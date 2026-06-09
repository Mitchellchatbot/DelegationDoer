import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  computeTouchpointLabel,
  daysSince,
  getLatestTouchpointsByClient,
  type TouchpointLabel
} from "@/lib/client-touchpoint";
import { listThreads } from "@/lib/missive-client";
import { buildClientSignals, threadMatchesClient } from "@/lib/client-thread-match";

export const dynamic = "force-dynamic";

// GET /api/sod/dashboard
//
// Returns the per-department "today at a glance" payload shown between
// the welcome modal and the SOD form. Department is resolved from the
// caller — SEO and Website have their own shape; others get null.

type HealthLabel = "thriving" | "steady" | "shaky" | "at_risk";

interface ClientRow {
  id: string;
  name: string;
  website: string | null;
  websites: string[] | null;
  contact_emails: string[] | null;
  priority: "low" | "medium" | "high" | null;
  priority_rank: number | null;
  health_label: HealthLabel | null;
  health_override_label: HealthLabel | null;
  touchpoint_override_label: TouchpointLabel | null;
}

interface SeoFollowUpItem {
  clientId: string;
  clientName: string;
  daysSinceLastOutbound: number | null;
  touchpoint: TouchpointLabel;
  health: HealthLabel | null;
}

interface SeoPayload {
  kind: "seo";
  healthCounts: Record<HealthLabel, number>;
  // Surfaced so the Client Health card can show a useful empty state
  // when health labels haven't been computed yet ("12 clients tracked
  // · health pending") instead of a blank panel.
  totalClients: number;
  followUp: SeoFollowUpItem[];
  recentOutbound: Array<{
    id: string;
    clientName: string;
    subject: string;
    sentAt: string;
  }>;
  // Team-wide client-facing work already completed today, so the
  // employee sees progress before planning the rest of the day.
  completedToday: {
    counts: {
      emailsSent: number;
      approvals: number;
      tasksCompleted: number;
      clientUpdates: number;
      meetings: number;
    };
    items: Array<{
      kind: "email" | "approval" | "task" | "update" | "meeting";
      label: string;
      at: string;
    }>;
  };
}

interface WebPayload {
  kind: "web";
  inbound: Array<{
    threadId: string;
    accountId: string | null;
    subject: string;
    clientName: string;
    lastAt: string;
    participants: string[];
  }>;
  carryOverTasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: string | null;
    clientName: string | null;
    clientPriority: "low" | "medium" | "high" | null;
  }>;
}

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "no user" }, { status: 401 });

    const deps = me.departmentIds ?? [];
    const isSeo = deps.includes("dep_seo");
    const isWeb = deps.includes("dep_web");
    if (!isSeo && !isWeb) {
      return NextResponse.json({ payload: null });
    }

    if (isSeo) {
      const payload = await buildSeoPayload(userId);
      return NextResponse.json({ payload });
    }

    const payload = await buildWebPayload(me);
    return NextResponse.json({ payload });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}

