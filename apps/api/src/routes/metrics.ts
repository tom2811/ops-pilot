import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { adminPool } from "../db.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";

function assertMetricsToken(provided: string | undefined): void {
  if (!env.METRICS_TOKEN) throw new AppError(404, "Not found");
  if (!provided) throw new AppError(401, "Metrics token required");
  const expected = `Bearer ${env.METRICS_TOKEN}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(401, "Invalid metrics token");
  }
}

function metric(name: string, help: string, type: "gauge" | "counter", value: number, labels?: Record<string, string>): string[] {
  const labelText = labels
    ? `{${Object.entries(labels)
        .map(([key, item]) => `${key}="${item.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
        .join(",")}}`
    : "";
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labelText} ${value}`];
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (req, reply) => {
    assertMetricsToken(req.headers.authorization);

    const [outbox, notifications, emails, outboxAge, notificationAge, openTickets, breachedTickets, heartbeat, expiredSessions] =
      await Promise.all([
        adminPool.query<{ status: string; count: number }>(
          "select status::text, count(*)::int as count from outbox_events group by status",
        ),
        adminPool.query<{ status: string; count: number }>(
          "select delivery_status as status, count(*)::int as count from notifications group by delivery_status",
        ),
        adminPool.query<{ status: string; count: number }>(
          "select delivery_status as status, count(*)::int as count from email_messages group by delivery_status",
        ),
        adminPool.query<{ seconds: number }>(
          "select coalesce(extract(epoch from now() - min(available_at)), 0)::float as seconds from outbox_events where status = 'pending'",
        ),
        adminPool.query<{ seconds: number }>(
          "select coalesce(extract(epoch from now() - min(next_attempt_at)), 0)::float as seconds from notifications where delivery_status = 'pending'",
        ),
        adminPool.query<{ count: number }>(
          `select count(*)::int as count
           from tickets t
           join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
           where t.deleted_at is null and s.stage not in ('resolved', 'closed')`,
        ),
        adminPool.query<{ count: number }>(
          `select count(*)::int as count
           from tickets t
           join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
           where t.deleted_at is null and s.stage not in ('resolved', 'closed')
             and (t.sla_response_breached_at is not null or t.sla_resolution_breached_at is not null)`,
        ),
        adminPool.query<{ seconds: number }>(
          "select coalesce(extract(epoch from now() - max(last_seen_at)), 0)::float as seconds from worker_heartbeat",
        ),
        adminPool.query<{ count: number }>(
          "select count(*)::int as count from sessions where expires_at < now()",
        ),
      ]);

    const lines: string[] = [
      ...metric("opspilot_up", "1 when the API can query the database", "gauge", 1),
      ...metric("opspilot_uptime_seconds", "API process uptime in seconds", "gauge", Math.round(process.uptime())),
      ...metric(
        "opspilot_worker_last_seen_seconds",
        "Seconds since the worker last wrote a heartbeat (Infinity when it has never run)",
        "gauge",
        Number.isFinite(heartbeat.rows[0]?.seconds) ? Number(heartbeat.rows[0]?.seconds) : Number.POSITIVE_INFINITY,
      ),
      ...metric("opspilot_tickets_open", "Tickets not resolved or closed", "gauge", openTickets.rows[0]?.count ?? 0),
      ...metric(
        "opspilot_tickets_sla_breached_open",
        "Open tickets with a recorded response or resolution breach",
        "gauge",
        breachedTickets.rows[0]?.count ?? 0,
      ),
      ...metric(
        "opspilot_outbox_oldest_pending_seconds",
        "Age of the oldest pending outbox event",
        "gauge",
        Number(outboxAge.rows[0]?.seconds ?? 0),
      ),
      ...metric(
        "opspilot_notifications_oldest_pending_seconds",
        "Age of the oldest pending notification",
        "gauge",
        Number(notificationAge.rows[0]?.seconds ?? 0),
      ),
      ...metric("opspilot_sessions_expired", "Expired sessions awaiting cleanup", "gauge", expiredSessions.rows[0]?.count ?? 0),
    ];

    for (const row of outbox.rows) {
      lines.push(...metric("opspilot_outbox_events", "Outbox events by status", "gauge", row.count, { status: row.status }));
    }
    for (const row of notifications.rows) {
      lines.push(
        ...metric("opspilot_notifications", "Notifications by delivery status", "gauge", row.count, { status: row.status }),
      );
    }
    for (const row of emails.rows) {
      lines.push(
        ...metric("opspilot_email_messages", "Email messages by delivery status", "gauge", row.count, { status: row.status }),
      );
    }

    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(`${lines.join("\n")}\n`);
  });
}
