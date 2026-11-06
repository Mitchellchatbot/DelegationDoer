import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadSettings: vi.fn() }));
vi.mock("@/lib/exec/llm/client", () => ({ callModel: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ spentTodayUsd: vi.fn() }));
vi.mock("@/lib/exec/producers/dd", async () => (await import("../__tests__/ddtext-mocks")).producersDd);
vi.mock("@/lib/exec/analysis/tasks", async () => (await import("../__tests__/ddtext-mocks")).analysisTasks);
vi.mock("@/lib/exec/intake-screen", () => ({ loadIntakeScreeningPolicy: vi.fn(), restrictedIntakeTaskIds: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => ({
  DdReadError: class DdReadError extends Error {
    readonly table: string;
    constructor(table: string, message: string) {
      super(`DD read failed (${table}): ${message}`);
      this.table = table;
    }
  },
  listTasksByIds: vi.fn(),
  listUsers: vi.fn(),
  listActivitySince: vi.fn(),
  listTaskMessagesSince: vi.fn(),
  listUpdateRepliesByUser: vi.fn()
}));
// attention.ts: P2b's syncAttention runs for real on the fake attention DB; Area A's new status read is stood in for.
vi.mock("@/lib/exec/attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/attention")>();
  return { ...actual, listAttentionStatusByFingerprints: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listAttentionStatusByFingerprints } from "@/lib/exec/attention";
import type { AttentionStatus } from "@/lib/exec/attention-types";
import { loadIntakeScreeningPolicy, restrictedIntakeTaskIds, type IntakeWithholdReason } from "@/lib/exec/intake-screen";
import { callModel, type CallModelResult } from "@/lib/exec/llm/client";
import { spentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { DDTEXT_CONCURRENCY, DDTEXT_MAX_CALLS, ddtextJobHandler } from "@/lib/exec/handlers/ddtext-triage";
import { listActivitySince, listTaskMessagesSince, listTasksByIds, listUpdateRepliesByUser, listUsers } from "@/lib/exec/sources/dd";
import type { DdTask, DdUser } from "@/lib/exec/sources/dd-types";
import type { ExecJobRow } from "@/lib/exec/types";
import { BudgetExceededError, type ExecPrincipal, type ExecSettings, type JobContext } from "@/lib/exec/types";
import { createFakeDdtextDb, type FakeDdtextDb, type Row } from "../__tests__/fake-ddtext-db";
import { createFakePostgrest, type FakePostgrest } from "../__tests__/fake-postgrest";
import { ddTask } from "../__tests__/ddtext-mocks";

// P5a contract §3.12.6: tests 59 (the handler), 60 (idempotency) and 51b's
// handler half, on the fake DD + ddtext + attention database, P3's
// sync-state.ts on the fake exec_sync_state, and a mocked model.

const NOW = new Date("2026-11-20T15:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const at = (msBefore: number) => new Date(NOW.getTime() - msBefore).toISOString();
const principal = {
  id: "ep_1",
  userId: "u_mitchell",
  email: "mitchell@scaledai.org",
  name: "Mitchell",
  timezone: "America/New_York",
  mailAccountIds: [],
  slackTeamId: null,
  slackUserId: null
} as unknown as ExecPrincipal;

let db: FakeDdtextDb;
let state: FakePostgrest;
let tasks: Map<string, DdTask>;
let withheld: Map<string, IntakeWithholdReason>;
let settings: Partial<ExecSettings>;
let hisActivity: { taskId: string; createdAt: string }[];

const users: DdUser[] = ["u_ann:Ann", "u_bob:Bob", "u_mitchell:Mitchell Price"].map((s) => {
  const [id, name] = s.split(":");
  return { id, name, email: `${id}@x.test`, role: "worker", isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: [] };
});

function ctx(): JobContext {
  return { job: { id: 7 } as ExecJobRow, principal, signal: new AbortController().signal, workerId: "w1" };
}
const run = () => ddtextJobHandler.run(ctx()) as Promise<Record<string, unknown>>;

function addTask(id: string, over: Partial<DdTask> = {}): void {
  tasks.set(id, ddTask({ id, title: `Task ${id}`, ...over }));
  db.taskIds.add(id);
}

function comment(id: string, text: string, msBefore: number, over: Row = {}): Row {
  const row = { id, task_id: "t_1", user_id: "u_ann", action: "comment", detail: text, created_at: at(msBefore), mentioned_user_ids: [], ...over };
  db.activity.push(row);
  return row;
}

function eodNote(id: string, blockers: string, submittedBefore: number, updatedBefore = submittedBefore): Row {
  const row = { id, user_id: "u_ann", note_date: "2026-11-19", submitted_at: at(submittedBefore), updated_at: at(updatedBefore), blockers };
  db.eod.push(row);
  return row;
}

const BLOCKER = "Blocked: the client still hasn't sent the hosting logins, so nothing can deploy.";

function refsOf(request: unknown): string[] {
  const text = ((request as { messages: { content: { text: string }[] }[] }).messages[0].content[1] as { text: string }).text;
  return [...text.matchAll(/^\[(i\d+) /gm)].map((m) => m[1]);
}

function modelResult(text: string, over: Partial<CallModelResult> = {}): CallModelResult {
  return {
    message: {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: over.refused ? { type: "refusal", category: "general_harms" } : null,
      usage: { input_tokens: 1000, output_tokens: 100 },
      toolInputErrors: [],
      unknownDeltas: 0
    },
    refused: false,
    truncated: false,
    costUsd: 0.0002,
    latencyMs: 10,
    requestId: "req",
    ...over
  };
}

/** The model finds one blocker in every item it is shown. */
function blockerForEveryRef() {
  vi.mocked(callModel).mockImplementation(async ({ request }) =>
    modelResult(JSON.stringify({ signals: refsOf(request).map((ref) => ({ subject: ref, kind: "blocker", summary: "Deployment is waiting on client logins.", confidence: "high" })) }))
  );
}

const itemOf = (id: string) => db.items.find((i) => i.source_id === id);
const cursor = () => state.tables.exec_sync_state.find((r) => r.source === "ddtext" && r.key === "cursor")?.cursor as Row | undefined;
const scanSince = () => db.callsTo("activity_logs").map((c) => c.filters.find((f) => f.kind === "gte")).find(Boolean) as { value: string } | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = createFakeDdtextDb();
  state = createFakePostgrest({ tables: { exec_sync_state: [] } });
  for (const u of users) db.userIds.add(u.id);
  tasks = new Map();
  addTask("t_1", { priority: "high" });
  withheld = new Map();
  hisActivity = [];
  settings = { principalId: "ep_1", ddtextSchemaReady: true, ddtextEnabled: true, retentionDaysDdtext: 90, emailSchemaReady: false, emailEnabled: false };
  const client = db.client as { from(t: string): unknown; rpc(n: string, a: unknown): unknown };
  const stateClient = state.client as { from(t: string): unknown };
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from: (t: string) => (t === "exec_sync_state" ? stateClient.from(t) : client.from(t)),
    rpc: (n: string, a: unknown) => client.rpc(n, a)
  } as unknown as SupabaseClient);
  vi.mocked(loadSettings).mockImplementation(async () => settings as ExecSettings);
  vi.mocked(spentTodayUsd).mockResolvedValue(0);
  vi.mocked(loadIntakeScreeningPolicy).mockResolvedValue({ rules: [], hash: "h" });
  vi.mocked(restrictedIntakeTaskIds).mockImplementation(async (_p, ids) => new Map([...withheld].filter(([id]) => ids.includes(id))));
  vi.mocked(listTasksByIds).mockImplementation(async (_p, ids) => ids.map((id) => tasks.get(id)).filter((t): t is DdTask => t !== undefined));
  vi.mocked(listUsers).mockResolvedValue(users);
  vi.mocked(listActivitySince).mockImplementation(async (_p, since, filter) =>
    hisActivity
      .filter((a) => Date.parse(a.createdAt) >= Date.parse(since) && (filter.taskIds ?? []).includes(a.taskId))
      .map((a, i) => ({ id: `h${i}`, taskId: a.taskId, userId: "u_mitchell", action: "comment", createdAt: a.createdAt }))
  );
  vi.mocked(listTaskMessagesSince).mockResolvedValue([]);
  vi.mocked(listUpdateRepliesByUser).mockResolvedValue([]);
  vi.mocked(listAttentionStatusByFingerprints).mockImplementation(async (_p, fps) => {
    const out = new Map<string, AttentionStatus>();
    for (const r of db.attention.rows) if (fps.includes(r.fingerprint as string)) out.set(r.fingerprint as string, r.status as AttentionStatus);
    return out;
  });
  vi.mocked(callModel).mockImplementation(async () => modelResult('{"signals":[]}'));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gates (test 59)", () => {
  it("not installed: skips without a read", async () => {
    settings.ddtextSchemaReady = false;
    comment("a_1", BLOCKER, 5 * MIN);
    expect(await run()).toEqual({ skipped: "not_installed" });
    expect(db.calls).toEqual([]);
    expect(state.queries).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("disabled: deletes every item, signal and ddtext attention row (any status), no scan, no call, cursor kept (a-build-12)", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    comment("a_2", BLOCKER, 4 * MIN);
    blockerForEveryRef();
    await run();
    expect(db.items).toHaveLength(2);
    expect(db.attention.rows).toHaveLength(2);
    db.attention.rows = db.attention.rows.map((r, i) => ({ ...r, status: i === 0 ? "dismissed" : "resolved", resolution: i === 0 ? null : "owner", resolved_at: i === 0 ? null : NOW.toISOString() }));
    db.attention.seed({
      principal_id: "ep_1",
      fingerprint: "dd:overdue:assignee:u_ann",
      source: "dd",
      kind: "overdue_tasks",
      category: "delegated",
      priority_band: "normal",
      title: "Overdue",
      state_hash: "x"
    });
    const saved = structuredClone(cursor());
    vi.mocked(callModel).mockClear();
    db.calls = [];
    settings.ddtextEnabled = false;
    expect(await run()).toEqual({ disabled: true, deletedItems: 2, deletedAttention: 2 });
    expect(db.items).toEqual([]);
    expect(db.signals).toEqual([]);
    expect(db.attention.rows.map((r) => r.kind)).toEqual(["overdue_tasks"]);
    expect(db.callsTo("activity_logs")).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
    expect(cursor()).toEqual(saved);
  });

  it("lease held by another run: skips", async () => {
    state.tables.exec_sync_state.push({
      principal_id: "ep_1",
      source: "ddtext",
      key: "ddtext-lease",
      cursor: { rev: 3, holder: "w9:99", leaseUntil: new Date(NOW.getTime() + 60_000).toISOString() },
      updated_at: NOW.toISOString()
    });
    comment("a_1", BLOCKER, 5 * MIN);
    expect(await run()).toEqual({ skipped: "lease_held" });
    expect(db.callsTo("activity_logs")).toEqual([]);
  });

  it("releases its lease after a run", async () => {
    await run();
    const lease = state.tables.exec_sync_state.find((r) => r.key === "ddtext-lease");
    expect(lease?.source).toBe("ddtext");
    expect(lease?.cursor).toMatchObject({ holder: null, leaseUntil: null });
  });
});

describe("windows and the cursor (test 59, a-correct-15)", () => {
  it("first run: the backfill is min(14, retention) days; retention 7 gives a 7-day backfill and scan floor", async () => {
    await run();
    expect(scanSince()?.value).toBe(at(14 * DAY));
    db.calls = [];
    state.tables.exec_sync_state = [];
    settings.retentionDaysDdtext = 7;
    await run();
    expect(scanSince()?.value).toBe(at(7 * DAY));
    const eod = db.callsTo("eod_notes")[0].filters.find((f) => f.kind === "gt") as { value: string };
    expect(eod.value).toBe(at(7 * DAY));
  });

  it("a later scan starts 15 minutes before the saved position, never before the floor", async () => {
    comment("a_1", BLOCKER, 60 * MIN);
    await run();
    expect(cursor()).toMatchObject({ comments: { at: at(60 * MIN), id: "a_1" }, startedAt: NOW.toISOString() });
    db.calls = [];
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    await run();
    expect(scanSince()?.value).toBe(at(75 * MIN));
  });

  it("saves startedAt even when no position moved (ddtextLastRunAt, a-correct-16)", async () => {
    await run();
    const first = cursor();
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    await run();
    expect(cursor()).toMatchObject({ comments: first?.comments, eod: first?.eod, sod: first?.sod, startedAt: new Date(NOW.getTime() + 10 * MIN).toISOString() });
  });
});

describe("triage (tests 59, 60, 51b)", () => {
  it("writes each item's outcome and signals, syncs the attention row, and returns counts only", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    comment("a_2", "ok", 4 * MIN);
    comment("a_3", "My own update on the deployment plan here.", 3 * MIN, { user_id: "u_mitchell" });
    blockerForEveryRef();
    const r = await run();
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(itemOf("a_1")).toMatchObject({ outcome: "signals", model: "claude-haiku-5-5", task_id: "t_1", activity_log_id: "a_1", triage_version: "ddtext-v1" });
    expect(itemOf("a_1")?.expires_at).toBe(new Date(Date.parse(at(5 * MIN)) + 90 * DAY).toISOString());
    expect(itemOf("a_2")).toBeUndefined();
    expect(itemOf("a_3")).toBeUndefined();
    expect(db.attention.rows.map((x) => x.fingerprint)).toEqual(["dd:ddtext:blocker:comment:a_1"]);
    expect(r).toMatchObject({ scanned: 3, prefiltered: 2, items: 1, calls: 1, signals: 1, inserted: 1, orphansDeleted: 0 });
    expect(Object.values(r).every((v) => typeof v === "number")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/hosting|Deployment/i);
  });

  it("the same run twice: the second makes no model call and writes nothing (test 60)", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    eodNote("e_1", "Waiting on design files from the client before I can start the page.", 30 * MIN);
    blockerForEveryRef();
    await run();
    const calls = vi.mocked(callModel).mock.calls.length;
    const writes = db.callsTo("exec_ddtext_replace_item").length;
    expect(writes).toBe(2);
    const second = await run();
    expect(vi.mocked(callModel).mock.calls.length).toBe(calls);
    expect(db.callsTo("exec_ddtext_replace_item").length).toBe(writes);
    expect(second).toMatchObject({ items: 0, calls: 0, deduped: 2, inserted: 0, unchanged: 2 });
  });

  it("packs 10 long items and 5 context rows into ≥2 batches: one call per batch, a model outcome for every item (51b)", async () => {
    for (let i = 0; i < 5; i += 1) comment(`ctx${i}`, `context ${i} ${"c".repeat(1490)}`, DAY + (5 - i) * MIN);
    for (let i = 0; i < 10; i += 1) comment(`it${i}`, `item ${i} ${"q".repeat(1490)}`, 50 * MIN - i * MIN);
    // Only the 10 are new: the context rows are before the saved position.
    state.tables.exec_sync_state.push({ principal_id: "ep_1", source: "ddtext", key: "cursor", cursor: { rev: 1, comments: { at: at(DAY - 30 * MIN), id: "zz" }, eod: { at: null }, sod: { at: null }, startedAt: at(DAY) }, updated_at: at(DAY) });
    blockerForEveryRef();
    const r = await run();
    const n = vi.mocked(callModel).mock.calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(r.calls).toBe(n);
    for (const call of vi.mocked(callModel).mock.calls) expect(((call[0].request.messages[0].content[1] as { text: string }).text).length).toBeLessThanOrEqual(12_000);
    const seen = vi.mocked(callModel).mock.calls.flatMap((c) => refsOf(c[0].request)).length;
    expect(seen).toBe(10);
    for (let i = 0; i < 10; i += 1) expect(itemOf(`it${i}`)?.outcome).toBe("signals");
    for (let i = 0; i < 5; i += 1) expect(itemOf(`ctx${i}`)).toBeUndefined();
  });

  it("budget (the daily cap): this and every unlaunched item deferred, no more launches, cursor past them; retried once each later", async () => {
    const n = DDTEXT_CONCURRENCY + 2;
    for (let i = 0; i < n; i += 1) {
      addTask(`t_${i}`);
      comment(`a_${i}`, BLOCKER, (10 - i) * MIN, { task_id: `t_${i}` });
    }
    vi.mocked(callModel).mockRejectedValue(new BudgetExceededError(15, 15));
    const r = await run();
    // Only the calls already in flight when the cap answered; nothing launched after it.
    expect(vi.mocked(callModel).mock.calls.length).toBeLessThanOrEqual(DDTEXT_CONCURRENCY);
    for (let i = 0; i < n; i += 1) expect(itemOf(`a_${i}`)?.outcome).toBe("deferred");
    expect(r).toMatchObject({ deferred: n, ceilingReached: 0 });
    expect(cursor()).toMatchObject({ comments: { at: at((10 - n + 1) * MIN), id: `a_${n - 1}` } });
    // Next run: every item is inside the 15-minute overlap AND on the deferred list: one call each, not two (a-correct-15).
    vi.mocked(callModel).mockReset();
    blockerForEveryRef();
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    const again = await run();
    expect(callModel).toHaveBeenCalledTimes(n);
    expect(vi.mocked(callModel).mock.calls.flatMap((c) => refsOf(c[0].request))).toEqual(Array.from({ length: n }, () => "i1"));
    for (let i = 0; i < n; i += 1) expect(itemOf(`a_${i}`)?.outcome).toBe("signals");
    expect(again).toMatchObject({ items: n, deferred: 0 });
  });

  it("deferred items outside the scan are re-read by id and retried", async () => {
    addTask("t_2");
    comment("a_old", BLOCKER, 3 * DAY);
    comment("a_new", BLOCKER, 60 * MIN, { task_id: "t_2" });
    vi.mocked(callModel).mockRejectedValue(new BudgetExceededError(15, 15));
    await run();
    expect([itemOf("a_old")?.outcome, itemOf("a_new")?.outcome]).toEqual(["deferred", "deferred"]);
    // The cursor moved on to a_new: a day later a_old is only on the deferred list.
    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    vi.mocked(callModel).mockReset();
    blockerForEveryRef();
    db.calls = [];
    await run();
    expect(itemOf("a_old")?.outcome).toBe("signals");
    expect(itemOf("a_new")?.outcome).toBe("signals");
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(db.callsTo("activity_logs").some((c) => c.filters.some((f) => f.kind === "in" && f.column === "id"))).toBe(true);
  });

  it("the C29 ceiling: at $0.995 today no call is made and the items are deferred (ceilingReached); a failed spend read defers too", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    vi.mocked(spentTodayUsd).mockResolvedValue(0.995);
    const r = await run();
    expect(callModel).not.toHaveBeenCalled();
    expect(itemOf("a_1")?.outcome).toBe("deferred");
    expect(r).toMatchObject({ calls: 0, deferred: 1, ceilingReached: 1 });
    expect(spentTodayUsd).toHaveBeenCalledWith("ep_1", "America/New_York", expect.any(Date), { feature: "ddtext" });

    db.items = [];
    db.signals = [];
    state.tables.exec_sync_state = [];
    vi.mocked(spentTodayUsd).mockRejectedValue(new Error("read failed"));
    const r2 = await run();
    expect(callModel).not.toHaveBeenCalled();
    expect(r2).toMatchObject({ deferred: 1, ceilingReached: 1 });
  });

  it("refusal: failed, no retry", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    vi.mocked(callModel).mockResolvedValue(modelResult("", { refused: true }));
    const r = await run();
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(itemOf("a_1")).toMatchObject({ outcome: "failed", failure: "refusal" });
    expect(r.failed).toBe(1);
  });

  it("truncation: one split retry, item by item, then failed: truncated", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    comment("a_2", "Need a decision from Mitchell on the pricing tier before Friday.", 4 * MIN);
    vi.mocked(callModel)
      .mockResolvedValueOnce(modelResult('{"signals":[', { truncated: true }))
      .mockResolvedValueOnce(modelResult(JSON.stringify({ signals: [{ subject: "i1", kind: "blocker", summary: "Deployment waits on client logins.", confidence: "high" }] })))
      .mockResolvedValueOnce(modelResult('{"sig', { truncated: true }));
    const r = await run();
    expect(callModel).toHaveBeenCalledTimes(3);
    expect(itemOf("a_1")?.outcome).toBe("signals");
    expect(itemOf("a_2")).toMatchObject({ outcome: "failed", failure: "truncated" });
    expect(r.calls).toBe(3);
  });

  it("an infrastructure error throws, with no cursor write and no sync", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    vi.mocked(callModel).mockRejectedValue(new Error("socket hang up"));
    await expect(run()).rejects.toThrow("socket hang up");
    expect(cursor()).toBeUndefined();
    expect(db.attention.rows).toEqual([]);
    // The lease is still given back.
    expect(state.tables.exec_sync_state.find((r) => r.key === "ddtext-lease")?.cursor).toMatchObject({ holder: null });
  });

  it("the call cap stops launching; the cursor stops before the first unlaunched item", async () => {
    const n = DDTEXT_MAX_CALLS + 2;
    for (let i = 0; i < n; i += 1) {
      addTask(`t_${i}`);
      comment(`a_${String(i).padStart(3, "0")}`, BLOCKER, (n - i) * MIN, { task_id: `t_${i}` });
    }
    blockerForEveryRef();
    const r = await run();
    expect(callModel).toHaveBeenCalledTimes(DDTEXT_MAX_CALLS);
    expect(r.calls).toBe(DDTEXT_MAX_CALLS);
    expect(db.items).toHaveLength(DDTEXT_MAX_CALLS);
    const unlaunched = db.activity.map((a) => a.id as string).filter((id) => !itemOf(id)).sort();
    expect(unlaunched).toHaveLength(2);
    const first = db.activity.find((a) => a.id === unlaunched[0]);
    expect(Date.parse((cursor()?.comments as Row).at as string)).toBeLessThan(Date.parse(first?.created_at as string));
  });

  it("the 180 s time box stops launching", async () => {
    addTask("t_2");
    addTask("t_3");
    comment("a_1", BLOCKER, 5 * MIN);
    comment("a_2", BLOCKER, 4 * MIN, { task_id: "t_2" });
    comment("a_3", BLOCKER, 3 * MIN, { task_id: "t_3" });
    vi.mocked(callModel).mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 100_000));
      return modelResult('{"signals":[]}');
    });
    const r = await run();
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(r.calls).toBe(2);
    expect(itemOf("a_3")).toBeUndefined();
    expect(cursor()).toMatchObject({ comments: { at: at(4 * MIN), id: "a_2" } });
  });

  it("source_gone is counted, not fatal", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    db.before = (c) => {
      if (c.op === "rpc") db.deleteActivity("a_1");
    };
    const r = await run();
    expect(r.sourceGone).toBe(1);
    expect(db.items).toEqual([]);
  });
});

