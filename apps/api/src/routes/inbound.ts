import type { FastifyInstance } from "fastify";
import { inboundEmailInputSchema } from "@opspilot/core";
import { adminPool } from "../db.js";
import { notFound } from "../errors.js";
import { processInboundEmail } from "../domain/inboundEmail.js";

export async function inboundRoutes(app: FastifyInstance): Promise<void> {
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
