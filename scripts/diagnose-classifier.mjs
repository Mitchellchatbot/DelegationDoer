// Diagnose WHY email-intake classification is failing — i.e. why inbound
// threads pile up in routing-review as "Couldn't auto-summarize"
// (review_reason='classifier-failed'). Those parks happen when the Haiku
// classify call in src/lib/email-classifier.ts throws or returns non-JSON;
// the catch there falls back to the placeholder body and parks the thread.
//
// This script reproduces that EXACT path and prints the real error the app
// swallows, isolating which stage breaks:
//   Stage 1 — resolve the Anthropic key the same way src/lib/anthropic-key.ts
//             does: prefer ANTHROPIC_API_KEY from env, else read the Supabase
//             Vault via the get_secret RPC with the service-role key.
//   Stage 2 — make one minimal classify call to the SAME model the app uses.
//
// Dependency-free, mirrors the other scripts/*.mjs. Run it WHERE THE REAL
// SECRETS LIVE so it tests production config:
//   railway run node scripts/diagnose-classifier.mjs
// or locally after putting the keys in .env.local:
//   node scripts/diagnose-classifier.mjs
//
// Reads (same var names + fallbacks as the app):
//   ANTHROPIC_API_KEY                          (optional direct override)
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY | SERVICE_ROLE_KEY
//
// CLASSIFY_MODEL / VAULT_SECRET_NAME mirror src/lib/anthropic-client.ts
// (MODELS.classify) and src/lib/anthropic-key.ts — keep them in sync.

import fs from "node:fs";
import path from "node:path";

const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";
const VAULT_SECRET_NAME = "ANTHROPIC_API_KEY";

// Load .env.local without adding a dotenv dep (same loader the other
// scripts use). Env already set on the process (e.g. via `railway run`)
// wins over the file.
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Never print a full secret. Show enough to tell two keys apart.
const mask = (k) =>
  k ? `${k.slice(0, 7)}…${k.slice(-4)} (len ${k.length})` : "(none)";

// ── Stage 1: resolve the Anthropic key exactly like anthropic-key.ts ──
async function resolveKey() {
  const direct = process.env.ANTHROPIC_API_KEY;
  if (direct && direct.trim()) {
    console.log(`[key] using ANTHROPIC_API_KEY from env: ${mask(direct.trim())}`);
    return direct.trim();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "No ANTHROPIC_API_KEY in env, and no Supabase URL/service key to read the " +
        "Vault (looked for SUPABASE_SERVICE_ROLE_KEY and SERVICE_ROLE_KEY). " +
        "Run this with the production env (railway run …)."
    );
  }

  console.log(`[key] reading Vault via get_secret RPC at ${url}`);
  const r = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/get_secret`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ secret_name: VAULT_SECRET_NAME })
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(
      `Vault get_secret RPC failed: HTTP ${r.status} ${r.statusText} — ${text}`
    );
  }
  // The RPC returns the bare text value, JSON-encoded (a quoted string) — or
  // null when the secret/RPC isn't set up.
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  if (!value || typeof value !== "string") {
    throw new Error(
      `Vault returned no string secret named "${VAULT_SECRET_NAME}" (got: ${text}). ` +
        "Confirm the secret exists in Supabase → Vault and the get_secret RPC is installed."
    );
  }
  console.log(`[key] Vault returned a key: ${mask(value)}`);
  return value;
}

// ── Stage 2: make the SAME minimal classify call the app makes ──
async function tryClassify(key) {
  console.log(`[anthropic] POST /v1/messages  model=${CLASSIFY_MODEL}`);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      max_tokens: 64,
      system: "Reply with the single word OK.",
      messages: [{ role: "user", content: "Subject: ping\n\nDiagnostic." }]
    })
  });
  const body = await r.text();
  if (!r.ok) {
    throw new Error(`Anthropic API error: HTTP ${r.status} ${r.statusText}\n${body}`);
  }
  console.log("[anthropic] success:", body.slice(0, 300));
}

(async () => {
  try {
    const key = await resolveKey();
    await tryClassify(key);
    console.log(
      "\n✅ Classification path is HEALTHY — the key resolves and the model responds."
    );
    console.log(
      "   If routing-review still floods, the running deploy likely cached an empty/old key\n" +
        "   at boot (anthropic-key.ts caches for the process lifetime) — redeploy to clear it."
    );
    process.exit(0);
  } catch (err) {
    console.error(
      '\n❌ This is exactly why emails park as "Couldn\'t auto-summarize":\n'
    );
    console.error(String(err && err.message ? err.message : err));
    console.error("\nWhat each failure means:");
    console.error("  HTTP 401 / authentication_error → key in Vault is missing/invalid/revoked → set a valid key");
    console.error("  HTTP 404 / not_found_error       → model id wrong/retired → fix MODELS.classify in anthropic-client.ts");
    console.error("  HTTP 400 + credit/billing        → Anthropic account out of credit → top up billing");
    console.error("  HTTP 429 / rate_limit_error      → Anthropic rate/quota limit → raise limit or back off");
    console.error("  Vault get_secret failed / null   → secret or RPC not set up on this project (see README)");
    process.exit(1);
  }
})();
