import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_ROLE_PERMISSIONS, type Permission, type Role } from "@opspilot/core";
import { env } from "./env.js";
import { pool, withUser } from "./db.js";
import { AppError } from "./errors.js";
import type { AuthUser, TenantContext } from "./types.js";

export const SESSION_COOKIE = "opspilot_session";
const SESSION_DAYS = 30;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `insert into sessions (user_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, meta.userAgent ?? null, meta.ip ?? null],
  );
  return { token, expiresAt };
}

export function currentSessionHash(req: FastifyRequest): string | null {
  const token = req.cookies[SESSION_COOKIE];
  return token ? hashToken(token) : null;
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: env.SESSION_COOKIE_SECURE ? "none" : "lax",
    secure: env.SESSION_COOKIE_SECURE,
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    sameSite: env.SESSION_COOKIE_SECURE ? "none" : "lax",
    secure: env.SESSION_COOKIE_SECURE,
  });
}

export async function getSessionUser(req: FastifyRequest): Promise<AuthUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;

  const result = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    is_platform_admin: boolean;
  }>(
    `update sessions s set last_seen_at = now()
     from users u
     where s.token_hash = $1 and s.expires_at > now() and u.id = s.user_id and u.is_active
     returning u.id, u.email, u.display_name,
       exists (select 1 from platform_admins pa where pa.user_id = u.id) as is_platform_admin`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isPlatformAdmin: row.is_platform_admin,
  };
}

function effectivePermissions(
  role: Role,
  customRoleId: string | null,
  customPermissions: unknown,
): Permission[] {
  if (!customRoleId) return DEFAULT_ROLE_PERMISSIONS[role];
  if (!Array.isArray(customPermissions)) return [];
  return customPermissions.filter((permission): permission is Permission =>
    typeof permission === "string",
  );
}

export async function getMemberships(userId: string): Promise<TenantContext[]> {
  return withUser(userId, async (client) => {
    const result = await client.query<{
      id: string;
      slug: string;
      name: string;
      role: Role;
      custom_role_id: string | null;
      custom_permissions: unknown;
    }>(
      `select t.id, t.slug, t.name, m.role, m.custom_role_id,
              cr.permissions as custom_permissions
       from memberships m
       join tenants t on t.id = m.tenant_id
       left join custom_roles cr on cr.tenant_id = m.tenant_id and cr.id = m.custom_role_id
       where m.user_id = $1 and m.is_active and t.status = 'active'
       order by t.name`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      role: row.role,
      permissions: effectivePermissions(row.role, row.custom_role_id, row.custom_permissions),
    }));
  });
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const user = await getSessionUser(req);
  if (!user) throw new AppError(401, "Unauthorized");
  req.authUser = user;
}

function readTenantSlug(req: FastifyRequest): string {
  const params: unknown = req.params;
  if (typeof params !== "object" || params === null || !("tenantSlug" in params)) {
    throw new AppError(400, "Tenant slug missing");
  }
  const slug = params.tenantSlug;
  if (typeof slug !== "string" || slug.length === 0) throw new AppError(400, "Tenant slug missing");
  return slug;
}

export async function requireTenant(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.authUser) throw new AppError(401, "Unauthorized");
  const slug = readTenantSlug(req);

  const row = await withUser(req.authUser.id, async (client) => {
    const result = await client.query<{
      id: string;
      slug: string;
      name: string;
      role: Role;
      custom_role_id: string | null;
      custom_permissions: unknown;
    }>(
      `select t.id, t.slug, t.name, m.role, m.custom_role_id,
              cr.permissions as custom_permissions
       from memberships m
       join tenants t on t.id = m.tenant_id
       left join custom_roles cr on cr.tenant_id = m.tenant_id and cr.id = m.custom_role_id
       where m.user_id = $1 and m.is_active and t.slug = $2 and t.status = 'active'`,
      [req.authUser?.id, slug],
    );
    return result.rows[0] ?? null;
  });

  if (!row) throw new AppError(404, "Tenant not found");
  req.tenant = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    role: row.role,
    permissions: effectivePermissions(row.role, row.custom_role_id, row.custom_permissions),
  };
}

export async function requirePlatformAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.authUser) throw new AppError(401, "Unauthorized");
  if (!req.authUser.isPlatformAdmin) throw new AppError(403, "Platform administrators only");
}

export function requirePermission(...permissions: Permission[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const tenant = req.tenant;
    if (!tenant) throw new AppError(401, "Unauthorized");
    if (!permissions.every((permission) => tenant.permissions.includes(permission))) {
      throw new AppError(403, "Forbidden");
    }
  };
}

export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const tenant = req.tenant;
    if (!tenant) throw new AppError(401, "Unauthorized");
    if (!roles.includes(tenant.role)) throw new AppError(403, "Forbidden");
  };
}

export async function getLoginUser(email: string): Promise<{
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  isPlatformAdmin: boolean;
} | null> {
  const result = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    is_platform_admin: boolean;
  }>(
    `select u.id, u.email, u.display_name, u.password_hash,
            exists (select 1 from platform_admins pa where pa.user_id = u.id) as is_platform_admin
     from users u where u.email = $1 and u.is_active`,
    [email],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    isPlatformAdmin: row.is_platform_admin,
  };
}

export async function deleteSession(req: FastifyRequest): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  await pool.query("delete from sessions where token_hash = $1", [hashToken(token)]);
}