describe("mentions (tests 56, 59; C18)", () => {
  it("a short comment naming him is written for its mention without a model call, and becomes a ddtext_mention item", async () => {
    comment("a_1", "@Mitchell ?", 5 * MIN);
    const r = await run();
    expect(callModel).not.toHaveBeenCalled();
    expect(itemOf("a_1")).toMatchObject({ outcome: "signals", model: null });
    expect(db.signals.map((s) => [s.kind, s.confidence, s.summary])).toEqual([["mention", "deterministic", null]]);
    expect(db.attention.rows.map((x) => [x.kind, x.fingerprint])).toEqual([["ddtext_mention", "dd:ddtext:mention:comment:a_1"]]);
    expect(r).toMatchObject({ calls: 0, signals: 1, inserted: 1 });
  });

  it("no mention when DD's own mention chip names him (M23), and none while P2b's mention item for the task is live", async () => {
    comment("a_1", "@Mitchell Price can you approve the hosting plan today please?", 5 * MIN, { mentioned_user_ids: ["u_mitchell"] });
    await run();
    expect(db.signals.filter((s) => s.kind === "mention")).toEqual([]);

    comment("a_2", "@Mitchell Price one more question on the hosting plan for you", 4 * MIN);
    db.attention.seed({ principal_id: "ep_1", fingerprint: "dd:mention:task:t_1", source: "dd", kind: "unanswered_mention", category: "my_action", priority_band: "normal", title: "Mention", state_hash: "x" });
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    await run();
    expect(db.signals.filter((s) => s.kind === "mention").map((s) => s.source_id)).toEqual(["a_2"]);
    expect(db.attention.rows.filter((x) => x.kind === "ddtext_mention")).toEqual([]);
  });

  it("his later activity on the task answers a mention", async () => {
    comment("a_1", "@Mitchell ?", 50 * MIN);
    hisActivity = [{ taskId: "t_1", createdAt: at(10 * MIN) }];
    await run();
    expect(db.signals).toHaveLength(1);
    expect(db.attention.rows).toEqual([]);
  });
});

