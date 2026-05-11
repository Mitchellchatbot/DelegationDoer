import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildEodForDepartment, sendEodToSlack, type EodSendResult } from "@/lib/eod";

export const dynamic = "force-dynamic";

// POST /api/eod/send — { departmentId?: string, date?: "YYYY-MM-DD" }.
// If departmentId omitted, sends for every department the caller is
// allowed to act on (CEO = all, dept head = their depts).
// Returns per-department delivery results.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (me.role !== "ceo" && me.role !== "department_head") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const dateStr =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date().toISOString().slice(0, 10);
    const date = new Date(`${dateStr}T12:00:00Z`); // midday utc → safely inside the day

    const supabase = getSupabaseAdmin();

    let targetIds: string[];
    if (typeof body.departmentId === "string" && body.departmentId.length > 0) {
      targetIds = [body.departmentId];
    } else if (me.role === "ceo") {
      const { data } = await supabase.from("departments").select("id");
      targetIds = (data ?? []).map((r) => r.id as string);
    } else {
      // department_head → only depts they lead
      const { data } = await supabase
        .from("department_members")
        .select("department_id")
        .eq("user_id", userId);
      targetIds = (data ?? []).map((r) => r.department_id as string);
    }

    // For non-CEO callers asking about a specific department, verify
    // membership instead of trusting the body.
    if (me.role !== "ceo" && typeof body.departmentId === "string") {
      const { data } = await supabase
        .from("department_members")
        .select("department_id")
        .eq("user_id", userId)
        .eq("department_id", body.departmentId)
        .maybeSingle();
      if (!data) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const results: EodSendResult[] = [];
    for (const id of targetIds) {
      const summary = await buildEodForDepartment(id, date);
      if (!summary) {
        results.push({
          departmentId: id,
          departmentName: id,
          channelId: null,
          delivery: "failed",
          error: "department not found"
        });
        continue;
      }
      const r = await sendEodToSlack(summary);
      results.push(r);
    }

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
