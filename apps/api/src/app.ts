import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { env } from "./env.js";
import { AppError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { ticketRoutes } from "./routes/tickets.js";
import { configRoutes } from "./routes/config.js";
import { automationRoutes } from "./routes/automation.js";
import { notificationRoutes } from "./routes/notifications.js";
import { attachmentRoutes } from "./routes/attachments.js";
import "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  app.addHook("onRequest", async (req) => {
    const header = req.headers["x-correlation-id"];
    req.correlationId = typeof header === "string" && UUID.test(header) ? header : randomUUID();
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: error.message });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Validation failed", issues: error.issues });
    }
    const shaped = error as { code?: string; statusCode?: number; message?: string };
    if (shaped.code === "23505") return reply.status(409).send({ error: "That value already exists" });
    if (shaped.code === "23503") return reply.status(400).send({ error: "Related record not found" });
    if (shaped.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.status(413).send({ error: "File is larger than 10 MB" });
    }
    if (shaped.statusCode === 400) return reply.status(400).send({ error: shaped.message ?? "Bad request" });

    req.log.error({ err: error, correlationId: req.correlationId }, "request failed");
    return reply.status(500).send({ error: "Internal server error" });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "Not found" }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(ticketRoutes, { prefix: "/api" });
  await app.register(configRoutes, { prefix: "/api" });
  await app.register(automationRoutes, { prefix: "/api/automation" });
  await app.register(notificationRoutes, { prefix: "/api" });
  await app.register(attachmentRoutes, { prefix: "/api" });

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}
