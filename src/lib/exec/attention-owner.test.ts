import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { createFakeAttentionDb, type FakeAttentionDb, type FakeCall, type Row } from "@/lib/exec/__tests__/fake-attention-db";
import {
  OWNER_ACTION_TRANSITIONS,
  applyOwnerAction,
  feedOrFilter,
  getAttentionItemIdentity,
  getAttentionItemRow,
  lastAttentionRefresh,
  listAttentionPage,
  listAttentionStatusByFingerprints,
  ownerActionPatch,
  syncAttention,
  type AttentionCursorKey,
  type AttentionPageQuery,
  type OwnerActionState
} from "@/lib/exec/attention";
import type { AttentionCandidate, OwnerAction } from "@/lib/exec/attention-types";
import { principalFromRows } from "@/lib/exec/principal";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P5a contract §3.3 (Area A): the store read behind the screened accessor
// (listAttentionPage, feedOrFilter, the by-id and by-fingerprint reads) and the
// owner-action writer, against the real functions on the extended fake table
// (a-build-11). Tests 5, 6, 9, 11, 12, 13, 14.

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint();

const NOW = new Date("2026-11-04T13:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const id = (n: number) => `ea_${n.toString(16).padStart(32, "0")}`;

let db: FakeAttentionDb;
beforeEach(() => {
  db = createFakeAttentionDb({ now: () => "2026-11-01T09:00:00.000Z" });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/** A stored DD row; status-coherent defaults. */
function seed(n: number, over: Row = {}): Row {
  const status = (over.status as string | undefined) ?? "open";
  return db.seed({
    id: id(n),
    principal_id: "ep_1",
    fingerprint: `dd:overdue:assignee:u_${n}`,
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    priority_score: 50,
    priority_band: "normal",
    priority_reasons: ["Overdue tasks (base 25)"],
    title: `Item ${n}`,
    what_happened: "Something is late.",
    why_it_matters: "It matters.",
    state_hash: "abcdef0123456789",
    status,
    snooze_until: status === "snoozed" ? "2026-11-05T13:00:00.000Z" : null,
    resolution: status === "resolved" ? "auto" : null,
    resolved_at: status === "resolved" ? "2026-11-03T13:00:00.000Z" : null,
    first_seen_at: "2026-11-01T09:00:00.000Z",
    last_seen_at: "2026-11-04T12:50:00.000Z",
    updated_at: "2026-11-02T10:00:00.123456Z",
    ...over
  });
}

const stored = (n: number) => db.read().find((r) => r.id === id(n)) as Row;
const updates = () => db.calls.filter((c) => c.op === "update");
const filterValue = (call: FakeCall, op: string, col: string) => call.filters.find((f) => f[0] === op && f[1] === col)?.[2];
const query = (over: Partial<AttentionPageQuery> = {}): AttentionPageQuery => ({ statuses: "default", after: null, limit: 50, now: NOW, ...over });

// ---------------------------------------------------------------------------
// Test 5: feedOrFilter
// ---------------------------------------------------------------------------

describe("feedOrFilter (C5, C6, test 5)", () => {
  const KEY: AttentionCursorKey = { score: 55, firstSeenRaw: "2026-11-04T10:00:00.123456+00:00", id: id(7) };
  const CURSOR_TAIL = `or(priority_score.lt.55,and(priority_score.eq.55,first_seen_at.lt."2026-11-04T10:00:00.123456+00:00"),and(priority_score.eq.55,first_seen_at.eq."2026-11-04T10:00:00.123456+00:00",id.gt.${id(7)}))`;
  const STATUS_TERMS: Record<string, string> = {
    default: `status.in.(open,seen),and(status.eq.snoozed,snooze_until.lte.${NOW_ISO})`,
    open: `status.in.(open),and(status.eq.snoozed,snooze_until.lte.${NOW_ISO})`,
    seen: "status.in.(seen)",
    snoozed: `and(status.eq.snoozed,snooze_until.gt.${NOW_ISO})`,
    dismissed: "status.in.(dismissed)",
    resolved: "status.in.(resolved)"
  };

  it.each(Object.entries(STATUS_TERMS))("%s, without and with a cursor", (status, terms) => {
    expect(feedOrFilter(status as never, NOW_ISO, null)).toBe(terms);
    expect(feedOrFilter(status as never, NOW_ISO, KEY)).toBe(`and(or(${terms}),${CURSOR_TAIL})`);
  });

  it("refuses a cursor timestamp that fails the regex, a bad score or id, an unknown status and a bad now", () => {
    for (const bad of ["2026-11-04 10:00:00+00:00", '2026-11-04T10:00:00Z"),id.gt.(', "2026-11-04T10:00:00.1234567Z", "tomorrow"]) {
      expect(() => feedOrFilter("default", NOW_ISO, { ...KEY, firstSeenRaw: bad })).toThrow(NonRetryableError);
    }
    for (const score of [-1, 101, 5.5, Number.NaN]) expect(() => feedOrFilter("default", NOW_ISO, { ...KEY, score })).toThrow(NonRetryableError);
    for (const bad of ["ea_x", `${id(7)},status.eq.open`, ""]) expect(() => feedOrFilter("default", NOW_ISO, { ...KEY, id: bad })).toThrow(NonRetryableError);
    expect(() => feedOrFilter("archived" as never, NOW_ISO, null)).toThrow(NonRetryableError);
    expect(() => feedOrFilter("default", "now", null)).toThrow(NonRetryableError);
  });
});

// ---------------------------------------------------------------------------
// Test 6: listAttentionPage
// ---------------------------------------------------------------------------

describe("listAttentionPage (C5, test 6)", () => {
  it("asks for the order, the status/cursor or(), the eq and since filters and the limit", async () => {
    seed(1);
    await listAttentionPage(
      principal,
      query({ category: "delegated", band: "normal", source: "dd", kind: "overdue_tasks", firstSeenAfter: "2026-10-01T00:00:00.000Z", updatedAfter: "2026-10-02T00:00:00.000Z", limit: 21 })
    );
    const [call] = db.calls;
    expect(call.op).toBe("select");
    expect(call.filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["or", `status.in.(open,seen),and(status.eq.snoozed,snooze_until.lte.${NOW_ISO})`],
      ["eq", "category", "delegated"],
      ["eq", "priority_band", "normal"],
      ["eq", "source", "dd"],
      ["eq", "kind", "overdue_tasks"],
      ["gte", "first_seen_at", "2026-10-01T00:00:00.000Z"],
      ["gte", "updated_at", "2026-10-02T00:00:00.000Z"]
    ]);
    expect(call.orders).toEqual([
      ["priority_score", false],
      ["first_seen_at", false],
      ["id", true]
    ]);
    expect(call.limit).toBe(21);
  });

  it("keeps the raw updated_at and first_seen_at verbatim (microseconds) next to the item", async () => {
    seed(1, { first_seen_at: "2026-11-01T09:00:00.654321Z", updated_at: "2026-11-02T10:00:00.123456Z" });
    const [row] = await listAttentionPage(principal, query());
    expect(row.version).toBe("2026-11-02T10:00:00.123456+00:00");
    expect(row.firstSeenRaw).toBe("2026-11-01T09:00:00.654321+00:00");
    // The item's own fields are rounded to the millisecond, which is why the raw strings travel beside it.
    expect(row.item.updatedAt).toBe("2026-11-02T10:00:00.123Z");
  });

  it("orders by score (numerically), then first seen (to the microsecond), then id", async () => {
    seed(1, { priority_score: 55, first_seen_at: "2026-11-01T09:00:00.000001Z" });
    seed(2, { priority_score: 100, first_seen_at: "2026-10-01T09:00:00Z" });
    seed(3, { priority_score: 55, first_seen_at: "2026-11-01T09:00:00.000002Z" });
    seed(4, { priority_score: 55, first_seen_at: "2026-11-01T09:00:00.000001Z" });
    seed(5, { priority_score: 9 });
    const rows = await listAttentionPage(principal, query());
    expect(rows.map((r) => r.item.id)).toEqual([id(2), id(3), id(1), id(4), id(5)]);
  });

  it("filters by status: default is open + seen + run-out snoozes; snoozed means still snoozed", async () => {
    seed(1, { status: "open" });
    seed(2, { status: "seen" });
    seed(3, { status: "snoozed", snooze_until: "2026-11-04T12:00:00Z" });
    seed(4, { status: "snoozed", snooze_until: "2026-11-05T12:00:00Z" });
    seed(5, { status: "dismissed" });
    seed(6, { status: "resolved" });
    const ids = async (statuses: AttentionPageQuery["statuses"]) => (await listAttentionPage(principal, query({ statuses }))).map((r) => r.item.id).sort();
    expect(await ids("default")).toEqual([id(1), id(2), id(3)]);
    expect(await ids("open")).toEqual([id(1), id(3)]);
    expect(await ids("snoozed")).toEqual([id(4)]);
    expect(await ids("dismissed")).toEqual([id(5)]);
    expect(await ids("resolved")).toEqual([id(6)]);
  });

  it("starts right after the cursor key", async () => {
    seed(1, { priority_score: 60 });
    seed(2, { priority_score: 50, first_seen_at: "2026-11-02T09:00:00.000002Z" });
    seed(3, { priority_score: 50, first_seen_at: "2026-11-02T09:00:00.000001Z" });
    seed(4, { priority_score: 50, first_seen_at: "2026-11-02T09:00:00.000001Z" });
    seed(5, { priority_score: 40 });
    const after = { score: 50, firstSeenRaw: "2026-11-02T09:00:00.000001+00:00", id: id(3) };
    expect((await listAttentionPage(principal, query({ after }))).map((r) => r.item.id)).toEqual([id(4), id(5)]);
  });

  it("refuses a bad query before reading, and throws on a database error", async () => {
    await expect(listAttentionPage(principal, query({ limit: 0 }))).rejects.toThrow(NonRetryableError);
    await expect(listAttentionPage(principal, query({ limit: 102 }))).rejects.toThrow(NonRetryableError);
    await expect(listAttentionPage(principal, query({ kind: "Bad Kind" }))).rejects.toThrow(NonRetryableError);
    await expect(listAttentionPage(principal, query({ category: "x" as never }))).rejects.toThrow(NonRetryableError);
    await expect(listAttentionPage(principal, query({ firstSeenAfter: "last week" }))).rejects.toThrow(NonRetryableError);
    expect(db.calls).toEqual([]);
    db.fail = () => ({ message: "boom" });
    await expect(listAttentionPage(principal, query())).rejects.toThrow("exec_attention_items read failed");
  });

  it("passes the abort signal", async () => {
    const signal = new AbortController().signal;
    await listAttentionPage(principal, query(), { signal });
    expect(db.calls[0].signal).toBe(signal);
  });
});

// ---------------------------------------------------------------------------
// Test 9: keyset stability against last_seen_at moves (M7)
// ---------------------------------------------------------------------------

describe("keyset paging is stable while syncs bump last_seen_at (test 9)", () => {
  it("a row whose last_seen_at changes between page 1 and page 2 is neither skipped nor repeated", async () => {
    // One score; first_seen order A > B > C > D, last_seen order deliberately different.
    seed(1, { first_seen_at: "2026-11-01T10:00:00Z", last_seen_at: "2026-11-04T12:00:00Z" });
    seed(2, { first_seen_at: "2026-11-01T09:00:00Z", last_seen_at: "2026-11-04T12:03:00Z" });
    seed(3, { first_seen_at: "2026-11-01T08:00:00Z", last_seen_at: "2026-11-04T12:01:00Z" });
    seed(4, { first_seen_at: "2026-11-01T07:00:00Z", last_seen_at: "2026-11-04T12:02:00Z" });
    const page1 = await listAttentionPage(principal, query({ limit: 2 }));
    expect(page1.map((r) => r.item.id)).toEqual([id(1), id(2)]);
    const last = page1[1];
    // A sync sees row 3 again (only last_seen_at moves).
    db.rows = db.rows.map((r) => (r.id === id(3) ? { ...r, last_seen_at: "2026-11-04T12:59:00+00:00" } : r));
    const page2 = await listAttentionPage(principal, query({ limit: 2, after: { score: last.item.priority.score, firstSeenRaw: last.firstSeenRaw, id: last.item.id } }));
    expect(page2.map((r) => r.item.id)).toEqual([id(3), id(4)]);
  });
});

// ---------------------------------------------------------------------------
// By id / by fingerprint
// ---------------------------------------------------------------------------

describe("getAttentionItemRow, getAttentionItemIdentity, listAttentionStatusByFingerprints", () => {
  it("reads one row by principal and id, raw strings kept; null for none or a malformed id (no read)", async () => {
    seed(1, { updated_at: "2026-11-02T10:00:00.000007Z" });
    const row = await getAttentionItemRow(principal, id(1));
    expect(row?.item.id).toBe(id(1));
    expect(row?.version).toBe("2026-11-02T10:00:00.000007+00:00");
    expect(db.calls[0].filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["eq", "id", id(1)]
    ]);
    expect(await getAttentionItemRow(principal, id(9))).toBeNull();
    db.calls.length = 0;
    expect(await getAttentionItemRow(principal, "ea_1,status.eq.open")).toBeNull();
    expect(db.calls).toEqual([]);
  });

  it("reads an item's identity columns only", async () => {
    seed(1);
    expect(await getAttentionItemIdentity(principal, id(1))).toEqual({ id: id(1), fingerprint: "dd:overdue:assignee:u_1", source: "dd", kind: "overdue_tasks" });
    expect(db.calls[0].columns).toBe("id,fingerprint,source,kind");
    expect(await getAttentionItemIdentity(principal, id(2))).toBeNull();
  });

  it("maps fingerprints to stored statuses, identity columns only; malformed fingerprints throw before any read", async () => {
    seed(1, { status: "dismissed" });
    seed(2);
    const map = await listAttentionStatusByFingerprints(principal, ["dd:overdue:assignee:u_1", "dd:overdue:assignee:u_2", "dd:none:x", "dd:overdue:assignee:u_1"]);
    expect([...map]).toEqual([
      ["dd:overdue:assignee:u_1", "dismissed"],
      ["dd:overdue:assignee:u_2", "open"]
    ]);
    expect(db.calls[0].columns).toBe("fingerprint,status");
    expect(db.calls[0].filters).toContainEqual(["eq", "principal_id", "ep_1"]);
    db.calls.length = 0;
    expect((await listAttentionStatusByFingerprints(principal, [])).size).toBe(0);
    await expect(listAttentionStatusByFingerprints(principal, ["dd:a,b"])).rejects.toThrow(NonRetryableError);
    expect(db.calls).toEqual([]);
  });
});

describe("lastAttentionRefresh with kinds (a-correct-16)", () => {
  it("narrows to the given kinds; without them it is P2b's read", async () => {
    seed(1, { kind: "overdue_tasks", last_seen_at: "2026-11-04T10:00:00Z" });
    seed(2, { kind: "ddtext_blocker", fingerprint: "dd:ddtext:blocker:comment:x", last_seen_at: "2026-11-04T12:58:00Z" });
    expect(await lastAttentionRefresh(principal, "dd")).toBe("2026-11-04T12:58:00.000Z");
    expect(await lastAttentionRefresh(principal, "dd", { kinds: ["overdue_tasks", "stalled_tasks"] })).toBe("2026-11-04T10:00:00.000Z");
    expect(db.calls[1].filters).toContainEqual(["in", "kind", ["overdue_tasks", "stalled_tasks"]]);
    expect(db.calls[0].filters.some((f) => f[0] === "in")).toBe(false);
    await expect(lastAttentionRefresh(principal, "dd", { kinds: [] })).rejects.toThrow(NonRetryableError);
    await expect(lastAttentionRefresh(principal, "dd", { kinds: ["Bad"] })).rejects.toThrow(NonRetryableError);
  });
});

// ---------------------------------------------------------------------------
// Tests 11-13: the owner-action writer
// ---------------------------------------------------------------------------

const STATES: Record<OwnerActionState | "snoozed_expired", Row> = {
  open: { status: "open" },
  seen: { status: "seen" },
  snoozed: { status: "snoozed", snooze_until: "2026-11-05T13:00:00Z" },
  snoozed_expired: { status: "snoozed", snooze_until: "2026-11-04T12:00:00Z" },
  dismissed: { status: "dismissed" },
  resolved_owner: { status: "resolved", resolution: "owner", resolved_at: "2026-11-03T13:00:00Z" },
  resolved_auto: { status: "resolved", resolution: "auto", resolved_at: "2026-11-03T13:00:00Z" }
};
const ACTIONS: OwnerAction[] = ["seen", "snooze", "dismiss", "resolve", "reopen"];
const SNOOZE_UNTIL = "2026-11-06T13:00:00.000Z";
const optsFor = (action: OwnerAction, version: string) => ({ expectedUpdatedAt: version, now: NOW, ...(action === "snooze" ? { snoozeUntil: SNOOZE_UNTIL } : {}) });

describe("applyOwnerAction: the C2 table, every cell (test 11)", () => {
  const cells = ACTIONS.flatMap((action) =>
    (Object.keys(STATES) as (keyof typeof STATES)[]).map((state) => {
      const effective: OwnerActionState = state === "snoozed_expired" ? "open" : state;
      return [action, state, OWNER_ACTION_TRANSITIONS[action][effective]] as const;
    })
  );

  it("is the contract's table", () => {
    expect(OWNER_ACTION_TRANSITIONS).toEqual({
      seen: { open: "write", seen: "noop", snoozed: "invalid", dismissed: "invalid", resolved_owner: "invalid", resolved_auto: "invalid" },
      snooze: { open: "write", seen: "write", snoozed: "write", dismissed: "invalid", resolved_owner: "invalid", resolved_auto: "invalid" },
      dismiss: { open: "write", seen: "write", snoozed: "write", dismissed: "noop", resolved_owner: "invalid", resolved_auto: "invalid" },
      resolve: { open: "write", seen: "write", snoozed: "write", dismissed: "write", resolved_owner: "noop", resolved_auto: "write" },
      reopen: { open: "noop", seen: "write", snoozed: "write", dismissed: "write", resolved_owner: "write", resolved_auto: "invalid" }
    });
  });

  it.each(cells)("%s on %s → %s", async (action, state, verdict) => {
    const before = seed(1, STATES[state]);
    const r = await applyOwnerAction(principal, id(1), action, optsFor(action, before.updated_at as string));
    const expected = verdict === "write" ? "applied" : verdict === "noop" ? "unchanged" : "invalid_transition";
    expect(r.outcome).toBe(expected);
    if (verdict === "write") {
      expect(updates()).toHaveLength(1);
      expect(stored(1).updated_at).toBe("2026-11-04T13:00:00+00:00");
      if (r.outcome === "applied") expect(r.row.version).toBe("2026-11-04T13:00:00+00:00");
    } else {
      expect(updates()).toEqual([]);
      expect(stored(1)).toEqual(before);
      if (r.outcome !== "not_found") expect(r.row.item.id).toBe(id(1));
    }
  });
});

describe("applyOwnerAction: the patches (test 12, K2)", () => {
  const PATCHES: Record<OwnerAction, Row> = {
    seen: { status: "seen", snooze_until: null, updated_at: NOW_ISO },
    snooze: { status: "snoozed", snooze_until: SNOOZE_UNTIL, updated_at: NOW_ISO },
    dismiss: { status: "dismissed", snooze_until: null, updated_at: NOW_ISO },
    resolve: { status: "resolved", resolution: "owner", resolved_at: NOW_ISO, snooze_until: null, updated_at: NOW_ISO },
    reopen: { status: "open", snooze_until: null, resolution: null, resolved_at: null, updated_at: NOW_ISO }
  };
  const FROM: Record<OwnerAction, keyof typeof STATES> = { seen: "open", snooze: "seen", dismiss: "snoozed", resolve: "resolved_auto", reopen: "resolved_owner" };

  it.each(ACTIONS)("%s writes exactly its columns, never last_seen_at", async (action) => {
    const before = seed(1, STATES[FROM[action]]);
    const r = await applyOwnerAction(principal, id(1), action, optsFor(action, before.updated_at as string));
    expect(r.outcome).toBe("applied");
    const [call] = updates();
    expect(call.patch).toEqual(PATCHES[action]);
    expect(Object.keys(call.patch ?? {})).not.toContain("last_seen_at");
    expect(stored(1).last_seen_at).toBe(before.last_seen_at);
    expect(ownerActionPatch(action, NOW_ISO, action === "snooze" ? SNOOZE_UNTIL : null)).toEqual(PATCHES[action]);
  });

  it("resolve marks the resolution as his (owner), an auto-resolved row included", async () => {
    seed(1, STATES.resolved_auto);
    await applyOwnerAction(principal, id(1), "resolve", optsFor("resolve", stored(1).updated_at as string));
    expect(stored(1)).toMatchObject({ status: "resolved", resolution: "owner", resolved_at: "2026-11-04T13:00:00+00:00" });
  });

  it("reopen clears the snooze, the resolution and resolved_at", async () => {
    seed(1, STATES.resolved_owner);
    await applyOwnerAction(principal, id(1), "reopen", optsFor("reopen", stored(1).updated_at as string));
    expect(stored(1)).toMatchObject({ status: "open", snooze_until: null, resolution: null, resolved_at: null });
    seed(2, { ...STATES.snoozed, fingerprint: "dd:x:2" });
    await applyOwnerAction(principal, id(2), "reopen", optsFor("reopen", stored(2).updated_at as string));
    expect(stored(2)).toMatchObject({ status: "open", snooze_until: null });
  });

  it("the update is fenced on principal, id, the exact version and the stored status, and returns the row", async () => {
    seed(1, STATES.snoozed_expired);
    const r = await applyOwnerAction(principal, id(1), "dismiss", optsFor("dismiss", "2026-11-02T10:00:00.123456+00:00"));
    expect(r.outcome).toBe("applied");
    const [call] = updates();
    expect(call.filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["eq", "id", id(1)],
      ["eq", "updated_at", "2026-11-02T10:00:00.123456+00:00"],
      // The stored status (snoozed), though the effective one was open.
      ["eq", "status", "snoozed"]
    ]);
    expect(call.columns).toContain("updated_at");
  });

  it("refuses bad input with NonRetryableError before reading", async () => {
    seed(1);
    const v = stored(1).updated_at as string;
    await expect(applyOwnerAction(principal, id(1), "archive" as OwnerAction, { expectedUpdatedAt: v, now: NOW })).rejects.toThrow(NonRetryableError);
    await expect(applyOwnerAction(principal, id(1), "seen", { expectedUpdatedAt: "yesterday", now: NOW })).rejects.toThrow(NonRetryableError);
    await expect(applyOwnerAction(principal, id(1), "snooze", { expectedUpdatedAt: v, now: NOW })).rejects.toThrow(NonRetryableError);
    // C4: more than 60 s ahead, at most 90 days ahead.
    await expect(applyOwnerAction(principal, id(1), "snooze", { expectedUpdatedAt: v, now: NOW, snoozeUntil: "2026-11-04T13:01:00.000Z" })).rejects.toThrow(NonRetryableError);
    await expect(applyOwnerAction(principal, id(1), "snooze", { expectedUpdatedAt: v, now: NOW, snoozeUntil: "2027-02-02T13:00:01.000Z" })).rejects.toThrow(NonRetryableError);
    await expect(applyOwnerAction(principal, id(1), "dismiss", { expectedUpdatedAt: v, now: NOW, snoozeUntil: SNOOZE_UNTIL })).rejects.toThrow(NonRetryableError);
    expect(db.calls).toEqual([]);
    // 90 days exactly is allowed; 61 s is too.
    expect((await applyOwnerAction(principal, id(1), "snooze", { expectedUpdatedAt: v, now: NOW, snoozeUntil: "2027-02-02T13:00:00.000Z" })).outcome).toBe("applied");
  });

  it("an unknown or malformed id is not_found", async () => {
    expect(await applyOwnerAction(principal, id(5), "seen", optsFor("seen", NOW_ISO))).toEqual({ outcome: "not_found" });
    db.calls.length = 0;
    expect(await applyOwnerAction(principal, "ea_bad", "seen", optsFor("seen", NOW_ISO))).toEqual({ outcome: "not_found" });
    expect(db.calls).toEqual([]);
  });
});

