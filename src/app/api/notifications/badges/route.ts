import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

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

    return NextResponse.json({
      clients: clientsAtRisk,
      peopleEodPending
    });
  } catch (err) {
    return NextResponse.json(
      { clients: 0, peopleEodPending: 0, error: err instanceof Error ? err.message : "unknown" },
      { status: 200 } // never 500 the sidebar
    );
  }
}
