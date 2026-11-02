import { randomUUID } from "node:crypto";
import type pg from "pg";
import { renderTemplate } from "@opspilot/core";
import { writeAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";

type SlaBreachRow = {
  tenant_id: string;
  id: string;
  version: number;
};

export async function markSlaBreaches(
  pool: pg.Pool,
  kind: "response" | "resolution",
): Promise<number> {
  const breachedColumn = kind === "response" ? "sla_response_breached_at" : "sla_resolution_breached_at";
  const dueColumn = kind === "response" ? "sla_response_due_at" : "sla_resolution_due_at";
  const metCondition =
    kind === "response"
      ? "(first_responded_at is null or first_responded_at > sla_response_due_at)"
      : "(resolved_at is null or resolved_at > sla_resolution_due_at)";
  // The clock stops when the ticket is answered, resolved, merged, or closed.
  // Using the stop time as the breach timestamp keeps historical breaches accurate
  // instead of stamping them when the worker happens to notice them.
  const stopExpression =
    kind === "response"
      ? "coalesce(first_responded_at, resolved_at, closed_at, now())"
      : "coalesce(resolved_at, closed_at, now())";

  const result = await pool.query<SlaBreachRow>(
    `with due as (
       select tenant_id, id
       from tickets
       where ${dueColumn} is not null
         and ${dueColumn} < ${stopExpression}
         and ${breachedColumn} is null
         and sla_paused_at is null
         and deleted_at is null
         and merged_into_ticket_id is null
         and ${metCondition}
       order by ${dueColumn}
       for update skip locked
       limit 100
     )
     update tickets t
     set ${breachedColumn} = ${stopExpression}, version = version + 1, updated_at = now()
     from due
     where t.tenant_id = due.tenant_id and t.id = due.id
     returning t.tenant_id, t.id, t.version`,
  );

  for (const ticket of result.rows) {
    await writeAudit(
      pool,
      ticket.tenant_id,
      { id: null, role: "system" },
      `ticket.sla_${kind}_breached`,
      "ticket",
      ticket.id,
      { kind },
      { breached: true },
      randomUUID(),
    );
    await enqueueEvent(pool, ticket.tenant_id, "ticket", ticket.id, ticket.version, "ticket.sla_breached", {
      ticketId: ticket.id,
      kind,
    });
  }
  return result.rowCount ?? 0;
}

type SlaWarningRow = {
  tenant_id: string;
  id: string;
  number: number;
  subject: string;
  assignee_id: string | null;
  team_id: string | null;
  due_at: Date;
  version: number;
};

export async function markSlaWarnings(
  pool: pg.Pool,
  kind: "response" | "resolution",
): Promise<number> {
  const warningColumn = kind === "response" ? "sla_response_warning_at" : "sla_resolution_warning_at";
  const warnDueColumn = kind === "response" ? "sla_response_warn_due_at" : "sla_resolution_warn_due_at";
  const breachedColumn = kind === "response" ? "sla_response_breached_at" : "sla_resolution_breached_at";
  const dueColumn = kind === "response" ? "sla_response_due_at" : "sla_resolution_due_at";
  const metCondition =
    kind === "response"
      ? "(first_responded_at is null)"
      : "(resolved_at is null)";

  const result = await pool.query<SlaWarningRow>(
    `with at_risk as (
       select tenant_id, id
       from tickets
       where ${dueColumn} is not null
         and now() >= coalesce(${warnDueColumn}, created_at + 0.8 * (${dueColumn} - created_at))
         and now() < ${dueColumn}
         and ${warningColumn} is null
         and ${breachedColumn} is null
         and sla_paused_at is null
         and deleted_at is null
         and merged_into_ticket_id is null
         and resolved_at is null
         and closed_at is null
         and ${metCondition}
       order by ${dueColumn}
       for update skip locked
       limit 100
     )
     update tickets t
     set ${warningColumn} = now(), version = version + 1, updated_at = now()
     from at_risk
     where t.tenant_id = at_risk.tenant_id and t.id = at_risk.id
     returning t.tenant_id, t.id, t.number, t.subject, t.assignee_id, t.team_id, t.${dueColumn} as due_at, t.version`,
  );

  for (const ticket of result.rows) {
    await writeAudit(
      pool,
      ticket.tenant_id,
      { id: null, role: "system" },
      `ticket.sla_${kind}_warning`,
      "ticket",
      ticket.id,
      null,
      { kind, percent: 80, dueAt: ticket.due_at },
      randomUUID(),
    );

    const eventId = await enqueueEvent(pool, ticket.tenant_id, "ticket", ticket.id, ticket.version, "ticket.sla_warning", {
      ticketId: ticket.id,
      kind,
      percent: 80,
      dueAt: ticket.due_at,
    });

    // Determine recipients to alert (assignee if assigned, otherwise team members)
    const recipientIds: string[] = [];
    if (ticket.assignee_id) {
      recipientIds.push(ticket.assignee_id);
    } else if (ticket.team_id) {
      const teamUsers = await pool.query<{ user_id: string }>(
        "select user_id from team_members where tenant_id = $1 and team_id = $2",
        [ticket.tenant_id, ticket.team_id],
      );
      recipientIds.push(...teamUsers.rows.map((r) => r.user_id));
    }

    if (recipientIds.length > 0) {
      const tmpl = await pool.query<{ subject: string; body: string }>(
        "select subject, body from notification_templates where tenant_id = $1 and key = 'sla_warning' and is_active",
        [ticket.tenant_id],
      );
      const subjectTmpl = tmpl.rows[0]?.subject ?? "SLA warning: Ticket #{{number}} approaching breach threshold";
      const bodyTmpl =
        tmpl.rows[0]?.body ??
        'Ticket #{{number}} ("{{subject}}") has reached 80% of its {{kind}} SLA limit. Please take action before the SLA breaches at {{dueAt}}.';
      const vars = {
        number: ticket.number,
        subject: ticket.subject,
        kind,
        dueAt: ticket.due_at.toISOString(),
      };
      const renderedSubj = renderTemplate(subjectTmpl, vars);
      const renderedBody = renderTemplate(bodyTmpl, vars);

      for (const recipientId of recipientIds) {
        await pool.query(
          `insert into notifications
             (tenant_id, event_id, ticket_id, recipient_id, channel, dedupe_key, status, delivery_status, subject, body)
           values ($1, $2, $3, $4, 'email', $5, 'pending', 'pending', $6, $7)
           on conflict (tenant_id, dedupe_key) do nothing`,
          [
            ticket.tenant_id,
            eventId,
            ticket.id,
            recipientId,
            `${eventId}:sla_${kind}_warning:${recipientId}`,
            renderedSubj,
            renderedBody,
          ],
        );
      }
    }
  }

  return result.rowCount ?? 0;
}

type EscalationCandidate = {
  tenant_id: string;
  id: string;
  number: number;
  subject: string;
  assignee_id: string | null;
  team_id: string | null;
  version: number;
  policy_id: string;
  sla_kind: "response" | "resolution";
  threshold_percent: number;
  target_type: "manager" | "team_lead" | "team";
  target_team_id: string | null;
};

async function escalationRecipients(
  pool: pg.Pool,
  ticket: EscalationCandidate,
): Promise<string[]> {
  if (ticket.target_type === "manager") {
    if (!ticket.assignee_id) return [];
    const row = await pool.query<{ manager_user_id: string | null }>(
      "select manager_user_id from memberships where tenant_id = $1 and user_id = $2 and is_active",
      [ticket.tenant_id, ticket.assignee_id],
    );
    const managerId = row.rows[0]?.manager_user_id;
    return managerId ? [managerId] : [];
  }
  if (ticket.target_type === "team_lead") {
    if (!ticket.team_id) return [];
    const row = await pool.query<{ lead_user_id: string | null }>(
      "select lead_user_id from teams where tenant_id = $1 and id = $2 and is_active",
      [ticket.tenant_id, ticket.team_id],
    );
    const leadId = row.rows[0]?.lead_user_id;
    return leadId ? [leadId] : [];
  }
  const teamId = ticket.target_team_id ?? ticket.team_id;
  if (!teamId) return [];
  const members = await pool.query<{ user_id: string }>(
    "select user_id from team_members where tenant_id = $1 and team_id = $2",
    [ticket.tenant_id, teamId],
  );
  return members.rows.map((row) => row.user_id);
}

export async function applyEscalations(pool: pg.Pool): Promise<number> {
  const result = await pool.query<EscalationCandidate>(
    `select t.tenant_id, t.id, t.number, t.subject, t.assignee_id, t.team_id, t.version,
            p.id as policy_id, p.sla_kind, p.threshold_percent, p.target_type, p.target_team_id
     from tickets t
     join escalation_policies p on p.tenant_id = t.tenant_id and p.is_active
     where t.deleted_at is null
       and t.merged_into_ticket_id is null
       and t.closed_at is null
       and t.sla_paused_at is null
       and not exists (
         select 1 from ticket_escalations e
         where e.tenant_id = t.tenant_id
           and e.ticket_id = t.id
           and e.policy_id = p.id
           and e.threshold_percent = p.threshold_percent
       )
       and (
         (p.sla_kind = 'response' and t.sla_response_due_at is not null and t.first_responded_at is null
          and now() >= case
            when p.threshold_percent >= 100 then t.sla_response_due_at
            else t.created_at + (p.threshold_percent / 100.0) * (t.sla_response_due_at - t.created_at)
          end)
         or
         (p.sla_kind = 'resolution' and t.sla_resolution_due_at is not null and t.resolved_at is null
          and now() >= case
            when p.threshold_percent >= 100 then t.sla_resolution_due_at
            else t.created_at + (p.threshold_percent / 100.0) * (t.sla_resolution_due_at - t.created_at)
          end)
       )
     order by t.created_at
     for update of t skip locked
     limit 100`,
  );

  let paged = 0;
  for (const ticket of result.rows) {
    const recipientIds = [...new Set(await escalationRecipients(pool, ticket))];
    if (recipientIds.length === 0) continue;

    const bumped = await pool.query<{ version: number }>(
      `update tickets set version = version + 1, updated_at = now()
       where tenant_id = $1 and id = $2
       returning version`,
      [ticket.tenant_id, ticket.id],
    );
    const version = bumped.rows[0]?.version ?? ticket.version + 1;
    const eventId = await enqueueEvent(
      pool,
      ticket.tenant_id,
      "ticket",
      ticket.id,
      version,
      "ticket.sla_escalated",
      {
        ticketId: ticket.id,
        policyId: ticket.policy_id,
        kind: ticket.sla_kind,
        threshold: ticket.threshold_percent,
        recipientIds,
      },
    );

    let notified = 0;
    const tmpl = await pool.query<{ subject: string; body: string }>(
      "select subject, body from notification_templates where tenant_id = $1 and key = 'sla_escalated' and is_active",
      [ticket.tenant_id],
    );
    const subjectTmpl = tmpl.rows[0]?.subject ?? "SLA escalation: Ticket #{{number}}";
    const bodyTmpl =
      tmpl.rows[0]?.body ??
      'Ticket #{{number}} ("{{subject}}") has reached {{threshold}}% of its {{kind}} SLA and was escalated.';
    const vars = {
      number: ticket.number,
      subject: ticket.subject,
      kind: ticket.sla_kind,
      threshold: ticket.threshold_percent,
    };
    for (const recipientId of recipientIds) {
      const inserted = await pool.query(
        `insert into notifications
           (tenant_id, event_id, ticket_id, recipient_id, channel, dedupe_key, status, delivery_status, subject, body)
         values ($1, $2, $3, $4, 'email', $5, 'pending', 'pending', $6, $7)
         on conflict (tenant_id, dedupe_key) do nothing`,
        [
          ticket.tenant_id,
          eventId,
          ticket.id,
          recipientId,
          `${eventId}:sla_escalated:${ticket.policy_id}:${recipientId}`,
          renderTemplate(subjectTmpl, vars),
          renderTemplate(bodyTmpl, vars),
        ],
      );
      notified += inserted.rowCount ?? 0;
    }

    if (notified === 0) continue;

    await pool.query(
      `insert into ticket_escalations
         (tenant_id, ticket_id, policy_id, threshold_percent, event_id)
       values ($1, $2, $3, $4, $5)
       on conflict (ticket_id, policy_id, threshold_percent) do nothing`,
      [ticket.tenant_id, ticket.id, ticket.policy_id, ticket.threshold_percent, eventId],
    );
    await writeAudit(
      pool,
      ticket.tenant_id,
      { id: null, role: "system" },
      "ticket.sla_escalated",
      "ticket",
      ticket.id,
      null,
      {
        policyId: ticket.policy_id,
        kind: ticket.sla_kind,
        threshold: ticket.threshold_percent,
        recipientIds,
      },
      randomUUID(),
    );
    paged += 1;
  }
  return paged;
}
