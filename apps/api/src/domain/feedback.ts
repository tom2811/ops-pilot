import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { enqueueEmail } from "../emailQueue.js";
import { env } from "../env.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requestFeedback(
  client: pg.PoolClient,
  tenantId: string,
  ticketId: string,
): Promise<void> {
  const existing = await client.query("select 1 from ticket_feedback where tenant_id = $1 and ticket_id = $2", [
    tenantId,
    ticketId,
  ]);
  if ((existing.rowCount ?? 0) > 0) return;

  const recipient = await client.query<{
    number: number;
    subject: string;
    email: string;
    display_name: string;
    tenant_name: string;
  }>(
    `select t.number, t.subject, u.email, u.display_name, tn.name as tenant_name
     from tickets t
     join users u on u.id = t.requester_id
     join tenants tn on tn.id = t.tenant_id
     where t.tenant_id = $1 and t.id = $2 and t.deleted_at is null`,
    [tenantId, ticketId],
  );
  const ticket = recipient.rows[0];
  if (!ticket) return;

  const token = randomBytes(32).toString("base64url");
  await client.query(
    `insert into ticket_feedback (tenant_id, ticket_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '30 days')`,
    [tenantId, ticketId, hashToken(token)],
  );
  const link = `${env.WEB_ORIGIN.replace(/\/$/, "")}/feedback?token=${encodeURIComponent(token)}`;
  await enqueueEmail(client, {
    tenantId,
    recipient: ticket.email,
    subject: `How did we do? Ticket #${ticket.number}`,
    body: `Hi ${ticket.display_name},\n\nYour request "${ticket.subject}" has been resolved. We would appreciate a quick rating:\n${link}\n\nThis link expires in 30 days.`,
  });
}