describe("restricted senders (C25; a-correct-2, a-build-13, coherence-1)", () => {
  it("a task withheld for its sender or its thread is skipped for good, with P3's schema off and no tag (M31)", async () => {
    addTask("t_r", { tags: ["email-intake"] });
    addTask("t_thread");
    comment("a_1", BLOCKER, 5 * MIN, { task_id: "t_r" });
    comment("a_2", BLOCKER, 4 * MIN, { task_id: "t_thread" });
    comment("a_3", BLOCKER, 3 * MIN);
    withheld.set("t_r", "restricted_sender");
    withheld.set("t_thread", "restricted_thread");
    blockerForEveryRef();
    const r = await run();
    expect(restrictedIntakeTaskIds).toHaveBeenCalledWith(principal, expect.arrayContaining(["t_r", "t_thread", "t_1"]), { rules: [], hash: "h" }, expect.anything());
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callModel).mock.calls[0][0].request.messages[0].content[1]).not.toMatchObject({ text: expect.stringContaining("Task t_r") });
    expect([itemOf("a_1"), itemOf("a_2"), itemOf("a_3")?.outcome]).toEqual([undefined, undefined, "signals"]);
    expect(r).toMatchObject({ skippedIntake: 2 });
    expect(cursor()).toMatchObject({ comments: { id: "a_3" } });
  });

  it("an unreadable screen skips a mail-linked task's rows as unscreened and holds the cursor before the first of them", async () => {
    addTask("t_mail");
    comment("a_1", BLOCKER, 6 * MIN);
    comment("a_2", BLOCKER, 5 * MIN, { task_id: "t_mail" });
    comment("a_3", BLOCKER, 4 * MIN);
    vi.mocked(loadIntakeScreeningPolicy).mockResolvedValue(null);
    vi.mocked(restrictedIntakeTaskIds).mockImplementation(async (_p, ids) => new Map(ids.filter((id) => id === "t_mail").map((id) => [id, "unscreened" as const])));
    blockerForEveryRef();
    const r = await run();
    expect(r.skippedUnscreened).toBe(1);
    expect(itemOf("a_2")).toBeUndefined();
    expect(itemOf("a_1")?.outcome).toBe("signals");
    expect(itemOf("a_3")?.outcome).toBe("signals");
    expect(vi.mocked(callModel).mock.calls.every((c) => !(c[0].request.messages[0].content[1] as { text: string }).text.includes("Task t_mail"))).toBe(true);
    // The cursor holds before a_2, so a later run with a readable screen reaches it.
    expect(cursor()).toMatchObject({ comments: { at: at(6 * MIN), id: "a_1" } });
    vi.mocked(restrictedIntakeTaskIds).mockImplementation(async () => new Map());
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    await run();
    expect(itemOf("a_2")?.outcome).toBe("signals");
  });

  it("an already-triaged overlap row that now can't be screened never walks the saved cursor back (data-3)", async () => {
    addTask("t_mail");
    comment("a_0", BLOCKER, 12 * MIN);
    comment("a_1", BLOCKER, 10 * MIN, { task_id: "t_mail" });
    comment("a_2", BLOCKER, 5 * MIN);
    blockerForEveryRef();
    await run();
    expect(cursor()).toMatchObject({ comments: { at: at(5 * MIN), id: "a_2" } });
    // A rules outage: every mail-linked task is unscreened. a_1 sits in the 15-minute overlap before the saved position.
    vi.mocked(restrictedIntakeTaskIds).mockImplementation(async (_p, ids) => new Map(ids.filter((id) => id === "t_mail").map((id) => [id, "unscreened" as const])));
    for (const later of [10, 20, 30]) {
      vi.setSystemTime(new Date(NOW.getTime() + later * MIN));
      await expect(run()).rejects.toThrow(/couldn't be screened/);
      expect(cursor(), `+${later} min`).toMatchObject({ comments: { at: at(5 * MIN), id: "a_2" } });
    }
    // The last scan still starts 15 minutes before a_2, not before a_0.
    const scans = db.callsTo("activity_logs").map((c) => c.filters.find((f) => f.kind === "gte")).filter(Boolean) as { value: string }[];
    expect(scans[scans.length - 1].value).toBe(at(20 * MIN));
  });

  it("step 9 never syncs a partial picture: a live signal's task that can't be screened throws before the sync", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    blockerForEveryRef();
    await run();
    const before = structuredClone(db.attention.rows);
    vi.mocked(restrictedIntakeTaskIds).mockImplementation(async (_p, ids) => new Map(ids.map((id) => [id, "unscreened" as const])));
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    await expect(run()).rejects.toThrow(/couldn't be screened/);
    expect(db.attention.rows).toEqual(before);
    expect(db.items).toHaveLength(1);
  });

  it("a sender muted after a signal was stored: the next run deletes that task's items and attention row", async () => {
    addTask("t_2");
    comment("a_1", BLOCKER, 5 * MIN, { task_id: "t_2" });
    blockerForEveryRef();
    await run();
    expect(db.attention.rows).toHaveLength(1);
    withheld.set("t_2", "restricted_sender");
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    const r = await run();
    expect(db.items).toEqual([]);
    expect(db.signals).toEqual([]);
    expect(db.attention.rows).toEqual([]);
    expect(r).toMatchObject({ withheldDeleted: 1, orphansDeleted: 1 });
  });

  it("a sender muted later drops that task's signals of every age, not only the live 14 days (security-4)", async () => {
    addTask("t_old");
    addTask("t_flaky");
    // Stored 30 days ago: outside the 14-day live window, inside the 90-day retention.
    vi.setSystemTime(new Date(NOW.getTime() - 30 * DAY));
    comment("a_old", BLOCKER, 30 * DAY + 5 * MIN, { task_id: "t_old" });
    comment("a_flaky", BLOCKER, 30 * DAY + 4 * MIN, { task_id: "t_flaky" });
    blockerForEveryRef();
    await run();
    expect(db.signals.map((s) => s.source_id).sort()).toEqual(["a_flaky", "a_old"]);
    vi.setSystemTime(NOW);
    withheld.set("t_old", "restricted_sender");
    // An older task that can't be screened right now is skipped, not thrown: it backs nothing live.
    withheld.set("t_flaky", "unscreened");
    const r = await run();
    expect(restrictedIntakeTaskIds).toHaveBeenLastCalledWith(principal, expect.arrayContaining(["t_old", "t_flaky"]), { rules: [], hash: "h" }, expect.anything());
    expect(itemOf("a_old")).toBeUndefined();
    expect(db.signals.map((s) => s.source_id)).toEqual(["a_flaky"]);
    expect(r).toMatchObject({ withheldDeleted: 1 });
  });
});

