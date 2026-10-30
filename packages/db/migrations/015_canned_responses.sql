create table if not exists canned_responses (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid primary key default gen_random_uuid(),
  title text not null,
  shortcut text not null,
  body text not null,
  created_by uuid references users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, shortcut)
);

create index if not exists idx_canned_responses_tenant on canned_responses(tenant_id) where is_active;

alter table canned_responses enable row level security;
alter table canned_responses force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'canned_responses' and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on canned_responses for all
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  end if;
end
$$;
