// For recent classifier-skipped threads, show the body the intake pipeline
// actually feeds Claude (body_text or stripped html), so we can tell whether
// Claude judged a FULL email non-actionable (prompt problem) or an EMPTY/stub
// body (extraction problem). Run via railway run.
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
function stripHtml(html) {
  return (html || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function extractEmail(addr) {
  const m = (addr || "").match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase();
  return addr && addr.includes("@") ? addr.trim().toLowerCase() : null;
}

// A few specific real-looking client threads from the skipped list.
const wanted = [
  "Follow-Up on Meta Strategy", "Care Assist / SEO", "New message from \"Maple Moon",
  "New message from \"Emilie", "Website Review", "Innovative Outdoor Living Performance"
];
const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
const logs = await rest(
  `email_intake_log?select=thread_id&routed_via=eq.classifier-skipped&processed_at=gte.${since}&order=processed_at.desc&limit=60`
);
let shown = 0;
for (const l of logs) {
  if (shown >= 6) break;
  const r = await fetch(`${missiveUrl}/api/threads/${encodeURIComponent(l.thread_id)}`, {
    headers: { Authorization: `Bearer ${missiveTok}` }
  });
  if (!r.ok) continue;
  const d = await r.json();
  const subj = d.thread?.subject ?? "";
  if (!wanted.some((w) => subj.includes(w.replace(/\\"/g, '"')))) continue;
  const inbound = (d.messages || []).find((m) => m.direction === "inbound") || d.messages?.[0];
  const from = inbound ? extractEmail(inbound.from_addr) : null;
  const bodyText = inbound?.body_text || "";
  const bodyHtml = inbound?.body_html || "";
  const built = bodyText || stripHtml(bodyHtml);
  console.log("============================================================");
  console.log(`FROM: ${from}`);
  console.log(`SUBJ: ${subj}`);
  console.log(`messages=${(d.messages || []).length}  body_text.len=${bodyText.length}  body_html.len=${bodyHtml.length}  built.len=${built.length}`);
  console.log(`BUILT BODY (first 600): ${built.slice(0, 600)}`);
  console.log("");
  shown++;
}
console.log(`(showed ${shown} threads)`);
process.exit(0);
