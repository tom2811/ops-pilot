import { config } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

config({ path: resolve(import.meta.dirname, "../../../.env") });
config();

const defaultAppDbUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;
const defaultAdminDbUrl =
  process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

const envSchema = z.object({
  APP_DATABASE_URL: z.string().min(1).default(defaultAppDbUrl ?? ""),
  ADMIN_DATABASE_URL: z.string().min(1).default(defaultAdminDbUrl ?? ""),
  WORKER_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  NEON_BRANCH: z.string().optional(),
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  SESSION_COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  PUBLIC_API_URL: z.string().min(1).default("http://localhost:3000/api"),
  N8N_WEBHOOK_URL: z.string().min(1).optional(),
  N8N_WEBHOOK_SECRET: z.string().min(1).optional(),
  INBOUND_WEBHOOK_SECRET:
    process.env.NODE_ENV === "production"
      ? z.string().min(16, "INBOUND_WEBHOOK_SECRET must be at least 16 characters in production")
      : z.string().min(16).default("dev-inbound-webhook-secret"),
  INBOUND_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  INBOUND_WEBHOOK_ALLOW_LEGACY_SECRET: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  METRICS_TOKEN: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(16).optional()),
  SMTP_HOST: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  SMTP_PORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().positive().default(587),
  ),
  SMTP_SECURE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ),
  SMTP_FROM: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional()),
  INBOUND_EMAIL_DOMAIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().min(1).max(200).optional(),
  ),
  UPLOAD_DIR: z.string().min(1).default("./data/uploads"),
  LOG_LEVEL: z.string().default("info"),
});

export const env = envSchema.parse(process.env);
