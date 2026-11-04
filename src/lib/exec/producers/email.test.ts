import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { normalizeCandidate, parseEmailFingerprint, reconcile } from "@/lib/exec/attention";
import type { AttentionCandidate } from "@/lib/exec/attention-types";
import type { ProducerThreadRow } from "@/lib/exec/email-store";
import type { ExecCommitment, ExecEmailSignal, ReplyArtifacts, ThreadScreenRow } from "@/lib/exec/email-types";
import {
  EMAIL_ATTENTION_KINDS,
  buildEmailCandidates,
  emailThreadAnchor,
  type EmailCandidateInput,
  type HealthDrop,
  type ProducerSignal
} from "@/lib/exec/producers/email";
import type { DdClient, DdSatisfactionSignal } from "@/lib/exec/sources/dd-types";
import { restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// producers/email.ts (contract §3.13, A2, L4, L12, L13): the restricted
// screen on every row, one anchored item per thread with its precedence, the
// per-kind conditions and windows, stable state hashes, commitments only
// through clean thread rows, satisfaction freshness per client, health drops,
// and what an item may carry (no evidence quote, no address).

const DAY = 86_400_000;
const NOW = new Date("2026-11-04T17:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

const TH = (n: number) => `4f1c2d3e-aaaa-bbbb-cccc-${String(n).padStart(12, "0")}`;
const MSG = (n: number) => `9a8b7c6d-0000-0000-0000-${String(n).padStart(12, "0")}`;

function rule(id: string, pattern: string, matchKind: "domain" | "exact" = "domain"): RestrictedSenderRule {
  return { id, pattern, matchKind, label: id, viewerUserIds: new Set() };
}

const RULES = [rule("rs_deel", "deel.com"), rule("rs_rm", "rm@gmail.com", "exact")];
const H = restrictedPolicyHash("hidden", RULES);
const OLD_H = restrictedPolicyHash("hidden", [rule("rs_old", "old.example")]);

const hashesOf = (...addresses: string[]) =>
  screenHashesFor({ all: [{ from: addresses[0] ?? "", to: addresses.slice(1), cc: [] }], participants: [] }).hashes;
const CLEAN_HASHES = hashesOf("Jane Doe <jane@acme.com>", "mitchell@scaledai.org");

const CLIENTS: Pick<DdClient, "id" | "name" | "status">[] = [
  { id: "cl_acme", name: "Acme", status: "active" },
  { id: "cl_beta", name: "Beta Labs", status: "active" },
  { id: "cl_gone", name: "Gone Co", status: "churned" }
];

function row(over: Partial<ProducerThreadRow> = {}): ProducerThreadRow {
  return {
    threadId: TH(1),
    accountId: "acct-1",
    state: "triaged",
    version: 3,
    screenHashes: CLEAN_HASHES,
    screenTruncated: false,
    screenedPolicyHash: H,
    subject: "Q3 renewal",
    counterpartName: "Jane Doe",
    counterpartEmail: "jane@acme.com",
    newestMessageId: MSG(1),
    newestInboundMessageId: MSG(1),
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
    summary: "Asks for the renewal quote by Friday.",
    reason: "A direct question that waits on you.",
    category: "client",
    urgency: "normal",
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

const acme = { clientId: "cl_acme", clientName: "Acme", clientMatchVia: "exact" as const, matchConfidence: "high" as const, clientCandidates: 1 };

function input(over: Partial<EmailCandidateInput> = {}): EmailCandidateInput {
  return {
    timezone: "America/New_York",
    threads: [],
    commitments: [],
    screenRows: new Map(),
    signals: new Map(),
    artifacts: new Map(),
    satisfaction: { rows: [], latestScoredByClient: new Map() },
    healthDrops: [],
    clients: CLIENTS,
    rules: RULES,
    currentPolicyHash: H,
    now: NOW,
    ...over
  };
}

function signal(messageId: string, over: Partial<ExecEmailSignal> = {}): [string, ProducerSignal] {
  return [messageId, { messageId, flagged: null, removedAt: null, webLink: null, ...over }];
}

const one = (i: EmailCandidateInput): AttentionCandidate | undefined => {
  const out = buildEmailCandidates(i);
  expect(out.length).toBeLessThanOrEqual(1);
  return out[0];
};
const kindOf = (r: ProducerThreadRow, over: Partial<EmailCandidateInput> = {}) => {
  const c = one(input({ threads: [r], ...over }));
  return c ? `${c.kind}/${c.category}` : null;
};

// ---------------------------------------------------------------------------
// The restricted screen (A2)
// ---------------------------------------------------------------------------

describe("the in-memory screen", () => {
  it("drops a row whose stored hashes match a rule (domain, subdomain, exact)", () => {
    for (const hashes of [
      hashesOf("Payroll <payroll@deel.com>", "mitchell@scaledai.org"),
      hashesOf("jane@acme.com", "ops@eu.deel.com"),
      hashesOf("rm@gmail.com", "mitchell@scaledai.org")
    ]) {
      expect(kindOf(row({ screenHashes: hashes, urgency: "critical" }))).toBeNull();
    }
  });

  it("drops a truncated row screened under another policy, keeps one screened under this one", () => {
    expect(kindOf(row({ screenTruncated: true, screenedPolicyHash: OLD_H, urgency: "critical" }))).toBeNull();
    expect(kindOf(row({ screenTruncated: true, screenedPolicyHash: null, urgency: "critical" }))).toBeNull();
    expect(kindOf(row({ screenTruncated: true, screenedPolicyHash: H, urgency: "critical" }))).toBe("important_email/my_action");
  });

  it("keeps a complete row last stamped under an older policy: its hashes alone decide", () => {
    expect(kindOf(row({ screenedPolicyHash: OLD_H, urgency: "critical" }))).toBe("important_email/my_action");
  });

  it("never builds from a tombstone or a gone row", () => {
    expect(kindOf(row({ state: "restricted_hidden", urgency: "critical" }))).toBeNull();
    expect(kindOf(row({ state: "gone", urgency: "critical" }))).toBeNull();
    expect(kindOf(row({ state: "filtered", urgency: "critical" }))).toBeNull();
  });

  it("a rule change over more than 500 rows leaves the unaffected items exactly as they were", () => {
    const threads = Array.from({ length: 600 }, (_, i) =>
      row({ threadId: TH(i), newestMessageId: MSG(i), newestInboundMessageId: MSG(i), lastInboundAt: ago(3 + (i % 20)), urgency: i % 2 ? "high" : "normal" })
    );
    const before = buildEmailCandidates(input({ threads }));
    expect(before).toHaveLength(600);
    // A new rule arrives; the rows are still stamped with the old hash and
    // their (complete) hashes don't match it.
    const rules2 = [...RULES, rule("rs_new", "billcom.example")];
    const after = buildEmailCandidates(input({ threads, rules: rules2, currentPolicyHash: restrictedPolicyHash("hidden", rules2) }));
    expect(after).toEqual(before);
    // reconcile against the stored items: nothing reopens, resolves or changes.
    const stored = before.map((c, i) => ({
      ...c,
      id: `ea_${i}`,
      principalId: "ep_1",
      status: "seen" as const,
      snoozeUntil: null,
      firstSeenAt: ago(1),
      lastSeenAt: ago(0.01),
      resolvedAt: null,
      resolution: null,
      updatedAt: ago(1)
    }));
    const plan = reconcile(stored, after, { source: "email", kinds: EMAIL_ATTENTION_KINDS }, NOW);
    expect(plan.inserts).toEqual([]);
    expect(plan.resolves).toEqual([]);
    expect(plan.updates.every((u) => u.change === "unchanged")).toBe(true);
  });

  it("a rule that matches one row of many drops that row only", () => {
    const threads = [
      row({ threadId: TH(1) }),
      row({ threadId: TH(2), newestInboundMessageId: MSG(2), newestMessageId: MSG(2), screenHashes: hashesOf("x@newly-restricted.example", "mitchell@scaledai.org") }),
      row({ threadId: TH(3), newestInboundMessageId: MSG(3), newestMessageId: MSG(3) })
    ].map((r) => ({ ...r, lastInboundAt: ago(4) }));
    const rules2 = [...RULES, rule("rs_new", "newly-restricted.example")];
    const out = buildEmailCandidates(input({ threads, rules: rules2, currentPolicyHash: restrictedPolicyHash("hidden", rules2) }));
    expect(out.map((c) => parseEmailFingerprint(c.fingerprint)?.threadId)).toEqual([TH(1), TH(3)]);
  });
});

// ---------------------------------------------------------------------------
// Thread items: anchor, precedence, conditions
// ---------------------------------------------------------------------------

describe("one item per thread, one anchor", () => {
  it("anchors on the newest inbound message, else the newest message", () => {
    expect(emailThreadAnchor(row())).toBe(MSG(1));
    expect(emailThreadAnchor(row({ newestInboundMessageId: null, newestMessageId: MSG(9) }))).toBe(MSG(9));
    expect(emailThreadAnchor(row({ newestInboundMessageId: null, newestMessageId: null }))).toBeNull();
    const c = one(input({ threads: [row({ urgency: "high" })] }));
    expect(c?.fingerprint).toBe(`email:thread:${TH(1)}:${MSG(1)}`);
  });

  it("a decision anchored on an older message keeps the thread's anchor (the decision id is in the state hash only)", () => {
    const base = row({ decisionQuestion: "Approve the 10% discount?", decisionMessageId: MSG(1) });
    const older = { ...base, decisionMessageId: MSG(0) };
    const a = one(input({ threads: [base] }));
    const b = one(input({ threads: [older] }));
    expect(a?.kind).toBe("decision_ask");
    expect(b?.fingerprint).toBe(a?.fingerprint);
    expect(b?.stateHash).not.toBe(a?.stateHash);
  });

  it("a new inbound message is a new item (the anchor moves)", () => {
    const a = one(input({ threads: [row({ urgency: "high" })] }));
    const b = one(input({ threads: [row({ urgency: "high", newestInboundMessageId: MSG(2), newestMessageId: MSG(2) })] }));
    expect(b?.fingerprint).not.toBe(a?.fingerprint);
  });

  it("precedence: escalation, then decision, then important; the kind changes in place", () => {
    const all = row({ ...acme, clientSignal: "complaint", decisionQuestion: "Refund or credit?", urgency: "high" });
    const escalation = one(input({ threads: [all] }));
    const decision = one(input({ threads: [{ ...all, clientId: null, clientName: null, matchConfidence: null, clientMatchVia: null }] }));
    const important = one(input({ threads: [{ ...all, clientId: null, clientName: null, matchConfidence: null, clientMatchVia: null, decisionQuestion: null }] }));
    expect([escalation?.kind, decision?.kind, important?.kind]).toEqual(["client_escalation", "decision_ask", "important_email"]);
    expect(new Set([escalation?.fingerprint, decision?.fingerprint, important?.fingerprint]).size).toBe(1);
    expect(new Set([escalation?.stateHash, decision?.stateHash, important?.stateHash]).size).toBe(3);
  });

  it("makes one candidate per fingerprint even from duplicate rows", () => {
    const r = row({ urgency: "high" });
    expect(buildEmailCandidates(input({ threads: [r, { ...r }] }))).toHaveLength(1);
  });

  it("skips a thread whose ids can't key an item instead of failing the sync", () => {
    expect(kindOf(row({ threadId: "bad id", urgency: "high" }))).toBeNull();
    expect(kindOf(row({ newestInboundMessageId: "a:b", newestMessageId: "a:b", urgency: "high" }))).toBeNull();
  });
});

describe("client_escalation", () => {
  const esc = (over: Partial<ProducerThreadRow>) => row({ ...acme, clientSignal: "complaint", ...over });

  it.each<[string, Partial<ProducerThreadRow>, string | null]>([
    ["a complaint from a client, awaiting his reply", {}, "client_escalation/intervene"],
    ["a churn risk", { clientSignal: "churn_risk" }, "client_escalation/intervene"],
    ["something broken", { clientSignal: "outage_or_breakage" }, "client_escalation/intervene"],
    ["a billing or legal dispute", { clientSignal: "billing_or_legal_dispute" }, "client_escalation/intervene"],
    ["urgent client mail with no signal", { clientSignal: "none", urgency: "critical" }, "client_escalation/intervene"],
    ["high urgency counts as urgent", { clientSignal: "none", urgency: "high" }, "client_escalation/intervene"],
    ["a medium-confidence match", { matchConfidence: "medium", clientMatchVia: "domain" }, "client_escalation/intervene"],
    ["praise is not an escalation", { clientSignal: "praise" }, "important_email/my_action"],
    ["a low-confidence match is not a client", { matchConfidence: "low", clientCandidates: 3 }, null],
    ["last inbound 14 days ago still counts", { lastInboundAt: ago(14) }, "client_escalation/intervene"],
    ["15 days is past the window", { lastInboundAt: ago(15) }, "important_email/my_action"],
    ["answered", { answeredState: "answered" }, null]
  ])("%s → %s", (_name, over, expected) => {
    expect(kindOf(esc(over))).toBe(expected);
  });

  it("a thread he archived in Outlook (the newest inbound's signal) isn't an escalation, nor anything else", () => {
    const signals = new Map([signal(MSG(1), { removedAt: ago(0.5) })]);
    expect(kindOf(esc({}), { signals })).toBeNull();
  });

  it("an archive of an older message doesn't count once a new one arrives", () => {
    const signals = new Map([signal(MSG(0), { removedAt: ago(0.5) })]);
    expect(kindOf(esc({}), { signals })).toBe("client_escalation/intervene");
  });

  it.each<[string, ReplyArtifacts]>([
    ["a scheduled reply", { scheduledFor: ahead(1), draftPending: false }],
    ["a draft waiting for approval", { scheduledFor: null, draftPending: true }]
  ])("%s takes it off the list", (_name, artifact) => {
    expect(kindOf(esc({}), { artifacts: new Map([[TH(1), artifact]]) })).toBeNull();
  });
});

describe("decision_ask", () => {
  const dec = (over: Partial<ProducerThreadRow>) => row({ decisionQuestion: "Do we take the Q1 pilot?", decisionMessageId: MSG(1), ...over });
  it.each<[string, Partial<ProducerThreadRow>, string | null]>([
    ["a decision asked of him, awaiting", {}, "decision_ask/approval"],
    ["30 days old still counts", { lastInboundAt: ago(30) }, "decision_ask/approval"],
    ["31 days is past the window", { lastInboundAt: ago(31) }, null],
    ["a blank question is no decision", { decisionQuestion: "   " }, null],
    ["answered", { answeredState: "answered" }, null]
  ])("%s → %s", (_name, over, expected) => {
    expect(kindOf(dec({ needsReply: false, ...over }))).toBe(expected);
  });
});

describe("important_email", () => {
  it.each<[string, Partial<ProducerThreadRow>, string | null]>([
    ["needs a reply, a day old, nothing special: not yet", {}, null],
    ["needs a reply and has waited 3 days", { lastInboundAt: ago(3) }, "important_email/my_action"],
    ["needs a reply, high urgency", { urgency: "high" }, "important_email/my_action"],
    ["needs a reply, critical urgency", { urgency: "critical" }, "important_email/my_action"],
    ["needs a reply, AI importance high", { importance: "high" }, "important_email/my_action"],
    ["needs a reply, needs him personally", { mitchellPersonally: true }, "important_email/my_action"],
    ["needs a reply, from a client", { clientId: "cl_acme", clientName: "Acme", matchConfidence: "medium", clientMatchVia: "domain", clientCandidates: 1 }, "important_email/my_action"],
    ["30 days old still counts", { lastInboundAt: ago(30) }, "important_email/my_action"],
    ["31 days is past the window", { lastInboundAt: ago(31) }, null],
    ["answered", { answeredState: "answered", urgency: "critical" }, null],
    ["outbound only", { answeredState: "no_inbound", lastInboundAt: null, newestInboundMessageId: null, urgency: "critical" }, null],
    ["no reply needed, important: FYI", { needsReply: false, importance: "high" }, "important_email/fyi"],
    ["no reply needed, nothing special", { needsReply: false }, null],
    ["FYI only within 7 days", { needsReply: false, importance: "high", lastInboundAt: ago(8) }, null],
    ["automated mail is never an FYI", { needsReply: false, importance: "high", automated: true }, null],
    ["an answered FYI is done", { needsReply: false, importance: "high", answeredState: "answered" }, null]
  ])("%s → %s", (_name, over, expected) => {
    expect(kindOf(row(over))).toBe(expected);
  });

  it("an Outlook flag (on the anchor) makes it important, and an FYI", () => {
    const signals = new Map([signal(MSG(1), { flagged: true })]);
    expect(kindOf(row(), { signals })).toBe("important_email/my_action");
    expect(kindOf(row({ needsReply: false }), { signals })).toBe("important_email/fyi");
    const c = one(input({ threads: [row()], signals }));
    expect(c?.priority.reasons).toContain("Flagged in Outlook (+8)");
    expect(c?.facts).toContainEqual(expect.objectContaining({ text: "Flagged in Outlook", basis: "record" }));
  });
});

// ---------------------------------------------------------------------------
// What a thread item says
// ---------------------------------------------------------------------------

describe("a thread item's content", () => {
  const LINK = "https://outlook.office365.com/owa/?ItemID=AAMkAD%2BZ&exvsurl=1&viewmodel=ReadMessageItem";

  it("tags every fact with its basis and cites private refs", () => {
    const r = row({ ...acme, clientSignal: "complaint", urgency: "high", decisionQuestion: null, lastInboundAt: ago(2), injectionSuspected: true });
    const c = one(input({ threads: [r], signals: new Map([signal(MSG(1), { webLink: LINK })]) })) as AttentionCandidate;
    expect(c).toMatchObject({ source: "email", kind: "client_escalation", category: "intervene", occurredAt: ago(2) });
    expect(c.title).toBe("Client escalation from Acme: Q3 renewal");
    expect(c.whatHappened).toBe("Acme wrote 2 days ago, and it hasn't been answered.");
    expect(c.whyItMatters).toBe("AI-assessed as a complaint from a client.");
    expect(c.recommendedNext).toBe("Reply today, or hand it to the client's account lead with a deadline.");
    const basis = Object.fromEntries(c.facts.map((f) => [f.text.split(/[:(]/)[0].trim(), f.basis]));
    expect(basis).toMatchObject({
      Summary: "ai",
      "Why it was flagged": "ai",
      "Urgency high, importance normal": "ai",
      "Client signal": "ai",
      Client: "derived",
      "Unanswered for 2 days": "derived",
      "Last email in": "record"
    });
    expect(c.facts.some((f) => f.basis === "ai" && /instructions planted/.test(f.text))).toBe(true);
    expect(c.refs.map((ref) => [ref.system, ref.class])).toEqual([
      ["dd", "private"],
      ["outlook", "private"],
      ["dd", "internal"]
    ]);
    expect(c.refs[1].url).toBe(new URL(LINK).href);
    expect(c.priority.reasons).toEqual(["Client escalation (base 45)", "High urgency (AI-assessed) (+12)", "Client waiting 2 days (+6)"]);
  });

  it("carries no address and no name from the mail, and at most 120 characters of subject in the title", () => {
    const subject = `${"Renewal ".repeat(30)}end`;
    const c = one(input({ threads: [row({ subject, urgency: "high", counterpartName: "Jane Q. Doe", counterpartEmail: "jane.q@acme.com" })] })) as AttentionCandidate;
    const json = JSON.stringify(c);
    expect(json).not.toMatch(/jane|Jane|acme\.com/);
    expect(c.title.startsWith("Reply needed: ")).toBe(true);
    expect(c.title.length).toBeLessThanOrEqual("Reply needed: ".length + 120);
    expect(c.title).not.toContain("end");
  });

  it("puts the decision question in whyItMatters only (A7), never in a fact", () => {
    const c = one(input({ threads: [row({ decisionQuestion: "Approve the 10% discount?", needsReply: false })] })) as AttentionCandidate;
    expect(c.kind).toBe("decision_ask");
    expect(c.whyItMatters).toBe("AI-assessed: the email asks you to decide: Approve the 10% discount?");
    expect(c.facts.some((f) => f.text.includes("discount"))).toBe(false);
    expect(c.facts).toContainEqual(expect.objectContaining({ text: "Asks you for a decision (AI-assessed)", basis: "ai" }));
  });

  it("falls back on a missing subject", () => {
    expect(one(input({ threads: [row({ subject: null, urgency: "high" })] }))?.title).toBe("Reply needed: (no subject)");
  });

  it("uses the newest inbound's web link, else the newest message's", () => {
    const r = row({ urgency: "high", newestMessageId: MSG(2) });
    const withOwn = one(input({ threads: [r], signals: new Map([signal(MSG(1), { webLink: LINK }), signal(MSG(2), { webLink: `${LINK}&ispopout=0` })]) }));
    expect(withOwn?.refs.find((ref) => ref.system === "outlook")?.url).toBe(new URL(LINK).href);
    const fallback = one(input({ threads: [r], signals: new Map([signal(MSG(2), { webLink: LINK })]) }));
    expect(fallback?.refs.find((ref) => ref.system === "outlook")?.url).toBe(new URL(LINK).href);
    const none = one(input({ threads: [r] }));
    expect(none?.refs.some((ref) => ref.system === "outlook")).toBe(false);
  });

  it("produces candidates syncAttention accepts, already in their stored form", () => {
    const out = buildEmailCandidates(
      input({
        threads: [
          row({ ...acme, clientSignal: "complaint", summary: "s".repeat(400), reason: "r".repeat(160) }),
          row({ threadId: TH(2), newestInboundMessageId: MSG(2), newestMessageId: MSG(2), decisionQuestion: "Yes or no?", subject: "x".repeat(200) })
        ]
      })
    );
    expect(out).toHaveLength(2);
    for (const c of out) expect(normalizeCandidate(c)).toEqual(c);
    expect(() => reconcile([], out, { source: "email", kinds: EMAIL_ATTENTION_KINDS }, NOW)).not.toThrow();
  });
});

describe("state hashes", () => {
  it("take no time inputs: the same situation a day later hashes the same, while the score ages", () => {
    const r = row({ urgency: "high", lastInboundAt: ago(1) });
    const today = one(input({ threads: [r] })) as AttentionCandidate;
    const tomorrow = one(input({ threads: [r], now: new Date(NOW.getTime() + DAY) })) as AttentionCandidate;
    expect(tomorrow.stateHash).toBe(today.stateHash);
    expect(tomorrow.priority.score).toBeGreaterThan(today.priority.score);
  });

  it("ignore the AI's wording, and move on what he would want to see again", () => {
    const base = one(input({ threads: [row({ urgency: "high" })] })) as AttentionCandidate;
    const reworded = one(input({ threads: [row({ urgency: "high", summary: "Different words", reason: "Other words" })] })) as AttentionCandidate;
    expect(reworded.stateHash).toBe(base.stateHash);
    for (const changed of [
      row({ urgency: "critical" }),
      row({ urgency: "high", importance: "high" }),
      row({ urgency: "high", clientSignal: "churn_risk" }),
      row({ urgency: "high", decisionQuestion: "Which plan?" })
    ]) {
      expect(one(input({ threads: [changed] }))?.stateHash).not.toBe(base.stateHash);
    }
    const flagged = one(input({ threads: [row({ urgency: "high" })], signals: new Map([signal(MSG(1), { flagged: true })]) }));
    expect(flagged?.stateHash).not.toBe(base.stateHash);
  });

  it("are 16 hex characters", () => {
    expect(one(input({ threads: [row({ urgency: "high" })] }))?.stateHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// overdue_commitment
// ---------------------------------------------------------------------------

function commitment(over: Partial<ExecCommitment> = {}): ExecCommitment {
  return {
    id: "ec_00000000000000000000000000000001",
    principalId: "ep_1",
    fingerprint: "f".repeat(64),
    source: "email",
    threadId: TH(1),
    messageId: MSG(1),
    accountId: "acct-1",
    direction: "mitchell_owes",
    text: "Send the signed SOW",
    counterparty: "Acme",
    dueAt: ago(2),
    dueText: "by Monday",
    status: "open",
    followedUpAt: null,
    evidenceExcerpt: "SECRET EVIDENCE: I will send the signed SOW by Monday",
    sourceRef: { system: "outlook", id: MSG(1), url: null, label: "Q3 renewal", class: "private" },
    messageSentAt: ago(9),
    messageCreatedAt: ago(9),
    createdAt: ago(9),
    updatedAt: ago(9),
    expiresAt: ahead(200),
    ...over
  };
}

function screenRow(over: Partial<ThreadScreenRow> = {}): ThreadScreenRow {
  return { threadId: TH(1), accountId: "acct-1", state: "triaged", screenHashes: CLEAN_HASHES, screenTruncated: false, screenedPolicyHash: H, ...over };
}

describe("overdue_commitment", () => {
  const withRow = (c: ExecCommitment, r: ThreadScreenRow | null, over: Partial<EmailCandidateInput> = {}) =>
    buildEmailCandidates(input({ commitments: [c], screenRows: new Map(r ? [[c.threadId, r]] : []), ...over }));

  it("is an item for an open commitment past due, through a clean thread row", () => {
    const [c] = withRow(commitment(), screenRow());
    expect(c).toMatchObject({
      fingerprint: `email:commitment:${TH(1)}:ec_00000000000000000000000000000001`,
      kind: "overdue_commitment",
      category: "my_action",
      title: "You promised: Send the signed SOW",
      occurredAt: ago(2)
    });
    expect(c.whatHappened).toMatch(/^You committed to deliver this to Acme by .+\. It is 2 days overdue\.$/);
    expect(c.priority.reasons).toEqual(["Overdue commitment (base 30)", "Overdue 2 days (+4)"]);
    expect(c.facts.map((f) => f.basis)).toEqual(["ai", "ai", "ai", "derived", "record"]);
    expect(c.refs).toEqual([expect.objectContaining({ system: "dd", class: "private", id: `/executive/email/${TH(1)}` })]);
  });

  it("is delegated when it is owed to him", () => {
    const [c] = withRow(commitment({ direction: "owed_to_mitchell", counterparty: "Jane" }), screenRow());
    expect(c.category).toBe("delegated");
    expect(c.title).toBe("Owed to you: Send the signed SOW");
    expect(c.whatHappened).toMatch(/^Jane committed to deliver this to you by/);
  });

  it("never carries the evidence quote", () => {
    const out = withRow(commitment(), screenRow());
    expect(JSON.stringify(out)).not.toContain("SECRET EVIDENCE");
  });

  it.each<[string, ThreadScreenRow | null]>([
    ["no thread row", null],
    ["a tombstoned thread", screenRow({ state: "restricted_hidden", screenHashes: [] })],
    ["a gone thread", screenRow({ state: "gone" })],
    ["a thread whose hashes match a rule", screenRow({ screenHashes: hashesOf("x@deel.com") })],
    ["a truncated thread screened under another policy", screenRow({ screenTruncated: true, screenedPolicyHash: OLD_H })]
  ])("is dropped for %s", (_name, r) => {
    expect(withRow(commitment(), r)).toEqual([]);
  });

  it("counts for a thread of any age and state that passes the screen", () => {
    expect(withRow(commitment(), screenRow({ state: "filtered" }))).toHaveLength(1);
  });

  it.each<[string, Partial<ExecCommitment>]>([
    ["not yet due", { dueAt: ahead(1) }],
    ["no due date", { dueAt: null }],
    ["more than 30 days overdue (the pass expires it)", { dueAt: ago(31) }],
    ["followed up", { status: "followed_up", followedUpAt: ago(1) }],
    ["expired", { status: "expired" }]
  ])("is no item when %s", (_name, over) => {
    expect(withRow(commitment(over), screenRow())).toEqual([]);
  });

  it("labels the thread link with the subject only when the thread row is clean", () => {
    const [clean] = withRow(commitment(), screenRow(), { threads: [row({ urgency: "low", needsReply: false })] });
    expect(clean.refs[0].label).toBe("Q3 renewal");
    const [noRow] = withRow(commitment(), screenRow());
    expect(noRow.refs[0].label).toBe("Email thread");
  });

  it("never borrows a link label from a producer row that fails the screen", () => {
    // Two reads that disagree (the producer row matched a rule, the screen
    // row didn't): the commitment may show, but not with that row's subject.
    const restricted = row({ subject: "Deel payroll", screenHashes: hashesOf("payroll@deel.com") });
    const [c] = withRow(commitment(), screenRow(), { threads: [restricted] });
    expect(c.refs[0].label).toBe("Email thread");
    expect(JSON.stringify(c)).not.toContain("Deel");
  });

  it("hashes status, due date and overdue bucket: steady within a bucket", () => {
    const [d3] = withRow(commitment({ dueAt: ago(3.1) }), screenRow());
    const [d5] = withRow(commitment({ dueAt: ago(3.1) }), screenRow(), { now: new Date(NOW.getTime() + 2 * DAY) });
    const [d8] = withRow(commitment({ dueAt: ago(3.1) }), screenRow(), { now: new Date(NOW.getTime() + 5 * DAY) });
    expect(d5.stateHash).toBe(d3.stateHash);
    expect(d8.stateHash).not.toBe(d3.stateHash);
  });
});

// ---------------------------------------------------------------------------
// client_satisfaction_drop (L13)
// ---------------------------------------------------------------------------

describe("client_satisfaction_drop", () => {
  const sat = (clientId: string, score: number, deliveredDaysAgo: number): DdSatisfactionSignal => ({
    clientId,
    score,
    deliveredAt: ago(deliveredDaysAgo),
    scoredAt: ago(deliveredDaysAgo - 0.1)
  });
  const fresh = new Map([
    ["cl_acme", ago(1)],
    ["cl_beta", ago(4)],
    ["cl_gone", ago(1)]
  ]);
  const build = (rows: DdSatisfactionSignal[], latest = fresh, now = NOW) =>
    buildEmailCandidates(input({ satisfaction: { rows, latestScoredByClient: latest }, now }));

  it("is an item for a fresh, active client with unhappy inbound scores in the last 7 days", () => {
    const [c] = build([sat("cl_acme", 40, 2), sat("cl_acme", 90, 1), sat("cl_acme", 50, 3)]);
    expect(c).toMatchObject({ fingerprint: "email:satisfaction:cl_acme", kind: "client_satisfaction_drop", category: "intervene", title: "Client satisfaction dropped: Acme" });
    expect(c.whatHappened).toBe("2 inbound emails from Acme in the last 7 days scored as unhappy.");
    expect(c.priority.reasons).toEqual(["Client satisfaction drop (base 30)", "Medium severity (+8)", "2 items (+3)"]);
    expect(c.facts.map((f) => f.basis)).toEqual(["ai", "ai", "record"]);
    expect(c.occurredAt).toBe(ago(2));
  });

  it("is hostile at 25 or below", () => {
    const [c] = build([sat("cl_acme", 20, 1)]);
    expect(c.priority.reasons).toContain("High severity (+20)");
    expect(c.whatHappened).toMatch(/as hostile/);
  });

  it.each<[string, DdSatisfactionSignal[], Map<string, string>]>([
    ["stale scores (newest older than 3 days)", [sat("cl_beta", 30, 2)], fresh],
    ["no score on record", [sat("cl_acme", 30, 2)], new Map()],
    ["an inactive client", [sat("cl_gone", 30, 2)], fresh],
    ["an unknown client", [sat("cl_who", 30, 2)], new Map([["cl_who", ago(1)]])],
    ["only happy scores", [sat("cl_acme", 56, 1), sat("cl_acme", 95, 1)], fresh],
    ["unhappy mail older than the window", [sat("cl_acme", 10, 8)], fresh]
  ])("is no item for %s", (_name, rows, latest) => {
    expect(build(rows, latest)).toEqual([]);
  });

  it("decides freshness per client", () => {
    const out = build([sat("cl_acme", 30, 1), sat("cl_beta", 30, 1)]);
    expect(out.map((c) => c.fingerprint)).toEqual(["email:satisfaction:cl_acme"]);
  });

  it("hashes count, newest low date and the score band, not the clock", () => {
    const rows = [sat("cl_acme", 40, 2)];
    const [a] = build(rows);
    const [later] = build(rows, new Map([["cl_acme", ago(0)]]), new Date(NOW.getTime() + 0.5 * DAY));
    expect(later.stateHash).toBe(a.stateHash);
    const [more] = build([...rows, sat("cl_acme", 45, 1)]);
    expect(more.stateHash).not.toBe(a.stateHash);
    const [worse] = build([sat("cl_acme", 10, 2)]);
    expect(worse.stateHash).not.toBe(a.stateHash);
  });
});

// ---------------------------------------------------------------------------
// client_health_drop (L13)
// ---------------------------------------------------------------------------

describe("client_health_drop", () => {
  const drop = (over: Partial<HealthDrop> = {}): HealthDrop => ({ clientId: "cl_acme", from: "steady", to: "shaky", droppedAt: ago(1), overridden: false, ...over });

  it("is an item while the drop is under 7 days old", () => {
    const [c] = buildEmailCandidates(input({ healthDrops: [drop()] }));
    expect(c).toMatchObject({ fingerprint: "email:health:cl_acme", kind: "client_health_drop", category: "intervene", title: "Client health dropped: Acme" });
    expect(c.whatHappened).toMatch(/^Acme's health went from steady to shaky on /);
    expect(c.priority.reasons).toEqual(["Client health drop (base 35)", "Medium severity (+8)"]);
    const [risk] = buildEmailCandidates(input({ healthDrops: [drop({ to: "at_risk", overridden: true })] }));
    expect(risk.priority.reasons).toContain("High severity (+20)");
    expect(risk.whyItMatters).toBe("A leader marked this client down.");
    expect(risk.facts[0].text).toBe("Health now: at risk (set by a leader)");
  });

  it.each<[string, HealthDrop]>([
    ["an old drop", drop({ droppedAt: ago(7.5) })],
    ["a rise", drop({ from: "shaky", to: "steady" })],
    ["no change", drop({ from: "shaky", to: "shaky" })],
    ["an inactive client", drop({ clientId: "cl_gone" })],
    ["an unknown client", drop({ clientId: "cl_who" })]
  ])("is no item for %s", (_name, d) => {
    expect(buildEmailCandidates(input({ healthDrops: [d] }))).toEqual([]);
  });

  it("hashes from, to and the drop date", () => {
    const [a] = buildEmailCandidates(input({ healthDrops: [drop()] }));
    const [b] = buildEmailCandidates(input({ healthDrops: [drop()], now: new Date(NOW.getTime() + DAY) }));
    const [c] = buildEmailCandidates(input({ healthDrops: [drop({ to: "at_risk" })] }));
    expect(b.stateHash).toBe(a.stateHash);
    expect(c.stateHash).not.toBe(a.stateHash);
  });
});

describe("the whole batch", () => {
  it("never builds a public ref, and keeps every kind inside the email scope", () => {
    const out = buildEmailCandidates(
      input({
        threads: [row({ ...acme, clientSignal: "complaint" }), row({ threadId: TH(2), newestInboundMessageId: MSG(2), newestMessageId: MSG(2), needsReply: false, importance: "high" })],
        commitments: [commitment()],
        screenRows: new Map([[TH(1), screenRow()]]),
        satisfaction: { rows: [{ clientId: "cl_acme", score: 20, deliveredAt: ago(1), scoredAt: ago(1) }], latestScoredByClient: new Map([["cl_acme", ago(1)]]) },
        healthDrops: [{ clientId: "cl_beta", from: "thriving", to: "steady", droppedAt: ago(2), overridden: false }]
      })
    );
    expect(out.map((c) => c.kind).sort()).toEqual(
      ["client_escalation", "client_health_drop", "client_satisfaction_drop", "important_email", "overdue_commitment"].sort()
    );
    for (const c of out) {
      expect(EMAIL_ATTENTION_KINDS).toContain(c.kind);
      expect(c.source).toBe("email");
      expect([...c.refs, ...c.facts.flatMap((f) => f.refs)].every((r) => r.class !== "public")).toBe(true);
      expect(c.facts.length).toBeGreaterThan(0);
    }
  });

  it("refuses an invalid now", () => {
    expect(() => buildEmailCandidates(input({ now: new Date(Number.NaN) }))).toThrow(TypeError);
  });
});
