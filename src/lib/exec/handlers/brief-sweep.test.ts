import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-reading")>()), listPurgeLog: vi.fn() }));
vi.mock("@/lib/exec/brief-screen", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-screen")>()), purgeLogScrubQuery: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  openActiveInstallation: vi.fn(), recordSlackPost: vi.fn(), recordSlackError: vi.fn(), clearSlackError: vi.fn(), enqueueRevokeCheck: vi.fn()
}));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn(), isJobLive: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUsers: vi.fn() }));

import { assertNoBriefText, BRIEF_TEXT_SENTINELS, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { BOT_TOKEN, BRIEF_ID, briefContent, briefRowSeed, checkinSeed, ctxFor, DM, LOCAL_DATE, openInstallation, PRINCIPAL, TEAM, TZ } from "@/lib/exec/__tests__/brief-d-harness";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import { fakeSlackWorkspace, installFakeSlack, type FakeSlackWorkspace } from "@/lib/exec/__tests__/fake-slack-api";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { BRIEF_COPY, BRIEF_OPS } from "@/lib/exec/brief-copy";
import { purgeLogScrubQuery, type BriefScreen } from "@/lib/exec/brief-screen";
import { briefDmToView, renderBriefDm } from "@/lib/exec/brief-slack-ui";
import { __resetBriefStoreForTests, claimBuild } from "@/lib/exec/brief-store";
import type { BriefContent } from "@/lib/exec/brief-types";
import { BRIEF_SWEEP_JOB_KIND, briefSweepJobHandler, briefSweepScheduledWork, type BriefSweepResult } from "@/lib/exec/handlers/brief-sweep";
import { enqueueJob, isJobLive } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { openActiveInstallation } from "@/lib/exec/slack-install";
import { localDateOfTs } from "@/lib/exec/slack-intel-types";
import { listPurgeLog } from "@/lib/exec/slack-reading";
import { listUsers } from "@/lib/exec/sources/dd";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 §5.13 SW01-SW15 (Area D): exec.brief-sweep. The brief store is real over the standalone fake (its scrub RPCs mirror the
// SQL); P7a's purge log is an in-memory list behind the facade's listPurgeLog (rows can be hidden, to model a transaction that
// commits after a higher id was read); purgeLogScrubQuery (Area C) is mocked with §3.17.7's mapping; the cursor lives in an
// in-memory exec_sync_state.

const NOW = new Date("2026-11-09T13:20:00.000Z");
type LogRow = { id: number; scope: "message" | "conversation" | "reading"; channelId: string | null; ts: string | null; reason: string; createdAt: string; hidden?: boolean };
let log: LogRow[];
let cursor: Map<string, unknown>;
let db: FakeBriefDb;
let ws: FakeSlackWorkspace;
let slack: ReturnType<typeof installFakeSlack>;
let out: ReturnType<typeof captureConsole>;

function useDb(rows: Row[], checkins: Row[] = []): FakeBriefDb {
  db = createFakeBriefDb({ tables: { exec_briefs: rows, exec_brief_checkins: checkins } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const brief = () => db.tables.exec_briefs[0];
const scrubCalls = () => db.calls.filter((c) => c.kind === "rpc" && c.target === "exec_brief_scrub_slack").map((c) => c.payload as Row);
const storedAfterId = () => (cursor.get("slack-scrub") as { afterId: number } | undefined)?.afterId ?? 0;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const msg = (id: number, ts: string, createdAt: string, reason = "deleted_event", channelId = "C0SALES"): LogRow =>
  ({ id, scope: "message", channelId, ts, reason, createdAt });
const sweep = () => briefSweepJobHandler.run(ctxFor(BRIEF_SWEEP_JOB_KIND, {})) as Promise<BriefSweepResult>;

/** A content whose Slack line cites the message SALES_TS. */
const SALES_TS = "1794000000.000100";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  vi.stubEnv("EXEC_TOKEN_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://operations.scaledai.org");
  __resetBriefStoreForTests();
  useDb([briefRowSeed("delivered")]);
  log = [];
  cursor = new Map();
  ws = fakeSlackWorkspace({ tokens: { [BOT_TOKEN]: { userId: "U0BOT", teamId: TEAM, botId: "B0BOT" } } });
  slack = installFakeSlack(ws.handlers);
  for (const m of [notifyOps, listPurgeLog, purgeLogScrubQuery, getSyncState, putSyncState, openActiveInstallation, enqueueJob, isJobLive, listUsers]) {
    vi.mocked(m as (...a: unknown[]) => unknown).mockReset();
  }
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(listPurgeLog).mockImplementation(async (_p, afterId, limit) =>
    log.filter((r) => !r.hidden && r.id > afterId).sort((a, b) => a.id - b.id).slice(0, limit).map(({ hidden: _h, ...r }) => r));
  // §3.17.7's mapping (Area C owns the real one): message rows of any reason → the message and digest keys; conversation → channels; reading → all.
  vi.mocked(purgeLogScrubQuery).mockImplementation((rows, tz) => {
    const keys = new Set<string>();
    const channels = new Set<string>();
    let all = false;
    for (const r of rows) {
      if (r.scope === "reading") all = true;
      else if (r.scope === "conversation" && r.channelId) channels.add(r.channelId);
      else if (r.scope === "message" && r.channelId && r.ts) {
        keys.add(`m:${r.channelId}:${r.ts}`);
        keys.add(`d:${r.channelId}:${localDateOfTs(r.ts, tz)}`);
      }
    }
    return { slackKeys: [...keys], channels: [...channels], all };
  });
  vi.mocked(getSyncState).mockImplementation((async (_p: unknown, _s: unknown, key: string, parse: (raw: unknown) => unknown) => {
    const v = cursor.get(key);
    return v === undefined ? null : { value: parse(v), rev: 1 };
  }) as never);
  vi.mocked(putSyncState).mockImplementation(async (_p, _s, key, value) => {
    cursor.set(key, structuredClone(value));
  });
  vi.mocked(openActiveInstallation).mockResolvedValue(openInstallation());
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(isJobLive).mockResolvedValue(false);
  vi.mocked(listUsers).mockResolvedValue([]);
});
afterEach(() => {
  assertNoBriefText(out.calls(), { label: "console" });
  assertNoBriefText(vi.mocked(notifyOps), { label: "notifyOps" });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("SW01, SW02, SW12 the purge-log feed (C16)", () => {
  it("SW01 message → m: and d: keys; conversation → the channel; reading → all; the cursor moves after the scrub, to the last id", async () => {
    log = [msg(1, SALES_TS, ago(3_600_000)), { id: 2, scope: "conversation", channelId: "C0OPS", ts: null, reason: "left", createdAt: ago(3_600_000) }];
    const r = await sweep();
    expect(r).toMatchObject({ purgeLogRows: 2, cursorAdvanced: 2, failedSteps: [] });
    expect(scrubCalls()).toEqual([{ p_principal: "ep_1", p_slack_keys: [`m:C0SALES:${SALES_TS}`, `d:C0SALES:${localDateOfTs(SALES_TS, TZ)}`], p_channels: ["C0OPS"], p_all: false }]);
    expect(storedAfterId()).toBe(2);
    expect((brief().content as BriefContent).sections[1].items[0]).toMatchObject({ text: BRIEF_COPY.removedSlack, refs: [], scrubbed: true });

    log.push({ id: 3, scope: "reading", channelId: null, ts: null, reason: "reading_purged", createdAt: ago(3_600_000) });
    await sweep();
    expect(scrubCalls().at(-1)).toMatchObject({ p_all: true, p_slack_keys: [], p_channels: [] });
    expect(storedAfterId()).toBe(3);
  });

  it("SW01 the cursor never moves past a scrub that failed", async () => {
    log = [msg(1, SALES_TS, ago(3_600_000))];
    db.failNext("exec_brief_scrub_slack", "53300");
    const r = await sweep();
    expect(r.failedSteps).toEqual(["slackScrub"]);
    expect(storedAfterId()).toBe(0);
    expect(vi.mocked(putSyncState)).not.toHaveBeenCalled();
  });

  it("SW01 650 rows → 4 batches in one run, the cursor at the last id", async () => {
    log = Array.from({ length: 650 }, (_, i) => msg(i + 1, `17940000${String(i).padStart(2, "0")}.000100`, ago(3_600_000)));
    const r = await sweep();
    expect(vi.mocked(listPurgeLog).mock.calls.map((c) => [c[1], c[2]])).toEqual([[0, 200], [200, 200], [400, 200], [600, 200]]);
    expect(r).toMatchObject({ purgeLogRows: 650, cursorAdvanced: 650 });
    expect(storedAfterId()).toBe(650);
  });

  it("SW02 P7a's purge log missing (the facade answers []) → the step is a no-op, nothing else fails", async () => {
    vi.mocked(listPurgeLog).mockResolvedValue([]);
    const r = await sweep();
    expect(r).toMatchObject({ purgeLogRows: 0, failedSteps: [] });
    expect(scrubCalls()).toEqual([]);
  });

  it("SW12 hub and author_optout message rows scrub exactly like deleted_event; an author purge of 300 rows is applied within one run", async () => {
    log = [msg(1, SALES_TS, ago(3_600_000), "hub")];
    await sweep();
    expect((brief().content as BriefContent).sections[1].items[0]).toMatchObject({ text: BRIEF_COPY.removedSlack, scrubbed: true });
    useDb([briefRowSeed("delivered")]);
    cursor.clear();
    log = Array.from({ length: 300 }, (_, i) => msg(i + 1, i === 299 ? SALES_TS : `17939${String(i).padStart(5, "0")}.000100`, ago(3_600_000), "author_optout"));
    const r = await sweep();
    expect(r).toMatchObject({ purgeLogRows: 300, cursorAdvanced: 300 });
    expect((brief().content as BriefContent).sections[1].items[0]).toMatchObject({ text: BRIEF_COPY.removedSlack });
  });
});

describe("SW09, SW14, SW15 the cursor never passes an unsettled or held-back row (intel-13, AM-P8-9)", () => {
  it("SW09 a build in flight since 08:00: rows at 07:58 and 08:02 are both scrubbed, the cursor stops at 07:58; after the build, the 08:02 row is applied again", async () => {
    vi.setSystemTime(new Date("2026-11-09T13:30:00.000Z"));       // both rows older than the 15-minute settle time
    useDb([briefRowSeed("building", { build_started_at: "2026-11-09T13:00:00.000Z" })]);
    log = [msg(1, "1794000001.000100", "2026-11-09T12:58:00.000Z"), msg(2, SALES_TS, "2026-11-09T13:02:00.000Z")];
    await sweep();
    expect(scrubCalls()).toHaveLength(1);
    expect(scrubCalls()[0].p_slack_keys).toContain(`m:C0SALES:${SALES_TS}`);
    expect(storedAfterId()).toBe(1);
    // The build finishes: its content cites the 08:02 message (its gather read it before the delete landed).
    Object.assign(brief(), briefRowSeed("built", { built_at: "2026-11-09T13:05:00.000Z" }));
    vi.mocked(isJobLive).mockResolvedValue(true);
    await sweep();
    expect(storedAfterId()).toBe(2);
    expect((brief().content as BriefContent).sections[1].items[0]).toMatchObject({ text: BRIEF_COPY.removedSlack, scrubbed: true });
  });

  it("SW09 the same with a regenerate in flight (regen_lock_until live, status delivered)", async () => {
    // A regenerate claimed at 13:24 holds its lock until 13:29; the hold-back point is lock - 900 s - 60 s = 13:13:00, before the
    // settle point (now - 15 min = 13:13:30).
    vi.setSystemTime(new Date("2026-11-09T13:28:30.000Z"));
    useDb([briefRowSeed("delivered", { regen_lock_until: "2026-11-09T13:29:00.000Z" })]);
    log = [msg(1, "1794000001.000100", "2026-11-09T13:12:00.000Z"), msg(2, SALES_TS, "2026-11-09T13:13:15.000Z")];
    await sweep();
    expect(storedAfterId()).toBe(1);
    brief().regen_lock_until = null;
    vi.setSystemTime(new Date("2026-11-09T13:30:00.000Z"));
    await sweep();
    expect(storedAfterId()).toBe(2);
  });

  it("SW14 a lower id that commits after a higher one was read is scrubbed by a later pass; the cursor stays ≤ 4 until id 5 is settled", async () => {
    log = [1, 2, 3, 4].map((id) => msg(id, `179399000${id}.000100`, ago(3_600_000)));
    log.push({ ...msg(5, SALES_TS, ago(60_000)), hidden: true }, msg(6, "1793990006.000100", ago(60_000)));
    await sweep();
    expect(storedAfterId()).toBe(4);
    expect(scrubCalls().flatMap((c) => c.p_slack_keys as string[])).not.toContain(`m:C0SALES:${SALES_TS}`);
    log[4].hidden = false;                                            // id 5 commits now
    await sweep();
    expect(storedAfterId()).toBe(4);                                  // 5 and 6 are still younger than the settle time
    expect(scrubCalls().at(-1)?.p_slack_keys).toContain(`m:C0SALES:${SALES_TS}`);
    expect((brief().content as BriefContent).sections[1].items[0]).toMatchObject({ text: BRIEF_COPY.removedSlack });
    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60_000));
    await sweep();
    expect(storedAfterId()).toBe(6);
  });

  it("SW15 2,400 young rows: the cursor doesn't move; a pass after the settle time passes them (2,000 a run)", async () => {
    log = Array.from({ length: 2400 }, (_, i) => msg(i + 1, `1793${String(i).padStart(6, "0")}.000100`, ago(30_000)));
    const first = await sweep();
    expect(first).toMatchObject({ purgeLogRows: 2000, cursorAdvanced: 0 });
    expect(storedAfterId()).toBe(0);
    vi.setSystemTime(new Date(NOW.getTime() + 16 * 60_000));
    expect(await sweep()).toMatchObject({ purgeLogRows: 2000, cursorAdvanced: 2000 });
    expect(await sweep()).toMatchObject({ purgeLogRows: 400, cursorAdvanced: 400 });
    expect(storedAfterId()).toBe(2400);
  });
});

describe("SW03 the scrubbed-DM follow-ups (C15)", () => {
  function scrubbedDelivered(): void {
    useDb([briefRowSeed("delivered", { scrubbed_at: "2026-11-09T13:10:00.000Z" })]);
    ws.messages.push({ channel: DM, ts: "1794000001.000100", token: BOT_TOKEN, text: "x", blocks: [], metadata: null, deleted: false, updates: 0 });
  }

  it("one chat.update of slack_ts with renderScrubbedNote, dm_followed_at set; a second sweep → no update", async () => {
    scrubbedDelivered();
    expect(await sweep()).toMatchObject({ followupsUpdated: 1, followupsPending: 0 });
    expect(ws.messages[0]).toMatchObject({ updates: 1, text: BRIEF_COPY.dmFallbackText });
    expect(JSON.stringify(ws.messages[0].blocks)).toContain(BRIEF_COPY.dmScrubbedNote);
    expect(brief().dm_followed_at).toBe("2026-11-09T13:10:00.000Z");
    await sweep();
    expect(slack.calls.filter((c) => c.method === "chat.update")).toHaveLength(1);
  });

  it("message_not_found counts as done; no installation leaves the row waiting", async () => {
    scrubbedDelivered();
    ws.messages.length = 0;
    expect(await sweep()).toMatchObject({ followupsUpdated: 1 });
    expect(brief().dm_followed_at).toBe("2026-11-09T13:10:00.000Z");
    scrubbedDelivered();
    vi.mocked(openActiveInstallation).mockResolvedValue(null);
    expect(await sweep()).toMatchObject({ followupsUpdated: 0, followupsPending: 1 });
    expect(brief().dm_followed_at ?? null).toBeNull();
  });
});

describe("SW04, SW05, SW11 stale rows (never a post)", () => {
  it("SW04 a stale building → failed stale_build + ops; a placeholder older than 2 h → failed never_built", async () => {
    useDb([briefRowSeed("building", { build_started_at: "2026-11-09T13:00:00.000Z" })]);
    expect(await sweep()).toMatchObject({ staleBuild: 1 });
    expect(brief()).toMatchObject({ status: "failed", status_reason: "stale_build" });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.failed.key("ep_1")]);
    useDb([briefRowSeed("building", { build_started_at: null, created_at: "2026-11-09T11:00:00.000Z" })]);
    expect(await sweep()).toMatchObject({ neverBuilt: 1 });
    expect(brief()).toMatchObject({ status: "failed", status_reason: "never_built" });
  });

  it("SW05 a stale delivering → resolved by the lookup (here: not found → delivery_unknown), never posted", async () => {
    useDb([briefRowSeed("delivering", { updated_at: "2026-11-09T13:02:00.000Z" })]);
    expect(await sweep()).toMatchObject({ staleDelivering: 1 });
    expect(brief()).toMatchObject({ status: "delivery_unknown", status_reason: "stale_delivering" });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toEqual([]);
  });

  it("SW11 a built row older than 10 minutes with no live full job → page_only; fresh or queued → untouched; then a regenerate can claim the day", async () => {
    useDb([briefRowSeed("built", { built_at: "2026-11-09T13:05:00.000Z" })]);
    expect(await sweep()).toMatchObject({ staleBuilt: 1 });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "delivery_failed", error_code: "stale_built" });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.failed.key("ep_1")]);
    const regen = await claimBuild(PRINCIPAL, { localDate: LOCAL_DATE, tz: TZ, scheduledAt: new Date("2026-11-09T13:00:00.000Z"), trigger: "regenerate", expectedRev: 1,
      contentExpiresAt: new Date("2026-12-10T05:00:00.000Z"), expiresAt: new Date("2027-05-09T05:00:00.000Z") });
    expect(regen).toMatchObject({ outcome: "claimed" });

    useDb([briefRowSeed("built", { built_at: "2026-11-09T13:05:00.000Z", fallback_sent_at: "2026-11-09T13:46:00.000Z" })]);
    vi.mocked(notifyOps).mockClear();
    await sweep();
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "after_fallback" });
    expect(vi.mocked(enqueueJob).mock.calls.at(-1)?.[0]).toMatchObject({ kind: "exec.brief-deliver", payload: { mode: "late" } });
    expect(notifyOps).not.toHaveBeenCalled();

    useDb([briefRowSeed("built", { built_at: "2026-11-09T13:15:00.000Z" })]);
    await sweep();
    expect(brief().status).toBe("built");
    useDb([briefRowSeed("built", { built_at: "2026-11-09T13:05:00.000Z" })]);
    vi.mocked(isJobLive).mockResolvedValue(true);
    await sweep();
    expect(brief().status).toBe("built");
    // intel-11 (integrator, M47): the sweep leaves that row built (its full job is still queued), and it still never blocks a
    // regenerate: RPC 1 claims a built row older than 10 minutes.
    expect(await claimBuild(PRINCIPAL, { localDate: LOCAL_DATE, tz: TZ, scheduledAt: new Date("2026-11-09T13:00:00.000Z"), trigger: "regenerate",
      expectedRev: 1, contentExpiresAt: new Date("2026-12-10T05:00:00.000Z"), expiresAt: new Date("2027-05-09T05:00:00.000Z") })).toMatchObject({ outcome: "claimed" });
  });
});

