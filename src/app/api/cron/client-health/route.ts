import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listThreadsPaged, getThread } from "@/lib/missive-client";
import { loadClientMatcher } from "@/lib/client-thread-match";
import { scoreAndStore, recomputeClientHealth } from "@/lib/satisfaction-scoring";
import { syncClientTouchpointsFromMissive } from "@/lib/touchpoint-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daily incremental scorer. Walks recent threads in both INBOX and
// SENT folders, picks up every message we haven't already scored
// (across both directions), scores them, and recomputes the affected
// clients' medians.
//
// Why both folders: a thread with no inbound replies (we sent a
// status update, client never wrote back) lives only in SENT — it
// never shows up under folder=INBOX. INBOX-only walks would silently
// miss every outbound that didn't get answered.
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
  const touched = new Set<string>();
  // De-dupe thread ids across the two folder passes — a thread with
  // both inbound and outbound shows up in both folders, but we only
  // need to walk its messages once.
  const seenThreads = new Set<string>();
  let scored = 0;
  let errored = 0;
  let threadsWalked = 0;

  for (const folder of ["INBOX", "SENT"] as const) {
    let offset = 0;
    // 3 pages per folder (~300 threads each, 600 total) leaves head-
    // room under maxDuration=60s while still catching every fresh
    // thread on a daily cadence.
    for (let i = 0; i < 3; i++) {
      const page = await listThreadsPaged({ folder, limit: PAGE, offset });
      if (page.threads.length === 0) break;

      const fresh = page.threads.filter(
        (t) => new Date(t.last_message_at).getTime() >= since
      );
      if (fresh.length === 0) break;

      for (const t of fresh) {
        if (seenThreads.has(t.id)) continue;
        seenThreads.add(t.id);
        threadsWalked += 1;
        const clientHit =
          // Try each participant against the client matcher; first hit wins.
          t.participants
            .map((p) => matcher.match(p))
            .find((m): m is { id: string; name: string } => !!m) ?? null;
        if (!clientHit) continue;

        const detail = await getThread(t.id).catch(() => null);
        if (!detail) continue;
        // detail.messages contains BOTH directions regardless of which
        // folder the thread was listed under — so scoring picks up
        // inbound + outbound from a single getThread() call.
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
  }

  // Recompute medians + write back to clients.
  for (const cid of touched) {
    await recomputeClientHealth(cid).catch(() => { /* best-effort */ });
  }

  // Refresh per-client last-outbound timestamps from missiveclone's
  // SENT folder so the touchpoint dashboard picks up emails sent
  // outside DelegationDoer. Cheap enough to run every night — capped
  // at 6 months of history internally.
  let touchpointsUpdated = 0;
  try {
    const r = await syncClientTouchpointsFromMissive();
    touchpointsUpdated = r.clientsUpdated;
  } catch { /* best-effort */ }

  return NextResponse.json({
    ok: true,
    threadsWalked,
    scored,
    errored,
    clientsTouched: touched.size,
    touchpointsUpdated
  });
}
