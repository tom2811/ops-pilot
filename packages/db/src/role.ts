import pg from "pg";
import { adminDatabaseUrl, appRole } from "./env.js";

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main() {
  const role = appRole();
  const password = process.env.APP_DB_PASSWORD;
  const workerRole = process.env.WORKER_DB_ROLE;
  const workerPassword = process.env.WORKER_DB_PASSWORD;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error("APP_DB_ROLE must be a simple identifier");
  if (!password) throw new Error("APP_DB_PASSWORD is required");
  if (workerRole) {
    if (!/^[a-z_][a-z0-9_]*$/.test(workerRole)) throw new Error("WORKER_DB_ROLE must be a simple identifier");
    if (workerRole === role) throw new Error("WORKER_DB_ROLE must differ from APP_DB_ROLE");
    if (!workerPassword) throw new Error("WORKER_DB_PASSWORD is required when WORKER_DB_ROLE is set");
  }

  const client = new pg.Client({ connectionString: adminDatabaseUrl() });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_roles where rolname = $1", [role]);
    if (existing.rowCount === 0) {
      await client.query(
        `create role ${role} login password ${quoteLiteral(password)} nosuperuser nocreatedb nocreaterole nobypassrls`,
      );
      console.log(`created role ${role}`);
    } else {
      await client.query(
        `alter role ${role} with login password ${quoteLiteral(password)} nosuperuser nocreatedb nocreaterole nobypassrls`,
      );
      console.log(`updated role ${role}`);
    }

    if (workerRole) {
      const workerExisting = await client.query("select 1 from pg_roles where rolname = $1", [workerRole]);
      if (workerExisting.rowCount === 0) {
        await client.query(
          `create role ${workerRole} login password ${quoteLiteral(workerPassword!)} nosuperuser nocreatedb nocreaterole inherit bypassrls`,
        );
        console.log(`created role ${workerRole}`);
      } else {
        await client.query(
          `alter role ${workerRole} with login password ${quoteLiteral(workerPassword!)} nosuperuser nocreatedb nocreaterole inherit bypassrls`,
        );
        console.log(`updated role ${workerRole}`);
      }
      await client.query(`grant ${role} to ${workerRole}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
