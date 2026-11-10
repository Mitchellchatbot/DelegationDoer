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
// P8: the revoked-reading lister (P7a's, global) and installationFactsForSystem (P8, Area D) for the system purge's re-check.
vi.mock("@/lib/exec/slack-install", () => ({
  deleteOldSlackEvents: vi.fn(), deleteExpiredOAuthStates: vi.fn(), listRevokedReadingInstallations: vi.fn(), installationFactsForSystem: vi.fn(),
  // P6's backstop, run for real in P8 PU04 (AM-P8-16): its store calls.
  listUnpurgedRevokedInstallations: vi.fn(), getInstallationForSystem: vi.fn(), purgeInstallation: vi.fn(), openInstallationForSystem: vi.fn(),
  revokeInstallation: vi.fn()
}));
// The C18 backstop step's own purge is covered in slack-uninstall.test.ts (UN-B) against fake-slack-db.
vi.mock("@/lib/exec/handlers/slack-uninstall", () => ({ purgeUnpurgedRevocations: vi.fn() }));
// P7a's Slack reading step (PG01): purgeExpiredSlack's own mapping is covered in slack-read-store.test.ts (PG02) and the
// SQL suite (RQ19); PG01 also runs the real store function against fake-slack-read-db.
vi.mock("@/lib/exec/slack-read-store", () => ({ purgeExpiredSlack: vi.fn(), purgeReading: vi.fn() }));
// P7b's Slack intel step (PU01-PU03 below): purgeExpiredSlackIntel's own mapping is covered in slack-intel-store.test.ts and
// the SQL suite; PU01 / PU02 also run the real store function against fake-slack-intel-db.
vi.mock("@/lib/exec/slack-intel-store", () => ({ purgeExpiredSlackIntel: vi.fn() }));
// P8 (§3.14.1): the brief store's purge / scrub / fallback-DM reads are mocked here (their own SQL mirror is covered by
// brief-store.test.ts and the SQL suite; P8 PU03 / PU12 run the real store functions against fake-brief-db), P7a's purgeReading
// through the facade, the DD bot's delete (Area D's) and the audit writer.
vi.mock("@/lib/exec/brief-store", () => ({
  purgeExpiredBriefs: vi.fn(), listPrincipalIdsWithSlackLines: vi.fn(), scrubBriefsForSlackSystem: vi.fn(), listFallbackDmsDue: vi.fn(),
  markFallbackDmDeleted: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", () => ({ purgeReading: vi.fn() }));
vi.mock("@/lib/exec/dd-bot", () => ({ deleteDdBotDm: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
// P9 F13: the Slack token re-seal step (its own behaviour is slack-token-reseal.test.ts's).
vi.mock("@/lib/exec/slack-token-reseal", () => ({ resealSlackTokens: vi.fn() }));

import { assertNoBriefText } from "@/lib/exec/__tests__/brief-assert";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import { createFakeExecDb, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { auditEvent } from "@/lib/exec/audit";
import {
  listFallbackDmsDue,
  listPrincipalIdsWithSlackLines,
  markFallbackDmDeleted,
  purgeExpiredBriefs,
  scrubBriefsForSlackSystem
} from "@/lib/exec/brief-store";
import { deleteDdBotDm } from "@/lib/exec/dd-bot";
import type { FakeSlackIntelDbSeed } from "@/lib/exec/__tests__/fake-slack-intel-db";
import { purgeOldFeedback } from "@/lib/exec/attention-feedback";
import { purgeExpiredChatRows } from "@/lib/exec/chat-store";
import { purgeExpiredDdtext, purgeOrphanDdtextAttention } from "@/lib/exec/ddtext-store";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { PURGE_JOB_KIND, RETENTION_DAYS, purgeJobHandler, purgeSystemWork, runPurge } from "@/lib/exec/handlers/purge";
import { purgeUnpurgedRevocations } from "@/lib/exec/handlers/slack-uninstall";
import {
  deleteExpiredOAuthStates,
  deleteOldSlackEvents,
  getInstallationForSystem,
  installationFactsForSystem,
  listRevokedReadingInstallations,
  listUnpurgedRevokedInstallations,
  purgeInstallation
} from "@/lib/exec/slack-install";
import { purgeExpiredSlackIntel } from "@/lib/exec/slack-intel-store";
import { purgeExpiredSlack, purgeReading as storePurgeReading } from "@/lib/exec/slack-read-store";
import { purgeReading } from "@/lib/exec/slack-reading";
import { resealSlackTokens } from "@/lib/exec/slack-token-reseal";
import type { ExecPrincipal, JobContext } from "@/lib/exec/types";
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
  vi.mocked(purgeExpiredSlackIntel).mockReset();
  vi.mocked(purgeExpiredSlackIntel).mockResolvedValue({ digests: 27, failedBuilds: 28 });
  // P8: the brief purge's counts, and nothing revoked, no Slack lines, no mini-brief DM due by default.
  vi.mocked(purgeExpiredBriefs).mockReset();
  vi.mocked(purgeExpiredBriefs).mockResolvedValue({ contentPurged: 29, refsReleased: 33, briefsDeleted: 30, checkinsDeleted: 31, mentionsDeleted: 32 });
  // P9 F13: nothing to re-seal by default.
  vi.mocked(resealSlackTokens).mockReset();
  vi.mocked(resealSlackTokens).mockResolvedValue({ checked: 0, resealed: 0, unknownKey: 0, lost: 0, failed: 0 });
  vi.mocked(listRevokedReadingInstallations).mockReset();
  vi.mocked(listRevokedReadingInstallations).mockResolvedValue([]);
  vi.mocked(purgeReading).mockReset();
  vi.mocked(purgeReading).mockResolvedValue({ purged: 1 });
  vi.mocked(auditEvent).mockReset();
  vi.mocked(auditEvent).mockResolvedValue(undefined);
  vi.mocked(listPrincipalIdsWithSlackLines).mockReset();
  vi.mocked(listPrincipalIdsWithSlackLines).mockResolvedValue([]);
  vi.mocked(installationFactsForSystem).mockReset();
  vi.mocked(installationFactsForSystem).mockResolvedValue({ schema: true, active: true, readingActive: true });
  vi.mocked(scrubBriefsForSlackSystem).mockReset();
  vi.mocked(scrubBriefsForSlackSystem).mockResolvedValue(0);
  vi.mocked(listFallbackDmsDue).mockReset();
  vi.mocked(listFallbackDmsDue).mockResolvedValue([]);
  vi.mocked(markFallbackDmDeleted).mockReset();
  vi.mocked(markFallbackDmDeleted).mockResolvedValue(true);
  vi.mocked(deleteDdBotDm).mockReset();
  vi.mocked(deleteDdBotDm).mockResolvedValue("deleted");
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
  "slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 " +
  "slackDigests=27 slackDigestsFailed=28 " +
  // P8 (§3.14.1): the four new steps' eight counts.
  "briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 " +
  // P9: RPC 7 v2's released refs (§3.1) and the Slack token re-seal's four counts (F13).
  "slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0";

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
      slackAttention: 26,
      slackDigests: 27,
      slackDigestsFailed: 28,
      briefContentPurged: 29,
      briefsDeleted: 30,
      briefCheckinsDeleted: 31,
      briefMentionsDeleted: 32,
      briefRefsReleased: 33,
      revokedReadingPurged: 0,
      briefSlackScrubbed: 0,
      fallbackDmsDeleted: 0,
      fallbackDmsRetry: 0,
      slackResealed: 0,
      slackResealUnknownKey: 0,
      slackResealLost: 0,
      slackResealFailed: 0
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
      "exec.purge: 1 of 21 steps failed: email: exec email store: exec_email_threads purge failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredDrafts).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("emailThreads=0 emailCommitments=0 emailSignals=0 emailAttentionRows=0 draftsContentPurged=7"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("failed=1"));
  });

  it("PX11: a drafts step failure fails the run after every other step ran", async () => {
    vi.mocked(purgeExpiredDrafts).mockRejectedValue(new Error("exec drafts store: exec_drafts_purge_expired failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 21 steps failed: drafts: exec drafts store: exec_drafts_purge_expired failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredEmailRows).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("draftsContentPurged=0 draftsDeleted=0 draftsClosedIdle=0 draftsChecksScheduled=0 ddtextItems=11 ddtextAttention=12 attentionFeedback=13 chatConversations=14 chatMessages=15 chatStaleFailed=16 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 slackDigests=27 slackDigestsFailed=28 briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1"));
  });

  it("another step failing doesn't skip the email or drafts steps", async () => {
    db.deleteResult = (d) => (d.table === "exec_access_log" ? { count: null, error: { message: "statement timeout" } } : { count: 1, error: null });
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: accessLog");
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
      "exec.purge: 1 of 21 steps failed: chat: exec chat store: exec_conversations purge failed: lock timeout (55P03)"
    );
    expect(purgeOldFeedback).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("chatConversations=0 chatMessages=0 chatStaleFailed=0 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 slackDigests=27 slackDigestsFailed=28 briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1"));
    vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 1, messages: 2, staleFailed: 3 });
    vi.mocked(purgeOldFeedback).mockRejectedValue(new Error("exec_attention_feedback purge failed: down"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: attentionFeedback");
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
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: ddtextItems: exec ddtext store: purge failed: lock timeout");
    expect(purgeOrphanDdtextAttention).toHaveBeenCalledTimes(1);
    expect(purgeOldFeedback).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ddtextItems=0 ddtextAttention=12 attentionFeedback=13 chatConversations=14 chatMessages=15 chatStaleFailed=16 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 slackDigests=27 slackDigestsFailed=28 briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1"));
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
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slackEvents: exec slack store: deleteOldSlackEvents failed (57014)");
    expect(deleteExpiredOAuthStates).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("slackEvents=0 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26 slackDigests=27 slackDigestsFailed=28 briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1"));
  });

  it("PU03: the summary log line carries both counts, after the chat counts", async () => {
    await runPurge(undefined, NOW);
    expect(console.log).toHaveBeenCalledWith(FULL_LOG);
    expect(FULL_LOG.includes("chatStaleFailed=16 slackEvents=17 oauthStates=18 slackRevocationsPurged=19 slackItems=20 slackMessages=21 slackThreads=22 slackMarkers=23 slackLog=24 slackChannels=25 slackAttention=26")).toBe(true);
  });

  // P7a: the backstop is P6's last step; P7a's slack step (PG01) runs after it.
  it("PU04 (fixer correctness-5): the C18 backstop runs last of P6's steps, with the run's clock and signal, and its failure fails the run like any step", async () => {
    const signal = new AbortController().signal;
    await expect(runPurge(signal, NOW)).resolves.toMatchObject({ slackRevocationsPurged: 19 });
    expect(purgeUnpurgedRevocations).toHaveBeenCalledWith(NOW, { signal });
    expect(order(deleteExpiredOAuthStates)).toBeLessThan(order(purgeUnpurgedRevocations));
    expect(order(purgeUnpurgedRevocations)).toBeLessThan(order(purgeExpiredSlack));
    vi.mocked(purgeUnpurgedRevocations).mockRejectedValue(new Error("exec slack store: purgeInstallation failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slackRevocationsPurged: exec slack store: purgeInstallation failed (57014)");
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
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slack: exec slack reading store: purgeExpiredSlack failed (57014)");
    expect(purgeUnpurgedRevocations).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("slackRevocationsPurged=19 slackItems=0 slackMessages=0 slackThreads=0 slackMarkers=0 slackLog=0 slackChannels=0 slackAttention=0 slackDigests=27 slackDigestsFailed=28 briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1"));
    vi.mocked(purgeExpiredSlack).mockResolvedValue({ items: 1, messages: 1, threads: 0, markers: 0, log: 0, channels: 0, attention: 1 });
    vi.mocked(purgeUnpurgedRevocations).mockRejectedValue(new Error("exec slack store: purgeInstallation failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slackRevocationsPurged");
    expect(purgeExpiredSlack).toHaveBeenCalledTimes(2);
  });

  it("PG01: an answer's non-numeric or negative count reads as 0", async () => {
    vi.mocked(purgeExpiredSlack).mockResolvedValue({ items: -1, messages: Number.NaN, threads: 2 } as Record<string, number>);
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ slackItems: 0, slackMessages: 0, slackThreads: 2, slackMarkers: 0 });
  });
});

describe("exec.purge: the P7b Slack intel step (contract §2.3; PU01-PU03)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
  const D = (id: number, over: Record<string, unknown> = {}) => ({
    id: `esd_${id.toString(16).padStart(32, "0")}`, principal_id: "ep_1", channel_id: "C0GEN", local_date: "2026-10-01", tz: "UTC", from_ts: "1790000000.000000",
    to_ts: "1790086400.000000", status: "empty", expires_at: "2027-01-01T00:00:00.000Z", requested_at: "2026-10-02T00:00:00.000Z", ...over
  });

  /** The exec client, with every exec_slack_digests request routed to the P7b fake; the step runs the real store function. */
  async function withIntelDb(seed: FakeSlackIntelDbSeed) {
    const real = await vi.importActual<typeof import("@/lib/exec/slack-intel-store")>("@/lib/exec/slack-intel-store");
    const { createFakeSlackIntelDb } = await import("@/lib/exec/__tests__/fake-slack-intel-db");
    const intel = createFakeSlackIntelDb({ now: () => NOW, ...seed });
    const execClient = db.client as { from(t: string): unknown; rpc(fn: string, args?: unknown): unknown };
    const intelClient = intel.client as { from(t: string): unknown };
    const routed = { ...execClient, from: (t: string) => (t === "exec_slack_digests" ? intelClient.from(t) : execClient.from(t)) };
    vi.mocked(getSupabaseAdmin).mockReturnValue(routed as unknown as SupabaseClient);
    vi.mocked(purgeExpiredSlackIntel).mockImplementation(real.purgeExpiredSlackIntel);
    return intel;
  }

  it("PU01: deletes expired digests and marks building rows requested over 30 minutes ago failed, counts both, after P7a's step", async () => {
    const intel = await withIntelDb({
      tables: {
        exec_slack_channels: [{ principal_id: "ep_1", channel_id: "C0GEN", installation_id: "esi_1", conv_type: "channel", class: "standard" }],
        exec_slack_digests: [
          D(1, { expires_at: "2026-11-04T11:59:59.000Z" }),
          D(2, { expires_at: "2026-11-01T00:00:00.000Z", local_date: "2026-10-02", status: "failed" }),
          D(3, { local_date: "2026-10-03" }),
          D(4, { local_date: "2026-10-04", status: "building", requested_at: "2026-11-04T11:29:00.000Z" }),
          D(5, { local_date: "2026-10-05", status: "building", requested_at: "2026-11-04T11:45:00.000Z" })
        ]
      }
    });
    const signal = new AbortController().signal;
    const counts = await runPurge(signal, NOW);
    expect(counts).toMatchObject({ slackDigests: 2, slackDigestsFailed: 1 });
    expect(purgeExpiredSlackIntel).toHaveBeenCalledWith(NOW, { signal });
    expect(order(purgeExpiredSlack)).toBeLessThan(order(purgeExpiredSlackIntel));
    expect(intel.tables.exec_slack_digests.map((d) => [String(d.id).slice(-1), d.status])).toEqual([["3", "empty"], ["4", "failed"], ["5", "building"]]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("slackAttention=26 slackDigests=2 slackDigestsFailed=1"));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("PU02: a missing exec_slack_digests (P7b not applied) reports zeros and the run succeeds", async () => {
    const intel = await withIntelDb({ missing: ["exec_slack_digests"] });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ slackDigests: 0, slackDigestsFailed: 0, slackAttention: 26 });
    expect(intel.calls.map((c) => `${c.kind} ${c.target}`)).toEqual(["select exec_slack_digests"]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("PU03: a failing slackIntel step doesn't stop the others and fails the run at the end; another step failing doesn't skip it", async () => {
    vi.mocked(purgeExpiredSlackIntel).mockRejectedValue(new Error("exec slack intel store: purgeExpiredSlackIntel failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slackIntel: exec slack intel store: purgeExpiredSlackIntel failed (57014)");
    expect(purgeExpiredSlack).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("slackAttention=26 slackDigests=0 slackDigestsFailed=0 briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1"));
    vi.mocked(purgeExpiredSlackIntel).mockResolvedValue({ digests: 3, failedBuilds: 0 });
    vi.mocked(purgeExpiredSlack).mockRejectedValue(new Error("exec slack reading store: purgeExpiredSlack failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slack: ");
    expect(purgeExpiredSlackIntel).toHaveBeenCalledTimes(2);
    // An answer's malformed counts read as 0.
    vi.mocked(purgeExpiredSlack).mockResolvedValue({ items: 0, messages: 0, threads: 0, markers: 0, log: 0, channels: 0, attention: 0 });
    vi.mocked(purgeExpiredSlackIntel).mockResolvedValue({ digests: -2, failedBuilds: Number.NaN } as { digests: number; failedBuilds: number });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ slackDigests: 0, slackDigestsFailed: 0 });
  });
});

// ---------------------------------------------------------------------------
// P8 (contract §3.14, §5.14; Area A): the system purge. The tick half of PU01 / PU02 (the system pass enqueuing
// exec.purge:system:<UTC date> with every principal disabled, and BUILT_IN_SCHEDULE no longer listing exec.purge) is
// runtime.ts / scheduler.ts's (Area B); these tests cover the job and its steps.
// ---------------------------------------------------------------------------

const I1 = `esi_${"1".repeat(32)}`;
const I2 = `esi_${"2".repeat(32)}`;
const I3 = `esi_${"3".repeat(32)}`;
const SYSTEM_CTX = (signal: AbortSignal, principal: ExecPrincipal | null = null): JobContext => ({
  job: {
    id: 1, kind: PURGE_JOB_KIND, lane: "bulk", principal_id: principal ? principal.id : null, payload: {},
    dedupe_key: principal ? `exec.purge:${principal.id}:2026-11-04` : "exec.purge:system:2026-11-04", status: "running", attempts: 1, max_attempts: 3,
    run_after: NOW.toISOString(), locked_by: "w1", locked_until: null, heartbeat_at: null, last_error: null, result: null, created_at: NOW.toISOString(),
    started_at: NOW.toISOString(), finished_at: null
  } as unknown as JobContext["job"],
  principal,
  signal,
  workerId: "w1"
});

/** The exec client, with every exec_briefs request and exec_brief_* RPC routed to the P8 fake; the step runs the real store function. */
async function withBriefDb(seed: Parameters<typeof createFakeBriefDb>[0] = {}): Promise<FakeBriefDb> {
  const brief = createFakeBriefDb({ now: () => NOW, ...seed });
  const execClient = db.client as { from(t: string): unknown; rpc(fn: string, args?: unknown): unknown };
  const briefClient = brief.client as { from(t: string): unknown; rpc(fn: string, args?: unknown): unknown };
  const routed = {
    ...execClient,
    from: (t: string) => (t.startsWith("exec_brief") ? briefClient.from(t) : execClient.from(t)),
    rpc: (fn: string, args?: unknown) => (fn.startsWith("exec_brief_") ? briefClient.rpc(fn, args) : execClient.rpc(fn, args))
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(routed as unknown as SupabaseClient);
  const real = await vi.importActual<typeof import("@/lib/exec/brief-store")>("@/lib/exec/brief-store");
  real.__resetBriefStoreForTests();
  vi.mocked(purgeExpiredBriefs).mockImplementation(real.purgeExpiredBriefs);
  vi.mocked(listFallbackDmsDue).mockImplementation(real.listFallbackDmsDue);
  vi.mocked(markFallbackDmDeleted).mockImplementation(real.markFallbackDmDeleted);
  return brief;
}

describe("exec.purge as a system job (P8 contract §3.14.1, M10, C17; PU01, PU02, PU06)", () => {
  it("P8 PU01: purgeSystemWork is daily at 03:30 UTC, bulk, maxAttempts 3; the handler's timeout is 300 s and its run passes the job's signal", async () => {
    expect(purgeSystemWork).toEqual({ kind: "exec.purge", lane: "bulk", cadence: { kind: "daily", atUtc: "03:30" }, maxAttempts: 3 });
    expect(Object.isFrozen(purgeSystemWork)).toBe(true);
    expect(purgeJobHandler).toMatchObject({ kind: "exec.purge", lane: "bulk", timeoutMs: 300_000 });
    const signal = new AbortController().signal;
    await purgeJobHandler.run(SYSTEM_CTX(signal));
    expect(purgeExpiredBriefs).toHaveBeenCalledWith(expect.any(Date), { signal });
    expect(purgeExpiredEmailRows).toHaveBeenCalledWith(expect.any(Date), { signal });
  });

  it("P8 PU02: with no principal (principal: null, every principal disabled) the handler runs every step, P2a's to P8's", async () => {
    const counts = (await purgeJobHandler.run(SYSTEM_CTX(new AbortController().signal))) as Record<string, number>;
    for (const fn of [purgeExpiredEmailRows, purgeExpiredDrafts, purgeExpiredDdtext, purgeOrphanDdtextAttention, purgeOldFeedback, purgeExpiredChatRows,
      deleteOldSlackEvents, deleteExpiredOAuthStates, purgeUnpurgedRevocations, purgeExpiredSlack, purgeExpiredSlackIntel, purgeExpiredBriefs,
      listRevokedReadingInstallations, listPrincipalIdsWithSlackLines, listFallbackDmsDue]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs", "exec_access_log", "exec_audit_log", "exec_ai_usage", "exec_attention_items"]);
    expect(counts).toMatchObject({ briefContentPurged: 29, briefsDeleted: 30, briefCheckinsDeleted: 31, briefMentionsDeleted: 32 });
  });

  it("P8 PU06: an old per-principal exec.purge:<p>:<date> row runs once more, exactly like the system job, and a second run changes nothing it wouldn't", async () => {
    const principal = { id: "ep_1" } as ExecPrincipal;
    const signal = new AbortController().signal;
    const a = await purgeJobHandler.run(SYSTEM_CTX(signal, principal));
    const b = await purgeJobHandler.run(SYSTEM_CTX(signal, null));
    expect(a).toEqual(b);
    // The steps take no principal: the same global, idempotent deletes ran both times.
    expect(vi.mocked(purgeExpiredBriefs).mock.calls.map((c) => c.length)).toEqual([2, 2]);
    expect(vi.mocked(listPrincipalIdsWithSlackLines).mock.calls.map((c) => c[0])).toEqual([100, 100]);
  });
});

describe("exec.purge: the P8 brief steps (contract §3.14.1; PU03-PU05, PU07, PU11, PU12)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("P8 PU03: the briefs step runs after P7b's with the run's clock and signal; the store calls RPC 7 with the UTC date − 90 days, again while a count equals the batch", async () => {
    const signal = new AbortController().signal;
    await runPurge(signal, NOW);
    expect(purgeExpiredBriefs).toHaveBeenCalledWith(NOW, { signal });
    expect(order(purgeExpiredSlackIntel)).toBeLessThan(order(purgeExpiredBriefs));
    // The real store against fake-brief-db: 1,500 briefs past their content expiry → two rounds (1,000 then 500).
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      id: `eb_${i.toString(16).padStart(32, "0")}`, principal_id: "ep_1", local_date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      tz: "UTC", scheduled_at: "2026-10-01T08:00:00.000Z", status: "page_only", content: { v: 1 }, mode: "ai", built_at: "2026-10-01T08:01:00.000Z",
      content_expires_at: "2026-10-31T00:00:00.000Z", expires_at: "2027-04-01T00:00:00.000Z"
    }));
    const brief = await withBriefDb({ tables: { exec_briefs: rows } });
    const counts = await runPurge(undefined, NOW);
    expect(counts).toMatchObject({ briefContentPurged: 1500, briefsDeleted: 0, briefCheckinsDeleted: 0, briefMentionsDeleted: 0 });
    const calls = brief.calls.filter((c) => c.target === "exec_brief_purge_expired_v2");
    expect(calls.map((c) => c.payload)).toEqual([
      { p_now: NOW.toISOString(), p_limit: 1000, p_mention_cutoff: "2026-08-06" },
      { p_now: NOW.toISOString(), p_limit: 1000, p_mention_cutoff: "2026-08-06" }
    ]);
    expect(brief.tables.exec_briefs.every((b) => b.content === null && b.content_purged_at === NOW.toISOString())).toBe(true);
  });

  it("P8 PU03: before the P8 migration the step reports zeros and the run succeeds (the real store against a missing RPC)", async () => {
    const brief = await withBriefDb({ missing: ["exec_brief_purge_expired_v2", "exec_brief_purge_expired"] });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ briefContentPurged: 0, briefsDeleted: 0, briefCheckinsDeleted: 0, briefMentionsDeleted: 0,
      briefRefsReleased: 0 });
    // The DD-bot step's due-DM read runs first (fixer security-2), then RPC 7 (P9: v2, missing, then P8's v1, missing too).
    expect(brief.calls.map((c) => `${c.kind} ${c.target}`)).toEqual(["select exec_briefs", "rpc exec_brief_purge_expired_v2", "rpc exec_brief_purge_expired"]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("P8 PU04 (AM-P8-16): two revoked-unpurged installations → P6's backstop step purges each with purgeReading THEN purgeInstallation (P7a's order)", async () => {
    const real = await vi.importActual<typeof import("@/lib/exec/handlers/slack-uninstall")>("@/lib/exec/handlers/slack-uninstall");
    vi.mocked(purgeUnpurgedRevocations).mockImplementation(real.purgeUnpurgedRevocations);
    const calls: string[] = [];
    vi.mocked(listUnpurgedRevokedInstallations).mockResolvedValue([I1, I2]);
    vi.mocked(getInstallationForSystem).mockResolvedValue(null);
    vi.mocked(storePurgeReading).mockImplementation(async (id: string) => (calls.push(`reading ${id}`), { purged: 1 }));
    vi.mocked(purgeInstallation).mockImplementation(async (id: string) => (calls.push(`installation ${id}`), { purged: true, events: 0, posts: 0, conversations: 0 }));
    const counts = await runPurge(undefined, NOW);
    expect(calls).toEqual([`reading ${I1}`, `installation ${I1}`, `reading ${I2}`, `installation ${I2}`]);
    expect(counts.slackRevocationsPurged).toBe(2);
    expect(listUnpurgedRevokedInstallations).toHaveBeenCalledWith(new Date(NOW.getTime() - 3_600_000).toISOString(), 20, { signal: undefined });
  });

  it("P8 PU04: a principal with Slack lines and no live reading half → scrubBriefsForSlackSystem; one whose reading is active → untouched; after the re-check of revoked halves", async () => {
    vi.mocked(listRevokedReadingInstallations).mockResolvedValue([I3]);
    vi.mocked(listPrincipalIdsWithSlackLines).mockResolvedValue(["ep_off", "ep_live", "ep_gone"]);
    vi.mocked(installationFactsForSystem).mockImplementation(async (id: string) => ({
      schema: true, active: id !== "ep_gone", readingActive: id === "ep_live"
    }));
    vi.mocked(scrubBriefsForSlackSystem).mockImplementation(async (id: string) => (id === "ep_off" ? 2 : 1));
    const counts = await runPurge(undefined, NOW);
    expect(vi.mocked(scrubBriefsForSlackSystem).mock.calls.map((c) => c[0])).toEqual(["ep_off", "ep_gone"]);
    expect(counts.briefSlackScrubbed).toBe(3);
    expect(listPrincipalIdsWithSlackLines).toHaveBeenCalledWith(100, { signal: undefined });
    expect(order(purgeReading)).toBeLessThan(order(listPrincipalIdsWithSlackLines));
    expect(order(purgeExpiredBriefs)).toBeLessThan(order(listRevokedReadingInstallations));
    // A null answer (not installed) counts 0; a failing principal doesn't stop the next one and fails the run.
    vi.mocked(scrubBriefsForSlackSystem).mockReset();
    vi.mocked(scrubBriefsForSlackSystem).mockImplementation(async (id: string) => {
      if (id === "ep_off") throw new Error("exec brief store: exec_brief_scrub_slack failed (57014)");
      return null;
    });
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: briefSlack: exec brief store: exec_brief_scrub_slack failed (57014)");
    expect(vi.mocked(scrubBriefsForSlackSystem).mock.calls.map((c) => c[0])).toEqual(["ep_off", "ep_gone"]);
  });

  it("P8 PU11 (intel-15, coherence-8): a disabled principal's stopped reading half → purgeReading once, P7a's slack.read_purged audit (ids and counts only), revokedReadingPurged 1; the next run doesn't list it", async () => {
    vi.mocked(listRevokedReadingInstallations).mockResolvedValueOnce([I3]).mockResolvedValueOnce([]);
    vi.mocked(purgeReading).mockResolvedValue({ channels: 2, messages: 5, items: 1 });
    const signal = new AbortController().signal;
    const counts = (await purgeJobHandler.run(SYSTEM_CTX(signal))) as Record<string, number>;
    expect(purgeReading).toHaveBeenCalledTimes(1);
    expect(purgeReading).toHaveBeenCalledWith(I3);
    expect(counts.revokedReadingPurged).toBe(1);
    expect(auditEvent).toHaveBeenCalledWith(null, {
      actor: "system", action: "slack.read_purged", target: `exec_slack_installations:${I3}`, input: { reason: "system_purge", channels: 2, messages: 5, items: 1 }
    });
    assertNoBriefText(vi.mocked(auditEvent).mock.calls);
    expect((await purgeJobHandler.run(SYSTEM_CTX(signal)) as Record<string, number>).revokedReadingPurged).toBe(0);
    expect(purgeReading).toHaveBeenCalledTimes(1);
  });

  it("P8 PU11: purgeReading null (P7a not installed) skips the sub-step, the others run; more than 50 listed → 50 a day; a failing id doesn't stop the next", async () => {
    vi.mocked(listRevokedReadingInstallations).mockResolvedValue([I1, I2]);
    vi.mocked(purgeReading).mockResolvedValue(null);
    vi.mocked(listPrincipalIdsWithSlackLines).mockResolvedValue(["ep_off"]);
    vi.mocked(installationFactsForSystem).mockResolvedValue({ schema: true, active: false, readingActive: false });
    vi.mocked(scrubBriefsForSlackSystem).mockResolvedValue(1);
    const counts = await runPurge(undefined, NOW);
    expect(purgeReading).toHaveBeenCalledTimes(1);
    expect(auditEvent).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ revokedReadingPurged: 0, briefSlackScrubbed: 1 });
    // 60 listed → the first 50 (P7a's lister orders oldest revoke first).
    const many = Array.from({ length: 60 }, (_, i) => `esi_${i.toString(16).padStart(32, "0")}`);
    vi.mocked(listRevokedReadingInstallations).mockResolvedValue(many);
    vi.mocked(purgeReading).mockReset();
    vi.mocked(purgeReading).mockResolvedValue({ purged: 1 });
    expect((await runPurge(undefined, NOW)).revokedReadingPurged).toBe(50);
    expect(vi.mocked(purgeReading).mock.calls.map((c) => c[0])).toEqual(many.slice(0, 50));
    // One failing id: the next still runs, the run fails at the end.
    vi.mocked(listRevokedReadingInstallations).mockResolvedValue([I1, I2]);
    vi.mocked(purgeReading).mockReset();
    vi.mocked(purgeReading).mockImplementation(async (id: string) => {
      if (id === I1) throw new Error("exec slack reading store: purgeReading failed (55P03)");
      return { purged: 1 };
    });
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: revokedReading: exec slack reading store: purgeReading failed (55P03)");
    expect(vi.mocked(purgeReading).mock.calls.map((c) => c[0])).toEqual([I1, I2]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("revokedReadingPurged=0 "));
  });

  it("P8 PU12 (intel-18): two mini-brief DMs past fallback_delete_after → deleteDdBotDm each on the stored channel and ts, both marked; one not yet due untouched; principal null", async () => {
    const base = { principal_id: "ep_1", tz: "UTC", scheduled_at: "2026-10-01T08:00:00.000Z", status: "page_only", content: null,
      content_purged_at: "2026-10-31T00:00:00.000Z", content_expires_at: "2026-10-31T00:00:00.000Z", expires_at: "2027-04-01T00:00:00.000Z",
      fallback_sent_at: "2026-10-01T08:45:00.000Z" };
    const brief = await withBriefDb({
      tables: {
        exec_briefs: [
          { ...base, id: `eb_${"a".repeat(32)}`, local_date: "2026-10-01", fallback_channel_id: "D0DDBOT", fallback_slack_ts: "1790000000.000100",
            fallback_delete_after: "2026-10-31T08:45:00.000Z" },
          { ...base, id: `eb_${"b".repeat(32)}`, local_date: "2026-10-02", fallback_channel_id: "D0DDBOT", fallback_slack_ts: "1790086400.000100",
            fallback_delete_after: "2026-11-01T08:45:00.000Z" },
          { ...base, id: `eb_${"c".repeat(32)}`, local_date: "2026-11-03", fallback_channel_id: "D0DDBOT", fallback_slack_ts: "1793600000.000100",
            fallback_delete_after: "2026-12-03T08:45:00.000Z" }
        ]
      }
    });
    const signal = new AbortController().signal;
    const counts = (await purgeJobHandler.run(SYSTEM_CTX(signal))) as Record<string, number>;
    expect(vi.mocked(deleteDdBotDm).mock.calls).toEqual([
      [{ channel: "D0DDBOT", ts: "1790000000.000100" }, { signal }],
      [{ channel: "D0DDBOT", ts: "1790086400.000100" }, { signal }]
    ]);
    expect(counts).toMatchObject({ fallbackDmsDeleted: 2, fallbackDmsRetry: 0 });
    expect(brief.tables.exec_briefs.map((b) => b.fallback_deleted_at === null)).toEqual([false, false, true]);
    // A second run: nothing due any more.
    vi.mocked(deleteDdBotDm).mockClear();
    expect((await runPurge(undefined, NOW)).fallbackDmsDeleted).toBe(0);
    expect(deleteDdBotDm).not.toHaveBeenCalled();
  });

  it("P8 PU12: \"retry\" (ratelimited) or a throw → not marked, counted fallbackDmsRetry, the run still succeeds; \"deleted\" (message_not_found included) → marked", async () => {
    vi.mocked(listFallbackDmsDue).mockResolvedValue([
      { id: `eb_${"a".repeat(32)}`, channel: "D0DDBOT", ts: "1790000000.000100" },
      { id: `eb_${"b".repeat(32)}`, channel: "D0DDBOT", ts: "1790086400.000100" },
      { id: `eb_${"c".repeat(32)}`, channel: "D0DDBOT", ts: "1790172800.000100" }
    ]);
    vi.mocked(deleteDdBotDm).mockResolvedValueOnce("retry").mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce("deleted");
    const counts = await runPurge(undefined, NOW);
    expect(counts).toMatchObject({ fallbackDmsDeleted: 1, fallbackDmsRetry: 2 });
    expect(vi.mocked(markFallbackDmDeleted).mock.calls).toEqual([[`eb_${"c".repeat(32)}`]]);
    expect(listFallbackDmsDue).toHaveBeenCalledWith(NOW, 50);
    expect(console.error).toHaveBeenCalledWith(`[exec-purge] DD-bot mini-brief eb_${"b".repeat(32)} not deleted (Error)`);
  });

  it("P8 PU12 (fixer security-2): retention 365 days caps the mini-brief's deletion at its row's expiry; just past it ONE run deletes the DM, marks it, then deletes the row", async () => {
    const expiresAt = new Date(NOW.getTime() - 3_600_000).toISOString();
    const brief = await withBriefDb({
      tables: {
        exec_briefs: [{
          id: `eb_${"d".repeat(32)}`, principal_id: "ep_1", local_date: "2026-05-08", tz: "UTC", scheduled_at: "2026-05-08T12:00:00.000Z", status: "page_only",
          status_reason: "after_fallback", content: null, content_purged_at: "2026-06-08T00:00:00.000Z", content_expires_at: "2026-06-08T00:00:00.000Z",
          expires_at: expiresAt, fallback_sent_at: "2026-05-08T12:45:00.000Z", fallback_channel_id: "D0DDBOT", fallback_slack_ts: "1778244300.000100",
          // brief-fallback.ts: min(now + 365 days, expires_at) = expires_at.
          fallback_delete_after: expiresAt
        }]
      }
    });
    vi.mocked(purgeExpiredBriefs).mockClear();
    const counts = await runPurge(undefined, NOW);
    expect(vi.mocked(deleteDdBotDm).mock.calls.map((c) => c[0])).toEqual([{ channel: "D0DDBOT", ts: "1778244300.000100" }]);
    expect(counts).toMatchObject({ fallbackDmsDeleted: 1, briefsDeleted: 1 });
    expect(brief.tables.exec_briefs).toEqual([]);
    expect(order(listFallbackDmsDue)).toBeLessThan(order(purgeExpiredBriefs));
  });

  it("P8 PU05: a failing brief step doesn't stop the others (the DD-bot step before it ran); the run throws at the end", async () => {
    vi.mocked(purgeExpiredBriefs).mockRejectedValue(new Error("exec brief store: exec_brief_purge_expired failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: briefs: exec brief store: exec_brief_purge_expired failed (57014)");
    expect(listRevokedReadingInstallations).toHaveBeenCalledTimes(1);
    expect(listFallbackDmsDue).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("briefContentPurged=0 briefsDeleted=0 briefCheckinsDeleted=0 briefMentionsDeleted=0 briefRefsReleased=0 "));
    // And an earlier step failing doesn't skip the P8 steps.
    vi.mocked(purgeExpiredBriefs).mockResolvedValue({ contentPurged: 1, refsReleased: 0, briefsDeleted: 0, checkinsDeleted: 0, mentionsDeleted: 0 });
    vi.mocked(purgeExpiredSlackIntel).mockRejectedValue(new Error("exec slack intel store: purgeExpiredSlackIntel failed (57014)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slackIntel");
    expect(purgeExpiredBriefs).toHaveBeenCalledTimes(2);
    expect(listFallbackDmsDue).toHaveBeenCalledTimes(2);
    // An aborted signal stops before the P8 steps.
    const controller = new AbortController();
    vi.mocked(purgeExpiredSlackIntel).mockImplementation(async () => {
      controller.abort(new Error("lease lost"));
      return { digests: 0, failedBuilds: 0 };
    });
    await expect(runPurge(controller.signal, NOW)).rejects.toThrow("lease lost");
    expect(purgeExpiredBriefs).toHaveBeenCalledTimes(2);
  });

  it("P8 PU07: the summary line carries counts only (key=number pairs), after P7b's, and no brief text, id list or token", async () => {
    vi.mocked(listRevokedReadingInstallations).mockResolvedValue([I1]);
    vi.mocked(listPrincipalIdsWithSlackLines).mockResolvedValue(["ep_off"]);
    vi.mocked(installationFactsForSystem).mockResolvedValue({ schema: true, active: false, readingActive: false });
    vi.mocked(scrubBriefsForSlackSystem).mockResolvedValue(4);
    vi.mocked(listFallbackDmsDue).mockResolvedValue([{ id: `eb_${"a".repeat(32)}`, channel: "D0DDBOT", ts: "1790000000.000100" }]);
    await runPurge(undefined, NOW);
    const line = String(vi.mocked(console.log).mock.calls.at(-1)?.[0]);
    expect(line).toMatch(/^\[exec-purge\] deleted( [A-Za-z]+=\d+)+$/);
    expect(line.endsWith("slackDigests=27 slackDigestsFailed=28 briefContentPurged=29 briefsDeleted=30 briefCheckinsDeleted=31 briefMentionsDeleted=32 " +
      "briefRefsReleased=33 revokedReadingPurged=1 briefSlackScrubbed=4 fallbackDmsDeleted=1 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0")).toBe(true);
    assertNoBriefText([vi.mocked(console.log).mock.calls, vi.mocked(console.error).mock.calls]);
    expect(line).not.toMatch(/eb_|esi_|D0DDBOT|ep_off/);
  });
});

