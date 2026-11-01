import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "dotenv";
import { resolve } from "node:path";
import pg from "pg";
import { z } from "zod";
import { createMailer } from "./mailer.js";
import { writeAudit } from "./audit.js";
import { enqueueEvent } from "./outbox.js";
import { processInboundEmail } from "./domain/inboundEmail.js";
import { markSlaBreaches, markSlaWarnings } from "./domain/sla.js";
import { addBusinessMinutes, renderTemplate } from "@opspilot/core";
import { getBusinessHoursConfig } from "./domain/tickets.js";

const REDACTED_BODY = "[body redacted]";
const SMTP_NOT_CONFIGURED = "SMTP is not configured";

config({ path: resolve(import.meta.dirname, "../../../.env") });
config();

const workerEnv = z
  .object({
    WORKER_DATABASE_URL: z.string().min(1).optional(),
    ADMIN_DATABASE_URL: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),
    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
    NEON_BRANCH: z.string().optional(),
    N8N_WEBHOOK_URL: z.string().url().optional(),
    N8N_WEBHOOK_SECRET: z.string().min(1).optional(),
    PUBLIC_API_URL: z.string().url().default("http://localhost:3000/api"),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(1500),
    MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    SMTP_HOST: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
    SMTP_PORT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().int().positive().default(587),
    ),
    SMTP_SECURE: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["true", "false"]).default("false"),
    ),
    SMTP_USER: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),
    SMTP_PASS: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),
    SMTP_FROM: z.string().min(1).default("OpsPilot <no-reply@opspilot.local>"),
    SMTP_REPLY_TO: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);

const connectionString =
  workerEnv.WORKER_DATABASE_URL ??
  workerEnv.DATABASE_URL_UNPOOLED ??
  workerEnv.ADMIN_DATABASE_URL ??
  workerEnv.DATABASE_URL;
if (!connectionString) throw new Error("WORKER_DATABASE_URL, DATABASE_URL_UNPOOLED, or ADMIN_DATABASE_URL is required");
if (workerEnv.N8N_WEBHOOK_URL && !workerEnv.N8N_WEBHOOK_SECRET) {
  throw new Error("N8N_WEBHOOK_SECRET is required when N8N_WEBHOOK_URL is set");
}

function smtpFromDomain(from: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return address.split("@").pop()?.trim() || "opspilot.local";
}

const messageIdDomain = smtpFromDomain(workerEnv.SMTP_FROM);

function deliveryMessageId(kind: "email" | "notification", id: string): string {
  return `<${kind}-${id}@${messageIdDomain}>`;
}

const pool = new pg.Pool({ connectionString, max: 4 });
const mailer = createMailer(
  workerEnv.SMTP_HOST
    ? {
        host: workerEnv.SMTP_HOST,
        port: workerEnv.SMTP_PORT,
        secure: workerEnv.SMTP_SECURE === "true",
        user: workerEnv.SMTP_USER,
        pass: workerEnv.SMTP_PASS,
        from: workerEnv.SMTP_FROM,
        replyTo: workerEnv.SMTP_REPLY_TO,
      }
    : null,
);

type OutboxRow = {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type NotificationRow = {
  id: string;
  tenant_id: string;
  channel: string;
  subject: string;
  body: string;
  attempts: number;
  recipient_email: string;
  tenant_status: string;
};

type EmailRow = {
  id: string;
  tenant_id: string | null;
  recipient: string;
  subject: string;
  body: string;
  attempts: number;
  tenant_status: string | null;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function permanentSmtpResponseCode(error: unknown): number | null {
  const responseCode = Number((error as { responseCode?: unknown } | null)?.responseCode);
  return Number.isFinite(responseCode) && responseCode >= 500 && responseCode < 600 ? responseCode : null;
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...details, at: new Date().toISOString() }));
}

type AutoCloseTenant = {
  tenant_id: string;
  auto_close_days: number;
  closed_status_id: string;
};

