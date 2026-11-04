import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// exec.email-reconcile (contract §3.11, L10, L20, L23 as amended by A3/A7 and
// the round-4 findings). The clone's feed and thread list are scripted; the
// store, the sync-state cursors and the job queue are the real modules over
// an in-memory database.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
const fakeE = vi.hoisted(() => ({ deleteEmailAttentionForThreads: vi.fn() }));
vi.mock("@/lib/exec/attention", () => fakeE);
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadSettings: vi.fn(), loadPrincipalById: vi.fn() };
});
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return {
    ...actual,
    checkPinnedAccounts: vi.fn(),
    listPrincipalMessagesFeed: vi.fn(),
    listPrincipalThreadsSince: vi.fn(),
    loadScreeningPolicy: vi.fn(),
    // The full-cycle tests run the real triage handler on what reconcile queued.
    readPrincipalThread: vi.fn(),
    loadHisBodies: vi.fn()
  };
});
vi.mock("@/lib/exec/triage/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/triage/email")>();
  return { ...actual, runTriageModel: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";
import { createFakePipelineDb, type FakePipelineDb, type Row } from "@/lib/exec/__tests__/fake-pipeline-db";
import { planThreadWrite, type ThreadProposal } from "@/lib/exec/email-state";
import { applyThreadProposal, listSignalsForMessages } from "@/lib/exec/email-store";
import type { HisMessage, MessageMeta, PrincipalMailThread } from "@/lib/exec/email-types";
import {
  COVER_MARGIN_MS,
  DEEP_WINDOW_MS,
  LIST_OVERLAP_MS,
  MAX_INTERACTIVE_PER_RUN,
  changedRowWanted,
  createdGroupDecision,
  emailReconcileJobHandler,
  finishListWindow,
  folderMoveKey,
  folderMoveWanted,
  signalOf,
  startListWindow
} from "@/lib/exec/handlers/email-reconcile";
import { createEmailTriageHandler } from "@/lib/exec/handlers/email-triage";
import { EMAIL_ATTENTION_JOB_KIND, EMAIL_RECONCILE_JOB_KIND, EMAIL_TRIAGE_JOB_KIND, __resetJobsForTests, mailBacklogKey, reconKey, retriageKey, triageJob } from "@/lib/exec/jobs";
import { EXEC_MODELS } from "@/lib/exec/llm/models";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import {
  checkPinnedAccounts,
  listPrincipalMessagesFeed,
  listPrincipalThreadsSince,
  loadHisBodies,
  loadScreeningPolicy,
  overlayAnswered,
  parseAddress,
  parseAddressList,
  readPrincipalThread,
  restrictedPolicyHash,
  screenHashesFor,
  type FeedPage,
  type FeedRow
} from "@/lib/exec/sources/mail";
import { initialReconState, parseReconState, type ReconState } from "@/lib/exec/sync-state";
import { localDateString } from "@/lib/exec/time";
import { TRIAGE_VERSION, runTriageModel } from "@/lib/exec/triage/email";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-04T17:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => NOW.getTime() - ms;

function mint(id = "ep_1", accounts = ["acct_1"]): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();
const SETTINGS: ExecSettings = { ...settingsFromRow(null, "ep_1"), emailEnabled: true, emailSchemaReady: true, retentionDaysEmail: 180 };

const rule = (id: string, pattern: string): RestrictedSenderRule => ({ id, pattern, matchKind: "domain", label: id, viewerUserIds: new Set() });
const RULES = [rule("rs_1", "restricted.com")];
const policy = (rules: RestrictedSenderRule[]) => ({ rules, hash: restrictedPolicyHash("hidden", rules) });

function feedRow(messageId: string, threadId: string, over: Partial<FeedRow> = {}): FeedRow {
  const created = over.createdAtMs ?? ago(30 * MIN);
  return {
    messageId,
    threadId,
    accountId: "acct_1",
    direction: "inbound",
    folder: "INBOX",
    isJunk: false,
    rfcMessageId: `<${messageId}@x>`,
    inReplyTo: null,
    sentAtMs: created,
    createdAtMs: created,
    signalsAtMs: created,
    flagStatus: null,
    isRead: null,
    importance: null,
    webLink: null,
    removedAtMs: null,
    from: "Ann <ann@client.com>",
    to: ["mitchell@scaledai.org"],
    cc: [],
    ...over
  };
}

/** A scripted CL1 feed: keyset by (position, id), served up to the 120 s settle horizon. */
class FakeFeed {
  rows: FeedRow[] = [];
  supported = true;
  calls: { order: string; cursor: string | null; sinceIso: string | null; accountId: string }[] = [];
  page(accountId: string, opts: { order: "created" | "changed"; cursor: string | null; sinceIso: string | null; limit: number }): FeedPage {
    this.calls.push({ order: opts.order, cursor: opts.cursor, sinceIso: opts.sinceIso, accountId });
    if (!this.supported) return { supported: false };
    const pos = (r: FeedRow) => (opts.order === "created" ? r.createdAtMs : r.signalsAtMs);
    const horizon = Date.now() - 120_000;
    let after = { ms: opts.sinceIso ? Date.parse(opts.sinceIso) : 0, id: "" };
    if (opts.cursor) {
      const [ms, id] = opts.cursor.slice(2).split("|");
      after = { ms: Number(ms), id };
    }
    const eligible = this.rows
      .filter((r) => r.accountId === accountId && pos(r) <= horizon && (pos(r) > after.ms || (pos(r) === after.ms && r.messageId > after.id)))
      .sort((a, b) => pos(a) - pos(b) || (a.messageId < b.messageId ? -1 : 1));
    const rows = eligible.slice(0, opts.limit);
    const last = rows[rows.length - 1];
    const tag = opts.order === "created" ? "c" : "u";
    return {
      supported: true,
      rows: rows.map((r) => structuredClone(r)),
      nextCursor: last ? `${tag}:${pos(last)}|${last.messageId}` : (opts.cursor ?? `${tag}:${after.ms}|${after.id}`),
      hasMore: eligible.length > opts.limit,
      settledThrough: iso(horizon),
      settledThroughMs: horizon
    };
  }
}

/** A scripted thread list: last_message_at desc, `after:` strict, offset/limit, hasMore = a full page. */
class FakeList {
  threads: { threadId: string; lastMessageAt: string; snoozed?: boolean; accountId?: string }[] = [];
  calls: { afterIso: string; offset: number; limit: number; snoozed: boolean }[] = [];
  page(accountId: string, opts: { afterIso: string; limit: number; offset: number; snoozed?: boolean }) {
    this.calls.push({ afterIso: opts.afterIso, offset: opts.offset, limit: opts.limit, snoozed: opts.snoozed === true });
    const rows = this.threads
      .filter((t) => (t.accountId ?? "acct_1") === accountId && (t.snoozed === true) === (opts.snoozed === true) && Date.parse(t.lastMessageAt) > Date.parse(opts.afterIso))
      .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
      .slice(opts.offset, opts.offset + opts.limit);
    return { threads: rows.map((t) => ({ threadId: t.threadId, lastMessageAt: t.lastMessageAt })), hasMore: rows.length === opts.limit, limitEchoed: opts.limit };
  }
}

let db: FakePipelineDb;
let feed: FakeFeed;
let list: FakeList;

function useDb(email: Record<string, Row[]> = {}, syncState: Row[] = []): FakePipelineDb {
  db = createFakePipelineDb({ email: { tables: email, now: () => new Date(Date.now()) }, pg: { tables: { exec_sync_state: syncState } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

function ctx(principal: ExecPrincipal = P): JobContext {
  return { job: jobRow({ kind: EMAIL_RECONCILE_JOB_KIND, lane: "bulk", principal_id: principal.id, max_attempts: 3 }), principal, signal: new AbortController().signal, workerId: "w" };
}

function account(id = "acct_1", lastSyncedAt: string | null = iso(ago(2 * MIN))) {
  return { id, email: "mitchell@scaledai.org", lastSyncedAt, lastSyncError: null, lastSyncErrorAt: null };
}

const recon = (accountId = "acct_1", principalId = "ep_1"): ReconState | null => {
  const r = db.pg.tables.exec_sync_state.find((s) => s.principal_id === principalId && s.source === "mail" && s.key === `recon:${accountId}`);
  return r ? parseReconState(r.cursor) : null;
};
const reconRow = (state: ReconState, accountId = "acct_1", rev = 1): Row => ({
  principal_id: "ep_1",
  source: "mail",
  key: `recon:${accountId}`,
  cursor: { ...state, rev },
  updated_at: NOW.toISOString()
});
const triageJobs = () => db.jobsOf(EMAIL_TRIAGE_JOB_KIND);
const signals = () => db.email.tables.exec_email_signals ?? [];

const snakeRow = (patch: Record<string, unknown>): Row =>
  Object.fromEntries(Object.entries(patch).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));

/** A stored thread row as the state machine writes it, with the read behind it starting at `readStartedAt`. */
function storedRow(threadId: string, readStartedAt: number, over: Record<string, unknown> = {}): Row {
  const plan = planThreadWrite(null, cleanTriage(threadId, readStartedAt), { rules: [], currentPolicyHash: policy([]).hash, now: new Date(readStartedAt), retentionDays: 180 });
  if (plan.action !== "write") throw new Error("fixture row did not plan");
  return { principal_id: "ep_1", thread_id: threadId, version: 1, updated_at: iso(readStartedAt), ...snakeRow(plan.patch), ...over };
}

/** A clean triage of Ann's one message on `threadId`, read at `readStartedAt`, screened under `policyHash`. */
function cleanTriage(threadId: string, readStartedAt: number, policyHash = policy([]).hash): ThreadProposal {
  return {
    kind: "triage",
    snapshot: { identityCount: 1, maxCreatedAtMs: readStartedAt - 10 * MIN, maxSentAtMs: readStartedAt - 10 * MIN, readStartedAtMs: readStartedAt, readDoneAtMs: readStartedAt + 200 },
    screen: { verdict: "clean", hashes: screenHashesFor({ all: [{ from: "ann@client.com", to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes, truncated: false },
    policyHash,
    facts: {
      accountId: "acct_1",
      subject: "Renewal",
      counterpartName: "Ann",
      counterpartEmail: "ann@client.com",
      correspondents: ["ann@client.com"],
      messageCount: 1,
      newestMessageId: `${threadId}-m1`,
      newestInboundMessageId: `${threadId}-m1`,
      newestOutboundMessageId: null,
      lastInboundAt: iso(readStartedAt - 10 * MIN),
      lastOutboundAt: null,
      newestIsOutbound: false,
      answeredState: "awaiting_reply",
      answeredAt: null,
      answeredMessageId: null,
      partialThread: false,
      outboundAutomatedOnly: false,
      clientId: null,
      clientName: null,
      clientMatchVia: null,
      matchConfidence: null,
      clientCandidates: 0
    },
    outcome: {
      kind: "triaged",
      watermarkMs: readStartedAt - 10 * MIN,
      ai: {
        summary: "s",
        reason: "r",
        category: "client",
        urgency: "normal",
        importance: "normal",
        needsReply: true,
        mitchellPersonally: true,
        awaitingReplyFromOthers: false,
        decisionQuestion: null,
        decisionMessageId: null,
        clientSignal: "none",
        automated: false,
        injectionSuspected: false
      },
      run: { contentHash: "c".repeat(64), model: "claude-haiku-5-5", triageVersion: TRIAGE_VERSION, inputTruncated: false, bodySource: "text" }
    },
    commitments: []
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.EXEC_ENABLED = "true";
  __resetJobsForTests();
  useDb();
  feed = new FakeFeed();
  list = new FakeList();
  // restoreMocks leaves a vi.fn()'s implementations (and any unused *Once) in place: reset them.
  for (const m of [loadSettings, loadScreeningPolicy, checkPinnedAccounts, listPrincipalMessagesFeed, listPrincipalThreadsSince, notifyOps, readPrincipalThread, loadHisBodies, runTriageModel]) {
    vi.mocked(m).mockReset();
  }
  vi.mocked(readPrincipalThread).mockRejectedValue(new Error("this test reads no thread"));
  vi.mocked(loadHisBodies).mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
  vi.mocked(checkPinnedAccounts).mockResolvedValue({ accounts: [account()], problems: [] });
  vi.mocked(listPrincipalMessagesFeed).mockImplementation(async (_p, accountId, opts) => feed.page(accountId, opts));
  vi.mocked(listPrincipalThreadsSince).mockImplementation(async (_p, accountId, opts) => list.page(accountId, opts));
  fakeE.deleteEmailAttentionForThreads.mockReset();
  fakeE.deleteEmailAttentionForThreads.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Every enqueue site sets the attempts budget (L6): triage 10, attention 3.
  // A site that forgot would get the column default, 6.
  for (const j of db.jobs) expect(j.max_attempts).toBe(j.kind === EMAIL_TRIAGE_JOB_KIND ? 10 : 3);
  vi.useRealTimers();
  delete process.env.EXEC_ENABLED;
});

const run = (principal: ExecPrincipal = P) => emailReconcileJobHandler.run(ctx(principal)) as Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Gates and accounts
// ---------------------------------------------------------------------------

describe("the job, its gates and the account check", () => {
  it("is a bulk job with a 240 s ceiling", () => {
    expect(emailReconcileJobHandler).toMatchObject({ kind: "exec.email-reconcile", lane: "bulk", timeoutMs: 240_000 });
  });

  it.each([
    ["not_installed", { emailSchemaReady: false, emailEnabled: false }],
    ["email_off", { emailEnabled: false }]
  ])("skips when %s, before touching the clone", async (why, over) => {
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, ...over });
    expect(await run()).toMatchObject({ skipped: why });
    expect(checkPinnedAccounts).not.toHaveBeenCalled();
  });

  it("skips with no pin, and refuses a job without a principal", async () => {
    expect(await run(mint("ep_1", []))).toMatchObject({ skipped: "no_pin" });
    await expect(emailReconcileJobHandler.run({ ...ctx(), principal: null })).rejects.toThrow(NonRetryableError);
  });

  it("checks the accounts fresh every run and records them in mail/accounts", async () => {
    await run();
    const stored = db.pg.tables.exec_sync_state.find((s) => s.key === "accounts");
    expect(stored?.cursor).toMatchObject({ accounts: [{ id: "acct_1", email: "mitchell@scaledai.org" }], problems: [] });
  });

  it("is exempt from the stored problem filter: a problem recorded earlier doesn't stop the check that clears it", async () => {
    useDb({}, [{ principal_id: "ep_1", source: "mail", key: "accounts", cursor: { rev: 3, checkedAt: iso(ago(HOUR)), accounts: [], problems: [{ accountId: "acct_1", reason: "not_found" }] }, updated_at: NOW.toISOString() }]);
    feed.rows = [feedRow("m1", "t1")];
    await run();
    expect(checkPinnedAccounts).toHaveBeenCalled();
    expect(feed.calls.some((c) => c.accountId === "acct_1")).toBe(true);
    expect(db.pg.tables.exec_sync_state.find((s) => s.key === "accounts")?.cursor).toMatchObject({ problems: [] });
  });

  it("a problem account raises an ops alert (ids and codes only) and is skipped this run", async () => {
    const two = mint("ep_1", ["acct_1", "acct_2"]);
    vi.mocked(checkPinnedAccounts).mockResolvedValue({ accounts: [account("acct_1"), account("acct_2")], problems: [{ accountId: "acct_2", reason: "email_mismatch" }] });
    feed.rows = [feedRow("m1", "t1"), feedRow("m2", "t2", { accountId: "acct_2" })];
    const r = await run(two);
    expect(r).toMatchObject({ problems: 1 });
    expect(notifyOps).toHaveBeenCalledWith({ key: "email-account-problem:ep_1:acct_2", title: "a pinned mailbox can't be used", detail: "principal ep_1, account acct_2: email_mismatch" });
    expect(feed.calls.every((c) => c.accountId === "acct_1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feed mode: the created pass
// ---------------------------------------------------------------------------

describe("feed mode, created pass", () => {
  it("first run: both passes start at the backfill start; the backfill marker and the cursor persist", async () => {
    feed.rows = [feedRow("m1", "t1", { createdAtMs: ago(3 * DAY) })];
    await run();
    const created = feed.calls.find((c) => c.order === "created");
    const changed = feed.calls.find((c) => c.order === "changed");
    expect(created).toMatchObject({ cursor: null, sinceIso: iso(ago(14 * DAY)) });
    expect(changed).toMatchObject({ cursor: null, sinceIso: iso(ago(14 * DAY)) });
    const st = recon();
    expect(st).toMatchObject({ mode: "feed", backfill: { from: iso(ago(14 * DAY)), startedAt: NOW.toISOString(), enqueuedAt: NOW.toISOString() } });
    expect(st?.created.cursor).toBe(`c:${ago(3 * DAY)}|m1`);
    // The next run resumes from the cursor, not from `since`.
    vi.setSystemTime(new Date(NOW.getTime() + 5 * MIN));
    await run();
    expect(feed.calls.filter((c) => c.order === "created").at(-1)).toMatchObject({ cursor: `c:${ago(3 * DAY)}|m1`, sinceIso: null });
  });

  it("enqueues one job per thread group, keyed on the group's newest row; backfill groups go bulk with reason backfill", async () => {
    feed.rows = [
      feedRow("m1", "t1", { createdAtMs: ago(2 * DAY) }),
      feedRow("m2", "t1", { createdAtMs: ago(2 * DAY - MIN) }),
      feedRow("m3", "t2", { createdAtMs: ago(DAY) })
    ];
    const r = await run();
    expect(r).toMatchObject({ enqueued: 2 });
    expect(db.job(reconKey("ep_1", "t1", "m2"))).toMatchObject({ lane: "bulk", max_attempts: 10, payload: { threadId: "t1", reason: "backfill", messageId: "m2", accountId: "acct_1" } });
    expect(db.job(reconKey("ep_1", "t2", "m3"))).toMatchObject({ lane: "bulk", payload: { reason: "backfill" } });
    // Staggered 20 s apart on the shared position.
    const [a, b] = triageJobs().map((j) => Date.parse(j.run_after as string));
    expect(b - a).toBe(20_000);
  });

  it("after the backfill, recent mail (sent ≤ 2 h ago) goes to the interactive lane; older mail to bulk", async () => {
    useDb({}, [reconRow({ ...initialReconState(), mode: "feed", backfill: { from: iso(ago(14 * DAY)), startedAt: iso(ago(DAY)), enqueuedAt: iso(ago(DAY)) } })]);
    feed.rows = [feedRow("m1", "t1", { createdAtMs: ago(10 * MIN) }), feedRow("m2", "t2", { createdAtMs: ago(10 * MIN), sentAtMs: ago(5 * HOUR) })];
    await run();
    expect(db.job(reconKey("ep_1", "t1", "m1"))).toMatchObject({ lane: "interactive", payload: { reason: "reconcile" } });
    expect(db.job(reconKey("ep_1", "t2", "m2"))).toMatchObject({ lane: "bulk", payload: { reason: "reconcile" } });
  });

  it("sends at most 200 interactive jobs per run; further recent mail goes the capped bulk way", async () => {
    useDb({}, [reconRow({ ...initialReconState(), mode: "feed", backfill: { from: iso(ago(14 * DAY)), startedAt: iso(ago(DAY)), enqueuedAt: iso(ago(DAY)) } })]);
    feed.rows = Array.from({ length: 205 }, (_, i) => feedRow(`m${String(i).padStart(3, "0")}`, `t${String(i).padStart(3, "0")}`, { createdAtMs: ago(30 * MIN) + i }));
    await run();
    expect(triageJobs().filter((j) => j.lane === "interactive")).toHaveLength(MAX_INTERACTIVE_PER_RUN);
    expect(triageJobs().filter((j) => j.lane === "bulk")).toHaveLength(5);
  });

  it("skips a group the stored read already covered (read started ≥ newest ingest + 120 s), in any state", async () => {
    const ingest = ago(HOUR);
    useDb({
      exec_email_threads: [
        storedRow("t1", ingest + COVER_MARGIN_MS),
        storedRow("t2", ingest + COVER_MARGIN_MS - 1),
        storedRow("t3", ingest + COVER_MARGIN_MS, { state: "filtered", filter_reason: "unreplyable", summary: null, reason: null, category: null, urgency: null, importance: null, needs_reply: null, mitchell_personally: null, awaiting_reply_from_others: null, client_signal: null, automated: null, triage_version: null, model: null, content_hash: null, input_watermark: null })
      ]
    });
    feed.rows = [feedRow("a", "t1", { createdAtMs: ingest }), feedRow("b", "t2", { createdAtMs: ingest }), feedRow("c", "t3", { createdAtMs: ingest })];
    await run();
    expect(triageJobs().map((j) => (j.payload as Row).threadId)).toEqual(["t2"]);
  });

  it("skips groups with no row that are all junk or older than the window, without counting them against the cap", async () => {
    for (let i = 0; i < 11; i += 1) db.jobs.push({ id: 900 + i, kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", payload: { threadId: `q${i}`, reason: "backfill" }, dedupe_key: `q${i}`, status: "queued", max_attempts: 10, run_after: NOW.toISOString() });
    feed.rows = [
      feedRow("j1", "junk", { isJunk: true, folder: "Junk Email", createdAtMs: ago(2 * DAY) }),
      feedRow("o1", "old", { sentAtMs: ago(20 * DAY), createdAtMs: ago(2 * DAY) }),
      feedRow("n1", "new", { createdAtMs: ago(2 * DAY) })
    ];
    const r = await run();
    expect(r).toMatchObject({ enqueued: 1, blocked: 0 });
    expect(triageJobs().filter((j) => (j.id as number) < 900).map((j) => (j.payload as Row).threadId)).toEqual(["new"]);
  });

  it("doesn't move the cursor past a page whose bulk work the cap turned away; the next run picks up the rest without duplicates", async () => {
    feed.rows = Array.from({ length: 15 }, (_, i) => feedRow(`m${String(i).padStart(2, "0")}`, `t${String(i).padStart(2, "0")}`, { createdAtMs: ago(2 * DAY) + i }));
    const first = await run();
    expect(first).toMatchObject({ enqueued: 12, blocked: 3 });
    expect(recon()?.created.cursor).toBeNull();
    expect(recon()?.backfill?.enqueuedAt).toBeNull();
    // The queue drains; the next run re-reads the page and enqueues only what's left.
    db.jobs.forEach((j) => (j.status = "succeeded"));
    vi.setSystemTime(new Date(NOW.getTime() + 5 * MIN));
    const second = await run();
    expect(second).toMatchObject({ enqueued: 3, blocked: 0 });
    expect(triageJobs()).toHaveLength(15);
    expect(recon()?.created.cursor).toBe(`c:${ago(2 * DAY) + 14}|m14`);
    expect(recon()?.backfill?.enqueuedAt).not.toBeNull();
  });

  it("stores a row's signals in the created pass only once its stamp is settled (amendments-5)", async () => {
    const created = ago(10 * MIN);
    feed.rows = [feedRow("m1", "t1", { createdAtMs: created, signalsAtMs: NOW.getTime() - 30_000, flagStatus: "flagged" })];
    vi.mocked(listPrincipalMessagesFeed).mockImplementation(async (_p, accountId, opts) =>
      opts.order === "created" ? feed.page(accountId, opts) : { supported: true, rows: [], nextCursor: "u:0|", hasMore: false, settledThrough: iso(ago(120_000)), settledThroughMs: ago(120_000) }
    );
    await run();
    expect(signals()).toHaveLength(0);
    // An earlier-stamped statement commits last with the final state; the changed pass delivers it once settled.
    feed.rows = [feedRow("m1", "t1", { createdAtMs: created, signalsAtMs: NOW.getTime() - 60_000, flagStatus: "notflagged" })];
    vi.setSystemTime(new Date(NOW.getTime() + 5 * MIN));
    vi.mocked(listPrincipalMessagesFeed).mockImplementation(async (_p, accountId, opts) => feed.page(accountId, opts));
    await run();
    expect(signals()).toEqual([expect.objectContaining({ message_id: "m1", flagged: false, signals_at: iso(NOW.getTime() - 60_000) })]);
  });
});

// ---------------------------------------------------------------------------
// Feed mode: signals, the changed pass, flags, restricted rows
// ---------------------------------------------------------------------------

describe("signals", () => {
  it("maps CL1's columns: flag_status, is_read, a NULL signals stamp, removal, the web link", () => {
    const base = feedRow("m1", "t1", { createdAtMs: 1_700_000_000_000 });
    expect(signalOf({ ...base, flagStatus: "flagged", isRead: false, removedAtMs: 1_700_000_100_000, webLink: "https://outlook.office.com/x", importance: "high" })).toEqual({
      messageId: "m1",
      threadId: "t1",
      accountId: "acct_1",
      direction: "inbound",
      flagged: true,
      importance: "high",
      unread: true,
      removedAt: iso(1_700_000_100_000),
      webLink: "https://outlook.office.com/x",
      signalsAt: iso(1_700_000_000_000)
    });
    expect(signalOf({ ...base, flagStatus: "complete" }).flagged).toBe(false);
    expect(signalOf({ ...base, flagStatus: "notflagged" }).flagged).toBe(false);
    expect(signalOf({ ...base, flagStatus: null, isRead: null })).toMatchObject({ flagged: null, unread: null });
  });

  it("the changed pass upserts every row of his, with no thread row needed, the newest stamp of a repeated id winning", async () => {
    feed.rows = [
      feedRow("m1", "t1", { createdAtMs: ago(HOUR), signalsAtMs: ago(10 * MIN), removedAtMs: ago(10 * MIN), flagStatus: "complete" }),
      // A message whose signals were never stamped (DD's own sends): its stamp is its ingest time.
      feedRow("m2", "t2", { createdAtMs: ago(2 * HOUR), signalsAtMs: ago(2 * HOUR), isRead: true })
    ];
    // The same message twice in one changed page (two stamps): the newer one stands.
    const changedPage = (accountId: string, opts: Parameters<FakeFeed["page"]>[1]): FeedPage => {
      const page = feed.page(accountId, opts);
      if (!page.supported || opts.order !== "changed") return page;
      const older = { ...page.rows.find((r) => r.messageId === "m1")!, signalsAtMs: ago(20 * MIN), removedAtMs: null };
      return { ...page, rows: [older, ...page.rows] };
    };
    vi.mocked(listPrincipalMessagesFeed).mockImplementation(async (_p, accountId, opts) => changedPage(accountId, opts));
    const r = await run();
    expect(r.signalsWritten).toBeGreaterThan(0);
    expect(signals()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message_id: "m1", thread_id: "t1", removed_at: iso(ago(10 * MIN)), flagged: false, signals_at: iso(ago(10 * MIN)) }),
        expect.objectContaining({ message_id: "m2", signals_at: iso(ago(2 * HOUR)), unread: false, flagged: null })
      ])
    );
    expect(signals()).toHaveLength(2);
    expect(db.email.tables.exec_email_threads ?? []).toHaveLength(0);
    // A page writing signals kicks the attention pass on the bulk lane.
    expect(db.jobsOf(EMAIL_ATTENTION_JOB_KIND)[0]).toMatchObject({ lane: "bulk" });
  });

  it("a signal stored before its thread's triage takes effect once the triage writes (A3: order-independent)", async () => {
    feed.rows = [feedRow("m1", "t1", { createdAtMs: ago(HOUR), signalsAtMs: ago(10 * MIN), removedAtMs: ago(10 * MIN), webLink: "https://outlook.office.com/m1" })];
    await run();
    // Triage writes the thread row later; the reader joins the signal by message id.
    const stored = await listSignalsForMessages(P, ["m1"]);
    const row = { answeredState: "awaiting_reply" as const, newestInboundMessageId: "m1" };
    expect(overlayAnswered(row, stored.get("m1"))).toBe("handled_in_outlook");
    expect(stored.get("m1")?.webLink).toBe("https://outlook.office.com/m1");
  });

  it("the changed pass enqueues a rescued message (changed well after ingest) whose thread has no row, once the backfill is done", async () => {
    // has_row's stored read already saw "other" (its last inbound is newer), so no folder-move re-triage either.
    useDb({ exec_email_threads: [storedRow("has_row", ago(2 * HOUR))] }, [
      reconRow({ ...initialReconState(), mode: "feed", backfill: { from: iso(ago(14 * DAY)), startedAt: iso(ago(DAY)), enqueuedAt: iso(ago(DAY)) }, created: { cursor: `c:${NOW.getTime()}|zzz`, since: null } })
    ]);
    feed.rows = [
      feedRow("rescued", "t1", { createdAtMs: ago(3 * HOUR), signalsAtMs: ago(10 * MIN), folder: "INBOX" }),
      feedRow("fresh", "t2", { createdAtMs: ago(10 * MIN), signalsAtMs: ago(10 * MIN) }),
      feedRow("other", "has_row", { createdAtMs: ago(3 * HOUR), signalsAtMs: ago(10 * MIN) }),
      feedRow("out", "t3", { direction: "outbound", createdAtMs: ago(3 * HOUR), signalsAtMs: ago(10 * MIN) }),
      feedRow("gone", "t4", { createdAtMs: ago(3 * HOUR), signalsAtMs: ago(10 * MIN), removedAtMs: ago(10 * MIN) }),
      feedRow("old", "t5", { sentAtMs: ago(20 * DAY), createdAtMs: ago(3 * HOUR), signalsAtMs: ago(10 * MIN) })
    ];
    await run();
    expect(triageJobs().map((j) => j.dedupe_key)).toEqual([reconKey("ep_1", "t1", "rescued")]);
    expect(db.job(reconKey("ep_1", "t1", "rescued"))).toMatchObject({ lane: "bulk", payload: { reason: "reconcile", messageId: "rescued" } });
  });

  it("a flag on the anchor of a filtered thread re-triages it (bulk, staggered); other flags don't", async () => {
    useDb(
      {
        exec_email_threads: [
          storedRow("tf", ago(DAY), { state: "filtered", filter_reason: "automated_hint" }),
          storedRow("tt", ago(DAY))
        ]
      },
      [reconRow({ ...initialReconState(), mode: "feed", backfill: { from: iso(ago(14 * DAY)), startedAt: iso(ago(2 * DAY)), enqueuedAt: iso(ago(2 * DAY)) }, created: { cursor: `c:${NOW.getTime()}|zzz`, since: null } })]
    );
    feed.rows = [
      feedRow("tf-m1", "tf", { createdAtMs: ago(DAY + HOUR), signalsAtMs: ago(10 * MIN), flagStatus: "flagged" }),
      feedRow("tf-m0", "tf", { createdAtMs: ago(DAY + 2 * HOUR), signalsAtMs: ago(11 * MIN), flagStatus: "flagged" }),
      feedRow("tt-m1", "tt", { createdAtMs: ago(DAY + HOUR), signalsAtMs: ago(10 * MIN), flagStatus: "flagged" })
    ];
    await run();
    expect(triageJobs().map((j) => j.dedupe_key)).toEqual([retriageKey("ep_1", "tf", "flag", "tf-m1")]);
    expect(triageJobs()[0]).toMatchObject({ lane: "bulk", max_attempts: 10, payload: { reason: "flag", messageId: "tf-m1" } });
  });

  it("a feed row from a ruled address tombstones the thread's content row at once, keeps its signals out and re-triages interactively", async () => {
    useDb({ exec_email_threads: [storedRow("t1", ago(DAY))] });
    // A backlog job for the message sits on the bulk lane, far in the future.
    db.jobs.push({ id: 700, kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", payload: { threadId: "t1", reason: "event", messageId: "m2" }, dedupe_key: mailBacklogKey("ep_1", "m2"), status: "queued", max_attempts: 10, run_after: iso(NOW.getTime() + 2 * HOUR) });
    feed.rows = [feedRow("m2", "t1", { createdAtMs: ago(10 * MIN), cc: ["X <x@restricted.com>"], webLink: "https://outlook.office.com/m2" })];
    const r = await run();
    expect(r).toMatchObject({ tombstoned: 1 });
    expect(db.email.tables.exec_email_threads?.[0]).toMatchObject({ state: "restricted_hidden", subject: null, summary: null });
    expect(signals()).toHaveLength(0);
    expect(db.job(reconKey("ep_1", "t1", "m2"))).toMatchObject({ lane: "interactive", payload: { reason: "reconcile", messageId: "m2" } });
    expect(db.job(mailBacklogKey("ep_1", "m2"))).toMatchObject({ status: "queued" });
    expect(fakeE.deleteEmailAttentionForThreads).toHaveBeenCalledWith(P, ["t1"], expect.anything());
  });

  it("a ruled row on a thread with no row isn't stored and is re-triaged interactively (triage records the tombstone)", async () => {
    feed.rows = [feedRow("m1", "t9", { from: "Boss <boss@restricted.com>" })];
    await run();
    expect(signals()).toHaveLength(0);
    expect(db.email.tables.exec_email_threads ?? []).toHaveLength(0);
    expect(db.job(reconKey("ep_1", "t9", "m1"))).toMatchObject({ lane: "interactive" });
  });

  it("a store refusal for one row is logged and the run goes on", async () => {
    const failing = createFakePipelineDb({
      email: {
        tables: { exec_email_threads: [storedRow("t1", ago(DAY))] },
        now: () => new Date(Date.now()),
        fail: (q) => (q.kind === "update" && q.target === "exec_email_threads" ? { message: "new row violates check constraint", code: "23514" } : null)
      },
      pg: { tables: { exec_sync_state: [] } }
    });
    db = failing;
    vi.mocked(getSupabaseAdmin).mockReturnValue(failing.client as SupabaseClient);
    feed.rows = [feedRow("m2", "t1", { cc: ["X <x@restricted.com>"] }), feedRow("m3", "t2", { createdAtMs: ago(2 * DAY) })];
    const r = await run();
    // Both passes see the ruled row, and each tombstone attempt is refused.
    expect(r).toMatchObject({ refusals: 2 });
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/tombstone refused for thread t1; continuing/));
    expect(failing.job(reconKey("ep_1", "t2", "m3"))).toBeDefined();
    expect(failing.job(reconKey("ep_1", "t1", "m2"))).toBeDefined();
  });

  it("an infrastructure error still fails the run (the runner retries it)", async () => {
    vi.mocked(listPrincipalMessagesFeed).mockRejectedValue(Object.assign(new Error("clone messages feed answered HTTP 503"), { status: 503 }));
    await expect(run()).rejects.toThrow(/503/);
  });
});

// ---------------------------------------------------------------------------
// List mode (pre-CL1)
// ---------------------------------------------------------------------------

describe("list mode", () => {
  beforeEach(() => {
    feed.supported = false;
  });

  it("an unsupported feed switches the mailbox to list mode; the first window starts at the backfill start", async () => {
    list.threads = [{ threadId: "t1", lastMessageAt: iso(ago(3 * DAY)) }];
    await run();
    const st = recon();
    expect(st?.mode).toBe("list");
    expect(list.calls[0]).toEqual({ afterIso: iso(ago(14 * DAY)), offset: 0, limit: 100, snoozed: false });
    expect(list.calls[1]).toMatchObject({ snoozed: true, offset: 0 });
    expect(db.job(reconKey("ep_1", "t1", ago(3 * DAY)))).toMatchObject({ lane: "bulk", payload: { reason: "backfill" } });
    // The window completed: hwm = min(windowTo, the clone's last sync at its start).
    expect(st?.list).toMatchObject({ hwm: iso(ago(2 * MIN)), windowFrom: null, offset: 0, pass: "normal" });
    expect(st?.backfill?.enqueuedAt).toBe(NOW.toISOString());
  });

  it("window math: from min(hwm, last sync) - 20 min; once a day 48 h; and it stores the clone's sync time at its start", () => {
    const base = { ...initialReconState(), backfill: { from: iso(ago(14 * DAY)), startedAt: iso(ago(5 * DAY)), enqueuedAt: iso(ago(5 * DAY)) } };
    const hwm = ago(10 * MIN);
    const normal = startListWindow({ ...base, list: { ...base.list, hwm: iso(hwm), lastDeepAt: iso(ago(HOUR)) } }, { lastSyncedAt: iso(ago(30 * MIN)) }, NOW.getTime());
    expect(normal).toMatchObject({ windowFrom: iso(ago(30 * MIN) - LIST_OVERLAP_MS), windowTo: NOW.toISOString(), lastSyncedAtAtStart: iso(ago(30 * MIN)), offset: 0, pass: "normal" });
    const synced = startListWindow({ ...base, list: { ...base.list, hwm: iso(hwm), lastDeepAt: iso(ago(HOUR)) } }, { lastSyncedAt: iso(ago(MIN)) }, NOW.getTime());
    expect(synced.windowFrom).toBe(iso(hwm - LIST_OVERLAP_MS));
    const deep = startListWindow({ ...base, list: { ...base.list, hwm: iso(hwm), lastDeepAt: iso(ago(25 * HOUR)) } }, { lastSyncedAt: iso(ago(MIN)) }, NOW.getTime());
    expect(deep).toMatchObject({ windowFrom: iso(hwm - DEEP_WINDOW_MS), lastDeepAt: NOW.toISOString() });
    expect(finishListWindow({ ...normal })).toMatchObject({ hwm: iso(ago(30 * MIN)), windowFrom: null, windowTo: null, lastSyncedAtAtStart: null });
    expect(finishListWindow({ ...normal, lastSyncedAtAtStart: null }).hwm).toBe(NOW.toISOString());
  });

  it("a thread that gains mail mid-window is caught by the next window", async () => {
    vi.mocked(checkPinnedAccounts).mockResolvedValue({ accounts: [account("acct_1", iso(ago(MIN)))], problems: [] });
    list.threads = [{ threadId: "t1", lastMessageAt: iso(ago(3 * DAY)) }];
    await run();
    const hwm = Date.parse(recon()?.list.hwm as string);
    // Mail lands just before the window's end but is ingested after the clone's sync at its start.
    list.threads = [{ threadId: "t1", lastMessageAt: iso(hwm - 30_000) }];
    vi.setSystemTime(new Date(NOW.getTime() + 5 * MIN));
    vi.mocked(checkPinnedAccounts).mockResolvedValue({ accounts: [account("acct_1", iso(NOW.getTime() + 4 * MIN))], problems: [] });
    await run();
    expect(db.job(reconKey("ep_1", "t1", hwm - 30_000))).toBeDefined();
  });

  it("pages with a one-row overlap and resumes a capped run from its offset", async () => {
    list.threads = Array.from({ length: 150 }, (_, i) => ({ threadId: `t${String(i).padStart(3, "0")}`, lastMessageAt: iso(ago(2 * DAY) - i * MIN) }));
    const first = await run();
    expect(first).toMatchObject({ enqueued: 12 });
    expect(recon()?.list).toMatchObject({ offset: 0, pass: "normal" });
    db.jobs.forEach((j) => (j.status = "succeeded"));
    // Room for every job: pages advance with the overlap.
    vi.mocked(checkPinnedAccounts).mockResolvedValue({ accounts: [account()], problems: [] });
    for (let i = 0; i < 40 && recon()?.list.windowFrom !== null; i += 1) {
      vi.setSystemTime(new Date(Date.now() + 5 * MIN));
      db.jobs.forEach((j) => (j.status = "succeeded"));
      await run();
    }
    const offsets = list.calls.filter((c) => !c.snoozed).map((c) => c.offset);
    expect(offsets).toContain(99);
    expect(new Set(triageJobs().map((j) => (j.payload as Row).threadId)).size).toBe(150);
  });

  it("skips a thread whose stored read already saw a message this new; a late-committed DD send is not skipped", async () => {
    const readAt = ago(HOUR);
    useDb({ exec_email_threads: [storedRow("seen", readAt), storedRow("late", readAt)] });
    const maxSent = Date.parse(storedRow("seen", readAt).snapshot_max_sent_at as string);
    // "late": a DD reply stamped before the stored read started but committed after it.
    list.threads = [{ threadId: "seen", lastMessageAt: iso(maxSent) }, { threadId: "late", lastMessageAt: iso(maxSent + 30_000) }];
    await run();
    expect(triageJobs().map((j) => (j.payload as Row).threadId)).toEqual(["late"]);
  });
});

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

describe("sweeps", () => {
  const deferredRow = (threadId: string, deferredAt: number) =>
    storedRow(threadId, ago(3 * DAY), {
      state: "deferred_budget",
      deferred_at: iso(deferredAt),
      last_attempt_at: iso(deferredAt),
      last_attempt_error: "budget",
      summary: null,
      reason: null,
      category: null,
      urgency: null,
      importance: null,
      needs_reply: null,
      mitchell_personally: null,
      awaiting_reply_from_others: null,
      client_signal: null,
      automated: null,
      triage_version: null,
      model: null,
      content_hash: null,
      input_watermark: null
    });

  it("budget: rows deferred before his local day began, once per local day (the key carries his local date)", async () => {
    // 17:00Z is 12:00 in New York; the local day began at 05:00Z.
    useDb({ exec_email_threads: [deferredRow("before", Date.parse("2026-11-04T04:30:00Z")), deferredRow("today", Date.parse("2026-11-04T05:30:00Z"))] });
    feed.supported = false;
    await run();
    const date = localDateString(NOW, "America/New_York");
    expect(date).toBe("2026-11-04");
    expect(triageJobs().map((j) => j.dedupe_key)).toEqual([retriageKey("ep_1", "before", "budget", date)]);
    expect(triageJobs()[0]).toMatchObject({ lane: "bulk", max_attempts: 10, payload: { reason: "budget_retry", accountId: "acct_1" } });
  });

  it("version: triaged rows last attempted under another TRIAGE_VERSION, by a persisted cursor", async () => {
    useDb({ exec_email_threads: [storedRow("v1", ago(DAY), { attempted_version: "email-triage-v0" }), storedRow("v2", ago(DAY))] });
    feed.supported = false;
    await run();
    expect(triageJobs().map((j) => j.dedupe_key)).toEqual([retriageKey("ep_1", "v1", "version", TRIAGE_VERSION)]);
    expect(triageJobs()[0]).toMatchObject({ payload: { reason: "version" } });
    // A short batch reached the end: the cursor wraps.
    expect(recon()?.versionCursor).toBeNull();
  });

  it("dead letters: each dead triage job once, oldest death first, keyed on the original id; dead-letter re-runs are never re-run", async () => {
    feed.supported = false;
    const dead = (id: number, finishedAt: string, reason: string) => ({
      id,
      kind: EMAIL_TRIAGE_JOB_KIND,
      lane: "interactive",
      principal_id: "ep_1",
      payload: { threadId: `t${id}`, reason, messageId: `m${id}`, accountId: "acct_1" },
      dedupe_key: `orig-${id}`,
      status: "dead",
      max_attempts: 10,
      run_after: finishedAt,
      finished_at: finishedAt
    });
    db.jobs.push(dead(5, iso(ago(2 * HOUR)), "event"), dead(3, iso(ago(HOUR)), "reconcile"), dead(9, iso(ago(30 * MIN)), "dead_letter"), dead(11, iso(ago(10_000)), "event"));
    await run();
    const retried = triageJobs().filter((j) => j.status === "queued").map((j) => j.dedupe_key);
    expect(retried).toEqual([retriageKey("ep_1", "t5", "dead", 5), retriageKey("ep_1", "t3", "dead", 3)]);
    expect(db.job(retriageKey("ep_1", "t5", "dead", 5))).toMatchObject({ lane: "bulk", payload: { reason: "dead_letter", originalJobId: 5, messageId: "m5" } });
    // The cursor passed the dead-letter re-run too; a death younger than a minute waits.
    expect(recon()?.deadCursor).toEqual({ finishedAt: iso(ago(30 * MIN)), id: 9 });
    // Run again: nothing is re-enqueued (once per original job).
    vi.setSystemTime(new Date(NOW.getTime() + 5 * MIN));
    await run();
    expect(triageJobs().filter((j) => j.status === "queued").map((j) => j.dedupe_key)).toEqual([...retried, retriageKey("ep_1", "t11", "dead", 11)]);
  });

  it("rows on a problem account get no re-triage", async () => {
    const two = mint("ep_1", ["acct_1", "acct_2"]);
    vi.mocked(checkPinnedAccounts).mockResolvedValue({ accounts: [account("acct_1"), account("acct_2")], problems: [{ accountId: "acct_2", reason: "not_found" }] });
    useDb({ exec_email_threads: [storedRow("v2", ago(DAY), { attempted_version: "email-triage-v0", account_id: "acct_2" })] });
    feed.supported = false;
    await run(two);
    expect(triageJobs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

describe("decisions", () => {
  it("createdGroupDecision covers the settle margin exactly", () => {
    const g = [feedRow("m1", "t", { createdAtMs: 1_000_000 })];
    const ctxNow = { nowMs: 1_000_000 + 10 * MIN, backfillStartedAtMs: null };
    expect(createdGroupDecision(g, { snapshotReadStartedAt: iso(1_000_000 + COVER_MARGIN_MS) }, ctxNow)).toEqual({ action: "skip", why: "covered" });
    expect(createdGroupDecision(g, { snapshotReadStartedAt: iso(1_000_000 + COVER_MARGIN_MS - 1) }, ctxNow)).toMatchObject({ action: "enqueue" });
    expect(createdGroupDecision(g, { snapshotReadStartedAt: null }, ctxNow)).toMatchObject({ action: "enqueue", lane: "interactive" });
  });

  it("changedRowWanted needs the backfill done, no row, and a change well after ingest", () => {
    const r = feedRow("m", "t", { createdAtMs: ago(3 * HOUR), signalsAtMs: ago(HOUR) });
    const c = { nowMs: NOW.getTime(), backfillDone: true };
    expect(changedRowWanted(r, null, c)).toBe(true);
    expect(changedRowWanted(r, null, { ...c, backfillDone: false })).toBe(false);
    expect(changedRowWanted({ ...r, signalsAtMs: r.createdAtMs + COVER_MARGIN_MS }, null, c)).toBe(false);
    expect(changedRowWanted({ ...r, isJunk: true }, null, c)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("isolation", () => {
  it("two principals: each run reads only its own mailboxes and writes only its own cursors and jobs", async () => {
    const other = mint("ep_2", ["acct_9"]);
    vi.mocked(loadSettings).mockImplementation(async (id: string) => ({ ...SETTINGS, principalId: id }));
    vi.mocked(checkPinnedAccounts).mockImplementation(async (p) => ({ accounts: [account(p.mailAccountIds[0])], problems: [] }));
    feed.rows = [feedRow("a1", "ta", { createdAtMs: ago(DAY) }), feedRow("b1", "tb", { createdAtMs: ago(DAY), accountId: "acct_9" })];
    await run(P);
    await run(other);
    expect(feed.calls.filter((c) => c.accountId === "acct_9").length).toBeGreaterThan(0);
    expect(db.job(reconKey("ep_1", "ta", "a1"))).toMatchObject({ principal_id: "ep_1" });
    expect(db.job(reconKey("ep_2", "tb", "b1"))).toMatchObject({ principal_id: "ep_2" });
    expect(db.job(reconKey("ep_1", "tb", "b1"))).toBeUndefined();
    expect(recon("acct_1", "ep_1")).not.toBeNull();
    expect(recon("acct_9", "ep_2")).not.toBeNull();
    expect(recon("acct_9", "ep_1")).toBeNull();
    expect(db.pg.tables.exec_sync_state.filter((s) => s.key === "stagger").map((s) => s.principal_id).sort()).toEqual(["ep_1", "ep_2"]);
  });
});

// ---------------------------------------------------------------------------
// Full cycles: what reconcile queues, through the real triage handler
// ---------------------------------------------------------------------------

const ME = "Mitchell <mitchell@scaledai.org>";
const ANN = "Ann <ann@client.com>";

interface Msg {
  id: string;
  dir?: "inbound" | "outbound";
  /** acct_1 is his pinned mailbox; anything else is a teammate's. */
  account?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  sentAtMs: number;
  junk?: boolean;
}

/** The clone's thread as triage reads it: his messages (acct_1) normalized, every message's raw addresses. */
function cloneThread(threadId: string, msgs: Msg[]): PrincipalMailThread {
  const all: MessageMeta[] = msgs.map((m) => {
    const direction = m.dir ?? "inbound";
    return {
      id: m.id,
      accountId: m.account ?? "acct_1",
      direction,
      from: m.from ?? (direction === "inbound" ? ANN : ME),
      to: m.to ?? [direction === "inbound" ? ME : ANN],
      cc: m.cc ?? [],
      rfcMessageId: `<${m.id}@x>`,
      inReplyTo: null,
      createdAtMs: m.sentAtMs,
      sentAt: iso(m.sentAtMs)
    };
  });
  const his: HisMessage[] = msgs
    .map((m, i) => ({ m, meta: all[i] }))
    .filter(({ m }) => (m.account ?? "acct_1") === "acct_1")
    .map(({ m, meta }) => ({
      id: m.id,
      threadId,
      accountId: "acct_1",
      direction: meta.direction,
      folder: m.junk ? "Junk Email" : meta.direction === "inbound" ? "INBOX" : "SENT",
      isJunk: m.junk === true,
      rfcMessageId: meta.rfcMessageId,
      inReplyTo: null,
      subject: "Renewal",
      from: parseAddress(meta.from),
      to: parseAddressList(meta.to),
      cc: parseAddressList(meta.cc),
      sentAt: iso(m.sentAtMs),
      createdAtMs: m.sentAtMs,
      isAutomated: false,
      attachments: [],
      bodyDeferred: false,
      bodyHtml: null,
      bodyText: `Message ${m.id}: can you send the renewal deck?`
    }))
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const sent = msgs.map((m) => m.sentAtMs);
  const started = Date.now();
  return {
    threadId,
    participants: [],
    his,
    all,
    snapshot: { identityCount: all.length, maxCreatedAtMs: Math.max(...sent), maxSentAtMs: Math.max(...sent), readStartedAtMs: started, readDoneAtMs: started + 100 },
    lastMessageAt: iso(Math.max(...sent))
  };
}

const triageHandler = createEmailTriageHandler({
  loadMatcher: async () => ({
    matchThread: () => ({ clientId: null, clientName: null, via: null, confidence: null, candidates: 0 }),
    isInternal: (email) => email.endsWith("@scaledai.org")
  })
});

function modelSaysReplyNeeded() {
  vi.mocked(runTriageModel).mockResolvedValue({
    kind: "ok",
    result: {
      summary: "Ann asks for the renewal deck.",
      reason: "A client is waiting",
      category: "client",
      urgency: "high",
      importance: "high",
      needsReply: true,
      mitchellPersonally: true,
      awaitingReplyFromOthers: false,
      decisionQuestion: null,
      decisionMessageId: null,
      clientSignal: "none",
      automated: false,
      injectionSuspected: false,
      commitments: []
    },
    dropped: [],
    call: { model: EXEC_MODELS.triage, requestId: "req_1", costUsd: 0.0007, latencyMs: 500 }
  });
}

/** Run a triage job (one reconcile queued, or a hand-made one) through the real handler. */
function runTriage(job: { lane?: unknown; payload?: unknown }) {
  return triageHandler.run({
    job: jobRow({ kind: EMAIL_TRIAGE_JOB_KIND, lane: job.lane as "interactive" | "bulk", principal_id: "ep_1", payload: job.payload as Record<string, unknown>, max_attempts: 10 }),
    principal: P,
    signal: new AbortController().signal,
    workerId: "w"
  }) as Promise<Record<string, unknown>>;
}

/** A feed-mode mailbox past its backfill, both feed cursors an hour back, the list window's mark 30 minutes back. */
const feedState = (): ReconState => ({
  ...initialReconState(),
  mode: "feed",
  backfill: { from: iso(ago(14 * DAY)), startedAt: iso(ago(2 * DAY)), enqueuedAt: iso(ago(2 * DAY)) },
  created: { cursor: `c:${ago(HOUR)}|`, since: null },
  changed: { cursor: `u:${ago(HOUR)}|`, since: null },
  list: { ...initialReconState().list, hwm: iso(ago(30 * MIN)), lastDeepAt: iso(ago(HOUR)) }
});

function tombRow(threadId: string): Row {
  const plan = planThreadWrite(
    null,
    { kind: "tombstone", snapshot: { identityCount: 1, maxCreatedAtMs: ago(DAY), maxSentAtMs: ago(DAY), readStartedAtMs: ago(DAY), readDoneAtMs: ago(DAY) + 200 }, hashes: [], truncated: false, policyHash: policy(RULES).hash, accountId: "acct_1" },
    { rules: RULES, currentPolicyHash: policy(RULES).hash, now: new Date(ago(DAY)), retentionDays: 180 }
  );
  if (plan.action !== "tombstone") throw new Error("fixture tombstone did not plan");
  return { principal_id: "ep_1", thread_id: threadId, version: 1, updated_at: iso(ago(DAY)), ...snakeRow(plan.patch) };
}

describe("feed mode, the thread pass (security-1)", () => {
  it("re-triages a stored row whose thread moved in someone else's mailbox; skips current, hidden, missing and already-queued threads", async () => {
    const fresh = storedRow("t_fresh", ago(DAY));
    useDb(
      {
        exec_email_threads: [
          storedRow("t_rows", ago(DAY)),
          fresh,
          tombRow("t_tomb"),
          storedRow("t_gone", ago(DAY), { state: "gone", gone_at: iso(ago(HOUR)) }),
          storedRow("t_mine", ago(DAY))
        ]
      },
      [reconRow(feedState())]
    );
    // His own new message on t_mine reaches the created pass; nothing of his reached t_rows.
    feed.rows = [feedRow("mine_m2", "t_mine", { createdAtMs: ago(10 * MIN) })];
    const moved = iso(ago(5 * MIN));
    list.threads = [
      { threadId: "t_rows", lastMessageAt: moved },
      { threadId: "t_fresh", lastMessageAt: fresh.snapshot_max_sent_at as string },
      { threadId: "t_tomb", lastMessageAt: moved },
      { threadId: "t_gone", lastMessageAt: moved },
      { threadId: "t_none", lastMessageAt: moved },
      { threadId: "t_mine", lastMessageAt: moved }
    ];
    await run();
    expect(triageJobs().map((j) => j.dedupe_key).sort()).toEqual([reconKey("ep_1", "t_mine", "mine_m2"), reconKey("ep_1", "t_rows", ago(5 * MIN))].sort());
    expect(db.job(reconKey("ep_1", "t_rows", ago(5 * MIN)))).toMatchObject({ lane: "interactive", payload: { threadId: "t_rows", reason: "reconcile", accountId: "acct_1" } });
    // It reads list mode's window (normal, then snoozed) and keeps the feed's cursors and backfill marker.
    expect(list.calls.map((c) => c.snoozed)).toEqual([false, true]);
    expect(list.calls[0].afterIso).toBe(iso(ago(30 * MIN) - LIST_OVERLAP_MS));
    expect(recon()).toMatchObject({ mode: "feed", backfill: { enqueuedAt: iso(ago(2 * DAY)) }, list: { windowFrom: null, hwm: iso(ago(2 * MIN)) } });
  });

  it("within one cycle: a delegate-only message that CCs a ruled address gets the stored row tombstoned, with no model call", async () => {
    useDb({ exec_email_threads: [storedRow("t1", ago(DAY))] }, [reconRow(feedState())]);
    list.threads = [{ threadId: "t1", lastMessageAt: iso(ago(5 * MIN)) }];
    await run();
    const job = db.job(reconKey("ep_1", "t1", ago(5 * MIN)));
    expect(job).toBeDefined();
    // The client replied only to his delegate's mailbox, CC'ing a ruled domain: his own feed never showed it.
    vi.mocked(readPrincipalThread).mockResolvedValue({
      kind: "ok",
      thread: cloneThread("t1", [
        { id: "t1-m1", sentAtMs: ago(DAY) - 10 * MIN },
        { id: "d1", account: "acct_team", to: ["Dee <dee@scaledai.org>"], cc: ["Billing <billing@restricted.com>"], sentAtMs: ago(5 * MIN) }
      ])
    });
    modelSaysReplyNeeded();
    expect(await runTriage(job as Row)).toMatchObject({ outcome: "tombstoned" });
    expect(db.email.tables.exec_email_threads?.[0]).toMatchObject({ state: "restricted_hidden", subject: null, summary: null });
    expect(runTriageModel).not.toHaveBeenCalled();
    expect(fakeE.deleteEmailAttentionForThreads).toHaveBeenCalledWith(P, ["t1"], expect.anything());
  });

  it("the thread pass never marks the feed's backfill done: the created pass owns that marker (security-1)", async () => {
    // The backfill is still running and its page is held back by the full bulk cap.
    useDb({}, [reconRow({ ...feedState(), backfill: { from: iso(ago(14 * DAY)), startedAt: iso(ago(MIN)), enqueuedAt: null } })]);
    for (let i = 0; i < 12; i += 1) {
      db.jobs.push({ id: 800 + i, kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", payload: { threadId: `q${i}`, reason: "backfill" }, dedupe_key: `q${i}`, status: "queued", max_attempts: 10, run_after: NOW.toISOString() });
    }
    feed.rows = [feedRow("b1", "t_backfill", { createdAtMs: ago(30 * MIN) })];
    list.threads = [];
    expect(await run()).toMatchObject({ blocked: 1 });
    // The thread pass finished its window; the backfill is still not enqueued.
    expect(recon()?.list.windowFrom).toBeNull();
    expect(recon()?.backfill?.enqueuedAt).toBeNull();
  });

  it("list mode itself is unchanged: a thread with no row is still found there", async () => {
    feed.supported = false;
    useDb({}, [reconRow({ ...feedState(), mode: "list" })]);
    list.threads = [{ threadId: "t_new", lastMessageAt: iso(ago(5 * MIN)) }];
    await run();
    expect(db.job(reconKey("ep_1", "t_new", ago(5 * MIN)))).toMatchObject({ payload: { reason: "reconcile" } });
  });
});

describe("reconcile's ruled-row tombstone against a triage in flight (data-1)", () => {
  it("an overflowing union drops the ruled hash, yet a clean job that read before the tombstone can't leave it", async () => {
    // 600 stored hashes that all sort before the ruled ones: the union keeps them and drops the rest.
    const filler = Array.from({ length: 600 }, (_, i) => `0${i.toString(16).padStart(31, "0")}`);
    useDb({ exec_email_threads: [storedRow("t1", ago(DAY), { screen_hashes: filler })] }, [reconRow(feedState())]);
    feed.rows = [feedRow("m2", "t1", { createdAtMs: ago(10 * MIN), cc: ["X <x@restricted.com>"] })];
    expect(await run()).toMatchObject({ tombstoned: 1 });
    const tomb = db.email.tables.exec_email_threads?.[0];
    expect(tomb).toMatchObject({ state: "restricted_hidden", screen_truncated: true, screen_hashes: filler, snapshot_read_done_at: NOW.toISOString() });
    // J0 read the thread 200 s ago (after the stored read, before m2 arrived): clean, under the current rules.
    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    const j0 = await applyThreadProposal(P, SETTINGS, "t1", cleanTriage("t1", ago(200_000), policy(RULES).hash), { now: new Date(), retentionDays: 180 });
    expect(j0).toMatchObject({ result: "skipped", reason: "stale_vs_tombstone" });
    expect(db.email.tables.exec_email_threads?.[0]).toMatchObject({ state: "restricted_hidden", subject: null, summary: null });
  });
});

describe("folder moves on a thread that has a row (data-2)", () => {
  it("folderMoveWanted: a rescue the facts don't include, or a move to Junk of the facts' newest inbound; only well after ingest, on a live row", () => {
    const stored = { state: "triaged" as const, lastInboundAt: iso(ago(3 * HOUR)), newestInboundMessageId: "m0" };
    const rescued = feedRow("m2", "t", { createdAtMs: ago(2 * HOUR), signalsAtMs: ago(10 * MIN) });
    expect(folderMoveWanted(rescued, stored)).toBe(true);
    expect(folderMoveWanted({ ...rescued, sentAtMs: ago(4 * HOUR) }, stored)).toBe(false);
    expect(folderMoveWanted({ ...rescued, signalsAtMs: rescued.createdAtMs + COVER_MARGIN_MS }, stored)).toBe(false);
    expect(folderMoveWanted({ ...rescued, direction: "outbound" }, stored)).toBe(false);
    expect(folderMoveWanted({ ...rescued, removedAtMs: ago(MIN) }, stored)).toBe(false);
    expect(folderMoveWanted(rescued, null)).toBe(false);
    expect(folderMoveWanted(rescued, { ...stored, state: "restricted_hidden" })).toBe(false);
    expect(folderMoveWanted(rescued, { ...stored, state: "gone" })).toBe(false);
    const junked = feedRow("m0", "t", { createdAtMs: ago(3 * HOUR), signalsAtMs: ago(10 * MIN), isJunk: true, folder: "Junk Email" });
    expect(folderMoveWanted(junked, stored)).toBe(true);
    expect(folderMoveWanted({ ...junked, messageId: "m9" }, stored)).toBe(false);
    expect(folderMoveKey("ep_1", rescued)).toBe(reconKey("ep_1", "t", "m2.i"));
    expect(folderMoveKey("ep_1", junked)).toBe(reconKey("ep_1", "t", "m0.j"));
  });

  it("a reply rescued from Junk after the thread was triaged without it is re-triaged, and the thread ends awaiting his reply", async () => {
    useDb({}, [reconRow(feedState())]);
    modelSaysReplyNeeded();
    // He answered Ann; her follow-up landed in Junk, so the event-time triage left it out.
    const atJunk = [
      { id: "m0", sentAtMs: ago(3 * HOUR) },
      { id: "o1", dir: "outbound" as const, sentAtMs: ago(150 * MIN) },
      { id: "m2", sentAtMs: ago(2 * HOUR), junk: true }
    ];
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: cloneThread("tj", atJunk) });
    const first = triageJob({ principalId: "ep_1", lane: "interactive", threadId: "tj", reason: "reconcile", dedupeKey: reconKey("ep_1", "tj", "m2") });
    expect(await runTriage(first)).toMatchObject({ outcome: "triaged" });
    expect(db.email.tables.exec_email_threads?.[0]).toMatchObject({ answered_state: "answered", newest_inbound_message_id: "m0" });

    // He rescues it 10 minutes ago: the changed feed shows it in the Inbox.
    feed.rows = [feedRow("m2", "tj", { createdAtMs: ago(2 * HOUR), signalsAtMs: ago(10 * MIN), from: ANN })];
    await run();
    const job = db.job(folderMoveKey("ep_1", { threadId: "tj", messageId: "m2", isJunk: false }));
    expect(job).toMatchObject({ lane: "bulk", payload: { threadId: "tj", reason: "reconcile", messageId: "m2" } });

    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: cloneThread("tj", atJunk.map((m) => ({ ...m, junk: false }))) });
    vi.setSystemTime(new Date(NOW.getTime() + 2 * MIN));
    expect(await runTriage(job as Row)).toMatchObject({ outcome: "triaged" });
    expect(db.email.tables.exec_email_threads?.[0]).toMatchObject({ answered_state: "awaiting_reply", newest_inbound_message_id: "m2", last_inbound_at: iso(ago(2 * HOUR)) });
  });

  it("marking the facts' newest inbound as junk re-triages the thread once", async () => {
    useDb({ exec_email_threads: [storedRow("t1", ago(DAY))] }, [reconRow(feedState())]);
    // storedRow's newest inbound is t1-m1.
    feed.rows = [feedRow("t1-m1", "t1", { createdAtMs: ago(2 * HOUR), signalsAtMs: ago(10 * MIN), isJunk: true, folder: "Junk Email" })];
    await run();
    expect(triageJobs().map((j) => j.dedupe_key)).toEqual([reconKey("ep_1", "t1", "t1-m1.j")]);
    // The next run reads the same move again only from an older cursor; the key keeps it to one job.
    useDb({ exec_email_threads: [storedRow("t1", ago(DAY))] }, [reconRow(feedState())]);
    db.jobs.push({ id: 900, kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", payload: { threadId: "t1", reason: "reconcile" }, dedupe_key: reconKey("ep_1", "t1", "t1-m1.j"), status: "succeeded", max_attempts: 10, run_after: NOW.toISOString() });
    await run();
    expect(triageJobs().filter((j) => j.status === "queued")).toHaveLength(0);
  });
});
