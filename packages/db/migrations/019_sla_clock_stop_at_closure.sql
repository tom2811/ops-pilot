-- Migration 019: Stop SLA clocks at resolution, closure, or merge
--
-- Older workers stamped SLA breaches whenever the maintenance cycle noticed
-- them, even if the ticket had already been resolved, closed, or merged.
-- Clear breaches that could only have happened after the clock stopped, and
-- clamp late stamps to the moment the ticket actually stopped.

-- Response SLA: the clock stops at the first response, resolution, or closure.
update tickets
set sla_response_breached_at = null
where sla_response_breached_at is not null
  and sla_response_due_at is not null
  and coalesce(first_responded_at, resolved_at, closed_at) is not null
  and sla_response_due_at >= coalesce(first_responded_at, resolved_at, closed_at);

update tickets
set sla_response_breached_at = coalesce(first_responded_at, resolved_at, closed_at)
where sla_response_breached_at is not null
  and coalesce(first_responded_at, resolved_at, closed_at) is not null
  and sla_response_breached_at > coalesce(first_responded_at, resolved_at, closed_at);

-- Resolution SLA: the clock stops at resolution, closure, or merge.
update tickets
set sla_resolution_breached_at = null
where sla_resolution_breached_at is not null
  and sla_resolution_due_at is not null
  and coalesce(resolved_at, closed_at) is not null
  and sla_resolution_due_at >= coalesce(resolved_at, closed_at);

update tickets
set sla_resolution_breached_at = coalesce(resolved_at, closed_at)
where sla_resolution_breached_at is not null
  and coalesce(resolved_at, closed_at) is not null
  and sla_resolution_breached_at > coalesce(resolved_at, closed_at);
