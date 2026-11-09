import { describe, expect, it } from "vitest";

import { createFakeAttentionDb, unquoteTermValue, type FakeResult, type Row } from "@/lib/exec/__tests__/fake-attention-db";

// Self-tests for the a-build-11 additions to the fake exec_attention_items
// (P5a test 21a): .gte(), quoted logic-term values, numeric comparison of
// number columns, microsecond timestamps in filters, logic terms and ORDER BY,
// and update(...).select(). P2b's and P3's users of the fake (attention.test.ts,
// attention-email.test.ts) still pass against it.

type Q = {
  eq(c: string, v: unknown): Q;
  neq(c: string, v: unknown): Q;
  lt(c: string, v: unknown): Q;
  lte(c: string, v: unknown): Q;
  gt(c: string, v: unknown): Q;
  gte(c: string, v: unknown): Q;
  in(c: string, v: unknown[]): Q;
  or(expr: string): Q;
  order(c: string, o?: { ascending?: boolean }): Q;
  limit(n: number): Q;
  select(cols: string): Q;
} & PromiseLike<FakeResult>;
type Client = { from(t: string): { select(c: string): Q; update(p: Row, o?: Record<string, unknown>): Q } };

function setup() {
  const db = createFakeAttentionDb({ now: () => "2026-11-04T09:00:00Z" });
  const client = db.client as Client;
  const seed = (id: number, over: Row = {}) =>
    db.seed({
      id: `ea_${String(id).padStart(32, "0")}`,
      principal_id: "ep_1",
      fingerprint: `dd:x:${id}`,
      source: "dd",
      kind: "overdue_tasks",
      category: "delegated",
      priority_band: "normal",
      title: `T${id}`,
      state_hash: "h",
      ...over
    });
  const ids = async (q: PromiseLike<FakeResult>) => {
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return (r.data as Row[]).map((row) => row.id);
  };
  return { db, client, seed, ids };
}

const id = (n: number) => `ea_${String(n).padStart(32, "0")}`;

