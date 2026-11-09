import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/brief-ownership-load", () => ({ loadBriefOwnership: vi.fn(), checkinApprovalSource: vi.fn() }));
vi.mock("@/lib/exec/brief-screen", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-screen")>()), catchUpBriefScrubs: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  openActiveInstallation: vi.fn(), recordSlackPost: vi.fn(), recordSlackError: vi.fn(), clearSlackError: vi.fn(), enqueueRevokeCheck: vi.fn(),
  deleteSlackPostRecord: vi.fn()
}));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn(), isJobLive: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUsers: vi.fn() }));

import { assertNoBriefText, BRIEF_TEXT_SENTINELS, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import {
  BOT_TOKEN, BRIEF_ID, briefRowSeed, checkinSeed, DM, LOCAL_DATE, MITCH_SLACK, NOW, openInstallation, ownership, PRINCIPAL, settings, settle, TEAM
} from "@/lib/exec/__tests__/brief-d-harness";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import { fakeSlackWorkspace, installFakeSlack, type FakeSlackWorkspace } from "@/lib/exec/__tests__/fake-slack-api";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { BRIEF_COPY, BRIEF_OPS } from "@/lib/exec/brief-copy";
import { deliverBrief, resolveStaleRows, type BriefDeliverResult } from "@/lib/exec/brief-deliver";
import { briefOwnership } from "@/lib/exec/brief-ownership";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { catchUpBriefScrubs, NO_SCREEN, type BriefScreen } from "@/lib/exec/brief-screen";
import { __resetBriefStoreForTests, deliveryStep, getBriefById, listFollowups, scrubBriefsForSlack, scrubBriefsForThreads } from "@/lib/exec/brief-store";
import type { BriefDeliverMode } from "@/lib/exec/brief-types";
import { BRIEF_DELIVER_JOB_KIND, briefDeliverJobHandler } from "@/lib/exec/handlers/brief-deliver";
import { enqueueJob, isJobLive } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { enqueueRevokeCheck, openActiveInstallation, recordSlackError, recordSlackPost } from "@/lib/exec/slack-install";
import { listUsers } from "@/lib/exec/sources/dd";
import { findDmMessageByMetadata, SlackChannelRefusedError } from "@/lib/exec/sources/slack";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ctxFor } from "@/lib/exec/__tests__/brief-d-harness";

// P8 §5.9 DL01-DL24 (Area D): exec.brief-deliver, exactly once (M2). The brief store is real over the standalone fake (its RPC 3
// mirrors the SQL's CAS and the post_attempts CHECK); Slack is the stateful fake workspace (metadata, "posted but timed out");
// P6's dmPost / sources/slack are real. Ownership, the screen's catch-up (Area C), settings, ops and the job queue are mocked
// at their module boundaries.

let db: FakeBriefDb;
let ws: FakeSlackWorkspace;
let slack: ReturnType<typeof installFakeSlack>;
let out: ReturnType<typeof captureConsole>;

