import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { inboundEmailInputSchema } from "@opspilot/core";
import { adminPool } from "../db.js";
import { env } from "../env.js";
import { AppError, notFound } from "../errors.js";
import { processInboundEmail } from "../domain/inboundEmail.js";

const TIMESTAMP_HEADER = "x-opspilot-timestamp";
const SIGNATURE_HEADER = "x-opspilot-signature";
const LEGACY_SECRET_HEADER = "x-opspilot-inbound-secret";

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const a = typeof left === "string" ? Buffer.from(left) : left;
  const b = typeof right === "string" ? Buffer.from(right) : right;
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(req: FastifyRequest): void {
  const timestamp = headerValue(req, TIMESTAMP_HEADER);
  const signature = headerValue(req, SIGNATURE_HEADER);

  if (timestamp && signature) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) throw new AppError(401, "Invalid webhook timestamp");
    const skew = Math.abs(Date.now() / 1000 - seconds);
    if (skew > env.INBOUND_WEBHOOK_TOLERANCE_SECONDS) {
      throw new AppError(401, "Webhook timestamp is outside the allowed window");
    }
    const expected = createHmac("sha256", env.INBOUND_WEBHOOK_SECRET)
      .update(`${timestamp}.${req.rawBody ?? ""}`)
      .digest();
    const provided = Buffer.from(signature.replace(/^sha256=/i, ""), "hex");
    if (!safeEqual(provided, expected)) {
      throw new AppError(401, "Webhook signature is invalid");
    }
    return;
  }

  if (env.INBOUND_WEBHOOK_ALLOW_LEGACY_SECRET) {
    const legacy = headerValue(req, LEGACY_SECRET_HEADER);
    if (legacy && safeEqual(legacy, env.INBOUND_WEBHOOK_SECRET)) {
      req.log.warn({ correlationId: req.correlationId }, "inbound_webhook_legacy_secret_used");
      return;
    }
  }

  throw new AppError(401, "Inbound webhook signature is missing or invalid");
}

export async function inboundRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req) => {
    verifySignature(req);
  });

  // Tenant-scoped inbound webhook
  app.post("/t/:tenantSlug/inbound/email", async (req, reply) => {
    const { tenantSlug } = req.params as { tenantSlug: string };
    const input = inboundEmailInputSchema.parse(req.body);

    const client = await adminPool.connect();
    try {
      const tenantRes = await client.query<{ id: string }>(
        "select id from tenants where slug = $1 and status = 'active'",
        [tenantSlug],
      );
      if (!tenantRes.rows[0]) notFound("Workspace not found");
      const tenantId = tenantRes.rows[0].id;

      await client.query("begin");
      const result = await processInboundEmail(client, input, tenantId, req.correlationId);
      await client.query("commit");

      const statusCode = result.action === "ticket_created" ? 201 : 200;
      return reply.status(statusCode).send(result);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // Global inbound webhook
  app.post("/inbound/email", async (req, reply) => {
    const input = inboundEmailInputSchema.parse(req.body);

    const client = await adminPool.connect();
    try {
      await client.query("begin");
      const result = await processInboundEmail(client, input, undefined, req.correlationId);
      await client.query("commit");

      const statusCode = result.action === "ticket_created" ? 201 : 200;
      return reply.status(statusCode).send(result);
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
