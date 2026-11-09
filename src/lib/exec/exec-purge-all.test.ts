import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { BRIEF_TEXT_SENTINELS, assertNoBriefText } from "@/lib/exec/__tests__/brief-assert";

// P8 contract §3.14.3, §5.14 PU08-PU10, PU13 (Area A): scripts/exec-purge-all.mjs, the hand-run decommission. The script is
// read as text and run in a sandboxed vm context with a fake fetch, a fake fs (no .env.local is ever read) and a fake
// process: nothing reaches a network or a real environment. Its two imports are replaced by the sandbox's bindings and
// process.exit ends the run.

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "exec-purge-all.mjs");
const KEY = `${BRIEF_TEXT_SENTINELS.token}-service-role`;
const URL_BASE = "https://fake-project.supabase.test";

interface FakeRequest { method: string; table: string; query: string; headers: Record<string, string> }
interface FakeReply { status: number; range?: string; body?: unknown }

class Exit {
  constructor(readonly code: number) {}
}

/** Runs the script once; `reply` answers each request (default: 200 with a count of 3, and no active installation). */
async function runScript(argv: string[], reply: (r: FakeRequest) => FakeReply | undefined = () => undefined) {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const imports = text.match(/^import .*$/gm) ?? [];
  expect(imports).toEqual(['import fs from "node:fs";', 'import path from "node:path";']);
  const body = text.replace(/^import .*$/gm, "");
  const out: string[] = [];
  const err: string[] = [];
  const requests: FakeRequest[] = [];
  const fakeFetch = async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    const u = new URL(url);
    const req: FakeRequest = { method: init.method ?? "GET", table: u.pathname.replace("/rest/v1/", ""), query: decodeURIComponent(u.search.slice(1)),
      headers: { ...(init.headers ?? {}) } };
    requests.push(req);
    const r = reply(req) ?? (req.method === "GET" ? { status: 200, body: [] } : { status: 200, range: "*/3" });
    const make = (): unknown => ({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h: string) => (h.toLowerCase() === "content-range" ? r.range ?? null : null) },
      json: async () => r.body ?? null,
      clone: () => make()
    });
    return make();
  };
  const sandbox = {
    fs: { existsSync: () => false, readFileSync: () => { throw new Error("no file reads in the sandbox"); } },
    path,
    process: {
      cwd: () => "/sandbox",
      env: { NEXT_PUBLIC_SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY } as Record<string, string>,
      argv: ["node", "scripts/exec-purge-all.mjs", ...argv],
      exit: (code: number) => {
        throw new Exit(code);
      }
    },
    fetch: fakeFetch,
    URL,
    console: { log: (...a: unknown[]) => out.push(a.join(" ")), error: (...a: unknown[]) => err.push(a.join(" ")), warn: (...a: unknown[]) => err.push(a.join(" ")) }
  };
  let exitCode: number | null = null;
  try {
    await vm.runInNewContext(`(async () => {\n${body}\n})()`, sandbox, { filename: "exec-purge-all.mjs" });
  } catch (e) {
    if (e instanceof Exit) exitCode = e.code;
    else throw e;
  }
  return { exitCode, out, err, requests };
}

/** The tables in the script's order (from a dry run's HEAD requests). */
async function purgeOrder(): Promise<string[]> {
  return (await runScript([])).requests.map((r) => r.table);
}

