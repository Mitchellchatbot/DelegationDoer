// EOD (end-of-day) report — aggregates today's completed tasks, hours
// logged, and self-written notes per department, then formats a Slack
// Block Kit message. Sender side lives in src/lib/slack.ts.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { postMessage } from "@/lib/slack";

export interface EodPersonSummary {
  userId: string;
  name: string;
  avatarUrl: string | null;
  completedTasks: { id: string; title: string; priority: string }[];
  hoursLogged: number;
  // Legacy free-form notes column — kept for back-compat with any UI
  // surface still reading it. New writes go to the structured fields
  // below.
  note: string | null;
  // Structured EOD fields (spec v2 Section 2). All optional at the
  // type level; the UI marks the first three as required on submit.
  workedOn: string | null;
  accomplished: string | null;
  planTomorrow: string | null;
  blockers: string | null;
  // Lifecycle — set when the worker hits "Submit EOD" (DMs leaders +
  // dept heads at that moment) and again when a dept head ticks off.
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string | null } | null;
}

export interface EodDepartmentSummary {
  departmentId: string;
  departmentName: string;
  slackChannelId: string | null;
  date: string; // YYYY-MM-DD
  totalCompleted: number;
  totalHoursLogged: number;
  people: EodPersonSummary[];
}

// Range = today (00:00 → 23:59:59) in UTC. Good enough for now — if we
// ever want per-user timezones we'd push the range computation into the
// query, but a single UTC day matches the existing date-bigint pattern
// in time_entries.
function utcDayRange(date: Date): { startIso: string; endIso: string; isoDate: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 3_600_000);
  const isoDate = start.toISOString().slice(0, 10); // YYYY-MM-DD
  return { startIso: start.toISOString(), endIso: end.toISOString(), isoDate };
}

