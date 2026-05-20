import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccounts, listThreadsPaged } from "@/lib/missive-client";
import { readStateForThreads, isThreadUnread } from "@/lib/thread-read-state";

export const dynamic = "force-dynamic";

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
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ clients: 0, peopleEodPending: 0 });
    const supabase = getSupabaseAdmin();

    // --- Clients badge: count at-risk + shaky after applying any
    // manual override the leader may have set. The override columns
    // are nullable; coalesce to the computed label.
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
    const isLeader = me.role === "leader";
    const isDeptHead = me.role === "department_head" && (me.departmentIds ?? []).length > 0;
    const canApprove = isLeader || isDeptHead;
    if (canApprove) {
      try {
        if (isLeader) {
          const { count } = await supabase
            .from("email_drafts")
            .select("id", { count: "exact", head: true })
            .eq("status", "pending");
          approvalsPending = count ?? 0;
        } else {
          // Dept head: count pending drafts whose author is in any
          // of their departments. Two-step query because PostgREST
          // doesn't expose a clean cross-table count for this shape.
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
      } catch { /* migration not applied yet — silently zero */ }
    }

    // --- Inboxes unread: count threads with no read row OR a
    // read_through_at older than the thread's last_message_at, across
    // every account the caller can see. Best-effort — if missiveclone
    // is slow or down, we silently return 0 rather than 500ing the
    // sidebar. Caps at 200 threads to keep the poll cheap.
    let inboxesUnread = 0;
    try {
      const visibleIds = await visibleAccountIdsFor(me);
      const accounts = await listAccounts();
      const visibleAccounts = visibleIds === null
        ? accounts
        : accounts.filter((a) => visibleIds.has(a.id));
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

    return NextResponse.json({
      clients: clientsAtRisk,
      peopleEodPending,
      approvalsPending,
      inboxesUnread,
      canApprove
    });
  } catch (err) {
    return NextResponse.json(
      { clients: 0, peopleEodPending: 0, approvalsPending: 0, inboxesUnread: 0, canApprove: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 200 } // never 500 the sidebar
    );
  }
}
