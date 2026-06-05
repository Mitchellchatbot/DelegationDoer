// Inspect what looksAutomated() actually dropped: pull recent 'auto-filtered'
// thread_ids from email_intake_log, fetch each thread from missiveclone, and
// print sender + subject so we can judge if real client mail was filtered.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
const missiveUrl = (process.env.MISSIVE_API_URL || "").replace(/\/+$/, "");
const missiveTok = process.env.MISSIVE_API_TOKEN;
const base = url.replace(/\/+$/, "");

async function rest(path) {
  const r = await fetch(`${base}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
function extractEmail(addr) {
  const m = (addr || "").match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase();
  return addr && addr.includes("@") ? addr.trim().toLowerCase() : null;
}

const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
const which = process.argv[2] === "skipped" ? "classifier-skipped" : "auto-filtered";
const logs = await rest(
  `email_intake_log?select=thread_id,processed_at&routed_via=eq.${which}&processed_at=gte.${since}&order=processed_at.desc&limit=25`
);
console.log(`Inspecting ${logs.length} recent ${which} threads:\n`);
for (const l of logs) {
  try {
    const r = await fetch(`${missiveUrl}/api/threads/${encodeURIComponent(l.thread_id)}`, {
      headers: { Authorization: `Bearer ${missiveTok}` }
    });
    if (!r.ok) { console.log(`  [${l.thread_id}] fetch ${r.status}`); continue; }
    const d = await r.json();
    const subj = d.thread?.subject ?? "(no subject)";
    const inbound = (d.messages || []).find((m) => m.direction === "inbound");
    const from = inbound ? extractEmail(inbound.from_addr) : null;
    console.log(`• ${from}  |  "${subj.slice(0, 75)}"`);
  } catch (e) {
    console.log(`  [${l.thread_id}] error ${e.message}`);
  }
}
process.exit(0);
