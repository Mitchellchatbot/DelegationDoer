import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));

import { BUILT_IN_JOB_KINDS, ensureExecRuntime } from "@/lib/exec/runtime";
import { listSystemScheduledWork } from "@/lib/exec/scheduler";

// P9 contract §4 (Area D): docs/exec-assistant.md, the operations runbook. This pins that it exists with its 17 sections,
// names every environment variable exec code reads (and the P9 ones the shutdown drain reads), names every registered
// job kind, holds no select-star and no SQL that reads content, sealed secrets or a factor secret, and that its §16
// lockdown grid counts the exec tables, sequences and functions the migrations really create. The authenticator P9 added
// (its code, the factor pin EXEC_OWNER_MFA_FACTOR_IDS) was removed on 2026-11-10: RB12 pins that the runbook names it
// only in §4's removal note.

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = path.dirname(path.resolve(SRC));
const DOC_PATH = path.join(ROOT, "docs/exec-assistant.md");
const DOC = readFileSync(DOC_PATH, "utf8").replace(/\r\n/g, "\n");
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");

/** Every non-test source file under a directory (tests, __tests__ and fixtures excluded). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "node_modules") out.push(...sourceFiles(abs));
      continue;
    }
    if (/\.(?:ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.live\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}

const isProcessEnv = (n: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(n) && n.name.text === "env" && ts.isIdentifier(n.expression) && n.expression.text === "process";

/** process.env.NAME and process.env["NAME"] reads in a file (comments never count); a computed key is reported apart. */
function envReads(file: string): { names: string[]; computed: number } {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names: string[] = [];
  let computed = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && isProcessEnv(n.expression)) names.push(n.name.text);
    if (ts.isElementAccessExpression(n) && isProcessEnv(n.expression)) {
      if (ts.isStringLiteralLike(n.argumentExpression)) names.push(n.argumentExpression.text);
      else computed += 1;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { names, computed };
}

/** The fenced ```sql blocks of the doc. */
const sqlBlocks = (): string[] => [...DOC.matchAll(/```sql\n([\s\S]*?)\n\s*```/g)].map((m) => m[1]);

/** P9 fixer security-1: the first line of the runbook's one deliberate write (RB10 pins the rest of it). */
const DELIBERATE_WRITE = "-- The one deliberate write in this runbook: ends every session on his account";
const isDeliberateWrite = (sql: string): boolean => sql.trimStart().startsWith(DELIBERATE_WRITE);

/** 2026-11-10: the start of §4's note on the authenticator's removal (RB12), and the pin variable it retired. */
const AUTHENTICATOR_REMOVED = "**The authenticator was removed on 2026-11-10.**";
const FACTOR_PIN_ENV = "EXEC_OWNER_MFA_FACTOR_IDS";

