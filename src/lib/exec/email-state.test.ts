import { describe, expect, it } from "vitest";

import {
  assertThreadRowInvariants,
  commitmentExpiresAt,
  newerSnapshot,
  planThreadWrite,
  rowSnapshot,
  sameOrNewerSnapshot,
  stampDecision,
  stampNeedsRetriage,
  threadExpiresAt,
  TOMBSTONE_EMPTY,
  TOMBSTONE_KEPT,
  tombstonePatch,
  type EmailThreadPatch,
  type ThreadFacts,
  type ThreadProposal,
  type TriageAiFields,
  type TriageOutcomeProposal,
  type WriteContext,
  type WritePlan
} from "@/lib/exec/email-state";
import type { ExecEmailThread, NewCommitment, ThreadSnapshot } from "@/lib/exec/email-types";
import { restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { TRIAGE_VERSION } from "@/lib/exec/triage/email";
import { NonRetryableError } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-04T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const T0 = Date.parse("2026-11-04T11:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** The same instant as PostgREST prints a timestamptz. */
const pgIso = (ms: number) => iso(ms).replace(/\.(\d{3})Z$/, ".$1000+00:00");

const rule = (id: string, pattern: string, matchKind: "exact" | "domain" = "domain"): RestrictedSenderRule => ({
  id,
  pattern,
  matchKind,
  label: id,
  viewerUserIds: new Set<string>()
});
const RULES: RestrictedSenderRule[] = [rule("rs_1", "restricted.com")];
const H = restrictedPolicyHash("hidden", RULES);
const H_NONE = restrictedPolicyHash("hidden", []);
const H_OLD = "0".repeat(64);

const ctx = (over: Partial<WriteContext> = {}): WriteContext => ({ rules: RULES, currentPolicyHash: H, now: NOW, retentionDays: 180, ...over });

/** Screening hashes for a thread whose messages name these addresses. */
const hashes = (...addrs: string[]) => screenHashesFor({ all: [{ from: addrs[0] ?? "", to: addrs.slice(1), cc: [] }], participants: [] }).hashes;
const CLEAN = hashes("a@client.com", "mitchell@scaledai.org");
const WITH_RESTRICTED = hashes("a@client.com", "mitchell@scaledai.org", "x@restricted.com");

function snap(readStartedAtMs: number, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { identityCount: 2, maxCreatedAtMs: T0, maxSentAtMs: T0, readStartedAtMs, readDoneAtMs: readStartedAtMs + 300, ...over };
}

/** The stored snapshot of liveRow(): read T0+10s .. T0+10.3s, 2 identities. */
const ROW_SNAP = snap(T0 + 10_000);

function facts(over: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
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
    clientCandidates: 1,
    ...over
  };
}

const AI: TriageAiFields = {
  summary: "Asks about the renewal",
  reason: "Client question",
  category: "client",
  urgency: "high",
  importance: "high",
  needsReply: true,
  mitchellPersonally: true,
  awaitingReplyFromOthers: false,
  decisionQuestion: "Renew for a year?",
  decisionMessageId: "m2",
  clientSignal: "none",
  automated: false,
  injectionSuspected: false
};
const RUN = { contentHash: "b".repeat(64), model: "claude-haiku-5-5", triageVersion: TRIAGE_VERSION, inputTruncated: false, bodySource: "html" as const };

const triaged = (w: number | null, ai: Partial<TriageAiFields> = {}): TriageOutcomeProposal => ({ kind: "triaged", watermarkMs: w, ai: { ...AI, ...ai }, run: RUN });
const filtered = (w: number | null): TriageOutcomeProposal => ({ kind: "filtered", watermarkMs: w, reason: "automated_hint" });
const failed = (w: number | null): TriageOutcomeProposal => ({
  kind: "failed",
  watermarkMs: w,
  error: "refusal",
  refusalCategory: "cyber",
  run: { ...RUN, contentHash: "c".repeat(64) }
});
const budget = (w: number | null): TriageOutcomeProposal => ({ kind: "deferred_budget", watermarkMs: w });
const unchanged = (w: number | null): TriageOutcomeProposal => ({ kind: "unchanged", watermarkMs: w });

function commitment(messageId: string, createdAtMs: number | null, over: Partial<NewCommitment> = {}): NewCommitment {
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
    messageSentAt: iso(createdAtMs ?? T0),
    messageCreatedAtMs: createdAtMs,
    bornFollowedUpAt: null,
    ...over
  };
}

type TriageP = Extract<ThreadProposal, { kind: "triage" }>;

function triage(over: Partial<TriageP> = {}): TriageP {
  return {
    kind: "triage",
    // Newer than ROW_SNAP: started a minute after it finished.
    snapshot: snap(T0 + 70_000, { identityCount: 3, maxCreatedAtMs: T0 + 50_000 }),
    screen: { verdict: "clean", hashes: CLEAN, truncated: false },
    policyHash: H,
    facts: facts(),
    outcome: triaged(T0 + 50_000),
    commitments: [],
    ...over
  };
}

/** A triaged row: facts from ROW_SNAP, outcome and input watermark T0 (as PostgREST prints it). */
function liveRow(over: Partial<ExecEmailThread> = {}): ExecEmailThread {
  return {
    principalId: "ep_1",
    threadId: "th_1",
    state: "triaged",
    version: 3,
    snapshotIdentityCount: ROW_SNAP.identityCount,
    snapshotMaxCreatedAt: pgIso(T0),
    snapshotMaxSentAt: pgIso(T0),
    snapshotReadStartedAt: pgIso(ROW_SNAP.readStartedAtMs),
    snapshotReadDoneAt: pgIso(ROW_SNAP.readDoneAtMs),
    goneAt: null,
    screenHashes: [...CLEAN],
    screenTruncated: false,
    screenedPolicyHash: H,
    ...facts(),
    ...AI,
    filterReason: null,
    triageError: null,
    refusalCategory: null,
    contentHash: "a".repeat(64),
    model: "claude-haiku-5-5",
    triageVersion: "email-triage-v0",
    attemptedVersion: "email-triage-v0",
    inputWatermark: pgIso(T0),
    outcomeWatermark: pgIso(T0),
    inputTruncated: false,
    bodySource: "html",
    triagedAt: pgIso(T0 + 11_000),
    deferredAt: null,
    lastAttemptAt: pgIso(T0 + 11_000),
    lastAttemptError: null,
    firstSeenAt: pgIso(T0 - DAY),
    updatedAt: pgIso(T0 + 11_000),
    expiresAt: pgIso(T0 + 180 * DAY),
    ...over
  };
}

/** Apply a plan the way the store would (CAS version bump), for multi-step interleavings. */
function apply(row: ExecEmailThread | null, plan: WritePlan): ExecEmailThread | null {
  if (plan.action === "skip") return row;
  const base = row ?? ({ principalId: "ep_1", threadId: "th_1", version: 0 } as ExecEmailThread);
  return { ...base, ...plan.patch, version: (row?.version ?? 0) + 1, updatedAt: NOW_ISO } as ExecEmailThread;
}

/** A tombstone row as the planner writes one over liveRow(). */
function tombstoneRow(over: Partial<ExecEmailThread> = {}, hashesOver: string[] = WITH_RESTRICTED): ExecEmailThread {
  const t = apply(liveRow(), planThreadWrite(liveRow(), { kind: "tombstone", snapshot: ROW_SNAP, hashes: hashesOver, truncated: false, policyHash: H }, ctx()));
  if (!t) throw new Error("fixture tombstone did not build");
  return { ...t, ...over };
}

/** A gone row: liveRow() after a 404 read that finished at T0+100s. */
const GONE_AT = T0 + 100_000;
const goneRow = (over: Partial<ExecEmailThread> = {}) => liveRow({ state: "gone", goneAt: pgIso(GONE_AT), ...over });