async function buildSeoPayload(userId: string): Promise<SeoPayload> {
  const supabase = getSupabaseAdmin();

  // Try the full select first; if Supabase errors with 42703 (missing
  // column) — happens when the touchpoint migration hasn't been applied
  // yet — retry without the touchpoint override column. The dashboard
  // still works without it (touchpoint just falls back to the computed
  // band from last_outbound). Logged loudly either way so we don't
  // swallow real failures.
  const FULL_COLS =
    "id, name, website, websites, contact_emails, priority, priority_rank, " +
    "health_label, health_override_label, touchpoint_override_label";
  const FALLBACK_COLS =
    "id, name, website, websites, contact_emails, priority, priority_rank, " +
    "health_label, health_override_label";
  let { data: clientRows, error: clientErr } = await supabase
    .from("clients")
    .select(FULL_COLS);
  if (clientErr) {
    console.error("[sod/dashboard] clients select failed (trying fallback):", clientErr);
    const retry = await supabase.from("clients").select(FALLBACK_COLS);
    if (retry.error) {
      console.error("[sod/dashboard] fallback also failed:", retry.error);
    } else {
      clientRows = retry.data;
      clientErr = null;
    }
  }
  const clients = ((clientRows ?? []) as unknown) as ClientRow[];

  // Health count strip — effective label = override > computed.
  const healthCounts: Record<HealthLabel, number> = {
    thriving: 0, steady: 0, shaky: 0, at_risk: 0
  };
  for (const c of clients) {
    const eff = c.health_override_label ?? c.health_label;
    if (eff && eff in healthCounts) healthCounts[eff] += 1;
  }

  // Resolve touchpoint per client using the same helper the client
  // detail page uses. One round-trip for all of them.
  const touchpoints = await getLatestTouchpointsByClient(clients.map((c) => c.id));
  const now = new Date();
  type Enriched = ClientRow & {
    lastOutboundAt: string | null;
    daysSince: number | null;
    touchpoint: TouchpointLabel;
    effectiveHealth: HealthLabel | null;
  };
  const enriched: Enriched[] = clients.map((c) => {
    const tp = touchpoints.get(c.id);
    const lastAt = tp?.lastOutboundEmailAt ?? null;
    const auto = computeTouchpointLabel(lastAt, now);
    return {
      ...c,
      lastOutboundAt: lastAt,
      daysSince: daysSince(lastAt, now),
      touchpoint: c.touchpoint_override_label ?? auto,
      effectiveHealth: c.health_override_label ?? c.health_label
    };
  });

  // Follow-up — clients in the red band, sorted by oldest last contact.
  const followUp: SeoFollowUpItem[] = enriched
    .filter((c) => c.touchpoint === "red")
    .sort((a, b) => {
      const ad = a.daysSince ?? 9999;
      const bd = b.daysSince ?? 9999;
      return bd - ad;
    })
    .slice(0, 10)
    .map((c) => ({
      clientId: c.id,
      clientName: c.name,
      daysSinceLastOutbound: c.daysSince,
      touchpoint: c.touchpoint,
      health: c.effectiveHealth
    }));

  // 5 most recent outbound sends, team-wide.
  const { data: recentDrafts } = await supabase
    .from("email_drafts")
    .select("id, client_name, subject, sent_at")
    .not("sent_at", "is", null)
    .order("sent_at", { ascending: false })
    .limit(5);
  const recentOutbound = ((recentDrafts ?? []) as Array<{
    id: string;
    client_name: string;
    subject: string;
    sent_at: string;
  }>).map((r) => ({
    id: r.id,
    clientName: r.client_name,
    subject: r.subject,
    sentAt: r.sent_at
  }));

  // What's been completed today — team-wide client-facing work, so the
  // employee sees progress already made before planning the rest of the
  // day. UTC day range matches the existing EOD/dashboard convention
  // (per-user timezone is deliberately out of scope — see lib/eod.ts).
  const completedToday = await buildCompletedToday(supabase);

  // userId is unused in v1 but kept on the signature for the future
  // "drafts pending YOUR approval" personalisation.
  void userId;

  return {
    kind: "seo",
    healthCounts,
    totalClients: clients.length,
    followUp,
    recentOutbound,
    completedToday
  };
}

