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
  // Users with clock_enabled=false are salaried / on-call roles that
  // don't punch in. Dashboard hides the shift pill for them — keeps
  // the row clean instead of perpetually reading "off shift".
  clockEnabled: boolean;
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
    .select("id, name, avatar_url, role, clock_enabled")
    .order("name", { ascending: true })
    .limit(limit);
  const usersRes = await (
    scopedDepartmentIds && scopedDepartmentIds.length > 0 && userIds.length > 0
      ? baseQuery.in("id", userIds)
      : baseQuery
  );
  const users = (usersRes.data ?? []) as Array<{
    id: string; name: string | null; avatar_url: string | null; role: string;
    clock_enabled: boolean | null;
  }>;

  if (users.length === 0) return [];
  const ids = users.map((u) => u.id);

  // 2) Live signals — clock segments still open, EOD notes submitted
  //    today, overdue tasks per user. All batched.
  const today = new Date().toISOString().slice(0, 10);
  void todayIso; // kept for readability of the older block; unused now
  const [clockRes, eodRes, overdueRes] = await Promise.all([
    // Time-clock state lives in `time_entries` (one row per shift
    // segment; ended_at IS NULL means the user is currently on shift).
    // Earlier code read from `clock_segments` which doesn't exist —
    // the query 500'd silently, so the `clockedIn` set ended up empty
    // for EVERY user, and the dashboard showed "off shift" for everyone
    // on the team even when half of them were actively punched in.
    supabase
      .from("time_entries")
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
      overdueCount: overdueByUser.get(u.id) ?? 0,
      // Default true matches the column default — only the rows that
      // got explicitly flipped off (heads, salaried) report false.
      clockEnabled: u.clock_enabled !== false
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

// Leader "pulse" feed — unified, chronologically-sorted list of moves
// that matter today across the agency. Pulls from four sources and
// flattens to a common shape so the UI can render them in one card:
//
//   • SEO report request opened (task tagged 'seo-report-request')
//   • Task handed off (task_handoffs)
//   • Stalled task (status != done, last_activity_at > 7d ago)
//   • Site health alert (site_health_alerts)
//
// Each source is queried with a cheap LIMIT; we then merge + sort
// client-side by timestamp desc, capped at `total`. Best-effort —
// per-table errors don't break the whole feed.
export type PulseKind = "seo_report" | "handoff" | "stalled" | "site_alert";
export interface PulseEvent {
  id: string;             // unique within the feed
  kind: PulseKind;
  // Render fields — every kind populates these so the UI doesn't need
  // to branch on kind for layout.
  title: string;          // primary line
  detail: string | null;  // secondary line
  href: string;           // deep-link the row navigates to
  at: string;             // ISO timestamp used for sort + display
}

export async function getLeaderPulse(opts: {
  scopedDepartmentIds?: string[] | null;
  total?: number;
} = {}): Promise<PulseEvent[]> {
  const supabase = getSupabaseAdmin();
  const total = opts.total ?? 12;
  const events: PulseEvent[] = [];

  const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const stalledCutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1) SEO report requests opened (tagged tasks)
  try {
    const { data } = await supabase
      .from("tasks")
      .select("id, title, client_name, created_at, status")
      .contains("tags", ["seo-report-request"])
      .neq("status", "done")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(8);
    for (const r of (data ?? []) as Array<{ id: string; title: string | null; client_name: string | null; created_at: string }>) {
      events.push({
        id: `seo:${r.id}`,
        kind: "seo_report",
        title: r.title || "SEO report request",
        detail: r.client_name ? `for ${r.client_name}` : null,
        href: `/tasks/${r.id}`,
        at: r.created_at
      });
    }
  } catch { /* feed source missing — skip */ }

  // 2) Task handoffs (most recent)
  try {
    const { data } = await supabase
      .from("task_handoffs")
      .select("id, task_id, from_user_id, to_user_id, reason, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(10);
    const handoffs = (data ?? []) as Array<{ id: string; task_id: string; from_user_id: string | null; to_user_id: string | null; reason: string | null; created_at: string }>;
    // Batch lookups so we can show "X → Y on task Title"
    const userIds = new Set<string>();
    for (const h of handoffs) {
      if (h.from_user_id) userIds.add(h.from_user_id);
      if (h.to_user_id) userIds.add(h.to_user_id);
    }
    const taskIds = handoffs.map((h) => h.task_id).filter(Boolean);
    const [{ data: users }, { data: tasks }] = await Promise.all([
      userIds.size > 0
        ? supabase.from("users").select("id, name").in("id", Array.from(userIds))
        : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
      taskIds.length > 0
        ? supabase.from("tasks").select("id, title, client_name").in("id", taskIds)
        : Promise.resolve({ data: [] as { id: string; title: string | null; client_name: string | null }[] })
    ]);
    const nameById = new Map((users ?? []).map((u) => [u.id, u.name ?? "Someone"]));
    const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));
    for (const h of handoffs) {
      const t = taskById.get(h.task_id);
      if (!t) continue;
      const from = h.from_user_id ? nameById.get(h.from_user_id) ?? "Someone" : "Unassigned";
      const to = h.to_user_id ? nameById.get(h.to_user_id) ?? "Someone" : "Unassigned";
      events.push({
        id: `handoff:${h.id}`,
        kind: "handoff",
        title: t.title ?? "Task handed off",
        detail: `${from} → ${to}${t.client_name ? ` · ${t.client_name}` : ""}`,
        href: `/tasks/${h.task_id}`,
        at: h.created_at
      });
    }
  } catch { /* skip */ }

  // 3) Stalled tasks — assigned, in-flight, no activity in 7d
  try {
    const { data } = await supabase
      .from("tasks")
      .select("id, title, client_name, assignee_id, last_activity_at, status")
      .neq("status", "done")
      .eq("is_draft", false)
      .lt("last_activity_at", stalledCutoffIso)
      .not("assignee_id", "is", null)
      .order("last_activity_at", { ascending: true })
      .limit(6);
    const rows = (data ?? []) as Array<{ id: string; title: string | null; client_name: string | null; assignee_id: string | null; last_activity_at: string }>;
    const userIds = new Set<string>();
    for (const r of rows) if (r.assignee_id) userIds.add(r.assignee_id);
    const { data: users } = userIds.size > 0
      ? await supabase.from("users").select("id, name").in("id", Array.from(userIds))
      : { data: [] as { id: string; name: string | null }[] };
    const nameById = new Map((users ?? []).map((u) => [u.id, u.name ?? "Someone"]));
    for (const r of rows) {
      const days = Math.floor(
        (Date.now() - new Date(r.last_activity_at).getTime()) / 86_400_000
      );
      events.push({
        id: `stalled:${r.id}`,
        kind: "stalled",
        title: r.title || "Untitled task",
        detail: `${r.assignee_id ? nameById.get(r.assignee_id) ?? "Someone" : "Unassigned"} · ${days}d quiet${r.client_name ? ` · ${r.client_name}` : ""}`,
        href: `/tasks/${r.id}`,
        at: r.last_activity_at
      });
    }
  } catch { /* skip */ }

  // 4) Site health alerts
  try {
    const { data } = await supabase
      .from("site_health_alerts")
      .select("id, website, domain, site_score, task_id, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(6);
    for (const r of (data ?? []) as Array<{ id: string; website: string | null; domain: string | null; site_score: number; task_id: string | null; created_at: string }>) {
      events.push({
        id: `site:${r.id}`,
        kind: "site_alert",
        title: `${r.domain ?? r.website ?? "Site"} scored ${r.site_score}`,
        detail: r.task_id ? "Auto-task opened" : "No task created",
        href: r.task_id ? `/tasks/${r.task_id}` : "/clients",
        at: r.created_at
      });
    }
  } catch { /* skip */ }

  // Sort by `at` desc and cap.
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return events.slice(0, total);
}

// SEO briefs from leadership, for the /home card shown to dep_seo users.
// Returns every active client that has a seo_brief set, truncated to
// ~280 chars so the card stays scannable. Ordered by recently-updated
// briefs first (those are the ones most likely to be acted on).
export interface HomeSeoBriefRow {
  clientId: string;
  clientName: string;
  brief: string;
  updatedAt: string | null;
}

export async function getSeoBriefsForHome(limit = 20): Promise<HomeSeoBriefRow[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, status, seo_brief, seo_brief_at")
    .not("seo_brief", "is", null)
    .or("status.eq.active,status.is.null")
    .order("seo_brief_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return [];
  type Row = { id: string; name: string; status: string | null; seo_brief: string | null; seo_brief_at: string | null };
  return ((data ?? []) as unknown as Row[])
    .filter((r) => (r.seo_brief ?? "").trim().length > 0)
    .map<HomeSeoBriefRow>((r) => {
      const brief = (r.seo_brief ?? "").trim();
      return {
        clientId: r.id,
        clientName: r.name,
        brief: brief.length > 280 ? brief.slice(0, 280) + "…" : brief,
        updatedAt: r.seo_brief_at ?? null
      };
    });
}

export async function getClientHealthOverview(topN = 10): Promise<ClientHealthRow[]> {
  const supabase = getSupabaseAdmin();
  // The clients table column was renamed last_outbound_email_at →
  // last_outbound_email_at_external during the touchpoint-sync rollout.
  // The old name caused this query to 500 silently, which is why the
  // home dashboard kept reading "No active clients yet" even though
  // the team had 20+ live clients on file.
  //
  // Selection rule the user wants:
  //   - Top N clients by display_order (the canonical priority sort
  //     used everywhere else, lower = higher priority).
  //   - PLUS any client at risk (red touchpoint), even if outside
  //     the top-N band. So an important client that's going cold
  //     never falls off this dashboard just because they're not in
  //     the priority top 10.
  const { data, error } = await supabase
    .from("clients")
    .select(
      "id, name, contact_name, status, touchpoint_override_label, " +
      "last_outbound_email_at_external, encourage_emails, display_order"
    );
  if (error) return [];

  const now = new Date();
  // Supabase generic-error types confuse the inference here; cast via
  // unknown so we can land on the row shape we actually selected.
  const rows = ((data ?? []) as unknown as Array<{
    id: string;
    name: string;
    contact_name: string | null;
    status: string | null;
    touchpoint_override_label: TouchpointLabel | null;
    last_outbound_email_at_external: string | null;
    encourage_emails: boolean | null;
    display_order: number | null;
  }>)
    .filter((c) => !c.status || c.status === "active")
    .filter((c) => c.encourage_emails !== false)
    .map((c) => {
      const lastAt = c.last_outbound_email_at_external;
      const { label, isOverride } = effectiveTouchpoint(c.touchpoint_override_label, lastAt);
      const daysSince = lastAt
        ? Math.max(0, Math.floor((now.getTime() - new Date(lastAt).getTime()) / 86_400_000))
        : null;
      return {
        id: c.id,
        name: c.name,
        contactName: c.contact_name,
        touchpoint: label,
        isOverride,
        lastOutboundEmailAt: lastAt,
        daysSinceLastEmail: daysSince,
        displayOrder: c.display_order ?? Number.MAX_SAFE_INTEGER
      };
    });

  // Build the union: top-N by display_order + every red.
  const byPriority = [...rows].sort((a, b) => a.displayOrder - b.displayOrder);
  const topByPriority = byPriority.slice(0, topN);
  const reds = rows.filter((r) => r.touchpoint === "red");

  const seen = new Set<string>();
  const union: typeof rows = [];
  for (const r of [...reds, ...topByPriority]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    union.push(r);
  }

  // Final order: red first (stalest first), then yellow, then green.
  // Within each band, fall back to display_order so top-priority
  // clients win the tie inside the green band.
  const tone: Record<TouchpointLabel, number> = { red: 0, yellow: 1, green: 2 };
  union.sort((a, b) => {
    const t = tone[a.touchpoint] - tone[b.touchpoint];
    if (t !== 0) return t;
    if (a.touchpoint === "red") {
      const ad = a.lastOutboundEmailAt ? new Date(a.lastOutboundEmailAt).getTime() : 0;
      const bd = b.lastOutboundEmailAt ? new Date(b.lastOutboundEmailAt).getTime() : 0;
      if (ad !== bd) return ad - bd;
    }
    return a.displayOrder - b.displayOrder;
  });

  // Strip the internal displayOrder field before returning.
  return union.map<ClientHealthRow>(({ displayOrder: _d, ...rest }) => rest);
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
