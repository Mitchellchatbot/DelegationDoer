import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isApprover } from "@/lib/email-approvers";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/eod/digest-recommendations?window=daily|weekly|biweekly|monthly
//
// "Show me who should get an EOD update in this time window." The
// caller picks the window via tab; this endpoint returns the list of
// clients with unreported completed work + the contributors' EOD
// notes for that period, ordered by how much work is sitting there.
//
// IMPORTANT: this surface intentionally does NOT consult the per-
// client update_cadence column. The window is whatever the approver
// clicked. (The cadence column still drives the nightly cron, but
// that's a separate path.)
//
// Auth: approver only.

const WINDOWS = ["daily", "weekly", "biweekly", "monthly"] as const;
export type DigestWindow = typeof WINDOWS[number];

const WINDOW_DAYS: Record<DigestWindow, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30
};

interface ClientRow {
  id: string;
  name: string;
  status: string | null;
  contact_emails: string[] | null;
}

interface TaskRow {
  id: string;
  title: string;
  client_name: string;
  completed_at: string | null;
  assignee_id: string | null;
  tags: string[] | null;
}

interface SentEmailRow {
  client_name: string | null;
  sent_at: string | null;
}

interface EodNoteRow {
  user_id: string;
  note_date: string;
  worked_on: string | null;
  accomplished: string | null;
  plan_tomorrow: string | null;
}

export interface DigestTaskDetail {
  id: string;
  title: string;
  tags: string[];
  completedAt: string | null;
  assigneeName: string | null;
}

export interface DigestEodNote {
  authorName: string;
  noteDate: string;
  workedOn: string | null;
  accomplished: string | null;
}

export interface DigestRecommendation {
  clientId: string;
  clientName: string;
  contactEmails: string[];        // forwarded so the in-place composer modal can pre-fill To
  unreportedTaskCount: number;
  lastSentAt: string | null;
  tasks: DigestTaskDetail[];      // up to 5 most recent
  eodNotes: DigestEodNote[];      // up to 5 most recent contributor notes
  contributorNames: string[];     // distinct contributors
  hasContact: boolean;
}

function isDigestWindow(s: string): s is DigestWindow {
  return (WINDOWS as readonly string[]).includes(s);
}

