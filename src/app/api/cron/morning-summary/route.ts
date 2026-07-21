import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { postMessage } from "@/lib/slack";
import type { HealthLabel } from "@/lib/client-health";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// /api/cron/morning-summary — daily Slack ping listing every client
// whose effective health is at_risk or shaky, posted to the workspace
// scaled-team channel. Spec v2 Section 5: "Daily morning summary:
// 'X clients at risk today' with one-click open."
//
// Schedule via Railway cron at e.g. 09:00 America/New_York. Safe to
// run multiple times in a day — it just re-posts the same snapshot.

const LABEL_EMOJI: Record<HealthLabel, string> = {
  thriving: "🟢",
  steady: "🔵",
  shaky: "🟡",
  at_risk: "🔴"
};

const SEVERITY: Record<HealthLabel, number> = {
  thriving: 0,
  steady: 1,
  shaky: 2,
  at_risk: 3
};

export async function GET() {
  const supabase = getSupabaseAdmin();

  const { data: ws } = await supabase
    .from("workspace_settings")
    .select("scaled_team_channel_id, app_base_url")
    .eq("id", "workspace")
    .maybeSingle();
  const channel = (ws?.scaled_team_channel_id as string | null) ?? null;
  if (!channel) {
    return NextResponse.json({ ok: false, error: "no scaled-team channel configured" }, { status: 400 });
  }
  if (!process.env.SLACK_BOT_TOKEN) {
    return NextResponse.json({ ok: false, error: "SLACK_BOT_TOKEN missing" }, { status: 400 });
  }

  const { data: clientsRaw, error } = await supabase
    .from("clients")
    .select("id, name, health_label, health_override_label, health_summary, health_computed_at");
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const clients = (clientsRaw ?? []) as Array<{
    id: string;
    name: string;
    health_label: HealthLabel | null;
    health_override_label: HealthLabel | null;
    health_summary: string | null;
    health_computed_at: string | null;
  }>;

  // Effective label = override if set else computed. Treat null as
  // "no signal yet" — don't surface those in the morning report.
  const atRisk = clients
    .map((c) => ({
      ...c,
      effective: (c.health_override_label ?? c.health_label) as HealthLabel | null
    }))
    .filter((c) => c.effective === "at_risk" || c.effective === "shaky")
    .sort((a, b) => SEVERITY[b.effective!] - SEVERITY[a.effective!]);

  // Build the Slack payload. Empty days get a "no clients at risk"
  // green note so the team trusts the cron is running.
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York"
  });
  let text: string;
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `☀️ Morning Client Health · ${dateStr}` }
    }
  ];
  const baseUrl = (ws?.app_base_url as string | null) ?? "";

  if (atRisk.length === 0) {
    text = `Morning Client Health (${dateStr}) — every client is steady or better.`;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "🟢 *Every client is steady or better today.* No at-risk or shaky accounts to chase." }
    });
  } else {
    text = `Morning Client Health (${dateStr}) — ${atRisk.length} client${atRisk.length === 1 ? "" : "s"} need attention.`;
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `*${atRisk.length}* client${atRisk.length === 1 ? "" : "s"} at risk or shaky — start the day with these.`
      }]
    });
    blocks.push({ type: "divider" });
    for (const c of atRisk) {
      const emoji = LABEL_EMOJI[c.effective!];
      const link = baseUrl
        ? `<${baseUrl}/clients/${c.id}|Open in Scaled Operations>`
        : `\`/clients/${c.id}\``;
      const summary = c.health_summary
        ? `\n_${c.health_summary.slice(0, 280)}_`
        : "";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${c.name}* — _${c.effective}_  ·  ${link}${summary}`
        }
      });
    }
  }

  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: `Auto-generated from inbound-email sentiment · overrides honored`
    }]
  });

  try {
    await postMessage(channel, text, blocks);
    return NextResponse.json({
      ok: true,
      sent: { atRiskCount: atRisk.length, channel, date: dateStr }
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "slack post failed"
    }, { status: 500 });
  }
}
