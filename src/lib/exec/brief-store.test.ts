import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { BRIEF_TEXT_SENTINELS, assertNoBriefText } from "@/lib/exec/__tests__/brief-assert";
import { createFakeBriefDb, type FakeBriefDb, type FakeBriefDbSeed } from "@/lib/exec/__tests__/fake-brief-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import * as store from "@/lib/exec/brief-store";
import type { BriefContent, NewCheckin } from "@/lib/exec/brief-types";
import { parseSlackScrubCursor, parseTokenHealthState } from "@/lib/exec/sync-state";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 brief store (contract §3.4, §5.13 ST01-ST05, ST08-ST10; Area A) against the standalone fake (§5.19), whose RPC bodies
// mirror 20261111100000_exec_brief.sql (the SQL suite runs the same cases, SQ05-SQ12, on PGlite and real Postgres).

const NOW = new Date("2026-11-09T13:00:00.000Z");
const P = { id: "ep_1" } as unknown as ExecPrincipal;
const P2 = { id: "ep_2" } as unknown as ExecPrincipal;
const CONTENT_EXP = new Date("2026-12-10T05:00:00.000Z");
const ROW_EXP = new Date("2027-05-09T05:00:00.000Z");
const SCHED = new Date("2026-11-09T13:00:00.000Z");
const hex = (n: number) => n.toString(16).padStart(32, "0");
const T = (n: number) => `17941${String(n).padStart(5, "0")}.000100`;
const MISSING_CODES = ["42883", "PGRST202", "42P01", "PGRST205"] as const;

let db: FakeBriefDb;
function use(seed: FakeBriefDbSeed = {}): FakeBriefDb {
  db = createFakeBriefDb({ now: () => new Date(), ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.__resetBriefStoreForTests();
  use();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixtures (snake_case rows through the fake's client, so its DDL defaults and CHECKs apply)
// ---------------------------------------------------------------------------

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, text: `Line ${id}`, kind: "fact", basis: "ai", band: "high", aliases: ["i1"], fps: [`fp:${id}`], refs: [], threadIds: [] as string[],
  slackKeys: [] as string[], slackChannels: [] as string[], ...over
});
function content(items: ReturnType<typeof item>[] = [item("b1")], extra: Record<string, unknown> = {}): BriefContent {
  return {
    v: 1, localDate: "2026-11-09", tz: "America/New_York", rev: 1, builtAt: NOW.toISOString(), trigger: "schedule", mode: "ai", modeReason: null,
    top3Fallback: false, headline: `Headline ${BRIEF_TEXT_SENTINELS.briefLine}`,
    sections: [{ key: "emails", state: "ok", stateNote: null, items, pending: [], unchanged: 0, more: 0, stats: {} }] as unknown as BriefContent["sections"],
    top3: [], novelty: {}, counts: { new: 1, changed: 0, escalated: 0, pending: 0, unchanged: 0, restrictedEmail: 0, slackUnanswered: 0 }, failures: [],
    ...extra
  } as BriefContent;
}
const refsOf = (c: BriefContent) => {
  const all = c.sections.flatMap((s) => [...s.items, ...s.pending]) as unknown as { threadIds: string[]; slackKeys: string[]; slackChannels: string[] }[];
  const u = (k: "threadIds" | "slackKeys" | "slackChannels") => [...new Set(all.flatMap((x) => x[k] ?? []))].sort();
  return { ref_thread_ids: u("threadIds"), ref_slack_keys: u("slackKeys"), ref_slack_channels: u("slackChannels") };
};

let dayN = 0;
const nextDate = () => new Date(Date.UTC(2025, 0, 1) + dayN++ * 86_400_000).toISOString().slice(0, 10);

function statusFields(status: string): Row {
  const built = { mode: "ai", built_at: "2026-11-09T13:01:00.000Z", novelty_marked_at: "2026-11-09T13:01:00.000Z" };
  switch (status) {
    case "building":
      return { build_started_at: "2026-11-09T13:00:00.000Z" };
    case "failed":
      return {};
    case "built":
    case "page_only":
      return built;
    case "delivering":
    case "delivery_unknown":
      return { ...built, delivery_started_at: "2026-11-09T13:02:00.000Z", post_attempts: 1 };
    case "delivered":
      return { ...built, delivery_started_at: "2026-11-09T13:02:00.000Z", post_attempts: 1, delivered_at: "2026-11-09T13:02:01.000Z",
        slack_channel_id: "D0MITCH", slack_ts: T(1) };
    default:
      throw new Error(status);
  }
}

/** One exec_briefs row inserted through the client (defaults + CHECKs). */
async function addBrief(status = "built", over: Row = {}, principal = P): Promise<Row> {
  const hasContent = !["building", "failed"].includes(status);
  const c = "content" in over ? (over.content as BriefContent | null) : hasContent ? content() : null;
  const row: Row = {
    principal_id: principal.id, local_date: nextDate(), tz: "America/New_York", scheduled_at: SCHED.toISOString(), status,
    ...(c ? { content: c, ...refsOf(c) } : {}), ...statusFields(status), content_expires_at: CONTENT_EXP.toISOString(), expires_at: ROW_EXP.toISOString(),
    ...over
  };
  if (row.content === null) delete row.content;
  const client = db.client as SupabaseClient;
  const { data, error } = await client.from("exec_briefs").insert(row).select("*");
  if (error) throw new Error(`addBrief: ${error.code} ${error.message}`);
  return (data as Row[])[0];
}

async function addCheckin(brief: Row, over: Row = {}): Promise<Row> {
  const client = db.client as SupabaseClient;
  const { data, error } = await client.from("exec_brief_checkins").insert({
    brief_id: brief.id, principal_id: brief.principal_id, local_date: brief.local_date, brief_rev: 1, recipient_user_id: "u_austin",
    recipient_slack_id: "U0AUSTIN", text: `Hi, how is the week going? ${BRIEF_TEXT_SENTINELS.checkinText}`, expires_at: at(48 * 3_600_000),
    purge_at: at(30 * 86_400_000), ...over
  }).select("*");
  if (error) throw new Error(`addCheckin: ${error.code} ${error.message}`);
  return (data as Row[])[0];
}

const claimInput = (over: Partial<Parameters<typeof store.claimBuild>[1]> = {}) => ({
  localDate: nextDate(), tz: "America/New_York", scheduledAt: SCHED, trigger: "schedule" as const, expectedRev: null, contentExpiresAt: CONTENT_EXP,
  expiresAt: ROW_EXP, ...over
});
const finishInput = (id: string, over: Partial<store.FinishBuildInput> = {}): store.FinishBuildInput => ({
  id, expectedRev: 1, trigger: "schedule", status: "built", statusReason: null, owner: "exec", ownerReason: "owns", mode: "ai", modeReason: null,
  content: content([item("b1", { threadIds: ["t_1"] })]), refs: { threadIds: ["t_1"], slackKeys: [], slackChannels: [] },
  mentions: [{ fp: "email:thread:t_1:a", state: "s1", band: "high" }], mentionedOn: "2026-11-09", ...over
});
const row = (id: unknown) => db.tables.exec_briefs.find((b) => b.id === id) as Row;

// ---------------------------------------------------------------------------

describe("ST01 the schema probe and the not-installed mapping", () => {
  it("ST01: briefSchemaReady caches true for 60 s and false for 10 s; another error throws and isn't cached", async () => {
    expect(await store.briefSchemaReady()).toBe(true);
    vi.setSystemTime(new Date(NOW.getTime() + 59_000));
    expect(await store.briefSchemaReady()).toBe(true);
    expect(db.calls.filter((c) => c.target === "exec_briefs")).toHaveLength(1);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    db.missing.add("exec_briefs");
    expect(await store.briefSchemaReady()).toBe(false);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000 + 9_000));
    db.missing.delete("exec_briefs");
    expect(await store.briefSchemaReady()).toBe(false);
    expect(db.calls.filter((c) => c.target === "exec_briefs")).toHaveLength(2);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000 + 11_000));
    expect(await store.briefSchemaReady()).toBe(true);
    expect(db.calls.filter((c) => c.target === "exec_briefs")).toHaveLength(3);
    // The probe selects no column but the id, with limit 0.
    expect(db.calls[0]).toMatchObject({ kind: "select", columns: "id", limit: 0 });
    store.__resetBriefStoreForTests();
    db.failNext("exec_briefs", "57014");
    await expect(store.briefSchemaReady()).rejects.toMatchObject({ name: "BriefStoreError", op: "briefSchemaReady", pgCode: "57014" });
    expect(await store.briefSchemaReady()).toBe(true);
  });

  it.each(MISSING_CODES)("ST01: %s on every wrapper → its not-installed answer (not_installed, null, false, 0, empty, zeros)", async (code) => {
    const b = await addBrief("built");
    const miss = (op: string) => db.failNext(op, code);
    miss("exec_brief_claim_build");
    expect(await store.claimBuild(P, claimInput())).toEqual({ outcome: "not_installed" });
    miss("exec_brief_claim_fallback");
    expect(await store.claimFallback(P, claimInput())).toEqual({ outcome: "not_installed" });
    miss("exec_brief_finish_build");
    const fin = await store.finishBuild(P, finishInput(String(b.id))).catch((e: unknown) => e);
    expect(fin).toBeInstanceOf(store.BriefStoreError);
    expect(store.isBriefSchemaMissing(fin)).toBe(true);
    expect((fin as store.BriefStoreError).op).toBe("not_installed");
    miss("exec_brief_delivery_step");
    expect(await store.deliveryStep(String(b.id), { from: ["built"], to: "delivering", countPost: true })).toBe(false);
    miss("exec_brief_scrub_threads");
    expect(await store.scrubBriefsForThreads(P, ["t_1"])).toBeNull();
    miss("exec_brief_scrub_slack");
    expect(await store.scrubBriefsForSlack(P, { slackKeys: ["m:C0X:1.000001"], channels: [], all: false })).toBeNull();
    miss("exec_brief_scrub_slack");
    expect(await store.scrubBriefsForSlackSystem("ep_1")).toBeNull();
    miss("exec_brief_purge_expired");
    expect(await store.purgeExpiredBriefs(NOW)).toEqual({ contentPurged: 0, briefsDeleted: 0, checkinsDeleted: 0, mentionsDeleted: 0 });
    for (const [op, run, expected] of [
      ["exec_briefs", () => store.getBriefByDate(P, String(b.local_date)), null],
      ["exec_briefs", () => store.getBriefById(P, String(b.id)), null],
      ["exec_briefs", () => store.getLatestBrief(P, "2030-01-01"), null],
      ["exec_briefs", () => store.getBriefDayFactsForSystem("ep_1", String(b.local_date)), "not_installed"],
      ["exec_briefs", () => store.lastDeliveredBriefAt(P), null],
      ["exec_briefs", () => store.failBuild(P, String(b.id), 1, "pre_model", "x"), false],
      ["exec_briefs", () => store.recordCheckinsMessage(String(b.id), T(9)), false],
      ["exec_briefs", () => store.listFallbackDmsDue(NOW, 10), []],
      ["exec_briefs", () => store.listFollowups(P, 10), []],
      ["exec_briefs", () => store.listStaleBuilt(P, NOW), []],
      ["exec_briefs", () => store.listStaleDelivering(P, NOW), []],
      ["exec_briefs", () => store.oldestBuildInFlight(P), null],
      ["exec_briefs", () => store.listPrincipalIdsWithSlackLines(10), []],
      ["exec_brief_mentions", () => store.getMentions(P, ["f"]), new Map()],
      ["exec_brief_checkins", () => store.listCheckinsForBrief(P, String(b.id)), []],
      ["exec_brief_checkins", () => store.getCheckin(P, `ebc_${hex(1)}`), null],
      ["exec_brief_checkins", () => store.countPendingCheckins(P, "2026-11-09", NOW), { count: 0, oldestAt: null }],
      ["exec_brief_checkins", () => store.checkinCounts(P, "2026-11-09"), { proposed: 0, sending: 0, sent: 0, unknown: 0, failed: 0, expired: 0 }],
      ["exec_brief_checkins", () => store.listRecentCheckinRecipients(P, NOW.toISOString()), new Map()],
      ["exec_brief_checkins", () => store.checkinPostKeys(P, [{ channelId: "D0AUSTIN", ts: T(1) }]), new Set()],
      ["exec_brief_checkins", () => store.expireCheckins(P, { briefId: String(b.id), reason: "superseded" }), 0],
      ["exec_brief_checkins", () => store.resolveStaleSendingCheckins(P, NOW), []],
      ["exec_brief_checkins", () => store.checkinStep(P, `ebc_${hex(1)}`, { from: ["proposed"], rev: 1, to: "expired" }), false],
      ["daily_briefings", () => store.legacyDeliveredBetween(NOW.toISOString(), at(1000)), false],
      ["daily_briefings", () => store.getLegacyBriefMeta("brief_2026-11-09"), null],
      ["daily_briefings", () => store.listLegacyCheckinRecipients("2026-11-01"), new Map()]
    ] as [string, () => Promise<unknown>, unknown][]) {
      miss(op);
      expect(await run(), op).toEqual(expected);
    }
    miss("exec_brief_checkins");
    await expect(store.insertCheckins(P, [newCheckin(String(b.id))])).rejects.toMatchObject({ op: "not_installed" });
  });

  it("ST01: any other error is a BriefStoreError naming the op and code only (no value it was handed); an aborted signal wins", async () => {
    const b = await addBrief("built", { content: content([item("b1", { text: BRIEF_TEXT_SENTINELS.briefLine })]) });
    db.failNext("exec_brief_claim_build", "57014", `canceling statement ${BRIEF_TEXT_SENTINELS.briefLine}`);
    const err = await store.claimBuild(P, claimInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(store.BriefStoreError);
    expect(err).toMatchObject({ op: "exec_brief_claim_build", pgCode: "57014", message: "exec brief store: exec_brief_claim_build failed (57014)" });
    expect(store.isBriefSchemaMissing(err)).toBe(false);
    assertNoBriefText(err);
    db.failNext("exec_briefs", "XX000");
    await expect(store.getBriefById(P, String(b.id))).rejects.toMatchObject({ op: "getBriefById", pgCode: "XX000" });
    const controller = new AbortController();
    controller.abort(new Error("deadline"));
    await expect(store.getBriefByDate(P, String(b.local_date), { signal: controller.signal })).rejects.toThrow("deadline");
    expect(store.isBriefSchemaMissing({ code: "PGRST205" })).toBe(true);
    expect(store.isBriefSchemaMissing({ code: "42703" })).toBe(true);
    expect(store.isBriefSchemaMissing(new Error("x"))).toBe(false);
  });
});

