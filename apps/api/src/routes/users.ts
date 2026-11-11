import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  customRoleInputSchema,
  customRoleUpdateSchema,
  invitationInputSchema,
  membershipUpdateSchema,
} from "@opspilot/core";
import { hashToken, requireAuth, requirePermission, requireTenant } from "../auth.js";
import { enqueueEmail } from "../emailQueue.js";
import { env } from "../env.js";
import { withTenant } from "../db.js";
import { writeAudit } from "../audit.js";
import { badRequest, notFound } from "../errors.js";

const userParams = z.object({ tenantSlug: z.string().min(1), userId: z.string().uuid() });
const inviteParams = z.object({ tenantSlug: z.string().min(1), id: z.string().uuid() });
const roleParams = z.object({ tenantSlug: z.string().min(1), roleId: z.string().uuid() });

function context(req: {
  authUser?: { id: string };
  tenant?: { id: string; role: string };
}): { userId: string; tenantId: string; role: string } {
  if (!req.authUser || !req.tenant) throw new Error("Missing auth context");
  return { userId: req.authUser.id, tenantId: req.tenant.id, role: req.tenant.role };
}

async function validateTeams(
  client: { query: (sql: string, values: unknown[]) => Promise<{ rowCount: number | null }> },
  tenantId: string,
  teamIds: string[],
): Promise<void> {
  if (teamIds.length === 0) return;
  const result = await client.query(
    "select 1 from teams where tenant_id = $1 and is_active and id = any($2::uuid[])",
    [tenantId, teamIds],
  );
  if ((result.rowCount ?? 0) !== new Set(teamIds).size) throw badRequest("Unknown or inactive team");
}

