// EOD digest — accumulates one approval-queue email per client per day,
// drafted from every contributor's EOD content + client-side context
// (tasks completed since the last sent email, business info, SEO brief,
// recent threads). Fires live when a worker submits their EOD; the
// approve route stamps tasks as "reported" the moment the email
// actually sends so a task can never be reported on twice.
//
// Single source of truth for "is this task reported": tasks.reported_to_client_at.
// Single source of truth for "which tasks does this draft cover":
// email_draft_tasks (draft_id, task_id).
//
// Idempotency: per (client_name, date), there's at most one pending
// eod_digest draft. Re-running the builder for the same pair either
// updates the existing pending draft (re-running the AI with the
// expanded contributor set) or no-ops if the draft has progressed past
// pending OR an approver has hand-edited (revision_count > 0).

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAnthropic, MODELS } from "@/lib/anthropic-client";
import { TEAM_TAG } from "@/lib/task-team";

// How far back to look for already-completed work. Per spec: tasks
// closed in the last 7 days that haven't been reported yet. Sent
// emails further-back filter naturally via reported_to_client_at.
const LOOKBACK_DAYS = 7;

export type UpdateCadence = "daily" | "biweekly" | "weekly" | "monthly" | "none";

// Is `date` a "report day" under `cadence`? Used by both the live
// EOD-submit path (to skip non-daily clients) and the safety-net cron
// (to find clients whose day is today).
//
// Days-of-week are UTC: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
// biweekly = Wednesday + Friday (per spec). weekly = Friday only.
// monthly = the 1st of the month.
export function isReportDay(cadence: UpdateCadence, date: Date = new Date()): boolean {
  switch (cadence) {
    case "daily":    return true;
    case "biweekly": return date.getUTCDay() === 3 || date.getUTCDay() === 5;
    case "weekly":   return date.getUTCDay() === 5;
    case "monthly":  return date.getUTCDate() === 1;
    case "none":     return false;
  }
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  tags: string[] | null;
  completed_at: string | null;
}

interface ClientRow {
  id: string;
  name: string;
  contact_name: string | null;
  contact_emails: string[] | null;
  business_information: string | null;
  seo_brief: string | null;
}

function lookbackIso(): string {
  return new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
}

