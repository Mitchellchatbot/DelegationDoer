import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listThreadsPaged, getThread } from "@/lib/missive-client";
import { loadClientMatcher } from "@/lib/client-thread-match";
import { scoreAndStore, recomputeClientHealth } from "@/lib/satisfaction-scoring";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily incremental scorer. Walks the most-recent INBOX page, picks
// up every message we haven't already scored, scores it, and
// recomputes the affected clients' medians.
//
// Auth: Vercel cron Bearer token, or ?secret= query param (mirrors
// /api/cron/email-intake).
//
// One-time historical backfill lives at
// /api/admin/scan-mail-satisfaction — this one's just the keep-up
// job that runs every night.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const querySecret = new URL(req.url).searchParams.get("secret");
    const ok = auth === `Bearer ${secret}` || querySecret === secret;
    if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  const matcher = await loadClientMatcher();

  // Pull a generous window of recent threads — anything updated in
  // the last 36h gets re-checked. 36h instead of 24 gives one cycle
  // of slack so a missed cron run doesn't drop messages.
  const since = Date.now() - 36 * 60 * 60 * 1000;
  const PAGE = 100;
  let offset = 0;
  const touched = new Set<string>();
  let scored = 0;
  let errored = 0;
  let threadsWalked = 0;

  for (let i = 0; i < 5; i++) {
    // Cap at 5 pages (~500 threads) to stay under maxDuration.
    const page = await listThreadsPaged({ folder: "INBOX", limit: PAGE, offset });
    if (page.threads.length === 0) break;

    const fresh = page.threads.filter(
      (t) => new Date(t.last_message_at).getTime() >= since
    );
    if (fresh.length === 0) break;

    for (const t of fresh) {
      threadsWalked += 1;
      const clientHit =
        // Try each participant against the client matcher; first hit wins.
        t.participants
          .map((p) => matcher.match(p))
          .find((m): m is { id: string; name: string } => !!m) ?? null;
      if (!clientHit) continue;

      const detail = await getThread(t.id).catch(() => null);
      if (!detail) continue;
      const inWindow = detail.messages.filter(
        (m) => new Date(m.sent_at).getTime() >= since
      );
      if (inWindow.length === 0) continue;

      // Skip messages we already have scores for.
      const ids = inWindow.map((m) => m.id);
      const { data: existing } = await supabase
        .from("email_satisfaction_scores")
        .select("message_id")
        .in("message_id", ids);
      const have = new Set(((existing ?? []) as { message_id: string }[]).map((r) => r.message_id));
      const todo = inWindow.filter((m) => !have.has(m.id));
      if (todo.length === 0) continue;

      const r = await scoreAndStore(
        todo.map((m) => ({ ...m, clientId: clientHit.id }))
      );
      scored += r.scored;
      errored += r.errored;
      if (r.scored > 0) touched.add(clientHit.id);
    }

    if (!page.hasMore) break;
    offset += PAGE;
  }

  // Recompute medians + write back to clients.
  for (const cid of touched) {
    await recomputeClientHealth(cid).catch(() => { /* best-effort */ });
  }

  return NextResponse.json({
    ok: true,
    threadsWalked,
    scored,
    errored,
    clientsTouched: touched.size
  });
}
