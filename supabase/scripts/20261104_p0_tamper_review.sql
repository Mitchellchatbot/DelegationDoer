-- READ-ONLY. Run after 20261104000000_p0_lock_down_anon_access.sql.
--
-- Until that migration, tables without RLS were writable by anyone holding the
-- browser anon key. This grid lists the rows in the tables where a forged row
-- could have done real harm, for a person to eyeball. Nothing here proves
-- tampering — look for rows nobody remembers creating:
--
--   scheduled_emails  — the runner SENDS pending rows from the named mailbox.
--                       Check recipients/subjects against what people really
--                       scheduled (last 120 days).
--   brain_memories    — injected "memories" steer the owner's AI brief and
--                       chat. Read every active one.
--   daily_briefings   — the check-in "Send" button posts messages[].text AS
--                       MITCHELL; compare recent rows with the DMs he got.
--   email_drafts      — pending drafts can be approved (= sent) by leaders.
--
-- One result grid, newest first.

select 'scheduled_emails' as source,
       e.created_at        as at,
       e.status            as state,
       coalesce(u.name, e.user_id) as who,
       left(array_to_string(e.to_emails, ', ') || ' — ' || coalesce(e.subject, '(no subject)'), 300) as summary
from public.scheduled_emails e
left join public.users u on u.id = e.user_id
where e.created_at > now() - interval '120 days'

union all
select 'brain_memories', m.created_at, case when m.active then 'active' else 'inactive' end,
       coalesce(m.created_by, '(none)'), left(m.category || ': ' || m.content, 300)
from public.brain_memories m

union all
select 'daily_briefings', b.created_at,
       case when b.delivered_at is null then 'undelivered' else 'delivered' end,
       b.brief_date,
       left('messages=' || jsonb_array_length(coalesce(b.messages, '[]'::jsonb))::text || ' — ' || coalesce(b.needle_mover, ''), 300)
from public.daily_briefings b
where b.created_at > now() - interval '45 days'

union all
select 'email_drafts', d.created_at, d.status, coalesce(u.name, d.author_id),
       left(d.client_name || ' — ' || array_to_string(d.to_emails, ', ') || ' — ' || d.subject, 300)
from public.email_drafts d
left join public.users u on u.id = d.author_id
where d.status in ('pending', 'needs_revision')

order by at desc;