// Build one department's EOD summary. Pass `date` as a Date inside the
// target calendar day; we expand to a full UTC range from there.
export async function buildEodForDepartment(
  departmentId: string,
  date: Date = new Date()
): Promise<EodDepartmentSummary | null> {
  const supabase = getSupabaseAdmin();
  const { startIso, endIso, isoDate } = utcDayRange(date);

  // 1) Resolve department + members.
  const { data: dept } = await supabase
    .from("departments")
    .select("id, name, slack_channel_id")
    .eq("id", departmentId)
    .maybeSingle();
  if (!dept) return null;

  const { data: memberRows } = await supabase
    .from("department_members")
    .select("user_id")
    .eq("department_id", departmentId);
  const memberIds = (memberRows ?? []).map((r) => r.user_id as string);
  if (memberIds.length === 0) {
    return {
      departmentId: dept.id,
      departmentName: dept.name,
      slackChannelId: dept.slack_channel_id ?? null,
      date: isoDate,
      totalCompleted: 0,
      totalHoursLogged: 0,
      people: []
    };
  }

  // 2) Pull user records, completed tasks, time_entries, notes — in
  //    parallel.
  const [usersRes, tasksRes, entriesRes, notesRes] = await Promise.all([
    supabase
      .from("users")
      .select("id, name, avatar_url")
      .in("id", memberIds),
    supabase
      .from("tasks")
      .select("id, title, priority, assignee_id, status, last_activity_at")
      .in("assignee_id", memberIds)
      .eq("status", "done")
      .gte("last_activity_at", startIso)
      .lt("last_activity_at", endIso),
    supabase
      .from("time_entries")
      .select("user_id, started_at, ended_at")
      .in("user_id", memberIds)
      .gte("started_at", startIso)
      .lt("started_at", endIso),
    supabase
      .from("eod_notes")
      .select("user_id, note, worked_on, accomplished, plan_tomorrow, blockers, submitted_at, reviewed_at, reviewed_by")
      .in("user_id", memberIds)
      .eq("note_date", isoDate)
  ]);

  const users = (usersRes.data ?? []) as { id: string; name: string; avatar_url: string | null }[];
  const tasks = (tasksRes.data ?? []) as { id: string; title: string; priority: string; assignee_id: string; status: string; last_activity_at: string }[];
  const entries = (entriesRes.data ?? []) as { user_id: string; started_at: string; ended_at: string | null }[];
  const notes = (notesRes.data ?? []) as Array<{
    user_id: string;
    note: string | null;
    worked_on: string | null;
    accomplished: string | null;
    plan_tomorrow: string | null;
    blockers: string | null;
    submitted_at: string | null;
    reviewed_at: string | null;
    reviewed_by: string | null;
  }>;

  // Resolve reviewer names — single round-trip for the small set of
  // distinct reviewer user_ids we saw in today's notes.
  const reviewerIds = Array.from(new Set(
    notes.map((n) => n.reviewed_by).filter((v): v is string => !!v)
  ));
  const reviewerNameById = new Map<string, string | null>();
  if (reviewerIds.length > 0) {
    const { data: rs } = await supabase
      .from("users")
      .select("id, name")
      .in("id", reviewerIds);
    for (const r of (rs ?? []) as { id: string; name: string | null }[]) {
      reviewerNameById.set(r.id, r.name);
    }
  }

  // 3) Roll up per user.
  const tasksByUser = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const arr = tasksByUser.get(t.assignee_id) ?? [];
    arr.push(t);
    tasksByUser.set(t.assignee_id, arr);
  }

  const hoursByUser = new Map<string, number>();
  const now = Date.now();
  for (const e of entries) {
    const s = new Date(e.started_at).getTime();
    const f = e.ended_at ? new Date(e.ended_at).getTime() : now;
    if (f <= s) continue;
    hoursByUser.set(e.user_id, (hoursByUser.get(e.user_id) ?? 0) + (f - s) / 3_600_000);
  }

  const noteByUser = new Map<string, typeof notes[number]>();
  for (const n of notes) noteByUser.set(n.user_id, n);

  const people: EodPersonSummary[] = users
    .map((u) => {
      const completed = (tasksByUser.get(u.id) ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority
      }));
      const hours = +(hoursByUser.get(u.id) ?? 0).toFixed(2);
      const row = noteByUser.get(u.id) ?? null;
      const note = row?.note && row.note.trim() ? row.note : null;
      const blank = (v: string | null | undefined) =>
        v && v.trim() ? v : null;
      return {
        userId: u.id,
        name: u.name,
        avatarUrl: u.avatar_url ?? null,
        completedTasks: completed,
        hoursLogged: hours,
        note,
        workedOn: blank(row?.worked_on),
        accomplished: blank(row?.accomplished),
        planTomorrow: blank(row?.plan_tomorrow),
        blockers: blank(row?.blockers),
        submittedAt: row?.submitted_at ?? null,
        reviewedAt: row?.reviewed_at ?? null,
        reviewedBy: row?.reviewed_by
          ? { id: row.reviewed_by, name: reviewerNameById.get(row.reviewed_by) ?? null }
          : null
      };
    })
    // Sort: most completed first, then most hours, then name.
    .sort((a, b) => {
      if (b.completedTasks.length !== a.completedTasks.length)
        return b.completedTasks.length - a.completedTasks.length;
      if (b.hoursLogged !== a.hoursLogged) return b.hoursLogged - a.hoursLogged;
      return a.name.localeCompare(b.name);
    });

  return {
    departmentId: dept.id,
    departmentName: dept.name,
    slackChannelId: dept.slack_channel_id ?? null,
    date: isoDate,
    totalCompleted: tasks.length,
    totalHoursLogged: Array.from(hoursByUser.values()).reduce((a, b) => a + b, 0),
    people
  };
}

// Build EOD summaries for every department that has a Slack channel
// configured. Used by the cron path and the "send all" UI affordance.
export async function buildEodForAllDepartments(date: Date = new Date()): Promise<EodDepartmentSummary[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("departments")
    .select("id")
    .not("slack_channel_id", "is", null);
  const ids = (data ?? []).map((r) => r.id as string);
  const out: EodDepartmentSummary[] = [];
  for (const id of ids) {
    const summary = await buildEodForDepartment(id, date);
    if (summary) out.push(summary);
  }
  return out;
}

const PRIORITY_EMOJI: Record<string, string> = {
  critical: "🔥",
  high: "⚡",
  medium: "•",
  low: "·"
};

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

