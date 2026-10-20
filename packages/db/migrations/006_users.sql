alter table sessions
  add column user_agent text,
  add column ip text;

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  recipient citext not null,
  subject text not null,
  body text not null,
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_message_id text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index email_messages_pending_idx on email_messages (next_attempt_at)
where delivery_status = 'pending';

create table user_invitations (
  tenant_id uuid not null references tenants(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  email citext not null,
  role user_role not null,
  team_ids jsonb not null default '[]'::jsonb,
  token_hash text not null unique,
  invited_by uuid not null references users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, id)
);

create index user_invitations_pending_idx on user_invitations (tenant_id, email)
where accepted_at is null and revoked_at is null;

alter table user_invitations enable row level security;
alter table user_invitations force row level security;
create policy tenant_isolation on user_invitations for all
using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index password_reset_tokens_user_idx on password_reset_tokens (user_id);
