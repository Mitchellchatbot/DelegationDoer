import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// exec.email-triage (contract §3.11 steps 1-14, v3.1 A1-A7, round-4 addenda).
// The real state machine and store run over an in-memory database; only the
// clone reads, the restricted-sender rules, the model call and the settings
// loader are stand-ins, so every assertion is about what lands in the tables.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
// Area E's attention.ts: the tombstone procedure's last step.
const fakeE = vi.hoisted(() => ({ deleteEmailAttentionForThreads: vi.fn() }));
vi.mock("@/lib/exec/attention", () => fakeE);
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

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";
import { createFakePipelineDb, type FakePipelineDb, type Row } from "@/lib/exec/__tests__/fake-pipeline-db";
import type { HisMessage, MessageMeta, NewCommitment, PrincipalMailThread } from "@/lib/exec/email-types";
import {
  BACKLOG_AGE_MS,
  buildFacts,
  createEmailTriageHandler,
  followUpOf,
  isUnchanged,
  ownAddressesOf,
  watermarkOf,
  type TriageMatcher
} from "@/lib/exec/handlers/email-triage";
import { EMAIL_ATTENTION_JOB_KIND, EMAIL_TRIAGE_JOB_KIND, __resetJobsForTests, mailBacklogKey, mailEventKey, triageJob } from "@/lib/exec/jobs";
import { EXEC_MODELS } from "@/lib/exec/llm/models";
import { notifyOps } from "@/lib/exec/ops";
import { loadPrincipalById, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import {
  computeAnswered,
  loadHisBodies,
  loadScreeningPolicy,
  parseAddress,
  parseAddressList,
  readPrincipalThread,
  restrictedPolicyHash,
  screenByHashes,
  screenHashesFor
} from "@/lib/exec/sources/mail";
import { runTriageModel, TRIAGE_VERSION, type TriageModelOutcome, type TriageResult } from "@/lib/exec/triage/email";
import type { RenderedTriageInput } from "@/lib/exec/triage/email-text";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext, type JobLane } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-04T17:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

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
const NO_RULES: RestrictedSenderRule[] = [];
const RULES = [rule("rs_1", "restricted.com")];
const policy = (rules: RestrictedSenderRule[]) => ({ rules, hash: restrictedPolicyHash("hidden", rules) });

interface MailSpec {
  id: string;
  dir?: "inbound" | "outbound";
  from?: string;
  to?: string[];
  cc?: string[];
  /** Minutes before NOW. */
  sentAgo?: number;
  /** Ingest, minutes before NOW (defaults to sentAgo). */
  createdAgo?: number;
  subject?: string;
  junk?: boolean;
  automated?: boolean;
  account?: string;
  rfc?: string;
  inReplyTo?: string;
  body?: string;
}

const CLIENT = "Ann Client <ann@client.com>";
const ME = "Mitchell <mitchell@scaledai.org>";

function his(s: MailSpec): HisMessage {
  const dir = s.dir ?? "inbound";
  const sent = NOW.getTime() - (s.sentAgo ?? 60) * MIN;
  const created = NOW.getTime() - (s.createdAgo ?? s.sentAgo ?? 60) * MIN;
  return {
    id: s.id,
    threadId: "th_1",
    accountId: s.account ?? "acct_1",
    direction: dir,
    folder: s.junk ? "Junk Email" : dir === "inbound" ? "INBOX" : "SENT",
    isJunk: s.junk === true,
    rfcMessageId: s.rfc ?? `<${s.id}@mail>`,
    inReplyTo: s.inReplyTo ?? null,
    subject: s.subject ?? "Renewal",
    from: parseAddress(s.from ?? (dir === "inbound" ? CLIENT : ME)),
    to: parseAddressList(s.to ?? [dir === "inbound" ? ME : CLIENT]),
    cc: parseAddressList(s.cc ?? []),
    sentAt: iso(sent),
    createdAtMs: created,
    isAutomated: s.automated === true,
    attachments: [],
    bodyDeferred: false,
    bodyHtml: null,
    bodyText: s.body ?? `Message ${s.id}: can you send the renewal deck by Friday?`
  };
}

function meta(s: MailSpec): MessageMeta {
  const m = his(s);
  return {
    id: m.id,
    accountId: m.accountId,
    direction: m.direction,
    from: s.from ?? (m.direction === "inbound" ? CLIENT : ME),
    to: s.to ?? [m.direction === "inbound" ? ME : CLIENT],
    cc: s.cc ?? [],
    rfcMessageId: m.rfcMessageId,
    inReplyTo: m.inReplyTo,
    createdAtMs: m.createdAtMs,
    sentAt: m.sentAt
  };
}

/** A read of the thread as it is now: his = the specs on his account, all = every spec. */
function threadOf(specs: MailSpec[], participants: string[] = []): PrincipalMailThread {
  const all = specs.map(meta);
  const mine = specs.filter((s) => (s.account ?? "acct_1") === "acct_1").map(his);
  const created = all.map((m) => m.createdAtMs).filter((v): v is number => v !== null);
  const sent = all.map((m) => Date.parse(m.sentAt as string));
  const started = Date.now();
  return {
    threadId: "th_1",
    participants,
    his: mine.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || (a.id < b.id ? -1 : 1)),
    all,
    snapshot: {
      identityCount: all.length,
      maxCreatedAtMs: created.length ? Math.max(...created) : null,
      maxSentAtMs: Math.max(...sent),
      readStartedAtMs: started,
      readDoneAtMs: started + 200
    },
    lastMessageAt: iso(Math.max(...sent))
  };
}

