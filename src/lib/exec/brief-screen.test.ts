import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const h = vi.hoisted(() => ({ facade: true }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/sources/mail", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/mail")>()), loadScreeningPolicy: vi.fn() }));
vi.mock("@/lib/exec/email-store", () => ({ listThreadScreenRows: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", () => ({ slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/intake-screen", () => ({ loadIntakeScreeningPolicy: vi.fn(), restrictedIntakeTaskIds: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => {
  const listPurgeLog = vi.fn();
  // P9 (Area C): F11's channel read and F4's opt-out list, behind the same switch.
  const listIntelChannels = vi.fn();
  const listAuthorOptouts = vi.fn();
  // The facade, or (h.facade false) a build where P7a's facade doesn't carry listPurgeLog (nor the two P9 readers).
  return {
    get listPurgeLog() { return h.facade ? listPurgeLog : undefined; }, __listPurgeLog: listPurgeLog,
    get listIntelChannels() { return h.facade ? listIntelChannels : undefined; }, __listIntelChannels: listIntelChannels,
    get listAuthorOptouts() { return h.facade ? listAuthorOptouts : undefined; }, __listAuthorOptouts: listAuthorOptouts
  };
});

import { BRIEF_TEXT_SENTINELS, assertNoBriefText, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import {
  NO_SCREEN, OPTOUT_SCRUB_WINDOW_MS, applyBriefOptoutScrubs, catchUpBriefScrubs, parseBriefOptoutState, purgeLogScrubQuery, screenBriefContent, slackLineShown,
  withholdAllEmail
} from "@/lib/exec/brief-screen";
import { briefDmToView } from "@/lib/exec/brief-slack-ui";
import { __resetBriefStoreForTests } from "@/lib/exec/brief-store";
import type { BriefContent, BriefItem, BriefPendingLine, BriefTopItem } from "@/lib/exec/brief-types";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import type { ChannelRow } from "@/lib/exec/slack-read-types";
import { optoutFingerprint } from "@/lib/exec/slack-redact";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import * as slackReading from "@/lib/exec/slack-reading";
import { loadScreeningPolicy } from "@/lib/exec/sources/mail";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import type { ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 contract §5.13b BS01-BS07 (C16, C31; intel-13, intel-14; Area C): the one render-time screen and the post-write catch-up, over
// the standalone brief store fake (§5.19) with the reads mocked at their module boundaries. BS08 (the page and the card call the
// screen) tests Area E's brief-view.ts and is E's.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const settings: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id };
const NOW = new Date("2026-11-06T13:30:00.000Z");
const TZ = "America/New_York";
const listPurgeLog = (slackReading as unknown as { __listPurgeLog: ReturnType<typeof vi.fn> }).__listPurgeLog;
const listIntelChannels = (slackReading as unknown as { __listIntelChannels: ReturnType<typeof vi.fn> }).__listIntelChannels;
const listAuthorOptouts = (slackReading as unknown as { __listAuthorOptouts: ReturnType<typeof vi.fn> }).__listAuthorOptouts;
/** P9 F11: a P7a channel row (watched, standard, a member, never left) unless over says otherwise. */
const channelRow = (channelId: string, over: Partial<ChannelRow> = {}): ChannelRow => ({
  channelId, installationId: "esi_00000000000000000000000000000001", convType: "channel", class: "standard", denyReason: null, hubKind: null,
  financeName: false, watchState: "watched", muteSource: null, watchSetByOwnerAt: null, name: null, imUserId: null, isMember: true, isPrivate: false,
  isExtShared: false, extEver: false, isArchived: false, histWatermarkTs: null, deepSweptAt: null, sweptAt: null, lastEventTs: null, lastActivityTs: null,
  activity30d: null, probedAt: null, classifiedAt: null, leftAt: null, updatedAt: "2026-11-06T13:00:00.000Z", ...over
});
/** The channel rows listIntelChannels answers (by id); a missing id = no row (deny rows are never returned either). */
let channelRows: Map<string, ChannelRow>;
/** brief/optouts as stored (the cursor of brief/slack-scrub stays { afterId: 4 }). */
let optoutState: unknown;
const tsAt = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;
const TS_A = tsAt("2026-11-06T04:30:00.000Z");   // 23:30 on Nov 5 in New York

const screenRow = (threadId: string, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow =>
  ({ threadId, accountId: "acc_1", state: "triaged", screenHashes: [], screenTruncated: false, screenedPolicyHash: "h1", ...over });

function line(id: string, over: Partial<BriefItem> = {}): BriefItem {
  return { id, text: `Line ${id} ${BRIEF_TEXT_SENTINELS.briefLine}`, kind: "fact", basis: "ai", band: "high", aliases: [`i${id.slice(1)}`],
    fps: [`fp:${id}`], refs: [{ system: "dd", id: "/x", url: "https://operations.scaledai.org/x", label: "x", class: "internal" }],
    threadIds: [], slackKeys: [], slackChannels: [], ...over };
}
const pend = (fp: string, over: Partial<BriefPendingLine> = {}): BriefPendingLine =>
  ({ fp, title: `Pending ${fp}`, band: "normal", since: null, refs: [], threadIds: [], slackKeys: [], slackChannels: [], ...over });
const top = (alias: string, itemId: string | null, over: Partial<BriefTopItem> = {}): BriefTopItem =>
  ({ itemId, alias, fp: `fp:${alias}`, title: `Top ${alias}`, next: null, refs: [], threadIds: [], slackKeys: [], slackChannels: [], ...over });

function content(): BriefContent {
  const items = [
    line("b1", { threadIds: ["th_bad"] }),
    line("b2", { threadIds: ["th_ok"] }),
    line("b3", { slackKeys: [`m:C0OPS0001:${TS_A}`], slackChannels: ["C0OPS0001"] }),
    line("b4", { slackKeys: ["d:C0OPS0001:2026-11-05"], slackChannels: ["C0OPS0001"] }),
    line("b5")
  ];
  const sections = [
    { key: "emails", state: "ok", stateNote: null, items: items.slice(0, 2), pending: [pend("email:thread:th_bad:m", { threadIds: ["th_bad"] })], unchanged: 0, more: 0, stats: {} },
    { key: "slack", state: "ok", stateNote: null, items: items.slice(2, 4), pending: [pend("slack:msg:C0OPS0001:1.2", { slackChannels: ["C0OPS0001"], slackKeys: ["m:C0OPS0001:1.2"] })],
      unchanged: 0, more: 0, stats: {} },
    { key: "work", state: "ok", stateNote: null, items: items.slice(4), pending: [], unchanged: 1, more: 0, stats: {} }
  ] as BriefContent["sections"];
  return {
    v: 1, localDate: "2026-11-06", tz: TZ, rev: 1, builtAt: NOW.toISOString(), trigger: "schedule", mode: "ai", modeReason: null, top3Fallback: false,
    headline: `Headline ${BRIEF_TEXT_SENTINELS.briefLine}`, sections,
    top3: [top("i1", "b1", { threadIds: ["th_bad"] }), top("i3", "b3", { slackChannels: ["C0OPS0001"] }), top("i5", "b5"), top("i9", null, { threadIds: ["th_gone"] })],
    novelty: {}, counts: { new: 5, changed: 0, escalated: 0, pending: 2, unchanged: 1, restrictedEmail: 0, slackUnanswered: 1 }, failures: []
  };
}

let db: FakeBriefDb;
let consoleSpy: ReturnType<typeof captureConsole>;
beforeEach(() => {
  h.facade = true;
  __resetBriefStoreForTests();
  db = createFakeBriefDb({ now: () => NOW });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: "h1" });
  vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => {
    const m = new Map<string, ThreadScreenRow>();
    for (const id of ids) {
      if (id === "th_gone") continue;
      m.set(id, screenRow(id, id === "th_bad" ? { state: "restricted_hidden" } : {}));
    }
    return m;
  });
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(loadIntakeScreeningPolicy).mockReset().mockResolvedValue({ rules: [], hash: "h1" });
  vi.mocked(restrictedIntakeTaskIds).mockReset().mockResolvedValue(new Map());
  // The sweep's scrub cursor, and (P9 F4) the brief's own opt-out state, each under its key (parsed as the real store does).
  optoutState = undefined;
  vi.mocked(getSyncState).mockReset().mockImplementation((async (_p: unknown, _s: unknown, key: string, parse: (raw: unknown) => unknown) => {
    if (key === "slack-scrub") return { value: { afterId: 4 }, rev: 3 };
    if (key === "optouts" && optoutState !== undefined) {
      const value = parse(optoutState);
      return value === null ? null : { value, rev: 2 };
    }
    return null;
  }) as never);
  vi.mocked(putSyncState).mockReset().mockImplementation(async (_p, _s, key, value) => {
    if (key === "optouts") optoutState = structuredClone(value);
  });
  listPurgeLog.mockReset().mockResolvedValue([]);
  channelRows = new Map(["C0OPS0001", "C0SAFE001"].map((id) => [id, channelRow(id)]));
  listIntelChannels.mockReset().mockImplementation(async (_p: unknown, o?: { channelIds?: string[] }) =>
    (o?.channelIds ?? []).flatMap((id) => (channelRows.has(id) ? [channelRows.get(id)!] : [])));
  listAuthorOptouts.mockReset().mockResolvedValue([]);
  consoleSpy = captureConsole();
});
afterEach(() => {
  assertNoBriefText(consoleSpy.calls(), { label: "console" });
});

describe("BS01 purgeLogScrubQuery (C16)", () => {
  it("message rows of every reason → message and digest keys; conversation → channels; any reading row → all", () => {
    const reasons = ["deleted_event", "deleted_absent", "deleted_tombstone", "hub", "author_optout"];
    const rows = reasons.map((reason, n) => ({ scope: "message" as const, channelId: `C0CH${n}AAA`, ts: TS_A, reason }));
    const q = purgeLogScrubQuery(rows, TZ);
    for (let n = 0; n < reasons.length; n++) {
      expect(q.slackKeys).toContain(`m:C0CH${n}AAA:${TS_A}`);
      expect(q.slackKeys).toContain(`d:C0CH${n}AAA:2026-11-05`);   // 23:30 the evening before, in the brief zone
    }
    expect(q).toMatchObject({ channels: [], all: false });
    expect(purgeLogScrubQuery([{ scope: "conversation", channelId: "C0OPS0001", ts: null }], TZ)).toEqual({ slackKeys: [], channels: ["C0OPS0001"], all: false });
    expect(purgeLogScrubQuery([{ scope: "message", channelId: "C0A1", ts: TS_A }, { scope: "reading", channelId: null, ts: null }], TZ).all).toBe(true);
  });

  it("the digest date follows the brief zone across midnight and DST", () => {
    const key = (iso: string) => purgeLogScrubQuery([{ scope: "message", channelId: "C0A1", ts: tsAt(iso) }], TZ).slackKeys[1];
    expect(key("2026-11-06T05:00:00.000Z")).toBe("d:C0A1:2026-11-06");   // midnight EST
    expect(key("2026-11-06T04:59:59.000Z")).toBe("d:C0A1:2026-11-05");
    expect(key("2026-11-01T05:30:00.000Z")).toBe("d:C0A1:2026-11-01");   // 01:30 EDT, the fall-back morning
    expect(key("2026-11-01T03:30:00.000Z")).toBe("d:C0A1:2026-10-31");
    expect(key("2026-03-08T07:30:00.000Z")).toBe("d:C0A1:2026-03-08");   // 03:30 EDT, the spring-forward morning
    expect(key("2026-03-08T04:30:00.000Z")).toBe("d:C0A1:2026-03-07");
    expect(purgeLogScrubQuery([{ scope: "message", channelId: "C0A1", ts: tsAt("2026-11-06T05:00:00.000Z") }], "Europe/London").slackKeys[1])
      .toBe("d:C0A1:2026-11-06");
  });

  it("a ts that can't be dated scrubs its channel (fail closed); a malformed channel is ignored", () => {
    expect(purgeLogScrubQuery([{ scope: "message", channelId: "C0A1", ts: "not-a-ts" }], TZ)).toEqual({ slackKeys: ["m:C0A1:not-a-ts"], channels: ["C0A1"], all: false });
    expect(purgeLogScrubQuery([{ scope: "conversation", channelId: "bad channel", ts: null }], TZ)).toEqual({ slackKeys: [], channels: [], all: false });
  });
});

describe("BS02-BS04 screenBriefContent (C31)", () => {
  it("BS02 a line citing a withheld thread or one with no stored row → restricted; the headline hidden; untouched content → NO_SCREEN", async () => {
    const r = await screenBriefContent(principal, settings, content(), { now: NOW });
    if (!r.ok) throw new Error("expected ok");
    expect([...r.screen.items]).toEqual([["b1", "restricted"]]);
    expect([...r.screen.pending]).toEqual(["email:thread:th_bad:m"]);
    expect([...r.screen.top3].sort()).toEqual(["i1", "i9"]);   // i1 cites th_bad (and its line is withheld); i9's thread has no row
    expect(r.screen.withheldThreadIds).toEqual(["th_bad", "th_gone"]);
    expect(r.screen.hideHeadline).toBe(true);
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map(ids.map((id) => [id, screenRow(id)])));
    const clean = await screenBriefContent(principal, settings, content(), { now: NOW });
    expect(clean).toEqual({ ok: true, screen: NO_SCREEN });
    expect(listThreadScreenRows).toHaveBeenCalledWith(principal, ["th_bad", "th_gone", "th_ok"], expect.anything());
  });

  it("BS03 slackIntelState not ok → every Slack-derived item, pending line and top-3 entry withheld 'slack'; ok → none", async () => {
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map(ids.map((id) => [id, screenRow(id)])));
    vi.mocked(slackIntelState).mockResolvedValue("reading_off");
    const r = await screenBriefContent(principal, settings, content(), { now: NOW });
    if (!r.ok) throw new Error("expected ok");
    expect([...r.screen.items]).toEqual([["b3", "slack"], ["b4", "slack"]]);
    expect([...r.screen.pending]).toEqual(["slack:msg:C0OPS0001:1.2"]);
    expect([...r.screen.top3]).toEqual(["i3"]);
    expect(r.screen.withheldThreadIds).toEqual([]);
    expect(slackIntelState).toHaveBeenCalledTimes(1);
    vi.mocked(slackIntelState).mockResolvedValue("ok");
    expect(await screenBriefContent(principal, settings, content(), { now: NOW })).toEqual({ ok: true, screen: NO_SCREEN });
  });

  it("BS02b (fixer security-5) an intake approvals line is re-screened by its task ids (P5a's S5 now): a withheld task → restricted; no intake line → no read", async () => {
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map(ids.map((id) => [id, screenRow(id)])));
    expect(await screenBriefContent(principal, settings, content(), { now: NOW })).toEqual({ ok: true, screen: NO_SCREEN });
    expect(restrictedIntakeTaskIds).not.toHaveBeenCalled();
    const taskRef = (id: string) => ({ system: "dd" as const, id, url: `https://operations.scaledai.org/tasks/${id}`, label: `Draft ${id}`, class: "internal" as const });
    const c = content();
    c.sections[2].items.push(line("b6", { fps: ["brief:approval-items:draft_tasks"], refs: [taskRef("t_dr1"), taskRef("t_dr2"),
      { system: "dd", id: "/approvals", url: "https://operations.scaledai.org/approvals", label: "Approvals", class: "internal" }] }));
    c.sections[2].items.push(line("b7", { fps: ["brief:approval-items:email_drafts"], refs: [taskRef("t_mail")] }));
    c.top3.push(top("i6", null, { fp: "brief:approval-items:draft_tasks", refs: [taskRef("t_dr2")] }));
    vi.mocked(restrictedIntakeTaskIds).mockResolvedValue(new Map([["t_dr2", "restricted_sender"]]));
    const r = await screenBriefContent(principal, settings, c, { now: NOW });
    if (!r.ok) throw new Error("expected ok");
    expect([...r.screen.items]).toEqual([["b6", "restricted"]]);
    expect([...r.screen.top3]).toEqual(["i6"]);
    expect(r.screen).toMatchObject({ withheldThreadIds: [], hideHeadline: true });
    expect(vi.mocked(restrictedIntakeTaskIds).mock.calls[0][1]).toEqual(["t_dr1", "t_dr2"]);   // draft_tasks / fb_proofs lines only
    expect(vi.mocked(restrictedIntakeTaskIds).mock.calls[0][2]).toEqual({ rules: [], hash: "h1" });
    // The screen failing (withholdAllEmail) withholds the intake line too.
    expect([...withholdAllEmail(c, true).items].map(([id]) => id)).toContain("b6");
  });

  it("BS04 any read failure → screen_unavailable; nothing written; the caller's abort rethrows", async () => {
    vi.mocked(loadScreeningPolicy).mockRejectedValueOnce(new Error("rules"));
    expect(await screenBriefContent(principal, settings, content(), { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
    vi.mocked(listThreadScreenRows).mockRejectedValueOnce(new Error("rows"));
    expect(await screenBriefContent(principal, settings, content(), { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
    vi.mocked(slackIntelState).mockRejectedValueOnce(new Error("state"));
    expect(await screenBriefContent(principal, settings, content(), { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
    expect(db.mutations()).toBe(0);
    const c = new AbortController();
    const reason = new Error("stop");
    vi.mocked(loadScreeningPolicy).mockImplementationOnce(async () => {
      c.abort(reason);
      throw reason;
    });
    await expect(screenBriefContent(principal, settings, content(), { now: NOW, signal: c.signal })).rejects.toBe(reason);
  });
});

describe("BS05 withholdAllEmail", () => {
  it("every item with thread ids withheld 'restricted'; Slack ones only when slackOk is false; nothing to scrub into the row", () => {
    const s = withholdAllEmail(content(), true);
    expect([...s.items]).toEqual([["b1", "restricted"], ["b2", "restricted"]]);
    expect([...s.pending]).toEqual(["email:thread:th_bad:m"]);
    expect([...s.top3].sort()).toEqual(["i1", "i9"]);
    expect(s).toMatchObject({ withheldThreadIds: [], hideHeadline: true });
    const both = withholdAllEmail(content(), false);
    expect([...both.items]).toEqual([["b1", "restricted"], ["b2", "restricted"], ["b3", "slack"], ["b4", "slack"]]);
    expect(withholdAllEmail({ ...content(), sections: [], top3: [] }, false)).toBe(NO_SCREEN);
  });
});

/** The day's row in the fake store, its ref arrays from the content (as the finish RPC writes them). */
async function seedBrief(c: BriefContent = content()): Promise<string> {
  const all = [...c.sections.flatMap((s) => [...s.items, ...s.pending]), ...c.top3];
  const u = (k: "threadIds" | "slackKeys" | "slackChannels") => [...new Set(all.flatMap((x) => x[k]))].sort();
  const row: Row = {
    principal_id: principal.id, local_date: "2026-11-06", tz: TZ, scheduled_at: "2026-11-06T13:00:00.000Z", status: "built", content: c,
    ref_thread_ids: u("threadIds"), ref_slack_keys: u("slackKeys"), ref_slack_channels: u("slackChannels"), mode: "ai", built_at: NOW.toISOString(),
    novelty_marked_at: NOW.toISOString(), content_expires_at: "2026-12-07T05:00:00.000Z", expires_at: "2027-05-06T04:00:00.000Z"
  };
  const { data, error } = await (db.client as SupabaseClient).from("exec_briefs").insert(row).select("id");
  if (error) throw new Error(`seed: ${error.code}`);
  return (data as Row[])[0].id as string;
}
const stored = (id: string) => db.tables.exec_briefs.find((b) => b.id === id)!;
const storedContent = (id: string) => stored(id).content as BriefContent;

describe("BS06 catchUpBriefScrubs (intel-13)", () => {
  it("reads the purge log from the sweep's cursor without moving it, scrubs, then scrubs the withheld threads into the row and returns it", async () => {
    const id = await seedBrief();
    listPurgeLog.mockResolvedValueOnce([{ id: 5, scope: "message", channelId: "C0OPS0001", ts: TS_A, reason: "deleted_event", createdAt: NOW.toISOString() }]);
    const r = await catchUpBriefScrubs(principal, settings, id, { now: NOW });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(getSyncState).toHaveBeenCalledWith(principal, "brief", "slack-scrub", expect.any(Function), expect.anything());
    expect(listPurgeLog).toHaveBeenCalledWith(principal, 4, 200);
    expect(putSyncState).not.toHaveBeenCalled();
    const c = storedContent(id);
    const items = c.sections.flatMap((s) => s.items);
    // The Slack message and its day's digest are gone, and so is the restricted thread's line (scrubbed into the row).
    expect(items.find((i) => i.id === "b3")).toMatchObject({ text: BRIEF_COPY.removedSlack, scrubbed: true, slackKeys: [], refs: [] });
    expect(items.find((i) => i.id === "b4")).toMatchObject({ text: BRIEF_COPY.removedSlack, scrubbed: true });
    expect(items.find((i) => i.id === "b1")).toMatchObject({ text: BRIEF_COPY.removedRestricted, scrubbed: true, threadIds: [] });
    expect(items.find((i) => i.id === "b2")!.text).toContain("Line b2");
    expect(c.headline).toBeNull();
    expect(c.headlineScrubbed).toBe(true);
    expect(stored(id).ref_thread_ids).toEqual(["th_ok"]);
    expect(stored(id).ref_slack_keys).toEqual(["m:C0OPS0001:1.2"]);   // only the pending line's other message is left
    const threadScrubs = db.calls.filter((x) => x.kind === "rpc" && x.target === "exec_brief_scrub_threads_v2");
    expect(threadScrubs.map((x) => (x.payload as { p_thread_ids: string[] }).p_thread_ids)).toEqual([["th_bad", "th_gone"]]);
    // The returned row is the fresh one, and its screen is clean now.
    expect(r.row.content?.headline).toBeNull();
    expect(r.screen).toBe(NO_SCREEN);
  });

  it("re-reads rows above the cursor a pass already scrubbed (idempotent, no error); pages through full batches", async () => {
    const id = await seedBrief();
    const log = [{ id: 5, scope: "message" as const, channelId: "C0OPS0001", ts: TS_A, reason: "hub", createdAt: NOW.toISOString() }];
    listPurgeLog.mockResolvedValue(log);
    expect((await catchUpBriefScrubs(principal, settings, id, { now: NOW })).ok).toBe(true);
    const first = JSON.stringify(storedContent(id));
    expect((await catchUpBriefScrubs(principal, settings, id, { now: NOW })).ok).toBe(true);
    expect(JSON.stringify(storedContent(id))).toBe(first);
    expect(listPurgeLog.mock.calls.map((c) => c[1])).toEqual([4, 4]);
    // Full batches page on, from the local pointer; a short one ends the read.
    listPurgeLog.mockReset();
    const full = Array.from({ length: 200 }, (_, n) => ({ id: 10 + n, scope: "conversation" as const, channelId: "C0ZZZ0001", ts: null, reason: "left",
      createdAt: NOW.toISOString() }));
    listPurgeLog.mockResolvedValueOnce(full).mockResolvedValueOnce([]);
    expect((await catchUpBriefScrubs(principal, settings, id, { now: NOW })).ok).toBe(true);
    expect(listPurgeLog.mock.calls.map((c) => c[1])).toEqual([4, 209]);
  });

  it("a scrub or read error → screen_unavailable; an unknown brief → not_found", async () => {
    const id = await seedBrief();
    listPurgeLog.mockResolvedValueOnce([{ id: 5, scope: "reading", channelId: null, ts: null, reason: "reading_purged", createdAt: NOW.toISOString() }]);
    db.failNext("exec_brief_scrub_slack_v2", "XX000");
    expect(await catchUpBriefScrubs(principal, settings, id, { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
    listPurgeLog.mockRejectedValueOnce(new Error("log read"));
    expect(await catchUpBriefScrubs(principal, settings, id, { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
    vi.mocked(loadScreeningPolicy).mockRejectedValueOnce(new Error("rules"));
    expect(await catchUpBriefScrubs(principal, settings, id, { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
    expect(await catchUpBriefScrubs(principal, settings, `eb_${"f".repeat(32)}`, { now: NOW })).toEqual({ ok: false, reason: "not_found" });
  });

  it("the facade missing → the Slack step is skipped, the email step still runs", async () => {
    const id = await seedBrief();
    h.facade = false;
    const r = await catchUpBriefScrubs(principal, settings, id, { now: NOW });
    expect(r.ok).toBe(true);
    expect(listPurgeLog).not.toHaveBeenCalled();
    expect(getSyncState).not.toHaveBeenCalled();
    const items = storedContent(id).sections.flatMap((s) => s.items);
    expect(items.find((i) => i.id === "b3")!.text).toContain("Line b3");      // Slack untouched
    expect(items.find((i) => i.id === "b1")!.text).toBe(BRIEF_COPY.removedRestricted);
  });
});

describe("BS07 the DM view with a screen (Area D's briefDmToView)", () => {
  it("withheld lines render the removed text with no link; withheld pending and top-3 entries are absent; no headline", async () => {
    const r = await screenBriefContent(principal, settings, content(), { now: NOW });
    if (!r.ok) throw new Error("expected ok");
    const v = briefDmToView(content(), { tz: TZ, briefHref: "https://operations.scaledai.org/executive/brief", screen: r.screen });
    expect(v.headline).toBeNull();
    const emails = v.sections.find((s) => s.key === "emails")!;
    expect(emails.lines[0]).toMatchObject({ text: BRIEF_COPY.removedRestricted, href: null });
    expect(emails.lines[1].text).toContain("Line b2");
    expect(emails.pending).toEqual([]);
    expect(v.top3.map((t) => t.title)).toEqual(["Top i3", "Top i5"]);
    const plain = briefDmToView(content(), { tz: TZ, briefHref: "https://operations.scaledai.org/executive/brief", screen: NO_SCREEN });
    expect(plain.headline).toContain("Headline");
    expect(plain.sections.find((s) => s.key === "emails")!.lines[0].text).toContain("Line b1");
    expect(plain.top3.map((t) => t.title)).toEqual(["Top i1", "Top i3", "Top i5"]);   // the view shows at most 3
  });
});

// ---------------------------------------------------------------------------
// P9 (Area C): F7 (pinned accounts), F11 (the channel rows now), F4 (author opt-outs vs digest lines)
// ---------------------------------------------------------------------------

describe("BS-P9-F7 a thread row on an account that is no longer pinned (P3 ui-3)", () => {
  it("BS-P9-F7: its line, pending line and top-3 entry are withheld 'unavailable' (render only: not in withheldThreadIds, never scrubbed); restricted wins; a pinned row shows", async () => {
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map(ids.map((id) =>
      [id, screenRow(id, id === "th_ok" ? { accountId: "acc_unpinned" } : id === "th_bad" ? { accountId: "acc_unpinned", state: "restricted_hidden" } : {})])));
    const c = content();
    c.sections[0].pending.push(pend("email:thread:th_ok:m", { threadIds: ["th_ok"] }));
    c.top3.push(top("i2", null, { threadIds: ["th_ok"] }));
    const r = await screenBriefContent(principal, settings, c, { now: NOW });
    if (!r.ok) throw new Error("expected ok");
    expect(r.screen.items.get("b2")).toBe("unavailable");
    expect(r.screen.items.get("b1")).toBe("restricted");   // a restricted row on an unpinned account is still restricted
    expect(r.screen.pending.has("email:thread:th_ok:m")).toBe(true);
    expect(r.screen.top3.has("i2")).toBe(true);
    expect(r.screen.withheldThreadIds).toEqual(["th_bad"]);   // th_ok is not scrubbed into the row
    expect(r.screen.hideHeadline).toBe(true);
    const dm = briefDmToView(c, { tz: TZ, briefHref: "https://operations.scaledai.org/executive/brief", screen: r.screen });
    expect(dm.sections.find((x) => x.key === "emails")!.lines[1]).toMatchObject({ text: BRIEF_COPY.removedUnavailable, href: null });
    // The catch-up scrubs only the restricted threads: th_ok's line stays in the row (a re-pin shows it again).
    const id = await seedBrief(c);
    const caught = await catchUpBriefScrubs(principal, settings, id, { now: NOW });
    if (!caught.ok) throw new Error("expected ok");
    expect(storedContent(id).sections[0].items.find((i) => i.id === "b2")!.text).toContain("Line b2");
    expect(caught.screen.items.get("b2")).toBe("unavailable");
    // Pinned again: shown.
    const pinned = principalFromRows({ id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: ["acc_1", "acc_unpinned"], slack_team_id: null,
      slack_user_id: null }, { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" }, null)!;
    const again = await screenBriefContent(pinned, settings, c, { now: NOW });
    if (!again.ok) throw new Error("expected ok");
    expect(again.screen.items.has("b2")).toBe(false);
  });
});

describe("BS-P9-F11 the cited Slack channel rows, re-read at render (listIntelChannels, once)", () => {
  /** content() plus a line, a pending line and a top-3 entry on a second, untouched channel. */
  function twoChannels(): BriefContent {
    const c = content();
    c.sections[1].items.push(line("b6", { slackKeys: [`m:C0SAFE001:${TS_A}`], slackChannels: ["C0SAFE001"] }));
    c.sections[1].pending.push(pend("slack:msg:C0SAFE001:1.3", { slackChannels: ["C0SAFE001"], slackKeys: ["m:C0SAFE001:1.3"] }));
    c.top3.push(top("i6", "b6", { slackChannels: ["C0SAFE001"] }));
    return c;
  }
  const clean = () => vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map(ids.map((id) => [id, screenRow(id)])));
  const changes: [string, Partial<ChannelRow> | null][] = [
    ["renamed into a finance name", { financeName: true }],
    ["classified finance", { class: "finance" }],
    ["reset to unclassified (a leads rename)", { class: "unclassified" }],
    ["now a hub", { class: "hub" }],
    ["left", { leftAt: "2026-11-06T12:00:00.000Z" }],
    ["set to Don't watch", { watchState: "unwatched", watchSetByOwnerAt: "2026-11-06T12:00:00.000Z" }],
    ["gone (or deny: never listed)", null]
  ];
  for (const [what, over] of changes) {
    it(`BS-P9-F11: C ${what} after the build → C's item and digest lines, its pending line and its top-3 entry withheld 'slack', the headline hidden; another channel's lines stay`, async () => {
      clean();
      if (over === null) channelRows.delete("C0OPS0001");
      else channelRows.set("C0OPS0001", channelRow("C0OPS0001", over));
      const r = await screenBriefContent(principal, settings, twoChannels(), { now: NOW });
      if (!r.ok) throw new Error("expected ok");
      expect([...r.screen.items]).toEqual([["b3", "slack"], ["b4", "slack"]]);
      expect([...r.screen.pending]).toEqual(["slack:msg:C0OPS0001:1.2"]);
      expect([...r.screen.top3]).toEqual(["i3"]);
      expect(r.screen.hideHeadline).toBe(true);
      expect(r.screen.withheldThreadIds).toEqual([]);
      expect(listIntelChannels).toHaveBeenCalledTimes(1);
      expect(listIntelChannels.mock.calls[0][1]).toMatchObject({ channelIds: ["C0OPS0001", "C0SAFE001"] });
    });
  }

  it("BS-P9-F11: a mute passes only a message line in an IM muted by him or by Slack (the stored bypass); a digest line, a channel mention or a finance default mute never", () => {
    const msg = { slackChannels: ["C1"], slackKeys: ["m:C1:1.000100"] };
    const digest = { slackChannels: ["C1"], slackKeys: ["d:C1:2026-11-05"] };
    const at = (over: Partial<ChannelRow>) => new Map([["C1", channelRow("C1", over)]]);
    expect(slackLineShown(msg, at({}))).toBe(true);
    expect(slackLineShown(digest, at({}))).toBe(true);
    expect(slackLineShown(msg, at({ convType: "im", watchState: "muted", muteSource: "owner" }))).toBe(true);
    expect(slackLineShown(msg, at({ convType: "im", watchState: "muted", muteSource: "slack" }))).toBe(true);
    expect(slackLineShown(digest, at({ convType: "im", watchState: "muted", muteSource: "owner" }))).toBe(false);
    expect(slackLineShown(msg, at({ convType: "im", watchState: "muted", muteSource: "default_finance" }))).toBe(false);
    expect(slackLineShown(msg, at({ convType: "channel", watchState: "muted", muteSource: "owner" }))).toBe(false);
    expect(slackLineShown(msg, at({ convType: "mpim", watchState: "muted", muteSource: "owner" }))).toBe(false);
    expect(slackLineShown(msg, at({ convType: "im", watchState: "unwatched", muteSource: "owner" }))).toBe(false);
    expect(slackLineShown(msg, at({ convType: "im", watchState: "muted", muteSource: "owner", financeName: true }))).toBe(false);
    expect(slackLineShown({ slackChannels: ["C1"], slackKeys: [] }, at({ convType: "im", watchState: "muted", muteSource: "owner" }))).toBe(false);
    expect(slackLineShown({ slackChannels: ["C1", "C2"], slackKeys: ["m:C1:1.000100"] }, at({}))).toBe(false);   // C2 has no row
  });

  it("BS-P9-F11: the channel read failing → screen_unavailable; a facade without the reader → every Slack line withheld (fail closed); state not ok → no channel read", async () => {
    clean();
    listIntelChannels.mockRejectedValueOnce(new Error("channels"));
    expect(await screenBriefContent(principal, settings, twoChannels(), { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
    vi.mocked(slackIntelState).mockResolvedValueOnce("reading_off");
    listIntelChannels.mockClear();
    const off = await screenBriefContent(principal, settings, twoChannels(), { now: NOW });
    expect(listIntelChannels).not.toHaveBeenCalled();
    if (!off.ok) throw new Error("expected ok");
    expect([...off.screen.items].map(([id]) => id)).toEqual(["b3", "b4", "b6"]);
    h.facade = false;
    const r = await screenBriefContent(principal, settings, twoChannels(), { now: NOW });
    if (!r.ok) throw new Error("expected ok");
    expect([...r.screen.items]).toEqual([["b3", "slack"], ["b4", "slack"], ["b6", "slack"]]);
    // Nothing cites Slack: no state read, no channel read.
    h.facade = true;
    vi.mocked(slackIntelState).mockClear();
    listIntelChannels.mockClear();
    await screenBriefContent(principal, settings, { ...content(), sections: [content().sections[0]], top3: [] }, { now: NOW });
    expect(slackIntelState).not.toHaveBeenCalled();
    expect(listIntelChannels).not.toHaveBeenCalled();
  });
});

describe("BS-P9-F4 author opt-outs vs digest-derived lines (applyBriefOptoutScrubs; the catch-up runs it)", () => {
  const T0 = NOW.getTime();
  const at = (ms: number) => new Date(T0 + ms);

  it("BS-P9-F4: a new opt-out (an author with no stored message) → the catch-up scrubs every d: line before the screen; the state is stored after the scrub", async () => {
    const id = await seedBrief();
    listAuthorOptouts.mockResolvedValue(["U0ALICE"]);
    const r = await catchUpBriefScrubs(principal, settings, id, { now: NOW });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    const items = storedContent(id).sections.flatMap((x) => x.items);
    expect(items.find((i) => i.id === "b4")).toMatchObject({ text: BRIEF_COPY.removedSlack, scrubbed: true, slackKeys: [] });
    expect(items.find((i) => i.id === "b3")!.text).toContain("Line b3");    // a message line: P7a's purge-log rows cover those
    expect(stored(id).scrubbed_at).toBe(NOW.toISOString());
    expect(optoutState).toEqual({ ...optoutFingerprint(["U0ALICE"]), changedAt: NOW.toISOString() });
    const scrubs = db.calls.filter((x) => x.kind === "rpc" && x.target === "exec_brief_scrub_slack_v2").map((x) => x.payload);
    expect(scrubs).toEqual([{ p_principal: principal.id, p_slack_keys: ["d:C0OPS0001:2026-11-05"], p_channels: [], p_all: false }]);
  });

  it("BS-P9-F4: inside the 30-minute window a brief built later is scrubbed too; after it, nothing; a shrinking set stores its fingerprint and scrubs nothing", async () => {
    listAuthorOptouts.mockResolvedValue(["U0ALICE", "U0BOB"]);
    expect(await applyBriefOptoutScrubs(principal, at(0))).toEqual({ scrubbed: 0, window: true });   // nothing cites a digest yet
    const later = await seedBrief();
    expect(await applyBriefOptoutScrubs(principal, at(5 * 60_000))).toEqual({ scrubbed: 1, window: true });
    expect(storedContent(later).sections[1].items.find((i) => i.id === "b4")!.text).toBe(BRIEF_COPY.removedSlack);
    expect(optoutState).toMatchObject({ changedAt: at(0).toISOString(), count: 2 });
    db.tables.exec_briefs.length = 0;
    const afterWindow = await seedBrief();
    expect(await applyBriefOptoutScrubs(principal, at(OPTOUT_SCRUB_WINDOW_MS))).toEqual({ scrubbed: 0, window: false });
    expect(storedContent(afterWindow).sections[1].items.find((i) => i.id === "b4")!.text).toContain("Line b4");
    // Shrinking: the new fingerprint is stored, no window opens.
    vi.mocked(putSyncState).mockClear();
    listAuthorOptouts.mockResolvedValue(["U0ALICE"]);
    expect(await applyBriefOptoutScrubs(principal, at(OPTOUT_SCRUB_WINDOW_MS + 60_000))).toEqual({ scrubbed: 0, window: false });
    expect(optoutState).toEqual({ ...optoutFingerprint(["U0ALICE"]), changedAt: at(0).toISOString() });
    expect(storedContent(afterWindow).sections[1].items.find((i) => i.id === "b4")!.text).toContain("Line b4");
    // The same set again: nothing written.
    vi.mocked(putSyncState).mockClear();
    await applyBriefOptoutScrubs(principal, at(OPTOUT_SCRUB_WINDOW_MS + 120_000));
    expect(putSyncState).not.toHaveBeenCalled();
  });

  it("BS-P9-F4: a failing scrub stores no state (the next call retries); no opt-out and nothing stored writes nothing; the facade missing → null", async () => {
    await seedBrief();
    listAuthorOptouts.mockResolvedValue(["U0ALICE"]);
    db.failNext("exec_brief_scrub_slack_v2", "XX000");
    await expect(applyBriefOptoutScrubs(principal, NOW)).rejects.toMatchObject({ name: "BriefStoreError" });
    expect(optoutState).toBeUndefined();
    expect(await applyBriefOptoutScrubs(principal, NOW)).toEqual({ scrubbed: 1, window: true });
    expect(optoutState).toMatchObject({ count: 1 });
    optoutState = undefined;
    vi.mocked(putSyncState).mockClear();
    listAuthorOptouts.mockResolvedValue([]);
    expect(await applyBriefOptoutScrubs(principal, NOW)).toEqual({ scrubbed: 0, window: false });
    expect(putSyncState).not.toHaveBeenCalled();
    h.facade = false;
    expect(await applyBriefOptoutScrubs(principal, NOW)).toBeNull();
  });

  it("BS-P9-F4: the catch-up fails closed when the opt-out read fails (screen_unavailable, nothing posted from it)", async () => {
    const id = await seedBrief();
    listAuthorOptouts.mockRejectedValueOnce(new Error("optouts"));
    expect(await catchUpBriefScrubs(principal, settings, id, { now: NOW })).toEqual({ ok: false, reason: "screen_unavailable" });
  });

  it("parseBriefOptoutState: C33's { fp, count } plus changedAt (null or a timestamp); anything else → null", () => {
    expect(parseBriefOptoutState({ fp: "0123456789ab", count: 2, changedAt: NOW.toISOString(), rev: 4 })).toEqual({ fp: "0123456789ab", count: 2, changedAt: NOW.toISOString() });
    expect(parseBriefOptoutState({ fp: "", count: 0 })).toEqual({ fp: "", count: 0, changedAt: null });
    for (const bad of [null, {}, { fp: "xyz", count: 1 }, { fp: "0123456789ab", count: -1 }, { fp: "0123456789ab", count: 1, changedAt: "soon" }]) {
      expect(parseBriefOptoutState(bad)).toBeNull();
    }
  });
});
