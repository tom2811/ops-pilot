import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../../.env") });
config();

export function adminDatabaseUrl(): string {
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("ADMIN_DATABASE_URL, DATABASE_URL_UNPOOLED, or DATABASE_URL is required");
  return url;
}

export function appRole(): string {
  const role = process.env.APP_DB_ROLE;
  if (!role) throw new Error("APP_DB_ROLE is required");
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error("APP_DB_ROLE must be a simple identifier");
  return role;
}