describe("SW06, SW13 check-ins", () => {
  it("SW06 expired proposed check-ins → expired", async () => {
    useDb([briefRowSeed("delivered")], [checkinSeed(1, { expires_at: "2026-11-09T13:00:00.000Z", created_at: "2026-11-07T13:00:00.000Z" }), checkinSeed(2)]);
    expect(await sweep()).toMatchObject({ checkinsExpired: 1 });
    expect(db.tables.exec_brief_checkins.map((r) => [r.status, r.status_reason ?? null])).toEqual([["expired", "expired"], ["proposed", null]]);
  });

  it("SW13 a check-in sending for 2 minutes → unknown stale_sending and the message re-rendered once; one sending for 10 s → untouched", async () => {
    const sending = (n: number, at: string) => checkinSeed(n, { status: "sending", sending_at: at, audit_id: n });
    useDb([briefRowSeed("delivered", { checkins_ts: "1794000002.000100" })], [sending(1, "2026-11-09T13:18:00.000Z"), sending(2, "2026-11-09T13:19:50.000Z")]);
    ws.messages.push({ channel: DM, ts: "1794000002.000100", token: BOT_TOKEN, text: "x", blocks: [], metadata: null, deleted: false, updates: 0 });
    expect(await sweep()).toMatchObject({ checkinsUnknown: 1, checkinMessagesRendered: 1 });
    expect(db.tables.exec_brief_checkins.map((r) => [r.status, r.status_reason ?? null])).toEqual([["unknown", "stale_sending"], ["sending", null]]);
    expect(ws.messages[0].updates).toBe(1);
    expect(JSON.stringify(ws.messages[0].blocks)).toContain("We couldn't confirm this was sent.");
  });
});

