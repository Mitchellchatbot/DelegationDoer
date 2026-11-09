import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/brief-ownership-load", () => ({ loadBriefOwnership: vi.fn(), checkinApprovalSource: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  openInstallationById: vi.fn(), recordSlackError: vi.fn(), enqueueRevokeCheck: vi.fn(), clearSlackError: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUsers: vi.fn(), listDepartments: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), putSyncState: vi.fn() }));

import { assertNoBriefText, BRIEF_TEXT_SENTINELS, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { BOT_TOKEN, checkinId, checkinSeed, DM, NOW, ownership, PRINCIPAL, settings, settle, TEAM, USER_TOKEN } from "@/lib/exec/__tests__/brief-d-harness";
import {
  checkinRow, checkinsMessage, clickCtx, clickPayload, messageText, postsAsHim, sendButtons, setupClickWorld, valueOf, type ClickWorld
} from "@/lib/exec/__tests__/checkin-click-harness";
import { createFakeSlackDb } from "@/lib/exec/__tests__/fake-slack-db";
import { installationRow } from "@/lib/exec/__tests__/slack-route-helpers";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { BRIEF_COPY, BRIEF_OPS } from "@/lib/exec/brief-copy";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { checkinPostKeys, checkinStep, expireCheckins } from "@/lib/exec/brief-store";
import { CHECKIN_SEND_JOB_KIND, checkinSendJobHandler, type CheckinResult } from "@/lib/exec/handlers/checkin-send";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { briefAnsweredExclusion } from "@/lib/exec/runtime";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";
import { listUsers } from "@/lib/exec/sources/dd";
import { putSyncState } from "@/lib/exec/sync-state";
import { AuditUnavailableError } from "@/lib/exec/types";

// P8 §5.11 CI09-CI23, CI26-CI29 (Area D): exec.checkin-send, one Send click (M6, C6, C7, C50; intel-17). The brief store and the
// MAC are real (the store over the standalone fake, the MAC under a test EXEC_TOKEN_KEY); checkin-post.ts reads his token from the
// fake users table and posts through P6's client into the stateful fake Slack. The audit, ownership and settings are mocked.

let w: ClickWorld;
let out: ReturnType<typeof captureConsole>;
const ID1 = checkinId(1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  w = setupClickWorld();
});
afterEach(() => {
  // CI28: no check-in text, no note, no token, no MAC-bearing value in a log or an ops alert.
  assertNoBriefText(out.calls(), { label: "console" });
  assertNoBriefText(vi.mocked(notifyOps), { label: "notifyOps" });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const send = (payload: Record<string, unknown>) => settle(checkinSendJobHandler.run(clickCtx(CHECKIN_SEND_JOB_KIND, payload)) as Promise<CheckinResult>);
const sendNow = (id = ID1) => send(clickPayload(id, valueOf(w.db, id)));

describe("CI19 the post as Mitchell", () => {
  it("success → sent with ts, channel and sent_at; audit started first and finished ok; token health ok; the message re-rendered", async () => {
    let postsAtAudit = -1;
    vi.mocked(auditStart).mockImplementationOnce(async () => {
      postsAtAudit = postsAsHim(w.ws).length;
      return 1;
    });
    const r = await sendNow();
    expect(postsAtAudit).toBe(0);
    expect(r).toEqual({ status: "sent", reason: null });
    const [post] = postsAsHim(w.ws);
    expect(post).toMatchObject({ channel: w.ws.imFor(USER_TOKEN, "U0P1") });
    expect(checkinRow(w.db, ID1)).toMatchObject({ status: "sent", slack_ts: post.ts, slack_channel_id: post.channel, audit_id: 1 });
    expect(checkinRow(w.db, ID1).sent_at).not.toBeNull();
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[1, { ok: true, result: { ts: post.ts } }]]);
    expect(vi.mocked(putSyncState).mock.calls.map((c) => [c[1], c[2], (c[3] as { state: string }).state])).toContainEqual(["brief", "token-health", "ok"]);
    expect(messageText(w.ws)).toContain(escapeMrkdwn("Sent to Person1 at"));
    assertNoBriefText(r);
  });

  it("an ambiguous post (timeout) → unknown, never retried", async () => {
    w.ws.failNext("chat.postMessage", "timeout");
    expect(await sendNow()).toEqual({ status: "unknown", reason: "timeout" });
    expect(w.slack.calls.filter((c) => c.method === "chat.postMessage" && c.headers.authorization === `Bearer ${USER_TOKEN}`)).toHaveLength(1);
    expect(checkinRow(w.db, ID1)).toMatchObject({ status: "unknown", status_reason: "timeout" });
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[1, { ok: false, error: "unknown" }]]);
    expect(await sendNow().catch(() => null)).toMatchObject({ reason: "not_proposed" });
    expect(postsAsHim(w.ws)).toHaveLength(0);
  });

  it("a clear error → failed with the code", async () => {
    w.ws.failNext("chat.postMessage", { error: "not_in_channel" });
    expect(await sendNow()).toEqual({ status: "failed", reason: "not_in_channel" });
    expect(checkinRow(w.db, ID1)).toMatchObject({ status: "failed", status_reason: "not_in_channel" });
    expect(vi.mocked(auditFinish).mock.calls).toEqual([[1, { ok: false, error: "not_in_channel" }]]);
  });
});

