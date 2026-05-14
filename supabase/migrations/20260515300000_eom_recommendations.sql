-- Employee-of-the-month recommendations. Each EoM gets to spotlight
-- one or more pieces of culture — a movie, album, art piece, game,
-- video, or a fully-custom "poster" they assembled themselves. The
-- /updates/recommendations page reveals the latest as a full-bleed
-- card with everything older in a history grid below.

create table if not exists public.eom_recommendations (
  id          text primary key,
  user_id     text not null references public.users(id) on delete cascade,
  month       text not null,           -- 'YYYY-MM', matches employee_of_month.month
  kind        text not null check (kind in ('movie','tv','album','art','game','video','custom')),
  title       text not null,
  subtitle    text,
  body        text,                    -- free-form pitch ("why I love this")
  external_id text,                    -- tmdb id / rawg id / youtube id
  external_url text,                   -- link out to the canonical source
  image_url   text,                    -- poster image (uploaded or external CDN)
  audio_url   text,                    -- optional audio attachment

  -- For 'custom' kind: the placed-text layers + any other layout knobs.
  -- Shape: { overlays: [{ text, xPct, yPct, sizePx, weight, color, shadow }],
  --          imageFit: 'cover'|'contain', imageFocalX?: 0..1, imageFocalY?: 0..1 }
  layout      jsonb not null default '{}'::jsonb,

  created_at  timestamptz not null default now()
);

create index if not exists eom_recommendations_user_idx
  on public.eom_recommendations (user_id, created_at desc);
create index if not exists eom_recommendations_month_idx
  on public.eom_recommendations (month);

alter table public.eom_recommendations enable row level security;
