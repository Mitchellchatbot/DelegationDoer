import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isApprover } from "@/lib/email-approvers";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { UpdateCadence } from "@/lib/eod-digest";

export const dynamic = "force-dynamic";

// GET /api/eod/digest-recommendations
//
// "Which clients are due for an EOD update, and how much work would
// it cover?" Returns one row per client with unreported completed
// work in their cadence's lookback window. Approvers use this on
// /approvals to decide where to draft next; the existing cron handles
// the on-schedule fan-out, this surface is for manual control.
//
// Auth: approver only (same gate as the rest of /approvals).
//
// Response shape:
//   {
//     today: "YYYY-MM-DD",
//     dueToday: <recommendation[]>,    // cadence says today IS a report day
//     waiting:  <recommendation[]>,    // unreported work exists but cadence-day isn't today
//   }
// Each recommendation is { clientId, clientName, cadence, unreportedTaskCount,
//   lastSentAt, lookbackStart, sampleTaskTitles[] }.

interface ClientRow {
  id: string;
  name: string;
  status: string | null;
  update_cadence: UpdateCadence | null;
  contact_emails: string[] | null;
}

interface TaskRow {
  id: string;
  title: string;
  client_name: string;
  completed_at: string | null;
}

interface SentEmailRow {
  client_name: string | null;
  sent_at: string | null;
}

export interface DigestRecommendation {
  clientId: string;
  clientName: string;
  cadence: UpdateCadence;
  cadenceDueToday: boolean;
  unreportedTaskCount: number;
  lastSentAt: string | null;
  lookbackStart: string;
  sampleTaskTitles: string[];
  hasContact: boolean;
}

// Match the day-of-week logic in lib/eod-digest.ts:isReportDay.
function isCadenceDueToday(cadence: UpdateCadence, date: Date): boolean {
  switch (cadence) {
    case "daily":    return true;
    case "biweekly": return date.getUTCDay() === 3 || date.getUTCDay() === 5;
    case "weekly":   return date.getUTCDay() === 5;
    case "monthly":  return date.getUTCDate() === 1;
    case "none":     return false;
  }
}

// Lookback window for "what work would this digest cover", per cadence.
// Daily looks back to start-of-day; weekly looks back 7 days; biweekly
// looks back to the most recent Wed/Fri (whichever came first); monthly
// looks back to the 1st of the current month. The actual reported_to_client_at
// filter ALSO narrows by "tasks never reported", so a quiet month's
// monthly digest doesn't accidentally include 30 days of already-sent work.
function lookbackStart(cadence: UpdateCadence, today: Date): Date {
  const d = new Date(today);
  switch (cadence) {
    case "daily":
      d.setUTCHours(0, 0, 0, 0);
      return d;
    case "weekly": {
      const back = new Date(d.getTime() - 7 * 86_400_000);
      back.setUTCHours(0, 0, 0, 0);
      return back;
    }
    case "biweekly": {
      // Walk backwards from today to the most recent Wed (3) or Fri (5).
      // If today IS Wed/Fri, use a day before to get a usable window.
      const day = d.getUTCDay();
      let daysBack = 1;
      while (daysBack < 8) {
        const cand = new Date(d.getTime() - daysBack * 86_400_000);
        const cd = cand.getUTCDay();
        if (cd === 3 || cd === 5) {
          cand.setUTCHours(0, 0, 0, 0);
          return cand;
        }
        daysBack += 1;
      }
      // Fallback shouldn't happen — we always hit a Wed/Fri within a week.
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - 7);
      return d;
      void day;
    }
    case "monthly": {
      const back = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      return back;
    }
    case "none":
      // Shouldn't reach here — `none` clients are filtered out before
      // we compute the window. Return today so the empty-window query
      // matches nothing.
      d.setUTCHours(0, 0, 0, 0);
      return d;
  }
}

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
      return NextResponse.json({ error: "approver only" }, { status: 403 });
    }

    const supabase = getSupabaseAdmin();
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // 1) Every active client with a non-"none" cadence — those are the
    //    candidates. We don't pre-filter to cadence-due-today since the
    //    UI shows both "due now" and "waiting" lists.
    const { data: clientRows, error: clientErr } = await supabase
      .from("clients")
      .select("id, name, status, update_cadence, contact_emails");
    if (clientErr) {
      return NextResponse.json({ error: clientErr.message }, { status: 500 });
    }
    const clients = (clientRows ?? []) as ClientRow[];
    const active = clients
      .filter((c) => !c.status || c.status === "active")
      .filter((c) => ((c.update_cadence ?? "daily") as UpdateCadence) !== "none");

    if (active.length === 0) {
      return NextResponse.json({ today: todayStr, dueToday: [], waiting: [] });
    }

    // 2) Pull unreported completed tasks per client, scoped to the
    //    widest lookback window we'll need. Subset per-client in JS
    //    below — saves N round-trips.
    //
    //    Widest = the OLDEST of monthly's "1st of current month" and
    //    weekly's "7 days ago". Early in the month the weekly window
    //    reaches further back than the monthly floor (e.g. on June 2,
    //    monthly = June 1 but weekly = May 26). Using only the monthly
    //    floor would drop late-May work from weekly clients on the
    //    floor of June.
    const monthlyFloor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const weeklyFloor = new Date(today.getTime() - 7 * 86_400_000);
    weeklyFloor.setUTCHours(0, 0, 0, 0);
    const widestFloor = monthlyFloor.getTime() < weeklyFloor.getTime()
      ? monthlyFloor
      : weeklyFloor;
    const clientNames = active.map((c) => c.name);
    const [tasksRes, sentRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, title, client_name, completed_at")
        .in("client_name", clientNames)
        .eq("status", "done")
        .is("reported_to_client_at", null)
        .gte("completed_at", widestFloor.toISOString())
        .limit(2000),
      // Last sent email per client (we order DESC + group in memory).
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

    const recommendations: DigestRecommendation[] = [];
    for (const c of active) {
      const cadence = (c.update_cadence ?? "daily") as UpdateCadence;
      const windowStart = lookbackStart(cadence, today);
      const clientTasks = tasksByClient.get(c.name) ?? [];
      const inWindow = clientTasks.filter(
        (t) => t.completed_at && new Date(t.completed_at) >= windowStart
      );
      if (inWindow.length === 0) continue;
      recommendations.push({
        clientId: c.id,
        clientName: c.name,
        cadence,
        cadenceDueToday: isCadenceDueToday(cadence, today),
        unreportedTaskCount: inWindow.length,
        lastSentAt: lastSentByClient.get(c.name) ?? null,
        lookbackStart: windowStart.toISOString(),
        sampleTaskTitles: inWindow
          .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
          .slice(0, 3)
          .map((t) => t.title),
        hasContact: (c.contact_emails?.length ?? 0) > 0
      });
    }

    // Order each bucket by count desc, then by lastSent ASC (oldest
    // first — those have been waiting longest).
    recommendations.sort((a, b) => {
      if (a.unreportedTaskCount !== b.unreportedTaskCount) {
        return b.unreportedTaskCount - a.unreportedTaskCount;
      }
      return (a.lastSentAt ?? "").localeCompare(b.lastSentAt ?? "");
    });

    const dueToday = recommendations.filter((r) => r.cadenceDueToday);
    const waiting = recommendations.filter((r) => !r.cadenceDueToday);

    return NextResponse.json({ today: todayStr, dueToday, waiting });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
