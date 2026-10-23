import pg from "pg";

type Check = { name: string; value: unknown; meaning: string };

const url = process.env.AUDIT_DATABASE_URL ?? process.env.ADMIN_DATABASE_URL;
if (!url) throw new Error("AUDIT_DATABASE_URL or ADMIN_DATABASE_URL is required");

const client = new pg.Client({ connectionString: url });
await client.connect();

const checks: Check[] = [];
async function check(name: string, meaning: string, sql: string): Promise<void> {
  const result = await client.query<{ value: unknown }>(sql);
  checks.push({ name, meaning, value: result.rows[0]?.value ?? null });
}

try {
  await check("email_status_counts", "Email rows by terminal/queue state", `
    select coalesce(json_object_agg(delivery_status, count), '{}'::json) as value
    from (select delivery_status, count(*)::int as count from email_messages group by delivery_status) s`);
  await check("notification_status_counts", "Notification delivery vs legacy status", `
    select coalesce(json_agg(row_to_json(s)), '[]'::json) as value
    from (select delivery_status, status, count(*)::int as count from notifications group by delivery_status, status order by 1,2) s`);
  await check("email_sent_without_timestamp", "Invariant: sent implies sent_at", `
    select count(*)::int as value from email_messages where delivery_status = 'sent' and sent_at is null`);
  await check("email_pending_with_timestamp", "Invariant: pending has no sent_at", `
    select count(*)::int as value from email_messages where delivery_status = 'pending' and sent_at is not null`);
  await check("email_skipped_without_reason", "Invariant: skipped records why", `
    select count(*)::int as value from email_messages where delivery_status = 'skipped' and coalesce(last_error,'') = ''`);
  await check("notification_skipped_without_reason", "Invariant: skipped records why", `
    select count(*)::int as value from notifications where delivery_status = 'skipped' and coalesce(last_error,'') = ''`);
  await check("email_failed_below_attempt_cap", "Invariant: failed after five attempts or a permanent bounce", `
    select count(*)::int as value from email_messages
    where delivery_status = 'failed' and attempts < 5 and bounce_reason is null`);
  await check("notification_failed_below_attempt_cap", "Invariant: failed after five attempts or a permanent bounce", `
    select count(*)::int as value from notifications
    where delivery_status = 'failed' and attempts < 5 and bounce_reason is null`);
  await check("email_sent_without_provider_id", "Invariant: sent has SMTP message id", `
    select count(*)::int as value from email_messages where delivery_status = 'sent' and provider_message_id is null`);
  await check("notification_legacy_lie", "Legacy status differs from delivery status", `
    select count(*)::int as value from notifications where status::text <> delivery_status`);
  await check("notification_sent_without_timestamp", "Invariant: sent implies sent_at", `
    select count(*)::int as value from notifications where delivery_status = 'sent' and sent_at is null`);
  await check("cleartext_token_rows", "Email bodies containing a live token URL", `
    select count(*)::int as value from email_messages
    where body ~* '(token=|/invite/|/feedback\\?token=)'`);
  await check("terminal_email_body_redacted", "Terminal email bodies are redacted", `
    select count(*)::int as value from email_messages
    where delivery_status in ('sent', 'failed', 'skipped') and body <> '[body redacted]'`);
  await check("active_locks", "Rows leased by a live or dead worker", `
    select count(*)::int as value from email_messages where delivery_status = 'pending' and locked_until > now()`);
  await check("stale_locks", "Pending rows with expired leases (reclaimable)", `
    select count(*)::int as value from email_messages where delivery_status = 'pending' and locked_until < now()`);
  await check("duplicate_email_content", "Same recipient+subject+body sent more than once", `
    select coalesce(json_agg(row_to_json(s)), '[]'::json) as value from (
      select recipient, subject, count(*)::int as count
      from email_messages where delivery_status = 'sent'
      group by recipient, subject, md5(body) having count(*) > 1
    ) s`);
  await check("rls", "Row-level security flags", `
    select coalesce(json_object_agg(relname, json_build_object('enabled', relrowsecurity, 'forced', relforcerowsecurity)), '{}'::json) as value
    from pg_class where relname in ('email_messages','notifications')`);
} finally {
  await client.end();
}

const output = { generatedAt: new Date().toISOString(), checks };
console.log(JSON.stringify(output, null, 2));
if (process.argv.includes("--strict")) {
  const violations = checks.filter((entry) =>
    ["email_sent_without_timestamp", "email_pending_with_timestamp", "email_skipped_without_reason",
      "notification_skipped_without_reason",
      "email_failed_below_attempt_cap", "notification_failed_below_attempt_cap",
      "email_sent_without_provider_id", "notification_sent_without_timestamp",
      "cleartext_token_rows", "terminal_email_body_redacted", "duplicate_email_content",
      "notification_legacy_lie"].includes(entry.name) &&
      entry.value !== 0 && entry.value !== null && (!Array.isArray(entry.value) || entry.value.length > 0),
  );
  if (violations.length > 0) process.exitCode = 1;
}
