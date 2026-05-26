import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  effectiveTouchpoint,
  type TouchpointLabel
} from "@/lib/client-touchpoint";

// Server-side queries for the /home landing surface. Each function
// returns plain JSON-shaped data so server components can pass it
// straight into client components without serialization headaches.

export interface HomeTask {
  id: string;
  title: string;
  status: string;
  priority: "low" | "medium" | "high" | "critical";
  dueDate: string | null;
  // Set when the row came in via the "due today / in progress" filter
  // so the worker view can group/sort against it.
  isInProgress: boolean;
}

export interface HomeTeammate {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  clockedIn: boolean;
  eodSubmitted: boolean;
  overdueCount: number;
}

const PRI_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Day-window helpers. We treat "today" as the local day for the
// server (UTC on Vercel) — the cron treats EOD windows the same way
// so this stays consistent.
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfTomorrow(): Date {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

// Today's plate for one user. Picks rows where they're the assignee
// AND the task is either due today, in progress, or pending+no-due-
// date (so brand-new tasks still surface). Sorted by due-date asc,
// then priority. Capped at 8 — the cap is a deliberate UX choice
// (the whole point of /home is "show me my work, not all my work").
export async function getTodayTasksForUser(userId: string, limit = 8): Promise<HomeTask[]> {
  const supabase = getSupabaseAdmin();
  const todayIso = startOfToday().toISOString();
  const tomorrowIso = startOfTomorrow().toISOString();

  // Pull two slices in one round-trip:
  //   1) in_progress or urgent — always relevant
  //   2) due today (any non-done status)
  // Union client-side; Supabase doesn't do OR across columns + ranges
  // cleanly via the builder.
  const [inProgressRes, dueTodayRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .eq("assignee_id", userId)
      .eq("is_draft", false)
      .in("status", ["in_progress", "urgent"])
      .limit(20),
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .eq("assignee_id", userId)
      .eq("is_draft", false)
      .neq("status", "done")
      .gte("due_date", todayIso)
      .lt("due_date", tomorrowIso)
      .limit(20)
  ]);

  type Row = {
    id: string; title: string; status: string;
    priority: string; due_date: string | null;
  };
  const byId = new Map<string, HomeTask>();
  for (const r of (inProgressRes.data ?? []) as Row[]) {
    byId.set(r.id, {
      id: r.id, title: r.title, status: r.status,
      priority: (r.priority as HomeTask["priority"]) ?? "medium",
      dueDate: r.due_date, isInProgress: true
    });
  }
  for (const r of (dueTodayRes.data ?? []) as Row[]) {
    if (!byId.has(r.id)) {
      byId.set(r.id, {
        id: r.id, title: r.title, status: r.status,
        priority: (r.priority as HomeTask["priority"]) ?? "medium",
        dueDate: r.due_date, isInProgress: r.status === "in_progress"
      });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      const da = a.dueDate ? +new Date(a.dueDate) : Infinity;
      const db = b.dueDate ? +new Date(b.dueDate) : Infinity;
      if (da !== db) return da - db;
      return (PRI_RANK[a.priority] ?? 9) - (PRI_RANK[b.priority] ?? 9);
    })
    .slice(0, limit);
}

// "Did this user submit their EOD today?" Used for the worker EOD
// nudge banner and for the leader's team status grid. Source of
// truth is eod_notes.submitted_at not-null on the row keyed by today's
// note_date. Returns null on error so the page still renders.
export async function getEodSubmittedTodayForUser(userId: string): Promise<boolean | null> {
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const { data, error } = await supabase
      .from("eod_notes")
      .select("submitted_at")
      .eq("user_id", userId)
      .eq("note_date", today)
      .not("submitted_at", "is", null)
      .maybeSingle();
    if (error) return null;
    return !!data;
  } catch {
    return null;
  }
}

// Day Bookends status — feeds the pinned card at the top of /home that
// shows where the user stands on today's SOD + EOD submissions.
// Both tables share the same shape: (user_id, note_date YYYY-MM-DD,
// submitted_at timestamptz). Wrapped in try/catch per table so a
// missing migration doesn't crash the whole landing surface.
export interface DayBookendStatus {
  sod: { submittedAt: string | null; submitted: boolean };
  eod: { submittedAt: string | null; submitted: boolean };
}

