import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccounts, listThreadsPaged } from "@/lib/missive-client";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";
import { onCacheBust } from "@/lib/inbox-event-bus";

export const dynamic = "force-dynamic";

// GET /api/notifications/badges
//   Single round-trip refresh for the red-dot indicators on the sidebar:
//     clients              — at-risk + shaky clients (after override)
//     peopleEodPending     — workers without today's EOD submission, after 5pm ET
//     approvalsPending     — pending email drafts visible to this approver
//     inboxesUnread        — unread threads across the caller's visible inboxes
//     canApprove           — drives whether the Approvals nav item is rendered
//
//   Response is cached per-user for 60s; missive-webhook events bust the
//   cache for any user whose visible-account set touches the affected
//   account, so freshness stays sub-second under real activity.

const SCALED_TZ = "America/New_York";

interface BadgePayload {
  clients: number;
  peopleEodPending: number;
  approvalsPending: number;
  inboxesUnread: number;
  canApprove: boolean;
}

interface BadgeCacheEntry {
  expiresAt: number;
  // null = leader / sees everything; webhook for any account busts it.
  visibleAccountIds: Set<string> | null;
  body: BadgePayload;
}

const BADGE_CACHE_TTL_MS = 60_000;
const badgeCache = new Map<string, BadgeCacheEntry>();

// Module-scoped singleton registration. Without the guard, dev-mode hot
// reload stacks another listener on the bus on every recompile.
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

const EMPTY: BadgePayload = {
  clients: 0,
  peopleEodPending: 0,
  approvalsPending: 0,
  inboxesUnread: 0,
  canApprove: false
};

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const cached = badgeCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json(cached.body);
    }

    const me = await getUserById(userId);
    if (!me) return NextResponse.json(EMPTY);
    const supabase = getSupabaseAdmin();

    let clientsAtRisk = 0;
    try {
      const { data } = await supabase
        .from("clients")
        .select("health_label, health_override_label");
      const rows = (data ?? []) as Array<{ health_label: string | null; health_override_label: string | null }>;
      clientsAtRisk = rows.filter((r) => {
        const eff = r.health_override_label ?? r.health_label;
        return eff === "at_risk" || eff === "shaky";
      }).length;
    } catch { /* health columns absent — silently zero */ }

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

    // Approvals — leaders + named super-approvers see everything; dept
    // heads see drafts authored by anyone in their dept. Mirrors the
    // /api/email-drafts visibility filter so the count can't drift from
    // what they'd see on the /approvals page.
    let approvalsPending = 0;
    const isLeader = me.role === "leader";
    const lowerName = (me.name ?? "").toLowerCase();
    const isSuperApprover = ["mitchell", "mujtaba", "sam"].some((p) => lowerName.includes(p));
    const isDeptHead = me.role === "department_head" && (me.departmentIds ?? []).length > 0;
    const canApprove = isLeader || isSuperApprover || isDeptHead;
    if (canApprove) {
      try {
        if (isLeader || isSuperApprover) {
          const { count } = await supabase
            .from("email_drafts")
            .select("id", { count: "exact", head: true })
            .eq("status", "pending");
          approvalsPending = count ?? 0;
        } else {
          const myDepts = me.departmentIds ?? [];
          const { data: peerRows } = await supabase
            .from("department_members")
            .select("user_id")
            .in("department_id", myDepts);
          const peerIds = Array.from(new Set(
            ((peerRows ?? []) as { user_id: string }[]).map((r) => r.user_id)
          ));
          if (peerIds.length > 0) {
            const { count } = await supabase
              .from("email_drafts")
              .select("id", { count: "exact", head: true })
              .eq("status", "pending")
              .in("author_id", peerIds);
            approvalsPending = count ?? 0;
          }
        }
      } catch { /* email_drafts table absent — silently zero */ }
    }

    // Inbox unread — best-effort. If missiveclone is slow/down we want
    // the sidebar to render with zero rather than hanging the whole
    // request, so this is wrapped and the failure path still returns
    // the other badges.
    let inboxesUnread = 0;
    let visibleIds: Set<string> | null = null;
    try {
      visibleIds = await visibleAccountIdsFor(me);
      const accounts = await listAccounts();
      const visibleAccounts = visibleIds === null
        ? accounts
        : accounts.filter((a) => visibleIds!.has(a.id));
      if (visibleAccounts.length > 0) {
        const visibleEmails = new Set(visibleAccounts.map((a) => a.email.toLowerCase()));
        const page = await listThreadsPaged({ folder: "INBOX", limit: 200, offset: 0 });
        const threadsInView = visibleIds === null
          ? page.threads
          : page.threads.filter((t) =>
              (t.account_emails ?? []).some((ae) => visibleEmails.has(ae.email.toLowerCase()))
            );
        const readBy = await readStateForThreads(userId, threadsInView.map((t) => t.id));
        inboxesUnread = threadsInView.filter((t) =>
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
    // Never 500 the sidebar — degrade gracefully.
    return NextResponse.json(
      { ...EMPTY, error: err instanceof Error ? err.message : "unknown" },
      { status: 200 }
    );
  }
}
