// One-off production diagnostic for "new emails but no new tasks".
// Reads (service role): missive_account_settings, email_intake_log,
// routing_decisions, tasks. Run: railway run node scripts/diagnose-intake-state.mjs
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("missing supabase env");
const base = url.replace(/\/+$/, "");

async function rest(path) {
  const r = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

const sinceMs = Date.now() - 36 * 3600 * 1000;
const sinceIso = new Date(sinceMs).toISOString();

// 1) account settings
const settings = await rest("missive_account_settings?select=account_id,auto_intake_enabled,last_polled_at");
const enabled = settings.filter((s) => s.auto_intake_enabled === true);
console.log(`\n=== missive_account_settings: ${settings.length} rows, ${enabled.length} auto_intake_enabled ===`);
const newestPoll = enabled.map((s) => s.last_polled_at).filter(Boolean).sort().at(-1) ?? null;
console.log("newest last_polled_at across enabled accounts:", newestPoll);
if (newestPoll) {
  const ageMin = Math.round((Date.now() - new Date(newestPoll).getTime()) / 60000);
  console.log(`  -> ${ageMin} min ago (poll healthy if < ~12 min)`);
}

// 2) email_intake_log recent distribution
const logs = await rest(
  `email_intake_log?select=thread_id,routed_via,task_id,processed_at&processed_at=gte.${sinceIso}&order=processed_at.desc&limit=500`
);
console.log(`\n=== email_intake_log: ${logs.length} rows in last 36h ===`);
const byVia = {};
for (const l of logs) byVia[l.routed_via ?? "null"] = (byVia[l.routed_via ?? "null"] || 0) + 1;
console.log("routed_via distribution:", byVia);
console.log("most recent 8:", logs.slice(0, 8).map((l) => `${l.processed_at} ${l.routed_via} task=${l.task_id ? "Y" : "-"}`));

// 3) tasks created from intake recently
const tasks = await rest(
  `tasks?select=id,created_at,is_draft,title&created_at=gte.${sinceIso}&tags=cs.{email-intake}&order=created_at.desc&limit=50`
);
console.log(`\n=== tasks tagged email-intake in last 36h: ${tasks.length} ===`);
console.log(tasks.slice(0, 8).map((t) => `${t.created_at} draft=${t.is_draft} ${t.title?.slice(0, 50)}`));

// 4) routing_decisions recent
const rd = await rest(
  `routing_decisions?select=created_at,routed_via,needs_review,review_reason,task_id&created_at=gte.${sinceIso}&order=created_at.desc&limit=200`
);
console.log(`\n=== routing_decisions: ${rd.length} in last 36h ===`);
const rdVia = {};
for (const d of rd) rdVia[`${d.routed_via}|review:${d.review_reason ?? "-"}`] = (rdVia[`${d.routed_via}|review:${d.review_reason ?? "-"}`] || 0) + 1;
console.log(rdVia);
process.exit(0);
