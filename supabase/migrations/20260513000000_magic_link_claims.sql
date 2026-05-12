-- magic_link_claims: dodges Slack/Outlook safe-link scanners that
-- pre-fetch any URL pasted into a message and accidentally consume
-- single-use Supabase magic links.
--
-- Flow:
--   1. Leader clicks "Magic link" → we insert a claim and return
--      /signin/<claim_id> instead of the Supabase verify URL.
--   2. That URL is safe to paste anywhere — its GET handler renders
--      a button.
--   3. Only when the *actual user* clicks the button do we POST,
--      call supabase.auth.admin.generateLink, mark the claim used,
--      and 302 to the verify URL.
--
-- Claims are single-use, expire in 24h, and tied to an email so
-- generated links can only sign in the intended person.

create table if not exists magic_link_claims (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  target_user_id text references users(id) on delete cascade,
  created_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  used_at timestamptz
);

create index if not exists magic_link_claims_email_idx on magic_link_claims (email);
create index if not exists magic_link_claims_expires_at_idx on magic_link_claims (expires_at);

-- Service role does all writes/reads via the admin client; no public
-- access. Keep RLS on so anon/auth users can't read claim ids.
alter table magic_link_claims enable row level security;
