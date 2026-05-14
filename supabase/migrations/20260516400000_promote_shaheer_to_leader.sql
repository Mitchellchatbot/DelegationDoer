-- One-shot: promote shaheerkhosa6@gmail.com to leader. The rescue
-- migration re-created their row as a default worker; this puts
-- them back where they were before the purge.
update public.users
   set role = 'leader'
 where lower(email) = 'shaheerkhosa6@gmail.com';
