import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./env.js";
import { adminPool } from "./db.js";
import { AppError } from "./errors.js";
import { assertCsrfToken, SESSION_COOKIE } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { platformRoutes } from "./routes/platform.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { reportRoutes } from "./routes/reports.js";
import { ticketRoutes } from "./routes/tickets.js";
import { configRoutes } from "./routes/config.js";
import { automationRoutes } from "./routes/automation.js";
import { notificationRoutes } from "./routes/notifications.js";
import { auditRoutes } from "./routes/audit.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { inboundRoutes } from "./routes/inbound.js";
import { metricsRoutes } from "./routes/metrics.js";
import "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  // Capture the raw JSON body so inbound webhooks can be HMAC-verified over
  // exactly the bytes that were signed.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    req.rawBody = raw;
    if (!raw) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      done(error as Error);
    }
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } });
  const allowedOrigins = env.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    allowList: ["127.0.0.1", "::1"],
  });

  app.addHook("onRequest", async (req) => {
    const header = req.headers["x-correlation-id"];
    req.correlationId = typeof header === "string" && UUID.test(header) ? header : randomUUID();
  });

  const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  app.addHook("preHandler", async (req) => {
    // Only session-cookie requests need CSRF protection. Webhook and automation
    // callers authenticate with their own tokens and never carry this cookie.
    if (!mutatingMethods.has(req.method)) return;
    if (!req.cookies[SESSION_COOKIE]) return;
    await assertCsrfToken(req);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-correlation-id", req.correlationId);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (env.SESSION_COOKIE_SECURE) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({ error: error.message });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: "Validation failed", issues: error.issues });
    }
    const shaped = error as { code?: string; constraint?: string; statusCode?: number; message?: string };
    if (shaped.code === "23505") {
      if (shaped.constraint === "priorities_tenant_id_rank_key") {
        return reply.status(409).send({ error: "That priority rank is already in use" });
      }
      if (shaped.constraint === "priorities_tenant_id_key_key") {
        return reply.status(409).send({ error: "That priority key is already in use" });
      }
      return reply.status(409).send({ error: "That value already exists" });
    }
    if (shaped.code === "23503") return reply.status(400).send({ error: "Related record not found" });
    if (shaped.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.status(413).send({ error: "File is larger than 10 MB" });
    }
    if (shaped.statusCode === 429) return reply.status(429).send({ error: "Too many requests" });
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
  await app.register(userRoutes, { prefix: "/api" });
  await app.register(platformRoutes, { prefix: "/api" });
  await app.register(feedbackRoutes, { prefix: "/api" });
  await app.register(reportRoutes, { prefix: "/api" });
  await app.register(auditRoutes, { prefix: "/api" });
  await app.register(inboundRoutes, { prefix: "/api" });
  await app.register(metricsRoutes, { prefix: "/api" });

  app.get("/api/health/live", async () => ({ ok: true }));
  app.get("/api/health", async (_req, reply) => {
    try {
      await adminPool.query("select 1");
      return { ok: true, database: "ok", uptime: Math.round(process.uptime()) };
    } catch (error) {
      app.log.error({ err: error }, "health check failed");
      return reply.status(503).send({ ok: false, database: "unavailable" });
    }
  });

  return app;
}
