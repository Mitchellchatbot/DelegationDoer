import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { buildEodForAllDepartments, formatEodForSlack } from "@/lib/eod";
import { postMessage } from "@/lib/slack";

// 7pm America/New_York (0:00 UTC) recap — Vercel cron fires this once
// a day. Pulls the day's EOD summary across every department that has
// data and posts a single combined recap into the workspace's recap
// channel (defaults to Scaled Team). Idempotent via last_eod_recap_at:
// if the same UTC day has already been posted we skip.

export const dynamic = "force-dynamic";

export async function GET() {
  // DST guard: vercel.json fires this at both 23:00 and 00:00 UTC so
  // we hit 7pm America/New_York whether the country is on EDT or EST.
  // The handler refuses to do anything unless the *current* NY hour is
  // 19, so the wrong-side fire just no-ops.
  const nyHour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/New_York"
    }).format(new Date())
  );
  if (nyHour !== 19) {
    return NextResponse.json({ ok: true, skipped: "not-7pm-ny", nyHour });
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
    return NextResponse.json({ ok: false, reason: "no recap channel configured" });
  }

  // De-dupe: if the last successful recap landed in the same UTC day,
  // bail. The cron is at-least-once on Vercel so we have to defend.
  const last = settings?.last_eod_recap_at as string | null;
  if (last) {
    const lastDay = new Date(last).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (lastDay === today) {
      return NextResponse.json({ ok: true, skipped: "already-sent-today" });
    }
  }

  // Build per-department summaries and stitch them into one Block Kit
  // payload. We post a single message so the channel doesn't get
  // flooded with one per team.
  const summaries = await buildEodForAllDepartments();
  if (summaries.length === 0) {
    return NextResponse.json({ ok: true, skipped: "no-departments-with-data" });
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
  let summaryLines: string[] = [];
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

  try {
    await postMessage(
      recapChannel,
      `Daily Recap · ${today}\n` + summaryLines.join(" · "),
      [...headerBlocks, ...perDeptBlocks]
    );
    await supabase
      .from("workspace_settings")
      .update({ last_eod_recap_at: new Date().toISOString() })
      .eq("id", "workspace");
    return NextResponse.json({ ok: true, posted: summaries.length });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "unknown error"
    }, { status: 500 });
  }
}
