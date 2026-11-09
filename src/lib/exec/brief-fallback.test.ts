import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/brief-ownership-load", () => ({ loadBriefOwnership: vi.fn(), checkinApprovalSource: vi.fn() }));
vi.mock("@/lib/exec/attention-read", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/attention-read")>()), listScreenedAttention: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), getPendingApprovals: vi.fn(), listUsers: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  getLatestInstallation: vi.fn(), openActiveInstallation: vi.fn(), recordSlackPost: vi.fn(), recordSlackError: vi.fn(), enqueueRevokeCheck: vi.fn()
}));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn(), isJobLive: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn() }));

import { assertNoBriefText, BRIEF_TEXT_SENTINELS, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import {
  BRIEF_ID, briefRowSeed, ctxFor, DD_BOT_TOKEN, installation, LOCAL_DATE, NOW, openInstallation, ownership, PRINCIPAL, SCHEDULED_AT, settings, settle, TEAM, TZ
} from "@/lib/exec/__tests__/brief-d-harness";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import { fakeSlackWorkspace, installFakeSlack, type FakeSlackWorkspace } from "@/lib/exec/__tests__/fake-slack-api";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { BRIEF_COPY, BRIEF_OPS } from "@/lib/exec/brief-copy";
import { briefExpiries } from "@/lib/exec/brief-ownership";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { __resetBriefStoreForTests, claimBuild, finishBuild } from "@/lib/exec/brief-store";
import { deleteDdBotDm, postDdBotDm } from "@/lib/exec/dd-bot";
import { BRIEF_FALLBACK_JOB_KIND, briefFallbackJobHandler } from "@/lib/exec/handlers/brief-fallback";
import { enqueueJob, isJobLive } from "@/lib/exec/jobs";
import { callModel } from "@/lib/exec/llm/client";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { getLatestInstallation, openActiveInstallation } from "@/lib/exec/slack-install";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { getPendingApprovals } from "@/lib/exec/sources/dd";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 §5.10 WD01-WD16 (Area D): exec.brief-fallback, the watchdog (M7, C3, C32-C34, C49; intel-10, -11, -18). The brief store is
// real over the standalone fake (RPC 4's claim mirrors the SQL); the DD bot posts through the real dd-bot.ts and P6's client
// into the stateful fake Slack, with SLACK_BOT_TOKEN set. Ownership, the screened reads, settings, ops and the queue are mocked.

const RUN_AT = new Date("2026-11-09T13:46:00.000Z");     // 08:46 local: the watchdog's runAfter for an 08:00 brief
const DD_IM = "D0IM001";
let db: FakeBriefDb;
let ws: FakeSlackWorkspace;
let slack: ReturnType<typeof installFakeSlack>;
let out: ReturnType<typeof captureConsole>;

function useDb(rows: Row[]): FakeBriefDb {
  db = createFakeBriefDb({ tables: { exec_briefs: rows } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const brief = () => db.tables.exec_briefs[0];
const ddPosts = () => ws.messages.filter((m) => m.token === DD_BOT_TOKEN);
const claims = () => db.calls.filter((c) => c.kind === "rpc" && c.target === "exec_brief_claim_fallback");
/** The harness principal with a pinned mailbox (email intelligence on, P8 fixer ui-1: the email line is a count only then). */
const MAILBOX_PRINCIPAL = Object.freeze({ ...(PRINCIPAL as unknown as Record<string, unknown>), mailAccountIds: Object.freeze(["acc_1"]) }) as unknown as ExecPrincipal;
const run = (payload: Record<string, unknown> = { local_date: LOCAL_DATE, scheduled_at: SCHEDULED_AT }) =>
  settle(briefFallbackJobHandler.run(ctxFor(BRIEF_FALLBACK_JOB_KIND, payload, MAILBOX_PRINCIPAL)) as Promise<Record<string, unknown>>);

const item = (n: number, source: "dd" | "email" | "slack", band: "critical" | "high" | "normal", title: string): AttentionFeedItem => ({
  id: `ea_${n}`, principalId: PRINCIPAL.id, fingerprint: `${source}:x:${n}`, source, kind: "k", category: "my_action", title, whatHappened: "",
  whyItMatters: "", recommendedNext: null, facts: [], refs: [{ system: "dd", id: `task_${n}`, url: `https://operations.scaledai.org/tasks/task_${n}`, label: "t", class: "internal" }],
  priority: { score: 100 - n, band, reasons: [] }, stateHash: "h", occurredAt: null, status: "open", snoozeUntil: null, firstSeenAt: NOW.toISOString(),
  lastSeenAt: NOW.toISOString(), resolvedAt: null, resolution: null, updatedAt: NOW.toISOString(), version: NOW.toISOString()
}) as AttentionFeedItem;

const ITEMS: AttentionFeedItem[] = [
  item(1, "dd", "critical", "Overdue: the launch checklist"),
  item(2, "email", "critical", `Reply ${BRIEF_TEXT_SENTINELS.emailSubject}`),
  item(3, "slack", "high", `Sales asked ${BRIEF_TEXT_SENTINELS.digestSummary}`),
  ...[4, 5, 6, 7, 8, 9].map((n) => item(n, "dd", n % 2 === 0 ? "high" : "normal", `DD task ${n}`))
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(RUN_AT);
  out = captureConsole();
  vi.stubEnv("SLACK_BOT_TOKEN", DD_BOT_TOKEN);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://operations.scaledai.org");
  __resetBriefStoreForTests();
  useDb([briefRowSeed("built", { built_at: "2026-11-09T13:40:00.000Z" })]);
  ws = fakeSlackWorkspace({
    tokens: { [DD_BOT_TOKEN]: { userId: "U0DDBOT", teamId: TEAM, botId: "B0DDBOT" } },
    users: { [PRINCIPAL.email]: { id: "U0MITCH" } },
    ims: { [`${DD_BOT_TOKEN}|U0MITCH`]: DD_IM }
  });
  slack = installFakeSlack(ws.handlers);
  for (const m of [notifyOps, callModel, loadSettings, loadBriefOwnership, listScreenedAttention, getPendingApprovals, getLatestInstallation,
    openActiveInstallation, enqueueJob, isJobLive]) vi.mocked(m as (...a: unknown[]) => unknown).mockReset();
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(loadSettings).mockResolvedValue(settings({ retentionDaysChat: 30, emailSchemaReady: true, emailEnabled: true }));
  vi.mocked(slackIntelState).mockReset();
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(loadBriefOwnership).mockImplementation(async () => ownership("exec", "owns", null));
  vi.mocked(listScreenedAttention).mockResolvedValue({ items: ITEMS, nextCursor: null, hiddenEmail: 2, emailScreen: "ok", hiddenSlack: 1, slackScreen: "ok" });
  vi.mocked(getPendingApprovals).mockResolvedValue([{ mechanism: "draft_tasks", count: 2, oldestAt: null }, { mechanism: "checkins", count: 1, oldestAt: null }]);
  vi.mocked(getLatestInstallation).mockResolvedValue(installation());
  vi.mocked(openActiveInstallation).mockResolvedValue(openInstallation());
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(isJobLive).mockResolvedValue(true);
});
afterEach(() => {
  assertNoBriefText(out.calls(), { label: "console" });
  assertNoBriefText(vi.mocked(notifyOps), { label: "notifyOps" });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("WD01-WD05 the claim (RPC 4, C32)", () => {
  it("WD01 verdict exec, nothing delivered → claim → one DD-bot post; fallback_sent_at, its channel and ts; BRIEF_OPS.fallback", async () => {
    useDb([briefRowSeed("failed", { status_reason: "post_model" })]);
    const r = await run();
    expect(r).toMatchObject({ outcome: "posted", briefId: BRIEF_ID, status: "failed", code: null, movedToPageOnly: false });
    expect(ddPosts()).toHaveLength(1);
    expect(ddPosts()[0]).toMatchObject({ channel: DD_IM, text: BRIEF_COPY.fallbackText });
    expect(brief()).toMatchObject({ fallback_channel_id: DD_IM, fallback_slack_ts: ddPosts()[0].ts, fallback_error_code: null });
    expect(brief().fallback_sent_at).not.toBeNull();
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{ key: BRIEF_OPS.fallback.key("ep_1"), title: BRIEF_OPS.fallback.title, detail: `brief ${BRIEF_ID}, ${LOCAL_DATE}: failed` }]]);
    assertNoBriefText(r);
  });

  it("WD02 delivered → skipped, no post", async () => {
    useDb([briefRowSeed("delivered")]);
    expect(await run()).toEqual({ skipped: "delivered" });
    expect(ddPosts()).toEqual([]);
  });

  it.each(["delivering", "delivery_unknown"])("WD03 %s → skipped in_flight (C32), no post", async (status) => {
    useDb([briefRowSeed(status, { updated_at: RUN_AT.toISOString() })]);
    expect(await run()).toEqual({ skipped: "in_flight" });
    expect(ddPosts()).toEqual([]);
    expect(brief().fallback_sent_at ?? null).toBeNull();
  });

  it("WD04 fallback_sent_at already set (a second watchdog) → already, no post", async () => {
    useDb([briefRowSeed("failed", { fallback_sent_at: "2026-11-09T13:45:00.000Z" })]);
    expect(await run()).toEqual({ skipped: "already" });
    expect(ddPosts()).toEqual([]);
  });

  it("WD05 two watchdogs racing → one post", async () => {
    useDb([briefRowSeed("failed")]);
    const [a, b] = await settle(Promise.all([
      briefFallbackJobHandler.run(ctxFor(BRIEF_FALLBACK_JOB_KIND, { local_date: LOCAL_DATE, scheduled_at: SCHEDULED_AT })),
      briefFallbackJobHandler.run(ctxFor(BRIEF_FALLBACK_JOB_KIND, { local_date: LOCAL_DATE, scheduled_at: SCHEDULED_AT }))
    ]));
    expect(ddPosts()).toHaveLength(1);
    expect([a, b]).toContainEqual({ skipped: "already" });
  });
});

describe("WD06-WD07, WD14-WD15 rows before the claim", () => {
  it("WD06 no row at all: the RPC inserts the placeholder and the fallback posts; a later build claims it and ends page_only after_fallback", async () => {
    useDb([]);
    expect(await run()).toMatchObject({ outcome: "posted", status: "building" });
    expect(ddPosts()).toHaveLength(1);
    expect(brief()).toMatchObject({ status: "building", build_started_at: null });
    const claim = await claimBuild(PRINCIPAL, { localDate: LOCAL_DATE, tz: TZ, scheduledAt: new Date(SCHEDULED_AT), trigger: "schedule", expectedRev: null,
      contentExpiresAt: new Date("2026-12-10T05:00:00.000Z"), expiresAt: new Date("2027-05-09T05:00:00.000Z") });
    expect(claim).toMatchObject({ outcome: "claimed", fallbackSent: true });
    if (claim.outcome !== "claimed") throw new Error("claim");
    const content = briefRowSeed("built").content as never;
    const finished = await finishBuild(PRINCIPAL, { id: claim.id, expectedRev: claim.rev, // What the build does after a fallback (C34, Area C): fallbackSent → page_only after_fallback.
      trigger: "schedule", status: claim.fallbackSent ? "page_only" : "built", statusReason: claim.fallbackSent ? "after_fallback" : null, owner: "exec",
      ownerReason: "owns", mode: "ai", modeReason: null, content, refs: { threadIds: [], slackKeys: [], slackChannels: [] }, mentions: [], mentionedOn: LOCAL_DATE });
    expect(finished).toMatchObject({ outcome: "ok", status: "page_only" });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "after_fallback" });
  });

  it("WD07 a stale building (> 10 min) → failed stale_build + ops before the claim; a stale delivering → the lookup, never a post by the watchdog", async () => {
    useDb([briefRowSeed("building", { build_started_at: "2026-11-09T13:20:00.000Z" })]);
    expect(await run()).toMatchObject({ outcome: "posted", status: "failed" });
    expect(brief()).toMatchObject({ status: "failed", status_reason: "stale_build" });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.failed.key("ep_1"), BRIEF_OPS.fallback.key("ep_1")]);

    useDb([briefRowSeed("delivering", { updated_at: "2026-11-09T13:30:00.000Z" })]);
    expect(await run()).toEqual({ skipped: "in_flight" });
    expect(brief()).toMatchObject({ status: "delivery_unknown", status_reason: "stale_delivering" });
    expect(ws.messages.filter((m) => m.token !== DD_BOT_TOKEN)).toEqual([]);
    expect(slack.calls.filter((c) => c.method === "conversations.history")).toHaveLength(1);
  });

  it("WD14 the row is built at the claim: the mini-brief posts once, then page_only after_fallback and one late job; with the post failing, the row still moves", async () => {
    vi.mocked(isJobLive).mockResolvedValue(true);
    expect(await run()).toMatchObject({ outcome: "posted", status: "built", movedToPageOnly: true });
    expect(ddPosts()).toHaveLength(1);
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "after_fallback" });
    expect(vi.mocked(enqueueJob).mock.calls.map((c) => [c[0].kind, c[0].dedupeKey, c[0].payload])).toEqual([
      ["exec.brief-deliver", `exec.brief-deliver:ep_1:${LOCAL_DATE}:1:late`, { brief_id: BRIEF_ID, local_date: LOCAL_DATE, rev: 1, mode: "late" }]
    ]);

    useDb([briefRowSeed("built", { built_at: "2026-11-09T13:40:00.000Z" })]);
    vi.mocked(enqueueJob).mockClear();
    ws.failNext("chat.postMessage", { error: "channel_not_found" });
    expect(await run()).toMatchObject({ outcome: "failed", code: "channel_not_found", movedToPageOnly: true });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "after_fallback", fallback_error_code: "channel_not_found" });
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
  });

  it("WD15 a built row older than 10 minutes whose full deliver job is dead → page_only delivery_failed + BRIEF_OPS.failed before the claim; queued → untouched", async () => {
    useDb([briefRowSeed("built", { built_at: "2026-11-09T13:20:00.000Z" })]);
    vi.mocked(isJobLive).mockResolvedValue(false);
    expect(await run()).toMatchObject({ outcome: "posted", status: "page_only", movedToPageOnly: false });
    expect(brief()).toMatchObject({ status: "page_only", status_reason: "delivery_failed", error_code: "stale_built" });
    expect(vi.mocked(isJobLive)).toHaveBeenCalledWith(`exec.brief-deliver:ep_1:${LOCAL_DATE}:1:full`, expect.anything());
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.failed.key("ep_1"), BRIEF_OPS.fallback.key("ep_1")]);

    useDb([briefRowSeed("built", { built_at: "2026-11-09T13:20:00.000Z" })]);
    vi.mocked(isJobLive).mockResolvedValue(true);
    vi.mocked(notifyOps).mockClear();
    expect(await run()).toMatchObject({ outcome: "posted", status: "built", movedToPageOnly: true });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.fallback.key("ep_1")]);
  });
});

