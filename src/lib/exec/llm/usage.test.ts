import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadSettings: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { BudgetExceededError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";
import {
  SPEND_MEMO_TTL_MS,
  __resetSpendMemoForTests,
  assertWithinDailyCap,
  featureSpentTodayUsd,
  recordUsage,
  spentTodayUsd,
  usageRow,
  type UsageRecordInput
} from "@/lib/exec/llm/usage";
import { chatSpentTodayUsd } from "@/lib/exec/agent/budget";

// ---------------------------------------------------------------------------
// A chainable stand-in for the bits of supabase-js this module uses.
// ---------------------------------------------------------------------------

type Page = { data: unknown[] | null; error: { message: string } | null };

interface FakeDb {
  calls: { table: string; op: string; args: unknown[] }[];
  client: unknown;
}

function fakeDb(opts: { insertError?: string; pages?: Page[] | ((call: number) => Page) } = {}): FakeDb {
  const calls: FakeDb["calls"] = [];
  let pageCalls = 0;
  const nextPage = (): Page => {
    const p = opts.pages;
    const i = pageCalls++;
    if (typeof p === "function") return p(i);
    return p?.[i] ?? { data: [], error: null };
  };
  const client = {
    from(table: string) {
      return {
        insert(row: unknown) {
          calls.push({ table, op: "insert", args: [row] });
          return Promise.resolve({ error: opts.insertError ? { message: opts.insertError } : null });
        },
        select(cols: string) {
          calls.push({ table, op: "select", args: [cols] });
          const q = {
            eq: (...args: unknown[]) => (calls.push({ table, op: "eq", args }), q),
            gte: (...args: unknown[]) => (calls.push({ table, op: "gte", args }), q),
            gt: (...args: unknown[]) => (calls.push({ table, op: "gt", args }), q),
            order: (...args: unknown[]) => (calls.push({ table, op: "order", args }), q),
            limit: (...args: unknown[]) => {
              calls.push({ table, op: "limit", args });
              return Promise.resolve(nextPage());
            }
          };
          return q;
        }
      };
    }
  };
  return { calls, client };
}

function useDb(db: FakeDb): void {
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as ReturnType<typeof getSupabaseAdmin>);
}

