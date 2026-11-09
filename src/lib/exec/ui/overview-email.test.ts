import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => ({
  getPendingApprovals: vi.fn(),
  listActivitySince: vi.fn(),
  listDepartments: vi.fn(),
  listEodNotesForDate: vi.fn(),
  listOpenTasks: vi.fn(),
  listProjects: vi.fn(),
  listProjectStages: vi.fn(),
  listStatusChangeEntries: vi.fn(),
  listTasksByIds: vi.fn(),
  listTasksCompletedBetween: vi.fn(),
  listTasksCreatedBetween: vi.fn(),
  listTimeEntriesBetween: vi.fn(),
  listUsers: vi.fn(),
  listTasksForThread: vi.fn(),
  listClients: vi.fn(),
  listClientMeetings: vi.fn()
}));
// P5a (K8): the feed comes through the screened accessor (attention-read.ts),
// which runs for real here over a stubbed store read, so these tests still
// cover the email screen end to end.
vi.mock("@/lib/exec/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/attention")>()),
  listAttentionPage: vi.fn(),
  lastAttentionRefresh: vi.fn(),
  syncAttention: vi.fn()
}));
vi.mock("@/lib/exec/principal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn()
}));
vi.mock("@/lib/exec/email-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-store")>()),
  listBucketRows: vi.fn(),
  listCommitments: vi.fn(),
  listSignalsForMessages: vi.fn(),
  listThreadScreenRows: vi.fn(),
  listTombstonedThreadIds: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sources/mail")>()),
  loadScreeningPolicy: vi.fn(),
  listAllReplyArtifacts: vi.fn()
}));
vi.mock("@/lib/exec/sync-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn()
}));