async function readUser(
  client: {
    query: (
      sql: string,
      values: unknown[],
    ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  },
  tenantId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select m.user_id as id, u.email, u.display_name as name, m.role, m.is_active,
            m.created_at, m.custom_role_id, cr.name as custom_role_name, m.manager_user_id,
            coalesce(jsonb_agg(tm.team_id) filter (where tm.team_id is not null), '[]'::jsonb) as team_ids
     from memberships m
     join users u on u.id = m.user_id
     left join custom_roles cr on cr.tenant_id = m.tenant_id and cr.id = m.custom_role_id
     left join team_members tm on tm.tenant_id = m.tenant_id and tm.user_id = m.user_id
     where m.tenant_id = $1 and m.user_id = $2
     group by m.user_id, u.email, u.display_name, m.role, m.is_active, m.created_at,
              m.custom_role_id, cr.name, m.manager_user_id`,
    [tenantId, userId],
  );
  const user = result.rows[0];
  if (!user) throw notFound("User not found");
  return user;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requireTenant);

  app.get("/t/:tenantSlug/users", async (req) => {
    const { userId, tenantId } = context(req);
    const canManage = req.tenant?.permissions.includes("users.manage") ?? false;
    return withTenant(tenantId, userId, async (client) => {
      const [users, invitations, customRoles] = await Promise.all([
        client.query(
          `select m.user_id as id, u.email, u.display_name as name, m.role, m.is_active,
                  m.created_at, m.custom_role_id, cr.name as custom_role_name, m.manager_user_id,
                  coalesce(jsonb_agg(tm.team_id) filter (where tm.team_id is not null), '[]'::jsonb) as team_ids
           from memberships m
           join users u on u.id = m.user_id
           left join custom_roles cr on cr.tenant_id = m.tenant_id and cr.id = m.custom_role_id
           left join team_members tm on tm.tenant_id = m.tenant_id and tm.user_id = m.user_id
           where m.tenant_id = $1
           group by m.user_id, u.email, u.display_name, m.role, m.is_active, m.created_at,
                    m.custom_role_id, cr.name, m.manager_user_id
           order by m.is_active desc, u.display_name`,
          [tenantId],
        ),
        canManage
          ? client.query(
              `select id, email, role, team_ids, expires_at, created_at
               from user_invitations
               where tenant_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
               order by created_at desc`,
              [tenantId],
            )
          : Promise.resolve({ rows: [] }),
        client.query(
          `select cr.id, cr.name, cr.base_role, cr.permissions, cr.created_at,
                  (select count(*)::int from memberships m
                   where m.tenant_id = cr.tenant_id and m.custom_role_id = cr.id) as member_count
           from custom_roles cr
           where cr.tenant_id = $1
           order by cr.name`,
          [tenantId],
        ),
      ]);
      return { users: users.rows, invitations: invitations.rows, custom_roles: customRoles.rows };
    });
  });

  app.post("/t/:tenantSlug/invitations", { preHandler: requirePermission("users.manage") }, async (req) => {
    const { userId, tenantId, role } = context(req);
    const input = invitationInputSchema.parse(req.body);
    const teamIds = [...new Set(input.teamIds)];
    const token = randomBytes(32).toString("base64url");
    const link = `${env.WEB_ORIGIN.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`;
    return withTenant(tenantId, userId, async (client) => {
      await validateTeams(client, tenantId, teamIds);
      const existing = await client.query(
        `select 1 from memberships m join users u on u.id = m.user_id
         where m.tenant_id = $1 and u.email = $2`,
        [tenantId, input.email.toLowerCase()],
      );
      if ((existing.rowCount ?? 0) > 0) throw badRequest("That email is already a member");

      await client.query(
        `update user_invitations set revoked_at = now()
         where tenant_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
        [tenantId, input.email.toLowerCase()],
      );
      const result = await client.query(
        `insert into user_invitations (tenant_id, email, role, team_ids, token_hash, invited_by, expires_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, now() + interval '7 days')
         returning id, email, role, team_ids, expires_at, created_at`,
        [
          tenantId,
          input.email.toLowerCase(),
          input.role,
          JSON.stringify(teamIds),
          hashToken(token),
          userId,
        ],
      );
      const tenant = await client.query<{ name: string }>("select name from tenants where id = $1", [
        tenantId,
      ]);
      await enqueueEmail(client, {
        tenantId,
        recipient: input.email.toLowerCase(),
        subject: `Join ${tenant.rows[0]?.name ?? "your workspace"} on OpsPilot`,
        body: `You have been invited to ${tenant.rows[0]?.name ?? "a workspace"} on OpsPilot as ${input.role.replace("_", " ")}.\n\nAccept the invitation:\n${link}\n\nThis link expires in 7 days.`,
      });
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "user.invited",
        "user_invitation",
        result.rows[0]?.id ?? null,
        null,
        { email: input.email, role: input.role, teamIds },
        req.correlationId,
      );
      return { invitation: result.rows[0], link };
    });
  });

  app.delete("/t/:tenantSlug/invitations/:id", { preHandler: requirePermission("users.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = context(req);
    const params = inviteParams.parse(req.params);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `update user_invitations set revoked_at = now()
         where tenant_id = $1 and id = $2 and accepted_at is null and revoked_at is null
         returning email`,
        [tenantId, params.id],
      );
      if ((result.rowCount ?? 0) === 0) throw notFound("Invitation not found");
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "user.invitation_revoked",
        "user_invitation",
        params.id,
        null,
        {},
        req.correlationId,
      );
      return reply.code(204).send();
    });
  });

  app.get("/t/:tenantSlug/custom-roles", async (req) => {
    const { userId, tenantId } = context(req);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        `select cr.id, cr.name, cr.base_role, cr.permissions, cr.created_at,
                (select count(*)::int from memberships m
                 where m.tenant_id = cr.tenant_id and m.custom_role_id = cr.id) as member_count
         from custom_roles cr
         where cr.tenant_id = $1
         order by cr.name`,
        [tenantId],
      );
      return { roles: result.rows };
    });
  });

  app.post("/t/:tenantSlug/custom-roles", { preHandler: requirePermission("users.manage") }, async (req) => {
    const { userId, tenantId, role } = context(req);
    const input = customRoleInputSchema.parse(req.body);
    const permissions = [...new Set(input.permissions)];
    if (input.baseRole === "tenant_admin" && !permissions.includes("users.manage")) {
      throw badRequest("Administrator roles must include users.manage");
    }
    return withTenant(tenantId, userId, async (client) => {
      try {
        const result = await client.query(
          `insert into custom_roles (tenant_id, name, base_role, permissions)
           values ($1, $2, $3, $4::jsonb)
           returning id, name, base_role, permissions, created_at`,
          [tenantId, input.name, input.baseRole, JSON.stringify(permissions)],
        );
        await writeAudit(
          client,
          tenantId,
          { id: userId, role },
          "role.created",
          "custom_role",
          result.rows[0]?.id ?? null,
          null,
          { name: input.name, baseRole: input.baseRole, permissions },
          req.correlationId,
        );
        return result.rows[0];
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
          throw badRequest("A role with that name already exists");
        }
        throw error;
      }
    });
  });

  app.patch("/t/:tenantSlug/custom-roles/:roleId", { preHandler: requirePermission("users.manage") }, async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = roleParams.parse(req.params);
    const input = customRoleUpdateSchema.parse(req.body);
    return withTenant(tenantId, userId, async (client) => {
      const current = await client.query<{ base_role: string; permissions: unknown; member_count: string }>(
        `select cr.base_role, cr.permissions,
                (select count(*)::text from memberships m
                 where m.tenant_id = cr.tenant_id and m.custom_role_id = cr.id) as member_count
         from custom_roles cr
         where cr.tenant_id = $1 and cr.id = $2`,
        [tenantId, params.roleId],
      );
      const existing = current.rows[0];
      if (!existing) throw notFound("Role not found");
      if (input.baseRole && input.baseRole !== existing.base_role && Number(existing.member_count) > 0) {
        throw badRequest("Remove this role from members before changing its base role");
      }
      const permissions = input.permissions ? [...new Set(input.permissions)] : null;
      const resultingBaseRole = input.baseRole ?? existing.base_role;
      if (resultingBaseRole === "tenant_admin" && permissions && !permissions.includes("users.manage")) {
        throw badRequest("Administrator roles must include users.manage");
      }
      try {
        const result = await client.query(
          `update custom_roles set
             name = coalesce($3, name),
             base_role = coalesce($4::user_role, base_role),
             permissions = coalesce($5::jsonb, permissions),
             updated_at = now()
           where tenant_id = $1 and id = $2
           returning id, name, base_role, permissions, created_at`,
          [
            tenantId,
            params.roleId,
            input.name ?? null,
            input.baseRole ?? null,
            permissions ? JSON.stringify(permissions) : null,
          ],
        );
        await writeAudit(
          client,
          tenantId,
          { id: userId, role },
          "role.updated",
          "custom_role",
          params.roleId,
          { baseRole: existing.base_role, permissions: existing.permissions },
          { name: input.name ?? null, baseRole: input.baseRole ?? null, permissions },
          req.correlationId,
        );
        return result.rows[0];
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
          throw badRequest("A role with that name already exists");
        }
        throw error;
      }
    });
  });

  app.delete("/t/:tenantSlug/custom-roles/:roleId", { preHandler: requirePermission("users.manage") }, async (req, reply) => {
    const { userId, tenantId, role } = context(req);
    const params = roleParams.parse(req.params);
    return withTenant(tenantId, userId, async (client) => {
      const result = await client.query(
        "delete from custom_roles where tenant_id = $1 and id = $2 returning name",
        [tenantId, params.roleId],
      );
      if ((result.rowCount ?? 0) === 0) throw notFound("Role not found");
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "role.deleted",
        "custom_role",
        params.roleId,
        { name: result.rows[0]?.name ?? null },
        null,
        req.correlationId,
      );
      return reply.code(204).send();
    });
  });

  app.patch("/t/:tenantSlug/users/:userId", { preHandler: requirePermission("users.manage") }, async (req) => {
    const { userId, tenantId, role } = context(req);
    const params = userParams.parse(req.params);
    const input = membershipUpdateSchema.parse(req.body);
    const teamIds = input.teamIds ? [...new Set(input.teamIds)] : undefined;
    if (
      input.role === undefined &&
      input.isActive === undefined &&
      teamIds === undefined &&
      input.customRoleId === undefined &&
      input.managerUserId === undefined
    ) {
      throw badRequest("Nothing to update");
    }
    return withTenant(tenantId, userId, async (client) => {
      const current = await client.query<{ role: string; is_active: boolean }>(
        "select role, is_active from memberships where tenant_id = $1 and user_id = $2 for update",
        [tenantId, params.userId],
      );
      const membership = current.rows[0];
      if (!membership) throw notFound("User not found");

      let customRoleId = input.customRoleId;
      let nextRole = input.role;
      if (customRoleId) {
        const customRole = await client.query<{
          base_role: "tenant_admin" | "agent" | "employee";
          permissions: unknown;
        }>(
          "select base_role, permissions from custom_roles where tenant_id = $1 and id = $2",
          [tenantId, customRoleId],
        );
        const roleRow = customRole.rows[0];
        if (!roleRow) throw badRequest("Unknown custom role");
        nextRole = roleRow.base_role;
        if (
          nextRole === "tenant_admin" &&
          (!Array.isArray(roleRow.permissions) || !roleRow.permissions.includes("users.manage"))
        ) {
          throw badRequest("Administrator roles must include users.manage");
        }
      }

      const removingAdmin =
        membership.role === "tenant_admin" &&
        ((nextRole !== undefined && nextRole !== "tenant_admin") || input.isActive === false);
      if (removingAdmin) {
        const admins = await client.query<{ count: string }>(
          `select count(*)::text as count from memberships
           where tenant_id = $1 and role = 'tenant_admin' and is_active`,
          [tenantId],
        );
        if (Number(admins.rows[0]?.count ?? 0) <= 1) {
          throw badRequest("The workspace needs at least one active administrator");
        }
      }

      if (teamIds !== undefined) await validateTeams(client, tenantId, teamIds);
      if (input.managerUserId !== undefined) {
        if (input.managerUserId === params.userId) {
          throw badRequest("A person cannot be their own manager");
        }
        if (input.managerUserId) {
          const manager = await client.query(
            "select 1 from memberships where tenant_id = $1 and user_id = $2 and is_active",
            [tenantId, input.managerUserId],
          );
          if ((manager.rowCount ?? 0) === 0) throw badRequest("Unknown or inactive manager");
        }
      }
      await client.query(
        `update memberships
         set role = coalesce($3::user_role, role),
             is_active = coalesce($4::boolean, is_active),
             custom_role_id = case when $6::boolean then $5::uuid else custom_role_id end,
             manager_user_id = case when $8::boolean then $7::uuid else manager_user_id end
         where tenant_id = $1 and user_id = $2`,
        [
          tenantId,
          params.userId,
          nextRole ?? null,
          input.isActive ?? null,
          customRoleId ?? null,
          input.customRoleId !== undefined,
          input.managerUserId ?? null,
          input.managerUserId !== undefined,
        ],
      );
      if (teamIds !== undefined) {
        await client.query("delete from team_members where tenant_id = $1 and user_id = $2", [
          tenantId,
          params.userId,
        ]);
        if (teamIds.length > 0) {
          await client.query(
            `insert into team_members (tenant_id, team_id, user_id)
             select $1, team_id, $2 from unnest($3::uuid[]) as team_id`,
            [tenantId, params.userId, teamIds],
          );
        }
      }
      const updated = await readUser(client, tenantId, params.userId);
      await writeAudit(
        client,
        tenantId,
        { id: userId, role },
        "user.updated",
        "membership",
        params.userId,
        { role: membership.role, isActive: membership.is_active },
        {
          role: updated.role,
          isActive: updated.is_active,
          teamIds: updated.team_ids,
          customRoleId: updated.custom_role_id,
          managerUserId: updated.manager_user_id,
        },
        req.correlationId,
      );
      return updated;
    });
  });
}
