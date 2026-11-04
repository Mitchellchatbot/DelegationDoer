import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn()
}));
vi.mock("@/lib/exec/email-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-store")>()),
  getEmailThread: vi.fn(),
  listBucketRows: vi.fn(),
  listCommitments: vi.fn(),
  listSignalsForMessages: vi.fn(),
  listThreadScreenRows: vi.fn(),
  listTombstonedThreadIds: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sources/mail")>()),
  loadScreeningPolicy: vi.fn(),
  readPrincipalThread: vi.fn(),
  loadHisBodies: vi.fn(),
  listAllReplyArtifacts: vi.fn(),
  listReplyArtifacts: vi.fn(),
  countPendingReplyArtifacts: vi.fn()
}));
vi.mock("@/lib/exec/sync-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn()
}));
vi.mock("@/lib/exec/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/attention")>()),
  listAttentionForThread: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd", () => ({
  listTasksForThread: vi.fn(),
  listClients: vi.fn(),
  listClientMeetings: vi.fn(),
  latestScoredInboundByClient: vi.fn()
}));

import { listAttentionForThread } from "@/lib/exec/attention";
import type { AttentionItem } from "@/lib/exec/attention-types";
import {
  getEmailThread,
  listBucketRows,
  listCommitments,
  listSignalsForMessages,
  listThreadScreenRows,
  listTombstonedThreadIds,
  type BucketRow
} from "@/lib/exec/email-store";
import type { ExecCommitment, ExecEmailSignal, ExecEmailThread, HisMessage, MessageMeta, PrincipalMailThread, ThreadScreenRow } from "@/lib/exec/email-types";
import {
  bucketize,
  EMAIL_BUCKETS,
  getEmailTab,
  getEmailThreadPage,
  isThreadIdParam,
  satisfactionFreshness,
  screenCommitments,
  screenEmailAttention,
  summarizeMail,
  type EmailThreadView,
  type ScreeningPolicy
} from "@/lib/exec/email-view";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { latestScoredInboundByClient, listClientMeetings, listClients, listTasksForThread } from "@/lib/exec/sources/dd";
import type { DdClient, DdTask } from "@/lib/exec/sources/dd-types";
import {
  countPendingReplyArtifacts,
  listAllReplyArtifacts,
  listReplyArtifacts,
  loadHisBodies,
  loadScreeningPolicy,
  readPrincipalThread,
  restrictedPolicyHash,
  screenHashesFor
} from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { ruleFromRow } from "@/lib/restricted-senders";
import { BUCKET_ORDER } from "@/components/exec/email/labels";

// The email pages' reads (contract §3.14, L2, A2, §5 F): gating, the
// render-time screen on every stored surface, the live screen before any
// body, the clone-down and problem-account fallbacks, and every section
// failing on its own.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-04T15:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function mint(accounts: string[] = ["acc_his", "acc_two"]): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint();

const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  principalId: "ep_owner",
  ...DEFAULT_SETTINGS,
  mutedChannelIds: [],
  emailEnabled: true,
  emailSchemaReady: true,
  ...over
});

const RULE = ruleFromRow({ id: "r_deel", pattern: "Restricted.Example ", match_kind: "domain", label: "Payroll" }, new Set());
const POLICY: ScreeningPolicy = { rules: [RULE], hash: restrictedPolicyHash("hidden", [RULE]) };
const H = POLICY.hash;
const OLD_H = "0".repeat(64);

const hashesOf = (...addresses: string[]) => screenHashesFor({ all: [{ from: addresses[0] ?? "", to: addresses.slice(1), cc: [] }], participants: [] }).hashes;
const CLEAN = hashesOf("Jane Doe <jane@acme.com>", "mitchell@scaledai.org");
const RESTRICTED = hashesOf("payroll@restricted.example", "mitchell@scaledai.org");

function bucketRow(over: Partial<BucketRow> = {}): BucketRow {
  return {
    threadId: "t_reply",
    accountId: "acc_his",
    state: "triaged",
    screenHashes: CLEAN,
    screenTruncated: false,
    screenedPolicyHash: H,
    subject: "Q4 budget",
    counterpartName: "Jane Doe",
    counterpartEmail: "jane@acme.com",
    messageCount: 3,
    newestMessageId: "m3",
    newestInboundMessageId: "m3",
    newestOutboundMessageId: "m2",
    lastInboundAt: daysAgo(1),
    lastOutboundAt: daysAgo(2),
    newestIsOutbound: false,
    answeredState: "awaiting_reply",
    answeredAt: null,
    partialThread: false,
    outboundAutomatedOnly: false,
    clientId: "c_acme",
    clientName: "Acme",
    clientMatchVia: "exact",
    matchConfidence: "high",
    summary: "Jane asks you to approve the Q4 budget.",
    reason: "A client is waiting on a decision.",
    category: "client",
    urgency: "high",
    importance: "high",
    needsReply: true,
    mitchellPersonally: true,
    awaitingReplyFromOthers: false,
    decisionQuestion: "Approve the Q4 budget?",
    clientSignal: "none",
    injectionSuspected: false,
    filterReason: null,
    triageError: null,
    lastAttemptError: null,
    triagedAt: daysAgo(1),
    deferredAt: null,
    updatedAt: daysAgo(1),
    ...over
  };
}

function threadRow(over: Partial<ExecEmailThread> = {}): ExecEmailThread {
  return {
    ...bucketRow(),
    principalId: "ep_owner",
    version: 4,
    snapshotIdentityCount: 3,
    snapshotMaxCreatedAt: daysAgo(1),
    snapshotMaxSentAt: daysAgo(1),
    snapshotReadStartedAt: daysAgo(1),
    snapshotReadDoneAt: daysAgo(1),
    goneAt: null,
    correspondents: ["jane@acme.com"],
    answeredMessageId: null,
    clientCandidates: 1,
    decisionMessageId: "m3",
    automated: false,
    refusalCategory: null,
    contentHash: "a".repeat(64),
    model: "claude-haiku",
    triageVersion: "email-triage-v1",
    attemptedVersion: "email-triage-v1",
    inputWatermark: daysAgo(1),
    outcomeWatermark: daysAgo(1),
    inputTruncated: false,
    bodySource: "html",
    lastAttemptAt: daysAgo(1),
    firstSeenAt: daysAgo(3),
    expiresAt: daysAgo(-180),
    ...over
  };
}

