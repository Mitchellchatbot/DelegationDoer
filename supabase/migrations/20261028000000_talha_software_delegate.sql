-- Grant: Talha Ali (james@scaledai.org) may create tasks in, and assign tasks
-- to members of, the Software department (dep_software). He stays head of
-- Marketing; this only adds the department-scoped delegate power described in
-- 20260805000000_department_delegate.sql. Idempotent + email-keyed; aborts
-- loudly if the account can't be resolved.
do $$
declare
  v_user_id text;
begin
  select id into v_user_id
    from public.users
   where email ilike 'james@scaledai.org'
   limit 1;
  if v_user_id is null then
    raise exception 'No user with email james@scaledai.org found in public.users — confirm the account';
  end if;

  update public.users
     set delegate_department_ids = array(
           select distinct unnest(delegate_department_ids || array['dep_software'])
         )
   where id = v_user_id;
end $$;
