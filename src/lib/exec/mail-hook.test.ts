import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The mail hook (contract §3.11 "mail-hook", L10, L19, L20): which events it
// hears, whom it enqueues for, the backlog guard, never throwing into the bus,
// and the socket-health row. The inbox bus is the real one.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/missive-socket", () => ({
  startMissiveSocketBridge: vi.fn(),
  getMissiveSocketStatus: vi.fn()
}));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadPrincipalById: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { createFakePipelineDb, type FakePipelineDb, type Row } from "@/lib/exec/__tests__/fake-pipeline-db";
import { EMAIL_TRIAGE_JOB_KIND, __resetJobsForTests, mailBacklogKey, mailEventKey } from "@/lib/exec/jobs";
import { GUARD_MAX_EVENTS, __resetMailHookForTests, ensureMailHook, isMailHookInstalled, recordSocketHealth } from "@/lib/exec/mail-hook";
import { loadPrincipalById, principalFromRows } from "@/lib/exec/principal";
import { parseSocketState } from "@/lib/exec/sync-state";
import { publish, type InboxEvent } from "@/lib/inbox-event-bus";
import { getMissiveSocketStatus, startMissiveSocketBridge } from "@/lib/missive-socket";

const NOW = new Date("2026-11-04T17:00:00.000Z");

const principalRow = (id: string, accounts: string[], enabled = true): Row => ({ id, user_id: `u_${id}`, enabled, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null });
const settingsRow = (principalId: string, emailEnabled: boolean | null): Row => ({ principal_id: principalId, email_enabled: emailEnabled });
const accountsRow = (principalId: string, problems: { accountId: string; reason: string }[]): Row => ({
  principal_id: principalId,
  source: "mail",
  key: "accounts",
  cursor: { rev: 1, checkedAt: NOW.toISOString(), accounts: [], problems },
  updated_at: NOW.toISOString()
});