const write = (plan: WritePlan) => {
  if (plan.action !== "write") throw new Error(`expected a write, got ${JSON.stringify(plan)}`);
  return plan;
};
const tomb = (plan: WritePlan) => {
  if (plan.action !== "tombstone") throw new Error(`expected a tombstone, got ${JSON.stringify(plan)}`);
  return plan;
};

const CONTENT_KEYS = Object.keys(TOMBSTONE_EMPTY) as (keyof typeof TOMBSTONE_EMPTY)[];

function expectWhitelistEmpty(patch: EmailThreadPatch) {
  for (const key of CONTENT_KEYS) expect(patch[key], key).toEqual(TOMBSTONE_EMPTY[key]);
}

// ---------------------------------------------------------------------------
// Snapshot ordering (A4)
// ---------------------------------------------------------------------------

describe("newerSnapshot / sameOrNewerSnapshot (A4, happens-before)", () => {
  const cases: [string, ThreadSnapshot, ThreadSnapshot | null, boolean, boolean][] = [
    // [what, a, b, newer(a,b), sameOrNewer(a,b)]
    ["nothing stored", snap(T0), null, true, true],
    ["a started after b finished (+skew), even with fewer messages", snap(T0 + 10_000, { identityCount: 1 }), snap(T0, { identityCount: 9 }), true, true],
    ["b started after a finished (+skew), even with more messages in a", snap(T0, { identityCount: 9 }), snap(T0 + 10_000, { identityCount: 1 }), false, false],
    ["overlap: more identities wins", snap(T0, { identityCount: 3 }), snap(T0 + 100, { identityCount: 2 }), true, true],
    ["overlap: fewer identities loses", snap(T0, { identityCount: 2 }), snap(T0 + 100, { identityCount: 3 }), false, false],
    ["overlap, same count: later ingest wins", snap(T0, { maxCreatedAtMs: T0 + 1 }), snap(T0 + 100), true, true],
    ["overlap, same count, same ingest: equal", snap(T0), snap(T0 + 100), false, true],
    ["overlap, no ingest times on a: b wins", snap(T0, { maxCreatedAtMs: null }), snap(T0 + 100), false, false],
    ["overlap, no ingest times on either: equal", snap(T0, { maxCreatedAtMs: null }), snap(T0 + 100, { maxCreatedAtMs: null }), false, true],
    // Exactly at the skew edge the reads still count as overlapping.
    ["a starts exactly skew after b finished: overlap rules", snap(T0 + 300 + 5_000, { identityCount: 1 }), snap(T0, { identityCount: 2 }), false, false],
    ["a starts 1 ms past the skew edge: newer", snap(T0 + 300 + 5_001, { identityCount: 1 }), snap(T0, { identityCount: 2 }), true, true],
    // A dedupe-style hard delete: a later, non-overlapping read with fewer identities is still newer.
    ["count drop after a hard delete, non-overlapping", snap(T0 + 60_000, { identityCount: 4 }), snap(T0, { identityCount: 5 }), true, true]
  ];
  for (const [what, a, b, newer, sameOrNewer] of cases) {
    it(what, () => {
      expect(newerSnapshot(a, b)).toBe(newer);
      expect(sameOrNewerSnapshot(a, b)).toBe(sameOrNewer);
    });
  }

  it("sameOrNewer is ¬newer(b, a)", () => {
    const a = snap(T0, { identityCount: 2 });
    const b = snap(T0 + 50, { identityCount: 2, maxCreatedAtMs: T0 - 1 });
    expect(sameOrNewerSnapshot(a, b)).toBe(!newerSnapshot(b, a));
    expect(sameOrNewerSnapshot(b, a)).toBe(!newerSnapshot(a, b));
  });
});

describe("rowSnapshot", () => {
  it("reads the stored columns as epoch ms, whatever the timestamp text form", () => {
    expect(rowSnapshot(liveRow())).toEqual(ROW_SNAP);
  });
  it("is null when the row has no read_done (never read, or a tombstone written without one)", () => {
    expect(rowSnapshot(liveRow({ snapshotReadDoneAt: null }))).toBeNull();
  });
  it("a missing start time reads as the end time (it can only make the row look newer: fail closed)", () => {
    expect(rowSnapshot(liveRow({ snapshotReadStartedAt: null }))).toMatchObject({ readStartedAtMs: ROW_SNAP.readDoneAtMs });
  });
});

// ---------------------------------------------------------------------------
// The whitelist
// ---------------------------------------------------------------------------

describe("the tombstone whitelist", () => {
  it("partitions every stored column: content (emptied) or kept (no mail content)", () => {
    const all = Object.keys(liveRow()).filter((k) => !["principalId", "threadId", "version", "updatedAt"].includes(k)).sort();
    expect([...CONTENT_KEYS, ...TOMBSTONE_KEPT].sort()).toEqual(all);
  });

  it("refuses an image that would put content on a tombstone, naming only the column", () => {
    for (const [key, value] of [
      ["subject", "Hi"],
      ["summary", "x"],
      ["correspondents", ["a@b.c"]],
      ["messageCount", 1],
      ["partialThread", true],
      ["outcomeWatermark", NOW_ISO],
      ["injectionSuspected", true],
      ["goneAt", NOW_ISO]
    ] as const) {
      const image = { ...tombstonePatch(null, { snapshot: null, hashes: [], truncated: false, policyHash: H, accountId: "acc_1" }, ctx()), [key]: value };
      expect(() => assertThreadRowInvariants(image as never), key).toThrow(NonRetryableError);
      expect(() => assertThreadRowInvariants(image as never), key).toThrow(new RegExp(`tombstone would carry ${key}|gone_at must be set`));
    }
  });

  it("a gone row must have gone_at, and only a gone row may", () => {
    expect(() => assertThreadRowInvariants({ state: "gone", goneAt: null })).toThrow(NonRetryableError);
    expect(() => assertThreadRowInvariants({ state: "triaged", goneAt: NOW_ISO })).toThrow(NonRetryableError);
    expect(() => assertThreadRowInvariants({ state: "gone", goneAt: NOW_ISO })).not.toThrow();
  });

  it("the whitelist itself can't be changed by a caller", () => {
    expect(Object.isFrozen(TOMBSTONE_EMPTY)).toBe(true);
    expect(Object.isFrozen(TOMBSTONE_EMPTY.correspondents)).toBe(true);
  });

  it("tombstonePatch is the full null-set over every content column", () => {
    const patch = tombstonePatch(liveRow(), { snapshot: null, hashes: null, truncated: null, policyHash: H }, ctx());
    expectWhitelistEmpty(patch);
    expect(patch).toMatchObject({ state: "restricted_hidden", accountId: "acc_1", screenedPolicyHash: H });
  });
});

// ---------------------------------------------------------------------------
// Rule 1: tombstone
// ---------------------------------------------------------------------------