export async function getDayBookendStatus(userId: string): Promise<DayBookendStatus> {
  const supabase = getSupabaseAdmin();
  const today = new Date().toISOString().slice(0, 10);

  async function readOne(table: "sod_notes" | "eod_notes"): Promise<{ submittedAt: string | null; submitted: boolean }> {
    try {
      const { data, error } = await supabase
        .from(table)
        .select("submitted_at")
        .eq("user_id", userId)
        .eq("note_date", today)
        .maybeSingle();
      if (error) return { submittedAt: null, submitted: false };
      const submittedAt = (data?.submitted_at as string | null) ?? null;
      return { submittedAt, submitted: !!submittedAt };
    } catch {
      return { submittedAt: null, submitted: false };
    }
  }

  const [sod, eod] = await Promise.all([readOne("sod_notes"), readOne("eod_notes")]);
  return { sod, eod };
}

// Team status grid for the leader/head view. Lists every active user
// scoped to `departmentIds` (or all if undefined). For each one,
// surfaces: clocked-in right now, EOD submitted today, overdue task
// count. Cheap-ish — single round-trip per signal then joined in
// memory. Capped at 60 people; if anyone has more reports than that
// they probably need a different view anyway.
export async function getTeamStatusToday(
  scopedDepartmentIds?: string[],
  limit = 60
): Promise<HomeTeammate[]> {
  const supabase = getSupabaseAdmin();
  const todayIso = startOfToday().toISOString();
  const nowIso = new Date().toISOString();

  // 1) Scope the user roster. When scopedDepartmentIds is provided
  //    we use department_members to filter; otherwise we pull every
  //    non-leader (leaders are managers, not on the floor).
  let userIds: string[] = [];
  if (scopedDepartmentIds && scopedDepartmentIds.length > 0) {
    const { data: memberships } = await supabase
      .from("department_members")
      .select("user_id")
      .in("department_id", scopedDepartmentIds);
    userIds = Array.from(new Set(
      ((memberships ?? []) as { user_id: string }[]).map((m) => m.user_id)
    ));
  }

  const baseQuery = supabase
    .from("users")
    .select("id, name, avatar_url, role")
    .order("name", { ascending: true })
    .limit(limit);
  const usersRes = await (
    scopedDepartmentIds && scopedDepartmentIds.length > 0 && userIds.length > 0
      ? baseQuery.in("id", userIds)
      : baseQuery
  );
  const users = (usersRes.data ?? []) as Array<{
    id: string; name: string | null; avatar_url: string | null; role: string;
  }>;

  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);

  // 2) Live signals — clock segments still open, EOD notes submitted
  //    today, overdue tasks per user. All batched.
  const today = new Date().toISOString().slice(0, 10);
  void todayIso; // kept for readability of the older block; unused now
  const [clockRes, eodRes, overdueRes] = await Promise.all([
    supabase
      .from("clock_segments")
      .select("user_id")
      .in("user_id", ids)
      .is("ended_at", null),
    supabase
      .from("eod_notes")
      .select("user_id")
      .in("user_id", ids)
      .eq("note_date", today)
      .not("submitted_at", "is", null),
    supabase
      .from("tasks")
      .select("assignee_id")
      .in("assignee_id", ids)
      .eq("is_draft", false)
      .neq("status", "done")
      .lt("due_date", nowIso)
  ]);

  const clockedIn = new Set<string>(
    ((clockRes.data ?? []) as { user_id: string }[]).map((r) => r.user_id)
  );
  const eodToday = new Set<string>(
    ((eodRes.data ?? []) as { user_id: string }[]).map((r) => r.user_id)
  );
  const overdueByUser = new Map<string, number>();
  for (const r of ((overdueRes.data ?? []) as { assignee_id: string | null }[])) {
    if (!r.assignee_id) continue;
    overdueByUser.set(r.assignee_id, (overdueByUser.get(r.assignee_id) ?? 0) + 1);
  }

  return users
    .filter((u) => u.name && u.role !== "leader")
    .map<HomeTeammate>((u) => ({
      userId: u.id,
      name: u.name as string,
      avatarUrl: u.avatar_url,
      role: u.role,
      clockedIn: clockedIn.has(u.id),
      eodSubmitted: eodToday.has(u.id),
      overdueCount: overdueByUser.get(u.id) ?? 0
    }));
}

