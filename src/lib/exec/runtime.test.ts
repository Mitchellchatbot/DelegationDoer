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
  return { ...actual, deleteOldSlackEvents: vi.fn(), deleteExpiredOAuthStates: vi.fn(), getActiveInstallation: vi.fn(), listUnpurgedRevokedInstallations: vi.fn() };
});
// P7a's Slack reading retention step (purgeExpiredSlack, contract §3.15) has its own suites (slack-read-store, purge); here it
// finds nothing to delete.
vi.mock("@/lib/exec/slack-read-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-read-store")>();
  return { ...actual, purgeExpiredSlack: vi.fn() };
});
// P7a (contract §3.11.12, RT02-RT03): the events route's gate cache is refreshed by the worker tick, not awaited.
vi.mock("@/lib/exec/slack-gate-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-gate-cache")>();
  return { ...actual, refreshGateCache: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listEnabledPrincipals, loadPrincipalById, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { createFakeExecDb, jobRow, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredDdtext, purgeOrphanDdtextAttention } from "@/lib/exec/ddtext-store";
import { purgeOldFeedback } from "@/lib/exec/attention-feedback";
import { purgeExpiredChatRows } from "@/lib/exec/chat-store";
import { deleteExpiredOAuthStates, deleteOldSlackEvents, getActiveInstallation, listUnpurgedRevokedInstallations } from "@/lib/exec/slack-install";
import { purgeExpiredSlack } from "@/lib/exec/slack-read-store";
import { DD_ATTENTION_JOB_KIND, ddAttentionJobHandler, ddAttentionScheduledWork } from "@/lib/exec/handlers/dd-attention";
import { DDTEXT_JOB_KIND, ddtextJobHandler, ddtextScheduledWork } from "@/lib/exec/handlers/ddtext-triage";
import { draftGenerateJobHandler } from "@/lib/exec/handlers/draft-generate";
import { draftReconcileJobHandler, draftReconcileScheduledWork } from "@/lib/exec/handlers/draft-reconcile";
import { emailAttentionJobHandler, emailAttentionScheduledWork } from "@/lib/exec/handlers/email-attention";
import { emailReconcileJobHandler, emailReconcileScheduledWork } from "@/lib/exec/handlers/email-reconcile";
import { emailTriageJobHandler } from "@/lib/exec/handlers/email-triage";
import { PURGE_JOB_KIND, RETENTION_DAYS, purgeJobHandler, purgeScheduledWork, runPurge } from "@/lib/exec/handlers/purge";
import { slackActionJobHandler } from "@/lib/exec/handlers/slack-action";
import { slackCardJobHandler } from "@/lib/exec/handlers/slack-card";
import { slackHomeJobHandler } from "@/lib/exec/handlers/slack-home";
import { slackReplyJobHandler } from "@/lib/exec/handlers/slack-reply";
import { slackDmPurgeJobHandler, slackDmPurgeScheduledWork, slackSweepJobHandler, slackSweepScheduledWork } from "@/lib/exec/handlers/slack-sweep";
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
import { __resetSchedulerForTests, dueDedupeKey, getScheduledWork, listScheduledWork, registerScheduledWork } from "@/lib/exec/scheduler";
import {
  __resetExecRuntimeForTests,
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
  slackAttention: 0
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

const ALL_SCHEDULES = [
  purgeScheduledWork,
  ddAttentionScheduledWork,
  emailReconcileScheduledWork,
  emailAttentionScheduledWork,
  draftReconcileScheduledWork,
  voiceRefreshScheduledWork,
  ddtextScheduledWork,
  slackSweepScheduledWork,
  slackDmPurgeScheduledWork,
  slackDiscoverScheduledWork,
  slackReadSweepScheduledWork,
  slackProbeScheduledWork,
  slackAttentionScheduledWork,
  slackReadRecheckScheduledWork
];

describe("ensureExecRuntime", () => {
  // P6 (contract §3.11.8, C35): the seven Slack kinds, registered unconditionally; both schedules gated on an active installation.
  it("registers the seven P6 Slack kinds and their two gated schedules", async () => {
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
    expect(getScheduledWork("exec.slack-dm-purge")).toBe(slackDmPurgeScheduledWork);
    expect(slackSweepScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "interval", minutes: 5 }, maxAttempts: 1 });
    expect(slackDmPurgeScheduledWork).toMatchObject({ lane: "bulk", cadence: { kind: "daily" }, maxAttempts: 2 });
    const settings = settingsFromRow(null, "ep_1");
    expect(slackDmPurgeScheduledWork.cadence.kind === "daily" && slackDmPurgeScheduledWork.cadence.at(settings)).toBe("04:10");
    expect(slackSweepScheduledWork.enabled).toBeUndefined();
    // The gate: no active installation → nothing enqueued; an active one → due.
    await expect(slackSweepScheduledWork.when?.(principal, settings, NOW)).resolves.toBe(false);
    vi.mocked(getActiveInstallation).mockResolvedValueOnce({ id: "esi_" + "1".repeat(32) } as never);
    await expect(slackDmPurgeScheduledWork.when?.(principal, settings, NOW)).resolves.toBe(true);
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
    expect(getScheduledWork(PURGE_JOB_KIND)).toBe(purgeScheduledWork);
    expect(getScheduledWork(DD_ATTENTION_JOB_KIND)).toBe(ddAttentionScheduledWork);
    expect(listScheduledWork()).toEqual(ALL_SCHEDULES);
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
    expect(getScheduledWork(PURGE_JOB_KIND)).toBe(purgeScheduledWork);
  });

  it("tolerates a schedule that is already registered", () => {
    registerScheduledWork(purgeScheduledWork);
    expect(() => ensureExecRuntime()).not.toThrow();
    expect(listScheduledWork()).toEqual(ALL_SCHEDULES);
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
    expect(listScheduledWork().filter((w) => w.kind.startsWith("exec.slack-") && !["exec.slack-sweep", "exec.slack-dm-purge"].includes(w.kind)).map((w) => w.kind))
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

  it("enqueues only the 10-minute DD and email-attention refreshes before the purge's time, and is idle on a repeat in the same bucket", async () => {
    const at = new Date("2026-11-04T07:00:00Z"); // 02:00 EST, before the 03:30 purge
    vi.setSystemTime(at);
    vi.mocked(listEnabledPrincipals).mockResolvedValue([principal]);
    // Email is off (the default settings): the attention pass still runs (L24), reconcile doesn't. The DD text
    // triage is ungated too (P5a: off deletes, not installed skips).
    await expect(runExecSchedulerTick()).resolves.toBe("principals=1 enqueued=3 reaped=0");
    expect(db.upserts.map((u) => u.row)).toEqual([
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
      }
    ]);
    expect(db.callsTo("exec_reap_expired_leases")).toHaveLength(1);

    // Same 10-minute bucket: the key dedupes, nothing is due, the tick is idle.
    vi.setSystemTime(new Date("2026-11-04T07:09:00Z"));
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

  it("enqueues the daily purge once its local time has passed, deduped by local date", async () => {
    vi.mocked(listEnabledPrincipals).mockResolvedValue([principal]);
    const purges = () => db.upserts.filter((u) => u.row.kind === PURGE_JOB_KIND);

    vi.setSystemTime(new Date("2026-11-04T08:29:00Z")); // 03:29 EST
    await runExecSchedulerTick();
    expect(purges()).toEqual([]);

    // The purge, plus the DD and email-attention refreshes and the DD text triage of a new 10-minute bucket.
    vi.setSystemTime(new Date("2026-11-04T08:30:00Z")); // 03:30 EST
    await expect(runExecSchedulerTick()).resolves.toBe("principals=1 enqueued=4 reaped=0");
    expect(purges().map((u) => u.row)).toEqual([
      { kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", payload: {}, dedupe_key: "exec.purge:ep_1:2026-11-04" }
    ]);

    vi.setSystemTime(new Date("2026-11-04T20:00:00Z")); // later the same local day
    await runExecSchedulerTick();
    expect(purges()).toHaveLength(2);
    expect(purges()[1].row.dedupe_key).toBe("exec.purge:ep_1:2026-11-04");
  });

  it("reports reaped leases", async () => {
    vi.setSystemTime(NOW);
    db.rpc.set("exec_reap_expired_leases", () => ({ data: 2, error: null }));
    await expect(runExecSchedulerTick()).resolves.toBe("principals=0 enqueued=0 reaped=2");
  });
});

describe("runExecTickForCron", () => {
  beforeEach(() => vi.stubEnv("EXEC_ENABLED", "true"));

  it("runs the scheduler, then both lanes, and reports each part", async () => {
    const out = await runExecTickForCron(40_000);
    expect(out).toEqual({
      ok: true,
      scheduler: { principals: 0, enqueued: 0, reaped: 0, summary: "idle" },
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

  it("is a bulk job with a 120 s ceiling, scheduled daily at 03:30 local", () => {
    expect(purgeJobHandler).toMatchObject({ kind: "exec.purge", lane: "bulk", timeoutMs: 120_000 });
    expect(purgeScheduledWork).toMatchObject({ kind: "exec.purge", lane: "bulk", cadence: { kind: "daily" } });
    expect(purgeScheduledWork.enabled).toBeUndefined();
    const settings = settingsFromRow(null, "ep_1");
    expect(dueDedupeKey(purgeScheduledWork, principal, settings, new Date("2026-11-04T08:29:59Z"))).toBeNull();
    expect(dueDedupeKey(purgeScheduledWork, principal, settings, new Date("2026-11-04T08:30:00Z"))).toBe("exec.purge:ep_1:2026-11-04");
    // Ignores the brief time: it's not tied to any setting.
    const briefAtFour = { ...settings, briefLocalTime: "04:00" };
    expect(dueDedupeKey(purgeScheduledWork, principal, briefAtFour, new Date("2026-11-04T08:30:00Z"))).toBe("exec.purge:ep_1:2026-11-04");
    expect(Object.isFrozen(purgeJobHandler)).toBe(true);
    expect(Object.isFrozen(purgeScheduledWork)).toBe(true);
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
        "ddtextItems=0 ddtextAttention=0 attentionFeedback=0 chatConversations=0 chatMessages=0 chatStaleFailed=0 slackEvents=0 oauthStates=0 slackRevocationsPurged=0 slackItems=0 slackMessages=0 slackThreads=0 slackMarkers=0 slackLog=0 slackChannels=0 slackAttention=0"
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
    await expect(runPurge()).rejects.toThrow("exec.purge: 1 of 15 steps failed: accessLog: exec_access_log purge failed: statement timeout");
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
      "exec.purge: 1 of 15 steps failed: resolvedAttention: exec_attention_items purge failed: permission denied"
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
        "ddtextItems=0 ddtextAttention=0 attentionFeedback=0 chatConversations=0 chatMessages=0 chatStaleFailed=0 slackEvents=0 oauthStates=0 slackRevocationsPurged=0 slackItems=0 slackMessages=0 slackThreads=0 slackMarkers=0 slackLog=0 slackChannels=0 slackAttention=0 failed=1"
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
