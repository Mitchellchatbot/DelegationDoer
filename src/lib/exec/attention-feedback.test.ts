import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/attention")>()),
  getAttentionItemIdentity: vi.fn()
}));

import { getAttentionItemIdentity } from "@/lib/exec/attention";
import { FEEDBACK_REASONS, feedbackTotals, isValidFeedback, purgeOldFeedback, recordAttentionFeedback } from "@/lib/exec/attention-feedback";
import type { FeedbackReason } from "@/lib/exec/attention-types";
import { principalFromRows } from "@/lib/exec/principal";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Needs Attention feedback (P5a contract §3.5, C10; tests 15, 16): one vote
// per item, the upsert's key set, the vote/reason pairing before the database,
// totals over 365 days and the purge, a missing table tolerated.

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
const NOW = new Date("2026-11-06T12:00:00.000Z");
const ITEM = `ea_${"a".repeat(32)}`;

interface Call {
  op: "select" | "upsert" | "delete";
  table: string;
  args: unknown[];
  chain: [string, ...unknown[]][];
}
interface Stored {
  id: number;
  principal_id: string;
  item_id: string;
  fingerprint: string;
  kind: string;
  vote: number;
  reason: string | null;
  created_at: string;
}
let calls: Call[];
let rows: Stored[];
let nextId: number;
let failWith: { message: string; code?: string } | null;

/** exec_attention_feedback in memory: the upsert on (principal_id, item_id), keyset reads by id, the dated delete. */
function fakeAdmin() {
  return {
    from(table: string) {
      const make = (op: Call["op"], args: unknown[]) => {
        const call: Call = { op, table, args, chain: [] };
        calls.push(call);
        const b: Record<string, unknown> = {};
        for (const m of ["eq", "gte", "gt", "lt", "order", "limit", "abortSignal"]) b[m] = (...a: unknown[]) => (call.chain.push([m, ...a]), b);
        b.then = <A, B>(ok?: (v: unknown) => A, bad?: (e: unknown) => B) => Promise.resolve().then(() => run(call)).then(ok, bad);
        return b;
      };
      return {
        select: (cols: string) => make("select", [cols]),
        upsert: (row: unknown, opts: unknown) => make("upsert", [row, opts]),
        delete: (opts: unknown) => make("delete", [opts])
      };
    }
  };
}

function run(call: Call): { data?: unknown; error: { message: string; code?: string } | null; count?: number | null } {
  if (failWith) return { data: null, error: failWith };
  const arg = (m: string) => call.chain.find((c) => c[0] === m);
  if (call.op === "upsert") {
    const row = call.args[0] as Omit<Stored, "id">;
    const at = rows.findIndex((r) => r.principal_id === row.principal_id && r.item_id === row.item_id);
    if (at >= 0) rows[at] = { ...rows[at], ...row };
    else rows.push({ id: nextId++, ...row });
    return { error: null };
  }
  if (call.op === "delete") {
    const cutoff = Date.parse(arg("lt")?.[2] as string);
    const before = rows.length;
    rows = rows.filter((r) => !(Date.parse(r.created_at) < cutoff));
    return { error: null, count: before - rows.length };
  }
  const principalId = arg("eq")?.[2];
  const since = Date.parse(arg("gte")?.[2] as string);
  const after = (arg("gt")?.[2] as number | undefined) ?? 0;
  const limit = arg("limit")?.[1] as number;
  const data = rows
    .filter((r) => r.principal_id === principalId && Date.parse(r.created_at) >= since && r.id > after)
    .sort((a, b) => a.id - b.id)
    .slice(0, limit)
    .map((r) => ({ id: r.id, kind: r.kind, vote: r.vote, reason: r.reason }));
  return { data, error: null };
}

beforeEach(() => {
  calls = [];
  rows = [];
  nextId = 1;
  failWith = null;
  vi.mocked(getSupabaseAdmin).mockReturnValue(fakeAdmin() as unknown as SupabaseClient);
  vi.mocked(getAttentionItemIdentity).mockResolvedValue({ id: ITEM, fingerprint: "dd:overdue:assignee:u_1", source: "dd", kind: "overdue_tasks" });
});