describe("WD08-WD11, WD16 the mini-brief and the DD bot", () => {
  it("WD08 band counts, ≤ 5 DD titles, email and Slack as counts only, approvals, the restricted count, the /executive link; no buttons, no model call", async () => {
    useDb([briefRowSeed("failed")]);
    await run();
    const [post] = ddPosts();
    const text = JSON.stringify(post.blocks);
    expect(text).toContain("Needs attention: 2 critical, 4 high, 3 normal.");
    expect(text).toContain("Overdue: the launch checklist");
    expect(text).toContain("DD task 7");
    expect(text).not.toContain("DD task 8");                                          // only the top 5 DD titles
    expect(text).toContain("Email: 1 items need you.");
    expect(text).toContain("Slack: 1 items need you.");
    expect(text).toContain("Waiting for approval: 3.");
    expect(text).toContain("2 restricted-sender emails need you.");
    expect(text).toContain("https://operations.scaledai.org/executive|Open Executive AI in DD");
    expect(text).not.toContain(BRIEF_TEXT_SENTINELS.emailSubject);
    expect(text).not.toContain(BRIEF_TEXT_SENTINELS.digestSummary);
    expect((post.blocks as { type: string }[]).some((b) => b.type === "actions")).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
    expect(vi.mocked(listScreenedAttention).mock.calls[0][2]).toMatchObject({ surface: "slack" });
  });

  it("WD08 a failed read: its line says it couldn't load, the post still goes", async () => {
    useDb([briefRowSeed("failed")]);
    vi.mocked(listScreenedAttention).mockRejectedValue(new Error("read failed"));
    vi.mocked(getPendingApprovals).mockRejectedValue(new Error("read failed"));
    expect(await run()).toMatchObject({ outcome: "posted" });
    const text = JSON.stringify(ddPosts()[0].blocks);
    expect(text).toContain("Email: Couldn't load this.");
    expect(text).toContain("Waiting for approval: Couldn't load this.");
  });

  it("WD08b (fixer ui-1) Slack reading off / not installed / not connected → its state line, never \"Slack: 0 items\"; a Slack screen that couldn't run → Couldn't load", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: ITEMS.filter((i) => i.source !== "slack"), nextCursor: null, hiddenEmail: 0, emailScreen: "ok",
      hiddenSlack: 0, slackScreen: "none" });
    for (const [state, line] of [["reading_off", BRIEF_COPY.state.slack_reading_off], ["not_installed", BRIEF_COPY.state.slack_not_installed],
      ["not_connected", BRIEF_COPY.state.slack_not_connected], ["reading_revoked", BRIEF_COPY.state.slack_reading_revoked]] as const) {
      useDb([briefRowSeed("failed")]);
      ws.messages.length = 0;
      vi.mocked(slackIntelState).mockResolvedValue(state);
      await run();
      const text = JSON.stringify(ddPosts()[0].blocks);
      expect(text, state).toContain(line);
      expect(text, state).not.toMatch(/Slack: \d+ items/);
    }
    useDb([briefRowSeed("failed")]);
    ws.messages.length = 0;
    vi.mocked(slackIntelState).mockResolvedValue("ok");
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: ITEMS, nextCursor: null, hiddenEmail: 0, emailScreen: "ok", hiddenSlack: 3, slackScreen: "unavailable" });
    await run();
    expect(JSON.stringify(ddPosts()[0].blocks)).toContain("Slack: Couldn't load this.");
  });

  it("WD08c (fixer ui-1) email off / no mailbox → its state line, never \"Email: 0 items\"; an email screen that couldn't run → Couldn't load, no restricted-sender line", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: ITEMS.filter((i) => i.source !== "email"), nextCursor: null, hiddenEmail: 0, emailScreen: "ok",
      hiddenSlack: 0, slackScreen: "ok" });
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailSchemaReady: true, emailEnabled: false }));
    useDb([briefRowSeed("failed")]);
    await run();
    let text = JSON.stringify(ddPosts()[0].blocks);
    expect(text).toContain(BRIEF_COPY.state.email_off);
    expect(text).not.toMatch(/Email: \d+ items/);
    // Email on, but no mailbox pinned to him.
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailSchemaReady: true, emailEnabled: true }));
    useDb([briefRowSeed("failed")]);
    ws.messages.length = 0;
    await settle(briefFallbackJobHandler.run(ctxFor(BRIEF_FALLBACK_JOB_KIND, { local_date: LOCAL_DATE, scheduled_at: SCHEDULED_AT })) as Promise<unknown>);
    expect(JSON.stringify(ddPosts()[0].blocks)).toContain(BRIEF_COPY.state.email_no_pin);
    // The screen couldn't run: every email item withheld and counted, but not as restricted-sender mail.
    useDb([briefRowSeed("failed")]);
    ws.messages.length = 0;
    vi.mocked(listScreenedAttention).mockResolvedValue({ items: ITEMS.filter((i) => i.source !== "email"), nextCursor: null, hiddenEmail: 4,
      emailScreen: "unavailable", hiddenSlack: 0, slackScreen: "ok" });
    await run();
    text = JSON.stringify(ddPosts()[0].blocks);
    expect(text).toContain("Email: Couldn't load this.");
    expect(text).not.toContain("restricted-sender");
    expect(text).not.toMatch(/Email: \d+ items/);
  });

  it("WD09 the Slack id comes from the installation row; with none, from users.lookupByEmail with the DD bot token; neither → dd_bot_no_user + fallbackFailed", async () => {
    useDb([briefRowSeed("failed")]);
    vi.mocked(getLatestInstallation).mockResolvedValue(installation({ userId: "U0FROMINSTALL" }));
    await run();
    expect(slack.calls.filter((c) => c.method === "users.lookupByEmail")).toEqual([]);
    expect(slack.calls.find((c) => c.method === "conversations.open")?.body).toEqual({ users: "U0FROMINSTALL" });

    useDb([briefRowSeed("failed")]);
    vi.mocked(getLatestInstallation).mockResolvedValue(null);
    await run();
    const lookup = slack.calls.filter((c) => c.method === "users.lookupByEmail");
    expect(lookup.map((c) => [c.body, c.headers.authorization])).toEqual([[{ email: PRINCIPAL.email }, `Bearer ${DD_BOT_TOKEN}`]]);

    useDb([briefRowSeed("failed")]);
    ws.users.clear();
    vi.mocked(notifyOps).mockClear();
    expect(await run()).toMatchObject({ outcome: "failed", code: "dd_bot_no_user" });
    expect(brief()).toMatchObject({ fallback_error_code: "dd_bot_no_user", fallback_slack_ts: null });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.fallbackFailed.key("ep_1")]);
  });

  it("WD10 the DD-bot post: SLACK_BOT_TOKEN through dd-bot.ts, conversations.open then chat.postMessage to that D… channel only; @/lib/slack not imported", async () => {
    useDb([briefRowSeed("failed")]);
    await run();
    expect(slack.calls.map((c) => c.method)).toEqual(["conversations.open", "chat.postMessage"]);
    expect(slack.calls.every((c) => c.headers.authorization === `Bearer ${DD_BOT_TOKEN}`)).toBe(true);
    expect(slack.calls[1].body).toMatchObject({ channel: DD_IM, unfurl_links: false, unfurl_media: false });
    const text = readFileSync(fileURLToPath(new URL("./dd-bot.ts", import.meta.url)), "utf8");
    expect(text).not.toMatch(/from "@\/lib\/slack"/);
    const handler = readFileSync(fileURLToPath(new URL("./handlers/brief-fallback.ts", import.meta.url)), "utf8");
    expect(handler).not.toMatch(/from "@\/lib\/slack"/);
  });

  it("WD10 SLACK_BOT_TOKEN unset → dd_bot_not_configured, no Slack call", async () => {
    useDb([briefRowSeed("failed")]);
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    expect(await run()).toMatchObject({ outcome: "failed", code: "dd_bot_not_configured" });
    expect(slack.calls).toEqual([]);
  });

  it("WD11 a post failure → fallback_error_code, fallbackFailed, no retry", async () => {
    useDb([briefRowSeed("failed")]);
    ws.failNext("chat.postMessage", "http_503");
    expect(await run()).toMatchObject({ outcome: "failed", code: "http_503" });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect(brief()).toMatchObject({ fallback_error_code: "http_503", fallback_slack_ts: null });
    expect(await run()).toEqual({ skipped: "already" });
    expect(slack.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });

  it("WD16 a post stores the DD bot's IM, its ts and delete-after = post time + retentionDaysChat days (capped at expires_at); a failure only the code", async () => {
    useDb([briefRowSeed("failed")]);
    vi.mocked(loadSettings).mockResolvedValue(settings({ retentionDaysChat: 7 }));
    await run();
    expect(brief()).toMatchObject({ fallback_channel_id: DD_IM, fallback_slack_ts: ddPosts()[0].ts });
    expect(Date.parse(String(brief().fallback_delete_after))).toBe(RUN_AT.getTime() + 7 * 86_400_000);
    useDb([briefRowSeed("failed")]);
    vi.mocked(loadSettings).mockResolvedValue(settings({ retentionDaysChat: 3650 }));
    await run();
    expect(brief().fallback_delete_after).toBe(briefExpiries(LOCAL_DATE, TZ).expiresAt.toISOString());
  });
});

