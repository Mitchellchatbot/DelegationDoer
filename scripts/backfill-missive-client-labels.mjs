// One-shot backfill: pulls every client from Supabase, then drives the
// missiveclone POST /labels/backfill-clients endpoint until done. Each
// matching thread gets a label named after the client.
//
// Required env (read from .env.local):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   MISSIVE_API_URL, MISSIVE_API_TOKEN
//
// Usage:
//   node scripts/backfill-missive-client-labels.mjs           # do it
//   node scripts/backfill-missive-client-labels.mjs --dry-run # count only
//   node scripts/backfill-missive-client-labels.mjs --limit 800

import fs from "node:fs";
import path from "node:path";

// Load .env.local without adding a dotenv dep.
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISSIVE_URL  = (process.env.MISSIVE_API_URL || "").replace(/\/+$/, "");
const MISSIVE_TOK  = process.env.MISSIVE_API_TOKEN;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_KEY, MISSIVE_URL, MISSIVE_TOK })) {
  if (!v) { console.error(`missing env: ${k}`); process.exit(1); }
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("--dry");
const limitArg = (() => {
  const i = process.argv.indexOf("--limit");
  return i > 0 ? parseInt(process.argv[i + 1], 10) : NaN;
})();
const batchLimit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 400;

function extractDomain(url) {
  if (!url) return null;
  const d = String(url).trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0].split(":")[0].toLowerCase();
  return d || null;
}

async function loadClients() {
  // Page through clients via the Supabase REST API. We only need a few
  // columns; status filter excludes archived/inactive (status != 'active'
  // is uncommon but keeps the backfill scoped to current accounts).
  const url = new URL(`${SUPABASE_URL}/rest/v1/clients`);
  url.searchParams.set("select", "id,name,website,websites,contact_emails,contact_name,status");
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      // No pagination — clients table is < 1000 rows.
      Prefer: "count=exact"
    }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`supabase clients fetch failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const rows = await r.json();
  return rows.map((row) => {
    const emails = Array.isArray(row.contact_emails)
      ? row.contact_emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      : [];
    const sites = [row.website, ...(Array.isArray(row.websites) ? row.websites : [])];
    const domains = Array.from(new Set(sites.map(extractDomain).filter(Boolean)));
    // Owner / point-of-contact names. Split on comma in case multiple
    // names landed in one field, drop ones too short to be safe.
    const ownerNames = (row.contact_name ? String(row.contact_name) : "")
      .split(/[,/&]| and /i)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    return { id: row.id, name: row.name, status: row.status, emails, domains, ownerNames };
  });
}

async function callBackfill({ clients, cursor }) {
  const r = await fetch(`${MISSIVE_URL}/api/labels/backfill-clients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MISSIVE_TOK}`
    },
    body: JSON.stringify({
      clients: clients.map((c) => ({
        name: c.name,
        emails: c.emails,
        domains: c.domains,
        owner_names: c.ownerNames
      })),
      cursor,
      limit: batchLimit,
      dry_run: dryRun
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`missiveclone backfill failed (${r.status}): ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function main() {
  const t0 = Date.now();
  console.log(`mode: ${dryRun ? "DRY-RUN (no writes)" : "WRITE"}  batch_limit: ${batchLimit}`);
  console.log(`loading clients from supabase...`);
  const clients = await loadClients();
  const useful = clients.filter(
    (c) => c.emails.length > 0 || c.domains.length > 0 || c.ownerNames.length > 0
  );
  console.log(`  ${clients.length} clients loaded; ${useful.length} have at least one email or domain signal`);
  if (useful.length === 0) {
    console.log("nothing to do — no clients have matching signals");
    return;
  }

  let cursor = null;
  let totalThreads = 0;
  let totalApplied = 0;
  let labelsCreated = 0;
  let calls = 0;

  while (true) {
    calls += 1;
    const res = await callBackfill({ clients: useful, cursor });
    totalThreads += res.batch_size || 0;
    totalApplied += res.applied || 0;
    labelsCreated += res.labels_created || 0;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(
      `  [${calls.toString().padStart(4)}] batch=${(res.batch_size || 0).toString().padStart(4)} ` +
      `applied=${(res.applied || 0).toString().padStart(5)} ` +
      `total_threads=${totalThreads} total_applied=${totalApplied} ` +
      `(${elapsed}s)\n`
    );
    if (res.done) break;
    cursor = res.next_cursor;
    if (!cursor) break;
  }

  console.log(
    `\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `threads_scanned=${totalThreads} thread_label_links_${dryRun ? "would_be_added" : "added"}=${totalApplied} ` +
    `labels_created=${labelsCreated}`
  );
}

main().catch((err) => {
  console.error("\nfailed:", err.message);
  process.exit(1);
});
