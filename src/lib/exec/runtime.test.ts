import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, listEnabledPrincipals: vi.fn(), loadSettings: vi.fn(), loadPrincipalById: vi.fn() };
});
// The mail hook has its own suite (mail-hook.test.ts); here we only see where it is installed.
vi.mock("@/lib/exec/mail-hook", () => ({ ensureMailHook: vi.fn(), recordSocketHealth: vi.fn() }));
// P3's email retention step has its own suites (email-store, purge); here it finds nothing to delete.
vi.mock("@/lib/exec/email-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/email-store")>();
  return { ...actual, purgeExpiredEmailRows: vi.fn() };
});
// P4's drafts retention step has its own suites (drafts-store, purge); here it finds nothing to delete.
vi.mock("@/lib/exec/drafts-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/drafts-store")>();
  return { ...actual, purgeExpiredDrafts: vi.fn() };
});
// P5a's DD text and feedback retention steps have their own suites (ddtext-store, attention-feedback, purge); here they find nothing to delete.
vi.mock("@/lib/exec/ddtext-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/ddtext-store")>();
  return { ...actual, purgeExpiredDdtext: vi.fn(), purgeOrphanDdtextAttention: vi.fn() };
});
vi.mock("@/lib/exec/attention-feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/attention-feedback")>();
  return { ...actual, purgeOldFeedback: vi.fn() };
});
// P5b's chat retention step has its own suites (chat-store, purge); here it finds nothing to delete.
vi.mock("@/lib/exec/chat-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/chat-store")>();
  return { ...actual, purgeExpiredChatRows: vi.fn() };
});
// P6's Slack retention steps have their own suites (slack-install, purge); here they find nothing to delete. The two
// Slack schedules' gate (slack-sweep.ts slackWorkDue) reads the active installation: none here unless a test says so.
vi.mock("@/lib/exec/slack-install", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-install")>();
  return {
    ...actual,
    deleteOldSlackEvents: vi.fn(),
    deleteExpiredOAuthStates: vi.fn(),
    getActiveInstallation: vi.fn(),
    listUnpurgedRevokedInstallations: vi.fn(),
    // P8 (M10 steps 1 and 3): the system purge's revoked-reading lister and the brief-lines fact read.
    listRevokedReadingInstallations: vi.fn(),
    installationFactsForSystem: vi.fn()
  };
});
// P7a's Slack reading retention step (purgeExpiredSlack, contract §3.15) has its own suites (slack-read-store, purge); here it
// finds nothing to delete.
vi.mock("@/lib/exec/slack-read-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-read-store")>();
  return { ...actual, purgeExpiredSlack: vi.fn() };
});
// P7b's Slack intel retention step (purgeExpiredSlackIntel, contract §2.3) has its own suites (slack-intel-store, purge); here it
// finds nothing to delete.
vi.mock("@/lib/exec/slack-intel-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-intel-store")>();
  return { ...actual, purgeExpiredSlackIntel: vi.fn() };
});
// P8 (contract §3.15): the two hooks' store reads (Area A's brief store) are mocked; the hooks' adapters are tested here.
// The system purge's P8 steps (§3.14.1: briefs, briefSlack, ddBotFallbackDms) have their own suite (handlers/purge.test.ts);
// here they find nothing to do.
vi.mock("@/lib/exec/brief-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/brief-store")>();
  return {
    ...actual,
    checkinPostKeys: vi.fn(),
    isBriefSchemaMissing: vi.fn(),
    lastDeliveredBriefAt: vi.fn(),
    purgeExpiredBriefs: vi.fn(),
    listPrincipalIdsWithSlackLines: vi.fn(),
    scrubBriefsForSlackSystem: vi.fn(),
    listFallbackDmsDue: vi.fn(),
    markFallbackDmDeleted: vi.fn()
  };
});
// P9 F13 (Area C): the system purge's Slack token re-seal step has its own suites (slack-token-reseal, handlers/purge); here it
// finds nothing to re-seal.
vi.mock("@/lib/exec/slack-token-reseal", () => ({ resealSlackTokens: vi.fn() }));
// P7a (contract §3.11.12, RT02-RT03): the events route's gate cache is refreshed by the worker tick, not awaited.
vi.mock("@/lib/exec/slack-gate-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-gate-cache")>();
  return { ...actual, refreshGateCache: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { resealSlackTokens } from "@/lib/exec/slack-token-reseal";
import { listEnabledPrincipals, loadPrincipalById, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { createFakeExecDb, jobRow, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredDdtext, purgeOrphanDdtextAttention } from "@/lib/exec/ddtext-store";
import { purgeOldFeedback } from "@/lib/exec/attention-feedback";
import { purgeExpiredChatRows } from "@/lib/exec/chat-store";
import {
  deleteExpiredOAuthStates,
  deleteOldSlackEvents,
  getActiveInstallation,
  listRevokedReadingInstallations,
  listUnpurgedRevokedInstallations
} from "@/lib/exec/slack-install";
import { purgeExpiredSlack } from "@/lib/exec/slack-read-store";
import { DD_ATTENTION_JOB_KIND, ddAttentionJobHandler, ddAttentionScheduledWork } from "@/lib/exec/handlers/dd-attention";
import { DDTEXT_JOB_KIND, ddtextJobHandler, ddtextScheduledWork } from "@/lib/exec/handlers/ddtext-triage";
import { draftGenerateJobHandler } from "@/lib/exec/handlers/draft-generate";
import { draftReconcileJobHandler, draftReconcileScheduledWork } from "@/lib/exec/handlers/draft-reconcile";
import { emailAttentionJobHandler, emailAttentionScheduledWork } from "@/lib/exec/handlers/email-attention";
import { emailReconcileJobHandler, emailReconcileScheduledWork } from "@/lib/exec/handlers/email-reconcile";
import { emailTriageJobHandler } from "@/lib/exec/handlers/email-triage";
import { PURGE_JOB_KIND, RETENTION_DAYS, purgeJobHandler, purgeSystemWork, runPurge } from "@/lib/exec/handlers/purge";
import { accessAlertJobHandler } from "@/lib/exec/handlers/access-alert";
import { briefJobHandler, briefScheduledWork } from "@/lib/exec/handlers/brief";
import { briefDeliverJobHandler } from "@/lib/exec/handlers/brief-deliver";
import { briefFallbackJobHandler } from "@/lib/exec/handlers/brief-fallback";
import { briefHealthJobHandler, briefHealthScheduledWork } from "@/lib/exec/handlers/brief-health";
import { briefPrepJobHandler, briefPrepScheduledWork } from "@/lib/exec/handlers/brief-prep";
import { briefSweepJobHandler, briefSweepScheduledWork } from "@/lib/exec/handlers/brief-sweep";
import { checkinRewriteJobHandler } from "@/lib/exec/handlers/checkin-rewrite";
import { checkinSendJobHandler } from "@/lib/exec/handlers/checkin-send";
import { opsWatchJobHandler, opsWatchSystemWork } from "@/lib/exec/handlers/ops-watch";
import {
  checkinPostKeys,
  isBriefSchemaMissing,
  lastDeliveredBriefAt,
  listFallbackDmsDue,
  listPrincipalIdsWithSlackLines,
  purgeExpiredBriefs
} from "@/lib/exec/brief-store";
import { getAnsweredExclusion } from "@/lib/exec/slack-reading";
import { slackActionJobHandler } from "@/lib/exec/handlers/slack-action";
import { slackCardJobHandler } from "@/lib/exec/handlers/slack-card";
import { slackHomeJobHandler } from "@/lib/exec/handlers/slack-home";
import { slackReplyJobHandler } from "@/lib/exec/handlers/slack-reply";
import { slackDmPurgeJobHandler, slackDmPurgeSystemWork, slackSweepJobHandler, slackSweepScheduledWork } from "@/lib/exec/handlers/slack-sweep";
import { slackUninstallJobHandler } from "@/lib/exec/handlers/slack-uninstall";
import { slackAttentionJobHandler, slackAttentionScheduledWork } from "@/lib/exec/handlers/slack-attention";
import { slackClassifyJobHandler } from "@/lib/exec/handlers/slack-classify";
import { slackDiscoverJobHandler, slackDiscoverScheduledWork } from "@/lib/exec/handlers/slack-discover";
import { slackProbeJobHandler, slackProbeScheduledWork } from "@/lib/exec/handlers/slack-probe";
import { slackReadPurgeJobHandler, slackReadRecheckJobHandler, slackReadRecheckScheduledWork } from "@/lib/exec/handlers/slack-read-purge";
import { slackReadSweepJobHandler, slackReadSweepScheduledWork } from "@/lib/exec/handlers/slack-read-sweep";
import { slackRekeyJobHandler } from "@/lib/exec/handlers/slack-rekey";
import { slackTriageJobHandler } from "@/lib/exec/handlers/slack-triage";
import { slackUserCheckJobHandler } from "@/lib/exec/handlers/slack-user-check";
import { slackCorrelateJobHandler, slackCorrelateScheduledWork } from "@/lib/exec/handlers/slack-correlate";
import { slackDigestJobHandler, slackDigestPlanJobHandler, slackDigestPlanScheduledWork } from "@/lib/exec/handlers/slack-digest";
import { slackIntelSweepJobHandler, slackIntelSweepScheduledWork } from "@/lib/exec/handlers/slack-intel-sweep";
import { refreshGateCache } from "@/lib/exec/slack-gate-cache";
import { voiceRefreshJobHandler, voiceRefreshScheduledWork } from "@/lib/exec/handlers/voice-refresh";
import {
  EMAIL_ATTENTION_JOB_KIND,
  EMAIL_RECONCILE_JOB_KIND,
  EMAIL_TRIAGE_JOB_KIND,
  __resetJobsForTests,
  getJobHandler,
  jobsInFlight,
  registerJobHandler
} from "@/lib/exec/jobs";
import { ensureMailHook, recordSocketHealth } from "@/lib/exec/mail-hook";
import {
  __resetSchedulerForTests,
  dueSystemDedupeKey,
  getScheduledWork,
  getSystemScheduledWork,
  listScheduledWork,
  listSystemScheduledWork,
  registerScheduledWork,
  registerSystemScheduledWork
} from "@/lib/exec/scheduler";
import {
  __resetExecRuntimeForTests,
  briefAnsweredExclusion,
  briefSinceLastResolver,
  ensureExecRuntime,
  runExecSchedulerTick,
  runExecTickForCron,
  runExecWorkerTick
} from "@/lib/exec/runtime";
import { intervalBucket } from "@/lib/exec/time";
import type { ExecPrincipal, JobContext } from "@/lib/exec/types";

let db: FakeExecDb;

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const NOW = new Date("2026-11-04T12:00:00.000Z"); // 07:00 EST
const DAY_MS = 86_400_000;
const isoDaysBefore = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const NO_EMAIL_PURGED = {
  emailThreads: 0,
  emailCommitments: 0,
  emailSignals: 0,
  emailAttentionRows: 0,
  draftsContentPurged: 0,
  draftsDeleted: 0,
  draftsClosedIdle: 0,
  draftsChecksScheduled: 0,
  ddtextItems: 0,
  ddtextAttention: 0,
  attentionFeedback: 0,
  chatConversations: 0,
  chatMessages: 0,
  chatStaleFailed: 0,
  slackEvents: 0,
  oauthStates: 0,
  slackRevocationsPurged: 0,
  slackItems: 0,
  slackMessages: 0,
  slackThreads: 0,
  slackMarkers: 0,
  slackLog: 0,
  slackChannels: 0,
  slackAttention: 0,
  slackDigests: 0,
  slackDigestsFailed: 0,
  // P8 (§3.14.1): the system purge's four new steps find nothing here.
  briefContentPurged: 0,
  briefsDeleted: 0,
  briefCheckinsDeleted: 0,
  briefMentionsDeleted: 0,
  // P9: RPC 7 v2's released refs (§3.1) and the Slack token re-seal's four counts (F13).
  briefRefsReleased: 0,
  revokedReadingPurged: 0,
  briefSlackScrubbed: 0,
  fallbackDmsDeleted: 0,
  fallbackDmsRetry: 0,
  slackResealed: 0,
  slackResealUnknownKey: 0,
  slackResealLost: 0,
  slackResealFailed: 0
};

function resetAll(): void {
  __resetExecRuntimeForTests();
  __resetJobsForTests();
  __resetSchedulerForTests();
}

beforeEach(() => {
  resetAll();
  db = createFakeExecDb();
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(listEnabledPrincipals).mockResolvedValue([]);
  vi.mocked(loadSettings).mockImplementation(async (id: string) => settingsFromRow(null, id));
  vi.mocked(loadPrincipalById).mockResolvedValue(principal);
  vi.mocked(purgeExpiredEmailRows).mockResolvedValue({ threads: 0, commitments: 0, attentionRows: 0, signals: 0 });
  vi.mocked(purgeExpiredDrafts).mockResolvedValue({ contentPurged: 0, deleted: 0, closedIdle: 0, checksScheduled: 0 });
  vi.mocked(purgeExpiredDdtext).mockResolvedValue(0);
  vi.mocked(purgeOrphanDdtextAttention).mockResolvedValue(0);
  vi.mocked(purgeOldFeedback).mockResolvedValue(0);
  vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 0, messages: 0, staleFailed: 0 });
  vi.mocked(deleteOldSlackEvents).mockResolvedValue(0);
  vi.mocked(deleteExpiredOAuthStates).mockResolvedValue(0);
  vi.mocked(getActiveInstallation).mockResolvedValue(null);
  // The C18 backstop (fixer correctness-5) finds no revocation waiting for its purge here.
  vi.mocked(listUnpurgedRevokedInstallations).mockResolvedValue([]);
  vi.mocked(purgeExpiredSlack).mockResolvedValue({ items: 0, messages: 0, threads: 0, markers: 0, log: 0, channels: 0, attention: 0 });
  // P8 (§3.14.1): no expired brief, no revoked reading half, no brief citing Slack, no mini-brief DM due.
  vi.mocked(purgeExpiredBriefs).mockResolvedValue({ contentPurged: 0, refsReleased: 0, briefsDeleted: 0, checkinsDeleted: 0, mentionsDeleted: 0 });
  vi.mocked(listRevokedReadingInstallations).mockResolvedValue([]);
  vi.mocked(listPrincipalIdsWithSlackLines).mockResolvedValue([]);
  vi.mocked(listFallbackDmsDue).mockResolvedValue([]);
  vi.mocked(resealSlackTokens).mockResolvedValue({ checked: 0, resealed: 0, unknownKey: 0, lost: 0, failed: 0 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetAll();
});

// ---------------------------------------------------------------------------

describe("while EXEC_ENABLED is not 'true'", () => {
  it.each([undefined, "", "false", "1", "TRUE"])("EXEC_ENABLED=%j: every entry point is inert", async (value) => {
    if (value === undefined) vi.stubEnv("EXEC_ENABLED", undefined);
    else vi.stubEnv("EXEC_ENABLED", value);

    await expect(runExecWorkerTick()).resolves.toBe("disabled");
    await expect(runExecSchedulerTick()).resolves.toBe("disabled");
    await expect(runExecTickForCron(40_000)).resolves.toEqual({ ok: true, skipped: "disabled" });

    expect(db.rpcCalls).toEqual([]);
    expect(db.upserts).toEqual([]);
    expect(listEnabledPrincipals).not.toHaveBeenCalled();
    // Nothing was even registered.
    expect(getJobHandler(PURGE_JOB_KIND)).toBeUndefined();
    expect(listScheduledWork()).toEqual([]);
  });
});

// P8 (contract §3.15, M10, C17): exec.purge left this list for the system schedule (ALL_SYSTEM_SCHEDULES); the four brief
// works joined it at the end. P9 F16: exec.slack-dm-purge left it too (system work, after exec.ops-watch).
const ALL_SCHEDULES = [
  ddAttentionScheduledWork,
  emailReconcileScheduledWork,
  emailAttentionScheduledWork,
  draftReconcileScheduledWork,
  voiceRefreshScheduledWork,
  ddtextScheduledWork,
  slackSweepScheduledWork,
  slackDiscoverScheduledWork,
  slackReadSweepScheduledWork,
  slackProbeScheduledWork,
  slackAttentionScheduledWork,
  slackReadRecheckScheduledWork,
  // P7b (contract §3.11.5)
  slackCorrelateScheduledWork,
  slackDigestPlanScheduledWork,
  slackIntelSweepScheduledWork,
  // P8 (contract §3.6, §3.15)
  briefScheduledWork,
  briefPrepScheduledWork,
  briefSweepScheduledWork,
  briefHealthScheduledWork
];
const ALL_SYSTEM_SCHEDULES = [purgeSystemWork, opsWatchSystemWork, slackDmPurgeSystemWork];

describe("ensureExecRuntime", () => {
  // P6 (contract §3.11.8, C35): the seven Slack kinds, registered unconditionally; the sweep's schedule gated on an active installation.
  // P9 F16: the DM purge is SYSTEM work (daily at 04:10 UTC, every active installation, a disabled principal's included), never
  // a per-principal schedule; its handler stays (a per-principal row queued before P9 still runs once).
  it("registers the seven P6 Slack kinds, the sweep's gated schedule and (P9 F16) the DM purge's system work", async () => {
    ensureExecRuntime();
    for (const handler of [slackReplyJobHandler, slackActionJobHandler, slackCardJobHandler, slackHomeJobHandler, slackUninstallJobHandler, slackSweepJobHandler, slackDmPurgeJobHandler]) {
      expect(getJobHandler(handler.kind)).toBe(handler);
    }
    expect([slackReplyJobHandler, slackActionJobHandler, slackCardJobHandler, slackHomeJobHandler, slackUninstallJobHandler, slackSweepJobHandler, slackDmPurgeJobHandler].map((h) => [h.kind, h.lane, h.timeoutMs])).toEqual([
      ["exec.slack-reply", "interactive", 300_000],
      ["exec.slack-action", "interactive", 420_000],
      ["exec.slack-card", "interactive", 30_000],
      ["exec.slack-home", "interactive", 30_000],
      ["exec.slack-uninstall", "bulk", 60_000],
      ["exec.slack-sweep", "bulk", 60_000],
      ["exec.slack-dm-purge", "bulk", 120_000]
    ]);
    expect(getScheduledWork("exec.slack-sweep")).toBe(slackSweepScheduledWork);
    expect(getScheduledWork("exec.slack-dm-purge")).toBeUndefined();
    expect(getSystemScheduledWork("exec.slack-dm-purge")).toBe(slackDmPurgeSystemWork);
    expect(slackSweepScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 1 });
    expect(slackDmPurgeSystemWork).toEqual({ kind: "exec.slack-dm-purge", lane: "bulk", cadence: { kind: "daily", atUtc: "04:10" }, maxAttempts: 2 });
    const settings = settingsFromRow(null, "ep_1");
    expect(slackSweepScheduledWork.enabled).toBeUndefined();
    // The sweep's gate: no active installation → nothing enqueued; an active one → due.
    await expect(slackSweepScheduledWork.when?.(principal, settings, NOW)).resolves.toBe(false);
    vi.mocked(getActiveInstallation).mockResolvedValueOnce({ id: "esi_" + "1".repeat(32) } as never);
    await expect(slackSweepScheduledWork.when?.(principal, settings, NOW)).resolves.toBe(true);
  });

  // P5a (contract §3.12.8, K17): the DD text triage, its own kind on the DD refresh's 10-minute buckets, ungated.
  it("registers the P5a DD text triage and its 10-minute, ungated schedule", () => {
    ensureExecRuntime();
    expect(getJobHandler(DDTEXT_JOB_KIND)).toBe(ddtextJobHandler);
    expect(getScheduledWork(DDTEXT_JOB_KIND)).toBe(ddtextScheduledWork);
    expect(ddtextJobHandler).toMatchObject({ kind: "exec.ddtext-triage", lane: "bulk", timeoutMs: 240_000 });
    expect(ddtextScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 3 });
    expect(ddtextScheduledWork.enabled).toBeUndefined();
  });

  it("registers the three P4 draft kinds and their two schedules (Y5)", () => {
    ensureExecRuntime();
    expect(getJobHandler("exec.draft-generate")).toBe(draftGenerateJobHandler);
    expect(getJobHandler("exec.draft-reconcile")).toBe(draftReconcileJobHandler);
    expect(getJobHandler("exec.voice-refresh")).toBe(voiceRefreshJobHandler);
    expect(getScheduledWork("exec.draft-reconcile")).toBe(draftReconcileScheduledWork);
    expect(getScheduledWork("exec.voice-refresh")).toBe(voiceRefreshScheduledWork);
    // The reconcile schedule carries the Y4 `when` gate (a row is due); the voice schedule has none.
    expect(typeof draftReconcileScheduledWork.when).toBe("function");
    expect(voiceRefreshScheduledWork.when).toBeUndefined();
  });

  it("registers the built-in handlers and schedules once, however often it's called", () => {
    ensureExecRuntime();
    ensureExecRuntime();
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
    expect(getJobHandler(DD_ATTENTION_JOB_KIND)).toBe(ddAttentionJobHandler);
    // P8 (M10, C17): exec.purge is system work now, never a per-principal schedule.
    expect(getScheduledWork(PURGE_JOB_KIND)).toBeUndefined();
    expect(getSystemScheduledWork(PURGE_JOB_KIND)).toBe(purgeSystemWork);
    expect(getScheduledWork(DD_ATTENTION_JOB_KIND)).toBe(ddAttentionScheduledWork);
    expect(listScheduledWork()).toEqual(ALL_SCHEDULES);
    expect(listSystemScheduledWork()).toEqual(ALL_SYSTEM_SCHEDULES);
  });

  it("registers the three email kinds (P3) and their two schedules", () => {
    ensureExecRuntime();
    expect(getJobHandler(EMAIL_TRIAGE_JOB_KIND)).toBe(emailTriageJobHandler);
    expect(getJobHandler(EMAIL_RECONCILE_JOB_KIND)).toBe(emailReconcileJobHandler);
    expect(getJobHandler(EMAIL_ATTENTION_JOB_KIND)).toBe(emailAttentionJobHandler);
    expect(emailTriageJobHandler).toMatchObject({ kind: "exec.email-triage", timeoutMs: 120_000 });
    expect(emailReconcileJobHandler).toMatchObject({ kind: "exec.email-reconcile", lane: "bulk", timeoutMs: 240_000 });
    expect(emailAttentionJobHandler).toMatchObject({ kind: "exec.email-attention", timeoutMs: 120_000 });
    // Reconcile: every 5 minutes, bulk, 3 attempts, only once email is installed and on.
    expect(getScheduledWork(EMAIL_RECONCILE_JOB_KIND)).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 3 });
    const gate = emailReconcileScheduledWork.enabled as (s: ReturnType<typeof settingsFromRow>) => boolean;
    const base = settingsFromRow(null, "ep_1");
    expect(gate({ ...base, emailEnabled: true, emailSchemaReady: true })).toBe(true);
    expect(gate({ ...base, emailEnabled: true, emailSchemaReady: false })).toBe(false);
    expect(gate({ ...base, emailEnabled: false, emailSchemaReady: true })).toBe(false);
    // Attention: every 10 minutes, bulk, 3 attempts, ungated (L24).
    expect(getScheduledWork(EMAIL_ATTENTION_JOB_KIND)).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 3 });
    expect(emailAttentionScheduledWork.enabled).toBeUndefined();
  });

  it("tolerates a kind another copy of the module already registered", () => {
    registerJobHandler(purgeJobHandler);
    expect(() => ensureExecRuntime()).not.toThrow();
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
    expect(getSystemScheduledWork(PURGE_JOB_KIND)).toBe(purgeSystemWork);
  });

  it("tolerates a schedule that is already registered", () => {
    registerScheduledWork(ddAttentionScheduledWork);
    // P8: a system schedule another copy of the module already registered, too.
    registerSystemScheduledWork(purgeSystemWork);
    expect(() => ensureExecRuntime()).not.toThrow();
    expect(listScheduledWork()).toEqual(ALL_SCHEDULES);
    expect(listSystemScheduledWork()).toEqual(ALL_SYSTEM_SCHEDULES);
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
  });

  it("keeps its once-per-process flag on globalThis", () => {
    ensureExecRuntime();
    __resetJobsForTests();
    __resetSchedulerForTests();
    ensureExecRuntime(); // flag still set: no re-registration
    expect(getJobHandler(PURGE_JOB_KIND)).toBeUndefined();
    __resetExecRuntimeForTests();
    ensureExecRuntime();
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
  });
});

