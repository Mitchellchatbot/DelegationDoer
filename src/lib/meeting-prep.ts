// Pre-meeting context aggregation. Given a client, pulls together the
// signals a teammate needs before a client meeting — recently-completed
// + open tasks, prior tl;dv meeting briefs, recent EOD client updates,
// and recent email threads — into one normalized bundle. The synthesis
// into a scannable brief happens in the /api/calendar/meetings/prep
// route; this module is pure data-gathering so it stays testable and
// owns no prompt.
//
// Reuses the Ask-AI client-context handlers (ai-tools.ts) verbatim so the
// department + inbox scoping is single-sourced: a worker preparing for a
// meeting sees exactly what Ask AI would let them see, never another
// team's tasks or an inbox they can't read. See [[ask-ai-permission-scoping]].

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getLeaderIds } from "@/lib/server-data";
import { canViewTaskScopedToDepartment } from "@/lib/access";
import {
  listClientCompletedTasks,
  listClientEodUpdates,
  listClientMeetings,
  listClientRecentEmails,
  type ToolContext
} from "@/lib/ai-tools";
import { coerceMeetingBrief, type MeetingBrief } from "@/lib/meeting-brief";
import type { User } from "@/lib/types";

const MS_DAY = 86_400_000;

export interface PrepCompletedTask {
  title: string;
  description: string | null;
  priority: string | null;
  completedAt: string | null;
  completedBy: string | null;
  tags: string[];
}
export interface PrepOpenTask {
  title: string;
  status: string;
  priority: string | null;
  dueDate: string | null;
  blocks: number;
}
export interface PrepMeeting {
  title: string;
  meetingDate: string;
  summary: string | null;
  brief: MeetingBrief;
}
export interface PrepEodUpdate {
  filedBy: string | null;
  message: string;
  noteDate: string;
}
export interface PrepEmailThread {
  subject: string;
  latestDirection: string;
  latestSnippet: string;
  lastAt: string;
  satisfactionScore: number | null;
}

export interface MeetingPrepBundle {
  clientId: string;
  clientName: string;             // "" when the client id didn't resolve
  lastMeetingDate: string | null;
  sinceISO: string;
  sinceDays: number;
  completedTasks: PrepCompletedTask[];
  openTasks: PrepOpenTask[];
  meetings: PrepMeeting[];
  eodUpdates: PrepEodUpdate[];
  emails: { accessible: boolean; note: string | null; threads: PrepEmailThread[] };
  sourceCounts: {
    completedTasks: number;
    openTasks: number;
    meetings: number;
    eodUpdates: number;
    emailThreads: number;
  };
  warnings: string[];
}

