import { createHash } from "node:crypto";

import type { AttentionCandidate, AttentionCategory, AttentionFact, FactBasis } from "@/lib/exec/attention-types";
import { formatInZone } from "@/lib/exec/format";
import { scorePriority, type AttentionKind } from "@/lib/exec/priority";
import { slackMessageRef } from "@/lib/exec/refs";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import { SLACK_READ_LIMITS, slackMsgFingerprint, tsToMs } from "@/lib/exec/slack-read-types";
import type { ChannelRow, SlackAttentionKind, SlackItemRow } from "@/lib/exec/slack-read-types";
import type { SourceRef } from "@/lib/exec/types";

// P7a Slack Needs Attention producer (P7a contract §3.13, C19; Area D; pure).
//
//   slack_decision    a decision asked of him (assessed, addressed to him)
//   slack_request     a request, question or action item addressed to him that needs a response
//   slack_commitment  a commitment whose due date passed, at most 30 days ago (his own: until answered;
//                     owed to him: until 30 days overdue)
//   slack_unassessed  a DM or mention the budget (or a failed assessment) left unassessed (C18)
//
// One candidate per message (fingerprint slack:msg:<channel>:<ts>), by precedence decision > request|question|
// action_item > commitment > unassessed; fyi never. Open while the message is answered by nothing (responded_at
// null) and at most 14 days old. A message in a conversation that is no longer readable (deny, unclassified, a
// hub, or no channel row) produces nothing (N1); the S3 screen withholds the rest per surface.
//
// What an item may carry: the author's label (≤ 80), the conversation's name ("#<name>"), the AI summary as an
// AI fact (never for a finance item), dates and counts. Never the excerpt (§0.3 rule 6): no title, fact or ref
// carries it, and the one SourceRef has no excerpt field. Finance items (class finance, or a channel with a
// finance name, C10/C45) get the neutral title and no AI fact.

export interface SlackAttentionInput { items: readonly SlackItemRow[]; channels: ReadonlyMap<string, ChannelRow>; now: Date; tz: string }

const DAY_MS = 86_400_000;
const COPY = SLACK_READ_COPY.attention;
const UNREADABLE: ReadonlySet<string> = new Set(["deny", "unclassified", "hub"]);
const REQUEST_KINDS: ReadonlySet<string> = new Set(["request", "question", "action_item"]);
const TITLE_MAX = 200;
const TEXT_MAX = 600;

type Pick1 = { kind: SlackAttentionKind; item: SlackItemRow };

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-z]+)\}/g, (all, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : all));
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function placeOf(ch: ChannelRow): string {
  if (ch.convType === "im") return COPY.placeDm;
  if (ch.convType === "mpim") return COPY.placeGroupDm;
  if (typeof ch.name === "string" && ch.name !== "") return fill(COPY.placeChannel, { name: ch.name });
  return COPY.placeUnknown;
}

function authorOf(item: SlackItemRow): string {
  if (item.authorExternal) return COPY.authorExternal;
  return typeof item.authorLabel === "string" && item.authorLabel.trim() !== "" ? item.authorLabel : COPY.authorUnknown;
}

function isFinance(item: SlackItemRow, ch: ChannelRow): boolean {
  return item.sourceClass === "finance" || ch.class === "finance" || ch.financeName === true;
}

/** The message's most important open item and its kind, or null (C19's precedence; fyi never). */
function pickItem(group: readonly SlackItemRow[], nowMs: number): Pick1 | null {
  const sentMs = tsToMs(group[0].ts);
  const fresh = nowMs - sentMs <= SLACK_READ_LIMITS.attentionWindowDays * DAY_MS;
  const open = (i: SlackItemRow) => i.respondedAt === null && fresh;
  const decision = group.find((i) => i.kind === "decision" && i.assessed && i.addressedToYou && open(i));
  if (decision) return { kind: "slack_decision", item: decision };
  const request = group.find((i) => REQUEST_KINDS.has(i.kind) && i.assessed && i.addressedToYou && i.needsResponse && open(i));
  if (request) return { kind: "slack_request", item: request };
  const commitment = group.find((i) => {
    if (i.kind !== "commitment" || i.dueAt === null || i.commitmentDirection === null) return false;
    const dueMs = Date.parse(i.dueAt);
    if (!Number.isFinite(dueMs) || dueMs > nowMs || nowMs - dueMs > SLACK_READ_LIMITS.commitmentOverdueMaxDays * DAY_MS) return false;
    return i.commitmentDirection === "owed_to_mitchell" || i.respondedAt === null;
  });
  if (commitment) return { kind: "slack_commitment", item: commitment };
  const unassessed = group.find((i) => i.kind === "request" && !i.assessed && open(i));
  if (unassessed) return { kind: "slack_unassessed", item: unassessed };
  return null;
}

function categoryOf(p: Pick1): AttentionCategory {
  if (p.kind === "slack_decision") return "approval";
  if (p.kind === "slack_commitment") return p.item.commitmentDirection === "owed_to_mitchell" ? "delegated" : "my_action";
  return "my_action";
}

