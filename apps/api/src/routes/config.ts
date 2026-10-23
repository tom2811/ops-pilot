import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { routingConditionsSchema, slaPolicyInputSchema, tenantSettingsInputSchema } from "@opspilot/core";
import { requireAuth, requirePermission, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";
import { writeAudit } from "../audit.js";
import { badRequest, notFound } from "../errors.js";

const slug = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers and dashes");

const teamInput = z.object({ slug, name: z.string().trim().min(1).max(100) });
const categoryInput = z.object({
  slug,
  name: z.string().trim().min(1).max(100),
  defaultTeamId: z.string().uuid().nullable().optional(),
});
const priorityInput = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[a-z0-9_-]+$/),
  label: z.string().trim().min(1).max(100),
  rank: z.number().int().min(1).max(1000),
  color: z.string().trim().min(1).max(30).default("gray"),
});
const customFieldInput = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().trim().min(1).max(120),
  type: z.enum(["text", "textarea", "number", "date", "select", "multiselect", "checkbox"]),
  required: z.boolean().default(false),
  visibility: z.enum(["public", "internal"]).default("internal"),
  options: z.array(z.string().trim().min(1)).default([]),
  appliesToCategoryId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().default(0),
});
const routingRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  conditions: routingConditionsSchema,
  teamId: z.string().uuid(),
  sortOrder: z.number().int().default(0),
});
const entityParams = z.object({ tenantSlug: z.string().min(1), id: z.string().uuid() });

const teamUpdate = teamInput.partial();
const categoryUpdate = categoryInput.partial();
const priorityUpdate = priorityInput.partial();
const customFieldUpdate = customFieldInput.partial();
const routingRuleUpdate = routingRuleInput.partial();
const slaPolicyUpdate = slaPolicyInputSchema.partial();

