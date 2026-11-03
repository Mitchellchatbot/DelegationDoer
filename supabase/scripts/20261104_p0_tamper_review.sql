-- READ-ONLY. Run after 20261104000000_p0_lock_down_anon_access.sql.
--
-- Until that migration, the 59 public tables without RLS were readable AND
-- writable by anyone holding the browser anon key (or any signed-in user's
-- JWT, from devtools). This grid lists the rows where a forged insert or a
-- quiet edit could do real harm, for a person to eyeball. Nothing here proves
-- tampering — look for rows nobody remembers creating or changing. Dates are
-- not trusted (an attacker could set created_at), so anything still able to
-- act (pending sends, active settings) is listed regardless of age.
--
--   scheduled_emails          the runner SENDS pending rows from account_id.
--                             Check recipients, cc, mailbox, schedule, body hash.
--   email_drafts              pending drafts are sent when a leader approves.
--   daily_briefings           the check-in "Send" button posts messages[].text
--                             AS MITCHELL — compare with the DMs he received.
--   brain_memories            injected "memories" steer the owner's AI brief/chat.
--   inbox_privacy             who owns / can see a private mailbox (e.g. the
--                             owner's). A changed owner_user_id or a deleted row
--                             changes who reads that mail.
--   routing_rules, workspace_settings, missive_account_settings
--                             routing, channel and per-mailbox intake settings.
--
-- Row review cannot show past UPDATEs/DELETEs that were later reverted. Also
-- pull Supabase API logs NOW, while they are retained (Dashboard → Logs →
-- API / edge logs): any non-GET request to /rest/v1/* made with the anon key
-- or a user JWT (not service_role) is someone writing through the hole.
--
-- One result grid, grouped by source.

select source, at, state, who, summary
from (
  select 1 as ord, 'scheduled_emails' as source, e.created_at as at, e.status as state,
         coalesce(u.name, e.user_id) as who,
         left(
           'to=' || array_to_string(e.to_emails, ',') ||
           ' cc=' || array_to_string(e.cc_emails, ',') ||
           ' account=' || e.account_id ||
           ' scheduled_for=' || e.scheduled_for::text ||
           ' in_reply_to=' || coalesce(e.in_reply_to, '-') ||
           ' subject=' || coalesce(e.subject, '(none)') ||
           ' body_md5=' || md5(e.body_text), 600) as summary
  from public.scheduled_emails e
  left join public.users u on u.id = e.user_id
  where e.status = 'pending' or e.created_at > now() - interval '120 days'

  union all
  select 2, 'email_drafts', d.created_at, d.status, coalesce(u.name, d.author_id),
         left(
           d.client_name ||
           ' to=' || array_to_string(d.to_emails, ',') ||
           ' cc=' || array_to_string(d.cc_emails, ',') ||
           ' bcc=' || array_to_string(d.bcc_emails, ',') ||
           ' account=' || coalesce(d.account_id, '-') ||
           ' subject=' || d.subject ||
           ' body_md5=' || md5(d.body_text), 600)
  from public.email_drafts d
  left join public.users u on u.id = d.author_id
  where d.status not in ('sent', 'rejected', 'failed') or d.created_at > now() - interval '30 days'

  union all
  select 3, 'daily_briefings', b.created_at,
         case when b.delivered_at is null then 'undelivered' else 'delivered' end,
         b.brief_date,
         left('messages=' || b.messages::text, 1500)
  from public.daily_briefings b
  where b.created_at > now() - interval '45 days'
     or exists (select 1 from jsonb_array_elements(coalesce(b.messages, '[]'::jsonb)) m
                where m ->> 'status' is distinct from 'sent')

  union all
  select 4, 'brain_memories', m.created_at, case when m.active then 'active' else 'inactive' end,
         coalesce(m.created_by, '(none)'), left(m.category || ': ' || m.content, 600)
  from public.brain_memories m

  union all
  select 5, 'inbox_privacy', null::timestamptz, 'current', null, left(to_jsonb(p)::text, 600)
  from public.inbox_privacy p

  union all
  select 6, 'routing_rules', null::timestamptz, 'current', null, left(to_jsonb(r)::text, 600)
  from public.routing_rules r

  union all
  select 7, 'workspace_settings', null::timestamptz, 'current', null, left(to_jsonb(w)::text, 600)
  from public.workspace_settings w

  union all
  select 8, 'missive_account_settings', null::timestamptz, 'current', null, left(to_jsonb(s)::text, 600)
  from public.missive_account_settings s
) x
order by ord, at desc nulls last;
