// The morning CFO report, DM'd privately to Mitchell at the start of every day.
//
// This is the standalone "CFO read" — the one finance thing to see first: the
// survival margin before founder pay vs the 30% floor, the plain-English read,
// client-loss exposure, and today's moves. Numbers are computed deterministically
// from the finance data (loadCfoSnapshot → the same defense + learnings models as
// the /finance page), so the figures are always exact — no LLM in the money path.
//
// Idempotency mirrors daily-briefing exactly:
//   - target-hour guard: no-op until the current America/New_York hour reaches
//     TARGET_HOUR (delivers at the first tick from then on, once per day).
//   - same-day dedupe: a cfo_reports row for today's ET date with delivered_at
//     set means we already ran; skip.
// opts.force bypasses both; opts.dryRun renders + returns the payload only.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";
import { DEFAULT_TZ, nowInTz } from "@/lib/shift";
import { loadCfoSnapshot, type CfoSnapshot } from "@/lib/finance-snapshot";
import { cfoMoves, readMoney as money } from "@/lib/finance-read";

const OWNER_EMAIL = "mitchell@scaledai.org";
const TARGET_HOUR = 7; // 7am America/New_York — before the 8am team brief

export type CfoReportOutcome =
  | { ok: true; delivered: true; reportId: string; marginPct: number; onTrack: boolean }
  | { ok: true; dryRun: true; text: string; blocks: unknown[] }
  | { ok: true; skipped: string; nyHour?: number }
  | { ok: false; reason: string };

function prettyDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: DEFAULT_TZ
  });
}

// Deterministic Slack blocks for the report — no model, so the numbers are exact.
function buildReportBlocks(snap: CfoSnapshot): { blocks: unknown[]; text: string } {
  const { defense: d, learnings: l } = snap;
  const date = prettyDate();
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `🧮 CFO Report — ${date}`.slice(0, 150), emoji: true } }
  ];

  if (d.hasData) {
    const status = d.onTrack
      ? `*Survival margin: ${d.marginPct}%*  ✅ above the ${d.floorPct}% floor`
      : `*Survival margin: ${d.marginPct}%*  🔴 below the ${d.floorPct}% floor by ${money(d.gapNow)}/mo`;
    const sub = `_${d.month} · ${money(d.beforeFounderProfit)} profit before founder pay on ${money(d.revenue)} revenue_`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${status}\n${sub}` } });
  }

  if (l.hasData && l.verdict) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*The read*\n${l.verdict}` } });
  }

  if (d.hasData && d.scenarios.length) {
    const lines = d.scenarios.slice(0, 3).map((s) => {
      const hold = s.cutNeeded > 0 ? `cut ${money(s.cutNeeded)}/mo to hold ${d.floorPct}%` : `still above ${d.floorPct}% ✓`;
      return `• *${s.client.split(",")[0]}* (−${money(s.lostMrr)}/mo) → margin ${s.newMarginPct}%, ${hold}`;
    });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*If we lose a top client*\n${lines.join("\n")}` } });
  }

  const moves = cfoMoves(d, l);
  if (moves.length) {
    const numbered = moves.map((m, i) => `${i + 1}. ${m}`).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Today's moves*\n${numbered}` } });
  }

  if (d.hasData) {
    const prot = d.protected.map((p) => p.name).join(", ") || "none";
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Defense pool if needed: *${money(d.cutCapacity)}/mo* (software · ads · non-protected roles). Protected (never cut): ${prot}.` }]
    });
  }

  const text = d.hasData
    ? `CFO Report — ${date}: margin ${d.marginPct}% ${d.onTrack ? `(above ${d.floorPct}% floor)` : `(below ${d.floorPct}% floor by ${money(d.gapNow)}/mo)`}`
    : `CFO Report — ${date}`;
  return { blocks: blocks.slice(0, 50), text };
}

export async function runCfoReport(
  opts: { force?: boolean; dryRun?: boolean } = {}
): Promise<CfoReportOutcome> {
  const now = nowInTz(DEFAULT_TZ);
  // Deliver at the first tick from the target hour onward; the same-day dedupe
  // below guarantees exactly one send even across late ticks / deploy restarts.
  if (!opts.force && now.hh < TARGET_HOUR) {
    return { ok: true, skipped: "before-target-hour", nyHour: now.hh };
  }

  const reportId = `cfo_${now.ymd}`;
  const supabase = getSupabaseAdmin();

  if (!opts.force && !opts.dryRun) {
    const { data: existing } = await supabase
      .from("cfo_reports")
      .select("id, delivered_at")
      .eq("id", reportId)
      .maybeSingle();
    if (existing?.delivered_at) return { ok: true, skipped: "already-sent-today" };
  }

  if (!opts.dryRun && !process.env.SLACK_BOT_TOKEN) {
    return { ok: false, reason: "SLACK_BOT_TOKEN missing" };
  }

  const snap = await loadCfoSnapshot().catch(() => null);
  if (!snap) return { ok: false, reason: "No finance data available for the CFO report" };
  const { defense: d } = snap;

  const { blocks, text } = buildReportBlocks(snap);

  if (opts.dryRun) {
    return { ok: true, dryRun: true, text, blocks };
  }

  // Persist before posting so the row exists the moment the DM lands.
  const { error: upsertErr } = await supabase.from("cfo_reports").upsert({
    id: reportId,
    report_date: now.ymd,
    month: d.month || null,
    margin_pct: d.hasData ? d.marginPct : null,
    on_track: d.hasData ? d.onTrack : null,
    gap_now: d.hasData ? d.gapNow : null,
    report: { text, blocks }
  });
  if (upsertErr) return { ok: false, reason: `DB upsert failed: ${upsertErr.message}` };

  try {
    const slackUserId = await resolveSlackId({ email: OWNER_EMAIL });
    const dmChannel = await openDm(slackUserId);
    const posted = await postMessage(dmChannel, text, blocks);
    await supabase.from("cfo_reports").update({ delivered_at: new Date().toISOString(), slack_ts: posted.ts }).eq("id", reportId);
  } catch (err) {
    return { ok: false, reason: `Slack DM failed: ${err instanceof Error ? err.message : "unknown"}` };
  }

  return { ok: true, delivered: true, reportId, marginPct: d.marginPct, onTrack: d.onTrack };
}