function useDb(rows: Row[], checkins: Row[] = []): FakeBriefDb {
  db = createFakeBriefDb({ tables: { exec_briefs: rows, exec_brief_checkins: checkins, users: [] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const brief = () => db.tables.exec_briefs[0];
const posts = () => ws.messages.filter((m) => m.channel === DM);
const briefPosts = () => posts().filter((m) => (m.metadata as { event_type?: string } | null)?.event_type === "exec_brief");
const payload = (mode: BriefDeliverMode = "full", over: Record<string, unknown> = {}) => ({ brief_id: BRIEF_ID, local_date: LOCAL_DATE, rev: 1, mode, ...over });
const run = (mode: BriefDeliverMode = "full") => settle(deliverBrief(PRINCIPAL, payload(mode) as never, new AbortController().signal));

/** Area C's catch-up as its contract says (§3.17.7): re-read the row and screen it; the tests swap in scrubs and screens. */
function catchUp(screen: BriefScreen = NO_SCREEN) {
  vi.mocked(catchUpBriefScrubs).mockImplementation(async (p, _s, id) => {
    const row = await getBriefById(p, id);
    return row === null ? { ok: false, reason: "not_found" } : { ok: true, row, screen };
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  vi.stubEnv("EXEC_TOKEN_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://operations.scaledai.org");
  __resetBriefStoreForTests();
  useDb([briefRowSeed("built")]);
  ws = fakeSlackWorkspace({ tokens: { [BOT_TOKEN]: { userId: "U0BOT", teamId: TEAM, botId: "B0BOT" } } });
  slack = installFakeSlack(ws.handlers);
  for (const m of [notifyOps, loadSettings, loadBriefOwnership, catchUpBriefScrubs, openActiveInstallation, recordSlackPost, recordSlackError,
    enqueueRevokeCheck, enqueueJob, isJobLive, listUsers]) vi.mocked(m as (...a: unknown[]) => unknown).mockReset();
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(loadBriefOwnership).mockResolvedValue(ownership());
  vi.mocked(openActiveInstallation).mockResolvedValue(openInstallation());
  vi.mocked(recordSlackPost).mockResolvedValue(undefined);
  vi.mocked(recordSlackError).mockResolvedValue(undefined);
  vi.mocked(enqueueRevokeCheck).mockResolvedValue(undefined);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(isJobLive).mockResolvedValue(false);
  vi.mocked(listUsers).mockResolvedValue([1, 2, 3].map((n) => ({ id: `u_${n}`, name: `Person${n} Last`, email: `p${n}@scaledai.org`, role: "worker",
    isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: [] })));
  catchUp();
});
afterEach(() => {
  // DL19: no brief text, no check-in text, no token in a log line or an ops alert.
  assertNoBriefText(out.calls(), { label: "console" });
  assertNoBriefText(vi.mocked(notifyOps), { label: "notifyOps" });
  assertNoBriefText(vi.mocked(enqueueJob), { label: "enqueueJob" });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("DL01-DL03 the happy path", () => {
  it("DL01 built → delivering (+1) → delivered: one chat.postMessage to the DM with the brief metadata, unfurls off; a ledger row kind note", async () => {
    const r = await run();
    expect(r).toMatchObject({ outcome: "delivered", status: "delivered", postAttempts: 1, checkins: "none" });
    expect(brief()).toMatchObject({ status: "delivered", post_attempts: 1, slack_channel_id: DM, slack_ts: posts()[0].ts });
    const calls = slack.calls.filter((c) => c.method === "chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ channel: DM, unfurl_links: false, unfurl_media: false, link_names: false, text: BRIEF_COPY.dmFallbackText,
      metadata: { event_type: "exec_brief", event_payload: { brief_id: BRIEF_ID, rev: 1 } } });
    expect(vi.mocked(recordSlackPost).mock.calls.map((c) => c[1])).toEqual([expect.objectContaining({ kind: "note", refId: null, channelId: DM })]);
    assertNoBriefText(r);
  });

  it("DL02 then the check-ins message: a second post (ledger kind note), checkins_ts recorded, a Send button per proposed row", async () => {
    useDb([briefRowSeed("built")], [checkinSeed(1), checkinSeed(2)]);
    const r = await run();
    expect(r).toMatchObject({ outcome: "delivered", checkins: "posted" });
    expect(posts()).toHaveLength(2);
    expect(brief().checkins_ts).toBe(posts()[1].ts);
    expect(posts()[1].text).toBe(BRIEF_COPY.checkinsFallbackText);
    const buttons = (posts()[1].blocks as { type: string; elements?: { action_id: string; value: string }[] }[]).filter((b) => b.type === "actions");
    expect(buttons.map((b) => b.elements?.[0].value.slice(0, 39))).toEqual([`c1.${checkinSeed(1).id}`, `c1.${checkinSeed(2).id}`]);
    expect(vi.mocked(recordSlackPost).mock.calls.map((c) => c[1].kind)).toEqual(["note", "note"]);
  });

  it("DL03 two workers racing on one row → one post", async () => {
    const [a, b] = await settle(Promise.all([
      deliverBrief(PRINCIPAL, payload() as never, new AbortController().signal),
      deliverBrief(PRINCIPAL, payload() as never, new AbortController().signal)
    ]));
    expect(briefPosts()).toHaveLength(1);
    expect([a, b].filter((r) => "outcome" in r && r.outcome === "delivered")).toHaveLength(1);
    expect([a, b].filter((r) => "skipped" in r)).toEqual([{ skipped: "not_won" }]);
    expect(brief()).toMatchObject({ status: "delivered", post_attempts: 1 });
  });
});

describe("DL04-DL08, DL17 ambiguous posts and the metadata lookup", () => {
  it("DL04 the first post times out but landed; the lookup finds it → delivered with that ts, no second post", async () => {
    ws.failNext("chat.postMessage", "posted_timeout");
    const r = await run();
    expect(r).toMatchObject({ outcome: "delivered", postAttempts: 1 });
    expect(briefPosts()).toHaveLength(1);
    expect(brief()).toMatchObject({ status: "delivered", slack_ts: briefPosts()[0].ts, post_attempts: 1 });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });

  it("DL05 ambiguous, not found → exactly one more post (post_attempts 2) → delivered", async () => {
    ws.failNext("chat.postMessage", "http_503");
    const r = await run();
    expect(r).toMatchObject({ outcome: "delivered", postAttempts: 2 });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2);
    expect(briefPosts()).toHaveLength(1);
    expect(brief()).toMatchObject({ status: "delivered", post_attempts: 2 });
  });

  it("DL06 ambiguous, not found, ambiguous again, not found → delivery_unknown ambiguous_twice, the ops alert, exactly two posts", async () => {
    ws.failNext("chat.postMessage", "network");
    ws.failNext("chat.postMessage", "timeout");
    const r = await run();
    expect(r).toMatchObject({ outcome: "delivery_unknown", reason: "ambiguous_twice", postAttempts: 2 });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2);
    expect(slack.calls.filter((c) => c.method === "conversations.history")).toHaveLength(2);
    expect(brief()).toMatchObject({ status: "delivery_unknown", status_reason: "ambiguous_twice", post_attempts: 2 });
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{ key: BRIEF_OPS.deliveryUnknown.key("ep_1"), title: BRIEF_OPS.deliveryUnknown.title,
      detail: `brief ${BRIEF_ID}, ${LOCAL_DATE}: ambiguous_twice` }]]);
  });

  it("DL06b ambiguous, not found, the second post landed but timed out → the second lookup finds it → delivered", async () => {
    ws.failNext("chat.postMessage", "timeout");
    ws.failNext("chat.postMessage", "posted_timeout");
    expect(await run()).toMatchObject({ outcome: "delivered", postAttempts: 2 });
    expect(briefPosts()).toHaveLength(1);
  });

  it("DL07 the lookup itself fails → delivery_unknown lookup_failed, the ops alert, no second post", async () => {
    ws.failNext("chat.postMessage", "timeout");
    ws.failNext("conversations.history", { error: "internal_error" });
    const r = await run();
    expect(r).toMatchObject({ outcome: "delivery_unknown", reason: "lookup_failed", postAttempts: 1 });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect(brief()).toMatchObject({ status: "delivery_unknown", status_reason: "lookup_failed", post_attempts: 1 });
    expect(vi.mocked(notifyOps)).toHaveBeenCalledWith(expect.objectContaining({ key: BRIEF_OPS.deliveryUnknown.key("ep_1") }));
  });

  it("DL08 a third post is impossible: with post_attempts already 2 RPC 3 refuses another count", async () => {
    useDb([briefRowSeed("delivering", { post_attempts: 2 })]);
    expect(await deliveryStep(BRIEF_ID, { from: ["delivering"], to: "delivering", countPost: true })).toBe(false);
    useDb([briefRowSeed("built", { post_attempts: 2 })]);
    expect(await run()).toEqual({ skipped: "not_won" });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
  });

  it("DL17 the lookup reads conversations.history with include_all_metadata on the DM only, oldest = delivery start - 60 s", async () => {
    ws.failNext("chat.postMessage", "posted_timeout");
    await run();
    const lookups = slack.calls.filter((c) => c.method === "conversations.history");
    expect(lookups).toHaveLength(1);
    const started = Date.parse(String(brief().delivery_started_at));
    expect(lookups[0].body).toMatchObject({ channel: DM, include_all_metadata: "true", inclusive: "true", oldest: `${Math.floor((started - 60_000) / 1000)}.000000` });
  });

  it("DL18 findDmMessageByMetadata refuses another channel before any network call", async () => {
    const target = Object.freeze({ token: BOT_TOKEN, dmChannelId: DM });
    for (const channel of ["C0SALES", "D0OTHER", "G0PRIV", "U0MITCH"]) {
      await expect(findDmMessageByMetadata(target, { channel, oldest: "1.000000", eventType: "exec_brief", match: { brief_id: BRIEF_ID } }))
        .rejects.toBeInstanceOf(SlackChannelRefusedError);
    }
    expect(slack.calls).toEqual([]);
  });
});

describe("DL09-DL10 clear failures and rate limits", () => {
  it.each(["invalid_auth", "channel_not_found", "invalid_blocks", "msg_too_long"])("DL09 %s → page_only delivery_failed with the code", async (code) => {
    ws.failNext("chat.postMessage", { error: code });
    const r = await run();
    expect(r).toMatchObject({ outcome: "page_only", reason: "delivery_failed", postAttempts: 1 });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "delivery_failed", error_code: code });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    if (code === "invalid_auth") {
      expect(vi.mocked(recordSlackError)).toHaveBeenCalledWith(expect.any(String), "invalid_auth");
      expect(vi.mocked(enqueueRevokeCheck)).toHaveBeenCalledTimes(1);
    } else {
      expect(vi.mocked(recordSlackError)).not.toHaveBeenCalled();
    }
  });

  it("DL09 SlackChannelRefusedError (an installation whose DM id changed under the job) → page_only delivery_failed", async () => {
    vi.mocked(openActiveInstallation).mockResolvedValue({ ...openInstallation(), target: Object.freeze({ token: BOT_TOKEN, dmChannelId: "D0ELSE" }) });
    expect(await run()).toMatchObject({ outcome: "page_only", reason: "delivery_failed" });
    expect(brief()).toMatchObject({ status: "page_only", error_code: "channel_refused" });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
  });

  it("DL10 ratelimited with Retry-After 5 → one wait and a second post; Retry-After 60 → page_only rate_limited", async () => {
    ws.failNext("chat.postMessage", { ratelimited: 5 });
    expect(await run()).toMatchObject({ outcome: "delivered", postAttempts: 2 });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2);
    expect(slack.calls.filter((c) => c.method === "conversations.history")).toHaveLength(0);

    useDb([briefRowSeed("built")]);
    ws.failNext("chat.postMessage", { ratelimited: 60 });
    expect(await run()).toMatchObject({ outcome: "page_only", reason: "rate_limited", postAttempts: 1 });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "rate_limited" });
  });
});

