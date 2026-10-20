import type pg from "pg";

export type AuditActor = {
  id: string | null;
  role: string;
};

export async function writeAudit(
  client: pg.Pool | pg.PoolClient,
  tenantId: string,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  correlationId: string,
): Promise<void> {
  await client.query(
    `insert into audit_log
      (tenant_id, actor_id, actor_role, action, entity_type, entity_id, before, after, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantId,
      actor.id,
      actor.role,
      action,
      entityType,
      entityId,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      correlationId,
    ],
  );
}