// Build / refresh the digest for a single (clientName, dateStr) pair.
// Returns true if the draft was created or updated, false if we
// no-op'd (no contributors today, wrong cadence-day, no contact,
// already past pending, hand-edited).
//
// `opts.force` skips the cadence-day check — used by the safety-net
// cron when it's explicitly polling on a known report-day, so we don't
// double-check.
export async function buildDigestForClient(
  clientName: string,
  dateStr: string,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  const supabase = getSupabaseAdmin();

  // 2) Resolve the client row. Tasks may carry a free-text client_name
  //    that doesn't have a matching row — that's fine, we just won't
  //    have contact/brief context for the prompt.
  const { data: clientRowRaw } = await supabase
    .from("clients")
    .select("id, name, contact_name, contact_emails, business_information, seo_brief, update_cadence")
    .eq("name", clientName)
    .maybeSingle();
  const client = clientRowRaw as (ClientRow & { update_cadence?: UpdateCadence | null }) | null;
  if (!client?.contact_emails || client.contact_emails.length === 0) {
    // No "to" address → we can't queue a sendable draft. Skip silently;
    // the approver would only have to fill in the recipient anyway.
    return false;
  }
  // Cadence gate — non-report-days never produce a draft for this
  // client. Default to 'daily' for back-compat with rows that pre-date
  // the cadence column.
  if (!opts.force) {
    const cadence: UpdateCadence = (client.update_cadence as UpdateCadence | null) ?? "daily";
    if (!isReportDay(cadence, new Date(`${dateStr}T12:00:00Z`))) return false;
  }

  // 3) Collect every contributor's EOD content + task work for this
  //    client TODAY. Contributors = anyone whose tasks-closed-today or
  //    emails-sent-today reference this client.
  const todayIso = new Date(`${dateStr}T00:00:00Z`).toISOString();
  const lookbackIsoVal = lookbackIso();

  const [contribsTasksRes, eodNotesRes, tasksForReportRes, lastSentRes] = await Promise.all([
    // department_id + tags come along so an unclaimed team task can still
    // yield contributors — see the fallback below.
    supabase
      .from("tasks")
      .select("assignee_id, department_id, tags")
      .eq("client_name", clientName)
      .eq("status", "done")
      .gte("completed_at", todayIso),
    // Fetched separately by user after we know contributors.
    Promise.resolve({ data: null }),
    // Tasks to report on: closed in the lookback window AND not yet
    // reported in any sent email. This is the "what's new since the
    // last update" set.
    supabase
      .from("tasks")
      .select("id, title, description, tags, completed_at")
      .eq("client_name", clientName)
      .eq("status", "done")
      .is("reported_to_client_at", null)
      .gte("completed_at", lookbackIsoVal)
      .order("completed_at", { ascending: true })
      .limit(50),
    supabase
      .from("email_drafts")
      .select("subject, sent_at")
      .eq("client_name", clientName)
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  const completedToday = (contribsTasksRes.data ?? []) as {
    assignee_id: string | null;
    department_id: string | null;
    tags: string[] | null;
  }[];
  const contributorIds = Array.from(new Set(
    completedToday.map((r) => r.assignee_id).filter((v): v is string => !!v)
  ));

  // Fallback for unclaimed team work. Finishing a team task normally
  // auto-claims it (see PATCH /api/tasks/[id]), so this is the belt to that
  // braces — but the failure it guards against is severe and silent: with no
  // contributors this function returns false and NO client update email is
  // drafted at all, with no error and no log. Better to credit the
  // department than to skip the client's update.
  if (contributorIds.length === 0) {
    const teamDeptIds = Array.from(new Set(
      completedToday
        .filter((r) => !r.assignee_id && (r.tags ?? []).includes(TEAM_TAG) && r.department_id)
        .map((r) => r.department_id as string)
    ));
    if (teamDeptIds.length > 0) {
      const { data: members } = await supabase
        .from("department_members")
        .select("user_id")
        .in("department_id", teamDeptIds);
      for (const m of (members ?? []) as { user_id: string }[]) {
        if (!contributorIds.includes(m.user_id)) contributorIds.push(m.user_id);
      }
    }
  }
  if (contributorIds.length === 0) return false;

  // Fetch contributor user rows + their EOD notes for today in parallel.
  const [contribUsersRes, contribNotesRes] = await Promise.all([
    supabase
      .from("users")
      .select("id, name")
      .in("id", contributorIds),
    supabase
      .from("eod_notes")
      .select("user_id, worked_on, accomplished, plan_tomorrow, blockers, note")
      .in("user_id", contributorIds)
      .eq("note_date", dateStr)
  ]);
  const userById = new Map(
    ((contribUsersRes.data ?? []) as { id: string; name: string }[])
      .map((u) => [u.id, u.name])
  );
  const notesByUser = new Map(
    ((contribNotesRes.data ?? []) as Array<{
      user_id: string;
      worked_on: string | null;
      accomplished: string | null;
      plan_tomorrow: string | null;
      blockers: string | null;
      note: string | null;
    }>).map((n) => [n.user_id, n])
  );

  const tasksToReport = (tasksForReportRes.data ?? []) as TaskRow[];
  if (tasksToReport.length === 0) {
    // Nothing new since the last sent email. Skip — no draft to write.
    return false;
  }

  // 4) Look for an existing pending digest draft for this client+date.
  //    If it exists and was hand-edited, leave it alone. If it exists
  //    and is untouched, we'll re-render it with the expanded inputs.
  //    Otherwise insert a fresh row.
  const { data: existing } = await supabase
    .from("email_drafts")
    .select("id, status, revision_count, body_text")
    .eq("client_name", clientName)
    .eq("kind", "eod_digest")
    .gte("created_at", todayIso)
    .maybeSingle();
  if (existing) {
    if (existing.status !== "pending") return false;
    if ((existing.revision_count ?? 0) > 0) return false;
  }

  // 5) Compose the prompt. The system message defines the "Bella"
  //    voice — same as the live "Fill with AI" path so the digest reads
  //    like the existing client_update emails the approvers already
  //    review.
  const callerNameForSignoff = "The team";
  const eodChunks: string[] = [];
  for (const userId of contributorIds) {
    const name = userById.get(userId) ?? "A teammate";
    const note = notesByUser.get(userId);
    const fields: string[] = [];
    if (note?.worked_on) fields.push(`Worked on: ${note.worked_on}`);
    if (note?.accomplished) fields.push(`Accomplished: ${note.accomplished}`);
    if (note?.plan_tomorrow) fields.push(`Plan tomorrow: ${note.plan_tomorrow}`);
    if (note?.blockers) fields.push(`Blockers: ${note.blockers}`);
    if (fields.length === 0 && note?.note) fields.push(`Notes: ${note.note}`);
    if (fields.length > 0) {
      eodChunks.push(`From ${name}:\n${fields.join("\n")}`);
    }
  }
  const eodSection = eodChunks.length > 0
    ? eodChunks.join("\n\n")
    : "(no structured EOD notes from contributors today)";

  const taskLines = tasksToReport.map((t) =>
    `- ${t.title}${t.tags?.length ? ` (${t.tags.slice(0, 3).join(", ")})` : ""}`
  ).join("\n");

  const lastSent = (lastSentRes.data as { subject: string | null; sent_at: string | null } | null) ?? null;
  const lastSentLine = lastSent?.sent_at
    ? `Last sent ${lastSent.sent_at.slice(0, 10)}${lastSent.subject ? ` ("${lastSent.subject}")` : ""}`
    : "First update to this client.";

  const userPrompt = [
    `Client: ${client.name}`,
    client.contact_name ? `Primary contact: ${client.contact_name}` : "",
    "",
    "Recent context:",
    lastSentLine,
    client.business_information ? `Business: ${client.business_information.slice(0, 400)}` : "",
    client.seo_brief ? `Leadership SEO brief: ${client.seo_brief.slice(0, 400)}` : "",
    "",
    "Today's EOD notes from teammates who touched this account:",
    eodSection,
    "",
    `Completed work in the last ${LOOKBACK_DAYS} days NOT yet reported to this client:`,
    taskLines,
    "",
    "Draft a short client-update email summarizing what's new since the last update. Output JSON: { subject, body }."
  ].filter(Boolean).join("\n");

  const systemPrompt = `You write end-of-day client update emails for a digital agency. The draft you produce is queued for human approval before sending.

Voice: direct, friendly, professional. First-person plural ("we"). 2-4 short paragraphs.
- Lead with a one-line summary of what's new since the last update.
- One short paragraph per major theme (content shipped, fixes deployed, milestones hit).
- Reference the leadership brief's priorities when they overlap with the work done.
- If the list of work is short, keep the email short — don't pad.
- End with a soft prompt: "Let us know if you have any questions."
- Sign off "Best," then a newline, then "${callerNameForSignoff}".

ABSOLUTE RULES:
- NEVER use em dashes ("—") or en dashes ("–"). Use commas, periods, or parentheses.
- Plain text only. No markdown, no bullets, no headers.
- Never invent specifics not in the input. If the work list is empty, do not produce a draft.

Return STRICT JSON, no code fences:
{ "subject": "<≤60 chars, e.g. 'Update on Acme'>", "body": "<plain-text body>" }`;

  const anthropic = await getAnthropic();
  const result = await anthropic.messages.create({
    model: MODELS.classify, // Haiku — cheap + plenty for a short update
    max_tokens: 900,
    temperature: 0.4,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }]
  });
  const block = result.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text.trim() : "";

  let parsed: { subject?: unknown; body?: unknown } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* swallow */ }
    }
  }
  const subjectRaw = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
  const bodyRaw = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!bodyRaw) return false;

  const scrub = (s: string) => s
    .replace(/\s+—\s+/g, ", ")
    .replace(/\s+–\s+/g, ", ")
    .replace(/—/g, ",")
    .replace(/–/g, ",");
  const subject = scrub(subjectRaw || `Update on ${client.name}`).slice(0, 300);
  const body = scrub(bodyRaw);

  // 6) Upsert the draft. We use a deterministic id so the same
  //    (client_id, date) writes back to the same row even across
  //    multiple workers' submits in the same day. First contributor's
  //    user id becomes the author_id (legal owner) — the SECOND
  //    submitter merges their inputs into the regenerated body but
  //    doesn't overwrite the author. Approvers see "drafted by N+M"
  //    naturally in the linked-tasks list.
  const draftId = `eod_${client.id}_${dateStr}`;
  const firstContributorId = contributorIds[0];
  const now = new Date().toISOString();
  const draftRow = {
    id: draftId,
    author_id: existing ? undefined : firstContributorId,
    client_id: client.id,
    client_name: client.name,
    to_emails: client.contact_emails,
    cc_emails: [] as string[],
    bcc_emails: [] as string[],
    subject,
    body_text: body,
    kind: "eod_digest" as const,
    status: "pending" as const,
    updated_at: now,
    ...(existing ? {} : { created_at: now })
  };
  // Strip undefined keys for the upsert.
  const cleaned = Object.fromEntries(
    Object.entries(draftRow).filter(([, v]) => v !== undefined)
  );

  const { error: upsertErr } = await supabase
    .from("email_drafts")
    .upsert(cleaned, { onConflict: "id" });
  if (upsertErr) throw new Error(`upsert draft: ${upsertErr.message}`);

  // 7) Link the tasks. Wipe and reinsert so a removed task (e.g.
  //    reopened to in_progress) drops out of the link set cleanly.
  await supabase.from("email_draft_tasks").delete().eq("draft_id", draftId);
  if (tasksToReport.length > 0) {
    const links = tasksToReport.map((t) => ({
      draft_id: draftId,
      task_id: t.id
    }));
    const { error: linkErr } = await supabase.from("email_draft_tasks").insert(links);
    if (linkErr) throw new Error(`link tasks: ${linkErr.message}`);
  }

  return true;
}

