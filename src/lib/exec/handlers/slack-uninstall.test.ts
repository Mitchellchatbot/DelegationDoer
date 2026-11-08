import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/agent/turn", () => ({
  prepareChatTurn: vi.fn(), runPreparedTurn: vi.fn(), newConversationTitle: vi.fn((q: string) => q), storedTurnPayload: vi.fn(), proposalViewFor: vi.fn()
}));
vi.mock("@/lib/exec/drafts", () => ({ getDraftView: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));

import { prepareChatTurn, runPreparedTurn } from "@/lib/exec/agent/turn";
import { auditEvent, auditStart } from "@/lib/exec/audit";
import { slackReplyJobHandler } from "@/lib/exec/handlers/slack-reply";
import { UNPURGED_REVOCATION_GRACE_MS, purgeUnpurgedRevocations, slackUninstallJobHandler } from "@/lib/exec/handlers/slack-uninstall";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { acceptEvent, revokeInstallation } from "@/lib/exec/slack-install";
import type { SlackEventFacts } from "@/lib/exec/slack-types";

import { done as chatDone } from "../__tests__/chat-ui-fixtures";
import { findSentinel, ROUTING_INSTALLATION as RI } from "../__tests__/slack-assert";
import {
  EVENT_ID,
  INST,
  KEY,
  MSG,
  SETTINGS,
  TURN,
  callsOf,
  installationRow,
  jobCtx,
  replyEventRow,
  slackError,
  slackRateLimited,
  useSlack,
  useSlackDb,
  type Harness
} from "../__tests__/slack-jobs-harness";

// P6 contract §5.8 (C17, C18, K16): UN01-UN08, the uninstall check and purge (system jobs, principal null).

const NOW_MS = Date.parse("2026-11-06T15:00:30.000Z");
const NOW_SEC = Math.floor(NOW_MS / 1000);
const TS = "1793977201.000100";
let h: Harness;
let spies: ReturnType<typeof vi.spyOn>[];

const run = (payload: Record<string, unknown>) => slackUninstallJobHandler.run(jobCtx("exec.slack-uninstall", payload, { principal: null }));
const inst = () => h.db.tables.exec_slack_installations.find((i) => i.id === INST) as Record<string, unknown>;
const uninstallJobs = (mode?: string) => h.db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-uninstall" && (mode === undefined || (j.payload as Record<string, unknown>).mode === mode));

function facts(type: "app_uninstalled" | "tokens_revoked", eventTime: number, over: Partial<SlackEventFacts> = {}): SlackEventFacts {
  return {
    eventId: `Ev0${type === "app_uninstalled" ? "UNINSTALL" : "REVOKED"}${eventTime}`, teamId: RI.teamId, apiAppId: RI.appId, eventType: type, eventTime, retryNum: 0,
    channel: null, channelType: null, user: null, ts: null, threadTs: null, hasBotId: false, hasAppId: false, subtype: null, hidden: false,
    textIsString: false, hasMessage: false, tab: null, revokedBotIds: [], revokedUserIds: type === "tokens_revoked" ? [RI.botUserId] : [], ...over
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.mocked(notifyOps).mockReset();
  vi.mocked(auditEvent).mockReset();
  vi.mocked(auditStart).mockReset().mockResolvedValue(5);
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  h = useSlackDb({ tables: { exec_slack_events: [] } });
  spies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "info").mockImplementation(() => {})];
});
afterEach(() => {
  expect(findSentinel([spies.map((s) => s.mock.calls), vi.mocked(notifyOps).mock.calls, vi.mocked(auditEvent).mock.calls.map((c) => c[1])])).toBeNull();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("mode check (C17; UN02, UN03)", () => {
  it("UN02: auth.test ok → still valid, nothing changes; invalid_auth → revoked (tokens_revoked) with one purge job; internal_error → rethrown retryable", async () => {
    let slack = useSlack();
    expect(await run({ installation_id: INST, mode: "check", event_time: NOW_SEC })).toEqual({ stillValid: true });
    expect(callsOf(slack.calls, "auth.test")).toHaveLength(1);
    expect(inst().revoked_at).toBeNull();
    slack.restore();

    slack = useSlack({ "auth.test": slackError("internal_error") });
    await expect(run({ installation_id: INST, mode: "check", event_time: NOW_SEC })).rejects.toMatchObject({ name: "SlackApiError", errorClass: "retryable" });
    expect(inst().revoked_at).toBeNull();
    slack.restore();

    slack = useSlack({ "auth.test": slackError("invalid_auth") });
    expect(await run({ installation_id: INST, mode: "check", event_time: NOW_SEC })).toEqual({ revoked: true });
    expect(inst()).toMatchObject({ revoke_reason: "tokens_revoked" });
    expect(inst().revoked_at).not.toBeNull();
    expect(uninstallJobs("purge")).toHaveLength(1);
  });

  it("UN02b: each dead-token code revokes; another auth-class code (missing_scope) does not", async () => {
    for (const code of ["token_revoked", "account_inactive", "not_authed"]) {
      h = useSlackDb();
      const slack = useSlack({ "auth.test": slackError(code) });
      expect(await run({ installation_id: INST, mode: "check" })).toEqual({ revoked: true });
      slack.restore();
    }
    h = useSlackDb();
    useSlack({ "auth.test": slackError("missing_scope") });
    await expect(run({ installation_id: INST, mode: "check" })).rejects.toMatchObject({ code: "missing_scope" });
    expect(inst().revoked_at).toBeNull();
  });

  it("UN03: an event or failure dated before installed_at (a reinstall in between) → stale, no auth.test", async () => {
    const slack = useSlack();
    expect(await run({ installation_id: INST, mode: "check", event_time: RI.installedAtEpochSec - 60 })).toEqual({ skipped: "stale" });
    expect(slack.calls).toHaveLength(0);
  });

  it("an installation that is no longer active → skipped; a bad payload → NonRetryableError", async () => {
    await revokeInstallation(INST, "disconnected");
    const slack = useSlack();
    expect(await run({ installation_id: INST, mode: "check", event_time: NOW_SEC })).toEqual({ skipped: "not_active" });
    expect(slack.calls).toHaveLength(0);
    await expect(run({ installation_id: "esi_bad", mode: "check" })).rejects.toMatchObject({ name: "NonRetryableError" });
    await expect(run({ installation_id: INST, mode: "wipe" })).rejects.toMatchObject({ name: "NonRetryableError" });
  });
});

describe("mode purge (C18; UN01, UN04-UN07)", () => {
  it("UN01: app_uninstalled through RPC 1 → revoked and exactly one purge job; running it purges", async () => {
    h = useSlackDb({
      tables: {
        exec_slack_events: [replyEventRow({ reply_state: "answered" })],
        exec_slack_posts: [{ installation_id: INST, principal_id: "ep_1", channel_id: RI.dmChannelId, ts: TS, thread_ts: null, kind: "note", message_id: null, ref_id: null, posted_at: "2026-11-06T14:00:00.000Z", followed_at: null }],
        exec_conversations: [{ id: "ecv_" + "1".repeat(32), principal_id: "ep_1", surface: "slack", title: "t", create_client_turn_id: "slkc_D0MITCH_1_1", slack_channel_id: RI.dmChannelId, slack_thread_ts: TS, ref_seq: 0, turn_count: 1, created_at: "2026-11-05T00:00:00.000Z", updated_at: "2026-11-05T00:00:00.000Z", last_message_at: "2026-11-05T00:00:00.000Z", expires_at: "2027-02-01T00:00:00.000Z" }]
      }
    });
    const ack = await acceptEvent(facts("app_uninstalled", NOW_SEC), { signal: new AbortController().signal });
    expect(ack).toMatchObject({ outcome: "accepted", decision: "revoke" });
    expect(inst()).toMatchObject({ revoke_reason: "app_uninstalled" });
    const jobs = uninstallJobs("purge");
    expect(jobs).toHaveLength(1);
    expect(await run(jobs[0].payload as Record<string, unknown>)).toEqual({ purged: true, events: 2, posts: 1, conversations: 1 });
    expect(inst()).toMatchObject({ bot_token_enc: null, key_id: null });
    expect(h.db.tables.exec_slack_posts).toHaveLength(0);
  });

  it("UN04: the purge → counts; notifyOps with ids and counts only; the system audit row", async () => {
    await revokeInstallation(INST, "tokens_revoked");
    expect(await run({ installation_id: INST, mode: "purge" })).toEqual({ purged: true, events: 0, posts: 0, conversations: 0 });
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{
      key: "exec-slack-revoked",
      title: "Executive Assistant Slack app disconnected",
      detail: `installation ${INST}: tokens_revoked; events 0, posts 0, conversations 0`
    }]]);
    expect(vi.mocked(auditEvent).mock.calls).toEqual([[null, {
      actor: "system", action: "slack.revoked", target: `exec_slack_installations:${INST}`,
      input: { reason: "tokens_revoked", events: 0, posts: 0, conversations: 0 }
    }]]);
  });

  it("UN05: the purge RPC missing (migration not applied) → NonRetryableError not_installed", async () => {
    await revokeInstallation(INST, "app_uninstalled");
    h.db.missing.add("exec_slack_purge_installation");
    await expect(run({ installation_id: INST, mode: "purge" })).rejects.toMatchObject({ name: "NonRetryableError", message: "not_installed" });
  });

  it("UN06: a second purge run → no-op counts and no second ops alert or audit row", async () => {
    await revokeInstallation(INST, "app_uninstalled");
    await run({ installation_id: INST, mode: "purge" });
    expect(await run({ installation_id: INST, mode: "purge" })).toMatchObject({ events: 0, posts: 0, conversations: 0 });
    expect(vi.mocked(notifyOps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditEvent)).toHaveBeenCalledTimes(1);
    // A purge of a row that was never revoked does nothing and alerts nobody.
    h = useSlackDb();
    vi.mocked(notifyOps).mockClear();
    expect(await run({ installation_id: INST, mode: "purge" })).toEqual({ purged: false, events: 0, posts: 0, conversations: 0 });
    expect(vi.mocked(notifyOps)).not.toHaveBeenCalled();
  });

  it("UN-B (fixer correctness-5): the daily backstop purges a revocation whose purge job died (over an hour old, purged_at null), once, with the alert and audit; younger or purged rows are left alone", async () => {
    const OLD = `esi_${"a".repeat(32)}`;
    const YOUNG = `esi_${"b".repeat(32)}`;
    const DONE = `esi_${"c".repeat(32)}`;
    const at = (ms: number) => new Date(ms).toISOString();
    h = useSlackDb({ tables: { exec_slack_installations: [
      installationRow({ id: OLD, revoked_at: at(NOW_MS - 2 * 3_600_000), revoke_reason: "disconnected" }),
      installationRow({ id: YOUNG, slack_dm_channel_id: "D0YOUNG", revoked_at: at(NOW_MS - 10 * 60_000), revoke_reason: "app_uninstalled" }),
      installationRow({ id: DONE, slack_dm_channel_id: "D0DONE", revoked_at: at(NOW_MS - 5 * 3_600_000), revoke_reason: "app_uninstalled", bot_token_enc: null, key_id: null, purged_at: at(NOW_MS - 4 * 3_600_000) })
    ] } });
    expect(UNPURGED_REVOCATION_GRACE_MS).toBe(3_600_000);
    expect(await purgeUnpurgedRevocations(new Date(NOW_MS))).toBe(1);
    const row = (id: string) => h.db.tables.exec_slack_installations.find((i) => i.id === id) as Record<string, unknown>;
    expect([row(OLD).bot_token_enc, row(OLD).key_id, row(OLD).purged_at !== null]).toEqual([null, null, true]);
    expect(row(YOUNG).bot_token_enc).not.toBeNull();
    expect(row(YOUNG).purged_at).toBeNull();
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].detail)).toEqual([`installation ${OLD}: disconnected; events 0, posts 0, conversations 0`]);
    expect(vi.mocked(auditEvent)).toHaveBeenCalledTimes(1);
    // Idempotent: the next day finds nothing (and an hour later the young one goes too).
    expect(await purgeUnpurgedRevocations(new Date(NOW_MS))).toBe(0);
    expect(await purgeUnpurgedRevocations(new Date(NOW_MS + 3_600_000))).toBe(1);
    expect(row(YOUNG).bot_token_enc).toBeNull();
    expect(vi.mocked(notifyOps)).toHaveBeenCalledTimes(2);
    // Before the P6 migration: nothing to list.
    h.db.missing.add("exec_slack_installations");
    expect(await purgeUnpurgedRevocations(new Date(NOW_MS))).toBe(0);
  });

  it("UN07: after a disconnect, a late app_uninstalled finds no active row → dropped not_installed", async () => {
    await revokeInstallation(INST, "disconnected");
    const before = uninstallJobs().length;
    const ack = await acceptEvent(facts("app_uninstalled", NOW_SEC), { signal: new AbortController().signal });
    expect(ack).toMatchObject({ outcome: "accepted", decision: "drop", reason: "not_installed" });
    expect(uninstallJobs()).toHaveLength(before);
    expect(inst()).toMatchObject({ revoke_reason: "disconnected" });
  });
});

