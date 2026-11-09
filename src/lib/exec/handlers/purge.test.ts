import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// The email step's own deletes are covered in email-store.test.ts (and the SQL suite).
vi.mock("@/lib/exec/email-store", () => ({ purgeExpiredEmailRows: vi.fn() }));
// The drafts step's own RPC loop is covered in drafts-store.test.ts (and the SQL suite).
vi.mock("@/lib/exec/drafts-store", () => ({ purgeExpiredDrafts: vi.fn() }));
// The P5a steps' own deletes are covered in ddtext-store's and attention-feedback's suites (and the SQL suite).
vi.mock("@/lib/exec/ddtext-store", () => ({ purgeExpiredDdtext: vi.fn(), purgeOrphanDdtextAttention: vi.fn() }));
vi.mock("@/lib/exec/attention-feedback", () => ({ purgeOldFeedback: vi.fn() }));
// P5b's chat step's own deletes are covered in chat-store.test.ts (T71) and the SQL suite.
vi.mock("@/lib/exec/chat-store", () => ({ purgeExpiredChatRows: vi.fn() }));
// P6's Slack steps' own deletes are covered in slack-install.test.ts; PU02 runs the real ones against fake-slack-db.
vi.mock("@/lib/exec/slack-install", () => ({ deleteOldSlackEvents: vi.fn(), deleteExpiredOAuthStates: vi.fn() }));
// The C18 backstop step's own purge is covered in slack-uninstall.test.ts (UN-B) against fake-slack-db.
vi.mock("@/lib/exec/handlers/slack-uninstall", () => ({ purgeUnpurgedRevocations: vi.fn() }));
// P7a's Slack reading step (PG01): purgeExpiredSlack's own mapping is covered in slack-read-store.test.ts (PG02) and the
// SQL suite (RQ19); PG01 also runs the real store function against fake-slack-read-db.
vi.mock("@/lib/exec/slack-read-store", () => ({ purgeExpiredSlack: vi.fn() }));

