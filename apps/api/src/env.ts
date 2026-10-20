import { config } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

config({ path: resolve(import.meta.dirname, "../../../.env") });
config();

const envSchema = z.object({
  APP_DATABASE_URL: z.string().min(1),
  WORKER_DATABASE_URL: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  SESSION_COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  PUBLIC_API_URL: z.string().min(1).default("http://localhost:3000/api"),
  N8N_WEBHOOK_URL: z.string().min(1).optional(),
  N8N_WEBHOOK_SECRET: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default("info"),
});

export const env = envSchema.parse(process.env);