async function autoCloseTickets(): Promise<number> {
  const tenants = await pool.query<AutoCloseTenant>(
    `select ts.tenant_id, ts.auto_close_days, closed.id as closed_status_id
     from tenant_settings ts
     join lateral (
       select id from ticket_statuses
       where tenant_id = ts.tenant_id and stage = 'closed' and is_active
       order by sort_order limit 1
     ) closed on true
     where ts.auto_close_days > 0`,
  );

  let closedCount = 0;
  for (const tenant of tenants.rows) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const due = await client.query<{ id: string; status_id: string; version: number }>(
        `select t.id, t.status_id, t.version
         from tickets t
         join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
         where t.tenant_id = $1 and s.stage = 'resolved'
           and t.resolved_at < now() - ($2::text || ' days')::interval
         order by t.resolved_at
         for update of t skip locked
         limit 100`,
        [tenant.tenant_id, tenant.auto_close_days],
      );

      for (const ticket of due.rows) {
        const updated = await client.query<{ version: number }>(
          `update tickets
           set status_id = $3, closed_at = now(), version = version + 1, updated_at = now()
           where tenant_id = $1 and id = $2 and version = $4
           returning version`,
          [tenant.tenant_id, ticket.id, tenant.closed_status_id, ticket.version],
        );
        const next = updated.rows[0];
        if (!next) continue;

        await client.query(
          `insert into ticket_status_history
            (tenant_id, ticket_id, from_status_id, to_status_id, actor_role, reason)
           values ($1, $2, $3, $4, 'system', 'auto-closed after resolution window')`,
          [tenant.tenant_id, ticket.id, ticket.status_id, tenant.closed_status_id],
        );
        await writeAudit(
          client,
          tenant.tenant_id,
          { id: null, role: "system" },
          "ticket.auto_closed",
          "ticket",
          ticket.id,
          { autoCloseDays: tenant.auto_close_days },
          { stage: "closed" },
          randomUUID(),
        );
        await enqueueEvent(client, tenant.tenant_id, "ticket", ticket.id, next.version, "ticket.auto_closed", {
          ticketId: ticket.id,
        });
        closedCount += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      log("auto_close_failed", { tenantId: tenant.tenant_id, error: String(error) });
    } finally {
      client.release();
    }
  }
  return closedCount;
}

