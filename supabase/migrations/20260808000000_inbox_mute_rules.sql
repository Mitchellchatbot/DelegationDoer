-- Workspace mute rules for inbox noise.
--
-- The problem: the category tabs (people / newsletters / receipts …) only
-- FILTER a view — they never take anything out of the default list, and the
-- notification writers don't consult them at all. So plugin/vendor mail still
-- fills "All inboxes" and still pings every opted-in user.
--
-- A mute rule is a pattern matched against a message's sender and subject. A
-- match means: no notification row is written, and the thread drops out of the
-- normal inbox lists. Nothing is deleted or hidden permanently — muted mail is
-- still readable under the Muted view, so this is a routing decision, not a
-- destructive one.
--
-- Rules are WORKSPACE-wide and managed by leaders/admins (same gate as inbox
-- assignments): plugin noise is noise for everyone, so muting it once should
-- fix it for the whole team rather than making each person repeat the work.
--
-- match_type semantics — `value` is always stored lower-cased and compared
-- against a lower-cased subject/sender:
--   sender_exact     value = "noreply@elementor.com"  → sender address equals it
--   sender_domain    value = "mailchimp.com"          → sender's domain equals it
--   sender_local     value = "wordpress"              → sender's local-part equals it,
--                                                       ANY domain. This is the one
--                                                       that catches WordPress/plugin
--                                                       mail, which arrives as
--                                                       wordpress@<each client's domain>
--                                                       and so can't be pinned to a
--                                                       single domain.
--   subject_contains value = "plugin activated"       → subject contains it
create table if not exists public.inbox_mute_rules (
  id text primary key,
  match_type text not null check (
    match_type in ('sender_exact', 'sender_domain', 'sender_local', 'subject_contains')
  ),
  value text not null,
  -- Free-text "why" so a rule someone added six months ago is still
  -- explicable to whoever finds it muting something they wanted.
  note text,
  enabled boolean not null default true,
  created_by text references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- One rule per (type, value); re-muting the same sender is a no-op rather
  -- than a duplicate row.
  unique (match_type, value)
);

-- The hot path loads every enabled rule (the set is small — tens, not
-- thousands) and compiles it once per request.
create index if not exists inbox_mute_rules_enabled_idx
  on public.inbox_mute_rules (enabled)
  where enabled;

alter table public.inbox_mute_rules enable row level security;