const screenRow = (threadId: string, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow => ({
  threadId,
  accountId: "acc_his",
  state: "triaged",
  screenHashes: CLEAN,
  screenTruncated: false,
  screenedPolicyHash: H,
  ...over
});

function commitment(id: string, threadId: string, over: Partial<ExecCommitment> = {}): ExecCommitment {
  return {
    id,
    principalId: "ep_owner",
    fingerprint: "f".repeat(64),
    source: "email",
    threadId,
    messageId: "m3",
    accountId: "acc_his",
    direction: "mitchell_owes",
    text: `Send the deck (${id})`,
    counterparty: "Jane",
    dueAt: daysAgo(-2),
    dueText: "Friday",
    status: "open",
    followedUpAt: null,
    evidenceExcerpt: "I'll send the deck by Friday",
    sourceRef: { system: "outlook", id: "m3", url: null, label: "Email message", class: "private" },
    messageSentAt: daysAgo(1),
    messageCreatedAt: daysAgo(1),
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    expiresAt: daysAgo(-180),
    ...over
  };
}

const signal = (messageId: string, over: Partial<ExecEmailSignal> = {}): ExecEmailSignal => ({
  principalId: "ep_owner",
  messageId,
  threadId: "t_reply",
  accountId: "acc_his",
  direction: "inbound",
  flagged: false,
  importance: "normal",
  unread: false,
  removedAt: null,
  webLink: null,
  signalsAt: daysAgo(1),
  expiresAt: daysAgo(-180),
  ...over
});

function his(id: string, over: Partial<HisMessage> = {}): HisMessage {
  return {
    id,
    threadId: "t_reply",
    accountId: "acc_his",
    direction: "inbound",
    folder: "Inbox",
    isJunk: false,
    rfcMessageId: `<${id}@acme.com>`,
    inReplyTo: null,
    subject: "Q4 budget",
    from: { name: "Jane Doe", email: "jane@acme.com" },
    to: [{ name: "Mitchell", email: "mitchell@scaledai.org" }],
    cc: [],
    sentAt: daysAgo(1),
    createdAtMs: NOW.getTime() - 86_400_000,
    isAutomated: false,
    attachments: [],
    bodyDeferred: true,
    bodyHtml: null,
    bodyText: null,
    ...over
  };
}

const meta = (m: HisMessage, over: Partial<MessageMeta> = {}): MessageMeta => ({
  id: m.id,
  accountId: m.accountId,
  direction: m.direction,
  from: m.from ? `${m.from.name} <${m.from.email}>` : "",
  to: m.to.map((a) => a.email),
  cc: m.cc.map((a) => a.email),
  rfcMessageId: m.rfcMessageId,
  inReplyTo: m.inReplyTo,
  createdAtMs: m.createdAtMs,
  sentAt: m.sentAt,
  ...over
});

function liveThread(hisMessages: HisMessage[], extraAll: MessageMeta[] = [], participants: string[] = []): PrincipalMailThread {
  return {
    threadId: "t_reply",
    participants,
    his: hisMessages,
    all: [...hisMessages.map((m) => meta(m)), ...extraAll],
    snapshot: { identityCount: hisMessages.length, maxCreatedAtMs: null, maxSentAtMs: null, readStartedAtMs: 1, readDoneAtMs: 2 },
    lastMessageAt: daysAgo(1)
  };
}

function attentionItem(id: string, fingerprint: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    principalId: "ep_owner",
    fingerprint,
    source: "email",
    kind: "important_email",
    category: "my_action",
    title: `Item ${id}`,
    whatHappened: "",
    whyItMatters: "",
    recommendedNext: null,
    facts: [],
    refs: [],
    priority: { score: 40, band: "normal", reasons: [] },
    stateHash: "0123456789abcdef",
    occurredAt: null,
    status: "open",
    snoozeUntil: null,
    firstSeenAt: daysAgo(1),
    lastSeenAt: daysAgo(0),
    resolvedAt: null,
    resolution: null,
    updatedAt: daysAgo(0),
    ...over
  };
}

const task = (id: string): DdTask => ({
  id,
  title: `Task ${id}`,
  status: "in_progress",
  priority: "medium",
  tags: [],
  departmentId: null,
  assigneeId: null,
  creatorId: "u_owner",
  projectId: null,
  stageId: null,
  clientName: null,
  dueDate: null,
  createdAt: daysAgo(1),
  completedAt: null,
  lastActivityAt: daysAgo(1),
  archivedAt: null,
  archivedBy: null,
  isDraft: false,
  deletedAt: null,
  estimatedHours: 1
});

const client = (over: Partial<DdClient> = {}): DdClient => ({
  id: "c_acme",
  name: "Acme Dental",
  status: "active",
  healthScore: 60,
  healthLabel: "steady",
  healthSampleSize: 10,
  healthComputedAt: daysAgo(1),
  healthOverrideLabel: null,
  healthOverrideBy: null,
  healthOverrideAt: null,
  touchpointOverrideLabel: null,
  touchpointOverrideBy: null,
  touchpointOverrideAt: null,
  lastOutboundEmailAtExternal: null,
  touchpointSyncedAt: null,
  ...over
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

type SyncValues = Record<string, unknown>;
let sync: SyncValues;

function wire() {
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [...POLICY.rules], hash: H });
  vi.mocked(listBucketRows).mockResolvedValue([bucketRow()]);
  vi.mocked(listAllReplyArtifacts).mockResolvedValue(new Map());
  vi.mocked(listReplyArtifacts).mockResolvedValue(new Map());
  vi.mocked(listTombstonedThreadIds).mockResolvedValue([]);
  vi.mocked(countPendingReplyArtifacts).mockResolvedValue({ draftsPending: 2, scheduledReplies: 1 });
  vi.mocked(listCommitments).mockResolvedValue([]);
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(listSignalsForMessages).mockResolvedValue(new Map());
  vi.mocked(getEmailThread).mockResolvedValue(threadRow());
  vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: liveThread([his("m1", { sentAt: daysAgo(2) }), his("m3")]) });
  vi.mocked(loadHisBodies).mockImplementation(async (_p, t, ids) => {
    for (const m of t.his) {
      if (ids.includes(m.id)) {
        m.bodyHtml = `<p>Body of ${m.id}</p><img src="https://cdn.example.com/${m.id}.png">`;
        m.bodyDeferred = false;
      }
    }
  });
  vi.mocked(listTasksForThread).mockResolvedValue([task("t1")]);
  vi.mocked(listClients).mockResolvedValue([client()]);
  vi.mocked(latestScoredInboundByClient).mockResolvedValue(new Map([["c_acme", daysAgo(1)]]));
  vi.mocked(listClientMeetings).mockResolvedValue([{ id: "mt1", title: "QBR", meetingAt: daysAgo(5) }]);
  vi.mocked(listAttentionForThread).mockResolvedValue([attentionItem("ea_1", "email:thread:t_reply:m3")]);
  sync = {
    accounts: {
      value: {
        checkedAt: daysAgo(0),
        accounts: [
          { id: "acc_his", email: "mitchell@scaledai.org", lastSyncedAt: daysAgo(0), lastSyncError: null, lastSyncErrorAt: null },
          { id: "acc_two", email: "m2@scaledai.org", lastSyncedAt: daysAgo(0), lastSyncError: null, lastSyncErrorAt: null }
        ],
        problems: []
      },
      rev: 1
    },
    socket: { value: { connected: true, lastEventAt: daysAgo(0), observedAt: new Date(NOW.getTime() - 60_000).toISOString() }, rev: 1 },
    stagger: null,
    "recon:acc_his": { value: { mode: "feed", backfill: { from: daysAgo(14), startedAt: daysAgo(3), enqueuedAt: daysAgo(2) } }, rev: 1 },
    "recon:acc_two": { value: { mode: "feed", backfill: { from: daysAgo(14), startedAt: daysAgo(3), enqueuedAt: daysAgo(2) } }, rev: 1 }
  };
  vi.mocked(getSyncState).mockImplementation(async (_p, _source, key) => {
    const v = sync[key];
    if (v instanceof Error) throw v;
    return (v ?? null) as never;
  });
}

