import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { restrictionsFor } from "@/lib/restricted-senders";
import { listAccounts, listThreadsPaged } from "@/lib/missive-client";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";
import { onCacheBust } from "@/lib/inbox-event-bus";
import { isApprover } from "@/lib/email-approvers";

export const dynamic = "force-dynamic";

// Per-user 60s response cache. Without this every signed-in user was
// hammering the missiveclone pool on every 30s sidebar poll — a major
// contributor to the "timeout exceeded when trying to connect" 500s.
// The webhook receiver (/api/missive-webhook) busts each user's entry
// the instant something changes in an account they can see, so users
// see sub-second freshness on real activity and zero traffic while
// idle. In-process Map; safe for the single-instance Railway deploy.
interface BadgePayload {
  clients: number;
  peopleEodPending: number;
  approvalsPending: number;
  inboxesUnread: number;
  canApprove: boolean;
}

interface BadgeCacheEntry {
  expiresAt: number;
  // Account ids the user was scoped to when the entry was cached. A
  // webhook for any account in this set drops the entry. null = leader
  // who sees everything — drop on any event.
  visibleAccountIds: Set<string> | null;
  body: BadgePayload;
}

const BADGE_CACHE_TTL_MS = 60_000;
const badgeCache = new Map<string, BadgeCacheEntry>();

// Module-scoped singleton registration. Without the guard, every
// dev-mode hot reload would stack another listener on the bus.
const globalKey = "__ddBadgeCacheBusterRegistered" as const;
type GlobalWithKey = typeof globalThis & { [globalKey]?: boolean };
const g = globalThis as GlobalWithKey;
if (!g[globalKey]) {
  g[globalKey] = true;
  onCacheBust((accountId) => {
    for (const [userId, entry] of badgeCache) {
      if (entry.visibleAccountIds === null || entry.visibleAccountIds.has(accountId)) {
        badgeCache.delete(userId);
      }
    }
  });
}

// GET /api/notifications/badges
//   Returns the badge counts that the sidebar's nav items show as
//   red-dot indicators. Polled every 30s by the Sidebar component
//   alongside the existing SEO/Updates counts.
//
//   clients — total clients whose effective health is at_risk or
//             shaky (the two "bad" buckets). Effective = override if
//             set, otherwise computed label. Reflects spec Section 5:
//             "🚨 emoji next to client name on People + Client tabs."
//
//   peopleEodPending — count of workers in *the caller's visible
//             departments* who haven't submitted today's EOD yet, but
//             only after 5pm in the workspace's primary timezone (so
//             the badge doesn't nag at 9am).

const SCALED_TZ = "America/New_York";

function currentHourInTz(tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return parseInt(parts.hour ?? "0", 10);
}

