import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PUT /api/admin/users/[id]/slack
//   body: { slackEmail?: string|null, slackUserId?: string|null }
//   Sets the Slack-side identifiers on a DD user record so every
//   downstream DM uses the override instead of the DD email. Either
//   field can be null to clear. Leader/admin only.

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const callerId = await requireCurrentUserId();
    const caller = await getUserById(callerId);
    if (!caller) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (caller.role !== "leader" && caller.isAdmin !== true) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const update: Record<string, unknown> = {};
    if ("slackEmail" in body) {
      update.slack_email = typeof body.slackEmail === "string" && body.slackEmail.trim()
        ? body.slackEmail.trim().toLowerCase()
        : null;
    }
    if ("slackUserId" in body) {
      update.slack_user_id = typeof body.slackUserId === "string" && body.slackUserId.trim()
        ? body.slackUserId.trim()
        : null;
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("users")
      .update(update)
      .eq("id", params.id)
      .select("id, name, email, slack_email, slack_user_id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "user not found" }, { status: 404 });
    return NextResponse.json({ ok: true, user: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
