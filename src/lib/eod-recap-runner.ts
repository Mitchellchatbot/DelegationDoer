// Shared runner for the 7pm America/New_York daily recap so the
// /api/cron/eod-recap route AND the in-process scheduler (cron-bootstrap)
// drive identical logic.
//
// Two layers of idempotency keep this safe to run at any cadence (Vercel
// fires it at 23:00 + 00:00 UTC to straddle DST; the in-process loop ticks
// hourly):
//   1. NY-hour guard — does nothing unless the *current* America/New_York
//      hour is 19, so any off-window tick just no-ops.
//   2. last_eod_recap_at — if a recap already posted in the same UTC day we
//      skip, so two ticks inside the 7pm hour can't double-post.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildEodForAllDepartments, formatEodForSlack } from "@/lib/eod";
import { postMessage } from "@/lib/slack";

// Discriminated outcome so the route can echo the same JSON it always has
// and the scheduler can log a one-line summary. A hard failure (Slack post,
// etc.) is thrown — the route maps that to a 500, matching prior behaviour.
export type EodRecapOutcome =
  | { ok: true; skipped: string; nyHour?: number }
  | { ok: true; posted: number }
  | { ok: false; reason: string };

export async function runEodRecap(): Promise<EodRecapOutcome> {
  // DST guard: the handler refuses to do anything unless the current NY hour
  // is 19, so a wrong-side fire just no-ops.
  const nyHour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/New_York"
    }).format(new Date())
  );
  if (nyHour !== 19) {
    return { ok: true, skipped: "not-7pm-ny", nyHour };
  }

  const supabase = getSupabaseAdmin();
  const { data: settings } = await supabase
    .from("workspace_settings")
    .select("scaled_team_channel_id, eod_recap_channel_id, last_eod_recap_at")
    .eq("id", "workspace")
    .maybeSingle();
  const recapChannel =
    (settings?.eod_recap_channel_id as string | null) ||
    (settings?.scaled_team_channel_id as string | null);
  if (!recapChannel) {
    return { ok: false, reason: "no recap channel configured" };
  }

  // De-dupe: if the last successful recap landed in the same UTC day, bail.
  const last = settings?.last_eod_recap_at as string | null;
  if (last) {
    const lastDay = new Date(last).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (lastDay === today) {
      return { ok: true, skipped: "already-sent-today" };
    }
  }

  // Build per-department summaries and stitch them into one Block Kit payload.
  const summaries = await buildEodForAllDepartments();
  if (summaries.length === 0) {
    return { ok: true, skipped: "no-departments-with-data" };
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York"
  });
  const headerBlocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `📒 Daily Recap · ${today}`, emoji: true } },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "*7pm EST roll-up* — every department's day in one place." }
      ]
    },
    { type: "divider" }
  ];
  const perDeptBlocks: unknown[] = [];
  const summaryLines: string[] = [];
  for (const s of summaries) {
    summaryLines.push(`${s.departmentName}: ${s.totalCompleted} done · ${s.totalHoursLogged.toFixed(1)}h`);
    // Reuse the formatter but strip its leading header / footer so the
    // combined recap doesn't repeat the same context line N times.
    const { blocks } = formatEodForSlack(s);
    const body = blocks.filter((b) => {
      const blk = b as { type?: string };
      return blk.type !== "header" && blk.type !== "context";
    });
    if (body.length === 0) continue;
    perDeptBlocks.push(...body);
  }

  // Thrown failures bubble to the caller (route → 500). The dedupe write only
  // happens after a successful post, so a failed post is retried next tick.
  await postMessage(
    recapChannel,
    `Daily Recap · ${today}\n` + summaryLines.join(" · "),
    [...headerBlocks, ...perDeptBlocks]
  );
  await supabase
    .from("workspace_settings")
    .update({ last_eod_recap_at: new Date().toISOString() })
    .eq("id", "workspace");
  return { ok: true, posted: summaries.length };
}