describe("P8 the morning brief (contract §3.15): the ten handlers, four schedules, two system works and two hooks", () => {
  const P8_HANDLERS = [briefJobHandler, briefDeliverJobHandler, briefFallbackJobHandler, briefPrepJobHandler, briefSweepJobHandler,
    briefHealthJobHandler, checkinSendJobHandler, checkinRewriteJobHandler, opsWatchJobHandler, accessAlertJobHandler];

  it("registers each handler once, with the §3.13 lanes and timeouts", () => {
    ensureExecRuntime();
    ensureExecRuntime();
    for (const handler of P8_HANDLERS) expect(getJobHandler(handler.kind)).toBe(handler);
    expect(P8_HANDLERS.map((h) => [h.kind, h.lane, h.timeoutMs])).toEqual([
      ["exec.brief", "interactive", 240_000],
      ["exec.brief-deliver", "interactive", 60_000],
      ["exec.brief-fallback", "interactive", 60_000],
      ["exec.brief-prep", "bulk", 15_000],
      ["exec.brief-sweep", "bulk", 60_000],
      ["exec.brief-health", "bulk", 30_000],
      ["exec.checkin-send", "interactive", 30_000],
      ["exec.checkin-rewrite", "interactive", 60_000],
      ["exec.ops-watch", "bulk", 30_000],
      ["exec.access-alert", "bulk", 30_000]
    ]);
    // No schedule for the deliver, fallback (a companion), check-in, ops-watch (system) or access-alert kinds.
    for (const kind of ["exec.brief-deliver", "exec.brief-fallback", "exec.checkin-send", "exec.checkin-rewrite", "exec.access-alert"]) {
      expect(getScheduledWork(kind), kind).toBeUndefined();
      expect(getSystemScheduledWork(kind), kind).toBeUndefined();
    }
    expect(getSystemScheduledWork("exec.ops-watch")).toBe(opsWatchSystemWork);
    expect(getScheduledWork("exec.ops-watch")).toBeUndefined();
  });

  it("registers the two hooks: P7a's answered exclusion (A6) and P7b's since-last-brief resolver (B4)", async () => {
    ensureExecRuntime();
    expect(getAnsweredExclusion()).toBe(briefAnsweredExclusion);
    expect(Reflect.get(globalThis, "__ddExecSinceLastBriefResolver")).toBe(briefSinceLastResolver);
  });

  it("A6 the adapter un-stamps exactly the stamps that are his check-in posts; a missing brief schema matches none", async () => {
    vi.mocked(checkinPostKeys).mockResolvedValue(new Set(["D0SAM0001:1793990000.000100"]));
    const rows = [{ channelId: "D0SAM0001", respondedTs: "1793990000.000100" }, { channelId: "C0OPS0001", respondedTs: "1793990001.000200" }];
    await expect(briefAnsweredExclusion(principal, rows)).resolves.toEqual([rows[0]]);
    expect(checkinPostKeys).toHaveBeenCalledWith(principal, [{ channelId: "D0SAM0001", ts: "1793990000.000100" }, { channelId: "C0OPS0001", ts: "1793990001.000200" }]);
    await expect(briefAnsweredExclusion(principal, [])).resolves.toEqual([]);
    const missing = new Error("not installed");
    vi.mocked(checkinPostKeys).mockRejectedValue(missing);
    vi.mocked(isBriefSchemaMissing).mockImplementation((e) => e === missing);
    await expect(briefAnsweredExclusion(principal, rows)).resolves.toEqual([]);
    const other = new Error("timeout");
    vi.mocked(checkinPostKeys).mockRejectedValue(other);
    await expect(briefAnsweredExclusion(principal, rows)).rejects.toBe(other);
  });

  it("B4 the resolver answers the latest delivered or fallback stamp, or null", async () => {
    vi.mocked(lastDeliveredBriefAt).mockResolvedValue("2026-11-06T13:01:00.000Z");
    await expect(briefSinceLastResolver(principal)).resolves.toEqual(new Date("2026-11-06T13:01:00.000Z"));
    vi.mocked(lastDeliveredBriefAt).mockResolvedValue(null);
    await expect(briefSinceLastResolver(principal)).resolves.toBeNull();
    vi.mocked(lastDeliveredBriefAt).mockResolvedValue("not a time");
    await expect(briefSinceLastResolver(principal)).resolves.toBeNull();
  });

  it("the brief's schedules: exec.brief and its watchdog at the brief time, prep 15 minutes before, the sweep every 5, health at 06:00", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(listEnabledPrincipals).mockResolvedValue([principal]);
    vi.mocked(loadSettings).mockImplementation(async (id: string) => ({ ...settingsFromRow(null, id), briefEnabled: true }));
    vi.setSystemTime(new Date("2026-11-06T13:00:00Z"));   // 08:00 EST
    await runExecSchedulerTick();
    const rows = db.upserts.map((u) => u.row).filter((r) => String(r.kind).startsWith("exec.brief"));
    expect(rows.map((r) => [r.kind, r.dedupe_key, r.lane, r.max_attempts])).toEqual([
      ["exec.brief", "exec.brief:ep_1:2026-11-06", "interactive", 1],
      ["exec.brief-fallback", "exec.brief-fallback:ep_1:2026-11-06", "interactive", 1],
      ["exec.brief-prep", "exec.brief-prep:ep_1:2026-11-06", "bulk", 1],
      ["exec.brief-sweep", `exec.brief-sweep:ep_1:i${intervalBucket(new Date("2026-11-06T13:00:00Z"), 5)}`, "bulk", 1],
      ["exec.brief-health", "exec.brief-health:ep_1:2026-11-06", "bulk", 2]
    ]);
    expect(rows[0].payload).toEqual({ local_date: "2026-11-06", scheduled_at: "2026-11-06T13:00:00.000Z", trigger: "schedule" });
    expect(rows[1]).toMatchObject({ payload: { local_date: "2026-11-06", scheduled_at: "2026-11-06T13:00:00.000Z" }, run_after: "2026-11-06T13:45:00.000Z" });
  });
});

