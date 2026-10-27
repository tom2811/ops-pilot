import { randomUUID } from "node:crypto";
import type pg from "pg";
import { renderTemplate, type Role, type Stage } from "@opspilot/core";
import { writeAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requestFeedback } from "./feedback.js";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  filterVisibleCustomFields,
  validateCustomFields,
  visibleCustomFields,
} from "./customFields.js";

export type TicketRow = {
  tenant_id: string;
  id: string;
  number: number;
  subject: string;
  description: string;
  requester_id: string;
  assignee_id: string | null;
  team_id: string | null;
  category_id: string;
  priority_id: string;
  status_id: string;
  custom_fields: Record<string, unknown>;
  resolution_summary: string | null;
  pending_reason: string | null;
  version: number;
  reopened_count: number;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  sla_policy_id: string | null;
  sla_response_due_at: Date | null;
  sla_resolution_due_at: Date | null;
  sla_response_breached_at: Date | null;
  sla_resolution_breached_at: Date | null;
  sla_paused_at: Date | null;
  created_at: Date;
  updated_at: Date;
  status_key: string;
  status_label: string;
  status_stage: Stage;
  category_name: string;
  priority_key: string;
  priority_label: string;
  priority_rank: number;
  requester_name: string;
  assignee_name: string | null;
  team_name: string | null;
};

type TicketListRow = TicketRow & { total_count: string };

const ticketSelect = `
  select t.tenant_id, t.id, t.number, t.subject, t.description, t.requester_id, t.assignee_id,
         t.team_id, t.category_id, t.priority_id, t.status_id, t.custom_fields,
         t.resolution_summary, t.pending_reason, t.version, t.reopened_count,
         t.first_responded_at, t.resolved_at, t.closed_at,
         t.sla_policy_id, t.sla_response_due_at, t.sla_resolution_due_at,
         t.sla_response_breached_at, t.sla_resolution_breached_at, t.sla_paused_at,
         t.created_at, t.updated_at,
         s.key as status_key, s.label as status_label, s.stage as status_stage,
         c.name as category_name,
         p.key as priority_key, p.label as priority_label, p.rank as priority_rank,
         req.display_name as requester_name,
         asg.display_name as assignee_name,
         tm.name as team_name
  from tickets t
  join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
  join categories c on c.tenant_id = t.tenant_id and c.id = t.category_id
  join priorities p on p.tenant_id = t.tenant_id and p.id = t.priority_id
  join users req on req.id = t.requester_id
  left join users asg on asg.id = t.assignee_id
  left join teams tm on tm.tenant_id = t.tenant_id and tm.id = t.team_id
`;

const ticketListSelect = ticketSelect.replace(
  "select t.tenant_id,",
  "select count(*) over() as total_count, t.tenant_id,",
);

async function notifyFromTemplate(
  client: pg.PoolClient,
  tenantId: string,
  eventId: string,
  ticketId: string,
  recipientId: string,
  templateKey: string,
  variables: Record<string, unknown>,
): Promise<void> {
  const template = await client.query<{ subject: string; body: string }>(
    `select subject, body from notification_templates
     where tenant_id = $1 and key = $2 and is_active`,
    [tenantId, templateKey],
  );
  const row = template.rows[0];
  if (!row) return;

  await client.query(
    `insert into notifications
      (tenant_id, event_id, ticket_id, recipient_id, channel, dedupe_key, status, subject, body)
     values ($1, $2, $3, $4, 'email', $5, 'pending', $6, $7)
     on conflict (tenant_id, dedupe_key) do nothing`,
    [
      tenantId,
      eventId,
      ticketId,
      recipientId,
      `${eventId}:${templateKey}:${recipientId}`,
      renderTemplate(row.subject, variables),
      renderTemplate(row.body, variables),
    ],
  );
}

export async function loadTicket(
  client: pg.PoolClient,
  tenantId: string,
  ticketId: string,
  forUpdate = false,
): Promise<TicketRow | null> {
  const result = await client.query<TicketRow>(
    `${ticketSelect} where t.tenant_id = $1 and t.id = $2 and t.deleted_at is null ${forUpdate ? "for update of t" : ""}`,
    [tenantId, ticketId],
  );
  return result.rows[0] ?? null;
}

