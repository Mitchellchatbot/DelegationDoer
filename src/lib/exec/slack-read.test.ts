import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  openReadingInstallation: vi.fn(), recordUserTokenError: vi.fn(), clearUserTokenError: vi.fn(), enqueueUserCheck: vi.fn()
}));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  listFbLeadChannels: vi.fn(), listClients: vi.fn(), getClientEmailChannelId: vi.fn(), listDdBotDmChannelIds: vi.fn()
}));
vi.mock("@/lib/exec/dd-bot", () => ({ getDdBotIdentity: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-read-store")>()),
  markDeleted: vi.fn(), noteMessages: vi.fn(), noteFromHim: vi.fn(), setAcknowledged: vi.fn()
}));

import { SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { DD_BOT, HIM, NOW, PRINCIPAL, channelRow, readMessage, readingInstallation, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { clearUserTokenError, enqueueUserCheck, openReadingInstallation, recordUserTokenError } from "@/lib/exec/slack-install";
import { noteSlackRateLimited, SlackRateBudgetError, takeSlackBudget } from "@/lib/exec/slack-rate";
import {
  __resetSlackReadForTests,
  classifierContext,
  enqueueSlackSweepNow,
  grantedTypes,
  isRateLimited,
  noteWindow,
  openReader,
  paced,
  slackAttentionKick,
  tsPlusSeconds,
  windowContext
} from "@/lib/exec/slack-read";
import { markDeleted, noteFromHim, noteMessages, setAcknowledged } from "@/lib/exec/slack-read-store";
import { getClientEmailChannelId, listClients, listDdBotDmChannelIds, listFbLeadChannels, DdReadError } from "@/lib/exec/sources/dd";
import { SlackApiError } from "@/lib/exec/sources/slack";

// P7a contract §3.11.0 (Area D): slack-read.ts, the job glue. RL09's `paced` half (Area B's request), N51 (the user check on a
// dead user token), CJ05 (the classifier context cache), the reader, the enqueues, and noteWindow's order.

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
  __resetSlackReadForTests();
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(openReadingInstallation).mockResolvedValue(readingInstallation());
  vi.mocked(takeSlackBudget).mockResolvedValue(undefined);
  vi.mocked(noteSlackRateLimited).mockResolvedValue(undefined);
  vi.mocked(listFbLeadChannels).mockResolvedValue([{ name: "acme-vob-leads", channelId: "C0LEADS" }]);
  vi.mocked(listClients).mockResolvedValue([{ id: "c1", name: "Acme Recovery", status: "active" }] as never);
  vi.mocked(getClientEmailChannelId).mockResolvedValue("C0EMAIL");
  vi.mocked(listDdBotDmChannelIds).mockResolvedValue(["D0DDBOT"]);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: "T0SCALED", userId: DD_BOT.userId, botId: "B0DDBOT", appId: DD_BOT.appId, checkedAt: NOW.toISOString() });
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(markDeleted).mockResolvedValue({ items: 0, messages: 1, attention: 0 });
  vi.mocked(noteMessages).mockResolvedValue({ candidates: 1, anchors: 1, blocked: 0, optedOut: 0, jobs: 1 });
  vi.mocked(noteFromHim).mockResolvedValue({ stamped: 2, skipped: 0 });
  vi.mocked(setAcknowledged).mockResolvedValue(1);
});
afterEach(() => {
  out.assertClean();
});

describe("openReader", () => {
  it("the schema, the reading half, its state; SecretUnavailableError → a non-retryable auth error", async () => {
    expect(await openReader(PRINCIPAL)).toMatchObject({ row: { id: expect.any(String) } });
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReadingSchemaReady: false }));
    expect(await openReader(PRINCIPAL)).toBeNull();
    vi.mocked(openReadingInstallation).mockResolvedValueOnce(null);
    expect(await openReader(PRINCIPAL)).toBeNull();
    vi.mocked(openReadingInstallation).mockResolvedValueOnce(readingInstallation({ reading: { state: "revoked" } }));
    expect(await openReader(PRINCIPAL)).toBeNull();
    vi.mocked(openReadingInstallation).mockRejectedValueOnce(new SecretUnavailableError("not_configured", "no key"));
    await expect(openReader(PRINCIPAL)).rejects.toMatchObject({ name: "NonRetryableError", errorClass: "auth" });
  });
});

