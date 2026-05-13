import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/seo-reports/summary — cheap "how many open SEO report
// requests are there?" used by the sidebar + Updates tab badge.
// Counts only, no rows, so it can poll without paying for the full
// list payload.
export async function GET() {
  try {
    await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { count, error } = await supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .contains("tags", ["seo-report-request"])
      .neq("status", "done");
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ openCount: count ?? 0 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
