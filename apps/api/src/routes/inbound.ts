import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { inboundEmailInputSchema } from "@opspilot/core";
import { adminPool } from "../db.js";
import { env } from "../env.js";
import { AppError, notFound } from "../errors.js";
import { processInboundEmail } from "../domain/inboundEmail.js";

function assertWebhookSecret(provided: string | string[] | undefined): void {
  const value = Array.isArray(provided) ? provided[0] : provided;
  const expected = env.INBOUND_WEBHOOK_SECRET;
  if (
    !value ||
    value.length !== expected.length ||
    !timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  ) {
    throw new AppError(401, "Inbound webhook secret is missing or invalid");
  }
}

export async function inboundRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req) => {
    assertWebhookSecret(req.headers["x-opspilot-inbound-secret"]);
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