import { createFakeExecDb, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { purgeOldFeedback } from "@/lib/exec/attention-feedback";
import { purgeExpiredChatRows } from "@/lib/exec/chat-store";
import { purgeExpiredDdtext, purgeOrphanDdtextAttention } from "@/lib/exec/ddtext-store";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { RETENTION_DAYS, runPurge } from "@/lib/exec/handlers/purge";
import { purgeUnpurgedRevocations } from "@/lib/exec/handlers/slack-uninstall";
import { deleteExpiredOAuthStates, deleteOldSlackEvents } from "@/lib/exec/slack-install";
import { purgeExpiredSlack } from "@/lib/exec/slack-read-store";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec.purge with the P3 email step (contract §3.13 "Retention", coherence-18),
// the P4 drafts step (P4 contract §2.8, Y6; PX11) and the P5a DD text and
// feedback steps (P5a contract §3.12.8, §2.6; test 28).

const NOW = new Date("2026-11-04T12:00:00.000Z");
let db: FakeExecDb;

beforeEach(() => {
  db = createFakeExecDb();
  db.deleteResult = () => ({ count: 1, error: null });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(purgeExpiredEmailRows).mockReset();
  vi.mocked(purgeExpiredEmailRows).mockResolvedValue({ threads: 3, commitments: 4, signals: 5, attentionRows: 6 });
  vi.mocked(purgeExpiredDrafts).mockReset();
  vi.mocked(purgeExpiredDrafts).mockResolvedValue({ contentPurged: 7, deleted: 8, closedIdle: 9, checksScheduled: 10 });
  vi.mocked(purgeExpiredDdtext).mockReset();
  vi.mocked(purgeExpiredDdtext).mockResolvedValue(11);
  vi.mocked(purgeOrphanDdtextAttention).mockReset();
  vi.mocked(purgeOrphanDdtextAttention).mockResolvedValue(12);
  vi.mocked(purgeOldFeedback).mockReset();
  vi.mocked(purgeOldFeedback).mockResolvedValue(13);
  vi.mocked(purgeExpiredChatRows).mockReset();
  vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 14, messages: 15, staleFailed: 16 });
  vi.mocked(deleteOldSlackEvents).mockReset();
  vi.mocked(deleteOldSlackEvents).mockResolvedValue(17);
  vi.mocked(deleteExpiredOAuthStates).mockReset();
  vi.mocked(deleteExpiredOAuthStates).mockResolvedValue(18);
  vi.mocked(purgeUnpurgedRevocations).mockReset();
  vi.mocked(purgeUnpurgedRevocations).mockResolvedValue(19);
  vi.mocked(purgeExpiredSlack).mockReset();
  vi.mocked(purgeExpiredSlack).mockResolvedValue({ items: 20, messages: 21, threads: 22, markers: 23, log: 24, channels: 25, attention: 26 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const FULL_LOG =
  "[exec-purge] deleted finishedJobs=1 accessLog=1 auditLog=1 aiUsage=1 resolvedAttention=1 " +
  "emailThreads=3 emailCommitments=4 emailSignals=5 emailAttentionRows=6 " +
  "draftsContentPurged=7 draftsDeleted=8 draftsClosedIdle=9 draftsChecksScheduled=10 " +
  "ddtextItems=11 ddtextAttention=12 attentionFeedback=13 " +
  "chatConversations=14 chatMessages=15 chatStaleFailed=16 " +
  "slackEvents=17 oauthStates=18 slackRevocationsPurged=19 " +
  "slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26";

describe("exec.purge: the email and drafts steps", () => {
  it("run after the P2a/P2b steps with the run's clock and signal, and report their counts", async () => {
    const signal = new AbortController().signal;
    await expect(runPurge(signal, NOW)).resolves.toEqual({
      finishedJobs: 1,
      accessLog: 1,
      auditLog: 1,
      aiUsage: 1,
      resolvedAttention: 1,
      emailThreads: 3,
      emailCommitments: 4,
      emailSignals: 5,
      emailAttentionRows: 6,
      draftsContentPurged: 7,
      draftsDeleted: 8,
      draftsClosedIdle: 9,
      draftsChecksScheduled: 10,
      ddtextItems: 11,
      ddtextAttention: 12,
      attentionFeedback: 13,
      chatConversations: 14,
      chatMessages: 15,
      chatStaleFailed: 16,
      slackEvents: 17,
      oauthStates: 18,
      slackRevocationsPurged: 19,
      slackItems: 20,
      slackMessages: 21,
      slackThreads: 22,
      slackMarkers: 23,
      slackLog: 24,
      slackChannels: 25,
      slackAttention: 26
    });
    expect(purgeExpiredEmailRows).toHaveBeenCalledWith(NOW, { signal });
    expect(purgeExpiredDrafts).toHaveBeenCalledWith(NOW, { signal });
    expect(vi.mocked(purgeExpiredEmailRows).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(purgeExpiredDrafts).mock.invocationCallOrder[0]);
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs", "exec_access_log", "exec_audit_log", "exec_ai_usage", "exec_attention_items"]);
    expect(console.log).toHaveBeenCalledWith(FULL_LOG);
  });

  it("an email step failure doesn't stop the others (the drafts step still runs), and still fails the run (the job retries)", async () => {
    vi.mocked(purgeExpiredEmailRows).mockRejectedValue(new Error("exec email store: exec_email_threads purge failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 15 steps failed: email: exec email store: exec_email_threads purge failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredDrafts).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("emailThreads=0 emailCommitments=0 emailSignals=0 emailAttentionRows=0 draftsContentPurged=7"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("failed=1"));
  });

  it("PX11: a drafts step failure fails the run after every other step ran", async () => {
    vi.mocked(purgeExpiredDrafts).mockRejectedValue(new Error("exec drafts store: exec_drafts_purge_expired failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 15 steps failed: drafts: exec drafts store: exec_drafts_purge_expired failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredEmailRows).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("draftsContentPurged=0 draftsDeleted=0 draftsClosedIdle=0 draftsChecksScheduled=0 ddtextItems=11 ddtextAttention=12 attentionFeedback=13 chatConversations=14 chatMessages=15 chatStaleFailed=16 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 failed=1"));
  });

  it("another step failing doesn't skip the email or drafts steps", async () => {
    db.deleteResult = (d) => (d.table === "exec_access_log" ? { count: null, error: { message: "statement timeout" } } : { count: 1, error: null });
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 15 steps failed: accessLog");
    expect(purgeExpiredEmailRows).toHaveBeenCalledTimes(1);
    expect(purgeExpiredDrafts).toHaveBeenCalledTimes(1);
  });

  it("before the P3 / P4 migrations the steps report zeros (the stores tolerate missing tables and functions)", async () => {
    vi.mocked(purgeExpiredEmailRows).mockResolvedValue({ threads: 0, commitments: 0, signals: 0, attentionRows: 0 });
    vi.mocked(purgeExpiredDrafts).mockResolvedValue({ contentPurged: 0, deleted: 0, closedIdle: 0, checksScheduled: 0 });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({
      emailThreads: 0, emailCommitments: 0, emailSignals: 0, emailAttentionRows: 0,
      draftsContentPurged: 0, draftsDeleted: 0, draftsClosedIdle: 0, draftsChecksScheduled: 0
    });
  });

  it("an aborted signal stops before the email step, so the drafts step never runs either", async () => {
    const controller = new AbortController();
    db.deleteResult = (d) => {
      if (d.table === "exec_attention_items") controller.abort(new Error("lease lost"));
      return { count: 1, error: null };
    };
    await expect(runPurge(controller.signal, NOW)).rejects.toThrow("lease lost");
    expect(purgeExpiredEmailRows).not.toHaveBeenCalled();
    expect(purgeExpiredDrafts).not.toHaveBeenCalled();
    expect(purgeExpiredDdtext).not.toHaveBeenCalled();
    expect(purgeOrphanDdtextAttention).not.toHaveBeenCalled();
    expect(purgeOldFeedback).not.toHaveBeenCalled();
  });
});

describe("exec.purge: the P5b chat step (T71, contract §3.21)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("runs last, with the run's clock and signal, and reports its three counts", async () => {
    const signal = new AbortController().signal;
    const counts = await runPurge(signal, NOW);
    expect(purgeExpiredChatRows).toHaveBeenCalledWith(NOW, { signal });
    expect(counts).toMatchObject({ chatConversations: 14, chatMessages: 15, chatStaleFailed: 16 });
    expect(order(purgeOldFeedback)).toBeLessThan(order(purgeExpiredChatRows));
  });

  it("before the P5b migration the step reports zeros (the store tolerates missing tables)", async () => {
    vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 0, messages: 0, staleFailed: 0 });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ chatConversations: 0, chatMessages: 0, chatStaleFailed: 0, attentionFeedback: 13 });
  });

  it("a chat step failure fails the run after every other step ran; another step failing doesn't skip it", async () => {
    vi.mocked(purgeExpiredChatRows).mockRejectedValue(new Error("exec chat store: exec_conversations purge failed: lock timeout (55P03)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 15 steps failed: chat: exec chat store: exec_conversations purge failed: lock timeout (55P03)"
    );
    expect(purgeOldFeedback).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("chatConversations=0 chatMessages=0 chatStaleFailed=0 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 failed=1"));
    vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 1, messages: 2, staleFailed: 3 });
    vi.mocked(purgeOldFeedback).mockRejectedValue(new Error("exec_attention_feedback purge failed: down"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 15 steps failed: attentionFeedback");
    expect(purgeExpiredChatRows).toHaveBeenCalledTimes(2);
  });
});