describe("recordAttentionFeedback (C10, test 15)", () => {
  it("reads the item's identity, then upserts one row with the same key set every time", async () => {
    expect(await recordAttentionFeedback(principal, ITEM, { vote: 1, reason: "useful" }, { now: NOW })).toEqual({ outcome: "recorded", itemId: ITEM, vote: 1, reason: "useful" });
    expect(getAttentionItemIdentity).toHaveBeenCalledWith(principal, ITEM, { signal: undefined });
    expect(await recordAttentionFeedback(principal, ITEM, { vote: -1, reason: null }, { now: new Date("2026-11-06T13:00:00.000Z") })).toMatchObject({ outcome: "recorded", vote: -1, reason: null });
    const upserts = calls.filter((c) => c.op === "upsert");
    expect(upserts).toHaveLength(2);
    for (const u of upserts) {
      expect(u.table).toBe("exec_attention_feedback");
      expect(Object.keys(u.args[0] as object).sort()).toEqual(["created_at", "fingerprint", "item_id", "kind", "principal_id", "reason", "vote"]);
      expect(u.args[1]).toEqual({ onConflict: "principal_id,item_id" });
    }
    expect(upserts[0].args[0]).toEqual({
      principal_id: "ep_1",
      item_id: ITEM,
      fingerprint: "dd:overdue:assignee:u_1",
      kind: "overdue_tasks",
      vote: 1,
      reason: "useful",
      created_at: "2026-11-06T12:00:00.000Z"
    });
  });

  it("a re-vote replaces the vote, the reason and created_at (one row per item)", async () => {
    await recordAttentionFeedback(principal, ITEM, { vote: 1, reason: "useful" }, { now: NOW });
    await recordAttentionFeedback(principal, ITEM, { vote: -1, reason: "wrong_priority" }, { now: new Date("2026-11-07T12:00:00.000Z") });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vote: -1, reason: "wrong_priority", created_at: "2026-11-07T12:00:00.000Z" });
  });

  it("a missing item, or a malformed id, is not_found and writes nothing", async () => {
    vi.mocked(getAttentionItemIdentity).mockResolvedValue(null);
    expect(await recordAttentionFeedback(principal, ITEM, { vote: 1, reason: null }, { now: NOW })).toEqual({ outcome: "not_found" });
    vi.mocked(getAttentionItemIdentity).mockClear();
    expect(await recordAttentionFeedback(principal, "ea_bad", { vote: 1, reason: null }, { now: NOW })).toEqual({ outcome: "not_found" });
    expect(getAttentionItemIdentity).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("enforces the vote/reason pairing before the database (M18)", async () => {
    const bad: [number, FeedbackReason | null | string][] = [
      [-1, "useful"],
      [1, "not_relevant"],
      [1, "wrong_facts"],
      [0, null],
      [2, null],
      [-1, "spam"]
    ];
    for (const [vote, reason] of bad) {
      await expect(recordAttentionFeedback(principal, ITEM, { vote, reason } as never, { now: NOW })).rejects.toThrow(NonRetryableError);
    }
    expect(getAttentionItemIdentity).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    for (const reason of FEEDBACK_REASONS) {
      expect(isValidFeedback(reason === "useful" ? 1 : -1, reason)).toBe(true);
      expect(isValidFeedback(reason === "useful" ? -1 : 1, reason)).toBe(false);
    }
    expect(isValidFeedback(1, null) && isValidFeedback(-1, null)).toBe(true);
  });

  it("throws on a write error, with the code and never the row", async () => {
    failWith = { message: "new row violates ... (dd:overdue:assignee:u_1)", code: "23514" };
    await expect(recordAttentionFeedback(principal, ITEM, { vote: 1, reason: null }, { now: NOW })).rejects.toThrow("exec_attention_feedback write failed: 23514");
  });
});

