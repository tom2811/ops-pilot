create extension if not exists pgcrypto;
create extension if not exists citext;

create type tenant_status as enum ('active', 'suspended');
create type user_role as enum ('tenant_admin', 'agent', 'employee');
create type ticket_stage as enum ('new', 'open', 'in_progress', 'pending', 'resolved', 'closed');
create type comment_visibility as enum ('public', 'internal');
create type outbox_status as enum ('pending', 'sending', 'delivered', 'dead');
create type automation_run_status as enum ('in_progress', 'completed', 'failed');
create type notification_status as enum ('sent', 'skipped', 'failed');

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug citext not null unique,
  name text not null,
  status tenant_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tenant_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  timezone text not null default 'UTC',
  ticket_prefix text not null default 'OPS',
  reopen_window_days integer not null default 14 check (reopen_window_days >= 0),
  auto_close_days integer not null default 7 check (auto_close_days >= 0),
  branding jsonb not null default '{}'::jsonb,
  config_version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table platform_admins (
  user_id uuid primary key references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table memberships (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role user_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index memberships_user_idx on memberships (user_id);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index sessions_user_idx on sessions (user_id);

create table teams (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  slug citext not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, slug)
);

create table team_members (
  tenant_id uuid not null,
  team_id uuid not null,
  user_id uuid not null,
  primary key (tenant_id, team_id, user_id),
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id) references memberships (tenant_id, user_id) on delete cascade
);

create table categories (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  parent_id uuid,
  slug citext not null,
  name text not null,
  default_team_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, slug),
  foreign key (tenant_id, parent_id) references categories (tenant_id, id) on delete restrict,
  foreign key (tenant_id, default_team_id) references teams (tenant_id, id) on delete set null
);

create table priorities (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  key citext not null,
  label text not null,
  rank integer not null,
  color text not null default 'gray',
  is_active boolean not null default true,
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, key),
  unique (tenant_id, rank)
);

create table ticket_statuses (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  key citext not null,
  label text not null,
  stage ticket_stage not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create table ticket_transition_rules (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  from_status_id uuid not null,
  to_status_id uuid not null,
  actor_role user_role not null,
  requires_assignee boolean not null default false,
  requires_summary boolean not null default false,
  requires_reason boolean not null default false,
  is_active boolean not null default true,
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, from_status_id, to_status_id, actor_role),
  foreign key (tenant_id, from_status_id) references ticket_statuses (tenant_id, id) on delete cascade,
  foreign key (tenant_id, to_status_id) references ticket_statuses (tenant_id, id) on delete cascade
);

create table custom_field_definitions (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  key citext not null,
  label text not null,
  type text not null check (type in ('text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox')),
  required boolean not null default false,
  visibility text not null default 'internal' check (visibility in ('public', 'internal')),
  options jsonb not null default '[]'::jsonb,
  applies_to_category_id uuid,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, key),
  foreign key (tenant_id, applies_to_category_id) references categories (tenant_id, id) on delete set null
);

create table routing_rules (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null,
  conditions jsonb not null,
  team_id uuid not null,
  sort_order integer not null default 0,
  version integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, name, version),
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete restrict
);

create table ticket_counters (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  next_number bigint not null default 1 check (next_number > 0)
);

create table tickets (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  number bigint not null,
  subject text not null check (length(subject) between 1 and 200),
  description text not null check (length(description) between 1 and 20000),
  requester_id uuid not null,
  assignee_id uuid,
  team_id uuid,
  category_id uuid not null,
  priority_id uuid not null,
  status_id uuid not null,
  custom_fields jsonb not null default '{}'::jsonb,
  resolution_summary text,
  pending_reason text,
  version integer not null default 0 check (version >= 0),
  reopened_count integer not null default 0 check (reopened_count >= 0),
  first_responded_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, requester_id) references memberships (tenant_id, user_id) on delete restrict,
  foreign key (tenant_id, assignee_id) references memberships (tenant_id, user_id) on delete restrict,
  foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete restrict,
  foreign key (tenant_id, category_id) references categories (tenant_id, id) on delete restrict,
  foreign key (tenant_id, priority_id) references priorities (tenant_id, id) on delete restrict,
  foreign key (tenant_id, status_id) references ticket_statuses (tenant_id, id) on delete restrict
);