describe("SW07, SW08, SW10 results and what a scrub leaves", () => {
  it("SW07 the result carries counts and step names only", async () => {
    log = [msg(1, SALES_TS, ago(3_600_000))];
    const r = await sweep();
    assertNoBriefText(r);
    expect(Object.values(r).every((v) => typeof v === "number" || Array.isArray(v))).toBe(true);
    expect(briefSweepScheduledWork).toMatchObject({ kind: "exec.brief-sweep", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 1 });
    expect(briefSweepJobHandler).toMatchObject({ kind: "exec.brief-sweep", lane: "bulk", timeoutMs: 60_000 });
  });

  it("SW08 after a Slack scrub the stored line is removedSlack with no refs, and it renders with no link (the page's half is Area E's)", async () => {
    log = [msg(1, SALES_TS, ago(3_600_000))];
    await sweep();
    const content = brief().content as BriefContent;
    const view = briefDmToView(content, { tz: TZ, briefHref: "https://operations.scaledai.org/executive/brief", screen: { items: new Map(), pending: new Set(),
      top3: new Set(), withheldThreadIds: [], hideHeadline: false } });
    expect(view.sections[1].lines).toEqual([{ text: BRIEF_COPY.removedSlack, kind: "fact", href: null }]);
    expect(JSON.stringify(renderBriefDm(view))).not.toContain("slack.com/archives");
    expect(JSON.stringify(content)).not.toContain(BRIEF_TEXT_SENTINELS.digestSummary);
  });

  it("SW10 with slackIntelState not ok, a screen withholding Slack hides every Slack-derived line before any scrub ran (the renderer's half)", () => {
    const screen: BriefScreen = { items: new Map([["b2", "slack"]]), pending: new Set(), top3: new Set(), withheldThreadIds: [], hideHeadline: true };
    const view = briefDmToView(briefContent(), { tz: TZ, briefHref: "https://operations.scaledai.org/executive/brief", screen });
    expect(view.sections[1].lines).toEqual([{ text: BRIEF_COPY.removedSlack, kind: "fact", href: null }]);
    expect(view.headline).toBeNull();
    expect(BRIEF_ID.startsWith("eb_")).toBe(true);
  });
});
