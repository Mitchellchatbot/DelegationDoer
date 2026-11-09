import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// P8 contract §5.15 WF01-WF03 and §3.18 (M11): the exec-tick GitHub Action, read as text (it ships; nobody triggers it),
// the legacy daily-briefing workflow left exactly as it was, and the route the Action calls.

const ROOT = path.dirname(path.resolve(fileURLToPath(new URL("../../", import.meta.url))));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Line endings don't count: the working tree is CRLF, git stores LF. */
const sha256Lf = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

const TICK = ".github/workflows/exec-tick.yml";
const DAILY = ".github/workflows/daily-briefing.yml";
/** daily-briefing.yml at the base (9e1fedd), LF-normalized: M11 keeps it byte-identical. */
const DAILY_BASE_SHA256 = "94f6b93f5d2016a060200ad6a0826009e3d9e98796253b2625cc939234ff4c61";

describe("exec-tick.yml (M11, §3.18)", () => {
  const yml = read(TICK);
  const lines = yml.split(/\r?\n/);

  it("WF01 exactly one schedule, the cron 7 10-17 * * *, plus workflow_dispatch", () => {
    const crons = [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]*)"\s*$/gm)].map((m) => m[1]);
    expect(crons).toEqual(["7 10-17 * * *"]);
    expect(lines.filter((l) => /^\s*schedule:\s*$/.test(l))).toHaveLength(1);
    expect(yml).toMatch(/^\s*workflow_dispatch:\s*\{\}\s*$/m);
    expect(yml).toMatch(/^on:\s*$/m);
    // 8 runs a day (10:07-17:07 UTC), off the top of the hour.
    expect(crons[0].split(" ")[0]).toBe("7");
  });

  it("WF01 one POST with the Bearer CRON_SECRET header; the body goes to /dev/null and only the status is printed", () => {
    const curls = lines.filter((l) => /\bcurl\b/.test(l));
    expect(curls).toHaveLength(1);
    const curl = curls[0];
    expect(curl).toContain("-X POST");
    expect(curl).toContain('-H "Authorization: Bearer $CRON_SECRET"');
    expect(curl).toContain("-o /dev/null");
    expect(curl).toContain("-w '%{http_code}'");
    expect(curl).toContain('"$EXEC_TICK_URL"');
    // Nothing echoes a response body, the secret or the URL's value.
    for (const l of lines.filter((x) => /^\s*echo\b/.test(x))) {
      expect(l, l).not.toMatch(/\$CRON_SECRET|\$EXEC_TICK_URL|\$body|\$response/);
    }
    expect(yml).not.toMatch(/\bbody=|\btee\b|cat .*response/);
  });

  it("WF01 it references only secrets.CRON_SECRET and vars.EXEC_TICK_URL", () => {
    const refs = [...yml.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
    expect(refs.sort()).toEqual(["secrets.CRON_SECRET", "vars.EXEC_TICK_URL"]);
    expect(yml).not.toMatch(/secrets\.(?!CRON_SECRET\b)[A-Z_]+/);
    expect(yml).not.toMatch(/github\.token|GITHUB_TOKEN/);
  });

  it("WF01 the URL shape check, the missing-config check, 3 attempts 20 s apart, success only on 200", () => {
    expect(yml).toContain('case "$EXEC_TICK_URL" in');
    expect(yml).toContain("https://*/api/cron/exec-tick) ;;");
    expect(yml).toContain('if [ -z "$CRON_SECRET" ] || [ -z "$EXEC_TICK_URL" ]; then');
    expect(yml).toContain("for attempt in 1 2 3; do");
    expect(yml).toContain("sleep 20");
    expect(yml).toContain('if [ "$code" = "200" ]; then exit 0; fi');
    expect(yml).toMatch(/timeout-minutes:\s*5/);
    // No hardcoded host in the steps (the header comment names the value to set): the URL comes from the repository variable.
    const steps = lines.filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(steps).not.toMatch(/https:\/\/[a-z0-9.-]+\.(?:org|app|com)\/api/i);
  });
});

describe("daily-briefing.yml (M11)", () => {
  it("WF02 is byte-identical to the base (line endings aside)", () => {
    expect(sha256Lf(read(DAILY))).toBe(DAILY_BASE_SHA256);
  });

  it("the workflows directory holds exactly the two workflows", () => {
    expect(readdirSync(path.join(ROOT, ".github/workflows")).sort()).toEqual(["daily-briefing.yml", "exec-tick.yml"]);
  });
});

describe("/api/cron/exec-tick (WF03)", () => {
  const route = read("src/app/api/cron/exec-tick/route.ts");

  it("WF03 accepts POST and is gated by cronAuthError first (a guard against accidental edits)", () => {
    expect(route).toMatch(/export async function POST\(req: Request\)\s*\{\s*return handle\(req\);\s*\}/);
    expect(route).toMatch(/export async function GET\(req: Request\)\s*\{\s*return handle\(req\);\s*\}/);
    expect(route).toContain('import { cronAuthError } from "@/lib/cron-auth";');
    const handle = route.slice(route.indexOf("async function handle("));
    const firstStatements = handle.split("\n").slice(1, 3).map((l) => l.trim());
    expect(firstStatements).toEqual(["const denied = cronAuthError(req);", "if (denied) return denied;"]);
    expect(route).toContain('export const dynamic = "force-dynamic";');
  });

  it("WF03 the cron gate takes only the Bearer header (the query-string secret is gone)", () => {
    const auth = read("src/lib/cron-auth.ts");
    expect(auth).toContain('header.startsWith("Bearer ")');
    const code = auth.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toMatch(/searchParams|\?secret=/);
  });
});
