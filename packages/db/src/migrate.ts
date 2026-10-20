import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { adminDatabaseUrl, appRole } from "./env.js";

const migrationsDir = resolve(import.meta.dirname, "../migrations");

async function main() {
  const client = new pg.Client({ connectionString: adminDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map((row) => row.name),
    );
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(resolve(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        console.log(`applied ${file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    const role = appRole();
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) throw new Error(`role ${role} does not exist; run pnpm db:role`);

    await client.query(`grant usage on schema public to ${role}`);
    await client.query(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await client.query(`grant usage, select on all sequences in schema public to ${role}`);
    await client.query(`revoke update, delete on audit_log, ticket_status_history, ticket_assignment_history from ${role}`);
    console.log(`granted privileges to ${role}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