describe("CI09, CI10, CI23 the button is checked against the stored row", () => {
  it("CI09 the row's text edited in the database after the render → mac_mismatch (logged by id), nothing posted", async () => {
    const value = valueOf(w.db, ID1);
    checkinRow(w.db, ID1).text = "Edited text in the database";
    expect(await send(clickPayload(ID1, value))).toEqual({ status: "proposed", reason: "mac_mismatch" });
    expect(postsAsHim(w.ws)).toEqual([]);
    expect(out.calls().flat().join(" ")).toContain(`checkin ${ID1} mac_mismatch`);
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("CI10 a rewrite (rev 1 → 2) invalidates the rev-1 button (stale); the rev-2 value works", async () => {
    const old = valueOf(w.db, ID1);
    // C6 (integrator, M27): the rev is bound into the MAC itself, not only compared. The rev-1 MAC under a forged rev, with the
    // stored rev moved to match and the text unchanged, is refused as a MAC mismatch.
    const forged = old.replace(/\.1\.([0-9a-f]{32})$/, ".7.$1");
    expect(forged).not.toBe(old);
    Object.assign(checkinRow(w.db, ID1), { rev: 7 });
    expect(await send(clickPayload(ID1, forged))).toEqual({ status: "proposed", reason: "mac_mismatch" });
    expect(postsAsHim(w.ws)).toEqual([]);
    Object.assign(checkinRow(w.db, ID1), { rev: 2, text: "A different note." });
    expect(await send(clickPayload(ID1, old))).toEqual({ status: "proposed", reason: "stale" });
    expect(postsAsHim(w.ws)).toEqual([]);
    expect(await send(clickPayload(ID1, valueOf(w.db, ID1)))).toEqual({ status: "sent", reason: null });
  });

  it("CI23 the payload's message_ts must be the brief's checkins_ts; another message → skipped, no render", async () => {
    expect(await send(clickPayload(ID1, valueOf(w.db, ID1), { message_ts: "1794000009.000100" }))).toEqual({ skipped: "other_message" });
    expect(checkinsMessage(w.ws)?.updates).toBe(0);
    expect(await send(clickPayload(ID1, valueOf(w.db, ID1), { checkin_id: checkinId(2) }))).toEqual({ skipped: "bad_value" });
    expect(await send(clickPayload(ID1, valueOf(w.db, ID1), { channel_id: "D0OTHER" }))).toEqual({ skipped: "installation" });
    expect(postsAsHim(w.ws)).toEqual([]);
  });
});

describe("CI12-CI14 the auth.test binding of his DD token (M6)", () => {
  it("CI12 another user → mismatch: no post, failed token_mismatch, BRIEF_OPS.tokenMismatch, the message with no Send buttons and the token note", async () => {
    w.ws.tokens.set(USER_TOKEN, { userId: "U0SOMEONE", teamId: TEAM });
    expect(await sendNow()).toEqual({ status: "failed", reason: "token_mismatch" });
    expect(postsAsHim(w.ws)).toEqual([]);
    expect(checkinRow(w.db, ID1)).toMatchObject({ status: "failed", status_reason: "token_mismatch" });
    expect(vi.mocked(notifyOps).mock.calls.map((c) => c[0].key)).toEqual([BRIEF_OPS.tokenMismatch.key(PRINCIPAL.id)]);
    expect(sendButtons(w.ws)).toEqual([]);
    expect(messageText(w.ws)).toContain(escapeMrkdwn(BRIEF_COPY.checkinsPaused.token).slice(0, 40));
  });

  it("CI12 another team → mismatch", async () => {
    w.ws.tokens.set(USER_TOKEN, { userId: "U0MITCH", teamId: "T0ELSE" });
    expect(await sendNow()).toEqual({ status: "failed", reason: "token_mismatch" });
  });

  it("CI13 SLACK_USER_TOKEN in env and the column empty → failed token_missing, the missing note, no post", async () => {
    vi.stubEnv("SLACK_USER_TOKEN", USER_TOKEN);
    w.db.tables.users[0].slack_user_token = null;
    expect(await sendNow()).toEqual({ status: "failed", reason: "token_missing" });
    expect(postsAsHim(w.ws)).toEqual([]);
    expect(messageText(w.ws)).toContain("Sending is paused: DD has no Slack connection");
  });

  it("CI14 token_revoked → failed token_revoked", async () => {
    w.ws.tokens.set(USER_TOKEN, { error: "token_revoked" });
    expect(await sendNow()).toEqual({ status: "failed", reason: "token_revoked" });
    expect(checkinRow(w.db, ID1)).toMatchObject({ status: "failed", status_reason: "token_revoked" });
  });
});

describe("CI15, CI15b, CI16 audit first, fail closed; the button stays live", () => {
  it("CI15 auditStart unavailable → no CAS, no post, the row stays proposed, the busy note; CI15b a second click sends once", async () => {
    // CI15b (intel-17, integrator): both clicks go through RPC 2 v2 (P6's fake) as in production. Jobs are keyed by the click
    // (its trigger id), so the second click on the same check-in and rev is a new job, not a duplicate of the failed one.
    const value = valueOf(w.db, ID1);
    const sdb = createFakeSlackDb({ tables: { exec_slack_installations: [installationRow()] } });
    const rpc = (sdb.client as { rpc(n: string, a: object): Promise<{ data: unknown }> }).rpc.bind(sdb.client);
    const click = async (trigger: string) => (await rpc("exec_slack_accept_action_v2", { p_team_id: "T0SCALED", p_api_app_id: "A0EXEC",
      p_user_id: "U0MITCH", p_trigger_id: trigger, p_action_id: "ea_ci_send", p_value: value, p_container_type: "message", p_channel_id: DM,
      p_message_ts: "1794000002.000100" })).data;
    const runJob = (i: number) => send(sdb.tables.exec_jobs[i].payload as Record<string, unknown>);
    vi.mocked(auditStart).mockRejectedValueOnce(new AuditUnavailableError("audit down"));
    expect(await click("t.1")).toEqual({ outcome: "enqueued" });
    expect(await runJob(0)).toEqual({ status: "proposed", reason: "audit_unavailable" });
    expect(checkinRow(w.db, ID1)).toMatchObject({ status: "proposed", rev: 1 });
    expect(postsAsHim(w.ws)).toEqual([]);
    expect(messageText(w.ws)).toContain(escapeMrkdwn(BRIEF_COPY.checkinsPaused.busy));
    expect(await click("t.2")).toEqual({ outcome: "enqueued" });
    expect(sdb.tables.exec_jobs).toHaveLength(2);
    expect(await runJob(1)).toEqual({ status: "sent", reason: null });
    expect(postsAsHim(w.ws)).toHaveLength(1);
  });

  it("CI15b the same after a checkinsPaused.disabled exit, once check-ins are on again", async () => {
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ checkinsEnabled: false }));
    expect(await sendNow()).toEqual({ status: "proposed", reason: "disabled" });
    expect(messageText(w.ws)).toContain(escapeMrkdwn(BRIEF_COPY.checkinsPaused.disabled));
    expect(await sendNow()).toEqual({ status: "sent", reason: null });
    expect(postsAsHim(w.ws)).toHaveLength(1);
  });

  it("CI16 the audit input holds ids and a 16-hex text fingerprint only", async () => {
    await sendNow();
    const [[principal, entry]] = vi.mocked(auditStart).mock.calls;
    expect(principal).toBe(PRINCIPAL);
    expect(entry).toEqual({ actor: "slack", action: "brief.checkin.send", target: `exec_brief_checkins:${ID1}`,
      input: { checkinId: ID1, rev: 1, recipientUserId: "u_1", recipientSlackId: "U0P1", textSha256: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    assertNoBriefText(vi.mocked(auditStart), { label: "auditStart" });
    assertNoBriefText(vi.mocked(auditFinish), { label: "auditFinish" });
  });
});

describe("CI17, CI18 clicks are jobs; one post per row", () => {
  it("CI17 two clicks (two trigger ids) → two jobs through RPC 2 v2; run together → exactly one post; Slack retrying one click → one job", async () => {
    const value = valueOf(w.db, ID1);
    const sdb = createFakeSlackDb({ tables: { exec_slack_installations: [installationRow()] } });
    const rpc = (sdb.client as { rpc(n: string, a: object): Promise<{ data: unknown }> }).rpc.bind(sdb.client);
    const click = (trigger: string) => rpc("exec_slack_accept_action_v2", { p_team_id: "T0SCALED", p_api_app_id: "A0EXEC", p_user_id: "U0MITCH",
      p_trigger_id: trigger, p_action_id: "ea_ci_send", p_value: value, p_container_type: "message", p_channel_id: DM, p_message_ts: "1794000002.000100" });
    expect((await click("t.1")).data).toEqual({ outcome: "enqueued" });
    expect((await click("t.1")).data).toEqual({ outcome: "duplicate" });
    expect((await click("t.2")).data).toEqual({ outcome: "enqueued" });
    expect(sdb.tables.exec_jobs.map((j) => [j.kind, j.dedupe_key, j.max_attempts])).toEqual([
      ["exec.checkin-send", "checkin-send:t.1", 1], ["exec.checkin-send", "checkin-send:t.2", 1]
    ]);
    const results = await settle(Promise.all(sdb.tables.exec_jobs.map((j) => checkinSendJobHandler.run(clickCtx(CHECKIN_SEND_JOB_KIND, j.payload as Record<string, unknown>)))));
    expect(postsAsHim(w.ws)).toHaveLength(1);
    expect(results.filter((r) => (r as { status?: string }).status === "sent")).toHaveLength(1);
    expect(checkinRow(w.db, ID1)).toMatchObject({ status: "sent" });
  });

  it("CI18 a row found sending for more than 60 s → unknown found_sending, no post; one sending 5 s → render only, and the in-flight send still completes", async () => {
    Object.assign(checkinRow(w.db, ID1), { status: "sending", sending_at: new Date(NOW.getTime() - 61_000).toISOString(), audit_id: 7 });
    expect(await sendNow()).toEqual({ status: "unknown", reason: "found_sending" });
    expect(postsAsHim(w.ws)).toEqual([]);
    Object.assign(checkinRow(w.db, ID1), { status: "sending", status_reason: null, sending_at: new Date(NOW.getTime() - 5_000).toISOString() });
    expect(await sendNow()).toEqual({ status: "sending", reason: "in_flight" });
    expect(checkinRow(w.db, ID1).status).toBe("sending");
    expect(await checkinStep(PRINCIPAL, ID1, { from: ["sending"], rev: 1, to: "sent", sentAt: NOW.toISOString(), channel: "D0IM001", ts: "1794000003.000100" })).toBe(true);
    expect(postsAsHim(w.ws)).toEqual([]);
  });
});

describe("CI21, CI22 the gates", () => {
  it("CI21 expired → expired, no post; check-ins off → no post, the disabled note; the verdict not exec → no post, notOwned", async () => {
    checkinRow(w.db, ID1).expires_at = new Date(NOW.getTime() - 1).toISOString();
    expect(await sendNow()).toEqual({ status: "expired", reason: "expired" });
    const id2 = checkinId(2);
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ checkinsEnabled: false }));
    expect(await sendNow(id2)).toEqual({ status: "proposed", reason: "disabled" });
    vi.mocked(loadBriefOwnership).mockResolvedValueOnce(ownership("exec_page_only", "not_superseding"));
    expect(await sendNow(id2)).toEqual({ status: "proposed", reason: "not_owned" });
    expect(messageText(w.ws)).toContain(escapeMrkdwn(BRIEF_COPY.checkinsPaused.notOwned));
    expect(postsAsHim(w.ws)).toEqual([]);
  });

  it("CI22 the recipient's Slack account changed (another id) or the DD user was deleted → failed recipient_changed", async () => {
    w.ws.users.set("p1@scaledai.org", { id: "U0SOMEONE" });
    expect(await sendNow()).toEqual({ status: "failed", reason: "recipient_changed" });
    vi.mocked(listUsers).mockResolvedValueOnce([]);
    expect(await sendNow(checkinId(2))).toEqual({ status: "failed", reason: "recipient_changed" });
    expect(postsAsHim(w.ws)).toEqual([]);
    expect(messageText(w.ws)).toContain(escapeMrkdwn(BRIEF_COPY.checkinStatus.recipient));
  });
});

