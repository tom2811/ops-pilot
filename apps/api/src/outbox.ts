import type pg from "pg";

export async function enqueueEvent(
  client: pg.Pool | pg.PoolClient,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const idempotencyKey = `${aggregateType}:${aggregateId}:${aggregateVersion}:${eventType}`;
  const inserted = await client.query<{ id: string }>(
    `insert into outbox_events
      (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, payload, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (idempotency_key) do nothing
     returning id`,
    [tenantId, aggregateType, aggregateId, aggregateVersion, eventType, JSON.stringify(payload), idempotencyKey],
  );
  const id = inserted.rows[0]?.id;
  if (id) return id;

  const existing = await client.query<{ id: string }>(
    "select id from outbox_events where idempotency_key = $1",
    [idempotencyKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) throw new Error("Could not enqueue or load outbox event");
  return existingId;
}
