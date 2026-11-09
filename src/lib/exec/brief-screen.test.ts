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
  // The facade, or (h.facade false) a build where P7a's facade doesn't carry listPurgeLog.
  return { get listPurgeLog() { return h.facade ? listPurgeLog : undefined; }, __listPurgeLog: listPurgeLog };
});

import { BRIEF_TEXT_SENTINELS, assertNoBriefText, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import { NO_SCREEN, catchUpBriefScrubs, purgeLogScrubQuery, screenBriefContent, withholdAllEmail } from "@/lib/exec/brief-screen";
import { briefDmToView } from "@/lib/exec/brief-slack-ui";
import { __resetBriefStoreForTests } from "@/lib/exec/brief-store";
import type { BriefContent, BriefItem, BriefPendingLine, BriefTopItem } from "@/lib/exec/brief-types";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
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
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const settings: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id };
const NOW = new Date("2026-11-06T13:30:00.000Z");
const TZ = "America/New_York";
const listPurgeLog = (slackReading as unknown as { __listPurgeLog: ReturnType<typeof vi.fn> }).__listPurgeLog;
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
  vi.mocked(getSyncState).mockResolvedValue({ value: { afterId: 4 }, rev: 3 });
  listPurgeLog.mockReset().mockResolvedValue([]);
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
    const threadScrubs = db.calls.filter((x) => x.kind === "rpc" && x.target === "exec_brief_scrub_threads");
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
    db.failNext("exec_brief_scrub_slack", "XX000");
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
