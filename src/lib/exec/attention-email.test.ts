import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { createFakeEmailDb, type FakeEmailDb, type Row } from "@/lib/exec/__tests__/fake-email-db";
import {
  deleteAttentionItemsByIds,
  deleteEmailAttentionForThreads,
  emailClientFingerprint,
  emailCommitmentFingerprint,
  emailThreadFingerprint,
  listAllEmailAttentionRows,
  listAttentionForThread,
  listEmailAttentionRows,
  parseEmailFingerprint
} from "@/lib/exec/attention";
import { principalFromRows } from "@/lib/exec/principal";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";

// P3's additions to attention.ts: the email fingerprints (L4) and their
// parser, the identity listing, hard deletes, and the per-thread read. A
// restricted thread must leave no item behind in any status (L2), so the
// deletes are checked across every status and against everything they must
// not touch: other threads, the client-level email items, DD items and
// another principal's rows.

function mint(id: string, userId: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: userId, enabled: true, mail_account_ids: ["acct-1"], slack_team_id: null, slack_user_id: null },
    { id: userId, email: `${userId}@scaledai.org`, name: userId, work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const principal = mint("ep_1", "u_mitchell");
const other = mint("ep_2", "u_other");

const T0 = "2026-11-01T12:00:00+00:00";
const NOW = new Date("2026-11-04T13:00:00.000Z");
const TH_A = "4f1c2d3e-aaaa-bbbb-cccc-000000000001";
const TH_B = "4f1c2d3e-aaaa-bbbb-cccc-000000000002";
const MSG_1 = "9a8b7c6d-0000-0000-0000-000000000001";
const MSG_2 = "9a8b7c6d-0000-0000-0000-000000000002";

let seq = 0;
const nextId = () => `ea_${(++seq).toString(16).padStart(32, "0")}`;

function itemRow(fingerprint: string, over: Partial<Row> = {}): Row {
  const source = fingerprint.split(":")[0];
  return {
    id: nextId(),
    principal_id: principal.id,
    fingerprint,
    source,
    kind: source === "dd" ? "overdue_tasks" : "important_email",
    category: "my_action",
    priority_score: 40,
    priority_band: "normal",
    priority_reasons: ["Important email (base 30)"],
    title: "Reply needed: Q3 renewal",
    what_happened: "An email came in 2 days ago, and it hasn't been answered.",
    why_it_matters: "AI-assessed as needing your reply.",
    recommended_next: null,
    facts: [],
    refs: [],
    state_hash: "0123456789abcdef",
    occurred_at: null,
    status: "open",
    snooze_until: null,
    resolution: null,
    first_seen_at: T0,
    last_seen_at: T0,
    resolved_at: null,
    updated_at: T0,
    ...over
  };
}

const resolved = { status: "resolved", resolution: "auto", resolved_at: T0 };

let db: FakeEmailDb;

function useDb(rows: Row[], cfg: Parameters<typeof createFakeEmailDb>[0] = {}): void {
  db = createFakeEmailDb({ ...cfg, tables: { exec_attention_items: rows } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
}

const stored = () => (db.tables.exec_attention_items ?? []).map((r) => r.fingerprint as string).sort();

beforeEach(() => {
  seq = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

describe("parseEmailFingerprint", () => {
  it.each([
    [`email:thread:${TH_A}:${MSG_1}`, { kind: "thread", threadId: TH_A, key: MSG_1 }],
    [`email:commitment:${TH_A}:ec_00ff`, { kind: "commitment", threadId: TH_A, key: "ec_00ff" }],
    ["email:satisfaction:cl_villa", { kind: "satisfaction", threadId: null, key: "cl_villa" }],
    ["email:health:cl_villa", { kind: "health", threadId: null, key: "cl_villa" }],
    // A thread id may hold ":"; the anchor never does, so the last ":" splits.
    ["email:thread:a:b:c", { kind: "thread", threadId: "a:b", key: "c" }]
  ])("%s", (fp, parsed) => {
    expect(parseEmailFingerprint(fp)).toEqual(parsed);
  });

  it.each([
    "dd:overdue:assignee:u_1",
    "slack:x:y",
    "email:thread:",
    `email:thread:${TH_A}`,
    `email:thread:${TH_A}:`,
    `email:thread::${MSG_1}`,
    "email:commitment:only",
    "email:satisfaction:",
    "email:satisfaction:a:b",
    "email:health:",
    "email:other:x",
    "email:",
    "",
    "EMAIL:thread:a:b"
  ])("%j is not an email item fingerprint", (fp) => {
    expect(parseEmailFingerprint(fp)).toBeNull();
  });

  it("is null for a non-string", () => {
    expect(parseEmailFingerprint(undefined as unknown as string)).toBeNull();
    expect(parseEmailFingerprint(42 as unknown as string)).toBeNull();
  });
});

describe("the fingerprint builders", () => {
  it("build what the parser reads back", () => {
    const thread = emailThreadFingerprint(TH_A, MSG_1);
    expect(thread).toBe(`email:thread:${TH_A}:${MSG_1}`);
    expect(parseEmailFingerprint(thread as string)).toEqual({ kind: "thread", threadId: TH_A, key: MSG_1 });
    const commitment = emailCommitmentFingerprint("x:y", "ec_1");
    expect(parseEmailFingerprint(commitment as string)).toEqual({ kind: "commitment", threadId: "x:y", key: "ec_1" });
    expect(parseEmailFingerprint(emailClientFingerprint("satisfaction", "cl_1") as string)).toEqual({ kind: "satisfaction", threadId: null, key: "cl_1" });
    expect(parseEmailFingerprint(emailClientFingerprint("health", "cl_1") as string)).toEqual({ kind: "health", threadId: null, key: "cl_1" });
  });

  it.each([
    ["an empty thread id", "", MSG_1],
    ["an empty anchor", TH_A, ""],
    ["an anchor with a colon", TH_A, "a:b"],
    ["whitespace", "a b", MSG_1],
    ["a quote", 'a"b', MSG_1],
    ["a comma", "a,b", MSG_1],
    ["parentheses", "a(b)", MSG_1],
    ["a backslash", "a\\b", MSG_1],
    ["a control character", "a\u0001b", MSG_1],
    ["a bidi override", "a‮b", MSG_1],
    ["an over-long id", "x".repeat(290), MSG_1]
  ])("refuse %s (the item is not made)", (_name, threadId, anchor) => {
    expect(emailThreadFingerprint(threadId, anchor)).toBeNull();
    expect(emailCommitmentFingerprint(threadId, anchor)).toBeNull();
  });

  it("refuse a client id the parser couldn't read back", () => {
    expect(emailClientFingerprint("satisfaction", "a:b")).toBeNull();
    expect(emailClientFingerprint("health", "")).toBeNull();
    expect(emailClientFingerprint("health", "a b")).toBeNull();
    expect(emailClientFingerprint("other" as "health", "cl_1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Listing and deleting
// ---------------------------------------------------------------------------

describe("listEmailAttentionRows", () => {
  it("lists this principal's email items in every status, by id, a keyset page at a time", async () => {
    useDb([
      itemRow(`email:thread:${TH_A}:${MSG_1}`),
      itemRow(`email:thread:${TH_B}:${MSG_2}`, resolved),
      itemRow("dd:overdue:assignee:u_1"),
      itemRow(`email:commitment:${TH_A}:ec_1`, { status: "dismissed" }),
      itemRow(`email:thread:${TH_A}:${MSG_1}`, { principal_id: other.id }),
      itemRow("email:health:cl_1", { status: "seen" })
    ]);
    const first = await listEmailAttentionRows(principal, { afterId: null, limit: 2 });
    expect(first.map((r) => [r.fingerprint, r.status])).toEqual([
      [`email:thread:${TH_A}:${MSG_1}`, "open"],
      [`email:thread:${TH_B}:${MSG_2}`, "resolved"]
    ]);
    const second = await listEmailAttentionRows(principal, { afterId: first[1].id, limit: 2 });
    expect(second.map((r) => r.fingerprint)).toEqual([`email:commitment:${TH_A}:ec_1`, "email:health:cl_1"]);
    expect(await listEmailAttentionRows(principal, { afterId: second[1].id, limit: 2 })).toEqual([]);
    const q = db.requests.find((r) => r.kind === "select");
    expect(q?.columns).toBe("id,fingerprint,kind,status");
  });

  it("refuses a bad limit or cursor before reading", async () => {
    useDb([]);
    await expect(listEmailAttentionRows(principal, { afterId: null, limit: 0 })).rejects.toThrow(NonRetryableError);
    await expect(listEmailAttentionRows(principal, { afterId: null, limit: 1001 })).rejects.toThrow(NonRetryableError);
    await expect(listEmailAttentionRows(principal, { afterId: "a b", limit: 10 })).rejects.toThrow(NonRetryableError);
    expect(db.requests).toHaveLength(0);
  });

  it("throws on a failed read (never an empty list)", async () => {
    useDb([itemRow(`email:thread:${TH_A}:${MSG_1}`)], { fail: () => ({ message: "statement timeout" }) });
    await expect(listEmailAttentionRows(principal, { afterId: null, limit: 10 })).rejects.toThrow(/statement timeout/);
  });

  it("listAllEmailAttentionRows walks every page", async () => {
    useDb(Array.from({ length: 1_005 }, (_, i) => itemRow(`email:thread:t${i}:${MSG_1}`)));
    const all = await listAllEmailAttentionRows(principal);
    expect(all).toHaveLength(1_005);
    expect(db.requests.filter((r) => r.kind === "select")).toHaveLength(2);
  });
});

describe("deleteAttentionItemsByIds", () => {
  it("deletes only this principal's rows, limited to the source given", async () => {
    const mine = itemRow(`email:thread:${TH_A}:${MSG_1}`);
    const dd = itemRow("dd:overdue:assignee:u_1");
    const theirs = itemRow(`email:thread:${TH_A}:${MSG_1}`, { principal_id: other.id });
    useDb([mine, dd, theirs]);
    expect(await deleteAttentionItemsByIds(principal, [mine.id as string, dd.id as string, theirs.id as string], { source: "email" })).toBe(1);
    expect(db.tables.exec_attention_items.map((r) => r.id)).toEqual([dd.id, theirs.id]);
  });

  it("does nothing for no ids, and refuses a malformed one", async () => {
    useDb([]);
    expect(await deleteAttentionItemsByIds(principal, [])).toBe(0);
    expect(db.requests).toHaveLength(0);
    await expect(deleteAttentionItemsByIds(principal, ["ok", "bad id"])).rejects.toThrow(NonRetryableError);
    await expect(deleteAttentionItemsByIds(principal, ["ok"], { source: "mail" as "email" })).rejects.toThrow(NonRetryableError);
    expect(db.requests).toHaveLength(0);
  });

  it("chunks long id lists", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => itemRow(`email:thread:t${i}:${MSG_1}`));
    useDb(rows);
    expect(await deleteAttentionItemsByIds(principal, rows.map((r) => r.id as string), { source: "email" })).toBe(450);
    expect(db.requests.filter((r) => r.kind === "delete").length).toBeGreaterThanOrEqual(3);
  });

  it("throws on a failed delete", async () => {
    const row = itemRow(`email:thread:${TH_A}:${MSG_1}`);
    useDb([row], { fail: (r) => (r.kind === "delete" ? { message: "deadlock detected" } : null) });
    await expect(deleteAttentionItemsByIds(principal, [row.id as string])).rejects.toThrow(/deadlock/);
  });
});

describe("deleteEmailAttentionForThreads", () => {
  it("hard-deletes every item of the threads, in every status, and nothing else", async () => {
    useDb([
      itemRow(`email:thread:${TH_A}:${MSG_1}`),
      itemRow(`email:thread:${TH_A}:${MSG_2}`, resolved),
      itemRow(`email:commitment:${TH_A}:ec_1`, { status: "dismissed" }),
      itemRow(`email:commitment:${TH_A}:ec_2`, { status: "snoozed", snooze_until: "2026-11-09T00:00:00+00:00" }),
      itemRow(`email:thread:${TH_A}:${MSG_1}`.replace(TH_A, `${TH_A}x`)),
      itemRow(`email:thread:${TH_B}:${MSG_1}`, { status: "seen" }),
      itemRow("email:satisfaction:cl_1"),
      itemRow("email:health:cl_1"),
      itemRow("dd:overdue:assignee:u_1"),
      itemRow(`email:thread:${TH_A}:${MSG_1}`, { principal_id: other.id })
    ]);
    expect(await deleteEmailAttentionForThreads(principal, [TH_A])).toBe(4);
    expect(stored()).toEqual(
      [
        `email:thread:${TH_A}x:${MSG_1}`,
        `email:thread:${TH_B}:${MSG_1}`,
        "email:satisfaction:cl_1",
        "email:health:cl_1",
        "dd:overdue:assignee:u_1",
        `email:thread:${TH_A}:${MSG_1}`
      ].sort()
    );
    // The other principal's row with the same fingerprint is still there.
    expect(db.tables.exec_attention_items.filter((r) => r.fingerprint === `email:thread:${TH_A}:${MSG_1}`)).toEqual([
      expect.objectContaining({ principal_id: other.id })
    ]);
  });

  it("takes several threads at once, across pages", async () => {
    const rows = Array.from({ length: 1_200 }, (_, i) => itemRow(`email:thread:t${i % 3}:m${i}`));
    useDb(rows);
    expect(await deleteEmailAttentionForThreads(principal, ["t0", "t2"])).toBe(800);
    expect(db.tables.exec_attention_items.every((r) => String(r.fingerprint).startsWith("email:thread:t1:"))).toBe(true);
  });

  it("reads nothing for no threads", async () => {
    useDb([itemRow(`email:thread:${TH_A}:${MSG_1}`)]);
    expect(await deleteEmailAttentionForThreads(principal, [])).toBe(0);
    expect(await deleteEmailAttentionForThreads(principal, ["", null as unknown as string])).toBe(0);
    expect(db.requests).toHaveLength(0);
  });

  it("throws when the read or the delete fails, so a tombstone procedure retries", async () => {
    useDb([itemRow(`email:thread:${TH_A}:${MSG_1}`)], { fail: (r) => (r.kind === "select" ? { message: "connection reset" } : null) });
    await expect(deleteEmailAttentionForThreads(principal, [TH_A])).rejects.toThrow(/connection reset/);
    useDb([itemRow(`email:thread:${TH_A}:${MSG_1}`)], { fail: (r) => (r.kind === "delete" ? { message: "lock timeout" } : null) });
    await expect(deleteEmailAttentionForThreads(principal, [TH_A])).rejects.toThrow(/lock timeout/);
    expect(db.tables.exec_attention_items).toHaveLength(1);
  });

  it("matches the store's own call shape (principal, [threadId], { signal })", async () => {
    useDb([itemRow(`email:thread:${TH_A}:${MSG_1}`)]);
    const signal = new AbortController().signal;
    await expect(deleteEmailAttentionForThreads(principal, [TH_A], { signal })).resolves.toBe(1);
    expect(db.requests.every((r) => r.signal === signal)).toBe(true);
  });
});

describe("listAttentionForThread", () => {
  it("finds the thread's own items, put away or not, highest priority first", async () => {
    useDb([
      itemRow(`email:thread:${TH_A}:${MSG_1}`, { priority_score: 50, priority_band: "high" }),
      itemRow(`email:commitment:${TH_A}:ec_1`, { kind: "overdue_commitment", priority_score: 60, priority_band: "high", status: "dismissed" }),
      itemRow(`email:thread:${TH_A}:${MSG_2}`, resolved),
      itemRow(`email:commitment:${TH_A}:ec_2`, { kind: "overdue_commitment", status: "snoozed", snooze_until: "2026-11-01T00:00:00+00:00" }),
      itemRow(`email:thread:${TH_B}:${MSG_1}`),
      itemRow(`email:thread:${TH_A}:${MSG_1}`, { principal_id: other.id })
    ]);
    const items = await listAttentionForThread(principal, TH_A, { now: NOW });
    expect(items.map((i) => [i.fingerprint, i.status])).toEqual([
      [`email:commitment:${TH_A}:ec_1`, "dismissed"],
      [`email:thread:${TH_A}:${MSG_1}`, "open"],
      // A snooze that ran out reads as open.
      [`email:commitment:${TH_A}:ec_2`, "open"]
    ]);
    expect(items.every((i) => i.principalId === principal.id)).toBe(true);
  });

  it("narrows to the statuses asked for", async () => {
    useDb([
      itemRow(`email:thread:${TH_A}:${MSG_1}`, { status: "seen" }),
      itemRow(`email:thread:${TH_A}:${MSG_2}`, resolved)
    ]);
    expect((await listAttentionForThread(principal, TH_A, { now: NOW, statuses: ["resolved"] })).map((i) => i.fingerprint)).toEqual([
      `email:thread:${TH_A}:${MSG_2}`
    ]);
    await expect(listAttentionForThread(principal, TH_A, { statuses: [] })).rejects.toThrow(NonRetryableError);
    await expect(listAttentionForThread(principal, TH_A, { statuses: ["gone" as "open"] })).rejects.toThrow(NonRetryableError);
  });

  it("is empty for a thread with no items, and refuses an empty id", async () => {
    useDb([itemRow(`email:thread:${TH_B}:${MSG_1}`)]);
    expect(await listAttentionForThread(principal, TH_A, { now: NOW })).toEqual([]);
    await expect(listAttentionForThread(principal, "")).rejects.toThrow(NonRetryableError);
  });

  it("fails closed on a malformed stored row and on a failed read", async () => {
    useDb([itemRow(`email:thread:${TH_A}:${MSG_1}`, { category: "bogus" })]);
    await expect(listAttentionForThread(principal, TH_A, { now: NOW })).rejects.toThrow(/read failed/);
    useDb([itemRow(`email:thread:${TH_A}:${MSG_1}`)], { fail: () => ({ message: "boom" }) });
    await expect(listAttentionForThread(principal, TH_A, { now: NOW })).rejects.toThrow(/boom/);
  });
});
