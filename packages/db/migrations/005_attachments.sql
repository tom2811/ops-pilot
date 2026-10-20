create table ticket_attachments (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  ticket_id uuid not null,
  uploader_id uuid not null references users(id) on delete restrict,
  filename text not null check (length(filename) between 1 and 255),
  content_type text not null,
  size integer not null check (size between 0 and 10485760),
  storage_key text not null unique,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade
);

create index ticket_attachments_ticket_idx on ticket_attachments (tenant_id, ticket_id, created_at);

alter table ticket_attachments enable row level security;
alter table ticket_attachments force row level security;
create policy tenant_isolation on ticket_attachments for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