const CALL = { model: EXEC_MODELS.triage, requestId: "req_1", costUsd: 0.0007, latencyMs: 900 };

function result(over: Partial<TriageResult> = {}): TriageResult {
  return {
    summary: "Ann asks for the renewal deck by Friday.",
    reason: "A client is waiting on him",
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
    commitments: [],
    ...over
  };
}

function commitmentFrom(rendered: RenderedTriageInput, messageId: string, over: Partial<NewCommitment> = {}): NewCommitment {
  const m = rendered.messages.find((x) => x.messageId === messageId);
  if (!m) throw new Error(`message ${messageId} was not rendered`);
  return {
    source: "email",
    threadId: "th_1",
    messageId,
    accountId: m.accountId,
    direction: m.direction === "outbound" ? "mitchell_owes" : "owed_to_mitchell",
    text: `Deliver the deck (${messageId})`,
    counterparty: "Ann",
    dueAt: null,
    dueText: null,
    evidenceExcerpt: `send the renewal deck (${messageId})`,
    sourceRef: { system: "outlook", id: messageId, url: null, label: "Email message", class: "private" },
    messageSentAt: m.sentAt,
    messageCreatedAtMs: m.createdAtMs,
    bornFollowedUpAt: null,
    ...over
  };
}

const NO_MATCH = { clientId: null, clientName: null, via: null, confidence: null, candidates: 0 };
const matcher = (over: Partial<ReturnType<TriageMatcher["matchThread"]>> = {}): TriageMatcher => ({
  matchThread: () => ({ ...NO_MATCH, ...over }),
  isInternal: (email) => email.endsWith("@scaledai.org")
});

let db: FakePipelineDb;
let specs: MailSpec[];
let participants: string[];
let currentMatcher: TriageMatcher;
const loadMatcher = vi.fn(async () => currentMatcher);
const handler = createEmailTriageHandler({ loadMatcher });