function newCheckin(briefId: string, over: Partial<NewCheckin> = {}): NewCheckin {
  return {
    briefId, localDate: "2026-11-09", briefRev: 1, recipientUserId: "u_austin", recipientSlackId: "U0AUSTIN", text: "Hi Altamash, how is the week going?",
    expiresAt: at(48 * 3_600_000), purgeAt: at(30 * 86_400_000), ...over
  };
}

// ---------------------------------------------------------------------------

describe("ST02 finishBuild's mentions", () => {
  it("ST02: de-duplicates by fingerprint (first wins) and sends every build's mentions, the RPC marking only the day's first", async () => {
    const c = await store.claimBuild(P, claimInput());
    if (c.outcome !== "claimed") throw new Error(c.outcome);
    const r = await store.finishBuild(P, finishInput(c.id, {
      mentions: [{ fp: "a", state: "s1", band: "high" }, { fp: "b", state: "s2", band: "normal" }, { fp: "a", state: "s9", band: "critical" }]
    }));
    expect(r).toEqual({ outcome: "ok", rev: 1, status: "built", marked: 2 });
    const call = db.calls.find((x) => x.target === "exec_brief_finish_build");
    expect((call?.payload as Row).p_mentions).toEqual([{ fp: "a", state: "s1", band: "high" }, { fp: "b", state: "s2", band: "normal" }]);
    expect(db.tables.exec_brief_mentions.map((m) => [m.fingerprint, m.last_state_hash])).toEqual([["a", "s1"], ["b", "s2"]]);
    // A regenerate sends its mentions too; the RPC marks nothing (novelty_marked_at is set). (Built 11 minutes ago: a fresh
    // 'built' row is busy at the finish, fixer correctness-1.)
    row(c.id).built_at = at(-11 * 60_000);
    const again = await store.finishBuild(P, finishInput(c.id, { trigger: "regenerate", mentions: [{ fp: "c", state: "s", band: "high" }] }));
    expect(again).toMatchObject({ outcome: "ok", rev: 2, marked: 0 });
    expect(db.tables.exec_brief_mentions).toHaveLength(2);
  });

  it("ST02: refuses an invalid fingerprint, state or band, more than 400 distinct ones, or bad refs, before any call", async () => {
    const c = await store.claimBuild(P, claimInput());
    if (c.outcome !== "claimed") throw new Error(c.outcome);
    const before = db.calls.length;
    for (const mentions of [
      [{ fp: "", state: "s", band: "high" }],
      [{ fp: "x".repeat(301), state: "s", band: "high" }],
      [{ fp: "f", state: "", band: "high" }],
      [{ fp: "f", state: "s".repeat(129), band: "high" }],
      [{ fp: "f", state: "s", band: "low" }],
      Array.from({ length: 401 }, (_, i) => ({ fp: `f${i}`, state: "s", band: "high" }))
    ]) {
      await expect(store.finishBuild(P, finishInput(c.id, { mentions: mentions as store.FinishBuildInput["mentions"] }))).rejects.toBeInstanceOf(TypeError);
    }
    await expect(store.finishBuild(P, finishInput(c.id, { refs: { threadIds: Array.from({ length: 401 }, (_, i) => `t${i}`), slackKeys: [], slackChannels: [] } })))
      .rejects.toBeInstanceOf(TypeError);
    await expect(store.finishBuild(P, finishInput(c.id, { refs: { threadIds: [""], slackKeys: [], slackChannels: [] } }))).rejects.toBeInstanceOf(TypeError);
    await expect(store.finishBuild(P, finishInput(c.id, { mentionedOn: "11/09/2026" }))).rejects.toBeInstanceOf(TypeError);
    // 400 distinct after de-duplication is fine.
    const ok = Array.from({ length: 450 }, (_, i) => ({ fp: `f${i % 400}`, state: "s", band: "high" as const }));
    expect(db.calls.length).toBe(before);
    expect(await store.finishBuild(P, finishInput(c.id, { mentions: ok }))).toMatchObject({ outcome: "ok", marked: 400 });
  });
});

// ---------------------------------------------------------------------------