describe("P7a Slack reading (contract §3.11.12): RT01-RT03", () => {
  const P7A_HANDLERS = [slackDiscoverJobHandler, slackClassifyJobHandler, slackReadSweepJobHandler, slackProbeJobHandler, slackTriageJobHandler,
    slackAttentionJobHandler, slackRekeyJobHandler, slackUserCheckJobHandler, slackReadPurgeJobHandler, slackReadRecheckJobHandler];

  it("RT01 registers the ten handlers and the five schedules once, with the exact gates", () => {
    ensureExecRuntime();
    ensureExecRuntime();
    for (const handler of P7A_HANDLERS) expect(getJobHandler(handler.kind)).toBe(handler);
    expect(P7A_HANDLERS.map((h) => [h.kind, h.lane, h.timeoutMs])).toEqual([
      ["exec.slack-discover", "bulk", 300_000],
      ["exec.slack-classify", "interactive", 60_000],
      ["exec.slack-read-sweep", "bulk", 180_000],
      ["exec.slack-probe", "bulk", 90_000],
      ["exec.slack-triage", "interactive", 90_000],
      ["exec.slack-attention", "bulk", 120_000],
      ["exec.slack-rekey", "interactive", 60_000],
      ["exec.slack-user-check", "bulk", 30_000],
      ["exec.slack-read-purge", "bulk", 120_000],
      ["exec.slack-read-recheck", "bulk", 60_000]
    ]);
    const base = settingsFromRow(null, "ep_1");
    const on = { ...base, slackReadingSchemaReady: true, slackReadingEnabled: true };
    const gate = (w: { enabled?: (s: typeof base) => boolean }, s: typeof base) => w.enabled?.(s);
    expect(getScheduledWork("exec.slack-discover")).toBe(slackDiscoverScheduledWork);
    expect(slackDiscoverScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "daily" }, maxAttempts: 3 });
    expect(slackDiscoverScheduledWork.cadence.kind === "daily" && slackDiscoverScheduledWork.cadence.at(base)).toBe("05:10");
    expect([gate(slackDiscoverScheduledWork, base), gate(slackDiscoverScheduledWork, { ...base, slackReadingSchemaReady: true })]).toEqual([false, true]);
    expect(slackReadSweepScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 30 }, maxAttempts: 1 });
    expect([gate(slackReadSweepScheduledWork, { ...on, slackReadingEnabled: false }), gate(slackReadSweepScheduledWork, on)]).toEqual([false, true]);
    expect(slackProbeScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 15 }, maxAttempts: 1 });
    expect([gate(slackProbeScheduledWork, on), gate(slackProbeScheduledWork, { ...on, watchMode: "active_public" })]).toEqual([false, true]);
    expect(slackAttentionScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 3 });
    expect([gate(slackAttentionScheduledWork, base), gate(slackAttentionScheduledWork, { ...base, slackReadingSchemaReady: true })]).toEqual([false, true]);
    expect(slackReadRecheckScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "daily" }, maxAttempts: 2 });
    expect(slackReadRecheckScheduledWork.cadence.kind === "daily" && slackReadRecheckScheduledWork.cadence.at(base)).toBe("04:20");
    expect([gate(slackReadRecheckScheduledWork, base), gate(slackReadRecheckScheduledWork, { ...base, slackReadingSchemaReady: true })]).toEqual([false, true]);
    // P7b's three schedules (its own describe below) and P6's sweep are left out of P7a's list (P9 F16: P6's DM purge is no
    // per-principal schedule any more).
    expect(listScheduledWork().map((w) => w.kind)).not.toContain("exec.slack-dm-purge");
    const notP7a = ["exec.slack-sweep", "exec.slack-correlate", "exec.slack-digest-plan", "exec.slack-intel-sweep"];
    expect(listScheduledWork().filter((w) => w.kind.startsWith("exec.slack-") && !notP7a.includes(w.kind)).map((w) => w.kind))
      .toEqual(["exec.slack-discover", "exec.slack-read-sweep", "exec.slack-probe", "exec.slack-attention", "exec.slack-read-recheck"]);
  });

  it("RT02 runExecWorkerTick calls refreshGateCache without awaiting it", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    let settle!: (v: "refreshed") => void;
    vi.mocked(refreshGateCache).mockReturnValue(new Promise((r) => (settle = r)));
    await expect(runExecWorkerTick()).resolves.toBe("idle");
    expect(refreshGateCache).toHaveBeenCalledTimes(1);
    settle("refreshed");
  });

  it("RT03 a throwing refresh (sync or async) doesn't fail the tick", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    vi.mocked(refreshGateCache).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(runExecWorkerTick()).resolves.toBe("idle");
    vi.mocked(refreshGateCache).mockRejectedValueOnce(new Error("later"));
    await expect(runExecWorkerTick()).resolves.toBe("idle");
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("P7b Slack intelligence (contract §3.11.5): the four handlers and the three schedules", () => {
  const P7B_HANDLERS = [slackCorrelateJobHandler, slackDigestJobHandler, slackDigestPlanJobHandler, slackIntelSweepJobHandler];

  it("registers each once, with the lanes, timeouts and gates of §3.11 (the sweep gated on the P7a schema only, SW05)", () => {
    ensureExecRuntime();
    ensureExecRuntime();
    for (const handler of P7B_HANDLERS) expect(getJobHandler(handler.kind)).toBe(handler);
    expect(P7B_HANDLERS.map((h) => [h.kind, h.lane, h.timeoutMs])).toEqual([
      ["exec.slack-correlate", "bulk", 120_000],
      ["exec.slack-digest", "bulk", 120_000],
      ["exec.slack-digest-plan", "bulk", 60_000],
      ["exec.slack-intel-sweep", "bulk", 90_000]
    ]);
    expect(getScheduledWork("exec.slack-correlate")).toBe(slackCorrelateScheduledWork);
    expect(getScheduledWork("exec.slack-digest-plan")).toBe(slackDigestPlanScheduledWork);
    expect(getScheduledWork("exec.slack-intel-sweep")).toBe(slackIntelSweepScheduledWork);
    // exec.slack-digest has no schedule: the plan, the tool, the route and rebuilds enqueue it.
    expect(getScheduledWork("exec.slack-digest")).toBeUndefined();
    const base = settingsFromRow(null, "ep_1");
    const schema = { ...base, slackReadingSchemaReady: true };
    const on = { ...schema, slackReadingEnabled: true };
    const gate = (w: { enabled?: (s: typeof base) => boolean }, s: typeof base) => w.enabled?.(s);
    expect(slackCorrelateScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 15 }, maxAttempts: 3 });
    expect([gate(slackCorrelateScheduledWork, schema), gate(slackCorrelateScheduledWork, on)]).toEqual([false, true]);
    expect(slackDigestPlanScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "daily" }, maxAttempts: 2 });
    expect(slackDigestPlanScheduledWork.cadence.kind === "daily" && slackDigestPlanScheduledWork.cadence.at(base)).toBe("00:30");
    expect([gate(slackDigestPlanScheduledWork, schema), gate(slackDigestPlanScheduledWork, on)]).toEqual([false, true]);
    expect(slackIntelSweepScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 3 });
    // The sweep only removes data, so reading off doesn't stop it; only a missing P7a schema does.
    expect([gate(slackIntelSweepScheduledWork, base), gate(slackIntelSweepScheduledWork, schema), gate(slackIntelSweepScheduledWork, on)]).toEqual([false, true, true]);
    // P8 stage 0 (p8-bindings.md, forced by the ScheduledWork.payload ctx seed): the payload function now gets a ScheduleContext.
    const ctx = { now: new Date(), settings: base, zone: "UTC", localDate: null, dueAt: null, dueKey: "exec.slack-intel-sweep:ep_1:i1" };
    expect(slackIntelSweepScheduledWork.payload?.(principal, ctx)).toEqual({ reason: "schedule" });
  });
});