let db: FakePipelineDb;
function useDb(pg: Record<string, Row[]>): FakePipelineDb {
  db = createFakePipelineDb({ pg: { tables: { exec_sync_state: [], exec_principals: [], exec_settings: [], ...pg } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

function event(over: Partial<InboxEvent> = {}): InboxEvent {
  return { event: "message:new", account_id: "acct_1", thread_id: "th_1", message_id: "m1", ts: Date.now(), ...over };
}

const triageJobs = () => db.jobsOf(EMAIL_TRIAGE_JOB_KIND);
/** Let the listener's fire-and-forget work finish. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  process.env.EXEC_ENABLED = "true";
  __resetMailHookForTests();
  __resetJobsForTests();
  useDb({ exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [settingsRow("ep_1", true)] });
  // restoreMocks doesn't reset a vi.fn()'s implementation: a test that makes the bridge throw must not leak.
  vi.mocked(startMissiveSocketBridge).mockReset();
  vi.mocked(loadPrincipalById).mockReset();
  vi.mocked(getMissiveSocketStatus).mockReset();
  vi.mocked(getMissiveSocketStatus).mockReturnValue({
    initialized: true,
    connected: true,
    socketId: "s1",
    url: null,
    connectAttempts: 0,
    successfulConnects: 1,
    lastConnectError: null,
    lastDisconnectReason: null
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Every job the hook enqueues (event or backlog) carries triage's 10 attempts (L6).
  for (const j of db.jobs) expect(j.max_attempts).toBe(10);
  __resetMailHookForTests();
  vi.useRealTimers();
  delete process.env.EXEC_ENABLED;
});

describe("installing", () => {
  it("subscribes once per module copy and makes sure the socket bridge runs", async () => {
    ensureMailHook();
    ensureMailHook();
    expect(isMailHookInstalled()).toBe(true);
    expect(startMissiveSocketBridge).toHaveBeenCalledTimes(1);
    publish(event());
    await settle();
    // One listener: one enqueue attempt, one job.
    expect(triageJobs()).toHaveLength(1);
    expect(db.jobRequests.filter((r) => r.kind === "upsert")).toHaveLength(1);
  });

  it("never throws, even when the bridge can't start", () => {
    vi.mocked(startMissiveSocketBridge).mockImplementation(() => {
      throw new Error("socket.io-client failed to load");
    });
    expect(() => ensureMailHook()).not.toThrow();
    expect(isMailHookInstalled()).toBe(false);
  });
});

describe("events", () => {
  beforeEach(() => ensureMailHook());

  it("a new message on a pinned mailbox becomes an interactive triage job 8 s out, keyed on the message", async () => {
    publish(event());
    await settle();
    expect(triageJobs()).toEqual([
      expect.objectContaining({
        kind: EMAIL_TRIAGE_JOB_KIND,
        lane: "interactive",
        principal_id: "ep_1",
        dedupe_key: mailEventKey("ep_1", "m1"),
        max_attempts: 10,
        run_after: new Date(NOW.getTime() + 8_000).toISOString(),
        payload: { threadId: "th_1", messageId: "m1", accountId: "acct_1", reason: "event" }
      })
    ]);
  });

  it("the same message twice (socket and webhook) is one job", async () => {
    publish(event());
    publish(event());
    await settle();
    expect(triageJobs()).toHaveLength(1);
  });

  it.each([
    ["thread:updated", { event: "thread:updated" as const, message_id: undefined }],
    ["thread:updated, even one that names a message", { event: "thread:updated" as const, message_id: "m7" }],
    ["no message id", { message_id: undefined }],
    ["a foreign mailbox", { account_id: "acct_someone_else" }],
    ["Junk (CL1 sends the folder)", { folder: "Junk Email" }],
    ["Spam", { folder: "Spam" }],
    ["a malformed id", { thread_id: "th\n1" }]
  ])("ignores %s", async (_name, over) => {
    publish(event(over));
    await settle();
    expect(triageJobs()).toHaveLength(0);
  });

  it("enqueues for an outbound or Inbox message (the folder only filters Junk)", async () => {
    publish(event({ direction: "outbound", folder: "Sent Items", message_id: "m2" }));
    await settle();
    expect(triageJobs()).toHaveLength(1);
  });

  it.each([
    ["a disabled principal", { exec_principals: [principalRow("ep_1", ["acct_1"], false)], exec_settings: [settingsRow("ep_1", true)] }],
    ["email off", { exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [settingsRow("ep_1", false)] }],
    ["email unset", { exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [settingsRow("ep_1", null)] }],
    ["no settings row", { exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [] }],
    ["the P3 migration not applied (no email_enabled column)", { exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [{ principal_id: "ep_1" }] }],
    ["a problem account", { exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [settingsRow("ep_1", true)], exec_sync_state: [accountsRow("ep_1", [{ accountId: "acct_1", reason: "email_mismatch" }])] }]
  ])("ignores events for %s, silently", async (_name, tables) => {
    useDb(tables);
    vi.mocked(console.error).mockClear();
    publish(event());
    await settle();
    expect(triageJobs()).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("ignores everything while EXEC_ENABLED is off", async () => {
    process.env.EXEC_ENABLED = "false";
    publish(event());
    await settle();
    expect(db.pg.queries).toHaveLength(0);
    expect(triageJobs()).toHaveLength(0);
  });

  it("enqueues only for the principal who pinned the mailbox (two principals)", async () => {
    useDb({
      exec_principals: [principalRow("ep_1", ["acct_1"]), principalRow("ep_2", ["acct_2"])],
      exec_settings: [settingsRow("ep_1", true), settingsRow("ep_2", true)]
    });
    publish(event({ account_id: "acct_2", message_id: "m9" }));
    await settle();
    expect(triageJobs().map((j) => [j.principal_id, j.dedupe_key])).toEqual([["ep_2", mailEventKey("ep_2", "m9")]]);
  });

  it("reads who owns each mailbox at most once a minute", async () => {
    publish(event({ message_id: "a" }));
    await settle();
    publish(event({ message_id: "b" }));
    await settle();
    expect(db.pg.on("exec_principals")).toHaveLength(1);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    publish(event({ message_id: "c" }));
    await settle();
    expect(db.pg.on("exec_principals")).toHaveLength(2);
  });

  it("never throws into the bus: a failed read or enqueue is logged with ids only", async () => {
    useDb({ exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [settingsRow("ep_1", true)] });
    const failing = createFakePipelineDb({
      pg: { tables: { exec_sync_state: [], exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [settingsRow("ep_1", true)] } },
      failJobs: () => "connection reset"
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(failing.client as SupabaseClient);
    expect(() => publish(event())).not.toThrow();
    await settle();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/ep_1: could not enqueue message m1; reconcile will find it/));

    __resetMailHookForTests();
    ensureMailHook();
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("supabase env missing");
    });
    expect(() => publish(event({ message_id: "m2" }))).not.toThrow();
    await settle();
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/could not read which principals own each mailbox/));
  });
});

describe("the backlog guard (L10)", () => {
  beforeEach(() => ensureMailHook());

  it(`past ${GUARD_MAX_EVENTS} events a minute, the rest go to the bulk lane in one capped, staggered batch`, async () => {
    vi.mocked(loadPrincipalById).mockResolvedValue(
      principalFromRows(
        principalRow("ep_1", ["acct_1"]) as never,
        { id: "u_ep_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
        null
      )
    );
    for (let i = 0; i < GUARD_MAX_EVENTS + 20; i += 1) publish(event({ message_id: `m${i}`, thread_id: `t${i}` }));
    await settle();
    const interactive = triageJobs().filter((j) => j.lane === "interactive");
    expect(interactive).toHaveLength(GUARD_MAX_EVENTS);
    expect(triageJobs().filter((j) => j.lane === "bulk")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    const bulk = triageJobs().filter((j) => j.lane === "bulk");
    // The bulk cap (12) admits the first 12; the other 8 are left for reconcile.
    expect(bulk).toHaveLength(12);
    expect(bulk[0]).toMatchObject({ dedupe_key: mailBacklogKey("ep_1", `m${GUARD_MAX_EVENTS}`), max_attempts: 10, payload: { reason: "event", messageId: `m${GUARD_MAX_EVENTS}` } });
    const times = bulk.map((j) => Date.parse(j.run_after as string));
    expect(times[1] - times[0]).toBe(20_000);
    expect(db.pg.tables.exec_sync_state.find((s) => s.key === "stagger")).toBeDefined();
    expect(loadPrincipalById).toHaveBeenCalledWith("ep_1");
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/ep_1: backlog of 20 events: 12 queued on the bulk lane, 0 already queued, 8 left for reconcile/));
  });

  it("a minute later, events are interactive again", async () => {
    for (let i = 0; i < GUARD_MAX_EVENTS + 1; i += 1) publish(event({ message_id: `m${i}` }));
    await settle();
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    publish(event({ message_id: "late" }));
    await settle();
    expect(db.job(mailEventKey("ep_1", "late"))).toMatchObject({ lane: "interactive" });
  });
});

describe("socket health", () => {
  it("records connected, the last event heard and when, per email-on principal, at most once a minute", async () => {
    ensureMailHook();
    publish(event());
    await settle();
    recordSocketHealth(NOW.getTime());
    await settle();
    const row = db.pg.tables.exec_sync_state.find((s) => s.principal_id === "ep_1" && s.key === "socket");
    expect(parseSocketState(row?.cursor)).toEqual({ connected: true, lastEventAt: NOW.toISOString(), observedAt: NOW.toISOString() });

    vi.mocked(getMissiveSocketStatus).mockReturnValue({ ...vi.mocked(getMissiveSocketStatus)(), connected: false });
    recordSocketHealth(NOW.getTime() + 30_000);
    await settle();
    expect(parseSocketState(db.pg.tables.exec_sync_state.find((s) => s.key === "socket")?.cursor)?.connected).toBe(true);

    recordSocketHealth(NOW.getTime() + 61_000);
    await settle();
    expect(parseSocketState(db.pg.tables.exec_sync_state.find((s) => s.key === "socket")?.cursor)).toMatchObject({ connected: false, observedAt: new Date(NOW.getTime() + 61_000).toISOString() });
  });

  it("writes nothing for a principal with email off, and never throws", async () => {
    useDb({ exec_principals: [principalRow("ep_1", ["acct_1"])], exec_settings: [settingsRow("ep_1", false)] });
    expect(() => recordSocketHealth(NOW.getTime())).not.toThrow();
    await settle();
    expect(db.pg.tables.exec_sync_state.find((s) => s.key === "socket")).toBeUndefined();
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no db");
    });
    expect(() => recordSocketHealth(NOW.getTime() + 120_000)).not.toThrow();
    await settle();
  });
});