async function isTeamMember(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  teamId: string | null,
): Promise<boolean> {
  if (!teamId) return false;
  const result = await client.query(
    "select 1 from team_members where tenant_id = $1 and user_id = $2 and team_id = $3",
    [tenantId, userId, teamId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function assertCanRead(
  client: pg.PoolClient,
  ticket: TicketRow,
  userId: string,
  role: Role,
): Promise<void> {
  if (role === "tenant_admin") return;
  if (role === "employee") {
    if (ticket.requester_id !== userId) notFound();
    return;
  }
  if (ticket.assignee_id === userId) return;
  if (await isTeamMember(client, ticket.tenant_id, userId, ticket.team_id)) return;
  if (!ticket.assignee_id && !ticket.team_id) return;
  notFound();
}

export type TicketListInput = {
  status?: string;
  priority?: string;
  q?: string;
  limit: number;
  offset: number;
};

export async function listTickets(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  input: TicketListInput,
): Promise<{ items: TicketRow[]; total: number }> {
  const conditions = ["t.tenant_id = $1", "t.deleted_at is null"];
  const params: Array<string | number> = [tenantId];
  let index = 2;

  if (role === "employee") {
    conditions.push(`t.requester_id = $${index++}`);
    params.push(userId);
  } else if (role === "agent") {
    conditions.push(
      `(t.assignee_id = $${index} or exists (
        select 1 from team_members tm
        where tm.tenant_id = t.tenant_id and tm.user_id = $${index} and tm.team_id = t.team_id
      ) or (t.assignee_id is null and t.team_id is null))`,
    );
    params.push(userId);
    index += 1;
  }

  if (input.status) {
    conditions.push(`s.key = $${index++}`);
    params.push(input.status);
  }
  if (input.priority) {
    conditions.push(`p.key = $${index++}`);
    params.push(input.priority);
  }
  if (input.q) {
    conditions.push(`to_tsvector('simple', t.subject || ' ' || t.description) @@ plainto_tsquery('simple', $${index++})`);
    params.push(input.q);
  }

  params.push(input.limit, input.offset);
  const limitIndex = index;
  const offsetIndex = index + 1;

  const result = await client.query<TicketListRow>(
    `${ticketListSelect}
     where ${conditions.join(" and ")}
     order by p.rank asc, t.created_at desc
     limit $${limitIndex} offset $${offsetIndex}`,
    params,
  );

  const rows = result.rows.map(({ total_count: _total, ...row }) => row);
  const items = await filterVisibleCustomFields(client, tenantId, rows, role);

  return {
    items,
    total: result.rows[0] ? Number(result.rows[0].total_count) : 0,
  };
}

export async function createTicket(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  input: {
    subject: string;
    description: string;
    categoryId: string;
    priorityId: string;
    customFields: Record<string, unknown>;
  },
  correlationId: string,
): Promise<TicketRow> {
  const category = await client.query("select 1 from categories where tenant_id = $1 and id = $2 and is_active", [
    tenantId,
    input.categoryId,
  ]);
  if ((category.rowCount ?? 0) === 0) return badRequest("Unknown category");

  const priority = await client.query("select 1 from priorities where tenant_id = $1 and id = $2 and is_active", [
    tenantId,
    input.priorityId,
  ]);
  if ((priority.rowCount ?? 0) === 0) return badRequest("Unknown priority");

  const customFields = await validateCustomFields(client, tenantId, input.categoryId, input.customFields, role);

  const newStatus = await getStatusByStage(client, tenantId, "new");
  if (!newStatus) throw new Error("Tenant has no new status");

  const counter = await client.query<{ number: number }>(
    `insert into ticket_counters (tenant_id, next_number)
     values ($1, 2)
     on conflict (tenant_id) do update set next_number = ticket_counters.next_number + 1
     returning next_number - 1 as number`,
    [tenantId],
  );
  const number = counter.rows[0]?.number;
  if (!number) throw new Error("Could not allocate ticket number");

  const sla = await client.query<{ id: string; response_minutes: number; resolution_minutes: number }>(
    `select id, response_minutes, resolution_minutes
     from sla_policies
     where tenant_id = $1 and is_active
       and (priority_id is null or priority_id = $2)
       and (category_id is null or category_id = $3)
     order by (category_id is not null) desc, (priority_id is not null) desc, created_at
     limit 1`,
    [tenantId, input.priorityId, input.categoryId],
  );
  const slaPolicy = sla.rows[0];

  const id = randomUUID();
  await client.query(
    `insert into tickets
      (tenant_id, id, number, subject, description, requester_id, category_id, priority_id, status_id, custom_fields,
       sla_policy_id, sla_response_due_at, sla_resolution_due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             now() + ($12::text || ' minutes')::interval,
             now() + ($13::text || ' minutes')::interval)`,
    [
      tenantId,
      id,
      number,
      input.subject,
      input.description,
      userId,
      input.categoryId,
      input.priorityId,
      newStatus.id,
      JSON.stringify(customFields),
      slaPolicy?.id ?? null,
      slaPolicy?.response_minutes ?? null,
      slaPolicy?.resolution_minutes ?? null,
    ],
  );

  await client.query(
    `insert into ticket_status_history
      (tenant_id, ticket_id, to_status_id, actor_id, actor_role)
     values ($1, $2, $3, $4, $5)`,
    [tenantId, id, newStatus.id, userId, role],
  );

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.created",
    "ticket",
    id,
    null,
    { subject: input.subject, categoryId: input.categoryId, priorityId: input.priorityId },
    correlationId,
  );

  await enqueueEvent(client, tenantId, "ticket", id, 0, "ticket.created", {
    ticketId: id,
    number,
    subject: input.subject,
    categoryId: input.categoryId,
    priorityId: input.priorityId,
    requesterId: userId,
    customFields,
  });

  const created = await loadTicket(client, tenantId, id);
  if (!created) throw new Error("Created ticket missing");
  return created;
}

export async function updateTicket(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  ticketId: string,
  input: {
    subject?: string;
    description?: string;
    categoryId?: string;
    priorityId?: string;
    customFields?: Record<string, unknown>;
    expectedVersion: number;
  },
  correlationId: string,
): Promise<TicketRow> {
  const ticket = await loadTicket(client, tenantId, ticketId, true);
  if (!ticket) notFound();
  if (role === "employee") {
    if (ticket.requester_id !== userId) notFound();
    if (ticket.status_stage === "resolved" || ticket.status_stage === "closed") {
      badRequest("Resolved or closed tickets cannot be edited");
    }
    if (
      (input.categoryId && input.categoryId !== ticket.category_id) ||
      (input.priorityId && input.priorityId !== ticket.priority_id)
    ) {
      badRequest("Only agents can change the category or priority");
    }
  } else if (role === "agent") {
    await assertCanRead(client, ticket, userId, role);
  }
  if (ticket.version !== input.expectedVersion) conflict("Ticket changed; reload and try again");

  const categoryId = input.categoryId ?? ticket.category_id;
  const priorityId = input.priorityId ?? ticket.priority_id;
  if (input.categoryId) {
    const category = await client.query(
      "select 1 from categories where tenant_id = $1 and id = $2 and is_active",
      [tenantId, categoryId],
    );
    if ((category.rowCount ?? 0) === 0) badRequest("Unknown category");
  }
  if (input.priorityId) {
    const priority = await client.query(
      "select 1 from priorities where tenant_id = $1 and id = $2 and is_active",
      [tenantId, priorityId],
    );
    if ((priority.rowCount ?? 0) === 0) badRequest("Unknown priority");
  }

  let customFields = ticket.custom_fields;
  if (input.customFields) {
    customFields = await validateCustomFields(client, tenantId, categoryId, input.customFields, role);
    if (role === "employee") {
      const hidden = await client.query<{ key: string }>(
        "select key from custom_field_definitions where tenant_id = $1 and visibility = 'internal'",
        [tenantId],
      );
      for (const field of hidden.rows) {
        if (field.key in ticket.custom_fields) customFields[field.key] = ticket.custom_fields[field.key];
      }
    }
  }

  const slaChanged = categoryId !== ticket.category_id || priorityId !== ticket.priority_id;
  let slaPolicyId: string | null = null;
  let responseMinutes: number | null = null;
  let resolutionMinutes: number | null = null;
  if (slaChanged) {
    const sla = await client.query<{ id: string; response_minutes: number; resolution_minutes: number }>(
      `select id, response_minutes, resolution_minutes
       from sla_policies
       where tenant_id = $1 and is_active
         and (priority_id is null or priority_id = $2)
         and (category_id is null or category_id = $3)
       order by (category_id is not null) desc, (priority_id is not null) desc, created_at
       limit 1`,
      [tenantId, priorityId, categoryId],
    );
    const policy = sla.rows[0];
    slaPolicyId = policy?.id ?? null;
    responseMinutes = policy?.response_minutes ?? null;
    resolutionMinutes = policy?.resolution_minutes ?? null;
  }

  const updated = await client.query(
    `update tickets set
       subject = $3,
       description = $4,
       category_id = $5,
       priority_id = $6,
       custom_fields = $7,
       sla_policy_id = case when $8 then $9 else sla_policy_id end,
       sla_response_due_at = case when $8 then created_at + ($10::text || ' minutes')::interval
                                  else sla_response_due_at end,
       sla_resolution_due_at = case when $8 then created_at + ($11::text || ' minutes')::interval
                                    else sla_resolution_due_at end,
       sla_response_breached_at = case when $8 then null else sla_response_breached_at end,
       sla_resolution_breached_at = case when $8 then null else sla_resolution_breached_at end,
       version = version + 1,
       updated_at = now()
     where tenant_id = $1 and id = $2 and version = $12`,
    [
      tenantId,
      ticketId,
      input.subject ?? ticket.subject,
      input.description ?? ticket.description,
      categoryId,
      priorityId,
      JSON.stringify(customFields),
      slaChanged,
      slaPolicyId,
      responseMinutes,
      resolutionMinutes,
      input.expectedVersion,
    ],
  );
  if ((updated.rowCount ?? 0) === 0) conflict("Ticket changed; reload and try again");

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.updated",
    "ticket",
    ticketId,
    {
      subject: ticket.subject,
      categoryId: ticket.category_id,
      priorityId: ticket.priority_id,
    },
    {
      subject: input.subject ?? ticket.subject,
      categoryId,
      priorityId,
    },
    correlationId,
  );

  const refreshed = await loadTicket(client, tenantId, ticketId);
  if (!refreshed) throw new Error("Ticket disappeared after update");

  await enqueueEvent(client, tenantId, "ticket", ticketId, refreshed.version, "ticket.updated", {
    ticketId,
    changed: Object.keys(input).filter((key) => key !== "expectedVersion"),
  });

  if (role === "employee") {
    return {
      ...refreshed,
      custom_fields: await visibleCustomFields(client, tenantId, refreshed.category_id, refreshed.custom_fields, role),
    };
  }
  return refreshed;
}

export async function deleteTicket(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  ticketId: string,
  correlationId: string,
): Promise<void> {
  const ticket = await loadTicket(client, tenantId, ticketId, true);
  if (!ticket) notFound();
  await client.query(
    `update tickets set deleted_at = now(), version = version + 1, updated_at = now()
     where tenant_id = $1 and id = $2`,
    [tenantId, ticketId],
  );
  await writeAudit(
    client,
    tenantId,
    { id: userId, role: "tenant_admin" },
    "ticket.deleted",
    "ticket",
    ticketId,
    { number: ticket.number, subject: ticket.subject },
    null,
    correlationId,
  );
  await enqueueEvent(client, tenantId, "ticket", ticketId, ticket.version + 1, "ticket.deleted", {
    ticketId,
    number: ticket.number,
  });
}

type StatusRef = { id: string; key: string; label: string; stage: Stage };

async function getStatusByStage(
  client: pg.PoolClient,
  tenantId: string,
  stage: Stage,
): Promise<StatusRef | null> {
  const result = await client.query<StatusRef>(
    "select id, key, label, stage from ticket_statuses where tenant_id = $1 and stage = $2 and is_active order by sort_order limit 1",
    [tenantId, stage],
  );
  return result.rows[0] ?? null;
}

export type AllowedTransition = {
  toStatusId: string;
  key: string;
  label: string;
  stage: Stage;
  requiresAssignee: boolean;
  requiresSummary: boolean;
  requiresReason: boolean;
};

export async function allowedTransitions(
  client: pg.PoolClient,
  tenantId: string,
  fromStatusId: string,
  role: Role,
): Promise<AllowedTransition[]> {
  const result = await client.query<{
    to_status_id: string;
    key: string;
    label: string;
    stage: Stage;
    requires_assignee: boolean;
    requires_summary: boolean;
    requires_reason: boolean;
  }>(
    `select r.to_status_id, s.key, s.label, s.stage,
            r.requires_assignee, r.requires_summary, r.requires_reason
     from ticket_transition_rules r
     join ticket_statuses s on s.tenant_id = r.tenant_id and s.id = r.to_status_id
     where r.tenant_id = $1 and r.from_status_id = $2 and r.actor_role = $3
       and r.is_active and s.is_active
     order by s.sort_order`,
    [tenantId, fromStatusId, role],
  );

  return result.rows.map((row) => ({
    toStatusId: row.to_status_id,
    key: row.key,
    label: row.label,
    stage: row.stage,
    requiresAssignee: row.requires_assignee,
    requiresSummary: row.requires_summary,
    requiresReason: row.requires_reason,
  }));
}

export async function applyTransition(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  ticketId: string,
  input: {
    toStatusId: string;
    expectedVersion: number;
    reason?: string;
    resolutionSummary?: string;
  },
  correlationId: string,
): Promise<TicketRow> {
  const ticket = await loadTicket(client, tenantId, ticketId, true);
  if (!ticket) notFound();
  if (role === "employee") {
    if (ticket.requester_id !== userId) notFound();
  } else if (role === "agent") {
    await assertCanRead(client, ticket, userId, role);
  }
  if (ticket.version !== input.expectedVersion) conflict("Ticket changed; reload and try again");

  const target = await client.query<StatusRef>(
    "select id, key, label, stage from ticket_statuses where tenant_id = $1 and id = $2 and is_active",
    [tenantId, input.toStatusId],
  );
  const targetStatus = target.rows[0];
  if (!targetStatus) badRequest("Unknown status");

  const rule = await client.query<{
    requires_assignee: boolean;
    requires_summary: boolean;
    requires_reason: boolean;
  }>(
    `select requires_assignee, requires_summary, requires_reason
     from ticket_transition_rules
     where tenant_id = $1 and from_status_id = $2 and to_status_id = $3 and actor_role = $4 and is_active`,
    [tenantId, ticket.status_id, targetStatus.id, role],
  );
  const transition = rule.rows[0];
  if (!transition) badRequest("Transition not allowed");

  if (transition.requires_assignee && !ticket.assignee_id) badRequest("Assign the ticket first");
  if ((transition.requires_summary || targetStatus.stage === "resolved") && !input.resolutionSummary) {
    badRequest("Resolution summary is required");
  }
  const reopening = targetStatus.stage === "open" && (ticket.status_stage === "resolved" || ticket.status_stage === "closed");
  if ((transition.requires_reason || targetStatus.stage === "pending" || reopening) && !input.reason) {
    badRequest("Reason is required");
  }
  if (reopening) {
    const settings = await client.query<{ reopen_window_days: number }>(
      "select reopen_window_days from tenant_settings where tenant_id = $1",
      [tenantId],
    );
    const windowDays = settings.rows[0]?.reopen_window_days ?? 0;
    const closedAt = ticket.resolved_at ?? ticket.closed_at;
    if (!closedAt || Date.now() > closedAt.getTime() + windowDays * 86_400_000) {
      badRequest("Reopen window has expired");
    }
  }

  const updated = await client.query(
    `update tickets set
       status_id = $3,
       resolution_summary = case when $4 = 'resolved' then $5
                                 when $4 = 'open' then null
                                 else resolution_summary end,
       pending_reason = case when $4 = 'pending' then $6 else null end,
       resolved_at = case when $4 = 'resolved' then now()
                          when $4 = 'open' then null
                          else resolved_at end,
       closed_at = case when $4 = 'closed' then now()
                        when $4 = 'open' then null
                        else closed_at end,
       sla_response_due_at = case when $9 then sla_response_due_at + (now() - sla_paused_at)
                                  else sla_response_due_at end,
       sla_resolution_due_at = case when $9 then sla_resolution_due_at + (now() - sla_paused_at)
                                    else sla_resolution_due_at end,
       sla_paused_at = case when $4 = 'pending' then coalesce(sla_paused_at, now())
                            when $9 then null
                            else sla_paused_at end,
       reopened_count = reopened_count + case when $7 then 1 else 0 end,
       version = version + 1,
       updated_at = now()
     where tenant_id = $1 and id = $2 and version = $8`,
    [
      tenantId,
      ticketId,
      targetStatus.id,
      targetStatus.stage,
      input.resolutionSummary ?? null,
      input.reason ?? null,
      reopening,
      input.expectedVersion,
      ticket.sla_paused_at !== null && targetStatus.stage !== "pending",
    ],
  );
  if ((updated.rowCount ?? 0) === 0) conflict("Ticket changed; reload and try again");

  await client.query(
    `insert into ticket_status_history
      (tenant_id, ticket_id, from_status_id, to_status_id, actor_id, actor_role, reason)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, ticketId, ticket.status_id, targetStatus.id, userId, role, input.reason ?? null],
  );

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.status_changed",
    "ticket",
    ticketId,
    { status: ticket.status_key },
    { status: targetStatus.key },
    correlationId,
  );

  const refreshed = await loadTicket(client, tenantId, ticketId);
  if (!refreshed) throw new Error("Ticket disappeared after transition");

  await enqueueEvent(client, tenantId, "ticket", ticketId, refreshed.version, "ticket.status_changed", {
    ticketId,
    fromStatus: ticket.status_key,
    toStatus: targetStatus.key,
    stage: targetStatus.stage,
    actorRole: role,
  });

  if (
    targetStatus.stage === "resolved" &&
    ticket.status_stage !== "resolved" &&
    ticket.status_stage !== "closed"
  ) {
    const summary = input.resolutionSummary ?? refreshed.resolution_summary ?? "";
    const eventId = await enqueueEvent(client, tenantId, "ticket", ticketId, refreshed.version, "ticket.resolved", {
      ticketId,
      resolutionSummary: summary,
    });
    if (ticket.requester_id !== userId) {
      await notifyFromTemplate(client, tenantId, eventId, ticketId, ticket.requester_id, "ticket_resolved", {
        number: refreshed.number,
        subject: refreshed.subject,
        summary,
      });
    }
  }

  if (
    (targetStatus.stage === "resolved" || targetStatus.stage === "closed") &&
    ticket.status_stage !== "resolved" &&
    ticket.status_stage !== "closed"
  ) {
    await requestFeedback(client, tenantId, ticketId);
  }

  if (role === "employee") {
    return {
      ...refreshed,
      custom_fields: await visibleCustomFields(client, tenantId, refreshed.category_id, refreshed.custom_fields, role),
    };
  }
  return refreshed;
}

export async function assignTicket(
  client: pg.PoolClient,
  tenantId: string,
  actorId: string | null,
  actorRole: string,
  ticketId: string,
  input: { teamId: string; assigneeId?: string | null; expectedVersion?: number },
  correlationId: string,
): Promise<TicketRow> {
  const ticket = await loadTicket(client, tenantId, ticketId, true);
  if (!ticket) notFound();
  if (actorRole === "agent" && actorId) {
    await assertCanRead(client, ticket, actorId, "agent");
  }
  if (input.expectedVersion !== undefined && ticket.version !== input.expectedVersion) {
    conflict("Ticket changed; reload and try again");
  }

  const team = await client.query<{ id: string; name: string }>(
    "select id, name from teams where tenant_id = $1 and id = $2 and is_active",
    [tenantId, input.teamId],
  );
  if ((team.rowCount ?? 0) === 0) badRequest("Unknown team");

  if (input.assigneeId) {
    const assignee = await client.query(
      "select 1 from memberships where tenant_id = $1 and user_id = $2 and is_active and role in ('agent', 'tenant_admin')",
      [tenantId, input.assigneeId],
    );
    if ((assignee.rowCount ?? 0) === 0) badRequest("Assignee is not an active agent");
    const member = await client.query(
      "select 1 from team_members where tenant_id = $1 and team_id = $2 and user_id = $3",
      [tenantId, input.teamId, input.assigneeId],
    );
    if ((member.rowCount ?? 0) === 0) badRequest("Assignee is not in the team");
  }

  let nextStatusId = ticket.status_id;
  if (ticket.status_stage === "new") {
    const openStatus = await getStatusByStage(client, tenantId, "open");
    if (!openStatus) throw new Error("Tenant has no open status");
    nextStatusId = openStatus.id;
  }

  await client.query(
    `update tickets set team_id = $3, assignee_id = $4, status_id = $5,
            version = version + 1, updated_at = now()
     where tenant_id = $1 and id = $2 and version = $6`,
    [
      tenantId,
      ticketId,
      input.teamId,
      input.assigneeId ?? null,
      nextStatusId,
      input.expectedVersion ?? ticket.version,
    ],
  );

  await client.query(
    `insert into ticket_assignment_history
      (tenant_id, ticket_id, from_assignee_id, to_assignee_id, from_team_id, to_team_id, actor_id, actor_role, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantId,
      ticketId,
      ticket.assignee_id,
      input.assigneeId ?? null,
      ticket.team_id,
      input.teamId,
      actorId,
      actorRole,
      actorRole === "automation" ? "automation" : "manual",
    ],
  );

  if (nextStatusId !== ticket.status_id) {
    await client.query(
      `insert into ticket_status_history
        (tenant_id, ticket_id, from_status_id, to_status_id, actor_id, actor_role, reason)
       values ($1, $2, $3, $4, $5, $6, 'assigned')`,
      [tenantId, ticketId, ticket.status_id, nextStatusId, actorId, actorRole],
    );
  }

  await writeAudit(
    client,
    tenantId,
    { id: actorId, role: actorRole },
    "ticket.assigned",
    "ticket",
    ticketId,
    { assigneeId: ticket.assignee_id, teamId: ticket.team_id },
    { assigneeId: input.assigneeId ?? null, teamId: input.teamId },
    correlationId,
  );

  const refreshed = await loadTicket(client, tenantId, ticketId);
  if (!refreshed) throw new Error("Ticket disappeared after assignment");

  await enqueueEvent(client, tenantId, "ticket", ticketId, refreshed.version, "ticket.assigned", {
    ticketId,
    teamId: input.teamId,
    assigneeId: input.assigneeId ?? null,
    actorRole,
  });

  return refreshed;
}

export async function addComment(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  ticketId: string,
  input: { body: string; visibility: "public" | "internal" },
  correlationId: string,
): Promise<{
  id: string;
  body: string;
  visibility: "public" | "internal";
  authorName: string;
  createdAt: Date;
}> {
  const ticket = await loadTicket(client, tenantId, ticketId, true);
  if (!ticket) notFound();
  await assertCanRead(client, ticket, userId, role);
  if (role === "employee" && input.visibility === "internal") badRequest("Employees cannot add internal notes");

  const id = randomUUID();
  await client.query(
    `insert into ticket_comments (tenant_id, id, ticket_id, author_id, body, visibility)
     values ($1, $2, $3, $4, $5, $6)`,
    [tenantId, id, ticketId, userId, input.body, input.visibility],
  );

  if ((role === "agent" || role === "tenant_admin") && input.visibility === "public" && !ticket.first_responded_at) {
    await client.query(
      "update tickets set first_responded_at = now(), version = version + 1, updated_at = now() where tenant_id = $1 and id = $2",
      [tenantId, ticketId],
    );
  }

  const author = await client.query<{ display_name: string }>("select display_name from users where id = $1", [userId]);
  const authorName = author.rows[0]?.display_name ?? "Unknown";

  if (input.visibility === "public") {
    const recipientId = role === "employee" ? ticket.assignee_id : ticket.requester_id;
    if (recipientId && recipientId !== userId) {
      const eventId = await enqueueEvent(client, tenantId, "ticket_comment", id, 1, "ticket.replied", {
        ticketId,
        commentId: id,
        authorId: userId,
        visibility: input.visibility,
      });
      await notifyFromTemplate(client, tenantId, eventId, ticketId, recipientId, "ticket_replied", {
        number: ticket.number,
        subject: ticket.subject,
        authorName,
        body: input.body,
      });
    }
  }

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    input.visibility === "internal" ? "ticket.internal_note_added" : "ticket.comment_added",
    "ticket",
    ticketId,
    null,
    { visibility: input.visibility },
    correlationId,
  );

  return {
    id,
    body: input.body,
    visibility: input.visibility,
    authorName,
    createdAt: new Date(),
  };
}

