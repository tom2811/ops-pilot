import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  invitationAcceptSchema,
  loginSchema,
  passwordChangeSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
} from "@opspilot/core";
import { hashPassword, verifyPassword } from "@opspilot/core/password";
import {
  clearFailedLogins,
  clearSessionCookie,
  createSession,
  currentCsrfToken,
  currentSessionHash,
  deleteSession,
  getLoginUser,
  getMemberships,
  hashToken,
  recordFailedLogin,
  requireAuth,
  setSessionCookie,
} from "../auth.js";
import { adminPool, pool } from "../db.js";
import { enqueueEmail } from "../emailQueue.js";
import { env } from "../env.js";
import { AppError } from "../errors.js";

const inviteParams = z.object({ token: z.string().min(10).max(200) });

// A syntactically valid hash used to keep failed logins for unknown accounts
// roughly as expensive as real ones, so timing does not reveal which emails exist.
const DUMMY_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

function webUrl(path: string): string {
  return `${env.WEB_ORIGIN.replace(/\/$/, "")}${path}`;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = loginSchema.parse(req.body);
    const user = await getLoginUser(input.email.toLowerCase());
    if (!user) {
      await verifyPassword(input.password, DUMMY_HASH);
      throw new AppError(401, "Invalid email or password");
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AppError(429, "Too many failed attempts. Try again in a few minutes.");
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await recordFailedLogin(user.id);
      throw new AppError(401, "Invalid email or password");
    }
    await clearFailedLogins(user.id);

    const session = await createSession(user.id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    setSessionCookie(reply, session.token, session.expiresAt);
    const memberships = await getMemberships(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isPlatformAdmin: user.isPlatformAdmin,
      },
      memberships,
      csrfToken: session.csrfToken,
    };
  });

  app.post("/logout", async (req, reply) => {
    await deleteSession(req);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/me", { preHandler: requireAuth }, async (req) => {
    const user = req.authUser;
    if (!user) throw new AppError(401, "Unauthorized");
    return {
      user,
      memberships: await getMemberships(user.id),
      csrfToken: await currentCsrfToken(req),
    };
  });

  app.get("/sessions", { preHandler: requireAuth }, async (req) => {
    if (!req.authUser) throw new AppError(401, "Unauthorized");
    const current = currentSessionHash(req);
    const result = await pool.query(
      `select id, created_at, last_seen_at, expires_at, user_agent, ip,
              ($2::text is not null and token_hash = $2) as is_current
       from sessions
       where user_id = $1 and expires_at > now()
       order by last_seen_at desc`,
      [req.authUser.id, current],
    );
    return { sessions: result.rows };
  });

  app.delete("/sessions/:id", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.authUser) throw new AppError(401, "Unauthorized");
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await pool.query("delete from sessions where id = $1 and user_id = $2", [
      params.id,
      req.authUser.id,
    ]);
    if (result.rowCount === 0) throw new AppError(404, "Session not found");
    return reply.code(204).send();
  });

  app.delete("/sessions", { preHandler: requireAuth }, async (req) => {
    if (!req.authUser) throw new AppError(401, "Unauthorized");
    const current = currentSessionHash(req);
    const result = await pool.query(
      `delete from sessions
       where user_id = $1 and ($2::text is null or token_hash <> $2)`,
      [req.authUser.id, current],
    );
    return { ok: true, revoked: result.rowCount ?? 0 };
  });

  app.post("/password/change", { preHandler: requireAuth }, async (req) => {
    if (!req.authUser) throw new AppError(401, "Unauthorized");
    const input = passwordChangeSchema.parse(req.body);
    const user = await getLoginUser(req.authUser.email);
    if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError(400, "Current password is incorrect");
    }
    await pool.query("update users set password_hash = $1 where id = $2", [
      await hashPassword(input.newPassword),
      user.id,
    ]);
    const current = currentSessionHash(req);
    await pool.query(
      `delete from sessions
       where user_id = $1 and ($2::text is null or token_hash <> $2)`,
      [user.id, current],
    );
    return { ok: true };
  });

  app.post("/password/reset/request", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req) => {
    const input = passwordResetRequestSchema.parse(req.body);
    const result = await pool.query<{ id: string; email: string; display_name: string }>(
      "select id, email, display_name from users where email = $1 and is_active",
      [input.email.toLowerCase()],
    );
    const user = result.rows[0];
    if (user) {
      const token = randomBytes(32).toString("base64url");
      await pool.query(
        "update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null",
        [user.id],
      );
      await pool.query(
        `insert into password_reset_tokens (user_id, token_hash, expires_at)
         values ($1, $2, now() + interval '1 hour')`,
        [user.id, hashToken(token)],
      );
      const link = webUrl(`/reset-password?token=${encodeURIComponent(token)}`);
      await enqueueEmail(adminPool, {
        tenantId: null,
        recipient: user.email,
        subject: "Reset your OpsPilot password",
        body: `Hi ${user.display_name},\n\nUse this link within one hour to reset your password:\n${link}\n\nIf you did not request this, you can ignore this email.`,
      });
    }
    return { ok: true };
  });

  app.post("/password/reset/confirm", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req) => {
    const input = passwordResetConfirmSchema.parse(req.body);
    const tokenHash = hashToken(input.token);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{ id: string; user_id: string }>(
        `select id, user_id from password_reset_tokens
         where token_hash = $1 and used_at is null and expires_at > now()
         for update`,
        [tokenHash],
      );
      const tokenRow = result.rows[0];
      if (!tokenRow) throw new AppError(400, "This reset link is invalid or expired");
      await client.query("update users set password_hash = $1 where id = $2", [
        await hashPassword(input.password),
        tokenRow.user_id,
      ]);
      await client.query("update password_reset_tokens set used_at = now() where id = $1", [
        tokenRow.id,
      ]);
      await client.query("delete from sessions where user_id = $1", [tokenRow.user_id]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return { ok: true };
  });

  app.get("/invitations/:token", async (req) => {
    const params = inviteParams.parse(req.params);
    const result = await adminPool.query<{
      email: string;
      role: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      tenant_name: string;
      tenant_slug: string;
      tenant_status: string;
    }>(
      `select i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
              t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status
       from user_invitations i
       join tenants t on t.id = i.tenant_id
       where i.token_hash = $1`,
      [hashToken(params.token)],
    );
    const invite = result.rows[0];
    if (!invite || invite.revoked_at || invite.tenant_status !== "active") {
      throw new AppError(404, "Invitation not found");
    }
    if (invite.accepted_at) throw new AppError(410, "Invitation already accepted");
    if (invite.expires_at < new Date()) throw new AppError(410, "Invitation expired");
    const existing = await adminPool.query("select 1 from users where email = $1 and is_active", [
      invite.email,
    ]);
    return {
      email: invite.email,
      role: invite.role,
      tenantName: invite.tenant_name,
      tenantSlug: invite.tenant_slug,
      existingUser: (existing.rowCount ?? 0) > 0,
    };
  });

  app.post("/invitations/:token/accept", async (req, reply) => {
    const params = inviteParams.parse(req.params);
    const input = invitationAcceptSchema.parse(req.body);
    const tokenHash = hashToken(params.token);

    const client = await adminPool.connect();
    let userId: string;
    let userEmail: string;
    let displayName: string;
    try {
      await client.query("begin");
      const inviteResult = await client.query<{
        id: string;
        tenant_id: string;
        email: string;
        role: "tenant_admin" | "agent" | "employee";
        team_ids: unknown;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
      }>(
        `select i.id, i.tenant_id, i.email, i.role, i.team_ids, i.expires_at, i.accepted_at, i.revoked_at
         from user_invitations i
         join tenants t on t.id = i.tenant_id
         where i.token_hash = $1 and t.status = 'active'
         for update of i`,
        [tokenHash],
      );
      const invite = inviteResult.rows[0];
      if (!invite || invite.revoked_at) throw new AppError(404, "Invitation not found");
      if (invite.accepted_at) throw new AppError(410, "Invitation already accepted");
      if (invite.expires_at < new Date()) throw new AppError(410, "Invitation expired");

      const existing = await client.query<{
        id: string;
        email: string;
        display_name: string;
        password_hash: string;
        is_active: boolean;
      }>(
        "select id, email, display_name, password_hash, is_active from users where email = $1",
        [invite.email],
      );
      const existingUser = existing.rows[0];

      if (existingUser) {
        if (!existingUser.is_active) throw new AppError(400, "That account is disabled");
        if (!input.password || !(await verifyPassword(input.password, existingUser.password_hash))) {
          throw new AppError(401, "Enter the password for the invited account");
        }
        userId = existingUser.id;
        userEmail = existingUser.email;
        displayName = existingUser.display_name;
      } else {
        if (!input.displayName || !input.password) {
          throw new AppError(400, "Display name and password are required");
        }
        const created = await client.query<{ id: string; email: string; display_name: string }>(
          `insert into users (email, display_name, password_hash)
           values ($1, $2, $3)
           returning id, email, display_name`,
          [invite.email, input.displayName, await hashPassword(input.password)],
        );
        const user = created.rows[0];
        if (!user) throw new Error("failed to create user");
        userId = user.id;
        userEmail = user.email;
        displayName = user.display_name;
      }

      await client.query(
        `insert into memberships (tenant_id, user_id, role, is_active)
         values ($1, $2, $3, true)
         on conflict (tenant_id, user_id)
         do update set role = excluded.role, is_active = true`,
        [invite.tenant_id, userId, invite.role],
      );
      const teamIds = Array.isArray(invite.team_ids)
        ? invite.team_ids.filter((id): id is string => typeof id === "string")
        : [];
      if (teamIds.length > 0) {
        await client.query(
          `insert into team_members (tenant_id, team_id, user_id)
           select $1, team_id, $3
           from unnest($2::uuid[]) as team_id
           on conflict do nothing`,
          [invite.tenant_id, teamIds, userId],
        );
      }
      await client.query("update user_invitations set accepted_at = now() where id = $1", [
        invite.id,
      ]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const session = await createSession(userId, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    setSessionCookie(reply, session.token, session.expiresAt);
    return {
      user: { id: userId, email: userEmail, displayName, isPlatformAdmin: false },
      memberships: await getMemberships(userId),
      csrfToken: session.csrfToken,
    };
  });
}
