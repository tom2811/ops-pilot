alter table notifications
  add column delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'skipped', 'failed')),
  add column attempts integer not null default 0 check (attempts >= 0),
  add column next_attempt_at timestamptz not null default now(),
  add column last_error text,
  add column provider_message_id text,
  add column locked_until timestamptz;

update notifications
set delivery_status = case when sent_at is not null then 'sent' else 'pending' end;

create index notifications_pending_idx on notifications (next_attempt_at)
where delivery_status = 'pending';

create table notification_templates (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  key citext not null,
  subject text not null,
  body text not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, key)
);

alter table notification_templates enable row level security;
alter table notification_templates force row level security;
create policy tenant_isolation on notification_templates for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
