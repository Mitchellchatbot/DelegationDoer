import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-read-store")>();
  return { ...actual, rateTake: vi.fn(), rateBlock: vi.fn() };
});

import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import { installFakeSlack, SLACK_RECORDED } from "@/lib/exec/__tests__/fake-slack-api";
import { captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { classifyError } from "@/lib/exec/jobs";
import { noteSlackRateLimited, SlackRateBudgetError, takeSlackBudget } from "@/lib/exec/slack-rate";
import { rateBlock, rateTake, SlackReadStoreError } from "@/lib/exec/slack-read-store";
import type { MeteredMethod, RateClass } from "@/lib/exec/slack-read-types";
import { readDmMessage } from "@/lib/exec/sources/slack";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a §5.6 RL01-RL10 (Area B): the priority limiter (N6, C13). The thresholds live in SQL (exec_slack_rate_take, §2.8.9;
// RQ18 runs them on PGlite / PG15 / PG17). Here the store's rateTake / rateBlock are mocked at the module boundary with
// LimiterModel, a line-by-line TS statement of §2.8.9, so RL01-RL07 pin the contract's table through takeSlackBudget and the
// model is the spec A's fake (fake-slack-read-db.ts) and the SQL must equal (RQ13). RL08-RL10 test the client itself.

const TEAM = "T0SCALED";
const MINUTE = 60_000;

/** §2.8.9 exec_slack_rate_take / exec_slack_rate_block, as TS. */
class LimiterModel {
  rows = new Map<string, { windowStart: number; total: number; own: Record<RateClass, number>; blockedUntil: number | null }>();
  take(team: string, method: MeteredMethod, cls: RateClass, n: number, nowDate: Date): { allowed: boolean; waitMs: number; reason?: "blocked" | "budget" } {
    if (!["triage", "sweep", "probe", "discovery"].includes(cls)) throw new Error("exec_slack_rate_take: bad class");
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("exec_slack_rate_take: n must be 1..10");
    const tier = ["conversations.history", "conversations.replies", "conversations.info", "users.conversations"].includes(method) ? "t3"
      : ["conversations.list", "users.list"].includes(method) ? "t2" : method === "users.info" ? "t4" : method === "chat.getPermalink" ? "special" : null;
    if (tier === null || !/^T[A-Z0-9]{2,30}$/.test(team)) throw new Error("exec_slack_rate_take: bad team or method");
    const now = nowDate.getTime();
    const window = Math.floor(now / MINUTE) * MINUTE;
    const key = `${team}|${method}`;
    let row = this.rows.get(key);
    if (!row) {
      row = { windowStart: window, total: 0, own: { triage: 0, sweep: 0, probe: 0, discovery: 0 }, blockedUntil: null };
      this.rows.set(key, row);
    }
    if (row.blockedUntil !== null && row.blockedUntil > now) return { allowed: false, reason: "blocked", waitMs: Math.ceil(row.blockedUntil - now) };
    if (row.windowStart !== window) row = { ...row, windowStart: window, total: 0, own: { triage: 0, sweep: 0, probe: 0, discovery: 0 } };
    const own = row.own[cls];
    const ok = tier === "t3"
      ? cls === "triage" ? row.total + n <= 40 : cls === "sweep" ? row.total + n <= 30 : row.total + n <= 20 && own + n <= 10
      : tier === "t2" ? cls === "discovery" && row.total + n <= 15
        : tier === "t4" ? row.total + n <= 60 : row.total + n <= 100;
    if (ok) row = { ...row, total: row.total + n, own: { ...row.own, [cls]: own + n } };
    this.rows.set(key, row);
    return ok ? { allowed: true, waitMs: 0 } : { allowed: false, reason: "budget", waitMs: Math.ceil(window + MINUTE - now) };
  }
  block(team: string, method: MeteredMethod, until: Date | null, now = Date.now()): void {
    const capped = Math.min(until === null ? now + 30_000 : until.getTime(), now + 10 * MINUTE);
    const key = `${team}|${method}`;
    const row = this.rows.get(key) ?? { windowStart: Math.floor(now / MINUTE) * MINUTE, total: 0, own: { triage: 0, sweep: 0, probe: 0, discovery: 0 }, blockedUntil: null };
    row.blockedUntil = Math.max(row.blockedUntil ?? capped, capped);
    this.rows.set(key, row);
  }
}

let model: LimiterModel;
let clock: number;
const now = () => new Date(clock);
let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  model = new LimiterModel();
  // 2026-11-08T15:00:10Z: 50 s left in the minute.
  clock = Date.UTC(2026, 10, 8, 15, 0, 10);
  vi.mocked(rateTake).mockImplementation(async (team, method, cls, n, at) => model.take(team, method, cls, n, at));
  vi.mocked(rateBlock).mockImplementation(async (team, method, until) => model.block(team, method, until, clock));
  out = captureConsole();
});
afterEach(() => {
  vi.useRealTimers();
});

