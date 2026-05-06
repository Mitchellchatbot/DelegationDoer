import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Hourly cron — flags any open task with no activity in 48h.
// In production: wire to Vercel Cron (vercel.json) or node-cron from a long-lived process.
export async function GET() {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - 48 * 36e5).toISOString();

  // Only the rows we'll actually flip — open tasks, not yet flagged,
  // last activity older than the cutoff.
  const { data, error } = await supabase
    .from("tasks")
    .update({ inactive_flag: true })
    .neq("status", "done")
    .eq("inactive_flag", false)
    .lt("last_activity_at", cutoff)
    .select("id");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, flagged: data?.length ?? 0 });
}