describe("RL09 / N51: paced", () => {
  const ri = () => readingInstallation();
  it("takes the budget first, then calls; a budget refusal makes no call", async () => {
    const call = vi.fn().mockResolvedValue("ok");
    expect(await paced(ri(), "conversations.history", "sweep", call)).toBe("ok");
    expect(vi.mocked(takeSlackBudget).mock.calls[0].slice(0, 3)).toEqual(["T0SCALED", "conversations.history", "sweep"]);
    expect(vi.mocked(takeSlackBudget).mock.invocationCallOrder[0]).toBeLessThan(call.mock.invocationCallOrder[0]);
    vi.mocked(takeSlackBudget).mockRejectedValueOnce(new SlackRateBudgetError(20_000));
    const second = vi.fn();
    await expect(paced(ri(), "conversations.history", "sweep", second)).rejects.toBeInstanceOf(SlackRateBudgetError);
    expect(second).not.toHaveBeenCalled();
  });

  it("RL09 a ratelimited SlackApiError → noteSlackRateLimited(team, method, retryAfterMs), rethrown; no retryAfter → 30 s", async () => {
    const limited = new SlackApiError("conversations.history", "ratelimited", { errorClass: "retryable", status: 429, retryAfterMs: 12_000 });
    await expect(paced(ri(), "conversations.history", "sweep", () => Promise.reject(limited))).rejects.toBe(limited);
    expect(noteSlackRateLimited).toHaveBeenCalledWith("T0SCALED", "conversations.history", 12_000);
    const bare = new SlackApiError("users.info", "ratelimited", { errorClass: "retryable" });
    await expect(paced(ri(), "users.info", "triage", () => Promise.reject(bare))).rejects.toBe(bare);
    expect(noteSlackRateLimited).toHaveBeenLastCalledWith("T0SCALED", "users.info", 30_000);
    expect(isRateLimited(limited)).toBe(true);
    expect(isRateLimited(new SlackRateBudgetError(1000))).toBe(true);
    expect(recordUserTokenError).not.toHaveBeenCalled();
  });

  it("N51 an auth-class error records the code; the four dead-token codes enqueue the user check; missing_scope doesn't", async () => {
    for (const code of ["invalid_auth", "token_revoked", "account_inactive", "not_authed"]) {
      const e = new SlackApiError("conversations.history", code, { errorClass: "auth" });
      await expect(paced(ri(), "conversations.history", "sweep", () => Promise.reject(e))).rejects.toBe(e);
      expect(recordUserTokenError).toHaveBeenLastCalledWith(ri().row.id, code);
    }
    expect(enqueueUserCheck).toHaveBeenCalledTimes(4);
    const scope = new SlackApiError("conversations.history", "missing_scope", { errorClass: "auth" });
    await expect(paced(ri(), "conversations.history", "sweep", () => Promise.reject(scope))).rejects.toBe(scope);
    expect(enqueueUserCheck).toHaveBeenCalledTimes(4);
    expect(noteSlackRateLimited).not.toHaveBeenCalled();
  });

  it("a fatal error is rethrown untouched; a success after a recorded error clears it once per opened half", async () => {
    const fatal = new SlackApiError("conversations.history", "channel_not_found", { errorClass: "fatal" });
    await expect(paced(ri(), "conversations.history", "sweep", () => Promise.reject(fatal))).rejects.toBe(fatal);
    expect(recordUserTokenError).not.toHaveBeenCalled();
    const broken = readingInstallation({ reading: { lastErrorCode: "invalid_auth" } });
    await paced(broken, "conversations.history", "sweep", async () => 1);
    await paced(broken, "conversations.history", "sweep", async () => 1);
    expect(clearUserTokenError).toHaveBeenCalledTimes(1);
    await paced(ri(), "conversations.history", "sweep", async () => 1);
    expect(clearUserTokenError).toHaveBeenCalledTimes(1);
  });
});