beforeEach(() => {
  wire();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const failure = () => new Error("read failed: connection reset");
const UNAVAILABLE = { ok: false, error: "unavailable" };

async function tabOn() {
  const view = await getEmailTab(principal, NOW);
  if (view.state !== "on") throw new Error(`expected the tab to be on, got ${view.state}`);
  return view;
}

async function threadOk(id = "t_reply"): Promise<EmailThreadView> {
  const page = await getEmailThreadPage(principal, id, NOW);
  if (page.kind !== "ok") throw new Error("expected the thread page to render");
  return page.view;
}

const EMAIL_READS = [listBucketRows, listAllReplyArtifacts, listTombstonedThreadIds, countPendingReplyArtifacts, listCommitments, loadScreeningPolicy, getSyncState];

// ---------------------------------------------------------------------------
// /executive/email
// ---------------------------------------------------------------------------

describe("getEmailTab: gating", () => {
  it("is off, reading nothing about his mail, before the migration", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailSchemaReady: false, emailEnabled: false }));
    expect(await getEmailTab(principal, NOW)).toEqual({ state: "off", generatedAt: NOW.toISOString(), timezone: "America/New_York" });
    for (const fn of EMAIL_READS) expect(fn).not.toHaveBeenCalled();
  });

  it("is off while email_enabled is false", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailEnabled: false }));
    expect((await getEmailTab(principal, NOW)).state).toBe("off");
    for (const fn of EMAIL_READS) expect(fn).not.toHaveBeenCalled();
  });

  it("says no mailbox is pinned, reading nothing", async () => {
    expect((await getEmailTab(mint([]), NOW)).state).toBe("no_pin");
    for (const fn of EMAIL_READS) expect(fn).not.toHaveBeenCalled();
  });

  it("throws when it can't tell whether email is on, or can't load the rules (the error page)", async () => {
    vi.mocked(loadSettings).mockRejectedValue(failure());
    await expect(getEmailTab(principal, NOW)).rejects.toThrow("connection reset");
    wire();
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("restricted-sender rules unavailable"));
    await expect(getEmailTab(principal, NOW)).rejects.toThrow("rules unavailable");
    expect(listBucketRows).not.toHaveBeenCalled();
  });
});

describe("getEmailTab: buckets and the render-time screen", () => {
  it("buckets screened rows and counts what the screen dropped as restricted", async () => {
    vi.mocked(listBucketRows).mockResolvedValue([
      bucketRow(),
      bucketRow({ threadId: "t_waiting", newestInboundMessageId: "mw1", newestMessageId: "mw2", newestIsOutbound: true, awaitingReplyFromOthers: true, needsReply: false, lastOutboundAt: daysAgo(3), lastInboundAt: daysAgo(6), answeredState: "answered", urgency: "normal", importance: "normal", decisionQuestion: null }),
      bucketRow({ threadId: "t_filtered", newestInboundMessageId: "mf1", newestMessageId: "mf1", state: "filtered", filterReason: "automated_hint", summary: null, needsReply: null, urgency: null, importance: null, decisionQuestion: null }),
      // A rule now matches its stored hashes.
      bucketRow({ threadId: "t_restricted", screenHashes: RESTRICTED, subject: "Payroll" }),
      // Truncated, and screened under older rules: can't be cleared without a fresh read.
      bucketRow({ threadId: "t_stale", screenTruncated: true, screenedPolicyHash: OLD_H, subject: "Stale" })
    ]);
    vi.mocked(listTombstonedThreadIds).mockResolvedValue(["t_tomb1", "t_tomb2"]);
    vi.mocked(listSignalsForMessages).mockResolvedValue(new Map([["m3", signal("m3", { flagged: true, webLink: "https://outlook.office.com/owa/?ItemID=x" })]]));
    const view = await tabOn();
    if (!view.buckets.ok) throw new Error("buckets should load");
    expect(view.buckets.data.counts).toEqual({ reply: 1, urgent: 1, important: 1, waiting: 1, filtered: 1 });
    const all = EMAIL_BUCKETS.flatMap((b) => (view.buckets.ok ? view.buckets.data.lists[b] : []));
    expect(all.map((r) => r.threadId)).not.toContain("t_restricted");
    expect(all.map((r) => r.threadId)).not.toContain("t_stale");
    expect(JSON.stringify(view)).not.toContain("Payroll");
    expect(JSON.stringify(view)).not.toContain("Stale");
    expect(view.restricted).toEqual({ ok: true, data: 4 });
    const reply = view.buckets.data.lists.reply[0];
    expect(reply).toMatchObject({ threadId: "t_reply", href: "/executive/email/t_reply", flagged: true, answered: "awaiting_reply", assessable: false });
    expect(view.buckets.data.lists.filtered[0]).toMatchObject({ threadId: "t_filtered", assessable: true, filterReason: "automated_hint" });
    // Signals are read for the surviving rows' newest inbound and anchor only.
    expect([...vi.mocked(listSignalsForMessages).mock.calls[0][1]].sort()).toEqual(["m3", "mf1", "mw1", "mw2"]);
  });

  it("overlays the answered state: archived in Outlook, a scheduled reply or a pending draft leave Needs your reply", async () => {
    vi.mocked(listBucketRows).mockResolvedValue([
      bucketRow({ threadId: "t_archived", newestInboundMessageId: "m_a", newestMessageId: "m_a" }),
      bucketRow({ threadId: "t_scheduled", newestInboundMessageId: "m_s", newestMessageId: "m_s" }),
      bucketRow({ threadId: "t_draft", newestInboundMessageId: "m_d", newestMessageId: "m_d" })
    ]);
    vi.mocked(listSignalsForMessages).mockResolvedValue(new Map([["m_a", signal("m_a", { removedAt: daysAgo(0) })]]));
    vi.mocked(listAllReplyArtifacts).mockResolvedValue(
      new Map([
        ["t_scheduled", { scheduledFor: daysAgo(-1), draftPending: false }],
        ["t_draft", { scheduledFor: null, draftPending: true }]
      ])
    );
    const view = await tabOn();
    if (!view.buckets.ok) throw new Error("buckets should load");
    expect(view.buckets.data.counts.reply).toBe(0);
    expect(view.buckets.data.lists.important.map((r) => [r.threadId, r.answered])).toEqual([
      ["t_archived", "handled_in_outlook"],
      ["t_draft", "draft_pending"],
      ["t_scheduled", "reply_scheduled"]
    ]);
  });

  it("lists at most 100 rows per bucket, newest first, and keeps the full count", async () => {
    vi.mocked(listBucketRows).mockResolvedValue(
      Array.from({ length: 150 }, (_, i) => bucketRow({ threadId: `t_${String(i).padStart(3, "0")}`, lastInboundAt: new Date(NOW.getTime() - i * 60_000).toISOString(), importance: "normal" }))
    );
    const view = await tabOn();
    if (!view.buckets.ok) throw new Error("buckets should load");
    expect(view.buckets.data.counts.reply).toBe(150);
    expect(view.buckets.data.lists.reply).toHaveLength(100);
    expect(view.buckets.data.lists.reply[0].threadId).toBe("t_000");
  });

  it("fails the buckets (never zeros) when the rows, signals or reply artifacts can't be read", async () => {
    for (const breakIt of [
      () => vi.mocked(listBucketRows).mockRejectedValue(failure()),
      () => vi.mocked(listSignalsForMessages).mockRejectedValue(failure()),
      () => vi.mocked(listAllReplyArtifacts).mockRejectedValue(failure())
    ]) {
      wire();
      breakIt();
      const view = await tabOn();
      expect(view.buckets).toEqual(UNAVAILABLE);
      expect(view.drafts.ok).toBe(true);
    }
  });

  it("fails the restricted count when the rows or the tombstones can't be read", async () => {
    vi.mocked(listTombstonedThreadIds).mockRejectedValue(failure());
    expect((await tabOn()).restricted).toEqual(UNAVAILABLE);
    wire();
    vi.mocked(listBucketRows).mockRejectedValue(failure());
    expect((await tabOn()).restricted).toEqual(UNAVAILABLE);
  });

  it("fails the drafts card on its own", async () => {
    vi.mocked(countPendingReplyArtifacts).mockRejectedValue(failure());
    const view = await tabOn();
    expect(view.drafts).toEqual(UNAVAILABLE);
    expect(view.buckets.ok).toBe(true);
    wire();
    expect((await tabOn()).drafts).toEqual({ ok: true, data: { draftsPending: 2, scheduledReplies: 1 } });
  });
});