export async function ticketDetail(
  client: pg.PoolClient,
  tenantId: string,
  ticketId: string,
  userId: string,
  role: Role,
): Promise<Record<string, unknown>> {
  const ticket = await loadTicket(client, tenantId, ticketId);
  if (!ticket) notFound();
  await assertCanRead(client, ticket, userId, role);

  const comments = await client.query<{
    id: string;
    body: string;
    visibility: "public" | "internal";
    author_name: string;
    created_at: Date;
  }>(
    `select c.id, c.body, c.visibility, u.display_name as author_name, c.created_at
     from ticket_comments c
     join users u on u.id = c.author_id
     where c.tenant_id = $1 and c.ticket_id = $2
       and ($3 = false or c.visibility = 'public')
     order by c.created_at`,
    [tenantId, ticketId, role === "employee"],
  );

  const history = await client.query<{
    created_at: Date;
    from_label: string | null;
    to_label: string;
    actor_role: string;
    actor_name: string | null;
    reason: string | null;
  }>(
    `select h.created_at, fs.label as from_label, ts.label as to_label,
            h.actor_role, u.display_name as actor_name, h.reason
     from ticket_status_history h
     join ticket_statuses ts on ts.tenant_id = h.tenant_id and ts.id = h.to_status_id
     left join ticket_statuses fs on fs.tenant_id = h.tenant_id and fs.id = h.from_status_id
     left join users u on u.id = h.actor_id
     where h.tenant_id = $1 and h.ticket_id = $2
     order by h.created_at`,
    [tenantId, ticketId],
  );

  const assignments = await client.query<{
    created_at: Date;
    actor_role: string;
    actor_name: string | null;
    source: string;
    to_assignee_name: string | null;
    to_team_name: string | null;
  }>(
    `select ah.created_at, ah.actor_role, u.display_name as actor_name, ah.source,
            asg.display_name as to_assignee_name, tm.name as to_team_name
     from ticket_assignment_history ah
     left join users u on u.id = ah.actor_id
     left join users asg on asg.id = ah.to_assignee_id
     left join teams tm on tm.tenant_id = ah.tenant_id and tm.id = ah.to_team_id
     where ah.tenant_id = $1 and ah.ticket_id = $2
     order by ah.created_at`,
    [tenantId, ticketId],
  );

  const updates = await client.query<{
    created_at: Date;
    actor_role: string;
    actor_name: string | null;
  }>(
    `select a.created_at, a.actor_role, u.display_name as actor_name
     from audit_log a
     left join users u on u.id = a.actor_id
     where a.tenant_id = $1 and a.entity_type = 'ticket' and a.entity_id = $2
       and a.action = 'ticket.updated'
     order by a.created_at`,
    [tenantId, ticketId],
  );

  const transitions = await allowedTransitions(client, tenantId, ticket.status_id, role);
  const customFields = await visibleCustomFields(client, tenantId, ticket.category_id, ticket.custom_fields, role);
  const attachments = await client.query<{
    id: string;
    filename: string;
    content_type: string;
    size: number;
    uploader_id: string;
    uploader_name: string;
    created_at: Date;
  }>(
    `select a.id, a.filename, a.content_type, a.size, a.uploader_id,
            u.display_name as uploader_name, a.created_at
     from ticket_attachments a
     join users u on u.id = a.uploader_id
     where a.tenant_id = $1 and a.ticket_id = $2
     order by a.created_at`,
    [tenantId, ticketId],
  );

  return {
    ...ticket,
    custom_fields: customFields,
    comments: comments.rows,
    history: history.rows,
    assignments: assignments.rows,
    updates: updates.rows,
    attachments: attachments.rows,
    allowed_transitions: transitions,
  };
}
