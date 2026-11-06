import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// exec.email-attention (contract §3.13, L5, L24, A6, addenda §1.1/§1.7/§1.8):
// the lease, the gates, the policy step (tiers, bulk stamp, tombstones,
// re-triage, generations, laps, the time box, the rest cursor), both safety
// nets, the reads-then-sync rule, the health snapshot, commitment expiry and
// orphaned items. The store, the DD reads and the enqueue helpers are mocked
// (each has its own suite); the state machine's stamp rule, the restricted
// screen and the producer are the real ones.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/attention")>();
  return {
    ...actual,
    syncAttention: vi.fn(),
    deleteEmailAttentionForThreads: vi.fn(),
    deleteAttentionItemsByIds: vi.fn(),
    listAllEmailAttentionRows: vi.fn()
  };
});
vi.mock("@/lib/exec/email-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/email-store")>();
  return {
    ...actual,
    applyThreadProposal: vi.fn(),
    deleteCommitmentsForThreads: vi.fn(),
    deleteSignalsForThreads: vi.fn(),
    listCommitments: vi.fn(),
    listProducerThreads: vi.fn(),
    listRescreenBatch: vi.fn(),
    listSignalsForMessages: vi.fn(),
    listThreadScreenRows: vi.fn(),
    listTombstonedThreadIds: vi.fn(),
    setCommitmentStatus: vi.fn(),
    stampScreened: vi.fn()
  };
});
// P4 (X5): the safety nets' drafts purge; its own suite is drafts-store.test.ts.
vi.mock("@/lib/exec/drafts-store", () => ({ purgeDraftsForThreads: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/jobs")>();
  return { ...actual, enqueueJob: vi.fn(), enqueueBulkTriage: vi.fn() };
});
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadSettings: vi.fn() };
});
vi.mock("@/lib/exec/sources/dd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/dd")>();
  return { ...actual, listClients: vi.fn(), listSatisfactionSignals: vi.fn(), latestScoredInboundByClient: vi.fn() };
});
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, loadScreeningPolicy: vi.fn(), listAllReplyArtifacts: vi.fn() };
});
vi.mock("@/lib/exec/sync-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sync-state")>();
  return { ...actual, getSyncState: vi.fn(), casSyncState: vi.fn(), putSyncState: vi.fn(), tryAcquireLease: vi.fn(), releaseLease: vi.fn() };
});

