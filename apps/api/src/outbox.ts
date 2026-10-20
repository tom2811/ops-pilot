import type pg from "pg";

export async function enqueueEvent(
  client: pg.PoolClient,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const idempotencyKey = `${aggregateType}:${aggregateId}:${aggregateVersion}:${eventType}`;
  await client.query(
    `insert into outbox_events
      (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (idempotency_key) do nothing`,
    [tenantId, aggregateType, aggregateId, aggregateVersion, eventType, JSON.stringify(payload), idempotencyKey],
  );
}
