import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { principalFromRows } from "@/lib/exec/principal";
import {
  casSyncState,
  getSyncState,
  initialReconState,
  parseAccountsState,
  parseHealthState,
  parseLeaseState,
  parsePolicyState,
  parseReconState,
  parseSocketState,
  parseStaggerState,
  problemAccountIds,
  putSyncState,
  putSyncStateByPrincipalId,
  releaseLease,
  SyncStateError,
  tryAcquireLease
} from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { createFakePostgrest, type FakePostgrestConfig, type Row } from "./__tests__/fake-postgrest";

function mint(id: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const principal = mint("ep_owner");
const other = mint("ep_other");

const row = (over: Partial<Row> & { cursor: unknown }): Row => ({
  principal_id: principal.id,
  source: "mail",
  key: "recon:acc_1",
  updated_at: "2026-11-04T10:00:00.000Z",
  ...over
});

function setup(cfg: FakePostgrestConfig = {}) {
  const db = createFakePostgrest({ tables: { exec_sync_state: [] }, ...cfg });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  const stored = (source = "mail", key = "recon:acc_1", pid = principal.id) =>
    db.tables.exec_sync_state.find((r) => r.principal_id === pid && r.source === source && r.key === key);
  return { db, stored };
}

const parseAny = (raw: unknown) => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getSyncState", () => {
  it("returns null when there is no row", async () => {
    setup();
    expect(await getSyncState(principal, "mail", "recon:acc_1", parseAny)).toBeNull();
  });

  it("returns the parsed value and its rev, reading rev as cursor->>rev in the same select", async () => {
    const { db } = setup({ tables: { exec_sync_state: [row({ cursor: { rev: 7, hwm: "x" } })] } });
    expect(await getSyncState(principal, "mail", "recon:acc_1", parseAny)).toEqual({ value: { rev: 7, hwm: "x" }, rev: 7 });
    const q = db.on("exec_sync_state")[0];
    expect(q.columns).toBe("cursor, rev:cursor->>rev");
    expect(q.filters).toEqual([
      { kind: "eq", column: "principal_id", value: principal.id },
      { kind: "eq", column: "source", value: "mail" },
      { kind: "eq", column: "key", value: "recon:acc_1" }
    ]);
    expect(q.single).toBe(true);
  });

  it("is scoped to the principal", async () => {
    setup({ tables: { exec_sync_state: [row({ principal_id: other.id, cursor: { rev: 1 } })] } });
    expect(await getSyncState(principal, "mail", "recon:acc_1", parseAny)).toBeNull();
  });

  it.each([
    ["no rev", { hwm: "x" }],
    ["a zero rev", { rev: 0 }],
    ["a fractional rev", { rev: 1.5 }],
    ["a string rev", { rev: "abc" }],
    ["a null cursor", null]
  ])("treats a cursor with %s as absent and logs the key", async (_name, cursor) => {
    setup({ tables: { exec_sync_state: [row({ cursor })] } });
    expect(await getSyncState(principal, "mail", "recon:acc_1", parseAny)).toBeNull();
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("mail/recon:acc_1");
  });

  it("treats a value the parser rejects, or a parser that throws, as absent", async () => {
    setup({ tables: { exec_sync_state: [row({ cursor: { rev: 2 } })] } });
    expect(await getSyncState(principal, "mail", "recon:acc_1", () => null)).toBeNull();
    expect(
      await getSyncState(principal, "mail", "recon:acc_1", () => {
        throw new Error("bug");
      })
    ).toBeNull();
  });

  it("throws on a database error instead of returning no state", async () => {
    setup({ fail: () => "connection reset" });
    await expect(getSyncState(principal, "mail", "recon:acc_1", parseAny)).rejects.toBeInstanceOf(SyncStateError);
  });

  it("refuses an unknown source or a bad key", async () => {
    setup();
    await expect(getSyncState(principal, "slack" as "mail", "k", parseAny)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(getSyncState(principal, "mail", "", parseAny)).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("casSyncState", () => {
  it("expectedRev null inserts rev 1 only when no row exists", async () => {
    const { db, stored } = setup();
    expect(await casSyncState(principal, "mail", "recon:acc_1", null, { hwm: "a" })).toBe(true);
    expect(stored()?.cursor).toEqual({ hwm: "a", rev: 1 });
    expect(typeof stored()?.updated_at).toBe("string");
    expect(await casSyncState(principal, "mail", "recon:acc_1", null, { hwm: "b" })).toBe(false);
    expect(stored()?.cursor).toEqual({ hwm: "a", rev: 1 });
    expect(db.on("exec_sync_state")[0].options).toEqual({ onConflict: "principal_id,source,key", ignoreDuplicates: true });
  });

  it("writes rev+1 while the stored rev is the expected one, and loses cleanly when it moved", async () => {
    const { db, stored } = setup({ tables: { exec_sync_state: [row({ cursor: { rev: 3, hwm: "a" } })] } });
    expect(await casSyncState(principal, "mail", "recon:acc_1", 3, { hwm: "b", rev: 99 })).toBe(true);
    expect(stored()?.cursor).toEqual({ hwm: "b", rev: 4 });
    expect(stored()?.updated_at).not.toBe("2026-11-04T10:00:00.000Z");
    const update = db.on("exec_sync_state").find((q) => q.op === "update");
    expect(update?.filters).toContainEqual({ kind: "eq", column: "cursor->>rev", value: "3" });
    // A writer still holding rev 3 loses and changes nothing.
    expect(await casSyncState(principal, "mail", "recon:acc_1", 3, { hwm: "stale" })).toBe(false);
    expect(stored()?.cursor).toEqual({ hwm: "b", rev: 4 });
  });

  it("refuses a bad expectedRev and a bad value for good", async () => {
    setup();
    await expect(casSyncState(principal, "mail", "k", 0, {})).rejects.toBeInstanceOf(NonRetryableError);
    await expect(casSyncState(principal, "mail", "k", 1.5, {})).rejects.toBeInstanceOf(NonRetryableError);
    await expect(casSyncState(principal, "mail", "k", null, [] as unknown as object)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(casSyncState(principal, "mail", "k", null, { big: "x".repeat(70_000) })).rejects.toThrow(/max 65536/);
    await expect(casSyncState(principal, "mail", "k", null, { n: BigInt(1) } as object)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("throws on a database error", async () => {
    setup({ fail: (q) => (q.op === "update" ? "deadlock detected" : null) });
    await expect(casSyncState(principal, "mail", "k", 1, {})).rejects.toBeInstanceOf(SyncStateError);
  });
});

describe("putSyncState", () => {
  it("creates the row at rev 1, then bumps the rev on every write", async () => {
    const { stored } = setup();
    await putSyncState(principal, "mail", "accounts", { checkedAt: "a" });
    expect(stored("mail", "accounts")?.cursor).toEqual({ checkedAt: "a", rev: 1 });
    await putSyncState(principal, "mail", "accounts", { checkedAt: "b" });
    expect(stored("mail", "accounts")?.cursor).toEqual({ checkedAt: "b", rev: 2 });
  });

  it("replaces a row whose rev is unusable instead of wedging", async () => {
    const { stored } = setup({ tables: { exec_sync_state: [row({ key: "accounts", cursor: { rev: "garbage", x: 1 } })] } });
    await putSyncState(principal, "mail", "accounts", { checkedAt: "c" });
    expect(stored("mail", "accounts")?.cursor).toEqual({ checkedAt: "c", rev: 1 });
  });

  it("re-reads and lands on top when another writer gets in between", async () => {
    let raced = false;
    const { stored } = setup({
      tables: { exec_sync_state: [row({ key: "socket", cursor: { rev: 5, v: "old" } })] },
      beforeExecute: (q, db) => {
        if (q.op === "update" && !raced) {
          raced = true;
          db.tables.exec_sync_state[0].cursor = { rev: 6, v: "theirs" };
        }
      }
    });
    await putSyncState(principal, "mail", "socket", { v: "mine" });
    expect(stored("mail", "socket")?.cursor).toEqual({ v: "mine", rev: 7 });
  });

  it("gives up with an error when another writer keeps winning", async () => {
    setup({
      tables: { exec_sync_state: [row({ key: "socket", cursor: { rev: 1 } })] },
      beforeExecute: (q, db) => {
        if (q.op === "update") {
          const r = db.tables.exec_sync_state[0];
          r.cursor = { rev: Number((r.cursor as Row).rev) + 1 };
        }
      }
    });
    await expect(putSyncState(principal, "mail", "socket", { v: 1 })).rejects.toThrow(/another writer kept updating/);
  });
});

describe("putSyncStateByPrincipalId (the mail hook's raw-id writer)", () => {
  it("writes mail/socket for a raw principal id", async () => {
    const { stored } = setup();
    await putSyncStateByPrincipalId(principal.id, "mail", "socket", { connected: true });
    expect(stored("mail", "socket")?.cursor).toEqual({ connected: true, rev: 1 });
  });

  it("writes nothing else", async () => {
    setup();
    await expect(putSyncStateByPrincipalId("", "mail", "socket", {})).rejects.toBeInstanceOf(NonRetryableError);
    await expect(putSyncStateByPrincipalId(principal.id, "mail", "recon:acc_1" as "socket", {})).rejects.toBeInstanceOf(NonRetryableError);
    await expect(putSyncStateByPrincipalId(principal.id, "email" as "mail", "socket", {})).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("attention lease", () => {
  const T0 = new Date("2026-11-04T12:00:00.000Z");
  const leaseRow = (cursor: unknown) => row({ source: "email", key: "attention-lease", cursor });

  it("acquires a lease nobody has taken yet", async () => {
    const { stored } = setup();
    expect(await tryAcquireLease(principal, "attention-lease", "w1:job1", 180_000, T0)).toBe(true);
    expect(stored("email", "attention-lease")?.cursor).toEqual({ holder: "w1:job1", leaseUntil: "2026-11-04T12:03:00.000Z", rev: 1 });
  });

  it("refuses while another holder's lease is unexpired, and takes it over once expired", async () => {
    const { stored } = setup({ tables: { exec_sync_state: [leaseRow({ rev: 4, holder: "w2:job9", leaseUntil: "2026-11-04T12:01:00.000Z" })] } });
    expect(await tryAcquireLease(principal, "attention-lease", "w1:job1", 180_000, T0)).toBe(false);
    expect(stored("email", "attention-lease")?.cursor).toMatchObject({ holder: "w2:job9", rev: 4 });
    const later = new Date("2026-11-04T12:01:00.000Z");
    expect(await tryAcquireLease(principal, "attention-lease", "w1:job1", 180_000, later)).toBe(true);
    expect(stored("email", "attention-lease")?.cursor).toEqual({ holder: "w1:job1", leaseUntil: "2026-11-04T12:04:00.000Z", rev: 5 });
  });

  it("re-acquiring its own lease extends it; a free or unreadable lease is taken", async () => {
    const { stored } = setup({ tables: { exec_sync_state: [leaseRow({ rev: 2, holder: "w1:job1", leaseUntil: "2026-11-04T12:02:00.000Z" })] } });
    expect(await tryAcquireLease(principal, "attention-lease", "w1:job1", 180_000, T0)).toBe(true);
    expect(stored("email", "attention-lease")?.cursor).toMatchObject({ holder: "w1:job1", leaseUntil: "2026-11-04T12:03:00.000Z", rev: 3 });

    setup({ tables: { exec_sync_state: [leaseRow({ rev: 2, holder: null, leaseUntil: null })] } });
    expect(await tryAcquireLease(principal, "attention-lease", "w3", 1000, T0)).toBe(true);
    setup({ tables: { exec_sync_state: [leaseRow({ rev: "x", holder: 5 })] } });
    expect(await tryAcquireLease(principal, "attention-lease", "w3", 1000, T0)).toBe(true);
  });

  it("loses a race to another acquirer between its read and its write", async () => {
    setup({
      tables: { exec_sync_state: [leaseRow({ rev: 1, holder: null, leaseUntil: null })] },
      beforeExecute: (q, db) => {
        if (q.op === "update") db.tables.exec_sync_state[0].cursor = { rev: 2, holder: "w9", leaseUntil: "2026-11-04T12:03:00.000Z" };
      }
    });
    expect(await tryAcquireLease(principal, "attention-lease", "w1", 180_000, T0)).toBe(false);
  });

  it("refuses bad arguments and throws on a database error", async () => {
    setup();
    await expect(tryAcquireLease(principal, "attention-lease", "", 1000, T0)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(tryAcquireLease(principal, "attention-lease", "w", 0, T0)).rejects.toBeInstanceOf(NonRetryableError);
    setup({ fail: () => "timeout" });
    await expect(tryAcquireLease(principal, "attention-lease", "w", 1000, T0)).rejects.toBeInstanceOf(SyncStateError);
  });

  it("release frees it only for its own holder", async () => {
    const { stored } = setup({ tables: { exec_sync_state: [leaseRow({ rev: 3, holder: "w1", leaseUntil: "2026-11-04T12:03:00.000Z" })] } });
    await releaseLease(principal, "attention-lease", "w2");
    expect(stored("email", "attention-lease")?.cursor).toMatchObject({ holder: "w1", rev: 3 });
    await releaseLease(principal, "attention-lease", "w1");
    expect(stored("email", "attention-lease")?.cursor).toEqual({ holder: null, leaseUntil: null, rev: 4 });
    // Free now: anyone acquires at once.
    expect(await tryAcquireLease(principal, "attention-lease", "w2", 1000, new Date("2026-11-04T12:00:30.000Z"))).toBe(true);
  });

  it("release never throws: a failure is logged and the lease expires on its own", async () => {
    setup({ fail: () => "connection refused" });
    await expect(releaseLease(principal, "attention-lease", "w1")).resolves.toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("could not release email/attention-lease");
    setup();
    await expect(releaseLease(principal, "attention-lease", "w1")).resolves.toBeUndefined();
  });
});

describe("parsers", () => {
  const ISO = "2026-11-04T12:00:00.000Z";

  it("parseReconState: a full state round-trips; older rows get defaults; garbage is null", () => {
    const full = {
      rev: 9,
      mode: "feed",
      created: { cursor: "Y3Vyc29y", since: ISO },
      changed: { cursor: null, since: ISO },
      list: { hwm: ISO, windowFrom: ISO, windowTo: ISO, lastSyncedAtAtStart: ISO, offset: 199, lastDeepAt: null, pass: "snoozed" },
      backfill: { from: ISO, startedAt: ISO, enqueuedAt: null },
      versionCursor: "t_42",
      deadCursor: { finishedAt: ISO, id: 1234 },
      unknownKey: "dropped"
    };
    expect(parseReconState(full)).toEqual({
      mode: "feed",
      created: { cursor: "Y3Vyc29y", since: ISO },
      changed: { cursor: null, since: ISO },
      list: { hwm: ISO, windowFrom: ISO, windowTo: ISO, lastSyncedAtAtStart: ISO, offset: 199, lastDeepAt: null, pass: "snoozed" },
      backfill: { from: ISO, startedAt: ISO, enqueuedAt: null },
      versionCursor: "t_42",
      deadCursor: { finishedAt: ISO, id: 1234 }
    });
    expect(parseReconState({ rev: 1 })).toEqual(initialReconState());
    expect(parseReconState(initialReconState())).toEqual(initialReconState());
    for (const bad of [
      null,
      [],
      "x",
      { mode: "push" },
      { created: { cursor: 5 } },
      { list: { offset: -1 } },
      { list: { pass: "both" } },
      { backfill: { from: "yesterday", startedAt: ISO } },
      { deadCursor: 17 },
      { deadCursor: { finishedAt: ISO, id: 0 } },
      { versionCursor: "" }
    ]) {
      expect(parseReconState(bad)).toBeNull();
    }
  });

  it("parsePolicyState needs a hex64 hash, a generation and appliedAt; lap defaults to 0", () => {
    const hash = "a".repeat(64);
    expect(parsePolicyState({ rev: 1, hash, generation: 3, appliedAt: ISO, rescreenAfter: "t_9" })).toEqual({
      hash,
      generation: 3,
      appliedAt: ISO,
      rescreenAfter: "t_9",
      lap: 0
    });
    expect(parsePolicyState({ hash, generation: 0, appliedAt: ISO, rescreenAfter: null, lap: 2 })?.lap).toBe(2);
    expect(parsePolicyState({ hash: "A".repeat(64), generation: 0, appliedAt: ISO })).toBeNull();
    expect(parsePolicyState({ hash, appliedAt: ISO })).toBeNull();
    expect(parsePolicyState({ hash, generation: 1, appliedAt: ISO, lap: -1 })).toBeNull();
  });

  it("parseSocketState / parseStaggerState / parseLeaseState", () => {
    expect(parseSocketState({ connected: true, lastEventAt: null, observedAt: ISO })).toEqual({ connected: true, lastEventAt: null, observedAt: ISO });
    expect(parseSocketState({ connected: "yes", observedAt: ISO })).toBeNull();
    expect(parseStaggerState({ rev: 4, lastRunAfter: ISO })).toEqual({ lastRunAfter: ISO });
    expect(parseStaggerState({})).toEqual({ lastRunAfter: null });
    expect(parseStaggerState({ lastRunAfter: 5 })).toBeNull();
    expect(parseLeaseState({ holder: "w1", leaseUntil: ISO })).toEqual({ holder: "w1", leaseUntil: ISO });
    expect(parseLeaseState({ holder: null })).toEqual({ holder: null, leaseUntil: null });
    expect(parseLeaseState({ holder: "w1", leaseUntil: "soon" })).toBeNull();
  });

  it("parseAccountsState keeps any well-formed problem reason, so an unknown reason still marks a problem", () => {
    const state = parseAccountsState({
      checkedAt: ISO,
      accounts: [{ id: "acc_1", email: "mitchell@scaledai.org", lastSyncedAt: ISO, lastSyncError: null, lastSyncErrorAt: null }],
      problems: [
        { accountId: "acc_2", reason: "not_found" },
        { accountId: "acc_3", reason: "some_future_reason" }
      ]
    });
    expect(state?.accounts).toHaveLength(1);
    expect([...problemAccountIds(state)]).toEqual(["acc_2", "acc_3"]);
    expect(problemAccountIds(null).size).toBe(0);
    expect(parseAccountsState({ checkedAt: ISO, accounts: [], problems: [{ accountId: "a", reason: "Not Found!" }] })).toBeNull();
    expect(parseAccountsState({ checkedAt: ISO, accounts: [{ id: "a" }], problems: [] })).toBeNull();
  });

  it("parseHealthState builds a prototype-free record", () => {
    const labels = JSON.parse(
      `{"c_1":{"label":"healthy","droppedFrom":null,"droppedAt":null},"__proto__":{"label":"at_risk","droppedFrom":"healthy","droppedAt":"${ISO}"}}`
    );
    const state = parseHealthState({ takenAt: ISO, labels });
    expect(state).not.toBeNull();
    expect(Object.getPrototypeOf(state?.labels)).toBeNull();
    expect(state?.labels["c_1"]).toEqual({ label: "healthy", droppedFrom: null, droppedAt: null });
    expect(state?.labels["__proto__"]).toEqual({ label: "at_risk", droppedFrom: "healthy", droppedAt: ISO });
    expect(state?.labels["constructor"]).toBeUndefined();
    expect(({} as Record<string, unknown>).label).toBeUndefined();
    expect(parseHealthState({ takenAt: ISO, labels: { c_1: { label: "" } } })).toBeNull();
    expect(parseHealthState({ takenAt: ISO })).toBeNull();
  });
});
