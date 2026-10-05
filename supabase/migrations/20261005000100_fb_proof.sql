-- Facebook task proof-of-work (submission + proofing). One row per FB task that
-- an FB-team member submits for manager approval: photo of completed work, what
-- they did, whether a test was done, and the manager's review.
create table if not exists public.fb_proof (
  task_id text primary key references public.tasks(id) on delete cascade,
  photo_url text,
  work_done text,
  test_done boolean not null default false,
  submitted_by text references public.users(id),
  submitted_at timestamptz not null default now(),
  review_status text not null default 'pending' check (review_status in ('pending','approved','sent_back')),
  reviewed_by text references public.users(id),
  review_notes text,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);

notify pgrst, 'reload schema';