describe("DL11-DL15, DL21, DL24 the gates before a post", () => {
  it("DL11 the verdict lapsed to exec_page_only → page_only ownership_lapsed, no post", async () => {
    vi.mocked(loadBriefOwnership).mockResolvedValue(ownership("exec_page_only", "not_superseding"));
    expect(await run()).toMatchObject({ outcome: "page_only", reason: "ownership_lapsed" });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "ownership_lapsed", post_attempts: 0 });
    expect(slack.calls).toEqual([]);
  });

  it("DL12 past the cutoff in full mode → page_only after_cutoff and BRIEF_OPS.late", async () => {
    vi.setSystemTime(new Date("2026-11-09T17:30:00.000Z"));     // 12:30 local, after max(12:00, 08:00 + 4 h)
    expect(await run()).toMatchObject({ outcome: "page_only", reason: "after_cutoff" });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "after_cutoff" });
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{ key: BRIEF_OPS.late.key("ep_1"), title: BRIEF_OPS.late.title, detail: `brief ${BRIEF_ID}, ${LOCAL_DATE}: after_cutoff` }]]);
    expect(slack.calls).toEqual([]);
  });

  it("DL13 same_day: page_only not_superseding → delivered; legacy_delivered and after_fallback → refused, no post", async () => {
    useDb([briefRowSeed("page_only", { status_reason: "not_superseding" })]);
    expect(await run("same_day")).toMatchObject({ outcome: "delivered" });
    expect(brief()).toMatchObject({ status: "delivered", post_attempts: 1 });
    for (const reason of ["legacy_delivered", "after_fallback"]) {
      useDb([briefRowSeed("page_only", { status_reason: reason, ...(reason === "after_fallback" ? { fallback_sent_at: "2026-11-09T13:46:00.000Z" } : {}) })]);
      const before = ws.messages.length;
      expect(await run("same_day")).toEqual({ skipped: "not_won" });
      expect(ws.messages.length).toBe(before);
      expect(brief()).toMatchObject({ status: "page_only", status_reason: reason, post_attempts: 0 });
    }
    // The verdict says legacy delivered today: skipped before any step. Integrator (M02): the verdict is the real M1 predicate's
    // answer to the day's facts (supersede on, installed, the legacy brief already delivered), not a hand-picked one.
    useDb([briefRowSeed("page_only", { status_reason: "legacy_delivered" })]);
    const read = ownership();
    const facts = { ...read.facts, legacyDeliveredToday: true };
    vi.mocked(loadBriefOwnership).mockResolvedValue({ ...read, facts, verdict: briefOwnership(facts) });
    expect(await run("same_day")).toEqual({ skipped: "not_owned" });
  });

  it("DL14 late mode: one post of the late note, late_note_ts, then the check-ins message; no metadata; never a second late note", async () => {
    useDb([briefRowSeed("page_only", { status_reason: "after_fallback", fallback_sent_at: "2026-11-09T13:46:00.000Z" })], [checkinSeed(1)]);
    const r = await run("late");
    expect(r).toMatchObject({ outcome: "late_posted", checkins: "posted" });
    expect(posts()).toHaveLength(2);
    expect(posts()[0]).toMatchObject({ text: BRIEF_COPY.dmFallbackText, metadata: null });
    expect(JSON.stringify(posts()[0].blocks)).toContain(BRIEF_COPY.lateNote);
    expect(brief()).toMatchObject({ late_note_ts: posts()[0].ts, checkins_ts: posts()[1].ts });
    expect(await run("late")).toEqual({ skipped: "already" });
    expect(posts()).toHaveLength(2);
  });

  it("DL15 no active installation → page_only no_installation", async () => {
    vi.mocked(openActiveInstallation).mockResolvedValue(null);
    expect(await run()).toMatchObject({ outcome: "page_only", reason: "no_installation" });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "no_installation", post_attempts: 0 });
  });

  it("DL21 the watchdog claimed while this full job waited: page_only after_fallback, one late job, no brief post; a rerun changes nothing", async () => {
    useDb([briefRowSeed("built", { fallback_sent_at: "2026-11-09T13:46:00.000Z" })]);
    expect(await run()).toEqual({ skipped: "after_fallback" });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "after_fallback", post_attempts: 0 });
    expect(vi.mocked(enqueueJob).mock.calls).toEqual([[{ kind: "exec.brief-deliver", lane: "interactive", principalId: "ep_1",
      payload: { brief_id: BRIEF_ID, local_date: LOCAL_DATE, rev: 1, mode: "late" }, dedupeKey: `exec.brief-deliver:ep_1:${LOCAL_DATE}:1:late`, maxAttempts: 1 }]]);
    expect(slack.calls).toEqual([]);
    expect(await run()).toEqual({ skipped: "not_won" });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
  });

  it("DL24 late mode after the cutoff → skipped, no post", async () => {
    useDb([briefRowSeed("page_only", { status_reason: "after_fallback", fallback_sent_at: "2026-11-09T13:46:00.000Z" })]);
    vi.setSystemTime(new Date("2026-11-09T17:30:00.000Z"));
    expect(await run("late")).toEqual({ skipped: "after_cutoff" });
    expect(slack.calls).toEqual([]);
  });
});

