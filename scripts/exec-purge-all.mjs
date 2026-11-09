// Decommission the Executive AI Assistant's data: every exec_* row, children first (P8 contract §3.14.3, M10).
//
// HAND-RUN ONLY. Never run by a builder, CI or a job. The daily system purge (exec.purge) covers retention while
// EXEC_ENABLED=true; this script is for turning Executive AI off for good.
//
//   node scripts/exec-purge-all.mjs                           dry run (the default): prints "table: <count>" per table
//   node scripts/exec-purge-all.mjs --apply                   deletes every row, children first; keeps exec_audit_log
//   node scripts/exec-purge-all.mjs --apply --include-audit   also deletes exec_audit_log
//
// --apply refuses (exit 2) while any exec_slack_installations row is still active (revoked_at null): disconnect Slack in
// Executive AI → Settings first, so Slack revokes the tokens before their rows go. A table that doesn't exist (the phase's
// migration was never applied) prints "not installed". Output is table names and counts only: never a row, a value, an
// error body or a key.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local), as scripts/find-users.mjs reads them.

import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// Children before parents (every foreign key of P2a-P8 respected), each with a column that is never null (the DELETE
// filter PostgREST requires). exec_slack_author_optouts goes before exec_slack_channels (P7a contract §7.6); the P8 brief
// tables first; exec_audit_log only with --include-audit (exec_drafts' audit reference is set null, and it goes first).
const EXEC_PURGE_ORDER = Object.freeze([
  // P8
  { table: "exec_brief_checkins", key: "id" },
  { table: "exec_brief_mentions", key: "principal_id" },
  { table: "exec_briefs", key: "id" },
  // P7b
  { table: "exec_slack_message_links", key: "principal_id" },
  { table: "exec_slack_channel_links", key: "principal_id" },
  { table: "exec_slack_digests", key: "id" },
  // P7a
  { table: "exec_slack_items", key: "id" },
  { table: "exec_slack_messages", key: "principal_id" },
  { table: "exec_slack_threads", key: "principal_id" },
  { table: "exec_slack_deleted", key: "principal_id" },
  { table: "exec_slack_purge_log", key: "id" },
  { table: "exec_slack_rate", key: "team_id" },
  { table: "exec_slack_dd_bot", key: "team_id" },
  { table: "exec_slack_author_optouts", key: "principal_id" },
  { table: "exec_slack_channels", key: "principal_id" },
  // P6
  { table: "exec_slack_posts", key: "installation_id" },
  { table: "exec_chat_feedback", key: "principal_id" },
  { table: "exec_slack_events", key: "event_id" },
  { table: "exec_oauth_states", key: "nonce_hash" },
  // P5b
  { table: "exec_task_proposals", key: "id" },
  { table: "exec_messages", key: "id" },
  { table: "exec_conversations", key: "id" },
  // P5a
  { table: "exec_attention_feedback", key: "id" },
  { table: "exec_ddtext_signals", key: "principal_id" },
  { table: "exec_ddtext_items", key: "principal_id" },
  // P4
  { table: "exec_drafts", key: "id" },
  { table: "exec_voice_profile", key: "principal_id" },
  // P3
  { table: "exec_email_signals", key: "principal_id" },
  { table: "exec_commitments", key: "id" },
  { table: "exec_email_threads", key: "principal_id" },
  // P2b / P2a
  { table: "exec_attention_items", key: "id" },
  { table: "exec_jobs", key: "id" },
  { table: "exec_sync_state", key: "principal_id" },
  { table: "exec_ai_usage", key: "id" },
  { table: "exec_access_log", key: "id" },
  { table: "exec_audit_log", key: "id", audit: true },
  { table: "exec_slack_installations", key: "id" },
  { table: "exec_settings", key: "principal_id" },
  { table: "exec_principals", key: "id" }
]);

const USAGE = "usage: node scripts/exec-purge-all.mjs [--apply] [--keep-audit | --include-audit]";
const args = process.argv.slice(2);
const known = new Set(["--apply", "--keep-audit", "--include-audit"]);
if (args.some((a) => !known.has(a)) || (args.includes("--keep-audit") && args.includes("--include-audit"))) {
  console.error(USAGE);
  process.exit(1);
}
const apply = args.includes("--apply");
const includeAudit = args.includes("--include-audit");

const headers = (extra = {}) => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...extra });
const rest = (table, query) => `${SUPABASE_URL}/rest/v1/${table}?${query}`;

/** The row count of a Content-Range header ("0-24/120" or "*\/0"), or null. */
function rangeCount(res) {
  const m = String(res.headers.get("content-range") ?? "").match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** A missing table: 404, or PostgREST's PGRST205 / Postgres's 42P01 in the (never printed) error body. */
async function isMissing(res) {
  if (res.status === 404) return true;
  try {
    const body = await res.clone().json();
    return body?.code === "PGRST205" || body?.code === "42P01";
  } catch {
    return false;
  }
}

/** HEAD select=* with Prefer: count=exact → the table's row count, "not installed", or an error status. */
async function countRows(table) {
  const res = await fetch(rest(table, "select=*"), { method: "HEAD", headers: headers({ Prefer: "count=exact" }) });
  if (res.ok) return { count: rangeCount(res) ?? 0 };
  if (await isMissing(res)) return { missing: true };
  return { error: res.status };
}

if (!apply) {
  console.log("exec-purge-all: DRY RUN (nothing is deleted; --apply deletes)");
  let errors = 0;
  for (const { table, audit } of EXEC_PURGE_ORDER) {
    const r = await countRows(table);
    const note = audit && !includeAudit ? " (kept: --include-audit deletes it)" : "";
    if (r.missing) console.log(`${table}: not installed`);
    else if (r.error !== undefined) {
      errors += 1;
      console.log(`${table}: error ${r.error}`);
    } else console.log(`${table}: ${r.count}${note}`);
  }
  process.exit(errors > 0 ? 1 : 0);
}

// --apply: refuse while Slack is still connected (its tokens must be revoked by Slack first).
{
  const res = await fetch(rest("exec_slack_installations", "select=id&revoked_at=is.null&limit=1"), { method: "GET", headers: headers() });
  if (res.ok) {
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      console.error("exec-purge-all: refused: a Slack installation is still active. Disconnect Slack in Executive AI → Settings first, so Slack revokes the tokens.");
      process.exit(2);
    }
  } else if (!(await isMissing(res))) {
    console.error(`exec-purge-all: refused: the Slack installation check failed (${res.status})`);
    process.exit(2);
  }
}

console.log(`exec-purge-all: APPLY (${includeAudit ? "exec_audit_log included" : "exec_audit_log kept"})`);
for (const { table, key, audit } of EXEC_PURGE_ORDER) {
  if (audit && !includeAudit) {
    console.log(`${table}: kept`);
    continue;
  }
  const res = await fetch(rest(table, `${key}=not.is.null`), { method: "DELETE", headers: headers({ Prefer: "count=exact,return=minimal" }) });
  if (res.ok) {
    console.log(`${table}: deleted ${rangeCount(res) ?? 0}`);
  } else if (await isMissing(res)) {
    console.log(`${table}: not installed`);
  } else {
    // Stop: the children-first order must hold; re-run after fixing the cause (every delete so far is final).
    console.error(`${table}: failed (${res.status}); stopped`);
    process.exit(1);
  }
}
process.exit(0);
