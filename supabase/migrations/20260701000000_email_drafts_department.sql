-- Department routing for email drafts. The Client Update composer now
-- splits a single client update into one draft per department (Website /
-- SEO / Software / ...) so each lands with the matching department head
-- for approval. `department_id` tags which department a draft belongs to;
-- NULL means "not department-scoped" (the legacy behaviour — global
-- approvers only, e.g. custom emails or tasks with no department).
--
-- Routing reads this column in lib/email-approvers.ts (canApproveDraft +
-- getApproversForDraft) and in GET /api/email-drafts visibility. Nullable
-- + ON DELETE SET NULL so deleting a department never orphans a receipt.

alter table public.email_drafts
  add column if not exists department_id text
    references public.departments(id) on delete set null;

-- Pending drafts for a given department — the query a department head's
-- approvals view + badge count runs.
create index if not exists email_drafts_department_status_idx
  on email_drafts(department_id, status, created_at desc)
  where department_id is not null;