describe("ST03 the check-in CAS", () => {
  it("ST03: checkinStep's patch is always { status, status_reason, updated_at } plus exactly the step's own columns; each step keeps the earlier stamps", async () => {
    const b = await addBrief("delivered");
    const [ck] = await store.insertCheckins(P, [newCheckin(String(b.id), { localDate: String(b.local_date) })]);
    expect(ck).toMatchObject({ status: "proposed", rev: 1, briefRev: 1, recipientSlackId: "U0AUSTIN", auditId: null });
    const keys = () => Object.keys(db.calls.filter((c) => c.kind === "update").at(-1)?.payload as Row).sort();
    expect(await store.checkinStep(P, ck.id, { from: ["proposed"], rev: 1, to: "sending", sendingAt: NOW.toISOString(), auditId: 77 })).toBe(true);
    expect(keys()).toEqual(["audit_id", "sending_at", "status", "status_reason", "updated_at"]);
    expect(await store.checkinStep(P, ck.id, { from: ["sending"], rev: 1, to: "sent", sentAt: at(1000), channel: "D0AUSTIN", ts: T(3) })).toBe(true);
    expect(keys()).toEqual(["sent_at", "slack_channel_id", "slack_ts", "status", "status_reason", "updated_at"]);
    const sent = await store.getCheckin(P, ck.id);
    expect(sent).toMatchObject({ status: "sent", sendingAt: NOW.toISOString(), auditId: 77, slackTs: T(3), slackChannelId: "D0AUSTIN", statusReason: null });
    for (const payload of db.calls.filter((c) => c.kind === "update").map((c) => c.payload as Row)) {
      expect(Object.values(payload).includes(undefined)).toBe(false);
    }
  });

  it("ST03: the CAS refuses a wrong rev, a wrong source status and another principal's row; a reason is stored on the way out", async () => {
    const b = await addBrief("delivered");
    const [ck] = await store.insertCheckins(P, [newCheckin(String(b.id))]);
    expect(await store.checkinStep(P, ck.id, { from: ["proposed"], rev: 2, to: "expired" })).toBe(false);
    expect(await store.checkinStep(P, ck.id, { from: ["sending"], rev: 1, to: "unknown" })).toBe(false);
    expect(await store.checkinStep(P2, ck.id, { from: ["proposed"], rev: 1, to: "expired" })).toBe(false);
    expect(await store.checkinStep(P, ck.id, { from: ["proposed"], rev: 1, to: "failed", reason: "recipient_changed" })).toBe(true);
    expect(await store.getCheckin(P, ck.id)).toMatchObject({ status: "failed", statusReason: "recipient_changed" });
    await expect(store.checkinStep(P, ck.id, { from: ["failed"], rev: 1, to: "expired", reason: "Bad Reason" })).rejects.toBeInstanceOf(TypeError);
  });

  it("ST03: rewriteCheckin sets the text and rev + 1 only from proposed at that rev", async () => {
    const b = await addBrief("delivered");
    const [ck] = await store.insertCheckins(P, [newCheckin(String(b.id))]);
    expect(await store.rewriteCheckin(P, ck.id, 1, "A new note")).toBe(true);
    expect(await store.getCheckin(P, ck.id)).toMatchObject({ rev: 2, text: "A new note", status: "proposed" });
    expect(await store.rewriteCheckin(P, ck.id, 1, "Stale")).toBe(false);
    await store.checkinStep(P, ck.id, { from: ["proposed"], rev: 2, to: "sending", sendingAt: NOW.toISOString(), auditId: 1 });
    expect(await store.rewriteCheckin(P, ck.id, 2, "While sending")).toBe(false);
    await expect(store.rewriteCheckin(P, ck.id, 2, "x".repeat(601))).rejects.toBeInstanceOf(TypeError);
    await expect(store.rewriteCheckin(P, ck.id, 2, "")).rejects.toBeInstanceOf(TypeError);
  });

  it("ST03: insertCheckins builds every row with the identical key set and checks each before the call", async () => {
    const b = await addBrief("delivered");
    const rows = await store.insertCheckins(P, [newCheckin(String(b.id)), newCheckin(String(b.id), { recipientUserId: "u_james", recipientSlackId: "U0JAMES" })]);
    expect(rows).toHaveLength(2);
    const payload = db.calls.find((c) => c.kind === "insert" && c.target === "exec_brief_checkins" && Array.isArray(c.payload) && c.payload.length === 2)?.payload as Row[];
    expect(payload.map((r) => Object.keys(r).sort().join(","))).toEqual([
      "brief_id,brief_rev,expires_at,local_date,principal_id,purge_at,recipient_slack_id,recipient_user_id,text",
      "brief_id,brief_rev,expires_at,local_date,principal_id,purge_at,recipient_slack_id,recipient_user_id,text"
    ]);
    const before = db.calls.length;
    await expect(store.insertCheckins(P, [newCheckin(String(b.id), { text: "" })])).rejects.toBeInstanceOf(TypeError);
    await expect(store.insertCheckins(P, [newCheckin(String(b.id), { recipientSlackId: "B0BOT" })])).rejects.toBeInstanceOf(TypeError);
    await expect(store.insertCheckins(P, [newCheckin("eb_bad")])).rejects.toBeInstanceOf(TypeError);
    expect(db.calls.length).toBe(before);
    expect(await store.insertCheckins(P, [])).toEqual([]);
    // The live key: a second live row for the same recipient and brief → 23505, thrown as a BriefStoreError.
    await expect(store.insertCheckins(P, [newCheckin(String(b.id))])).rejects.toMatchObject({ op: "insertCheckins", pgCode: "23505" });
  });
});

// ---------------------------------------------------------------------------

describe("ST04 / ST05 the legacy and system reads", () => {
  it("ST04: listLegacyCheckinRecipients parses daily_briefings.messages (userId → newest brief_date) and ignores malformed entries and rows", async () => {
    use({
      tables: {
        daily_briefings: [
          { id: "brief_2026-11-07", brief_date: "2026-11-07", messages: [{ userId: "u_a", name: "A", status: "sent" }, { userId: "u_b", status: "pending" }] },
          { id: "brief_2026-11-08", brief_date: "2026-11-08", messages: [{ userId: "u_a", status: "failed" }, null, "u_c", { name: "no id" }, { userId: 7 },
            { userId: "" }, [{ userId: "u_d" }]] },
          { id: "brief_2026-11-09", brief_date: "2026-11-09", messages: "not an array" },
          { id: "brief_bad", brief_date: "11/09/2026", messages: [{ userId: "u_e" }] },
          { id: "brief_2026-10-01", brief_date: "2026-10-01", messages: [{ userId: "u_old" }] }
        ]
      }
    });
    const m = await store.listLegacyCheckinRecipients("2026-11-04");
    expect([...m.entries()].sort()).toEqual([["u_a", "2026-11-08"], ["u_b", "2026-11-07"]]);
    expect(db.calls.at(-1)).toMatchObject({ columns: "brief_date,messages" });
  });

  it("ST04: legacyDeliveredBetween and getLegacyBriefMeta read delivered_at / meta only", async () => {
    use({
      tables: {
        daily_briefings: [
          { id: "brief_2026-11-08", brief_date: "2026-11-08", delivered_at: "2026-11-08T14:00:00.000Z", meta: { ranWhileSuperseded: true } },
          { id: "brief_2026-11-09", brief_date: "2026-11-09", delivered_at: null, meta: {} }
        ]
      }
    });
    expect(await store.legacyDeliveredBetween("2026-11-08T05:00:00.000Z", "2026-11-09T05:00:00.000Z")).toBe(true);
    expect(await store.legacyDeliveredBetween("2026-11-09T05:00:00.000Z", "2026-11-10T05:00:00.000Z")).toBe(false);
    expect(await store.legacyDeliveredBetween("2026-11-08T14:00:00.001Z", "2026-11-09T05:00:00.000Z")).toBe(false);
    expect(await store.getLegacyBriefMeta("brief_2026-11-08")).toEqual({ ranWhileSuperseded: true });
    expect(await store.getLegacyBriefMeta("brief_2026-11-09")).toEqual({ ranWhileSuperseded: false });
    expect(await store.getLegacyBriefMeta("brief_2026-11-10")).toBeNull();
    expect(db.calls.filter((c) => c.target === "daily_briefings").map((c) => c.columns)).toEqual(["id", "id", "id", "meta", "meta", "meta"]);
  });

  it("ST04 (fixer security-3): legacyBriefInFlight: an undelivered row stamped postingAt in the last 10 minutes; reads meta only", async () => {
    const row = (id: string, over: Row) => ({ id, brief_date: "2026-11-09", created_at: at(-60 * 60_000), delivered_at: null, meta: {}, ...over });
    use({ tables: { daily_briefings: [row("brief_2026-11-09", { meta: { postingAt: at(-60_000) } })] } });
    expect(await store.legacyBriefInFlight()).toBe(true);
    expect(db.calls.filter((c) => c.target === "daily_briefings").map((c) => c.columns)).toEqual(["meta"]);
    for (const over of [
      { meta: { postingAt: at(-11 * 60_000) } },                                          // the stamp lapsed
      { meta: { postingAt: at(-60_000) }, delivered_at: at(-30_000) },                    // it posted
      { meta: {} },                                                                       // never stamped (or cleared)
      { meta: { postingAt: at(-60_000) }, created_at: at(-4 * 86_400_000) }               // an old row
    ]) {
      use({ tables: { daily_briefings: [row("brief_2026-11-09", over)] } });
      expect(await store.legacyBriefInFlight(), JSON.stringify(over)).toBe(false);
    }
    use({ missing: ["daily_briefings"] });
    expect(await store.legacyBriefInFlight()).toBe(false);
  });

  it("ST05: getBriefDayFactsForSystem returns booleans and the owner only (never content), from a three-column select", async () => {
    const b = await addBrief("delivered", { owner: "exec", owner_reason: "owns", fallback_sent_at: "2026-11-09T13:45:00.000Z",
      content: content([item("b1", { text: BRIEF_TEXT_SENTINELS.briefLine })]) });
    const facts = await store.getBriefDayFactsForSystem("ep_1", String(b.local_date));
    expect(facts).toEqual({ exists: true, owner: "exec", delivered: true, fallbackSent: true });
    assertNoBriefText(facts);
    expect(db.calls.at(-1)?.columns).toBe("owner,delivered_at,fallback_sent_at");
    expect(await store.getBriefDayFactsForSystem("ep_1", "2030-01-01")).toEqual({ exists: false, owner: null, delivered: false, fallbackSent: false });
    expect(await store.getBriefDayFactsForSystem("ep_2", String(b.local_date))).toEqual({ exists: false, owner: null, delivered: false, fallbackSent: false });
  });
});