function useDb(tables: Record<string, Row[]> = {}, pg: Record<string, Row[]> = {}): FakePipelineDb {
  db = createFakePipelineDb({ email: { tables, now: () => new Date(Date.now()) }, pg: { tables: { exec_sync_state: [], ...pg } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

function ctx(payload: Record<string, unknown>, lane: JobLane = "interactive", over: Partial<JobContext> = {}): JobContext {
  return {
    job: jobRow({ kind: EMAIL_TRIAGE_JOB_KIND, lane, principal_id: "ep_1", payload, max_attempts: 10 }),
    principal: P,
    signal: new AbortController().signal,
    workerId: "w",
    ...over
  };
}

const eventPayload = (messageId: string) => triageJob({ principalId: "ep_1", lane: "interactive", threadId: "th_1", messageId, accountId: "acct_1", reason: "event", dedupeKey: mailEventKey("ep_1", messageId) }).payload as Record<string, unknown>;
const payload = (reason: string, over: Record<string, unknown> = {}) => ({ threadId: "th_1", accountId: "acct_1", reason, ...over });

const row = () => db.email.tables.exec_email_threads?.find((r) => r.thread_id === "th_1");
const commitments = () => db.email.tables.exec_commitments ?? [];
const kicks = () => db.jobsOf(EMAIL_ATTENTION_JOB_KIND);

function accountsState(problems: { accountId: string; reason: string }[] = []): Row {
  return {
    principal_id: "ep_1",
    source: "mail",
    key: "accounts",
    cursor: { rev: 1, checkedAt: NOW.toISOString(), accounts: [{ id: "acct_1", email: "mitchell@scaledai.org", lastSyncedAt: NOW.toISOString(), lastSyncError: null, lastSyncErrorAt: null }], problems },
    updated_at: NOW.toISOString()
  };
}

function modelAnswers(...answers: ((rendered: RenderedTriageInput) => TriageModelOutcome)[]) {
  const queue = [...answers];
  vi.mocked(runTriageModel).mockImplementation(async (_p, rendered) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error("no model answer queued");
    return next(rendered);
  });
}
const ok = (over: Partial<TriageResult> = {}, commit: (r: RenderedTriageInput) => NewCommitment[] = () => []) => (r: RenderedTriageInput): TriageModelOutcome => ({
  kind: "ok",
  result: result({ ...over, commitments: commit(r) }),
  dropped: [],
  call: CALL
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.EXEC_ENABLED = "true";
  __resetJobsForTests();
  useDb();
  specs = [{ id: "m1", sentAgo: 30 }];
  participants = [];
  currentMatcher = matcher();
  // restoreMocks leaves a vi.fn()'s implementations (and any unused *Once) in place: reset them.
  for (const m of [loadSettings, loadScreeningPolicy, readPrincipalThread, loadHisBodies, runTriageModel, notifyOps, loadPrincipalById]) vi.mocked(m).mockReset();
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(NO_RULES));
  vi.mocked(readPrincipalThread).mockImplementation(async () => ({ kind: "ok", thread: threadOf(specs, participants) }));
  vi.mocked(loadHisBodies).mockResolvedValue(undefined);
  modelAnswers(ok());
  fakeE.deleteEmailAttentionForThreads.mockReset();
  fakeE.deleteEmailAttentionForThreads.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  // Every enqueue site sets the attempts budget (L6): triage 10, attention 3 (the column default would be 6).
  for (const j of db.jobs) expect(j.max_attempts).toBe(j.kind === EMAIL_TRIAGE_JOB_KIND ? 10 : 3);
  vi.useRealTimers();
  delete process.env.EXEC_ENABLED;
});

/** Run the handler a few seconds after the previous run, as a later job would. */
async function runLater(seconds: number, c: JobContext) {
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
  return handler.run(c);
}

// ---------------------------------------------------------------------------
// The job's shape and gates
// ---------------------------------------------------------------------------

describe("the job", () => {
  it("is exec.email-triage with a 120 s ceiling", () => {
    expect(handler).toMatchObject({ kind: "exec.email-triage", timeoutMs: 120_000 });
    expect(Object.isFrozen(handler)).toBe(true);
  });

  it("refuses a job with no principal or a malformed payload (a bug, not a retry)", async () => {
    await expect(handler.run(ctx(payload("event"), "interactive", { principal: null }))).rejects.toThrow(NonRetryableError);
    await expect(handler.run(ctx({ threadId: "th_1", reason: "retriage" }))).rejects.toThrow(NonRetryableError);
    await expect(handler.run(ctx({ reason: "event" }))).rejects.toThrow(NonRetryableError);
  });

  it.each([
    ["not_installed", { emailSchemaReady: false, emailEnabled: false }],
    ["email_off", { emailEnabled: false }]
  ])("skips when %s, before any read", async (why, over) => {
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, ...over });
    expect(await handler.run(ctx(payload("reconcile")))).toEqual({ outcome: "skipped", why });
    expect(readPrincipalThread).not.toHaveBeenCalled();
  });

  it("skips with no pin", async () => {
    const unpinned = mint("ep_1", []);
    expect(await handler.run(ctx(payload("reconcile"), "interactive", { principal: unpinned }))).toEqual({ outcome: "skipped", why: "no_pin" });
  });

  it("skips work for an account the last reconcile marked as a problem, and reads only usable accounts", async () => {
    useDb({}, { exec_sync_state: [accountsState([{ accountId: "acct_1", reason: "email_mismatch" }])] });
    expect(await handler.run(ctx(payload("reconcile")))).toEqual({ outcome: "skipped", why: "no_usable_account" });
    const two = mint("ep_1", ["acct_1", "acct_2"]);
    expect(await handler.run(ctx(payload("reconcile"), "interactive", { principal: two }))).toEqual({ outcome: "skipped", why: "account_not_usable" });
    await handler.run(ctx(payload("reconcile", { accountId: "acct_2" }), "interactive", { principal: two }));
    expect(vi.mocked(readPrincipalThread).mock.calls[0][2]).toMatchObject({ usable: ["acct_2"], timeoutMs: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// Reads that end the job
// ---------------------------------------------------------------------------

describe("read outcomes", () => {
  it("a clone 404 marks a stored thread gone at the 404 read's own readDoneAtMs, keeps its content, and kicks attention", async () => {
    await handler.run(ctx(payload("reconcile")));
    let readDoneAtMs = 0;
    vi.mocked(readPrincipalThread).mockImplementationOnce(async () => {
      // Distinct from the handler's clock, so the test sees whose time is stored.
      readDoneAtMs = Date.now() - 1_234;
      return { kind: "not_found", readDoneAtMs };
    });
    const r = await runLater(60, ctx(payload("reconcile")));
    expect(r).toMatchObject({ outcome: "gone", write: "updated" });
    expect(row()).toMatchObject({ state: "gone", subject: "Renewal" });
    expect(readDoneAtMs).toBeGreaterThan(0);
    expect(Date.parse(row()?.gone_at as string)).toBe(readDoneAtMs);
    expect(kicks().length).toBeGreaterThan(0);
  });

  it("a clone 404 for a thread with no row writes nothing", async () => {
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "not_found", readDoneAtMs: Date.now() });
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "gone", write: "skipped", why: "no_row" });
    expect(row()).toBeUndefined();
    expect(kicks()).toHaveLength(0);
  });

  it("not his: no write", async () => {
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "not_his" });
    expect(await handler.run(ctx(payload("reconcile")))).toEqual({ outcome: "skipped", why: "not_his" });
    expect(row()).toBeUndefined();
  });

  it("an event for a message that isn't in the thread on his usable account is skipped", async () => {
    specs = [{ id: "m1", sentAgo: 10 }, { id: "x1", sentAgo: 5, account: "acct_other" }];
    expect(await handler.run(ctx(eventPayload("x1")))).toEqual({ outcome: "skipped", why: "message_not_in_thread" });
    expect(await handler.run(ctx(eventPayload("nope")))).toEqual({ outcome: "skipped", why: "message_not_in_thread" });
    expect(runTriageModel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("a new thread", () => {
  it("is triaged: facts from his messages, the AI fields, its commitments, a kick on the job's lane", async () => {
    specs = [
      { id: "m1", dir: "outbound", sentAgo: 120, to: ["Ann Client <ann@client.com>"], cc: ["Bob <bob@partner.com>"] },
      { id: "m2", sentAgo: 30, subject: "Re: Renewal", cc: ["Bob <bob@partner.com>", "Mitchell <mitchell@scaledai.org>"] }
    ];
    currentMatcher = matcher({ clientId: "c_1", clientName: "Client Co", via: "exact", confidence: "high", candidates: 1 });
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m2")]));
    const r = await handler.run(ctx(eventPayload("m2")));
    expect(r).toEqual({ outcome: "triaged", write: "inserted", commitmentsInserted: 1, followedUp: 0, modelCalled: true });
    expect(row()).toMatchObject({
      state: "triaged",
      account_id: "acct_1",
      subject: "Re: Renewal",
      counterpart_name: "Ann Client",
      counterpart_email: "ann@client.com",
      correspondents: ["ann@client.com", "bob@partner.com"],
      message_count: 2,
      newest_message_id: "m2",
      newest_inbound_message_id: "m2",
      newest_outbound_message_id: "m1",
      answered_state: "awaiting_reply",
      client_id: "c_1",
      match_confidence: "high",
      summary: "Ann asks for the renewal deck by Friday.",
      urgency: "high",
      triage_version: TRIAGE_VERSION,
      attempted_version: TRIAGE_VERSION,
      model: EXEC_MODELS.triage,
      screened_policy_hash: restrictedPolicyHash("hidden", NO_RULES)
    });
    expect(row()?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(row()?.input_watermark as string)).toBe(NOW.getTime() - 30 * MIN);
    expect(commitments()).toHaveLength(1);
    expect(commitments()[0]).toMatchObject({ message_id: "m2", direction: "owed_to_mitchell", status: "open" });
    const minute = Math.floor(NOW.getTime() / 60_000);
    expect(kicks()).toEqual([
      expect.objectContaining({ dedupe_key: `email-attn:ep_1:m${minute + 1}`, lane: "interactive", max_attempts: 3, run_after: iso((minute + 1) * 60_000 + 2_000) })
    ]);
    // First triage: every message is new, and the model may take commitments from any.
    expect(vi.mocked(runTriageModel).mock.calls[0][2]).toMatchObject({ firstTriage: true });
    expect(vi.mocked(runTriageModel).mock.calls[0][1].newSinceWatermarkMs).toBeNull();
  });

  it("loads the bodies of the messages it shows, newest first, with the 30 s clone timeout", async () => {
    specs = [{ id: "m1", sentAgo: 50 }, { id: "m2", dir: "outbound", sentAgo: 40 }, { id: "m3", sentAgo: 30 }];
    vi.mocked(readPrincipalThread).mockImplementation(async () => {
      const t = threadOf(specs);
      for (const m of t.his) m.bodyDeferred = m.id !== "m3";
      return { kind: "ok", thread: t };
    });
    await handler.run(ctx(payload("reconcile")));
    expect(vi.mocked(loadHisBodies).mock.calls[0][2]).toEqual(["m2", "m1"]);
    expect(vi.mocked(loadHisBodies).mock.calls[0][3]).toMatchObject({ timeoutMs: 30_000 });
  });

  it("the job result carries codes and counts only", async () => {
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m1")]));
    const r = (await handler.run(ctx(payload("reconcile")))) as Record<string, unknown>;
    for (const v of Object.values(r)) expect(["string", "number", "boolean"]).toContain(typeof v);
    expect(JSON.stringify(r)).not.toMatch(/renewal|ann@|deck/i);
  });
});

// ---------------------------------------------------------------------------
// Exits before the model
// ---------------------------------------------------------------------------

describe("exits", () => {
  it("age gate: a thread with no row whose newest mail is older than the backfill window is not picked up", async () => {
    specs = [{ id: "m1", sentAgo: 15 * 24 * 60 }];
    expect(await handler.run(ctx(payload("backfill")))).toEqual({ outcome: "skipped", why: "too_old" });
    expect(row()).toBeUndefined();
  });

  it("the age gate doesn't apply to a thread that has a row", async () => {
    specs = [{ id: "m1", sentAgo: 20 * 24 * 60 }];
    vi.setSystemTime(new Date(NOW.getTime() - 19 * DAY));
    await handler.run(ctx(payload("reconcile")));
    vi.setSystemTime(NOW);
    expect(await handler.run(ctx(payload("version")))).toMatchObject({ outcome: "unchanged" });
  });

  it("junk only, no row: nothing is written", async () => {
    specs = [{ id: "m1", sentAgo: 5, junk: true }];
    expect(await handler.run(ctx(payload("reconcile")))).toEqual({ outcome: "skipped", why: "junk_only" });
    expect(row()).toBeUndefined();
  });

  it("junk only, with a row: the read's screening hashes are unioned into it first (coherence-20)", async () => {
    await handler.run(ctx(payload("reconcile")));
    const before = row()?.screen_hashes as string[];
    specs = [{ id: "m1", sentAgo: 30, junk: true }, { id: "j2", sentAgo: 1, junk: true, from: "Spam <promo@spammer.net>" }];
    const r = await runLater(10, ctx(payload("reconcile")));
    expect(r).toMatchObject({ outcome: "skipped", why: "junk_only", write: "updated" });
    const after = row()?.screen_hashes as string[];
    expect(after.length).toBeGreaterThan(before.length);
    for (const h of screenHashesFor({ all: [{ from: "promo@spammer.net", to: [], cc: [] }], participants: [] }).hashes) expect(after).toContain(h);
  });

  it("backlog: an interactive event for mail sent over 2 h ago moves to the bulk lane at the shared stagger, without a model call", async () => {
    specs = [{ id: "m1", sentAgo: BACKLOG_AGE_MS / MIN + 30 }];
    const r = await handler.run(ctx(eventPayload("m1")));
    expect(r).toEqual({ outcome: "deferred", why: "backlog", enqueued: 1 });
    const moved = db.job(mailBacklogKey("ep_1", "m1"));
    expect(moved).toMatchObject({ kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", max_attempts: 10, payload: { threadId: "th_1", reason: "event", messageId: "m1", accountId: "acct_1" } });
    expect(db.pg.tables.exec_sync_state.find((s) => s.key === "stagger")).toBeDefined();
    expect(runTriageModel).not.toHaveBeenCalled();
    expect(row()).toBeUndefined();
    // On the bulk lane it is triaged, not re-routed again.
    expect(await handler.run(ctx(moved?.payload as Record<string, unknown>, "bulk"))).toMatchObject({ outcome: "triaged" });
  });

  it("backlog under backpressure: nothing is queued (reconcile finds it later)", async () => {
    for (let i = 0; i < 12; i += 1) {
      db.jobs.push({ id: 500 + i, kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", payload: { threadId: `x${i}`, reason: "backfill" }, dedupe_key: `x${i}`, status: "queued", max_attempts: 10, run_after: NOW.toISOString() });
    }
    specs = [{ id: "m1", sentAgo: 600 }];
    expect(await handler.run(ctx(eventPayload("m1")))).toEqual({ outcome: "deferred", why: "backpressure", enqueued: 0 });
    expect(db.job(mailBacklogKey("ep_1", "m1"))).toBeUndefined();
  });

  it("the backlog and junk exits screen first when a row exists: a restricted CC tombstones instead (A7)", async () => {
    await handler.run(ctx(payload("reconcile")));
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    specs = [{ id: "m1", sentAgo: 30 }, { id: "m2", sentAgo: 600, cc: ["X <x@restricted.com>"] }];
    const r = await runLater(5, ctx(eventPayload("m2")));
    expect(r).toMatchObject({ outcome: "tombstoned" });
    expect(row()).toMatchObject({ state: "restricted_hidden", subject: null, summary: null });
    expect(db.job(mailBacklogKey("ep_1", "m2"))).toBeUndefined();
    expect(fakeE.deleteEmailAttentionForThreads).toHaveBeenCalled();
    expect(runTriageModel).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Restricted senders
// ---------------------------------------------------------------------------

describe("restricted senders", () => {
  it("a restricted participant on a new thread creates a tombstone row, never calls the model, and kicks", async () => {
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    participants = ["boss@restricted.com"];
    expect(await handler.run(ctx(payload("reconcile")))).toEqual({ outcome: "tombstoned", write: "tombstoned" });
    expect(row()).toMatchObject({ state: "restricted_hidden", account_id: "acct_1", subject: null, correspondents: [], screened_policy_hash: policy(RULES).hash });
    expect(runTriageModel).not.toHaveBeenCalled();
    expect(kicks()).toHaveLength(1);
  });

  it("another account's message in the thread is screened too (every message, any account)", async () => {
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    specs = [{ id: "m1", sentAgo: 30 }, { id: "o1", sentAgo: 20, account: "acct_other", from: "Y <y@restricted.com>" }];
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "tombstoned" });
  });

  it("rules reloaded between the read and the write turn the write into a tombstone", async () => {
    specs = [{ id: "m1", sentAgo: 30, cc: ["X <x@restricted.com>"] }];
    vi.mocked(loadScreeningPolicy).mockResolvedValueOnce(policy(NO_RULES)).mockResolvedValue(policy(RULES));
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "tombstoned" });
    expect(row()).toMatchObject({ state: "restricted_hidden", summary: null });
    expect(commitments()).toHaveLength(0);
  });

  it("a rule added before the write tombstones even when the read's hash set is truncated (the live re-screen, not the hashes, decides)", async () => {
    // A ruled domain whose screening hash sorts late: the row keeps the lowest 600 hashes,
    // so with enough other participants this one is among those dropped.
    const sha32 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);
    const domain = Array.from({ length: 400 }, (_, i) => `ruled-${i}.com`).find((d) => sha32(`d:${d}`) > "f8");
    if (!domain) throw new Error("no late-sorting domain among the candidates");
    const late = [rule("rs_late", domain)];
    specs = [{ id: "m1", sentAgo: 30, cc: [`X <x@${domain}>`] }];
    participants = Array.from({ length: 400 }, (_, i) => `p${i}@d${i}.example`);
    const read = screenHashesFor({ all: threadOf(specs).all, participants });
    expect(read.truncated).toBe(true);
    expect(screenByHashes(read.hashes, late).verdict).toBe("clean");
    vi.mocked(loadScreeningPolicy).mockResolvedValueOnce(policy(NO_RULES)).mockResolvedValue(policy(late));
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "tombstoned" });
    expect(row()).toMatchObject({ state: "restricted_hidden", subject: null, summary: null, screen_truncated: true });
  });

  it("a rule added while the store writes (its per-attempt reload) still tombstones", async () => {
    specs = [{ id: "m1", sentAgo: 30, cc: ["X <x@restricted.com>"] }];
    vi.mocked(loadScreeningPolicy).mockResolvedValueOnce(policy(NO_RULES)).mockResolvedValueOnce(policy(NO_RULES)).mockResolvedValue(policy(RULES));
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "tombstoned", write: "tombstoned" });
    expect(row()?.state).toBe("restricted_hidden");
  });

  it("security-2: a tombstone's stored hashes still match a rule after the ruled message left the clone: no body load, no model call", async () => {
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    // A teammate's copy CC'd a ruled address: the thread is a tombstone.
    specs = [{ id: "m1", sentAgo: 60 }, { id: "x1", sentAgo: 50, account: "acct_team", cc: ["X <x@restricted.com>"] }];
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "tombstoned" });
    // That message is purged from the clone (purge-by-sender); a new one of his arrives. The live read is clean.
    specs = [{ id: "m1", sentAgo: 60 }, { id: "m2", sentAgo: 5 }];
    expect(await runLater(30, ctx(eventPayload("m2")))).toMatchObject({ outcome: "tombstoned" });
    expect(row()).toMatchObject({ state: "restricted_hidden", subject: null, summary: null });
    expect(loadHisBodies).not.toHaveBeenCalled();
    expect(runTriageModel).not.toHaveBeenCalled();
  });

  it("security-2: a live row whose stored hashes match a rule added since is tombstoned before the model, though the live read is clean", async () => {
    // Triaged under no rules, with a ruled address in a message that is later purged.
    specs = [{ id: "m1", sentAgo: 60 }, { id: "x1", sentAgo: 50, account: "acct_team", from: "X <x@restricted.com>" }];
    await handler.run(ctx(payload("reconcile")));
    expect(row()?.state).toBe("triaged");
    expect(runTriageModel).toHaveBeenCalledTimes(1);
    const bodyLoads = vi.mocked(loadHisBodies).mock.calls.length;
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    specs = [{ id: "m1", sentAgo: 60 }, { id: "m2", sentAgo: 5 }];
    expect(await runLater(30, ctx(eventPayload("m2")))).toMatchObject({ outcome: "tombstoned", write: "tombstoned" });
    expect(row()).toMatchObject({ state: "restricted_hidden", summary: null });
    expect(runTriageModel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadHisBodies).mock.calls.length).toBe(bodyLoads);
  });

  it("a tombstone is left by a later clean read once the rule is removed (a policy re-triage), as a first assessment", async () => {
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    specs = [{ id: "m1", sentAgo: 30, cc: ["X <x@restricted.com>"] }];
    await handler.run(ctx(payload("reconcile")));
    expect(row()?.state).toBe("restricted_hidden");
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(NO_RULES));
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m1")]));
    const r = await runLater(30, ctx(payload("policy")));
    expect(r).toMatchObject({ outcome: "triaged", write: "updated", commitmentsInserted: 1 });
    expect(row()).toMatchObject({ state: "triaged", subject: "Renewal" });
    expect(vi.mocked(runTriageModel).mock.calls[0][2]).toMatchObject({ firstTriage: true });
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe("every outcome", () => {
  it("filtered: a no-reply sender goes to the Filtered bucket without a model call", async () => {
    specs = [{ id: "m1", sentAgo: 30, from: "Billing <no-reply@vendor.com>", subject: "Your invoice" }];
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "filtered", write: "inserted", modelCalled: false });
    expect(row()).toMatchObject({ state: "filtered", filter_reason: "unreplyable", summary: null });
    expect(runTriageModel).not.toHaveBeenCalled();
  });

  it("an exact client contact is never filtered", async () => {
    specs = [{ id: "m1", sentAgo: 30, from: "Billing <no-reply@client.com>", subject: "Your invoice" }];
    currentMatcher = matcher({ clientId: "c_1", clientName: "Client Co", via: "exact", confidence: "high", candidates: 1 });
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "triaged" });
  });

  it.each([
    ["refused", { kind: "failed", error: "refusal" }],
    ["truncated", { kind: "failed", error: "truncated" }],
    ["invalid_output", { kind: "failed", error: "invalid_output" }]
  ])("%s → triage_failed", async (kind, expected) => {
    const answer =
      kind === "refused"
        ? { kind: "refused" as const, refusalCategory: "cyber", call: CALL }
        : kind === "truncated"
          ? { kind: "truncated" as const, call: CALL }
          : { kind: "invalid_output" as const, details: ["summary:missing"], call: CALL };
    modelAnswers(() => answer);
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "failed", modelCalled: true });
    expect(row()).toMatchObject({ state: "triage_failed", triage_error: expected.error, summary: null, attempted_version: TRIAGE_VERSION });
  });

  it("input too large → triage_failed, recording the model it was too large for, without a call", async () => {
    modelAnswers(() => ({ kind: "input_too_large", estimatedTokens: 95_000 }));
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "failed", modelCalled: false });
    expect(row()).toMatchObject({ state: "triage_failed", triage_error: "input_too_large" });
  });

  it("budget → deferred_budget, and attempted_version is not stamped (the version sweep must not skip it)", async () => {
    modelAnswers(() => ({ kind: "budget" }));
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "deferred_budget", modelCalled: false });
    expect(row()).toMatchObject({ state: "deferred_budget", attempted_version: null, last_attempt_error: "budget", input_watermark: null });
  });

  it("an event run then a reconcile run on an unchanged thread make one model call", async () => {
    await handler.run(ctx(eventPayload("m1")));
    const r = await runLater(130, ctx(payload("reconcile", { messageId: "m1" }), "bulk"));
    expect(r).toMatchObject({ outcome: "unchanged", modelCalled: false });
    expect(runTriageModel).toHaveBeenCalledTimes(1);
    expect(row()?.state).toBe("triaged");
  });

  it("a refusal is not re-sent while the input is unchanged: one model call, one alert (amendments-9)", async () => {
    modelAnswers(() => ({ kind: "refused", refusalCategory: "cyber", call: CALL }));
    await handler.run(ctx(eventPayload("m1")));
    expect(await runLater(130, ctx(payload("reconcile"), "bulk"))).toMatchObject({ outcome: "unchanged" });
    expect(runTriageModel).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledTimes(1);
    const alert = vi.mocked(notifyOps).mock.calls[0][0];
    expect(alert).toEqual({ key: "email-triage-refusal:ep_1", title: "email triage refused a thread", detail: "thread th_1 (cyber)" });
  });

  it("Assess forces a model call on an unchanged thread and past the prefilter", async () => {
    specs = [{ id: "m1", sentAgo: 30, from: "Billing <no-reply@vendor.com>", subject: "Your invoice" }];
    await handler.run(ctx(payload("reconcile")));
    expect(row()?.state).toBe("filtered");
    const r = await runLater(30, ctx(payload("assess", { force: true })));
    expect(r).toMatchObject({ outcome: "triaged", modelCalled: true });
    expect(row()?.state).toBe("triaged");
    expect(await runLater(30, ctx(payload("assess", { force: true })))).toMatchObject({ modelCalled: true });
  });

  it("a flag on the anchor (its stored signals row) keeps a thread out of the Filtered bucket", async () => {
    specs = [{ id: "m1", sentAgo: 30, from: "Billing <no-reply@vendor.com>", subject: "Your invoice" }];
    await handler.run(ctx(eventPayload("m1")));
    expect(row()?.state).toBe("filtered");
    (db.email.tables.exec_email_signals ??= []).push({
      principal_id: "ep_1",
      message_id: "m1",
      thread_id: "th_1",
      account_id: "acct_1",
      direction: "inbound",
      flagged: true,
      importance: null,
      unread: null,
      removed_at: null,
      web_link: null,
      signals_at: NOW.toISOString(),
      expires_at: iso(NOW.getTime() + 180 * DAY)
    });
    expect(await runLater(200, ctx(payload("flag", { messageId: "m1" }), "bulk"))).toMatchObject({ outcome: "triaged" });
    expect(row()?.state).toBe("triaged");
  });

  it("a filtered, failed or budget outcome at the same watermark never downgrades a triaged row", async () => {
    await handler.run(ctx(payload("reconcile")));
    modelAnswers(() => ({ kind: "budget" }));
    await runLater(10, ctx(payload("assess", { force: true })));
    expect(row()).toMatchObject({ state: "triaged", last_attempt_error: "budget" });
    expect(row()?.summary).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [NEW] marks and commitments (A5, amendments-1, coherence-2)
// ---------------------------------------------------------------------------

describe("[NEW] and commitments", () => {
  it("re-triage marks [NEW] with the 120 s settle margin, and keeps a late-committed earlier-stamped message's commitment", async () => {
    // m7 is ingested (and triaged) first; m6, sent and stamped 30 s earlier, commits late.
    specs = [{ id: "m7", sentAgo: 10, createdAgo: 10 }];
    await handler.run(ctx(eventPayload("m7")));
    const stamp = Date.parse(row()?.input_watermark as string);
    specs = [{ id: "m6", dir: "outbound", sentAgo: 10.5, createdAgo: 10.5 }, { id: "m7", sentAgo: 10, createdAgo: 10 }];
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m6")]));
    await runLater(60, ctx(eventPayload("m6")));
    expect(runTriageModel).toHaveBeenCalledTimes(2);
    const [, rendered, opts] = vi.mocked(runTriageModel).mock.calls[1];
    expect(rendered.newSinceWatermarkMs).toBe(stamp - 120_000);
    // m6's ingest stamp is behind the stored watermark, yet inside the margin.
    expect(rendered.messages.find((m) => m.messageId === "m6")?.createdAtMs).toBeLessThan(stamp);
    expect(rendered.messages.find((m) => m.messageId === "m6")?.isNew).toBe(true);
    expect(opts).toMatchObject({ firstTriage: false });
    expect(commitments().map((c) => c.message_id)).toEqual(["m6"]);
  });

  it("a budget-deferred first triage, retried the next day, still extracts commitments from every message", async () => {
    specs = [{ id: "m1", sentAgo: 30 }];
    modelAnswers(() => ({ kind: "budget" }));
    await handler.run(ctx(eventPayload("m1")));
    expect(row()?.state).toBe("deferred_budget");
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m1")]));
    const r = await runLater(24 * 3600, ctx(payload("budget_retry"), "bulk"));
    expect(r).toMatchObject({ outcome: "triaged", commitmentsInserted: 1 });
    expect(vi.mocked(runTriageModel).mock.calls[0][2]).toMatchObject({ firstTriage: true });
  });

  it("a failed first triage, then Assess, extracts commitments", async () => {
    modelAnswers(() => ({ kind: "truncated", call: CALL }));
    await handler.run(ctx(eventPayload("m1")));
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m1")]));
    expect(await runLater(30, ctx(payload("assess", { force: true })))).toMatchObject({ outcome: "triaged", commitmentsInserted: 1 });
  });

  it("two triaged runs over the same message store one set of commitments", async () => {
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m1")]));
    await handler.run(ctx(eventPayload("m1")));
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "m1", { evidenceExcerpt: "a different span (m1)" })]));
    await runLater(30, ctx(payload("assess", { force: true })));
    expect(commitments()).toHaveLength(1);
  });

  it("follow-ups: a later reply of his closes what he owed; a later inbound from outside closes what was owed to him", async () => {
    specs = [{ id: "m1", sentAgo: 60 }, { id: "o1", dir: "outbound", sentAgo: 50 }];
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "o1"), commitmentFrom(r, "m1")]));
    await handler.run(ctx(eventPayload("o1")));
    expect(commitments().map((c) => c.status)).toEqual(["open", "open"]);

    // An internal colleague's message doesn't follow up what the client owes; his non-automated reply does follow up his.
    specs = [...specs, { id: "i2", sentAgo: 20, from: "Pat <pat@scaledai.org>" }, { id: "o2", dir: "outbound", sentAgo: 10 }];
    modelAnswers(ok());
    const r = await runLater(30, ctx(eventPayload("o2")));
    expect(r).toMatchObject({ followedUp: 1 });
    const byMessage = Object.fromEntries(commitments().map((c) => [c.message_id, c.status]));
    expect(byMessage).toEqual({ o1: "followed_up", m1: "open" });

    specs = [...specs, { id: "m3", sentAgo: 5 }];
    expect(await runLater(30, ctx(eventPayload("m3")))).toMatchObject({ followedUp: 1 });
    expect(commitments().every((c) => c.status === "followed_up")).toBe(true);
  });

  it("a commitment already acted on when it is found is stored as followed up", async () => {
    specs = [{ id: "o1", dir: "outbound", sentAgo: 60 }, { id: "o2", dir: "outbound", sentAgo: 30 }];
    modelAnswers(ok({}, (r) => [commitmentFrom(r, "o1")]));
    await handler.run(ctx(payload("reconcile")));
    expect(commitments()[0]).toMatchObject({ status: "followed_up", followed_up_at: iso(NOW.getTime() - 30 * MIN) });
  });
});

