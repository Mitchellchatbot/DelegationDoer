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

interface FakeRequest { method: string; table: string; query: string; headers: Record<string, string>; host: string; body: unknown }
interface FakeReply { status: number; range?: string; body?: unknown }

class Exit {
  constructor(readonly code: number) {}
}

/** Runs the script once; `reply` answers each request (default: 200 with a count of 3, and no active installation); `env` adds
 *  to the sandbox's environment (P9 F15: SLACK_BOT_TOKEN). */
async function runScript(argv: string[], reply: (r: FakeRequest) => FakeReply | undefined = () => undefined, env: Record<string, string> = {}) {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const imports = text.match(/^import .*$/gm) ?? [];
  expect(imports).toEqual(['import fs from "node:fs";', 'import path from "node:path";']);
  const body = text.replace(/^import .*$/gm, "");
  const out: string[] = [];
  const err: string[] = [];
  const requests: FakeRequest[] = [];
  const fakeFetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const req: FakeRequest = { method: init.method ?? "GET", table: u.pathname.replace("/rest/v1/", ""), query: decodeURIComponent(u.search.slice(1)),
      headers: { ...(init.headers ?? {}) }, host: u.host, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
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
      env: { NEXT_PUBLIC_SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY, ...env } as Record<string, string>,
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

/** The tables in the script's order (from a dry run's per-table HEAD select=* requests; P9 F15's pending-DM count is not one). */
async function purgeOrder(): Promise<string[]> {
  return (await runScript([])).requests.filter((r) => r.query === "select=*").map((r) => r.table);
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
    // P9 F15: plus one HEAD count of exec_briefs' pending DD-bot mini-brief DMs, last.
    expect(r.requests.slice(0, -1).every((q) => q.query === "select=*" && q.headers.Prefer === "count=exact" && q.headers.apikey === KEY)).toBe(true);
    expect(r.requests.at(-1)).toMatchObject({ method: "HEAD", table: "exec_briefs", query: "select=id&fallback_slack_ts=not.is.null&fallback_deleted_at=is.null",
      headers: { Prefer: "count=exact", apikey: KEY } });
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

// ---------------------------------------------------------------------------
// P9 F15 (Area C): exec_briefs is the only record of the DD bot's watchdog mini-brief DMs (fallback_slack_ts set,
// fallback_deleted_at null). The dry run counts them; --apply refuses (exit 2) while any is still in Slack unless
// --delete-fallback-dms, which deletes each with SLACK_BOT_TOKEN (chat.delete) before the first DELETE.

describe("scripts/exec-purge-all.mjs: the DD bot's pending mini-brief DMs (P9 F15)", () => {
  const PENDING = "fallback_slack_ts=not.is.null&fallback_deleted_at=is.null";
  const BOT_TOKEN = `xoxb-${BRIEF_TEXT_SENTINELS.token}-dd-bot`;
  const isCount = (q: FakeRequest) => q.method === "HEAD" && q.table === "exec_briefs" && q.query === `select=id&${PENDING}`;
  const isList = (q: FakeRequest) => q.method === "GET" && q.table === "exec_briefs" && q.query.startsWith(`select=id,fallback_channel_id,fallback_slack_ts&${PENDING}&order=id.asc&limit=1000`);
  const isSlack = (q: FakeRequest) => q.host === "slack.com";
  const row = (n: number) => ({ id: `eb_${String(n).padStart(32, "0")}`, fallback_channel_id: "D0MITCHDD", fallback_slack_ts: `1794229${String(n).padStart(3, "0")}.000100` });
  const pending = (rows: unknown[]) => (q: FakeRequest): FakeReply | undefined => (isList(q) ? { status: 200, body: rows } : undefined);
  const clean = (r: Awaited<ReturnType<typeof runScript>>) => {
    assertNoBriefText([r.out, r.err]);
    for (const line of [...r.out, ...r.err]) {
      expect(line).not.toContain(BOT_TOKEN);
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("D0MITCHDD");
      expect(line).not.toMatch(/1794229\d{3}\.000100/);
    }
  };

  it("F15 the dry run reports how many are still in Slack (a HEAD count of exec_briefs' pending rows): N, 0, not installed, an error", async () => {
    const two = await runScript([], (q) => (isCount(q) ? { status: 200, range: "0-1/2" } : undefined));
    expect(two.exitCode).toBe(0);
    expect(two.out.at(-1)).toBe("exec-purge-all: DD-bot mini-brief DMs still in Slack: 2 (--apply refuses unless --delete-fallback-dms)");
    const none = await runScript([], (q) => (isCount(q) ? { status: 200, range: "*/0" } : undefined));
    expect(none.out.at(-1)).toBe("exec-purge-all: DD-bot mini-brief DMs still in Slack: 0");
    const missing = await runScript([], (q) => (q.table === "exec_briefs" ? { status: 404 } : undefined));
    expect(missing.out.at(-1)).toBe("exec-purge-all: DD-bot mini-brief DMs still in Slack: not installed");
    expect(missing.exitCode).toBe(0);
    const failed = await runScript([], (q) => (isCount(q) ? { status: 500, body: { message: BRIEF_TEXT_SENTINELS.briefLine } } : undefined));
    expect(failed.out.at(-1)).toBe("exec-purge-all: DD-bot mini-brief DMs still in Slack: error 500");
    expect(failed.exitCode).toBe(1);
    for (const r of [two, none, missing, failed]) {
      clean(r);
      expect(r.requests.some(isSlack)).toBe(false);
    }
  });

  it("F15 --apply refuses (exit 2) while any is pending, before any DELETE and any Slack call; the refusal is counts only", async () => {
    const r = await runScript(["--apply"], pending([row(1), row(2)]), { SLACK_BOT_TOKEN: BOT_TOKEN });
    expect(r.exitCode).toBe(2);
    expect(r.requests.filter((q) => q.method === "DELETE")).toEqual([]);
    expect(r.requests.some(isSlack)).toBe(false);
    expect(r.requests.map((q) => [q.method, q.table])).toEqual([["GET", "exec_slack_installations"], ["GET", "exec_briefs"]]);
    expect(r.err.join("\n")).toContain("2 DD-bot mini-brief DM(s) are still in Slack");
    expect(r.err.join("\n")).toContain("--delete-fallback-dms");
    clean(r);
    // The check failing refuses too (nothing deleted); none pending (or exec_briefs not installed) goes on as before, with no Slack call.
    const f = await runScript(["--apply"], (q) => (isList(q) ? { status: 503 } : undefined));
    expect(f.exitCode).toBe(2);
    expect(f.err).toEqual(["exec-purge-all: refused: the DD-bot mini-brief DM check failed (503)"]);
    expect(f.requests.filter((q) => q.method === "DELETE")).toEqual([]);
    for (const reply of [pending([]), (q: FakeRequest): FakeReply | undefined => (isList(q) ? { status: 404 } : undefined)]) {
      const ok = await runScript(["--apply"], reply);
      expect(ok.exitCode).toBe(0);
      expect(ok.requests.some(isSlack)).toBe(false);
      expect(ok.requests.filter((q) => q.method === "DELETE").length).toBeGreaterThan(0);
    }
  });

  it("F15 --apply --delete-fallback-dms deletes each with SLACK_BOT_TOKEN (chat.delete) before the first DELETE; message_not_found / channel_not_found count as done", async () => {
    const r = await runScript(["--apply", "--delete-fallback-dms"], (q) => {
      if (isList(q)) return { status: 200, body: [row(1), row(2), row(3)] };
      if (isSlack(q)) {
        const ts = String((q.body as { ts?: unknown }).ts);
        return { status: 200, body: ts === row(2).fallback_slack_ts ? { ok: false, error: "message_not_found" }
          : ts === row(3).fallback_slack_ts ? { ok: false, error: "channel_not_found" } : { ok: true, channel: "D0MITCHDD", ts } };
      }
      return undefined;
    }, { SLACK_BOT_TOKEN: BOT_TOKEN });
    expect(r.exitCode).toBe(0);
    const slack = r.requests.filter(isSlack);
    expect(slack.map((q) => [q.method, q.table, q.body])).toEqual([1, 2, 3].map((n) => ["POST", "/api/chat.delete", { channel: "D0MITCHDD", ts: row(n).fallback_slack_ts }]));
    expect(slack.every((q) => q.headers.Authorization === `Bearer ${BOT_TOKEN}` && q.headers.apikey === undefined)).toBe(true);
    const firstDelete = r.requests.findIndex((q) => q.method === "DELETE");
    expect(firstDelete).toBeGreaterThan(r.requests.lastIndexOf(slack[2]));
    expect(r.out).toContain("exec-purge-all: DD-bot mini-brief DMs deleted: 3");
    expect(r.out).toContain("exec_briefs: deleted 3");
    clean(r);
  });

  it("F15 --delete-fallback-dms refuses (exit 2) with nothing deleted: without SLACK_BOT_TOKEN, or when a chat.delete fails", async () => {
    const noToken = await runScript(["--apply", "--delete-fallback-dms"], pending([row(1)]));
    expect(noToken.exitCode).toBe(2);
    expect(noToken.err).toEqual(["exec-purge-all: refused: --delete-fallback-dms needs SLACK_BOT_TOKEN (the DD bot's token)"]);
    expect(noToken.requests.some(isSlack)).toBe(false);
    expect(noToken.requests.filter((q) => q.method === "DELETE")).toEqual([]);
    // One of two fails (a rate limit, an error body, an unreadable body): all are tried, then the run stops before any DELETE.
    for (const failure of [{ status: 429, body: { ok: false, error: "ratelimited" } }, { status: 200, body: { ok: false, error: "cant_delete_message" } },
      { status: 200, body: null }]) {
      const r = await runScript(["--apply", "--delete-fallback-dms"], (q) => {
        if (isList(q)) return { status: 200, body: [row(1), row(2)] };
        if (isSlack(q)) return String((q.body as { ts?: unknown }).ts) === row(1).fallback_slack_ts ? failure : { status: 200, body: { ok: true } };
        return undefined;
      }, { SLACK_BOT_TOKEN: BOT_TOKEN });
      expect(r.exitCode).toBe(2);
      expect(r.requests.filter(isSlack)).toHaveLength(2);
      expect(r.requests.filter((q) => q.method === "DELETE")).toEqual([]);
      expect(r.out.at(-1)).toBe("exec-purge-all: DD-bot mini-brief DMs deleted: 1");
      expect(r.err.at(-1)).toBe("exec-purge-all: refused: 1 DD-bot mini-brief DM(s) could not be deleted; nothing else was deleted (re-run to retry)");
      clean(r);
    }
  });

  it("F15 more than a page of pending rows: listed page by page by id (id=gt.<the last id>), every one deleted", async () => {
    const all = Array.from({ length: 1001 }, (_, i) => row(i + 1));
    const r = await runScript(["--apply", "--delete-fallback-dms"], (q) => {
      if (isList(q)) return { status: 200, body: q.query.includes("&id=gt.") ? all.slice(1000) : all.slice(0, 1000) };
      if (isSlack(q)) return { status: 200, body: { ok: true } };
      return undefined;
    }, { SLACK_BOT_TOKEN: BOT_TOKEN });
    expect(r.exitCode).toBe(0);
    expect(r.requests.filter(isList).map((q) => q.query.split("&").filter((p) => p.startsWith("id=gt.")))).toEqual([[], [`id=gt.${all[999].id}`]]);
    expect(r.requests.filter(isSlack)).toHaveLength(1001);
    expect(r.out).toContain("exec-purge-all: DD-bot mini-brief DMs deleted: 1001");
  });
});
