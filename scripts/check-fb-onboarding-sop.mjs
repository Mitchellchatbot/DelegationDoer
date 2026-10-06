// Dependency-free check for the FB-onboarding checklist's phase arithmetic. The
// repo has no test runner, so this is a plain Node script:
// `node scripts/check-fb-onboarding-sop.mjs` (exits 0 on pass, 1 on failure —
// usable in CI later).
//
// Unlike check-archive.mjs, this does NOT mirror the logic it is testing: it
// transpiles the real src/lib/fb-onboarding.ts with the repo's own TypeScript
// and calls the shipped functions. That module is deliberately import-free
// ("Pure data + pure functions", see its header), which is what makes loading
// it from a plain script possible — if someone ever adds an import to it, this
// script is the thing that will start failing, and that is a fair warning.
//
// WHAT IT IS GUARDING. progress().complete is the AND of every phase, and
// src/app/api/tasks/[id]/fb-onboarding/route.ts turns a false into a CLEARED
// completed_at. So adding a mandatory step to any phase retroactively
// un-completes every client who was already Live — silently, on their next
// PATCH. The Scaled Sync phase avoids that by counting nothing until
// sync.platform says the client is on Scaled Sync; these assertions are what
// stop that gate from being removed by accident. The same hazard is why
// `optional` has to keep working.

import assert from "node:assert/strict";
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

// Load the real module.
const srcPath = path.join(ROOT, "src/lib/fb-onboarding.ts");
const js = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function("exports", "module", "require", js)(mod.exports, mod, require_);
const M = mod.exports;