describe("getEmailTab: commitments are screened through their own thread rows", () => {
  it("keeps only commitments whose thread row exists, isn't a tombstone or gone, and passes the screen; overdue first", async () => {
    vi.mocked(listCommitments).mockResolvedValue([
      commitment("c_ok", "t_reply"),
      commitment("c_overdue", "t_old", { dueAt: daysAgo(3) }),
      commitment("c_restricted", "t_restricted"),
      commitment("c_tomb", "t_tomb"),
      commitment("c_gone", "t_gone"),
      commitment("c_norow", "t_missing"),
      commitment("c_stale", "t_stale")
    ]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(
      new Map([
        ["t_reply", screenRow("t_reply")],
        // An old thread, outside the 30-day bucket window: still screened, still shown.
        ["t_old", screenRow("t_old", { state: "filtered" })],
        ["t_restricted", screenRow("t_restricted", { screenHashes: RESTRICTED })],
        ["t_tomb", screenRow("t_tomb", { state: "restricted_hidden", screenHashes: [] })],
        ["t_gone", screenRow("t_gone", { state: "gone" })],
        ["t_stale", screenRow("t_stale", { screenTruncated: true, screenedPolicyHash: OLD_H })]
      ])
    );
    const view = await tabOn();
    if (!view.commitments.ok) throw new Error("commitments should load");
    expect(view.commitments.data.items.map((c) => c.id)).toEqual(["c_overdue", "c_ok"]);
    expect(view.commitments.data).toMatchObject({ total: 2, overdue: 1 });
    expect(view.commitments.data.items[1]).toMatchObject({ threadSubject: "Q4 budget", threadHref: "/executive/email/t_reply", evidence: null });
    expect(view.commitments.data.items[0].threadSubject).toBeNull();
    expect([...vi.mocked(listThreadScreenRows).mock.calls[0][1]].sort()).toEqual(["t_gone", "t_missing", "t_old", "t_reply", "t_restricted", "t_stale", "t_tomb"]);
  });

  it("fails the card when the commitments or their rows can't be read", async () => {
    vi.mocked(listCommitments).mockResolvedValue([commitment("c1", "t_reply")]);
    vi.mocked(listThreadScreenRows).mockRejectedValue(failure());
    expect((await tabOn()).commitments).toEqual(UNAVAILABLE);
    wire();
    vi.mocked(listCommitments).mockRejectedValue(failure());
    expect((await tabOn()).commitments).toEqual(UNAVAILABLE);
  });
});

describe("getEmailTab: freshness", () => {
  it("reports synced mailboxes, live updates, the signals feed and satisfaction freshness", async () => {
    const { freshness } = await tabOn();
    expect(freshness.accounts).toMatchObject({ ok: true, data: { checkedAt: daysAgo(0) } });
    expect(freshness.socket).toMatchObject({ ok: true, data: { connected: true, stale: false } });
    expect(freshness.sync).toEqual({ ok: true, data: { signals: "available", catchingUp: false, catchingUpUntil: null } });
    expect(freshness.satisfaction).toEqual({ ok: true, data: { fresh: 1, active: 1, freshDays: 3 } });
  });

  it("says for how many active clients the satisfaction scores are fresh (L13), counting only active clients", async () => {
    vi.mocked(listClients).mockResolvedValue([
      client({ id: "c_acme" }),
      client({ id: "c_stale" }),
      client({ id: "c_never" }),
      client({ id: "c_gone", status: "churned" })
    ]);
    vi.mocked(latestScoredInboundByClient).mockResolvedValue(
      new Map([
        ["c_acme", daysAgo(1)],
        ["c_stale", daysAgo(4)],
        // A fresh score for an inactive client counts toward neither number.
        ["c_gone", daysAgo(0)]
      ])
    );
    const { freshness } = await tabOn();
    expect(freshness.satisfaction).toEqual({ ok: true, data: { fresh: 1, active: 3, freshDays: 3 } });
    // The read is taken as of the page's own clock.
    expect(vi.mocked(latestScoredInboundByClient).mock.calls[0][1]).toMatchObject({ now: NOW });
  });

  it("fails the satisfaction line on its own when either read fails", async () => {
    vi.mocked(listClients).mockRejectedValue(failure());
    let view = await tabOn();
    expect(view.freshness.satisfaction).toEqual(UNAVAILABLE);
    expect(view.freshness.accounts.ok).toBe(true);
    expect(view.buckets.ok).toBe(true);
    wire();
    vi.mocked(latestScoredInboundByClient).mockRejectedValue(failure());
    view = await tabOn();
    expect(view.freshness.satisfaction).toEqual(UNAVAILABLE);
    expect(view.freshness.sync.ok).toBe(true);
  });

  it("says not synced yet before the first reconcile", async () => {
    sync.accounts = null;
    sync.socket = null;
    sync["recon:acc_his"] = null;
    const { freshness } = await tabOn();
    expect(freshness.accounts).toMatchObject({ ok: true, data: { checkedAt: null } });
    expect(freshness.socket).toEqual({ ok: true, data: null });
    expect(freshness.sync).toMatchObject({ ok: true, data: { signals: "unknown", catchingUp: true } });
  });

  it("names problem accounts and failing syncs", async () => {
    sync.accounts = {
      value: {
        checkedAt: daysAgo(0),
        accounts: [
          { id: "acc_his", email: "mitchell@scaledai.org", lastSyncedAt: daysAgo(2), lastSyncError: "AADSTS70000: invalid_grant", lastSyncErrorAt: daysAgo(1) },
          { id: "acc_two", email: "m2@scaledai.org", lastSyncedAt: daysAgo(0), lastSyncError: null, lastSyncErrorAt: null }
        ],
        problems: [{ accountId: "acc_two", reason: "email_mismatch" }]
      },
      rev: 2
    };
    const { freshness } = await tabOn();
    if (!freshness.accounts.ok) throw new Error("accounts should load");
    expect(freshness.accounts.data.mailboxes).toEqual([
      { accountId: "acc_his", address: "mitchell@scaledai.org", lastSyncedAt: daysAgo(2), failingSince: daysAgo(1), failingError: "AADSTS70000: invalid_grant", problem: null },
      { accountId: "acc_two", address: "m2@scaledai.org", lastSyncedAt: daysAgo(0), failingSince: null, failingError: null, problem: "email_mismatch" }
    ]);
  });

  it("says Outlook signals aren't available in list mode, and catching up while the queue is ahead", async () => {
    sync["recon:acc_two"] = { value: { mode: "list", backfill: { from: daysAgo(14), startedAt: daysAgo(3), enqueuedAt: daysAgo(2) } }, rev: 1 };
    const until = new Date(NOW.getTime() + 600_000).toISOString();
    sync.stagger = { value: { lastRunAfter: until }, rev: 3 };
    const { freshness } = await tabOn();
    expect(freshness.sync).toEqual({ ok: true, data: { signals: "unavailable", catchingUp: true, catchingUpUntil: until } });
  });

  it("marks live updates stale when the worker stopped reporting", async () => {
    sync.socket = { value: { connected: true, lastEventAt: null, observedAt: daysAgo(1) }, rev: 1 };
    expect((await tabOn()).freshness.socket).toMatchObject({ ok: true, data: { stale: true } });
  });

  it("fails each freshness part on its own", async () => {
    sync.accounts = new Error("x");
    sync.socket = new Error("y");
    sync.stagger = new Error("z");
    vi.mocked(latestScoredInboundByClient).mockRejectedValue(failure());
    const view = await tabOn();
    expect(view.freshness).toEqual({ accounts: UNAVAILABLE, socket: UNAVAILABLE, sync: UNAVAILABLE, satisfaction: UNAVAILABLE });
    expect(view.buckets.ok).toBe(true);
  });
});

describe("satisfactionFreshness (L13)", () => {
  const at = (iso: string) => new Map([["c_1", iso]]);
  const one = [{ id: "c_1", status: "active" }];

  it("counts a client fresh up to exactly 3 days after its newest score, and not a millisecond later", () => {
    const scored = NOW.getTime() - 3 * 86_400_000;
    expect(satisfactionFreshness(one, at(new Date(scored).toISOString()), NOW)).toEqual({ fresh: 1, active: 1, freshDays: 3 });
    expect(satisfactionFreshness(one, at(new Date(scored - 1).toISOString()), NOW)).toEqual({ fresh: 0, active: 1, freshDays: 3 });
  });

  it("a client with no score, or an unreadable one, isn't fresh", () => {
    expect(satisfactionFreshness(one, new Map(), NOW)).toEqual({ fresh: 0, active: 1, freshDays: 3 });
    expect(satisfactionFreshness(one, at("not a time"), NOW)).toEqual({ fresh: 0, active: 1, freshDays: 3 });
  });

  it("active means status empty or 'active', as DD's pages read it; nothing else counts", () => {
    const clients = [
      { id: "c_1", status: "active" },
      { id: "c_2", status: "" },
      { id: "c_3", status: "paused" },
      { id: "c_4", status: "Active" }
    ];
    const latest = new Map(clients.map((c) => [c.id, daysAgo(0)]));
    expect(satisfactionFreshness(clients, latest, NOW)).toEqual({ fresh: 2, active: 2, freshDays: 3 });
  });
});

// ---------------------------------------------------------------------------
// /executive/email/[threadId]
// ---------------------------------------------------------------------------

describe("getEmailThreadPage: every 404", () => {
  it("refuses a malformed id before reading anything", async () => {
    for (const id of ["", "../x", "a/b", "t?x=1", "t,x", " t", "x".repeat(201)]) {
      expect(await getEmailThreadPage(principal, id, NOW)).toEqual({ kind: "not_found" });
    }
    expect(loadSettings).not.toHaveBeenCalled();
    expect(isThreadIdParam("2f1c1a7e-9d1b-4c55-8d3e-7a9f2b6c1d00")).toBe(true);
  });

  it("404s when email is off, not installed, or nothing is pinned", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailEnabled: false }));
    expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailSchemaReady: false, emailEnabled: false }));
    expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
    wire();
    expect((await getEmailThreadPage(mint([]), "t_reply", NOW)).kind).toBe("not_found");
    expect(getEmailThread).not.toHaveBeenCalled();
  });

  it("404s for no row, a tombstone, a gone row, or a row on an account he no longer has", async () => {
    for (const row of [null, threadRow({ state: "restricted_hidden" }), threadRow({ state: "gone" }), threadRow({ accountId: "acc_other" })]) {
      vi.mocked(getEmailThread).mockResolvedValue(row);
      expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
    }
    expect(readPrincipalThread).not.toHaveBeenCalled();
  });

  it("404s on the stored screen (a rule match, or a stale truncated row) without a live read", async () => {
    for (const row of [threadRow({ screenHashes: RESTRICTED }), threadRow({ screenTruncated: true, screenedPolicyHash: OLD_H })]) {
      vi.mocked(getEmailThread).mockResolvedValue(row);
      expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
    }
    expect(readPrincipalThread).not.toHaveBeenCalled();
  });

  it("404s when the mail service says not found or not his", async () => {
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "not_found", readDoneAtMs: NOW.getTime() });
    expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "not_his" });
    expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
  });

  it("404s on a live restricted CC, or a restricted participant, before any body is fetched", async () => {
    const inbound = his("m3");
    const otherAccount: MessageMeta = { ...meta(inbound), id: "m_other", accountId: "acc_team", cc: ["Payroll <payroll@restricted.example>"] };
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: liveThread([inbound], [otherAccount]) });
    expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: liveThread([his("m3")], [], ["ops@restricted.example"]) });
    expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
    expect(loadHisBodies).not.toHaveBeenCalled();
    expect(listTasksForThread).not.toHaveBeenCalled();
  });

  it("throws (the error page) when the settings, rules, row or mailbox state can't be read", async () => {
    const breakers = [
      () => vi.mocked(loadSettings).mockRejectedValue(failure()),
      () => vi.mocked(loadScreeningPolicy).mockRejectedValue(failure()),
      () => vi.mocked(getEmailThread).mockRejectedValue(failure()),
      () => {
        sync.accounts = failure();
      }
    ];
    for (const breakIt of breakers) {
      wire();
      breakIt();
      await expect(getEmailThreadPage(principal, "t_reply", NOW)).rejects.toThrow();
    }
  });
});

