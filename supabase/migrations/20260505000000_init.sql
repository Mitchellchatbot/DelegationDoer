-- DelegationDoer initial schema + seed.
-- Mirrors the shape of src/lib/mock-data.ts so the app can flip from
-- in-memory mocks to real reads without changing call sites.

-- =========================================================================
-- ENUM TYPES
-- =========================================================================

create type role as enum ('ceo', 'department_head', 'worker');
create type ticket_status as enum ('pending', 'in_progress', 'urgent', 'waiting_on_client', 'done');
create type priority as enum ('low', 'medium', 'high', 'critical');
create type milestone_status as enum ('pending', 'in_progress', 'done', 'delayed');
create type raci_role as enum ('responsible', 'accountable', 'consulted', 'informed');

-- =========================================================================
-- TABLES
-- =========================================================================

create table public.departments (
  id          text primary key,
  name        text not null unique,
  description text,
  task_types  text[] not null default '{}',
  created_at  timestamptz not null default now()
);

create table public.users (
  id             text primary key,
  name           text not null,
  email          text not null unique,
  role           role not null default 'worker',
  daily_capacity numeric(4,1) not null default 8,
  throughput     jsonb not null default '{}'::jsonb,
  skills         text[] not null default '{}',
  avatar_url     text,
  created_at     timestamptz not null default now()
);

-- Many-to-many: a worker is a member of one department; a department head
-- can be a member of several.
create table public.department_members (
  user_id       text not null references public.users(id) on delete cascade,
  department_id text not null references public.departments(id) on delete cascade,
  primary key (user_id, department_id)
);
create index on public.department_members (department_id);

create table public.skill_profiles (
  id               text primary key,
  user_id          text not null references public.users(id) on delete cascade,
  skill_name       text not null,
  experience_level smallint not null default 1 check (experience_level between 1 and 5),
  task_types       text[] not null default '{}'
);
create index on public.skill_profiles (user_id);