const principal: ExecPrincipal = principalFromRows(
  { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
  { id: "u_1", email: "Mitchell@ScaledAI.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;

function settings(overrides: Partial<ExecSettings> = {}): ExecSettings {
  return { ...settingsFromRow(null, "ep_1"), ...overrides };
}

const baseRecord: UsageRecordInput = {
  principalId: "ep_1",
  feature: "chat",
  model: "claude-opus-5-5",
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 20_000,
    cache_creation_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }
  },
  latencyMs: 1234.6,
  stopReason: "end_turn",
  requestId: "req_011"
};

beforeEach(() => {
  vi.mocked(notifyOps).mockResolvedValue(false);
  vi.mocked(loadSettings).mockResolvedValue(settings());
});

// ---------------------------------------------------------------------------

describe("usageRow", () => {
  it("maps usage to the exec_ai_usage columns, pricing it", () => {
    expect(usageRow(baseRecord)).toEqual({
      principal_id: "ep_1",
      feature: "chat",
      model: "claude-opus-5-5",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 20_000,
      cache_write_tokens: 3000,
      cost_usd: 0.039,
      latency_ms: 1235,
      stop_reason: "end_turn",
      request_id: "req_011"
    });
  });

  it("rounds cost to the column's 6 decimals", () => {
    // 7 Haiku input tokens = $0.0000007 → 0.000001
    expect(usageRow({ ...baseRecord, model: "claude-haiku-5-5", usage: { input_tokens: 7 } }).cost_usd).toBe(0.000001);
  });

  it("copes with missing usage, odd latencies and long strings", () => {
    const row = usageRow({
      ...baseRecord,
      principalId: null,
      usage: null,
      latencyMs: -5,
      stopReason: "x".repeat(100),
      requestId: "r".repeat(300)
    });
    expect(row).toMatchObject({
      principal_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      latency_ms: 0
    });
    expect(row.stop_reason).toHaveLength(64);
    expect(row.request_id).toHaveLength(200);
    expect(usageRow({ ...baseRecord, latencyMs: Number.NaN }).latency_ms).toBeNull();
    expect(usageRow({ ...baseRecord, latencyMs: null, stopReason: null, requestId: null })).toMatchObject({
      latency_ms: null,
      stop_reason: null,
      request_id: null
    });
  });
});

describe("recordUsage", () => {
  it("inserts one row into exec_ai_usage", async () => {
    const db = fakeDb();
    useDb(db);
    await recordUsage(baseRecord);
    expect(db.calls).toEqual([{ table: "exec_ai_usage", op: "insert", args: [usageRow(baseRecord)] }]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("logs and alerts ops when the insert fails, without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    useDb(fakeDb({ insertError: 'relation "exec_ai_usage" does not exist' }));
    await expect(recordUsage(baseRecord)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("req_011");
    expect(String(error.mock.calls[0][0])).toContain("does not exist");
    expect(notifyOps).toHaveBeenCalledWith(expect.objectContaining({ key: "exec-usage-write" }));
  });

  it("does not throw when the admin client can't even be built", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("Supabase admin requires NEXT_PUBLIC_SUPABASE_URL");
    });
    await expect(recordUsage({ ...baseRecord, requestId: null })).resolves.toBeUndefined();
    expect(String(error.mock.calls[0][0])).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it("logs, rather than leaks, an ops alert that rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(notifyOps).mockRejectedValue(new Error("slack down"));
    useDb(fakeDb({ insertError: "boom" }));
    await recordUsage(baseRecord);
    await new Promise((r) => setTimeout(r, 0));
    expect(error.mock.calls.some((c) => String(c[0]).includes("ops alert failed") && String(c[1]).includes("slack down"))).toBe(true);
  });
});

describe("spentTodayUsd", () => {
  it("sums today's cost_usd for the principal, numeric strings included", async () => {
    const db = fakeDb({
      pages: [
        {
          data: [
            { id: 1, cost_usd: 0.25 },
            { id: 2, cost_usd: "1.500000" },
            { id: 3, cost_usd: null },
            { id: 4, cost_usd: "garbage" },
            { id: 5, cost_usd: -3 }
          ],
          error: null
        }
      ]
    });
    useDb(db);
    expect(await spentTodayUsd("ep_1", "America/New_York", new Date("2026-11-04T15:00:00Z"))).toBeCloseTo(1.75, 9);
    expect(db.calls).toEqual([
      { table: "exec_ai_usage", op: "select", args: ["id,cost_usd"] },
      { table: "exec_ai_usage", op: "eq", args: ["principal_id", "ep_1"] },
      { table: "exec_ai_usage", op: "gte", args: ["created_at", "2026-11-04T05:00:00.000Z"] },
      { table: "exec_ai_usage", op: "gt", args: ["id", 0] },
      { table: "exec_ai_usage", op: "order", args: ["id", { ascending: true }] },
      { table: "exec_ai_usage", op: "limit", args: [1000] }
    ]);
  });

  it.each([
    // Spring forward: midnight on the 8th was still EST (UTC-5).
    ["America/New_York", "2026-03-08T15:00:00Z", "2026-03-08T05:00:00.000Z"],
    // Fall back: midnight on the 1st was still EDT (UTC-4).
    ["America/New_York", "2026-11-01T15:00:00Z", "2026-11-01T04:00:00.000Z"],
    // 22:30 on the 3rd in New York is already the 4th in UTC: the LOCAL day counts.
    ["America/New_York", "2026-11-04T03:30:00Z", "2026-11-03T05:00:00.000Z"],
    // Karachi is UTC+5 all year.
    ["Asia/Karachi", "2026-11-04T20:00:00Z", "2026-11-04T19:00:00.000Z"],
    ["UTC", "2026-11-04T23:59:59Z", "2026-11-04T00:00:00.000Z"]
  ])("starts the day at local midnight in %s (now %s → %s)", async (tz, now, expected) => {
    const db = fakeDb();
    useDb(db);
    await spentTodayUsd("ep_1", tz, new Date(now));
    expect(db.calls.find((c) => c.op === "gte")?.args).toEqual(["created_at", expected]);
  });

  it("pages with an id keyset until a short page", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, cost_usd: 0.001 }));
    const db = fakeDb({ pages: [{ data: full, error: null }, { data: [{ id: 1001, cost_usd: 2 }], error: null }] });
    useDb(db);
    expect(await spentTodayUsd("ep_1", "UTC", new Date("2026-11-04T12:00:00Z"))).toBeCloseTo(3, 9);
    expect(db.calls.filter((c) => c.op === "gt").map((c) => c.args)).toEqual([
      ["id", 0],
      ["id", 1000]
    ]);
  });

  it("reads a null page as no spend", async () => {
    useDb(fakeDb({ pages: [{ data: null, error: null }] }));
    expect(await spentTodayUsd("ep_1", "UTC")).toBe(0);
  });

  it("throws when the read fails, so the cap fails closed", async () => {
    useDb(fakeDb({ pages: [{ data: null, error: { message: "connection refused" } }] }));
    await expect(spentTodayUsd("ep_1", "UTC")).rejects.toThrow("exec_ai_usage read failed: connection refused");
  });

  // P5a test 62b (C29): one feature's spend, for the DD text ceiling and P5b's chat sub-cap.
  it("with opts.feature adds .eq(\"feature\", …) after the principal; without it the query is P2a's exactly", async () => {
    const db = fakeDb({ pages: [{ data: [{ id: 1, cost_usd: "0.004" }], error: null }] });
    useDb(db);
    const now = new Date("2026-11-04T15:00:00Z");
    expect(await spentTodayUsd("ep_1", "America/New_York", now, { feature: "ddtext" })).toBeCloseTo(0.004, 9);
    expect(db.calls).toEqual([
      { table: "exec_ai_usage", op: "select", args: ["id,cost_usd"] },
      { table: "exec_ai_usage", op: "eq", args: ["principal_id", "ep_1"] },
      { table: "exec_ai_usage", op: "eq", args: ["feature", "ddtext"] },
      { table: "exec_ai_usage", op: "gte", args: ["created_at", "2026-11-04T05:00:00.000Z"] },
      { table: "exec_ai_usage", op: "gt", args: ["id", 0] },
      { table: "exec_ai_usage", op: "order", args: ["id", { ascending: true }] },
      { table: "exec_ai_usage", op: "limit", args: [1000] }
    ]);

    const plain = fakeDb();
    useDb(plain);
    await spentTodayUsd("ep_1", "America/New_York", now, {});
    expect(plain.calls.some((c) => c.op === "eq" && c.args[0] === "feature")).toBe(false);
    expect(plain.calls.map((c) => c.op)).toEqual(["select", "eq", "gte", "gt", "order", "limit"]);
  });

  it("with opts.feature keeps failing closed on a read error", async () => {
    useDb(fakeDb({ pages: [{ data: null, error: { message: "connection refused" } }] }));
    await expect(spentTodayUsd("ep_1", "UTC", new Date(), { feature: "ddtext" })).rejects.toThrow("exec_ai_usage read failed: connection refused");
  });

  it("refuses to guess past 50 full pages", async () => {
    const db = fakeDb({
      pages: (call) => ({ data: Array.from({ length: 1000 }, (_, i) => ({ id: call * 1000 + i + 1, cost_usd: 0 })), error: null })
    });
    useDb(db);
    await expect(spentTodayUsd("ep_1", "UTC")).rejects.toThrow(/not guessing/);
    expect(db.calls.filter((c) => c.op === "limit")).toHaveLength(50);
  });
});