describe("UN08 (security-2): a dead token found by any job reaches the check", () => {
  const readyTurn = () => {
    vi.mocked(prepareChatTurn).mockImplementation(async (_p, _s, req) => ({
      kind: "started",
      begin: { outcome: "started", conversationId: String(req.conversationId), created: false, turnId: TURN(1), userMessageId: MSG(1), userCreatedAt: new Date().toISOString(), assistantMessageId: MSG(2), refSeq: 0, contextRef: null },
      context: null
    }));
    vi.mocked(runPreparedTurn).mockResolvedValue({ done: chatDone({ messageId: MSG(2) }), audit: { status: "complete", statusReason: null, modelCalls: 1, toolCalls: 0, costUsd: 0 } });
  };
  const reply = (eventId: string, ts: string) =>
    slackReplyJobHandler.run(jobCtx("exec.slack-reply", { event_id: eventId, installation_id: INST, channel: RI.dmChannelId, ts, thread_ts: null, event_time: NOW_SEC - 1 }));

  it("a placeholder post failing token_revoked → one check job keyed by the hour; a second failure that hour adds none; the check revokes and enqueues one purge", async () => {
    readyTurn();
    h = useSlackDb({ tables: { exec_slack_events: [replyEventRow({ message_ts: TS }), replyEventRow({ event_id: "Ev0SLACKREPLY2", message_ts: "1793977202.000100" })] } });
    let slack = useSlack({ "chat.postMessage": slackError("token_revoked") }, { ts: TS, user: RI.userId, text: "hi", type: "message" });
    await expect(reply(EVENT_ID, TS)).rejects.toMatchObject({ code: "token_revoked" });
    slack.restore();
    slack = useSlack({ "chat.postMessage": slackError("token_revoked") }, { ts: "1793977202.000100", user: RI.userId, text: "hi", type: "message" });
    await expect(reply("Ev0SLACKREPLY2", "1793977202.000100")).rejects.toMatchObject({ code: "token_revoked" });
    slack.restore();

    const checks = uninstallJobs("check");
    expect(checks.map((j) => [j.dedupe_key, j.lane, j.principal_id, j.max_attempts])).toEqual([[`slack-revoke-check:auth:${INST}:2026110615`, "bulk", null, 3]]);
    expect(checks[0].payload).toEqual({ installation_id: INST, mode: "check", event_time: NOW_SEC });

    slack = useSlack({ "auth.test": slackError("token_revoked") });
    expect(await run(checks[0].payload as Record<string, unknown>)).toEqual({ revoked: true });
    expect(inst()).toMatchObject({ revoke_reason: "tokens_revoked" });
    expect(uninstallJobs("purge")).toHaveLength(1);
  });

  it("a ratelimited failure enqueues no check", async () => {
    readyTurn();
    h = useSlackDb({ tables: { exec_slack_events: [replyEventRow({ message_ts: TS })] } });
    useSlack({ "chat.postMessage": slackRateLimited() }, { ts: TS, user: RI.userId, text: "hi", type: "message" });
    await expect(reply(EVENT_ID, TS)).rejects.toMatchObject({ code: "ratelimited", errorClass: "retryable" });
    expect(uninstallJobs()).toHaveLength(0);
    expect(inst().last_error_code).toBeNull();
  });

  it("the handler: bulk lane, 60 s", () => {
    expect(slackUninstallJobHandler).toMatchObject({ kind: "exec.slack-uninstall", lane: "bulk", timeoutMs: 60_000 });
    expect(installationRow().id).toBe(INST);
  });
});