create index tickets_queue_idx on tickets (tenant_id, status_id, priority_id, created_at);
create index tickets_assignee_idx on tickets (tenant_id, assignee_id, status_id);
create index tickets_team_idx on tickets (tenant_id, team_id, status_id);
create index tickets_requester_idx on tickets (tenant_id, requester_id, created_at desc);
create index tickets_search_idx on tickets using gin (to_tsvector('simple', subject || ' ' || description));

create table ticket_comments (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  ticket_id uuid not null,
  author_id uuid not null,
  body text not null check (length(body) between 1 and 20000),
  visibility comment_visibility not null default 'public',
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, author_id) references memberships (tenant_id, user_id) on delete restrict
);

create index ticket_comments_ticket_idx on ticket_comments (tenant_id, ticket_id, created_at);

create table ticket_status_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  ticket_id uuid not null,
  from_status_id uuid,
  to_status_id uuid not null,
  actor_id uuid,
  actor_role text not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, from_status_id) references ticket_statuses (tenant_id, id) on delete restrict,
  foreign key (tenant_id, to_status_id) references ticket_statuses (tenant_id, id) on delete restrict
);

create index ticket_status_history_ticket_idx on ticket_status_history (tenant_id, ticket_id, created_at);

create table ticket_assignment_history (
  tenant_id uuid not null,
  id uuid not null default gen_random_uuid(),
  ticket_id uuid not null,
  from_assignee_id uuid,
  to_assignee_id uuid,
  from_team_id uuid,
  to_team_id uuid,
  actor_id uuid,
  actor_role text not null,
  source text not null default 'manual' check (source in ('manual', 'automation')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade
);

create index ticket_assignment_history_ticket_idx on ticket_assignment_history (tenant_id, ticket_id, created_at);

create table audit_log (
  tenant_id uuid,
  id bigserial primary key,
  actor_id uuid,
  actor_role text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  before jsonb,
  after jsonb,
  correlation_id uuid not null,
  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (tenant_id, entity_type, entity_id, created_at);
create index audit_log_created_idx on audit_log (created_at);

create table outbox_events (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  aggregate_version integer not null,
  event_type text not null,
  payload jsonb not null,
  status outbox_status not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  primary key (id),
  unique (tenant_id, id),
  unique (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type)
);

create index outbox_pending_idx on outbox_events (available_at) where status = 'pending';
create index outbox_sending_idx on outbox_events (locked_until) where status = 'sending';

create table automation_runs (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  event_id uuid not null references outbox_events(id) on delete cascade,
  run_token_hash text not null,
  status automation_run_status not null default 'in_progress',
  lease_expires_at timestamptz not null,
  completed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, event_id)
);

create index automation_runs_token_idx on automation_runs (run_token_hash);

create table command_receipts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  command text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);

create table notifications (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  event_id uuid not null references outbox_events(id) on delete cascade,
  ticket_id uuid not null,
  recipient_id uuid not null,
  channel text not null default 'email',
  dedupe_key text not null,
  status notification_status not null default 'sent',
  subject text not null,
  body text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, dedupe_key),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, recipient_id) references memberships (tenant_id, user_id) on delete restrict
);

create index notifications_ticket_idx on notifications (tenant_id, ticket_id, created_at);

alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenants_visible_to_members on tenants for all
using (
  id = nullif(current_setting('app.tenant_id', true), '')::uuid
  or exists (
    select 1 from memberships m
    where m.tenant_id = tenants.id
      and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
)
with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table memberships enable row level security;
alter table memberships force row level security;
create policy memberships_self_or_tenant on memberships for all
using (
  user_id = nullif(current_setting('app.user_id', true), '')::uuid
  or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
)
with check (
  user_id = nullif(current_setting('app.user_id', true), '')::uuid
  or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenant_settings', 'teams', 'team_members', 'categories', 'priorities',
    'ticket_statuses', 'ticket_transition_rules', 'custom_field_definitions',
    'routing_rules', 'ticket_counters', 'tickets', 'ticket_comments',
    'ticket_status_history', 'ticket_assignment_history', 'audit_log',
    'outbox_events', 'automation_runs', 'command_receipts', 'notifications'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy tenant_isolation on %I for all using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  end loop;
end $$;

create policy automation_run_token_lookup on automation_runs for select
using (run_token_hash = nullif(current_setting('app.run_token_hash', true), ''));