describe("DL16, DL19, DL20, DL22, DL23 content, screens and the check-ins message", () => {
  it("DL16 the DM is rendered within the 45-block budget", async () => {
    await run();
    expect((posts()[0].blocks as unknown[]).length).toBeLessThanOrEqual(45);
  });

  it("DL19 handler results and logs carry no brief text; the handler's payload check", async () => {
    const r = await settle(briefDeliverJobHandler.run(ctxFor(BRIEF_DELIVER_JOB_KIND, payload())) as Promise<BriefDeliverResult>);
    expect(r).toMatchObject({ outcome: "delivered" });
    assertNoBriefText(r);
    expect(briefDeliverJobHandler).toMatchObject({ kind: "exec.brief-deliver", lane: "interactive", timeoutMs: 60_000 });
    await expect(briefDeliverJobHandler.run(ctxFor(BRIEF_DELIVER_JOB_KIND, { brief_id: "x" }))).rejects.toMatchObject({ name: "NonRetryableError", message: "bad_payload" });
  });

  it("DL20 a failed check-ins post leaves the brief delivered and checkins_ts unset", async () => {
    useDb([briefRowSeed("built")], [checkinSeed(1)]);
    ws.failNext("chat.postMessage", "pass");                    // the brief
    ws.failNext("chat.postMessage", { error: "invalid_blocks" }); // the check-ins message
    const r = await run();
    expect(r).toMatchObject({ outcome: "delivered", checkins: "failed" });
    expect(brief()).toMatchObject({ status: "delivered", checkins_ts: null });
  });

  it("DL22 a Slack delete and a tombstone between finishBuild and the post: removed lines, no link, no headline, the sentinels nowhere; the row scrubbed", async () => {
    vi.mocked(catchUpBriefScrubs).mockImplementation(async (p, _s, id) => {
      // What the catch-up does (§3.17.7): the purge-log rows past the cursor and the withheld threads are scrubbed into the row.
      await scrubBriefsForSlack(p, { slackKeys: ["m:C0SALES:1794000000.000100", "d:C0SALES:2026-11-09"], channels: [], all: false });
      await scrubBriefsForThreads(p, ["t_1"]);
      const row = await getBriefById(p, id);
      return row === null ? { ok: false, reason: "not_found" } : { ok: true, row, screen: NO_SCREEN };
    });
    expect(await run()).toMatchObject({ outcome: "delivered" });
    const dm = JSON.stringify(posts()[0].blocks);
    expect(dm).toContain(BRIEF_COPY.removedSlack);
    expect(dm).toContain(BRIEF_COPY.removedRestricted);
    for (const s of [BRIEF_TEXT_SENTINELS.briefLine, BRIEF_TEXT_SENTINELS.emailSubject, BRIEF_TEXT_SENTINELS.digestSummary]) expect(dm).not.toContain(s);
    expect(dm).not.toContain("slack.com/archives");
    expect(dm).not.toContain("outlook.office.com");
    expect(brief().scrubbed_at).not.toBeNull();
    expect((brief().content as { headline: unknown }).headline).toBeNull();
  });

  it("DL22b (fixer security-4) scrubs the catch-up made before the render need no C15 follow-up; a scrub after the render still gets one", async () => {
    vi.mocked(catchUpBriefScrubs).mockImplementation(async (p, _s, id) => {
      await scrubBriefsForThreads(p, ["t_1"]);
      const row = await getBriefById(p, id);
      return row === null ? { ok: false, reason: "not_found" } : { ok: true, row, screen: NO_SCREEN };
    });
    expect(await run()).toMatchObject({ outcome: "delivered" });
    const scrubbedAt = brief().scrubbed_at as string;
    expect(scrubbedAt).not.toBeNull();
    expect(brief().dm_followed_at).toBe(scrubbedAt);
    expect(await listFollowups(PRINCIPAL, 10)).toEqual([]);
    // A later scrub (another message deleted after the post): followed up.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await scrubBriefsForSlack(PRINCIPAL, { slackKeys: ["m:C0SALES:1794000000.000100"], channels: [], all: false });
    expect((await listFollowups(PRINCIPAL, 10)).map((f) => f.id)).toEqual([BRIEF_ID]);
  });

  it("DL23 a failed screen read → page_only screen_unavailable, no chat.postMessage, post_attempts 0; same_day → skipped, the row unchanged", async () => {
    vi.mocked(catchUpBriefScrubs).mockResolvedValue({ ok: false, reason: "screen_unavailable" });
    expect(await run()).toMatchObject({ outcome: "page_only", reason: "screen_unavailable" });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "screen_unavailable", post_attempts: 0 });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    useDb([briefRowSeed("page_only", { status_reason: "not_superseding" })]);
    const before = structuredClone(brief());
    vi.mocked(catchUpBriefScrubs).mockRejectedValue(new Error("read failed"));
    expect(await run("same_day")).toEqual({ skipped: "screen_unavailable" });
    expect(brief()).toEqual(before);
  });

  it("DL23 slackIntelState not ok → the post happens with every Slack line removedSlack", async () => {
    catchUp({ items: new Map([["b2", "slack"]]), pending: new Set(), top3: new Set(), withheldThreadIds: [], hideHeadline: true });
    expect(await run()).toMatchObject({ outcome: "delivered" });
    const dm = JSON.stringify(posts()[0].blocks);
    expect(dm).toContain(BRIEF_COPY.removedSlack);
    expect(dm).not.toContain(BRIEF_TEXT_SENTINELS.digestSummary);
    expect(dm).not.toContain(BRIEF_TEXT_SENTINELS.briefLine);
  });
});

