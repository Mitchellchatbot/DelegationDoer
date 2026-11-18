// Dependency-free check for Meta onboarding (src/lib/meta-onboarding.ts). The
// repo has no test runner, so this is a plain Node script:
// `node scripts/check-meta-onboarding.mjs` (exits 0 on pass, 1 on failure).
//
// Same approach as check-fb-onboarding-sop.mjs: it transpiles the REAL module
// with the repo's own TypeScript and calls the shipped functions. The module
// has type-only imports, which transpile away, so it loads on its own.
//
// WHAT IT IS GUARDING.
//   1. The go-live checklist is the SOP's own 32 boxes, and every one of them
//      is attached to exactly one SOP step, so the step-by-step view and the
//      checklist view tick the same key and nothing is ticked twice.
//   2. The total is pinned at 32. completed_at is reconciled against the full
//      list on every save, so a new box un-completes every client who already
//      finished, on their next tick. Add one only on purpose.
//   3. No field for a secret or for the lead Sheet's link: the page is
//      readable by the whole Facebook team.
//   4. It stays OUT of FB onboarding: fb-onboarding.ts knows no Meta stage
//      and accepts no meta key, so nothing here can move a client's FB stage
//      or clear its completion.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

let ts;
try {
  ts = require_("typescript");
} catch {
  console.error("typescript not installed — run `npm ci` first");
  process.exit(1);
}

function load(rel) {
  const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function("exports", "module", "require", js)(mod.exports, mod, require_);
  return mod.exports;
}

const M = load("src/lib/meta-onboarding.ts");
const FB = load("src/lib/fb-onboarding.ts");