let failed = 0;
function check(label, cond, detail) {
  if (cond) return;
  failed++;
  console.error(`FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
}

const AT = "2026-01-01T00:00:00.000Z";
const on = () => ({ v: true, by: "u", at: AT });
const txt = (s) => ({ v: s, by: "u", at: AT });

// The state of an onboarding that was complete BEFORE the Scaled Sync phase
// existed: every pre-existing phase filled, nothing under sync.*
function legacyComplete() {
  const s = {};
  for (const it of M.ACCESS_ITEMS) {
    for (const c of it.checks) if (!c.optional) s[c.key] = on();
    if (it.choice) s[it.choice.key] = txt(it.choice.options[0].value);
    for (const i of it.inputs ?? []) if (!i.optional) s[i.key] = txt("x");
  }
  s[M.CITIES_KEY] = txt("Austin, TX");
  s[M.BUDGET_KEY] = txt("$100/day");
  s[M.CREATIVES_KEY] = txt("https://drive.google.com/x");
  s[M.PROVIDER_KEY] = txt("Bright Paths");
  for (const st of M.MAIN_ZAP_STEPS) {
    for (const k of M.mainStepKeys(st)) s[k.key] = k.kind === "check" ? on() : txt("v");
  }
  for (const z of M.ZAPS) if (z.id !== "main") s[M.zapBuiltKey(z.id)] = on();
  for (const c of M.SLACK_CHANNELS) s[M.slackKey(c.id)] = on();
  s["access.notify.channel"] = txt("slack");
  for (const c of M.CLIENT_STREAMS) s[M.clientKey("slack", c.id)] = on();
  for (const t of M.testCases("")) s[M.testResultKey(t.id)] = txt("pass");
  return s;
}

// 1. A client who predates the phase is untouched by it.
const legacy = legacyComplete();
let p = M.progress(legacy);
check("ungated syncTotal is 0", p.syncTotal === 0, `got ${p.syncTotal}`);
check("a legacy onboarding is still complete", p.complete === true,
  JSON.stringify({ access: `${p.accessCleared}/${p.accessTotal}`, launch: `${p.launchDone}/${p.launchTotal}`,
    sync: `${p.syncDone}/${p.syncTotal}`, main: `${p.mainDone}/${p.mainTotal}`,
    setup: `${p.setupDone}/${p.setupTotal}`, tests: `${p.testsDone}/${p.testsTotal}` }));
check("it stays Live", M.stage(p, AT) === "live", M.stage(p, AT));
check("stage() never emits sync for it", M.stage(p, null) !== "sync", M.stage(p, null));

// 2. "Another CRM" is an answer, and is equally inert.
p = M.progress({ ...legacy, [M.SYNC_PLATFORM_KEY]: txt("other") });
check("'other' keeps syncTotal at 0", p.syncTotal === 0, `got ${p.syncTotal}`);
check("'other' stays complete", p.complete === true);

// 3. On Scaled Sync the phase is real.
const scoped = { ...legacy, [M.SYNC_PLATFORM_KEY]: txt("scaled_sync") };
p = M.progress(scoped);
check("scaled_sync gives the phase steps", p.syncTotal > 0, `got ${p.syncTotal}`);
check("and withholds completion", p.complete === false);
check("stage() is sync", M.stage(p, null) === "sync", M.stage(p, null));
const sp = M.stageProgress(p, "sync");
check("stageProgress agrees", sp.done === p.syncDone && sp.total === p.syncTotal, JSON.stringify(sp));

// 4. Filling it in finishes the onboarding again.
const filled = { ...scoped };
for (const st of M.SYNC_STEPS) {
  for (const k of M.stepKeys(st, M.syncKey)) filled[k.key] = k.kind === "check" ? on() : txt("v");
}
p = M.progress(filled);
check("a filled tab completes", p.syncDone === p.syncTotal && p.complete === true,
  `${p.syncDone}/${p.syncTotal}`);
check("stage() moves past sync", M.stage(p, null) !== "sync", M.stage(p, null));

// 4b. The two delivery routes. Each route's steps must be REQUIRED once that
//     route is chosen, and inert otherwise — otherwise the tab can read 100%
//     with no webhook wired anywhere, which is the failure this replaced.
const routeKey = M.syncKey("b2", "route");
const stepOf = (id) => M.SYNC_STEPS.find((st) => st.id === id);
const direct = stepOf("b3"), viaZap = stepOf("b3z");
check("the direct-route step is conditional", !!direct.when, "no when");
check("the zap-route step is conditional", !!viaZap.when, "no when");

function countsFor(route, st) {
  const state = { ...scoped };
  if (route !== null) state[routeKey] = txt(route);
  const keys = M.syncKeys(state).map((k) => k.key);
  return M.stepKeys(st, M.syncKey).some((k) => keys.includes(k.key));
}
check("no route chosen: neither route's steps count",
  !countsFor(null, direct) && !countsFor(null, viaZap));
check("native: the Typeform webhook step counts", countsFor("native", direct));
check("native: the Zap step does not", !countsFor("native", viaZap));
check("zap: the Zap step counts", countsFor("zap", viaZap));
check("zap: the Typeform webhook step does not", !countsFor("zap", direct));
check("both: both count", countsFor("both", direct) && countsFor("both", viaZap));

// And the route itself is mandatory, so "no route chosen" can never be a
// finished tab — which is what makes the conditional steps safe.
const noRoute = { ...scoped };
for (const st of M.SYNC_STEPS) {
  for (const k of M.stepKeys(st, M.syncKey)) {
    if (k.key !== routeKey) noRoute[k.key] = k.kind === "check" ? on() : txt("v");
  }
}
check("a tab with no route chosen is NOT complete", M.progress(noRoute).complete === false,
  `sync ${M.progress(noRoute).syncDone}/${M.progress(noRoute).syncTotal}`);

// Every `when` must point at a key that exists and offer only real values.
for (const st of M.SYNC_STEPS.filter((x) => x.when)) {
  const owner = M.SYNC_STEPS.find((o) =>
    (o.choices || []).some((c) => M.syncKey(o.id, c.key) === st.when.key));
  check(`${st.id}'s when points at a real choice`, !!owner, st.when.key);
  if (owner) {
    const ch = owner.choices.find((c) => M.syncKey(owner.id, c.key) === st.when.key);
    const bogus = st.when.anyOf.filter((v) => !ch.options.some((o) => o.value === v));
    check(`${st.id}'s when uses real option values`, bogus.length === 0, bogus.join(", "));
  }
}

// 5. The API route rejects any key the registry does not know, so every key a
//    step declares has to be registered — probed with a value of its own kind.
for (const [name, steps, keyFor] of [
  ["SYNC_STEPS", M.SYNC_STEPS, M.syncKey],
  ["MAIN_ZAP_STEPS", M.MAIN_ZAP_STEPS, M.mainKey],
]) {
  const declared = [];
  for (const st of steps) {
    for (const c of st.checks) declared.push({ key: keyFor(st.id, c.key), probe: true });
    for (const c of st.choices ?? []) declared.push({ key: keyFor(st.id, c.key), probe: c.options[0].value });
    for (const i of st.inputs ?? []) declared.push({ key: keyFor(st.id, i.key), probe: "x" });
  }
  const keys = declared.map((d) => d.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  // A check and an input sharing one key is invisible to the counters once
  // either is optional, so this is checked against the declarations.
  check(`${name} has no duplicate key`, dupes.length === 0, dupes.join(", "));
  const unregistered = declared.filter((d) => M.normaliseValue(d.key, d.probe) === null).map((d) => d.key);
  check(`${name} keys are all registered`, unregistered.length === 0, unregistered.join(", "));
}
check("the gate rejects an unknown CRM", M.normaliseValue(M.SYNC_PLATFORM_KEY, "kipu") === null);
check("an unregistered sync key is rejected", M.normaliseValue("sync.nope.nope", true) === null);

// 6. Whatever stage() can emit must be allowed by the stage check constraint,
//    or every PATCH on a client in that stage fails. The migration is applied
//    by hand, so this is the only thing that keeps the two in step.
const migrations = fs.readdirSync(path.join(ROOT, "supabase/migrations"))
  .filter((f) => f.includes("fb_onboarding_stage"))
  .map((f) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"));
const constraintSql = migrations.filter((sql) => sql.includes("fb_onboarding_stage_check")).pop();
check("a stage check-constraint migration exists", !!constraintSql);
// Read the IN list only. Searching the whole file matches the prose above the
// SQL — these migrations explain which stage they are adding, and quote it — so
// a stage dropped from the constraint would still look present.
const inList = constraintSql && /stage\s+in\s*\(([^)]*)\)/i.exec(constraintSql);
check("the constraint's stage list is parseable", !!inList, constraintSql ? "no `stage in (...)` found" : "");
if (inList) {
  const allowed = inList[1].split(",").map((t) => t.trim().replace(/^'|'$/g, ""));
  const missing = M.STAGES.filter((s) => !allowed.includes(s));
  check("every stage() value is allowed by the constraint", missing.length === 0, missing.join(", "));
  const extra = allowed.filter((a) => a && !M.STAGES.includes(a));
  check("the constraint allows no stage the code cannot emit", extra.length === 0, extra.join(", "));
}

// 7. The per-stage tables are exhaustive at the type level, but the arrays and
//    the ladder are not — a new stage can be typed in and never reached.
for (const st of M.STAGES) {
  check(`STAGE_LABEL has ${st}`, typeof M.STAGE_LABEL[st] === "string" && M.STAGE_LABEL[st] !== "");
  check(`STAGE_BLURB has ${st}`, typeof M.STAGE_BLURB[st] === "string" && M.STAGE_BLURB[st] !== "");
  check(`STAGE_AGING has an entry for ${st}`, st in M.STAGE_AGING);
}
for (const ph of M.PHASES) {
  check(`${ph} is reachable as a stage`, M.STAGES.includes(ph));
  check(`stagePhase round-trips ${ph}`, M.stagePhase(ph) === ph, M.stagePhase(ph));
}
check("sync sits between launch and build",
  M.STAGES.indexOf("sync") === M.STAGES.indexOf("launch") + 1 &&
  M.STAGES.indexOf("sync") === M.STAGES.indexOf("main") - 1, M.STAGES.join(","));

// 8. `optional` has to keep working, and must not have moved what already shipped.
check("MAIN_ZAP_STEPS still totals 71", M.progress({}).mainTotal === 71, `got ${M.progress({}).mainTotal}`);
const allOptional = M.SYNC_STEPS.find((st) =>
  st.checks.length > 0 && st.checks.every((c) => c.optional) && !st.choices && !st.inputs);
check("an all-optional step counts zero", !allOptional || M.stepKeys(allOptional, M.syncKey).length === 0);
check("optional boxes still render", !allOptional || allOptional.checks.length > 0);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
assert.ok(true);
console.log("fb-onboarding SOP checks passed");
