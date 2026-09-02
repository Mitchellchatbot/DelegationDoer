// Reconcile clients.team_id against the SEO "Teams & Sites" spreadsheet.
//
//   node scripts/seo-team-split.mjs            # dry run — reports, writes nothing
//   node scripts/seo-team-split.mjs --apply    # actually writes team_id
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local).
//
// Why a script and not a migration: the mapping is by CLIENT NAME, and names
// in the sheet are informal ("NATC", "Villa Healing Center") while the DB has
// whatever was typed at onboarding. Matching is therefore fuzzy and needs a
// human to eyeball the diff before it runs. A migration would apply blind.
//
// Safety rails:
//   - Dry run is the default. --apply is required to write.
//   - Only EXACT normalized matches are ever written. Fuzzy near-misses are
//     reported for a human to resolve by hand (or by dragging on
//     /client-teams); auto-applying them risks silently handing the wrong
//     client to the wrong lead.
//   - Clients already on the right team are skipped (no-op writes).
//   - A client in the DB that the sheet does NOT mention is left completely
//     alone. The sheet is treated as "these 39 belong to these leads", not as
//     "everything else is unassigned".

import fs from "node:fs";
import path from "node:path";

// Load .env.local without adding a dotenv dep. (Same shape as
// scripts/backfill-missive-client-labels.mjs — keep them consistent.)
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

const APPLY = process.argv.includes("--apply");
// --list just dumps every client + its current team, for eyeballing the
// names the fuzzy matcher couldn't resolve.
const LIST = process.argv.includes("--list");
// --create-missing additionally CREATES a bare client row for each sheet site
// that has no counterpart in the DB at all (name + team only — no website,
// contacts, or onboarding date). Requires --apply; on its own it only reports.
const CREATE_MISSING = process.argv.includes("--create-missing");

// --- the sheet, transcribed from ScaledAI_Teams_Sites.xlsx -------------------
// Team ids match src/lib/client-teams.ts. "Bisma" in the sheet is Bismah
// (bella@scaledai.org) => team_seo_bismah.
const SHEET = {
  team_seo_saif: [
    "Villa Healing Center", "Villa Treatment Center", "Villa Wellness Center",
    "Villa Behavioral Health", "Dynamic Behavioral Health LA", "Quest 2 Recovery",
    "Quest IOP", "Changes Treatment", "Santa Barbara Recovery", "NATC",
    "Path2Purpose", "Creative Closet Design", "Chimney Guard", "V&F Paving"
  ],
  team_seo_samir: [
    "Fortify Wellness", "Simonds Recovery Center", "Eleve Wellness",
    "Pathways Recovery", "Vive Treatment", "Cobb Defense", "Play Steppa",
    "Florida Addiction Resource", "Florida Sober Living Homes",
    "Miami Outpatient Detox"
  ],
  team_seo_bismah: [
    "The Hope Institute", "DJ Housing", "Get Holas", "Hopeful Estates",
    "Allocation Assist", "Doctors Finders", "National Mental Health Support",
    "Alcohol Awareness", "National Depression Hotline", "Cristallo Pools",
    "Innovative Outdoor Living", "Innovative Storm Defense", "Schiller Pools",
    "Pool Doctor", "Prime Pool Market"
  ]
};

// Hand-curated sheet-name -> DB-name aliases. Every one of these was a
// near-miss the matcher surfaced and a human confirmed; they are NOT guesses
// the script makes at runtime. Keeping them here (rather than loosening the
// matcher) means the write path stays exact-match-only, and the reason each
// pair is considered the same client is reviewable in the diff.
const ALIASES = {
  "Villa Wellness Center": "Villa Wellness",
  "Dynamic Behavioral Health LA": "Dynamic Behavioral Health",
  "NATC": "Northridge Addiction Treatment Center",   // acronym
  "Chimney Guard": "Chimney Guard USA",              // currently on team_seo_sam
  "Simonds Recovery Center": "Simonds Recovery Centers",
  "Vive Treatment": "Vive Treatment Centers",
  "Doctors Finders": "Doctor Finder"
};

const SEO_TEAMS = new Set([
  "team_seo_sam", "team_seo_bismah", "team_seo_samir", "team_seo_saif"
]);

// Normalization for matching. Aggressive on purpose: case, punctuation,
// ampersand spelling, and a leading "the" are all noise. Anything that
// survives this and still doesn't match is a genuine difference a human
// should look at.
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    // Split letter/digit runs so "Path2Purpose" and "Path 2 Purpose" agree.
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ");
}

// Crude singularization so "Centers"/"Center" and "Doctors"/"Doctor" collide.
// Only used for SUGGESTIONS, never for the exact-match write path — the sheet
// and the DB disagreeing on a plural is exactly the kind of thing a human
// should confirm rather than have a script guess.
function stem(s) {
  return norm(s).split(" ").map((t) => t.replace(/s$/, "")).join(" ");
}

