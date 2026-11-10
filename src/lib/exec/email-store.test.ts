import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// Area E's attention.ts provides deleteEmailAttentionForThreads; the store's
// tombstone procedure is tested against this fake E.
const fakeE = vi.hoisted(() => ({ deleteEmailAttentionForThreads: vi.fn() }));
vi.mock("@/lib/exec/attention", () => fakeE);
// P5b's chat store (contract §3.18; its own suite is chat-store.test.ts) and P4's purge by id (Area F's
// drafts-store.test.ts) are fakes here: the tombstone procedure's chat steps are tested against them (T72).
const fakeChat = vi.hoisted(() => ({ redactChatForThreads: vi.fn(), listChatDraftIdsForThreads: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => fakeChat);
const fakeF = vi.hoisted(() => ({ purgeDraftsByIds: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/drafts-store")>()),
  purgeDraftsByIds: fakeF.purgeDraftsByIds
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, loadScreeningPolicy: vi.fn() };
});

import { createFakeEmailDb, type FakeEmailDb, type Row } from "@/lib/exec/__tests__/fake-email-db";
import { planThreadWrite, tombstonePatch, TOMBSTONE_EMPTY, type ThreadFacts, type ThreadProposal, type TriageAiFields } from "@/lib/exec/email-state";
import {
  applyThreadProposal,
  bucketOf,
  commitmentFingerprint,
  deleteCommitmentsForThreads,
  deleteSignalsForThreads,
  getEmailThread,
  listBucketRows,
  listCommitmentMessageIds,
  listCommitments,
  listCorrespondentRows,
  listProducerThreads,
  listRescreenBatch,
  listSignalsForMessages,
  listStaleThreads,
  listThreadScreenRows,
  listTombstonedThreadIds,
  purgeExpiredEmailRows,
  setCommitmentStatus,
  stampScreened,
  THREAD_COLUMNS,
  TOMBSTONE_ATTEMPTS,
  upsertCommitments,
  upsertEmailSignals,
  WRITE_ATTEMPTS,
  type BucketRow
} from "@/lib/exec/email-store";
import type { EmailSignalInput, ExecEmailSignal, ExecEmailThread, NewCommitment, ThreadSnapshot } from "@/lib/exec/email-types";
import { principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { loadScreeningPolicy, restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { TRIAGE_VERSION } from "@/lib/exec/triage/email";
import { NonRetryableError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-04T12:00:00.000Z");
const T0 = Date.parse("2026-11-04T11:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function mint(id = "ep_1", accounts: string[] = ["acc_1"]): ExecPrincipal {
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
const H = restrictedPolicyHash("hidden", RULES);
const H_NONE = restrictedPolicyHash("hidden", []);
const H_OLD = "0".repeat(64);
const policy = (rules: RestrictedSenderRule[] = RULES) => ({ rules, hash: restrictedPolicyHash("hidden", rules) });

const hashes = (...addrs: string[]) => screenHashesFor({ all: [{ from: addrs[0] ?? "", to: addrs.slice(1), cc: [] }], participants: [] }).hashes;
const CLEAN = hashes("a@client.com", "mitchell@scaledai.org");
const RESTRICTED = hashes("a@client.com", "mitchell@scaledai.org", "x@restricted.com");

const snap = (readStartedAtMs: number, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({
  identityCount: 2,
  maxCreatedAtMs: T0,
  maxSentAtMs: T0,
  readStartedAtMs,
  readDoneAtMs: readStartedAtMs + 300,
  ...over
});

const FACTS: ThreadFacts = {
  accountId: "acc_1",
  subject: "Renewal",
  counterpartName: "Ann",
  counterpartEmail: "a@client.com",
  correspondents: ["a@client.com"],
  messageCount: 2,
  newestMessageId: "m2",
  newestInboundMessageId: "m2",
  newestOutboundMessageId: "m1",
  lastInboundAt: iso(T0),
  lastOutboundAt: iso(T0 - 3_600_000),
  newestIsOutbound: false,
  answeredState: "awaiting_reply",
  answeredAt: null,
  answeredMessageId: null,
  partialThread: false,
  outboundAutomatedOnly: false,
  clientId: "c_1",
  clientName: "Client Co",
  clientMatchVia: "exact",
  matchConfidence: "high",
  clientCandidates: 1
};
const AI: TriageAiFields = {
  summary: "Asks about the renewal",
  reason: "Client question",
  category: "client",
  urgency: "high",
  importance: "high",
  needsReply: true,
  mitchellPersonally: true,
  awaitingReplyFromOthers: false,
  decisionQuestion: "Renew?",
  decisionMessageId: "m2",
  clientSignal: "none",
  automated: false,
  injectionSuspected: false
};
const RUN = { contentHash: "b".repeat(64), model: "claude-haiku-5-5", triageVersion: TRIAGE_VERSION, inputTruncated: false, bodySource: "html" as const };

function commitment(messageId: string, over: Partial<NewCommitment> = {}): NewCommitment {
  return {
    source: "email",
    threadId: "th_1",
    messageId,
    accountId: "acc_1",
    direction: "mitchell_owes",
    text: `Send the deck (${messageId})`,
    counterparty: "Ann",
    dueAt: null,
    dueText: null,
    evidenceExcerpt: `I'll send the deck (${messageId})`,
    sourceRef: { system: "dd", id: "th_1", url: null, label: "Renewal", class: "private" },
    messageSentAt: iso(T0),
    messageCreatedAtMs: T0,
    bornFollowedUpAt: null,
    ...over
  };
}

type TriageP = Extract<ThreadProposal, { kind: "triage" }>;
function triage(over: Partial<TriageP> = {}): TriageP {
  return {
    kind: "triage",
    snapshot: snap(T0 + 70_000, { identityCount: 3, maxCreatedAtMs: T0 + 50_000 }),
    screen: { verdict: "clean", hashes: CLEAN, truncated: false },
    policyHash: H,
    facts: FACTS,
    outcome: { kind: "triaged", watermarkMs: T0 + 50_000, ai: AI, run: RUN },
    commitments: [],
    ...over
  };
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toDb = (o: Record<string, unknown>): Row => Object.fromEntries(Object.entries(o).map(([k, v]) => [snake(k), v]));

/** A stored triaged thread row (snake_case), the way the planner writes one. */
function threadRow(over: Partial<ExecEmailThread> = {}, threadId = "th_1", principalId = "ep_1"): Row {
  const plan = planThreadWrite(null, triage(), { rules: RULES, currentPolicyHash: H, now: new Date(T0 + 80_000), retentionDays: 180 });
  if (plan.action !== "write") throw new Error("fixture row did not plan");
  return toDb({ principalId, threadId, version: 1, updatedAt: iso(T0 + 80_000), ...plan.patch, ...over });
}

function tombstoneDbRow(over: Partial<ExecEmailThread> = {}, threadId = "th_1"): Row {
  const image = tombstonePatch(null, { snapshot: snap(T0), hashes: RESTRICTED, truncated: false, policyHash: H, accountId: "acc_1" }, {
    rules: RULES,
    currentPolicyHash: H,
    now: NOW,
    retentionDays: 180
  });
  return toDb({ principalId: "ep_1", threadId, version: 4, updatedAt: iso(T0), ...image, ...over });
}

let db: FakeEmailDb;
function useDb(cfg: Parameters<typeof createFakeEmailDb>[0] = {}) {
  db = createFakeEmailDb({ now: () => NOW, ...cfg });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

const thread = (id = "th_1") => db.tables.exec_email_threads?.find((r) => r.thread_id === id);
const ctx = { now: NOW, retentionDays: 180 };
const loader = (rules: RestrictedSenderRule[] = RULES) => vi.fn(async () => policy(rules));

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
  fakeE.deleteEmailAttentionForThreads.mockReset();
  fakeE.deleteEmailAttentionForThreads.mockImplementation(async () => {
    db.log.push("attention delete");
    return 0;
  });
  vi.mocked(loadScreeningPolicy).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Before P5b's migration both chat reads answer nothing; the P3/P4 suites below see no chat step in db.log.
  fakeChat.redactChatForThreads.mockReset();
  fakeChat.redactChatForThreads.mockResolvedValue(0);
  fakeChat.listChatDraftIdsForThreads.mockReset();
  fakeChat.listChatDraftIdsForThreads.mockResolvedValue([]);
  fakeF.purgeDraftsByIds.mockReset();
  fakeF.purgeDraftsByIds.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

describe("row mapping", () => {
  it("THREAD_COLUMNS is exactly the snake_case of every ExecEmailThread field", () => {
    const fields = Object.keys(threadRow()).sort();
    expect(Object.keys(THREAD_COLUMNS).sort()).toEqual(fields);
  });

  it("getEmailThread maps a stored row back to the camelCase shape", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    const row = await getEmailThread(P, "th_1");
    expect(row).toMatchObject({ threadId: "th_1", state: "triaged", subject: "Renewal", screenHashes: [...CLEAN].sort(), version: 1 });
  });

  it("is scoped to the principal", async () => {
    useDb({ tables: { exec_email_threads: [threadRow({}, "th_1", "ep_other")] } });
    expect(await getEmailThread(P, "th_1")).toBeNull();
  });

  it("a malformed row fails the read (fail closed), naming only the column", async () => {
    useDb({ tables: { exec_email_threads: [{ ...threadRow(), state: "pending" }] } });
    await expect(getEmailThread(P, "th_1")).rejects.toThrow(/column state is malformed/);
    useDb({ tables: { exec_email_threads: [{ ...threadRow(), screen_hashes: "x" }] } });
    await expect(getEmailThread(P, "th_1")).rejects.toThrow(/column screen_hashes is malformed/);
  });

  it("a database error throws; a missing table reads as no row (not installed)", async () => {
    useDb({ fail: () => ({ message: "timeout", code: "57014" }) });
    await expect(getEmailThread(P, "th_1")).rejects.toThrow(/exec_email_threads read failed: timeout/);
    useDb({ missing: ["exec_email_threads"] });
    expect(await getEmailThread(P, "th_1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyThreadProposal
// ---------------------------------------------------------------------------

describe("applyThreadProposal: writes", () => {
  it("no row: inserts the full image at version 1 and stores the commitments", async () => {
    useDb({ tables: { exec_email_threads: [] } });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", triage({ commitments: [commitment("m2")] }), ctx, { loadRules: loader() });
    expect(out.result).toBe("inserted");
    expect(out.commitments.map((c) => c.messageId)).toEqual(["m2"]);
    expect(thread()).toMatchObject({ version: 1, state: "triaged", subject: "Renewal", screened_policy_hash: H, attempted_version: TRIAGE_VERSION });
    expect(Object.keys(thread() ?? {}).sort()).toEqual(Object.keys(THREAD_COLUMNS).sort());
    expect(db.tables.exec_commitments).toHaveLength(1);
  });

  it("an existing row: CAS update on its version, version bumped", async () => {
    useDb({ tables: { exec_email_threads: [threadRow({ version: 7, outcomeWatermark: iso(T0), inputWatermark: iso(T0) })] } });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", triage({ facts: { ...FACTS, subject: "Renewal (2)" }, snapshot: snap(T0 + 90_000, { identityCount: 4 }) }), ctx, {
      loadRules: loader()
    });
    expect(out.result).toBe("updated");
    expect(thread()).toMatchObject({ version: 8, subject: "Renewal (2)" });
    const update = db.requests.find((r) => r.kind === "update");
    expect(update?.filters).toEqual(expect.arrayContaining([{ op: "eq", column: "version", value: 7 }]));
  });

  it("the CAS loop: a lost race re-reads and re-plans; an ordinary write gives up after WRITE_ATTEMPTS as a skip", async () => {
    let bumps = 0;
    useDb({
      tables: { exec_email_threads: [threadRow({ outcomeWatermark: iso(T0), inputWatermark: iso(T0) })] },
      before: (r, d) => {
        // Another writer lands between every read and our update.
        if (r.kind === "update" && r.target === "exec_email_threads") {
          bumps += 1;
          const row = d.tables.exec_email_threads[0];
          row.version = (row.version as number) + 1;
        }
      }
    });
    const rules = loader();
    const out = await applyThreadProposal(P, SETTINGS, "th_1", triage({ snapshot: snap(T0 + 90_000, { identityCount: 4 }) }), ctx, { loadRules: rules });
    expect(out).toEqual({ result: "skipped", reason: "conflict", commitments: [] });
    expect(bumps).toBe(WRITE_ATTEMPTS);
    // The rules were reloaded for every attempt (A1).
    expect(rules).toHaveBeenCalledTimes(WRITE_ATTEMPTS);
  });

  it("the CAS loop: succeeds on a later attempt after losing races", async () => {
    let bumps = 0;
    useDb({
      tables: { exec_email_threads: [threadRow({ outcomeWatermark: iso(T0), inputWatermark: iso(T0) })] },
      before: (r, d) => {
        if (r.kind === "update" && r.target === "exec_email_threads" && bumps < WRITE_ATTEMPTS - 1) {
          bumps += 1;
          d.tables.exec_email_threads[0].version = (d.tables.exec_email_threads[0].version as number) + 1;
        }
      }
    });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", triage({ snapshot: snap(T0 + 90_000, { identityCount: 4 }) }), ctx, { loadRules: loader() });
    expect(out.result).toBe("updated");
  });

  it("an insert that finds a row created meanwhile re-plans as an update", async () => {
    useDb({
      tables: { exec_email_threads: [] },
      before: (r, d) => {
        if (r.kind === "upsert" && d.tables.exec_email_threads.length === 0) d.tables.exec_email_threads.push(threadRow({ version: 1 }));
      }
    });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", triage({ snapshot: snap(T0 + 90_000, { identityCount: 4 }) }), ctx, { loadRules: loader() });
    expect(out.result).toBe("updated");
    expect(db.tables.exec_email_threads).toHaveLength(1);
  });

  it("commitments are stored only when the write lands, never on a skip", async () => {
    useDb({ tables: { exec_email_threads: [threadRow({ outcomeWatermark: iso(T0 + 999_999), inputWatermark: iso(T0 + 999_999) })] } });
    // An older outcome on a row that changed nothing else: noop skip.
    const stale = triage({ snapshot: snap(T0 - 60_000, { identityCount: 1 }), outcome: { kind: "triaged", watermarkMs: T0, ai: AI, run: RUN }, commitments: [commitment("m2")] });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", stale, ctx, { loadRules: loader() });
    expect(out.result).toBe("skipped");
    expect(db.log).not.toContain("rpc exec_email_insert_commitments");
  });

  it("A6.3: a tombstone that lands after the CAS takes the just-inserted commitments with it", async () => {
    useDb({
      tables: { exec_email_threads: [] },
      before: (r, d) => {
        // The re-read after the commitments insert finds a tombstone.
        if (r.kind === "select" && r.target === "exec_email_threads" && d.log.includes("rpc exec_email_insert_commitments")) {
          Object.assign(d.tables.exec_email_threads[0], tombstoneDbRow({ version: 9 }));
        }
      }
    });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", triage({ commitments: [commitment("m2")] }), ctx, { loadRules: loader() });
    expect(out.result).toBe("inserted");
    expect(out.commitments).toEqual([]);
    expect(db.tables.exec_commitments).toEqual([]);
  });

  it("settings of another principal, or a commitment of another thread, are refused before anything is written", async () => {
    useDb({ tables: { exec_email_threads: [] } });
    await expect(applyThreadProposal(P, { ...SETTINGS, principalId: "ep_2" }, "th_1", triage(), ctx, { loadRules: loader() })).rejects.toThrow(NonRetryableError);
    await expect(
      applyThreadProposal(P, SETTINGS, "th_1", triage({ commitments: [commitment("m2", { threadId: "th_9" })] }), ctx, { loadRules: loader() })
    ).rejects.toThrow(NonRetryableError);
    expect(db.requests).toEqual([]);
  });

  it("a write the database refuses for its shape is a programming error; anything else retries", async () => {
    useDb({ tables: { exec_email_threads: [] }, fail: (r) => (r.kind === "upsert" ? { message: "violates check constraint", code: "23514" } : null) });
    await expect(applyThreadProposal(P, SETTINGS, "th_1", triage(), ctx, { loadRules: loader() })).rejects.toBeInstanceOf(NonRetryableError);
    useDb({ tables: { exec_email_threads: [] }, fail: (r) => (r.kind === "upsert" ? { message: "connection reset" } : null) });
    const err = await applyThreadProposal(P, SETTINGS, "th_1", triage(), ctx, { loadRules: loader() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });

  it("a rules loader failure propagates (the job retries; nothing is screened as clean)", async () => {
    useDb({ tables: { exec_email_threads: [] } });
    const failing = vi.fn(async () => {
      throw new Error("restricted-sender rules unavailable");
    });
    await expect(applyThreadProposal(P, SETTINGS, "th_1", triage(), ctx, { loadRules: failing })).rejects.toThrow(/rules unavailable/);
    expect(db.tables.exec_email_threads).toEqual([]);
  });

  it("not installed: a missing table skips with not_installed; a missing commitments RPC stores none", async () => {
    useDb({ missing: ["exec_email_threads"] });
    expect(await applyThreadProposal(P, SETTINGS, "th_1", triage(), ctx, { loadRules: loader() })).toEqual({ result: "skipped", reason: "not_installed", commitments: [] });
    useDb({ tables: { exec_email_threads: [] }, missing: ["exec_email_insert_commitments"] });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", triage({ commitments: [commitment("m2")] }), ctx, { loadRules: loader() });
    expect(out).toMatchObject({ result: "inserted", commitments: [] });
  });
});

describe("applyThreadProposal: the tombstone procedure", () => {
  it("runs in order: commitments, the whitelist row by CAS, commitments again, signals, the drafts purge (P4), attention (fake E)", async () => {
    useDb({
      tables: {
        exec_email_threads: [threadRow({ version: 3 })],
        exec_commitments: [{ id: "ec_1", principal_id: "ep_1", thread_id: "th_1", message_id: "m2" }],
        exec_email_signals: [{ principal_id: "ep_1", message_id: "m2", thread_id: "th_1" }]
      }
    });
    const rules = loader();
    const out = await applyThreadProposal(P, SETTINGS, "th_1", { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H }, ctx, { loadRules: rules });
    expect(out).toEqual({ result: "tombstoned", commitments: [] });
    expect(db.log).toEqual([
      "select exec_email_threads",
      "delete exec_commitments",
      "update exec_email_threads",
      "delete exec_commitments",
      "delete exec_email_signals",
      "rpc exec_drafts_purge_restricted",
      // P8 X1 (contract §3.21.1, ST06): the brief scrub right after P4's drafts purge (P9 §3.1: its _v2 RPC first).
      "rpc exec_brief_scrub_threads_v2",
      "attention delete"
    ]);
    const purge = db.requests.find((r) => r.kind === "rpc" && r.target === "exec_drafts_purge_restricted");
    expect(purge?.payload).toEqual({ p_principal: "ep_1", p_thread_ids: ["th_1"] });
    expect(fakeE.deleteEmailAttentionForThreads).toHaveBeenCalledWith(P, ["th_1"], expect.anything());
    // Tombstones need no rules: the loader is never called.
    expect(rules).not.toHaveBeenCalled();
    const row = thread() as Row;
    expect(row.state).toBe("restricted_hidden");
    for (const key of Object.keys(TOMBSTONE_EMPTY)) expect(row[snake(key)], key).toEqual((TOMBSTONE_EMPTY as Record<string, unknown>)[key]);
    expect(db.tables.exec_commitments).toEqual([]);
    expect(db.tables.exec_email_signals).toEqual([]);
  });

  it("a triage write that turns into a tombstone (a rule added between attempts) runs the procedure", async () => {
    let calls = 0;
    useDb({
      tables: { exec_email_threads: [threadRow({ screenHashes: [...RESTRICTED].sort(), outcomeWatermark: iso(T0), inputWatermark: iso(T0) })] },
      before: (r, d) => {
        // The first attempt's update loses a race.
        if (r.kind === "update" && r.target === "exec_email_threads" && calls === 0) {
          calls += 1;
          d.tables.exec_email_threads[0].version = (d.tables.exec_email_threads[0].version as number) + 1;
        }
      }
    });
    // Attempt 1: no rules (clean); attempt 2: the rule exists.
    const rules = vi.fn().mockResolvedValueOnce(policy([])).mockResolvedValue(policy(RULES));
    const p = triage({ snapshot: snap(T0 + 90_000, { identityCount: 4 }), policyHash: H_NONE, commitments: [commitment("m3")] });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", p, ctx, { loadRules: rules });
    expect(out).toEqual({ result: "tombstoned", commitments: [] });
    expect(thread()?.state).toBe("restricted_hidden");
    expect(db.log).not.toContain("rpc exec_email_insert_commitments");
    expect(fakeE.deleteEmailAttentionForThreads).toHaveBeenCalledTimes(1);
  });

  it("a tombstone that loses three CAS races still lands", async () => {
    let lost = 0;
    useDb({
      tables: { exec_email_threads: [threadRow({ version: 3 })] },
      before: (r, d) => {
        if (r.kind === "update" && r.target === "exec_email_threads" && lost < 3) {
          lost += 1;
          d.tables.exec_email_threads[0].version = (d.tables.exec_email_threads[0].version as number) + 1;
        }
      }
    });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H }, ctx);
    expect(out.result).toBe("tombstoned");
    expect(thread()?.state).toBe("restricted_hidden");
  });

  it("a triage write that becomes a tombstone gets the tombstone's attempts: it lands after more than WRITE_ATTEMPTS lost races", async () => {
    let lost = 0;
    useDb({
      tables: { exec_email_threads: [threadRow({ version: 3 })] },
      before: (r, d) => {
        if (r.kind === "update" && r.target === "exec_email_threads" && lost < WRITE_ATTEMPTS + 2) {
          lost += 1;
          d.tables.exec_email_threads[0].version = (d.tables.exec_email_threads[0].version as number) + 1;
        }
      }
    });
    const restricted = triage({ screen: { verdict: "restricted", hashes: RESTRICTED, truncated: false } });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", restricted, ctx, { loadRules: loader() });
    expect(out.result).toBe("tombstoned");
    expect(lost).toBe(WRITE_ATTEMPTS + 2);
    expect(thread()?.state).toBe("restricted_hidden");
  });

  it("a tombstone that keeps losing throws a retryable error, never a skip", async () => {
    useDb({
      tables: { exec_email_threads: [threadRow({ version: 3 })] },
      before: (r, d) => {
        if (r.kind === "update" && r.target === "exec_email_threads") d.tables.exec_email_threads[0].version = (d.tables.exec_email_threads[0].version as number) + 1;
      }
    });
    const err = await applyThreadProposal(P, SETTINGS, "th_1", { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(String(err)).toMatch(new RegExp(`${TOMBSTONE_ATTEMPTS} attempts`));
    expect(db.requests.filter((r) => r.kind === "update")).toHaveLength(TOMBSTONE_ATTEMPTS);
  });

  it("a gone proposal loads the rules once and keeps retrying like a tombstone", async () => {
    let lost = 0;
    useDb({
      tables: { exec_email_threads: [threadRow({ version: 3 })] },
      before: (r, d) => {
        if (r.kind === "update" && r.target === "exec_email_threads" && lost < 4) {
          lost += 1;
          d.tables.exec_email_threads[0].version = (d.tables.exec_email_threads[0].version as number) + 1;
        }
      }
    });
    const rules = loader();
    const out = await applyThreadProposal(P, SETTINGS, "th_1", { kind: "gone", atMs: T0 + 100_000 }, ctx, { loadRules: rules });
    expect(out.result).toBe("updated");
    expect(thread()).toMatchObject({ state: "gone", gone_at: iso(T0 + 100_000), subject: "Renewal" });
    expect(rules).toHaveBeenCalledTimes(1);
  });

  it("re-confirming an existing tombstone re-runs the procedure's last steps (a retry after a failed delete finishes them)", async () => {
    useDb({
      tables: {
        exec_email_threads: [tombstoneDbRow()],
        exec_email_signals: [{ principal_id: "ep_1", message_id: "m9", thread_id: "th_1" }]
      }
    });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", { kind: "tombstone", snapshot: null, hashes: null, truncated: null, policyHash: H }, ctx);
    expect(out).toEqual({ result: "skipped", reason: "noop", commitments: [] });
    expect(db.log).toEqual(["select exec_email_threads", "delete exec_commitments", "delete exec_email_signals", "rpc exec_drafts_purge_restricted",
      "rpc exec_brief_scrub_threads_v2", "attention delete"]);
    expect(db.tables.exec_email_signals).toEqual([]);
  });

  // P4 contract §2.7, X4 (PX04): the drafts step sits after the signals delete and before the attention delete.
  it("PX04: the drafts purge empties the thread's exec_drafts rows; the RPC missing lets the tombstone complete; an RPC error throws (retryable)", async () => {
    const draft = (id: string, threadId: string, over: Row = {}) => ({
      id, principal_id: "ep_1", account_id: "acc_1", kind: "reply", origin: "web", status: "saved", prior_status: null, version: 1, saved_version: 1, generation_seq: 1,
      thread_id: threadId, parent_message_id: "m1", reply_mode: "reply", thread_subject: "Renewal", reply_candidates: null, thread_addresses: ["a@client.com"],
      to_recipients: [{ address: "a@client.com", name: null }], cc_recipients: [], bcc_recipients: [], subject: null, body_doc: null, body_html: "<p>x</p>", body_text: "x",
      instruction: "x", note_for_mitchell: null, placeholders: [], review_recipients: null, recipients_sig: null, screen_hashes: [], screen_truncated: false,
      screened_policy_hash: null, render_nonce: "abcdefabcdefabcdef012345", model: null, usage: null, generation_error: null, generation_flags: [], facts_status: null,
      client_id: null, generated_at: null, outlook_graph_id: "AAMk=", internet_message_id: null, conversation_id: null, web_link: null, content_hash: null,
      observed_content_hash: null, review_hash: null, review_at: null, review_blockers: [], confirm_hash: null, save_attempt_key: null, save_version: null,
      save_timezone: null, save_if_content_hash: null, save_started_at: null, discard_attempt_key: null, discard_started_at: null, send_attempt_key: null,
      send_started_at: null, send_accepted_at: null, sent_at: null, sent_audit_id: null, sent_mismatch: false, unverified: false, gone_unconfirmed: false,
      signature_skipped: false, outlook_edited: false, restricted_purged: false, uses_private_refs: false, clone_flags: [], owner_resolution: null,
      opened_in_outlook_at: null, last_error_code: null, last_error_at: null, next_check_at: null, check_count: 0, gone_at: null, created_at: iso(T0),
      updated_at: iso(T0), terminal_at: null, content_purged_at: null, expires_at: null, ...over
    });
    useDb({ tables: { exec_email_threads: [threadRow({ version: 3 })], exec_drafts: [draft("ed_1", "th_1"), draft("ed_2", "th_other")] } });
    const tombstone: ThreadProposal = { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H };
    expect((await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx)).result).toBe("tombstoned");
    expect(db.tables.exec_drafts[0]).toMatchObject({ status: "saved", restricted_purged: true, body_html: null, instruction: null, to_recipients: [], version: 2 });
    expect(db.tables.exec_drafts[1]).toMatchObject({ restricted_purged: false, instruction: "x" });
    expect(db.log.indexOf("rpc exec_drafts_purge_restricted")).toBeGreaterThan(db.log.lastIndexOf("delete exec_email_signals"));
    expect(db.log.indexOf("rpc exec_drafts_purge_restricted")).toBeLessThan(db.log.indexOf("attention delete"));

    // The P4 migration not applied: the RPC is missing and the procedure still finishes.
    useDb({ tables: { exec_email_threads: [threadRow({ version: 3 })] }, missing: ["exec_drafts_purge_restricted"] });
    expect((await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx)).result).toBe("tombstoned");
    expect(db.log).toContain("rpc exec_drafts_purge_restricted");
    expect(db.log).toContain("attention delete");

    // Any other RPC failure throws after the row is tombstoned, and the retry finishes the steps.
    useDb({
      tables: { exec_email_threads: [threadRow({ version: 3 })] },
      fail: (r) => (r.kind === "rpc" && r.target === "exec_drafts_purge_restricted" && db.log.filter((l) => l === "rpc exec_drafts_purge_restricted").length === 1 ? { message: "lock timeout", code: "55P03" } : null)
    });
    const err = await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx).catch((e: unknown) => e);
    expect(String(err)).toMatch(/exec_drafts_purge_restricted failed: lock timeout/);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(thread()?.state).toBe("restricted_hidden");
    expect(db.log).not.toContain("attention delete");
    const retry = await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx);
    expect(retry).toEqual({ result: "skipped", reason: "noop", commitments: [] });
    expect(db.log.slice(-3)).toEqual(["rpc exec_drafts_purge_restricted", "rpc exec_brief_scrub_threads_v2", "attention delete"]);
  });

  it("dd_only behaves exactly as hidden: the default loader screens under the hidden policy hash and the restricted read tombstones", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    const ddOnly: ExecSettings = { ...SETTINGS, restrictedPolicy: "dd_only" };
    const restricted = triage({ screen: { verdict: "restricted", hashes: RESTRICTED, truncated: false } });
    const out = await applyThreadProposal(P, ddOnly, "th_1", restricted, ctx);
    expect(out.result).toBe("tombstoned");
    // The loader takes the principal only: no policy argument, so nothing about dd_only can change the hash.
    expect(vi.mocked(loadScreeningPolicy).mock.calls[0][0]).toBe(P);
    expect(restrictedPolicyHash("dd_only", RULES)).toBe(restrictedPolicyHash("hidden", RULES));
  });
});

describe("the P5b chat steps of the tombstone procedure (T72, contract §3.18)", () => {
  const tombstone: ThreadProposal = { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H };
  const chatDraftIds = ["ed_00000000000000000000000000000001", "ed_00000000000000000000000000000002"];
  const logChat = () => {
    fakeChat.redactChatForThreads.mockImplementation(async () => {
      db.log.push("chat redact");
      return 2;
    });
    fakeChat.listChatDraftIdsForThreads.mockImplementation(async () => {
      db.log.push("chat draft ids");
      return chatDraftIds;
    });
    fakeF.purgeDraftsByIds.mockImplementation(async () => {
      db.log.push("chat drafts purge");
      return 1;
    });
  };

  it("after P4's X4 purge and the attention delete: redact the thread's chat answers, then purge the chat drafts on their cards by id", async () => {
    useDb({ tables: { exec_email_threads: [threadRow({ version: 3 })] } });
    logChat();
    const signal = new AbortController().signal;
    expect((await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx, { signal })).result).toBe("tombstoned");
    expect(db.log.slice(-6)).toEqual(["rpc exec_drafts_purge_restricted", "rpc exec_brief_scrub_threads_v2", "attention delete", "chat redact", "chat draft ids",
      "chat drafts purge"]);
    expect(fakeChat.redactChatForThreads).toHaveBeenCalledWith(P, ["th_1"], { signal });
    expect(fakeChat.listChatDraftIdsForThreads).toHaveBeenCalledWith(P, ["th_1"], { signal });
    expect(fakeF.purgeDraftsByIds).toHaveBeenCalledWith(P, chatDraftIds, { signal });
    expect(fakeChat.redactChatForThreads).toHaveBeenCalledTimes(1);
  });

  it("no chat draft on the reached answers: no purge call; P5b not installed (0 and []) still finishes the tombstone", async () => {
    useDb({ tables: { exec_email_threads: [threadRow({ version: 3 })] } });
    expect((await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx)).result).toBe("tombstoned");
    expect(fakeChat.redactChatForThreads).toHaveBeenCalledTimes(1);
    expect(fakeChat.listChatDraftIdsForThreads).toHaveBeenCalledTimes(1);
    expect(fakeF.purgeDraftsByIds).not.toHaveBeenCalled();
    expect(db.log.at(-1)).toBe("attention delete");
  });

  it("a failing redaction (or draft purge) throws a retryable error after the tombstone landed; the noop re-run calls the chat steps again", async () => {
    useDb({ tables: { exec_email_threads: [threadRow({ version: 3 })] } });
    logChat();
    fakeChat.redactChatForThreads.mockImplementationOnce(async () => {
      throw new Error("exec chat store: exec_chat_redact_threads failed: lock timeout (55P03)");
    });
    const err = await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx).catch((e: unknown) => e);
    expect(String(err)).toMatch(/exec_chat_redact_threads failed/);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(thread()?.state).toBe("restricted_hidden");
    expect(fakeF.purgeDraftsByIds).not.toHaveBeenCalled();
    db.log.length = 0;
    expect(await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx)).toEqual({ result: "skipped", reason: "noop", commitments: [] });
    expect(db.log.slice(-3)).toEqual(["chat redact", "chat draft ids", "chat drafts purge"]);

    fakeF.purgeDraftsByIds.mockImplementationOnce(async () => {
      throw new Error("exec drafts store: exec_drafts_purge_by_ids failed: lock timeout");
    });
    const again = await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx).catch((e: unknown) => e);
    expect(String(again)).toMatch(/exec_drafts_purge_by_ids failed/);
    expect(again).not.toBeInstanceOf(NonRetryableError);
  });

  it("a write that isn't a tombstone never touches chat", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    vi.mocked(loadScreeningPolicy).mockResolvedValue(policy(RULES));
    await applyThreadProposal(P, SETTINGS, "th_1", { kind: "gone", atMs: T0 + 100_000 }, ctx, { loadRules: loader() });
    expect(fakeChat.redactChatForThreads).not.toHaveBeenCalled();
    expect(fakeChat.listChatDraftIdsForThreads).not.toHaveBeenCalled();
    expect(fakeF.purgeDraftsByIds).not.toHaveBeenCalled();
  });
});

describe("the attention step (Area E's deleteEmailAttentionForThreads)", () => {
  it("a failing attention delete throws a retryable error after the row is tombstoned, and the retry finishes the procedure", async () => {
    useDb({
      tables: {
        exec_email_threads: [threadRow()],
        exec_email_signals: [{ principal_id: "ep_1", message_id: "m9", thread_id: "th_1" }]
      }
    });
    fakeE.deleteEmailAttentionForThreads.mockImplementationOnce(async () => {
      db.log.push("attention delete failed");
      throw new Error("exec_attention_items delete failed: connection reset");
    });
    const tombstone: ThreadProposal = { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H };
    const err = await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx).catch((e: unknown) => e);
    expect(String(err)).toMatch(/connection reset/);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    // Fail closed: the whitelist row landed before the attention step ran.
    expect(thread()?.state).toBe("restricted_hidden");

    // The job's retry: the planner finds the tombstone in place (noop), and
    // the store still runs steps 3-5, so the attention rows go this time.
    db.log.length = 0;
    const retry = await applyThreadProposal(P, SETTINGS, "th_1", tombstone, ctx);
    expect(retry).toEqual({ result: "skipped", reason: "noop", commitments: [] });
    expect(db.log).toEqual(["select exec_email_threads", "delete exec_commitments", "delete exec_email_signals", "rpc exec_drafts_purge_restricted",
      "rpc exec_brief_scrub_threads_v2", "attention delete"]);
    expect(fakeE.deleteEmailAttentionForThreads).toHaveBeenLastCalledWith(P, ["th_1"], expect.anything());
  });
});

describe("listCorrespondentRows (P4 X4 (b))", () => {
  it("every non-tombstone row of the principal with its screen columns and correspondents; not installed -> []", async () => {
    useDb({
      tables: {
        exec_email_threads: [
          threadRow({ correspondents: ["a@client.com", "b@client.com"] }, "th_1"),
          tombstoneDbRow({}, "th_t"),
          threadRow({ state: "filtered", correspondents: ["c@x.com"] }, "th_2"),
          { ...threadRow({ correspondents: ["z@other.com"] }, "th_3"), principal_id: "ep_other" }
        ]
      }
    });
    const rows = await listCorrespondentRows(P);
    expect(rows.map((r) => [r.threadId, r.state, r.correspondents])).toEqual([
      ["th_1", "triaged", ["a@client.com", "b@client.com"]],
      ["th_2", "filtered", ["c@x.com"]]
    ]);
    expect(rows[0].accountId).toBe("acc_1");
    expect(Object.keys(rows[0]).sort()).toEqual(["accountId", "correspondents", "screenHashes", "screenTruncated", "screenedPolicyHash", "state", "threadId"]);
    expect(db.requests[0].columns).toBe("thread_id,account_id,state,screen_hashes,screen_truncated,screened_policy_hash,correspondents");
    useDb({ missing: ["exec_email_threads"] });
    expect(await listCorrespondentRows(P)).toEqual([]);
    useDb({ fail: () => ({ message: "down" }) });
    await expect(listCorrespondentRows(P)).rejects.toThrow(/correspondents read failed: down/);
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("retention formulas", () => {
  it("a thread expires at its newest activity + retention; a tombstone at its previous activity + retention", async () => {
    useDb({ tables: { exec_email_threads: [] } });
    await applyThreadProposal(P, SETTINGS, "th_1", triage(), ctx, { loadRules: loader() });
    expect(thread()?.expires_at).toBe(iso(T0 + 180 * DAY));
    await applyThreadProposal(P, SETTINGS, "th_1", { kind: "tombstone", snapshot: null, hashes: RESTRICTED, truncated: false, policyHash: H }, ctx);
    expect(thread()?.expires_at).toBe(iso(T0 + 180 * DAY));
  });

  it("a commitment expires at greatest(sent, due) + retention, and a long-dated one raises its thread's expiry", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    const due = iso(T0 + 300 * DAY);
    const [c] = await upsertCommitments(P, SETTINGS, [commitment("m2", { dueAt: due })]);
    expect(c.expiresAt).toBe(iso(T0 + 480 * DAY));
    expect(thread()?.expires_at).toBe(iso(T0 + 480 * DAY));
  });

  it("signals expire at signals_at + the principal's retention", async () => {
    useDb({ tables: { exec_settings: [{ principal_id: "ep_1", retention_days_email: 30 }] } });
    await upsertEmailSignals(P, [signal("m1")]);
    expect(db.tables.exec_email_signals[0].expires_at).toBe(iso(T0 + 30 * DAY));
  });
});

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

function bucketRow(over: Partial<BucketRow> = {}): BucketRow {
  return {
    threadId: "th_1",
    accountId: "acc_1",
    state: "triaged",
    screenHashes: CLEAN,
    screenTruncated: false,
    screenedPolicyHash: H,
    subject: "Renewal",
    counterpartName: "Ann",
    counterpartEmail: "a@client.com",
    messageCount: 2,
    newestMessageId: "m2",
    newestInboundMessageId: "m2",
    newestOutboundMessageId: "m1",
    lastInboundAt: iso(NOW.getTime() - 1 * DAY),
    lastOutboundAt: iso(NOW.getTime() - 3 * DAY),
    newestIsOutbound: false,
    answeredState: "awaiting_reply",
    answeredAt: null,
    partialThread: false,
    outboundAutomatedOnly: false,
    clientId: null,
    clientName: null,
    clientMatchVia: null,
    matchConfidence: null,
    summary: null,
    reason: null,
    category: "client",
    urgency: "normal",
    importance: "normal",
    needsReply: false,
    mitchellPersonally: null,
    awaitingReplyFromOthers: false,
    decisionQuestion: null,
    clientSignal: null,
    injectionSuspected: false,
    filterReason: null,
    triageError: null,
    lastAttemptError: null,
    triagedAt: null,
    deferredAt: null,
    updatedAt: iso(NOW.getTime()),
    ...over
  };
}

type Sig = Pick<ExecEmailSignal, "messageId" | "flagged" | "removedAt">;
const sigs = (...list: Sig[]) => new Map(list.map((s) => [s.messageId, s]));
const daysAgo = (n: number) => iso(NOW.getTime() - n * DAY);

describe("bucketOf (L12), with the read-time overlay", () => {
  const cases: [string, BucketRow, Map<string, Sig>, Parameters<typeof bucketOf>[2], string[]][] = [
    ["needs reply, awaiting, 1 day", bucketRow({ needsReply: true }), sigs(), undefined, ["reply"]],
    ["needs reply at exactly 30 days", bucketRow({ needsReply: true, lastInboundAt: daysAgo(30) }), sigs(), undefined, ["reply"]],
    ["needs reply, 31 days: too old", bucketRow({ needsReply: true, lastInboundAt: daysAgo(31) }), sigs(), undefined, []],
    ["needs reply but answered", bucketRow({ needsReply: true, answeredState: "answered" }), sigs(), undefined, []],
    ["archived in Outlook (the newest inbound's signal): handled", bucketRow({ needsReply: true }), sigs({ messageId: "m2", flagged: null, removedAt: daysAgo(0) }), undefined, []],
    [
      "archive + new inbound: the archive belonged to the old message, so it is awaiting again",
      bucketRow({ needsReply: true, newestInboundMessageId: "m3", newestMessageId: "m3" }),
      sigs({ messageId: "m2", flagged: null, removedAt: daysAgo(1) }),
      undefined,
      ["reply"]
    ],
    ["a scheduled DD reply", bucketRow({ needsReply: true }), sigs(), { scheduledFor: iso(NOW.getTime() + DAY), draftPending: false }, []],
    ["a draft pending approval", bucketRow({ needsReply: true }), sigs(), { scheduledFor: null, draftPending: true }, []],
    ["urgent (high), awaiting, 14 days", bucketRow({ urgency: "high", lastInboundAt: daysAgo(14) }), sigs(), undefined, ["urgent"]],
    ["urgent (critical) with needs reply: both", bucketRow({ urgency: "critical", needsReply: true }), sigs(), undefined, ["reply", "urgent"]],
    ["urgent, 15 days: too old", bucketRow({ urgency: "high", lastInboundAt: daysAgo(15), lastOutboundAt: daysAgo(20) }), sigs(), undefined, []],
    ["important (AI), within 7 days of activity", bucketRow({ importance: "high", lastInboundAt: daysAgo(6), lastOutboundAt: daysAgo(20) }), sigs(), undefined, ["important"]],
    ["important, 8 days: too old", bucketRow({ importance: "high", lastInboundAt: daysAgo(8), lastOutboundAt: daysAgo(9) }), sigs(), undefined, []],
    ["flagged on the anchor: important", bucketRow(), sigs({ messageId: "m2", flagged: true, removedAt: null }), undefined, ["important"]],
    ["flagged on another message: not important", bucketRow(), sigs({ messageId: "m1", flagged: true, removedAt: null }), undefined, []],
    [
      "outbound-only thread flagged on its newest message: important",
      bucketRow({ newestInboundMessageId: null, newestMessageId: "m1", lastInboundAt: null, answeredState: "no_inbound", newestIsOutbound: true }),
      sigs({ messageId: "m1", flagged: true, removedAt: null }),
      undefined,
      ["important"]
    ],
    [
      "waiting on others: his outbound is newest, 2-30 days",
      bucketRow({ awaitingReplyFromOthers: true, newestIsOutbound: true, lastOutboundAt: daysAgo(2), lastInboundAt: daysAgo(10), answeredState: "answered" }),
      sigs(),
      undefined,
      ["waiting"]
    ],
    [
      "waiting, only 1 day",
      bucketRow({ awaitingReplyFromOthers: true, newestIsOutbound: true, lastOutboundAt: daysAgo(1), answeredState: "answered" }),
      sigs(),
      undefined,
      []
    ],
    [
      "waiting, automated outbound only",
      bucketRow({ awaitingReplyFromOthers: true, newestIsOutbound: true, outboundAutomatedOnly: true, lastOutboundAt: daysAgo(5), answeredState: "answered" }),
      sigs(),
      undefined,
      []
    ],
    [
      "waiting, 31 days",
      bucketRow({ awaitingReplyFromOthers: true, newestIsOutbound: true, lastOutboundAt: daysAgo(31), lastInboundAt: daysAgo(40), answeredState: "answered" }),
      sigs(),
      undefined,
      []
    ],
    ["filtered within 7 days", bucketRow({ state: "filtered", filterReason: "automated_hint" }), sigs(), undefined, ["filtered"]],
    ["triage failed within 7 days", bucketRow({ state: "triage_failed", triageError: "refusal" }), sigs(), undefined, ["filtered"]],
    ["deferred by budget within 7 days", bucketRow({ state: "deferred_budget" }), sigs(), undefined, ["filtered"]],
    ["filtered, 8 days", bucketRow({ state: "filtered", lastInboundAt: daysAgo(8), lastOutboundAt: daysAgo(9) }), sigs(), undefined, []],
    ["a tombstone is in no bucket", bucketRow({ state: "restricted_hidden", needsReply: true, importance: "high" }), sigs(), undefined, []],
    ["a gone row is in no bucket", bucketRow({ state: "gone", needsReply: true, importance: "high" }), sigs(), undefined, []]
  ];
  for (const [what, row, signals, artifacts, expected] of cases) {
    it(what, () => {
      expect(bucketOf(row, signals, artifacts, NOW)).toEqual(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

describe("commitments", () => {
  it("every RPC row has the identical key set (a mixed batch inserts)", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    const rows = [
      commitment("m1"),
      commitment("m2", { counterparty: null, dueAt: iso(T0 + 5 * DAY), dueText: "Friday", bornFollowedUpAt: iso(T0 + DAY), messageCreatedAtMs: null })
    ];
    const out = await upsertCommitments(P, SETTINGS, rows);
    expect(out).toHaveLength(2);
    const call = db.requests.find((r) => r.kind === "rpc" && r.target === "exec_email_insert_commitments");
    const sent = (call?.payload as Row).p_rows as Row[];
    expect(Object.keys(sent[0]).sort()).toEqual(Object.keys(sent[1]).sort());
    expect(sent[1]).toMatchObject({ counterparty: null, message_created_at: null, due_text: "Friday" });
  });

  it("bornFollowedUp is stored as followed_up with its time", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    const [c] = await upsertCommitments(P, SETTINGS, [commitment("m2", { bornFollowedUpAt: iso(T0 + DAY) })]);
    expect(c).toMatchObject({ status: "followed_up", followedUpAt: iso(T0 + DAY) });
    const [open] = await upsertCommitments(P, SETTINGS, [commitment("m3")]);
    expect(open).toMatchObject({ status: "open", followedUpAt: null });
  });

  it("the evidence fingerprint: stable over case and whitespace, distinct by direction, message and quote", () => {
    const base = { direction: "mitchell_owes" as const, messageId: "m1", evidenceExcerpt: "I'll send  the deck\nby Friday" };
    const fp = commitmentFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(commitmentFingerprint({ ...base, evidenceExcerpt: "  i'll SEND the deck by friday " })).toBe(fp);
    expect(commitmentFingerprint({ ...base, direction: "owed_to_mitchell" })).not.toBe(fp);
    expect(commitmentFingerprint({ ...base, messageId: "m2" })).not.toBe(fp);
    expect(commitmentFingerprint({ ...base, evidenceExcerpt: "I'll send the slides by Friday" })).not.toBe(fp);
  });

  it("one set per message: a second extraction of the same message inserts nothing (insert-time dedupe)", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    await upsertCommitments(P, SETTINGS, [commitment("m2")]);
    const again = await upsertCommitments(P, SETTINGS, [commitment("m2", { evidenceExcerpt: "a different span of the same message" })]);
    expect(again).toEqual([]);
    expect(db.tables.exec_commitments).toHaveLength(1);
  });

  it("two overlapping triaged writes on the same messages leave one set", async () => {
    useDb({ tables: { exec_email_threads: [] } });
    const p = triage({ commitments: [commitment("m2")] });
    await applyThreadProposal(P, SETTINGS, "th_1", p, ctx, { loadRules: loader() });
    const second = triage({
      snapshot: { ...p.snapshot, readStartedAtMs: p.snapshot.readStartedAtMs + 50, readDoneAtMs: p.snapshot.readDoneAtMs + 50 },
      commitments: [commitment("m2", { evidenceExcerpt: "another quote from m2" })]
    });
    const out = await applyThreadProposal(P, SETTINGS, "th_1", second, { now: new Date(NOW.getTime() + 1_000), retentionDays: 180 }, { loadRules: loader() });
    expect(out.result).toBe("updated");
    expect(db.tables.exec_commitments).toHaveLength(1);
  });

  it("never onto a tombstone or a gone thread, and never without a thread row", async () => {
    useDb({ tables: { exec_email_threads: [tombstoneDbRow(), threadRow({ state: "gone", goneAt: iso(T0) }, "th_2")] } });
    expect(await upsertCommitments(P, SETTINGS, [commitment("m2"), commitment("m5", { threadId: "th_2" }), commitment("m6", { threadId: "th_3" })])).toEqual([]);
    expect(db.tables.exec_commitments ?? []).toEqual([]);
  });

  it("calls the RPC once per thread, and the evidence quote never rides in source_ref", async () => {
    useDb({ tables: { exec_email_threads: [threadRow(), threadRow({}, "th_2")] } });
    await upsertCommitments(P, SETTINGS, [
      commitment("m1", { sourceRef: { system: "dd", id: "th_1", url: null, label: "R", class: "private", excerpt: "secret quote" } }),
      commitment("m4", { threadId: "th_2" })
    ]);
    const calls = db.requests.filter((r) => r.kind === "rpc");
    expect(calls.map((c) => (c.payload as Row).p_thread_id)).toEqual(["th_1", "th_2"]);
    expect(db.tables.exec_commitments.every((c) => !("excerpt" in (c.source_ref as Row)))).toBe(true);
  });

  it("refuses a commitment from an account outside his pin; drops one with no text", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    await expect(upsertCommitments(P, SETTINGS, [commitment("m1", { accountId: "acc_other" })])).rejects.toThrow(NonRetryableError);
    expect(await upsertCommitments(P, SETTINGS, [commitment("m1", { text: "\u0000  " })])).toEqual([]);
  });

  it("listCommitments: statuses, threads, due before, ordered by due date (undated last), limit", async () => {
    const c = (id: string, over: Row) => ({
      id,
      principal_id: "ep_1",
      fingerprint: id.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "0"),
      source: "email",
      thread_id: "th_1",
      message_id: `m_${id}`,
      account_id: "acc_1",
      direction: "mitchell_owes",
      text: "x",
      counterparty: null,
      due_at: null,
      due_text: null,
      status: "open",
      followed_up_at: null,
      evidence_excerpt: "y",
      source_ref: { system: "dd", id: "th_1", url: null, label: "R", class: "private" },
      message_sent_at: iso(T0),
      message_created_at: null,
      created_at: iso(T0),
      updated_at: iso(T0),
      expires_at: iso(T0 + 180 * DAY),
      ...over
    });
    useDb({
      tables: {
        exec_commitments: [
          c("ec_a", { due_at: iso(T0 + 3 * DAY) }),
          c("ec_b", { due_at: iso(T0 + 1 * DAY) }),
          c("ec_c", {}),
          c("ec_d", { status: "followed_up", followed_up_at: iso(T0) }),
          c("ec_e", { thread_id: "th_2", due_at: iso(T0) }),
          c("ec_f", { principal_id: "ep_other" })
        ]
      }
    });
    expect((await listCommitments(P)).map((x) => x.id)).toEqual(["ec_e", "ec_b", "ec_a", "ec_c"]);
    expect((await listCommitments(P, { threadIds: ["th_1"] })).map((x) => x.id)).toEqual(["ec_b", "ec_a", "ec_c"]);
    expect((await listCommitments(P, { dueBefore: iso(T0 + 2 * DAY) })).map((x) => x.id)).toEqual(["ec_e", "ec_b"]);
    expect((await listCommitments(P, { statuses: ["open", "followed_up"], limit: 2 })).map((x) => x.id)).toEqual(["ec_e", "ec_b"]);
    expect((await listCommitments(P, { statuses: ["followed_up"] })).map((x) => x.id)).toEqual(["ec_d"]);
    await expect(listCommitments(P, { statuses: [] })).rejects.toThrow(NonRetryableError);
    expect(await listCommitmentMessageIds(P, "th_1")).toEqual(new Set(["m_ec_a", "m_ec_b", "m_ec_c", "m_ec_d"]));
  });

  it("listCommitments fails closed on a database error and is empty when not installed", async () => {
    useDb({ fail: () => ({ message: "boom" }) });
    await expect(listCommitments(P)).rejects.toThrow(/boom/);
    useDb({ missing: ["exec_commitments"] });
    expect(await listCommitments(P)).toEqual([]);
  });

  it("setCommitmentStatus: followed_up needs its time; the others clear it", async () => {
    useDb({ tables: { exec_commitments: [{ id: "ec_1", principal_id: "ep_1", status: "open", followed_up_at: null, updated_at: iso(T0) }] } });
    await setCommitmentStatus(P, "ec_1", "followed_up", iso(T0 + DAY), { now: NOW });
    expect(db.tables.exec_commitments[0]).toMatchObject({ status: "followed_up", followed_up_at: iso(T0 + DAY), updated_at: NOW.toISOString() });
    // A compare-and-set on the status: the expiry sweep can't overwrite a follow-up.
    await setCommitmentStatus(P, "ec_1", "expired", null, { now: NOW, expectStatus: "open" });
    expect(db.tables.exec_commitments[0]).toMatchObject({ status: "followed_up" });
    await setCommitmentStatus(P, "ec_1", "expired", iso(T0 + DAY), { now: NOW });
    expect(db.tables.exec_commitments[0]).toMatchObject({ status: "expired", followed_up_at: null });
    await expect(setCommitmentStatus(P, "ec_1", "followed_up", null)).rejects.toThrow(NonRetryableError);
  });

  it("deleteCommitmentsForThreads deletes only the principal's rows of those threads", async () => {
    useDb({
      tables: {
        exec_commitments: [
          { id: "1", principal_id: "ep_1", thread_id: "th_1" },
          { id: "2", principal_id: "ep_1", thread_id: "th_2" },
          { id: "3", principal_id: "ep_other", thread_id: "th_1" }
        ]
      }
    });
    expect(await deleteCommitmentsForThreads(P, ["th_1"])).toBe(1);
    expect(db.tables.exec_commitments.map((r) => r.id)).toEqual(["2", "3"]);
  });
});

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function signal(messageId: string, over: Partial<EmailSignalInput> = {}): EmailSignalInput {
  return {
    messageId,
    threadId: "th_1",
    accountId: "acc_1",
    direction: "inbound",
    flagged: false,
    importance: "normal",
    unread: true,
    removedAt: null,
    webLink: "https://outlook.office365.com/owa/?ItemID=abc",
    signalsAt: iso(T0),
    ...over
  };
}

describe("signals", () => {
  it("one row per message (the newest stamp wins), malformed fields nulled, malformed rows dropped, identical keys", async () => {
    useDb();
    const written = await upsertEmailSignals(P, [
      signal("m1", { signalsAt: iso(T0) }),
      signal("m1", { signalsAt: iso(T0 + 5), flagged: true }),
      signal("m2", { importance: "urgent" as never, webLink: "javascript:alert(1)" }),
      signal("m3", { direction: "sideways" as never }),
      signal("m4", { signalsAt: "not a time" }),
      signal("m5", { webLink: "http://outlook.office365.com/owa/?ItemID=plain" }),
      signal("m6", { webLink: `https://${"x".repeat(2041)}` })
    ]);
    expect(written).toBe(4);
    const call = db.requests.find((r) => r.kind === "rpc");
    const rows = (call?.payload as Row).p_rows as Row[];
    expect(rows.map((r) => r.message_id)).toEqual(["m1", "m2", "m5", "m6"]);
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(rows[1]).sort());
    expect(rows[0]).toMatchObject({ flagged: true, signals_at: iso(T0 + 5) });
    expect(rows[1]).toMatchObject({ importance: null, web_link: null });
    // The wrapper itself drops a link that isn't https or is too long (it is rendered as a link).
    expect(rows[2]).toMatchObject({ web_link: null });
    expect(rows[3]).toMatchObject({ web_link: null });
  });

  it("chunks by 200 and sums what was written", async () => {
    useDb();
    const many = Array.from({ length: 450 }, (_, i) => signal(`m${i}`));
    expect(await upsertEmailSignals(P, many)).toBe(450);
    expect(db.requests.filter((r) => r.kind === "rpc").map((r) => ((r.payload as Row).p_rows as Row[]).length)).toEqual([200, 200, 50]);
  });

  it("monotonic, and nothing for a tombstoned thread (the RPC's rules)", async () => {
    useDb({ tables: { exec_email_threads: [tombstoneDbRow({}, "th_t")] } });
    await upsertEmailSignals(P, [signal("m1", { signalsAt: iso(T0 + 10) })]);
    await upsertEmailSignals(P, [signal("m1", { signalsAt: iso(T0), flagged: true })]);
    expect(db.tables.exec_email_signals[0]).toMatchObject({ flagged: false, signals_at: iso(T0 + 10) });
    expect(await upsertEmailSignals(P, [signal("m9", { threadId: "th_t" })])).toBe(0);
  });

  it("a signal from outside his pin is refused", async () => {
    useDb();
    await expect(upsertEmailSignals(P, [signal("m1", { accountId: "acc_other" })])).rejects.toThrow(NonRetryableError);
  });

  it("listSignalsForMessages reads by message id; deleteSignalsForThreads deletes by thread", async () => {
    useDb();
    await upsertEmailSignals(P, [signal("m1"), signal("m2", { threadId: "th_2", removedAt: iso(T0 + 1) })]);
    const got = await listSignalsForMessages(P, ["m1", "m2", "m3"]);
    expect([...got.keys()].sort()).toEqual(["m1", "m2"]);
    expect(got.get("m2")).toMatchObject({ threadId: "th_2", removedAt: iso(T0 + 1) });
    expect(await deleteSignalsForThreads(P, ["th_2"])).toBe(1);
    expect([...(await listSignalsForMessages(P, ["m1", "m2"])).keys()]).toEqual(["m1"]);
  });

  it("not installed: writes 0, reads none", async () => {
    useDb({ missing: ["exec_email_upsert_signals", "exec_email_signals"] });
    expect(await upsertEmailSignals(P, [signal("m1")])).toBe(0);
    expect(await listSignalsForMessages(P, ["m1"])).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// List reads
// ---------------------------------------------------------------------------

describe("list reads", () => {
  const recent = iso(NOW.getTime() - DAY);
  const old = iso(NOW.getTime() - 40 * DAY);

  it("listBucketRows: no tombstones, no gone rows, no rows older than 30 days; outbound-only activity counts", async () => {
    useDb({
      tables: {
        exec_email_threads: [
          threadRow({ lastInboundAt: recent }, "th_a"),
          threadRow({ lastInboundAt: null, lastOutboundAt: recent }, "th_b"),
          threadRow({ lastInboundAt: old, lastOutboundAt: old }, "th_c"),
          tombstoneDbRow({}, "th_d"),
          threadRow({ state: "gone", goneAt: recent, lastInboundAt: recent }, "th_e"),
          threadRow({ lastInboundAt: recent }, "th_f", "ep_other")
        ]
      }
    });
    const rows = await listBucketRows(P, NOW);
    expect(rows.map((r) => r.threadId)).toEqual(["th_a", "th_b"]);
    expect(rows[0]).toHaveProperty("screenHashes");
    expect(rows[0]).not.toHaveProperty("contentHash");
  });

  it("listProducerThreads: triaged rows in the window, with the screen columns", async () => {
    useDb({
      tables: {
        exec_email_threads: [
          threadRow({ lastInboundAt: recent }, "th_a"),
          threadRow({ lastInboundAt: recent, state: "filtered", filterReason: "unreplyable" }, "th_b"),
          threadRow({ lastInboundAt: old, lastOutboundAt: old }, "th_c")
        ]
      }
    });
    const rows = await listProducerThreads(P, NOW);
    expect(rows.map((r) => r.threadId)).toEqual(["th_a"]);
    expect(rows[0]).toMatchObject({ screenTruncated: false, screenedPolicyHash: H });
  });

  it("listRescreenBatch: rows screened under another policy (or never), by tier, keyset by thread id", async () => {
    useDb({
      tables: {
        exec_email_threads: [
          threadRow({ lastInboundAt: recent, screenedPolicyHash: H_OLD }, "th_a"),
          threadRow({ lastInboundAt: recent, screenedPolicyHash: H }, "th_b"),
          threadRow({ lastInboundAt: recent, screenedPolicyHash: null }, "th_c"),
          threadRow({ lastInboundAt: old, lastOutboundAt: old, screenedPolicyHash: H_OLD }, "th_d"),
          tombstoneDbRow({ screenedPolicyHash: H_OLD }, "th_e")
        ]
      }
    });
    const producer = await listRescreenBatch(P, H, { tier: "producer", afterThreadId: null, limit: 10, now: NOW });
    expect(producer.map((r) => r.threadId)).toEqual(["th_a", "th_c"]);
    const rest = await listRescreenBatch(P, H, { tier: "rest", afterThreadId: null, limit: 10 });
    expect(rest.map((r) => r.threadId)).toEqual(["th_a", "th_c", "th_d", "th_e"]);
    const page2 = await listRescreenBatch(P, H, { tier: "rest", afterThreadId: "th_c", limit: 1 });
    expect(page2.map((r) => r.threadId)).toEqual(["th_d"]);
    expect(page2[0]).toEqual({
      threadId: "th_d",
      version: 1,
      state: "triaged",
      screenHashes: [...CLEAN].sort(),
      screenTruncated: false,
      accountId: "acc_1",
      screenedPolicyHash: H_OLD
    });
  });

  it("listTombstonedThreadIds and listThreadScreenRows (any state and age)", async () => {
    useDb({ tables: { exec_email_threads: [tombstoneDbRow({}, "th_t"), threadRow({ lastInboundAt: old, lastOutboundAt: old }, "th_old")] } });
    expect(await listTombstonedThreadIds(P)).toEqual(["th_t"]);
    const screen = await listThreadScreenRows(P, ["th_t", "th_old", "th_missing"]);
    expect([...screen.keys()].sort()).toEqual(["th_old", "th_t"]);
    expect(screen.get("th_t")).toEqual({
      threadId: "th_t",
      accountId: "acc_1",
      state: "restricted_hidden",
      screenHashes: [...RESTRICTED].sort(),
      screenTruncated: false,
      screenedPolicyHash: H
    });
  });

  it("listStaleThreads: version sweep and budget sweep (before the local day start)", async () => {
    const dayStart = iso(NOW.getTime() - 2 * 3_600_000);
    useDb({
      tables: {
        exec_email_threads: [
          threadRow({ attemptedVersion: "email-triage-v0" }, "th_a"),
          threadRow({ attemptedVersion: null }, "th_b"),
          threadRow({ attemptedVersion: TRIAGE_VERSION }, "th_c"),
          threadRow({ state: "deferred_budget", deferredAt: iso(NOW.getTime() - 5 * 3_600_000) }, "th_d"),
          threadRow({ state: "deferred_budget", deferredAt: iso(NOW.getTime() - 3_600_000) }, "th_e"),
          threadRow({ lastAttemptError: "budget", lastAttemptAt: iso(NOW.getTime() - 5 * 3_600_000) }, "th_f")
        ]
      }
    });
    // Triaged rows last attempted under another version (or never): not th_c (current), not the deferred ones.
    expect((await listStaleThreads(P, { kind: "version", limit: 50 })).map((r) => r.threadId)).toEqual(["th_a", "th_b"]);
    expect(await listStaleThreads(P, { kind: "deferred_budget", before: dayStart, limit: 50 })).toEqual([
      { threadId: "th_d", accountId: "acc_1" },
      { threadId: "th_f", accountId: "acc_1" }
    ]);
    await expect(listStaleThreads(P, { kind: "deferred_budget", limit: 50 })).rejects.toThrow(NonRetryableError);
    expect((await listStaleThreads(P, { kind: "deferred_budget", before: dayStart, afterThreadId: "th_d", limit: 50 })).map((r) => r.threadId)).toEqual(["th_f"]);
  });

  it("reads fail closed: a database error throws, never an empty list", async () => {
    useDb({ fail: () => ({ message: "upstream error" }) });
    await expect(listBucketRows(P, NOW)).rejects.toThrow(/upstream error/);
    await expect(listProducerThreads(P, NOW)).rejects.toThrow(/upstream error/);
    await expect(listThreadScreenRows(P, ["th_1"])).rejects.toThrow(/upstream error/);
    await expect(listTombstonedThreadIds(P)).rejects.toThrow(/upstream error/);
    await expect(listSignalsForMessages(P, ["m1"])).rejects.toThrow(/upstream error/);
  });

  it("not installed: empty, not an error", async () => {
    useDb({ missing: ["exec_email_threads"] });
    expect(await listBucketRows(P, NOW)).toEqual([]);
    expect(await listThreadScreenRows(P, ["th_1"])).toEqual(new Map());
    expect(await listRescreenBatch(P, H, { tier: "rest", afterThreadId: null, limit: 5 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The stamp RPC wrapper
// ---------------------------------------------------------------------------

describe("stampScreened", () => {
  it("chunks by 200, sends thread ids and versions, sums the stamped counts (stale versions are left)", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => threadRow({ version: 2 }, `th_${String(i).padStart(3, "0")}`));
    useDb({ tables: { exec_email_threads: rows } });
    const items = rows.map((r, i) => ({ threadId: r.thread_id as string, version: i === 0 ? 1 : 2 }));
    expect(await stampScreened(P, items, H_NONE)).toBe(449);
    const calls = db.requests.filter((r) => r.kind === "rpc");
    expect(calls.map((c) => ((c.payload as Row).p_items as Row[]).length)).toEqual([200, 200, 50]);
    expect((calls[0].payload as Row).p_items).toEqual(expect.arrayContaining([{ thread_id: "th_001", version: 2 }]));
    expect(thread("th_001")).toMatchObject({ screened_policy_hash: H_NONE, version: 3 });
    expect(thread("th_000")).toMatchObject({ screened_policy_hash: H, version: 2 });
  });

  it("refuses a malformed hash or version; not installed stamps nothing", async () => {
    useDb();
    await expect(stampScreened(P, [{ threadId: "th_1", version: 1 }], "nope")).rejects.toThrow(NonRetryableError);
    await expect(stampScreened(P, [{ threadId: "th_1", version: 0 }], H)).rejects.toThrow(NonRetryableError);
    useDb({ missing: ["exec_email_stamp_screened"] });
    expect(await stampScreened(P, [{ threadId: "th_1", version: 1 }], H)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

describe("purgeExpiredEmailRows", () => {
  const past = iso(NOW.getTime() - DAY);
  const future = iso(NOW.getTime() + DAY);
  const attention = (id: string, fingerprint: string, principalId = "ep_1") => ({ id, principal_id: principalId, source: "email", fingerprint });
  const commitmentRow = (id: string, threadId: string, expiresAt: string, principalId = "ep_1") => ({ id, principal_id: principalId, thread_id: threadId, expires_at: expiresAt });

  it("deletes expired threads (with their commitments and signals), expired commitments and signals, and orphaned attention rows", async () => {
    useDb({
      tables: {
        exec_email_threads: [
          threadRow({ expiresAt: past }, "th_old"),
          threadRow({ expiresAt: future }, "th_live"),
          threadRow({ expiresAt: past }, "th_kept"), // has an unexpired commitment
          threadRow({ expiresAt: past }, "th_other", "ep_2")
        ],
        exec_commitments: [
          commitmentRow("ec_old", "th_old", past),
          commitmentRow("ec_long", "th_kept", future),
          commitmentRow("ec_expired_live", "th_live", past),
          commitmentRow("ec_live", "th_live", future)
        ],
        exec_email_signals: [
          { principal_id: "ep_1", message_id: "s1", thread_id: "th_old", expires_at: future },
          { principal_id: "ep_1", message_id: "s2", thread_id: "th_live", expires_at: past },
          { principal_id: "ep_1", message_id: "s3", thread_id: "th_live", expires_at: future }
        ],
        exec_attention_items: [
          attention("ea_1", "email:thread:th_old:m2"),
          attention("ea_2", "email:commitment:th_old:ec_old"),
          attention("ea_3", "email:thread:th_live:m2"),
          attention("ea_4", "email:commitment:th_live:ec_expired_live"),
          attention("ea_5", "email:commitment:th_live:ec_live"),
          attention("ea_6", "email:satisfaction:c_1"),
          attention("ea_7", "email:health:c_1"),
          attention("ea_8", "email:thread:th_other:m1", "ep_2"),
          { id: "ea_9", principal_id: "ep_1", source: "dd", fingerprint: "dd:overdue:x" }
        ]
      }
    });
    const counts = await purgeExpiredEmailRows(NOW);
    // th_old and ep_2's th_other go; th_kept stays for its live commitment.
    expect(counts).toEqual({ threads: 2, commitments: 2, signals: 2, attentionRows: 4 });
    expect(db.tables.exec_email_threads.map((r) => r.thread_id).sort()).toEqual(["th_kept", "th_live"]);
    expect(db.tables.exec_commitments.map((r) => r.id).sort()).toEqual(["ec_live", "ec_long"]);
    expect(db.tables.exec_email_signals.map((r) => r.message_id)).toEqual(["s3"]);
    expect(db.tables.exec_attention_items.map((r) => r.id).sort()).toEqual(["ea_3", "ea_5", "ea_6", "ea_7", "ea_9"]);
  });

  it("amendments-10: a commitment due in 300 days outlives its thread's activity retention and is still screenable", async () => {
    useDb({ tables: { exec_email_threads: [threadRow()] } });
    await upsertCommitments(P, SETTINGS, [commitment("m2", { dueAt: iso(T0 + 300 * DAY) })]);
    // 200 days later: past the thread's own activity retention (180 d), before the commitment's.
    const later = new Date(T0 + 200 * DAY);
    const counts = await purgeExpiredEmailRows(later);
    expect(counts.threads).toBe(0);
    expect((await listThreadScreenRows(P, ["th_1"])).has("th_1")).toBe(true);
    expect(await listCommitments(P)).toHaveLength(1);
    // Even if a later rewrite pulled the thread's expiry back, the purge keeps it while the commitment lives.
    (db.tables.exec_email_threads[0] as Row).expires_at = iso(T0 + 180 * DAY);
    expect((await purgeExpiredEmailRows(later)).threads).toBe(0);
  });

  it("missing tables count 0 (the migration isn't applied)", async () => {
    useDb({ missing: ["exec_email_threads", "exec_commitments", "exec_email_signals", "exec_attention_items"] });
    expect(await purgeExpiredEmailRows(NOW)).toEqual({ threads: 0, commitments: 0, attentionRows: 0, signals: 0 });
  });

  it("a database error throws (the purge job retries)", async () => {
    useDb({ tables: { exec_email_threads: [threadRow({ expiresAt: past })] }, fail: (r) => (r.kind === "delete" ? { message: "lock timeout" } : null) });
    await expect(purgeExpiredEmailRows(NOW)).rejects.toThrow(/lock timeout/);
  });
});
