import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// GET /api/eom — current month's Employee of the Month, plus the holder's
// public details so the widget + avatars can render the crown without a
// second round-trip. Also includes `isMe` so the widget can flip into
// celebration mode without a separate "who am I" call.
export async function GET() {
  const meId = await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const month = currentMonthKey();
  const { data, error } = await supabase
    .from("employee_of_month")
    .select("month, user_id, crowned_by_id, crowned_at, reason")
    .eq("month", month)
    .maybeSingle();
  if (error) {
    // Table not migrated yet → behave as if no one's crowned. Lets the
    // widget / presence provider / avatars keep working during partial
    // migrations.
    if (/relation .* does not exist/i.test(error.message)) {
      return NextResponse.json({ eom: null, month, isMe: false });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ eom: null, month, isMe: false });

  const { data: user } = await supabase
    .from("users")
    .select("id, name, avatar_url")
    .eq("id", data.user_id)
    .maybeSingle();

  return NextResponse.json({
    eom: {
      month: data.month,
      userId: data.user_id,
      name: user?.name ?? null,
      avatarUrl: user?.avatar_url ?? null,
      crownedAt: data.crowned_at,
      crownedById: data.crowned_by_id,
      reason: data.reason ?? null
    },
    month,
    isMe: data.user_id === meId
  });
}

// POST /api/eom — body: { userId, reason? }. CEO only. Upserts on month
// (so re-crowning replaces the holder for the current month).
export async function POST(req: NextRequest) {
  const adminId = await requireCurrentUserId();
  const me = await getUserById(adminId);
  if (!me || me.role !== "ceo") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const userId = typeof body.userId === "string" ? body.userId : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() || null : null;
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const month = currentMonthKey();
  const { data, error } = await supabase
    .from("employee_of_month")
    .upsert({
      month,
      user_id: userId,
      crowned_by_id: adminId,
      crowned_at: new Date().toISOString(),
      reason
    }, { onConflict: "month" })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, eom: data });
}

// DELETE /api/eom — uncrown for the current month. CEO only.
export async function DELETE() {
  const adminId = await requireCurrentUserId();
  const me = await getUserById(adminId);
  if (!me || me.role !== "ceo") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("employee_of_month")
    .delete()
    .eq("month", currentMonthKey());
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
