import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/departments — small list of all departments with the fields
// the settings + EOD pages care about (name + slack_channel_id).
// Auth-gated only; everyone signed in can read this.
export async function GET() {
  await requireCurrentUserId();
  const { data, error } = await getSupabaseAdmin()
    .from("departments")
    .select("id, name, slack_channel_id, task_channel_id")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    departments: (data ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      slackChannelId: (d.slack_channel_id as string | null) ?? null,
      taskChannelId: (d.task_channel_id as string | null) ?? null
    }))
  });
}