describe("assertWithinDailyCap", () => {
  const now = new Date("2026-11-04T15:00:00Z");

  it("passes under the cap, loading settings when none are given", async () => {
    useDb(fakeDb({ pages: [{ data: [{ id: 1, cost_usd: 4.5 }], error: null }] }));
    await expect(assertWithinDailyCap(principal, undefined, now)).resolves.toEqual({ spentUsd: 4.5, capUsd: 15 });
    expect(loadSettings).toHaveBeenCalledWith("ep_1");
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("uses the settings it is given instead of loading them", async () => {
    useDb(fakeDb({ pages: [{ data: [{ id: 1, cost_usd: 1 }], error: null }] }));
    await expect(assertWithinDailyCap(principal, settings({ dailyCostCapUsd: 2 }), now)).resolves.toEqual({
      spentUsd: 1,
      capUsd: 2
    });
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("reads spend in the principal's own zone", async () => {
    const db = fakeDb();
    useDb(db);
    await assertWithinDailyCap(principal, settings(), new Date("2026-11-04T03:30:00Z"));
    expect(db.calls.find((c) => c.op === "gte")?.args).toEqual(["created_at", "2026-11-03T05:00:00.000Z"]);
    expect(db.calls.find((c) => c.op === "eq")?.args).toEqual(["principal_id", "ep_1"]);
  });

  it("throws BudgetExceededError once spend reaches the cap exactly, and alerts ops", async () => {
    useDb(fakeDb({ pages: [{ data: [{ id: 1, cost_usd: 10 }, { id: 2, cost_usd: 5 }], error: null }] }));
    const err = await assertWithinDailyCap(principal, settings(), now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).spentUsd).toBe(15);
    expect((err as BudgetExceededError).capUsd).toBe(15);
    expect(notifyOps).toHaveBeenCalledWith(expect.objectContaining({ key: "exec-cost-cap:ep_1" }));
  });

  it("throws past the cap with both figures on the error", async () => {
    useDb(fakeDb({ pages: [{ data: [{ id: 1, cost_usd: 20.123 }], error: null }] }));
    await expect(assertWithinDailyCap(principal, settings({ dailyCostCapUsd: 5 }), now)).rejects.toMatchObject({
      name: "BudgetExceededError",
      spentUsd: 20.123,
      capUsd: 5
    });
  });

  it.each([0, -1, Number.NaN])("treats a cap of %s as AI switched off, without reading spend", async (cap) => {
    const db = fakeDb();
    useDb(db);
    await expect(assertWithinDailyCap(principal, settings({ dailyCostCapUsd: cap }), now)).rejects.toMatchObject({
      name: "BudgetExceededError",
      spentUsd: 0,
      capUsd: 0
    });
    expect(db.calls).toEqual([]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("refuses settings that belong to another principal", async () => {
    useDb(fakeDb());
    await expect(
      assertWithinDailyCap(principal, { ...settings({ dailyCostCapUsd: 1000 }), principalId: "ep_other" }, now)
    ).rejects.toThrow("different principal");
  });

  it("fails closed when spend can't be read", async () => {
    useDb(fakeDb({ pages: [{ data: null, error: { message: "timeout" } }] }));
    await expect(assertWithinDailyCap(principal, settings(), now)).rejects.toThrow("exec_ai_usage read failed: timeout");
  });

  it("fails closed when settings can't be loaded", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed: boom"));
    await expect(assertWithinDailyCap(principal, undefined, now)).rejects.toThrow("exec_settings read failed");
  });
});

// ---------------------------------------------------------------------------
// P7a (contract §3.20.1, C17; AM-P7a-13): featureSpentTodayUsd, the Slack sub-cap's spend read.
// ---------------------------------------------------------------------------

describe("featureSpentTodayUsd (P7a C17)", () => {
  type Q = { filters: unknown[][]; signal: AbortSignal | null };
  function featureDb(rows: { id: number; feature: string; cost_usd: number | string; created_at: string; principal_id: string }[], error: { code?: string; message: string } | null = null) {
    const queries: Q[] = [];
    const client = {
      from(table: string) {
        expect(table).toBe("exec_ai_usage");
        return {
          select(cols: string) {
            expect(cols).toBe("id,cost_usd");
            const q: Q = { filters: [], signal: null };
            queries.push(q);
            let limit = Infinity;
            const run = () => {
              if (error) return { data: null, error };
              let out = rows.filter((r) =>
                q.filters.every(([op, col, v]) => {
                  const x = (r as Record<string, unknown>)[col as string];
                  if (op === "eq") return x === v;
                  if (op === "in") return (v as unknown[]).includes(x);
                  if (op === "gte") return Date.parse(String(x)) >= Date.parse(String(v));
                  if (op === "gt") return Number(x) > Number(v);
                  return true;
                })
              );
              out = out.sort((x, y) => x.id - y.id).slice(0, limit);
              return { data: out.map((r) => ({ id: r.id, cost_usd: r.cost_usd })), error: null };
            };
            const b = {
              eq: (c: string, v: unknown) => (q.filters.push(["eq", c, v]), b),
              in: (c: string, v: unknown[]) => (q.filters.push(["in", c, v]), b),
              gte: (c: string, v: unknown) => (q.filters.push(["gte", c, v]), b),
              gt: (c: string, v: unknown) => (q.filters.push(["gt", c, v]), b),
              order: () => b,
              limit: (n: number) => ((limit = n), b),
              abortSignal: (sig: AbortSignal) => ((q.signal = sig), b),
              then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad)
            };
            return b;
          }
        };
      }
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as never);
    return queries;
  }
  const NOW = new Date("2026-11-08T15:00:00Z");

  it("sums today's rows of the listed features only (principal-local day), on the signal", async () => {
    const queries = featureDb([
      { id: 1, feature: "slack_triage", cost_usd: "0.010000", created_at: "2026-11-08T13:00:00Z", principal_id: "ep_1" },
      { id: 2, feature: "triage", cost_usd: 0.5, created_at: "2026-11-08T13:00:00Z", principal_id: "ep_1" },
      { id: 3, feature: "slack_triage", cost_usd: 0.02, created_at: "2026-11-08T04:00:00Z", principal_id: "ep_1" },
      { id: 4, feature: "slack_triage", cost_usd: 0.04, created_at: "2026-11-08T14:00:00Z", principal_id: "ep_2" },
      { id: 5, feature: "ddtext", cost_usd: 0.003, created_at: "2026-11-08T14:30:00Z", principal_id: "ep_1" }
    ]);
    const signal = new AbortController().signal;
    expect(await featureSpentTodayUsd("ep_1", "America/New_York", ["slack_triage"], NOW, { signal })).toBeCloseTo(0.01, 9);
    expect(queries[0].signal).toBe(signal);
    expect(queries[0].filters).toContainEqual(["in", "feature", ["slack_triage"]]);
    expect(await featureSpentTodayUsd("ep_1", "UTC", ["slack_triage", "ddtext"], NOW)).toBeCloseTo(0.033, 9);
  });

  it("an empty feature list spends nothing without a query; a read error throws without the database's text", async () => {
    const queries = featureDb([]);
    expect(await featureSpentTodayUsd("ep_1", "UTC", [], NOW)).toBe(0);
    expect(queries).toEqual([]);
    featureDb([], { code: "57014", message: "SENTINEL-SLACK-TEXT-7f3a" });
    const err = await featureSpentTodayUsd("ep_1", "UTC", ["slack_triage"], NOW).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("exec_ai_usage read failed (57014)");
  });

  it("pages by id past 1,000 rows", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, feature: "slack_triage", cost_usd: 0.001, created_at: "2026-11-08T14:00:00Z", principal_id: "ep_1" }));
    const queries = featureDb(rows);
    expect(await featureSpentTodayUsd("ep_1", "UTC", ["slack_triage"], NOW)).toBeCloseTo(1.5, 6);
    expect(queries).toHaveLength(2);
    expect(queries[1].filters).toContainEqual(["gt", "id", 1000]);
  });
});