describe("step 9 and his row's state (review data-1, data-2)", () => {
  it("a wait he dismissed stays dismissed while the task waits on the client and after it moves back (data-1)", async () => {
    vi.mocked(callModel).mockImplementation(async ({ request }) =>
      modelResult(JSON.stringify({ signals: refsOf(request).map((ref) => ({ subject: ref, kind: "waiting", summary: "Parked until the client sends the logins.", confidence: "high" })) }))
    );
    comment("a_1", BLOCKER, 5 * MIN);
    await run();
    expect(db.attention.rows.map((r) => [r.kind, r.status])).toEqual([["ddtext_waiting", "open"]]);
    db.attention.rows = db.attention.rows.map((r) => ({ ...r, status: "dismissed" }));
    addTask("t_1", { priority: "high", status: "waiting_on_client" });
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    expect(await run()).toMatchObject({ resolved: 0 });
    expect(db.attention.rows.map((r) => r.status)).toEqual(["dismissed"]);
    addTask("t_1", { priority: "high", status: "in_progress" });
    vi.setSystemTime(new Date(NOW.getTime() + 20 * MIN));
    expect(await run()).toMatchObject({ reopened: 0 });
    expect(db.attention.rows.map((r) => r.status)).toEqual(["dismissed"]);
  });

  it("an item that vanishes between the signals read and the hash read neither reopens his seen row nor backs it (data-2)", async () => {
    comment("a_1", BLOCKER, 5 * MIN);
    blockerForEveryRef();
    await run();
    db.attention.rows = db.attention.rows.map((r) => ({ ...r, status: "seen" }));
    // Step 9 reads the live signals (the select with a source_created_at floor), then the item hashes: the
    // item (and, by cascade, its signal) goes in between, as the daily retention purge or a DD hard delete would.
    let step9 = false;
    let vanished = false;
    db.before = (call) => {
      if (call.table === "exec_ddtext_signals" && call.op === "select" && call.filters.some((f) => f.kind === "gte" && f.column === "source_created_at")) step9 = true;
      else if (step9 && !vanished && call.table === "exec_ddtext_items" && call.op === "select") {
        vanished = true;
        db.items = db.items.filter((i) => i.source_id !== "a_1");
        db.signals = db.signals.filter((s) => s.source_id !== "a_1");
      }
    };
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    const r = await run();
    expect(vanished).toBe(true);
    expect(r).toMatchObject({ reopened: 0, orphansDeleted: 1 });
    expect(db.attention.rows).toEqual([]);
  });
});

