// Read-only: print who reports to each SEO lead, per the org chart
// (users.manager_user_id / secondary_manager_user_id). This is the exact
// source the /client-teams column tooltips read, so running this tells you
// what those tooltips will say.
//
//   node scripts/seo-team-members.mjs
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

const LEADS = {
  "steve@scaledai.org": "Saif  (team_seo_saif)",
  "samir@scaledai.org": "Samir (team_seo_samir)",
  "bella@scaledai.org": "Bismah (team_seo_bismah)"
};

const res = await fetch(
  `${SUPABASE_URL}/rest/v1/users?select=id,name,email,manager_user_id,secondary_manager_user_id&order=name.asc`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
);
if (!res.ok) {
  console.error(`${res.status} ${res.statusText}: ${await res.text()}`);
  process.exit(1);
}
const users = await res.json();

for (const [email, label] of Object.entries(LEADS)) {
  const lead = users.find((u) => (u.email ?? "").trim().toLowerCase() === email);
  if (!lead) {
    console.log(`\n${label}\n   !! no user row for ${email}`);
    continue;
  }
  const reports = users.filter(
    (u) => u.id !== lead.id &&
      (u.manager_user_id === lead.id || u.secondary_manager_user_id === lead.id)
  );
  console.log(`\n${label}  — DD user "${lead.name}"`);
  if (!reports.length) console.log("   (nobody reports to them)");
  for (const r of reports) {
    const via = r.manager_user_id === lead.id ? "primary" : "secondary";
    console.log(`   - ${r.name}  <${r.email ?? "no email"}>  [${via}]`);
  }
}