describe("exec.purge: the P5a DD text and feedback steps (test 28)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("run after the drafts step, in the order expiry → orphan sweep (every principal) → feedback, with the run's clock and signal", async () => {
    const signal = new AbortController().signal;
    await runPurge(signal, NOW);
    expect(purgeExpiredDdtext).toHaveBeenCalledWith(NOW, { signal });
    // No principal and no backing: the sweep covers every principal and reads the signals itself.
    expect(purgeOrphanDdtextAttention).toHaveBeenCalledWith(NOW, { signal });
    expect(purgeOldFeedback).toHaveBeenCalledWith(NOW, { signal });
    const seq = [purgeExpiredEmailRows, purgeExpiredDrafts, purgeExpiredDdtext, purgeOrphanDdtextAttention, purgeOldFeedback].map(order);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    expect(RETENTION_DAYS).toMatchObject({ attentionFeedback: 365, resolvedAttention: 90 });
  });

  it("an attention row whose ddtext item expires in this run is gone after the same run (a-correct-1)", async () => {
    // A tiny model of the two stores: items with their expiry, and the ddtext
    // attention rows that live only while an item (its signals) backs them.
    const items = new Map([
      ["comment:al_old", { expiresAt: "2026-11-04T00:00:00.000Z" }],
      ["comment:al_new", { expiresAt: "2026-12-01T00:00:00.000Z" }]
    ]);
    const attention = new Map([
      ["ea_old", "comment:al_old"],
      ["ea_new", "comment:al_new"]
    ]);
    vi.mocked(purgeExpiredDdtext).mockImplementation(async (now: Date) => {
      let n = 0;
      for (const [key, item] of items) if (Date.parse(item.expiresAt) <= now.getTime()) (items.delete(key), (n += 1));
      return n;
    });
    vi.mocked(purgeOrphanDdtextAttention).mockImplementation(async () => {
      let n = 0;
      for (const [id, key] of attention) if (!items.has(key)) (attention.delete(id), (n += 1));
      return n;
    });
    const counts = await runPurge(undefined, NOW);
    expect([...attention.keys()]).toEqual(["ea_new"]);
    expect(counts).toMatchObject({ ddtextItems: 1, ddtextAttention: 1 });
  });

  it("before the P5a migration the steps report zeros (the stores tolerate missing tables)", async () => {
    vi.mocked(purgeExpiredDdtext).mockResolvedValue(0);
    vi.mocked(purgeOrphanDdtextAttention).mockResolvedValue(0);
    vi.mocked(purgeOldFeedback).mockResolvedValue(0);
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ ddtextItems: 0, ddtextAttention: 0, attentionFeedback: 0 });
  });

  it("a failing expiry step doesn't skip the orphan sweep or the feedback step, and still fails the run", async () => {
    vi.mocked(purgeExpiredDdtext).mockRejectedValue(new Error("exec ddtext store: purge failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 15 steps failed: ddtextItems: exec ddtext store: purge failed: lock timeout");
    expect(purgeOrphanDdtextAttention).toHaveBeenCalledTimes(1);
    expect(purgeOldFeedback).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ddtextItems=0 ddtextAttention=12 attentionFeedback=13 chatConversations=14 chatMessages=15 chatStaleFailed=16 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 failed=1"));
  });

  it("P2b's 90-day resolved-row step is unchanged: resolved rows of every kind, by resolved_at and last_seen_at only", async () => {
    await runPurge(undefined, NOW);
    const attentionDelete = db.deletes.find((d) => d.table === "exec_attention_items");
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    expect(attentionDelete?.filters).toEqual([
      ["eq", "status", "resolved"],
      ["lt", "resolved_at", cutoff],
      ["lt", "last_seen_at", cutoff]
    ]);
  });
});