describe("runExecWorkerTick", () => {
  beforeEach(() => vi.stubEnv("EXEC_ENABLED", "true"));

  it("is idle with an empty queue, after an interactive then a bulk pass", async () => {
    await expect(runExecWorkerTick()).resolves.toBe("idle");
    expect(db.callsTo("exec_claim_jobs").map((c) => c.p_lane)).toEqual(["interactive", "bulk"]);
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
  });

  it("reports claims and doesn't wait for the jobs", async () => {
    db.queue.push(jobRow({ kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1" }));
    let release!: () => void;
    db.deleteResult = () => ({ count: 0, error: null });
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(loadPrincipalById).mockImplementation(async () => {
      await gate;
      return principal;
    });

    await expect(runExecWorkerTick()).resolves.toBe("claimed interactive=0 bulk=1");
    expect(jobsInFlight().bulk).toBe(1);
    release();
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
    expect(db.callsTo("exec_finish_job")).toEqual([expect.objectContaining({ p_outcome: "succeeded" })]);
  });

  it("still runs the bulk lane when the interactive claim fails, then throws", async () => {
    db.rpc.set("exec_claim_jobs", (args) =>
      args.p_lane === "interactive" ? { data: null, error: { message: "connection reset" } } : { data: [], error: null }
    );
    await expect(runExecWorkerTick()).rejects.toThrow(
      "interactive: exec_claim_jobs failed (interactive): connection reset (claimed interactive=0 bulk=0)"
    );
    expect(db.callsTo("exec_claim_jobs").map((c) => c.p_lane)).toEqual(["interactive", "bulk"]);
  });
});

describe("the mail hook's placement (L19)", () => {
  it("is installed, and socket health recorded, by the worker tick (the instrumentation layer)", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    await runExecWorkerTick();
    expect(ensureMailHook).toHaveBeenCalledTimes(1);
    expect(recordSocketHealth).toHaveBeenCalledTimes(1);
  });

  it("is never installed by the cron route's tick or the scheduler tick", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    await runExecTickForCron(1_000);
    await runExecSchedulerTick();
    ensureExecRuntime();
    expect(ensureMailHook).not.toHaveBeenCalled();
    expect(recordSocketHealth).not.toHaveBeenCalled();
  });

  it("is not installed while EXEC_ENABLED is off", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    await runExecWorkerTick();
    expect(ensureMailHook).not.toHaveBeenCalled();
  });
});

