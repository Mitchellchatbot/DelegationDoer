// Read-only probe for the Ask AI inbox search fix (search_inbox).
//
// Answers three questions against the LIVE mail service, without writing
// anything:
//   1. How much mail is actually archived? (open vs closed vs pending split)
//   2. Would the OLD query shape have found a given email?
//   3. Does the NEW query shape find it?
//
// The old shape pinned folder=INBOX + status=open and capped at 20 rows, so
// anything archived, sent-only, or past the 20 newest matches was invisible.
// The new shape drops the status pin on a filtered lookup and walks INBOX+SENT.
//
// Required env (read from .env.local):
//   MISSIVE_API_URL, MISSIVE_API_TOKEN
//
// Usage:
//   node scripts/probe-inbox-search.mjs --from kristin@impactwellnessnetwork.com
//   node scripts/probe-inbox-search.mjs --subject "payment declined"
//   node scripts/probe-inbox-search.mjs --from deel.com --after 2026-01-01
//   node scripts/probe-inbox-search.mjs --stats-only
//   railway run node scripts/probe-inbox-search.mjs --from <addr>

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

const MISSIVE_URL = (process.env.MISSIVE_API_URL || "").replace(/\/+$/, "");
const MISSIVE_TOK = process.env.MISSIVE_API_TOKEN;
for (const [k, v] of Object.entries({ MISSIVE_URL, MISSIVE_TOK })) {
  if (!v) { console.error(`missing env: ${k}`); process.exit(1); }
}

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flags = new Set(process.argv.slice(2));

const from = argOf("from");
const to = argOf("to");
const subject = argOf("subject");
const after = argOf("after");
const before = argOf("before");
const text = argOf("query");
const statsOnly = flags.has("--stats-only");

if (!statsOnly && !from && !to && !subject && !after && !before && !text) {
  console.error("give at least one of --from / --to / --subject / --after / --before / --query, or --stats-only");
  process.exit(1);
}

async function threads(params) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
  const url = `${MISSIVE_URL}/api/threads?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MISSIVE_TOK}` },
    cache: "no-store"
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET /api/threads -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Mirrors the quoting rule in src/lib/ai-tools.ts inboxQueryTerm(): always
// quote, strip embedded quotes (the clone's tokenizer has no escape syntax).
const term = (key, raw) => {
  if (!raw) return "";
  const v = String(raw).replace(/"/g, " ").replace(/\s+/g, " ").trim();
  return v ? `${key}:"${v}"` : "";
};

const q = [
  term("from", from),
  term("to", to),
  term("subject", subject),
  after ? `after:${after}` : "",
  before ? `before:${before}` : "",
  text ? `"${String(text).replace(/"/g, " ").trim()}"` : ""
].filter(Boolean).join(" ");

const fmt = (t) => {
  const when = t.last_message_at ? new Date(Number(t.last_message_at) || Date.parse(t.last_message_at)) : null;
  const day = when && !isNaN(when) ? when.toISOString().slice(0, 10) : "?";
  return `    [${String(t.status).padEnd(7)}] ${day}  ${(t.last_from || "?").slice(0, 38).padEnd(38)} ${(t.subject || "(no subject)").slice(0, 60)}`;
};

(async () => {
  console.log(`mail service: ${MISSIVE_URL}\n`);

  // ---- 1. status split over a large recent sample -------------------------
  console.log("1) status split (sample of up to 1000 most recent threads, all folders)");
  const counts = { open: 0, pending: 0, closed: 0 };
  let scanned = 0;
  for (let offset = 0; offset < 1000; offset += 200) {
    const page = await threads({ limit: 200, offset });
    if (!page.threads?.length) break;
    for (const t of page.threads) {
      scanned += 1;
      if (counts[t.status] !== undefined) counts[t.status] += 1;
    }
    if (!page.hasMore) break;
  }
  const pct = (n) => (scanned ? ((n / scanned) * 100).toFixed(1) : "0.0");
  console.log(`   scanned ${scanned}`);
  for (const k of ["open", "pending", "closed"]) {
    console.log(`   ${k.padEnd(8)} ${String(counts[k]).padStart(5)}  (${pct(counts[k])}%)`);
  }
  console.log(`   -> ${counts.closed} archived/done threads were invisible to the old tool at any limit.\n`);

  if (statsOnly) return;

  console.log(`query string DD now builds:  ${q}\n`);

  // ---- 2. the OLD shape ---------------------------------------------------
  // folder=INBOX & status=open & limit=20 — exactly what ai-tools.ts sent.
  const old = await threads({ folder: "INBOX", status: "open", q, limit: 20 });
  console.log(`2) OLD shape  (folder=INBOX & status=open & limit=20): ${old.threads.length} hit(s)`);
  old.threads.slice(0, 10).forEach((t) => console.log(fmt(t)));

  // ---- 3. the NEW shape ---------------------------------------------------
  // No status pin; INBOX + SENT walked separately and merged, 50/page.
  const seen = new Map();
  for (const folder of ["INBOX", "SENT"]) {
    for (let page = 0; page < 3; page += 1) {
      const res = await threads({ folder, q, limit: 50, offset: page * 50 });
      for (const t of res.threads) if (!seen.has(t.id)) seen.set(t.id, t);
      if (!res.hasMore || !res.threads.length) break;
    }
  }
  const merged = [...seen.values()].sort(
    (a, b) => (Number(b.last_message_at) || 0) - (Number(a.last_message_at) || 0)
  );
  console.log(`\n3) NEW shape  (no status pin, INBOX+SENT, 3 pages each): ${merged.length} hit(s)`);
  merged.slice(0, 15).forEach((t) => console.log(fmt(t)));

  // ---- verdict ------------------------------------------------------------
  const oldIds = new Set(old.threads.map((t) => t.id));
  const gained = merged.filter((t) => !oldIds.has(t.id));
  console.log(`\nVERDICT: the fix surfaces ${gained.length} thread(s) the old tool could not reach.`);
  if (gained.length) {
    const byStatus = gained.reduce((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {});
    console.log(`  newly reachable by status: ${JSON.stringify(byStatus)}`);
    console.log("  first few:");
    gained.slice(0, 8).forEach((t) => console.log(fmt(t)));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