async function sendPendingChasers(): Promise<number> {
  const result = await pool.query<{
    tenant_id: string;
    id: string;
    number: number;
    subject: string;
    requester_id: string;
    assignee_id: string | null;
    sla_paused_at: Date;
    version: number;
    requester_name: string;
  }>(
    `select t.tenant_id, t.id, t.number, t.subject, t.requester_id, t.assignee_id, t.sla_paused_at, t.version,
            u.display_name as requester_name
     from tickets t
     join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
     join users u on u.id = t.requester_id
     where s.stage = 'pending'
       and t.sla_paused_at is not null
       and t.pending_chaser_sent_at is null
       and t.deleted_at is null
       and t.merged_into_ticket_id is null
     order by t.sla_paused_at asc
     for update of t skip locked
     limit 50`,
  );

  let sentCount = 0;
  const now = new Date();

  for (const ticket of result.rows) {
    const bhConfig = await getBusinessHoursConfig(pool, ticket.tenant_id);
    const dailyMinutes = bhConfig
      ? (bhConfig.endHour * 60 + bhConfig.endMinute) - (bhConfig.startHour * 60 + bhConfig.startMinute)
      : 24 * 60;
    const chaserDueAt = addBusinessMinutes(
      new Date(ticket.sla_paused_at),
      3 * Math.max(60, dailyMinutes),
      bhConfig,
    );

    if (now.getTime() >= chaserDueAt.getTime()) {
      await pool.query(
        "update tickets set pending_chaser_sent_at = now(), version = version + 1, updated_at = now() where tenant_id = $1 and id = $2",
        [ticket.tenant_id, ticket.id],
      );

      const eventId = await enqueueEvent(pool, ticket.tenant_id, "ticket", ticket.id, ticket.version + 1, "ticket.pending_chaser_sent", {
        ticketId: ticket.id,
        requesterId: ticket.requester_id,
        pausedAt: ticket.sla_paused_at,
        chaserDueAt,
      });

      await writeAudit(
        pool,
        ticket.tenant_id,
        { id: null, role: "system" },
        "ticket.pending_chaser_sent",
        "ticket",
        ticket.id,
        null,
        { requesterId: ticket.requester_id, chaserDueAt },
        randomUUID(),
      );

      // Determine system comment author
      let authorId = ticket.assignee_id;
      if (!authorId) {
        const adminUser = await pool.query<{ user_id: string }>(
          "select user_id from memberships where tenant_id = $1 and role = 'tenant_admin' limit 1",
          [ticket.tenant_id],
        );
        authorId = adminUser.rows[0]?.user_id ?? ticket.requester_id;
      }

      await pool.query(
        `insert into ticket_comments (tenant_id, id, ticket_id, author_id, body, visibility)
         values ($1, $2, $3, $4, $5, 'public')`,
        [
          ticket.tenant_id,
          randomUUID(),
          ticket.id,
          authorId,
          `Automated reminder sent to ${ticket.requester_name} after 3 business days awaiting response in Pending status.`,
        ],
      );

      // Send notification to requester
      const tmpl = await pool.query<{ subject: string; body: string }>(
        "select subject, body from notification_templates where tenant_id = $1 and key = 'pending_chaser' and is_active",
        [ticket.tenant_id],
      );
      const subjectTmpl = tmpl.rows[0]?.subject ?? "Reminder: Waiting for your reply on ticket #{{number}}";
      const bodyTmpl =
        tmpl.rows[0]?.body ??
        "Hello {{requesterName}},\n\nYour ticket #{{number}} (\"{{subject}}\") is currently waiting on your input. If no reply is received, the ticket will be automatically resolved.\n\nPlease reply directly to this email to provide an update.";
      const vars = {
        number: ticket.number,
        subject: ticket.subject,
        requesterName: ticket.requester_name,
      };

      await pool.query(
        `insert into notifications
           (tenant_id, event_id, ticket_id, recipient_id, channel, dedupe_key, status, delivery_status, subject, body)
         values ($1, $2, $3, $4, 'email', $5, 'pending', 'pending', $6, $7)
         on conflict (tenant_id, dedupe_key) do nothing`,
        [
          ticket.tenant_id,
          eventId,
          ticket.id,
          ticket.requester_id,
          `${eventId}:pending_chaser:${ticket.requester_id}`,
          renderTemplate(subjectTmpl, vars),
          renderTemplate(bodyTmpl, vars),
        ],
      );

      sentCount++;
    }
  }

  return sentCount;
}

async function runMaintenance(): Promise<void> {
  const responseBreaches = await markSlaBreaches(pool, "response");
  const resolutionBreaches = await markSlaBreaches(pool, "resolution");
  if (responseBreaches + resolutionBreaches > 0) {
    log("sla_breaches_recorded", { response: responseBreaches, resolution: resolutionBreaches });
  }
  const responseWarnings = await markSlaWarnings(pool, "response");
  const resolutionWarnings = await markSlaWarnings(pool, "resolution");
  if (responseWarnings + resolutionWarnings > 0) {
    log("sla_warnings_recorded", { response: responseWarnings, resolution: resolutionWarnings });
  }
  const chasers = await sendPendingChasers();
  if (chasers > 0) log("pending_chasers_sent", { count: chasers });
  const closed = await autoCloseTickets();
  if (closed > 0) log("tickets_auto_closed", { count: closed });
}

