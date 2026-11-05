import type { Permission, Role } from "@opspilot/core";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
};

export type TenantContext = {
  id: string;
  slug: string;
  name: string;
  role: Role;
  permissions: Permission[];
};

export type AutomationContext = {
  runId: string;
  eventId: string;
  tenantId: string;
  tenantSlug: string;
};

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    tenant?: TenantContext;
    automation?: AutomationContext;
    correlationId: string;
    rawBody?: string;
  }
}
