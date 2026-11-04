import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The event path end to end, on fake timers (contract §5 D "Integration"):
//   message:new on the bus → the hook enqueues triage 8 s out → the worker
//   claims it once due → triage writes the row and kicks attention for the
//   next minute boundary + 2 s → the attention pass runs then and hands the
//   thread's item to the attention sync.
// Real: the bus, the hook, the job queue and runner (over an in-memory
// exec_jobs), the registered handlers (triage with E's matcher, E's attention
// pass), the state machine and the store. Stand-ins: the clone read, the
// rules, the model call, DD's client/satisfaction reads, and P2b's attention
// table write (syncAttention records what it is handed).

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/missive-socket", () => ({ startMissiveSocketBridge: vi.fn(), getMissiveSocketStatus: vi.fn(() => ({ connected: true })) }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadSettings: vi.fn(), loadPrincipalById: vi.fn() };
});
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, readPrincipalThread: vi.fn(), loadHisBodies: vi.fn(), loadScreeningPolicy: vi.fn() };
});
vi.mock("@/lib/exec/triage/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/triage/email")>();
  return { ...actual, runTriageModel: vi.fn() };
});
vi.mock("@/lib/exec/correlate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/correlate")>();
  return { ...actual, loadClientMatcher: vi.fn() };
});
vi.mock("@/lib/exec/sources/dd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/dd")>();
  return { ...actual, listClients: vi.fn(), latestScoredInboundByClient: vi.fn(), listSatisfactionSignals: vi.fn() };
});
vi.mock("@/lib/exec/attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/attention")>();
  return {
    ...actual,
    syncAttention: vi.fn(),
    listAllEmailAttentionRows: vi.fn(),
    deleteEmailAttentionForThreads: vi.fn(),
    deleteAttentionItemsByIds: vi.fn()
  };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { createFakePipelineDb, type FakePipelineDb } from "@/lib/exec/__tests__/fake-pipeline-db";