let failed = 0;
function check(label, cond, detail) {
  if (cond) return;
  failed++;
  console.error(`FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
}

const AT = "2026-01-01T00:00:00.000Z";
const on = () => ({ v: true, by: "u", at: AT });
const allTicked = () => Object.fromEntries(M.META_CHECKLIST_KEYS.map((k) => [k, on()]));

// 1. The checklist is the SOP's: five sections, 32 boxes.
check("META_CHECKLIST totals 32", M.META_CHECKLIST_KEYS.length === 32, String(M.META_CHECKLIST_KEYS.length));
check("checklist sections, in the SOP's order",
  JSON.stringify(M.META_CHECKLIST.map((g) => `${g.title}:${g.items.length}`)) ===
  JSON.stringify(["Client answers:7", "Scaled Sync:8", "Scaled Admissions:7", "Zap:4", "Launch:6"]),
  M.META_CHECKLIST.map((g) => `${g.title}:${g.items.length}`).join(", "));
check("checklist keys are unique", new Set(M.META_CHECKLIST_KEYS).size === M.META_CHECKLIST_KEYS.length);
check("checklist keys all live under list.", M.META_CHECKLIST_KEYS.every((k) => k.startsWith("list.")));

// Every box belongs to one real step; every step id and section is real.
const stepIds = M.META_STEPS.map((s) => s.id);
check("step ids are unique", new Set(stepIds).size === stepIds.length);
const orphans = M.META_CHECKLIST_ITEMS.filter((i) => !stepIds.includes(i.step));
check("every checklist box points at a real SOP step", orphans.length === 0, orphans.map((i) => `${i.key}->${i.step}`).join(", "));
const sectionIds = M.META_SECTIONS.map((s) => s.id);
check("every step sits in a real section", M.META_STEPS.every((s) => sectionIds.includes(s.section)));
check("sections run Before you start, A, B, C, D, Cadence",
  sectionIds.join(",") === "pre,a,b,c,d,cadence", sectionIds.join(","));
check("the SOP's steps are all there: Before you start, A1-A8, B1-B7, C1-C5, D1-D6, Cadence",
  M.META_STEPS.map((s) => s.step).join(",") ===
  ["Before you start", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "B1", "B2", "B3", "B4", "B5", "B6", "B7",
   "C1", "C2", "C3", "C4", "C5", "D1", "D2", "D3", "D4", "D5", "D6", "Cadence"].join(","),
  M.META_STEPS.map((s) => s.step).join(","));
const covered = M.META_STEPS.reduce((n, s) => n + M.itemsForStep(s.id).length, 0);
check("the step cards show every box exactly once", covered === 32, String(covered));
check("13 known traps, each with a fix", M.META_TRAPS.length === 13 && M.META_TRAPS.every((t) => t.trap && t.happens && t.fix));

// 2. Progress and completion.
let p = M.metaProgress({});
check("empty: 0/32, not complete, next is Client answers",
  p.done === 0 && p.total === 32 && !p.complete && p.next?.id === "client", JSON.stringify(p.next));
p = M.metaProgress(allTicked());
check("every box ticked: complete, nothing next", p.complete && p.done === 32 && p.next === null);
const lastOff = { ...allTicked(), "list.launch.first_lead": { v: false, by: "u", at: AT } };
p = M.metaProgress(lastOff);
check("one box off: not complete, next is Launch 5/6",
  !p.complete && p.done === 31 && p.next?.id === "launch" && p.next.done === 5, JSON.stringify(p.next));
p = M.metaProgress({ ...allTicked(), "list.client.brand": { v: "true", by: "u", at: AT } });
check("a string \"true\" is not a tick", !p.complete && p.done === 31);
p = M.metaProgress({ ...allTicked(), "info.client": { v: "Acme", by: "u", at: AT }, "info.cadence": { v: "on", by: "u", at: AT } });
check("reference fields never count", p.complete && p.total === 32);

// 3. What the API will store.
for (const k of M.META_CHECKLIST_KEYS) {
  if (M.normaliseMetaValue(k, true) !== true || M.normaliseMetaValue(k, false) !== false || M.normaliseMetaValue(k, "true") !== null) {
    check(`checklist key ${k} takes booleans only`, false);
  }
}
check("client name is trimmed and capped", M.normaliseMetaValue("info.client", "  Acme  ") === "Acme" &&
  M.normaliseMetaValue("info.client", "x".repeat(900)).length === 500);
check("cadence choice takes on / off / clear", ["on", "off", ""].every((v) => M.normaliseMetaValue("info.cadence", v) === v) &&
  M.normaliseMetaValue("info.cadence", "maybe") === null);
check("an unknown key is rejected", M.normaliseMetaValue("list.client.nope", true) === null);
check("an FB onboarding key is rejected here", M.normaliseMetaValue("setup.provider", "x") === null);

// No field for a secret or the lead Sheet's link.
const fields = M.META_STEPS.flatMap((s) => [...(s.inputs ?? []), ...(s.choices ?? [])]);
const leaky = fields.filter((f) => /secret|sheet|password|token|api.?key|lead.?form.?key/i.test(`${f.key} ${f.label} ${f.placeholder ?? ""}`));
check("no field for a secret or the Sheet link", leaky.length === 0, leaky.map((f) => f.key).join(", "));
check("every reference field lives under info.", fields.every((f) => f.key.startsWith("info.")));

// 4. Kept out of FB onboarding.
check("FB onboarding has no meta stage", !FB.STAGES.includes("meta") && !FB.PHASES.includes("meta"), FB.STAGES.join(","));
check("FB onboarding accepts no meta key",
  [...M.META_CHECKLIST_KEYS, "meta.route", M.META_CLIENT_KEY].every((k) => FB.normaliseValue(k, true) === null && FB.normaliseValue(k, "x") === null));

// The migration exists and matches what the route calls.
const migration = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith("_meta_onboarding.sql")).sort().pop();
const sql = migration ? fs.readFileSync(path.join(ROOT, "supabase/migrations", migration), "utf8") : "";
check("a meta_onboarding migration exists", !!migration);
check("it creates the table with RLS on", /create table if not exists public\.meta_onboarding/i.test(sql) && /meta_onboarding enable row level security/i.test(sql));
check("meta_onboarding_set takes (text, text, jsonb, text[]) and is service-role only",
  /grant execute on function public\.meta_onboarding_set\(text, text, jsonb, text\[\]\) to service_role/i.test(sql) &&
  /revoke all on function public\.meta_onboarding_set\(text, text, jsonb, text\[\]\) from public, anon, authenticated/i.test(sql));
const route = fs.readFileSync(path.join(ROOT, "src/app/api/tasks/[id]/meta-onboarding/route.ts"), "utf8");
check("the route passes the checklist keys as p_required", /p_required:\s*META_CHECKLIST_KEYS/.test(route));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("meta-onboarding checks passed");