// Cross-team list of "what's due today, still open" — the leader's
// at-a-glance ship list. Scoped via scopedDepartmentIds for heads.
// Picks assignee_id ∈ scoped users (or all). Capped at 20.
export async function getTodayDeliverables(
  scopedDepartmentIds?: string[],
  limit = 20
): Promise<Array<HomeTask & { assigneeId: string | null; assigneeName: string | null }>> {
  const supabase = getSupabaseAdmin();
  const todayIso = startOfToday().toISOString();
  const tomorrowIso = startOfTomorrow().toISOString();

  // Scope by assignee membership if a dept filter is set.
  let assigneeFilter: string[] | null = null;
  if (scopedDepartmentIds && scopedDepartmentIds.length > 0) {
    const { data: memberships } = await supabase
      .from("department_members")
      .select("user_id")
      .in("department_id", scopedDepartmentIds);
    assigneeFilter = Array.from(new Set(
      ((memberships ?? []) as { user_id: string }[]).map((m) => m.user_id)
    ));
    if (assigneeFilter.length === 0) return [];
  }

  let query = supabase
    .from("tasks")
    .select("id, title, status, priority, due_date, assignee_id")
    .eq("is_draft", false)
    .neq("status", "done")
    .gte("due_date", todayIso)
    .lt("due_date", tomorrowIso)
    .order("due_date", { ascending: true })
    .limit(limit);
  if (assigneeFilter) query = query.in("assignee_id", assigneeFilter);

  const { data, error } = await query;
  if (error) return [];

  const rows = (data ?? []) as Array<{
    id: string; title: string; status: string; priority: string;
    due_date: string | null; assignee_id: string | null;
  }>;
  if (rows.length === 0) return [];

  const assigneeIds = Array.from(new Set(
    rows.map((r) => r.assignee_id).filter((v): v is string => !!v)
  ));
  const namesById = new Map<string, string>();
  if (assigneeIds.length > 0) {
    const { data: nameRows } = await supabase
      .from("users")
      .select("id, name")
      .in("id", assigneeIds);
    for (const u of ((nameRows ?? []) as { id: string; name: string | null }[])) {
      namesById.set(u.id, u.name ?? "—");
    }
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    priority: (r.priority as HomeTask["priority"]) ?? "medium",
    dueDate: r.due_date,
    isInProgress: r.status === "in_progress",
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_id ? namesById.get(r.assignee_id) ?? null : null
  }));
}

// Client health snapshot for /home leader view. Returns active clients
// sorted by stalest-first (longest gap since the last outbound email),
// with their effective touchpoint label (manual override > computed
// from last_outbound_email_at). Capped at `limit` — the home strip is
// a "what needs attention" surface, not the full /clients list.
export interface ClientHealthRow {
  id: string;
  name: string;
  contactName: string | null;
  touchpoint: TouchpointLabel;
  isOverride: boolean;
  lastOutboundEmailAt: string | null;
  daysSinceLastEmail: number | null;
}

