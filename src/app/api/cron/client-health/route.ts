import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { classifyBatch, scoreToLabel, type HealthLabel } from "@/lib/client-health";
import { postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// /api/cron/client-health — daily cron that scores each client's
// recent inbound emails for sentiment, aggregates to one of four
// labels (thriving / steady / shaky / at_risk), and writes the
// result back to the clients row. Leader overrides (health_override_*)
// are untouched by this; the UI picks them over the computed label
// at display time.
//
// Source: missive.messages (the missiveclone schema in DD's same
// Supabase project). We match messages to clients by sender email,
// either an exact contact_emails hit or a domain-of-domain_location
// hit, looking at the last 14 days and capping at ~25 messages per
// client so a chatty client doesn't dominate token spend.

const LOOKBACK_DAYS = 14;
const MAX_MESSAGES_PER_CLIENT = 25;

interface MissiveMessage {
  id: string;
  subject: string | null;
  body_text: string | null;
  from_addr: string | null;
  sent_at: number;
}

interface ClientRow {
  id: string;
  name: string;
  contact_emails: string[] | null;
  domain_location: string | null;
  health_label: HealthLabel | null;
}

// Severity ranking — used to detect downgrades. Higher number = worse.
// We ping Slack on any transition that moves the label *up* this scale
// (thriving→steady is a small step, thriving→at_risk is a cliff).
const SEVERITY: Record<HealthLabel, number> = {
  thriving: 0,
  steady: 1,
  shaky: 2,
  at_risk: 3
};

// Human-readable emoji for the Slack ping.
const LABEL_EMOJI: Record<HealthLabel, string> = {
  thriving: "🟢",
  steady: "🔵",
  shaky: "🟡",
  at_risk: "🔴"
};

export async function GET() {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ ok: false, error: "OPENAI_API_KEY not configured" }, { status: 500 });
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ ok: false, error: "Supabase env not configured" }, { status: 500 });
  }

  const supabase = getSupabaseAdmin();

  const { data: clientsRaw, error: clientsErr } = await supabase
    .from("clients")
    .select("id, name, contact_emails, domain_location, health_label");
  if (clientsErr) {
    return NextResponse.json({ ok: false, error: `clients fetch: ${clientsErr.message}` }, { status: 500 });
  }
  const clients = (clientsRaw ?? []) as ClientRow[];
  if (clients.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, updated: 0, note: "no clients" });
  }

  // Build lookup tables: emailLower → clientId, domainLower → clientId.
  // Domain matching is the fallback for when a client emails from a
  // colleague address we haven't catalogued yet.
  const emailToClient = new Map<string, string>();
  const domainToClient = new Map<string, string>();
  const clientsWithoutSignal: string[] = []; // names of clients with no email AND no domain
  for (const c of clients) {
    let hasSignal = false;
    for (const e of c.contact_emails ?? []) {
      if (typeof e === "string" && e.includes("@")) {
        emailToClient.set(e.toLowerCase(), c.id);
        hasSignal = true;
      }
    }
    if (c.domain_location) {
      const d = extractDomain(c.domain_location);
      if (d) {
        domainToClient.set(d.toLowerCase(), c.id);
        hasSignal = true;
      }
    }
    if (!hasSignal) clientsWithoutSignal.push(c.name);
  }

  const since = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  // Pull recent inbound messages via the SECURITY DEFINER RPC.
  // Supabase's PostgREST caps row responses at 1000 regardless of
  // the function's LIMIT, so we page through in 1000-row chunks
  // until the well runs dry. Memory cap: hard-stop at 50k messages
  // (a busy 14-day window for a midsize org) so a runaway dataset
  // can't OOM the cron container.
  const PAGE_SIZE = 1000;
  const HARD_CAP = 50_000;
  const msgs: MissiveMessage[] = [];
  while (msgs.length < HARD_CAP) {
    const { data: page, error: msgsErr } = await supabase.rpc(
      "recent_inbound_missive_messages",
      { since_ms: since, msg_limit: PAGE_SIZE, offset_rows: msgs.length }
    );
    if (msgsErr) {
      return NextResponse.json({ ok: false, error: `missive fetch: ${msgsErr.message}` }, { status: 500 });
    }
    const rows = (page ?? []) as MissiveMessage[];
    msgs.push(...rows);
    // Short page = we've reached the end. PostgREST always returns
    // up to PAGE_SIZE for a successful query, so anything less means
    // there's nothing left to paginate.
    if (rows.length < PAGE_SIZE) break;
  }

  // Bucket messages by client + remember which senders we couldn't
  // place so the response can surface them — that's how leaders find
  // out which clients are missing contact_emails / domain_location.
  const byClient = new Map<string, MissiveMessage[]>();
  const unmatchedDomainCounts = new Map<string, number>();
  let parseableSenders = 0;
  for (const m of msgs) {
    const sender = extractEmailAddress(m.from_addr ?? "");
    if (!sender) continue;
    parseableSenders++;
    let clientId = emailToClient.get(sender.toLowerCase());
    if (!clientId) {
      const dom = sender.split("@")[1]?.toLowerCase();
      if (dom) clientId = domainToClient.get(dom);
    }
    if (!clientId) {
      const dom = sender.split("@")[1]?.toLowerCase();
      if (dom) unmatchedDomainCounts.set(dom, (unmatchedDomainCounts.get(dom) ?? 0) + 1);
      continue;
    }
    const list = byClient.get(clientId) ?? [];
    if (list.length < MAX_MESSAGES_PER_CLIENT) list.push(m);
    byClient.set(clientId, list);
  }
  const topUnmatchedDomains = Array.from(unmatchedDomainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  // Prior label per client — used to decide whether to ping Slack
  // about a downgrade after the new label is written.
  const priorLabelById = new Map<string, HealthLabel | null>();
  const clientNameById = new Map<string, string>();
  for (const c of clients) {
    priorLabelById.set(c.id, c.health_label ?? null);
    clientNameById.set(c.id, c.name);
  }

  // One workspace-channel ping per run, batched at the end with a list
  // of every client that worsened. Avoids the team getting spammed if
  // 10 clients drop in one cron pass.
  const downgrades: Array<{ name: string; from: HealthLabel | null; to: HealthLabel }> = [];

  const results: Array<{ clientId: string; label: HealthLabel; sample: number; score: number; summary: string }> = [];
  const errors: Array<{ clientId: string; error: string }> = [];
  const now = new Date().toISOString();

  for (const [clientId, clientMsgs] of byClient.entries()) {
    if (clientMsgs.length === 0) continue;
    try {
      const snippets = clientMsgs.map((m) => ({
        id: m.id,
        subject: m.subject ?? "",
        body: stripQuotedReply(m.body_text ?? "")
      }));
      const { scores } = await classifyBatch(snippets);
      if (scores.length === 0) {
        errors.push({ clientId, error: "no scores returned" });
        continue;
      }
      const avg = scores.reduce((s, x) => s + x.sentiment, 0) / scores.length;
      const label = scoreToLabel(avg);
      // Build a one-paragraph summary from the most negative + most
      // positive reasons so leaders can see what the model latched onto.
      const sorted = [...scores].sort((a, b) => a.sentiment - b.sentiment);
      const lowest = sorted[0]?.reason || "";
      const highest = sorted[sorted.length - 1]?.reason || "";
      const summary = [
        lowest && `Most concerning: ${lowest}`,
        highest && lowest !== highest && `Most positive: ${highest}`
      ].filter(Boolean).join(" · ").slice(0, 500);

      const { error: updateErr } = await supabase
        .from("clients")
        .update({
          health_score: Number(avg.toFixed(3)),
          health_label: label,
          health_sample_size: scores.length,
          health_summary: summary,
          health_computed_at: now
        })
        .eq("id", clientId);
      if (updateErr) {
        errors.push({ clientId, error: updateErr.message });
        continue;
      }
      // Track downgrades (worse severity than prior). null prior counts
      // as "no signal yet" — only ping when we're moving *from* a known
      // label, so a first-time scoring of a brand-new client doesn't
      // spam Slack with "Acme dropped from null to thriving".
      const prior = priorLabelById.get(clientId) ?? null;
      if (prior && SEVERITY[label] > SEVERITY[prior]) {
        downgrades.push({ name: clientNameById.get(clientId) ?? clientId, from: prior, to: label });
      }
      results.push({ clientId, label, sample: scores.length, score: avg, summary });
    } catch (err) {
      errors.push({ clientId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Slack ping for downgrades — single batched message so a bad cron
  // run doesn't fan out 10 separate notifications. Posts to the
  // workspace's configured scaled-team channel; silently no-ops if
  // either the channel or the bot token isn't configured.
  let slackPing: { delivered: boolean; reason?: string } = { delivered: false };
  if (downgrades.length > 0) {
    try {
      const { data: ws } = await supabase
        .from("workspace_settings")
        .select("scaled_team_channel_id")
        .eq("id", "workspace")
        .maybeSingle();
      const channel = (ws?.scaled_team_channel_id as string | null) ?? null;
      if (!channel) {
        slackPing = { delivered: false, reason: "no scaled-team channel configured" };
      } else if (!process.env.SLACK_BOT_TOKEN) {
        slackPing = { delivered: false, reason: "SLACK_BOT_TOKEN missing" };
      } else {
        const lines = downgrades.map((d) =>
          `${LABEL_EMOJI[d.to]} *${d.name}* — ${d.from} → *${d.to}*`
        );
        const headline =
          downgrades.length === 1
            ? `Client health drop detected`
            : `${downgrades.length} client health drops detected`;
        const text = `${headline}\n${lines.join("\n")}`;
        const blocks = [
          { type: "header", text: { type: "plain_text", text: `🚨 ${headline}` } },
          {
            type: "section",
            text: { type: "mrkdwn", text: lines.join("\n") }
          },
          {
            type: "context",
            elements: [{
              type: "mrkdwn",
              text: `Auto-detected from inbound email sentiment · ${new Date(now).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
            }]
          }
        ];
        await postMessage(channel, text, blocks);
        slackPing = { delivered: true };
      }
    } catch (err) {
      slackPing = { delivered: false, reason: err instanceof Error ? err.message : "slack post failed" };
    }
  }

  return NextResponse.json({
    ok: true,
    diagnostics: {
      // Always-useful numbers. If matched is 0 the next two lines say why.
      clientsScanned: clients.length,
      clientsWithSignal: clients.length - clientsWithoutSignal.length,
      clientsMissingEmailAndDomain: clientsWithoutSignal.length,
      messagesFetched: msgs.length,
      parseableSenders,
      clientsMatched: byClient.size,
      clientsUpdated: results.length,
      // If the cron found mail but couldn't bucket it, this list tells
      // you which sender domains are showing up that aren't tied to
      // any client yet. Add them to the client's contact_emails or
      // set domain_location to start matching.
      topUnmatchedDomains,
      // Truncated sample of clients with no matchable signal yet — the
      // ones the cron literally can't reach until contact info is filled.
      sampleClientsMissingContact: clientsWithoutSignal.slice(0, 10),
      downgrades,
      slackPing
    },
    errors,
    results: results.map((r) => ({ clientId: r.clientId, label: r.label, sample: r.sample }))
  });
}

// "Foo Bar <foo@bar.com>" → "foo@bar.com"
function extractEmailAddress(s: string): string | null {
  const m = /<([^>]+@[^>]+)>/.exec(s);
  if (m) return m[1].trim();
  if (s.includes("@")) return s.trim();
  return null;
}

// "https://example.com/path" → "example.com"
function extractDomain(s: string): string | null {
  try {
    const url = new URL(s.startsWith("http") ? s : `https://${s}`);
    return url.hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

// Heuristically chop quoted-reply chains. Sentiment of "thanks!"
// shouldn't be polluted by 30 lines of reply history below it.
function stripQuotedReply(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*On .* wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}
