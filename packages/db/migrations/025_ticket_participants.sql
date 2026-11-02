create table if not exists ticket_participants (
  tenant_id uuid not null references tenants(id) on delete cascade,
  ticket_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, ticket_id, user_id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references memberships (tenant_id, user_id) on delete cascade
);

create index if not exists idx_ticket_participants_user on ticket_participants(tenant_id, user_id);

alter table ticket_participants enable row level security;
alter table ticket_participants force row level security;

create policy tenant_isolation on ticket_participants for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

insert into notification_templates (tenant_id, key, subject, body)
select
  id,
  'ticket_merged',
  'Ticket #{{secondaryNumber}} was merged into #{{number}}',
  'Your ticket #{{secondaryNumber}} ("{{secondarySubject}}") was merged into #{{number}} ("{{subject}}"). Follow the conversation on the surviving ticket.'
from tenants
on conflict (tenant_id, key) do nothing;