describe("fake-attention-db (a-build-11 self-tests, test 21a)", () => {
  it(".gte filters rows, timestamps compared as instants", async () => {
    const { client, seed, ids } = setup();
    seed(1, { first_seen_at: "2026-11-04T10:00:00.000001+00:00" });
    seed(2, { first_seen_at: "2026-11-04T10:00:00Z" });
    seed(3, { first_seen_at: "2026-11-04T09:59:59.999999Z" });
    expect(await ids(client.from("exec_attention_items").select("id").gte("first_seen_at", "2026-11-04T10:00:00.000Z").order("id"))).toEqual([id(1), id(2)]);
    expect(await ids(client.from("exec_attention_items").select("id").gte("priority_score", 0).order("id"))).toEqual([id(1), id(2), id(3)]);
  });

  it("a quoted logic-term value matches as the bare instant (and escapes are read)", async () => {
    const { client, seed, ids } = setup();
    seed(1, { first_seen_at: "2026-11-04T10:00:00.123456+00:00" });
    seed(2, { first_seen_at: "2026-11-04T10:00:00.123455+00:00" });
    const q = (expr: string) => ids(client.from("exec_attention_items").select("id").or(expr).order("id"));
    expect(await q(`first_seen_at.lt."2026-11-04T10:00:00.123456+00:00"`)).toEqual([id(2)]);
    expect(await q(`first_seen_at.eq."2026-11-04T10:00:00.123456+00:00"`)).toEqual([id(1)]);
    expect(await q(`and(first_seen_at.lte."2026-11-04T10:00:00.123456Z",priority_score.eq.0)`)).toEqual([id(1), id(2)]);
    expect(unquoteTermValue(`"a\\"b\\\\c"`)).toBe(`a"b\\c`);
    expect(unquoteTermValue("plain")).toBe("plain");
    expect(() => unquoteTermValue(`"open`)).toThrow();
  });

  it("priority_score.lt.55 compares numbers: 100 is not below 55", async () => {
    const { client, seed, ids } = setup();
    seed(1, { priority_score: 100 });
    seed(2, { priority_score: 55 });
    seed(3, { priority_score: 9 });
    const q = (expr: string) => ids(client.from("exec_attention_items").select("id").or(expr).order("id"));
    expect(await q("priority_score.lt.55")).toEqual([id(3)]);
    expect(await q("priority_score.gt.55")).toEqual([id(1)]);
    expect(await q("priority_score.eq.55")).toEqual([id(2)]);
    expect(await ids(client.from("exec_attention_items").select("id").lt("priority_score", 55).order("id"))).toEqual([id(3)]);
    // ORDER BY a number column is numeric too.
    expect(await ids(client.from("exec_attention_items").select("id").order("priority_score", { ascending: false }))).toEqual([id(1), id(2), id(3)]);
  });

  it("microseconds 123456 and 123457 compare as different and in order, in filters and ORDER BY", async () => {
    const { client, seed, ids } = setup();
    seed(1, { first_seen_at: "2026-11-04T10:00:00.123456+00:00" });
    seed(2, { first_seen_at: "2026-11-04T10:00:00.123457+00:00" });
    expect(await ids(client.from("exec_attention_items").select("id").order("first_seen_at", { ascending: false }))).toEqual([id(2), id(1)]);
    expect(await ids(client.from("exec_attention_items").select("id").order("first_seen_at"))).toEqual([id(1), id(2)]);
    expect(await ids(client.from("exec_attention_items").select("id").gt("first_seen_at", "2026-11-04T10:00:00.123456Z"))).toEqual([id(2)]);
    expect(await ids(client.from("exec_attention_items").select("id").eq("first_seen_at", "2026-11-04T10:00:00.123457Z"))).toEqual([id(2)]);
    expect(await ids(client.from("exec_attention_items").select("id").or(`first_seen_at.gt."2026-11-04T10:00:00.123456+00:00"`))).toEqual([id(2)]);
  });

  it("reads timestamps back as PostgREST prints them, microseconds kept", async () => {
    const { db, seed } = setup();
    seed(1, { first_seen_at: "2026-11-04T10:00:00.123456Z", updated_at: "2026-11-04T10:00:00Z" });
    expect(db.read()[0]).toMatchObject({ first_seen_at: "2026-11-04T10:00:00.123456+00:00", updated_at: "2026-11-04T10:00:00+00:00" });
  });

  it("update(...).select(cols) returns the changed rows, and only them", async () => {
    const { client, seed } = setup();
    seed(1);
    seed(2);
    const r = await client.from("exec_attention_items").update({ status: "seen", updated_at: "2026-11-04T11:00:00Z" }).eq("id", id(1)).select("id,status,updated_at");
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ id: id(1), status: "seen", updated_at: "2026-11-04T11:00:00+00:00" }]);
    const none = await client.from("exec_attention_items").update({ status: "seen" }).eq("id", "ea_nope").select("id");
    expect(none.data).toEqual([]);
    // Without .select(), as P2b's writes call it, the data stays null.
    const bare = await client.from("exec_attention_items").update({ status: "open" }, { count: "exact" }).eq("id", id(1));
    expect(bare).toMatchObject({ data: null, count: 1 });
  });

  it("keeps refusing what Postgres would: a write that breaks a CHECK changes nothing", async () => {
    const { db, client, seed } = setup();
    seed(1);
    const r = await client.from("exec_attention_items").update({ status: "snoozed" }).eq("id", id(1)).select("id");
    expect(r.error?.message).toContain("exec_attention_items_snooze_check");
    expect(db.read()[0].status).toBe("open");
  });

  it("refuses an unknown logic term and a timestamp compared with a non-timestamp", async () => {
    const { client, seed } = setup();
    seed(1);
    expect((await client.from("exec_attention_items").select("id").or("priority_score.like.5")).error).not.toBeNull();
    expect((await client.from("exec_attention_items").select("id").gte("first_seen_at", "yesterday")).error).not.toBeNull();
  });
});
