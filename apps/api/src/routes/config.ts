import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { routingConditionsSchema, slaPolicyInputSchema } from "@opspilot/core";
import { requireAuth, requireRole, requireTenant } from "../auth.js";
import { withTenant } from "../db.js";
import { writeAudit } from "../audit.js";
import { badRequest } from "../errors.js";

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

  app.post("/t/:tenantSlug/teams", { preHandler: requireRole("tenant_admin") }, async (req) => {
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

  app.post("/t/:tenantSlug/categories", { preHandler: requireRole("tenant_admin") }, async (req) => {
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

  app.post("/t/:tenantSlug/priorities", { preHandler: requireRole("tenant_admin") }, async (req) => {
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

  app.post("/t/:tenantSlug/sla-policies", { preHandler: requireRole("tenant_admin") }, async (req) => {
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

  app.post("/t/:tenantSlug/custom-fields", { preHandler: requireRole("tenant_admin") }, async (req) => {
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

  app.post("/t/:tenantSlug/routing-rules", { preHandler: requireRole("tenant_admin") }, async (req) => {
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
}