function titleOf(p: Pick1, ch: ChannelRow, finance: boolean): string {
  if (finance) return COPY.titleFinance;
  const values = { author: authorOf(p.item), place: placeOf(ch) };
  if (p.kind === "slack_decision") return fill(COPY.titleDecision, values);
  if (p.kind === "slack_commitment") {
    return fill(p.item.commitmentDirection === "mitchell_owes" ? COPY.titleCommitmentYours : COPY.titleCommitmentTheirs, values);
  }
  let title: string;
  if (ch.convType === "im") title = fill(COPY.titleDm, values);
  else if (ch.convType === "mpim") title = fill(COPY.titleGroupDm, values);
  else if (p.item.threadTs !== null) title = fill(COPY.titleThread, values);
  else title = fill(COPY.titleMention, values);
  return p.kind === "slack_unassessed" ? `${title}${COPY.suffixNotAssessed}` : title;
}

function stateHash(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function fact(text: string, basis: FactBasis, refs: SourceRef[] = []): AttentionFact {
  return { text: clip(text, 300), basis, refs };
}

function candidateFor(p: Pick1, ch: ChannelRow, now: Date, tz: string): AttentionCandidate {
  const item = p.item;
  const nowMs = now.getTime();
  const sentMs = tsToMs(item.ts);
  const sentIso = new Date(sentMs).toISOString();
  const finance = isFinance(item, ch);
  const place = placeOf(ch);
  const base = slackMessageRef({ channelId: item.channelId, ts: item.ts, permalink: item.permalink, label: place, isPrivate: item.sourceClass !== "public" });
  const ref: SourceRef = finance ? { ...base, class: "finance" } : base;
  const ageDays = Math.max(0, Math.floor((nowMs - sentMs) / DAY_MS));
  const overdueDays = item.dueAt !== null ? Math.max(0, Math.floor((nowMs - Date.parse(item.dueAt)) / DAY_MS)) : 0;
  const isCommitment = p.kind === "slack_commitment";
  const summary = typeof item.summary === "string" && item.summary.trim() !== "" ? item.summary : null;

  const facts: AttentionFact[] = [
    fact(fill(COPY.factSent, { time: formatInZone(sentIso, tz, "datetime", now), place }), "record", [ref]),
    fact(isCommitment ? fill(COPY.factOverdue, { n: overdueDays }) : fill(COPY.factUnanswered, { n: ageDays }), "derived")
  ];
  if (item.assessed && !finance && summary !== null) facts.push(fact(summary, "ai"));
  if (item.acknowledgedAt !== null) facts.push(fact(COPY.factReacted, "record", [ref]));

  const title = titleOf(p, ch, finance);
  let whatHappened: string;
  if (finance) whatHappened = COPY.financeWhat;
  else if (!item.assessed) whatHappened = COPY.notAssessed;
  else whatHappened = summary !== null ? `AI summary: ${summary}` : title;
  const whyItMatters = p.kind === "slack_decision" ? COPY.whyDecision : isCommitment ? COPY.whyCommitment : COPY.whyRequest;

  return {
    fingerprint: slackMsgFingerprint(item.channelId, item.ts),
    source: "slack",
    kind: p.kind,
    category: categoryOf(p),
    title: clip(title, TITLE_MAX),
    whatHappened: clip(whatHappened, TEXT_MAX),
    whyItMatters,
    recommendedNext: p.kind === "slack_decision" ? COPY.decideInSlack : COPY.replyInSlack,
    facts,
    refs: [ref],
    priority: scorePriority({
      kind: p.kind as AttentionKind,
      ageDays: isCommitment ? overdueDays : ageDays,
      ...(item.assessed ? { urgency: item.urgency } : {}),
      aboutPrincipal: true
    }),
    stateHash: stateHash({
      kind: p.kind,
      assessed: item.assessed,
      urgency: item.urgency,
      dueBucket: item.dueAt !== null ? item.dueAt.slice(0, 10) : null,
      acknowledged: item.acknowledgedAt !== null
    }),
    occurredAt: sentIso
  };
}

/** One candidate per (channel, ts) that has an open item, by precedence decision > request|question|action_item > commitment > unassessed. */
export function buildSlackCandidates(input: SlackAttentionInput): AttentionCandidate[] {
  const now = input.now;
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs)) return [];
  const groups = new Map<string, SlackItemRow[]>();
  for (const item of Array.isArray(input.items) ? input.items : []) {
    if (!item || typeof item.channelId !== "string" || typeof item.ts !== "string") continue;
    const fp = slackMsgFingerprint(item.channelId, item.ts);
    const list = groups.get(fp);
    if (list) list.push(item);
    else groups.set(fp, [item]);
  }
  const out: AttentionCandidate[] = [];
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const ch = input.channels.get(group[0].channelId);
    if (!ch || UNREADABLE.has(ch.class)) continue;
    let p: Pick1 | null;
    try {
      p = pickItem(group, nowMs);
    } catch {
      // A malformed ts: no item (tsToMs throws on one; the store never returns one).
      continue;
    }
    if (p) out.push(candidateFor(p, ch, now, input.tz));
  }
  return out;
}
