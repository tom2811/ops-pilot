import type pg from "pg";

export async function enqueueEmail(
  client: pg.Pool | pg.PoolClient,
  input: {
    tenantId: string | null;
    recipient: string;
    subject: string;
    body: string;
  },
): Promise<void> {
  await client.query(
    `insert into email_messages (tenant_id, recipient, subject, body)
     values ($1, $2, $3, $4)`,
    [input.tenantId, input.recipient, input.subject, input.body],
  );
}
