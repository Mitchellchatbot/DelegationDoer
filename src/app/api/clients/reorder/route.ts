import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments } from "@/lib/inbox-access";

export const dynamic = "force-dynamic";

// POST /api/clients/reorder
// Body: { ids: string[] }   — array of client ids in their NEW desired
//                              order (top of the list = most urgent).
// Leader-only. Renumbers display_order in increments of 100 so subsequent
// inserts have headroom for fractional ranks.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !canManageAssignments(me)) {
      return NextResponse.json({ error: "Leader only" }, { status: 403 });
    }
    const { ids } = await req.json();
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) {
      return NextResponse.json({ error: "ids must be string[]" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    // Update each row to its new index * 100. Sequentially because the JS
    // client doesn't expose a bulk UPDATE…CASE statement; each UPDATE is a
    // single row by primary key so latency is bounded by N round trips.
    // For our scale (tens of clients) that's fine.
    for (let i = 0; i < ids.length; i++) {
      const { error } = await supabase
        .from("clients")
        .update({ display_order: (i + 1) * 100 })
        .eq("id", ids[i]);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