function tenantContext(req: {
  authUser?: { id: string };
  tenant?: { id: string; role: string };
}): { userId: string; tenantId: string; role: string } {
  if (!req.authUser || !req.tenant) throw new Error("Missing auth context");
  return { userId: req.authUser.id, tenantId: req.tenant.id, role: req.tenant.role };
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireTenant);

  app.get("/t/:tenantSlug/config", async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    return withTenant(tenantId, userId, async (client) => {
      const [teams, categories, priorities, statuses, customFields, routingRules, agents, settings, slaPolicies] = await Promise.all([
        client.query(
          "select id, slug, name from teams where tenant_id = $1 and is_active order by name",
          [tenantId],
        ),
        client.query(
          `select id, slug, name, default_team_id from categories
           where tenant_id = $1 and is_active order by name`,
          [tenantId],
        ),
        client.query(
          "select id, key, label, rank, color from priorities where tenant_id = $1 and is_active order by rank",
          [tenantId],
        ),
        client.query(
          "select id, key, label, stage, sort_order from ticket_statuses where tenant_id = $1 and is_active order by sort_order",
          [tenantId],
        ),
        client.query(
          `select id, key, label, type, required, visibility, options, applies_to_category_id, sort_order
           from custom_field_definitions
           where tenant_id = $1 and is_active and ($2 = false or visibility = 'public')
           order by sort_order, label`,
          [tenantId, role === "employee"],
        ),
        role === "employee"
          ? Promise.resolve({ rows: [] })
          : client.query(
              `select id, name, conditions, team_id, sort_order, version
               from routing_rules where tenant_id = $1 and is_active order by sort_order, id`,
              [tenantId],
            ),
        role === "employee"
          ? Promise.resolve({ rows: [] })
          : client.query(
              `select m.user_id as id, u.display_name as name, m.role,
                      coalesce(jsonb_agg(tm.team_id) filter (where tm.team_id is not null), '[]'::jsonb) as team_ids
               from memberships m
               join users u on u.id = m.user_id
               left join team_members tm on tm.tenant_id = m.tenant_id and tm.user_id = m.user_id
               where m.tenant_id = $1 and m.is_active and m.role in ('agent', 'tenant_admin')
               group by m.user_id, u.display_name, m.role
               order by u.display_name`,
              [tenantId],
            ),
        client.query(
          "select timezone, ticket_prefix, reopen_window_days, auto_close_days, branding, config_version from tenant_settings where tenant_id = $1",
          [tenantId],
        ),
        role === "employee"
          ? Promise.resolve({ rows: [] })
          : client.query(
              `select id, name, priority_id, category_id, response_minutes, resolution_minutes, is_active
               from sla_policies where tenant_id = $1 and is_active
               order by name`,
              [tenantId],
            ),
      ]);

      return {
        teams: teams.rows,
        categories: categories.rows,
        priorities: priorities.rows,
        statuses: statuses.rows,
        custom_fields: customFields.rows,
        routing_rules: routingRules.rows,
        agents: agents.rows,
        settings: settings.rows[0] ?? null,
        sla_policies: slaPolicies.rows,
      };
    });
  });

  app.post("/t/:tenantSlug/teams", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const input = teamInput.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        "insert into teams (tenant_id, slug, name) values ($1, $2, $3) returning id, slug, name",
        [tenantId, input.slug, input.name],
      );
      const team = result.rows[0];
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "config.team_created",
        "team",
        team.id,
        null,
        { slug: input.slug, name: input.name },
        req.correlationId,
      );
      return team;
    });
  });

  app.post("/t/:tenantSlug/categories", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const input = categoryInput.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `insert into categories (tenant_id, slug, name, default_team_id)
         values ($1, $2, $3, $4) returning id, slug, name, default_team_id`,
        [tenantId, input.slug, input.name, input.defaultTeamId ?? null],
      );
      const category = result.rows[0];
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "config.category_created",
        "category",
        category.id,
        null,
        { slug: input.slug, name: input.name, defaultTeamId: input.defaultTeamId ?? null },
        req.correlationId,
      );
      return category;
    });
  });

  app.post("/t/:tenantSlug/priorities", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const input = priorityInput.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `insert into priorities (tenant_id, key, label, rank, color)
         values ($1, $2, $3, $4, $5) returning id, key, label, rank, color`,
        [tenantId, input.key, input.label, input.rank, input.color],
      );
      const priority = result.rows[0];
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "config.priority_created",
        "priority",
        priority.id,
        null,
        { key: input.key, label: input.label, rank: input.rank },
        req.correlationId,
      );
      return priority;
    });
  });

  app.post("/t/:tenantSlug/sla-policies", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const input = slaPolicyInputSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `insert into sla_policies
          (tenant_id, name, priority_id, category_id, response_minutes, resolution_minutes)
         values ($1, $2, $3, $4, $5, $6)
         returning id, name, priority_id, category_id, response_minutes, resolution_minutes, is_active`,
        [
          tenantId,
          input.name,
          input.priorityId ?? null,
          input.categoryId ?? null,
          input.responseMinutes,
          input.resolutionMinutes,
        ],
      );
      const policy = result.rows[0];
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "config.sla_policy_created",
        "sla_policy",
        policy.id,
        null,
        { name: input.name, priorityId: input.priorityId ?? null, categoryId: input.categoryId ?? null },
        req.correlationId,
      );
      return policy;
    });
  });

  app.post("/t/:tenantSlug/custom-fields", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const input = customFieldInput.parse(req.body);
    if ((input.type === "select" || input.type === "multiselect") && input.options.length === 0) {
      badRequest("Select fields need at least one option");
    }
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `insert into custom_field_definitions
          (tenant_id, key, label, type, required, visibility, options, applies_to_category_id, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, key, label, type, required, visibility, options, applies_to_category_id, sort_order`,
        [
          tenantId,
          input.key,
          input.label,
          input.type,
          input.required,
          input.visibility,
          JSON.stringify(input.options),
          input.appliesToCategoryId ?? null,
          input.sortOrder,
        ],
      );
      const field = result.rows[0];
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "config.custom_field_created",
        "custom_field",
        field.id,
        null,
        { key: input.key, label: input.label, type: input.type },
        req.correlationId,
      );
      return field;
    });
  });

  app.post("/t/:tenantSlug/routing-rules", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const input = routingRuleInput.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `insert into routing_rules (tenant_id, name, conditions, team_id, sort_order)
         values ($1, $2, $3, $4, $5)
         returning id, name, conditions, team_id, sort_order, version`,
        [tenantId, input.name, JSON.stringify(input.conditions), input.teamId, input.sortOrder],
      );
      const rule = result.rows[0];
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "config.routing_rule_created",
        "routing_rule",
        rule.id,
        null,
        { name: input.name, teamId: input.teamId },
        req.correlationId,
      );
      return rule;
    });
  });
  app.patch("/t/:tenantSlug/teams/:id", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    const input = teamUpdate.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update teams set slug = coalesce($3, slug), name = coalesce($4, name)
         where tenant_id = $1 and id = $2 returning id, slug, name`,
        [tenantId, id, input.slug ?? null, input.name ?? null],
      );
      if (!result.rows[0]) notFound("Team not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.team_updated", "team", id, null, input, req.correlationId);
      return result.rows[0];
    });
  });

  app.delete("/t/:tenantSlug/teams/:id", { preHandler: requirePermission("config.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    await withTenant(tenantId, userId, async (client) => {
      const result = await client.query("update teams set is_active = false where tenant_id = $1 and id = $2", [tenantId, id]);
      if ((result.rowCount ?? 0) === 0) notFound("Team not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.team_deactivated", "team", id, null, null, req.correlationId);
    });
    return reply.status(204).send();
  });

  app.patch("/t/:tenantSlug/categories/:id", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    const input = categoryUpdate.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update categories set slug = coalesce($3, slug), name = coalesce($4, name),
                default_team_id = case when $5 then $6 else default_team_id end
         where tenant_id = $1 and id = $2
         returning id, slug, name, default_team_id`,
        [
          tenantId,
          id,
          input.slug ?? null,
          input.name ?? null,
          Object.hasOwn(input, "defaultTeamId"),
          input.defaultTeamId ?? null,
        ],
      );
      if (!result.rows[0]) notFound("Category not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.category_updated", "category", id, null, input, req.correlationId);
      return result.rows[0];
    });
  });

  app.delete("/t/:tenantSlug/categories/:id", { preHandler: requirePermission("config.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    await withTenant(tenantId, userId, async (client) => {
      const result = await client.query("update categories set is_active = false where tenant_id = $1 and id = $2", [tenantId, id]);
      if ((result.rowCount ?? 0) === 0) notFound("Category not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.category_deactivated", "category", id, null, null, req.correlationId);
    });
    return reply.status(204).send();
  });

  app.patch("/t/:tenantSlug/priorities/:id", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    const input = priorityUpdate.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update priorities set key = coalesce($3, key), label = coalesce($4, label),
                rank = coalesce($5, rank), color = coalesce($6, color)
         where tenant_id = $1 and id = $2 returning id, key, label, rank, color`,
        [tenantId, id, input.key ?? null, input.label ?? null, input.rank ?? null, input.color ?? null],
      );
      if (!result.rows[0]) notFound("Priority not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.priority_updated", "priority", id, null, input, req.correlationId);
      return result.rows[0];
    });
  });

  app.delete("/t/:tenantSlug/priorities/:id", { preHandler: requirePermission("config.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    await withTenant(tenantId, userId, async (client) => {
      const result = await client.query("update priorities set is_active = false where tenant_id = $1 and id = $2", [tenantId, id]);
      if ((result.rowCount ?? 0) === 0) notFound("Priority not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.priority_deactivated", "priority", id, null, null, req.correlationId);
    });
    return reply.status(204).send();
  });

  app.patch("/t/:tenantSlug/custom-fields/:id", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    const input = customFieldUpdate.parse(req.body);
    if ((input.type === "select" || input.type === "multiselect") && input.options && input.options.length === 0) {
      badRequest("Select fields need at least one option");
    }
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update custom_field_definitions set
           label = coalesce($3, label), type = coalesce($4, type),
           required = coalesce($5, required), visibility = coalesce($6, visibility),
           options = case when $7::jsonb is null then options else $7::jsonb end,
           applies_to_category_id = case when $8 then $9 else applies_to_category_id end,
           sort_order = coalesce($10, sort_order)
         where tenant_id = $1 and id = $2
         returning id, key, label, type, required, visibility, options, applies_to_category_id, sort_order`,
        [
          tenantId,
          id,
          input.label,
          input.type,
          input.required,
          input.visibility,
          input.options ? JSON.stringify(input.options) : null,
          Object.hasOwn(input, "appliesToCategoryId"),
          input.appliesToCategoryId ?? null,
          input.sortOrder,
        ],
      );
      if (!result.rows[0]) notFound("Custom field not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.custom_field_updated", "custom_field", id, null, input, req.correlationId);
      return result.rows[0];
    });
  });

  app.delete("/t/:tenantSlug/custom-fields/:id", { preHandler: requirePermission("config.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    await withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        "update custom_field_definitions set is_active = false where tenant_id = $1 and id = $2",
        [tenantId, id],
      );
      if ((result.rowCount ?? 0) === 0) notFound("Custom field not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.custom_field_deactivated", "custom_field", id, null, null, req.correlationId);
    });
    return reply.status(204).send();
  });

  app.patch("/t/:tenantSlug/routing-rules/:id", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    const input = routingRuleUpdate.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update routing_rules set
           name = coalesce($3, name),
           conditions = case when $4::jsonb is null then conditions else $4::jsonb end,
           team_id = coalesce($5, team_id),
           sort_order = coalesce($6, sort_order),
           version = version + 1
         where tenant_id = $1 and id = $2
         returning id, name, conditions, team_id, sort_order, version`,
        [
          tenantId,
          id,
          input.name ?? null,
          input.conditions ? JSON.stringify(input.conditions) : null,
          input.teamId ?? null,
          input.sortOrder ?? null,
        ],
      );
      if (!result.rows[0]) notFound("Routing rule not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.routing_rule_updated", "routing_rule", id, null, input, req.correlationId);
      return result.rows[0];
    });
  });

  app.delete("/t/:tenantSlug/routing-rules/:id", { preHandler: requirePermission("config.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    await withTenant(tenantId, userId, async (client) => {
      const result = await client.query("update routing_rules set is_active = false where tenant_id = $1 and id = $2", [tenantId, id]);
      if ((result.rowCount ?? 0) === 0) notFound("Routing rule not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.routing_rule_deactivated", "routing_rule", id, null, null, req.correlationId);
    });
    return reply.status(204).send();
  });

  app.patch("/t/:tenantSlug/sla-policies/:id", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    const input = slaPolicyUpdate.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update sla_policies set
           name = coalesce($3, name),
           priority_id = case when $4 then $5 else priority_id end,
           category_id = case when $6 then $7 else category_id end,
           response_minutes = coalesce($8, response_minutes),
           resolution_minutes = coalesce($9, resolution_minutes),
           updated_at = now()
         where tenant_id = $1 and id = $2
         returning id, name, priority_id, category_id, response_minutes, resolution_minutes, is_active`,
        [
          tenantId,
          id,
          input.name,
          Object.hasOwn(input, "priorityId"),
          input.priorityId ?? null,
          Object.hasOwn(input, "categoryId"),
          input.categoryId ?? null,
          input.responseMinutes,
          input.resolutionMinutes,
        ],
      );
      if (!result.rows[0]) notFound("SLA policy not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.sla_policy_updated", "sla_policy", id, null, input, req.correlationId);
      return result.rows[0];
    });
  });

  app.delete("/t/:tenantSlug/sla-policies/:id", { preHandler: requirePermission("config.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = tenantContext(req);
    const { id } = entityParams.parse(req.params);
    await withTenant(tenantId, userId, async (client) => {
      const result = await client.query("update sla_policies set is_active = false where tenant_id = $1 and id = $2", [tenantId, id]);
      if ((result.rowCount ?? 0) === 0) notFound("SLA policy not found");
      await writeAudit(client, tenantId, { id: userId, role }, "config.sla_policy_deactivated", "sla_policy", id, null, null, req.correlationId);
    });
    return reply.status(204).send();
  });

  app.patch("/t/:tenantSlug/settings", { preHandler: requirePermission("config.manage") }, async (req) => {
    const { userId, tenantId, role } = tenantContext(req);
    const input = tenantSettingsInputSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update tenant_settings set timezone = $2, ticket_prefix = $3,
                reopen_window_days = $4, auto_close_days = $5,
                config_version = config_version + 1, updated_at = now()
         where tenant_id = $1
         returning timezone, ticket_prefix, reopen_window_days, auto_close_days, branding, config_version`,
        [tenantId, input.timezone, input.ticketPrefix, input.reopenWindowDays, input.autoCloseDays],
      );
      await writeAudit(client, tenantId, { id: userId, role }, "config.settings_updated", "tenant_settings", tenantId, null, input, req.correlationId);
      return result.rows[0];
    });
  });

}
