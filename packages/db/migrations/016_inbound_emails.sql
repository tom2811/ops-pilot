create table if not exists inbound_emails (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid primary key default gen_random_uuid(),
  message_id text not null,
  from_address text not null,
  to_address text not null default '',
  subject text not null,
  body text not null,
  in_reply_to text,
  ticket_id uuid,
  comment_id uuid,
  action text not null check (action in ('ticket_created', 'comment_added', 'ignored')),
  created_at timestamptz not null default now(),
  unique (tenant_id, message_id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete set null,
  foreign key (tenant_id, comment_id) references ticket_comments (tenant_id, id) on delete set null
);

create index if not exists idx_inbound_emails_tenant on inbound_emails(tenant_id);
create index if not exists idx_inbound_emails_ticket on inbound_emails(tenant_id, ticket_id);

alter table inbound_emails enable row level security;
alter table inbound_emails force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'inbound_emails' and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on inbound_emails for all
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  end if;
end
$$;