// Today's [00:00, next-00:00) range in UTC. Mirrors utcDayRange() in
// lib/eod.ts so "completed today" lines up with the EOD report.
function utcDayRange(now: Date = new Date()): { startIso: string; endIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 3_600_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function buildCompletedToday(
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<SeoPayload["completedToday"]> {
  const { startIso, endIso } = utcDayRange();
  const counts = { emailsSent: 0, approvals: 0, tasksCompleted: 0, clientUpdates: 0, meetings: 0 };
  const items: SeoPayload["completedToday"]["items"] = [];

  // Tasks completed today — keyed off completed_at, the stable
  // done-transition stamp (same predicate as the EOD builder; never
  // last_activity_at, which bumps on any edit).
  try {
    const { data: tasks } = await supabase
      .from("tasks")
      .select("id, title, completed_at")
      .eq("status", "done")
      .gte("completed_at", startIso)
      .lt("completed_at", endIso);
    for (const t of (tasks ?? []) as Array<{ id: string; title: string; completed_at: string }>) {
      counts.tasksCompleted += 1;
      items.push({ kind: "task", label: t.title, at: t.completed_at });
    }
  } catch {
    /* tasks table issue — skip */
  }

  // Emails sent today (and the client_update subset). Approvals are
  // counted off approved_at, which is stamped when status leaves
  // 'pending'. One select covers all three.
  try {
    const { data: drafts } = await supabase
      .from("email_drafts")
      .select("id, client_name, subject, kind, status, sent_at, approved_at")
      .or(`sent_at.gte.${startIso},approved_at.gte.${startIso}`)
      .limit(500);
    for (const d of (drafts ?? []) as Array<{
      id: string; client_name: string | null; subject: string | null;
      kind: string; status: string; sent_at: string | null; approved_at: string | null;
    }>) {
      const sentToday = !!d.sent_at && d.sent_at >= startIso && d.sent_at < endIso;
      const approvedToday = !!d.approved_at && d.approved_at >= startIso && d.approved_at < endIso;
      const name = d.client_name ?? "—";
      if (sentToday && d.status === "sent") {
        counts.emailsSent += 1;
        if (d.kind === "client_update") {
          counts.clientUpdates += 1;
          items.push({ kind: "update", label: `${name} — ${d.subject ?? "(no subject)"}`, at: d.sent_at! });
        } else {
          items.push({ kind: "email", label: `${name} — ${d.subject ?? "(no subject)"}`, at: d.sent_at! });
        }
      }
      if (approvedToday && (d.status === "approved" || d.status === "sent")) {
        counts.approvals += 1;
        items.push({ kind: "approval", label: `${name} — ${d.subject ?? "(no subject)"}`, at: d.approved_at! });
      }
    }
  } catch {
    /* email_drafts table issue — skip */
  }

  // Meetings completed today.
  try {
    const { data: meetings } = await supabase
      .from("client_meetings")
      .select("client_id, title, meeting_date")
      .gte("meeting_date", startIso)
      .lt("meeting_date", endIso);
    for (const m of (meetings ?? []) as Array<{ client_id: string; title: string | null; meeting_date: string }>) {
      counts.meetings += 1;
      items.push({ kind: "meeting", label: m.title ?? "Client meeting", at: m.meeting_date });
    }
  } catch {
    /* client_meetings table missing — skip */
  }

  // Newest first, capped so the card stays scannable.
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  items.splice(8);

  return { counts, items };
}

async function buildWebPayload(
  me: { id: string; weeklySchedule?: unknown; workTimezone?: string | null }
): Promise<WebPayload> {
  const supabase = getSupabaseAdmin();

  // 1) Carry-over tasks — every dep_web task that isn't done and whose
  // due date hasn't already passed (or has no due date). Sorted by
  // client priority (high → low) then due_date ascending.
  const today = new Date().toISOString().slice(0, 10);
  const { data: taskRows } = await supabase
    .from("tasks")
    .select("id, title, status, priority, due_date, client_name")
    .eq("department_id", "dep_web")
    .neq("status", "done")
    .or(`due_date.gte.${today},due_date.is.null`)
    .limit(50);
  type TaskRow = {
    id: string; title: string; status: string; priority: string;
    due_date: string | null; client_name: string | null;
  };
  const tasks = (taskRows ?? []) as TaskRow[];

  const clientNames = Array.from(
    new Set(tasks.map((t) => t.client_name).filter((n): n is string => !!n))
  );
  let priorityByName = new Map<string, "low" | "medium" | "high">();
  if (clientNames.length > 0) {
    const { data: cli } = await supabase
      .from("clients")
      .select("name, priority")
      .in("name", clientNames);
    for (const c of (cli ?? []) as Array<{ name: string; priority: "low" | "medium" | "high" }>) {
      priorityByName.set(c.name, c.priority);
    }
  }
  const PRIO_RANK = { high: 0, medium: 1, low: 2 } as const;
  const carryOverTasks: WebPayload["carryOverTasks"] = tasks
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.due_date,
      clientName: t.client_name,
      clientPriority: t.client_name ? priorityByName.get(t.client_name) ?? null : null
    }))
    .sort((a, b) => {
      const ap = a.clientPriority ? PRIO_RANK[a.clientPriority] : 99;
      const bp = b.clientPriority ? PRIO_RANK[b.clientPriority] : 99;
      if (ap !== bp) return ap - bp;
      const ad = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
      const bd = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
      return ad - bd;
    })
    .slice(0, 15);

  // 2) Inbound email agenda — recent threads (last 16h) that match a
  // known client. Missive integration is wrapped in try/catch so a
  // misconfigured / down clone doesn't break the whole dashboard.
  const inbound: WebPayload["inbound"] = [];
  try {
    const sinceMs = Date.now() - 16 * 60 * 60 * 1000;
    const allClientsRes = await supabase
      .from("clients")
      .select("id, name, website, websites, contact_emails");
    type ClientLite = {
      id: string; name: string; website: string | null;
      websites: string[] | null; contact_emails: string[] | null;
    };
    const allClients = (allClientsRes.data ?? []) as ClientLite[];
    const clientSignals = allClients.map((c) => ({
      client: c,
      signals: buildClientSignals({
        website: c.website,
        websites: c.websites ?? [],
        contactEmails: c.contact_emails ?? []
      })
    }));

    const threads = await listThreads({ folder: "INBOX", limit: 100 });
    for (const t of threads) {
      const lastMs = new Date(t.last_message_at).getTime();
      if (Number.isNaN(lastMs) || lastMs < sinceMs) continue;
      // Find the first client this thread matches.
      const match = clientSignals.find((cs) =>
        cs.signals.emailSet.size + cs.signals.domainSet.size > 0
        && threadMatchesClient(t.participants, cs.signals)
      );
      if (!match) continue;
      inbound.push({
        threadId: t.id,
        accountId: t.account_emails?.[0]?.email ?? null,
        subject: t.subject || "(no subject)",
        clientName: match.client.name,
        lastAt: t.last_message_at,
        participants: t.participants ?? []
      });
      if (inbound.length >= 15) break;
    }
  } catch {
    /* Missive unreachable — render empty inbound list */
  }

  void me; // kept on signature for future personalisation (user's inbox)

  return { kind: "web", inbound, carryOverTasks };
}
