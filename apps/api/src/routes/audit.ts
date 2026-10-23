import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requirePermission, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";

const listQuery = z.object({
  entityType: z.string().trim().max(60).optional(),
  action: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireTenant);
  app.addHook("preHandler", requirePermission("audit.view"));

  app.get("/t/:tenantSlug/audit-log", async (req) => {
    if (!req.tenant || !req.authUser) throw new Error("Missing auth context");
    const tenantId = req.tenant.id;
    const userId = req.authUser.id;
    const query = listQuery.parse(req.query);
    const limit = query.pageSize;
    const offset = (query.page - 1) * query.pageSize;
    const entityType = query.entityType || null;
    const action = query.action || null;

    return withTenant(tenantId, userId, async (client) => {
      const [items, total, types] = await Promise.all([
        client.query(
          `select a.id, a.action, a.entity_type, a.entity_id, a.actor_id, a.actor_role,
                  u.display_name as actor_name, a.before, a.after, a.correlation_id, a.created_at
           from audit_log a
           left join users u on u.id = a.actor_id
           where a.tenant_id = $1
             and ($2::text is null or a.entity_type = $2)
             and ($3::text is null or a.action like $3)
           order by a.created_at desc, a.id desc
           limit $4 offset $5`,
          [tenantId, entityType, action ? `${action}%` : null, limit, offset],
        ),
        client.query(
          `select count(*)::int as count
           from audit_log a
           where a.tenant_id = $1
             and ($2::text is null or a.entity_type = $2)
             and ($3::text is null or a.action like $3)`,
          [tenantId, entityType, action ? `${action}%` : null],
        ),
        client.query(
          `select distinct entity_type
           from audit_log
           where tenant_id = $1
           order by entity_type`,
          [tenantId],
        ),
      ]);

      return {
        items: items.rows,
        total: total.rows[0]?.count ?? 0,
        page: query.page,
        pageSize: query.pageSize,
        entity_types: types.rows.map((row) => row.entity_type as string),
      };
    });
  });
}
