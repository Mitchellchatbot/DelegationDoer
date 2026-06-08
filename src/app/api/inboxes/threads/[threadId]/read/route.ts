import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { publish } from "@/lib/inbox-event-bus";

export const dynamic = "force-dynamic";
// Node runtime so this handler shares the in-process inbox event bus
// singleton with the SSE stream (/api/inbox-events) and the badge cache
// buster — mirrors the SSE route. Without this a future edge migration
// would silently sever publish() from its subscribers.
export const runtime = "nodejs";

// POST /api/inboxes/threads/[threadId]/read
//   body: { accountId: string, readThroughAt: string | null }
//
// Marks the thread as read for the current user. `readThroughAt` should
// be the timestamp of the newest message visible to the user — if a
// later message arrives, the thread re-surfaces as unread.
export async function POST(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  const userId = await requireCurrentUserId();
  const body = await req.json().catch(() => ({}));
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const readThroughAt =
    typeof body.readThroughAt === "string" ? body.readThroughAt : null;
  if (!accountId) {
    return NextResponse.json({ error: "accountId required" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase.from("thread_read_state").upsert(
    {
      user_id: userId,
      thread_id: params.threadId,
      account_id: accountId,
      last_read_at: now,
      read_through_at: readThroughAt
    },
    { onConflict: "user_id,thread_id" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Tell the inbox bus the thread's read-state changed so the sidebar
  // badge cache busts and any concurrently-mounted thread list refreshes
  // live (the list that triggered this is unmounted on the detail page,
  // so it relies on router.refresh() on Back instead).
  publish({
    event: "thread:updated",
    account_id: accountId,
    thread_id: params.threadId,
    ts: Date.now()
  });

  return NextResponse.json({ ok: true });
}

// DELETE → mark unread (drop the read-state row).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  const userId = await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  // Grab the account before deleting so we can publish a symmetric
  // thread:updated event (the bus filters/keys on account_id).
  const { data: existing } = await supabase
    .from("thread_read_state")
    .select("account_id")
    .eq("user_id", userId)
    .eq("thread_id", params.threadId)
    .maybeSingle();

  const { error } = await supabase
    .from("thread_read_state")
    .delete()
    .eq("user_id", userId)
    .eq("thread_id", params.threadId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (existing?.account_id) {
    publish({
      event: "thread:updated",
      account_id: existing.account_id,
      thread_id: params.threadId,
      ts: Date.now()
    });
  }

  return NextResponse.json({ ok: true });
}
