// Read-only: print users matching name/email substrings, so an allowlist can
// be keyed on exact emails instead of guessed.
//
//   node scripts/find-users.mjs mitch sam tabrez farez
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local).

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

const terms = process.argv.slice(2).map((t) => t.toLowerCase());

const res = await fetch(
  `${SUPABASE_URL}/rest/v1/users?select=name,email,role,is_admin&order=name.asc`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
);
if (!res.ok) {
  console.error(`${res.status} ${res.statusText}: ${await res.text()}`);
  process.exit(1);
}
const users = await res.json();

const rows = terms.length
  ? users.filter((u) =>
      terms.some((t) =>
        (u.name ?? "").toLowerCase().includes(t) ||
        (u.email ?? "").toLowerCase().includes(t)
      ))
  : users;

console.log(`${rows.length} of ${users.length} users\n`);
for (const u of rows) {
  const flags = [u.role, u.is_admin ? "ADMIN" : null].filter(Boolean).join(" ");
  console.log(`${(u.name ?? "?").padEnd(22)} ${(u.email ?? "-").padEnd(30)} ${flags}`);
}
