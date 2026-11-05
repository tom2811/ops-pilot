with matched as (
  select
    t.tenant_id,
    t.id,
    p.id as policy_id,
    p.response_minutes,
    p.resolution_minutes
  from tickets t
  join lateral (
    select p.id, p.response_minutes, p.resolution_minutes
    from sla_policies p
    where p.tenant_id = t.tenant_id
      and p.is_active
      and not coalesce(p.business_hours_only, false)
      and (p.priority_id is null or p.priority_id = t.priority_id)
      and (p.category_id is null or p.category_id = t.category_id)
    order by (p.category_id is not null) desc, (p.priority_id is not null) desc, p.created_at
    limit 1
  ) p on true
  where t.sla_policy_id is null
)
update tickets t set
  sla_policy_id = m.policy_id,
  sla_response_due_at = t.created_at + (m.response_minutes::text || ' minutes')::interval,
  sla_resolution_due_at = t.created_at + (m.resolution_minutes::text || ' minutes')::interval,
  sla_response_warn_due_at =
    t.created_at + (greatest(1, round(m.response_minutes * 0.8))::int::text || ' minutes')::interval,
  sla_resolution_warn_due_at =
    t.created_at + (greatest(1, round(m.resolution_minutes * 0.8))::int::text || ' minutes')::interval
from matched m
where t.tenant_id = m.tenant_id and t.id = m.id;

update tickets set sla_response_warning_at = sla_response_warn_due_at
where sla_response_due_at is not null
  and sla_response_breached_at is null
  and sla_response_warning_at is null
  and sla_response_warn_due_at < coalesce(first_responded_at, resolved_at, closed_at, now());

update tickets set sla_resolution_warning_at = sla_resolution_warn_due_at
where sla_resolution_due_at is not null
  and sla_resolution_breached_at is null
  and sla_resolution_warning_at is null
  and sla_resolution_warn_due_at < coalesce(resolved_at, closed_at, now());

update tickets set sla_response_breached_at = sla_response_due_at
where sla_response_due_at is not null
  and sla_response_breached_at is null
  and sla_response_due_at < coalesce(first_responded_at, resolved_at, closed_at, now());

update tickets set sla_resolution_breached_at = sla_resolution_due_at
where sla_resolution_due_at is not null
  and sla_resolution_breached_at is null
  and sla_resolution_due_at < coalesce(resolved_at, closed_at, now());