async function claimEvent(): Promise<OutboxRow | null> {
  await pool.query(
    `update outbox_events set status = 'pending', locked_until = null
     where status = 'sending' and locked_until < now()`,
  );

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<OutboxRow>(
      `select e.id, e.tenant_id, t.slug as tenant_slug, e.aggregate_type, e.aggregate_id,
              e.aggregate_version, e.event_type, e.payload, e.attempts
       from outbox_events e
       join tenants t on t.id = e.tenant_id
       where e.status = 'pending' and e.available_at <= now()
       order by e.available_at, e.created_at
       for update of e skip locked
       limit 1`,
    );
    const event = result.rows[0];
    if (!event) {
      await client.query("commit");
      return null;
    }
    await client.query(
      `update outbox_events
       set status = 'sending', attempts = attempts + 1, locked_until = now() + interval '5 minutes'
       where id = $1`,
      [event.id],
    );
    await client.query("commit");
    return { ...event, attempts: event.attempts + 1 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function claimNotifications(limit = 10): Promise<NotificationRow[]> {
  await pool.query(
    `update notifications set locked_until = null
     where delivery_status = 'pending' and locked_until < now()`,
  );
  const result = await pool.query<NotificationRow>(
    `update notifications n set locked_until = now() + interval '5 minutes'
     from (
       select id from notifications
       where delivery_status = 'pending' and next_attempt_at <= now()
         and (locked_until is null or locked_until < now())
       order by next_attempt_at, created_at
       for update skip locked
       limit $1
     ) claimed, users u
     where n.id = claimed.id and u.id = n.recipient_id
     returning n.id, n.tenant_id, n.channel, n.subject, n.body, n.attempts, u.email as recipient_email,
               (select status from tenants where id = n.tenant_id) as tenant_status`,
    [limit],
  );
  return result.rows;
}

async function markNotificationSkipped(notification: NotificationRow, reason: string): Promise<void> {
  await pool.query(
    `update notifications
     set delivery_status = 'skipped', status = 'skipped', last_error = $2, locked_until = null
     where id = $1`,
    [notification.id, reason],
  );
  log("notification_skipped", { notificationId: notification.id, reason });
}

async function deferNotification(notification: NotificationRow): Promise<void> {
  await pool.query(
    `update notifications
     set status = 'pending', last_error = $2,
         next_attempt_at = now() + interval '60 seconds', locked_until = null
     where id = $1`,
    [notification.id, SMTP_NOT_CONFIGURED],
  );
  log("notification_deferred", { notificationId: notification.id, reason: SMTP_NOT_CONFIGURED });
}

async function processNotifications(): Promise<void> {
  const notifications = await claimNotifications();
  for (const notification of notifications) {
    if (notification.channel !== "email") {
      await markNotificationSkipped(notification, `Unsupported channel: ${notification.channel}`);
      continue;
    }
    if (notification.tenant_status !== "active") {
      await markNotificationSkipped(notification, `Tenant is not active: ${notification.tenant_status}`);
      continue;
    }
    if (!mailer) {
      await deferNotification(notification);
      continue;
    }
    const attempts = notification.attempts + 1;
    try {
      const messageId = await mailer.send({
        to: notification.recipient_email,
        subject: notification.subject,
        text: notification.body,
        messageId: deliveryMessageId("notification", notification.id),
      });
      await pool.query(
        `update notifications
         set delivery_status = 'sent', status = 'sent', sent_at = now(), attempts = $2,
             provider_message_id = $3, last_error = null, bounce_reason = null, locked_until = null
         where id = $1`,
        [notification.id, attempts, messageId ?? null],
      );
      log("notification_sent", { notificationId: notification.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanentCode = permanentSmtpResponseCode(error);
      const dead = permanentCode !== null || attempts >= 5;
      const lastError = (permanentCode === null ? message : `SMTP ${permanentCode}: ${message}`).slice(0, 2000);
      await pool.query(
        `update notifications
         set delivery_status = ($2::notification_status)::text, status = $2::notification_status,
             attempts = $3,
             next_attempt_at = case when $2 = 'pending' then now() + ($4::text || ' seconds')::interval
                                    else next_attempt_at end,
             last_error = $5,
             bounce_reason = case when $6::boolean then $5 else bounce_reason end,
             locked_until = null
         where id = $1`,
        [notification.id, dead ? "failed" : "pending", attempts, String(Math.min(60, 2 ** attempts)), lastError, permanentCode !== null],
      );
      log("notification_failed", {
        notificationId: notification.id,
        attempts,
        dead,
        permanent: permanentCode !== null,
        error: lastError,
      });
    }
  }
}

async function claimEmails(limit = 10): Promise<EmailRow[]> {
  await pool.query(
    `update email_messages set locked_until = null
     where delivery_status = 'pending' and locked_until < now()`,
  );
  const result = await pool.query<EmailRow>(
    `update email_messages m set locked_until = now() + interval '5 minutes'
     from (
       select id from email_messages
       where delivery_status = 'pending' and next_attempt_at <= now()
         and (locked_until is null or locked_until < now())
       order by next_attempt_at, created_at
       for update skip locked
       limit $1
     ) claimed
     where m.id = claimed.id
     returning m.id, m.tenant_id, m.recipient, m.subject, m.body, m.attempts,
               (select status from tenants where id = m.tenant_id) as tenant_status`,
    [limit],
  );
  return result.rows;
}

async function assertWorkerDatabaseRole(): Promise<string> {
  const result = await pool.query<{ role: string; bypassrls: boolean; superuser: boolean }>(
    `select current_user as role, rolbypassrls as bypassrls, rolsuper as superuser
     from pg_roles where rolname = current_user`,
  );
  const row = result.rows[0];
  if (!row || (!row.bypassrls && !row.superuser)) {
    throw new Error(
      `Worker database role ${row?.role ?? "(unknown)"} cannot bypass RLS; use a dedicated role with BYPASSRLS (WORKER_DB_ROLE) or an admin role`,
    );
  }
  return row.role;
}

async function markEmailSkipped(email: EmailRow, reason: string): Promise<void> {
  await pool.query(
    `update email_messages
     set delivery_status = 'skipped', last_error = $2, locked_until = null, body = $3
     where id = $1`,
    [email.id, reason, REDACTED_BODY],
  );
  log("email_skipped", { emailId: email.id, reason });
}

async function deferEmail(email: EmailRow): Promise<void> {
  await pool.query(
    `update email_messages
     set last_error = $2, next_attempt_at = now() + interval '60 seconds', locked_until = null
     where id = $1`,
    [email.id, SMTP_NOT_CONFIGURED],
  );
  log("email_deferred", { emailId: email.id, reason: SMTP_NOT_CONFIGURED });
}

async function resumeDeferredMail(): Promise<void> {
  if (!mailer) return;
  const emails = await pool.query(
    `update email_messages set next_attempt_at = now()
     where delivery_status = 'pending' and last_error = $1`,
    [SMTP_NOT_CONFIGURED],
  );
  const notifications = await pool.query(
    `update notifications set next_attempt_at = now()
     where delivery_status = 'pending' and last_error = $1`,
    [SMTP_NOT_CONFIGURED],
  );
  if ((emails.rowCount ?? 0) + (notifications.rowCount ?? 0) > 0) {
    log("deferred_mail_resumed", { emails: emails.rowCount ?? 0, notifications: notifications.rowCount ?? 0 });
  }
}

async function processEmails(): Promise<void> {
  const emails = await claimEmails();
  for (const email of emails) {
    if (email.tenant_id && email.tenant_status !== "active") {
      await markEmailSkipped(email, `Tenant is not active: ${email.tenant_status}`);
      continue;
    }
    if (!mailer) {
      await deferEmail(email);
      continue;
    }
    const attempts = email.attempts + 1;
    try {
      const messageId = await mailer.send({
        to: email.recipient,
        subject: email.subject,
        text: email.body,
        messageId: deliveryMessageId("email", email.id),
      });
      await pool.query(
        `update email_messages
         set delivery_status = 'sent', sent_at = now(), attempts = $2,
             provider_message_id = $3, last_error = null, bounce_reason = null,
             locked_until = null, body = $4
         where id = $1`,
        [email.id, attempts, messageId ?? null, REDACTED_BODY],
      );
      log("email_sent", { emailId: email.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanentCode = permanentSmtpResponseCode(error);
      const dead = permanentCode !== null || attempts >= 5;
      const lastError = (permanentCode === null ? message : `SMTP ${permanentCode}: ${message}`).slice(0, 2000);
      await pool.query(
        `update email_messages
         set delivery_status = $2, attempts = $3,
             next_attempt_at = case when $2 = 'pending' then now() + ($4::text || ' seconds')::interval
                                    else next_attempt_at end,
             last_error = $5,
             bounce_reason = case when $7::boolean then $5 else bounce_reason end,
             locked_until = null,
             body = case when $2 = 'failed' then $6 else body end
         where id = $1`,
        [
          email.id,
          dead ? "failed" : "pending",
          attempts,
          String(Math.min(60, 2 ** attempts)),
          lastError,
          REDACTED_BODY,
          permanentCode !== null,
        ],
      );
      log("email_failed", { emailId: email.id, attempts, dead, permanent: permanentCode !== null, error: lastError });
    }
  }
}

async function deliver(event: OutboxRow): Promise<void> {
  if (event.event_type !== "ticket.created") {
    await pool.query("update outbox_events set status = 'delivered', delivered_at = now(), locked_until = null where id = $1", [
      event.id,
    ]);
    return;
  }
  if (!workerEnv.N8N_WEBHOOK_URL || !workerEnv.N8N_WEBHOOK_SECRET) {
    log("n8n_not_configured", { eventId: event.id });
    await pool.query("update outbox_events set status = 'delivered', delivered_at = now(), locked_until = null where id = $1", [
      event.id,
    ]);
    return;
  }

  const runToken = randomBytes(32).toString("base64url");
  const preferredRunId = randomUUID();
  const run = await pool.query<{ id: string }>(
    `insert into automation_runs (tenant_id, id, event_id, run_token_hash, status, lease_expires_at)
     values ($1, $2, $3, $4, 'in_progress', now() + interval '10 minutes')
     on conflict (tenant_id, event_id) do update set
       run_token_hash = excluded.run_token_hash,
       status = 'in_progress',
       lease_expires_at = excluded.lease_expires_at,
       completed_at = null,
       error = null
     returning id`,
    [event.tenant_id, preferredRunId, event.id, hashToken(runToken)],
  );
  const runId = run.rows[0]?.id ?? preferredRunId;

  const body = JSON.stringify({
    eventId: event.id,
    runId,
    tenant: { id: event.tenant_id, slug: event.tenant_slug },
    token: runToken,
    event: { type: event.event_type, payload: event.payload },
    callbackBaseUrl: `${workerEnv.PUBLIC_API_URL}/automation/runs/${runId}`,
  });
  const signature = createHmac("sha256", workerEnv.N8N_WEBHOOK_SECRET).update(body).digest("hex");

  const response = await fetch(workerEnv.N8N_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opspilot-signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`n8n responded ${response.status}`);

  await pool.query(
    "update outbox_events set status = 'delivered', delivered_at = now(), locked_until = null, last_error = null where id = $1",
    [event.id],
  );
  log("event_delivered", { eventId: event.id, runId, tenant: event.tenant_slug });
}

async function fail(event: OutboxRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const dead = event.attempts >= 5;
  await pool.query(
    `update outbox_events set
       status = $2::outbox_status,
       available_at = case when $2::outbox_status = 'pending'::outbox_status
                           then now() + ($3::text || ' seconds')::interval else available_at end,
       locked_until = null,
       last_error = $4
     where id = $1`,
    [event.id, dead ? "dead" : "pending", String(Math.min(60, 2 ** event.attempts)), message.slice(0, 2000)],
  );
  await pool.query(
    "update automation_runs set status = 'failed', error = $2, completed_at = now() where tenant_id = $1 and event_id = $3 and status = 'in_progress'",
    [event.tenant_id, message.slice(0, 2000), event.id],
  );
  log("event_failed", { eventId: event.id, attempts: event.attempts, dead, error: message });
}

function getMailpitApiUrl(): string | null {
  if (process.env.MAILPIT_API_URL) return process.env.MAILPIT_API_URL;
  if (workerEnv.SMTP_HOST === "opspilot-mailpit" || workerEnv.SMTP_HOST === "mailpit") {
    return `http://${workerEnv.SMTP_HOST}:8025`;
  }
  if (workerEnv.SMTP_HOST === "localhost" || workerEnv.SMTP_HOST === "127.0.0.1") {
    return "http://localhost:8025";
  }
  return null;
}

type MailpitMessageSummary = {
  ID: string;
  MessageID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
};

type MailpitMessageDetail = {
  ID: string;
  MessageID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
  Text: string;
  HTML: string;
  Headers?: Record<string, string[]>;
};

async function pollMailpitInbound(): Promise<void> {
  const mailpitUrl = getMailpitApiUrl();
  if (!mailpitUrl) return;

  try {
    const listRes = await fetch(`${mailpitUrl}/api/v1/messages?limit=20`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!listRes.ok) return;
    const data = (await listRes.json()) as { messages?: MailpitMessageSummary[] };
    if (!data.messages || data.messages.length === 0) return;

    for (const msg of data.messages) {
      const fromAddr = (msg.From?.Address ?? "").toLowerCase();
      if (
        fromAddr === workerEnv.SMTP_FROM.toLowerCase() ||
        fromAddr.includes("no-reply@opspilot.local") ||
        fromAddr.includes("mailer-daemon@")
      ) {
        continue;
      }

      const detailRes = await fetch(`${mailpitUrl}/api/v1/message/${msg.ID}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!detailRes.ok) continue;
      const detail = (await detailRes.json()) as MailpitMessageDetail;

      const client = await pool.connect();
      try {
        await client.query("begin");
        const inReplyTo = detail.Headers?.["In-Reply-To"]?.[0] || detail.Headers?.["in-reply-to"]?.[0];
        const references = detail.Headers?.["References"]?.[0] || detail.Headers?.["references"]?.[0];
        const toAddr = detail.To?.[0]?.Address;

        const res = await processInboundEmail(client, {
          from: detail.From?.Address || fromAddr,
          to: toAddr,
          subject: detail.Subject || "(No subject)",
          text: detail.Text || "",
          html: detail.HTML || "",
          messageId: detail.MessageID || msg.ID,
          inReplyTo,
          references,
        });
        await client.query("commit");

        log("inbound_email_processed", {
          action: res.action,
          ticketId: res.ticketId,
          mailpitId: msg.ID,
        });

        await fetch(`${mailpitUrl}/api/v1/messages`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ IDs: [msg.ID] }),
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      } catch (err) {
        await client.query("rollback").catch(() => {});
        log("inbound_email_failed", { mailpitId: msg.ID, error: String(err) });
      } finally {
        client.release();
      }
    }
  } catch {
    // Non-fatal if Mailpit is unreachable
  }
}

let running = true;
let nextMaintenance = 0;

async function loop(): Promise<void> {
  while (running) {
    try {
      if (Date.now() >= nextMaintenance) {
        await runMaintenance();
        nextMaintenance = Date.now() + workerEnv.MAINTENANCE_INTERVAL_MS;
      }
      await pollMailpitInbound();
      await processNotifications();
      await processEmails();
      const event = await claimEvent();
      if (!event) {
        await sleep(workerEnv.WORKER_POLL_MS);
        continue;
      }
      try {
        await deliver(event);
      } catch (error) {
        await fail(event, error);
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "worker_loop_error", error: String(error) }));
      await sleep(2000);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
    log("worker_stopping", { signal });
  });
}

const workerDbRole = await assertWorkerDatabaseRole();
log("worker_started", { pollMs: workerEnv.WORKER_POLL_MS, mailConfigured: Boolean(mailer), dbRole: workerDbRole });
await resumeDeferredMail();
await loop();
await pool.end();