// ---------------------------------------------------------------------------

describe("ST08 the fake mirrors RPCs 1-7 (SQ05-SQ12's cases, through the store)", () => {
  it("ST08 / SQ05: claim: schedule claimed then exists; a placeholder claimed with first; retry only on pre_model; regenerate's rules and regen_seq", async () => {
    const d = nextDate();
    const c1 = await store.claimBuild(P, claimInput({ localDate: d }));
    expect(c1).toMatchObject({ outcome: "claimed", rev: 1, first: true, fallbackSent: false, status: null, regenSeq: null });
    expect(await store.claimBuild(P, claimInput({ localDate: d }))).toMatchObject({ outcome: "exists", rev: 1, status: "building" });
    const d2 = nextDate();
    expect(await store.claimFallback(P, claimInput({ localDate: d2 }))).toMatchObject({ outcome: "claimed", status: "building" });
    expect(await store.claimBuild(P, claimInput({ localDate: d2 }))).toMatchObject({ outcome: "claimed", first: true, fallbackSent: true });
    const pre = await addBrief("failed", { status_reason: "pre_model" });
    expect(await store.claimBuild(P, claimInput({ localDate: String(pre.local_date) }))).toMatchObject({ outcome: "exists", status: "failed" });
    expect(await store.claimBuild(P, claimInput({ localDate: String(pre.local_date), trigger: "retry" }))).toMatchObject({ outcome: "claimed", first: true });
    expect(row(pre.id)).toMatchObject({ status: "building", status_reason: null });
    const post = await addBrief("failed", { status_reason: "post_model" });
    expect(await store.claimBuild(P, claimInput({ localDate: String(post.local_date), trigger: "retry" }))).toMatchObject({ outcome: "exists" });
    // Regenerate.
    expect(await store.claimBuild(P, claimInput({ trigger: "regenerate", expectedRev: 1 }))).toEqual({ outcome: "not_found" });
    const del = await addBrief("delivered");
    const regen = (rev = 1, over = {}) => store.claimBuild(P, claimInput({ localDate: String(del.local_date), trigger: "regenerate", expectedRev: rev, ...over }));
    expect(await regen(2)).toEqual({ outcome: "conflict", rev: 1 });
    const seqs: (number | null)[] = [];
    for (let n = 0; n < 3; n += 1) {
      const r = await regen(1, { regenLockSeconds: 120 });
      expect(r).toMatchObject({ outcome: "claimed", status: "delivered", first: false });
      seqs.push(r.outcome === "claimed" ? r.regenSeq : null);
      expect(await regen()).toMatchObject({ outcome: "busy", status: "delivered" });
      await store.releaseRegenLock(P, String(del.id), 1);
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(row(del.id).regen_lock_until).toBeNull();
    for (const status of ["building", "delivering"]) {
      const b = await addBrief(status);
      expect(await store.claimBuild(P, claimInput({ localDate: String(b.local_date), trigger: "regenerate", expectedRev: 1 }))).toMatchObject({ outcome: "busy", status });
    }
    const fresh = await addBrief("built", { built_at: at(-2 * 60_000) });
    expect(await store.claimBuild(P, claimInput({ localDate: String(fresh.local_date), trigger: "regenerate", expectedRev: 1 }))).toMatchObject({ outcome: "busy" });
    const old = await addBrief("built", { built_at: at(-11 * 60_000) });
    expect(await store.claimBuild(P, claimInput({ localDate: String(old.local_date), trigger: "regenerate", expectedRev: 1 }))).toMatchObject({ outcome: "claimed" });
    expect(Date.parse(String(row(old.id).regen_lock_until)) - Date.now()).toBe(300_000);
    const fb = await addBrief("built", { built_at: at(-60_000), fallback_sent_at: at(-30_000) });
    expect(await store.claimBuild(P, claimInput({ localDate: String(fb.local_date), trigger: "regenerate", expectedRev: 1 }))).toMatchObject({ outcome: "claimed", fallbackSent: true });
    // Argument checks before any call.
    await expect(store.claimBuild(P, claimInput({ trigger: "regenerate", expectedRev: null }))).rejects.toBeInstanceOf(TypeError);
    await expect(store.claimBuild(P, claimInput({ expectedRev: 1 }))).rejects.toBeInstanceOf(TypeError);
    await expect(store.claimBuild(P, claimInput({ localDate: "2026-13-45x" }))).rejects.toBeInstanceOf(TypeError);
    await expect(store.claimBuild(P, claimInput({ expiresAt: new Date("2026-12-01T00:00:00Z") }))).rejects.toBeInstanceOf(TypeError);
  });

  it("ST08 / SQ06: delivery steps: built → delivering ×2, never a third; delivered refs; page_only re-delivery reasons; no post after the watchdog", async () => {
    const b = await addBrief("built");
    const step = (id: unknown, s: Parameters<typeof store.deliveryStep>[1]) => store.deliveryStep(String(id), s);
    expect(await step(b.id, { from: ["built"], to: "delivering", countPost: true })).toBe(true);
    expect(await step(b.id, { from: ["delivering"], to: "delivering", countPost: true })).toBe(true);
    expect(await step(b.id, { from: ["delivering"], to: "delivering", countPost: true })).toBe(false);
    expect(row(b.id).post_attempts).toBe(2);
    expect(await step(b.id, { from: ["delivering"], to: "delivered", countPost: false, channel: "D0MITCH", ts: T(5) })).toBe(true);
    expect(row(b.id)).toMatchObject({ status: "delivered", slack_channel_id: "D0MITCH", slack_ts: T(5) });
    expect(await step(b.id, { from: ["delivering"], to: "page_only", countPost: false, reason: "delivery_failed" })).toBe(false);
    const u = await addBrief("delivering");
    expect(await step(u.id, { from: ["delivering"], to: "delivery_unknown", countPost: false, reason: "ambiguous_twice", errorCode: "http_503" })).toBe(true);
    expect(row(u.id)).toMatchObject({ status: "delivery_unknown", status_reason: "ambiguous_twice", error_code: "http_503" });
    for (const [reason, ok] of [["not_superseding", true], ["no_installation", true], ["legacy_delivered", false], ["after_cutoff", false]] as const) {
      const p = await addBrief("page_only", { status_reason: reason });
      expect(await step(p.id, { from: ["page_only"], to: "delivering", countPost: true }), reason).toBe(ok);
    }
    const fb = await addBrief("built", { fallback_sent_at: at(-1000) });
    expect(await step(fb.id, { from: ["built"], to: "delivering", countPost: true })).toBe(false);
    const built = await addBrief("built");
    expect(await step(built.id, { from: ["built"], to: "delivered", countPost: false, channel: "D0MITCH", ts: T(6) })).toBe(false);
    expect(await step(built.id, { from: ["built"], to: "page_only", countPost: false, reason: "ownership_lapsed" })).toBe(true);
    // The store's own guards (before the call).
    await expect(step(b.id, { from: ["built"], to: "delivering", countPost: false })).rejects.toBeInstanceOf(TypeError);
    await expect(step(b.id, { from: ["failed" as "built"], to: "page_only", countPost: false })).rejects.toBeInstanceOf(TypeError);
    await expect(step(b.id, { from: ["delivering"], to: "delivered", countPost: false, channel: "C0MITCH", ts: T(1) })).rejects.toBeInstanceOf(TypeError);
    // The fake's own CHECK: a third count can't be stored.
    const client = db.client as SupabaseClient;
    const { error } = await client.from("exec_briefs").update({ post_attempts: 3 }).eq("id", b.id);
    expect(error).toMatchObject({ code: "23514", message: expect.stringContaining("exec_briefs_post_attempts_check") });
  });

  it("ST08 / SQ07 / SQ09: finish: schedule → built + marked; regenerate rev+1 keeps delivered; failed → page_only regenerated (marks, intel-16); built → page_only; conflict / lost", async () => {
    const c = await store.claimBuild(P, claimInput());
    if (c.outcome !== "claimed") throw new Error(c.outcome);
    expect(await store.finishBuild(P, finishInput(c.id))).toEqual({ outcome: "ok", rev: 1, status: "built", marked: 1 });
    expect(row(c.id)).toMatchObject({ status: "built", owner: "exec", ref_thread_ids: ["t_1"] });
    expect(await store.finishBuild(P, finishInput(c.id))).toEqual({ outcome: "conflict", rev: 1, status: "built" });
    const del = await addBrief("delivered");
    expect(await store.finishBuild(P, finishInput(String(del.id), { trigger: "regenerate" }))).toEqual({ outcome: "ok", rev: 2, status: "delivered", marked: 0 });
    const failed = await addBrief("failed", { status_reason: "post_model" });
    expect(await store.finishBuild(P, finishInput(String(failed.id), { trigger: "regenerate", mentions: [{ fp: "first", state: "s", band: "critical" }] })))
      .toEqual({ outcome: "ok", rev: 2, status: "page_only", marked: 1 });
    expect(row(failed.id).status_reason).toBe("regenerated");
    const fb = await addBrief("built", { fallback_sent_at: at(-1000) });
    await store.finishBuild(P, finishInput(String(fb.id), { trigger: "regenerate" }));
    expect(row(fb.id)).toMatchObject({ status: "page_only", status_reason: "after_fallback" });
    // Built 11 minutes ago (C48): a fresh 'built' row is busy at the finish too (fixer correctness-1).
    const nf = await addBrief("built", { built_at: at(-11 * 60_000) });
    await store.finishBuild(P, finishInput(String(nf.id), { trigger: "regenerate" }));
    expect(row(nf.id)).toMatchObject({ status: "page_only", status_reason: "delivery_failed" });
    expect(await store.deliveryStep(String(nf.id), { from: ["built", "page_only"], to: "delivering", countPost: true })).toBe(false);
    expect(await store.finishBuild(P, finishInput(`eb_${hex(999)}`))).toEqual({ outcome: "lost" });
    // greatest(last_mentioned_on): a later build of an earlier date never moves it back.
    const c2 = await store.claimBuild(P, claimInput());
    if (c2.outcome !== "claimed") throw new Error(c2.outcome);
    await store.finishBuild(P, finishInput(c2.id, { mentions: [{ fp: "email:thread:t_1:a", state: "s2", band: "critical" }], mentionedOn: "2026-11-05" }));
    const m = await store.getMentions(P, ["email:thread:t_1:a", "nope"]);
    // The state and band follow the newest write; the date never moves backwards.
    expect([...m.entries()]).toEqual([["email:thread:t_1:a", { stateHash: "s2", band: "critical", lastMentionedOn: "2026-11-09" }]]);
  });

  it("ST08 / SQ07 (fixer correctness-1): a regenerate finish on building / delivering / a fresh built row → conflict, nothing written; either order with a retry leaves the retry's build deliverable", async () => {
    for (const status of ["building", "delivering"] as const) {
      const b = await addBrief(status);
      const before = structuredClone(row(b.id));
      expect(await store.finishBuild(P, finishInput(String(b.id), { trigger: "regenerate" }))).toEqual({ outcome: "conflict", rev: 1, status });
      expect(row(b.id)).toEqual(before);
    }
    const fresh = await addBrief("built", { built_at: at(-2 * 60_000) });
    expect(await store.finishBuild(P, finishInput(String(fresh.id), { trigger: "regenerate" }))).toEqual({ outcome: "conflict", rev: 1, status: "built" });
    // A failed pre_model day: Regenerate claims, the retry claims; the regenerate's finish yields; the retry builds and delivers.
    const a = await addBrief("failed", { status_reason: "pre_model", error_code: "mentions_read" });
    const day = String(a.local_date);
    expect(await store.claimBuild(P, claimInput({ localDate: day, trigger: "regenerate", expectedRev: 1 }))).toMatchObject({ outcome: "claimed" });
    expect(await store.claimBuild(P, claimInput({ localDate: day, trigger: "retry" }))).toMatchObject({ outcome: "claimed" });
    expect(await store.finishBuild(P, finishInput(String(a.id), { trigger: "regenerate" }))).toEqual({ outcome: "conflict", rev: 1, status: "building" });
    expect(await store.finishBuild(P, finishInput(String(a.id), { trigger: "retry" }))).toMatchObject({ outcome: "ok", rev: 1, status: "built" });
    expect(await store.deliveryStep(String(a.id), { from: ["built"], to: "delivering", countPost: true })).toBe(true);
    // The retry finishes first: the regenerate then finds a fresh built row and yields.
    const b = await addBrief("failed", { status_reason: "pre_model", error_code: "mentions_read" });
    const dayB = String(b.local_date);
    await store.claimBuild(P, claimInput({ localDate: dayB, trigger: "regenerate", expectedRev: 1 }));
    await store.claimBuild(P, claimInput({ localDate: dayB, trigger: "retry" }));
    expect(await store.finishBuild(P, finishInput(String(b.id), { trigger: "retry" }))).toMatchObject({ outcome: "ok", status: "built" });
    expect(await store.finishBuild(P, finishInput(String(b.id), { trigger: "regenerate" }))).toEqual({ outcome: "conflict", rev: 1, status: "built" });
    expect(row(b.id)).toMatchObject({ status: "built", rev: 1, status_reason: null });
    expect(await store.deliveryStep(String(b.id), { from: ["built"], to: "delivering", countPost: true })).toBe(true);
  });

  it("ST08 / SQ07 (fixer security-1): a regenerate of a delivered or delivery_unknown day keeps the DM's refs; a later scrub of one marks it for the C15 follow-up", async () => {
    for (const status of ["delivered", "delivery_unknown"] as const) {
      const old = content([item("b1", { threadIds: ["t_old"], slackKeys: ["m:C0OLD:1700000000.000100"], slackChannels: ["C0OLD"] })]);
      const b = await addBrief(status, { content: old, ...refsOf(old) });
      expect(await store.finishBuild(P, finishInput(String(b.id), { trigger: "regenerate", content: content([item("b1", { threadIds: ["t_new"] })]),
        refs: { threadIds: ["t_new"], slackKeys: [], slackChannels: [] } }))).toMatchObject({ outcome: "ok", rev: 2, status });
      expect(row(b.id)).toMatchObject({ ref_thread_ids: ["t_new", "t_old"], ref_slack_keys: ["m:C0OLD:1700000000.000100"], ref_slack_channels: ["C0OLD"],
        scrubbed_at: null });
      expect(await store.scrubBriefsForSlack(P, { slackKeys: ["m:C0OLD:1700000000.000100"], channels: [], all: false })).toBe(1);
      expect(row(b.id).scrubbed_at).toBe(NOW.toISOString());
    }
    // The interleaving of the finding: deliver, regenerate without the line, then the line's message is deleted → listFollowups has the row.
    const d = await addBrief("delivered", { content: content([item("b1", { slackKeys: ["m:C1:1700000000.000100"], slackChannels: ["C1"] })]),
      ref_slack_keys: ["m:C1:1700000000.000100"], ref_slack_channels: ["C1"] });
    await store.finishBuild(P, finishInput(String(d.id), { trigger: "regenerate", content: content([item("b1")]), refs: { threadIds: [], slackKeys: [], slackChannels: [] } }));
    expect((await store.listFollowups(P, 10)).map((f) => f.id)).not.toContain(d.id);
    await store.scrubBriefsForSlack(P, { slackKeys: ["m:C1:1700000000.000100"], channels: [], all: false });
    expect((await store.listFollowups(P, 10)).map((f) => f.id)).toContain(d.id);
    // A reading revoke after a regenerate made while reading was off still reaches it (the `all` scrub needs the old channels).
    const r = await addBrief("delivered", { content: content([item("b1", { slackKeys: ["m:C2:1700000000.000100"], slackChannels: ["C2"] })]),
      ref_slack_keys: ["m:C2:1700000000.000100"], ref_slack_channels: ["C2"] });
    await store.finishBuild(P, finishInput(String(r.id), { trigger: "regenerate", content: content([item("b1")]), refs: { threadIds: [], slackKeys: [], slackChannels: [] } }));
    expect(await store.listPrincipalIdsWithSlackLines(10)).toContain(P.id);
    // Never delivered: the new refs only.
    const p = await addBrief("page_only", { content: content([item("b1", { threadIds: ["t_page"] })]), ref_thread_ids: ["t_page"] });
    await store.finishBuild(P, finishInput(String(p.id), { trigger: "regenerate", refs: { threadIds: [], slackKeys: [], slackChannels: [] } }));
    expect(row(p.id).ref_thread_ids).toEqual([]);
    // Past a cardinality CHECK: the new refs only, and the DM is followed up now.
    const many = Array.from({ length: 300 }, (_, i) => `t_a${String(i).padStart(3, "0")}`);
    const more = Array.from({ length: 300 }, (_, i) => `t_b${String(i).padStart(3, "0")}`);
    const big = await addBrief("delivered", { content: content([item("b1", { threadIds: many })]), ref_thread_ids: many });
    await store.finishBuild(P, finishInput(String(big.id), { trigger: "regenerate", content: content([item("b1", { threadIds: more })]),
      refs: { threadIds: more, slackKeys: [], slackChannels: [] } }));
    const bigRefs = row(big.id).ref_thread_ids as string[];
    expect([bigRefs.length, bigRefs[0], row(big.id).scrubbed_at]).toEqual([300, "t_b000", NOW.toISOString()]);
  });

  it("ST08 / SQ12 (fixer security-2): a row past expires_at keeps an undeleted DD-bot mini-brief's refs up to 7 days; deleted or older rows go", async () => {
    const fb = { fallback_sent_at: "2026-05-01T12:45:00.000Z", fallback_channel_id: "D0DDBOT", fallback_slack_ts: T(7), fallback_delete_after: at(-86_400_000) };
    const exp = { content_expires_at: at(-200 * 86_400_000) };
    const posted = await addBrief("page_only", { ...exp, ...fb, expires_at: at(-86_400_000) });
    const deleted = await addBrief("page_only", { ...exp, ...fb, fallback_deleted_at: at(-3_600_000), expires_at: at(-86_400_000) });
    const stale = await addBrief("page_only", { ...exp, ...fb, expires_at: at(-8 * 86_400_000) });
    expect((await store.purgeExpiredBriefs(NOW)).briefsDeleted).toBe(2);
    expect(row(posted.id)).toBeDefined();
    expect([row(deleted.id), row(stale.id)]).toEqual([undefined, undefined]);
  });

  it("ST08 / SQ08: the watchdog claim: inserted placeholder claimed, then already; delivered; in flight; a built row claimed", async () => {
    const d = nextDate();
    const r = await store.claimFallback(P, claimInput({ localDate: d }));
    expect(r).toMatchObject({ outcome: "claimed", status: "building" });
    expect(row(r.outcome === "not_installed" ? null : r.id)).toMatchObject({ build_started_at: null, status: "building" });
    expect(await store.claimFallback(P, claimInput({ localDate: d }))).toMatchObject({ outcome: "already", status: null });
    const del = await addBrief("delivered");
    expect(await store.claimFallback(P, claimInput({ localDate: String(del.local_date) }))).toMatchObject({ outcome: "delivered", id: del.id });
    for (const status of ["delivering", "delivery_unknown"] as const) {
      const b = await addBrief(status);
      expect(await store.claimFallback(P, claimInput({ localDate: String(b.local_date) }))).toMatchObject({ outcome: "in_flight", status });
    }
    const built = await addBrief("built");
    expect(await store.claimFallback(P, claimInput({ localDate: String(built.local_date) }))).toMatchObject({ outcome: "claimed", status: "built" });
  });

  it("ST08 / SQ10 / SQ10b / SQ11: the scrubs rewrite the citing lines, drop pending lines and top-3 entries, null the headline and recompute the arrays", async () => {
    const c = content(
      [item("b1", { threadIds: ["t_1"], band: "critical" }), item("b2", { threadIds: ["t_2"] })],
      {
        top3: [{ itemId: "b1", alias: "i1", fp: "f1", title: "x", next: null, refs: [], threadIds: [], slackKeys: [], slackChannels: [] },
          { itemId: null, alias: "i2", fp: "f2", title: "y", next: null, refs: [], threadIds: ["t_2"], slackKeys: [], slackChannels: [] }]
      }
    );
    (c.sections as unknown as Row[])[0].pending = [{ fp: "p1", title: "z", band: "normal", since: null, refs: [], threadIds: ["t_1"], slackKeys: [], slackChannels: [] }];
    (c.sections as unknown as Row[]).push({ key: "slack", state: "ok", stateNote: null, unchanged: 0, more: 0, stats: {}, pending: [],
      items: [item("b3", { slackKeys: ["m:C0PUB:1794100001.000100", "d:C0PUB:2026-11-08"], slackChannels: ["C0PUB"] })] });
    const b = await addBrief("delivered", { content: c, ref_thread_ids: ["t_1", "t_2"], ref_slack_keys: ["d:C0PUB:2026-11-08", "m:C0PUB:1794100001.000100"],
      ref_slack_channels: ["C0PUB"] });
    const other = await addBrief("built", { content: content([item("b1", { threadIds: ["t_1"] })]), ref_thread_ids: ["t_1"] }, P2);
    expect(await store.scrubBriefsForThreads(P, ["t_1", "t_1", ""])).toBe(1);
    const r = row(b.id);
    const s0 = (r.content as Row).sections as Row[];
    expect((s0[0].items as Row[])[0]).toEqual({ id: "b1", text: "[Removed: restricted sender]", kind: "fact", basis: "ai", band: "critical", aliases: [], fps: [],
      refs: [], threadIds: [], slackKeys: [], slackChannels: [], scrubbed: true });
    expect(s0[0].pending).toEqual([]);
    expect(((r.content as Row).top3 as Row[]).map((t) => t.fp)).toEqual(["f2"]);
    expect(r.content).toMatchObject({ headline: null, headlineScrubbed: true, scrubbed: true });
    expect([r.ref_thread_ids, r.scrubbed_at]).toEqual([["t_2"], NOW.toISOString()]);
    expect((((row(other.id).content as Row).sections as Row[])[0].items as Row[])[0].text).toBe("Line b1");
    expect(await store.scrubBriefsForThreads(P, ["t_1"])).toBe(0);
    // Slack: by digest key → the line goes; then all → nothing left to hit.
    expect(await store.scrubBriefsForSlack(P, { slackKeys: ["d:C0PUB:2026-11-08"], channels: [], all: false })).toBe(1);
    expect((((row(b.id).content as Row).sections as Row[])[1].items as Row[])[0]).toMatchObject({ text: "[Removed: no longer available in Slack]", scrubbed: true });
    expect(row(b.id).ref_slack_channels).toEqual([]);
    expect(await store.scrubBriefsForSlackSystem("ep_1")).toBe(0);
    expect(await store.scrubBriefsForSlack(P, { slackKeys: [], channels: [], all: false })).toBe(0);
    expect(await store.scrubBriefsForThreads(P, [])).toBe(0);
  });

  it("ST08 / SQ11: more than 500 keys are split into calls of ≤ 500; all is one call with no keys", async () => {
    const keys = Array.from({ length: 1100 }, (_, i) => `m:C0X:${i}.000001`);
    await store.scrubBriefsForSlack(P, { slackKeys: keys, channels: ["C0A", "C0B"], all: false });
    const calls = db.calls.filter((c) => c.target === "exec_brief_scrub_slack").map((c) => c.payload as Row);
    expect(calls.map((c) => [(c.p_slack_keys as string[]).length, (c.p_channels as string[]).length, c.p_all])).toEqual([[500, 2, false], [500, 0, false], [100, 0, false]]);
    await store.scrubBriefsForSlack(P, { slackKeys: keys, channels: [], all: true });
    expect(db.calls.at(-1)?.payload).toEqual({ p_principal: "ep_1", p_slack_keys: [], p_channels: [], p_all: true });
    const threads = Array.from({ length: 700 }, (_, i) => `t_${i}`);
    await store.scrubBriefsForThreads(P, threads);
    expect(db.calls.filter((c) => c.target === "exec_brief_scrub_threads").map((c) => ((c.payload as Row).p_thread_ids as string[]).length)).toEqual([500, 200]);
  });

  it("ST08 / SQ12: purge: content past its expiry nulled (status kept), rows past expires_at deleted with their check-ins, mentions before the cutoff", async () => {
    const stale = await addBrief("delivered", { content_expires_at: at(-86_400_000), expires_at: ROW_EXP.toISOString() });
    const gone = await addBrief("page_only", { content_expires_at: at(-3 * 86_400_000), expires_at: at(-86_400_000) });
    await addCheckin(gone);
    db.tables.exec_brief_mentions.push({ principal_id: "ep_1", fingerprint: "old", last_state_hash: "s", last_band: "high", last_mentioned_on: "2026-08-01" },
      { principal_id: "ep_1", fingerprint: "new", last_state_hash: "s", last_band: "high", last_mentioned_on: "2026-11-01" });
    const r = await store.purgeExpiredBriefs(NOW);
    expect(r).toEqual({ contentPurged: 2, briefsDeleted: 1, checkinsDeleted: 0, mentionsDeleted: 1 });
    expect(row(stale.id)).toMatchObject({ status: "delivered", content: null, content_purged_at: NOW.toISOString(), ref_thread_ids: [] });
    expect(row(gone.id)).toBeUndefined();
    expect(db.tables.exec_brief_checkins).toEqual([]);
    expect(db.tables.exec_brief_mentions.map((m) => m.fingerprint)).toEqual(["new"]);
    expect((db.calls.find((c) => c.target === "exec_brief_purge_expired")?.payload as Row).p_mention_cutoff).toBe("2026-08-11");
  });
});

// ---------------------------------------------------------------------------

describe("ST09 the DD bot's mini-brief refs (C49, intel-18)", () => {
  it("ST09: recordFallbackResult writes channel, ts and fallback_delete_after together, only after the claim and once; or the error code", async () => {
    const b = await addBrief("page_only", { status_reason: "after_fallback" });
    expect(await store.recordFallbackResult(String(b.id), { channel: "D0DDBOT", ts: T(7), deleteAfter: new Date("2026-12-09T13:45:00.000Z") })).toBe(false);
    expect(row(b.id).fallback_slack_ts).toBeNull();
    await store.claimFallback(P, claimInput({ localDate: String(b.local_date) }));
    expect(await store.recordFallbackResult(String(b.id), { channel: "D0DDBOT", ts: T(7), deleteAfter: new Date("2026-12-09T13:45:00.000Z") })).toBe(true);
    expect(row(b.id)).toMatchObject({ fallback_channel_id: "D0DDBOT", fallback_slack_ts: T(7), fallback_delete_after: "2026-12-09T13:45:00.000Z" });
    expect(await store.recordFallbackResult(String(b.id), { channel: "D0DDBOT", ts: T(8), deleteAfter: new Date("2026-12-09T13:45:00.000Z") })).toBe(false);
    expect(await store.recordFallbackResult(String(b.id), { errorCode: "channel_not_found" })).toBe(false);
    const e = await addBrief("page_only", { status_reason: "after_fallback", fallback_sent_at: at(-1000) });
    expect(await store.recordFallbackResult(String(e.id), { errorCode: "Not A Code!" })).toBe(true);
    expect(row(e.id).fallback_error_code).toBe("unknown");
    await expect(store.recordFallbackResult(String(e.id), { channel: "C0DDBOT", ts: T(7), deleteAfter: NOW })).rejects.toBeInstanceOf(TypeError);
    // The fake mirrors exec_briefs_fallback_dm_check: a ts without its channel can't be stored.
    const client = db.client as SupabaseClient;
    const { error } = await client.from("exec_briefs").update({ fallback_slack_ts: T(9) }).eq("id", e.id);
    expect(error).toMatchObject({ code: "23514" });
  });

  it("ST09: listFallbackDmsDue returns only due, undeleted rows, oldest first, refs only; markFallbackDmDeleted is idempotent", async () => {
    const mk = (n: number, deleteAfter: string, over: Row = {}) => addBrief("page_only", {
      status_reason: "after_fallback", fallback_sent_at: "2026-10-01T08:45:00.000Z", fallback_channel_id: "D0DDBOT", fallback_slack_ts: T(n),
      fallback_delete_after: deleteAfter, ...over
    });
    const b = await mk(2, "2026-11-08T00:00:00.000Z");
    const a = await mk(1, "2026-11-01T00:00:00.000Z");
    await mk(3, "2026-12-01T00:00:00.000Z");
    await mk(4, "2026-11-02T00:00:00.000Z", { fallback_deleted_at: "2026-11-03T00:00:00.000Z" });
    const due = await store.listFallbackDmsDue(NOW, 10);
    expect(due).toEqual([{ id: a.id, channel: "D0DDBOT", ts: T(1) }, { id: b.id, channel: "D0DDBOT", ts: T(2) }]);
    expect(db.calls.at(-1)?.columns).toBe("id,fallback_channel_id,fallback_slack_ts");
    expect(await store.listFallbackDmsDue(NOW, 1)).toHaveLength(1);
    expect(await store.markFallbackDmDeleted(String(a.id))).toBe(true);
    expect(await store.markFallbackDmDeleted(String(a.id))).toBe(false);
    expect((await store.listFallbackDmsDue(NOW, 10)).map((d) => d.id)).toEqual([b.id]);
  });
});

// ---------------------------------------------------------------------------

describe("ST10 the stale-row reads (intel-11, -13, C50)", () => {
  it("ST10: listStaleBuilt filters on built_at; listStaleDelivering on the last step; failStaleBuilds fails stale builds and old placeholders", async () => {
    const old = await addBrief("built", { built_at: at(-11 * 60_000), updated_at: at(0) });
    await addBrief("built", { built_at: at(-2 * 60_000), updated_at: at(-60 * 60_000) });
    await addBrief("page_only", { built_at: at(-60 * 60_000) });
    expect((await store.listStaleBuilt(P, new Date(Date.now() - 10 * 60_000))).map((r) => r.id)).toEqual([old.id]);
    const sd = await addBrief("delivering", { updated_at: at(-6 * 60_000) });
    await addBrief("delivering", { updated_at: at(-60_000) });
    expect((await store.listStaleDelivering(P, new Date(Date.now() - 5 * 60_000))).map((r) => r.id)).toEqual([sd.id]);
    const staleBuild = await addBrief("building", { build_started_at: at(-11 * 60_000) });
    await addBrief("building", { build_started_at: at(-60_000) });
    const placeholder = await addBrief("building", { build_started_at: null, created_at: at(-3 * 3_600_000) });
    await addBrief("building", { build_started_at: null, created_at: at(-60 * 60_000) });
    expect(await store.failStaleBuilds(P, NOW)).toEqual({ staleBuild: [staleBuild.id], neverBuilt: [placeholder.id] });
    expect(row(staleBuild.id)).toMatchObject({ status: "failed", status_reason: "stale_build" });
    expect(row(placeholder.id)).toMatchObject({ status: "failed", status_reason: "never_built" });
  });

  it("ST10: oldestBuildInFlight: the earlier of a building row's build_started_at and a live lock − 900 s; a placeholder and an expired lock don't count; null when neither", async () => {
    expect(await store.oldestBuildInFlight(P)).toBeNull();
    await addBrief("building", { build_started_at: null });
    await addBrief("delivered", { regen_lock_until: at(-1000) });
    expect(await store.oldestBuildInFlight(P)).toBeNull();
    await addBrief("building", { build_started_at: at(-5 * 60_000) });
    expect(await store.oldestBuildInFlight(P)).toBe(at(-5 * 60_000));
    await addBrief("delivered", { regen_lock_until: at(240_000) });
    expect(await store.oldestBuildInFlight(P)).toBe(at(240_000 - 900_000));
    expect(await store.oldestBuildInFlight(P2)).toBeNull();
  });

  it("ST10: resolveStaleSendingCheckins moves only sending rows older than the cut-off to unknown stale_sending and returns their brief ids", async () => {
    const b = await addBrief("delivered");
    const old = await addCheckin(b, { status: "sending", sending_at: at(-2 * 60_000), audit_id: 1 });
    const fresh = await addCheckin(b, { status: "sending", sending_at: at(-10_000), audit_id: 2, recipient_user_id: "u_james", recipient_slack_id: "U0JAMES" });
    const proposed = await addCheckin(b, { recipient_user_id: "u_x", recipient_slack_id: "U0X" });
    expect(await store.resolveStaleSendingCheckins(P, new Date(Date.now() - 60_000))).toEqual([b.id]);
    const st = (id: unknown) => db.tables.exec_brief_checkins.find((c) => c.id === id);
    expect(st(old.id)).toMatchObject({ status: "unknown", status_reason: "stale_sending" });
    expect(st(fresh.id)).toMatchObject({ status: "sending" });
    expect(st(proposed.id)).toMatchObject({ status: "proposed" });
    expect(await store.resolveStaleSendingCheckins(P2, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the other reads and writes", () => {
  it("getBriefByDate / getBriefById / getLatestBrief map every column; an unknown id shape is null without a call", async () => {
    await addBrief("delivered", { local_date: "2026-11-07" });
    const b = await addBrief("page_only", { local_date: "2026-11-08", status_reason: "not_superseding", owner: "exec_page_only", owner_reason: "not_superseding" });
    const r = await store.getBriefByDate(P, "2026-11-08");
    expect(r).toMatchObject({ id: b.id, principalId: "ep_1", localDate: "2026-11-08", status: "page_only", statusReason: "not_superseding", owner: "exec_page_only",
      ownerReason: "not_superseding", mode: "ai", rev: 1, regenSeq: 0, postAttempts: 0, contentExpiresAt: CONTENT_EXP.toISOString() });
    expect(r?.content?.sections[0].items[0].text).toBe("Line b1");
    expect(await store.getBriefById(P, String(b.id))).toEqual(r);
    expect(await store.getBriefById(P2, String(b.id))).toBeNull();
    const calls = db.calls.length;
    expect(await store.getBriefById(P, "eb_nope")).toBeNull();
    expect(db.calls.length).toBe(calls);
    expect((await store.getLatestBrief(P, "2026-11-30"))?.localDate).toBe("2026-11-08");
    expect((await store.getLatestBrief(P, "2026-11-07"))?.localDate).toBe("2026-11-07");
    expect(await store.getLatestBrief(P, "2026-11-06")).toBeNull();
    expect(db.calls.filter((c) => c.target === "exec_briefs" && c.kind === "select").every((c) => c.columns !== "*")).toBe(true);
  });

  it("lastDeliveredBriefAt: the later of the newest delivered_at and fallback_sent_at; null when none", async () => {
    expect(await store.lastDeliveredBriefAt(P)).toBeNull();
    await addBrief("delivered", { delivered_at: "2026-11-07T13:02:00.000Z" });
    await addBrief("page_only", { fallback_sent_at: "2026-11-08T13:45:00.000Z" });
    expect(await store.lastDeliveredBriefAt(P)).toBe("2026-11-08T13:45:00.000Z");
    await addBrief("delivered", { delivered_at: "2026-11-09T13:02:00.000Z" });
    expect(await store.lastDeliveredBriefAt(P)).toBe("2026-11-09T13:02:00.000Z");
  });

  it("recordCheckinsMessage / recordLateNote / listFollowups / markDmFollowed", async () => {
    const b = await addBrief("delivered");
    expect(await store.recordCheckinsMessage(String(b.id), T(4))).toBe(true);
    expect(await store.recordCheckinsMessage(String(b.id), T(5))).toBe(false);
    expect(row(b.id).checkins_ts).toBe(T(4));
    const p = await addBrief("page_only");
    expect(await store.recordLateNote(String(p.id), T(6))).toBe(false);
    await expect(store.recordCheckinsMessage(String(p.id), T(7))).rejects.toMatchObject({ pgCode: "23514" });
    const lf = await addBrief("page_only", { fallback_sent_at: at(-1000) });
    expect(await store.recordLateNote(String(lf.id), T(6))).toBe(true);
    expect(await store.recordLateNote(String(lf.id), T(7))).toBe(false);
    // Follow-ups: delivered and scrubbed since the last follow-up.
    await store.scrubBriefsForThreads(P, ["t_none"]);
    const s1 = await addBrief("delivered", { content: content([item("b1", { threadIds: ["t_9"] })]) });
    await store.scrubBriefsForThreads(P, ["t_9"]);
    const f = await store.listFollowups(P, 10);
    expect(f).toEqual([{ id: s1.id, channel: "D0MITCH", ts: T(1), scrubbedAt: NOW.toISOString() }]);
    await store.markDmFollowed(String(s1.id), NOW.toISOString());
    expect(await store.listFollowups(P, 10)).toEqual([]);
    // A later scrub needs a new follow-up.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    db.tables.exec_briefs.find((x) => x.id === s1.id)!.scrubbed_at = new Date().toISOString();
    expect((await store.listFollowups(P, 10)).map((x) => x.id)).toEqual([s1.id]);
    await store.markDmFollowed(String(s1.id), new Date().toISOString());
    expect(row(s1.id).dm_followed_at).toBe(new Date().toISOString());
    expect(await store.listFollowups(P2, 10)).toEqual([]);
  });

  it("expireCheckins by brief, earlier date or expiry; countPendingCheckins and checkinCounts; failBuild's CAS", async () => {
    const b = await addBrief("delivered", { local_date: "2026-11-09" });
    const older = await addBrief("delivered", { local_date: "2026-11-08" });
    await addCheckin(older, { recipient_user_id: "u_o", recipient_slack_id: "U0O" });
    const a = await addCheckin(b);
    await addCheckin(b, { recipient_user_id: "u_james", recipient_slack_id: "U0JAMES", created_at: at(-60_000) });
    await addCheckin(b, { recipient_user_id: "u_x", recipient_slack_id: "U0X", expires_at: at(1000), created_at: at(-2 * 60_000) });
    expect(await store.countPendingCheckins(P, "2026-11-09", NOW)).toEqual({ count: 3, oldestAt: at(-2 * 60_000) });
    expect(await store.expireCheckins(P, { beforeLocalDate: "2026-11-09", reason: "next_brief" })).toBe(1);
    vi.setSystemTime(new Date(NOW.getTime() + 2000));
    expect(await store.expireCheckins(P, { expiredBefore: new Date(), reason: "expired" })).toBe(1);
    expect(await store.countPendingCheckins(P, "2026-11-09", new Date())).toMatchObject({ count: 2 });
    expect(await store.expireCheckins(P, { briefId: String(b.id), reason: "superseded" })).toBe(2);
    expect(await store.checkinCounts(P, "2026-11-09")).toEqual({ proposed: 0, sending: 0, sent: 0, unknown: 0, failed: 0, expired: 3 });
    expect(db.tables.exec_brief_checkins.find((c) => c.id === a.id)).toMatchObject({ status: "expired", status_reason: "superseded" });
    await expect(store.expireCheckins(P, { reason: "expired" })).rejects.toBeInstanceOf(TypeError);
    const building = await addBrief("building");
    expect(await store.failBuild(P, String(building.id), 2, "pre_model", "store_error")).toBe(false);
    expect(await store.failBuild(P2, String(building.id), 1, "pre_model", "store_error")).toBe(false);
    expect(await store.failBuild(P, String(building.id), 1, "pre_model", "Bad Code!")).toBe(true);
    expect(row(building.id)).toMatchObject({ status: "failed", status_reason: "pre_model", error_code: "unknown" });
    expect(await store.failBuild(P, String(building.id), 1, "post_model", "x")).toBe(false);
  });

  it("listRecentCheckinRecipients skips superseded rows; listSentCheckinTexts keeps the newest per user; checkinPostKeys matches channel and ts", async () => {
    const b = await addBrief("delivered");
    await addCheckin(b, { status: "sent", sending_at: at(-3000), audit_id: 1, sent_at: at(-2000), slack_channel_id: "D0AUSTIN", slack_ts: T(11), text: "Old note",
      created_at: at(-3 * 86_400_000) });
    const b2 = await addBrief("delivered");
    await addCheckin(b2, { status: "sent", sending_at: at(-3000), audit_id: 2, sent_at: at(-1000), slack_channel_id: "D0AUSTIN", slack_ts: T(12), text: "New note" });
    await addCheckin(b2, { status: "expired", status_reason: "superseded", recipient_user_id: "u_sup", recipient_slack_id: "U0SUP" });
    await addCheckin(b2, { status: "expired", status_reason: "next_brief", recipient_user_id: "u_next", recipient_slack_id: "U0NEXT" });
    const recent = await store.listRecentCheckinRecipients(P, at(-5 * 86_400_000));
    expect([...recent.keys()].sort()).toEqual(["u_austin", "u_next"]);
    expect(recent.get("u_austin")).toBe(NOW.toISOString());
    expect(await store.listSentCheckinTexts(P, ["u_austin", "u_none"], 1)).toEqual(new Map([["u_austin", ["New note"]]]));
    expect(await store.listSentCheckinTexts(P, ["u_austin"], 3)).toEqual(new Map([["u_austin", ["New note", "Old note"]]]));
    expect(await store.checkinPostKeys(P, [{ channelId: "D0AUSTIN", ts: T(12) }, { channelId: "C0OTHER", ts: T(11) }, { channelId: "bad", ts: "x" }]))
      .toEqual(new Set([`D0AUSTIN:${T(12)}`]));
    expect(await store.checkinPostKeys(P2, [{ channelId: "D0AUSTIN", ts: T(12) }])).toEqual(new Set());
    expect(await store.checkinPostKeys(P, [])).toEqual(new Set());
  });

  it("listPrincipalIdsWithSlackLines: distinct principals whose briefs still hold content citing Slack", async () => {
    await addBrief("built", { ref_slack_channels: ["C0X"] });
    await addBrief("built", { ref_slack_channels: ["C0Y"] });
    await addBrief("built", { ref_slack_channels: ["C0Z"] }, P2);
    await addBrief("built", {}, { id: "ep_3" } as unknown as ExecPrincipal);
    await addBrief("page_only", { content: null, content_purged_at: at(-1000), ref_slack_channels: ["C0W"] }, { id: "ep_4" } as unknown as ExecPrincipal);
    expect(await store.listPrincipalIdsWithSlackLines(10)).toEqual(["ep_1", "ep_2"]);
    expect(await store.listPrincipalIdsWithSlackLines(1)).toEqual(["ep_1"]);
  });

  it("releaseRegenLock never throws (a store error or a bad id is swallowed; logs the op only)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const b = await addBrief("delivered", { regen_lock_until: at(60_000) });
    db.failNext("exec_briefs", "57014");
    await expect(store.releaseRegenLock(P, String(b.id), 1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[exec-brief] releaseRegenLock failed (57014)");
    await expect(store.releaseRegenLock(P, "nope", 1)).resolves.toBeUndefined();
    await expect(store.releaseRegenLock({} as ExecPrincipal, String(b.id), 1)).resolves.toBeUndefined();
    await store.releaseRegenLock(P, String(b.id), 1);
    expect(row(b.id).regen_lock_until).toBeNull();
    assertNoBriefText(warn.mock.calls);
  });
});

describe("sync-state's brief keys (§3.21.1; Area A)", () => {
  it("parseTokenHealthState: { state, checkedAt } for the six states (extra stored fields ignored); anything else → null", () => {
    for (const state of ["ok", "mismatch", "missing", "revoked", "error", "no_installation"]) {
      expect(parseTokenHealthState({ state, checkedAt: NOW.toISOString(), slackUserMatches: true, teamMatches: false })).toEqual({ state, checkedAt: NOW.toISOString() });
    }
    for (const raw of [null, "ok", [], {}, { state: "fine", checkedAt: NOW.toISOString() }, { state: "ok" }, { state: "ok", checkedAt: "yesterday" },
      { state: "ok", checkedAt: 1 }]) {
      expect(parseTokenHealthState(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("parseSlackScrubCursor: { afterId } a non-negative safe integer; anything else → null", () => {
    expect(parseSlackScrubCursor({ afterId: 0 })).toEqual({ afterId: 0 });
    expect(parseSlackScrubCursor({ afterId: 4812, done: [1] })).toEqual({ afterId: 4812 });
    for (const raw of [null, {}, { afterId: -1 }, { afterId: 1.5 }, { afterId: "7" }, { afterId: Number.MAX_SAFE_INTEGER + 2 }, [3]]) {
      expect(parseSlackScrubCursor(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("the fake itself (§5.19: the seams areas B-E rely on)", () => {
  it("mutations() counts writes (insert / update / delete and RPCs 1-7), never reads or the pure helpers", async () => {
    const client = db.client as SupabaseClient;
    await client.from("exec_briefs").select("id");
    await db.rpc("exec_brief_ref_array", { p_content: content(), p_key: "threadIds" });
    await db.rpc("exec_brief_item_hit", { p_item: item("b1", { threadIds: ["t"] }), p_thread_ids: ["t"], p_slack_keys: [], p_channels: [], p_all_slack: false });
    expect(db.mutations()).toBe(0);
    await addBrief("built");
    await store.scrubBriefsForThreads(P, ["t_x"]);
    await store.markFallbackDmDeleted(`eb_${hex(5)}`);
    expect(db.mutations()).toBe(3);
  });

  it("failNext matches a table, an RPC or '<kind>:<table>' once; missing 'table.column' → 42703 on a select, PGRST204 on a write", async () => {
    const client = db.client as SupabaseClient;
    const b = await addBrief("built");
    db.failNext("update:exec_briefs", "40001");
    expect((await client.from("exec_briefs").select("id")).error).toBeNull();
    expect((await client.from("exec_briefs").update({ error_code: "x" }).eq("id", b.id)).error).toMatchObject({ code: "40001" });
    expect((await client.from("exec_briefs").update({ error_code: "x" }).eq("id", b.id)).error).toBeNull();
    db.missing.add("exec_briefs.content");
    expect((await client.from("exec_briefs").select("id,content")).error).toMatchObject({ code: "42703" });
    expect((await client.from("exec_briefs").update({ content: null }).eq("id", b.id)).error).toMatchObject({ code: "PGRST204" });
    db.missing.add("exec_brief_scrub_threads");
    expect((await db.rpc("exec_brief_scrub_threads", { p_principal: "ep_1", p_thread_ids: ["t"] })).error).toMatchObject({ code: "PGRST202" });
  });

  it("before() runs ahead of a request (another writer); an aborted signal answers postgrest-js's abort result; count: exact counts before limit", async () => {
    const b = await addBrief("building");
    use({
      tables: { exec_briefs: [db.tables.exec_briefs[0]] },
      before: (call, fdb) => {
        if (call.kind === "rpc" && call.target === "exec_brief_finish_build") fdb.tables.exec_briefs[0].rev = 2;
      }
    });
    expect(await store.finishBuild(P, finishInput(String(b.id)))).toEqual({ outcome: "conflict", rev: 2, status: "building" });
    const client = db.client as SupabaseClient;
    const controller = new AbortController();
    controller.abort();
    expect((await client.from("exec_briefs").select("id").abortSignal(controller.signal)).error).toMatchObject({ code: "" });
    await addBrief("built");
    await addBrief("built");
    const counted = await client.from("exec_briefs").select("id", { count: "exact" }).limit(1);
    expect([counted.count, (counted.data as Row[]).length]).toEqual([3, 1]);
  });

  it("the CHECKs, NOT NULLs, unique keys, the check-in FK and its cascade", async () => {
    const client = db.client as SupabaseClient;
    const b = await addBrief("delivered");
    expect((await client.from("exec_briefs").insert({ principal_id: "ep_1", local_date: b.local_date, tz: "UTC", scheduled_at: SCHED.toISOString(), status: "building",
      content_expires_at: CONTENT_EXP.toISOString(), expires_at: ROW_EXP.toISOString() })).error).toMatchObject({ code: "23505", message: expect.stringContaining("exec_briefs_day_key") });
    expect((await client.from("exec_briefs").insert({ principal_id: "ep_1", local_date: nextDate(), tz: "UTC", status: "building",
      content_expires_at: CONTENT_EXP.toISOString(), expires_at: ROW_EXP.toISOString() })).error).toMatchObject({ code: "23502" });
    expect((await client.from("exec_brief_checkins").insert({ brief_id: `eb_${hex(77)}`, principal_id: "ep_1", local_date: "2026-11-09", brief_rev: 1,
      recipient_user_id: "u", recipient_slack_id: "U0X", text: "hi", expires_at: at(1000), purge_at: at(2000) })).error).toMatchObject({ code: "23503" });
    await addCheckin(b);
    await client.from("exec_briefs").delete().eq("id", b.id);
    expect(db.tables.exec_brief_checkins).toEqual([]);
  });
});
