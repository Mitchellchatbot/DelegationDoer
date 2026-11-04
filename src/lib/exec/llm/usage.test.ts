import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { assertWithinDailyCap, recordUsage, spentTodayUsd, usageRow, type UsageRecordInput } from "@/lib/exec/llm/usage";

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
