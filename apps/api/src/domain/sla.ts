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
         and now() >= created_at + 0.8 * (${dueColumn} - created_at)
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