/** Every exec_ table the migrations create, and the FK edges (child → parent) among them. */
function schema(): { tables: Set<string>; edges: [string, string][] } {
  const dir = path.join(ROOT, "supabase", "migrations");
  const tables = new Set<string>();
  const edges: [string, string][] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const s = fs.readFileSync(path.join(dir, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of s.matchAll(/create table if not exists public\.(exec_[a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
      tables.add(m[1]);
      for (const r of m[2].matchAll(/references\s+public\.(exec_[a-z_]+)/g)) edges.push([m[1], r[1]]);
    }
    for (const m of s.matchAll(/alter table (?:if exists )?public\.(exec_[a-z_]+)[^;]*?references\s+public\.(exec_[a-z_]+)/g)) edges.push([m[1], m[2]]);
  }
  return { tables, edges };
}

describe("scripts/exec-purge-all.mjs (P8 §3.14.3; PU08-PU10, PU13)", () => {
  it("PU08: the default run is a dry run: one HEAD select=* with Prefer: count=exact per table, counts printed, exit 0", async () => {
    const r = await runScript([]);
    expect(r.exitCode).toBe(0);
    expect(new Set(r.requests.map((q) => q.method))).toEqual(new Set(["HEAD"]));
    expect(r.requests.every((q) => q.query === "select=*" && q.headers.Prefer === "count=exact" && q.headers.apikey === KEY)).toBe(true);
    expect(r.out[0]).toBe("exec-purge-all: DRY RUN (nothing is deleted; --apply deletes)");
    expect(r.out).toContain("exec_briefs: 3");
    expect(r.out).toContain("exec_audit_log: 3 (kept: --include-audit deletes it)");
    expect(r.out.length).toBe(r.requests.length + 1);
  });

  it("PU08: a missing table (404 or PGRST205) prints 'not installed'; another error is reported and exits 1", async () => {
    const r = await runScript([], (q) => (q.table === "exec_briefs" ? { status: 404 } : q.table === "exec_brief_mentions" ? { status: 400, body: { code: "PGRST205" } }
      : q.table === "exec_jobs" ? { status: 500, body: { message: BRIEF_TEXT_SENTINELS.briefLine } } : undefined));
    expect(r.out).toContain("exec_briefs: not installed");
    expect(r.out).toContain("exec_brief_mentions: not installed");
    expect(r.out).toContain("exec_jobs: error 500");
    expect(r.exitCode).toBe(1);
  });

  it("PU08: --apply refuses (exit 2) while a Slack installation is active, deleting nothing; the check names no installation", async () => {
    const r = await runScript(["--apply"], (q) => (q.method === "GET" ? { status: 200, body: [{ id: `esi_${"1".repeat(32)}` }] } : undefined));
    expect(r.exitCode).toBe(2);
    expect(r.requests.map((q) => [q.method, q.table, q.query])).toEqual([["GET", "exec_slack_installations", "select=id&revoked_at=is.null&limit=1"]]);
    expect(r.err.join("\n")).toMatch(/Disconnect Slack/);
    expect(r.err.join("\n")).not.toMatch(/esi_/);
    // A failing check refuses too.
    const f = await runScript(["--apply"], (q) => (q.method === "GET" ? { status: 503 } : undefined));
    expect(f.exitCode).toBe(2);
    expect(f.requests.filter((q) => q.method === "DELETE")).toEqual([]);
  });

  it("PU08: --apply with no active installation deletes every table in EXEC_PURGE_ORDER (DELETE <key>=not.is.null), keeping exec_audit_log", async () => {
    const order = await purgeOrder();
    const r = await runScript(["--apply"]);
    expect(r.exitCode).toBe(0);
    const deletes = r.requests.filter((q) => q.method === "DELETE");
    expect(deletes.map((q) => q.table)).toEqual(order.filter((t) => t !== "exec_audit_log"));
    expect(deletes.every((q) => /^[a-z_]+=not\.is\.null$/.test(q.query) && q.headers.Prefer === "count=exact,return=minimal")).toBe(true);
    expect(deletes.find((q) => q.table === "exec_jobs")?.query).toBe("id=not.is.null");
    expect(r.out).toContain("exec_audit_log: kept");
    expect(r.out).toContain("exec_briefs: deleted 3");
    // A missing table is skipped as not installed (the phase was never applied), the rest still go.
    const m = await runScript(["--apply"], (q) => (q.method === "DELETE" && q.table === "exec_brief_checkins" ? { status: 404 } : undefined));
    expect(m.out).toContain("exec_brief_checkins: not installed");
    expect(m.exitCode).toBe(0);
    // A failing delete stops the run (the children-first order must hold).
    const s = await runScript(["--apply"], (q) => (q.method === "DELETE" && q.table === "exec_slack_channels" ? { status: 409 } : undefined));
    expect(s.exitCode).toBe(1);
    expect(s.requests.filter((q) => q.method === "DELETE").at(-1)?.table).toBe("exec_slack_channels");
  });

  it("PU08: --include-audit deletes exec_audit_log too (after every table referencing it); unknown or conflicting flags exit 1 with nothing sent", async () => {
    const r = await runScript(["--apply", "--include-audit"]);
    const deletes = r.requests.filter((q) => q.method === "DELETE").map((q) => q.table);
    expect(deletes).toContain("exec_audit_log");
    expect(deletes.indexOf("exec_drafts")).toBeLessThan(deletes.indexOf("exec_audit_log"));
    expect(deletes.indexOf("exec_audit_log")).toBeLessThan(deletes.indexOf("exec_principals"));
    expect((await runScript(["--apply", "--keep-audit"])).requests.filter((q) => q.method === "DELETE").map((q) => q.table)).not.toContain("exec_audit_log");
    for (const argv of [["--yes"], ["--apply", "--keep-audit", "--include-audit"], ["apply"]]) {
      const bad = await runScript(argv);
      expect(bad.exitCode, argv.join(" ")).toBe(1);
      expect(bad.requests).toEqual([]);
    }
  });

  it("PU09: the order deletes children before parents for every FK among the exec tables, and lists every exec table exactly once", async () => {
    const order = await purgeOrder();
    const { tables, edges } = schema();
    expect(new Set(order).size).toBe(order.length);
    expect([...tables].sort()).toEqual([...order].sort());
    for (const [child, parent] of edges) {
      if (child === parent) continue;
      expect(order.indexOf(child), `${child} → ${parent}`).toBeLessThan(order.indexOf(parent));
    }
    // The P8 and P7a edges named by the contract.
    for (const [child, parent] of [["exec_brief_checkins", "exec_briefs"], ["exec_briefs", "exec_principals"], ["exec_brief_mentions", "exec_principals"],
      ["exec_slack_author_optouts", "exec_principals"], ["exec_slack_items", "exec_slack_messages"], ["exec_slack_messages", "exec_slack_channels"]]) {
      expect(edges).toContainEqual([child, parent]);
    }
  });

  it("PU13 (p7a-sec-10): exec_slack_author_optouts comes before exec_slack_channels, and the dry run reports its count", async () => {
    const order = await purgeOrder();
    expect(order.indexOf("exec_slack_author_optouts")).toBeLessThan(order.indexOf("exec_slack_channels"));
    const r = await runScript([], (q) => (q.table === "exec_slack_author_optouts" ? { status: 200, range: "0-6/7" } : undefined));
    expect(r.out).toContain("exec_slack_author_optouts: 7");
  });

  it("PU10: the output is table names and counts only: never a row, an error body, the URL or the key", async () => {
    const poison = { status: 500, body: [{ text: BRIEF_TEXT_SENTINELS.checkinText, subject: BRIEF_TEXT_SENTINELS.emailSubject }] };
    const runs = [
      await runScript([], (q) => (q.table === "exec_messages" ? poison : undefined)),
      await runScript(["--apply"], (q) => (q.method === "GET" ? { status: 200, body: [{ id: "esi_x", token: BRIEF_TEXT_SENTINELS.token }] } : undefined)),
      await runScript(["--apply", "--include-audit"], (q) => (q.method === "DELETE" && q.table === "exec_jobs" ? poison : undefined))
    ];
    for (const r of runs) {
      assertNoBriefText([r.out, r.err]);
      for (const line of [...r.out, ...r.err]) {
        expect(line).not.toContain(KEY);
        expect(line).not.toContain(URL_BASE);
        expect(line).toMatch(/^(exec_[a-z_]+: (\d+( \(kept: --include-audit deletes it\))?|not installed|kept|deleted \d+|error \d+|failed \(\d+\); stopped)|exec-purge-all: .+)$/);
      }
    }
  });
});