describe("exec.purge: the P6 Slack steps (contract §2.6; PU01-PU03)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("PU01: runs slackEvents (25 h, SLACK_LIMITS.eventRetentionHours) and oauthStates after every earlier step, with the run's clock and signal", async () => {
    const signal = new AbortController().signal;
    const counts = await runPurge(signal, NOW);
    expect(deleteOldSlackEvents).toHaveBeenCalledWith(NOW, 25, { signal });
    expect(deleteExpiredOAuthStates).toHaveBeenCalledWith(NOW, { signal });
    expect(counts).toMatchObject({ slackEvents: 17, oauthStates: 18 });
    expect(order(purgeExpiredChatRows)).toBeLessThan(order(deleteOldSlackEvents));
    expect(order(deleteOldSlackEvents)).toBeLessThan(order(deleteExpiredOAuthStates));
    expect(RETENTION_DAYS).toEqual({ finishedJobs: 14, accessLog: 90, auditLog: 400, aiUsage: 400, resolvedAttention: 90, attentionFeedback: 365 });
  });

  it("PU02: before the P6 migration both steps report 0 and the run succeeds: the real store functions against a database without the tables", async () => {
    const real = await vi.importActual<typeof import("@/lib/exec/slack-install")>("@/lib/exec/slack-install");
    const { createFakeSlackDb } = await import("@/lib/exec/__tests__/fake-slack-db");
    const slackDb = createFakeSlackDb({ missing: ["exec_slack_events", "exec_oauth_states"] });
    // The other steps keep the exec fake; the Slack tables are answered by fake-slack-db (both missing).
    const execClient = db.client as { from(t: string): unknown };
    const routed = {
      ...execClient,
      from: (t: string) => (t === "exec_slack_events" || t === "exec_oauth_states" ? (slackDb.client as { from(t: string): unknown }).from(t) : execClient.from(t))
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(routed as unknown as SupabaseClient);
    vi.mocked(deleteOldSlackEvents).mockImplementation(real.deleteOldSlackEvents);
    vi.mocked(deleteExpiredOAuthStates).mockImplementation(real.deleteExpiredOAuthStates);
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ slackEvents: 0, oauthStates: 0, chatConversations: 14 });
    expect(slackDb.calls.map((c) => `${c.kind} ${c.target}`)).toEqual(["select exec_slack_events", "delete exec_oauth_states"]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("PU02: a Slack step's real failure is reported like any step's: the others still run and the run fails", async () => {
    vi.mocked(deleteOldSlackEvents).mockRejectedValue(new Error("exec slack store: deleteOldSlackEvents failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 15 steps failed: slackEvents: exec slack store: deleteOldSlackEvents failed (57014)");
    expect(deleteExpiredOAuthStates).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("slackEvents=0 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 failed=1"));
  });

  it("PU03: the summary log line carries both counts, after the chat counts", async () => {
    await runPurge(undefined, NOW);
    expect(console.log).toHaveBeenCalledWith(FULL_LOG);
    expect(FULL_LOG.endsWith("chatStaleFailed=16 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26")).toBe(true);
  });

  // P7a: the backstop is P6's last step; P7a's slack step (PG01) runs after it.
  it("PU04 (fixer correctness-5): the C18 backstop runs last of P6's steps, with the run's clock and signal, and its failure fails the run like any step", async () => {
    const signal = new AbortController().signal;
    await expect(runPurge(signal, NOW)).resolves.toMatchObject({ slackRevocationsPurged: 19 });
    expect(purgeUnpurgedRevocations).toHaveBeenCalledWith(NOW, { signal });
    expect(order(deleteExpiredOAuthStates)).toBeLessThan(order(purgeUnpurgedRevocations));
    expect(order(purgeUnpurgedRevocations)).toBeLessThan(order(purgeExpiredSlack));
    vi.mocked(purgeUnpurgedRevocations).mockRejectedValue(new Error("exec slack store: purgeInstallation failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 15 steps failed: slackRevocationsPurged: exec slack store: purgeInstallation failed (57014)");
  });
});

describe("exec.purge: the P7a Slack reading step (contract §3.15; PG01)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("PG01: runs after every P6 step with the run's clock and signal, maps the seven counts into the summary line", async () => {
    const signal = new AbortController().signal;
    const counts = await runPurge(signal, NOW);
    expect(purgeExpiredSlack).toHaveBeenCalledTimes(1);
    expect(purgeExpiredSlack).toHaveBeenCalledWith(NOW, { signal });
    expect(order(purgeUnpurgedRevocations)).toBeLessThan(order(purgeExpiredSlack));
    expect(counts).toMatchObject({ slackItems: 20, slackMessages: 21, slackThreads: 22, slackMarkers: 23, slackLog: 24, slackChannels: 25, slackAttention: 26 });
    expect(console.log).toHaveBeenCalledWith(FULL_LOG);
  });

  it("PG01: a missing RPC (P7a not applied) reports zeros and the run succeeds: the real store function against fake-slack-read-db", async () => {
    const real = await vi.importActual<typeof import("@/lib/exec/slack-read-store")>("@/lib/exec/slack-read-store");
    const { createFakeSlackReadDb } = await import("@/lib/exec/__tests__/fake-slack-read-db");
    const readDb = createFakeSlackReadDb({ missing: ["exec_slack_purge_expired"] });
    const execClient = db.client as { from(t: string): unknown; rpc(fn: string, args?: unknown): unknown };
    const routed = {
      ...execClient,
      rpc: (fn: string, args?: unknown) =>
        fn === "exec_slack_purge_expired" ? (readDb.client as { rpc(fn: string, args?: unknown): unknown }).rpc(fn, args) : execClient.rpc(fn, args)
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(routed as unknown as SupabaseClient);
    vi.mocked(purgeExpiredSlack).mockImplementation(real.purgeExpiredSlack);
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({
      slackItems: 0, slackMessages: 0, slackThreads: 0, slackMarkers: 0, slackLog: 0, slackChannels: 0, slackAttention: 0, slackRevocationsPurged: 19
    });
    expect(readDb.calls.map((c) => `${c.kind} ${c.target}`)).toEqual(["rpc exec_slack_purge_expired"]);
    expect(readDb.calls[0].payload).toEqual({ p_now: NOW.toISOString() });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("PG01: a failing slack step fails the run after every other step ran; another step failing doesn't skip it", async () => {
    vi.mocked(purgeExpiredSlack).mockRejectedValue(new Error("exec slack reading store: purgeExpiredSlack failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 15 steps failed: slack: exec slack reading store: purgeExpiredSlack failed (57014)");
    expect(purgeUnpurgedRevocations).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("slackRevocationsPurged=19 slackItems=0 slackMessages=0 slackThreads=0 slackMarkers=0 slackLog=0 slackChannels=0 slackAttention=0 failed=1"));
    vi.mocked(purgeExpiredSlack).mockResolvedValue({ items: 1, messages: 1, threads: 0, markers: 0, log: 0, channels: 0, attention: 1 });
    vi.mocked(purgeUnpurgedRevocations).mockRejectedValue(new Error("exec slack store: purgeInstallation failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 15 steps failed: slackRevocationsPurged");
    expect(purgeExpiredSlack).toHaveBeenCalledTimes(2);
  });

  it("PG01: an answer's non-numeric or negative count reads as 0", async () => {
    vi.mocked(purgeExpiredSlack).mockResolvedValue({ items: -1, messages: Number.NaN, threads: 2 } as Record<string, number>);
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ slackItems: 0, slackMessages: 0, slackThreads: 2, slackMarkers: 0 });
  });
});