function windowStart(w: DigestWindow): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  if (w === "daily") return d;
  const past = new Date(d.getTime() - WINDOW_DAYS[w] * 86_400_000);
  past.setUTCHours(0, 0, 0, 0);
  return past;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
      return NextResponse.json({ error: "approver only" }, { status: 403 });
    }

    const url = new URL(req.url);
    const raw = (url.searchParams.get("window") ?? "daily").toLowerCase();
    const window: DigestWindow = isDigestWindow(raw) ? raw : "daily";
    const start = windowStart(window);
    const startIso = start.toISOString();

    const supabase = getSupabaseAdmin();

    // 1) Active clients with at least one contact_emails entry. Clients
    //    with no contact can't receive an email anyway — drop them so
    //    the recommendation list reflects what's actually actionable.
    const { data: clientRows, error: clientErr } = await supabase
      .from("clients")
      .select("id, name, status, contact_emails");
    if (clientErr) {
      return NextResponse.json({ error: clientErr.message }, { status: 500 });
    }
    const clients = ((clientRows ?? []) as ClientRow[])
      .filter((c) => !c.status || c.status === "active");
    if (clients.length === 0) {
      return NextResponse.json({ window, windowDays: WINDOW_DAYS[window], recommendations: [] });
    }

    const clientNames = clients.map((c) => c.name);
    const clientByName = new Map<string, ClientRow>();
    for (const c of clients) clientByName.set(c.name, c);

    // 2) Unreported done tasks in the window, last-sent timestamp per
    //    client. One round-trip each.
    const [tasksRes, sentRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, title, client_name, completed_at, assignee_id, tags")
        .in("client_name", clientNames)
        .eq("status", "done")
        .is("reported_to_client_at", null)
        .gte("completed_at", startIso)
        .order("completed_at", { ascending: false })
        .limit(2000),
      supabase
        .from("email_drafts")
        .select("client_name, sent_at")
        .in("client_name", clientNames)
        .eq("status", "sent")
        .not("sent_at", "is", null)
        .order("sent_at", { ascending: false })
        .limit(500)
    ]);
    const tasks = (tasksRes.data ?? []) as TaskRow[];
    const sent = (sentRes.data ?? []) as SentEmailRow[];

    const tasksByClient = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const list = tasksByClient.get(t.client_name) ?? [];
      list.push(t);
      tasksByClient.set(t.client_name, list);
    }
    const lastSentByClient = new Map<string, string>();
    for (const r of sent) {
      if (!r.client_name || !r.sent_at) continue;
      if (!lastSentByClient.has(r.client_name)) {
        lastSentByClient.set(r.client_name, r.sent_at);
      }
    }

    // 3) Pull EOD notes for the contributing assignees in the window.
    //    Single round-trip across all contributors, then bucket per
    //    client below. Limit upper bound for safety.
    const allAssignees = Array.from(new Set(
      tasks.map((t) => t.assignee_id).filter((id): id is string => !!id)
    ));
    const startDateStr = start.toISOString().slice(0, 10);
    let notes: EodNoteRow[] = [];
    let userById = new Map<string, string>(); // user_id → name
    if (allAssignees.length > 0) {
      const [notesRes, usersRes] = await Promise.all([
        supabase
          .from("eod_notes")
          .select("user_id, note_date, worked_on, accomplished, plan_tomorrow")
          .in("user_id", allAssignees)
          .gte("note_date", startDateStr)
          .order("note_date", { ascending: false })
          .limit(500),
        supabase
          .from("users")
          .select("id, name")
          .in("id", allAssignees)
      ]);
      notes = (notesRes.data ?? []) as EodNoteRow[];
      userById = new Map(
        ((usersRes.data ?? []) as { id: string; name: string }[])
          .map((u) => [u.id, u.name])
      );
    }

    // Notes are global per-user. To bucket them per client we use the
    // task-assignment graph: any contributor for a client gets their
    // EOD notes attached to that client. So a worker who closed tasks
    // for both Acme and Beta has their note visible on both rows.
    const contributorsByClient = new Map<string, Set<string>>();
    for (const t of tasks) {
      if (!t.assignee_id) continue;
      const set = contributorsByClient.get(t.client_name) ?? new Set<string>();
      set.add(t.assignee_id);
      contributorsByClient.set(t.client_name, set);
    }

    const recommendations: DigestRecommendation[] = [];
    for (const c of clients) {
      const clientTasks = tasksByClient.get(c.name) ?? [];
      if (clientTasks.length === 0) continue;

      const taskDetails: DigestTaskDetail[] = clientTasks
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          title: t.title,
          tags: t.tags ?? [],
          completedAt: t.completed_at,
          assigneeName: t.assignee_id ? (userById.get(t.assignee_id) ?? null) : null
        }));

      const contributorIds = Array.from(contributorsByClient.get(c.name) ?? []);
      const eodNotes: DigestEodNote[] = notes
        .filter((n) => contributorIds.includes(n.user_id))
        .slice(0, 5)
        .map((n) => ({
          authorName: userById.get(n.user_id) ?? "Teammate",
          noteDate: n.note_date,
          workedOn: n.worked_on,
          accomplished: n.accomplished
        }));

      const contributorNames = contributorIds
        .map((id) => userById.get(id))
        .filter((n): n is string => !!n);

      recommendations.push({
        clientId: c.id,
        clientName: c.name,
        contactEmails: c.contact_emails ?? [],
        unreportedTaskCount: clientTasks.length,
        lastSentAt: lastSentByClient.get(c.name) ?? null,
        tasks: taskDetails,
        eodNotes,
        contributorNames,
        hasContact: (c.contact_emails?.length ?? 0) > 0
      });
    }

    // Most work first, then oldest last-update (those have waited longest).
    recommendations.sort((a, b) => {
      if (a.unreportedTaskCount !== b.unreportedTaskCount) {
        return b.unreportedTaskCount - a.unreportedTaskCount;
      }
      return (a.lastSentAt ?? "").localeCompare(b.lastSentAt ?? "");
    });

    return NextResponse.json({
      window,
      windowDays: WINDOW_DAYS[window],
      recommendations
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
