-- Migration 020: Repair merge status history
--
-- Merged tickets previously recorded 'Closed -> Closed' because the
-- ticket update ran before inserting the status history row.
-- Repair existing history rows where from_status_id equals to_status_id
-- and the reason indicates a ticket merge, setting from_status_id to the
-- ticket's prior status.

update ticket_status_history h
set from_status_id = prev.prior_status_id
from (
  select h2.id,
         (
           select p.to_status_id
           from ticket_status_history p
           where p.ticket_id = h2.ticket_id and p.created_at < h2.created_at
           order by p.created_at desc
           limit 1
         ) as prior_status_id
  from ticket_status_history h2
  where h2.from_status_id = h2.to_status_id and h2.reason like 'Merged into #%'
) prev
where h.id = prev.id and prev.prior_status_id is not null;