/** One take that must not wait: true when allowed, the error when refused. */
async function takeNow(method: MeteredMethod, cls: RateClass, n = 1): Promise<true | SlackRateBudgetError> {
  try {
    await takeSlackBudget(TEAM, method, cls, { n, maxWaitMs: 0, now });
    return true;
  } catch (err) {
    if (err instanceof SlackRateBudgetError) return err;
    throw err;
  }
}
async function takeTimes(times: number, method: MeteredMethod, cls: RateClass): Promise<number> {
  let ok = 0;
  for (let i = 0; i < times; i++) if ((await takeNow(method, cls)) === true) ok++;
  return ok;
}

describe("the Tier 3 classes (RL01-RL05)", () => {
  it("RL01 30 sweep takes in one minute succeed, the 31st is refused with the wait to the next minute (mutant N32)", async () => {
    expect(await takeTimes(30, "conversations.history", "sweep")).toBe(30);
    const refused = await takeNow("conversations.history", "sweep");
    expect(refused).toBeInstanceOf(SlackRateBudgetError);
    expect((refused as SlackRateBudgetError).retryAfterMs).toBe(50_000);
    // Tier 3 is per method: replies has its own row.
    expect(await takeNow("conversations.replies", "sweep")).toBe(true);
  });

  it("RL02 triage still gets budget after 30 sweep takes, up to a metered total of 40", async () => {
    expect(await takeTimes(30, "conversations.replies", "sweep")).toBe(30);
    expect(await takeTimes(10, "conversations.replies", "triage")).toBe(10);
    expect(await takeNow("conversations.replies", "triage")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeNow("conversations.replies", "sweep")).toBeInstanceOf(SlackRateBudgetError);
  });

  it("RL03 probe stops at its own 10, and at a metered total of 20", async () => {
    expect(await takeTimes(10, "conversations.history", "probe")).toBe(10);
    expect(await takeNow("conversations.history", "probe")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeNow("conversations.history", "sweep")).toBe(true);
    model = new LimiterModel();
    expect(await takeTimes(15, "conversations.history", "sweep")).toBe(15);
    expect(await takeTimes(5, "conversations.history", "probe")).toBe(5);
    expect(await takeNow("conversations.history", "probe")).toBeInstanceOf(SlackRateBudgetError);
  });

  it("RL04 discovery the same: its own 10, a total of 20 (users.conversations, conversations.info)", async () => {
    expect(await takeTimes(10, "users.conversations", "discovery")).toBe(10);
    expect(await takeNow("users.conversations", "discovery")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(12, "conversations.info", "sweep")).toBe(12);
    expect(await takeTimes(10, "conversations.info", "discovery")).toBe(8);
    // A batch take counts n at once and never overshoots.
    model = new LimiterModel();
    expect(await takeNow("conversations.info", "discovery", 10)).toBe(true);
    expect(await takeNow("conversations.info", "discovery", 1)).toBeInstanceOf(SlackRateBudgetError);
  });

  it("RL05 a new minute resets every counter", async () => {
    expect(await takeTimes(30, "conversations.history", "sweep")).toBe(30);
    expect(await takeNow("conversations.history", "sweep")).toBeInstanceOf(SlackRateBudgetError);
    clock += 50_000;
    expect(await takeTimes(30, "conversations.history", "sweep")).toBe(30);
    expect(await takeTimes(10, "conversations.history", "triage")).toBe(10);
  });
});