// Called by the approve route + scheduled-emails runner AFTER a draft
// moves to status='sent'. Stamps everything the draft references with the
// send time so it's excluded from future digests/composers:
//   - tasks it linked (email_draft_tasks)         -> tasks.reported_to_client_at
//   - EOD work entries it linked (email_draft_eod_work)
//                                                  -> eod_client_work.reported_to_client_at
// Idempotent: re-running on an already-sent draft just re-stamps the same
// value. Returns the total number of rows stamped across both sources.
export async function markTasksReportedFromDraft(draftId: string, sentAt: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  let stamped = 0;

  const { data: taskLinks } = await supabase
    .from("email_draft_tasks")
    .select("task_id")
    .eq("draft_id", draftId);
  const taskIds = ((taskLinks ?? []) as { task_id: string }[]).map((r) => r.task_id);
  if (taskIds.length > 0) {
    const { error } = await supabase
      .from("tasks")
      .update({ reported_to_client_at: sentAt })
      .in("id", taskIds);
    if (error) console.error("[eod-digest] mark tasks reported failed", error);
    else stamped += taskIds.length;
  }

  // EOD client-work source (the new email source). The link table may not
  // exist on environments where the 20260702 migration hasn't run — treat
  // a missing-table error as "nothing to stamp" rather than failing.
  const { data: workLinks, error: linkErr } = await supabase
    .from("email_draft_eod_work")
    .select("eod_work_id")
    .eq("draft_id", draftId);
  if (linkErr) {
    if (!/email_draft_eod_work/.test(linkErr.message)) {
      console.error("[eod-digest] eod-work link lookup failed", linkErr);
    }
  } else {
    const workIds = ((workLinks ?? []) as { eod_work_id: string }[]).map((r) => r.eod_work_id);
    if (workIds.length > 0) {
      const { error } = await supabase
        .from("eod_client_work")
        .update({ reported_to_client_at: sentAt })
        .in("id", workIds);
      if (error) console.error("[eod-digest] mark eod-work reported failed", error);
      else stamped += workIds.length;
    }
  }

  return stamped;
}

// Marks ALL of a client's still-pending EOD client-work as reported, keyed by
// client name. Used when a weekly SEO update is sent straight from the inbox
// composer (flagged via missiveclone's webhook) rather than through the EOD
// approval composer — so the client drops off the "Who needs an email" card
// exactly as if an EOD digest had been sent for them.
//
// Only touches rows that are still unreported AND not dismissed, so it's
// idempotent: redundant webhook deliveries re-stamp nothing. Returns the
// number of rows stamped (0 when the client had no pending work).
export async function markClientWeeklyUpdateReported(
  clientName: string,
  sentAt: string
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("eod_client_work")
    .update({ reported_to_client_at: sentAt })
    .eq("client_name", clientName)
    .is("reported_to_client_at", null)
    .is("dismissed_at", null)
    .select("id");
  if (error) {
    console.error("[eod-digest] mark client weekly-update reported failed", {
      clientName,
      err: error.message
    });
    return 0;
  }
  return (data ?? []).length;
}
