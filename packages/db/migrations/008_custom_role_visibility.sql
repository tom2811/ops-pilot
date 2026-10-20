drop policy tenant_isolation on custom_roles;
create policy tenant_isolation on custom_roles for all
using (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  or exists (
    select 1 from memberships m
    where m.tenant_id = custom_roles.tenant_id
      and m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
)
with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
