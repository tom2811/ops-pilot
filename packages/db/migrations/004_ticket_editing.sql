alter table tickets add column deleted_at timestamptz;
create index tickets_active_idx on tickets (tenant_id, created_at) where deleted_at is null;
