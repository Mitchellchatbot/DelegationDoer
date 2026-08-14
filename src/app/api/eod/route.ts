import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildEodForDepartment } from "@/lib/eod";
import { eodToday } from "@/lib/shift";

export const dynamic = "force-dynamic";

// GET /api/eod — returns today's EOD summaries for every department the
// caller can see. Leader sees all; department heads see their own
// departments; workers see their home department(s) so they can write
// their own note alongside teammates'.
export async function GET(req: Request) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();

    let allowedDeptIds: string[] | null = null;
    if (me.role === "leader" || me.isAdmin) {
      const { data } = await supabase.from("departments").select("id");
      allowedDeptIds = (data ?? []).map((r) => r.id as string);
    } else if (me.role === "department_head") {
      // Heads see every department they lead.
      const { data } = await supabase
        .from("department_members")
        .select("department_id")
        .eq("user_id", userId);
      allowedDeptIds = (data ?? []).map((r) => r.department_id as string);
    } else {
      // Workers see only their home department(s).
      allowedDeptIds = me.departmentIds;
    }

    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date");
    // Pass the YYYY-MM-DD through as a string. The old `new Date(param)`
    // parsed it as midnight UTC, whose ET date is the day *before* — so
    // every explicit ?date= read was off by one against the note_date
    // it was asking for.
    if (dateParam !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return NextResponse.json({ error: "invalid date" }, { status: 400 });
    }
    const isoDate = dateParam ?? eodToday();

    const summaries = [];
    for (const id of allowedDeptIds) {
      const s = await buildEodForDepartment(id, isoDate);
      if (s) summaries.push(s);
    }

    return NextResponse.json({ summaries, canSend: me.role === "leader" || me.role === "department_head" || !!me.isAdmin });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