describe("WD12-WD13 when the watchdog never posts", () => {
  it("WD12 the verdict isn't exec (the installation was revoked at 08:30) → skipped; nothing posted by either bot", async () => {
    vi.mocked(loadBriefOwnership).mockResolvedValue(ownership("exec_page_only", "no_installation"));
    expect(await run()).toEqual({ skipped: "no_installation" });
    expect(ws.messages).toEqual([]);
    expect(claims()).toEqual([]);
  });

  it("WD13a an outage catch-up: the watchdog at 12:15 → after_cutoff, no claim, no post, no fallback alert", async () => {
    useDb([briefRowSeed("page_only", { status_reason: "after_cutoff" })]);
    vi.mocked(loadBriefOwnership).mockResolvedValue(ownership("exec", "owns", {} as never));
    vi.setSystemTime(new Date("2026-11-09T17:15:00.000Z"));
    expect(await run()).toEqual({ skipped: "after_cutoff" });
    expect(claims()).toEqual([]);
    expect(brief().fallback_sent_at ?? null).toBeNull();
    expect(ws.messages).toEqual([]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("WD13b a watchdog queued before an outage that runs at 00:20 the next local day → skipped, no post", async () => {
    vi.mocked(loadBriefOwnership).mockResolvedValue(ownership("exec", "owns", {} as never));
    vi.setSystemTime(new Date("2026-11-10T05:20:00.000Z"));
    expect(await run()).toEqual({ skipped: "after_cutoff" });
    expect(claims()).toEqual([]);
    expect(ws.messages).toEqual([]);
  });

  it("WD13c the same with no row for the day → skipped and one BRIEF_OPS.late", async () => {
    useDb([]);
    vi.setSystemTime(new Date("2026-11-10T05:20:00.000Z"));
    expect(await run()).toEqual({ skipped: "after_cutoff" });
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{ key: BRIEF_OPS.late.key("ep_1"), title: BRIEF_OPS.late.title, detail: `principal ep_1, ${LOCAL_DATE}: no build` }]]);
    expect(ws.messages).toEqual([]);
  });

  it("a bad payload is refused (NonRetryableError), and the handler is interactive, 60 s", async () => {
    await expect(briefFallbackJobHandler.run(ctxFor(BRIEF_FALLBACK_JOB_KIND, { local_date: "x" }))).rejects.toMatchObject({ name: "NonRetryableError" });
    expect(briefFallbackJobHandler).toMatchObject({ kind: "exec.brief-fallback", lane: "interactive", timeoutMs: 60_000 });
  });
});

