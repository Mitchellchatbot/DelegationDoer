import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P8 contract §5.2 LG01-LG07 (M1, C37, C38): the legacy 8am runner asks the exec gate first (lazily, Node.js only), skips
// when the Executive AI brief owns or delivered the day, fails the tick closed when it can't tell, records
// meta.ranWhileSuperseded, and asks again right before posting. Every dependency of the runner is mocked; the gate module
// is mocked with a factory that counts its imports (LG01: never imported while EXEC_ENABLED is off).

const gateState = vi.hoisted(() => ({ imports: 0, gate: vi.fn() }));
const db = vi.hoisted(() => ({
  from: [] as string[],
  upserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[]
}));

vi.mock("@/lib/exec/brief-legacy-gate", () => {
  gateState.imports += 1;
  return { legacyBriefGate: gateState.gate };
});
vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => ({
    from(table: string) {
      db.from.push(table);
      const result = { data: [] as unknown[], error: null };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "gte", "lte", "order", "limit", "in", "is"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad);
      b.upsert = async (row: Record<string, unknown>) => (db.upserts.push(row), { error: null });
      b.update = (patch: Record<string, unknown>) => {
        db.updates.push(patch);
        return { eq: async () => ({ error: null }) };
      };
      return b;
    }
  })
}));
vi.mock("@/lib/server-data", () => ({ getAllTasks: vi.fn(async () => []), getAllUsersLight: vi.fn(async () => []) }));
vi.mock("@/lib/missive-client", () => ({ listAccounts: vi.fn(async () => []), listThreads: vi.fn(async () => []) }));
vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn(), MODELS: { chat: "model-under-test" } }));
vi.mock("@/lib/slack", () => ({ openDm: vi.fn(), postMessage: vi.fn() }));
vi.mock("@/lib/slack-resolve", () => ({ resolveSlackId: vi.fn() }));
vi.mock("@/lib/shift", () => ({ DEFAULT_TZ: "America/New_York", nowInTz: vi.fn(), ymdInTz: vi.fn(() => "2026-11-01") }));
vi.mock("@/lib/stripe", () => ({ getStripeRevenue: vi.fn(async () => null) }));
vi.mock("@/lib/brain-memory", () => ({ listMemories: vi.fn(async () => []), formatMemoriesBlock: vi.fn(() => "") }));

import { getAnthropic } from "@/lib/anthropic-client";
import { runDailyBriefing } from "@/lib/daily-briefing-runner";
import { nowInTz } from "@/lib/shift";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";

const create = vi.fn();
const NINE_AM = { hh: 9, mm: 0, dayKey: "fri", ymd: "2026-11-06" };

function resetDb(): void {
  db.from.length = 0;
  db.upserts.length = 0;
  db.updates.length = 0;
}

beforeEach(() => {
  resetDb();
  gateState.gate.mockReset();
  vi.mocked(nowInTz).mockReturnValue(NINE_AM as ReturnType<typeof nowInTz>);
  create.mockReset();
  create.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ daily_update: "The day's update.", needle_mover: "One thing.", engagement_messages: [] }) }] });
  vi.mocked(getAnthropic).mockResolvedValue({ messages: { create } } as unknown as Awaited<ReturnType<typeof getAnthropic>>);
  vi.mocked(resolveSlackId).mockResolvedValue("U0OWNER01");
  vi.mocked(openDm).mockResolvedValue("D0OWNER01");
  vi.mocked(postMessage).mockResolvedValue({ ts: "1793990000.000100" } as Awaited<ReturnType<typeof postMessage>>);
  vi.stubEnv("SLACK_BOT_TOKEN", "test-bot-token");
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Nothing of the legacy body ran: no clock read, no daily_briefings read, no model call, no Slack call. */
function expectNothingRan(): void {
  expect(nowInTz).not.toHaveBeenCalled();
  expect(db.from).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  expect(openDm).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalled();
}