describe("blocks and the other tiers (RL06, RL07)", () => {
  it("RL06 blocked_until refuses every class until it passes, with the wait to it; a block never runs past 10 minutes (mutant N33)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock);
    await noteSlackRateLimited(TEAM, "conversations.history", 7_000);
    expect(vi.mocked(rateBlock)).toHaveBeenCalledTimes(1);
    for (const cls of ["triage", "sweep", "probe", "discovery"] as const) {
      const refused = await takeNow("conversations.history", cls);
      expect(refused, cls).toBeInstanceOf(SlackRateBudgetError);
      expect((refused as SlackRateBudgetError).retryAfterMs).toBe(7_000);
    }
    expect(await takeNow("conversations.replies", "sweep")).toBe(true);
    clock += 7_000;
    expect(await takeNow("conversations.history", "triage")).toBe(true);
    // An hour's Retry-After is capped at 10 minutes, by the client and by the RPC.
    await noteSlackRateLimited(TEAM, "users.info", 3_600_000);
    const [, , until] = vi.mocked(rateBlock).mock.calls[1];
    expect(until.getTime() - clock).toBeLessThanOrEqual(10 * MINUTE);
    const blocked = await takeNow("users.info", "triage");
    expect((blocked as SlackRateBudgetError).retryAfterMs).toBeLessThanOrEqual(10 * MINUTE);
    model.block(TEAM, "users.list", new Date(clock + 24 * 3_600_000), clock);
    expect((model.rows.get(`${TEAM}|users.list`)?.blockedUntil ?? 0) - clock).toBe(10 * MINUTE);
  });

  it("RL07 Tier 2 conversations.list / users.list: discovery only, 15 a minute; users.info 60; chat.getPermalink 100", async () => {
    expect(await takeNow("conversations.list", "sweep")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeNow("users.list", "triage")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(15, "conversations.list", "discovery")).toBe(15);
    expect(await takeNow("conversations.list", "discovery")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(60, "users.info", "triage")).toBe(60);
    expect(await takeNow("users.info", "sweep")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(100, "chat.getPermalink", "triage")).toBe(100);
    expect(await takeNow("chat.getPermalink", "triage")).toBeInstanceOf(SlackRateBudgetError);
  });
});

