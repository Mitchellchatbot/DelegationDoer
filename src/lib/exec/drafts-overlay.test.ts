import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import type { BucketRow, ProducerThreadRow } from "@/lib/exec/email-store";
import { bucketOf } from "@/lib/exec/email-store";
import type { ReplyArtifacts } from "@/lib/exec/email-types";
import { buildEmailCandidates, type EmailCandidateInput } from "@/lib/exec/producers/email";
import { restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";

// X9 (P4 contract §3.14; §5.9 PX03): no code change in P3's producers, only
// the overlay: a thread whose newest inbound has an exec draft in
// sending / sent_pending / sent / sent_external (execSentParents, X2(a))
// reads reply_sent_pending, so it leaves the Reply bucket (bucketOf) and the
// email producer makes no reply item for it; a newer inbound brings it back.

const DAY = 86_400_000;
const NOW = new Date("2026-11-06T17:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const H = restrictedPolicyHash("hidden", []);
const HASHES = screenHashesFor({ all: [{ from: "Jane <jane@acme.com>", to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes;
const THREAD = "4f1c2d3e-aaaa-bbbb-cccc-000000000001";
const INBOUND = "9a8b7c6d-0000-0000-0000-000000000001";

function row(over: Partial<ProducerThreadRow> = {}): ProducerThreadRow {
  return {
    threadId: THREAD, accountId: "acct-1", state: "triaged", version: 3,
    screenHashes: HASHES, screenTruncated: false, screenedPolicyHash: H,
    subject: "Q3 renewal", counterpartName: "Jane", counterpartEmail: "jane@acme.com",
    newestMessageId: INBOUND, newestInboundMessageId: INBOUND, newestOutboundMessageId: null,
    lastInboundAt: ago(1), lastOutboundAt: null, newestIsOutbound: false,
    answeredState: "awaiting_reply", answeredAt: null, outboundAutomatedOnly: false,
    clientId: null, clientName: null, clientMatchVia: null, matchConfidence: null, clientCandidates: 0,
    summary: "Asks for the quote.", reason: "A direct question.", category: "client", urgency: "normal", importance: "normal",
    needsReply: true, mitchellPersonally: true, awaitingReplyFromOthers: false, decisionQuestion: null, decisionMessageId: null,
    clientSignal: "none", automated: false, injectionSuspected: false, triagedAt: ago(1),
    ...over
  };
}

/** The same thread as the Email tab's bucket read sees it (BUCKET_ROW_KEYS). */
function bucketRow(over: Partial<ProducerThreadRow> = {}): BucketRow {
  return {
    ...row(over),
    messageCount: 2, partialThread: false, filterReason: null, triageError: null,
    lastAttemptError: null, deferredAt: null, updatedAt: ago(1)
  };
}

function input(artifacts: Map<string, ReplyArtifacts>): EmailCandidateInput {
  return {
    timezone: "America/New_York", threads: [row()], commitments: [], screenRows: new Map(), signals: new Map(), artifacts,
    satisfaction: { rows: [], latestScoredByClient: new Map() }, healthDrops: [], clients: [], rules: [], currentPolicyHash: H, now: NOW
  };
}

const sent = (parents: string[]): ReplyArtifacts => ({ scheduledFor: null, draftPending: false, execDraft: null, execSentParents: parents });
// The producer's reply item is important_email / my_action ("Needs your reply"; mitchellPersonally qualifies it).
const replyItems = (artifacts: Map<string, ReplyArtifacts>) =>
  buildEmailCandidates(input(artifacts)).filter((c) => c.kind === "important_email" && c.category === "my_action");

describe("PX03 reply_sent_pending", () => {
  it("leaves the Reply bucket while an exec send on the newest inbound is pending or done", () => {
    expect(bucketOf(bucketRow(), new Map(), undefined, NOW)).toContain("reply");
    expect(bucketOf(bucketRow(), new Map(), sent([INBOUND]), NOW)).not.toContain("reply");
  });
  it("produces no reply attention item; without the exec send it does", () => {
    expect(replyItems(new Map())).toHaveLength(1);
    expect(replyItems(new Map([[THREAD, sent([INBOUND])]]))).toHaveLength(0);
  });
  it("a newer inbound (not the draft's parent) brings the thread back", () => {
    expect(bucketOf(bucketRow(), new Map(), sent(["9a8b7c6d-0000-0000-0000-000000000000"]), NOW)).toContain("reply");
    expect(replyItems(new Map([[THREAD, sent(["9a8b7c6d-0000-0000-0000-000000000000"])]]))).toHaveLength(1);
  });
  it("a ready or saved draft (execDraft only) doesn't change the overlay (L15)", () => {
    const ready: ReplyArtifacts = { scheduledFor: null, draftPending: false, execDraft: { id: `ed_${"0".repeat(31)}1`, status: "saved" }, execSentParents: [] };
    expect(bucketOf(bucketRow(), new Map(), ready, NOW)).toContain("reply");
    expect(replyItems(new Map([[THREAD, ready]]))).toHaveLength(1);
  });
});