// Format a summary as a Slack Block Kit payload — header, totals,
// per-person sections. Returned as { text, blocks } so a non-Block-Kit
// receiving channel still shows something sensible.
export function formatEodForSlack(s: EodDepartmentSummary): { text: string; blocks: unknown[] } {
  const dateStr = prettyDate(s.date);
  const text = `${s.departmentName} EOD · ${dateStr}\n${s.totalCompleted} done · ${s.totalHoursLogged.toFixed(1)}h logged`;

  const blocks: unknown[] = [];
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `${s.departmentName} · EOD · ${dateStr}` }
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          `*${s.totalCompleted}* task${s.totalCompleted === 1 ? "" : "s"} completed · ` +
          `*${s.totalHoursLogged.toFixed(1)}h* logged across ${s.people.length} ` +
          `${s.people.length === 1 ? "person" : "people"}`
      }
    ]
  });
  blocks.push({ type: "divider" });

  if (s.people.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No team members in this department._" }
    });
    return { text, blocks };
  }

  // Only include people who actually had activity OR wrote any
  // section of their EOD. Otherwise the digest gets noisy with
  // "nothing to report" lines.
  const hasAnyNote = (p: EodPersonSummary) =>
    !!(p.note || p.workedOn || p.accomplished || p.planTomorrow || p.blockers);
  const active = s.people.filter(
    (p) => p.completedTasks.length > 0 || p.hoursLogged > 0 || hasAnyNote(p)
  );
  if (active.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_Quiet day — no completions, hours, or notes logged._" }
    });
    return { text, blocks };
  }

  for (const p of active) {
    const lines: string[] = [];
    lines.push(`*${p.name}*  ·  ${p.completedTasks.length} done  ·  ${p.hoursLogged.toFixed(1)}h logged`);
    if (p.completedTasks.length > 0) {
      const top = p.completedTasks.slice(0, 6);
      for (const t of top) {
        const e = PRIORITY_EMOJI[t.priority] ?? "•";
        lines.push(`  ${e}  ${t.title}`);
      }
      if (p.completedTasks.length > top.length) {
        lines.push(`  …and ${p.completedTasks.length - top.length} more`);
      }
    }
    const quote = (s: string) =>
      s.split("\n").map((line) => `> ${line}`).join("\n");
    // Prefer the structured fields when present; fall back to the
    // legacy free-form note for users still on the old textarea.
    if (p.workedOn) lines.push(`*Worked on:*\n${quote(p.workedOn)}`);
    if (p.accomplished) lines.push(`*Accomplished:*\n${quote(p.accomplished)}`);
    if (p.planTomorrow) lines.push(`*Plan for tomorrow:*\n${quote(p.planTomorrow)}`);
    if (p.blockers) lines.push(`*Blockers / questions:*\n${quote(p.blockers)}`);
    if (!p.workedOn && !p.accomplished && !p.planTomorrow && !p.blockers && p.note) {
      lines.push(`_Notes:_\n${quote(p.note)}`);
    }
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") }
    });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Sent from DelegationDoer · ${dateStr}`
      }
    ]
  });
  return { text, blocks };
}

// Post the EOD digest. Surfaces a structured result so the caller (UI
// "Send" button or cron) can show success / failure per department.
export interface EodSendResult {
  departmentId: string;
  departmentName: string;
  channelId: string | null;
  delivery: "sent" | "skipped_no_channel" | "skipped_empty" | "failed";
  error?: string;
}

export async function sendEodToSlack(summary: EodDepartmentSummary): Promise<EodSendResult> {
  const base = {
    departmentId: summary.departmentId,
    departmentName: summary.departmentName,
    channelId: summary.slackChannelId
  };
  if (!summary.slackChannelId) {
    return { ...base, delivery: "skipped_no_channel" };
  }
  const hasContent = summary.people.some(
    (p) => p.completedTasks.length > 0 || p.hoursLogged > 0 || p.note
  );
  if (!hasContent) {
    return { ...base, delivery: "skipped_empty" };
  }
  const { text, blocks } = formatEodForSlack(summary);
  try {
    await postMessage(summary.slackChannelId, text, blocks);
    return { ...base, delivery: "sent" };
  } catch (err) {
    return {
      ...base,
      delivery: "failed",
      error: err instanceof Error ? err.message : "unknown"
    };
  }
}