describe("applyOwnerAction: compare-and-set (test 13)", () => {
  it("a stale expectedUpdatedAt is a conflict, with the current row and no write", async () => {
    seed(1, { updated_at: "2026-11-02T10:00:00.123457Z" });
    const r = await applyOwnerAction(principal, id(1), "dismiss", optsFor("dismiss", "2026-11-02T10:00:00.123456+00:00"));
    expect(r.outcome).toBe("conflict");
    if (r.outcome === "conflict") expect(r.row.version).toBe("2026-11-02T10:00:00.123457+00:00");
    expect(updates()).toEqual([]);
    expect(stored(1).status).toBe("open");
  });

  it("the version is compared as the exact string PostgREST printed (the same instant written differently is a conflict)", async () => {
    seed(1, { updated_at: "2026-11-02T10:00:00Z" });
    const r = await applyOwnerAction(principal, id(1), "dismiss", optsFor("dismiss", "2026-11-02T10:00:00.000Z"));
    expect(r.outcome).toBe("conflict");
  });

  it("a change between the read and the update (0 rows) is a conflict with the re-read row", async () => {
    seed(1);
    db.before = (call) => {
      if (call.op === "update") db.rows = db.rows.map((r) => ({ ...r, title: "Changed by a sync", updated_at: "2026-11-04T12:59:59.999999+00:00" }));
    };
    const r = await applyOwnerAction(principal, id(1), "dismiss", optsFor("dismiss", "2026-11-02T10:00:00.123456+00:00"));
    expect(r.outcome).toBe("conflict");
    if (r.outcome === "conflict") {
      expect(r.row.version).toBe("2026-11-04T12:59:59.999999+00:00");
      expect(r.row.item.title).toBe("Changed by a sync");
    }
    expect(stored(1).status).toBe("open");
  });

  it("a row deleted meanwhile is not_found", async () => {
    seed(1);
    db.before = (call) => {
      if (call.op === "update") db.rows = [];
    };
    expect(await applyOwnerAction(principal, id(1), "dismiss", optsFor("dismiss", "2026-11-02T10:00:00.123456+00:00"))).toEqual({ outcome: "not_found" });
  });

  it("a database error throws", async () => {
    seed(1);
    db.fail = (call) => (call.op === "update" ? { message: "timeout" } : null);
    await expect(applyOwnerAction(principal, id(1), "seen", optsFor("seen", "2026-11-02T10:00:00.123456+00:00"))).rejects.toThrow("exec_attention_items update failed");
  });
});