import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";
import {
  deleteAttentionItemsByIds,
  deleteEmailAttentionForThreads,
  listAllEmailAttentionRows,
  syncAttention,
  type EmailAttentionRow
} from "@/lib/exec/attention";
import type { AttentionCandidate } from "@/lib/exec/attention-types";
import { purgeDraftsForThreads } from "@/lib/exec/drafts-store";
import {
  applyThreadProposal,
  deleteCommitmentsForThreads,
  deleteSignalsForThreads,
  listCommitments,
  listProducerThreads,
  listRescreenBatch,
  listSignalsForMessages,
  listThreadScreenRows,
  listTombstonedThreadIds,
  setCommitmentStatus,
  stampScreened,
  type ProducerThreadRow,
  type RescreenRow
} from "@/lib/exec/email-store";
import type { ExecCommitment, ThreadScreenRow } from "@/lib/exec/email-types";
import {
  ATTENTION_LEASE_TTL_MS,
  EMAIL_ATTENTION_JOB_KIND,
  advanceHealthSnapshot,
  emailAttentionJobHandler,
  emailAttentionScheduledWork,
  type EmailAttentionSummary
} from "@/lib/exec/handlers/email-attention";
import { attentionKick, classifyError, enqueueBulkTriage, enqueueJob, type BulkTriageItem } from "@/lib/exec/jobs";
import { loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { EMAIL_ATTENTION_KINDS } from "@/lib/exec/producers/email";
import { dueDedupeKey } from "@/lib/exec/scheduler";
import { latestScoredInboundByClient, listClients, listSatisfactionSignals } from "@/lib/exec/sources/dd";
import type { DdClient } from "@/lib/exec/sources/dd-types";
import { listAllReplyArtifacts, loadScreeningPolicy, restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { casSyncState, getSyncState, putSyncState, releaseLease, tryAcquireLease, type HealthState } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const NOW = new Date("2026-11-04T17:03:10.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function mint(accounts: string[]): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint(["acct-1", "acct-2"]);

const rule = (id: string, pattern: string): RestrictedSenderRule => ({ id, pattern, matchKind: "domain", label: id, viewerUserIds: new Set() });
const RULES = [rule("rs_deel", "deel.com")];
const H = restrictedPolicyHash("hidden", RULES);
const OLD_H = restrictedPolicyHash("hidden", [rule("rs_old", "old.example")]);

const hashesOf = (...addresses: string[]) =>
  screenHashesFor({ all: [{ from: addresses[0] ?? "", to: addresses.slice(1), cc: [] }], participants: [] }).hashes;
const CLEAN = hashesOf("jane@acme.com", "mitchell@scaledai.org");
const RESTRICTED = hashesOf("payroll@deel.com", "mitchell@scaledai.org");

const TH = (n: number) => `4f1c2d3e-aaaa-bbbb-cccc-${String(n).padStart(12, "0")}`;
const MSG = (n: number) => `9a8b7c6d-0000-0000-0000-${String(n).padStart(12, "0")}`;

function rescreen(n: number, over: Partial<RescreenRow> = {}): RescreenRow {
  return { threadId: TH(n), version: 2, state: "triaged", screenHashes: CLEAN, screenTruncated: false, accountId: "acct-1", screenedPolicyHash: OLD_H, ...over };
}

function producerRow(n: number, over: Partial<ProducerThreadRow> = {}): ProducerThreadRow {
  return {
    threadId: TH(n),
    accountId: "acct-1",
    state: "triaged",
    version: 3,
    screenHashes: CLEAN,
    screenTruncated: false,
    screenedPolicyHash: H,
    subject: "Q3 renewal",
    counterpartName: "Jane Doe",
    counterpartEmail: "jane@acme.com",
    newestMessageId: MSG(n),
    newestInboundMessageId: MSG(n),
    newestOutboundMessageId: null,
    lastInboundAt: ago(1),
    lastOutboundAt: null,
    newestIsOutbound: false,
    answeredState: "awaiting_reply",
    answeredAt: null,
    outboundAutomatedOnly: false,
    clientId: null,
    clientName: null,
    clientMatchVia: null,
    matchConfidence: null,
    clientCandidates: 0,
    summary: "Asks for the renewal quote.",
    reason: "A direct question.",
    category: "client",
    urgency: "high",
    importance: "normal",
    needsReply: true,
    mitchellPersonally: false,
    awaitingReplyFromOthers: false,
    decisionQuestion: null,
    decisionMessageId: null,
    clientSignal: "none",
    automated: false,
    injectionSuspected: false,
    triagedAt: ago(1),
    ...over
  };
}

function client(id: string, over: Partial<DdClient> = {}): DdClient {
  return {
    id,
    name: id,
    status: "active",
    healthScore: null,
    healthLabel: "steady",
    healthSampleSize: null,
    healthComputedAt: null,
    healthOverrideLabel: null,
    healthOverrideBy: null,
    healthOverrideAt: null,
    touchpointOverrideLabel: null,
    touchpointOverrideBy: null,
    touchpointOverrideAt: null,
    lastOutboundEmailAtExternal: null,
    touchpointSyncedAt: null,
    ...over
  };
}

function commitment(id: string, over: Partial<ExecCommitment> = {}): ExecCommitment {
  return {
    id,
    principalId: "ep_1",
    fingerprint: "f".repeat(64),
    source: "email",
    threadId: TH(1),
    messageId: MSG(1),
    accountId: "acct-1",
    direction: "mitchell_owes",
    text: "Send the SOW",
    counterparty: null,
    dueAt: ago(2),
    dueText: null,
    status: "open",
    followedUpAt: null,
    evidenceExcerpt: "I will send the SOW",
    sourceRef: { system: "outlook", id: MSG(1), url: null, label: "s", class: "private" },
    messageSentAt: ago(10),
    messageCreatedAt: ago(10),
    createdAt: ago(10),
    updatedAt: ago(10),
    expiresAt: ago(-200),
    ...over
  };
}

const screenRow = (n: number, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow => ({
  threadId: TH(n),
  accountId: "acct-1",
  state: "triaged",
  screenHashes: CLEAN,
  screenTruncated: false,
  screenedPolicyHash: H,
  ...over
});

const settings = (over: { email_enabled?: boolean | null; schemaReady?: boolean } = {}): ExecSettings =>
  settingsFromRow(
    {
      principal_id: "ep_1",
      brief_enabled: false,
      brief_local_time: "08:00",
      brief_timezone: null,
      supersede_legacy_brief: false,
      checkins_enabled: true,
      restricted_policy: "hidden",
      watch_mode: "active_public",
      muted_channel_ids: [],
      retention_days_slack: 90,
      retention_days_email: 180,
      retention_days_chat: 90,
      daily_cost_cap_usd: 15,
      email_enabled: over.email_enabled === undefined ? true : over.email_enabled
    },
    "ep_1",
    { emailSchemaReady: over.schemaReady ?? true }
  );

// --- an in-memory exec_sync_state --------------------------------------------------

let syncRows: Map<string, { value: unknown; rev: number }>;

function seedState(source: string, key: string, value: object, rev = 1): void {
  syncRows.set(`${source}/${key}`, { value: JSON.parse(JSON.stringify(value)), rev });
}
const stateOf = (source: string, key: string) => syncRows.get(`${source}/${key}`)?.value as Record<string, unknown> | undefined;

function wireSyncState(): void {
  syncRows = new Map();
  vi.mocked(getSyncState).mockImplementation(async (_p, source, key, parse) => {
    const row = syncRows.get(`${source}/${key}`);
    if (!row) return null;
    const value = parse(row.value);
    return value === null ? null : { value, rev: row.rev };
  });
  vi.mocked(casSyncState).mockImplementation(async (_p, source, key, expectedRev, value) => {
    const k = `${source}/${key}`;
    const row = syncRows.get(k);
    if (expectedRev === null) {
      if (row) return false;
      syncRows.set(k, { value: JSON.parse(JSON.stringify(value)), rev: 1 });
      return true;
    }
    if (!row || row.rev !== expectedRev) return false;
    syncRows.set(k, { value: JSON.parse(JSON.stringify(value)), rev: expectedRev + 1 });
    return true;
  });
  vi.mocked(putSyncState).mockImplementation(async (_p, source, key, value) => {
    const k = `${source}/${key}`;
    syncRows.set(k, { value: JSON.parse(JSON.stringify(value)), rev: (syncRows.get(k)?.rev ?? 0) + 1 });
  });
}

// --- the rest of the world ----------------------------------------------------------

let producerTier: RescreenRow[][];
let restTier: RescreenRow[];

function context(over: Partial<JobContext> = {}, job: Parameters<typeof jobRow>[0] = {}): JobContext {
  return {
    job: jobRow({ id: 77, kind: EMAIL_ATTENTION_JOB_KIND, principal_id: "ep_1", lane: "bulk", dedupe_key: "exec.email-attention:ep_1:i100", ...job }),
    principal,
    signal: new AbortController().signal,
    workerId: "w1",
    ...over
  };
}

const run = (ctx: JobContext = context()) => emailAttentionJobHandler.run(ctx) as Promise<EmailAttentionSummary>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  wireSyncState();
  producerTier = [];
  restTier = [];

  vi.mocked(tryAcquireLease).mockResolvedValue(true);
  vi.mocked(releaseLease).mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: RULES, hash: H });

  vi.mocked(listRescreenBatch).mockImplementation(async (_p, _h, q) => {
    if (q.tier === "producer") return producerTier.shift() ?? [];
    const start = q.afterThreadId === null ? 0 : restTier.findIndex((r) => r.threadId > (q.afterThreadId as string));
    return start < 0 ? [] : restTier.slice(start, start + q.limit);
  });
  vi.mocked(stampScreened).mockImplementation(async (_p, items) => items.length);
  vi.mocked(applyThreadProposal).mockResolvedValue({ result: "tombstoned", commitments: [] });
  vi.mocked(enqueueBulkTriage).mockImplementation(async (_p, items) => ({
    enqueued: items.length,
    duplicates: 0,
    blocked: 0,
    blockedKeys: [],
    runAfter: []
  }));
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 501 });

  vi.mocked(listTombstonedThreadIds).mockResolvedValue([]);
  vi.mocked(deleteEmailAttentionForThreads).mockResolvedValue(0);
  vi.mocked(deleteCommitmentsForThreads).mockResolvedValue(0);
  vi.mocked(purgeDraftsForThreads).mockResolvedValue(0);
  vi.mocked(deleteSignalsForThreads).mockResolvedValue(0);
  vi.mocked(listAllEmailAttentionRows).mockResolvedValue([]);
  vi.mocked(deleteAttentionItemsByIds).mockResolvedValue(0);

  vi.mocked(listProducerThreads).mockResolvedValue([]);
  vi.mocked(listCommitments).mockResolvedValue([]);
  vi.mocked(listAllReplyArtifacts).mockResolvedValue(new Map());
  vi.mocked(listClients).mockResolvedValue([client("cl_acme")]);
  vi.mocked(latestScoredInboundByClient).mockResolvedValue(new Map());
  vi.mocked(listSatisfactionSignals).mockResolvedValue([]);
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(listSignalsForMessages).mockResolvedValue(new Map());
  vi.mocked(setCommitmentStatus).mockResolvedValue(undefined);
  vi.mocked(syncAttention).mockResolvedValue({ inserted: 1, updated: 0, reopened: 0, resolved: 0, unchanged: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

const synced = (): AttentionCandidate[] => vi.mocked(syncAttention).mock.calls.at(-1)?.[2] as AttentionCandidate[];
const bulkItems = (): BulkTriageItem[] => vi.mocked(enqueueBulkTriage).mock.calls.flatMap((c) => [...c[1]]);

// ---------------------------------------------------------------------------
// The job and its schedule
// ---------------------------------------------------------------------------

describe("the job and its schedule", () => {
  it("is a bulk job with a 120 s ceiling and a 180 s lease", () => {
    expect(emailAttentionJobHandler).toMatchObject({ kind: "exec.email-attention", lane: "bulk", timeoutMs: 120_000 });
    expect(ATTENTION_LEASE_TTL_MS).toBe(180_000);
    expect(Object.isFrozen(emailAttentionJobHandler)).toBe(true);
  });

  it("runs every 10 minutes for every principal, ungated, three attempts", () => {
    expect(emailAttentionScheduledWork).toEqual({ kind: "exec.email-attention", lane: "bulk", cadence: { kind: "interval", minutes: 10 }, maxAttempts: 3 });
    expect(emailAttentionScheduledWork.enabled).toBeUndefined();
    // Due even with email off and the schema missing: the pass itself decides (L24).
    expect(dueDedupeKey(emailAttentionScheduledWork, principal, settings({ email_enabled: false, schemaReady: false }), NOW)).toMatch(
      /^exec\.email-attention:ep_1:i\d+$/
    );
  });

  it("dies at once without a principal", async () => {
    const err = await run(context({ principal: null })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(tryAcquireLease).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1. The lease
// ---------------------------------------------------------------------------

describe("the lease", () => {
  it("takes the lease for timeout + 60 s and releases it with the same holder", async () => {
    await run();
    expect(tryAcquireLease).toHaveBeenCalledWith(principal, "attention-lease", "w1#77.1", 180_000, NOW);
    expect(releaseLease).toHaveBeenCalledWith(principal, "attention-lease", "w1#77.1");
  });

  it("a scheduled run skips while another pass holds it, touching nothing", async () => {
    vi.mocked(tryAcquireLease).mockResolvedValue(false);
    await expect(run()).resolves.toEqual({ skipped: "lease_held" });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("a kick re-kicks itself for the next minute instead (clock-derived key)", async () => {
    vi.mocked(tryAcquireLease).mockResolvedValue(false);
    const ctx = context({}, { lane: "interactive", dedupe_key: "email-attn:ep_1:m29870403", payload: { kick: true } });
    await expect(run(ctx)).resolves.toEqual({ skipped: "lease_held", requeued: true });
    expect(enqueueJob).toHaveBeenCalledWith(attentionKick(principal, "interactive", NOW));
    const input = vi.mocked(enqueueJob).mock.calls[0][0];
    expect(input).toMatchObject({ kind: EMAIL_ATTENTION_JOB_KIND, lane: "interactive", maxAttempts: 3 });
    expect(input.dedupeKey).toBe(`email-attn:ep_1:m${Math.floor(NOW.getTime() / 60_000) + 1}`);
    expect(input.runAfter?.toISOString()).toBe("2026-11-04T17:04:02.000Z");
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("recognizes a kick by its key even without the payload flag", async () => {
    vi.mocked(tryAcquireLease).mockResolvedValue(false);
    await run(context({}, { dedupe_key: "email-attn:ep_1:m1" }));
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it("is released even when the pass throws", async () => {
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("restricted-sender rules unavailable"));
    await expect(run()).rejects.toThrow(/rules unavailable/);
    expect(releaseLease).toHaveBeenCalledWith(principal, "attention-lease", "w1#77.1");
    expect(syncAttention).not.toHaveBeenCalled();
  });

  it("once released, the next run goes straight through", async () => {
    let holder: string | null = null;
    vi.mocked(tryAcquireLease).mockImplementation(async (_p, _k, h) => {
      if (holder !== null && holder !== h) return false;
      holder = h;
      return true;
    });
    vi.mocked(releaseLease).mockImplementation(async (_p, _k, h) => {
      if (holder === h) holder = null;
    });
    await run(context({}, { id: 1 }));
    await expect(run(context({}, { id: 2 }))).resolves.not.toHaveProperty("skipped");
  });
});

// ---------------------------------------------------------------------------
// 2. and 4. The gates
// ---------------------------------------------------------------------------

describe("the gates", () => {
  it("skips when the P3 migration isn't applied, before any email read", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ schemaReady: false }));
    await expect(run()).resolves.toEqual({ skipped: "not_installed" });
    expect(loadScreeningPolicy).not.toHaveBeenCalled();
    expect(listRescreenBatch).not.toHaveBeenCalled();
    expect(syncAttention).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalled();
  });

  it.each<[string, ExecSettings, ExecPrincipal]>([
    ["email off", settings({ email_enabled: false }), principal],
    ["nothing pinned", settings(), mint([])]
  ])("%s: runs the policy step and the safety net, then resolves every email item", async (_name, s, p) => {
    vi.mocked(loadSettings).mockResolvedValue(s);
    restTier = [rescreen(1, { screenTruncated: true }), rescreen(2)];
    vi.mocked(listTombstonedThreadIds).mockResolvedValue([TH(9)]);
    const out = await run(context({ principal: p }));
    expect(out.off).toBe(true);
    expect(stampScreened).toHaveBeenCalledWith(p, [{ threadId: TH(2), version: 2 }], H, expect.anything());
    // No re-triage while email is off.
    expect(enqueueBulkTriage).not.toHaveBeenCalled();
    expect(out.policy?.retriageSkipped).toBe(1);
    expect(deleteEmailAttentionForThreads).toHaveBeenCalledWith(p, [TH(9)], expect.anything());
    expect(syncAttention).toHaveBeenCalledWith(p, { source: "email", kinds: EMAIL_ATTENTION_KINDS }, [], NOW, expect.anything());
    expect(listProducerThreads).not.toHaveBeenCalled();
    expect(listSatisfactionSignals).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. The policy step
// ---------------------------------------------------------------------------

describe("the policy step", () => {
  const ROWS = {
    stamp: rescreen(1),
    tombstone: rescreen(2, { screenHashes: RESTRICTED }),
    truncated: rescreen(3, { screenTruncated: true }),
    cleanTombstone: rescreen(4, { state: "restricted_hidden" }),
    goneTruncated: rescreen(5, { state: "gone", screenTruncated: true }),
    stillRestrictedTombstone: rescreen(6, { state: "restricted_hidden", screenHashes: RESTRICTED })
  };

  it("routes every row by the state machine's stamp rule", async () => {
    restTier = Object.values(ROWS);
    const out = await run();
    // Bulk stamp: the clean row, and the tombstone that is still restricted.
    expect(stampScreened).toHaveBeenCalledWith(
      principal,
      [
        { threadId: TH(1), version: 2 },
        { threadId: TH(6), version: 2 }
      ],
      H,
      expect.anything()
    );
    // Tombstones through the store's procedure, as a stamp proposal under H;
    // a gone row with truncated hashes can't be re-read, so it is emptied (L31: hidden).
    expect(vi.mocked(applyThreadProposal).mock.calls.map((c) => [c[2], c[3]])).toEqual([
      [TH(2), { kind: "stamp", policyHash: H }],
      [TH(5), { kind: "stamp", policyHash: H }]
    ]);
    expect(vi.mocked(applyThreadProposal).mock.calls[0][4]).toEqual({ now: NOW, retentionDays: 180 });
    // A fresh read for the truncated row and for the tombstone that is clean now.
    expect(bulkItems()).toEqual([
      { threadId: TH(3), accountId: "acct-1", reason: "policy", dedupeKey: `retriage:ep_1:${TH(3)}:policy:g1.l0` },
      { threadId: TH(4), accountId: "acct-1", reason: "policy", dedupeKey: `retriage:ep_1:${TH(4)}:policy:g1.l0` }
    ]);
    expect(out.policy).toMatchObject({ generation: 1, stamped: 2, tombstoned: 2, retriageEnqueued: 2, timedOut: false, failures: 0 });
  });

  it("does the producer tier first, all of it, then the rest", async () => {
    producerTier = [Array.from({ length: 1_000 }, (_, i) => rescreen(100 + i)), [rescreen(2_000)]];
    restTier = [rescreen(1)];
    await run();
    const tiers = vi.mocked(listRescreenBatch).mock.calls.map((c) => [c[2].tier, c[2].afterThreadId]);
    expect(tiers).toEqual([
      ["producer", null],
      ["producer", TH(1_099)],
      ["rest", null]
    ]);
    expect(vi.mocked(listRescreenBatch).mock.calls[0][2]).toMatchObject({ limit: 1_000, now: NOW });
    expect(vi.mocked(stampScreened).mock.calls.map((c) => c[1].length)).toEqual([1_000, 1, 1]);
  });

  it("sends a thread to re-triage once per pass, though both tiers list it", async () => {
    producerTier = [[ROWS.truncated]];
    restTier = [ROWS.truncated];
    await run();
    expect(bulkItems().map((i) => i.threadId)).toEqual([TH(3)]);
  });

  it("never re-triages a row on a problem account (addenda §1.7)", async () => {
    seedState("mail", "accounts", { checkedAt: ago(0.01), accounts: [], problems: [{ accountId: "acct-2", reason: "email_mismatch" }] });
    restTier = [rescreen(3, { screenTruncated: true, accountId: "acct-2" }), rescreen(4, { state: "restricted_hidden" })];
    const out = await run();
    expect(bulkItems().map((i) => i.threadId)).toEqual([TH(4)]);
    expect(out.policy?.retriageSkipped).toBe(1);
  });

  it("starts a new generation when the hash moves: position and lap start over", async () => {
    seedState("mail", "restricted-policy", { hash: OLD_H, generation: 4, appliedAt: ago(3), rescreenAfter: TH(50), lap: 7 }, 9);
    restTier = [ROWS.truncated];
    const out = await run();
    expect(vi.mocked(listRescreenBatch).mock.calls.find((c) => c[2].tier === "rest")?.[2].afterThreadId).toBeNull();
    expect(bulkItems()[0].dedupeKey).toBe(`retriage:ep_1:${TH(3)}:policy:g5.l0`);
    expect(out.policy?.generation).toBe(5);
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ hash: H, generation: 5, appliedAt: NOW.toISOString(), rescreenAfter: null, lap: 1 });
  });

  it("keeps the generation while the hash stands, and resumes the rest tier where it stopped", async () => {
    seedState("mail", "restricted-policy", { hash: H, generation: 3, appliedAt: ago(3), rescreenAfter: TH(2), lap: 1 }, 4);
    restTier = [rescreen(1), rescreen(3, { screenTruncated: true })];
    await run();
    expect(vi.mocked(listRescreenBatch).mock.calls.find((c) => c[2].tier === "rest")?.[2].afterThreadId).toBe(TH(2));
    expect(bulkItems().map((i) => i.dedupeKey)).toEqual([`retriage:ep_1:${TH(3)}:policy:g3.l1`]);
  });

  it("wraps on a short rest batch: the position resets and the lap moves on (A7, amendments-2)", async () => {
    restTier = [ROWS.truncated];
    await run();
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ generation: 1, rescreenAfter: null, lap: 1 });
    // The next lap re-triages the row again under a new key.
    vi.mocked(enqueueBulkTriage).mockClear();
    await run();
    expect(bulkItems().map((i) => i.dedupeKey)).toEqual([`retriage:ep_1:${TH(3)}:policy:g1.l1`]);
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ lap: 2 });
  });

  it("writes nothing when there is nothing to re-screen", async () => {
    seedState("mail", "restricted-policy", { hash: H, generation: 2, appliedAt: ago(3), rescreenAfter: null, lap: 5 }, 8);
    await run();
    expect(syncRows.get("mail/restricted-policy")?.rev).toBe(8);
  });

  it("moves the position by a full batch without wrapping", async () => {
    restTier = Array.from({ length: 1_500 }, (_, i) => rescreen(i));
    await run();
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: TH(999), lap: 0 });
    await run();
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: null, lap: 1 });
  });

  it("holds the position in front of a re-triage the bulk cap turned away", async () => {
    restTier = [rescreen(1), rescreen(3, { screenTruncated: true }), rescreen(4, { state: "restricted_hidden" }), rescreen(5)];
    vi.mocked(enqueueBulkTriage).mockImplementation(async (_p, items) => ({
      enqueued: 1,
      duplicates: 0,
      blocked: 1,
      blockedKeys: [items[1].dedupeKey],
      runAfter: []
    }));
    const out = await run();
    // TH(4) was turned away: the cursor stays after TH(3), the lap doesn't end.
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: TH(3), lap: 0 });
    expect(out.policy).toMatchObject({ retriageEnqueued: 1, retriageBlocked: 1, wrapped: false });
    // Everything else in the batch was still stamped.
    expect(stampScreened).toHaveBeenCalledWith(principal, [{ threadId: TH(1), version: 2 }, { threadId: TH(5), version: 2 }], H, expect.anything());
  });

  it("stops at the 45 s time box, keeps its place, and still runs the nets and the sync", async () => {
    restTier = [rescreen(1), rescreen(2, { screenHashes: RESTRICTED }), rescreen(3)];
    vi.mocked(stampScreened).mockImplementation(async (_p, items) => {
      vi.setSystemTime(Date.now() + 46_000);
      return items.length;
    });
    const out = await run();
    expect(applyThreadProposal).not.toHaveBeenCalled();
    expect(out.policy?.timedOut).toBe(true);
    // TH(2)'s tombstone never ran: the next pass starts at it.
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: TH(1) });
    expect(listTombstonedThreadIds).toHaveBeenCalledTimes(2);
    expect(syncAttention).toHaveBeenCalledTimes(1);
  });

  it("a slow producer tier leaves the rest tier for the next pass", async () => {
    producerTier = [[rescreen(1)]];
    restTier = [rescreen(2)];
    vi.mocked(stampScreened).mockImplementation(async (_p, items) => {
      vi.setSystemTime(Date.now() + 50_000);
      return items.length;
    });
    const out = await run();
    expect(vi.mocked(listRescreenBatch).mock.calls.map((c) => c[2].tier)).toEqual(["producer"]);
    expect(out.policy?.timedOut).toBe(true);
    expect(syncAttention).toHaveBeenCalledTimes(1);
  });

  it("a tombstone that the store found needing a fresh read goes to re-triage", async () => {
    restTier = [ROWS.tombstone];
    vi.mocked(applyThreadProposal).mockResolvedValue({ result: "skipped", reason: "needs_fresh_read", commitments: [] });
    await run();
    expect(bulkItems().map((i) => i.threadId)).toEqual([TH(2)]);
  });

  it("a failed tombstone doesn't stop the pass: the sync runs, then the job fails with it", async () => {
    restTier = [rescreen(1), rescreen(2, { screenHashes: RESTRICTED }), rescreen(3, { screenHashes: RESTRICTED }), rescreen(4)];
    const transient = Object.assign(new Error("exec email store: exec_email_threads update failed: timeout"), {});
    vi.mocked(applyThreadProposal).mockRejectedValueOnce(transient).mockResolvedValueOnce({ result: "tombstoned", commitments: [] });
    await expect(run()).rejects.toBe(transient);
    expect(classifyError(transient)).toBe("retryable");
    expect(applyThreadProposal).toHaveBeenCalledTimes(2);
    expect(syncAttention).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalled();
    // The cursor stays in front of the row that failed.
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: TH(1) });
  });

  it("a programming error on one row doesn't wedge the cursor, and dead-letters the job", async () => {
    restTier = [rescreen(1), rescreen(2, { screenHashes: RESTRICTED }), rescreen(3)];
    const bug = new NonRetryableError("email state: facts.accountId is required");
    vi.mocked(applyThreadProposal).mockRejectedValue(bug);
    await expect(run()).rejects.toBe(bug);
    expect(classifyError(bug)).toBe("fatal");
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: null, lap: 1 });
  });

  it("a failed tombstone is tried once per pass, though both tiers list it", async () => {
    producerTier = [[rescreen(2, { screenHashes: RESTRICTED })]];
    restTier = [rescreen(2, { screenHashes: RESTRICTED })];
    const transient = new Error("connection reset");
    vi.mocked(applyThreadProposal).mockRejectedValue(transient);
    await expect(run()).rejects.toBe(transient);
    expect(applyThreadProposal).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    ["the bulk stamp", () => vi.mocked(stampScreened).mockRejectedValue(new Error("stamp rpc failed"))],
    ["the re-triage enqueue", () => vi.mocked(enqueueBulkTriage).mockRejectedValue(new Error("enqueue failed"))],
    ["a re-screen listing", () => vi.mocked(listRescreenBatch).mockRejectedValue(new Error("rescreen read failed"))],
    [
      "the policy state",
      () => {
        const real = vi.mocked(getSyncState).getMockImplementation();
        vi.mocked(getSyncState).mockImplementation(async (p, source, key, parse, o) => {
          if (key === "restricted-policy") throw new Error("sync state read failed");
          return (real as NonNullable<typeof real>)(p, source, key, parse, o);
        });
      }
    ]
  ])("a failure of %s still lets the nets and the sync run, then fails the job", async (_name, fail) => {
    restTier = [rescreen(1), rescreen(3, { screenTruncated: true })];
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(5)]);
    fail();
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(syncAttention).toHaveBeenCalledTimes(1);
    expect(synced()).toHaveLength(1);
    expect(listTombstonedThreadIds).toHaveBeenCalledTimes(2);
    expect(releaseLease).toHaveBeenCalled();
  });

  it("keeps the cursor in front of rows whose stamp or re-triage failed", async () => {
    restTier = [rescreen(1, { screenTruncated: true }), rescreen(2), rescreen(3)];
    vi.mocked(enqueueBulkTriage).mockRejectedValue(new Error("enqueue failed"));
    await run().catch(() => undefined);
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: null, lap: 0 });
    vi.mocked(enqueueBulkTriage).mockResolvedValue({ enqueued: 1, duplicates: 0, blocked: 0, blockedKeys: [], runAfter: [] });
    vi.mocked(stampScreened).mockRejectedValue(new Error("stamp rpc failed"));
    restTier = [rescreen(1, { screenTruncated: true }), rescreen(2), rescreen(3)];
    await run().catch(() => undefined);
    // The re-triage of TH(1) went out; the stamps of TH(2)/TH(3) didn't.
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ rescreenAfter: TH(1), lap: 0 });
  });

  it("an abort ends the pass at once, with no sync", async () => {
    const controller = new AbortController();
    restTier = [rescreen(1)];
    vi.mocked(stampScreened).mockImplementation(async () => {
      controller.abort(new Error("job timed out"));
      throw new Error("AbortError: This operation was aborted");
    });
    await expect(run(context({ signal: controller.signal }))).rejects.toThrow(/timed out/);
    expect(syncAttention).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalled();
  });

  it("replaces a policy row that doesn't parse instead of wedging", async () => {
    syncRows.set("mail/restricted-policy", { value: { hash: "nope" }, rev: 3 });
    restTier = [ROWS.truncated];
    await run();
    expect(putSyncState).toHaveBeenCalled();
    expect(stateOf("mail", "restricted-policy")).toMatchObject({ hash: H, generation: 1 });
  });
});

