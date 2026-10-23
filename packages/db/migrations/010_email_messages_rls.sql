update email_messages
set body = '[body redacted]'
where delivery_status in ('sent', 'failed', 'skipped');

alter table email_messages enable row level security;
alter table email_messages force row level security;
create policy tenant_isolation on email_messages for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
