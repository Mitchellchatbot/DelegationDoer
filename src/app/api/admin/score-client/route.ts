import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listLabels, listThreads, getThread } from "@/lib/missive-client";
import { scoreAndStore, recomputeClientHealth } from "@/lib/satisfaction-scoring";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/admin/score-client
//   body: { clientIds: string[], sinceDays?: number (default 14) }
//
// Focused scoring path for when the big sweep hasn't reached a client
// yet (or the sweep's scope window doesn't include today's mail). For
// each clientId we look up the per-client missive label, walk every
// thread carrying it, score messages within [now - sinceDays, now]
// via Claude Haiku, and recompute the client's median health.
//
// Auth: leader session OR `Authorization: Bearer ${CRON_SECRET}`
// (matches /api/cron/* — lets an operator curl this from a shell
// without juggling cookies).
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.get("authorization") ?? "";
    const cronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;
    if (!cronAuth) {
      const userId = await requireCurrentUserId();
      const me = await getUserById(userId);
      if (!isLeader(me)) {
        return NextResponse.json({ error: "leader only" }, { status: 403 });
      }
    }

    const body = await req.json().catch(() => ({}));
    const clientIds = Array.isArray(body?.clientIds)
      ? body.clientIds.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (clientIds.length === 0) {
      return NextResponse.json({ error: "clientIds[] required" }, { status: 400 });
    }
    const sinceDays = Math.min(60, Math.max(1, Number(body?.sinceDays) || 14));
    const scopeFromMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const scopeToMs = Date.now();

    const supabase = getSupabaseAdmin();
    const labels = await listLabels();
    const labelByName = new Map(labels.map((l) => [l.name.trim().toLowerCase(), l.id]));

    const { data: clients } = await supabase
      .from("clients")
      .select("id, name")
      .in("id", clientIds);
    if (!clients || clients.length === 0) {
      return NextResponse.json({ error: "no matching clients" }, { status: 404 });
    }

    const perClient: Array<{
      clientId: string;
      clientName: string;
      labelFound: boolean;
      threadsScanned: number;
      messagesScored: number;
      messagesErrored: number;
      health: { label: string | null; score: number | null; sample: number | null } | null;
    }> = [];

    for (const c of clients as Array<{ id: string; name: string }>) {
      const labelId = labelByName.get(c.name.trim().toLowerCase()) ?? null;
      if (!labelId) {
        perClient.push({
          clientId: c.id,
          clientName: c.name,
          labelFound: false,
          threadsScanned: 0,
          messagesScored: 0,
          messagesErrored: 0,
          health: null
        });
        continue;
      }

      // Pull every thread the per-client label carries. Limit 200 is
      // the API cap; for the 14-day window this is plenty.
      const threads = await listThreads({ labelId, limit: 200 });
      let threadsScanned = 0;
      let messagesScored = 0;
      let messagesErrored = 0;

      for (const t of threads) {
        threadsScanned += 1;
        let detail;
        try {
          detail = await getThread(t.id);
        } catch {
          continue;
        }
        const inScope = detail.messages.filter((m) => {
          const ms = new Date(m.sent_at).getTime();
          return !Number.isNaN(ms) && ms >= scopeFromMs && ms < scopeToMs;
        });
        if (inScope.length === 0) continue;
        const tagged = inScope.map((m) => ({ ...m, clientId: c.id }));
        const r = await scoreAndStore(tagged);
        messagesScored += r.scored;
        messagesErrored += r.errored;
      }

      const health = await recomputeClientHealth(c.id).catch(() => null);

      perClient.push({
        clientId: c.id,
        clientName: c.name,
        labelFound: true,
        threadsScanned,
        messagesScored,
        messagesErrored,
        health: health
          ? { label: health.label, score: health.score, sample: health.sampleSize }
          : null
      });
    }

    return NextResponse.json({ ok: true, sinceDays, results: perClient });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
