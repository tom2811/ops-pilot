alter table categories
  add column default_priority_id uuid;

alter table categories
  add constraint categories_default_priority_fk
  foreign key (tenant_id, default_priority_id)
  references priorities (tenant_id, id)
  on delete set null;

update categories c
set default_priority_id = p.id
from priorities p
where p.tenant_id = c.tenant_id
  and p.key = 'p3'
  and c.default_priority_id is null;

update categories c
set default_priority_id = p.id
from (
  select distinct on (tenant_id) tenant_id, id
  from priorities
  where is_active
  order by tenant_id, rank desc
) p
where p.tenant_id = c.tenant_id
  and c.default_priority_id is null;
