alter table tickets add column if not exists merged_into_ticket_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tickets_merged_into_fkey'
  ) then
    alter table tickets
      add constraint tickets_merged_into_fkey
      foreign key (tenant_id, merged_into_ticket_id)
      references tickets (tenant_id, id)
      on delete set null;
  end if;
end
$$;

create index if not exists idx_tickets_merged_into on tickets (tenant_id, merged_into_ticket_id)
  where merged_into_ticket_id is not null;

create table if not exists ticket_links (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid primary key default gen_random_uuid(),
  source_ticket_id uuid not null,
  target_ticket_id uuid not null,
  link_type text not null check (link_type in (
    'relates_to',
    'duplicates',
    'duplicated_by',
    'blocks',
    'blocked_by',
    'causes',
    'caused_by',
    'merged_into',
    'merged_from'
  )),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, source_ticket_id, target_ticket_id, link_type),
  check (source_ticket_id <> target_ticket_id),
  foreign key (tenant_id, source_ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_ticket_id) references tickets (tenant_id, id) on delete cascade
);

create index if not exists idx_ticket_links_source on ticket_links (tenant_id, source_ticket_id);
create index if not exists idx_ticket_links_target on ticket_links (tenant_id, target_ticket_id);

alter table ticket_links enable row level security;
alter table ticket_links force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'ticket_links' and policyname = 'tenant_isolation'
  ) then
    create policy tenant_isolation on ticket_links for all
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
  end if;
end
$$;