describe("getEmailThreadPage: the live read", () => {
  it("renders his messages only, newest first, bodies built into sandboxed documents", async () => {
    const mine = [his("m1", { sentAt: daysAgo(2) }), his("m2", { direction: "outbound", from: { name: "Mitchell", email: "mitchell@scaledai.org" }, sentAt: daysAgo(1.5) }), his("m3")];
    const teammates: MessageMeta = { id: "m_team", accountId: "acc_team", direction: "inbound", from: "Sam <sam@scaledai.org>", to: ["jane@acme.com"], cc: [], rfcMessageId: "<team@x>", inReplyTo: null, createdAtMs: 1, sentAt: daysAgo(1) };
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: liveThread(mine, [teammates]) });
    const view = await threadOk();
    expect(view.mode).toBe("live");
    expect(view.messages?.map((m) => m.id)).toEqual(["m3", "m2", "m1"]);
    expect(JSON.stringify(view)).not.toContain("m_team");
    expect(JSON.stringify(view)).not.toContain("sam@scaledai.org");
    const body = view.messages?.[0].body;
    if (body?.kind !== "html") throw new Error("expected an html body");
    expect(body.srcdoc.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(body.srcdoc).toContain("<p>Body of m3</p><img>");
    expect(body.remoteImages).toBe(1);
    expect(body.imagesSrcdoc).toContain('<img src="https://cdn.example.com/m3.png">');
    expect(readPrincipalThread).toHaveBeenCalledWith(principal, "t_reply", { usable: ["acc_his", "acc_two"], timeoutMs: 15_000 });
    expect(vi.mocked(loadHisBodies).mock.calls[0][2]).toEqual(["m3", "m2", "m1"]);
    expect(vi.mocked(loadHisBodies).mock.calls[0][3]).toMatchObject({ timeoutMs: 15_000, signal: expect.any(AbortSignal) });
  });

  it("loads only the newest 15 bodies", async () => {
    const many = Array.from({ length: 20 }, (_, i) => his(`m${String(i).padStart(2, "0")}`, { sentAt: new Date(NOW.getTime() - (20 - i) * 3_600_000).toISOString() }));
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: liveThread(many) });
    const view = await threadOk();
    expect(vi.mocked(loadHisBodies).mock.calls[0][2]).toHaveLength(15);
    expect(view.messages?.filter((m) => m.body.kind === "not_loaded").map((m) => m.id)).toEqual(["m04", "m03", "m02", "m01", "m00"]);
  });

  it("shows a text body as text, and says when there is none", async () => {
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: liveThread([his("m1", { sentAt: daysAgo(2) }), his("m2")]) });
    vi.mocked(loadHisBodies).mockImplementation(async (_p, t) => {
      t.his[0].bodyText = "Plain <b>text</b>";
      t.his[0].bodyDeferred = false;
      t.his[1].bodyDeferred = false;
    });
    const view = await threadOk();
    expect(view.messages?.map((m) => m.body)).toEqual([{ kind: "empty" }, { kind: "text", text: "Plain <b>text</b>", truncated: false }]);
  });

  it("keeps the messages, marked, when bodies time out", async () => {
    vi.mocked(loadHisBodies).mockRejectedValue(Object.assign(new Error("clone call timed out"), { name: "TimeoutError" }));
    const view = await threadOk();
    expect(view.mode).toBe("live");
    expect(view.bodiesFailed).toBe(true);
    expect(view.messages?.map((m) => m.body.kind)).toEqual(["not_loaded", "not_loaded"]);
  });

  it("notes a partial thread, stored or live", async () => {
    vi.mocked(readPrincipalThread).mockResolvedValue({ kind: "ok", thread: liveThread([his("m3", { inReplyTo: "<missing@acme.com>" })]) });
    expect((await threadOk()).partialThread).toBe(true);
    wire();
    vi.mocked(getEmailThread).mockResolvedValue(threadRow({ partialThread: true }));
    expect((await threadOk()).partialThread).toBe(true);
    wire();
    expect((await threadOk()).partialThread).toBe(false);
  });
});

