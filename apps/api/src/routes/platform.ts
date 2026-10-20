import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  DEFAULT_PRIORITIES,
  DEFAULT_SLA_POLICIES,
  DEFAULT_STATUSES,
  DEFAULT_TRANSITIONS,
} from "@opspilot/core";
import { hashToken, requireAuth, requirePlatformAdmin } from "../auth.js";
import { adminPool } from "../db.js";
import { enqueueEmail } from "../emailQueue.js";
import { env } from "../env.js";
import { writeAudit } from "../audit.js";
import { AppError, badRequest, notFound } from "../errors.js";

const slug = z
  .string()
  .trim()
  .min(2)
  .max(50)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers and dashes");

const createTenantInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug,
  adminEmail: z.string().email().max(320),
});

const updateTenantInput = z.object({
  status: z.enum(["active", "suspended"]),
});

async function provisionTenant(tenantId: string, slugValue: string): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    await client.query(
      "insert into tenant_settings (tenant_id, timezone, ticket_prefix) values ($1, 'UTC', $2)",
      [tenantId, slugValue.slice(0, 3).toUpperCase().padEnd(3, "X")],
    );
    await client.query("insert into ticket_counters (tenant_id, next_number) values ($1, 1)", [tenantId]);

    const teamIds = new Map<string, string>();
    for (const team of [
      { slug: "service-desk", name: "Service Desk" },
      { slug: "network", name: "Network Team" },
    ]) {
      const id = randomUUID();
      teamIds.set(team.slug, id);
      await client.query("insert into teams (tenant_id, id, slug, name) values ($1, $2, $3, $4)", [
        tenantId,
        id,
        team.slug,
        team.name,
      ]);
    }

    const categoryIds = new Map<string, string>();
    for (const category of [
      { slug: "hardware", name: "Hardware", team: "service-desk" },
      { slug: "access", name: "Access & Accounts", team: "service-desk" },
      { slug: "network", name: "Network", team: "network" },
      { slug: "software", name: "Software", team: "service-desk" },
    ]) {
      const id = randomUUID();
      categoryIds.set(category.slug, id);
      await client.query(
        "insert into categories (tenant_id, id, slug, name, default_team_id) values ($1, $2, $3, $4, $5)",
        [tenantId, id, category.slug, category.name, teamIds.get(category.team)],
      );
    }

    const priorityIds = new Map<string, string>();
    for (const priority of DEFAULT_PRIORITIES) {
      const result = await client.query<{ id: string }>(
        "insert into priorities (tenant_id, key, label, rank, color) values ($1, $2, $3, $4, $5) returning id",
        [tenantId, priority.key, priority.label, priority.rank, priority.color],
      );
      const id = result.rows[0]?.id;
      if (id) priorityIds.set(priority.key, id);
    }

    for (const policy of DEFAULT_SLA_POLICIES) {
      await client.query(
        `insert into sla_policies
          (tenant_id, name, priority_id, response_minutes, resolution_minutes)
         values ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          policy.name,
          priorityIds.get(policy.priorityKey) ?? null,
          policy.responseMinutes,
          policy.resolutionMinutes,
        ],
      );
    }

    const statusIds = new Map<string, string>();
    for (const status of DEFAULT_STATUSES) {
      const id = randomUUID();
      statusIds.set(status.key, id);
      await client.query(
        "insert into ticket_statuses (tenant_id, id, key, label, stage, sort_order) values ($1, $2, $3, $4, $5, $6)",
        [tenantId, id, status.key, status.label, status.stage, status.sortOrder],
      );
    }

    for (const rule of DEFAULT_TRANSITIONS) {
      await client.query(
        `insert into ticket_transition_rules
          (tenant_id, from_status_id, to_status_id, actor_role, requires_assignee, requires_summary, requires_reason)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          statusIds.get(rule.from),
          statusIds.get(rule.to),
          rule.role,
          rule.requiresAssignee ?? false,
          rule.requiresSummary ?? false,
          rule.requiresReason ?? false,
        ],
      );
    }

    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      await client.query(
        "insert into notification_templates (tenant_id, key, subject, body) values ($1, $2, $3, $4)",
        [tenantId, template.key, template.subject, template.body],
      );
    }

    let sortOrder = 10;
    for (const category of [
      { slug: "hardware", name: "Hardware", team: "service-desk" },
      { slug: "access", name: "Access & Accounts", team: "service-desk" },
      { slug: "network", name: "Network", team: "network" },
      { slug: "software", name: "Software", team: "service-desk" },
    ]) {
      await client.query(
        `insert into routing_rules (tenant_id, name, conditions, team_id, sort_order)
         values ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          `${category.name} routing`,
          JSON.stringify({ all: [{ field: "category_id", op: "eq", value: categoryIds.get(category.slug) }] }),
          teamIds.get(category.team),
          sortOrder,
        ],
      );
      sortOrder += 10;
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requirePlatformAdmin);

  app.get("/platform/tenants", async () => {
    const result = await adminPool.query(
      `select t.id, t.slug, t.name, t.status, t.created_at,
              (select count(*)::int from memberships m where m.tenant_id = t.id and m.is_active) as member_count,
              (select count(*)::int from tickets tk where tk.tenant_id = t.id and tk.deleted_at is null) as ticket_count,
              (select count(*)::int from user_invitations i
               where i.tenant_id = t.id and i.accepted_at is null and i.revoked_at is null
                 and i.expires_at > now()) as pending_invitations
       from tenants t
       order by t.created_at desc`,
    );
    return { tenants: result.rows };
  });

  app.post("/platform/tenants", async (req) => {
    if (!req.authUser) throw new AppError(401, "Unauthorized");
    const input = createTenantInput.parse(req.body);
    const slugValue = input.slug.toLowerCase();
    const token = randomBytes(32).toString("base64url");
    const link = `${env.WEB_ORIGIN.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`;

    let tenantId: string;
    try {
      tenantId = randomUUID();
      await adminPool.query(
        "insert into tenants (id, slug, name, status) values ($1, $2, $3, 'active')",
        [tenantId, slugValue, input.name],
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw badRequest("That workspace slug is already in use");
      }
      throw error;
    }

    try {
      await provisionTenant(tenantId, slugValue);
      const client = await adminPool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into user_invitations
            (tenant_id, email, role, token_hash, invited_by, expires_at)
           values ($1, $2, 'tenant_admin', $3, $4, now() + interval '14 days')`,
          [tenantId, input.adminEmail.toLowerCase(), hashToken(token), req.authUser.id],
        );
        await enqueueEmail(client, {
          tenantId,
          recipient: input.adminEmail.toLowerCase(),
          subject: `Set up ${input.name} on OpsPilot`,
          body: `You have been invited to administer ${input.name} on OpsPilot.\n\nAccept the invitation and create your administrator password:\n${link}\n\nThis link expires in 14 days.`,
        });
        await writeAudit(
          client,
          tenantId,
          { id: req.authUser.id, role: "platform_admin" },
          "platform.tenant_created",
          "tenant",
          tenantId,
          null,
          { name: input.name, slug: slugValue, adminEmail: input.adminEmail },
          req.correlationId,
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await adminPool.query("delete from tenants where id = $1", [tenantId]);
      throw error;
    }

    const tenant = await adminPool.query(
      "select id, slug, name, status, created_at from tenants where id = $1",
      [tenantId],
    );
    return { tenant: tenant.rows[0], invitationLink: link };
  });

  app.patch("/platform/tenants/:id", async (req) => {
    if (!req.authUser) throw new AppError(401, "Unauthorized");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = updateTenantInput.parse(req.body);
    const current = await adminPool.query<{ id: string; status: string; slug: string }>(
      "select id, status, slug from tenants where id = $1",
      [params.id],
    );
    const tenant = current.rows[0];
    if (!tenant) throw notFound("Workspace not found");
    if (tenant.status === input.status) throw badRequest("Workspace already has that status");
    await adminPool.query("update tenants set status = $2, updated_at = now() where id = $1", [
      params.id,
      input.status,
    ]);
    await writeAudit(
      adminPool,
      params.id,
      { id: req.authUser.id, role: "platform_admin" },
      "platform.tenant_status_changed",
      "tenant",
      params.id,
      { status: tenant.status },
      { status: input.status },
      req.correlationId,
    );
    return { id: params.id, status: input.status };
  });
}
