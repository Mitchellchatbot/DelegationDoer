import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/email-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-view")>()),
  loadEmailGate: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sources/mail")>()),
  loadScreeningPolicy: vi.fn()
}));
vi.mock("@/lib/exec/email-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-store")>()),
  listThreadScreenRows: vi.fn()
}));

import { createFakeAttentionDb, type FakeAttentionDb, type Row } from "@/lib/exec/__tests__/fake-attention-db";
import {
  MAX_SCREENED_READS,
  decodeAttentionCursor,
  encodeAttentionCursor,
  getScreenedAttentionItem,
  listScreenedAttention,
  parseAttentionFilters,
  screenAttentionItems
} from "@/lib/exec/attention-read";
import type { AttentionFeedItem, AttentionFilters } from "@/lib/exec/attention-types";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import { loadEmailGate } from "@/lib/exec/email-view";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { loadScreeningPolicy, restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { NonRetryableError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ruleFromRow } from "@/lib/restricted-senders";

// The screened accessor (P5a contract §3.4, S3, C5-C7, K24; tests 7, 8, 8b, 9,
// 10): keyset paging with refills over the real listAttentionPage on the fake
// table, and the email screen over P3's rules and thread rows.

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint();
const settings: ExecSettings = { principalId: "ep_1", ...DEFAULT_SETTINGS, mutedChannelIds: [], emailEnabled: true, emailSchemaReady: true };

const NOW = new Date("2026-11-04T13:00:00.000Z");
const id = (n: number) => `ea_${n.toString(16).padStart(32, "0")}`;

const RULE = ruleFromRow({ id: "r1", pattern: "restricted.example", match_kind: "domain", label: "R" }, new Set());
const H = restrictedPolicyHash("hidden", [RULE]);
const hashes = (from: string) => screenHashesFor({ all: [{ from, to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes;
const CLEAN = hashes("jane@acme.com");
const RESTRICTED = hashes("x@restricted.example");
const screenRow = (threadId: string, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow => ({
  threadId,
  accountId: "acc_his",
  state: "triaged",
  screenHashes: CLEAN,
  screenTruncated: false,
  screenedPolicyHash: H,
  ...over
});

let db: FakeAttentionDb;
let threadRows: Map<string, ThreadScreenRow>;

beforeEach(() => {
  db = createFakeAttentionDb({ now: () => "2026-11-01T09:00:00.000Z" });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(loadEmailGate).mockResolvedValue({ kind: "on", settings, pinned: ["acc_his"] });
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [RULE], hash: H });
  threadRows = new Map([
    ["t_ok", screenRow("t_ok")],
    ["t_restricted", screenRow("t_restricted", { screenHashes: RESTRICTED })],
    ["t_tomb", screenRow("t_tomb", { state: "restricted_hidden", screenHashes: [] })],
    ["t_gone", screenRow("t_gone", { state: "gone" })],
    ["t_old", screenRow("t_old", { accountId: "acc_old" })]
  ]);
  vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map([...threadRows].filter(([k]) => ids.includes(k))));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** A stored row: DD by default; give `fp` an email fingerprint for an email item. */
function seed(n: number, over: Row = {}, fp?: string): Row {
  const email = fp?.startsWith("email:") ?? false;
  return db.seed({
    id: id(n),
    principal_id: "ep_1",
    fingerprint: fp ?? `dd:x:${n}`,
    source: email ? "email" : "dd",
    kind: email ? "important_email" : "overdue_tasks",
    category: "my_action",
    priority_score: 50,
    priority_band: "normal",
    title: `Title ${n}`,
    state_hash: "abcdef0123456789",
    first_seen_at: new Date(Date.parse("2026-11-01T00:00:00Z") + n * 60_000).toISOString(),
    last_seen_at: "2026-11-04T12:50:00Z",
    ...over
  });
}

const selects = () => db.calls.filter((c) => c.op === "select");

// ---------------------------------------------------------------------------
// Filters and the cursor (test 7)
// ---------------------------------------------------------------------------

describe("parseAttentionFilters", () => {
  it("parses every filter; empty and unknown parameters are ignored", () => {
    expect(
      parseAttentionFilters({
        status: "dismissed",
        category: "approval",
        band: "high",
        source: "email",
        kind: "important_email",
        firstSeenAfter: "2026-11-01T00:00:00Z",
        updatedAfter: "2026-11-02T00:00:00.5+01:00",
        cursor: "abc.def",
        limit: "20",
        utm_source: "x",
        category2: undefined
      })
    ).toEqual({
      ok: true,
      filters: {
        status: "dismissed",
        category: "approval",
        band: "high",
        source: "email",
        kind: "important_email",
        firstSeenAfter: "2026-11-01T00:00:00.000Z",
        updatedAfter: "2026-11-01T23:00:00.500Z",
        cursor: "abc.def",
        limit: 20
      }
    });
    expect(parseAttentionFilters({ status: "", category: "" })).toEqual({ ok: true, filters: {} });
  });

  it.each([
    ["status", "archived"],
    ["category", "urgent"],
    ["band", "low"],
    ["source", "teams"],
    ["kind", "Bad-Kind"],
    ["firstSeenAfter", "yesterday"],
    ["updatedAfter", "2026-13-01T00:00:00Z"],
    ["limit", "0"],
    ["limit", "101"],
    ["limit", "1.5"],
    ["limit", "ten"],
    ["cursor", "x".repeat(513)]
  ])("names the bad parameter: %s=%s", (param, value) => {
    expect(parseAttentionFilters({ [param]: value })).toEqual({ ok: false, detail: param });
  });
});

describe("the cursor (test 7)", () => {
  const KEY = { score: 55, firstSeenRaw: "2026-11-04T10:00:00.123456+00:00", id: id(7) };
  const F: AttentionFilters = { status: "open", band: "high" };

  it("round-trips, bound to the filter set but not the page size or the cursor itself", () => {
    const c = encodeAttentionCursor(KEY, F);
    expect(decodeAttentionCursor(c, F)).toEqual(KEY);
    expect(decodeAttentionCursor(c, { ...F, limit: 20, cursor: c })).toEqual(KEY);
    // An equal filter set written differently (an ISO since-filter) is the same set.
    const g = { ...F, firstSeenAfter: "2026-11-01T00:00:00Z" };
    expect(decodeAttentionCursor(encodeAttentionCursor(KEY, g), { ...F, firstSeenAfter: "2026-11-01T00:00:00.000Z" })).toEqual(KEY);
  });

  it("is null for other filters", () => {
    const c = encodeAttentionCursor(KEY, F);
    for (const other of [{}, { status: "seen" }, { status: "open" }, { ...F, band: "critical" }, { ...F, source: "dd" }, { ...F, kind: "x" }, { ...F, updatedAfter: "2026-11-01T00:00:00.000Z" }] as AttentionFilters[]) {
      expect(decodeAttentionCursor(c, other)).toBeNull();
    }
  });

  it("is null when tampered with or malformed", () => {
    const c = encodeAttentionCursor(KEY, F);
    const [payload, mac] = c.split(".");
    const forged = Buffer.from(JSON.stringify([1, 99, KEY.firstSeenRaw, KEY.id]), "utf8").toString("base64url");
    expect(decodeAttentionCursor(`${forged}.${mac}`, F)).toBeNull();
    expect(decodeAttentionCursor(`${payload}.${"0".repeat(24)}`, F)).toBeNull();
    expect(decodeAttentionCursor(`${payload}${mac}`, F)).toBeNull();
    expect(decodeAttentionCursor("", F)).toBeNull();
    expect(decodeAttentionCursor("not a cursor", F)).toBeNull();
    expect(decodeAttentionCursor(`${c}x`, F)).toBeNull();
  });

  it("refuses to encode a malformed key", () => {
    expect(() => encodeAttentionCursor({ ...KEY, firstSeenRaw: "x" }, F)).toThrow(NonRetryableError);
    expect(() => encodeAttentionCursor({ ...KEY, score: 101 }, F)).toThrow(NonRetryableError);
  });
});

// ---------------------------------------------------------------------------
// Paging (tests 8, 8b, 9)
// ---------------------------------------------------------------------------

/** Seeded rows in the feed's order (score desc, first seen desc, id asc). */
function feedOrder(rows: Row[]): string[] {
  return [...rows]
    .sort(
      (a, b) =>
        (b.priority_score as number) - (a.priority_score as number) ||
        Date.parse(b.first_seen_at as string) - Date.parse(a.first_seen_at as string) ||
        String(a.id).localeCompare(String(b.id))
    )
    .map((r) => r.id as string);
}

async function allPages(filters: AttentionFilters = {}): Promise<{ pages: AttentionFeedItem[][]; cursors: (string | null)[] }> {
  const pages: AttentionFeedItem[][] = [];
  const cursors: (string | null)[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page = await listScreenedAttention(principal, { ...filters, cursor }, { now: NOW });
    pages.push(page.items);
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  return { pages, cursors };
}

describe("listScreenedAttention: keyset paging with refills (a-build-3, test 8)", () => {
  function seed130(): string[] {
    const rows: Row[] = [];
    for (let k = 1; k <= 130; k++) rows.push(seed(k, { priority_score: Math.max(0, 100 - Math.floor(k / 2)) }));
    const order = feedOrder(rows);
    // Three email rows among the first 50, each about a thread with no stored row: withheld.
    for (const at of [9, 19, 29]) {
      const n = parseInt(order[at].slice(3), 16);
      db.rows = db.rows.map((r) => (r.id === order[at] ? { ...r, source: "email", kind: "important_email", fingerprint: `email:thread:t_missing_${n}:m${n}` } : r));
    }
    return order;
  }

  it("page 1 holds exactly 50; its cursor is the 53rd row (the last examined); page 2 starts at the 54th; every survivor appears once", async () => {
    const order = seed130();
    const withheld = new Set([order[9], order[19], order[29]]);
    const page1 = await listScreenedAttention(principal, { limit: 50 }, { now: NOW });
    expect(page1.items).toHaveLength(50);
    expect(page1.hiddenEmail).toBe(3);
    expect(page1.emailScreen).toBe("ok");
    expect(page1.items.map((i) => i.id)).toEqual(order.slice(0, 53).filter((x) => !withheld.has(x)));
    // The reads: 51 (50 + the probe), then exactly what was still needed + 1.
    expect(selects().map((c) => c.limit)).toEqual([51, 4]);
    const key = decodeAttentionCursor(page1.nextCursor as string, { limit: 50 });
    expect(key?.id).toBe(order[52]);

    db.calls.length = 0;
    const page2 = await listScreenedAttention(principal, { limit: 50, cursor: page1.nextCursor }, { now: NOW });
    expect(page2.items[0].id).toBe(order[53]);
    expect(page2.items).toHaveLength(50);
    expect(selects().map((c) => c.limit)).toEqual([51]);

    const { pages, cursors } = await allPages({ limit: 50 });
    const seen = pages.flat().map((i) => i.id);
    expect(seen).toEqual(order.filter((x) => !withheld.has(x)));
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages.every((p) => p.length <= 50)).toBe(true);
    expect(cursors[cursors.length - 1]).toBeNull();
  });

  it("the cursor is never the probe row (M25)", async () => {
    const order = seed130();
    const page1 = await listScreenedAttention(principal, { limit: 10 }, { now: NOW });
    expect(decodeAttentionCursor(page1.nextCursor as string, { limit: 10 })?.id).toBe(order[10]);
    const page2 = await listScreenedAttention(principal, { limit: 10, cursor: page1.nextCursor }, { now: NOW });
    // Row 11 (index 10) was examined and is on page 1's tail; page 2 starts right after it.
    expect(page1.items.map((i) => i.id)).toContain(order[10]);
    expect(page2.items[0].id).toBe(order[11]);
  });

  it("the last page has no cursor; an empty feed is an empty page", async () => {
    for (let k = 1; k <= 5; k++) seed(k);
    const page = await listScreenedAttention(principal, { limit: 5 }, { now: NOW });
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
    expect(page.emailScreen).toBe("none");
    db.rows = [];
    expect(await listScreenedAttention(principal, {}, { now: NOW })).toEqual({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" });
  });

  it("with every row withheld, stops after 5 reads with a cursor and an empty page", async () => {
    for (let k = 1; k <= 260; k++) seed(k, {}, `email:thread:t_missing:m${k}`);
    const page = await listScreenedAttention(principal, { limit: 50 }, { now: NOW });
    expect(page.items).toEqual([]);
    expect(page.hiddenEmail).toBe(250);
    expect(page.nextCursor).not.toBeNull();
    expect(selects()).toHaveLength(MAX_SCREENED_READS);
    expect(selects().map((c) => c.limit)).toEqual([51, 51, 51, 51, 51]);
    // The next call carries on where the cap stopped.
    const next = await listScreenedAttention(principal, { limit: 50, cursor: page.nextCursor }, { now: NOW });
    expect(next.hiddenEmail).toBe(10);
    expect(next.nextCursor).toBeNull();
  });

  it("defaults to 50 and clamps the limit to 1..100", async () => {
    for (let k = 1; k <= 3; k++) seed(k);
    await listScreenedAttention(principal, {}, { now: NOW });
    await listScreenedAttention(principal, { limit: 1000 }, { now: NOW });
    await listScreenedAttention(principal, { limit: 0 }, { now: NOW });
    expect(selects().map((c) => c.limit)).toEqual([51, 101, 2]);
  });

  it("items are effective (a run-out snooze shows as open) and carry their exact version", async () => {
    seed(1, { status: "snoozed", snooze_until: "2026-11-04T12:00:00Z", updated_at: "2026-11-03T08:00:00.000042Z" });
    const [item] = (await listScreenedAttention(principal, {}, { now: NOW })).items;
    expect(item).toMatchObject({ id: id(1), status: "open", snoozeUntil: null, version: "2026-11-03T08:00:00.000042+00:00" });
  });

  it("passes the filters to the store read, and refuses bad filters and a foreign cursor", async () => {
    seed(1);
    await listScreenedAttention(principal, { status: "resolved", category: "approval", band: "high", source: "dd", kind: "x_y", updatedAfter: "2026-11-01T00:00:00Z" }, { now: NOW });
    expect(selects()[0].filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["or", "status.in.(resolved)"],
      ["eq", "category", "approval"],
      ["eq", "priority_band", "high"],
      ["eq", "source", "dd"],
      ["eq", "kind", "x_y"],
      ["gte", "updated_at", "2026-11-01T00:00:00.000Z"]
    ]);
    await expect(listScreenedAttention(principal, { band: "low" as never }, { now: NOW })).rejects.toThrow(NonRetryableError);
    const c = encodeAttentionCursor({ score: 1, firstSeenRaw: "2026-11-01T00:00:00+00:00", id: id(1) }, { status: "open" });
    await expect(listScreenedAttention(principal, { cursor: c }, { now: NOW })).rejects.toThrow("invalid_cursor");
  });

  it("throws on a store read error", async () => {
    seed(1);
    db.fail = () => ({ message: "timeout" });
    await expect(listScreenedAttention(principal, {}, { now: NOW })).rejects.toThrow("exec_attention_items read failed");
  });
});

describe("paging when sort keys move (C5, a-correct-14, test 8b)", () => {
  it("a row whose score rises past the cursor isn't on the next page; a fresh first page has it", async () => {
    for (let k = 1; k <= 6; k++) seed(k, { priority_score: 90 - k * 10 });
    const page1 = await listScreenedAttention(principal, { limit: 3 }, { now: NOW });
    expect(page1.items.map((i) => i.id)).toEqual([id(1), id(2), id(3)]);
    db.rows = db.rows.map((r) => (r.id === id(5) ? { ...r, priority_score: 95 } : r));
    const page2 = await listScreenedAttention(principal, { limit: 3, cursor: page1.nextCursor }, { now: NOW });
    expect(page2.items.map((i) => i.id)).toEqual([id(4), id(6)]);
    const fresh = await listScreenedAttention(principal, { limit: 3 }, { now: NOW });
    expect(fresh.items[0].id).toBe(id(5));
  });

  it("a row whose score falls below the cursor is shown again (the client dedupes by id)", async () => {
    for (let k = 1; k <= 6; k++) seed(k, { priority_score: 90 - k * 10 });
    const page1 = await listScreenedAttention(principal, { limit: 3 }, { now: NOW });
    db.rows = db.rows.map((r) => (r.id === id(2) ? { ...r, priority_score: 5 } : r));
    const page2 = await listScreenedAttention(principal, { limit: 3, cursor: page1.nextCursor }, { now: NOW });
    expect(page2.items.map((i) => i.id)).toEqual([id(4), id(5), id(6)]);
    const page3 = await listScreenedAttention(principal, { limit: 3, cursor: page2.nextCursor }, { now: NOW });
    expect(page3.items.map((i) => i.id)).toEqual([id(2)]);
  });
});

describe("keyset stability through the accessor (test 9)", () => {
  it("syncs bumping last_seen_at between pages neither skip nor repeat a row", async () => {
    for (let k = 1; k <= 8; k++) seed(k, { last_seen_at: new Date(Date.parse("2026-11-04T12:00:00Z") + ((k * 37) % 8) * 60_000).toISOString() });
    const page1 = await listScreenedAttention(principal, { limit: 4 }, { now: NOW });
    db.rows = db.rows.map((r) => ({ ...r, last_seen_at: r.id === id(2) || r.id === id(7) ? "2026-11-04T12:59:00+00:00" : r.last_seen_at }));
    const page2 = await listScreenedAttention(principal, { limit: 4, cursor: page1.nextCursor }, { now: NOW });
    const all = [...page1.items, ...page2.items].map((i) => i.id);
    expect(all).toEqual(feedOrder(db.read()));
    expect(new Set(all).size).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// The screen (test 10)
// ---------------------------------------------------------------------------

function seedScreenMix(): void {
  seed(1, { priority_score: 90 });
  seed(2, { priority_score: 85 }, "email:thread:t_ok:m1");
  seed(3, { priority_score: 80 }, "email:thread:t_restricted:m1");
  seed(4, { priority_score: 75 }, "email:commitment:t_tomb:ec_1");
  seed(5, { priority_score: 70 }, "email:thread:t_gone:m1");
  seed(6, { priority_score: 65 }, "email:thread:t_none:m1");
  seed(7, { priority_score: 60 }, "email:bogus:x");
  seed(8, { priority_score: 55 }, "email:satisfaction:c1");
  seed(9, { priority_score: 50 }, "email:health:c2");
  seed(10, { priority_score: 45 }, "email:commitment:t_ok:ec_2");
  seed(11, { priority_score: 40 }, "email:thread:t_old:m1");
}
const ids = async (filters: AttentionFilters = {}) => {
  const page = await listScreenedAttention(principal, filters, { now: NOW });
  return { ids: page.items.map((i) => Number.parseInt(i.id.slice(3), 16)), hiddenEmail: page.hiddenEmail, emailScreen: page.emailScreen };
};

describe("the email screen (C7, K24, test 10)", () => {
  it("withholds restricted, tombstoned, gone, rowless, unparseable and unpinned-mailbox items; passes DD, satisfaction, health and clean threads", async () => {
    seedScreenMix();
    expect(await ids()).toEqual({ ids: [1, 2, 8, 9, 10], hiddenEmail: 6, emailScreen: "ok" });
    // One rules read for the call, the rows for the page's threads.
    expect(loadScreeningPolicy).toHaveBeenCalledTimes(1);
    expect([...vi.mocked(listThreadScreenRows).mock.calls[0][1]].sort()).toEqual(["t_gone", "t_none", "t_ok", "t_old", "t_restricted", "t_tomb"]);
  });

  it("rules unreadable: every thread/commitment item withheld, unavailable; DD, satisfaction and health still shown", async () => {
    seedScreenMix();
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("restricted-sender rules unavailable"));
    expect(await ids()).toEqual({ ids: [1, 8, 9], hiddenEmail: 8, emailScreen: "unavailable" });
    expect(listThreadScreenRows).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("unavailable for");
  });

  it("thread rows unreadable: the same", async () => {
    seedScreenMix();
    vi.mocked(listThreadScreenRows).mockRejectedValue(new Error("timeout"));
    expect(await ids()).toEqual({ ids: [1, 8, 9], hiddenEmail: 8, emailScreen: "unavailable" });
  });

  it("email off or unpinned: every email item left out (not counted as screened out), nothing email-side read", async () => {
    seedScreenMix();
    for (const kind of ["off", "no_pin"] as const) {
      vi.mocked(loadEmailGate).mockResolvedValue({ kind, settings });
      expect(await ids()).toEqual({ ids: [1], hiddenEmail: 0, emailScreen: "ok" });
    }
    expect(loadScreeningPolicy).not.toHaveBeenCalled();
    expect(listThreadScreenRows).not.toHaveBeenCalled();
  });

  it("settings unreadable: every email item withheld (can't tell whether email is on), unavailable", async () => {
    seedScreenMix();
    vi.mocked(loadEmailGate).mockRejectedValue(new Error("exec_settings read failed"));
    expect(await ids()).toEqual({ ids: [1], hiddenEmail: 10, emailScreen: "unavailable" });
    expect(loadScreeningPolicy).not.toHaveBeenCalled();
  });

  it("no email item: emailScreen none and nothing email-side read", async () => {
    seed(1);
    seed(2);
    expect(await ids()).toEqual({ ids: [2, 1], hiddenEmail: 0, emailScreen: "none" });
    expect(loadEmailGate).not.toHaveBeenCalled();
  });

  it("only satisfaction/health email items: the gate is read, the rules aren't", async () => {
    seed(1, {}, "email:satisfaction:c1");
    expect(await ids()).toEqual({ ids: [1], hiddenEmail: 0, emailScreen: "ok" });
    expect(loadScreeningPolicy).not.toHaveBeenCalled();
  });

  it("refilled pages screen too, reading the rules once per call (M6)", async () => {
    for (let k = 1; k <= 6; k++) seed(k, { priority_score: 90 - k }, `email:thread:t_restricted:m${k}`);
    for (let k = 7; k <= 9; k++) seed(k, { priority_score: 50 - k });
    const page = await listScreenedAttention(principal, { limit: 3 }, { now: NOW });
    expect(page.items.map((i) => i.id)).toEqual([id(7), id(8), id(9)]);
    expect(page.hiddenEmail).toBe(6);
    expect(loadScreeningPolicy).toHaveBeenCalledTimes(1);
    expect(loadEmailGate).toHaveBeenCalledTimes(1);
  });

  it("an abort is rethrown, not mistaken for an unreadable screen", async () => {
    seed(1, {}, "email:thread:t_ok:m1");
    const controller = new AbortController();
    vi.mocked(loadScreeningPolicy).mockImplementation(async () => {
      controller.abort(new Error("deadline"));
      throw new Error("aborted");
    });
    await expect(listScreenedAttention(principal, {}, { now: NOW, signal: controller.signal })).rejects.toThrow("deadline");
  });

  it("screenAttentionItems screens arbitrary items the same way", async () => {
    seedScreenMix();
    const page = await listScreenedAttention(principal, { status: "default" }, { now: NOW });
    const all: AttentionFeedItem[] = page.items;
    const r = await screenAttentionItems(principal, all);
    expect(r.items).toEqual(all);
    expect(await screenAttentionItems(principal, [])).toEqual({ items: [], hiddenEmail: 0, emailScreen: "none" });
  });
});

describe("getScreenedAttentionItem (coherence-9, test 10)", () => {
  beforeEach(seedScreenMix);
  const reason = async (n: number | string) => getScreenedAttentionItem(principal, typeof n === "number" ? id(n) : n, { now: NOW });

  it("an unknown or malformed id is missing", async () => {
    expect(await reason(99)).toEqual({ ok: false, reason: "missing" });
    expect(await reason("ea_nope")).toEqual({ ok: false, reason: "missing" });
  });

  it("restricted, tombstoned, gone, rowless, unparseable and unpinned are withheld", async () => {
    for (const n of [3, 4, 5, 6, 7, 11]) expect(await reason(n)).toEqual({ ok: false, reason: "withheld" });
  });

  it("a clean thread, a DD, a satisfaction and a health item come back with their version", async () => {
    for (const n of [1, 2, 8, 9, 10]) {
      const r = await reason(n);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.item).toMatchObject({ id: id(n), version: "2026-11-01T09:00:00+00:00" });
    }
  });

  it("rules or rows unreadable: screen_unavailable for a thread item, ok for DD, satisfaction and health", async () => {
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("rules unavailable"));
    expect(await reason(2)).toEqual({ ok: false, reason: "screen_unavailable" });
    expect(await reason(10)).toEqual({ ok: false, reason: "screen_unavailable" });
    expect((await reason(1)).ok).toBe(true);
    expect((await reason(8)).ok).toBe(true);
    vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [RULE], hash: H });
    vi.mocked(listThreadScreenRows).mockRejectedValue(new Error("timeout"));
    expect(await reason(2)).toEqual({ ok: false, reason: "screen_unavailable" });
  });

  it("any status: a resolved item is still found", async () => {
    db.rows = db.rows.map((r) => (r.id === id(1) ? { ...r, status: "resolved", resolution: "auto", resolved_at: "2026-11-03T00:00:00+00:00" } : r));
    const r = await reason(1);
    expect(r.ok && r.item.status).toBe("resolved");
  });

  it("throws on a store read error", async () => {
    db.fail = () => ({ message: "timeout" });
    await expect(reason(1)).rejects.toThrow("exec_attention_items read failed");
  });
});