// ---------------------------------------------------------------------------
// 3b and 8. The safety nets
// ---------------------------------------------------------------------------

describe("the safety nets", () => {
  it("delete every tombstoned thread's items, commitments, drafts (P4 X5) and signals, before the reads and after the sync", async () => {
    vi.mocked(listTombstonedThreadIds).mockResolvedValue([TH(7), TH(8)]);
    vi.mocked(purgeDraftsForThreads).mockResolvedValue(2);
    const out = await run();
    for (const fn of [deleteEmailAttentionForThreads, deleteCommitmentsForThreads, purgeDraftsForThreads, deleteSignalsForThreads]) {
      expect(vi.mocked(fn).mock.calls.map((c) => c[1])).toEqual([
        [TH(7), TH(8)],
        [TH(7), TH(8)]
      ]);
    }
    const net1 = vi.mocked(deleteEmailAttentionForThreads).mock.invocationCallOrder[0];
    const net2 = vi.mocked(deleteEmailAttentionForThreads).mock.invocationCallOrder[1];
    const reads = vi.mocked(listProducerThreads).mock.invocationCallOrder[0];
    const sync = vi.mocked(syncAttention).mock.invocationCallOrder[0];
    expect(net1).toBeLessThan(reads);
    expect(sync).toBeLessThan(net2);
    // PX05: in each net the drafts purge runs after the commitments delete and before the signals delete, with the same signal.
    for (const i of [0, 1]) {
      const commitments = vi.mocked(deleteCommitmentsForThreads).mock.invocationCallOrder[i];
      const drafts = vi.mocked(purgeDraftsForThreads).mock.invocationCallOrder[i];
      const signals = vi.mocked(deleteSignalsForThreads).mock.invocationCallOrder[i];
      expect(commitments).toBeLessThan(drafts);
      expect(drafts).toBeLessThan(signals);
      expect(vi.mocked(purgeDraftsForThreads).mock.calls[i][2]).toEqual({ signal: expect.any(AbortSignal) });
    }
    expect((out as { net1?: { drafts: number | null } }).net1?.drafts).toBe(2);
    expect((out as { net2?: { drafts: number | null } }).net2?.drafts).toBe(2);
  });

  it("PX05: the P4 migration not applied (null) is recorded as such; a drafts purge failure fails the net like any other step", async () => {
    vi.mocked(listTombstonedThreadIds).mockResolvedValue([TH(7)]);
    vi.mocked(purgeDraftsForThreads).mockResolvedValue(null);
    const out = await run();
    expect((out as { net1?: { drafts: number | null } }).net1?.drafts).toBeNull();
    vi.mocked(purgeDraftsForThreads).mockRejectedValue(new Error("exec drafts store: exec_drafts_purge_restricted failed: lock timeout"));
    await expect(run()).rejects.toThrow(/exec_drafts_purge_restricted failed/);
    expect(syncAttention).toHaveBeenCalledTimes(1);
  });

  it("the safety nets skip every delete, the drafts purge included, when nothing is tombstoned or rule-matched", async () => {
    await run();
    expect(purgeDraftsForThreads).not.toHaveBeenCalled();
    expect(deleteCommitmentsForThreads).not.toHaveBeenCalled();
  });

  it("a tombstone landing between the reads and the sync leaves no item (A6)", async () => {
    // The thread is live and triaged when the producer reads it...
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(3)]);
    // ...and a triage job tombstones it just before the sync.
    vi.mocked(listTombstonedThreadIds).mockResolvedValueOnce([]).mockResolvedValueOnce([TH(3)]);
    await run();
    expect(synced().map((c) => c.fingerprint)).toEqual([`email:thread:${TH(3)}:${MSG(3)}`]);
    expect(vi.mocked(deleteEmailAttentionForThreads).mock.calls.at(-1)?.[1]).toEqual([TH(3)]);
    expect(vi.mocked(deleteEmailAttentionForThreads).mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      vi.mocked(syncAttention).mock.invocationCallOrder[0]
    );
  });

  it("drops a rule-matched producer row's items after the sync, even before its tombstone lands", async () => {
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(1), producerRow(2, { screenHashes: RESTRICTED, screenedPolicyHash: OLD_H })]);
    await run();
    expect(synced().map((c) => c.fingerprint)).toEqual([`email:thread:${TH(1)}:${MSG(1)}`]);
    expect(vi.mocked(deleteEmailAttentionForThreads).mock.calls.at(-1)?.[1]).toEqual([TH(2)]);
    expect(vi.mocked(deleteCommitmentsForThreads).mock.calls.at(-1)?.[1]).toEqual([TH(2)]);
  });

  it("deletes commitment items whose commitment is gone", async () => {
    const rows: EmailAttentionRow[] = [
      { id: "ea_1", fingerprint: `email:commitment:${TH(1)}:ec_live`, kind: "overdue_commitment", status: "open" },
      { id: "ea_2", fingerprint: `email:commitment:${TH(1)}:ec_gone`, kind: "overdue_commitment", status: "resolved" },
      { id: "ea_3", fingerprint: `email:thread:${TH(1)}:${MSG(1)}`, kind: "important_email", status: "open" },
      { id: "ea_4", fingerprint: "email:health:cl_acme", kind: "client_health_drop", status: "open" }
    ];
    vi.mocked(listAllEmailAttentionRows).mockResolvedValue(rows);
    vi.mocked(listCommitments).mockImplementation(async (_p, q) => (q?.threadIds ? [commitment("ec_live", { status: "followed_up" })] : []));
    vi.mocked(deleteAttentionItemsByIds).mockResolvedValue(1);
    const out = await run();
    expect(vi.mocked(listCommitments).mock.calls.find((c) => c[1]?.threadIds)?.[1]).toEqual({
      statuses: ["open", "followed_up", "expired"],
      threadIds: [TH(1)]
    });
    expect(deleteAttentionItemsByIds).toHaveBeenCalledWith(principal, ["ea_2"], { source: "email", signal: expect.any(AbortSignal) });
    expect(out.net1?.orphanItems).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5-7. Reads, health, expiry, sync
// ---------------------------------------------------------------------------

describe("reads and the sync", () => {
  it("syncs the producer's candidates within the email scope, at one instant, with the job's signal", async () => {
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(1)]);
    const ctx = context();
    const out = await run(ctx);
    expect(syncAttention).toHaveBeenCalledWith(principal, { source: "email", kinds: EMAIL_ATTENTION_KINDS }, expect.any(Array), NOW, { signal: ctx.signal });
    expect(synced()).toHaveLength(1);
    expect(out).toMatchObject({ candidates: 1, sync: { inserted: 1, updated: 0, reopened: 0, resolved: 0, unchanged: 0 } });
  });

  it("makes items only from the mailboxes pinned to him now; a re-pinned account's old rows resolve (ui-3)", async () => {
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(1), producerRow(2, { accountId: "acct-old" })]);
    vi.mocked(listCommitments).mockImplementation(async (_p, q) =>
      q?.threadIds ? [] : [commitment("ec_pinned", { threadId: TH(1) }), commitment("ec_old", { threadId: TH(2), accountId: "acct-old" })]
    );
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([[TH(1), screenRow(1)], [TH(2), screenRow(2, { accountId: "acct-old" })]]));
    await run();
    expect(synced().map((c) => c.fingerprint).sort()).toEqual([`email:commitment:${TH(1)}:ec_pinned`, `email:thread:${TH(1)}:${MSG(1)}`].sort());
  });

  it("an unpinned row that a rule matches still loses its items in the second net", async () => {
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(2, { accountId: "acct-old", screenHashes: RESTRICTED })]);
    await run();
    expect(vi.mocked(deleteEmailAttentionForThreads).mock.calls.at(-1)?.[1]).toEqual([TH(2)]);
  });

  it("reads the signals of every anchor and newest inbound, and the screen rows of every commitment's thread", async () => {
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(1), producerRow(2, { newestInboundMessageId: null, newestMessageId: MSG(20) })]);
    vi.mocked(listCommitments).mockResolvedValue([commitment("ec_a", { threadId: TH(5) }), commitment("ec_b", { threadId: TH(5) }), commitment("ec_c", { threadId: TH(6) })]);
    await run();
    expect(vi.mocked(listSignalsForMessages).mock.calls[0][1]).toEqual([MSG(1), MSG(20)]);
    expect(vi.mocked(listThreadScreenRows).mock.calls[0][1]).toEqual([TH(5), TH(6)]);
    expect(vi.mocked(listSatisfactionSignals).mock.calls[0][1]).toBe(new Date(NOW.getTime() - 7 * DAY).toISOString());
    expect(vi.mocked(listSatisfactionSignals).mock.calls[0][2]).toEqual({ rules: RULES, tombstonedThreadIds: [] });
  });

  const READS: [string, () => void][] = [
    ["producer rows", () => vi.mocked(listProducerThreads).mockRejectedValue(new Error("read failed"))],
    ["commitments", () => vi.mocked(listCommitments).mockRejectedValue(new Error("read failed"))],
    ["reply artifacts", () => vi.mocked(listAllReplyArtifacts).mockRejectedValue(new Error("read failed"))],
    ["clients", () => vi.mocked(listClients).mockRejectedValue(new Error("read failed"))],
    ["score freshness", () => vi.mocked(latestScoredInboundByClient).mockRejectedValue(new Error("read failed"))],
    ["satisfaction", () => vi.mocked(listSatisfactionSignals).mockRejectedValue(new Error("read failed"))],
    ["screen rows", () => vi.mocked(listThreadScreenRows).mockRejectedValue(new Error("read failed"))],
    ["signals", () => vi.mocked(listSignalsForMessages).mockRejectedValue(new Error("read failed"))],
    ["the rules", () => vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("read failed"))]
  ];
  it.each(READS)("a failed read of %s throws before any sync", async (_name, fail) => {
    fail();
    await expect(run()).rejects.toThrow(/read failed/);
    expect(syncAttention).not.toHaveBeenCalled();
  });

  it("expires commitments more than 30 days overdue (open only), and shows the rest", async () => {
    vi.mocked(listCommitments).mockImplementation(async (_p, q) =>
      q?.threadIds ? [] : [commitment("ec_old", { dueAt: ago(31) }), commitment("ec_due", { dueAt: ago(2) })]
    );
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([[TH(1), screenRow(1)]]));
    const out = await run();
    expect(setCommitmentStatus).toHaveBeenCalledTimes(1);
    expect(setCommitmentStatus).toHaveBeenCalledWith(principal, "ec_old", "expired", null, { expectStatus: "open", now: NOW, signal: expect.any(AbortSignal) });
    expect(out.expired).toBe(1);
    expect(synced().map((c) => c.fingerprint)).toEqual([`email:commitment:${TH(1)}:ec_due`]);
  });

  it("the first health snapshot makes no items; a later drop does, and a recovery clears it", async () => {
    vi.mocked(listClients).mockResolvedValue([client("cl_acme", { healthLabel: "steady" })]);
    await run();
    expect(synced().some((c) => c.kind === "client_health_drop")).toBe(false);
    expect(stateOf("email", "client-health")).toMatchObject({ labels: { cl_acme: { label: "steady", droppedFrom: null, droppedAt: null } } });

    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    vi.mocked(listClients).mockResolvedValue([client("cl_acme", { healthLabel: "shaky" })]);
    const out = await run();
    expect(out.healthDrops).toBe(1);
    expect(synced().filter((c) => c.kind === "client_health_drop").map((c) => c.fingerprint)).toEqual(["email:health:cl_acme"]);

    vi.setSystemTime(new Date(NOW.getTime() + 2 * DAY));
    vi.mocked(listClients).mockResolvedValue([client("cl_acme", { healthLabel: "steady" })]);
    await run();
    expect(synced().some((c) => c.kind === "client_health_drop")).toBe(false);
  });

  it("returns counts and codes only", async () => {
    vi.mocked(listProducerThreads).mockResolvedValue([producerRow(1, { subject: "SECRET SUBJECT", summary: "SECRET SUMMARY" })]);
    const out = await run();
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/SECRET|jane|Q3/);
    expect(Object.keys(out).sort()).toEqual(["candidates", "expired", "healthDrops", "net1", "net2", "policy", "sync"]);
  });
});