// ---------------------------------------------------------------------------
// The attention kick (L5)
// ---------------------------------------------------------------------------

describe("the attention kick", () => {
  it("goes on the writing job's lane", async () => {
    await handler.run(ctx(payload("reconcile"), "bulk"));
    expect(kicks()[0]).toMatchObject({ lane: "bulk" });
  });

  it("is best-effort: a failed kick doesn't fail the job", async () => {
    const real = db.client as { from(t: string): unknown };
    const from = real.from.bind(real);
    vi.spyOn(real, "from").mockImplementation((t: string) => {
      if (t !== "exec_jobs") return from(t);
      return { upsert: () => ({ select: () => Promise.resolve({ data: null, error: { message: "jobs table unavailable" } }) }) };
    });
    expect(await handler.run(ctx(payload("reconcile")))).toMatchObject({ outcome: "triaged" });
    expect(row()?.state).toBe("triaged");
  });

  it("no write, no kick", async () => {
    await handler.run(ctx(payload("reconcile")));
    const before = kicks().length;
    vi.mocked(readPrincipalThread).mockResolvedValueOnce({ kind: "not_his" });
    await runLater(70, ctx(payload("reconcile")));
    expect(kicks()).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  const thread = (list: MailSpec[]) => threadOf(list);

  it("watermarkOf is the max ingest time over the messages given", () => {
    const t = thread([{ id: "a", createdAgo: 5 }, { id: "b", createdAgo: 2 }]);
    expect(watermarkOf(t.his)).toBe(NOW.getTime() - 2 * MIN);
    expect(watermarkOf([{ ...t.his[0], createdAtMs: null }])).toBeNull();
  });

  it("ownAddressesOf is his DD email plus his mailboxes' addresses", () => {
    expect(ownAddressesOf(P, null)).toEqual(new Set(["mitchell@scaledai.org"]));
    const state = { checkedAt: NOW.toISOString(), accounts: [{ id: "a", email: "ceo@scaledai.org", lastSyncedAt: null, lastSyncError: null, lastSyncErrorAt: null }], problems: [] };
    expect(ownAddressesOf(P, state)).toEqual(new Set(["mitchell@scaledai.org", "ceo@scaledai.org"]));
  });

  it("buildFacts: an outbound-only thread's counterpart is his newest recipient; correspondents leave him out and cap at 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => `P${i} <p${i}@x.com>`);
    const t = thread([{ id: "o1", dir: "outbound", sentAgo: 10, to: many }]);
    const own = new Set(["mitchell@scaledai.org"]);
    const f = buildFacts(t, t.his, computeAnswered(t.his, { ownAddresses: own }), NO_MATCH, own);
    expect(f).toMatchObject({ counterpartEmail: "p0@x.com", counterpartName: "P0", newestInboundMessageId: null, answeredState: "no_inbound" });
    expect(f.correspondents).toHaveLength(50);
    expect(f.correspondents).not.toContain("mitchell@scaledai.org");
  });

  it("followUpOf ignores automated replies and the team's own inbound mail", () => {
    const t = thread([
      { id: "m1", sentAgo: 60 },
      { id: "o1", dir: "outbound", sentAgo: 50, automated: true },
      { id: "i1", sentAgo: 40, from: "Pat <pat@scaledai.org>" }
    ]);
    const own = new Set(["mitchell@scaledai.org"]);
    const at = iso(NOW.getTime() - 60 * MIN);
    expect(followUpOf("mitchell_owes", at, t.his, (e) => e.endsWith("@scaledai.org"), own)).toBeNull();
    expect(followUpOf("owed_to_mitchell", at, t.his, (e) => e.endsWith("@scaledai.org"), own)).toBeNull();
    expect(followUpOf("owed_to_mitchell", "not a date", t.his, () => false, own)).toBeNull();
  });

  it("isUnchanged needs the same hash, an outcome watermark at least as new, and a standing assessment", () => {
    const stored = { state: "triaged", triageError: null, contentHash: "h", outcomeWatermark: iso(1000) } as Parameters<typeof isUnchanged>[0];
    expect(isUnchanged(stored, "h", 1000, false)).toBe(true);
    expect(isUnchanged(stored, "h", 1001, false)).toBe(false);
    expect(isUnchanged(stored, "other", 1000, false)).toBe(false);
    expect(isUnchanged(stored, "h", 1000, true)).toBe(false);
    expect(isUnchanged({ ...stored!, state: "triage_failed", triageError: "refusal" }, "h", 1000, false)).toBe(true);
    expect(isUnchanged({ ...stored!, state: "triage_failed", triageError: "truncated" }, "h", 1000, false)).toBe(false);
    expect(isUnchanged({ ...stored!, state: "filtered" }, "h", 1000, false)).toBe(false);
    expect(isUnchanged(null, "h", 1000, false)).toBe(false);
  });
});

describe("loadPrincipalById is never used by the handler (it runs under the runner's principal)", () => {
  it("does not load principals", async () => {
    await handler.run(ctx(payload("reconcile")));
    expect(loadPrincipalById).not.toHaveBeenCalled();
  });
});