describe("CI26-CI29 the message, expiries, results and P7a's exclusion hook", () => {
  it("CI26 after each outcome the message shows each row's status line, and only a proposed row keeps its buttons", async () => {
    await sendNow();
    const text = messageText(w.ws);
    expect(text).toContain("Sent to Person1 at");
    expect(sendButtons(w.ws)).toEqual([valueOf(w.db, checkinId(2))]);
    expect(text).not.toContain(BRIEF_TEXT_SENTINELS.token);
    expect(checkinsMessage(w.ws)?.token).toBe(BOT_TOKEN);
  });

  it("CI27 the next day's build expires yesterday's proposed rows (next_brief); sent rows stay", async () => {
    Object.assign(checkinRow(w.db, checkinId(2)), { status: "sent", sending_at: NOW.toISOString(), sent_at: NOW.toISOString(), audit_id: 3, slack_channel_id: "D0IM001", slack_ts: "1794000003.000100" });
    expect(await expireCheckins(PRINCIPAL, { beforeLocalDate: "2026-11-10", reason: "next_brief" })).toBe(1);
    expect(w.db.tables.exec_brief_checkins.map((r) => [r.status, r.status_reason ?? null])).toEqual([["expired", "next_brief"], ["sent", null]]);
  });

  it("CI28 results carry codes only (sentinels incl. the token)", async () => {
    for (const r of [await sendNow(), await send(clickPayload(ID1, valueOf(w.db, ID1), { message_ts: "1794000009.000100" }))]) {
      assertNoBriefText(r);
      expect(JSON.stringify(r)).not.toMatch(/xox|c1\./);
    }
  });

  it("CI29 checkinPostKeys returns sent check-ins' keys only, for that principal; the registered adapter keeps exactly those rows", async () => {
    await sendNow();
    const sent = checkinRow(w.db, ID1);
    const keys = [{ channelId: String(sent.slack_channel_id), ts: String(sent.slack_ts) }, { channelId: "D0IM009", ts: "1794000009.000100" }];
    expect([...(await checkinPostKeys(PRINCIPAL, keys))]).toEqual([`${sent.slack_channel_id}:${sent.slack_ts}`]);
    const other = { ...PRINCIPAL, id: "ep_2" } as typeof PRINCIPAL;
    expect([...(await checkinPostKeys(other, keys))]).toEqual([]);
    const rows = keys.map((k) => ({ channelId: k.channelId, respondedTs: k.ts }));
    expect(await briefAnsweredExclusion(PRINCIPAL, rows)).toEqual([rows[0]]);
  });

  it("the handler is interactive, 30 s; a malformed payload is refused", async () => {
    expect(checkinSendJobHandler).toMatchObject({ kind: "exec.checkin-send", lane: "interactive", timeoutMs: 30_000 });
    await expect(checkinSendJobHandler.run(clickCtx(CHECKIN_SEND_JOB_KIND, { checkin_id: "x" }))).rejects.toMatchObject({ name: "NonRetryableError" });
    expect(w.db.client as SupabaseClient).toBeTruthy();
  });
});