describe("the classifier context", () => {
  it("every DD read, the lead slugs, the hubs, the DD bot; the installation's own ids; the granted types", async () => {
    const ctx = await classifierContext(PRINCIPAL, readingInstallation({ reading: { scopes: ["channels:history", "channels:read", "groups:history", "groups:read", "users:read"] } }),
      { botUserIds: new Set(["U0ZAP"]), slackMutedIds: null });
    expect(ctx).toMatchObject({ principalSlackUserId: HIM, assistantDmChannelId: "D0MITCH", assistantBotUserId: "U0BOT", ddBotUserId: "U0DDBOT", clientEmailChannelId: "C0EMAIL" });
    expect([...ctx.fbLeadChannelIds]).toEqual(["C0LEADS"]);
    expect([...ctx.fbLeadNames]).toEqual(["acme-vob-leads"]);
    expect([...ctx.ddBotDmChannelIds]).toEqual(["D0DDBOT"]);
    expect(ctx.leadSlugs).toContain("acme-recovery");
    expect([...ctx.grantedTypes].sort()).toEqual(["channel", "group"]);
    expect([...(ctx.botUserIds ?? [])]).toEqual(["U0ZAP"]);
  });

  it("DI02 any DD read failing throws (no partial context); the DD bot failing is tolerated", async () => {
    for (const fn of [listFbLeadChannels, listClients, getClientEmailChannelId, listDdBotDmChannelIds]) {
      __resetSlackReadForTests();
      vi.mocked(fn).mockRejectedValueOnce(new DdReadError("x", "57014"));
      await expect(classifierContext(PRINCIPAL, readingInstallation(), { botUserIds: null, slackMutedIds: null })).rejects.toBeInstanceOf(DdReadError);
    }
    __resetSlackReadForTests();
    vi.mocked(getDdBotIdentity).mockRejectedValueOnce(new Error("store down"));
    expect((await classifierContext(PRINCIPAL, readingInstallation(), { botUserIds: null, slackMutedIds: null })).ddBotUserId).toBeNull();
  });

  it("CJ05 cached per principal for 10 minutes: two calls → one set of DD reads; after the TTL, read again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await classifierContext(PRINCIPAL, readingInstallation(), { botUserIds: null, slackMutedIds: null });
      vi.setSystemTime(NOW.getTime() + 9 * 60_000);
      await classifierContext(PRINCIPAL, readingInstallation(), { botUserIds: new Set(), slackMutedIds: null });
      expect(listFbLeadChannels).toHaveBeenCalledTimes(1);
      expect(listClients).toHaveBeenCalledTimes(1);
      vi.setSystemTime(NOW.getTime() + 11 * 60_000);
      await classifierContext(PRINCIPAL, readingInstallation(), { botUserIds: null, slackMutedIds: null });
      expect(listFbLeadChannels).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("grantedTypes: each type needs its read and history scopes", () => {
    expect([...grantedTypes(["channels:read", "channels:history", "groups:read", "im:read", "im:history", "mpim:history"])].sort()).toEqual(["channel", "im"]);
    expect([...grantedTypes([])]).toEqual([]);
  });
});

describe("enqueues and ts arithmetic", () => {
  it("enqueueSlackSweepNow: bulk, one attempt, keyed by reason and minute", async () => {
    expect(await enqueueSlackSweepNow(PRINCIPAL, "brief", NOW)).toBe(true);
    expect(enqueueJob).toHaveBeenCalledWith({ kind: "exec.slack-read-sweep", lane: "bulk", principalId: "ep_1", payload: { reason: "brief" },
      dedupeKey: `slack-sweep-now:ep_1:brief:${Math.floor(NOW.getTime() / 60_000)}`, maxAttempts: 1 });
  });

  it("slackAttentionKick: the SQL kick's key (slack-attn:<p>:m<M+1>, +2 s, bulk, 3 attempts)", () => {
    const m = Math.floor(NOW.getTime() / 60_000) + 1;
    expect(slackAttentionKick(PRINCIPAL, NOW)).toEqual({ kind: "exec.slack-attention", lane: "bulk", principalId: "ep_1", payload: { kick: true },
      dedupeKey: `slack-attn:ep_1:m${m}`, runAfter: new Date(m * 60_000 + 2000), maxAttempts: 3 });
  });

  it("tsPlusSeconds keeps the fraction exactly", () => {
    expect(tsPlusSeconds("1794146400.000100", -600)).toBe("1794145800.000100");
    expect(tsPlusSeconds("bad", 1)).toBeNull();
  });
});

describe("noteWindow", () => {
  it("marks tombstones, notes candidates and anchors (with dd_paths), then stamps his messages, then his reactions", async () => {
    const ch = channelRow();
    const ri = readingInstallation();
    const w = windowContext(ri, ch, DD_BOT, new Set(["U0OPTOUT"]));
    const messages = [
      readMessage("1794149000.000100", { text: `<@${HIM}> ${S.text} please check`, reactedUserIds: [HIM] }),
      readMessage("1794149100.000100", { user: "U0DDBOT", appId: "A0DDAPP", text: "<https://operations.scaledai.org/tasks/t_9|Task>" }),
      readMessage("1794149200.000100", { user: "USLACKBOT", subtype: "tombstone", hidden: true, text: "This message was deleted." }),
      readMessage("1794149300.000100", { user: HIM, text: "<@U0JANE> done" }),
      readMessage("1794149400.000100", { user: "U0OPTOUT", text: `<@${HIM}> hi` })
    ];
    const counts = await noteWindow(PRINCIPAL, ch.channelId, messages, w, { lane: "bulk", bucket: "b5980500", now: NOW });
    expect(markDeleted).toHaveBeenCalledWith(PRINCIPAL, "C0GENERAL", ["1794149200.000100"], "tombstone");
    expect(vi.mocked(noteMessages).mock.calls[0][2]).toEqual([
      { ts: "1794149000.000100", thread_ts: null, role: "candidate", author: "U0JANE", author_external: false, reasons: 2, dd_paths: [] },
      { ts: "1794149100.000100", thread_ts: null, role: "anchor", author: null, author_external: false, reasons: 0, dd_paths: ["/tasks/t_9"] }
    ]);
    expect(vi.mocked(noteMessages).mock.calls[0].slice(3)).toEqual(["bulk", "b5980500"]);
    expect(noteFromHim).toHaveBeenCalledWith(PRINCIPAL, "C0GENERAL", [{ ts: "1794149300.000100", thread_ts: null, mentions: ["U0JANE"] }]);
    expect(setAcknowledged).toHaveBeenCalledWith(PRINCIPAL, "C0GENERAL", ["1794149000.000100"], NOW.toISOString());
    const order = [markDeleted, noteMessages, noteFromHim, setAcknowledged].map((f) => vi.mocked(f).mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(counts).toEqual({ candidates: 1, anchors: 1, stamped: 2, deleted: 1, acknowledged: 1, blocked: 0 });
    assertNoSlackText([vi.mocked(noteMessages).mock.calls, vi.mocked(noteFromHim).mock.calls, vi.mocked(markDeleted).mock.calls], { label: "rows", allow: ["userToken"] });
  });
});
