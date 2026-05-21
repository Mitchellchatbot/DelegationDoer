import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/auto-delegate-recipients
//   Returns workspace_settings.auto_delegate_user_ids — the explicit
//   list of users eligible to receive auto-routed tasks from email
//   intake. Empty array means "use the default skill-based routing"
//   so existing behavior survives until the leader sets a list.
//
// PUT /api/auto-delegate-recipients
//   body: { userIds: string[] }
//   Replaces the list. Leader / admin only.

export async function GET() {
  try {
    await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("workspace_settings")
      .select("auto_delegate_user_ids")
      .eq("id", "workspace")
      .maybeSingle();
    return NextResponse.json({
      userIds: (data?.auto_delegate_user_ids as string[] | null) ?? []
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (me.role !== "leader" && me.isAdmin !== true) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.filter((u: unknown) => typeof u === "string")
      : null;
    if (userIds === null) {
      return NextResponse.json({ error: "userIds (string[]) required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("workspace_settings")
      .upsert(
        { id: "workspace", auto_delegate_user_ids: userIds, updated_at: new Date().toISOString() },
        { onConflict: "id" }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, userIds });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
