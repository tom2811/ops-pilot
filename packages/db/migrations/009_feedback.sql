create table ticket_feedback (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  ticket_id uuid not null,
  token_hash text not null unique,
  rating integer check (rating between 1 and 5),
  comment text,
  submitted_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, ticket_id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade
);

create index ticket_feedback_submitted_idx on ticket_feedback (tenant_id, submitted_at)
where submitted_at is not null;

alter table ticket_feedback enable row level security;
alter table ticket_feedback force row level security;
create policy tenant_isolation on ticket_feedback for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