describe("takeSlackBudget (RL08)", () => {
  it("RL08 waits (fake timers) when the wait is ≤ 10 s and retries once; > 10 s → SlackRateBudgetError, retryable, 429", async () => {
    vi.useFakeTimers();
    clock = Date.UTC(2026, 10, 8, 15, 0, 55);   // 5 s left in the minute
    const realNow = () => new Date(clock);
    for (let i = 0; i < 30; i++) await takeSlackBudget(TEAM, "conversations.history", "sweep", { now: realNow });
    let settled = false;
    const p = takeSlackBudget(TEAM, "conversations.history", "sweep", { now: realNow }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    expect(vi.mocked(rateTake)).toHaveBeenCalledTimes(32);
    // A wait longer than the cap: refused at once, with the wait.
    clock = Date.UTC(2026, 10, 8, 15, 1, 10);
    for (let i = 0; i < 29; i++) await takeSlackBudget(TEAM, "conversations.history", "sweep", { now: realNow });
    const err = await takeSlackBudget(TEAM, "conversations.history", "sweep", { now: realNow }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackRateBudgetError);
    expect(err).toMatchObject({ name: "SlackRateBudgetError", errorClass: "retryable", status: 429, retryAfterMs: 50_000 });
    expect((err as Error).message).toBe("slack: the reading call budget is used up for now");
    expect(classifyError(err)).toBe("retryable");
  });

  it("a second refusal after the wait throws; maxWaitMs widens the wait; the caller's abort ends the wait", async () => {
    vi.useFakeTimers();
    vi.mocked(rateTake).mockResolvedValue({ allowed: false, waitMs: 3_000, reason: "blocked" });
    const twice = takeSlackBudget(TEAM, "users.info", "triage", { now }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await twice).toMatchObject({ retryAfterMs: 3_000 });
    expect(vi.mocked(rateTake)).toHaveBeenCalledTimes(2);
    vi.mocked(rateTake).mockClear();
    vi.mocked(rateTake).mockResolvedValueOnce({ allowed: false, waitMs: 20_000, reason: "budget" }).mockResolvedValueOnce({ allowed: true, waitMs: 0 });
    const wide = takeSlackBudget(TEAM, "users.info", "triage", { now, maxWaitMs: 30_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(wide).resolves.toBeUndefined();
    vi.mocked(rateTake).mockResolvedValue({ allowed: false, waitMs: 5_000, reason: "budget" });
    const controller = new AbortController();
    const aborted = takeSlackBudget(TEAM, "users.info", "triage", { now, signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    expect(await aborted).toMatchObject({ name: "AbortError" });
    const pre = new AbortController();
    pre.abort();
    vi.mocked(rateTake).mockClear();
    expect(await takeSlackBudget(TEAM, "users.info", "triage", { now, signal: pre.signal }).catch((e: unknown) => e)).toMatchObject({ name: "AbortError" });
    expect(vi.mocked(rateTake)).not.toHaveBeenCalled();
  });

  it("a store error throws (no unmetered call); n must be 1..10; an unreadable wait is a full window", async () => {
    vi.mocked(rateTake).mockRejectedValue(new SlackReadStoreError("rate_take", "57014"));
    await expect(takeSlackBudget(TEAM, "conversations.history", "sweep", { now })).rejects.toBeInstanceOf(SlackReadStoreError);
    for (const n of [0, 11, 1.5, Number.NaN]) {
      await expect(takeSlackBudget(TEAM, "conversations.history", "sweep", { n, now })).rejects.toBeInstanceOf(RangeError);
    }
    vi.mocked(rateTake).mockResolvedValue({ allowed: false, waitMs: Number.NaN });
    expect(await takeSlackBudget(TEAM, "conversations.history", "sweep", { now }).catch((e: unknown) => e)).toMatchObject({ retryAfterMs: 60_000 });
    expect(new SlackRateBudgetError(-5).retryAfterMs).toBe(1_000);
    expect(new SlackRateBudgetError(1_234.2).retryAfterMs).toBe(1_235);
    expect(out.calls()).toEqual([]);
  });
});

describe("noteSlackRateLimited (RL09)", () => {
  it("RL09 records rateBlock(team, method, now + retryAfterMs); never throws, and logs ids and codes only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock);
    await noteSlackRateLimited(TEAM, "conversations.replies", 12_000);
    expect(vi.mocked(rateBlock)).toHaveBeenLastCalledWith(TEAM, "conversations.replies", new Date(clock + 12_000));
    await noteSlackRateLimited(TEAM, "conversations.replies", Number.NaN);
    expect(vi.mocked(rateBlock)).toHaveBeenLastCalledWith(TEAM, "conversations.replies", new Date(clock + 30_000));
    await noteSlackRateLimited(TEAM, "conversations.replies", 0);
    expect(vi.mocked(rateBlock)).toHaveBeenLastCalledWith(TEAM, "conversations.replies", new Date(clock + 30_000));
    vi.mocked(rateBlock).mockRejectedValueOnce(new SlackReadStoreError("rate_block", "42P01"));
    await expect(noteSlackRateLimited(TEAM, "users.info", 5_000)).resolves.toBeUndefined();
    vi.mocked(rateBlock).mockRejectedValueOnce(new Error("SENTINEL-SLACK-TEXT-7f3a"));
    await expect(noteSlackRateLimited(TEAM, "users.info", 5_000)).resolves.toBeUndefined();
    out.assertClean();
    expect(out.calls()).toEqual([
      ["[exec-slack-read] rate block not recorded", { method: "users.info", code: "42P01" }],
      ["[exec-slack-read] rate block not recorded", { method: "users.info", code: "error" }]
    ]);
  });
});

// Integrator (stage 2, B's request): RL01, RL02, RL06 and RL07 again through the REAL store's rateTake / rateBlock against
// A's fake-slack-read-db.ts mirror of exec_slack_rate_take / _block, so the fake the handler tests run on is pinned to the
// same §2.8.9 table as LimiterModel (and the SQL, RQ18). The mutants N32b / N33b run here.
describe("the limiter through A's fake (RL01, RL02, RL06, RL07; integrator)", () => {
  let fake: FakeSlackReadDb;
  beforeEach(async () => {
    fake = createFakeSlackReadDb({ now: () => new Date(clock) });
    vi.mocked(getSupabaseAdmin).mockReturnValue(fake.client as never);
    const real = await vi.importActual<typeof import("@/lib/exec/slack-read-store")>("@/lib/exec/slack-read-store");
    vi.mocked(rateTake).mockImplementation(real.rateTake);
    vi.mocked(rateBlock).mockImplementation(real.rateBlock);
  });

  it("RL01 (fake-slack-read-db) 30 sweep takes succeed, the 31st is refused with the wait to the next minute; replies has its own row", async () => {
    expect(await takeTimes(30, "conversations.history", "sweep")).toBe(30);
    const refused = await takeNow("conversations.history", "sweep");
    expect(refused).toBeInstanceOf(SlackRateBudgetError);
    expect((refused as SlackRateBudgetError).retryAfterMs).toBe(50_000);
    expect(await takeNow("conversations.replies", "sweep")).toBe(true);
    clock += 50_000;
    expect(await takeNow("conversations.history", "sweep")).toBe(true);
  });

  it("RL02 (fake-slack-read-db) triage still gets budget after 30 sweep takes, up to a metered total of 40", async () => {
    expect(await takeTimes(30, "conversations.replies", "sweep")).toBe(30);
    expect(await takeTimes(10, "conversations.replies", "triage")).toBe(10);
    expect(await takeNow("conversations.replies", "triage")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(10, "conversations.history", "probe")).toBe(10);
    expect(await takeNow("conversations.history", "probe")).toBeInstanceOf(SlackRateBudgetError);
  });

  it("RL06 (fake-slack-read-db) blocked_until refuses every class until it passes, with the wait to it; the RPC caps a block at 10 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(clock);
    await noteSlackRateLimited(TEAM, "conversations.history", 7_000);
    for (const cls of ["triage", "sweep", "probe", "discovery"] as const) {
      const refused = await takeNow("conversations.history", cls);
      expect(refused, cls).toBeInstanceOf(SlackRateBudgetError);
      expect((refused as SlackRateBudgetError).retryAfterMs).toBe(7_000);
    }
    expect(await takeNow("conversations.replies", "sweep")).toBe(true);
    clock += 7_000;
    expect(await takeNow("conversations.history", "triage")).toBe(true);
    await rateBlock(TEAM, "users.list", new Date(clock + 24 * 3_600_000));
    const row = fake.tables.exec_slack_rate.find((r) => r.team_id === TEAM && r.method === "users.list");
    expect(Date.parse(String(row?.blocked_until)) - clock).toBe(10 * MINUTE);
  });

  it("RL07 (fake-slack-read-db) Tier 2 discovery only, 15 a minute; users.info 60; chat.getPermalink 100", async () => {
    expect(await takeNow("conversations.list", "sweep")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(15, "conversations.list", "discovery")).toBe(15);
    expect(await takeNow("conversations.list", "discovery")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(60, "users.info", "triage")).toBe(60);
    expect(await takeNow("users.info", "sweep")).toBeInstanceOf(SlackRateBudgetError);
    expect(await takeTimes(100, "chat.getPermalink", "triage")).toBe(100);
    expect(await takeNow("chat.getPermalink", "triage")).toBeInstanceOf(SlackRateBudgetError);
  });
});

describe("P6's DM path is unmetered (RL10)", () => {
  it("RL10 readDmMessage never takes from the limiter", async () => {
    installFakeSlack({
      "conversations.history": () => ({ ok: true, messages: [{ type: "message", user: "U0MITCH", text: "hi", ts: "1793977201.000100" }], has_more: false })
    });
    const target = Object.freeze({ token: "xoxb-FAKE-recorded-bot-token", dmChannelId: "D0MITCH" });
    for (let i = 0; i < 5; i++) await readDmMessage(target, { channel: "D0MITCH", ts: "1793977201.000100", threadTs: null });
    expect(vi.mocked(rateTake)).not.toHaveBeenCalled();
    expect(vi.mocked(rateBlock)).not.toHaveBeenCalled();
    expect(SLACK_RECORDED.authTest().team_id).toBe("T0SCALED");
  });

  it("RL10 slack-dm.ts and handlers/slack-reply.ts import nothing from slack-rate.ts or the reading store", () => {
    const importsOf = (rel: string): string[] => {
      const file = fileURLToPath(new URL(rel, import.meta.url));
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const specs: string[] = [];
      const visit = (n: ts.Node): void => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) specs.push(n.arguments[0].text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return specs;
    };
    for (const rel of ["./slack-dm.ts", "./handlers/slack-reply.ts"]) {
      const specs = importsOf(rel);
      expect(specs.length, rel).toBeGreaterThan(0);
      expect(specs.filter((s) => /slack-rate|slack-read-store|slack-read$/.test(s)), rel).toEqual([]);
    }
  });
});
