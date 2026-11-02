import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  DEFAULT_NOTIFICATION_TEMPLATES,
  INVERSE_LINK_TYPES,
  renderTemplate,
  shiftedSlaDue,
  slaWarnDue,
  stagePausesResolution,
  type BusinessHoursConfig,
  type Role,
  type Stage,
  type TicketLinkType,
} from "@opspilot/core";
import { env } from "../env.js";
import { writeAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { requestFeedback } from "./feedback.js";
import { previewRoute } from "./routing.js";
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
  sla_response_warning_at: Date | null;
  sla_resolution_warning_at: Date | null;
  sla_response_warn_due_at: Date | null;
  sla_resolution_warn_due_at: Date | null;
  sla_paused_at: Date | null;
  pending_chaser_sent_at: Date | null;
  merged_into_ticket_id: string | null;
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
         t.sla_response_breached_at, t.sla_resolution_breached_at,
         t.sla_response_warning_at, t.sla_resolution_warning_at,
         t.sla_response_warn_due_at, t.sla_resolution_warn_due_at,
         t.sla_paused_at, t.pending_chaser_sent_at,
         t.merged_into_ticket_id,
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
  let row = template.rows[0];
  if (!row) {
    const fallback = DEFAULT_NOTIFICATION_TEMPLATES.find((t) => t.key === templateKey);
    if (!fallback) return;
    row = fallback;
  }

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

async function hasReadAccess(
  client: pg.PoolClient,
  ticket: TicketRow,
  userId: string,
  role: Role,
): Promise<boolean> {
  if (role === "tenant_admin") return true;
  if (role === "employee") {
    if (ticket.requester_id === userId) return true;
    const participant = await client.query(
      "select 1 from ticket_participants where tenant_id = $1 and ticket_id = $2 and user_id = $3",
      [ticket.tenant_id, ticket.id, userId],
    );
    if ((participant.rowCount ?? 0) > 0) return true;
    const mergedParticipant = await client.query(
      "select 1 from tickets where tenant_id = $1 and merged_into_ticket_id = $2 and requester_id = $3",
      [ticket.tenant_id, ticket.id, userId],
    );
    return (mergedParticipant.rowCount ?? 0) > 0;
  }
  if (ticket.assignee_id === userId) return true;
  if (ticket.assignee_id === null && ticket.team_id === null) return true;
  return isTeamMember(client, ticket.tenant_id, userId, ticket.team_id);
}

export async function assertCanRead(
  client: pg.PoolClient,
  ticket: TicketRow,
  userId: string,
  role: Role,
): Promise<void> {
  if (!(await hasReadAccess(client, ticket, userId, role))) notFound();
}

export type TicketListInput = {
  status?: string;
  priority?: string;
  assignee?: "me" | "none";
  state?: "open" | "closed";
  sort?: "priority" | "updated" | "due";
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
    conditions.push(
      `(t.requester_id = $${index} or exists (
        select 1 from ticket_participants p
        where p.tenant_id = t.tenant_id and p.ticket_id = t.id and p.user_id = $${index}
      ))`,
    );
    params.push(userId);
    index += 1;
  } else if (role === "agent") {
    conditions.push(
      `(t.assignee_id = $${index}
        or (t.assignee_id is null and t.team_id is null)
        or exists (
          select 1 from team_members tm
          where tm.tenant_id = t.tenant_id and tm.user_id = $${index} and tm.team_id = t.team_id
        ))`,
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
  if (input.assignee === "me") {
    conditions.push(`t.assignee_id = $${index++}`);
    params.push(userId);
  } else if (input.assignee === "none") {
    conditions.push("t.assignee_id is null");
  }
  if (input.state === "open") {
    conditions.push("s.stage not in ('resolved', 'closed')");
  } else if (input.state === "closed") {
    conditions.push("s.stage in ('resolved', 'closed')");
  }
  if (input.q) {
    const trimmed = input.q.trim();
    if (trimmed) {
      const numMatch = trimmed.match(/^(?:[A-Za-z]+[-_# ]*)?0*(\d+)$/);
      if (numMatch && numMatch[1]) {
        const ticketNum = parseInt(numMatch[1], 10);
        const pattern = `%${trimmed.replace(/[%_\\]/g, "\\$&")}%`;
        conditions.push(
          `(t.number = $${index++} or t.subject ilike $${index++} or coalesce(t.description, '') ilike $${index++} or req.display_name ilike $${index++})`,
        );
        params.push(ticketNum, pattern, pattern, pattern);
      } else {
        const words = trimmed.split(/\s+/).filter(Boolean);
        if (words.length > 0) {
          const wordConditions: string[] = [];
          for (const word of words) {
            const wordPattern = `%${word.replace(/[%_\\]/g, "\\$&")}%`;
            wordConditions.push(
              `(t.subject ilike $${index++} or coalesce(t.description, '') ilike $${index++} or req.display_name ilike $${index++})`,
            );
            params.push(wordPattern, wordPattern, wordPattern);
          }
          conditions.push(`(${wordConditions.join(" and ")})`);
        }
      }
    }
  }

  params.push(input.limit, input.offset);
  const limitIndex = index;
  const offsetIndex = index + 1;
  const orderBy =
    input.sort === "updated"
      ? "t.updated_at desc"
      : input.sort === "priority"
        ? "p.rank asc, t.created_at desc"
        : "least(coalesce(t.sla_response_due_at, 'infinity'), coalesce(t.sla_resolution_due_at, 'infinity')) asc, p.rank asc, t.created_at asc";

  const result = await client.query<TicketListRow>(
    `${ticketListSelect}
     where ${conditions.join(" and ")}
     order by ${orderBy}
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

function nextSlaClock(input: {
  stopped: boolean;
  currentDue: Date | null;
  currentWarn: Date | null;
  oldMinutes: number;
  newMinutes: number | null;
  clock: Date;
  createdAt: Date;
  config?: BusinessHoursConfig;
}): { due: Date | null; warn: Date | null } {
  if (input.stopped) return { due: input.currentDue, warn: input.currentWarn };
  if (input.newMinutes == null) return { due: null, warn: null };
  const hadTarget = input.currentDue !== null;
  const shift = {
    oldDue: hadTarget ? input.currentDue : null,
    oldMinutes: hadTarget ? input.oldMinutes : 0,
    newMinutes: input.newMinutes,
    clock: hadTarget ? input.clock : input.createdAt,
    config: input.config,
  };
  return { due: shiftedSlaDue(shift), warn: slaWarnDue(shift) };
}

export async function getBusinessHoursConfig(
  client: pg.PoolClient | pg.Pool,
  tenantId: string,
): Promise<BusinessHoursConfig | undefined> {
  const settings = await client.query<{
    timezone: string | null;
    business_hours_start: string;
    business_hours_end: string;
    business_days: number[];
  }>(
    `select timezone, business_hours_start, business_hours_end, business_days
       from tenant_settings
      where tenant_id = $1`,
    [tenantId],
  );
  const row = settings.rows[0];
  if (!row) return undefined;
  const holidays = await client.query<{ holiday_on: string }>(
    "select to_char(holiday_on, 'YYYY-MM-DD') as holiday_on from tenant_holidays where tenant_id = $1",
    [tenantId],
  );
  const [sh = 9, sm = 0] = (row.business_hours_start || "09:00").split(":").map(Number);
  const [eh = 17, em = 0] = (row.business_hours_end || "17:00").split(":").map(Number);
  return {
    startHour: sh,
    startMinute: sm,
    endHour: eh,
    endMinute: em,
    businessDays: row.business_days || [1, 2, 3, 4, 5],
    timeZone: row.timezone || "UTC",
    holidays: holidays.rows.map((holiday) => holiday.holiday_on),
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
    customFields: Record<string, unknown>;
  },
  correlationId: string,
): Promise<TicketRow> {
  const category = await client.query("select 1 from categories where tenant_id = $1 and id = $2 and is_active", [
    tenantId,
    input.categoryId,
  ]);
  if ((category.rowCount ?? 0) === 0) return badRequest("Unknown category");

  const priority = await client.query<{ id: string }>(
    `select coalesce(
       (select p.id from priorities p
        where p.tenant_id = c.tenant_id and p.id = c.default_priority_id and p.is_active),
       (select p.id from priorities p
        where p.tenant_id = $1 and p.is_active
        order by p.rank desc, p.key
        limit 1)
     ) as id
     from categories c
     where c.tenant_id = $1 and c.id = $2`,
    [tenantId, input.categoryId],
  );
  const priorityId = priority.rows[0]?.id;
  if (!priorityId) return badRequest("Unknown priority");

  const customFields = await validateCustomFields(client, tenantId, input.categoryId, input.customFields, role);
  const route = await previewRoute(client, tenantId, {
    categoryId: input.categoryId,
    priorityId,
    customFields,
  });

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

  const sla = await client.query<{
    id: string;
    response_minutes: number;
    resolution_minutes: number;
    business_hours_only: boolean;
  }>(
    `select id, response_minutes, resolution_minutes, coalesce(business_hours_only, false) as business_hours_only
     from sla_policies
     where tenant_id = $1 and is_active
       and (priority_id is null or priority_id = $2)
       and (category_id is null or category_id = $3)
     order by (category_id is not null) desc, (priority_id is not null) desc, created_at
     limit 1`,
    [tenantId, priorityId, input.categoryId],
  );
  const slaPolicy = sla.rows[0];
  const bhConfig = slaPolicy?.business_hours_only
    ? await getBusinessHoursConfig(client, tenantId)
    : undefined;
  const now = new Date();
  const responseDueAt = slaPolicy?.response_minutes
    ? addBusinessMinutes(now, slaPolicy.response_minutes, bhConfig)
    : null;
  const resolutionDueAt = slaPolicy?.resolution_minutes
    ? addBusinessMinutes(now, slaPolicy.resolution_minutes, bhConfig)
    : null;
  const responseWarnAt = slaPolicy?.response_minutes
    ? slaWarnDue({ oldDue: null, oldMinutes: 0, newMinutes: slaPolicy.response_minutes, clock: now, config: bhConfig })
    : null;
  const resolutionWarnAt = slaPolicy?.resolution_minutes
    ? slaWarnDue({
        oldDue: null,
        oldMinutes: 0,
        newMinutes: slaPolicy.resolution_minutes,
        clock: now,
        config: bhConfig,
      })
    : null;

  const id = randomUUID();
  await client.query(
    `insert into tickets
      (tenant_id, id, number, subject, description, requester_id, team_id, category_id, priority_id, status_id, custom_fields,
       sla_policy_id, sla_response_due_at, sla_resolution_due_at, sla_response_warn_due_at, sla_resolution_warn_due_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      tenantId,
      id,
      number,
      input.subject,
      input.description,
      userId,
      route?.teamId ?? null,
      input.categoryId,
      priorityId,
      newStatus.id,
      JSON.stringify(customFields),
      slaPolicy?.id ?? null,
      responseDueAt,
      resolutionDueAt,
      responseWarnAt,
      resolutionWarnAt,
    ],
  );

  if (route) {
    await client.query(
      `insert into ticket_assignment_history
        (tenant_id, ticket_id, to_team_id, actor_id, actor_role, source)
       values ($1, $2, $3, $4, 'system', 'automation')`,
      [tenantId, id, route.teamId, userId],
    );
  }

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
    {
      subject: input.subject,
      categoryId: input.categoryId,
      priorityId,
      teamId: route?.teamId ?? null,
    },
    correlationId,
  );

  await enqueueEvent(client, tenantId, "ticket", id, 0, "ticket.created", {
    ticketId: id,
    number,
    subject: input.subject,
    categoryId: input.categoryId,
    priorityId,
    teamId: route?.teamId ?? null,
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
  let responseDueAt: Date | null = ticket.sla_response_due_at;
  let resolutionDueAt: Date | null = ticket.sla_resolution_due_at;
  let responseWarnAt: Date | null = ticket.sla_response_warn_due_at;
  let resolutionWarnAt: Date | null = ticket.sla_resolution_warn_due_at;
  if (slaChanged) {
    const sla = await client.query<{
      id: string;
      response_minutes: number;
      resolution_minutes: number;
      business_hours_only: boolean;
    }>(
      `select id, response_minutes, resolution_minutes, coalesce(business_hours_only, false) as business_hours_only
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
    const previous = ticket.sla_policy_id
      ? await client.query<{
          response_minutes: number;
          resolution_minutes: number;
          business_hours_only: boolean;
        }>(
          `select response_minutes, resolution_minutes, coalesce(business_hours_only, false) as business_hours_only
           from sla_policies where tenant_id = $1 and id = $2`,
          [tenantId, ticket.sla_policy_id],
        )
      : { rows: [] };
    const oldPolicy = previous.rows[0];
    const bhConfig = policy?.business_hours_only || oldPolicy?.business_hours_only
      ? await getBusinessHoursConfig(client, tenantId)
      : undefined;
    const createdAt = new Date(ticket.created_at);
    const clock = ticket.sla_paused_at ?? new Date();
    const responseClock = nextSlaClock({
      stopped: ticket.first_responded_at !== null,
      currentDue: ticket.sla_response_due_at,
      currentWarn: ticket.sla_response_warn_due_at,
      oldMinutes:
        oldPolicy?.response_minutes ??
        (ticket.sla_response_due_at
          ? businessMinutesBetween(createdAt, ticket.sla_response_due_at, bhConfig)
          : 0),
      newMinutes: policy?.response_minutes ?? null,
      clock,
      createdAt,
      config: policy?.business_hours_only ? bhConfig : undefined,
    });
    const resolutionClock = nextSlaClock({
      stopped: ticket.resolved_at !== null || ticket.closed_at !== null,
      currentDue: ticket.sla_resolution_due_at,
      currentWarn: ticket.sla_resolution_warn_due_at,
      oldMinutes:
        oldPolicy?.resolution_minutes ??
        (ticket.sla_resolution_due_at
          ? businessMinutesBetween(createdAt, ticket.sla_resolution_due_at, bhConfig)
          : 0),
      newMinutes: policy?.resolution_minutes ?? null,
      clock,
      createdAt,
      config: policy?.business_hours_only ? bhConfig : undefined,
    });
    responseDueAt = responseClock.due;
    responseWarnAt = responseClock.warn;
    resolutionDueAt = resolutionClock.due;
    resolutionWarnAt = resolutionClock.warn;
  }

  const updated = await client.query(
    `update tickets set
       subject = $3,
       description = $4,
       category_id = $5,
       priority_id = $6,
       custom_fields = $7,
       sla_policy_id = case when $8 then $9 else sla_policy_id end,
       sla_response_due_at = case when $8 then $10 else sla_response_due_at end,
       sla_resolution_due_at = case when $8 then $11 else sla_resolution_due_at end,
       sla_response_warn_due_at = case when $8 then $12 else sla_response_warn_due_at end,
       sla_resolution_warn_due_at = case when $8 then $13 else sla_resolution_warn_due_at end,
       version = version + 1,
       updated_at = now()
     where tenant_id = $1 and id = $2 and version = $14`,
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
      responseDueAt,
      resolutionDueAt,
      responseWarnAt,
      resolutionWarnAt,
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

type StatusRef = { id: string; key: string; label: string; stage: Stage; pauses_sla: boolean };

async function getStatusByStage(
  client: pg.PoolClient,
  tenantId: string,
  stage: Stage,
): Promise<StatusRef | null> {
  const result = await client.query<StatusRef>(
    "select id, key, label, stage, pauses_sla from ticket_statuses where tenant_id = $1 and stage = $2 and is_active order by sort_order limit 1",
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
    "select id, key, label, stage, pauses_sla from ticket_statuses where tenant_id = $1 and id = $2 and is_active",
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
       sla_response_warn_due_at = case when $9 then sla_response_warn_due_at + (now() - sla_paused_at)
                                       else sla_response_warn_due_at end,
       sla_resolution_warn_due_at = case when $9 then sla_resolution_warn_due_at + (now() - sla_paused_at)
                                         else sla_resolution_warn_due_at end,
       sla_paused_at = case when $10 then coalesce(sla_paused_at, now())
                            when $9 then null
                            else sla_paused_at end,
       pending_chaser_sent_at = case when $10 then null
                                     when $9 then null
                                     else pending_chaser_sent_at end,
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
      ticket.sla_paused_at !== null && !stagePausesResolution(targetStatus.pauses_sla),
      stagePausesResolution(targetStatus.pauses_sla),
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
       values ($1, $2, $3, $4, $5, $6, 'Assigned to team')`,
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

export async function claimTicket(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  ticketId: string,
  expectedVersion: number,
  correlationId: string,
): Promise<TicketRow> {
  const ticket = await loadTicket(client, tenantId, ticketId, true);
  if (!ticket) notFound();
  if (role === "employee") badRequest("Employees cannot claim tickets");
  await assertCanRead(client, ticket, userId, role);
  if (!ticket.team_id) badRequest("Route the ticket to a team before claiming it");
  if (role === "agent" && !(await isTeamMember(client, tenantId, userId, ticket.team_id))) {
    badRequest("You can only claim tickets for your team");
  }
  if (ticket.version !== expectedVersion) conflict("Ticket changed; reload and try again");
  if (ticket.assignee_id) conflict("Ticket is already claimed");

  let nextStatusId = ticket.status_id;
  if (ticket.status_stage === "new") {
    const openStatus = await getStatusByStage(client, tenantId, "open");
    if (!openStatus) throw new Error("Tenant has no open status");
    nextStatusId = openStatus.id;
  }

  const updated = await client.query(
    `update tickets set assignee_id = $3, status_id = $4, version = version + 1, updated_at = now()
     where tenant_id = $1 and id = $2 and assignee_id is null and version = $5`,
    [tenantId, ticketId, userId, nextStatusId, expectedVersion],
  );
  if ((updated.rowCount ?? 0) === 0) {
    const current = await loadTicket(client, tenantId, ticketId);
    if (current?.assignee_id) conflict("Ticket is already claimed");
    conflict("Ticket changed; reload and try again");
  }

  await client.query(
    `insert into ticket_assignment_history
      (tenant_id, ticket_id, from_assignee_id, to_assignee_id, from_team_id, to_team_id, actor_id, actor_role, source)
     values ($1, $2, null, $3, $4, $4, $3, $5, 'manual')`,
    [tenantId, ticketId, userId, ticket.team_id, role],
  );
  if (nextStatusId !== ticket.status_id) {
    await client.query(
      `insert into ticket_status_history
        (tenant_id, ticket_id, from_status_id, to_status_id, actor_id, actor_role, reason)
       values ($1, $2, $3, $4, $5, $6, 'Claimed')`,
      [tenantId, ticketId, ticket.status_id, nextStatusId, userId, role],
    );
  }
  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.claimed",
    "ticket",
    ticketId,
    { assigneeId: null, teamId: ticket.team_id },
    { assigneeId: userId, teamId: ticket.team_id },
    correlationId,
  );
  const refreshed = await loadTicket(client, tenantId, ticketId);
  if (!refreshed) throw new Error("Ticket disappeared after claim");
  await enqueueEvent(client, tenantId, "ticket", ticketId, refreshed.version, "ticket.assigned", {
    ticketId,
    teamId: ticket.team_id,
    assigneeId: userId,
    actorRole: role,
  });
  return refreshed;
}

export async function addComment(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  ticketId: string,
  input: { body: string; visibility: "public" | "internal"; countsAsFirstResponse?: boolean },
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

  if (
    input.countsAsFirstResponse &&
    (role === "agent" || role === "tenant_admin") &&
    input.visibility === "public" &&
    !ticket.first_responded_at
  ) {
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
    action: string;
    after: Record<string, unknown> | null;
    before: Record<string, unknown> | null;
  }>(
    `select a.created_at, a.actor_role, u.display_name as actor_name, a.action, a.after, a.before
     from audit_log a
     join tickets t on t.tenant_id = a.tenant_id and t.id = a.entity_id
     left join users u on u.id = a.actor_id
     where a.tenant_id = $1 and a.entity_type = 'ticket' and a.entity_id = $2
       and (
         a.action = 'ticket.updated'
         or a.action = 'ticket.merged'
         or a.action = 'ticket.link_created'
         or a.action = 'ticket.link_deleted'
         or a.action = 'ticket.sla_escalated'
         or a.action = 'ticket.sla_response_warning'
         or a.action = 'ticket.sla_resolution_warning'
         or (a.action = 'ticket.sla_response_breached' and t.sla_response_breached_at is not null)
         or (a.action = 'ticket.sla_resolution_breached' and t.sla_resolution_breached_at is not null)
       )
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

  const links = role === "employee" ? [] : await getTicketLinks(client, tenantId, ticketId);
  let mergedIntoTicket: { id: string; number: number; subject: string } | null = null;
  if (ticket.merged_into_ticket_id) {
    const parent = await client.query<{ id: string; number: number; subject: string }>(
      "select id, number, subject from tickets where tenant_id = $1 and id = $2 and deleted_at is null",
      [tenantId, ticket.merged_into_ticket_id],
    );
    if (parent.rows[0]) {
      mergedIntoTicket = parent.rows[0];
    }
  }

  const participants = await client.query<{ id: string; display_name: string; email: string }>(
    `select u.id, u.display_name, u.email
     from ticket_participants tp
     join users u on u.id = tp.user_id
     where tp.tenant_id = $1 and tp.ticket_id = $2
     order by tp.created_at`,
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
    links,
    merged_into: mergedIntoTicket,
    participants: participants.rows,
  };
}

export type TicketLinkRow = {
  id: string;
  link_type: TicketLinkType;
  linked_ticket_id: string;
  linked_ticket_number: number;
  linked_ticket_subject: string;
  linked_ticket_status: string;
  linked_ticket_stage: Stage;
  created_at: Date;
};

export async function getTicketLinks(
  client: pg.PoolClient,
  tenantId: string,
  ticketId: string,
  userId?: string,
  role?: Role,
): Promise<TicketLinkRow[]> {
  if (role === "employee") return [];
  if (userId && role) {
    const ticket = await loadTicket(client, tenantId, ticketId);
    if (!ticket) notFound();
    await assertCanRead(client, ticket, userId, role);
  }

  const result = await client.query<{
    id: string;
    raw_type: TicketLinkType;
    is_source: boolean;
    linked_ticket_id: string;
    linked_ticket_number: number;
    linked_ticket_subject: string;
    linked_ticket_status: string;
    linked_ticket_stage: Stage;
    created_at: Date;
  }>(
    `select tl.id,
            tl.link_type as raw_type,
            true as is_source,
            t.id as linked_ticket_id,
            t.number as linked_ticket_number,
            t.subject as linked_ticket_subject,
            s.label as linked_ticket_status,
            s.stage as linked_ticket_stage,
            tl.created_at
     from ticket_links tl
     join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.target_ticket_id
     join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
     where tl.tenant_id = $1 and tl.source_ticket_id = $2 and t.deleted_at is null

     union all

     select tl.id,
            tl.link_type as raw_type,
            false as is_source,
            t.id as linked_ticket_id,
            t.number as linked_ticket_number,
            t.subject as linked_ticket_subject,
            s.label as linked_ticket_status,
            s.stage as linked_ticket_stage,
            tl.created_at
     from ticket_links tl
     join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.source_ticket_id
     join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
     where tl.tenant_id = $1 and tl.target_ticket_id = $2 and t.deleted_at is null

     order by created_at desc`,
    [tenantId, ticketId],
  );

  const links: TicketLinkRow[] = [];
  for (const row of result.rows) {
    if (userId && role) {
      const linkedTicket = await loadTicket(client, tenantId, row.linked_ticket_id);
      if (!linkedTicket || !(await hasReadAccess(client, linkedTicket, userId, role))) continue;
    }
    links.push({
      id: row.id,
      link_type: (row.is_source ? row.raw_type : INVERSE_LINK_TYPES[row.raw_type] ?? row.raw_type) as TicketLinkType,
      linked_ticket_id: row.linked_ticket_id,
      linked_ticket_number: row.linked_ticket_number,
      linked_ticket_subject: row.linked_ticket_subject,
      linked_ticket_status: row.linked_ticket_status,
      linked_ticket_stage: row.linked_ticket_stage,
      created_at: row.created_at,
    });
  }
  return links;
}

export async function createTicketLink(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  ticketId: string,
  input: { targetTicketNumber: number; linkType: TicketLinkType },
  correlationId: string,
): Promise<TicketLinkRow> {
  if (role === "employee") {
    badRequest("Employees cannot link tickets");
  }

  const source = await loadTicket(client, tenantId, ticketId);
  if (!source) notFound();
  await assertCanRead(client, source, userId, role);

  const targetRes = await client.query<{
    id: string;
    number: number;
    subject: string;
    status_label: string;
    status_stage: Stage;
  }>(
    `select t.id, t.number, t.subject, s.label as status_label, s.stage as status_stage
     from tickets t
     join ticket_statuses s on s.tenant_id = t.tenant_id and s.id = t.status_id
     where t.tenant_id = $1 and t.number = $2 and t.deleted_at is null`,
    [tenantId, input.targetTicketNumber],
  );
  const target = targetRes.rows[0];
  if (!target) {
    badRequest(`Ticket #${input.targetTicketNumber} not found`);
  }
  const targetTicket = await loadTicket(client, tenantId, target.id);
  if (!targetTicket) {
    badRequest(`Ticket #${input.targetTicketNumber} not found`);
  }
  await assertCanRead(client, targetTicket, userId, role);

  if (source.id === target.id) {
    badRequest("Cannot link a ticket to itself");
  }

  const existing = await client.query(
    `select id from ticket_links
     where tenant_id = $1 and (
       (source_ticket_id = $2 and target_ticket_id = $3 and link_type = $4) or
       (source_ticket_id = $3 and target_ticket_id = $2 and link_type = $5)
     )`,
    [tenantId, source.id, target.id, input.linkType, INVERSE_LINK_TYPES[input.linkType]],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    conflict("This link already exists");
  }

  const inserted = await client.query<{ id: string; created_at: Date }>(
    `insert into ticket_links (tenant_id, source_ticket_id, target_ticket_id, link_type, created_by)
     values ($1, $2, $3, $4, $5)
     returning id, created_at`,
    [tenantId, source.id, target.id, input.linkType, userId],
  );

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.link_created",
    "ticket",
    source.id,
    null,
    {
      linkId: inserted.rows[0]?.id,
      linkType: input.linkType,
      targetTicketId: target.id,
      targetTicketNumber: target.number,
    },
    correlationId,
  );

  return {
    id: inserted.rows[0]!.id,
    link_type: input.linkType,
    linked_ticket_id: target.id,
    linked_ticket_number: target.number,
    linked_ticket_subject: target.subject,
    linked_ticket_status: target.status_label,
    linked_ticket_stage: target.status_stage,
    created_at: inserted.rows[0]!.created_at,
  };
}

export async function deleteTicketLink(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  ticketId: string,
  linkId: string,
  correlationId: string,
): Promise<void> {
  if (role === "employee") {
    badRequest("Employees cannot remove ticket links");
  }

  const ticket = await loadTicket(client, tenantId, ticketId);
  if (!ticket) notFound();
  await assertCanRead(client, ticket, userId, role);

  const link = await client.query<{ id: string; source_ticket_id: string; target_ticket_id: string; link_type: string }>(
    `select id, source_ticket_id, target_ticket_id, link_type
     from ticket_links
     where tenant_id = $1 and id = $2 and (source_ticket_id = $3 or target_ticket_id = $3)`,
    [tenantId, linkId, ticketId],
  );
  if (!link.rows[0]) {
    notFound();
  }

  const otherTicketId =
    link.rows[0].source_ticket_id === ticketId ? link.rows[0].target_ticket_id : link.rows[0].source_ticket_id;
  const otherTicket = await loadTicket(client, tenantId, otherTicketId);
  if (!otherTicket) notFound();
  await assertCanRead(client, otherTicket, userId, role);

  await client.query("delete from ticket_links where tenant_id = $1 and id = $2", [tenantId, linkId]);

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.link_deleted",
    "ticket",
    ticketId,
    null,
    { linkId },
    correlationId,
  );
}

export async function mergeTickets(
  client: pg.PoolClient,
  tenantId: string,
  userId: string,
  role: Role,
  currentTicketId: string,
  input: { targetTicketNumber: number; direction: "merge_into_this" | "merge_this_into"; reason?: string },
  correlationId: string,
): Promise<{
  primaryTicketId: string;
  secondaryTicketId: string;
  primaryNumber: number;
  secondaryNumber: number;
  redirectedFromPrimaryNumber?: number | null;
}> {
  if (role === "employee") {
    badRequest("Employees cannot merge tickets");
  }

  const current = await loadTicket(client, tenantId, currentTicketId);
  if (!current) notFound();
  await assertCanRead(client, current, userId, role);

  const other = await client.query<{
    id: string;
    number: number;
    subject: string;
    description: string;
    requester_id: string;
    requester_name: string;
    merged_into_ticket_id: string | null;
    status_id: string;
  }>(
    `select t.id, t.number, t.subject, t.description, t.requester_id, req.display_name as requester_name, t.merged_into_ticket_id, t.status_id
     from tickets t
     join users req on req.id = t.requester_id
     where t.tenant_id = $1 and t.number = $2 and t.deleted_at is null`,
    [tenantId, input.targetTicketNumber],
  );
  const otherTicket = other.rows[0];
  if (!otherTicket) {
    badRequest(`Ticket #${input.targetTicketNumber} not found`);
  }
  const otherFull = await loadTicket(client, tenantId, otherTicket.id);
  if (!otherFull) {
    badRequest(`Ticket #${input.targetTicketNumber} not found`);
  }
  await assertCanRead(client, otherFull, userId, role);

  if (current.id === otherTicket.id) {
    badRequest("Cannot merge a ticket into itself");
  }

  let primary: { id: string; number: number; subject: string; merged_into_ticket_id: string | null };
  let secondary: {
    id: string;
    number: number;
    subject: string;
    description: string;
    requester_id: string;
    requester_name: string;
    merged_into_ticket_id: string | null;
    status_id: string;
  };

  if (input.direction === "merge_into_this") {
    primary = current;
    secondary = otherTicket;
  } else {
    primary = otherTicket;
    secondary = current;
  }

  // Follow primary chain to root ticket if target was previously merged
  let redirectedFromPrimaryNumber: number | null = null;
  const visited = new Set<string>([primary.id]);
  while (primary.merged_into_ticket_id) {
    if (!redirectedFromPrimaryNumber) {
      redirectedFromPrimaryNumber = primary.number;
    }
    const nextRoot = await loadTicket(client, tenantId, primary.merged_into_ticket_id);
    if (!nextRoot || visited.has(nextRoot.id)) break;
    visited.add(nextRoot.id);
    primary = nextRoot;
  }

  if (primary.id === secondary.id) {
    if (redirectedFromPrimaryNumber) {
      badRequest(
        `Cannot merge ticket #${secondary.number} into #${redirectedFromPrimaryNumber} because #${redirectedFromPrimaryNumber} is already merged into #${secondary.number}`,
      );
    }
    badRequest("Cannot merge a ticket into itself");
  }

  if (secondary.merged_into_ticket_id) {
    badRequest(`Ticket #${secondary.number} has already been merged`);
  }

  const closedStatusRes = await client.query<{ id: string; label: string }>(
    `select id, label from ticket_statuses
     where tenant_id = $1 and stage = 'closed' and is_active
     order by sort_order asc
     limit 1`,
    [tenantId],
  );
  const closedStatus = closedStatusRes.rows[0];
  if (!closedStatus) {
    throw new Error("Tenant has no closed status");
  }

  const actor = await client.query<{ display_name: string }>(
    "select display_name from users where id = $1",
    [userId],
  );
  const actorName = actor.rows[0]?.display_name ?? "Agent";

  await client.query(
    `update tickets
     set status_id = $1,
         merged_into_ticket_id = $2,
         closed_at = coalesce(closed_at, now()),
         updated_at = now(),
         version = version + 1
     where tenant_id = $3 and id = $4`,
    [closedStatus.id, primary.id, tenantId, secondary.id],
  );

  await client.query(
    `insert into ticket_status_history
      (tenant_id, ticket_id, from_status_id, to_status_id, actor_id, actor_role, reason)
     values
      ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, secondary.id, secondary.status_id, closedStatus.id, userId, role, `Merged into #${primary.number}`],
  );

  await client.query(
    `insert into ticket_links (tenant_id, source_ticket_id, target_ticket_id, link_type, created_by)
     values ($1, $2, $3, 'merged_into', $4)
     on conflict (tenant_id, source_ticket_id, target_ticket_id, link_type) do nothing`,
    [tenantId, secondary.id, primary.id, userId],
  );

  // Consolidate the secondary conversation into the primary ticket.
  const secondaryComments = await client.query<{
    author_id: string;
    body: string;
    visibility: "public" | "internal";
    created_at: Date;
  }>(
    `select author_id, body, visibility, created_at
     from ticket_comments
     where tenant_id = $1 and ticket_id = $2
     order by created_at`,
    [tenantId, secondary.id],
  );
  for (const comment of secondaryComments.rows) {
    await client.query(
      `insert into ticket_comments (tenant_id, ticket_id, author_id, body, visibility, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        primary.id,
        comment.author_id,
        `[From #${secondary.number}] ${comment.body}`.slice(0, 20000),
        comment.visibility,
        comment.created_at,
      ],
    );
  }

  // Copy attachments from secondary to primary
  const secAttachments = await client.query<{
    id: string;
    uploader_id: string;
    filename: string;
    content_type: string;
    size: number;
    storage_key: string;
    created_at: Date;
  }>(
    `select id, uploader_id, filename, content_type, size, storage_key, created_at
     from ticket_attachments
     where tenant_id = $1 and ticket_id = $2`,
    [tenantId, secondary.id],
  );

  for (const att of secAttachments.rows) {
    const newId = randomUUID();
    const newStorageKey = `${tenantId}/${primary.id}/${randomUUID()}_${att.filename}`;
    const oldPath = resolve(env.UPLOAD_DIR, att.storage_key);
    const newPath = resolve(env.UPLOAD_DIR, newStorageKey);
    try {
      await mkdir(dirname(newPath), { recursive: true });
      await copyFile(oldPath, newPath);
    } catch {
      // Source file may not exist on disk in test environments
    }
    await client.query(
      `insert into ticket_attachments
        (tenant_id, id, ticket_id, uploader_id, filename, content_type, size, storage_key, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, newId, primary.id, att.uploader_id, att.filename, att.content_type, att.size, newStorageKey, att.created_at],
    );
  }

  // Add secondary requester and existing participants as participants on primary
  await client.query(
    `insert into ticket_participants (tenant_id, ticket_id, user_id)
     values ($1, $2, $3)
     on conflict (tenant_id, ticket_id, user_id) do nothing`,
    [tenantId, primary.id, secondary.requester_id],
  );

  const secParticipants = await client.query<{ user_id: string }>(
    `select user_id from ticket_participants where tenant_id = $1 and ticket_id = $2`,
    [tenantId, secondary.id],
  );
  for (const part of secParticipants.rows) {
    await client.query(
      `insert into ticket_participants (tenant_id, ticket_id, user_id)
       values ($1, $2, $3)
       on conflict (tenant_id, ticket_id, user_id) do nothing`,
      [tenantId, primary.id, part.user_id],
    );
  }

  const secCommentBody = `This ticket was merged into #${primary.number} ("${primary.subject}") by ${actorName}.${input.reason ? `\n\nReason: ${input.reason}` : ""}`;
  await addComment(
    client,
    tenantId,
    userId,
    role,
    secondary.id,
    { body: secCommentBody, visibility: "internal", countsAsFirstResponse: false },
    correlationId,
  );

  const autoRedirectNote = redirectedFromPrimaryNumber
    ? `\nNote: Target ticket #${redirectedFromPrimaryNumber} was previously merged into this ticket.`
    : "";
  const primCommentBody = `Merged ticket #${secondary.number} ("${secondary.subject}") into this ticket by ${actorName}.${autoRedirectNote}${input.reason ? `\nReason: ${input.reason}` : ""}\n\nOriginal Requester: ${secondary.requester_name}\nOriginal Description:\n${secondary.description}`;
  await addComment(
    client,
    tenantId,
    userId,
    role,
    primary.id,
    { body: primCommentBody, visibility: "internal", countsAsFirstResponse: false },
    correlationId,
  );

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.merged",
    "ticket",
    secondary.id,
    null,
    {
      mergedIntoTicketId: primary.id,
      mergedIntoTicketNumber: primary.number,
      redirectedFromPrimaryNumber,
      reason: input.reason,
    },
    correlationId,
  );

  await writeAudit(
    client,
    tenantId,
    { id: userId, role },
    "ticket.merged",
    "ticket",
    primary.id,
    null,
    {
      secondaryTicketId: secondary.id,
      secondaryTicketNumber: secondary.number,
      redirectedFromPrimaryNumber,
      reason: input.reason,
    },
    correlationId,
  );

  const secEventId = await enqueueEvent(client, tenantId, "ticket", secondary.id, 0, "ticket.merged", {
    ticketId: secondary.id,
    mergedIntoTicketId: primary.id,
    mergedIntoTicketNumber: primary.number,
  });

  await enqueueEvent(client, tenantId, "ticket", primary.id, 0, "ticket.merged", {
    ticketId: primary.id,
    secondaryTicketId: secondary.id,
    secondaryTicketNumber: secondary.number,
  });

  await notifyFromTemplate(client, tenantId, secEventId, primary.id, secondary.requester_id, "ticket_merged", {
    number: primary.number,
    subject: primary.subject,
    secondaryNumber: secondary.number,
    secondarySubject: secondary.subject,
  });

  return {
    primaryTicketId: primary.id,
    secondaryTicketId: secondary.id,
    primaryNumber: primary.number,
    secondaryNumber: secondary.number,
    redirectedFromPrimaryNumber,
  };
}