// ---------------------------------------------------------------------------
// P9 F22 (contract §1, §5.1): the 30 s per-process spend memo behind spentTodayUsd (the daily cap, the DD-text ceiling)
// and featureSpentTodayUsd (the Slack sub-cap). recordUsage adds this process's spend at once. chatSpentTodayUsd (P5b
// C17) stays a fresh read every time.
// ---------------------------------------------------------------------------

describe("P9 F22 the spend memo", () => {
  type Row = { id: number; principal_id: string | null; feature: string; cost_usd: number; created_at: string };
  /** An exec_ai_usage stand-in that answers the keyset reads (eq / in / gte / gt / order / limit / abortSignal) and inserts. */
  function spendDb(seed: Omit<Row, "id">[] = []) {
    const rows: Row[] = seed.map((r, i) => ({ id: i + 1, ...r }));
    let reads = 0;
    let failNext: string | null = null;
    let hold: Promise<void> | null = null;
    const client = {
      from(table: string) {
        expect(table).toBe("exec_ai_usage");
        return {
          insert(row: Omit<Row, "id" | "created_at">) {
            rows.push({ ...row, id: rows.length + 1, created_at: new Date().toISOString() } as Row);
            return Promise.resolve({ error: null });
          },
          select() {
            reads += 1;
            const filters: ((r: Row) => boolean)[] = [];
            let limit = Infinity;
            const run = async () => {
              if (hold) await hold;
              if (failNext !== null) {
                const message = failNext;
                failNext = null;
                return { data: null, error: { message } };
              }
              const out = rows.filter((r) => filters.every((f) => f(r))).sort((a, b) => a.id - b.id).slice(0, limit);
              return { data: out.map((r) => ({ id: r.id, cost_usd: r.cost_usd })), error: null };
            };
            const b = {
              eq: (c: string, v: unknown) => (filters.push((r) => (r as Record<string, unknown>)[c] === v), b),
              in: (c: string, v: unknown[]) => (filters.push((r) => v.includes((r as Record<string, unknown>)[c])), b),
              gte: (c: string, v: string) => (filters.push((r) => Date.parse(String((r as Record<string, unknown>)[c])) >= Date.parse(v)), b),
              gt: (c: string, v: number) => (filters.push((r) => Number((r as Record<string, unknown>)[c]) > v), b),
              order: () => b,
              limit: (n: number) => ((limit = n), b),
              abortSignal: () => b,
              then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad)
            };
            return b;
          }
        };
      }
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as never);
    return {
      rows,
      reads: () => reads,
      failNext: (m: string) => (failNext = m),
      holdReads: () => {
        let release!: () => void;
        hold = new Promise<void>((r) => (release = r));
        return () => {
          hold = null;
          release();
        };
      }
    };
  }
  const NOW = new Date("2026-11-04T15:00:00Z"); // 10:00 EST; his local day began 05:00Z
  const TODAY = "2026-11-04T14:00:00Z";
  const NY = "America/New_York";
  const rec = (over: Partial<UsageRecordInput>): UsageRecordInput => ({ ...baseRecord, ...over });
  // baseRecord (chat, Opus): $0.039 a row.

  beforeEach(() => {
    __resetSpendMemoForTests();
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("SP01 two cap checks within 30 s → one read; the second answers from the memo", async () => {
    const db = spendDb([{ principal_id: "ep_1", feature: "triage", cost_usd: 4.5, created_at: TODAY }]);
    await expect(assertWithinDailyCap(principal, settings(), NOW)).resolves.toEqual({ spentUsd: 4.5, capUsd: 15 });
    vi.setSystemTime(NOW.getTime() + SPEND_MEMO_TTL_MS - 1);
    await expect(assertWithinDailyCap(principal, settings(), new Date())).resolves.toEqual({ spentUsd: 4.5, capUsd: 15 });
    expect(db.reads()).toBe(1);
    expect(SPEND_MEMO_TTL_MS).toBe(30_000);
  });

  it("SP02 recordUsage moves the memo: this process's spend counts at once, without a read", async () => {
    const db = spendDb([{ principal_id: "ep_1", feature: "triage", cost_usd: 4.5, created_at: TODAY }]);
    expect(await spentTodayUsd("ep_1", NY, NOW)).toBeCloseTo(4.5, 9);
    await recordUsage(rec({}));
    await recordUsage(rec({ principalId: "ep_2" }));
    expect(await spentTodayUsd("ep_1", NY, NOW)).toBeCloseTo(4.539, 9);
    expect(db.reads()).toBe(1);
    // A cap reached by this process's own calls refuses the next one before any read.
    await recordUsage(rec({ usage: { input_tokens: 1_000_000, output_tokens: 500_000 } })); // $14 on Opus
    await expect(assertWithinDailyCap(principal, settings(), NOW)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(db.reads()).toBe(1);
  });

  it("SP03 after 30 s → a fresh read, which sees the rows that were recorded (no double count)", async () => {
    const db = spendDb([{ principal_id: "ep_1", feature: "triage", cost_usd: 1, created_at: TODAY }]);
    expect(await spentTodayUsd("ep_1", NY, NOW)).toBeCloseTo(1, 9);
    await recordUsage(rec({}));
    vi.setSystemTime(NOW.getTime() + SPEND_MEMO_TTL_MS);
    expect(await spentTodayUsd("ep_1", NY, new Date())).toBeCloseTo(1.039, 9);
    expect(db.reads()).toBe(2);
  });

  it("SP04 one entry per principal, local day and feature filter", async () => {
    const db = spendDb([
      { principal_id: "ep_1", feature: "ddtext", cost_usd: 0.25, created_at: TODAY },
      { principal_id: "ep_1", feature: "chat", cost_usd: 1, created_at: TODAY },
      { principal_id: "ep_2", feature: "chat", cost_usd: 7, created_at: TODAY }
    ]);
    expect(await spentTodayUsd("ep_1", NY, NOW)).toBeCloseTo(1.25, 9);
    expect(await spentTodayUsd("ep_1", NY, NOW, { feature: "ddtext" })).toBeCloseTo(0.25, 9);
    expect(await spentTodayUsd("ep_2", NY, NOW)).toBeCloseTo(7, 9);
    // Another day is another entry (its read counts every row from that midnight on, as the query does).
    expect(await spentTodayUsd("ep_1", NY, new Date("2026-11-03T15:00:00Z"))).toBeCloseTo(1.25, 9);
    expect(db.reads()).toBe(4);
    // A chat row of ep_1 moves ep_1's totals that count chat (both days' "every feature"), not the DD-text one or ep_2's.
    await recordUsage(rec({}));
    expect(await spentTodayUsd("ep_1", NY, NOW)).toBeCloseTo(1.289, 9);
    expect(await spentTodayUsd("ep_1", NY, NOW, { feature: "ddtext" })).toBeCloseTo(0.25, 9);
    expect(await spentTodayUsd("ep_2", NY, NOW)).toBeCloseTo(7, 9);
    expect(await spentTodayUsd("ep_1", NY, new Date("2026-11-03T15:00:00Z"))).toBeCloseTo(1.289, 9);
    expect(db.reads()).toBe(4);
  });

  it("SP05 a failed read keeps nothing: it throws (fail closed) and the next check reads again", async () => {
    const db = spendDb([{ principal_id: "ep_1", feature: "triage", cost_usd: 2, created_at: TODAY }]);
    db.failNext("connection refused");
    await expect(assertWithinDailyCap(principal, settings(), NOW)).rejects.toThrow("exec_ai_usage read failed: connection refused");
    await expect(assertWithinDailyCap(principal, settings(), NOW)).resolves.toEqual({ spentUsd: 2, capUsd: 15 });
    expect(db.reads()).toBe(2);
  });

  it("SP06 featureSpentTodayUsd (the Slack sub-cap) is memoized too: a Slack row recorded here moves it, a chat row doesn't", async () => {
    const db = spendDb([{ principal_id: "ep_1", feature: "slack_triage", cost_usd: 0.5, created_at: TODAY }]);
    const slack = ["slack_triage", "digest"] as const;
    expect(await featureSpentTodayUsd("ep_1", NY, slack, NOW)).toBeCloseTo(0.5, 9);
    await recordUsage(rec({ feature: "slack_triage", model: "claude-haiku-5-5", usage: { input_tokens: 100_000 } })); // $0.01
    await recordUsage(rec({})); // chat
    expect(await featureSpentTodayUsd("ep_1", NY, ["digest", "slack_triage"], NOW)).toBeCloseTo(0.51, 9);
    expect(db.reads()).toBe(1);
    // An aborted signal still throws before anything (memo or read).
    const aborted = new AbortController();
    aborted.abort(new Error("job lease lost"));
    await expect(featureSpentTodayUsd("ep_1", NY, slack, NOW, { signal: aborted.signal })).rejects.toThrow("job lease lost");
  });

  it("SP07 spend recorded while a read is in flight joins that read's total (it may miss the row: counting it errs high)", async () => {
    const db = spendDb([{ principal_id: "ep_1", feature: "triage", cost_usd: 1, created_at: TODAY }]);
    const release = db.holdReads();
    const pending = spentTodayUsd("ep_1", NY, NOW);
    await recordUsage(rec({}));
    release();
    // This fake's held read sees the new row too, and the memo adds it again: the total errs high (for up to 30 s).
    expect(await pending).toBeCloseTo(1.078, 9);
    expect(await spentTodayUsd("ep_1", NY, NOW)).toBeCloseTo(1.078, 9);
    expect(db.reads()).toBe(1);
  });

  it("SP08 chatSpentTodayUsd (P5b C17) is not memoized: every call reads", async () => {
    const db = spendDb([{ principal_id: "ep_1", feature: "chat", cost_usd: 3, created_at: TODAY }]);
    expect(await chatSpentTodayUsd(principal, NOW)).toBeCloseTo(3, 9);
    expect(await chatSpentTodayUsd(principal, NOW)).toBeCloseTo(3, 9);
    expect(db.reads()).toBe(2);
  });
});
