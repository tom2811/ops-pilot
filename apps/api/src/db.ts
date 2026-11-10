import pg from "pg";
import { env } from "./env.js";

export const pool = new pg.Pool({
  connectionString: env.APP_DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
export const adminPool = new pg.Pool({
  connectionString: env.ADMIN_DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (error) => {
  console.error("postgres pool error", error);
});
adminPool.on("error", (error) => {
  console.error("postgres admin pool error", error);
});

export async function withUser<T>(
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (userId) await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function withTenant<T>(
  tenantId: string,
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (userId) {
      await client.query(
        "select set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)",
        [userId, tenantId],
      );
    } else {
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function withRunToken<T>(
  runTokenHash: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.run_token_hash', $1, true)", [runTokenHash]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected one row");
  return row;
}
