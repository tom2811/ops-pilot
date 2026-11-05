-- Security hardening: server-side CSRF tokens, login throttling, worker liveness.

-- CSRF tokens live on the session row so the browser never has to read a cookie
-- from the API origin (the web app and API are on different sites).
alter table sessions add column if not exists csrf_token text;
update sessions set csrf_token = replace(gen_random_uuid()::text, '-', '') where csrf_token is null;
alter table sessions alter column csrf_token set not null;
create index if not exists sessions_expires_idx on sessions (expires_at);

-- Per-account login throttling. Five failures lock the account for fifteen minutes.
alter table users add column if not exists failed_login_attempts integer not null default 0;
alter table users add column if not exists locked_until timestamptz;

-- Worker liveness so /api/metrics can expose staleness.
create table if not exists worker_heartbeat (
  id text primary key,
  last_seen_at timestamptz not null default now()
);
insert into worker_heartbeat (id) values ('default') on conflict (id) do nothing;
