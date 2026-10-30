import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  cleanEmailBody,
  parseEmailAddress,
  parseTicketNumberFromSubject,
  type InboundEmailInput,
  type Role,
} from "@opspilot/core";
import { hashPassword } from "@opspilot/core/password";
import { writeAudit } from "../audit.js";
import { badRequest, notFound } from "../errors.js";
import { addComment, createTicket, loadTicket } from "./tickets.js";

export type ProcessInboundEmailResult = {
  action: "ticket_created" | "comment_added" | "duplicate" | "ignored";
  ticketId?: string;
  ticketNumber?: number;
  commentId?: string;
  tenantSlug: string;
};

export async function processInboundEmail(
  client: pg.PoolClient,
  input: InboundEmailInput,
  overrideTenantId?: string,
  correlationId: string = randomUUID(),
): Promise<ProcessInboundEmailResult> {
  const fromParsed = parseEmailAddress(input.from);
  if (!fromParsed.address || !fromParsed.address.includes("@")) {
    throw badRequest("Invalid sender email address");
  }

  const lowerFrom = fromParsed.address.toLowerCase();
  if (
    lowerFrom.includes("no-reply@") ||
    lowerFrom.includes("noreply@") ||
    lowerFrom.includes("mailer-daemon@") ||
    lowerFrom.includes("postmaster@")
  ) {
    return { action: "ignored", tenantSlug: "" };
  }

  const rawBody = input.body || input.text || (input.html ? input.html.replace(/<[^>]+>/g, " ").trim() : "");
  const cleanBody = cleanEmailBody(rawBody);
  const cleanSubject = input.subject.trim();
  const messageId = input.messageId?.trim() || randomUUID();

  // 1. Resolve Tenant
  let tenantId: string | null = null;
  let tenantSlug = "";
  let tenantPrefix = "OPS";
  let targetTicketIdFromHeader: string | null = null;

  if (overrideTenantId) {
    const t = await client.query<{ id: string; slug: string; ticket_prefix: string }>(
      `select t.id, t.slug, coalesce(ts.ticket_prefix, 'OPS') as ticket_prefix
       from tenants t
       left join tenant_settings ts on ts.tenant_id = t.id
       where t.id = $1`,
      [overrideTenantId],
    );
    if (!t.rows[0]) throw notFound("Tenant not found");
    tenantId = t.rows[0].id;
    tenantSlug = t.rows[0].slug;
    tenantPrefix = t.rows[0].ticket_prefix;
  } else {
    // Try in-reply-to or references notification ID
    const refText = `${input.inReplyTo ?? ""} ${input.references ?? ""}`;
    const notificationMatch = refText.match(/notification-([a-f0-9-]{36})@/i);
    if (notificationMatch) {
      const notif = await client.query<{ tenant_id: string; ticket_id: string; slug: string; ticket_prefix: string }>(
        `select n.tenant_id, n.ticket_id, t.slug, coalesce(ts.ticket_prefix, 'OPS') as ticket_prefix
         from notifications n
         join tenants t on t.id = n.tenant_id
         left join tenant_settings ts on ts.tenant_id = t.id
         where n.id = $1`,
        [notificationMatch[1]],
      );
      if (notif.rows[0]) {
        tenantId = notif.rows[0].tenant_id;
        tenantSlug = notif.rows[0].slug;
        tenantPrefix = notif.rows[0].ticket_prefix;
        targetTicketIdFromHeader = notif.rows[0].ticket_id;
      }
    }

    // Try ticket prefix in subject
    if (!tenantId) {
      const subjectPrefixMatch = cleanSubject.match(/\b([A-Z0-9]{2,10})-\d+\b/i);
      if (subjectPrefixMatch) {
        const byPrefix = await client.query<{ id: string; slug: string; ticket_prefix: string }>(
          `select t.id, t.slug, ts.ticket_prefix
           from tenant_settings ts
           join tenants t on t.id = ts.tenant_id
           where upper(ts.ticket_prefix) = upper($1) and t.status = 'active'`,
          [subjectPrefixMatch[1]],
        );
        if (byPrefix.rows[0]) {
          tenantId = byPrefix.rows[0].id;
          tenantSlug = byPrefix.rows[0].slug;
          tenantPrefix = byPrefix.rows[0].ticket_prefix;
        }
      }
    }

    // Try to-address
    if (!tenantId && input.to) {
      const toClean = input.to.toLowerCase();
      const byTo = await client.query<{ id: string; slug: string; ticket_prefix: string }>(
        `select t.id, t.slug, coalesce(ts.ticket_prefix, 'OPS') as ticket_prefix
         from tenants t
         left join tenant_settings ts on ts.tenant_id = t.id
         where t.status = 'active'
           and ($1 ilike '%' || t.slug || '%' or $1 ilike '%' || ts.ticket_prefix || '%')
         limit 1`,
        [toClean],
      );
      if (byTo.rows[0]) {
        tenantId = byTo.rows[0].id;
        tenantSlug = byTo.rows[0].slug;
        tenantPrefix = byTo.rows[0].ticket_prefix;
      }
    }

    // Try sender membership
    if (!tenantId) {
      const bySender = await client.query<{ id: string; slug: string; ticket_prefix: string }>(
        `select t.id, t.slug, coalesce(ts.ticket_prefix, 'OPS') as ticket_prefix
         from memberships m
         join users u on u.id = m.user_id
         join tenants t on t.id = m.tenant_id
         left join tenant_settings ts on ts.tenant_id = t.id
         where u.email = $1 and m.is_active and t.status = 'active'
         order by t.created_at asc
         limit 1`,
        [fromParsed.address],
      );
      if (bySender.rows[0]) {
        tenantId = bySender.rows[0].id;
        tenantSlug = bySender.rows[0].slug;
        tenantPrefix = bySender.rows[0].ticket_prefix;
      }
    }

    // Fallback: first active tenant
    if (!tenantId) {
      const fallback = await client.query<{ id: string; slug: string; ticket_prefix: string }>(
        `select t.id, t.slug, coalesce(ts.ticket_prefix, 'OPS') as ticket_prefix
         from tenants t
         left join tenant_settings ts on ts.tenant_id = t.id
         where t.status = 'active'
         order by t.created_at asc
         limit 1`,
      );
      if (fallback.rows[0]) {
        tenantId = fallback.rows[0].id;
        tenantSlug = fallback.rows[0].slug;
        tenantPrefix = fallback.rows[0].ticket_prefix;
      }
    }
  }

  if (!tenantId) {
    throw badRequest("Could not determine workspace destination for email");
  }

  // Set RLS tenant context
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

  // 2. Deduplication check
  const existing = await client.query<{ id: string; ticket_id: string; action: string }>(
    "select id, ticket_id, action from inbound_emails where tenant_id = $1 and message_id = $2",
    [tenantId, messageId],
  );
  if (existing.rows[0]) {
    return {
      action: "duplicate",
      ticketId: existing.rows[0].ticket_id,
      tenantSlug,
    };
  }

  // 3. User lookup or auto-provisioning
  let userId: string;
  let userRole: Role = "employee";

  const userRes = await client.query<{ id: string }>(
    "select id from users where email = $1",
    [fromParsed.address],
  );
  if (userRes.rows[0]) {
    userId = userRes.rows[0].id;
  } else {
    const randomPass = randomBytes(24).toString("hex");
    const createdUser = await client.query<{ id: string }>(
      `insert into users (email, display_name, password_hash)
       values ($1, $2, $3)
       returning id`,
      [fromParsed.address, fromParsed.name || fromParsed.address.split("@")[0], hashPassword(randomPass)],
    );
    userId = createdUser.rows[0]!.id;
  }

  const memberRes = await client.query<{ role: Role }>(
    "select role from memberships where tenant_id = $1 and user_id = $2 and is_active",
    [tenantId, userId],
  );
  if (memberRes.rows[0]) {
    userRole = memberRes.rows[0].role;
  } else {
    await client.query(
      `insert into memberships (tenant_id, user_id, role)
       values ($1, $2, 'employee')
       on conflict (tenant_id, user_id) do update set is_active = true`,
      [tenantId, userId],
    );
    userRole = "employee";
  }

  await client.query("select set_config('app.user_id', $1, true)", [userId]);

  // 4. Ticket matching (In-Reply-To or Subject Ticket Number)
  let targetTicketId = targetTicketIdFromHeader;

  if (!targetTicketId) {
    const parsedNumber = parseTicketNumberFromSubject(cleanSubject, tenantPrefix);
    if (parsedNumber !== null) {
      const ticketRes = await client.query<{ id: string }>(
        "select id from tickets where tenant_id = $1 and number = $2 and deleted_at is null",
        [tenantId, parsedNumber],
      );
      if (ticketRes.rows[0]) {
        targetTicketId = ticketRes.rows[0].id;
      }
    }
  }

  // 5. Existing ticket -> Add comment
  if (targetTicketId) {
    let ticket = await loadTicket(client, tenantId, targetTicketId);
    if (ticket) {
      let originalMergedFromNumber: number | null = null;
      const visited = new Set<string>([ticket.id]);
      while (ticket.merged_into_ticket_id) {
        originalMergedFromNumber = ticket.number;
        const parent = await loadTicket(client, tenantId, ticket.merged_into_ticket_id);
        if (!parent || visited.has(parent.id)) break;
        visited.add(parent.id);
        ticket = parent;
      }

      const commentPrefix = originalMergedFromNumber
        ? `[From reply to merged ticket #${originalMergedFromNumber}]:\n\n`
        : "";

      const comment = await addComment(
        client,
        tenantId,
        userId,
        userRole,
        ticket.id,
        {
          body: `${commentPrefix}${cleanBody || "(No content)"}`,
          visibility: "public",
        },
        correlationId,
      );

      await client.query(
        `insert into inbound_emails
          (tenant_id, message_id, from_address, to_address, subject, body, in_reply_to, ticket_id, comment_id, action)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'comment_added')`,
        [
          tenantId,
          messageId,
          fromParsed.address,
          input.to ?? "",
          cleanSubject,
          cleanBody,
          input.inReplyTo ?? null,
          ticket.id,
          comment.id,
        ],
      );

      await writeAudit(
        client,
        tenantId,
        { id: userId, role: userRole },
        "ticket.inbound_email_comment_added",
        "ticket",
        ticket.id,
        null,
        { messageId, from: fromParsed.address, subject: cleanSubject, commentId: comment.id },
        correlationId,
      );

      return {
        action: "comment_added",
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        commentId: comment.id,
        tenantSlug,
      };
    }
  }

  // 6. New Ticket
  const catRes = await client.query<{ id: string }>(
    `select id from categories
     where tenant_id = $1 and is_active
     order by created_at asc
     limit 1`,
    [tenantId],
  );
  const categoryId = catRes.rows[0]?.id;
  if (!categoryId) throw new Error("Workspace has no active categories");

  const priRes = await client.query<{ id: string }>(
    `select id from priorities
     where tenant_id = $1 and is_active
     order by case when key = 'p3' then 0 else 1 end, rank asc
     limit 1`,
    [tenantId],
  );
  const priorityId = priRes.rows[0]?.id;
  if (!priorityId) throw new Error("Workspace has no active priorities");

  // Populate any required custom fields with defaults
  const customFieldDefs = await client.query<{
    key: string;
    type: string;
    required: boolean;
    options: string[] | string;
  }>(
    `select key, type, required, options
     from custom_field_definitions
     where tenant_id = $1 and is_active
       and (applies_to_category_id is null or applies_to_category_id = $2)`,
    [tenantId, categoryId],
  );

  const customFields: Record<string, unknown> = {};
  for (const def of customFieldDefs.rows) {
    if (def.required) {
      if (def.type === "select") {
        const opts = Array.isArray(def.options) ? def.options : JSON.parse(def.options || "[]");
        customFields[def.key] = opts[0] ?? "HQ";
      } else if (def.type === "number") {
        customFields[def.key] = 0;
      } else if (def.type === "boolean") {
        customFields[def.key] = false;
      } else if (def.type === "date") {
        customFields[def.key] = new Date().toISOString().slice(0, 10);
      } else {
        customFields[def.key] = "Email request";
      }
    }
  }

  const createdTicket = await createTicket(
    client,
    tenantId,
    userId,
    userRole,
    {
      subject: cleanSubject.slice(0, 200) || "No subject",
      description: cleanBody.slice(0, 20000) || "(No content)",
      categoryId,
      priorityId,
      customFields,
    },
    correlationId,
  );

  await client.query(
    `insert into inbound_emails
      (tenant_id, message_id, from_address, to_address, subject, body, in_reply_to, ticket_id, action)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'ticket_created')`,
    [
      tenantId,
      messageId,
      fromParsed.address,
      input.to ?? "",
      cleanSubject,
      cleanBody,
      input.inReplyTo ?? null,
      createdTicket.id,
    ],
  );

  await writeAudit(
    client,
    tenantId,
    { id: userId, role: userRole },
    "ticket.inbound_email_ticket_created",
    "ticket",
    createdTicket.id,
    null,
    { messageId, from: fromParsed.address, subject: cleanSubject, ticketNumber: createdTicket.number },
    correlationId,
  );

  return {
    action: "ticket_created",
    ticketId: createdTicket.id,
    ticketNumber: createdTicket.number,
    tenantSlug,
  };
}
