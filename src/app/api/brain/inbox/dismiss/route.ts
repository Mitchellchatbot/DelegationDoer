import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { OWNER_EMAIL } from "@/lib/access";

export const dynamic = "force-dynamic";

// POST /api/brain/inbox/dismiss — hide a thread from the Scale Room inbox so it
// won't come back. Owner only. This does NOT delete or touch the real Missive
// email — it only records the thread id so loadSortedInbox filters it out.
// Body: { threadId }.  DELETE with { threadId } un-dismisses (undo).
async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId) return NextResponse.json({ error: "threadId required" }, { status: 400 });
  try {
    const { error } = await getSupabaseAdmin()
      .from("inbox_dismissals")
      .upsert({ thread_id: threadId, dismissed_by: OWNER_EMAIL, dismissed_at: new Date().toISOString() }, { onConflict: "thread_id" });
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "dismiss failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId) return NextResponse.json({ error: "threadId required" }, { status: 400 });
  try {
    const { error } = await getSupabaseAdmin().from("inbox_dismissals").delete().eq("thread_id", threadId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "undo failed" }, { status: 500 });
  }
}