describe("rule 1: tombstone (always allowed)", () => {
  const proposal = (over: Partial<Extract<ThreadProposal, { kind: "tombstone" }>> = {}): ThreadProposal => ({
    kind: "tombstone",
    snapshot: snap(T0 + 70_000, { identityCount: 3 }),
    hashes: WITH_RESTRICTED,
    truncated: false,
    policyHash: H,
    accountId: "acc_1",
    ...over
  });

  it("no row: inserts a tombstone, nothing but the whitelist, expiring from first sight", () => {
    const plan = tomb(planThreadWrite(null, proposal(), ctx()));
    expect(plan.insert).toBe(true);
    expectWhitelistEmpty(plan.patch);
    expect(plan.patch).toMatchObject({
      state: "restricted_hidden",
      accountId: "acc_1",
      screenHashes: [...WITH_RESTRICTED].sort(),
      screenTruncated: false,
      screenedPolicyHash: H,
      snapshotIdentityCount: 3,
      snapshotReadStartedAt: iso(T0 + 70_000),
      firstSeenAt: NOW_ISO,
      expiresAt: iso(NOW.getTime() + 180 * DAY)
    });
  });

  it("no row and no account id: a programming error", () => {
    expect(() => planThreadWrite(null, proposal({ accountId: null }), ctx())).toThrow(NonRetryableError);
  });

  it("live row: a full tombstone, hashes unioned, expiry from its previous activity", () => {
    const row = liveRow({ screenHashes: hashes("old@else.com") });
    const plan = tomb(planThreadWrite(row, proposal(), ctx()));
    expect(plan.insert).toBe(false);
    expectWhitelistEmpty(plan.patch);
    expect(plan.patch.screenHashes).toEqual([...new Set([...hashes("old@else.com"), ...WITH_RESTRICTED])].sort());
    expect(plan.patch.expiresAt).toBe(iso(T0 + 180 * DAY));
    expect(plan.patch.firstSeenAt).toBe(row.firstSeenAt);
    expect(plan.patch.snapshotIdentityCount).toBe(3);
  });

  it("gone row: becomes a tombstone (gone_at cleared)", () => {
    const plan = tomb(planThreadWrite(goneRow(), proposal(), ctx()));
    expect(plan.patch).toMatchObject({ state: "restricted_hidden", goneAt: null });
  });

  it("tombstone + newer snapshot: refreshed in place (write), hashes unioned, stamp set", () => {
    const t = tombstoneRow({ screenedPolicyHash: H_OLD });
    const plan = write(planThreadWrite(t, proposal({ hashes: hashes("new@else.com") }), ctx()));
    expect(plan.patch.screenHashes).toEqual([...new Set([...WITH_RESTRICTED, ...hashes("new@else.com")])].sort());
    expect(plan.patch.snapshotIdentityCount).toBe(3);
    expect(plan.patch.screenedPolicyHash).toBe(H);
    expect(plan.commitmentsToUpsert).toEqual([]);
  });

  it("tombstone + older snapshot: the snapshot stays, the hashes still union", () => {
    const t = tombstoneRow();
    const plan = write(planThreadWrite(t, proposal({ snapshot: snap(T0 - 60_000), hashes: hashes("new@else.com") }), ctx()));
    expect(plan.patch.snapshotReadStartedAt).toBeUndefined();
    expect(plan.patch.screenHashes).toContain(hashes("new@else.com")[0]);
  });

  it("tombstone + nothing new: noop", () => {
    expect(planThreadWrite(tombstoneRow(), proposal({ snapshot: null, hashes: null }), ctx())).toEqual({ action: "skip", reason: "noop" });
  });

  it("a tombstone keeps the expiry it got when it was first written", () => {
    const t = tombstoneRow({ expiresAt: pgIso(T0 + 5 * DAY), screenedPolicyHash: H_OLD });
    const plan = write(planThreadWrite(t, proposal(), ctx()));
    expect(plan.patch.expiresAt).toBeUndefined();
  });

  it("truncation: the proposal's flag, or a union over the limit, sets it; the 600 kept are the first sorted", () => {
    const many = Array.from({ length: 650 }, (_, i) => i.toString(16).padStart(32, "0"));
    const plan = tomb(planThreadWrite(liveRow({ screenHashes: [] }), proposal({ hashes: many }), ctx()));
    expect(plan.patch.screenTruncated).toBe(true);
    expect(plan.patch.screenHashes).toHaveLength(600);
    expect(plan.patch.screenHashes).toEqual([...many].sort().slice(0, 600));
    const flagged = tomb(planThreadWrite(liveRow(), proposal({ truncated: true }), ctx()));
    expect(flagged.patch.screenTruncated).toBe(true);
  });

  it("truncation is sticky on a tombstone", () => {
    const t = tombstoneRow({ screenTruncated: true });
    const plan = planThreadWrite(t, proposal({ truncated: false, hashes: hashes("n@x.com") }), ctx());
    expect(write(plan).patch.screenTruncated).toBeUndefined(); // unchanged: still true
  });
});

// ---------------------------------------------------------------------------
// Rule 2: gone
// ---------------------------------------------------------------------------