export async function getClientHealthOverview(limit = 8): Promise<ClientHealthRow[]> {
  const supabase = getSupabaseAdmin();
  // active-only — paused/archived clients shouldn't generate
  // "you haven't emailed them" noise. Same for clients with
  // encourage_emails=false (per-client opt-out).
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, contact_name, status, touchpoint_override_label, last_outbound_email_at, encourage_emails")
    .order("last_outbound_email_at", { ascending: true, nullsFirst: true });
  if (error) return [];

  const now = new Date();
  const rows = ((data ?? []) as Array<{
    id: string;
    name: string;
    contact_name: string | null;
    status: string | null;
    touchpoint_override_label: TouchpointLabel | null;
    last_outbound_email_at: string | null;
    encourage_emails: boolean | null;
  }>)
    .filter((c) => !c.status || c.status === "active")
    .filter((c) => c.encourage_emails !== false)
    .map<ClientHealthRow>((c) => {
      const { label, isOverride } = effectiveTouchpoint(
        c.touchpoint_override_label, c.last_outbound_email_at
      );
      const daysSince = c.last_outbound_email_at
        ? Math.max(0, Math.floor((now.getTime() - new Date(c.last_outbound_email_at).getTime()) / 86_400_000))
        : null;
      return {
        id: c.id,
        name: c.name,
        contactName: c.contact_name,
        touchpoint: label,
        isOverride,
        lastOutboundEmailAt: c.last_outbound_email_at,
        daysSinceLastEmail: daysSince
      };
    });

  // Prioritise red → yellow → green, then stalest first inside each band.
  // Cleaner signal than raw stalest sort — keeps reds at top even if a
  // green has somehow gone older (edge case from manual overrides).
  const tone: Record<TouchpointLabel, number> = { red: 0, yellow: 1, green: 2 };
  rows.sort((a, b) => {
    const t = tone[a.touchpoint] - tone[b.touchpoint];
    if (t !== 0) return t;
    const ad = a.lastOutboundEmailAt ? new Date(a.lastOutboundEmailAt).getTime() : 0;
    const bd = b.lastOutboundEmailAt ? new Date(b.lastOutboundEmailAt).getTime() : 0;
    return ad - bd;
  });

  return rows.slice(0, limit);
}

// "Needs you" counters for the leader strip. Mirrors what the badge
// endpoint returns but as a typed object the server component can
// consume directly. We pull from the same primitives the badge
// endpoint uses to keep numbers consistent.
export interface NeedsYouCounts {
  approvalsPending: number;
  inboxesUnread: number;
  peopleEodPending: number;
}

// Server-side fetch for the leader strip. Inboxes unread comes from
// the existing /api/notifications/badges endpoint (it already has the
// missive integration baked in); approvals + EOD pending we compute
// directly from supabase here. Wrapped in best-effort try/catches so
// the page renders even if a single signal is unreachable.
export async function getNeedsYouCounts(args: {
  canApprove: boolean;
  visibleDepartmentIds: string[] | null; // null = "see all depts"
  hourLocal: number;                      // skip EOD count before 5pm
  inboxesUnread?: number;                 // pre-fetched, if available
}): Promise<NeedsYouCounts> {
  const supabase = getSupabaseAdmin();

  // Approvals — count pending email_drafts the caller can act on.
  // The /approvals page surfaces the precise visibility filter; here
  // we use "all pending" for the approver pool and 0 otherwise, which
  // matches what the badge endpoint already does for the same field.
  let approvalsPending = 0;
  if (args.canApprove) {
    try {
      const { count } = await supabase
        .from("email_drafts")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      approvalsPending = count ?? 0;
    } catch { /* migration not applied */ }
  }

  // EOD pending — only meaningful after 5pm. Count members of the
  // caller's visible departments who haven't submitted today.
  let peopleEodPending = 0;
  if (args.hourLocal >= 17) {
    try {
      let visibleDeptIds = args.visibleDepartmentIds;
      if (visibleDeptIds === null) {
        const { data: deptRows } = await supabase.from("departments").select("id");
        visibleDeptIds = (deptRows ?? []).map((r) => r.id as string);
      }
      if (visibleDeptIds.length > 0) {
        const { data: members } = await supabase
          .from("department_members")
          .select("user_id")
          .in("department_id", visibleDeptIds);
        const memberIds = Array.from(new Set(
          ((members ?? []) as { user_id: string }[]).map((r) => r.user_id)
        ));
        if (memberIds.length > 0) {
          const today = new Date().toISOString().slice(0, 10);
          const { data: submitted } = await supabase
            .from("eod_notes")
            .select("user_id")
            .in("user_id", memberIds)
            .eq("note_date", today)
            .not("submitted_at", "is", null);
          const submittedSet = new Set(
            ((submitted ?? []) as { user_id: string }[]).map((r) => r.user_id)
          );
          peopleEodPending = memberIds.filter((id) => !submittedSet.has(id)).length;
        }
      }
    } catch { /* keep 0 */ }
  }

  return {
    approvalsPending,
    peopleEodPending,
    inboxesUnread: args.inboxesUnread ?? 0
  };
}
