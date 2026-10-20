import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "dotenv";
import { resolve } from "node:path";
import pg from "pg";
import { z } from "zod";

config({ path: resolve(import.meta.dirname, "../../../.env") });
config();

const workerEnv = z
  .object({
    WORKER_DATABASE_URL: z.string().min(1).optional(),
    ADMIN_DATABASE_URL: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),
    N8N_WEBHOOK_URL: z.string().url().optional(),
    N8N_WEBHOOK_SECRET: z.string().min(1).optional(),
    PUBLIC_API_URL: z.string().url().default("http://localhost:3000/api"),
    WORKER_POLL_MS: z.coerce.number().int().positive().default(1500),
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env);

const connectionString =
  workerEnv.WORKER_DATABASE_URL ?? workerEnv.ADMIN_DATABASE_URL ?? workerEnv.DATABASE_URL;
if (!connectionString) throw new Error("WORKER_DATABASE_URL or ADMIN_DATABASE_URL is required");
if (workerEnv.N8N_WEBHOOK_URL && !workerEnv.N8N_WEBHOOK_SECRET) {
  throw new Error("N8N_WEBHOOK_SECRET is required when N8N_WEBHOOK_URL is set");
}

const pool = new pg.Pool({ connectionString, max: 4 });

type OutboxRow = {
  id: string;
  tenant_id: string;
  tenant_slug: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...details, at: new Date().toISOString() }));
}

async function claimEvent(): Promise<OutboxRow | null> {
  await pool.query(
    `update outbox_events set status = 'pending', locked_until = null
     where status = 'sending' and locked_until < now()`,
  );

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<OutboxRow>(
      `select e.id, e.tenant_id, t.slug as tenant_slug, e.aggregate_type, e.aggregate_id,
              e.aggregate_version, e.event_type, e.payload, e.attempts
       from outbox_events e
       join tenants t on t.id = e.tenant_id
       where e.status = 'pending' and e.available_at <= now()
       order by e.available_at, e.created_at
       for update of e skip locked
       limit 1`,
    );
    const event = result.rows[0];
    if (!event) {
      await client.query("commit");
      return null;
    }
    await client.query(
      `update outbox_events
       set status = 'sending', attempts = attempts + 1, locked_until = now() + interval '5 minutes'
       where id = $1`,
      [event.id],
    );
    await client.query("commit");
    return { ...event, attempts: event.attempts + 1 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function deliver(event: OutboxRow): Promise<void> {
  if (event.event_type !== "ticket.created") {
    await pool.query("update outbox_events set status = 'delivered', delivered_at = now(), locked_until = null where id = $1", [
      event.id,
    ]);
    return;
  }
  if (!workerEnv.N8N_WEBHOOK_URL || !workerEnv.N8N_WEBHOOK_SECRET) {
    log("n8n_not_configured", { eventId: event.id });
    await pool.query("update outbox_events set status = 'delivered', delivered_at = now(), locked_until = null where id = $1", [
      event.id,
    ]);
    return;
  }

  const runToken = randomBytes(32).toString("base64url");
  const preferredRunId = randomUUID();
  const run = await pool.query<{ id: string }>(
    `insert into automation_runs (tenant_id, id, event_id, run_token_hash, status, lease_expires_at)
     values ($1, $2, $3, $4, 'in_progress', now() + interval '10 minutes')
     on conflict (tenant_id, event_id) do update set
       run_token_hash = excluded.run_token_hash,
       status = 'in_progress',
       lease_expires_at = excluded.lease_expires_at,
       completed_at = null,
       error = null
     returning id`,
    [event.tenant_id, preferredRunId, event.id, hashToken(runToken)],
  );
  const runId = run.rows[0]?.id ?? preferredRunId;

  const body = JSON.stringify({
    eventId: event.id,
    runId,
    tenant: { id: event.tenant_id, slug: event.tenant_slug },
    token: runToken,
    event: { type: event.event_type, payload: event.payload },
    callbackBaseUrl: `${workerEnv.PUBLIC_API_URL}/automation/runs/${runId}`,
  });
  const signature = createHmac("sha256", workerEnv.N8N_WEBHOOK_SECRET).update(body).digest("hex");

  const response = await fetch(workerEnv.N8N_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opspilot-signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`n8n responded ${response.status}`);

  await pool.query(
    "update outbox_events set status = 'delivered', delivered_at = now(), locked_until = null, last_error = null where id = $1",
    [event.id],
  );
  log("event_delivered", { eventId: event.id, runId, tenant: event.tenant_slug });
}

async function fail(event: OutboxRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const dead = event.attempts >= 5;
  await pool.query(
    `update outbox_events set
       status = $2::outbox_status,
       available_at = case when $2::outbox_status = 'pending'::outbox_status
                           then now() + ($3::text || ' seconds')::interval else available_at end,
       locked_until = null,
       last_error = $4
     where id = $1`,
    [event.id, dead ? "dead" : "pending", String(Math.min(60, 2 ** event.attempts)), message.slice(0, 2000)],
  );
  await pool.query(
    "update automation_runs set status = 'failed', error = $2, completed_at = now() where tenant_id = $1 and event_id = $3 and status = 'in_progress'",
    [event.tenant_id, message.slice(0, 2000), event.id],
  );
  log("event_failed", { eventId: event.id, attempts: event.attempts, dead, error: message });
}

let running = true;

async function loop(): Promise<void> {
  while (running) {
    try {
      const event = await claimEvent();
      if (!event) {
        await sleep(workerEnv.WORKER_POLL_MS);
        continue;
      }
      try {
        await deliver(event);
      } catch (error) {
        await fail(event, error);
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "worker_loop_error", error: String(error) }));
      await sleep(2000);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
    log("worker_stopping", { signal });
  });
}

log("worker_started", { pollMs: workerEnv.WORKER_POLL_MS });
await loop();
await pool.end();
