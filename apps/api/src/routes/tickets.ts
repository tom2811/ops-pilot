import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assignSchema,
  commentSchema,
  createTicketLinkSchema,
  createTicketSchema,
  mergeTicketSchema,
  routePreviewSchema,
  ticketUpdateSchema,
  transitionSchema,
} from "@opspilot/core";
import { requireAuth, requirePermission, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";
import { AppError, badRequest } from "../errors.js";
import { previewRoute } from "../domain/routing.js";
import {
  addComment,
  applyTransition,
  assignTicket,
  claimTicket,
  createTicket,
  createTicketLink,
  deleteTicket,
  deleteTicketLink,
  getTicketLinks,
  listTickets,
  mergeTickets,
  ticketDetail,
  updateTicket,
} from "../domain/tickets.js";

const ticketParams = z.object({ tenantSlug: z.string().min(1), ticketId: z.string().uuid() });
const listQuery = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.enum(["me", "none"]).optional(),
  state: z.enum(["open", "closed"]).optional(),
  sort: z.enum(["priority", "updated", "due"]).default("due"),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

function context(req: {
  authUser?: { id: string };
  tenant?: { id: string; role: "tenant_admin" | "agent" | "employee" };
}): { userId: string; tenantId: string; role: "tenant_admin" | "agent" | "employee" } {
  if (!req.authUser || !req.tenant) throw new Error("Missing auth context");
  return { userId: req.authUser.id, tenantId: req.tenant.id, role: req.tenant.role };
}

function formatCsvDate(val: unknown): string {
  if (!val) return "";
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireTenant);

  app.get("/t/:tenantSlug/tickets", async (req) => {
    const { userId, tenantId, role } = context(req);
    const query = listQuery.parse(req.query);
    return withTenant(tenantId, userId, async (client) => {
      const { items, total } = await listTickets(client, tenantId, userId, role, {
        status: query.status,
        priority: query.priority,
        assignee: query.assignee,
        state: query.state,
        sort: query.sort,
        q: query.q,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      });
      return { items, total, page: query.page, pageSize: query.pageSize };
    });
  });

  app.get("/t/:tenantSlug/tickets/export", async (req, reply) => {
    const { userId, tenantId, role } = context(req);
    if (role === "employee") {
      throw new AppError(403, "Ticket export requires agent or administrator role");
    }
    const query = listQuery.omit({ page: true, pageSize: true }).parse(req.query);
    return withTenant(tenantId, userId, async (client) => {
      const { items } = await listTickets(client, tenantId, userId, role, {
        status: query.status,
        priority: query.priority,
        assignee: query.assignee,
        state: query.state,
        sort: query.sort,
        q: query.q,
        limit: 5000,
        offset: 0,
      });

      const headers = [
        "Ticket Number",
        "Subject",
        "Status",
        "Priority",
        "Category",
        "Requester",
        "Assignee",
        "Team",
        "SLA Response Due",
        "SLA Resolution Due",
        "Created At",
        "Updated At",
        "Resolved At",
      ];

      const rows = [headers.join(",")];
      for (const t of items) {
        rows.push(
          [
            escapeCsv(t.number),
            escapeCsv(t.subject),
            escapeCsv(t.status_label),
            escapeCsv(t.priority_label),
            escapeCsv(t.category_name),
            escapeCsv(t.requester_name),
            escapeCsv(t.assignee_name || "Unassigned"),
            escapeCsv(t.team_name || "None"),
            escapeCsv(formatCsvDate(t.sla_response_due_at)),
            escapeCsv(formatCsvDate(t.sla_resolution_due_at)),
            escapeCsv(formatCsvDate(t.created_at)),
            escapeCsv(formatCsvDate(t.updated_at)),
            escapeCsv(formatCsvDate(t.resolved_at)),
          ].join(","),
        );
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `tickets-${req.tenant?.slug ?? "export"}-${dateStr}.csv`;
      reply.type("text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(rows.join("\r\n"));
    });
  });

  app.post("/t/:tenantSlug/tickets", async (req) => {
    const { userId, tenantId, role } = context(req);
    const input = createTicketSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) =>
      createTicket(
        client,
        tenantId,
        userId,
        role,
        {
          subject: input.subject,
          description: input.description,
          categoryId: input.categoryId,
          customFields: input.customFields,
          requesterId: input.requesterId,
        },
        req.correlationId,
      ),
    );
  });

  app.get("/t/:tenantSlug/tickets/:ticketId", async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = ticketParams.parse(req.params);
    return withTenant(tenantId, userId, async (client) =>
      ticketDetail(client, tenantId, params.ticketId, userId, role),
    );
  });

  app.patch("/t/:tenantSlug/tickets/:ticketId", async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = ticketParams.parse(req.params);
    const input = ticketUpdateSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) =>
      updateTicket(
        client,
        tenantId,
        userId,
        role,
        params.ticketId,
        {
          subject: input.subject,
          description: input.description,
          categoryId: input.categoryId,
          priorityId: input.priorityId,
          customFields: input.customFields,
          expectedVersion: input.expectedVersion,
        },
        req.correlationId,
      ),
    );
  });

  app.delete(
    "/t/:tenantSlug/tickets/:ticketId",
    { preHandler: requirePermission("tickets.delete") },
    async (req, reply) => {
      const { userId, tenantId } = context(req);
      const params = ticketParams.parse(req.params);
      await withTenant(tenantId, userId, async (client) =>
        deleteTicket(client, tenantId, userId, params.ticketId, req.correlationId),
      );
      return reply.status(204).send();
    },
  );

  app.post("/t/:tenantSlug/tickets/:ticketId/transitions", async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = ticketParams.parse(req.params);
    const input = transitionSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) =>
      applyTransition(
        client,
        tenantId,
        userId,
        role,
        params.ticketId,
        {
          toStatusId: input.toStatusId,
          expectedVersion: input.expectedVersion,
          reason: input.reason,
          resolutionSummary: input.resolutionSummary,
        },
        req.correlationId,
      ),
    );
  });

  app.post(
    "/t/:tenantSlug/tickets/:ticketId/assign",
    { preHandler: requirePermission("tickets.assign") },
    async (req) => {
      const { userId, tenantId } = context(req);
      const params = ticketParams.parse(req.params);
      const input = assignSchema.parse(req.body);
      return withTenant(tenantId, userId, async (client) =>
        assignTicket(
          client,
          tenantId,
          userId,
          context(req).role,
          params.ticketId,
          { teamId: input.teamId, assigneeId: input.assigneeId, expectedVersion: input.expectedVersion },
          req.correlationId,
        ),
      );
    },
  );

  app.post(
    "/t/:tenantSlug/tickets/:ticketId/claim",
    { preHandler: requirePermission("tickets.assign") },
    async (req) => {
      const { userId, tenantId, role } = context(req);
      const params = ticketParams.parse(req.params);
      const input = z.object({ expectedVersion: z.number().int().nonnegative() }).parse(req.body);
      return withTenant(tenantId, userId, async (client) =>
        claimTicket(client, tenantId, userId, role, params.ticketId, input.expectedVersion, req.correlationId),
      );
    },
  );

  app.post("/t/:tenantSlug/tickets/:ticketId/comments", async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = ticketParams.parse(req.params);
    const input = commentSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) =>
      addComment(
        client,
        tenantId,
        userId,
        role,
        params.ticketId,
        { body: input.body, visibility: input.visibility, countsAsFirstResponse: input.countsAsFirstResponse },
        req.correlationId,
      ),
    );
  });

  app.get("/t/:tenantSlug/tickets/:ticketId/links", async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = ticketParams.parse(req.params);
    return withTenant(tenantId, userId, async (client) => {
      const items = await getTicketLinks(client, tenantId, params.ticketId, userId, role);
      return { items };
    });
  });

  app.post("/t/:tenantSlug/tickets/:ticketId/links", async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = ticketParams.parse(req.params);
    const input = createTicketLinkSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) =>
      createTicketLink(
        client,
        tenantId,
        userId,
        role,
        params.ticketId,
        { targetTicketNumber: input.targetTicketNumber, linkType: input.linkType },
        req.correlationId,
      ),
    );
  });

  app.delete("/t/:tenantSlug/tickets/:ticketId/links/:linkId", async (req, reply) => {
    const { userId, tenantId, role } = context(req);
    const params = z
      .object({ tenantSlug: z.string().min(1), ticketId: z.string().uuid(), linkId: z.string().uuid() })
      .parse(req.params);
    await withTenant(tenantId, userId, async (client) => {
      await deleteTicketLink(client, tenantId, userId, role, params.ticketId, params.linkId, req.correlationId);
    });
    return reply.status(204).send();
  });

  app.post("/t/:tenantSlug/tickets/:ticketId/merge", async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = ticketParams.parse(req.params);
    const input = mergeTicketSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) =>
      mergeTickets(
        client,
        tenantId,
        userId,
        role,
        params.ticketId,
        input,
        req.correlationId,
      ),
    );
  });

  app.post("/t/:tenantSlug/routing/preview", async (req) => {
    const { userId, tenantId } = context(req);
    const input = routePreviewSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const preview = await previewRoute(client, tenantId, input);
      if (!preview) badRequest("No routing rule or default team matched");
      return preview;
    });
  });
}