describe("notes (K28, a-correct-9)", () => {
  it("an EOD edited inline after submission is never triaged until a resubmit; then once", async () => {
    eodNote("e_1", "Waiting on design files from the client before I can start.", 60 * MIN, 30 * MIN);
    blockerForEveryRef();
    const r = await run();
    expect(callModel).not.toHaveBeenCalled();
    expect(r).toMatchObject({ skippedEditedAfterSubmit: 1, items: 0 });
    expect(db.items).toEqual([]);
    // Resubmit: submitted_at moves past updated_at.
    db.eod[0].submitted_at = at(-5 * MIN);
    db.eod[0].updated_at = at(-5 * MIN);
    vi.setSystemTime(new Date(NOW.getTime() + 10 * MIN));
    await run();
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(itemOf("e_1")).toMatchObject({ source_type: "eod_note", eod_note_id: "e_1", note_date: "2026-11-19", outcome: "signals", task_id: null });
    expect(db.attention.rows.map((x) => x.fingerprint)).toEqual(["dd:ddtext:blocker:eod_note:e_1"]);
    vi.setSystemTime(new Date(NOW.getTime() + 20 * MIN));
    await run();
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("a deferred note edited after submission loses its deferred item", async () => {
    eodNote("e_1", "Waiting on design files from the client before I can start.", 3 * DAY);
    vi.mocked(callModel).mockRejectedValueOnce(new BudgetExceededError(15, 15));
    await run();
    expect(itemOf("e_1")?.outcome).toBe("deferred");
    db.eod[0].updated_at = NOW.toISOString();
    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    const r = await run();
    expect(itemOf("e_1")).toBeUndefined();
    expect(r.skippedEditedAfterSubmit).toBe(1);
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});

describe("the orphan purge at the end of every run (a-correct-1)", () => {
  it("deletes an unbacked ddtext row with the run's remaining signals as backing", async () => {
    db.attention.seed({
      principal_id: "ep_1",
      fingerprint: "dd:ddtext:blocker:comment:a_gone",
      source: "dd",
      kind: "ddtext_blocker",
      category: "intervene",
      priority_band: "high",
      title: "Possible blocker",
      state_hash: "x",
      status: "resolved",
      resolution: "owner",
      resolved_at: NOW.toISOString(),
      occurred_at: at(DAY)
    });
    const r = await run();
    expect(r.orphansDeleted).toBe(1);
    expect(db.attention.rows).toEqual([]);
  });
});
