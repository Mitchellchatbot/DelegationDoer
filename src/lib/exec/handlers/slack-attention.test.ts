import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), getReadingHalf: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), listItemsForAttention: vi.fn(), unstampAnswered: vi.fn() }));
vi.mock("@/lib/exec/attention", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/attention")>()), syncAttention: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), tryAcquireLease: vi.fn(), releaseLease: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import { captureConsole, findSlackText } from "@/lib/exec/__tests__/slack-read-assert";
import { NOW, PRINCIPAL, channelDbRow, channelRow, installationRow, itemDbRow, itemRow, jobCtx, messageDbRow, readingHalf, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { syncAttention } from "@/lib/exec/attention";
import { slackAttentionJobHandler, slackAttentionScheduledWork } from "@/lib/exec/handlers/slack-attention";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf } from "@/lib/exec/slack-install";
import { listItemsForAttention, unstampAnswered } from "@/lib/exec/slack-read-store";
import { SLACK_ATTENTION_KINDS, msToTs } from "@/lib/exec/slack-read-types";
import { __resetAnsweredExclusionForTests, registerAnsweredExclusion } from "@/lib/exec/slack-reading";
import { releaseLease, tryAcquireLease } from "@/lib/exec/sync-state";

// P7a contract §3.11.6, §5.14 AT02 / AT10 / AT11 / AT13, §5.9 AN09 (Area D): exec.slack-attention (the store, the sync and the
// lease mocked at the module boundary).

const ts = msToTs(NOW.getTime() - 86_400_000);
const run = (payload: Record<string, unknown> = {}) => slackAttentionJobHandler.run(jobCtx("exec.slack-attention", payload));
let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  __resetAnsweredExclusionForTests();
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf() });
  vi.mocked(listItemsForAttention).mockResolvedValue({ items: [itemRow({ ts })], channels: [channelRow({ name: "general" })] });
  vi.mocked(syncAttention).mockResolvedValue({ inserted: 1, updated: 0, reopened: 0, resolved: 0, unchanged: 0 });
  vi.mocked(tryAcquireLease).mockResolvedValue(true);
  vi.mocked(releaseLease).mockResolvedValue(undefined);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(unstampAnswered).mockResolvedValue(0);
});
afterEach(() => {
  out.assertClean();
  vi.useRealTimers();
});

