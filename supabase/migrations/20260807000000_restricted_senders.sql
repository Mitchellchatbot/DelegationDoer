-- Restricted senders — sender-scoped mail privacy.
--
-- inbox_privacy hides a WHOLE mailbox. This hides individual CONVERSATIONS
-- inside an otherwise-shared mailbox, keyed on who is corresponding.
--
-- Motivating case: Deel (the payroll/contractor platform) mail lands in
-- mitchell@scaledai.org. That inbox IS marked private, but it also sits in
-- the "Boss's mail" inbox_space, and space membership deliberately bypasses
-- inbox_privacy (see spaceGrantedAccountIds in src/lib/inbox-access.ts) — so
-- seven people currently read every payslip, invoice summary, compensation
-- change, contract termination and I-9 notice. Those seven are in the space
-- on purpose, so unsharing the mailbox is the wrong fix; the mail itself
-- needs to be restricted.
--
-- Model mirrors inbox_privacy: PRESENCE OF A ROW = RESTRICTED. A thread
-- matching an enabled rule is invisible to everyone EXCEPT the users listed
-- in restricted_sender_viewers for that rule. Role is irrelevant — leaders
-- and stealth admins are excluded too, exactly like a private inbox.
--
-- The Deel rules seeded below have NO viewers, which is deliberate and is the
-- strongest form of the rule: Deel mail is hidden from EVERY DelegationDoer
-- user, the mailbox owner included. It keeps arriving in Microsoft 365 and is
-- read there — DD simply stops surfacing it. (DD has no delete-thread API
-- against the clone, so it could not remove the mail itself even if asked.)
-- The viewers table still exists for future rules that should keep a named
-- person's access; leave it empty to hide a sender from everyone.
--
-- Matching is CORRESPONDENT-wide, not just "the sender": a thread matches if
-- ANY participant / last_from (list shape) or ANY message from/to/cc (detail
-- shape) matches. Matching only the newest sender would leak a Deel thread
-- whose latest message is our own outbound reply — one of the 97 known
-- threads is exactly that.
--
-- match_kind:
--   'domain' — the address's domain equals `pattern`, OR ends with
--              '.' || pattern. So 'deel.com' also covers hello.deel.com and
--              any future subdomain. Two rows cover all seven observed Deel
--              senders. Never a substring test: "contains deel.com" would
--              also match deel.com.evil.tld.
--   'exact'  — full address equality (escape hatch for one-off addresses).
--
-- Enforced in src/lib/restricted-senders.ts, applied at every inbox read
-- surface plus the notification fan-out and the intake pipeline. Best-effort
-- at the lib layer: if these tables are missing (code deployed ahead of the
-- migration) the loader returns [] and nothing is restricted, matching
-- getPrivateInboxOwners' behaviour in src/lib/inbox-access.ts.

create table if not exists public.restricted_senders (
  id          text primary key,
  -- Lower-cased domain or full address. Stored as given; compared lower.
  pattern     text not null,
  match_kind  text not null default 'domain'
              check (match_kind in ('domain', 'exact')),
  -- Human label, surfaced in intake audit rows and any future manage UI.
  label       text not null,
  -- Soft-disable, so a leader can lift a restriction without losing the
  -- viewer list to a delete-cascade.
  enabled     boolean not null default true,
  created_by  text references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One rule per (pattern, kind) — makes an "add rule" action idempotent.
create unique index if not exists restricted_senders_pattern_idx
  on public.restricted_senders (lower(pattern), match_kind);

-- Who may still read mail matching a rule. A rule with NO viewers hides the
-- mail from everyone, owner included — that is a legitimate configuration
-- (it's what the Deel rules use), so it is NOT a state to guard against.
create table if not exists public.restricted_sender_viewers (
  rule_id    text not null references public.restricted_senders(id) on delete cascade,
  user_id    text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (rule_id, user_id)
);

create index if not exists restricted_sender_viewers_user_idx
  on public.restricted_sender_viewers (user_id);

alter table public.restricted_senders        enable row level security;
alter table public.restricted_sender_viewers enable row level security;

-- Seed: Deel, hidden from EVERY DD user (no viewer rows — see the header).
-- Two domain rules cover all seven senders observed in production
-- (no-reply@ and its-payday@deel.support; payments@, support@, customer-ops-amr@
-- and jonathan.tambe@deel.com; deelteam@hello.deel.com via the subdomain rule).
--
-- created_by is provenance only and does NOT grant access. Resolved from the
-- requesting leader; falls back to null rather than aborting, since a missing
-- user must not stop the restriction itself from landing.
do $$
declare
  v_mitchell text;
begin
  select id into v_mitchell
    from public.users
   where email ilike 'mitchell@scaledai.org'
   limit 1;

  insert into public.restricted_senders (id, pattern, match_kind, label, created_by)
  values
    ('rs_deel_com',     'deel.com',     'domain', 'Deel (payroll/contractor platform)', v_mitchell),
    ('rs_deel_support', 'deel.support', 'domain', 'Deel notifications (deel.support)',  v_mitchell)
  on conflict (id) do nothing;
end $$;