import { deleteAttentionItemsByIds, deleteEmailAttentionForThreads, listAllEmailAttentionRows, syncAttention } from "@/lib/exec/attention";
import type { AttentionCandidate } from "@/lib/exec/attention-types";
import { buildClientMatcher, loadClientMatcher } from "@/lib/exec/correlate";
import type { PrincipalMailThread } from "@/lib/exec/email-types";
import { EMAIL_ATTENTION_JOB_KIND, EMAIL_TRIAGE_JOB_KIND, __resetJobsForTests, mailEventKey, runWorkerPass } from "@/lib/exec/jobs";
import { EXEC_MODELS } from "@/lib/exec/llm/models";
import { __resetMailHookForTests } from "@/lib/exec/mail-hook";
import { loadPrincipalById, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { __resetExecRuntimeForTests, ensureExecRuntime, runExecWorkerTick } from "@/lib/exec/runtime";
import { __resetSchedulerForTests } from "@/lib/exec/scheduler";
import { latestScoredInboundByClient, listClients, listSatisfactionSignals } from "@/lib/exec/sources/dd";
import { loadHisBodies, loadScreeningPolicy, parseAddress, parseAddressList, readPrincipalThread, restrictedPolicyHash } from "@/lib/exec/sources/mail";
import { runTriageModel } from "@/lib/exec/triage/email";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { publish } from "@/lib/inbox-event-bus";

const T0 = new Date("2026-11-04T17:00:30.000Z");
const MIN = 60_000;

const P: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acct_1"], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();
const SETTINGS: ExecSettings = { ...settingsFromRow(null, "ep_1"), emailEnabled: true, emailSchemaReady: true, retentionDaysEmail: 180 };

/** The thread as the clone has it when triage reads it: one inbound message, sent and ingested a minute before the event. */
function readThread(): PrincipalMailThread {
  const sent = T0.getTime() - MIN;
  const started = Date.now();
  return {
    threadId: "th_1",
    participants: ["ann@client.com", "mitchell@scaledai.org"],
    his: [
      {
        id: "m1",
        threadId: "th_1",
        accountId: "acct_1",
        direction: "inbound",
        folder: "INBOX",
        isJunk: false,
        rfcMessageId: "<m1@client.com>",
        inReplyTo: null,
        subject: "Renewal pricing",
        from: parseAddress("Ann Client <ann@client.com>"),
        to: parseAddressList(["Mitchell <mitchell@scaledai.org>"]),
        cc: [],
        sentAt: new Date(sent).toISOString(),
        createdAtMs: sent,
        isAutomated: false,
        attachments: [],
        bodyDeferred: false,
        bodyHtml: null,
        bodyText: "Can you approve the new renewal price by Friday?"
      }
    ],
    all: [
      {
        id: "m1",
        accountId: "acct_1",
        direction: "inbound",
        from: "Ann Client <ann@client.com>",
        to: ["Mitchell <mitchell@scaledai.org>"],
        cc: [],
        rfcMessageId: "<m1@client.com>",
        inReplyTo: null,
        createdAtMs: sent,
        sentAt: new Date(sent).toISOString()
      }
    ],
    snapshot: { identityCount: 1, maxCreatedAtMs: sent, maxSentAtMs: sent, readStartedAtMs: started, readDoneAtMs: started + 150 },
    lastMessageAt: new Date(sent).toISOString()
  };
}

let db: FakePipelineDb;
let synced: AttentionCandidate[][];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
  process.env.EXEC_ENABLED = "true";
  __resetExecRuntimeForTests();
  __resetJobsForTests();
  __resetSchedulerForTests();
  __resetMailHookForTests();
  db = createFakePipelineDb({
    email: { now: () => new Date(Date.now()) },
    pg: {
      tables: {
        exec_sync_state: [],
        exec_principals: [{ id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acct_1"], slack_team_id: null, slack_user_id: null }],
        exec_settings: [{ principal_id: "ep_1", email_enabled: true }]
      }
    }
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  for (const m of [loadSettings, loadPrincipalById, readPrincipalThread, loadHisBodies, loadScreeningPolicy, runTriageModel, loadClientMatcher, syncAttention]) {
    vi.mocked(m).mockReset();
  }
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(loadPrincipalById).mockResolvedValue(P);
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: restrictedPolicyHash("hidden", []) });
  vi.mocked(readPrincipalThread).mockImplementation(async () => ({ kind: "ok", thread: readThread() }));
  vi.mocked(loadHisBodies).mockResolvedValue(undefined);
  vi.mocked(loadClientMatcher).mockResolvedValue(buildClientMatcher([], { addresses: ["mitchell@scaledai.org"], domains: ["scaledai.org"] }));
  vi.mocked(runTriageModel).mockResolvedValue({
    kind: "ok",
    result: {
      summary: "Ann asks him to approve the new renewal price by Friday.",
      reason: "A client needs his decision",
      category: "client",
      urgency: "high",
      importance: "high",
      needsReply: true,
      mitchellPersonally: true,
      awaitingReplyFromOthers: false,
      decisionQuestion: "Approve the new renewal price?",
      decisionMessageId: "m1",
      clientSignal: "none",
      automated: false,
      injectionSuspected: false,
      commitments: []
    },
    dropped: [],
    call: { model: EXEC_MODELS.triage, requestId: "req_1", costUsd: 0.0007, latencyMs: 800 }
  });
  vi.mocked(listClients).mockResolvedValue([]);
  vi.mocked(latestScoredInboundByClient).mockResolvedValue(new Map());
  vi.mocked(listSatisfactionSignals).mockResolvedValue([]);
  vi.mocked(listAllEmailAttentionRows).mockResolvedValue([]);
  vi.mocked(deleteEmailAttentionForThreads).mockResolvedValue(0);
  vi.mocked(deleteAttentionItemsByIds).mockResolvedValue(0);
  synced = [];
  vi.mocked(syncAttention).mockImplementation(async (_p, scope, candidates) => {
    if (scope.source === "email") synced.push([...candidates]);
    return { inserted: candidates.length, updated: 0, reopened: 0, resolved: 0, unchanged: 0 };
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  // Every enqueue site on the path sets the attempts budget (L6): triage 10, attention 3.
  for (const j of db.jobs) expect(j.max_attempts).toBe(j.kind === EMAIL_TRIAGE_JOB_KIND ? 10 : 3);
  __resetMailHookForTests();
  __resetExecRuntimeForTests();
  __resetJobsForTests();
  __resetSchedulerForTests();
  vi.useRealTimers();
  delete process.env.EXEC_ENABLED;
});

const pass = () => runWorkerPass({ lane: "interactive", awaitCompletion: true });
const settle = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

describe("the event path, end to end", () => {
  it("event → +8 s → triage → kick → item", async () => {
    // The worker tick installs the hook (and registers every handler).
    await runExecWorkerTick();
    publish({ event: "message:new", account_id: "acct_1", thread_id: "th_1", message_id: "m1", ts: Date.now() });
    await settle();

    const triage = db.job(mailEventKey("ep_1", "m1"));
    expect(triage).toMatchObject({ kind: EMAIL_TRIAGE_JOB_KIND, lane: "interactive", status: "queued", run_after: new Date(T0.getTime() + 8_000).toISOString() });

    // Not due for 8 s.
    await vi.advanceTimersByTimeAsync(7_000);
    expect((await pass()).claimed).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pass()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(triage).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(runTriageModel).toHaveBeenCalledTimes(1);

    const row = db.email.tables.exec_email_threads?.find((r) => r.thread_id === "th_1");
    expect(row).toMatchObject({ state: "triaged", newest_inbound_message_id: "m1", answered_state: "awaiting_reply", decision_question: "Approve the new renewal price?" });

    // The kick: the next minute boundary + 2 s, on the triage job's lane.
    const kicks = db.jobsOf(EMAIL_ATTENTION_JOB_KIND);
    expect(kicks).toHaveLength(1);
    const due = Date.UTC(2026, 10, 4, 17, 1, 2);
    expect(kicks[0]).toMatchObject({ lane: "interactive", max_attempts: 3, run_after: new Date(due).toISOString(), dedupe_key: `email-attn:ep_1:m${Math.floor(due / MIN)}` });

    // Not before it's due; then the attention pass produces the thread's item.
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1_000);
    expect((await pass()).claimed).toBe(0);
    expect(synced).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pass()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(kicks[0]).toMatchObject({ status: "succeeded" });

    expect(synced).toHaveLength(1);
    const items = synced[0];
    expect(items).toHaveLength(1);
    expect(items[0].fingerprint).toBe("email:thread:th_1:m1");
    expect(["decision_ask", "important_email"]).toContain(items[0].kind);
    expect(Date.now()).toBe(due);
  });

  it("the same event delivered twice (socket and webhook) makes one job", async () => {
    ensureExecRuntime();
    await runExecWorkerTick();
    publish({ event: "message:new", account_id: "acct_1", thread_id: "th_1", message_id: "m1", ts: Date.now() });
    publish({ event: "message:new", account_id: "acct_1", thread_id: "th_1", message_id: "m1", ts: Date.now() });
    await settle();
    expect(db.jobsOf(EMAIL_TRIAGE_JOB_KIND)).toHaveLength(1);
  });
});