describe("feedbackTotals (test 16)", () => {
  const add = (kind: string, vote: number, reason: string | null, created_at: string, principal_id = "ep_1") =>
    rows.push({ id: nextId++, principal_id, item_id: `ea_${String(nextId).padStart(32, "0")}`, fingerprint: "dd:x", kind, vote, reason, created_at });

  it("counts by kind and by reason over the last 365 days, his rows only", async () => {
    add("overdue_tasks", 1, "useful", "2026-11-05T00:00:00Z");
    add("overdue_tasks", -1, "wrong_priority", "2026-10-05T00:00:00Z");
    add("stalled_tasks", -1, "not_relevant", "2026-06-05T00:00:00Z");
    add("stalled_tasks", -1, "not_relevant", "2026-06-06T00:00:00Z");
    add("stalled_tasks", 1, null, "2026-06-07T00:00:00Z");
    add("important_email", -1, null, "2026-01-01T00:00:00Z");
    add("overdue_tasks", 1, "useful", "2025-11-05T00:00:00Z"); // older than 365 days
    add("overdue_tasks", 1, "useful", "2026-11-05T00:00:00Z", "ep_other");
    expect(await feedbackTotals(principal, NOW)).toEqual({
      sinceIso: "2025-11-06T12:00:00.000Z",
      up: 2,
      down: 4,
      byKind: [
        { kind: "stalled_tasks", up: 1, down: 2 },
        { kind: "overdue_tasks", up: 1, down: 1 },
        { kind: "important_email", up: 0, down: 1 }
      ],
      byReason: [
        { reason: "useful", count: 1 },
        { reason: "not_relevant", count: 2 },
        { reason: "wrong_priority", count: 1 }
      ]
    });
    const [read] = calls;
    expect(read.args).toEqual(["id,kind,vote,reason"]);
    expect(read.chain).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["gte", "created_at", "2025-11-06T12:00:00.000Z"],
      ["order", "id", { ascending: true }],
      ["limit", 1000]
    ]);
  });

  it("pages past 1000 rows by id", async () => {
    for (let i = 0; i < 1500; i++) add("overdue_tasks", i % 3 === 0 ? 1 : -1, null, "2026-11-01T00:00:00Z");
    const totals = await feedbackTotals(principal, NOW);
    expect(totals?.up).toBe(500);
    expect(totals?.down).toBe(1000);
    expect(calls).toHaveLength(2);
    expect(calls[1].chain).toContainEqual(["gt", "id", 1000]);
  });

  it("no feedback yet: zeros and empty lists", async () => {
    expect(await feedbackTotals(principal, NOW)).toEqual({ sinceIso: "2025-11-06T12:00:00.000Z", up: 0, down: 0, byKind: [], byReason: [] });
  });

  it("a missing table is null; any other error throws", async () => {
    failWith = { message: 'relation "public.exec_attention_feedback" does not exist', code: "42P01" };
    expect(await feedbackTotals(principal, NOW)).toBeNull();
    failWith = { message: "Could not find the table 'public.exec_attention_feedback' in the schema cache", code: "PGRST205" };
    expect(await feedbackTotals(principal, NOW)).toBeNull();
    failWith = { message: "timeout", code: "57014" };
    await expect(feedbackTotals(principal, NOW)).rejects.toThrow("exec_attention_feedback read failed");
  });

  it("a malformed row fails the read", async () => {
    rows.push({ id: 1, principal_id: "ep_1", item_id: ITEM, fingerprint: "dd:x", kind: "x", vote: -1, reason: "useful", created_at: "2026-11-01T00:00:00Z" });
    await expect(feedbackTotals(principal, NOW)).rejects.toThrow("malformed row");
  });
});

describe("purgeOldFeedback (§2.6)", () => {
  it("deletes every principal's rows older than 365 days and counts them", async () => {
    rows.push(
      { id: 1, principal_id: "ep_1", item_id: ITEM, fingerprint: "dd:x", kind: "x", vote: 1, reason: null, created_at: "2025-11-01T00:00:00Z" },
      { id: 2, principal_id: "ep_2", item_id: ITEM, fingerprint: "dd:x", kind: "x", vote: 1, reason: null, created_at: "2025-11-06T11:59:59Z" },
      { id: 3, principal_id: "ep_1", item_id: ITEM, fingerprint: "dd:x", kind: "x", vote: 1, reason: null, created_at: "2025-11-06T12:00:00Z" }
    );
    expect(await purgeOldFeedback(NOW)).toBe(2);
    expect(rows.map((r) => r.id)).toEqual([3]);
    expect(calls[0].args).toEqual([{ count: "exact" }]);
    expect(calls[0].chain).toEqual([["lt", "created_at", "2025-11-06T12:00:00.000Z"]]);
  });

  it("a missing table is 0; any other error throws", async () => {
    failWith = { message: "missing", code: "42P01" };
    expect(await purgeOldFeedback(NOW)).toBe(0);
    failWith = { message: "timeout", code: "57014" };
    await expect(purgeOldFeedback(NOW)).rejects.toThrow("exec_attention_feedback purge failed");
  });
});
