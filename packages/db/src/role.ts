import pg from "pg";
import { adminDatabaseUrl, appRole } from "./env.js";

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main() {
  const role = appRole();
  const password = process.env.APP_DB_PASSWORD;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error("APP_DB_ROLE must be a simple identifier");
  if (!password) throw new Error("APP_DB_PASSWORD is required");

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
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
