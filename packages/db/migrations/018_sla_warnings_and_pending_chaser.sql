-- Migration 018: SLA Escalation Warnings & Pending Inactivity Chaser

alter table tickets
  add column if not exists sla_response_warning_at timestamptz,
  add column if not exists sla_resolution_warning_at timestamptz,
  add column if not exists pending_chaser_sent_at timestamptz;

create index if not exists idx_tickets_sla_response_warning on tickets (tenant_id, sla_response_due_at)
  where sla_response_warning_at is null
    and sla_response_breached_at is null
    and first_responded_at is null
    and sla_paused_at is null;

create index if not exists idx_tickets_sla_resolution_warning on tickets (tenant_id, sla_resolution_due_at)
  where sla_resolution_warning_at is null
    and sla_resolution_breached_at is null
    and resolved_at is null
    and sla_paused_at is null;

create index if not exists idx_tickets_pending_chaser on tickets (tenant_id, sla_paused_at)
  where pending_chaser_sent_at is null
    and sla_paused_at is not null;

-- Default notification templates for warnings and pending chaser
insert into notification_templates (tenant_id, key, subject, body)
select
  id as tenant_id,
  'sla_warning',
  'SLA warning: Ticket #{{number}} approaching breach threshold',
  'Ticket #{{number}} ("{{subject}}") has reached 80% of its {{kind}} SLA limit. Please take action before the SLA breaches at {{dueAt}}.'
from tenants
on conflict (tenant_id, key) do nothing;

insert into notification_templates (tenant_id, key, subject, body)
select
  id as tenant_id,
  'pending_chaser',
  'Reminder: Waiting for your reply on ticket #{{number}}',
  'Hello {{requesterName}},\n\nYour ticket #{{number}} ("{{subject}}") is currently waiting on your input. If no reply is received, the ticket will be automatically resolved.\n\nPlease reply directly to this email to provide an update.'
from tenants
on conflict (tenant_id, key) do nothing;