describe("getEmailThreadPage: the stored fallbacks", () => {
  it("clone down: the screened stored sections and no messages", async () => {
    vi.mocked(readPrincipalThread).mockRejectedValue(Object.assign(new Error("clone thread read answered HTTP 503"), { status: 503 }));
    const view = await threadOk();
    expect(view.mode).toBe("clone_unavailable");
    expect(view.messages).toBeNull();
    expect(view.thread).toMatchObject({ subject: "Q4 budget", summary: "Jane asks you to approve the Q4 budget." });
    expect(view.tasks.ok).toBe(true);
    expect(view.ddInboxUrl).toBe("https://operations.scaledai.org/inboxes/acc_his?thread=t_reply&acct=acc_his");
  });

  it("clone down on a restricted row is still a 404: the stored screen ran first", async () => {
    vi.mocked(readPrincipalThread).mockRejectedValue(new Error("down"));
    vi.mocked(getEmailThread).mockResolvedValue(threadRow({ screenHashes: RESTRICTED }));
    expect((await getEmailThreadPage(principal, "t_reply", NOW)).kind).toBe("not_found");
  });

  it("a problem account: no live read, stored sections, no DD inbox link", async () => {
    (sync.accounts as { value: { problems: unknown[] } }).value.problems = [{ accountId: "acc_his", reason: "not_found" }];
    const view = await threadOk();
    expect(readPrincipalThread).not.toHaveBeenCalled();
    expect(view.mode).toBe("account_problem");
    expect(view.messages).toBeNull();
    expect(view.ddInboxUrl).toBeNull();
    expect(view.thread.summary).toBe("Jane asks you to approve the Q4 budget.");
  });

  it("a problem on his other account narrows the live read to the usable one", async () => {
    (sync.accounts as { value: { problems: unknown[] } }).value.problems = [{ accountId: "acc_two", reason: "not_microsoft" }];
    await threadOk();
    expect(readPrincipalThread).toHaveBeenCalledWith(principal, "t_reply", { usable: ["acc_his"], timeoutMs: 15_000 });
  });
});

describe("getEmailThreadPage: the side sections' deadline (ui-1)", () => {
  // Each side read honours the signal it is handed, as the real reads do.
  const honour =
    <T>(value: T) =>
    async (...args: unknown[]): Promise<T> => {
      (args.at(-1) as { signal?: AbortSignal } | undefined)?.signal?.throwIfAborted();
      return value;
    };
  const OUTLOOK = "https://outlook.office.com/owa/?ItemID=AAMk%3D&exvsurl=1&viewmodel=ReadMessageItem";

  function wireHonouring() {
    vi.mocked(listSignalsForMessages).mockImplementation(honour(new Map([["m3", signal("m3", { webLink: OUTLOOK, removedAt: daysAgo(0) })]])));
    vi.mocked(listReplyArtifacts).mockImplementation(honour(new Map()));
    vi.mocked(listCommitments).mockImplementation(honour([commitment("c1", "t_reply")]));
    vi.mocked(listTasksForThread).mockImplementation(honour([task("t1")]));
    vi.mocked(listClients).mockImplementation(honour([client()]));
    vi.mocked(listClientMeetings).mockImplementation(honour([]));
    vi.mocked(listAttentionForThread).mockImplementation(honour([attentionItem("ea_1", "email:thread:t_reply:m3")]));
  }

  it("a clone read that times out after the page's first deadline ran out still leaves every side section loaded", async () => {
    wireHonouring();
    const first = new AbortController();
    const handed = [first.signal, new AbortController().signal];
    const deadline = vi.fn(() => handed.shift() ?? new AbortController().signal);
    // The clone takes its whole 15 s: the first deadline expires while it waits, then the read times out.
    vi.mocked(readPrincipalThread).mockImplementation(async () => {
      first.abort(new DOMException("deadline", "TimeoutError"));
      throw Object.assign(new Error("clone thread read timed out"), { name: "TimeoutError" });
    });
    const page = await getEmailThreadPage(principal, "t_reply", NOW, { deadline });
    if (page.kind !== "ok") throw new Error("expected the thread page to render");
    const view = page.view;
    expect(view.mode).toBe("clone_unavailable");
    expect(view.commitments).toMatchObject({ ok: true, data: [expect.objectContaining({ id: "c1" })] });
    expect(view.attention).toMatchObject({ ok: true, data: [expect.objectContaining({ id: "ea_1" })] });
    expect(view.tasks.ok).toBe(true);
    expect(view.client).toMatchObject({ ok: true, data: { id: "c_acme" } });
    expect(view.answeredUnchecked).toBe(false);
    expect(view.thread.answered).toBe("handled_in_outlook");
    expect(view.outlookUrl).toBe(OUTLOOK);
    expect(deadline).toHaveBeenCalledTimes(2);
  });

  it("a slow but successful live read and body load don't eat the side sections' time either", async () => {
    wireHonouring();
    const first = new AbortController();
    const handed = [first.signal, new AbortController().signal];
    vi.mocked(readPrincipalThread).mockImplementation(async () => {
      first.abort(new DOMException("deadline", "TimeoutError"));
      return { kind: "ok", thread: liveThread([his("m1", { sentAt: daysAgo(2) }), his("m3")]) };
    });
    const page = await getEmailThreadPage(principal, "t_reply", NOW, { deadline: () => handed.shift() ?? new AbortController().signal });
    if (page.kind !== "ok") throw new Error("expected the thread page to render");
    expect(page.view.mode).toBe("live");
    expect(page.view.messages?.map((m) => m.id)).toEqual(["m3", "m1"]);
    expect([page.view.commitments.ok, page.view.tasks.ok, page.view.client.ok, page.view.attention.ok]).toEqual([true, true, true, true]);
  });
});

