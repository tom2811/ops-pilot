alter table memberships
  add column manager_user_id uuid;

alter table memberships
  add constraint memberships_manager_fk
  foreign key (tenant_id, manager_user_id)
  references memberships (tenant_id, user_id)
  on delete set null;

alter table teams
  add column lead_user_id uuid;

alter table teams
  add constraint teams_lead_fk
  foreign key (tenant_id, lead_user_id)
  references memberships (tenant_id, user_id)
  on delete set null;

create table escalation_policies (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null,
  sla_kind text not null check (sla_kind in ('response', 'resolution')),
  threshold_percent integer not null check (threshold_percent between 1 and 100),
  target_type text not null check (target_type in ('manager', 'team_lead', 'team')),
  target_team_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, target_team_id) references teams (tenant_id, id) on delete restrict,
  check (
    (target_type = 'team' and target_team_id is not null)
    or (target_type <> 'team' and target_team_id is null)
  )
);

create table ticket_escalations (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  ticket_id uuid not null,
  policy_id uuid not null,
  threshold_percent integer not null,
  event_id uuid references outbox_events (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (ticket_id, policy_id, threshold_percent),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, policy_id) references escalation_policies (tenant_id, id) on delete restrict
);

alter table escalation_policies enable row level security;
alter table escalation_policies force row level security;
create policy tenant_isolation on escalation_policies for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table ticket_escalations enable row level security;
alter table ticket_escalations force row level security;
create policy tenant_isolation on ticket_escalations for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

insert into notification_templates (tenant_id, key, subject, body)
select
  id as tenant_id,
  'sla_escalated',
  'SLA escalation: Ticket #{{number}}',
  'Ticket #{{number}} ("{{subject}}") has reached {{threshold}}% of its {{kind}} SLA and was escalated.'
from tenants
on conflict (tenant_id, key) do nothing;
