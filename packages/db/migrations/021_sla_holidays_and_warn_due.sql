create table tenant_holidays (
  tenant_id uuid not null references tenants(id) on delete cascade,
  holiday_on date not null,
  name text not null check (length(name) between 1 and 120),
  primary key (tenant_id, holiday_on)
);

alter table tenant_holidays enable row level security;
alter table tenant_holidays force row level security;
create policy tenant_isolation on tenant_holidays for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table tickets
  add column sla_response_warn_due_at timestamptz,
  add column sla_resolution_warn_due_at timestamptz;

update tickets
set sla_response_warn_due_at = created_at + 0.8 * (sla_response_due_at - created_at)
where sla_response_due_at is not null
  and sla_response_warn_due_at is null;

update tickets
set sla_resolution_warn_due_at = created_at + 0.8 * (sla_resolution_due_at - created_at)
where sla_resolution_due_at is not null
  and sla_resolution_warn_due_at is null;
