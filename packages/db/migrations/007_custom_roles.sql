create table custom_roles (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name citext not null,
  base_role user_role not null,
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

alter table custom_roles enable row level security;
alter table custom_roles force row level security;
create policy tenant_isolation on custom_roles for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table memberships add column custom_role_id uuid;
alter table memberships
  add constraint memberships_custom_role_fk
  foreign key (tenant_id, custom_role_id) references custom_roles (tenant_id, id) on delete set null;
