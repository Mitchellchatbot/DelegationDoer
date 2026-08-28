-- Client onboarding forms — the Website and SEO questionnaires, moved off
-- Typeform and into Scaled Operations.
--
-- Sam (SEO) and Mujtaba (Website) mint a link per client and send it out. The
-- client fills it in with no DD account: the token in the URL is the only
-- identity, which is why it is a stored random value rather than something
-- derived from the client id — a stored row can be revoked one at a time, and
-- carries the opened/completed stamps the heads actually want to see.
--
-- Four tables, all keyed off the link rather than the client, because a client
-- can be sent both forms (and, after a rebuild, the same form twice) and the
-- answers to each must stay separable.
--
-- Apply MANUALLY. Merging the PR runs nothing in this repo.

-- ---------------------------------------------------------------------------
-- The link itself.
-- ---------------------------------------------------------------------------
create table if not exists public.client_onboarding_links (
  id              text primary key,
  -- 32 random bytes, base64url. THE credential for this form — anyone holding
  -- it can read back the hints and write answers, so it is never rendered into
  -- a list page; the head asks for it explicitly (see the copy-link action).
  token           text not null unique,
  form_key        text not null check (form_key in ('website', 'seo')),
  client_id       text not null references public.clients(id) on delete cascade,
  -- Which department's Slack channel hears about this one. Nullable + SET NULL
  -- so deleting a department never strands a client mid-onboarding; the notice
  -- falls back to the Scaled Team channel.
  department_id   text references public.departments(id) on delete set null,
  created_by      text references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Stamped the first time the link is opened. The difference between "sent"
  -- and "sent and ignored" is the single most useful thing on the card.
  first_opened_at timestamptz,
  completed_at    timestamptz,
  revoked_at      timestamptz
);

create index if not exists client_onboarding_links_client_idx
  on public.client_onboarding_links (client_id);

-- ---------------------------------------------------------------------------
-- One row per answered field.
-- ---------------------------------------------------------------------------
-- id is deterministic (`${link_id}:${step_id}:${field_key}`) so the autosave
-- path is a plain upsert — a client editing an answer three times leaves one
-- row, not three.
create table if not exists public.client_onboarding_answers (
  id           text primary key,
  link_id      text not null references public.client_onboarding_links(id) on delete cascade,
  -- Denormalised from the link so the client page can read every answer for a
  -- client without joining through however many links they have.
  client_id    text not null references public.clients(id) on delete cascade,
  step_id      text not null,
  field_key    text not null,
  -- The question as it was asked. Stored rather than looked up: the wording
  -- will be edited, and an answer read back a year later should be paired with
  -- the question that was actually on screen.
  label        text not null,
  -- Exactly one of value / sealed is populated. value is plaintext and is only
  -- ever used for fields NOT flagged secret; sealed is AES-256-GCM
  -- (iv:tag:ciphertext) and there is deliberately no plaintext column for it.
  value        text,
  sealed       text,
  -- Enough to recognise an answer in a list without revealing it: a short
  -- prefix for plain values, a mask for secrets.
  hint         text,
  is_secret    boolean not null default false,
  submitted_at timestamptz not null default now(),
  constraint client_onboarding_answers_link_field_key unique (link_id, step_id, field_key),
  -- A secret must be sealed and must not leave a plaintext copy behind; a
  -- non-secret has nothing to seal. Enforced here because the failure this
  -- guards against — a password quietly written to `value` after a refactor —
  -- is invisible in review and permanent once it has happened.
  constraint client_onboarding_answers_secrecy check (
    (is_secret and sealed is not null and value is null)
    or (not is_secret and sealed is null)
  )
);

create index if not exists client_onboarding_answers_link_idx
  on public.client_onboarding_answers (link_id);
create index if not exists client_onboarding_answers_client_idx
  on public.client_onboarding_answers (client_id);

-- ---------------------------------------------------------------------------
-- Which steps have been marked done.
-- ---------------------------------------------------------------------------
-- The walkthrough also keeps this in localStorage so a returning client resumes
-- instantly without a round trip. This table is the copy the TEAM reads: "how
-- far have they got" has to be answerable from DD, not from the client's
-- browser.
create table if not exists public.client_onboarding_steps (
  link_id text not null references public.client_onboarding_links(id) on delete cascade,
  step_id text not null,
  done_at timestamptz not null default now(),
  primary key (link_id, step_id)
);

-- ---------------------------------------------------------------------------
-- Files a client attached (the Website form's logo + images step).
-- ---------------------------------------------------------------------------
-- Stored in the existing public `ticket-attachments` bucket under
-- onboarding/<link_id>/, so the URL works in an <img> on the client page with
-- no signing dance. Bucket is already created by 20260506000001_attachments.sql.
create table if not exists public.client_onboarding_files (
  id           text primary key,
  link_id      text not null references public.client_onboarding_links(id) on delete cascade,
  client_id    text not null references public.clients(id) on delete cascade,
  step_id      text not null,
  field_key    text not null,
  file_name    text not null,
  url          text not null,
  storage_key  text,
  content_type text,
  size_bytes   bigint,
  uploaded_at  timestamptz not null default now()
);

create index if not exists client_onboarding_files_link_idx
  on public.client_onboarding_files (link_id);
create index if not exists client_onboarding_files_client_idx
  on public.client_onboarding_files (client_id);