describe("dd-bot.ts postDdBotDm / deleteDdBotDm (§3.13.3, C49; PU12's Slack half)", () => {
  it("postDdBotDm refuses a bot or deleted lookup result (dd_bot_no_user)", async () => {
    ws.users.set(PRINCIPAL.email, { id: "U0MITCH", isBot: true });
    await expect(postDdBotDm(PRINCIPAL, { slackUserId: null, parts: { blocks: [], text: "x" } }, { signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: "NonRetryableError", message: "dd_bot_no_user" });
  });

  it("deleteDdBotDm: deleted; a second delete (message_not_found) → deleted; channel_not_found → deleted; another error or no token → retry", async () => {
    const posted = await postDdBotDm(PRINCIPAL, { slackUserId: "U0MITCH", parts: { blocks: [], text: "x" } }, { signal: new AbortController().signal });
    const signal = new AbortController().signal;
    expect(await deleteDdBotDm(posted, { signal })).toBe("deleted");
    expect(ws.messages[0].deleted).toBe(true);
    expect(await deleteDdBotDm(posted, { signal })).toBe("deleted");
    ws.failNext("chat.delete", { error: "channel_not_found" });
    expect(await deleteDdBotDm(posted, { signal })).toBe("deleted");
    ws.failNext("chat.delete", { error: "ratelimited" });
    expect(await deleteDdBotDm(posted, { signal })).toBe("retry");
    ws.failNext("chat.delete", "http_503");
    expect(await deleteDdBotDm(posted, { signal })).toBe("retry");
    expect(await deleteDdBotDm({ channel: "C0NOTDM", ts: posted.ts }, { signal })).toBe("retry");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    expect(await deleteDdBotDm(posted, { signal })).toBe("retry");
    const deletes = slack.calls.filter((c) => c.method === "chat.delete");
    expect(deletes.every((c) => c.headers.authorization === `Bearer ${DD_BOT_TOKEN}` && c.body.channel === posted.channel)).toBe(true);
  });
});