// ---------------------------------------------------------------------------
// The health snapshot, unit by unit
// ---------------------------------------------------------------------------

describe("advanceHealthSnapshot", () => {
  const state = (labels: Record<string, { label: string; droppedFrom?: string | null; droppedAt?: string | null }>): HealthState => ({
    takenAt: ago(1),
    labels: Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, { label: v.label, droppedFrom: v.droppedFrom ?? null, droppedAt: v.droppedAt ?? null }]))
  });

  it("only records on the first run", () => {
    const r = advanceHealthSnapshot(null, [client("a", { healthLabel: "at_risk" })], NOW);
    expect(r.drops).toEqual([]);
    expect(r.next.labels.a).toEqual({ label: "at_risk", droppedFrom: null, droppedAt: null });
  });

  it("records a drop to a worse band, with when it was first seen", () => {
    const r = advanceHealthSnapshot(state({ a: { label: "steady" } }), [client("a", { healthLabel: "shaky" })], NOW);
    expect(r.drops).toEqual([{ clientId: "a", from: "steady", to: "shaky", droppedAt: NOW.toISOString(), overridden: false }]);
  });

  it("keeps a drop while the label stays down, and lets it age out after 7 days", () => {
    const prev = state({ a: { label: "shaky", droppedFrom: "steady", droppedAt: ago(3) } });
    expect(advanceHealthSnapshot(prev, [client("a", { healthLabel: "shaky" })], NOW).drops).toEqual([
      { clientId: "a", from: "steady", to: "shaky", droppedAt: ago(3), overridden: false }
    ]);
    const old = state({ a: { label: "shaky", droppedFrom: "steady", droppedAt: ago(8) } });
    const r = advanceHealthSnapshot(old, [client("a", { healthLabel: "shaky" })], NOW);
    expect(r.drops).toEqual([]);
    expect(r.next.labels.a).toEqual({ label: "shaky", droppedFrom: "steady", droppedAt: ago(8) });
  });

  it("a further drop inside the window keeps where the slide began; outside it, starts from the last label", () => {
    const recent = state({ a: { label: "shaky", droppedFrom: "thriving", droppedAt: ago(2) } });
    expect(advanceHealthSnapshot(recent, [client("a", { healthLabel: "at_risk" })], NOW).drops[0]).toMatchObject({ from: "thriving", to: "at_risk", droppedAt: NOW.toISOString() });
    const stale = state({ a: { label: "shaky", droppedFrom: "thriving", droppedAt: ago(20) } });
    expect(advanceHealthSnapshot(stale, [client("a", { healthLabel: "at_risk" })], NOW).drops[0]).toMatchObject({ from: "shaky", to: "at_risk" });
  });

  it("a partial recovery keeps the drop; a full one clears it", () => {
    const prev = state({ a: { label: "at_risk", droppedFrom: "steady", droppedAt: ago(1) } });
    expect(advanceHealthSnapshot(prev, [client("a", { healthLabel: "shaky" })], NOW).drops[0]).toMatchObject({ from: "steady", to: "shaky", droppedAt: ago(1) });
    const r = advanceHealthSnapshot(prev, [client("a", { healthLabel: "thriving" })], NOW);
    expect(r.drops).toEqual([]);
    expect(r.next.labels.a).toEqual({ label: "thriving", droppedFrom: null, droppedAt: null });
  });

  it("uses a leader's override over the computed label, and says so", () => {
    const prev = state({ a: { label: "steady" } });
    const r = advanceHealthSnapshot(prev, [client("a", { healthLabel: "thriving", healthOverrideLabel: "at_risk" })], NOW);
    expect(r.drops).toEqual([{ clientId: "a", from: "steady", to: "at_risk", droppedAt: NOW.toISOString(), overridden: true }]);
  });

  it("skips inactive clients, clients with no label, and a new client's first label", () => {
    const prev = state({ a: { label: "steady" }, b: { label: "steady" } });
    const r = advanceHealthSnapshot(
      prev,
      [client("a", { status: "paused", healthLabel: "at_risk" }), client("b", { healthLabel: null }), client("c", { healthLabel: "at_risk" })],
      NOW
    );
    expect(r.drops).toEqual([]);
    expect(Object.keys(r.next.labels)).toEqual(["c"]);
  });

  it("treats a stored label it doesn't know as no history", () => {
    const prev = state({ a: { label: "excellent" } });
    expect(advanceHealthSnapshot(prev, [client("a", { healthLabel: "at_risk" })], NOW).drops).toEqual([]);
  });
});