/** A section's text: from "## <n>." to the next "## ". */
function section(n: number): string {
  const start = DOC.search(new RegExp(`^## ${n}\\. `, "m"));
  if (start < 0) throw new Error(`runbook: no section ${n}`);
  const rest = DOC.slice(start + 3);
  const next = rest.search(/^## /m);
  return next < 0 ? DOC.slice(start) : DOC.slice(start, start + 3 + next);
}

describe("docs/exec-assistant.md (P9 contract §4)", () => {
  it("RB01 exists, with sections 0 to 16 in order", () => {
    const headings = [...DOC.matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(headings).toEqual(Array.from({ length: 17 }, (_, i) => i));
    for (const title of ["Scope and the never-list", "Architecture map", "Environment variables", "Switches and settings", "Setup order",
      "Deploy and rollback", "Turning things off", "Scheduled and event-driven jobs", "Slack deletion request", "Restricted senders and tombstones",
      "Secret rotation", "Monitoring", "Troubleshooting by symptom", "Live acceptance", "Known gaps", "Decommission", "Whole-surface lockdown grid"]) {
      expect(DOC).toContain(title);
    }
  });

  it("RB02 names every environment variable process.env reads under src/lib/exec (crypto.ts's keyed read: its two key names)", () => {
    const names = new Set<string>();
    const computedFiles: string[] = [];
    for (const file of sourceFiles(path.join(SRC, "lib/exec"))) {
      const r = envReads(file);
      for (const n of r.names) names.add(n);
      if (r.computed > 0) computedFiles.push(rel(file));
    }
    // The one keyed read (B9): crypto.ts decodeKey("EXEC_TOKEN_KEY" | "EXEC_TOKEN_KEY_PREVIOUS").
    expect(computedFiles).toEqual(["src/lib/exec/crypto.ts"]);
    const crypto = readFileSync(path.join(SRC, "lib/exec/crypto.ts"), "utf8");
    for (const key of ["EXEC_TOKEN_KEY", "EXEC_TOKEN_KEY_PREVIOUS"]) {
      expect(crypto).toContain(`decodeKey("${key}")`);
      names.add(key);
    }
    expect(names.size).toBeGreaterThanOrEqual(15);
    const missing = [...names].filter((n) => !new RegExp(`\`${n}\``).test(DOC));
    expect(missing).toEqual([]);
  });

  it("RB03 names the variables the in-process loops and the P9 shutdown drain read (cron-bootstrap.ts), Next's own aside", () => {
    const boot = path.join(SRC, "lib/cron-bootstrap.ts");
    const reads = new Set(envReads(boot).names);
    expect(reads).toEqual(new Set(["NEXT_RUNTIME", "VERCEL", "NEXT_MANUAL_SIG_HANDLE", "RAILWAY_DEPLOYMENT_DRAINING_SECONDS"]));
    // The per-loop opt-outs are read as process.env[job.disableEnv]: the exec loops' two.
    const text = readFileSync(boot, "utf8");
    for (const env of ["EXEC_WORKER_INTERNAL_CRON", "EXEC_SCHEDULER_INTERNAL_CRON"]) {
      expect(text).toContain(`disableEnv: "${env}"`);
      expect(DOC).toContain(`\`${env}\``);
    }
    for (const env of ["NEXT_MANUAL_SIG_HANDLE", "RAILWAY_DEPLOYMENT_DRAINING_SECONDS"]) expect(DOC).toContain(`\`${env}\``);
    expect(DOC).toContain("`VERCEL=1`");
  });

  it("RB04 names every registered job kind and the system schedules' cadences", () => {
    expect(BUILT_IN_JOB_KINDS.length).toBeGreaterThanOrEqual(40);
    const missing = BUILT_IN_JOB_KINDS.filter((k) => !DOC.includes(`\`${k}\``));
    expect(missing).toEqual([]);
    ensureExecRuntime();
    const jobs = section(7);
    for (const w of listSystemScheduledWork()) {
      expect(jobs).toContain(`\`${w.kind}\``);
      const cadence = w.cadence.kind === "daily" ? `daily ${w.cadence.atUtc} UTC` : `every ${w.cadence.minutes} min`;
      expect(jobs).toContain(cadence);
    }
  });

  it("RB05 holds no select-star anywhere; its SQL reads no content, no sealed secret and no factor secret, and writes nothing", () => {
    expect(DOC).not.toMatch(/\bselect\s+(?:distinct\s+)?(?:[a-z_][a-z0-9_]*\.)?\*/i);
    const blocks = sqlBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const sql of blocks) {
      expect(sql).not.toMatch(/_enc\b/i);
      expect(sql).not.toMatch(/\bsecret\b/i);
      // Outside string literals (the grid names privileges like 'SELECT, INSERT' as text): no write, no content column.
      const code = sql.replace(/'(?:[^']|'')*'/g, "''");
      expect(code).not.toMatch(/\b(?:content|body|subject|summary|headline|messages)\b/i);
      // P9 fixer security-1: the one block that starts with DELIBERATE_WRITE (the session reset RB10 pins word for word) is
      // the only write; every other block reads.
      if (isDeliberateWrite(sql)) continue;
      expect(code).not.toMatch(/\b(?:insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do)\b/i);
      expect(code.trim()).toMatch(/^(?:with|select)\b/i);
    }
  });

  it("RB10 (P9 fixer security-1) the one deliberate write: ends every session on his account, in §12 (his password stops working), and nothing more", () => {
    const writes = sqlBlocks().filter(isDeliberateWrite);
    expect(writes).toHaveLength(1);
    const body = writes[0].split("\n").filter((l) => !l.trim().startsWith("--")).join(" ").replace(/\s+/g, " ").trim();
    expect(body).toBe("delete from auth.sessions where user_id = (select u.id from auth.users u where lower(u.email) = 'mitchell@scaledai.org');");
    // Since the authenticator's removal (2026-11-10; it was §4 P9's foreign-factor step) it is §12's answer to "his
    // password stops working": his new password first, so the changed one can't open a fresh session, then every session
    // on his account ends. §14's password gap points there.
    const fix = section(12);
    expect(fix).toContain(DELIBERATE_WRITE);
    expect(fix.replace(/\s+/g, " ")).toMatch(/His password stops working:.*?1\. Mitchell sets a new password.*?2\. Right after, end every session on his account/);
    expect(section(14).replace(/\s+/g, " ")).toContain("his old password stops working (§12");
  });

  it("RB11 (P9 fixer ui-1, ui-9) the setup is safe and accurate: no live tampering with his account, the real label and alert title, the alert rate limit", () => {
    const acceptance = section(13);
    // ui-1: never tell the team to set his password or plant a factor on his account to test the gate.
    expect(acceptance).not.toMatch(/even after it enrols its own authenticator or sets a new\s+password/);
    expect(acceptance).toMatch(/Never try them on his account/);
    expect(acceptance).toMatch(/non-production Supabase project/);
    // Since the authenticator's removal (2026-11-10) only the F1 case is a proven refusal; the password case is §14's gap,
    // which §14 states (and no longer claims "either way"), with a link session's own authenticator still refused (F1).
    expect(acceptance.replace(/\s+/g, " ")).toContain('the "sets a new password" case is a known gap (§14)');
    const gaps = section(14).replace(/\s+/g, " ");
    expect(gaps).not.toMatch(/either way/);
    expect(gaps).toContain("can set a new password from DD Settings and then sign in with it");
    expect(gaps).toContain("A link session that enrols an authenticator of its own is still refused");
    // ui-9 (a): the label the Settings page really renders, and the refusal alert's real title.
    const view = readFileSync(path.join(SRC, "components/exec/settings/SettingsPageView.tsx"), "utf8");
    const label = /stepUpRefused: "([^"]+)"/.exec(view)?.[1] ?? "";
    expect(label).toBe("Refused: not a password sign-in");
    const monitoring = section(11).replace(/\s+/g, " ");
    expect(monitoring).toContain(`("${label}")`);
    const access = readFileSync(path.join(SRC, "lib/exec/access.ts"), "utf8");
    const title = /STEP_UP_REFUSED_OPS = Object\.freeze\(\{[\s\S]*?title: "([^"]+)"/.exec(access)?.[1] ?? "";
    expect(title).toBe("A session on the owner's account that wasn't a password sign-in was refused");
    expect(monitoring).toContain(`(title "${title}"`);
    // ui-9 (b): the refusal alert's per-key rate limit.
    expect(section(4).replace(/\s+/g, " ")).toContain("one per key per 15 min per process");
  });

  it("RB06 (LD-5) any query on auth.mfa_factors selects only the id, name, type, status and date", () => {
    // Since the authenticator's removal (2026-11-10) the runbook needs no such query; one added later stays bound by LD-5.
    const factorQueries = sqlBlocks().filter((s) => s.includes("auth.mfa_factors"));
    for (const q of factorQueries) {
      const list = /select\s+([\s\S]*?)\s+from\s+auth\.mfa_factors/i.exec(q)?.[1] ?? "";
      expect(list.split(",").map((c) => c.trim().replace(/^[a-z]+\./, ""))).toEqual(["id", "friendly_name", "factor_type", "status", "created_at"]);
    }
  });

  it("RB07 §16's grid counts what the migrations create: exec tables, identity sequences and distinct exec functions", () => {
    const dir = path.join(ROOT, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => /^\d{14}_(?:p0_|exec_).*\.sql$/.test(f)).sort();
    const sql = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    const tables = new Set([...sql.matchAll(/create table if not exists public\.(exec_[a-z0-9_]+)/gi)].map((m) => m[1]));
    const functions = new Set([...sql.matchAll(/create (?:or replace )?function public\.(exec_[a-z0-9_]+)/gi)].map((m) => m[1]));
    const sequences = [...sql.matchAll(/^\s*id\s+bigint generated always as identity primary key/gim)].length;
    const grid = section(16);
    expect(grid).toContain(`inventory: exec tables = ${tables.size}`);
    expect(grid).toContain(`count(*) = ${tables.size} as ok`);
    expect(grid).toContain(`inventory: exec sequences = ${sequences}`);
    expect(grid).toContain(`count(*) = ${sequences},`);
    expect(grid).toContain(`inventory: exec functions = ${functions.size}`);
    expect(grid).toContain(`count(*) = ${functions.size},`);
    expect([tables.size, sequences, functions.size]).toEqual([39, 6, 78]);
    // The one function pinned to search_path=public still exists.
    expect(functions.has("exec_ddtext_replace_item")).toBe(true);
  });

  it("RB08 lists every exec migration (and P0's) in §1.3, in file order", () => {
    const files = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => /^\d{14}_(?:p0_|exec_|optional_activity).*\.sql$/.test(f)).sort();
    const arch = section(1);
    let at = -1;
    for (const f of files) {
      const name = f.replace(/\.sql$/, "");
      const i = arch.indexOf(name);
      expect(i, name).toBeGreaterThan(at);
      at = i;
    }
    expect(files).toContain("20261111200000_exec_brief_dm_refs.sql");
  });

  it("RB09 covers P9: the step-up, the two-service rule (L1), the drain (L5) and the new alerts", () => {
    for (const s of ["mitchell@scaledai.org", "energetic-surprise", "\"Delegation Doer\"", "two-service rule", "L1", "L5",
      "Mitchell gets a 404 on /executive", "Slack tokens on the previous key", "slack.token_resealed", "--delete-fallback-dms",
      "20261111200000_exec_brief_dm_refs", "39 exec tables, 6 exec sequences, 78 exec functions"]) {
      expect(DOC, s).toContain(s);
    }
    // Each P9 alert key the doc names exists in the code that raises it.
    const code = sourceFiles(path.join(SRC, "lib/exec")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const key of ["exec-step-up-refused:", "exec-brief-v2-missing", "brief-compose-timeout:"]) {
      expect(DOC, key).toContain(`\`${key}`);
      expect(code, key).toContain(key);
    }
  });

  it("RB12 (2026-11-10) the authenticator is gone: its pin variable and alerts are named only in §4's removal note, which says to delete the variable, and no code reads or raises them", () => {
    const setup = section(4);
    const at = setup.indexOf(AUTHENTICATOR_REMOVED);
    expect(at).toBeGreaterThan(0);
    const note = setup.slice(at); // the note runs to the end of §4
    const count = (text: string, name: string) => text.split(name).length - 1;
    for (const name of [FACTOR_PIN_ENV, "exec-owner-unpinned-factor:", "exec-owner-mfa-misconfigured"]) {
      expect(count(note, name), name).toBeGreaterThanOrEqual(1);
      expect(count(DOC, name), name).toBe(count(note, name));
    }
    // The one instruction about the variable is to delete it: no env-table row, setup step or decommission step sets it.
    expect(note.replace(/\s+/g, " ")).toContain(`If \`${FACTOR_PIN_ENV}\` was set on Railway, delete it (it's ignored now).`);
    // RB02 alone can't tell: the note names the variable. So no source file under src reads it any more...
    const readers = sourceFiles(SRC).filter((f) => readFileSync(f, "utf8").includes(FACTOR_PIN_ENV) && envReads(f).names.includes(FACTOR_PIN_ENV));
    expect(readers.map(rel)).toEqual([]);
    // ...and nothing under src/lib/exec raises the alerts the note calls gone.
    const code = sourceFiles(path.join(SRC, "lib/exec")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const key of ["exec-owner-unpinned-factor:", "exec-owner-mfa-misconfigured"]) expect(code, key).not.toContain(key);
  });
});
