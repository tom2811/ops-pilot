import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  automationAssignSchema,
  notificationInputSchema,
  routePreviewSchema,
  runCompleteSchema,
} from "@opspilot/core";
import { hashToken } from "../auth.js";
import { withRunToken } from "../db.js";
import { AppError, conflict } from "../errors.js";
import { assignTicket } from "../domain/tickets.js";
import { previewRoute } from "../domain/routing.js";

type RunRow = {
  id: string;
  tenant_id: string;
  event_id: string;
  status: "in_progress" | "completed" | "failed";
  lease_expires_at: Date;
};

const runParams = z.object({ runId: z.string().uuid() });

function runToken(req: FastifyRequest): string {
  const header = req.headers["x-opspilot-run-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || token.length < 20) throw new AppError(401, "Invalid automation token");
  return token;
}

async function withAutomation(
  req: FastifyRequest,
  fn: (client: import("pg").PoolClient, run: RunRow) => Promise<unknown>,
): Promise<unknown> {
  const params = runParams.parse(req.params);
  return withRunToken(hashToken(runToken(req)), async (client) => {
    const result = await client.query<RunRow>(
      `select id, tenant_id, event_id, status, lease_expires_at
       from automation_runs where id = $1 and run_token_hash = $2`,
      [params.runId, hashToken(runToken(req))],
    );
    const run = result.rows[0];
    if (!run) throw new AppError(401, "Invalid automation token");
    if (run.status !== "in_progress") throw conflict("Automation run is no longer active");
    if (run.lease_expires_at.getTime() < Date.now()) throw new AppError(401, "Automation run has expired");

    await client.query("select set_config('app.tenant_id', $1, true)", [run.tenant_id]);
    return fn(client, run);
  });
}

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/runs/:runId/complete", async (req) => {
    const input = runCompleteSchema.parse(req.body);
    return withAutomation(req, async (client, run) => {
      await client.query(
        `update automation_runs
         set status = $3, error = $4, completed_at = now(),
             run_token_hash = encode(gen_random_bytes(32), 'hex')
         where tenant_id = $1 and id = $2`,
        [run.tenant_id, run.id, input.status, input.error ?? null],
      );
      await client.query(
        `update outbox_events
         set status = $3::outbox_status,
             delivered_at = case when $3::outbox_status = 'delivered'::outbox_status then now() else delivered_at end,
             last_error = $4, locked_until = null
         where tenant_id = $1 and id = $2`,
        [
          run.tenant_id,
          run.event_id,
          input.status === "completed" ? "delivered" : "dead",
          input.error ?? null,
        ],
      );
      return { ok: true };
    });
  });

  app.post("/runs/:runId/preview-route", async (req) => {
    const input = routePreviewSchema.parse(req.body);
    return withAutomation(req, async (client, run) => previewRoute(client, run.tenant_id, input));
  });

  app.post("/runs/:runId/assign", async (req) => {
    const input = automationAssignSchema.parse(req.body);
    return withAutomation(req, async (client, run) => {
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const receipt = await client.query<{ request_hash: string; response: Record<string, unknown> }>(
        "select request_hash, response from command_receipts where tenant_id = $1 and idempotency_key = $2",
        [run.tenant_id, input.idempotencyKey],
      );
      const existing = receipt.rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw conflict("Idempotency key reused with different input");
        return existing.response;
      }

      const ticket = await assignTicket(
        client,
        run.tenant_id,
        null,
        "automation",
        input.ticketId,
        { teamId: input.teamId, assigneeId: input.assigneeId },
        req.correlationId,
      );

      const response = {
        ticketId: ticket.id,
        number: ticket.number,
        version: ticket.version,
        status: ticket.status_key,
        teamId: ticket.team_id,
        assigneeId: ticket.assignee_id,
      };

      await client.query(
        `insert into command_receipts (tenant_id, idempotency_key, request_hash, command, response)
         values ($1, $2, $3, 'assign', $4)`,
        [run.tenant_id, input.idempotencyKey, requestHash, JSON.stringify(response)],
      );

      return response;
    });
  });

  app.post("/runs/:runId/notify", async (req) => {
    const input = notificationInputSchema.parse(req.body);
    return withAutomation(req, async (client, run) => {
      const dedupeKey = `${run.id}:${input.channel}:${input.ticketId}:${input.recipientId}`;
      const inserted = await client.query(
        `insert into notifications
          (tenant_id, event_id, ticket_id, recipient_id, channel, dedupe_key, status, subject, body, sent_at)
         values ($1, $2, $3, $4, $5, $6, 'sent', $7, $8, now())
         on conflict (tenant_id, dedupe_key) do nothing
         returning id`,
        [
          run.tenant_id,
          run.event_id,
          input.ticketId,
          input.recipientId,
          input.channel,
          dedupeKey,
          input.subject,
          input.body,
        ],
      );
      return { ok: true, deduped: (inserted.rowCount ?? 0) === 0 };
    });
  });
}