describe("rule 2: gone (the clone's own 404)", () => {
  const gone = (atMs = GONE_AT): ThreadProposal => ({ kind: "gone", atMs });

  const table: [string, ExecEmailThread | null, WriteContext, string][] = [
    ["no row: skip", null, ctx(), "skip:no_row"],
    ["a 404 on a tombstone stays a tombstone", tombstoneRow(), ctx(), "skip:tombstone"],
    ["clean live row: gone, content kept", liveRow(), ctx(), "write"],
    ["live row whose stored hashes match a rule: tombstone", liveRow({ screenHashes: WITH_RESTRICTED }), ctx(), "tombstone"],
    ["truncated row screened under another policy: tombstone", liveRow({ screenTruncated: true, screenedPolicyHash: H_OLD }), ctx(), "tombstone"],
    ["truncated row screened under this policy: gone", liveRow({ screenTruncated: true, screenedPolicyHash: H }), ctx(), "write"]
  ];
  for (const [what, row, c, expected] of table) {
    it(what, () => {
      const plan = planThreadWrite(row, gone(), c);
      expect(plan.action === "skip" ? `skip:${plan.reason}` : plan.action).toBe(expected);
    });
  }

  it("the gone write sets state, gone_at (the 404 read's done time) and the stamp, and keeps every content column", () => {
    const plan = write(planThreadWrite(liveRow({ screenedPolicyHash: H_OLD }), gone(), ctx()));
    expect(plan.patch).toEqual({ state: "gone", goneAt: iso(GONE_AT), screenedPolicyHash: H });
    expect(plan.commitmentsToUpsert).toEqual([]);
  });

  it("a later 404 moves gone_at forward; an earlier one changes nothing", () => {
    expect(write(planThreadWrite(goneRow(), gone(GONE_AT + 5_000), ctx())).patch).toEqual({ goneAt: iso(GONE_AT + 5_000) });
    expect(planThreadWrite(goneRow(), gone(GONE_AT - 5_000), ctx())).toEqual({ action: "skip", reason: "noop" });
  });

  it("refuses a gone proposal without a time", () => {
    expect(() => planThreadWrite(liveRow(), { kind: "gone", atMs: Number.NaN }, ctx())).toThrow(NonRetryableError);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: stamp
// ---------------------------------------------------------------------------

describe("rule 4: stamp (re-screen under the current policy)", () => {
  const stamp: ThreadProposal = { kind: "stamp", policyHash: H };
  const table: [string, ExecEmailThread | null, string][] = [
    ["no row", null, "skip:no_row"],
    ["already stamped with H", liveRow({ screenedPolicyHash: H }), "skip:already_stamped"],
    ["clean live row under an older policy: stamp", liveRow({ screenedPolicyHash: H_OLD }), "write"],
    ["live row whose hashes now match: tombstone", liveRow({ screenedPolicyHash: H_OLD, screenHashes: WITH_RESTRICTED }), "tombstone"],
    ["truncated live row under an older policy: needs a fresh read", liveRow({ screenedPolicyHash: H_OLD, screenTruncated: true }), "skip:needs_fresh_read"],
    ["truncated gone row under an older policy: tombstone (it can't be re-read)", goneRow({ screenedPolicyHash: H_OLD, screenTruncated: true }), "tombstone"],
    ["clean gone row: stamp", goneRow({ screenedPolicyHash: H_OLD }), "write"],
    ["restricted tombstone under an older policy: stamp it, still a tombstone", tombstoneRow({ screenedPolicyHash: H_OLD }), "write"],
    ["clean tombstone: needs a re-triage", tombstoneRow({ screenedPolicyHash: H_OLD }, CLEAN), "skip:needs_retriage"],
    ["clean truncated tombstone: needs a fresh read", tombstoneRow({ screenedPolicyHash: H_OLD, screenTruncated: true }, CLEAN), "skip:needs_fresh_read"]
  ];
  for (const [what, row, expected] of table) {
    it(what, () => {
      const plan = planThreadWrite(row, stamp, ctx());
      expect(plan.action === "skip" ? `skip:${plan.reason}` : plan.action).toBe(expected);
      if (plan.action === "write") expect(plan.patch).toEqual({ screenedPolicyHash: H });
      if (plan.action === "tombstone") expectWhitelistEmpty(plan.patch);
      // The attention pass's bulk path decides the same from the screen columns alone.
      const narrow = row === null ? null : { state: row.state, screenHashes: row.screenHashes, screenTruncated: row.screenTruncated, screenedPolicyHash: row.screenedPolicyHash };
      expect(stampDecision(narrow, ctx()), "stampDecision").toBe(
        ({ "skip:no_row": "no_row", "skip:already_stamped": "already_stamped", write: "stamp", tombstone: "tombstone", "skip:needs_fresh_read": "needs_fresh_read", "skip:needs_retriage": "needs_retriage" } as Record<string, string>)[expected]
      );
    });
  }

  it("stampNeedsRetriage says which skips the attention pass turns into a policy re-triage", () => {
    expect(stampNeedsRetriage({ action: "skip", reason: "needs_fresh_read" })).toBe(true);
    expect(stampNeedsRetriage({ action: "skip", reason: "needs_retriage" })).toBe(true);
    expect(stampNeedsRetriage({ action: "skip", reason: "already_stamped" })).toBe(false);
    expect(stampNeedsRetriage(planThreadWrite(liveRow({ screenedPolicyHash: H_OLD }), stamp, ctx()))).toBe(false);
  });

  it("judges against the context's rules (reloaded per attempt), not the proposal's hash", () => {
    // The pass proposed under H, the rule was removed before this attempt.
    const plan = planThreadWrite(liveRow({ screenedPolicyHash: H_OLD, screenHashes: WITH_RESTRICTED }), stamp, ctx({ rules: [], currentPolicyHash: H_NONE }));
    expect(write(plan).patch).toEqual({ screenedPolicyHash: H_NONE });
  });
});

// ---------------------------------------------------------------------------
// hashes: a clean early screen on a job that exits without a triage write
// ---------------------------------------------------------------------------

describe("hashes (union a clean early screen)", () => {
  const p = (over: Partial<Extract<ThreadProposal, { kind: "hashes" }>> = {}): ThreadProposal => ({
    kind: "hashes",
    snapshot: snap(T0 + 70_000, { identityCount: 3 }),
    screen: { verdict: "clean", hashes: hashes("a@client.com", "junk@spam.io"), truncated: false },
    policyHash: H,
    ...over
  });

  it("no row: nothing to union into", () => {
    expect(planThreadWrite(null, p(), ctx())).toEqual({ action: "skip", reason: "no_row" });
  });

  it("live row: unions the new hashes and stamps H (complete set, screened clean)", () => {
    const plan = write(planThreadWrite(liveRow({ screenedPolicyHash: H_OLD }), p(), ctx()));
    expect(plan.patch.screenHashes).toEqual([...new Set([...CLEAN, ...hashes("a@client.com", "junk@spam.io")])].sort());
    expect(plan.patch.screenedPolicyHash).toBe(H);
    expect(Object.keys(plan.patch).sort()).toEqual(["screenHashes", "screenedPolicyHash"]);
  });

  it("nothing new on a stamped row: noop", () => {
    expect(planThreadWrite(liveRow(), p({ screen: { verdict: "clean", hashes: CLEAN, truncated: false } }), ctx())).toEqual({ action: "skip", reason: "noop" });
  });

  it("the union matches a rule: tombstone", () => {
    const plan = planThreadWrite(liveRow({ screenHashes: WITH_RESTRICTED, screenedPolicyHash: H_OLD }), p(), ctx());
    expect(tomb(plan).patch.screenedPolicyHash).toBe(H);
  });

  it("the read itself is restricted: tombstone", () => {
    expect(planThreadWrite(liveRow(), p({ screen: { verdict: "restricted", hashes: WITH_RESTRICTED, truncated: false } }), ctx()).action).toBe("tombstone");
  });

  it("a tombstone: hashes only, its stamp untouched (so a clean one still gets its re-triage)", () => {
    const t = tombstoneRow({ screenedPolicyHash: H_OLD }, CLEAN);
    const plan = write(planThreadWrite(t, p(), ctx()));
    expect(Object.keys(plan.patch)).toEqual(["screenHashes"]);
  });

  it("truncated: stamps only from a read newer than the stored facts, screened under H", () => {
    const row = liveRow({ screenTruncated: true, screenedPolicyHash: H_OLD });
    expect(write(planThreadWrite(row, p(), ctx())).patch.screenedPolicyHash).toBe(H);
    expect(write(planThreadWrite(row, p({ snapshot: snap(T0 - 60_000) }), ctx())).patch.screenedPolicyHash).toBeUndefined();
    expect(write(planThreadWrite(row, p({ policyHash: H_OLD }), ctx())).patch.screenedPolicyHash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 5: triage
// ---------------------------------------------------------------------------

describe("rule 5(a)/(b): restricted reads and the union screen", () => {
  const rows: [string, ExecEmailThread | null][] = [
    ["no row", null],
    ["live row", liveRow()],
    ["gone row", goneRow()],
    ["tombstone", tombstoneRow({ screenedPolicyHash: H_OLD })]
  ];
  for (const [what, row] of rows) {
    it(`(a) a restricted read over ${what} → tombstone, stamped with the read's policy`, () => {
      const plan = planThreadWrite(
        row,
        triage({ screen: { verdict: "restricted", hashes: WITH_RESTRICTED, truncated: false }, policyHash: H_OLD, commitments: [commitment("m2", T0)] }),
        ctx({ currentPolicyHash: H })
      );
      expect(plan.action).toBe(row?.state === "restricted_hidden" ? "write" : "tombstone");
      if (plan.action === "skip") throw new Error("unexpected skip");
      const next = apply(row, plan) as ExecEmailThread;
      expect(next.state).toBe("restricted_hidden");
      expectWhitelistEmpty(next);
      expect(next.screenedPolicyHash).toBe(H_OLD);
      if (plan.action === "write") expect(plan.commitmentsToUpsert).toEqual([]);
    });
  }

  it("(b) a clean read whose union with the stored hashes matches a rule → tombstone stamped H, no commitments", () => {
    // The stored row already holds x@restricted.com; this (stale) read doesn't.
    const plan = tomb(planThreadWrite(liveRow({ screenHashes: WITH_RESTRICTED }), triage({ commitments: [commitment("m3", T0 + 50_000)] }), ctx()));
    expect(plan.patch.screenedPolicyHash).toBe(H);
    expectWhitelistEmpty(plan.patch);
  });

  it("(b) uses the rules of this attempt: a rule added since the read's own screen still bites", () => {
    const read = hashes("a@client.com", "y@newly-restricted.com");
    const rules = [...RULES, rule("rs_2", "newly-restricted.com")];
    const plan = planThreadWrite(liveRow(), triage({ screen: { verdict: "clean", hashes: read, truncated: false } }), ctx({ rules, currentPolicyHash: restrictedPolicyHash("hidden", rules) }));
    expect(plan.action).toBe("tombstone");
  });

  it("(b) screens the whole union, including hashes past the 600 a row can keep", () => {
    // 600 hashes that sort before the restricted ones, so a stored-set-only screen would miss them.
    const filler = Array.from({ length: 600 }, (_, i) => `0${i.toString(16).padStart(31, "0")}`);
    const plan = planThreadWrite(liveRow({ screenHashes: filler }), triage({ screen: { verdict: "clean", hashes: WITH_RESTRICTED, truncated: false } }), ctx());
    expect(plan.action).toBe("tombstone");
  });
});

describe("rule 5(c): leaving a tombstone", () => {
  // The tombstone was written from ROW_SNAP. Its hashes are clean once the rule is gone.
  const removed = ctx({ rules: [], currentPolicyHash: H_NONE });
  const clean = (over: Partial<TriageP> = {}) =>
    triage({ policyHash: H_NONE, screen: { verdict: "clean", hashes: WITH_RESTRICTED, truncated: false }, ...over });

  const table: [string, ExecEmailThread, TriageP, WriteContext, string][] = [
    ["rule removed + a later, non-overlapping clean read → content allowed", tombstoneRow(), clean(), removed, "write"],
    ["rule removed + a fresh read of the same snapshot (overlapping) → content allowed", tombstoneRow(), clean({ snapshot: { ...ROW_SNAP, readStartedAtMs: ROW_SNAP.readStartedAtMs + 100, readDoneAtMs: ROW_SNAP.readDoneAtMs + 100 } }), removed, "write"],
    ["rule removed + an older, non-overlapping read → stale", tombstoneRow(), clean({ snapshot: snap(T0 - 60_000) }), removed, "skip:stale_vs_tombstone"],
    ["rule removed + an overlapping read that saw fewer messages → stale", tombstoneRow(), clean({ snapshot: snap(T0 + 10_100, { identityCount: 1 }) }), removed, "skip:stale_vs_tombstone"],
    ["rule removed, but the read was screened under the old policy → stale", tombstoneRow(), clean({ policyHash: H }), removed, "skip:stale_vs_tombstone"],
    ["rule still present + same snapshot → stays a tombstone (the union screen)", tombstoneRow(), triage({ screen: { verdict: "clean", hashes: CLEAN, truncated: false } }), ctx(), "write-tombstone"],
    ["truncated tombstone + an overlapping same-snapshot read → stale", tombstoneRow({ screenTruncated: true }), clean({ snapshot: { ...ROW_SNAP, readStartedAtMs: ROW_SNAP.readStartedAtMs + 100, readDoneAtMs: ROW_SNAP.readDoneAtMs + 100 } }), removed, "skip:stale_vs_tombstone"],
    ["truncated tombstone + a strictly later read → exits", tombstoneRow({ screenTruncated: true }), clean(), removed, "write"],
    ["truncated tombstone without a stored snapshot → stale (can't be ordered)", tombstoneRow({ screenTruncated: true, snapshotReadDoneAt: null, snapshotReadStartedAt: null }), clean(), removed, "skip:stale_vs_tombstone"],
    ["a read whose own hash set is truncated also needs a strictly later read", tombstoneRow(), clean({ screen: { verdict: "clean", hashes: WITH_RESTRICTED, truncated: true }, snapshot: { ...ROW_SNAP, readStartedAtMs: ROW_SNAP.readStartedAtMs + 100, readDoneAtMs: ROW_SNAP.readDoneAtMs + 100 } }), removed, "skip:stale_vs_tombstone"],
    ["an exit needs an outcome: unchanged can't leave a tombstone", tombstoneRow(), clean({ outcome: unchanged(T0 + 50_000) }), removed, "skip:needs_outcome"]
  ];
  for (const [what, row, p, c, expected] of table) {
    it(what, () => {
      const plan = planThreadWrite(row, p, c);
      const label =
        plan.action === "skip" ? `skip:${plan.reason}` : plan.action === "write" && (plan.patch.state ?? row.state) === "restricted_hidden" ? "write-tombstone" : plan.action;
      expect(label).toBe(expected);
    });
  }

  it("an exit is a full content write: facts, outcome, stamp H, every commitment (first extraction)", () => {
    const row = tombstoneRow();
    const plan = write(planThreadWrite(row, clean({ commitments: [commitment("m1", T0 - DAY), commitment("m2", T0)] }), removed));
    expect(apply(row, plan)).toMatchObject({
      state: "triaged",
      subject: "Renewal",
      newestInboundMessageId: "m2",
      summary: AI.summary,
      screenedPolicyHash: H_NONE,
      inputWatermark: iso(T0 + 50_000),
      outcomeWatermark: iso(T0 + 50_000),
      expiresAt: iso(T0 + 180 * DAY)
    });
    expect(plan.commitmentsToUpsert.map((c) => c.messageId)).toEqual(["m1", "m2"]);
  });
});

describe("rule 5(d): gone rows", () => {
  it("a read that started before the 404 read finished (+skew) can't revive it", () => {
    for (const startedAt of [GONE_AT - 60_000, GONE_AT, GONE_AT + 5_000]) {
      expect(planThreadWrite(goneRow(), triage({ snapshot: snap(startedAt, { identityCount: 3 }) }), ctx())).toEqual({ action: "skip", reason: "stale_vs_gone" });
    }
  });

  it("a read that started after it revives the row with a written outcome (gone_at cleared)", () => {
    const plan = write(planThreadWrite(goneRow(), triage({ snapshot: snap(GONE_AT + 5_001, { identityCount: 3 }) }), ctx()));
    expect(plan.patch).toMatchObject({ state: "triaged", goneAt: null });
  });

  it("revival needs an outcome: unchanged can't", () => {
    expect(planThreadWrite(goneRow(), triage({ snapshot: snap(GONE_AT + 60_000), outcome: unchanged(T0) }), ctx())).toEqual({ action: "skip", reason: "needs_outcome" });
  });

  it("a gone row with no gone_at can't be ordered against: stale (fail closed)", () => {
    const row = { ...goneRow(), goneAt: null };
    expect(planThreadWrite(row, triage(), ctx())).toEqual({ action: "skip", reason: "stale_vs_gone" });
  });
});

describe("rule 5(e)/(e′): facts and screening columns", () => {
  it("a newer read writes the facts and its snapshot", () => {
    const plan = write(planThreadWrite(liveRow(), triage({ facts: facts({ subject: "Renewal (2)", messageCount: 3 }) }), ctx()));
    expect(plan.patch).toMatchObject({ subject: "Renewal (2)", messageCount: 3, snapshotIdentityCount: 3, snapshotReadStartedAt: iso(T0 + 70_000) });
  });

  it("an older read writes no facts and no snapshot, but its hashes still join the union", () => {
    const p = triage({
      snapshot: snap(T0 - 60_000, { identityCount: 1 }),
      facts: facts({ subject: "stale subject" }),
      screen: { verdict: "clean", hashes: hashes("late@client.com"), truncated: false },
      outcome: unchanged(T0)
    });
    const plan = write(planThreadWrite(liveRow(), p, ctx()));
    expect(plan.patch.subject).toBeUndefined();
    expect(plan.patch.snapshotIdentityCount).toBeUndefined();
    expect(plan.patch.screenHashes).toEqual([...new Set([...CLEAN, ...hashes("late@client.com")])].sort());
  });

  it("a later non-overlapping read applies even after a hard delete lowered the count (no frozen facts)", () => {
    const plan = write(planThreadWrite(liveRow({ snapshotIdentityCount: 5 }), triage({ snapshot: snap(T0 + 70_000, { identityCount: 4 }), facts: facts({ messageCount: 4 }) }), ctx()));
    expect(plan.patch.messageCount).toBe(4);
  });

  it("truncation is sticky: once set it stays, whatever later reads say", () => {
    const plan = planThreadWrite(liveRow({ screenTruncated: true }), triage(), ctx());
    expect(write(plan).patch.screenTruncated).toBeUndefined();
    const fresh = write(planThreadWrite(liveRow(), triage({ screen: { verdict: "clean", hashes: CLEAN, truncated: true } }), ctx()));
    expect(fresh.patch.screenTruncated).toBe(true);
  });

  it("display text is clipped by code point and cleaned (no NUL, no split surrogate)", () => {
    const subject = `${"a".repeat(199)}😀tail\u0000`;
    const plan = write(planThreadWrite(null, triage({ facts: facts({ subject, counterpartName: "N\u0000ame" }) }), ctx()));
    expect(plan.patch.subject).toBe(`${"a".repeat(199)}😀`);
    expect(plan.patch.counterpartName).toBe("Name");
    const correspondents = Array.from({ length: 60 }, (_, i) => `p${i}@x.com`);
    const many = write(planThreadWrite(null, triage({ facts: facts({ correspondents: [...correspondents, "x".repeat(321)] }) }), ctx()));
    expect(many.patch.correspondents).toEqual(correspondents.slice(0, 50));
  });
});

describe("rule 5(f): outcomes against the outcome watermark", () => {
  // liveRow(): triaged, outcome/input watermark T0 (printed "+00:00").
  const S = T0;
  /** The column is not written (the plan's patch leaves it out). */
  const KEEP = Symbol("keep");
  type Expect = Record<string, unknown>;
  type Case = [string, ExecEmailThread, TriageOutcomeProposal, Expect];
  const cases: Case[] = [
    [
      "w > s, triaged: written in full, both watermarks move",
      liveRow(),
      triaged(S + 1),
      { state: "triaged", inputWatermark: iso(S + 1), outcomeWatermark: iso(S + 1), triagedAt: NOW_ISO, contentHash: RUN.contentHash, triageVersion: TRIAGE_VERSION }
    ],
    [
      "w > s, filtered: written in full, input watermark stays, AI kept",
      liveRow(),
      filtered(S + 1),
      { state: "filtered", filterReason: "automated_hint", outcomeWatermark: iso(S + 1), inputWatermark: KEEP, summary: KEEP }
    ],
    [
      "w > s, failed: written in full, AI kept, the failed input's hash stored",
      liveRow(),
      failed(S + 1),
      {
        state: "triage_failed",
        triageError: "refusal",
        refusalCategory: "cyber",
        lastAttemptError: "refusal",
        contentHash: "c".repeat(64),
        inputWatermark: KEEP,
        summary: KEEP,
        model: KEEP
      }
    ],
    ["w > s, budget: written in full", liveRow(), budget(S + 1), { state: "deferred_budget", deferredAt: NOW_ISO, lastAttemptError: "budget", outcomeWatermark: iso(S + 1) }],
    ["w = s (Z vs +00:00), triaged, read same-or-newer: written", liveRow(), triaged(S), { state: "triaged", triagedAt: NOW_ISO, contentHash: RUN.contentHash }],
    ["w = s, failed on a triaged row: last attempt only", liveRow(), failed(S), { lastAttemptAt: NOW_ISO, lastAttemptError: "refusal", state: KEEP, triageError: KEEP, contentHash: KEEP }],
    ["w = s, budget on a triaged row: last attempt only", liveRow(), budget(S), { lastAttemptAt: NOW_ISO, lastAttemptError: "budget", state: KEEP, deferredAt: KEEP }],
    ["w = s, filtered on a triaged row: last attempt only", liveRow(), filtered(S), { lastAttemptAt: NOW_ISO, state: KEEP, filterReason: KEEP }],
    ["w = s, failed on a filtered row: written in full", liveRow({ state: "filtered", filterReason: "unreplyable" }), failed(S), { state: "triage_failed", filterReason: null }],
    ["w = s, triaged on a budget-deferred row: written in full", liveRow({ state: "deferred_budget", deferredAt: pgIso(T0) }), triaged(S), { state: "triaged", deferredAt: null }],
    ["w < s: no outcome change", liveRow(), triaged(S - 1), { state: KEEP, triagedAt: KEEP, inputWatermark: KEEP, outcomeWatermark: KEEP }],
    ["unchanged: no outcome change", liveRow(), unchanged(S), { state: KEEP, triagedAt: KEEP, lastAttemptAt: KEEP }],
    ["s null: written in full", liveRow({ outcomeWatermark: null, state: "filtered" }), failed(S - 99), { state: "triage_failed" }],
    ["w null against a stored s: no outcome change", liveRow(), triaged(null), { state: KEEP, triagedAt: KEEP }]
  ];
  for (const [what, row, outcome, expected] of cases) {
    it(what, () => {
      const plan = planThreadWrite(row, triage({ outcome }), ctx());
      if (plan.action === "skip") throw new Error(`unexpected skip: ${plan.reason}`);
      const next = apply(row, plan) as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(expected)) {
        if (v === KEEP) expect(plan.patch[k as keyof EmailThreadPatch], `${k} must not be written`).toBeUndefined();
        else expect(next[k], k).toEqual(v);
      }
    });
  }

  it("w = s, triaged from an older read: no outcome change (A5 tie)", () => {
    const p = triage({ outcome: triaged(S), snapshot: snap(T0 - 60_000, { identityCount: 9 }) });
    const plan = write(planThreadWrite(liveRow(), p, ctx()));
    expect(plan.patch.state).toBeUndefined();
    expect(plan.patch.triagedAt).toBeUndefined();
  });

  it("a filtered, failed or budget outcome can never downgrade a triaged row at its own watermark", () => {
    for (const o of [filtered(S), failed(S), budget(S)]) {
      const next = apply(liveRow(), planThreadWrite(liveRow(), triage({ outcome: o }), ctx()));
      expect(next?.state).toBe("triaged");
      expect(next?.summary).toBe(AI.summary);
    }
  });

  it("re-applying the same triaged proposal is a noop", () => {
    const p = triage();
    const once = apply(liveRow(), planThreadWrite(liveRow(), p, ctx()));
    expect(planThreadWrite(once, p, ctx())).toEqual({ action: "skip", reason: "noop" });
  });

  it("a new row needs an outcome", () => {
    expect(planThreadWrite(null, triage({ outcome: unchanged(T0) }), ctx())).toEqual({ action: "skip", reason: "needs_outcome" });
  });
});

describe("rule 5(g): stamping screened_policy_hash (A1)", () => {
  it("unchanged stamps H on a non-truncated row", () => {
    const plan = write(planThreadWrite(liveRow({ screenedPolicyHash: H_OLD }), triage({ outcome: unchanged(T0) }), ctx()));
    expect(plan.patch.screenedPolicyHash).toBe(H);
  });

  it("a non-truncated row is stamped H even when the read was screened under another policy (the union was screened under H)", () => {
    const plan = write(planThreadWrite(liveRow({ screenedPolicyHash: H_OLD }), triage({ policyHash: H_OLD }), ctx()));
    expect(plan.patch.screenedPolicyHash).toBe(H);
  });

  it("a truncated row is stamped only when facts apply and the read was screened under H", () => {
    const row = liveRow({ screenTruncated: true, screenedPolicyHash: H_OLD });
    expect(write(planThreadWrite(row, triage(), ctx())).patch.screenedPolicyHash).toBe(H);
    expect(write(planThreadWrite(row, triage({ policyHash: H_OLD }), ctx())).patch.screenedPolicyHash).toBeUndefined();
    expect(write(planThreadWrite(row, triage({ outcome: unchanged(T0) }), ctx())).patch.screenedPolicyHash).toBe(H);
  });

  it("a stale job can't stamp a truncated row", () => {
    const row = liveRow({ screenTruncated: true, screenedPolicyHash: H_OLD });
    const plan = planThreadWrite(row, triage({ snapshot: snap(T0 - 60_000), outcome: unchanged(T0) }), ctx());
    if (plan.action === "write") expect(plan.patch.screenedPolicyHash).toBeUndefined();
    else expect(plan).toEqual({ action: "skip", reason: "noop" });
  });
});

describe("rule 5(h): attempted_version", () => {
  for (const [what, outcome, expected] of [
    ["triaged", triaged(T0 + 1), TRIAGE_VERSION],
    ["filtered", filtered(T0 + 1), TRIAGE_VERSION],
    ["failed", failed(T0 + 1), TRIAGE_VERSION],
    ["unchanged", unchanged(T0), TRIAGE_VERSION],
    ["deferred_budget (not stamped)", budget(T0 + 1), undefined]
  ] as const) {
    it(what, () => {
      const plan = write(planThreadWrite(liveRow(), triage({ outcome }), ctx()));
      expect(plan.patch.attemptedVersion).toBe(expected);
    });
  }
});

describe("rule 5(i): commitments", () => {
  const X = T0; // the row's input watermark
  it("ride only on a triaged outcome written in full", () => {
    const c = [commitment("m3", T0 + 50_000)];
    expect(write(planThreadWrite(liveRow(), triage({ commitments: c }), ctx())).commitmentsToUpsert).toHaveLength(1);
    for (const o of [failed(T0 + 1), filtered(T0 + 1), budget(T0 + 1), unchanged(T0), triaged(T0 - 1)]) {
      const plan = planThreadWrite(liveRow(), triage({ outcome: o, commitments: c }), ctx());
      expect(plan.action === "write" ? plan.commitmentsToUpsert : [], o.kind).toEqual([]);
    }
  });

  it("first extraction (no input watermark): every one", () => {
    const c = [commitment("m1", T0 - 30 * DAY), commitment("m2", null)];
    expect(write(planThreadWrite(null, triage({ commitments: c }), ctx())).commitmentsToUpsert).toHaveLength(2);
    const noWatermark = liveRow({ inputWatermark: null });
    expect(write(planThreadWrite(noWatermark, triage({ commitments: c }), ctx())).commitmentsToUpsert).toHaveLength(2);
  });

  it("later extractions keep messages ingested after the watermark minus the 120 s settle margin", () => {
    const c = [
      commitment("old", X - 120_000), // exactly at the margin: dropped
      commitment("late", X - 119_999), // committed late, behind a newer message: kept
      commitment("new", X + 1),
      commitment("unknown", null) // no ingest time: can't be shown new
    ];
    const plan = write(planThreadWrite(liveRow(), triage({ commitments: c }), ctx()));
    expect(plan.commitmentsToUpsert.map((x) => x.messageId)).toEqual(["late", "new"]);
  });

  it("amendments-1: m7 committed first, then m6's job keeps m6's commitment", () => {
    const c6 = T0 + 40_000;
    const c7 = T0 + 45_000;
    // J7 saw only m7 (m6 not yet committed): w = c7.
    const j7 = triage({ snapshot: snap(T0 + 70_000, { identityCount: 2, maxCreatedAtMs: c7 }), outcome: triaged(c7), commitments: [commitment("m7", c7)] });
    const afterJ7 = apply(liveRow(), planThreadWrite(liveRow(), j7, ctx()));
    expect(afterJ7?.inputWatermark).toBe(iso(c7));
    // J6 read later and saw both: w = c7 = s, a newer read → written, m6 kept (c6 > c7 - 120 s).
    const j6 = triage({ snapshot: snap(T0 + 80_000, { identityCount: 3, maxCreatedAtMs: c7 }), outcome: triaged(c7), commitments: [commitment("m6", c6), commitment("m7", c7)] });
    const plan = write(planThreadWrite(afterJ7, j6, ctx()));
    expect(plan.commitmentsToUpsert.map((x) => x.messageId)).toEqual(["m6", "m7"]);
  });

  it("two overlapping triaged writes on the same messages both carry them (the insert RPC keeps one set)", () => {
    const p = triage({ commitments: [commitment("m3", T0 + 50_000)] });
    const first = write(planThreadWrite(liveRow(), p, ctx()));
    const second = write(planThreadWrite(apply(liveRow(), first), { ...p, snapshot: { ...p.snapshot, readStartedAtMs: p.snapshot.readStartedAtMs + 50, readDoneAtMs: p.snapshot.readDoneAtMs + 50 } }, ctx({ now: new Date(NOW.getTime() + 1_000) })));
    expect(first.commitmentsToUpsert.map((x) => x.messageId)).toEqual(["m3"]);
    expect(second.commitmentsToUpsert.map((x) => x.messageId)).toEqual(["m3"]);
  });

  for (const [what, firstOutcome] of [
    ["budget-deferred", budget(T0 + 50_000)],
    ["failed", failed(T0 + 50_000)],
    ["filtered", filtered(T0 + 50_000)]
  ] as const) {
    it(`a ${what} first triage, then a triaged retry at the same watermark, extracts every commitment`, () => {
      const first = apply(null, planThreadWrite(null, triage({ outcome: firstOutcome }), ctx()));
      expect(first?.inputWatermark).toBeNull();
      expect(first?.outcomeWatermark).toBe(iso(T0 + 50_000));
      const retry = triage({ outcome: triaged(T0 + 50_000), commitments: [commitment("m1", T0 - DAY), commitment("m2", T0 + 50_000)] });
      const plan = write(planThreadWrite(first, retry, ctx({ now: new Date(NOW.getTime() + DAY) })));
      expect(plan.patch.state).toBe("triaged");
      expect(plan.commitmentsToUpsert.map((x) => x.messageId)).toEqual(["m1", "m2"]);
    });
  }
});

describe("rule 5(j) and retention on triage writes", () => {
  it("a new row: full image, expiry from its newest activity, first seen now", () => {
    const plan = write(planThreadWrite(null, triage(), ctx()));
    expect(plan.insert).toBe(true);
    expect(plan.patch).toMatchObject({
      accountId: "acc_1",
      state: "triaged",
      firstSeenAt: NOW_ISO,
      expiresAt: iso(T0 + 180 * DAY),
      screenedPolicyHash: H,
      attemptedVersion: TRIAGE_VERSION,
      goneAt: null
    });
    // Every stored column is present on an insert.
    expect(Object.keys(plan.patch).sort()).toEqual([...CONTENT_KEYS, ...TOMBSTONE_KEPT].sort());
  });

  it("expiry follows the newest activity, never now", () => {
    expect(threadExpiresAt({ lastInboundAt: iso(T0), lastOutboundAt: iso(T0 + DAY), firstSeenAt: iso(T0 - 9 * DAY) }, 30, NOW)).toBe(iso(T0 + 31 * DAY));
    expect(threadExpiresAt({ lastInboundAt: null, lastOutboundAt: null, firstSeenAt: pgIso(T0 - 9 * DAY) }, 30, NOW)).toBe(iso(T0 + 21 * DAY));
    expect(commitmentExpiresAt({ messageSentAt: iso(T0), dueAt: iso(T0 + 300 * DAY) }, 180)).toBe(iso(T0 + 480 * DAY));
    expect(commitmentExpiresAt({ messageSentAt: iso(T0), dueAt: iso(T0 - DAY) }, 180)).toBe(iso(T0 + 180 * DAY));
    expect(commitmentExpiresAt({ messageSentAt: iso(T0), dueAt: null }, 180)).toBe(iso(T0 + 180 * DAY));
  });
});

// ---------------------------------------------------------------------------
// Interleavings (§5 C)
// ---------------------------------------------------------------------------

describe("interleavings", () => {
  it("stale tombstone race: J1 reads, a restricted CC arrives, J2 tombstones, J1 writes → still a tombstone, no commitments", () => {
    // J1 read the thread before x@restricted.com was CC'd.
    const j1 = triage({ snapshot: snap(T0 + 20_000, { identityCount: 2 }), commitments: [commitment("m2", T0)] });
    // J2 read after the CC arrived: restricted.
    const j2 = triage({ snapshot: snap(T0 + 40_000, { identityCount: 3 }), screen: { verdict: "restricted", hashes: WITH_RESTRICTED, truncated: false } });
    const afterJ2 = apply(liveRow(), planThreadWrite(liveRow(), j2, ctx()));
    expect(afterJ2?.state).toBe("restricted_hidden");
    const plan = planThreadWrite(afterJ2, j1, ctx());
    const after = apply(afterJ2, plan);
    expect(after?.state).toBe("restricted_hidden");
    expectWhitelistEmpty(after as EmailThreadPatch);
    if (plan.action === "write") expect(plan.commitmentsToUpsert).toEqual([]);
  });

  it("stale tombstone race with the rule removed meanwhile: the stale J1 still can't exit (older snapshot)", () => {
    const afterJ2 = apply(
      liveRow(),
      planThreadWrite(liveRow(), triage({ snapshot: snap(T0 + 40_000, { identityCount: 3 }), screen: { verdict: "restricted", hashes: WITH_RESTRICTED, truncated: false } }), ctx())
    );
    const j1 = triage({ snapshot: snap(T0 + 20_000, { identityCount: 2 }), policyHash: H_NONE });
    expect(planThreadWrite(afterJ2, j1, ctx({ rules: [], currentPolicyHash: H_NONE }))).toEqual({ action: "skip", reason: "stale_vs_tombstone" });
  });

  it("data-1: a tombstone made without a read (reconcile's ruled feed row) is dated to when it was written, so a read in flight before it can't leave it", () => {
    // 600 stored hashes that all sort before the ruled ones: the union keeps
    // the 600 and drops the ruled hashes, and the row turns truncated.
    const filler = Array.from({ length: 600 }, (_, i) => `0${i.toString(16).padStart(31, "0")}`);
    const live = liveRow({ screenHashes: filler });
    const writtenAt = T0 + 300_000;
    const tomb = apply(live, planThreadWrite(live, { kind: "tombstone", snapshot: null, hashes: WITH_RESTRICTED, truncated: false, policyHash: H }, ctx({ now: new Date(writtenAt) })));
    expect(tomb).toMatchObject({
      state: "restricted_hidden",
      screenTruncated: true,
      screenHashes: filler,
      snapshotIdentityCount: ROW_SNAP.identityCount,
      snapshotReadStartedAt: iso(ROW_SNAP.readStartedAtMs),
      snapshotReadDoneAt: iso(writtenAt)
    });
    // J0 read at T0+100 s: after the stored read, before the ruled mail arrived, so its own screen is clean
    // and the union can't see the ruled hashes either. It started before the tombstone was written: stale.
    const j0 = triage({ snapshot: snap(T0 + 100_000, { identityCount: 3 }), screen: { verdict: "clean", hashes: CLEAN, truncated: false } });
    expect(planThreadWrite(tomb, j0, ctx({ now: new Date(writtenAt + 5_000) }))).toEqual({ action: "skip", reason: "stale_vs_tombstone" });
    // A clean read that started after it was written (plus the skew) is ordered after it (A4).
    const later = triage({ snapshot: snap(writtenAt + 5_001, { identityCount: 3 }), screen: { verdict: "clean", hashes: CLEAN, truncated: false } });
    expect(planThreadWrite(tomb, later, ctx({ now: new Date(writtenAt + 10_000) })).action).toBe("write");
  });

  it("data-1: only a content row being emptied is re-dated; an existing tombstone keeps its snapshot", () => {
    const t = tombstoneRow();
    expect(planThreadWrite(t, { kind: "tombstone", snapshot: null, hashes: null, truncated: null, policyHash: H }, ctx({ now: new Date(T0 + 900_000) }))).toEqual({ action: "skip", reason: "noop" });
    // A proposal with its own newer snapshot keeps that snapshot as it is.
    const fromRead = tomb(planThreadWrite(liveRow(), { kind: "tombstone", snapshot: snap(T0 + 70_000), hashes: WITH_RESTRICTED, truncated: false, policyHash: H }, ctx({ now: new Date(T0 + 900_000) })));
    expect(fromRead.patch.snapshotReadDoneAt).toBe(iso(T0 + 70_300));
  });

  it("stale gone: a job that read before the 404 can't revive the row", () => {
    const gone = apply(liveRow(), planThreadWrite(liveRow(), { kind: "gone", atMs: GONE_AT }, ctx()));
    expect(gone?.state).toBe("gone");
    expect(planThreadWrite(gone, triage({ snapshot: snap(GONE_AT - 1_000, { identityCount: 9 }) }), ctx())).toEqual({ action: "skip", reason: "stale_vs_gone" });
  });

  it("a 404 for a tombstone leaves it a tombstone", () => {
    expect(planThreadWrite(tombstoneRow(), { kind: "gone", atMs: GONE_AT }, ctx())).toEqual({ action: "skip", reason: "tombstone" });
  });
});

// ---------------------------------------------------------------------------
// Programming errors
// ---------------------------------------------------------------------------

describe("malformed input is refused (NonRetryableError), never guessed", () => {
  const bad: [string, () => unknown][] = [
    ["unknown proposal kind", () => planThreadWrite(null, { kind: "signals" } as unknown as ThreadProposal, ctx())],
    ["a policy hash that isn't sha256 hex", () => planThreadWrite(null, triage({ policyHash: "nope" }), ctx())],
    ["a context hash that isn't sha256 hex", () => planThreadWrite(null, triage(), ctx({ currentPolicyHash: "x" }))],
    ["retention days out of range", () => planThreadWrite(null, triage(), ctx({ retentionDays: 0 }))],
    ["a snapshot time that isn't a number", () => planThreadWrite(null, triage({ snapshot: { ...snap(T0), readStartedAtMs: Number.NaN } }), ctx())],
    ["an unknown AI enum", () => planThreadWrite(null, triage({ outcome: triaged(T0, { urgency: "extreme" as never }) }), ctx())],
    ["a facts row without an account", () => planThreadWrite(null, triage({ facts: facts({ accountId: "" }) }), ctx())],
    ["a facts timestamp that isn't one", () => planThreadWrite(null, triage({ facts: facts({ lastInboundAt: "yesterday" }) }), ctx())],
    ["a content hash that isn't sha256 hex", () => planThreadWrite(null, triage({ outcome: { kind: "triaged", watermarkMs: T0, ai: AI, run: { ...RUN, contentHash: "zz" } } }), ctx())],
    ["screen hashes that aren't strings", () => planThreadWrite(null, triage({ screen: { verdict: "clean", hashes: [1 as unknown as string], truncated: false } }), ctx())]
  ];
  for (const [what, call] of bad) {
    it(what, () => {
      expect(call).toThrow(NonRetryableError);
    });
  }

  it("refusal messages name fields, never values", () => {
    try {
      planThreadWrite(null, triage({ facts: facts({ lastInboundAt: "secret-subject-text" }) }), ctx());
      throw new Error("did not throw");
    } catch (err) {
      expect(String(err)).not.toContain("secret-subject-text");
      expect(String(err)).toContain("facts.lastInboundAt");
    }
  });
});