describe("runExecSchedulerTick", () => {
  beforeEach(() => {
    vi.stubEnv("EXEC_ENABLED", "true");
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  it("enqueues the system works and the 10-minute DD and email-attention refreshes, and is idle on a repeat in the same buckets", async () => {
    const at = new Date("2026-11-04T07:00:00Z"); // 02:00 EST; past 03:30 UTC, the system purge's time (P8 M10)
    vi.setSystemTime(at);
    vi.mocked(listEnabledPrincipals).mockResolvedValue([principal]);
    // Email is off (the default settings): the attention pass still runs (L24), reconcile doesn't. The DD text
    // triage is ungated too (P5a: off deletes, not installed skips). P8: the two system works run first (principal_id
    // null), and the 5-minute brief sweep is ungated (it skips cheaply when the brief isn't installed); the brief is off.
    // P9 F16: the third system work, the Slack DM purge (past 04:10 UTC), enqueues after them.
    await expect(runExecSchedulerTick()).resolves.toBe("principals=1 enqueued=4 reaped=0 system=3");
    expect(db.upserts.map((u) => u.row)).toEqual([
      { kind: PURGE_JOB_KIND, lane: "bulk", principal_id: null, payload: {}, dedupe_key: "exec.purge:system:2026-11-04", max_attempts: 3 },
      {
        kind: "exec.ops-watch",
        lane: "bulk",
        principal_id: null,
        payload: { bucket: intervalBucket(at, 15) },
        dedupe_key: `exec.ops-watch:system:i${intervalBucket(at, 15)}`,
        max_attempts: 1
      },
      { kind: "exec.slack-dm-purge", lane: "bulk", principal_id: null, payload: {}, dedupe_key: "exec.slack-dm-purge:system:2026-11-04", max_attempts: 2 },
      {
        kind: DD_ATTENTION_JOB_KIND,
        lane: "bulk",
        principal_id: "ep_1",
        payload: {},
        dedupe_key: `exec.dd-attention:ep_1:i${intervalBucket(at, 10)}`,
        max_attempts: 3
      },
      {
        kind: EMAIL_ATTENTION_JOB_KIND,
        lane: "bulk",
        principal_id: "ep_1",
        payload: {},
        dedupe_key: `exec.email-attention:ep_1:i${intervalBucket(at, 10)}`,
        max_attempts: 3
      },
      {
        kind: DDTEXT_JOB_KIND,
        lane: "bulk",
        principal_id: "ep_1",
        payload: {},
        dedupe_key: `exec.ddtext-triage:ep_1:i${intervalBucket(at, 10)}`,
        max_attempts: 3
      },
      {
        kind: "exec.brief-sweep",
        lane: "bulk",
        principal_id: "ep_1",
        payload: {},
        dedupe_key: `exec.brief-sweep:ep_1:i${intervalBucket(at, 5)}`,
        max_attempts: 1
      }
    ]);
    expect(db.callsTo("exec_reap_expired_leases")).toHaveLength(1);

    // Same 5-, 10- and 15-minute buckets and the same UTC day: every key dedupes, the tick is idle.
    vi.setSystemTime(new Date("2026-11-04T07:04:00Z"));
    await expect(runExecSchedulerTick()).resolves.toBe("idle");
  });

  it("enqueues the 5-minute email reconcile once email is installed and on", async () => {
    const at = new Date("2026-11-04T07:00:00Z");
    vi.setSystemTime(at);
    vi.mocked(listEnabledPrincipals).mockResolvedValue([principal]);
    vi.mocked(loadSettings).mockImplementation(async (id: string) => ({ ...settingsFromRow(null, id), emailEnabled: true, emailSchemaReady: true }));
    await runExecSchedulerTick();
    expect(db.upserts.map((u) => u.row).find((r) => r.kind === EMAIL_RECONCILE_JOB_KIND)).toEqual({
      kind: EMAIL_RECONCILE_JOB_KIND,
      lane: "bulk",
      principal_id: "ep_1",
      payload: {},
      dedupe_key: `exec.email-reconcile:ep_1:i${intervalBucket(at, 5)}`,
      max_attempts: 3
    });
  });

  // P8 (M10, C17): the purge is SYSTEM work (principal_id null) at 03:30 UTC, keyed by UTC date, with or without principals.
  it("enqueues the system purge once 03:30 UTC has passed, deduped by UTC date, with no enabled principal", async () => {
    const purges = () => db.upserts.filter((u) => u.row.kind === PURGE_JOB_KIND);

    vi.setSystemTime(new Date("2026-11-04T03:29:00Z"));
    await runExecSchedulerTick();
    expect(purges()).toEqual([]);

    // The purge, plus this 15-minute bucket's ops-watch (already enqueued at 03:29: same bucket).
    vi.setSystemTime(new Date("2026-11-04T03:30:00Z"));
    await expect(runExecSchedulerTick()).resolves.toBe("principals=0 enqueued=0 reaped=0 system=2");
    expect(purges().map((u) => u.row)).toEqual([
      { kind: PURGE_JOB_KIND, lane: "bulk", principal_id: null, payload: {}, dedupe_key: "exec.purge:system:2026-11-04", max_attempts: 3 }
    ]);

    vi.setSystemTime(new Date("2026-11-04T20:00:00Z")); // later the same UTC day
    await runExecSchedulerTick();
    expect(purges()).toHaveLength(2);
    expect(purges()[1].row.dedupe_key).toBe("exec.purge:system:2026-11-04");
    expect(db.upsertResult({ dedupe_key: "exec.purge:system:2026-11-04" })).toEqual({ data: [], error: null });
  });

  it("reports reaped leases", async () => {
    vi.setSystemTime(NOW);
    db.rpc.set("exec_reap_expired_leases", () => ({ data: 2, error: null }));
    // P8: the system works enqueue too (12:00Z is past 03:30 UTC; P9 F16: and past the DM purge's 04:10 UTC).
    await expect(runExecSchedulerTick()).resolves.toBe("principals=0 enqueued=0 reaped=2 system=3");
  });
});

describe("runExecTickForCron", () => {
  beforeEach(() => vi.stubEnv("EXEC_ENABLED", "true"));

  it("runs the scheduler, then both lanes, and reports each part", async () => {
    // P8 (M10): the system works enqueue with no principal at all (12:00Z: past the 03:30 UTC purge; P9 F16: and the 04:10
    // UTC DM purge, the third).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const out = await runExecTickForCron(40_000);
    expect(out).toEqual({
      ok: true,
      scheduler: { principals: 0, enqueued: 0, reaped: 0, summary: "principals=0 enqueued=0 reaped=0 system=3" },
      interactive: {
        lane: "interactive",
        skipped: null,
        claimed: 0,
        succeeded: 0,
        retried: 0,
        dead: 0,
        cancelled: 0,
        leaseLost: 0,
        finishFailed: 0,
        running: 0
      },
      bulk: {
        lane: "bulk",
        skipped: null,
        claimed: 0,
        succeeded: 0,
        retried: 0,
        dead: 0,
        cancelled: 0,
        leaseLost: 0,
        finishFailed: 0,
        running: 0
      },
      budgetMs: 40_000,
      elapsedMs: expect.any(Number)
    });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["exec_reap_expired_leases", "exec_claim_jobs", "exec_claim_jobs"]);
  });

  it("waits for the jobs it starts and runs a purge end to end", async () => {
    db.queue.push(jobRow({ kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1" }));
    db.deleteResult = (d) => ({ count: d.table === "exec_jobs" ? 5 : 1, error: null });
    const out = await runExecTickForCron(40_000);
    expect(out.ok).toBe(true);
    expect(out.bulk).toMatchObject({ claimed: 1, succeeded: 1, running: 0 });
    expect(db.deletes.map((d) => d.table)).toEqual([
      "exec_jobs",
      "exec_access_log",
      "exec_audit_log",
      "exec_ai_usage",
      "exec_attention_items"
    ]);
    expect(db.callsTo("exec_finish_job")).toEqual([
      expect.objectContaining({
        p_outcome: "succeeded",
        p_result: { finishedJobs: 5, accessLog: 1, auditLog: 1, aiUsage: 1, resolvedAttention: 1, ...NO_EMAIL_PURGED }
      })
    ]);
  });

  it("caps the budget at 45 s and floors it at 0", async () => {
    await expect(runExecTickForCron(120_000)).resolves.toMatchObject({ budgetMs: 45_000 });
    await expect(runExecTickForCron(-5)).resolves.toMatchObject({ budgetMs: 0 });
    await expect(runExecTickForCron(Number.NaN)).resolves.toMatchObject({ budgetMs: 0 });
  });

  it("returns at the deadline while a job is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    db.queue.push(jobRow({ kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1" }));
    db.deleteResult = () => ({ count: 0, error: null });
    // The principal lookup stalls past the 1 s budget.
    vi.mocked(loadPrincipalById).mockImplementation(() => new Promise((r) => setTimeout(() => r(principal), 5_000)));

    const tick = runExecTickForCron(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(tick).resolves.toMatchObject({ ok: true, bulk: expect.objectContaining({ claimed: 1, running: 1 }) });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
  });

  it("still runs the lanes when the scheduler fails, and reports ok: false", async () => {
    vi.mocked(listEnabledPrincipals).mockRejectedValue(new Error("exec_principals read failed: timeout"));
    const out = await runExecTickForCron(40_000);
    expect(out.ok).toBe(false);
    expect(out.scheduler).toEqual({ error: "exec_principals read failed: timeout" });
    expect(out.interactive).toMatchObject({ claimed: 0 });
    expect(out.bulk).toMatchObject({ claimed: 0 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("scheduler failed"));
  });

  it("reports a lane whose claim failed, and keeps the other", async () => {
    db.rpc.set("exec_claim_jobs", (args) =>
      args.p_lane === "bulk" ? { data: null, error: { message: "permission denied" } } : { data: [], error: null }
    );
    const out = await runExecTickForCron(40_000);
    expect(out.ok).toBe(false);
    expect(out.bulk).toEqual({ lane: "bulk", error: "exec_claim_jobs failed (bulk): permission denied" });
    expect(out.interactive).toMatchObject({ lane: "interactive", claimed: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("exec.purge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  // P8 (M10, C17): a SYSTEM job daily at 03:30 UTC (no principal, no setting). Its ceiling (300 s from P8, Area A's
  // handlers/purge.ts) is pinned by purge.test.ts.
  it("is a bulk job, scheduled as system work daily at 03:30 UTC", () => {
    expect(purgeJobHandler).toMatchObject({ kind: "exec.purge", lane: "bulk" });
    expect(purgeSystemWork).toMatchObject({ kind: "exec.purge", lane: "bulk", cadence: { kind: "daily", atUtc: "03:30" }, maxAttempts: 3 });
    expect(dueSystemDedupeKey(purgeSystemWork, new Date("2026-11-04T03:29:59Z"))).toBeNull();
    expect(dueSystemDedupeKey(purgeSystemWork, new Date("2026-11-04T03:30:00Z"))).toBe("exec.purge:system:2026-11-04");
    expect(Object.isFrozen(purgeJobHandler)).toBe(true);
    expect(Object.isFrozen(purgeSystemWork)).toBe(true);
  });

  it("deletes past each table's retention and returns the counts", async () => {
    expect(RETENTION_DAYS).toEqual({ finishedJobs: 14, accessLog: 90, auditLog: 400, aiUsage: 400, resolvedAttention: 90, attentionFeedback: 365 });
    const counts: Record<string, number> = {
      exec_jobs: 7,
      exec_access_log: 30,
      exec_audit_log: 2,
      exec_ai_usage: 11,
      exec_attention_items: 4
    };
    db.deleteResult = (d) => ({ count: counts[d.table], error: null });
    const signal = new AbortController().signal;

    await expect(runPurge(signal)).resolves.toEqual({ finishedJobs: 7, accessLog: 30, auditLog: 2, aiUsage: 11, resolvedAttention: 4, ...NO_EMAIL_PURGED });

    expect(db.deletes).toEqual([
      {
        table: "exec_jobs",
        opts: { count: "exact" },
        filters: [
          ["in", "status", ["succeeded", "dead", "cancelled"]],
          ["lt", "finished_at", isoDaysBefore(14)]
        ],
        signal
      },
      { table: "exec_access_log", opts: { count: "exact" }, filters: [["lt", "created_at", isoDaysBefore(90)]], signal },
      { table: "exec_audit_log", opts: { count: "exact" }, filters: [["lt", "created_at", isoDaysBefore(400)]], signal },
      { table: "exec_ai_usage", opts: { count: "exact" }, filters: [["lt", "created_at", isoDaysBefore(400)]], signal },
      // Only resolved items, by when they were resolved and last seen: a live,
      // snoozed or dismissed item stays however old it is, and so does one he
      // resolved while its situation is still around.
      {
        table: "exec_attention_items",
        opts: { count: "exact" },
        filters: [
          ["eq", "status", "resolved"],
          ["lt", "resolved_at", isoDaysBefore(90)],
          ["lt", "last_seen_at", isoDaysBefore(90)]
        ],
        signal
      }
    ]);
    expect(console.log).toHaveBeenCalledWith(
      "[exec-purge] deleted finishedJobs=7 accessLog=30 auditLog=2 aiUsage=11 resolvedAttention=4 " +
        "emailThreads=0 emailCommitments=0 emailSignals=0 emailAttentionRows=0 " +
        "draftsContentPurged=0 draftsDeleted=0 draftsClosedIdle=0 draftsChecksScheduled=0 " +
        "ddtextItems=0 ddtextAttention=0 attentionFeedback=0 chatConversations=0 chatMessages=0 chatStaleFailed=0 slackEvents=0 oauthStates=0 slackRevocationsPurged=0 slackItems=0 slackMessages=0 slackThreads=0 slackMarkers=0 slackLog=0 slackChannels=0 slackAttention=0 slackDigests=0 slackDigestsFailed=0 " +
        "briefContentPurged=0 briefsDeleted=0 briefCheckinsDeleted=0 briefMentionsDeleted=0 briefRefsReleased=0 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 " +
        "slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0"
    );
  });

  it("keeps a row he resolved himself while refreshes still see its situation", async () => {
    await runPurge();
    const purge = db.deletes.find((d) => d.table === "exec_attention_items");
    if (!purge) throw new Error("no attention purge");
    // The delete's filters, applied to rows as Postgres would.
    const deletes = (row: Record<string, string | null>) =>
      purge.filters.every(([op, column, value]) => {
        const cell = row[column as string];
        if (op === "eq") return cell === value;
        if (op === "lt") return cell !== null && Date.parse(cell) < Date.parse(String(value));
        throw new Error(`unexpected filter ${String(op)}`);
      });
    const rows: Record<string, Record<string, string | null>> = {
      // Gone 101 days ago, auto-resolved the next refresh.
      autoResolvedLongAgo: { status: "resolved", resolved_at: isoDaysBefore(100), last_seen_at: isoDaysBefore(101) },
      // He marked it done 100 days ago; yesterday's refresh still found the same situation.
      ownerResolvedStillSeen: { status: "resolved", resolved_at: isoDaysBefore(100), last_seen_at: isoDaysBefore(1) },
      // He marked it done 100 days ago, and the situation itself ended 95 days ago.
      ownerResolvedGoneLongAgo: { status: "resolved", resolved_at: isoDaysBefore(100), last_seen_at: isoDaysBefore(95) },
      resolvedRecently: { status: "resolved", resolved_at: isoDaysBefore(10), last_seen_at: isoDaysBefore(11) },
      dismissedLongAgo: { status: "dismissed", resolved_at: null, last_seen_at: isoDaysBefore(400) }
    };
    expect(Object.keys(rows).filter((name) => deletes(rows[name]))).toEqual(["autoResolvedLongAgo", "ownerResolvedGoneLongAgo"]);
  });

  it("runs every step even when one fails, then fails the run", async () => {
    db.deleteResult = (d) =>
      d.table === "exec_access_log" ? { count: null, error: { message: "statement timeout" } } : { count: 1, error: null };
    await expect(runPurge()).rejects.toThrow("exec.purge: 1 of 21 steps failed: accessLog: exec_access_log purge failed: statement timeout");
    expect(db.deletes.map((d) => d.table)).toEqual([
      "exec_jobs",
      "exec_access_log",
      "exec_audit_log",
      "exec_ai_usage",
      "exec_attention_items"
    ]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("accessLog step failed"));
  });

  it("fails the run when the resolved-attention step fails, after the other steps ran", async () => {
    db.deleteResult = (d) =>
      d.table === "exec_attention_items" ? { count: null, error: { message: "permission denied" } } : { count: 2, error: null };
    await expect(runPurge()).rejects.toThrow(
      "exec.purge: 1 of 21 steps failed: resolvedAttention: exec_attention_items purge failed: permission denied"
    );
    expect(db.deletes.map((d) => d.table)).toEqual([
      "exec_jobs",
      "exec_access_log",
      "exec_audit_log",
      "exec_ai_usage",
      "exec_attention_items"
    ]);
    expect(console.log).toHaveBeenCalledWith(
      "[exec-purge] deleted finishedJobs=2 accessLog=2 auditLog=2 aiUsage=2 resolvedAttention=0 " +
        "emailThreads=0 emailCommitments=0 emailSignals=0 emailAttentionRows=0 " +
        "draftsContentPurged=0 draftsDeleted=0 draftsClosedIdle=0 draftsChecksScheduled=0 " +
        "ddtextItems=0 ddtextAttention=0 attentionFeedback=0 chatConversations=0 chatMessages=0 chatStaleFailed=0 slackEvents=0 oauthStates=0 slackRevocationsPurged=0 slackItems=0 slackMessages=0 slackThreads=0 slackMarkers=0 slackLog=0 slackChannels=0 slackAttention=0 slackDigests=0 slackDigestsFailed=0 " +
        "briefContentPurged=0 briefsDeleted=0 briefCheckinsDeleted=0 briefMentionsDeleted=0 briefRefsReleased=0 revokedReadingPurged=0 briefSlackScrubbed=0 fallbackDmsDeleted=0 fallbackDmsRetry=0 " +
        "slackResealed=0 slackResealUnknownKey=0 slackResealLost=0 slackResealFailed=0 failed=1"
    );
  });

  it("stops between steps once its signal aborts", async () => {
    const controller = new AbortController();
    db.deleteResult = (d) => {
      if (d.table === "exec_jobs") controller.abort(new Error("lease lost"));
      return { count: 1, error: null };
    };
    await expect(runPurge(controller.signal)).rejects.toThrow("lease lost");
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs"]);
  });

  it("does nothing with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timed out"));
    await expect(runPurge(controller.signal)).rejects.toThrow("timed out");
    expect(db.deletes).toEqual([]);
  });

  it("passes the job's signal through when the runner calls it", async () => {
    const controller = new AbortController();
    const ctx = { job: jobRow({ kind: PURGE_JOB_KIND }), principal, signal: controller.signal, workerId: "w" } satisfies JobContext;
    await expect(purgeJobHandler.run(ctx)).resolves.toEqual({
      finishedJobs: 0,
      accessLog: 0,
      auditLog: 0,
      aiUsage: 0,
      resolvedAttention: 0,
      ...NO_EMAIL_PURGED
    });
    expect(db.deletes.every((d) => d.signal === controller.signal)).toBe(true);
  });
});