describe("resolveStaleRows (shared by the watchdog and the sweep; never posts)", () => {
  it("a stale delivering row: the lookup finds the post → delivered; not found → delivery_unknown stale_delivering (+ ops); no post", async () => {
    useDb([briefRowSeed("delivering", { updated_at: "2026-11-09T13:02:00.000Z" })]);
    const landed = `${Math.floor(Date.parse("2026-11-09T13:02:01.000Z") / 1000)}.000100`;
    ws.messages.push({ channel: DM, ts: landed, token: BOT_TOKEN, text: "x", blocks: [], metadata: { event_type: "exec_brief", event_payload: { brief_id: BRIEF_ID, rev: 1 } }, deleted: false, updates: 0 });
    expect(await resolveStaleRows(PRINCIPAL, new Date(), new AbortController().signal)).toMatchObject({ staleDelivering: 1 });
    expect(brief()).toMatchObject({ status: "delivered", slack_ts: landed });
    useDb([briefRowSeed("delivering", { updated_at: "2026-11-09T13:02:00.000Z" })]);
    ws.messages.length = 0;
    await resolveStaleRows(PRINCIPAL, new Date(), new AbortController().signal);
    expect(brief()).toMatchObject({ status: "delivery_unknown", status_reason: "stale_delivering" });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(0);
    expect(vi.mocked(notifyOps)).toHaveBeenCalledWith(expect.objectContaining({ key: BRIEF_OPS.deliveryUnknown.key("ep_1") }));
  });
});

describe("the installation's identity in the DM", () => {
  it("the DM goes to his installation's own DM channel with the assistant's bot token", async () => {
    await run();
    expect(posts()[0]).toMatchObject({ token: BOT_TOKEN, channel: DM });
    expect(MITCH_SLACK).toBe("U0MITCH");
  });
});
