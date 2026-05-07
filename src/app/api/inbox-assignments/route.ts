import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments, getAllAssignments } from "@/lib/inbox-access";

export const dynamic = "force-dynamic";

// GET /api/inbox-assignments — every assignment row. CEO-only (the page
// that uses this is the management view).
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const assignments = await getAllAssignments();
    return NextResponse.json({ assignments });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/inbox-assignments
// Body: { userId, missiveAccountId, inboxEmail, inboxLabel? }
// Idempotent — `unique(user_id, missive_account_id)` collapses dupes.
export async function POST(req: NextRequest) {
  try {
    const actorId = await requireCurrentUserId();
    const me = await getUserById(actorId);
    if (!me || !canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = await req.json();
    const { userId, missiveAccountId, inboxEmail, inboxLabel } = body ?? {};
    if (!userId || !missiveAccountId || !inboxEmail) {
      return NextResponse.json({ error: "userId, missiveAccountId, inboxEmail required" }, { status: 400 });
    }

    const id = `ia_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await getSupabaseAdmin()
      .from("inbox_assignments")
      .upsert(
        {
          id,
          user_id: userId,
          missive_account_id: missiveAccountId,
          inbox_email: inboxEmail,
          inbox_label: inboxLabel ?? null,
          assigned_by: actorId
        },
        { onConflict: "user_id,missive_account_id", ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ assignment: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE /api/inbox-assignments?userId=...&missiveAccountId=...
export async function DELETE(req: NextRequest) {
  try {
    const actorId = await requireCurrentUserId();
    const me = await getUserById(actorId);
    if (!me || !canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");
    const missiveAccountId = url.searchParams.get("missiveAccountId");
    if (!userId || !missiveAccountId) {
      return NextResponse.json({ error: "userId + missiveAccountId required" }, { status: 400 });
    }
    const { error } = await getSupabaseAdmin()
      .from("inbox_assignments")
      .delete()
      .eq("user_id", userId)
      .eq("missive_account_id", missiveAccountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
