import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notificationTemplateInputSchema } from "@opspilot/core";
import { requireAuth, requireRole, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";
import { writeAudit } from "../audit.js";
import { notFound } from "../errors.js";

const params = z.object({ tenantSlug: z.string().min(1), templateId: z.string().uuid() });

function context(req: {
  authUser?: { id: string };
  tenant?: { id: string; role: string };
}): { userId: string; tenantId: string; role: string } {
  if (!req.authUser || !req.tenant) throw new Error("Missing auth context");
  return { userId: req.authUser.id, tenantId: req.tenant.id, role: req.tenant.role };
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireTenant);
  app.addHook("preHandler", requireRole("tenant_admin"));

  app.get("/t/:tenantSlug/notification-templates", async (req) => {
    const { userId, tenantId } = context(req);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `select id, key, subject, body, is_active, updated_at
         from notification_templates
         where tenant_id = $1
         order by key`,
        [tenantId],
      );
      return { items: result.rows };
    });
  });

  app.put("/t/:tenantSlug/notification-templates/:templateId", async (req) => {
    const { userId, tenantId, role } = context(req);
    const { templateId } = params.parse(req.params);
    const input = notificationTemplateInputSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update notification_templates
         set subject = $3, body = $4, is_active = $5, updated_at = now()
         where tenant_id = $1 and id = $2
         returning id, key, subject, body, is_active, updated_at`,
        [tenantId, templateId, input.subject, input.body, input.isActive],
      );
      const template = result.rows[0];
      if (!template) notFound("Notification template not found");
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "config.notification_template_updated",
        "notification_template",
        templateId,
        null,
        { subject: input.subject, isActive: input.isActive },
        req.correlationId,
      );
      return template;
    });
  });
}
