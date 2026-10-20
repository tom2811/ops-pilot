create table sla_policies (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null,
  priority_id uuid,
  category_id uuid,
  response_minutes integer not null check (response_minutes > 0),
  resolution_minutes integer not null check (resolution_minutes > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, priority_id) references priorities (tenant_id, id) on delete restrict,
  foreign key (tenant_id, category_id) references categories (tenant_id, id) on delete restrict
);

alter table sla_policies enable row level security;
alter table sla_policies force row level security;
create policy tenant_isolation on sla_policies for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table tickets
  add column sla_policy_id uuid,
  add column sla_response_due_at timestamptz,
  add column sla_resolution_due_at timestamptz,
  add column sla_response_breached_at timestamptz,
  add column sla_resolution_breached_at timestamptz,
  add column sla_paused_at timestamptz,
  add foreign key (tenant_id, sla_policy_id) references sla_policies (tenant_id, id) on delete restrict;

create index tickets_sla_response_due_idx on tickets (tenant_id, sla_response_due_at)
where sla_response_breached_at is null and sla_response_due_at is not null;

create index tickets_sla_resolution_due_idx on tickets (tenant_id, sla_resolution_due_at)
where sla_resolution_breached_at is null and sla_resolution_due_at is not null;
