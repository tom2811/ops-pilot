alter table ticket_statuses
  add column pauses_sla boolean not null default false;

update ticket_statuses
set pauses_sla = true
where stage = 'pending';

update ticket_statuses
set label = 'Waiting on customer'
where key = 'pending' and label = 'Pending';

insert into ticket_statuses (tenant_id, key, label, stage, sort_order, pauses_sla)
select t.id, 'waiting_on_vendor', 'Waiting on vendor', 'pending', 45, false
from tenants t
where not exists (
  select 1 from ticket_statuses s
  where s.tenant_id = t.id and s.key = 'waiting_on_vendor'
);

insert into ticket_transition_rules (
  tenant_id, from_status_id, to_status_id, actor_role, requires_assignee, requires_summary, requires_reason, is_active
)
select
  r.tenant_id,
  case when r.from_status_id = pending.id then vendor.id else r.from_status_id end,
  case when r.to_status_id = pending.id then vendor.id else r.to_status_id end,
  r.actor_role,
  r.requires_assignee,
  r.requires_summary,
  r.requires_reason,
  r.is_active
from ticket_transition_rules r
join ticket_statuses pending
  on pending.tenant_id = r.tenant_id and pending.key = 'pending'
join ticket_statuses vendor
  on vendor.tenant_id = r.tenant_id and vendor.key = 'waiting_on_vendor'
where r.from_status_id = pending.id or r.to_status_id = pending.id
on conflict (tenant_id, from_status_id, to_status_id, actor_role) do nothing;
