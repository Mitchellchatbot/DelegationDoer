import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { classifyBatch, scoreToLabel, type HealthLabel } from "@/lib/client-health";

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
}

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
    .select("id, name, contact_emails, domain_location");
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
  // Pull recent inbound messages via the SECURITY DEFINER RPC. PostgREST
  // doesn't expose the missive schema directly (and shouldn't — every
  // user would get read access to raw mail bodies), so the cron calls
  // public.recent_inbound_missive_messages instead. Cap the global
  // query at 5000 to bound memory; we'll still cap per-client below.
  const { data: msgsRaw, error: msgsErr } = await supabase.rpc(
    "recent_inbound_missive_messages",
    { since_ms: since, msg_limit: 5000 }
  );
  if (msgsErr) {
    return NextResponse.json({ ok: false, error: `missive fetch: ${msgsErr.message}` }, { status: 500 });
  }
  const msgs = (msgsRaw ?? []) as MissiveMessage[];

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
      results.push({ clientId, label, sample: scores.length, score: avg, summary });
    } catch (err) {
      errors.push({ clientId, error: err instanceof Error ? err.message : String(err) });
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
      sampleClientsMissingContact: clientsWithoutSignal.slice(0, 10)
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