create table public.projects (
  id            text primary key,
  name          text not null,
  description   text,
  department_id text references public.departments(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index on public.projects (department_id);

create table public.milestones (
  id           text primary key,
  project_id   text not null references public.projects(id) on delete cascade,
  name         text not null,
  due_date     timestamptz not null,
  deliverables text[] not null default '{}',
  status       milestone_status not null default 'pending'
);
create index on public.milestones (project_id);

create table public.raci_entries (
  id         text primary key,
  project_id text not null references public.projects(id) on delete cascade,
  user_id    text not null references public.users(id) on delete cascade,
  area       text not null,
  role       raci_role not null
);
create index on public.raci_entries (project_id);
create index on public.raci_entries (user_id);

create table public.tickets (
  id                text primary key,
  title             text not null,
  description       text,
  status            ticket_status not null default 'pending',
  priority          priority not null default 'medium',
  estimated_hours   numeric(5,1) not null default 2,
  actual_hours      numeric(5,1) not null default 0,
  tags              text[] not null default '{}',
  department_id     text references public.departments(id) on delete set null,
  assignee_id       text references public.users(id) on delete set null,
  creator_id        text not null references public.users(id) on delete restrict,
  project_id        text references public.projects(id) on delete set null,
  due_date          timestamptz,
  inactive_flag     boolean not null default false,
  last_activity_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  blocks_ticket_ids text[] not null default '{}'
);
create index on public.tickets (assignee_id);
create index on public.tickets (department_id);
create index on public.tickets (project_id);
create index on public.tickets (status);

create table public.activity_logs (
  id         text primary key,
  ticket_id  text not null references public.tickets(id) on delete cascade,
  user_id    text not null references public.users(id) on delete cascade,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);
create index on public.activity_logs (ticket_id);

create table public.incident_logs (
  id               text primary key,
  issue_type       text not null,
  affected_url     text,
  description      text not null,
  assigned_to_id   text references public.users(id) on delete set null,
  resolution_notes text,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index on public.incident_logs (assigned_to_id);
create index on public.incident_logs (issue_type);

-- Configurable mapping of incident issue type → user to assign by default.
create table public.incident_routing (
  issue_type text primary key,
  user_id    text not null references public.users(id) on delete cascade
);

-- updated_at trigger for tickets
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

create trigger tickets_set_updated_at
before update on public.tickets
for each row execute function public.set_updated_at();

-- =========================================================================
-- RLS
-- =========================================================================
-- Internal tool. Enabling RLS for compliance and granting the service_role
-- full bypass (which it has by default). Add per-role policies later when
-- wiring up Auth in the app.

alter table public.departments        enable row level security;
alter table public.users              enable row level security;
alter table public.department_members enable row level security;
alter table public.skill_profiles     enable row level security;
alter table public.projects           enable row level security;
alter table public.milestones         enable row level security;
alter table public.raci_entries       enable row level security;
alter table public.tickets            enable row level security;
alter table public.activity_logs      enable row level security;
alter table public.incident_logs      enable row level security;
alter table public.incident_routing   enable row level security;

-- =========================================================================
-- SEED — mirrors src/lib/mock-data.ts so the app flips over cleanly
-- =========================================================================

insert into public.departments (id, name, description, task_types) values
  ('dep_seo',      'SEO',       'Organic growth, on-page, technical SEO, link building.',
    array['keyword research','on-page audit','backlink outreach','technical seo','schema markup']),
  ('dep_web',      'Website',   'Site builds, CMS, content, performance, hosting.',
    array['new page build','bug fix','site migration','performance tuning','form integration','cms update']),
  ('dep_software', 'Software',  'Internal tools, custom apps, integrations, automation.',
    array['feature build','api integration','bug fix','refactor','deploy','internal tool']),
  ('dep_mkt',      'Marketing', 'Paid ads, email, content strategy, social.',
    array['ad campaign setup','email sequence','blog post','social calendar','landing page copy']);

insert into public.users (id, name, email, role, daily_capacity, throughput, skills) values
  ('u_1', 'Henry Chen',     'henry@scaledai.org',  'ceo',             8, '{}'::jsonb,
    array['strategy','operations']),
  ('u_2', 'Priya Sharma',   'priya@scaledai.org',  'department_head', 8, '{"audits_per_day":2,"insurance_pages_per_day":10}'::jsonb,
    array['technical seo','audits','schema']),
  ('u_3', 'Marcus Lee',     'marcus@scaledai.org', 'worker',          7, '{"outreach_emails_per_day":30}'::jsonb,
    array['link building','outreach']),
  ('u_4', 'Sara Okafor',    'sara@scaledai.org',   'department_head', 8, '{"ad_creatives_per_day":6}'::jsonb,
    array['meta ads','google ads','copy']),
  ('u_5', 'Diego Martín',   'diego@scaledai.org',  'department_head', 8, '{"pages_per_day":5}'::jsonb,
    array['wordpress','react','next.js','node','css']),
  ('u_6', 'Aisha Rahman',   'aisha@scaledai.org',  'worker',          6, '{"emails_per_day":8}'::jsonb,
    array['email','lifecycle']),
  ('u_7', 'Theo Park',      'theo@scaledai.org',   'worker',          8, '{"pages_per_day":4}'::jsonb,
    array['wordpress','html','css']),
  ('u_8', 'Nadia Volkova',  'nadia@scaledai.org',  'worker',          8, '{"features_per_week":3}'::jsonb,
    array['typescript','next.js','prisma']),
  ('u_9', 'Jamal Reed',     'jamal@scaledai.org',  'worker',          7, '{"briefs_per_day":4}'::jsonb,
    array['content','keyword research']);

insert into public.department_members (user_id, department_id) values
  ('u_2', 'dep_seo'),
  ('u_3', 'dep_seo'),
  ('u_9', 'dep_seo'),
  ('u_5', 'dep_web'),       -- Diego heads Website
  ('u_5', 'dep_software'),  -- Diego also heads Software
  ('u_7', 'dep_web'),
  ('u_8', 'dep_software'),
  ('u_4', 'dep_mkt'),
  ('u_6', 'dep_mkt');

insert into public.skill_profiles (id, user_id, skill_name, experience_level, task_types) values
  ('s_1',  'u_1', 'strategy',      5, '{}'),
  ('s_2',  'u_5', 'next.js',       5, array['new page build','performance tuning','feature build']),
  ('s_3',  'u_5', 'wordpress',     4, array['cms update','bug fix']),
  ('s_4',  'u_2', 'technical seo', 5, array['on-page audit','schema markup','technical seo']),
  ('s_5',  'u_3', 'link building', 4, array['backlink outreach']),
  ('s_6',  'u_4', 'meta ads',      5, array['ad campaign setup']),
  ('s_7',  'u_7', 'wordpress',     4, array['new page build','bug fix','cms update']),
  ('s_8',  'u_8', 'typescript',    5, array['feature build','refactor','api integration']),
  ('s_9',  'u_6', 'email',         4, array['email sequence']),
  ('s_10', 'u_9', 'content',       3, array['blog post']);

insert into public.projects (id, name, description, department_id) values
  ('p_1', 'Acme Insurance Site Refresh', 'End-to-end rebuild of acme-insurance.com on Next.js with location pages.', 'dep_web'),
  ('p_2', 'Q3 SEO Push — Lawsmith Group', 'Programmatic location pages and authority backlinks.',                    'dep_seo'),
  ('p_3', 'Spring Lifecycle Campaign',    'Activation + retention email arc.',                                       'dep_mkt'),
  ('p_4', 'DelegationDoer (internal)',    'This very tool. Built by Software.',                                      'dep_software');

insert into public.milestones (id, project_id, name, due_date, deliverables, status) values
  ('m_1', 'p_1', 'Design lock',          now() - interval '3 days',  array['Figma sign-off','Brand guide'],            'done'),
  ('m_2', 'p_1', 'Templates built',      now() + interval '7 days',  array['5 page templates','Component library'],    'in_progress'),
  ('m_3', 'p_1', 'Launch',               now() + interval '28 days', array['DNS cutover','301 map','GSC verification'],'pending'),
  ('m_4', 'p_2', 'Keyword map',          now() + interval '2 days',  array['1000 keywords','Cluster doc'],             'in_progress'),
  ('m_5', 'p_2', 'First 50 pages live',  now() + interval '14 days', array['50 location pages indexed'],               'pending'),
  ('m_6', 'p_3', 'Welcome series',       now() + interval '5 days',  array['6 emails','Triggers'],                     'in_progress'),
  ('m_7', 'p_4', 'v1 internal launch',   now() + interval '10 days', array['Auth','Tickets','Board'],                  'in_progress');

insert into public.raci_entries (id, project_id, user_id, area, role) values
  ('r_1', 'p_1', 'u_5', 'Templates',         'responsible'),
  ('r_2', 'p_1', 'u_7', 'Templates',         'consulted'),
  ('r_3', 'p_1', 'u_2', 'SEO migration',     'accountable'),
  ('r_4', 'p_1', 'u_4', 'SEO migration',     'informed'),
  ('r_5', 'p_1', 'u_5', 'DNS cutover',       'responsible'),
  ('r_6', 'p_1', 'u_1', 'DNS cutover',       'accountable'),
  ('r_7', 'p_2', 'u_2', 'Keyword strategy',  'accountable'),
  ('r_8', 'p_2', 'u_3', 'Outreach',          'responsible'),
  ('r_9', 'p_2', 'u_2', 'Outreach',          'consulted');

insert into public.tickets
  (id, title, description, status, priority, estimated_hours, actual_hours, tags,
   department_id, assignee_id, creator_id, project_id, due_date, inactive_flag,
   last_activity_at, created_at, blocks_ticket_ids)
values
  ('t_1', 'Build /locations/[city] template',
   'Programmatic template w/ schema, FAQ, internal links. Lighthouse 90+.',
   'in_progress', 'high', 6, 2.5, array['story','performance'],
   'dep_web', 'u_5', 'u_1', 'p_1', now() + interval '2 days', false,
   now() - interval '3 hours', now() - interval '30 hours', array['t_5','t_6']),

  ('t_2', 'Site down — acme-insurance.com 502s',
   'Cloudflare reporting bad gateway intermittently. Affecting checkout flow.',
   'urgent', 'critical', 2, 0.5, array['urgent','client-request'],
   'dep_web', 'u_7', 'u_5', null, now(), false,
   now() - interval '1 hour', now() - interval '2 hours', '{}'),

  ('t_3', 'Schema markup audit — Lawsmith Group',
   'Run sitewide audit, identify pages missing FAQPage / LocalBusiness schema.',
   'pending', 'medium', 4, 0, array['day-task'],
   'dep_seo', 'u_9', 'u_2', 'p_2', now() + interval '3 days', false,
   now() - interval '8 hours', now() - interval '8 hours', '{}'),

  ('t_4', '10 location pages — insurance vertical',
   'Pittsburgh, Cincinnati, St Louis, Cleveland, Indianapolis, Columbus, Buffalo, Rochester, Hartford, Providence.',
   'in_progress', 'medium', 8, 3, array['story'],
   'dep_seo', 'u_3', 'u_2', 'p_2', now() + interval '5 days', false,
   now() - interval '60 hours', now() - interval '80 hours', '{}'),

  ('t_5', 'Wire contact form to HubSpot',
   'Forms submit to /api/lead and forward to HubSpot. Validate spam.',
   'waiting_on_client', 'medium', 3, 1, array['client-request'],
   'dep_web', 'u_7', 'u_5', 'p_1', now() + interval '4 days', true,
   now() - interval '72 hours', now() - interval '120 hours', '{}'),

  ('t_6', 'QA pass on templates',
   'Cross-browser, mobile, a11y. Document defects in Linear.',
   'pending', 'low', 4, 0, array['day-task'],
   'dep_web', null, 'u_5', 'p_1', now() + interval '10 days', false,
   now() - interval '20 hours', now() - interval '20 hours', '{}'),

  ('t_7', 'Welcome email #3 copy',
   'Tone: warm + product-led. CTA to onboarding video.',
   'in_progress', 'medium', 2, 0.5, array['story'],
   'dep_mkt', 'u_6', 'u_4', 'p_3', now() + interval '1 day', false,
   now() - interval '4 hours', now() - interval '48 hours', '{}'),

  ('t_8', 'Meta ads — Spring promo creatives',
   '6 creatives, 2 angles. Hook test.',
   'pending', 'high', 5, 0, array['story'],
   'dep_mkt', 'u_4', 'u_1', 'p_3', now() + interval '2 days', false,
   now() - interval '10 hours', now() - interval '10 hours', '{}'),

  ('t_9', 'Outreach — 30 prospect domains for Lawsmith',
   'Build prospect list, score by DR, send first-touch.',
   'in_progress', 'medium', 3, 1.5, array['day-task'],
   'dep_seo', 'u_3', 'u_2', 'p_2', now() + interval '2 days', false,
   now() - interval '6 hours', now() - interval '50 hours', '{}'),

  ('t_10', 'Migrate hosting from Pantheon to Vercel',
   'Plan, dry run, cutover window. Coordinate with client.',
   'done', 'high', 10, 11, array['story'],
   'dep_web', 'u_5', 'u_1', 'p_1', now() - interval '2 days', false,
   now() - interval '48 hours', now() - interval '240 hours', '{}'),

  ('t_11', 'Ship DelegationDoer v1',
   'Internal release of the org''s task tool. Auth, tickets, board, focus mode.',
   'in_progress', 'high', 16, 8, array['story','internal'],
   'dep_software', 'u_8', 'u_5', 'p_4', now() + interval '7 days', false,
   now() - interval '2 hours', now() - interval '120 hours', '{}'),

  ('t_12', 'Critical: malware flag on lawsmith.com',
   'Google Safe Browsing flagging — investigate, clean, request review.',
   'urgent', 'critical', 4, 0.5, array['urgent'],
   'dep_web', 'u_5', 'u_2', null, now(), false,
   now() - interval '2 hours', now() - interval '2 hours', '{}'),

  ('t_13', 'Slack ↔ ticket sync integration',
   'Post a thread in #ops when a ticket flips to urgent.',
   'pending', 'medium', 6, 0, array['story','internal'],
   'dep_software', 'u_8', 'u_1', 'p_4', now() + interval '9 days', false,
   now() - interval '14 hours', now() - interval '14 hours', '{}');

insert into public.activity_logs (id, ticket_id, user_id, action, detail, created_at) values
  ('a_1', 't_1',  'u_1', 'created',       'Created and assigned to Diego (Website lead)',  now() - interval '30 hours'),
  ('a_2', 't_1',  'u_5', 'status_change', 'pending → in_progress',                          now() - interval '28 hours'),
  ('a_3', 't_1',  'u_5', 'comment',       'First template scaffolded; FAQ schema next.',    now() - interval '3 hours'),
  ('a_4', 't_2',  'u_5', 'created',       'Reported by Diego from monitoring',              now() - interval '2 hours'),
  ('a_5', 't_2',  'u_7', 'status_change', 'pending → urgent',                               now() - interval '1 hour'),
  ('a_6', 't_5',  'u_7', 'status_change', 'in_progress → waiting_on_client',                now() - interval '72 hours'),
  ('a_7', 't_11', 'u_5', 'comment',       'Auth flows wrapped, working on tickets API next.', now() - interval '2 hours');

insert into public.incident_logs
  (id, issue_type, affected_url, description, assigned_to_id, resolution_notes, resolved_at, created_at) values
  ('i_1', 'site down',   'acme-insurance.com',         '502 Bad Gateway intermittently.', 'u_7', null, null, now() - interval '2 hours'),
  ('i_2', 'malware',     'lawsmith.com',               'Google Safe Browsing flag.',       'u_5', null, null, now() - interval '2 hours'),
  ('i_3', 'form broken', 'acme-insurance.com/contact', 'Submissions silently failing.',    'u_7',
    'HubSpot API key rotated; updated env var; deployed.', now() - interval '96 hours', now() - interval '120 hours'),
  ('i_4', 'site down',   'lawsmith.com',               'Outage during maintenance window.', 'u_5',
    'Pantheon DB connection pool exhausted; bumped tier.', now() - interval '200 hours', now() - interval '220 hours'),
  ('i_5', 'site down',   'acme-insurance.com',         'Cloudflare 522.',                   'u_5',
    'Origin upstream timeout; raised origin keep-alive.', now() - interval '340 hours', now() - interval '360 hours');

insert into public.incident_routing (issue_type, user_id) values
  ('site down',   'u_7'),
  ('malware',     'u_5'),
  ('form broken', 'u_7'),
  ('other',       'u_1');