describe("Assess is offered only where triage would run it (ui-2)", () => {
  const filteredRow = (threadId: string, accountId: string) =>
    bucketRow({ threadId, accountId, newestInboundMessageId: `${threadId}_m`, newestMessageId: `${threadId}_m`, state: "filtered", filterReason: "automated_hint", needsReply: null, urgency: null, importance: null, decisionQuestion: null });

  it("the tab: not on a row of a problem account; left to the route when the mailbox state can't be read", async () => {
    vi.mocked(listBucketRows).mockResolvedValue([filteredRow("t_ok", "acc_his"), filteredRow("t_problem", "acc_two")]);
    (sync.accounts as { value: { problems: unknown[] } }).value.problems = [{ accountId: "acc_two", reason: "not_found" }];
    let view = await tabOn();
    if (!view.buckets.ok) throw new Error("buckets should load");
    expect(view.buckets.data.lists.filtered.map((r) => [r.threadId, r.assessable])).toEqual([
      ["t_ok", true],
      ["t_problem", false]
    ]);
    sync.accounts = failure();
    view = await tabOn();
    if (!view.buckets.ok) throw new Error("buckets should load");
    expect(view.buckets.data.lists.filtered.every((r) => r.assessable)).toBe(true);
  });

  it("the thread page: not while its mailbox is a problem account", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(threadRow({ state: "deferred_budget", lastAttemptError: "budget" }));
    expect((await threadOk()).thread.assessable).toBe(true);
    (sync.accounts as { value: { problems: unknown[] } }).value.problems = [{ accountId: "acc_his", reason: "not_found" }];
    const view = await threadOk();
    expect(view.mode).toBe("account_problem");
    expect(view.thread.assessable).toBe(false);
  });
});

describe("only the mailboxes pinned to him now (ui-3)", () => {
  it("the tab leaves out rows and commitments of an account no longer pinned, without counting them as restricted", async () => {
    vi.mocked(listBucketRows).mockResolvedValue([bucketRow(), bucketRow({ threadId: "t_old", accountId: "acc_old", newestInboundMessageId: "mo", newestMessageId: "mo", subject: "Old copy" })]);
    vi.mocked(listCommitments).mockResolvedValue([commitment("c_ok", "t_reply"), commitment("c_old", "t_old")]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([["t_reply", screenRow("t_reply")], ["t_old", screenRow("t_old", { accountId: "acc_old" })]]));
    const view = await tabOn();
    if (!view.buckets.ok || !view.commitments.ok) throw new Error("sections should load");
    expect(view.buckets.data.counts.reply).toBe(1);
    expect(EMAIL_BUCKETS.flatMap((b) => (view.buckets.ok ? view.buckets.data.lists[b] : [])).map((r) => r.threadId)).not.toContain("t_old");
    expect(JSON.stringify(view)).not.toContain("Old copy");
    expect(view.restricted).toEqual({ ok: true, data: 0 });
    expect(view.commitments.data.items.map((c) => c.id)).toEqual(["c_ok"]);
    // Its signals aren't even read.
    expect(vi.mocked(listSignalsForMessages).mock.calls[0][1]).not.toContain("mo");
  });
});

describe("catching up, over the mailboxes reconcile reads (ui-4)", () => {
  it("a problem account that was never reconciled doesn't keep the tab catching up", async () => {
    (sync.accounts as { value: { problems: unknown[] } }).value.problems = [{ accountId: "acc_two", reason: "email_mismatch" }];
    sync["recon:acc_two"] = null;
    expect((await tabOn()).freshness.sync).toEqual({ ok: true, data: { signals: "available", catchingUp: false, catchingUpUntil: null } });
  });

  it("every pinned mailbox a problem: no catching-up line, signals unknown", async () => {
    (sync.accounts as { value: { problems: unknown[] } }).value.problems = [
      { accountId: "acc_his", reason: "not_found" },
      { accountId: "acc_two", reason: "not_found" }
    ];
    sync["recon:acc_his"] = null;
    sync["recon:acc_two"] = null;
    expect((await tabOn()).freshness.sync).toEqual({ ok: true, data: { signals: "unknown", catchingUp: false, catchingUpUntil: null } });
  });

  it("a usable mailbox still mid-backfill does keep it catching up", async () => {
    (sync.accounts as { value: { problems: unknown[] } }).value.problems = [{ accountId: "acc_two", reason: "email_mismatch" }];
    sync["recon:acc_his"] = { value: { mode: "feed", backfill: { from: daysAgo(14), startedAt: daysAgo(0), enqueuedAt: null } }, rev: 1 };
    expect((await tabOn()).freshness.sync).toMatchObject({ ok: true, data: { catchingUp: true } });
  });
});