// ---------------------------------------------------------------------------
// Test 14: interleaving with syncAttention
// ---------------------------------------------------------------------------

function candidate(over: Partial<AttentionCandidate> = {}): AttentionCandidate {
  return {
    fingerprint: "dd:overdue:assignee:u_1",
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: "Item 1",
    whatHappened: "Something is late.",
    whyItMatters: "It matters.",
    recommendedNext: null,
    facts: [],
    refs: [],
    priority: { score: 50, band: "normal", reasons: ["Overdue tasks (base 25)"] },
    stateHash: "abcdef0123456789",
    occurredAt: null,
    ...over
  };
}
const SCOPE = { source: "dd" as const, kinds: ["overdue_tasks"] };

describe("owner actions and syncAttention interleave safely (test 14)", () => {
  it("his dismiss lands after a sync read its rows: the sync's content update for that row is skipped", async () => {
    seed(1);
    let dismissed = false;
    db.before = (call) => {
      // His action commits between the sync's read and its content update.
      if (call.op === "update" && !dismissed) {
        dismissed = true;
        db.rows = db.rows.map((r) => (r.id === id(1) ? { ...r, ...ownerActionPatch("dismiss", "2026-11-04T12:59:00.500000+00:00", null), updated_at: "2026-11-04T12:59:00.500000+00:00" } : r));
      }
    };
    const result = await syncAttention(principal, SCOPE, [candidate({ title: "Item 1, now 4 tasks", stateHash: "abcdef0123456789" })], NOW);
    expect(result.updated).toBe(0);
    expect(stored(1)).toMatchObject({ status: "dismissed", title: "Item 1" });
  });

  it("a sync's content update after his read makes his action a 409 conflict", async () => {
    seed(1);
    const read = await getAttentionItemRow(principal, id(1));
    if (read === null) throw new Error("row not read");
    const later = new Date("2026-11-04T12:59:00.000Z");
    const synced = await syncAttention(principal, SCOPE, [candidate({ title: "Item 1, now 4 tasks", stateHash: "fedcba9876543210" })], later);
    expect(synced.updated).toBe(1);
    const r = await applyOwnerAction(principal, id(1), "dismiss", optsFor("dismiss", read.version));
    expect(r.outcome).toBe("conflict");
    if (r.outcome === "conflict") expect(r.row.item.title).toBe("Item 1, now 4 tasks");
    expect(stored(1).status).toBe("open");
  });

  it("a sync's unchanged pass (last_seen_at only) doesn't trip his compare-and-set", async () => {
    seed(1);
    const read = await getAttentionItemRow(principal, id(1));
    if (read === null) throw new Error("row not read");
    const synced = await syncAttention(principal, SCOPE, [candidate()], new Date("2026-11-04T12:55:00.000Z"));
    expect(synced.unchanged).toBe(1);
    expect((await applyOwnerAction(principal, id(1), "dismiss", optsFor("dismiss", read.version))).outcome).toBe("applied");
    // His write left the producer's stamp alone.
    expect(stored(1).last_seen_at).toBe("2026-11-04T12:55:00+00:00");
  });
});
