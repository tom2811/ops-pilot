import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assignSchema,
  commentSchema,
  createTicketSchema,
  routePreviewSchema,
  ticketUpdateSchema,
  transitionSchema,
} from "@opspilot/core";
import { requireAuth, requirePermission, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";
import { badRequest } from "../errors.js";
import { previewRoute } from "../domain/routing.js";
import {
  addComment,
  applyTransition,
  assignTicket,
  createTicket,
  deleteTicket,
  listTickets,
  ticketDetail,
  updateTicket,
} from "../domain/tickets.js";

const ticketParams = z.object({ tenantSlug: z.string().min(1), ticketId: z.string().uuid() });
const listQuery = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
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
        q: query.q,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      });
      return { items, total, page: query.page, pageSize: query.pageSize };
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
          priorityId: input.priorityId,
          customFields: input.customFields,
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
        { body: input.body, visibility: input.visibility },
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