describe("getEmailThreadPage: sections", () => {
  it("carries the overlay, the Outlook link (allowlisted only), commitments with evidence, tasks, client and attention", async () => {
    vi.mocked(listSignalsForMessages).mockResolvedValue(new Map([["m3", signal("m3", { webLink: "https://outlook.office.com/owa/?ItemID=AAMk%3D&exvsurl=1&viewmodel=ReadMessageItem" })]]));
    vi.mocked(listReplyArtifacts).mockResolvedValue(new Map([["t_reply", { scheduledFor: daysAgo(-1), draftPending: false }]]));
    vi.mocked(listCommitments).mockResolvedValue([commitment("c1", "t_reply"), commitment("c2", "t_reply", { dueAt: daysAgo(1) })]);
    const view = await threadOk();
    expect(view.thread.answered).toBe("reply_scheduled");
    expect(view.answeredUnchecked).toBe(false);
    expect(view.outlookUrl).toBe("https://outlook.office.com/owa/?ItemID=AAMk%3D&exvsurl=1&viewmodel=ReadMessageItem");
    if (!view.commitments.ok) throw new Error("commitments should load");
    expect(view.commitments.data.map((c) => [c.id, c.overdue, c.evidence])).toEqual([
      ["c2", true, "I'll send the deck by Friday"],
      ["c1", false, "I'll send the deck by Friday"]
    ]);
    expect(listCommitments).toHaveBeenCalledWith(principal, { statuses: ["open", "followed_up", "expired"], threadIds: ["t_reply"] }, { signal: expect.any(AbortSignal) });
    expect(view.tasks).toEqual({ ok: true, data: [expect.objectContaining({ id: "t1", href: "/tasks/t1" })] });
    expect(view.client).toEqual({
      ok: true,
      data: { id: "c_acme", name: "Acme Dental", via: "exact", confidence: "high", candidates: 1, health: "steady", healthOverridden: false, meetings: [{ id: "mt1", title: "QBR", meetingAt: daysAgo(5) }] }
    });
    expect(view.attention).toEqual({ ok: true, data: [expect.objectContaining({ id: "ea_1" })] });
  });

  it("shows only attention items about this thread (A2)", async () => {
    vi.mocked(listAttentionForThread).mockResolvedValue([
      attentionItem("ea_this", "email:thread:t_reply:m3"),
      attentionItem("ea_commit", "email:commitment:t_reply:ec_1"),
      attentionItem("ea_other", "email:thread:t_other:m9"),
      attentionItem("ea_client", "email:satisfaction:c_acme"),
      attentionItem("ea_bad", "not-a-fingerprint")
    ]);
    const view = await threadOk();
    expect(view.attention.ok && view.attention.data.map((i) => i.id)).toEqual(["ea_this", "ea_commit"]);
  });

  it("never links an Outlook URL that isn't one Outlook item", async () => {
    vi.mocked(listSignalsForMessages).mockResolvedValue(new Map([["m3", signal("m3", { webLink: "https://evil.example/owa/?ItemID=x" })]]));
    expect((await threadOk()).outlookUrl).toBeNull();
  });

  it("shows the stored answered state, marked unchecked, when the overlay can't be read", async () => {
    vi.mocked(listSignalsForMessages).mockRejectedValue(failure());
    const view = await threadOk();
    expect(view.thread.answered).toBe("awaiting_reply");
    expect(view.answeredUnchecked).toBe(true);
    expect(view.outlookUrl).toBeNull();
  });

  it("fails each side section on its own", async () => {
    vi.mocked(listCommitments).mockRejectedValue(failure());
    vi.mocked(listTasksForThread).mockRejectedValue(failure());
    vi.mocked(listClients).mockRejectedValue(failure());
    vi.mocked(listAttentionForThread).mockRejectedValue(failure());
    const view = await threadOk();
    expect([view.commitments, view.tasks, view.client, view.attention]).toEqual([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    expect(view.messages).not.toBeNull();
  });

  it("has no client section data without a client match", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(threadRow({ clientId: null, clientName: null, clientMatchVia: null, matchConfidence: null }));
    expect((await threadOk()).client).toEqual({ ok: true, data: null });
    expect(listClients).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("screenEmailAttention", () => {
  const dd = { ...attentionItem("ea_dd", "dd:overdue:assignee:u1"), source: "dd" as const };
  const items = [
    dd,
    attentionItem("ea_ok", "email:thread:t_reply:m3"),
    attentionItem("ea_commit", "email:commitment:t_reply:ec_1"),
    attentionItem("ea_restricted", "email:thread:t_restricted:m9"),
    attentionItem("ea_tomb", "email:thread:t_tomb:m9"),
    attentionItem("ea_gone", "email:thread:t_gone:m9"),
    attentionItem("ea_norow", "email:thread:t_missing:m9"),
    attentionItem("ea_stale", "email:thread:t_stale:m9"),
    attentionItem("ea_sat", "email:satisfaction:c_acme", { kind: "client_satisfaction_drop" }),
    attentionItem("ea_bad", "email:thread:")
  ];
  const rows = new Map([
    ["t_reply", screenRow("t_reply")],
    ["t_restricted", screenRow("t_restricted", { screenHashes: RESTRICTED })],
    ["t_tomb", screenRow("t_tomb", { state: "restricted_hidden", screenHashes: [] })],
    ["t_gone", screenRow("t_gone", { state: "gone" })],
    ["t_stale", screenRow("t_stale", { screenTruncated: true, screenedPolicyHash: OLD_H })]
  ]);

  it("keeps an email item only when its thread row passes and isn't gone; client-level items pass", () => {
    const out = screenEmailAttention(items, { emailOn: true, policy: POLICY, rowsByThread: rows });
    expect(out.items.map((i) => i.id)).toEqual(["ea_dd", "ea_ok", "ea_commit", "ea_sat"]);
    expect(out.dropped).toBe(6);
    expect(out.unchecked).toBe(false);
  });

  it("drops every email item while email is off", () => {
    const out = screenEmailAttention(items, { emailOn: false, policy: null, rowsByThread: null });
    expect(out.items.map((i) => i.id)).toEqual(["ea_dd"]);
    expect(out.unchecked).toBe(false);
  });

  it("drops every email item, and says so, when the screen can't run", () => {
    for (const screen of [
      { emailOn: true, policy: null, rowsByThread: rows },
      { emailOn: true, policy: POLICY, rowsByThread: null }
    ]) {
      const out = screenEmailAttention(items, screen);
      expect(out.items.map((i) => i.id)).toEqual(["ea_dd"]);
      expect(out.unchecked).toBe(true);
    }
    expect(screenEmailAttention([dd], { emailOn: true, policy: null, rowsByThread: null }).unchecked).toBe(false);
  });
});

describe("pure helpers", () => {
  it("screenCommitments drops what hangs off a missing, tombstoned, gone or restricted row", () => {
    const rows = new Map([
      ["a", screenRow("a")],
      ["b", screenRow("b", { screenHashes: RESTRICTED })],
      ["c", screenRow("c", { state: "gone" })]
    ]);
    const out = screenCommitments([commitment("1", "a"), commitment("2", "b"), commitment("3", "c"), commitment("4", "d")], rows, POLICY);
    expect(out.kept.map((c) => c.id)).toEqual(["1"]);
    expect(out.dropped).toBe(3);
  });

  it("bucketize counts decision asks still awaiting his reply within 30 days", () => {
    const rows = [
      bucketRow({ threadId: "a" }),
      bucketRow({ threadId: "b", answeredState: "answered" }),
      bucketRow({ threadId: "c", lastInboundAt: daysAgo(31) }),
      bucketRow({ threadId: "d", decisionQuestion: null }),
      bucketRow({ threadId: "e", state: "filtered" })
    ];
    expect(bucketize(rows, new Map(), new Map(), NOW).decisionAsks).toBe(1);
  });

  it("summarizeMail reports the newest sync, the earliest failure and problems", () => {
    const s = summarizeMail(
      {
        checkedAt: daysAgo(0),
        accounts: [
          { id: "a", email: "x@y", lastSyncedAt: daysAgo(1), lastSyncError: "boom", lastSyncErrorAt: daysAgo(0.5) },
          { id: "b", email: "z@y", lastSyncedAt: daysAgo(0.1), lastSyncError: null, lastSyncErrorAt: null }
        ],
        problems: [{ accountId: "b", reason: "not_found" }]
      },
      { connected: false, observedAt: daysAgo(0) },
      ["a", "b"],
      NOW
    );
    expect(s).toEqual({ checkedAt: daysAgo(0), lastSyncedAt: daysAgo(0.1), failingSince: daysAgo(0.5), problems: 1, socket: { connected: false, observedAt: daysAgo(0), stale: false } });
    expect(summarizeMail(null, null, ["a"], NOW)).toEqual({ checkedAt: null, lastSyncedAt: null, failingSince: null, problems: 0, socket: null });
  });

  it("keeps the page's bucket order in step with the components'", () => {
    expect([...EMAIL_BUCKETS]).toEqual([...BUCKET_ORDER]);
  });
});
