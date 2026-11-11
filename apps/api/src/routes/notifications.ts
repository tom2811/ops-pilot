import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notificationTemplateInputSchema } from "@opspilot/core";
import { requireAnyPermission, requireAuth, requirePermission, requireTenant } from "../auth.js";
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

  app.get(
    "/t/:tenantSlug/notification-templates",
    async (req) => {
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
    },
  );

  app.get(
    "/t/:tenantSlug/email-logs",
    { preHandler: requireAnyPermission("config.manage", "audit.view") },
    async (req) => {
      const { userId, tenantId } = context(req);
      return withTenant(tenantId, userId, async (client) => {
        const notifsResult = await client.query(
          `select n.id, n.channel, n.subject, n.delivery_status, n.attempts, n.provider_message_id,
                  n.sent_at, n.created_at, n.last_error, u.email as recipient_email
           from notifications n
           left join users u on u.id = n.recipient_id
           where n.tenant_id = $1
           order by n.created_at desc
           limit 100`,
          [tenantId],
        );

        const inboundResult = await client.query(
          `select i.id, i.message_id, i.from_address, i.to_address, i.subject, i.action,
                  i.ticket_id, i.created_at, t.number as ticket_number
           from inbound_emails i
           left join tickets t on t.id = i.ticket_id and t.tenant_id = i.tenant_id
           where i.tenant_id = $1
           order by i.created_at desc
           limit 100`,
          [tenantId],
        );

        return {
          outbound: notifsResult.rows,
          inbound: inboundResult.rows,
        };
      });
    },
  );

  app.put(
    "/t/:tenantSlug/notification-templates/:templateId",
    { preHandler: requirePermission("config.manage") },
    async (req) => {
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
    },
  );
}