// The synthesized, user-facing brief the prep route returns: five sections
// of short bullet strings plus a one-line headline. `sources`/`warnings`
// let the panel explain why a section is thin (e.g. emails unavailable).
export interface MeetingPrepBrief {
  headline: string;
  completedSinceLastMeeting: string[];
  openItems: string[];
  risksAndBlockers: string[];
  clientRequests: string[];
  suggestedDiscussionPoints: string[];
  sources: MeetingPrepBundle["sourceCounts"];
  warnings: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const objArr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Open (non-done) tasks for a client, gated by the same department scope
// as the completed-tasks handler — copies the proven query shape from the
// `getClient` Ask-AI handler so open tasks never leak another team's work.
async function gatherOpenTasks(clientName: string, ctx: ToolContext): Promise<PrepOpenTask[]> {
  const supabase = getSupabaseAdmin();
  const [{ data: rows }, leaderIds] = await Promise.all([
    supabase
      .from("tasks")
      .select(
        "id, title, status, priority, due_date, blocks_task_ids, assignee_id, creator_id, department_id"
      )
      .eq("client_name", clientName)
      .neq("status", "done")
      .is("deleted_at", null)
      .is("archived_at", null)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(25),
    getLeaderIds()
  ]);

  return ((rows ?? []) as Array<{
    title: string;
    status: string;
    priority: string | null;
    due_date: string | null;
    blocks_task_ids: string[] | null;
    assignee_id: string | null;
    creator_id: string | null;
    department_id: string | null;
  }>)
    .filter((r) =>
      canViewTaskScopedToDepartment(
        ctx.actor,
        {
          assigneeId: r.assignee_id ?? null,
          creatorId: r.creator_id ?? "",
          departmentId: r.department_id ?? null
        },
        leaderIds
      )
    )
    .map((r) => ({
      title: r.title,
      status: r.status,
      priority: r.priority,
      dueDate: r.due_date,
      blocks: Array.isArray(r.blocks_task_ids) ? r.blocks_task_ids.length : 0
    }));
}

export async function gatherMeetingContext(args: {
  clientId: string;
  actor: User;
}): Promise<MeetingPrepBundle> {
  const { clientId, actor } = args;
  const supabase = getSupabaseAdmin();
  const warnings: string[] = [];

  // Canonical client name — tasks join by client_name, not id.
  const { data: clientRow } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", clientId)
    .maybeSingle();
  const clientName = (clientRow?.name as string | undefined) ?? "";

  // Newest prior meeting → the window cutoff for "since last meeting".
  let lastMeetingDate: string | null = null;
  if (clientName) {
    const { data: lastMtg, error: mtgErr } = await supabase
      .from("client_meetings")
      .select("meeting_date")
      .eq("client_id", clientId)
      .order("meeting_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!mtgErr && lastMtg?.meeting_date) lastMeetingDate = lastMtg.meeting_date as string;
  }

  const now = Date.now();
  const lastMs = lastMeetingDate ? new Date(lastMeetingDate).getTime() : NaN;
  // Cap the lookback at 60 days so a stale "last meeting" doesn't pull a
  // giant window; fall back to 21 days when there's no prior meeting.
  const sinceMs = Number.isFinite(lastMs)
    ? Math.max(lastMs, now - 60 * MS_DAY)
    : now - 21 * MS_DAY;
  const sinceISO = new Date(sinceMs).toISOString();
  const sinceDays = Math.max(1, Math.round((now - sinceMs) / MS_DAY));

  if (!clientName) {
    return {
      clientId,
      clientName: "",
      lastMeetingDate,
      sinceISO,
      sinceDays,
      completedTasks: [],
      openTasks: [],
      meetings: [],
      eodUpdates: [],
      emails: { accessible: false, note: null, threads: [] },
      sourceCounts: { completedTasks: 0, openTasks: 0, meetings: 0, eodUpdates: 0, emailThreads: 0 },
      warnings: ["client not found"]
    };
  }

  const ctx: ToolContext = { actor, proposals: [] };

  // All five sources concurrently. allSettled (not all): the email source
  // reaches missiveclone and can be slow or throw — one failing source must
  // never sink the whole brief. Meetings use sinceDays:0 (all-time, newest
  // few) so the last meeting's brief is never excluded by the window.
  const [completedR, openR, meetingsR, eodR, emailsR] = await Promise.allSettled([
    listClientCompletedTasks({ clientId, sinceDays, limit: 40 }, ctx),
    gatherOpenTasks(clientName, ctx),
    listClientMeetings({ clientId, sinceDays: 0, limit: 5 }),
    listClientEodUpdates({ clientId, sinceDays, limit: 20 }),
    listClientRecentEmails({ clientId, limit: 8 }, ctx)
  ]);

  // --- completed tasks ---
  let completedTasks: PrepCompletedTask[] = [];
  if (completedR.status === "fulfilled") {
    const v = completedR.value as Record<string, unknown>;
    if (typeof v.error === "string") warnings.push(`completed tasks: ${v.error}`);
    else
      completedTasks = objArr(v.tasks).map((t) => ({
        title: str(t.title),
        description: strOrNull(t.description),
        priority: strOrNull(t.priority),
        completedAt: strOrNull(t.completedAt),
        completedBy: strOrNull(t.completedBy),
        tags: strArr(t.tags)
      }));
  } else {
    warnings.push(`completed tasks unavailable: ${reason(completedR.reason)}`);
  }

  // --- open tasks ---
  let openTasks: PrepOpenTask[] = [];
  if (openR.status === "fulfilled") openTasks = openR.value;
  else warnings.push(`open tasks unavailable: ${reason(openR.reason)}`);

  // --- prior meetings ---
  let meetings: PrepMeeting[] = [];
  if (meetingsR.status === "fulfilled") {
    const v = meetingsR.value as Record<string, unknown>;
    if (typeof v.error === "string") warnings.push(`meetings: ${v.error}`);
    else {
      if (typeof v.note === "string") warnings.push(v.note);
      meetings = objArr(v.meetings).map((m) => ({
        title: str(m.title),
        meetingDate: str(m.meetingDate),
        summary: strOrNull(m.summary),
        brief: coerceMeetingBrief(m.brief)
      }));
    }
  } else {
    warnings.push(`meetings unavailable: ${reason(meetingsR.reason)}`);
  }

  // --- EOD client updates ---
  let eodUpdates: PrepEodUpdate[] = [];
  if (eodR.status === "fulfilled") {
    const v = eodR.value as Record<string, unknown>;
    if (typeof v.error === "string") warnings.push(`client updates: ${v.error}`);
    else
      eodUpdates = objArr(v.updates).map((u) => ({
        filedBy: strOrNull(u.filedBy),
        message: str(u.message),
        noteDate: str(u.noteDate)
      }));
  } else {
    warnings.push(`client updates unavailable: ${reason(eodR.reason)}`);
  }

  // --- recent emails (inbox-scoped) ---
  const emails: MeetingPrepBundle["emails"] = { accessible: false, note: null, threads: [] };
  if (emailsR.status === "fulfilled") {
    const v = emailsR.value as Record<string, unknown>;
    if (typeof v.error === "string") {
      warnings.push(`emails: ${v.error}`);
      emails.note = v.error;
    } else if (v.accessDenied === true) {
      emails.note = strOrNull(v.note) ?? "no inbox access for this client";
    } else {
      // accessible: either threads present, or a benign "no label yet" note.
      emails.accessible = true;
      emails.note = strOrNull(v.note);
      emails.threads = objArr(v.threads).map((t) => ({
        subject: str(t.subject) || "(no subject)",
        latestDirection: str(t.latestDirection),
        latestSnippet: str(t.latestSnippet),
        lastAt: str(t.lastAt),
        satisfactionScore: numOrNull(t.satisfactionScore)
      }));
    }
  } else {
    warnings.push(`emails unavailable: ${reason(emailsR.reason)}`);
    emails.note = reason(emailsR.reason);
  }

  return {
    clientId,
    clientName,
    lastMeetingDate,
    sinceISO,
    sinceDays,
    completedTasks,
    openTasks,
    meetings,
    eodUpdates,
    emails,
    sourceCounts: {
      completedTasks: completedTasks.length,
      openTasks: openTasks.length,
      meetings: meetings.length,
      eodUpdates: eodUpdates.length,
      emailThreads: emails.threads.length
    },
    warnings
  };
}
