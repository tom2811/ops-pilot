alter table tenant_settings
  add column if not exists business_hours_start time not null default '09:00',
  add column if not exists business_hours_end time not null default '17:00',
  add column if not exists business_days integer[] not null default '{1,2,3,4,5}';

alter table sla_policies
  add column if not exists business_hours_only boolean not null default false;