import { OverviewView } from "@/components/exec/overview/OverviewView";
import { fakeAttentionPage } from "@/lib/exec/__tests__/fake-attention-page";
import { lastAttentionRefresh, listAttentionPage } from "@/lib/exec/attention";
import type { AttentionItem } from "@/lib/exec/attention-types";
import { listBucketRows, listCommitments, listSignalsForMessages, listThreadScreenRows, listTombstonedThreadIds, type BucketRow } from "@/lib/exec/email-store";
import type { ExecCommitment, ThreadScreenRow } from "@/lib/exec/email-types";
import { EMAIL_ATTENTION_JOB_KIND, EMAIL_RECONCILE_JOB_KIND, EMAIL_TRIAGE_JOB_KIND } from "@/lib/exec/jobs";
import { EMAIL_TRACKED_JOB_KINDS, TRACKED_JOB_KINDS, getOverview, type ExecOverview, type OverviewSection } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import * as dd from "@/lib/exec/sources/dd";
import { listAllReplyArtifacts, loadScreeningPolicy, restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { ruleFromRow } from "@/lib/restricted-senders";

// Email on the Overview (contract §3.14 "Overview", A2, coherence-9, §5 F):
// off or not installed reads no email table and shows no email item; on, the
// counts, restricted count and commitments are screened, the feed's email
// items are screened against their threads' rows, and every part fails on
// its own without taking the page down.

const NOW = new Date("2026-11-04T15:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function mint(accounts: string[] = ["acc_his"]): ExecPrincipal {
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

const RULE = ruleFromRow({ id: "r1", pattern: "restricted.example", match_kind: "domain", label: "R" }, new Set());
const H = restrictedPolicyHash("hidden", [RULE]);
const hashes = (from: string) => screenHashesFor({ all: [{ from, to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes;
const CLEAN = hashes("jane@acme.com");
const RESTRICTED = hashes("x@restricted.example");

function bucketRow(threadId: string, over: Partial<BucketRow> = {}): BucketRow {
  return {
    threadId,
    accountId: "acc_his",
    state: "triaged",
    screenHashes: CLEAN,
    screenTruncated: false,
    screenedPolicyHash: H,
    subject: `Subject ${threadId}`,
    counterpartName: "Jane",
    counterpartEmail: "jane@acme.com",
    messageCount: 2,
    newestMessageId: `${threadId}_m`,
    newestInboundMessageId: `${threadId}_m`,
    newestOutboundMessageId: null,
    lastInboundAt: daysAgo(1),
    lastOutboundAt: null,
    newestIsOutbound: false,
    answeredState: "awaiting_reply",
    answeredAt: null,
    partialThread: false,
    outboundAutomatedOnly: false,
    clientId: null,
    clientName: null,
    clientMatchVia: null,
    matchConfidence: null,
    summary: "Summary",
    reason: null,
    category: "client",
    urgency: "normal",
    importance: "normal",
    needsReply: true,
    mitchellPersonally: false,
    awaitingReplyFromOthers: false,
    decisionQuestion: null,
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

const screenRow = (threadId: string, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow => ({
  threadId,
  accountId: "acc_his",
  state: "triaged",
  screenHashes: CLEAN,
  screenTruncated: false,
  screenedPolicyHash: H,
  ...over
});

function commitment(id: string, threadId: string, dueAt: string): ExecCommitment {
  return {
    id,
    principalId: "ep_owner",
    fingerprint: "f".repeat(64),
    source: "email",
    threadId,
    messageId: "m",
    accountId: "acc_his",
    direction: "owed_to_mitchell",
    text: `Promise ${id}`,
    counterparty: "Jane",
    dueAt,
    dueText: null,
    status: "open",
    followedUpAt: null,
    evidenceExcerpt: "QUOTE_MUST_NOT_SHOW",
    sourceRef: { system: "outlook", id: "m", url: null, label: "Email message", class: "private" },
    messageSentAt: daysAgo(2),
    messageCreatedAt: daysAgo(2),
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
    expiresAt: daysAgo(-180)
  };
}

function item(id: string, fingerprint: string, source: "dd" | "email" = "email", score = 50): AttentionItem {
  return {
    id,
    principalId: "ep_owner",
    fingerprint,
    source,
    kind: source === "dd" ? "overdue_tasks" : "important_email",
    category: "my_action",
    title: `Title ${id}`,
    whatHappened: "",
    whyItMatters: "",
    recommendedNext: null,
    facts: [],
    refs: [],
    priority: { score, band: "normal", reasons: [] },
    stateHash: "0123456789abcdef",
    occurredAt: null,
    status: "open",
    snoozeUntil: null,
    firstSeenAt: daysAgo(1),
    lastSeenAt: daysAgo(0),
    resolvedAt: null,
    resolution: null,
    updatedAt: daysAgo(0)
  };
}

const FEED = [
  item("ea_dd", "dd:overdue:assignee:u1", "dd"),
  item("ea_ok", "email:thread:t_ok:t_ok_m"),
  item("ea_restricted", "email:thread:t_restricted:x"),
  item("ea_tomb", "email:commitment:t_tomb:ec_9"),
  item("ea_gone", "email:thread:t_gone:x"),
  item("ea_sat", "email:satisfaction:c1")
];

// exec_jobs (the System card) and nothing else through the admin client.
// Rows come back by the status the query asks for (none by default).
let jobsByStatus: Record<string, Record<string, unknown>[]> = {};
function fakeAdmin() {
  return {
    from: (table: string) => {
      if (table !== "exec_jobs") throw new Error(`unexpected table ${table}`);
      let status = "";
      const b: Record<string, unknown> = {};
      for (const m of ["select", "gte", "or", "order", "range", "abortSignal", "in", "lt", "not", "is", "limit"]) b[m] = () => b;
      b.eq = (column: string, value: unknown) => {
        if (column === "status") status = String(value);
        return b;
      };
      b.then = <A, B>(ok?: (v: unknown) => A, bad?: (e: unknown) => B) => Promise.resolve({ data: jobsByStatus[status] ?? [], error: null }).then(ok, bad);
      return b;
    }
  };
}

let syncValues: Record<string, unknown>;

/** The stored feed the accessor reads (through a stubbed listAttentionPage). */
function feedOf(items: AttentionItem[]): void {
  vi.mocked(listAttentionPage).mockImplementation(fakeAttentionPage(items));
}

function wire() {
  jobsByStatus = {};
  vi.mocked(getSupabaseAdmin).mockReturnValue(fakeAdmin() as unknown as SupabaseClient);
  for (const fn of Object.values(dd)) if (typeof fn === "function" && "mockResolvedValue" in fn) (fn as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  feedOf(FEED);
  vi.mocked(lastAttentionRefresh).mockResolvedValue(daysAgo(0));
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [RULE], hash: H });
  vi.mocked(listBucketRows).mockResolvedValue([
    bucketRow("t_ok", { decisionQuestion: "Approve it?" }),
    bucketRow("t_hidden", { screenHashes: RESTRICTED }),
    bucketRow("t_filtered", { state: "filtered", needsReply: null })
  ]);
  vi.mocked(listAllReplyArtifacts).mockResolvedValue(new Map());
  vi.mocked(listSignalsForMessages).mockResolvedValue(new Map());
  vi.mocked(listTombstonedThreadIds).mockResolvedValue(["t_tomb"]);
  vi.mocked(listCommitments).mockResolvedValue([commitment("ec_ok", "t_ok", daysAgo(-2)), commitment("ec_late", "t_ok", daysAgo(1)), commitment("ec_hidden", "t_hidden", daysAgo(-1))]);
  vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => {
    const all = new Map([
      ["t_ok", screenRow("t_ok")],
      ["t_hidden", screenRow("t_hidden", { screenHashes: RESTRICTED })],
      ["t_restricted", screenRow("t_restricted", { screenHashes: RESTRICTED })],
      ["t_tomb", screenRow("t_tomb", { state: "restricted_hidden", screenHashes: [] })],
      ["t_gone", screenRow("t_gone", { state: "gone" })]
    ]);
    return new Map([...all].filter(([k]) => ids.includes(k)));
  });
  syncValues = {
    accounts: { value: { checkedAt: daysAgo(0), accounts: [{ id: "acc_his", email: "mitchell@scaledai.org", lastSyncedAt: daysAgo(0.01), lastSyncError: null, lastSyncErrorAt: null }], problems: [] }, rev: 1 },
    socket: { value: { connected: true, lastEventAt: null, observedAt: daysAgo(0.0005) }, rev: 1 }
  };
  vi.mocked(getSyncState).mockImplementation(async (_p, _s, key) => {
    const v = syncValues[key];
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

function data<T>(s: OverviewSection<T>): T {
  if (!s.ok) throw new Error("expected the section to load");
  return s.data;
}
const UNAVAILABLE = { ok: false, error: "unavailable" };
const EMAIL_TABLE_READS = [listBucketRows, listCommitments, listSignalsForMessages, listThreadScreenRows, listTombstonedThreadIds, listAllReplyArtifacts, loadScreeningPolicy, getSyncState];

async function emailOn(o: ExecOverview) {
  const e = data(o.sections.email);
  if (e.state !== "on") throw new Error(`expected email on, got ${e.state}`);
  return e;
}

describe("getOverview: email off or not installed", () => {
  for (const [what, s] of [
    ["not installed", settings({ emailSchemaReady: false, emailEnabled: false })],
    ["switched off", settings({ emailEnabled: false })]
  ] as const) {
    it(`${what}: reads no email table, says off, and shows no email item`, async () => {
      vi.mocked(loadSettings).mockResolvedValue(s);
      const o = await getOverview(principal, NOW);
      expect(o.sections.email).toEqual({ ok: true, data: { state: "off" } });
      for (const fn of EMAIL_TABLE_READS) expect(fn).not.toHaveBeenCalled();
      expect(data(o.sections.attention).items.map((i) => i.id)).toEqual(["ea_dd"]);
      expect(data(o.sections.attention).emailUnchecked).toBe(false);
      expect(data(o.sections.system).kinds.map((k) => k.kind)).toEqual([...TRACKED_JOB_KINDS]);
    });
  }

  it("no pin: says so and reads nothing", async () => {
    const o = await getOverview(mint([]), NOW);
    expect(o.sections.email).toEqual({ ok: true, data: { state: "no_pin" } });
    for (const fn of EMAIL_TABLE_READS) expect(fn).not.toHaveBeenCalled();
    expect(data(o.sections.attention).items.map((i) => i.id)).toEqual(["ea_dd"]);
  });
});

describe("getOverview: email on", () => {
  it("screens the counts and the commitments, and counts what the screen hid", async () => {
    const o = await getOverview(principal, NOW);
    const e = await emailOn(o);
    expect(e.counts).toEqual({ ok: true, data: { reply: 1, urgent: 0, important: 0, waiting: 0, filtered: 1, decisionAsks: 1 } });
    expect(e.restricted).toEqual({ ok: true, data: 2 });
    const due = data(e.commitments);
    expect(due.items.map((c) => [c.id, c.overdue, c.threadSubject])).toEqual([
      ["ec_late", true, "Subject t_ok"],
      ["ec_ok", false, "Subject t_ok"]
    ]);
    expect(due).toMatchObject({ total: 2, days: 7, limit: 6 });
    expect(JSON.stringify(o)).not.toContain("QUOTE_MUST_NOT_SHOW");
    expect(listCommitments).toHaveBeenCalledWith(principal, { statuses: ["open"], dueBefore: "2026-11-11T15:00:00.000Z" }, { signal: expect.any(AbortSignal) });
    expect(data(e.mail)).toMatchObject({ checkedAt: daysAgo(0), problems: 0, failingSince: null, socket: { connected: true, stale: false } });
  });

  it("drops feed items whose thread is restricted, a tombstone or gone; keeps the rest", async () => {
    const o = await getOverview(principal, NOW);
    const a = data(o.sections.attention);
    expect(a.items.map((i) => i.id)).toEqual(["ea_dd", "ea_ok", "ea_sat"]);
    expect(a.emailUnchecked).toBe(false);
    expect(a.hiddenEmail).toBe(3);
    expect(a.emailScreen).toBe("ok");
    // One screened page of 20: the store read asks for 20 + the probe row.
    expect(listAttentionPage).toHaveBeenCalledWith(principal, expect.objectContaining({ statuses: "default", after: null, limit: 21, now: NOW }), { signal: expect.any(AbortSignal) });
    const threadIdsAsked = vi.mocked(listThreadScreenRows).mock.calls.map((c) => [...c[1]].sort());
    expect(threadIdsAsked).toContainEqual(["t_gone", "t_ok", "t_restricted", "t_tomb"]);
  });

  it("never renders an email item for a tombstoned or restricted thread", async () => {
    const out = renderToStaticMarkup(createElement(OverviewView, { overview: await getOverview(principal, NOW), principalTz: "America/New_York" }));
    expect(out).toContain("Title ea_ok");
    for (const hidden of ["Title ea_restricted", "Title ea_tomb", "Title ea_gone", "Subject t_hidden", "Promise ec_hidden"]) expect(out).not.toContain(hidden);
  });

  it("reads the feed deep and shows the top 20 after the screen", async () => {
    // Real item ids (the accessor's cursor carries the last one it examined).
    const hexId = (n: number) => `ea_${n.toString(16).padStart(32, "0")}`;
    const many = [...Array.from({ length: 10 }, (_, i) => item(hexId(i + 1), `email:thread:t_restricted:m${i}`, "email", 90)), ...Array.from({ length: 25 }, (_, i) => item(hexId(i + 100), `dd:x:${i}`, "dd", 40))];
    feedOf(many);
    const a = data((await getOverview(principal, NOW)).sections.attention);
    expect(a.items).toHaveLength(20);
    expect(a.items.every((i) => i.source === "dd")).toBe(true);
  });

  it("tracks the email jobs on the System card", async () => {
    const kinds = data((await getOverview(principal, NOW)).sections.system).kinds.map((k) => k.kind);
    expect(kinds).toEqual([...TRACKED_JOB_KINDS, ...EMAIL_TRACKED_JOB_KINDS]);
    expect(EMAIL_TRACKED_JOB_KINDS).toEqual([EMAIL_TRIAGE_JOB_KIND, EMAIL_RECONCILE_JOB_KIND, EMAIL_ATTENTION_JOB_KIND]);
  });
});

describe("getOverview: only the mailboxes pinned to him now (ui-3)", () => {
  it("leaves out the rows, commitments and feed items of a mailbox no longer pinned", async () => {
    vi.mocked(listBucketRows).mockResolvedValue([bucketRow("t_ok", { decisionQuestion: "Approve it?" }), bucketRow("t_old", { accountId: "acc_old", subject: "Old copy" })]);
    vi.mocked(listCommitments).mockResolvedValue([commitment("ec_ok", "t_ok", daysAgo(-2)), commitment("ec_old", "t_old", daysAgo(-2))]);
    const rows = new Map<string, ThreadScreenRow>([
      ["t_ok", screenRow("t_ok")],
      ["t_old", screenRow("t_old", { accountId: "acc_old" })]
    ]);
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => new Map([...rows].filter(([k]) => ids.includes(k))));
    feedOf([item("ea_ok", "email:thread:t_ok:t_ok_m"), item("ea_old", "email:thread:t_old:x"), item("ea_old_c", "email:commitment:t_old:ec_old")]);
    const o = await getOverview(principal, NOW);
    const e = await emailOn(o);
    expect(e.counts).toEqual({ ok: true, data: { reply: 1, urgent: 0, important: 0, waiting: 0, filtered: 0, decisionAsks: 1 } });
    // Not counted as restricted either: the one hidden thread is the tombstone.
    expect(e.restricted).toEqual({ ok: true, data: 1 });
    expect(data(e.commitments).items.map((c) => c.id)).toEqual(["ec_ok"]);
    expect(data(o.sections.attention).items.map((i) => i.id)).toEqual(["ea_ok"]);
    expect(JSON.stringify(o)).not.toContain("Old copy");
  });
});

describe("getOverview: the Needs Attention card's freshness with email on (ui-10)", () => {
  const minutesAgo = (m: number) => daysAgo(m / 1440);

  it("is the older of the DD and email passes, so a stalled email pass shows as behind", async () => {
    vi.mocked(lastAttentionRefresh).mockImplementation(async (_p, source) => (source === "email" ? minutesAgo(45) : minutesAgo(2)));
    const o = await getOverview(principal, NOW);
    expect(data(o.sections.attention).checkedAt).toBe(minutesAgo(45));
    expect(lastAttentionRefresh).toHaveBeenCalledWith(principal, "email");
    const text = renderToStaticMarkup(createElement(OverviewView, { overview: o, principalTz: "America/New_York" })).replace(/<[^>]*>/g, "");
    expect(text).toContain("The refresh may be behind.");
  });

  it("the email pass's last successful run counts as a check, as the DD pass's does", async () => {
    vi.mocked(lastAttentionRefresh).mockImplementation(async (_p, source) => (source === "email" ? minutesAgo(45) : minutesAgo(2)));
    jobsByStatus = { succeeded: [{ id: 1, kind: EMAIL_ATTENTION_JOB_KIND, finished_at: minutesAgo(5) }] };
    // The email pass last ran 5 minutes ago (its items last changed 45 minutes ago): the older of 2 and 5.
    expect(data((await getOverview(principal, NOW)).sections.attention).checkedAt).toBe(minutesAgo(5));
  });

  it("email off: the DD pass alone, and the email refresh isn't read", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailEnabled: false }));
    vi.mocked(lastAttentionRefresh).mockImplementation(async (_p, source) => (source === "email" ? minutesAgo(45) : minutesAgo(2)));
    expect(data((await getOverview(principal, NOW)).sections.attention).checkedAt).toBe(minutesAgo(2));
    expect(lastAttentionRefresh).not.toHaveBeenCalledWith(principal, "email");
  });

  it("an email pass that never ran: not checked yet, never the DD pass's time", async () => {
    vi.mocked(lastAttentionRefresh).mockImplementation(async (_p, source) => (source === "email" ? null : minutesAgo(2)));
    expect(data((await getOverview(principal, NOW)).sections.attention).checkedAt).toBeNull();
  });

  it("an email refresh that can't be read fails the card, like the DD one (never a wrong time)", async () => {
    vi.mocked(lastAttentionRefresh).mockImplementation(async (_p, source) => {
      if (source === "email") throw new Error("exec_attention_items read failed");
      return minutesAgo(2);
    });
    expect((await getOverview(principal, NOW)).sections.attention).toEqual(UNAVAILABLE);
  });
});

describe("getOverview: email failures stay in their parts", () => {
  it("settings unreadable: the email card can't load and email items are hidden, flagged; the rest of the page loads", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed"));
    const o = await getOverview(principal, NOW);
    expect(o.sections.email).toEqual(UNAVAILABLE);
    const a = data(o.sections.attention);
    // It can't tell whether email is on, so every email item is withheld.
    expect(a.items.map((i) => i.id)).toEqual(["ea_dd"]);
    expect(a.emailUnchecked).toBe(true);
    expect(a.emailScreen).toBe("unavailable");
    for (const s of [o.sections.tiles, o.sections.approvals, o.sections.system, o.sections.deadlines, o.sections.projects]) expect(s.ok).toBe(true);
    for (const fn of EMAIL_TABLE_READS) expect(fn).not.toHaveBeenCalled();
  });

  it("rules unreadable: counts, restricted count and commitments can't load; email thread items hidden, flagged", async () => {
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("restricted-sender rules unavailable"));
    const o = await getOverview(principal, NOW);
    const e = await emailOn(o);
    expect([e.counts, e.restricted, e.commitments]).toEqual([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE]);
    expect(e.mail.ok).toBe(true);
    expect(data(o.sections.attention)).toMatchObject({ emailUnchecked: true, emailScreen: "unavailable" });
    // P5a C7: a satisfaction (or health) item isn't about a thread and was screened when it was made: it still shows.
    expect(data(o.sections.attention).items.map((i) => i.id)).toEqual(["ea_dd", "ea_sat"]);
  });

  it("the feed items' thread rows unreadable: email items hidden, flagged; counts still load", async () => {
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, ids) => {
      if (ids.includes("t_restricted")) throw new Error("timeout");
      return new Map([["t_ok", screenRow("t_ok")]]);
    });
    const o = await getOverview(principal, NOW);
    expect(data(o.sections.attention)).toMatchObject({ emailUnchecked: true });
    expect((await emailOn(o)).counts.ok).toBe(true);
  });

  it("each email part fails on its own", async () => {
    vi.mocked(listSignalsForMessages).mockRejectedValue(new Error("x"));
    let e = await emailOn(await getOverview(principal, NOW));
    expect(e.counts).toEqual(UNAVAILABLE);
    expect(e.restricted.ok).toBe(true);

    wire();
    vi.mocked(listTombstonedThreadIds).mockRejectedValue(new Error("x"));
    e = await emailOn(await getOverview(principal, NOW));
    expect(e.restricted).toEqual(UNAVAILABLE);
    expect(e.counts.ok).toBe(true);

    wire();
    vi.mocked(listCommitments).mockRejectedValue(new Error("x"));
    e = await emailOn(await getOverview(principal, NOW));
    expect(e.commitments).toEqual(UNAVAILABLE);

    wire();
    syncValues.accounts = new Error("x");
    e = await emailOn(await getOverview(principal, NOW));
    expect(e.mail).toEqual(UNAVAILABLE);
    expect(e.counts.ok).toBe(true);
  });
});

describe("OverviewView with email", () => {
  const render = (o: ExecOverview) => renderToStaticMarkup(createElement(OverviewView, { overview: o, principalTz: "America/New_York" }));
  const textOf = (m: string) => m.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'");

  it("on: the email card, the decision asks next to the approvals, the mail line on the System card", async () => {
    const text = textOf(render(await getOverview(principal, NOW)));
    expect(text).toContain("Needs reply1");
    expect(text).toContain("Decisions asked by emailAI-assessed");
    expect(text).toContain("Mail: synced");
    expect(text).toContain("live updates connected");
    expect(text).toContain("Email assessment");
    expect(text).toContain("2 threads hidden by the restricted-sender rules.");
  });

  it("off: one line in the email card, nothing email anywhere else", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ emailEnabled: false }));
    const text = textOf(render(await getOverview(principal, NOW)));
    expect(text).toContain("Email intelligence is off — the team turns it on.");
    expect(text).not.toContain("Decisions asked by email");
    expect(text).not.toContain("Mail:");
    expect(text).not.toContain("Email assessment");
  });

  it("says when email items are hidden because they couldn't be checked", async () => {
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("rules unavailable"));
    const text = textOf(render(await getOverview(principal, NOW)));
    expect(text).toContain("Email items are hidden: the restricted-sender check couldn't run. Reload to try again.");
    expect(text).toContain("Couldn't load your email counts.");
    expect(text).toContain("Decisions asked by email");
    expect(text).toContain("Couldn't load");
  });
});
