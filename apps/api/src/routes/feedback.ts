import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { feedbackSchema } from "@opspilot/core";
import { adminPool } from "../db.js";
import { AppError } from "../errors.js";

const paramsSchema = z.object({ token: z.string().min(10).max(200) });

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.get("/feedback/:token", async (req) => {
    const params = paramsSchema.parse(req.params);
    const result = await adminPool.query<{
      rating: number | null;
      comment: string | null;
      submitted_at: Date | null;
      expires_at: Date;
      number: number;
      subject: string;
      tenant_name: string;
    }>(
      `select f.rating, f.comment, f.submitted_at, f.expires_at,
              t.number, t.subject, tn.name as tenant_name
       from ticket_feedback f
       join tickets t on t.tenant_id = f.tenant_id and t.id = f.ticket_id
       join tenants tn on tn.id = f.tenant_id
       where f.token_hash = $1`,
      [hashToken(params.token)],
    );
    const feedback = result.rows[0];
    if (!feedback) throw new AppError(404, "Feedback link not found");
    if (!feedback.submitted_at && feedback.expires_at < new Date()) {
      throw new AppError(410, "This feedback link has expired");
    }
    return {
      ticketNumber: feedback.number,
      ticketSubject: feedback.subject,
      tenantName: feedback.tenant_name,
      submitted: feedback.submitted_at !== null,
      rating: feedback.rating,
      comment: feedback.comment,
    };
  });

  app.post("/feedback/:token", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const params = paramsSchema.parse(req.params);
    const input = feedbackSchema.parse(req.body);
    const result = await adminPool.query(
      `update ticket_feedback
       set rating = $2, comment = $3, submitted_at = now()
       where token_hash = $1 and submitted_at is null and expires_at > now()
       returning ticket_id`,
      [hashToken(params.token), input.rating, input.comment ?? null],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new AppError(400, "This feedback link was already used or has expired");
    }
    return { ok: true };
  });
}