function todayInTz(tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  });
  return fmt.format(new Date());
}

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const cached = badgeCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json(cached.body);
    }

    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ clients: 0, peopleEodPending: 0 });
    const supabase = getSupabaseAdmin();

    // --- Clients badge: count at-risk + shaky after applying any
    // manual override the leader may have set. The override columns
    // are nullable; coalesce to the computed label. Folds in the
    // touchpoint health bands (red OR yellow) too — a client either
    // sentiment-shaky OR touchpoint-stale lights the same badge so
    // operators see ONE "needs attention" number on the sidebar.
    let clientsAtRisk = 0;
    try {
      const { data: clientRows } = await supabase
        .from("clients")
        .select("id, health_label, health_override_label, touchpoint_override_label, encourage_emails");

      // Pull every sent email_drafts row in one shot so we can compute
      // the touchpoint band per client without N+1ing. Mirrors the
      // logic in lib/client-touchpoint.ts (kept inline here to avoid
      // pulling server-only code into the request hot path twice).
      const ids = ((clientRows ?? []) as Array<{ id: string }>).map((r) => r.id);
      const lastSentByClient = new Map<string, string>();
      if (ids.length > 0) {
        try {
          const { data: sentRows } = await supabase
            .from("email_drafts")
            .select("client_id, sent_at")
            .eq("status", "sent")
            .not("sent_at", "is", null)
            .in("client_id", ids)
            .order("sent_at", { ascending: false })
            .limit(2000);
          for (const r of (sentRows ?? []) as { client_id: string | null; sent_at: string | null }[]) {
            if (!r.client_id || !r.sent_at) continue;
            if (!lastSentByClient.has(r.client_id)) lastSentByClient.set(r.client_id, r.sent_at);
          }
        } catch { /* email_drafts may not exist yet */ }
      }

      const now = Date.now();
      const rows = (clientRows ?? []) as Array<{
        id: string;
        health_label: string | null;
        health_override_label: string | null;
        touchpoint_override_label: string | null;
        encourage_emails: boolean | null;
      }>;
      clientsAtRisk = rows.filter((r) => {
        // Opt-out: clients with email tracking off don't count toward
        // any "needs attention" badge.
        if (r.encourage_emails === false) return false;
        // Sentiment health channel
        const eff = r.health_override_label ?? r.health_label;
        if (eff === "at_risk" || eff === "shaky") return true;
        // Touchpoint channel: override wins; else compute from sent_at
        const tpOverride = r.touchpoint_override_label;
        if (tpOverride === "red" || tpOverride === "yellow") return true;
        if (tpOverride === "green") return false;
        const last = lastSentByClient.get(r.id);
        if (!last) return true; // never emailed → red
        const days = (now - new Date(last).getTime()) / 86_400_000;
        return days > 3; // yellow or red
      }).length;
    } catch {
      /* migration may not have applied yet — silently zero */
    }

    // --- People EOD-pending badge: only relevant after 5pm in the
    // workspace TZ. Counts members of the caller's visible departments
    // (leaders/admins see all depts; dept heads see their dept; workers
    // see their home dept(s)) who don't have a submitted_at row today.
    let peopleEodPending = 0;
    const hour = currentHourInTz(SCALED_TZ);
    if (hour >= 17) {
      let visibleDeptIds: string[] | null = null;
      if (me.role === "leader" || me.isAdmin) {
        const { data: deptRows } = await supabase.from("departments").select("id");
        visibleDeptIds = (deptRows ?? []).map((r) => r.id as string);
      } else {
        visibleDeptIds = me.departmentIds ?? [];
      }

      if (visibleDeptIds && visibleDeptIds.length > 0) {
        const { data: membersData } = await supabase
          .from("department_members")
          .select("user_id")
          .in("department_id", visibleDeptIds);
        const memberIds = Array.from(new Set(
          ((membersData ?? []) as { user_id: string }[]).map((r) => r.user_id)
        ));

        if (memberIds.length > 0) {
          const isoDate = todayInTz(SCALED_TZ);
          const { data: submittedRows } = await supabase
            .from("eod_notes")
            .select("user_id")
            .in("user_id", memberIds)
            .eq("note_date", isoDate)
            .not("submitted_at", "is", null);
          const submittedSet = new Set(
            ((submittedRows ?? []) as { user_id: string }[]).map((r) => r.user_id)
          );
          peopleEodPending = memberIds.filter((id) => !submittedSet.has(id)).length;
        }
      }
    }

    // --- Approvals pending: leaders see everything; dept heads see
    // only drafts whose AUTHOR sits in a department they head; admins
    // and workers see nothing in this badge. The visibility filter
    // mirrors GET /api/email-drafts so the count never drifts from
    // what they'll actually see on /approvals.
    let approvalsPending = 0;
    // v3 approver set (leader + Sam/Mujtaba/Farez) sees every pending
    // draft. Everyone else gets 0 — the sidebar still shows their own
    // drafts via the /emails page but doesn't badge them here.
    const canApprove = isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin });
    const headedDepts = me.role === "department_head" ? (me.departmentIds ?? []) : [];
    if (canApprove) {
      try {
        const { count } = await supabase
          .from("email_drafts")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending")
          .is("dismissed_at", null);
        approvalsPending = count ?? 0;
      } catch { /* migration not applied yet — silently zero */ }
    } else if (headedDepts.length > 0) {
      // Department heads badge only the pending drafts scoped to a
      // department they head — mirrors the GET /api/email-drafts
      // visibility filter so the count never drifts from what they see.
      try {
        const { count } = await supabase
          .from("email_drafts")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending")
          .is("dismissed_at", null)
          .in("department_id", headedDepts);
        approvalsPending = count ?? 0;
      } catch { /* migration not applied yet — silently zero */ }
    }

    // --- Inboxes unread: count threads with no read row OR a
    // read_through_at older than the thread's last_message_at, across
    // every account the caller can see. Best-effort — if missiveclone
    // is slow or down, we silently return 0 rather than 500ing the
    // sidebar. Caps at 200 threads to keep the poll cheap.
    let inboxesUnread = 0;
    // visibleIds is captured outside the try so the cache entry can
    // know which webhook account_ids should bust it for this user.
    let visibleIds: Set<string> | null = null;
    try {
      visibleIds = await visibleAccountIdsFor(me);
      const accounts = await listAccounts();
      const visibleAccounts = visibleIds === null
        ? accounts
        : accounts.filter((a) => visibleIds!.has(a.id));
      // Scope the fetch to the visible inboxes server-side. Fetching the
      // whole workspace and filtering here meant the 200-cap was spent on
      // workspace-wide recent threads, so a non-leader whose inboxes weren't
      // among the most recent 200 could see their unread badge read 0.
      if (visibleIds === null || visibleAccounts.length > 0) {
        const page = await listThreadsPaged({
          folder: "INBOX",
          limit: 200,
          offset: 0,
          mailboxIds: visibleIds === null ? undefined : visibleAccounts.map((a) => a.id)
        });
        // Sender-scoped privacy (see src/lib/restricted-senders.ts). Without
        // this the badge counts threads the user can't open, so it never
        // clears — and the phantom count is itself a tell that mail is hidden.
        const restrict = await restrictionsFor(me);
        const countable = restrict
          ? page.threads.filter((t) => !restrict.blocksThread(t))
          : page.threads;
        const readBy = await readStateForThreads(userId, countable.map((t) => t.id));
        inboxesUnread = countable.filter((t) =>
          isThreadUnread(t.last_message_at, readBy.get(t.id))
        ).length;
      }
    } catch { /* missive down or pool exhausted — degrade to zero */ }

    const body: BadgePayload = {
      clients: clientsAtRisk,
      peopleEodPending,
      approvalsPending,
      inboxesUnread,
      canApprove
    };
    badgeCache.set(userId, {
      expiresAt: Date.now() + BADGE_CACHE_TTL_MS,
      visibleAccountIds: visibleIds,
      body
    });
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { clients: 0, peopleEodPending: 0, approvalsPending: 0, inboxesUnread: 0, canApprove: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 200 } // never 500 the sidebar
    );
  }
}