describe("exec.slack-attention", () => {
  it("AT02 syncs the producer's candidates within source slack and the Slack kinds; returns counts only", async () => {
    const r = await run();
    expect(r).toEqual({ inserted: 1, updated: 0, reopened: 0, resolved: 0, unchanged: 0, unstamped: 0 });
    const [principal, scope, candidates, now] = vi.mocked(syncAttention).mock.calls[0];
    expect(principal).toBe(PRINCIPAL);
    expect(scope).toEqual({ source: "slack", kinds: SLACK_ATTENTION_KINDS });
    expect(candidates.map((c) => c.fingerprint)).toEqual([`slack:msg:C0GENERAL:${ts}`]);
    expect(now).toEqual(NOW);
    expect(releaseLease).toHaveBeenCalledWith(PRINCIPAL, "slack-attention-lease", expect.any(String));
    expect(findSlackText(r)).toEqual([]);
  });

  it("AT10 no live reading half, or the switch off → skipped, no sync; a failed item read throws before any sync", async () => {
    vi.mocked(getReadingHalf).mockResolvedValueOnce(null);
    expect(await run()).toEqual({ skipped: "not_reading" });
    vi.mocked(getReadingHalf).mockResolvedValueOnce({ row: installationRow(), reading: readingHalf({ state: "revoked", hasToken: false }) });
    expect(await run()).toEqual({ skipped: "not_reading" });
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReadingEnabled: false }));
    expect(await run()).toEqual({ skipped: "not_reading" });
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReadingSchemaReady: false }));
    expect(await run()).toEqual({ skipped: "not_installed" });
    expect(syncAttention).not.toHaveBeenCalled();
    vi.mocked(listItemsForAttention).mockRejectedValueOnce(new Error("read failed"));
    await expect(run()).rejects.toThrow("read failed");
    expect(syncAttention).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalled();
  });

  it("AT11 a held lease re-kicks for the next minute and returns", async () => {
    vi.mocked(tryAcquireLease).mockResolvedValueOnce(false);
    expect(await run({ kick: true })).toEqual({ skipped: "lease" });
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.slack-attention", dedupeKey: `slack-attn:ep_1:m${Math.floor(NOW.getTime() / 60_000) + 1}` });
    expect(syncAttention).not.toHaveBeenCalled();
  });

  it("AT13 / AN09 the registered check-in hook: its stamps are undone and those items reopen", async () => {
    vi.mocked(listItemsForAttention).mockResolvedValue({
      items: [itemRow({ ts, respondedTs: "1794149999.000100", respondedAt: NOW.toISOString() }), itemRow({ channelId: "D0JANE", ts, respondedTs: "1794149998.000100", respondedAt: NOW.toISOString() })],
      channels: [channelRow({ name: "general" }), channelRow({ channelId: "D0JANE", convType: "im", isPrivate: true, name: null })]
    });
    const hook = vi.fn(async (_p: unknown, rows: readonly { channelId: string; respondedTs: string }[]) => rows.filter((r) => r.channelId === "C0GENERAL"));
    registerAnsweredExclusion(hook);
    vi.mocked(unstampAnswered).mockResolvedValue(1);
    const r = await run();
    expect(hook).toHaveBeenCalledWith(PRINCIPAL, [{ channelId: "C0GENERAL", respondedTs: "1794149999.000100" }, { channelId: "D0JANE", respondedTs: "1794149998.000100" }]);
    expect(unstampAnswered).toHaveBeenCalledWith(PRINCIPAL, [{ channelId: "C0GENERAL", respondedTs: "1794149999.000100" }]);
    expect(vi.mocked(syncAttention).mock.calls[0][2].map((c) => c.fingerprint)).toEqual([`slack:msg:C0GENERAL:${ts}`]);
    expect(r).toMatchObject({ unstamped: 1 });
  });

  it("AN09b (fixer correctness-5): against the real store and fake DB, a check-in stamped before P8 wrote its row reopens through the hook; without a hook it stays answered", async () => {
    const actual = await vi.importActual<typeof import("@/lib/exec/slack-read-store")>("@/lib/exec/slack-read-store");
    const STAMP = "1794149999.000100";
    const seed = () => {
      const db = createFakeSlackReadDb({
        now: () => NOW,
        tables: {
          exec_slack_channels: [channelDbRow({ name: "general" })],
          exec_slack_messages: [messageDbRow({ ts, responded_ts: STAMP, responded_at: NOW.toISOString() })],
          exec_slack_items: [itemDbRow({ ts, responded_ts: STAMP, responded_at: NOW.toISOString() })]
        }
      });
      vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
      return db;
    };
    vi.mocked(listItemsForAttention).mockImplementation(actual.listItemsForAttention);
    vi.mocked(unstampAnswered).mockImplementation(actual.unstampAnswered);
    // No hook: the answered item produces nothing.
    seed();
    await run();
    expect(vi.mocked(syncAttention).mock.calls[0][2]).toEqual([]);
    // The hook names the check-in's ts: the stamp is undone in the store and the item is open again.
    const db = seed();
    const hook = vi.fn(async (_p: unknown, rows: readonly { channelId: string; respondedTs: string }[]) => [...rows]);
    registerAnsweredExclusion(hook);
    const r = await run();
    expect(hook).toHaveBeenCalledWith(PRINCIPAL, [{ channelId: "C0GENERAL", respondedTs: STAMP }]);
    expect(db.tables.exec_slack_items[0]).toMatchObject({ responded_ts: null, responded_at: null });
    expect(db.tables.exec_slack_messages[0]).toMatchObject({ responded_ts: null, responded_at: null });
    expect(vi.mocked(syncAttention).mock.calls[1][2].map((c) => c.fingerprint)).toEqual([`slack:msg:C0GENERAL:${ts}`]);
    expect(r).toMatchObject({ unstamped: 1 });
  });

  it("the schedule: every 10 minutes, bulk, three attempts, gated on the schema", () => {
    expect(slackAttentionScheduledWork).toMatchObject({ kind: "exec.slack-attention", lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 3 });
    expect(slackAttentionScheduledWork.enabled?.(settings({ slackReadingSchemaReady: false }))).toBe(false);
    expect(slackAttentionScheduledWork.enabled?.(settings({ slackReadingEnabled: false }))).toBe(true);
  });
});