describe("runDailyBriefing and the Executive AI gate (M1)", () => {
  // First in the file: the mocked gate module must never have been imported before this test.
  it("LG01 EXEC_ENABLED unset → no exec read at all (the gate module is never imported), and the brief runs as today", async () => {
    vi.stubEnv("EXEC_ENABLED", undefined);
    await expect(runDailyBriefing()).resolves.toEqual({ ok: true, delivered: true, briefId: "brief_2026-11-06", messages: 0, activeTasks: 0, inboxThreads: 0 });
    expect(gateState.imports).toBe(0);
    expect(gateState.gate).not.toHaveBeenCalled();
    // Positive control: it reached the model and posted with the DD bot.
    expect(create).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0].meta).not.toHaveProperty("ranWhileSuperseded");
    // Any value but exactly "true" is off too.
    vi.stubEnv("EXEC_ENABLED", "TRUE");
    await runDailyBriefing({ dryRun: true });
    expect(gateState.imports).toBe(0);
  });

  it.each([[{}], [{ force: true }], [{ dryRun: true }], [{ force: true, dryRun: true }]])(
    "LG02 the gate says exec owns → skipped superseded-by-exec before the target-hour guard (opts %j)",
    async (opts) => {
      vi.stubEnv("EXEC_ENABLED", "true");
      vi.mocked(nowInTz).mockReturnValue({ ...NINE_AM, hh: 3 } as ReturnType<typeof nowInTz>);
      gateState.gate.mockResolvedValue({ run: false, reason: "exec_owns" });
      await expect(runDailyBriefing(opts)).resolves.toEqual({ ok: true, skipped: "superseded-by-exec" });
      expect(gateState.gate).toHaveBeenCalledTimes(1);
      expect(gateState.gate).toHaveBeenCalledWith("mitchell@scaledai.org", expect.any(Date));
      expectNothingRan();
    }
  );

  it("LG03 the gate says exec delivered today → skipped exec-delivered-today", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    gateState.gate.mockResolvedValue({ run: false, reason: "exec_delivered" });
    await expect(runDailyBriefing({ force: true })).resolves.toEqual({ ok: true, skipped: "exec-delivered-today" });
    expectNothingRan();
  });

  it("LG04 the gate throws → ok: false, exec-ownership-unknown, and nothing else runs", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    gateState.gate.mockRejectedValue(new Error("exec_principals read failed (57014)"));
    await expect(runDailyBriefing({ force: true })).resolves.toEqual({ ok: false, reason: "exec-ownership-unknown" });
    expectNothingRan();
  });

  it("LG05 EXEC_ENABLED=true outside the Node.js runtime → fail closed (exec-ownership-unknown), no gate call", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(runDailyBriefing({ force: true })).resolves.toEqual({ ok: false, reason: "exec-ownership-unknown" });
    vi.stubEnv("NEXT_RUNTIME", undefined);
    await expect(runDailyBriefing()).resolves.toEqual({ ok: false, reason: "exec-ownership-unknown" });
    expect(gateState.gate).not.toHaveBeenCalled();
    expectNothingRan();
  });

  it("LG06 run: true with ranWhileSuperseded → the upserted row's meta.ranWhileSuperseded is true; false → the key is absent", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    gateState.gate.mockResolvedValue({ run: true, reason: "legacy_owns", ranWhileSuperseded: true });
    await expect(runDailyBriefing()).resolves.toMatchObject({ ok: true, delivered: true });
    expect(db.upserts).toHaveLength(1);
    expect((db.upserts[0].meta as Record<string, unknown>).ranWhileSuperseded).toBe(true);
    expect(db.upserts[0].meta).toMatchObject({ activeTasks: 0, inboxThreads: 0 });

    resetDb();
    gateState.gate.mockResolvedValue({ run: true, reason: "legacy_owns", ranWhileSuperseded: false });
    await runDailyBriefing();
    expect(db.upserts[0].meta).not.toHaveProperty("ranWhileSuperseded");
    resetDb();
    gateState.gate.mockResolvedValue({ run: true, reason: "exec_disabled", ranWhileSuperseded: false });
    await runDailyBriefing();
    expect(db.upserts[0].meta).not.toHaveProperty("ranWhileSuperseded");
  });

  it("LG06 the gate is asked first (before the clock) and once more before posting", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    gateState.gate.mockResolvedValue({ run: true, reason: "legacy_owns", ranWhileSuperseded: false });
    await runDailyBriefing();
    expect(gateState.gate).toHaveBeenCalledTimes(2);
    const [first, second] = gateState.gate.mock.invocationCallOrder;
    expect(first).toBeLessThan(vi.mocked(nowInTz).mock.invocationCallOrder[0]);
    expect(second).toBeGreaterThan(create.mock.invocationCallOrder[0]);
    expect(second).toBeLessThan(vi.mocked(postMessage).mock.invocationCallOrder[0]);
  });

  it("LG07 C38: the second gate call answering run: false → skipped superseded-by-exec-late, the row stored and undelivered", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    gateState.gate
      .mockResolvedValueOnce({ run: true, reason: "legacy_owns", ranWhileSuperseded: true })
      .mockResolvedValueOnce({ run: false, reason: "exec_owns" });
    await expect(runDailyBriefing()).resolves.toEqual({ ok: true, skipped: "superseded-by-exec-late" });
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({ id: "brief_2026-11-06", meta: { ranWhileSuperseded: true } });
    // Never stamped delivered; its posting stamp (fixer security-3) is cleared, so the assistant's DM isn't held back.
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).not.toHaveProperty("delivered_at");
    expect(db.updates[0].meta).toMatchObject({ ranWhileSuperseded: true });
    expect(db.updates[0].meta).not.toHaveProperty("postingAt");
    expect(openDm).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("LG07b (fixer security-3) the upsert stamps meta.postingAt BEFORE the late gate (so the assistant reads it as delivered); a post keeps it; EXEC_ENABLED off → no stamp", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    let stampedBeforeLateGate = false;
    gateState.gate
      .mockResolvedValueOnce({ run: true, reason: "legacy_owns", ranWhileSuperseded: false })
      .mockImplementationOnce(async () => {
        stampedBeforeLateGate = typeof (db.upserts[0]?.meta as Record<string, unknown> | undefined)?.postingAt === "string";
        return { run: true, reason: "legacy_owns", ranWhileSuperseded: false };
      });
    await expect(runDailyBriefing()).resolves.toMatchObject({ ok: true, delivered: true });
    expect(stampedBeforeLateGate).toBe(true);
    expect(Number.isFinite(Date.parse(String((db.upserts[0].meta as Record<string, unknown>).postingAt)))).toBe(true);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toHaveProperty("delivered_at");
    // The late gate failing clears it too.
    resetDb();
    gateState.gate.mockResolvedValueOnce({ run: true, reason: "legacy_owns", ranWhileSuperseded: false }).mockRejectedValueOnce(new Error("timeout"));
    await expect(runDailyBriefing()).resolves.toEqual({ ok: false, reason: "exec-ownership-unknown" });
    expect(db.updates.map((u) => Object.keys(u))).toEqual([["meta"]]);
    expect(db.updates[0].meta).not.toHaveProperty("postingAt");
    // EXEC_ENABLED off: no exec side reads it, so no stamp.
    resetDb();
    vi.stubEnv("EXEC_ENABLED", "");
    await runDailyBriefing();
    expect(db.upserts[0].meta).not.toHaveProperty("postingAt");
  });

  it("LG07 the late gate throwing → exec-ownership-unknown, nothing posted", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    gateState.gate
      .mockResolvedValueOnce({ run: true, reason: "legacy_owns", ranWhileSuperseded: false })
      .mockRejectedValueOnce(new Error("timeout"));
    await expect(runDailyBriefing()).resolves.toEqual({ ok: false, reason: "exec-ownership-unknown" });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("a dry run asks the gate once (first) and never again (it posts nothing)", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    gateState.gate.mockResolvedValue({ run: true, reason: "legacy_owns", ranWhileSuperseded: true });
    await expect(runDailyBriefing({ dryRun: true })).resolves.toMatchObject({ ok: true, dryRun: true, row: { meta: { ranWhileSuperseded: true } } });
    expect(gateState.gate).toHaveBeenCalledTimes(1);
    expect(db.upserts).toEqual([]);
  });
});