// Token-overlap score in [0,1], used only to SUGGEST near-misses.
function similarity(a, b) {
  const A = new Set(stem(a).split(" ").filter(Boolean));
  const B = new Set(stem(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.max(A.size, B.size);
}

async function sb(pathname, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  // `Prefer: return=minimal` yields an EMPTY body — 204 on PATCH but 201 on
  // POST — so status alone isn't enough to decide whether to parse. Read the
  // text and only parse when there's something there. (Parsing an empty body
  // threw "Unexpected end of JSON input" *after* the write had already
  // succeeded, which is the worst kind of failure: it looks like nothing
  // happened when in fact it did.)
  const text = await res.text();
  return text.trim() ? JSON.parse(text) : null;
}

const TEAM_LABEL = {
  team_seo_saif: "Saif", team_seo_samir: "Samir",
  team_seo_bismah: "Bismah", team_seo_sam: "Sam"
};

async function main() {
  const clients = await sb("clients?select=id,name,team_id&order=name.asc");
  console.log(`DB: ${clients.length} clients total\n`);

  if (LIST) {
    clients.forEach((c, i) => {
      console.log(`${String(i + 1).padStart(2)} | ${(c.team_id ?? "-").padEnd(16)} | ${c.name}`);
    });
    return;
  }

  // normalized name -> client rows (array, so we can detect duplicate names)
  const byNorm = new Map();
  for (const c of clients) {
    const k = norm(c.name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(c);
  }

  const writes = [];     // { client, from, to }
  const alreadyOk = [];  // sheet rows already on the right team
  const ambiguous = [];  // sheet name hitting >1 DB row
  const missing = [];    // sheet name with no exact match (+ suggestions)

  for (const [teamId, names] of Object.entries(SHEET)) {
    for (const name of names) {
      const lookup = ALIASES[name] ?? name;
      const hits = byNorm.get(norm(lookup)) ?? [];
      if (hits.length === 0) {
        const suggestions = clients
          .map((c) => ({ c, s: similarity(name, c.name) }))
          .filter((x) => x.s >= 0.34)
          .sort((a, b) => b.s - a.s)
          .slice(0, 3);
        missing.push({ teamId, name, suggestions });
      } else if (hits.length > 1) {
        ambiguous.push({ teamId, name, hits });
      } else {
        const c = hits[0];
        if (c.team_id === teamId) alreadyOk.push({ teamId, c });
        else writes.push({ client: c, from: c.team_id, to: teamId });
      }
    }
  }

  // SEO-owned clients in the DB that the sheet never mentions. Reported so a
  // human can decide; never touched automatically.
  const sheetNorms = new Set(
    Object.values(SHEET).flat().map((n) => norm(ALIASES[n] ?? n))
  );
  const orphans = clients.filter(
    (c) => SEO_TEAMS.has(c.team_id ?? "") && !sheetNorms.has(norm(c.name))
  );

  console.log(`= Already correct: ${alreadyOk.length}`);

  console.log(`\n= Will set team_id (${writes.length}):`);
  for (const w of writes) {
    const from = w.from ? (TEAM_LABEL[w.from] ?? w.from) : "unassigned";
    console.log(`   ${w.client.name}  [${from}] -> ${TEAM_LABEL[w.to]}`);
  }

  if (ambiguous.length) {
    console.log(`\n! Ambiguous — multiple clients share this name (${ambiguous.length}), SKIPPED:`);
    for (const a of ambiguous) {
      console.log(`   "${a.name}" -> ${TEAM_LABEL[a.teamId]}`);
      for (const h of a.hits) console.log(`       id=${h.id} team=${h.team_id ?? "-"}`);
    }
  }

  if (missing.length) {
    console.log(`\n! In the sheet but NOT found in DB (${missing.length}), SKIPPED:`);
    for (const m of missing) {
      console.log(`   "${m.name}" -> ${TEAM_LABEL[m.teamId]}`);
      for (const s of m.suggestions) {
        console.log(`       did you mean? "${s.c.name}" (${Math.round(s.s * 100)}%, team=${s.c.team_id ?? "-"})`);
      }
    }
  }

  if (orphans.length) {
    console.log(`\n? On an SEO team in DB but absent from the sheet (${orphans.length}), LEFT ALONE:`);
    for (const o of orphans) console.log(`   ${o.name}  [${TEAM_LABEL[o.team_id] ?? o.team_id}]`);
  }

  // Everything in the DB the sheet never names. Printed so the unmatched
  // sheet rows above can be resolved by eye against the real inventory.
  const unmentioned = clients.filter((c) => !sheetNorms.has(norm(c.name)));
  console.log(`\n? DB clients not named in the sheet (${unmentioned.length}):`);
  for (const c of unmentioned) {
    console.log(`   ${(c.team_id ?? "-").padEnd(16)} | ${c.name}`);
  }

  // Only the truly-absent ones are creatable. A sheet row that merely
  // matched ambiguously must NOT be duplicated into a new row.
  const creatable = CREATE_MISSING ? missing : [];
  if (CREATE_MISSING) {
    console.log(`\n+ Will CREATE ${creatable.length} new client(s):`);
    for (const m of creatable) console.log(`   ${m.name} -> ${TEAM_LABEL[m.teamId]}`);
  }

  if (!APPLY) {
    console.log(
      `\n--- DRY RUN. Nothing written. Re-run with --apply to write ${writes.length} change(s)` +
      (CREATE_MISSING ? ` and create ${creatable.length} client(s)` : "") + ". ---"
    );
    return;
  }

  console.log(`\nApplying ${writes.length} change(s)...`);
  let ok = 0;
  for (const w of writes) {
    await sb(`clients?id=eq.${encodeURIComponent(w.client.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ team_id: w.to })
    });
    ok++;
  }
  console.log(`Done. ${ok}/${writes.length} updated.`);

  if (creatable.length) {
    console.log(`\nCreating ${creatable.length} client(s)...`);
    let made = 0;
    for (const m of creatable) {
      // Mirror the id scheme in POST /api/clients so these rows are
      // indistinguishable from ones created through the UI.
      const slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32);
      const id = `cl_${slug}_${Math.random().toString(36).slice(2, 6)}`;
      await sb("clients", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id,
          name: m.name,
          team_id: m.teamId,
          priority: "medium",
          contact_emails: [],
          notes: "Created from the SEO Teams & Sites sheet — needs a website and contacts."
        })
      });
      console.log(`   + ${m.name} -> ${TEAM_LABEL[m.teamId]} (${id})`);
      made++;
    }
    console.log(`Done. ${made}/${creatable.length} created.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