// ---------------------------------------------------------------------------
// P9 (Area C): F13 the Slack token re-seal step; §3.1 RPC 7 v2's released refs
// ---------------------------------------------------------------------------

describe("exec.purge: P9's steps (F13 the re-seal, §3.1 RPC 7 v2)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("PU-P9-1 the Slack token re-seal runs last (after every delete) with the run's signal and reports its four counts", async () => {
    vi.mocked(resealSlackTokens).mockResolvedValue({ checked: 4, resealed: 2, unknownKey: 1, lost: 1, failed: 0 });
    const signal = new AbortController().signal;
    const counts = await runPurge(signal, NOW);
    expect(resealSlackTokens).toHaveBeenCalledWith({ signal });
    expect(order(listPrincipalIdsWithSlackLines)).toBeLessThan(order(resealSlackTokens));
    expect(order(purgeExpiredBriefs)).toBeLessThan(order(resealSlackTokens));
    expect(counts).toMatchObject({ slackResealed: 2, slackResealUnknownKey: 1, slackResealLost: 1, slackResealFailed: 0 });
    expect(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).toContain("slackResealed=2 slackResealUnknownKey=1 slackResealLost=1 slackResealFailed=0");
  });

  it("PU-P9-2 a failing re-seal (EXEC_TOKEN_KEY missing with installations to check) fails alone: every other count is reported and the run throws at the end", async () => {
    vi.mocked(resealSlackTokens).mockRejectedValue(new Error("EXEC_TOKEN_KEY is not set"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 21 steps failed: slackReseal: EXEC_TOKEN_KEY is not set");
    expect(purgeExpiredBriefs).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`briefRefsReleased=33 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1`));
  });

  it("PU-P9-3 the real store: RPC 7 v2 keeps a delivered brief's refs while its DM may exist and the step reports the refs it released", async () => {
    const brief = await withBriefDb({
      tables: {
        exec_briefs: [{
          id: `eb_${"1".padStart(32, "0")}`, principal_id: "ep_1", local_date: "2026-06-01", tz: "UTC", scheduled_at: "2026-06-01T08:00:00.000Z",
          status: "delivered", content: null, content_purged_at: "2026-07-02T00:00:00.000Z", mode: "ai", built_at: "2026-06-01T08:01:00.000Z",
          delivery_started_at: "2026-06-01T08:02:00.000Z", post_attempts: 1, delivered_at: "2026-06-01T08:02:01.000Z", slack_channel_id: "D0MITCH",
          slack_ts: "1780000000.000100", ref_thread_ids: ["t_1"], content_expires_at: "2026-07-01T00:00:00.000Z", expires_at: "2026-11-28T00:00:00.000Z"
        }],
        exec_settings: [{ principal_id: "ep_1", retention_days_chat: 90 }]
      }
    });
    const counts = await runPurge(undefined, NOW);
    expect(counts).toMatchObject({ briefContentPurged: 0, briefRefsReleased: 1 });
    expect(brief.tables.exec_briefs[0].ref_thread_ids).toEqual([]);
  });
});
