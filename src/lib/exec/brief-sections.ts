import { createHash } from "node:crypto";

import type {
  AttentionCategory,
  AttentionFeedItem,
  EmailScreenState,
  FactBasis,
  PriorityBand,
  SlackScreenState
} from "@/lib/exec/attention-types";
import { BRIEF_LIMITS, BRIEF_SECTION_KEYS, slackDigestBriefKey, slackMessageBriefKey } from "@/lib/exec/brief-types";
import type {
  BriefContent,
  BriefGather,
  BriefInputItem,
  BriefItem,
  BriefModeReason,
  BriefPendingLine,
  BriefSectionContent,
  BriefSectionGather,
  BriefSectionKey,
  BriefStateNote,
  BriefTopItem,
  BriefTrigger,
  NoveltyVerdict,
  SectionState
} from "@/lib/exec/brief-types";
import { formatInZone, pluralize } from "@/lib/exec/format";
import type { ExecOverview } from "@/lib/exec/overview";
import { appOrigin, clipExcerpt, isAllowedLinkUrl } from "@/lib/exec/refs";
import type { BriefSlackDigest } from "@/lib/exec/slack-digests";
import type { SlackCatchUpCounts, SlackIntelState } from "@/lib/exec/slack-intel-types";
import type { ApprovalItemList, ApprovalMechanism, DdTask } from "@/lib/exec/sources/dd-types";
import type { SourceRef } from "@/lib/exec/types";

// P8 brief sections (contract §3.8, M4, M8; Area C; pure, B-P8-5): the kind → section map, the gathered input items, the
// deterministic content and the deterministic top 3. Type-only imports from server modules (erased); P3's email
// fingerprint parser is injected by brief-gather.ts.
//
// The gather is screened before it reaches this module (P5a's surface-"slack" feed, P5a's screened approval items, the
// Overview's screened email sections, P7b's policy-filtered digests): nothing here reads, screens or logs. What an item
// may carry is bounded here: titles ≤ 200, facts ≤ 3 × 240, next ≤ 200, refs ≤ 5 rebuilt from their known fields only (an
// excerpt a source ref may carry is never copied, N7), links only when isAllowedLinkUrl passes.
//
// Section states (§3.7, GA05). Each section collects the health notes of its sources; a "hard" note is a source the
// section can't say "nothing" without (email for emails and client_requests, Slack for slack, the feed for every
// feed-backed section, the Overview part a section is built from), a "soft" one only qualifies it (email for decisions and
// commitments, ddtext off for blockers, one approval list, deadlines and completions for work). With items the state is
// "ok" and the first note is kept as stateNote; with none, the first hard note decides the state (never "nothing", M4).

/** Kind → section. P5a's ddtext kinds are bound at stage -1 (AM-P8-11); P7a's four Slack kinds are here (A4). */
export const KIND_SECTION: Readonly<Record<string, BriefSectionKey>> = Object.freeze({
  important_email: "emails",
  client_escalation: "client_requests", client_satisfaction_drop: "client_requests", client_health_drop: "client_requests",
  decision_ask: "decisions", unanswered_mention: "decisions", slack_decision: "decisions",
  slack_request: "slack", slack_unassessed: "slack",
  overdue_commitment: "commitments", slack_commitment: "commitments",
  pending_approval: "approvals",
  overdue_tasks: "work", stalled_tasks: "work", missed_deadlines: "work", waiting_on_client: "work",
  open_incident: "blockers", site_alert: "blockers", recurring_issue: "blockers",
  // P5a's DD text kinds (ddtext-types.ts DDTEXT_ATTENTION_KINDS), AM-P8-11: the AI-assessed blockers and waits are
  // operational blockers; a decision asked of him and a mention of him in DD text are decisions.
  ddtext_blocker: "blockers", ddtext_waiting: "blockers", ddtext_decision: "decisions", ddtext_mention: "decisions"
});

/** Fallback for an unmapped kind; fyi and on_track never enter the brief. */
export const CATEGORY_SECTION: Readonly<Record<AttentionCategory, BriefSectionKey | null>> = Object.freeze({
  my_action: "decisions", approval: "approvals", delegated: "work", intervene: "blockers", fyi: null, on_track: null
});

/** M8 "pending decision" (AM-P8-11 adds P5a's ddtext_decision beside P3's and P7a's decision kinds). */
export const PENDING_KINDS: ReadonlySet<string> = new Set(["decision_ask", "slack_decision", "pending_approval", "ddtext_decision"]);

/** The section an attention item belongs to: never for fyi / on_track (whatever the kind: the brief is about what needs him),
 *  else KIND_SECTION, else CATEGORY_SECTION (an unmapped kind, A4). */
export function sectionOf(item: { kind: string; category: AttentionCategory }): BriefSectionKey | null {
  if (!item || typeof item.kind !== "string") return null;
  const category = CATEGORY_SECTION[item.category];
  if (category === undefined || category === null) return null;
  return Object.prototype.hasOwnProperty.call(KIND_SECTION, item.kind) ? KIND_SECTION[item.kind] : category;
}

/** P3's parser (attention.ts parseEmailFingerprint), injected by brief-gather.ts so this module stays free of server-only imports (B-P8-5). */
export type EmailFpParser = (fp: string) => { threadId: string } | null;

// ---------------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------------

type Draft = Omit<BriefInputItem, "alias">;

/** The order of brief-novelty.ts's BAND_RANK (normal 0, high 1, critical 2), kept here so the pure modules import one way
 *  (brief-novelty and brief-validate import from this module, never the reverse); brief-sections.test.ts asserts the two agree. */
export const bandRank = (b: PriorityBand): number => (b === "critical" ? 2 : b === "high" ? 1 : 0);
const BASIS_RANK: Readonly<Record<FactBasis, number>> = Object.freeze({ record: 0, derived: 1, ai: 2 });

/** The brief's priority order: band rank desc, score desc, fingerprint asc (aliases, caps, the deterministic lines). */
export function compareInputItems(a: Pick<Draft, "band" | "score" | "fingerprint">, b: Pick<Draft, "band" | "score" | "fingerprint">): number {
  const byBand = bandRank(b.band) - bandRank(a.band);
  if (byBand !== 0) return byBand;
  const byScore = (Number.isFinite(b.score) ? b.score : 0) - (Number.isFinite(a.score) ? a.score : 0);
  if (byScore !== 0) return byScore;
  return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
}

const clip = (s: unknown, max: number): string => (typeof s === "string" ? clipExcerpt(s, max) : "");
const hashOf = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
const uniq = (list: readonly string[]): string[] => [...new Set(list.filter((x) => typeof x === "string" && x.length > 0))];
const isBand = (v: unknown): v is PriorityBand => v === "critical" || v === "high" || v === "normal";

/** A DD link (appOrigin() + path) when it passes the allow-list, else null. */
function ddUrl(path: string): string | null {
  const url = `${appOrigin()}${path}`;
  return isAllowedLinkUrl(url) ? url : null;
}

/** A source ref rebuilt from its known fields only: never an excerpt (N7, GA12); the url only when allow-listed. */
function cleanRef(ref: SourceRef): SourceRef | null {
  if (!ref || typeof ref !== "object" || typeof ref.system !== "string" || typeof ref.id !== "string" || ref.id.length === 0) return null;
  const url = typeof ref.url === "string" && isAllowedLinkUrl(ref.url) ? ref.url : null;
  return { system: ref.system, id: ref.id, url, label: clip(ref.label, 200) || "Source", class: ref.class };
}
function cleanRefs(refs: readonly SourceRef[], max = BRIEF_LIMITS.itemRefsMax): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(refs) ? refs : []) {
    const c = cleanRef(r);
    if (c === null) continue;
    const key = `${c.system}:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}
const taskRef = (id: string, label: string): SourceRef =>
  ({ system: "dd", id, url: ddUrl(`/tasks/${encodeURIComponent(id)}`), label: clip(label, 200) || `Task ${id}`, class: "internal" });
const projectRef = (id: string, label: string): SourceRef =>
  ({ system: "dd", id, url: ddUrl(`/projects/${encodeURIComponent(id)}`), label: clip(label, 200) || `Project ${id}`, class: "internal" });
const pageRef = (path: string, label: string): SourceRef => ({ system: "dd", id: path, url: ddUrl(path), label, class: "internal" });
const threadRef = (threadId: string): SourceRef => {
  const path = `/executive/email/${encodeURIComponent(threadId)}`;
  return { system: "dd", id: path, url: ddUrl(path), label: "Email thread", class: "private" };
};

const EMAIL_PAGE = /^\/executive\/email\/([^/?#]+)$/;
const SLACK_MSG_FP = /^slack:msg:([A-Za-z0-9]+):([0-9]+\.[0-9]+)$/;
const SLACK_MSG_REF = /^([A-Za-z0-9]+):([0-9]+\.[0-9]+)$/;
const SLACK_DIGEST_REF = /^([A-Za-z0-9]+):d:([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

/** Thread ids: parse(fp)?.threadId, refs with system "outlook" (id), refs with system "dd" and id /executive/email/<id>. */
export function threadIdsOf(fp: string, refs: readonly SourceRef[], parse: EmailFpParser): string[] {
  const out: string[] = [];
  let parsed: { threadId: string } | null = null;
  try {
    parsed = typeof fp === "string" ? parse(fp) : null;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed.threadId === "string" && parsed.threadId.length > 0) out.push(parsed.threadId);
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r || typeof r.id !== "string" || r.id.length === 0) continue;
    if (r.system === "outlook") out.push(r.id);
    else if (r.system === "dd") {
      const m = EMAIL_PAGE.exec(r.id);
      if (!m) continue;
      try {
        out.push(decodeURIComponent(m[1]));
      } catch {
        out.push(m[1]);
      }
    }
  }
  return uniq(out);
}

/** Slack: fp slack:msg:<ch>:<ts> → m:<ch>:<ts>; refs system "slack" id "<ch>:<ts>" → m:…, id "<ch>:d:<date>" → d:<ch>:<date>. */
export function slackKeysOf(fp: string, refs: readonly SourceRef[]): { keys: string[]; channels: string[] } {
  const keys: string[] = [];
  const channels: string[] = [];
  const m = typeof fp === "string" ? SLACK_MSG_FP.exec(fp) : null;
  if (m) {
    keys.push(slackMessageBriefKey(m[1], m[2]));
    channels.push(m[1]);
  }
  for (const r of Array.isArray(refs) ? refs : []) {
    if (!r || r.system !== "slack" || typeof r.id !== "string") continue;
    const d = SLACK_DIGEST_REF.exec(r.id);
    if (d) {
      keys.push(slackDigestBriefKey(d[1], d[2]));
      channels.push(d[1]);
      continue;
    }
    const msg = SLACK_MSG_REF.exec(r.id);
    if (msg) {
      keys.push(slackMessageBriefKey(msg[1], msg[2]));
      channels.push(msg[1]);
    }
  }
  return { keys: uniq(keys), channels: uniq(channels) };
}

/** The strongest basis among the facts (ai > derived > record); "record" when there is none. */
function strongestBasis(facts: readonly { basis: FactBasis }[]): FactBasis {
  let best: FactBasis = "record";
  for (const f of facts) if (f && BASIS_RANK[f.basis] !== undefined && BASIS_RANK[f.basis] > BASIS_RANK[best]) best = f.basis;
  return best;
}

/** One screened feed item → an input item (no alias yet). Untrusted: email and Slack items and P5a's DD-text items (AI read
 *  of other people's free text), which the compose step wraps (§3.10.1). */
export function inputItemFromAttention(item: AttentionFeedItem, section: BriefSectionKey, parse: EmailFpParser): Omit<BriefInputItem, "alias"> {
  const facts = Array.isArray(item.facts) ? item.facts : [];
  const sourceRefs = [...(Array.isArray(item.refs) ? item.refs : []), ...facts.flatMap((f) => (Array.isArray(f?.refs) ? f.refs : []))];
  const slack = slackKeysOf(item.fingerprint, sourceRefs);
  const band = isBand(item.priority?.band) ? item.priority.band : "normal";
  const score = typeof item.priority?.score === "number" && Number.isFinite(item.priority.score) ? item.priority.score : 0;
  return {
    fingerprint: item.fingerprint,
    stateHash: typeof item.stateHash === "string" && item.stateHash.length > 0 ? item.stateHash : hashOf([item.fingerprint]),
    section,
    source: item.source,
    kind: item.kind,
    category: item.category,
    band,
    score,
    basis: strongestBasis(facts),
    title: clip(item.title, BRIEF_LIMITS.modelTitleChars) || "(untitled)",
    facts: facts.map((f) => clip(f?.text, BRIEF_LIMITS.modelFactChars)).filter((t) => t.length > 0).slice(0, BRIEF_LIMITS.modelFactsPerItem),
    next: typeof item.recommendedNext === "string" && item.recommendedNext.trim() !== "" ? clip(item.recommendedNext, BRIEF_LIMITS.modelTitleChars) : null,
    refs: cleanRefs(item.refs),
    threadIds: threadIdsOf(item.fingerprint, sourceRefs, parse),
    slackKeys: slack.keys,
    slackChannels: slack.channels,
    untrusted: item.source !== "dd" || item.kind.startsWith("ddtext_"),
    occurredAt: typeof item.occurredAt === "string" ? item.occurredAt : null
  };
}

export interface AssembleInput {
  localDate: string; tz: string; now: Date;
  /** The surface-"slack" screened feed (both pages). p8 Area C (additive, optional): the page's screen states, so an email or
   *  Slack screen that couldn't run reads as "Couldn't load", never as "nothing" (every such item was withheld). */
  attention: { items: AttentionFeedItem[]; hiddenEmail: number; emailScreen?: EmailScreenState; slackScreen?: SlackScreenState } | null;
  overview: ExecOverview | null;
  /** P8 fixer security-5: intakeThreadIds (draft_tasks / fb_proofs) = the shown tasks' linked threads that have a row in his store. */
  approvals: Partial<Record<ApprovalMechanism, (ApprovalItemList & { hiddenRestricted: number; intakeThreadIds?: readonly string[] }) | null>>;
  completed: DdTask[] | null;
  /** AM-P8-12: catchUp is always null from the gather (P7b's slackCatchUpCounts reads the web surface, so its counts include
   *  finance-class items); the Slack section's stats and slackUnanswered come from the surface-"slack" attention items. */
  slack: { state: SlackIntelState | "unavailable"; digests: BriefSlackDigest[] | null; catchUp: SlackCatchUpCounts | null };
  ddtextOn: boolean;
  parseEmailFingerprint: EmailFpParser;
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic items (§3.8 table): never an attention row
// ---------------------------------------------------------------------------------------------------------------------

/** The itemized approval mechanisms (P5a C19; check-ins stay count-only). */
export const ITEMIZED_MECHANISMS: readonly ApprovalMechanism[] = Object.freeze(["draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews"] as ApprovalMechanism[]);
/** P8 fixer security-5: the mechanisms whose item titles come from intake (client mail): P5a's S5 screens them (intake-screen.ts). */
export const INTAKE_APPROVALS: ReadonlySet<ApprovalMechanism> = new Set<ApprovalMechanism>(["draft_tasks", "fb_proofs"]);
/** The fingerprint of an intake mechanism's approvals line (the render-time screen re-screens its task ids, brief-screen.ts). */
export const intakeApprovalFp = (m: ApprovalMechanism): string => `brief:approval-items:${m}`;
const MECHANISM_LABEL: Readonly<Record<ApprovalMechanism, string>> = Object.freeze({
  draft_tasks: "AI-drafted tasks", fb_proofs: "Facebook proofs", email_drafts: "Client email drafts",
  unrouted_mail: "Intake emails needing routing", eod_reviews: "EOD reports to review", checkins: "Check-ins not sent"
});
const MECHANISM_PAGE: Readonly<Record<ApprovalMechanism, string | null>> = Object.freeze({
  draft_tasks: "/approvals?tab=routing", fb_proofs: "/tasks/board?status=pending_approval&groupBy=status", email_drafts: "/approvals?tab=emails",
  unrouted_mail: "/approvals?tab=routing", eod_reviews: "/eod/history", checkins: null
});
const SYNTH_SCORE = Object.freeze({ progress: 1, completed: 2, deadline: 12, projectAtRisk: 25, projectOffTrack: 40, approvals: 20,
  commitment: 20, commitmentOverdue: 50, digest: 15 });

function synthetic(fields: Omit<Draft, "facts" | "refs" | "threadIds" | "slackKeys" | "slackChannels" | "next" | "occurredAt"> &
  Partial<Pick<Draft, "facts" | "refs" | "threadIds" | "slackKeys" | "slackChannels" | "next" | "occurredAt">>): Draft {
  return {
    ...fields,
    title: clip(fields.title, BRIEF_LIMITS.modelTitleChars) || "(untitled)",
    facts: (fields.facts ?? []).map((f) => clip(f, BRIEF_LIMITS.modelFactChars)).filter((f) => f.length > 0).slice(0, BRIEF_LIMITS.modelFactsPerItem),
    next: fields.next ?? null,
    refs: cleanRefs(fields.refs ?? []),
    threadIds: uniq(fields.threadIds ?? []),
    slackKeys: uniq(fields.slackKeys ?? []),
    slackChannels: uniq(fields.slackChannels ?? []),
    occurredAt: fields.occurredAt ?? null
  };
}

/** progress: "<n> tasks completed so far today and <m> created. <p> people active, <e> EODs submitted, <h> hours logged."
 *  Each part only when its tile loaded (P2b's TodayGlance sentences); null when none did. */
function progressItem(ov: ExecOverview, localDate: string): Draft | null {
  const tiles = ov.sections?.tiles;
  if (!tiles?.ok) return null;
  const t = tiles.data;
  const n = t.completedToday?.ok ? t.completedToday.data.count : null;
  const m = t.createdToday?.ok ? t.createdToday.data.count : null;
  const p = t.activePeople?.ok ? t.activePeople.data.count : null;
  const e = t.eodSubmitted?.ok ? t.eodSubmitted.data.count : null;
  const h = t.hoursLogged?.ok ? t.hoursLogged.data.hours : null;
  const sentences: string[] = [];
  if (n !== null && m !== null) sentences.push(`${pluralize(n, "task")} completed so far today and ${m} created.`);
  else if (n !== null) sentences.push(`${pluralize(n, "task")} completed so far today.`);
  else if (m !== null) sentences.push(`${pluralize(m, "task")} created so far today.`);
  const rest: string[] = [];
  if (p !== null) rest.push(`${pluralize(p, "person", "people")} active`);
  if (e !== null) rest.push(`${pluralize(e, "EOD")} submitted`);
  if (h !== null) rest.push(`${pluralize(h, "hour")} logged`);
  if (rest.length > 0) sentences.push(`${rest.join(", ")}.`);
  if (sentences.length === 0) return null;
  return synthetic({
    fingerprint: `brief:progress:${localDate}`, stateHash: hashOf({ completed: n, created: m, active: p, eods: e, hours: h }), section: "progress",
    source: "dd", kind: "brief_progress", category: "fyi", band: "normal", score: SYNTH_SCORE.progress, basis: "record",
    title: sentences.join(" "), untrusted: false
  });
}

/** work: "<n> tasks completed yesterday", up to completedShown titles packed into ≤ 3 facts of ≤ 240 characters. */
function completedItem(tasks: readonly DdTask[], localDate: string): Draft | null {
  const done = tasks.filter((t) => t && t.deletedAt === null && t.isDraft !== true);
  if (done.length === 0) return null;
  const shown = [...done].sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? "") || a.id.localeCompare(b.id))
    .slice(-BRIEF_LIMITS.completedShown).reverse();
  const labels = shown.map((t) => clip(t.clientName ? `${t.title} (${t.clientName})` : t.title, 110)).filter((l) => l.length > 0);
  const facts: string[] = [];
  let current = "";
  for (const l of labels) {
    if (current === "") current = l;
    else if (current.length + 2 + l.length <= BRIEF_LIMITS.modelFactChars) current = `${current}; ${l}`;
    else {
      facts.push(current);
      current = l;
      if (facts.length === BRIEF_LIMITS.modelFactsPerItem) break;
    }
  }
  if (current !== "" && facts.length < BRIEF_LIMITS.modelFactsPerItem) facts.push(current);
  return synthetic({
    fingerprint: `brief:completed:${localDate}`, stateHash: hashOf(done.map((t) => t.id).sort()), section: "work", source: "dd",
    kind: "brief_completed", category: "fyi", band: "normal", score: SYNTH_SCORE.completed, basis: "record",
    title: `${pluralize(done.length, "task")} completed yesterday`, facts, refs: shown.map((t) => taskRef(t.id, t.title)), untrusted: false
  });
}

/** True when a feed item already cites this DD task (the deadline needn't be listed twice). */
function citesTask(item: AttentionFeedItem, taskId: string): boolean {
  const refs = [...(item.refs ?? []), ...(item.facts ?? []).flatMap((f) => f?.refs ?? [])];
  return refs.some((r) => r?.system === "dd" && (r.id === taskId || r.id === `/tasks/${taskId}` || r.id === `/tasks/${encodeURIComponent(taskId)}`));
}

function deadlineItems(ov: ExecOverview, feed: readonly AttentionFeedItem[], tz: string, now: Date): Draft[] {
  const sec = ov.sections?.deadlines;
  if (!sec?.ok) return [];
  const out: Draft[] = [];
  for (const d of sec.data.items) {
    if (out.length >= BRIEF_LIMITS.deadlinesShown) break;
    if (!d || typeof d.taskId !== "string" || feed.some((i) => citesTask(i, d.taskId))) continue;
    const due = typeof d.dueDate === "string" ? formatInZone(d.dueDate, tz, "date", now) : null;
    const facts: string[] = [];
    if (d.clientName) facts.push(`Client: ${d.clientName}`);
    if (d.owner?.kind === "person" || d.owner?.kind === "team") facts.push(`Owner: ${d.owner.name}`);
    else if (d.owner?.kind === "unassigned") facts.push("Unassigned");
    out.push(synthetic({
      fingerprint: `brief:deadline:${d.taskId}`, stateHash: hashOf({ dueDate: d.dueDate, status: d.status }), section: "work", source: "dd",
      kind: "brief_deadline", category: "delegated", band: "normal", score: SYNTH_SCORE.deadline, basis: "record",
      title: due && due !== "—" ? `${d.title}, due ${due}` : d.title, facts, refs: [taskRef(d.taskId, d.title)], untrusted: false
    }));
  }
  return out;
}

function projectItems(ov: ExecOverview): Draft[] {
  const sec = ov.sections?.projects;
  if (!sec?.ok) return [];
  return sec.data.items
    .filter((p) => p && p.status !== "on_track")
    .slice(0, BRIEF_LIMITS.projectsShown)
    .map((p) => {
      const reasons = Array.isArray(p.reasons) ? p.reasons : [];
      const off = p.status === "off_track";
      return synthetic({
        fingerprint: `brief:project:${p.projectId}`, stateHash: hashOf({ status: p.status, reasons: [...reasons].sort() }), section: "delayed",
        source: "dd", kind: "brief_project", category: "delegated", band: off ? "high" : "normal",
        score: off ? SYNTH_SCORE.projectOffTrack : SYNTH_SCORE.projectAtRisk, basis: "derived",
        title: `${p.name}: ${reasons[0] ?? (off ? "off track" : "at risk")}`, facts: reasons.slice(1, 3),
        refs: [projectRef(p.projectId, p.name)], untrusted: false
      });
    });
}

/** approvals: one item per itemized mechanism with something waiting; it takes the place of the feed's dd:approval:<m> item
 *  (its band and score, never both lines). */
function approvalItem(m: ApprovalMechanism, list: ApprovalItemList & { hiddenRestricted: number; intakeThreadIds?: readonly string[] },
  feedItem: AttentionFeedItem | undefined, tz: string, now: Date): Draft | null {
  const total = typeof list.total === "number" && list.total > 0 ? list.total : 0;
  if (total === 0) return null;
  const hidden = typeof list.hiddenRestricted === "number" && list.hiddenRestricted > 0 ? list.hiddenRestricted : 0;
  const items = list.mode === "items" && Array.isArray(list.items) ? list.items : [];
  const room = BRIEF_LIMITS.modelFactsPerItem - (hidden > 0 ? 1 : 0);
  const facts = items.slice(0, room).map((i) => {
    const since = typeof i.waitingSince === "string" ? formatInZone(i.waitingSince, tz, "date", now) : null;
    return since && since !== "—" ? `${i.title}, waiting since ${since}` : i.title;
  });
  if (hidden > 0) facts.push(`${hidden} hidden: restricted sender`);
  const page = MECHANISM_PAGE[m];
  // P8 fixer security-5: the shown tasks' refs come first (≤ 3, under the 5-ref cap), so the render-time screen can re-screen an
  // intake-drafted line by its task ids; the page and the feed's refs follow.
  const refs: SourceRef[] = [];
  for (const i of items) if (typeof i.taskId === "string" && i.taskId.length > 0) refs.push(taskRef(i.taskId, i.title));
  if (page !== null) refs.push(pageRef(page, MECHANISM_LABEL[m]));
  refs.push(...(feedItem?.refs ?? []));
  const band = feedItem && isBand(feedItem.priority?.band) ? feedItem.priority.band : "normal";
  const score = feedItem && typeof feedItem.priority?.score === "number" ? feedItem.priority.score : SYNTH_SCORE.approvals;
  return synthetic({
    fingerprint: intakeApprovalFp(m), stateHash: hashOf(items.map((i) => i.id).sort()), section: "approvals", source: "dd",
    kind: "pending_approval", category: "approval", band, score, basis: "record",
    title: `Waiting for approval: ${MECHANISM_LABEL[m]} (${total})`, facts, refs,
    // P8 fixer security-5: the shown intake tasks' threads in his store (brief-gather.ts), so a tombstone's scrub (X1) and the
    // render-time screen reach a title named from that mail.
    threadIds: INTAKE_APPROVALS.has(m) && Array.isArray(list.intakeThreadIds) ? [...list.intakeThreadIds] : [],
    // Intake-drafted tasks are named from client mail and meetings: other people's words, so wrapped like email (§3.10.1).
    untrusted: m === "draft_tasks", occurredAt: items[0]?.waitingSince ?? null
  });
}

/** commitments: the Overview's open email commitments the feed doesn't already hold, the direction kept in the text (AM-P8-28:
 *  P7a stores only commitments others made to him in Slack, so no line claims to list his own Slack promises). */
function commitmentItems(ov: ExecOverview, feedFps: ReadonlySet<string>, tz: string, now: Date): Draft[] {
  const email = ov.sections?.email;
  if (!email?.ok || email.data.state !== "on" || !email.data.commitments.ok) return [];
  const out: Draft[] = [];
  for (const c of email.data.commitments.data.items) {
    if (!c || typeof c.threadId !== "string" || typeof c.id !== "string") continue;
    const fp = `email:commitment:${c.threadId}:${c.id}`;
    if (feedFps.has(fp)) continue;
    const mine = c.direction === "mitchell_owes";
    const who = typeof c.counterparty === "string" && c.counterparty.trim() !== "" ? c.counterparty.trim() : null;
    const title = mine ? `You promised${who ? ` ${who}` : ""}: ${c.text}` : `${who ?? "Someone"} owes you: ${c.text}`;
    const due = c.dueText ?? (typeof c.dueAt === "string" ? formatInZone(c.dueAt, tz, "date", now) : null);
    const facts: string[] = [];
    if (c.overdue) facts.push(due ? `Overdue (due ${due})` : "Overdue");
    else if (due && due !== "—") facts.push(`Due ${due}`);
    out.push(synthetic({
      fingerprint: fp, stateHash: hashOf({ status: c.status, due: c.dueAt, overdue: c.overdue === true }), section: "commitments", source: "email",
      kind: c.overdue ? "overdue_commitment" : "email_commitment", category: mine ? "my_action" : "delegated",
      band: c.overdue ? "high" : "normal", score: c.overdue ? SYNTH_SCORE.commitmentOverdue : SYNTH_SCORE.commitment, basis: "record",
      title, facts, refs: [threadRef(c.threadId)], threadIds: [c.threadId], untrusted: true, occurredAt: c.messageSentAt ?? null
    }));
  }
  return out;
}

function digestItem(d: BriefSlackDigest): Draft | null {
  if (!d || typeof d.channelId !== "string" || typeof d.localDate !== "string") return null;
  const facts = [
    ...(Array.isArray(d.decisions) ? d.decisions : []).map((x) => `Decision: ${x}`),
    ...(Array.isArray(d.openQuestions) ? d.openQuestions : []).map((x) => `Open question: ${x}`)
  ];
  return synthetic({
    fingerprint: `slack:digest:${d.channelId}:${d.localDate}`, stateHash: hashOf({ digest: d.digestId }), section: "slack", source: "slack",
    kind: "slack_digest", category: "fyi", band: "normal", score: SYNTH_SCORE.digest, basis: "ai",
    title: `${clip(d.channelLabel, 60) || "Slack"}: ${clip(d.summary, BRIEF_LIMITS.modelTitleChars)}`, facts, refs: d.ref ? [d.ref] : [],
    slackKeys: [slackDigestBriefKey(d.channelId, d.localDate)], slackChannels: [d.channelId], untrusted: true
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// assembleSections
// ---------------------------------------------------------------------------------------------------------------------

interface Note { note: BriefStateNote; state: SectionState; hard: boolean }
interface Building { items: Draft[]; notes: Note[]; stats: Record<string, number> }

/** The Overview's email health as a note, or null when email is live (§3.7). */
function emailNote(input: AssembleInput): Omit<Note, "hard"> | null {
  const email = input.overview?.sections?.email;
  if (!email || !email.ok) return { note: "email_unavailable", state: "unavailable" };
  if (email.data.state === "off") return { note: "email_off", state: "not_connected" };
  if (email.data.state === "no_pin") return { note: "email_no_pin", state: "not_connected" };
  if (input.attention?.emailScreen === "unavailable") return { note: "email_unavailable", state: "unavailable" };
  return null;
}

/** P7b's state as a note, or null when Slack is live. */
function slackNote(state: SlackIntelState | "unavailable"): Omit<Note, "hard"> | null {
  switch (state) {
    case "ok": return null;
    case "not_installed": return { note: "slack_not_installed", state: "not_connected" };
    case "not_connected": return { note: "slack_not_connected", state: "not_connected" };
    case "reading_revoked": return { note: "slack_reading_revoked", state: "off" };
    case "reading_off": return { note: "slack_reading_off", state: "off" };
    case "discovering": return { note: "slack_discovering", state: "not_connected" };
    default: return { note: "slack_unavailable", state: "unavailable" };
  }
}

/** Builds every section, assigns aliases i1..iN by (band rank desc, score desc, fingerprint asc) across the gather, caps each section
 *  at BRIEF_LIMITS.modelItemsPerSection and the whole at modelItemsMax (lowest score dropped first; dropped items count in `more`,
 *  carried as the section's stats.more). */
export function assembleSections(input: AssembleInput): BriefGather {
  const { localDate, tz } = input;
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date(Number.NaN);
  const failures: string[] = [];
  const parse: EmailFpParser = typeof input.parseEmailFingerprint === "function" ? input.parseEmailFingerprint : () => null;
  const build = new Map<BriefSectionKey, Building>(BRIEF_SECTION_KEYS.map((k) => [k, { items: [], notes: [], stats: {} }]));
  const sec = (k: BriefSectionKey) => build.get(k) as Building;
  const note = (k: BriefSectionKey, n: Omit<Note, "hard"> | null, hard: boolean) => {
    if (n !== null) sec(k).notes.push({ ...n, hard });
  };
  const unavailable: Omit<Note, "hard"> = { note: "unavailable", state: "unavailable" };

  // ---- the reads that failed (ids only) ----
  const ov = input.overview;
  const attention = input.attention;
  if (attention === null) failures.push("attention");
  else {
    if (attention.emailScreen === "unavailable") failures.push("attention.email");
    if (attention.slackScreen === "unavailable") failures.push("attention.slack");
  }
  if (ov === null) failures.push("overview");
  else for (const part of ["tiles", "deadlines", "projects", "email"] as const) if (!ov.sections?.[part]?.ok) failures.push(`overview.${part}`);
  for (const m of ITEMIZED_MECHANISMS) if (input.approvals?.[m] === null) failures.push(`approvals.${m}`);
  if (input.completed === null) failures.push("completed");
  const slackState = input.slack?.state ?? "unavailable";
  if (slackState === "unavailable") failures.push("slackState");
  else if (slackState === "ok" && input.slack.digests === null) failures.push("digests");

  // ---- the feed ----
  const feed = attention?.items ?? [];
  const feedFps = new Set(feed.map((i) => i.fingerprint));
  const replacedApprovals = new Set<string>();
  const approvalFeed = new Map<string, AttentionFeedItem>();
  for (const i of feed) if (i.kind === "pending_approval") approvalFeed.set(i.fingerprint, i);
  for (const m of ITEMIZED_MECHANISMS) {
    const list = input.approvals?.[m];
    if (list === null || list === undefined) continue;
    const fp = `dd:approval:${m}`;
    replacedApprovals.add(fp);
    const item = approvalItem(m, list, approvalFeed.get(fp), tz, now);
    if (item) sec("approvals").items.push(item);
  }
  for (const item of feed) {
    if (!item || typeof item.fingerprint !== "string") continue;
    // Slack lines only while P7b's state is "ok" (the render-time screen withholds them otherwise too, C31): fail closed.
    if (item.source === "slack" && slackState !== "ok") continue;
    const section = sectionOf(item);
    if (section === null || replacedApprovals.has(item.fingerprint)) continue;
    sec(section).items.push(inputItemFromAttention(item, section, parse));
  }

  // ---- the synthetic items ----
  if (ov !== null) {
    const progress = progressItem(ov, localDate);
    if (progress) sec("progress").items.push(progress);
    sec("work").items.push(...deadlineItems(ov, feed, tz, now));
    sec("delayed").items.push(...projectItems(ov));
    sec("commitments").items.push(...commitmentItems(ov, feedFps, tz, now));
  }
  if (input.completed !== null && input.completed !== undefined) {
    const done = completedItem(input.completed, localDate);
    if (done) sec("work").items.push(done);
  }
  if (slackState === "ok" && Array.isArray(input.slack.digests)) {
    for (const d of input.slack.digests.slice(0, BRIEF_LIMITS.digestsShown)) {
      const item = digestItem(d);
      if (item) sec("slack").items.push(item);
    }
  }

  // ---- notes (hard: the section can't say "nothing" without it; soft: it only qualifies the section) ----
  const feedNote = attention === null ? unavailable : null;
  const email = emailNote(input);
  for (const k of ["emails", "client_requests"] as const) {
    note(k, feedNote, true);
    note(k, email, true);
  }
  for (const k of ["decisions", "commitments"] as const) {
    note(k, feedNote, true);
    note(k, email, false);
  }
  if (ov !== null && ov.sections?.email?.ok && ov.sections.email.data.state === "on" && !ov.sections.email.data.commitments.ok) {
    note("commitments", unavailable, false);
  }
  const slackHealth = slackNote(slackState);
  const slackItemsUnknown = attention === null || attention.slackScreen === "unavailable" || (slackState === "ok" && input.slack.digests === null);
  note("slack", slackHealth ?? (slackItemsUnknown ? { note: "slack_unavailable", state: "unavailable" } : null), true);
  note("blockers", feedNote, true);
  if (!input.ddtextOn) note("blockers", { note: "ddtext_off", state: "ok" }, false);
  note("approvals", feedNote, true);
  for (const m of ITEMIZED_MECHANISMS) if (input.approvals?.[m] === null) note("approvals", unavailable, false);
  note("work", feedNote, true);
  if (ov === null || !ov.sections?.deadlines?.ok) note("work", unavailable, false);
  if (input.completed === null) note("work", unavailable, false);
  const progressLoaded = sec("progress").items.length > 0;
  if (!progressLoaded) note("progress", unavailable, true);
  if (ov === null || !ov.sections?.projects?.ok) note("delayed", unavailable, true);

  // ---- stats ----
  const tiles = ov?.sections?.tiles?.ok ? ov.sections.tiles.data : null;
  if (tiles) {
    const s = sec("progress").stats;
    if (tiles.completedToday?.ok) s.completedToday = tiles.completedToday.data.count;
    if (tiles.createdToday?.ok) s.createdToday = tiles.createdToday.data.count;
    if (tiles.activePeople?.ok) s.activePeople = tiles.activePeople.data.count;
    if (tiles.eodSubmitted?.ok) s.eodSubmitted = tiles.eodSubmitted.data.count;
    if (tiles.hoursLogged?.ok) s.hoursLogged = tiles.hoursLogged.data.hours;
    if (tiles.openOverdue?.ok) sec("work").stats.openOverdue = tiles.openOverdue.data.count;
  }
  const ovEmail = ov?.sections?.email?.ok ? ov.sections.email.data : null;
  if (ovEmail && ovEmail.state === "on" && ovEmail.counts.ok) {
    const c = ovEmail.counts.data;
    Object.assign(sec("emails").stats, { reply: c.reply, urgent: c.urgent, important: c.important, waiting: c.waiting, decisionAsks: c.decisionAsks });
  }
  if (ovEmail && ovEmail.state === "on" && ovEmail.commitments.ok) {
    sec("commitments").stats.emailOverdue = ovEmail.commitments.data.items.filter((c) => c.overdue).length;
  }
  if (input.completed) sec("work").stats.completedYesterday = input.completed.filter((t) => t && t.deletedAt === null && t.isDraft !== true).length;
  if (ov?.sections?.projects?.ok) {
    const items = ov.sections.projects.data.items;
    Object.assign(sec("delayed").stats, { offTrack: items.filter((p) => p.status === "off_track").length, atRisk: items.filter((p) => p.status === "at_risk").length });
  }
  const approvalStats: Record<string, number> = {};
  for (const m of ITEMIZED_MECHANISMS) {
    const list = input.approvals?.[m];
    if (list) approvalStats[m] = typeof list.total === "number" ? list.total : 0;
  }
  Object.assign(sec("approvals").stats, approvalStats);
  // AM-P8-12: the Slack counts come from the surface-"slack" feed itself (finance-class items are withheld there), never from
  // P7b's web-surface catch-up counts. "commitments" here are commitments others made to him (the only kind P7a stores).
  let slackUnanswered: number | null = null;
  if (attention !== null && attention.slackScreen !== "unavailable" && slackState === "ok") {
    const ofKind = (k: string) => feed.filter((i) => i.source === "slack" && i.kind === k).length;
    const stats = { requests: ofKind("slack_request"), decisions: ofKind("slack_decision"), commitments: ofKind("slack_commitment"), notAssessed: ofKind("slack_unassessed") };
    Object.assign(sec("slack").stats, stats);
    slackUnanswered = stats.requests + stats.decisions;
  }

  // ---- restricted email (C26): the Overview's restricted count + the feed's hidden email items ----
  let restrictedEmail: number | null = null;
  if (attention !== null && ovEmail !== null) {
    // P8 fixer ui-1: when the screen couldn't run, the hidden items weren't found restricted, only unscreened (the section says
    // "Couldn't load email."): they aren't counted as restricted-sender mail.
    const hidden = attention.emailScreen !== "unavailable" && typeof attention.hiddenEmail === "number" && attention.hiddenEmail > 0 ? attention.hiddenEmail : 0;
    if (ovEmail.state !== "on") restrictedEmail = hidden;
    else if (ovEmail.restricted.ok && typeof ovEmail.restricted.data === "number") restrictedEmail = ovEmail.restricted.data + hidden;
  }

  // ---- caps and aliases ----
  const more = new Map<BriefSectionKey, number>(BRIEF_SECTION_KEYS.map((k) => [k, 0]));
  const kept: Draft[] = [];
  for (const k of BRIEF_SECTION_KEYS) {
    const seen = new Set<string>();
    const items = sec(k).items.filter((i) => (seen.has(i.fingerprint) ? false : (seen.add(i.fingerprint), true))).sort(compareInputItems);
    kept.push(...items.slice(0, BRIEF_LIMITS.modelItemsPerSection));
    more.set(k, (more.get(k) ?? 0) + Math.max(0, items.length - BRIEF_LIMITS.modelItemsPerSection));
  }
  kept.sort(compareInputItems);
  for (const dropped of kept.splice(BRIEF_LIMITS.modelItemsMax)) more.set(dropped.section, (more.get(dropped.section) ?? 0) + 1);
  const aliased: BriefInputItem[] = kept.map((d, i) => ({ alias: `i${i + 1}`, ...d }));

  const sections: BriefSectionGather[] = BRIEF_SECTION_KEYS.map((key) => {
    const b = sec(key);
    const items = aliased.filter((i) => i.section === key);
    const hard = b.notes.find((n) => n.hard) ?? null;
    const first = hard ?? b.notes[0] ?? null;
    const state: SectionState = items.length > 0 || hard === null ? "ok" : hard.state;
    const stats = { ...b.stats };
    const dropped = more.get(key) ?? 0;
    if (dropped > 0) stats.more = dropped;
    return { key, state, stateNote: first?.note ?? null, items, stats };
  });

  return {
    localDate, tz, nowIso: Number.isFinite(now.getTime()) ? now.toISOString() : new Date(0).toISOString(),
    sections, restrictedEmail, slackUnanswered, failures: uniq(failures)
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Content pieces shared by the deterministic path and the validator (brief-validate.ts)
// ---------------------------------------------------------------------------------------------------------------------

const TOP3_CATEGORIES: ReadonlySet<AttentionCategory> = new Set<AttentionCategory>(["my_action", "approval", "intervene"]);

/** Every item of the gather, in alias order. */
export function gatherItems(gather: BriefGather): BriefInputItem[] {
  return gather.sections.flatMap((s) => s.items);
}

/** A verdict for an item: the map's, "new" when it has none (a fingerprint never judged is new to him). */
export function verdictOf(verdicts: ReadonlyMap<string, NoveltyVerdict>, fp: string): NoveltyVerdict {
  return verdicts.get(fp) ?? "new";
}
const isNovel = (v: NoveltyVerdict): boolean => v === "new" || v === "changed" || v === "escalated";

/** M4 fallback: category ∈ {my_action, approval, intervene}, score desc, then fingerprint; distinct fingerprints; ≤ 3. Novelty doesn't
 *  enter: an unchanged critical item is still one of his top actions. */
export function deterministicTop3(items: readonly BriefInputItem[], verdicts: ReadonlyMap<string, NoveltyVerdict>): BriefInputItem[] {
  void verdicts;
  const seen = new Set<string>();
  return items
    .filter((i) => i && TOP3_CATEGORIES.has(i.category))
    .sort((a, b) => (b.score - a.score) || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0))
    .filter((i) => (seen.has(i.fingerprint) ? false : (seen.add(i.fingerprint), true)))
    .slice(0, BRIEF_LIMITS.top3);
}

/** A top-3 entry for an input item; itemId = the stored line that cites it, when one does. */
export function topItemFrom(item: BriefInputItem, itemId: string | null): BriefTopItem {
  return {
    itemId, alias: item.alias, fp: item.fingerprint, title: item.title, next: item.next, refs: item.refs.map((r) => ({ ...r })),
    threadIds: [...item.threadIds], slackKeys: [...item.slackKeys], slackChannels: [...item.slackChannels]
  };
}

/** A pending line (C13): the title as gathered, whatever a model wrote; the renderers add BRIEF_COPY.pendingPrefix. */
function pendingLine(item: BriefInputItem): BriefPendingLine {
  return {
    fp: item.fingerprint, title: item.title, band: item.band, since: item.occurredAt, refs: item.refs.map((r) => ({ ...r })),
    threadIds: [...item.threadIds], slackKeys: [...item.slackKeys], slackChannels: [...item.slackChannels]
  };
}

/** Every section of BRIEF_SECTION_KEYS, in order, with the gather's state, stateNote and stats, the deterministic pending lines, the
 *  unchanged count and `more` (the gather's dropped items plus `extraMore`), around the given lines. */
export function contentSections(gather: BriefGather, verdicts: ReadonlyMap<string, NoveltyVerdict>,
  lines: ReadonlyMap<BriefSectionKey, BriefItem[]>, extraMore: ReadonlyMap<BriefSectionKey, number> = new Map()): BriefSectionContent[] {
  const byKey = new Map(gather.sections.map((s) => [s.key, s]));
  return BRIEF_SECTION_KEYS.map((key) => {
    const g = byKey.get(key);
    const items = g?.items ?? [];
    const stats = { ...(g?.stats ?? {}) };
    return {
      key,
      state: g?.state ?? "unavailable",
      stateNote: g ? g.stateNote : "unavailable",
      items: lines.get(key) ?? [],
      pending: items.filter((i) => verdictOf(verdicts, i.fingerprint) === "pending").map(pendingLine),
      unchanged: items.filter((i) => verdictOf(verdicts, i.fingerprint) === "unchanged").length,
      more: (typeof stats.more === "number" ? stats.more : 0) + (extraMore.get(key) ?? 0),
      stats
    };
  });
}

/** content.novelty (the verdict per input fingerprint) and content.counts. */
export function noveltyAndCounts(gather: BriefGather, verdicts: ReadonlyMap<string, NoveltyVerdict>):
  { novelty: Record<string, NoveltyVerdict>; counts: BriefContent["counts"] } {
  const novelty: Record<string, NoveltyVerdict> = {};
  const counts: BriefContent["counts"] = { new: 0, changed: 0, escalated: 0, pending: 0, unchanged: 0,
    restrictedEmail: gather.restrictedEmail, slackUnanswered: gather.slackUnanswered };
  for (const item of gatherItems(gather)) {
    const v = verdictOf(verdicts, item.fingerprint);
    if (Object.prototype.hasOwnProperty.call(novelty, item.fingerprint)) continue;
    novelty[item.fingerprint] = v;
    counts[v] += 1;
  }
  return { novelty, counts };
}

/** One deterministic line: the item's title as written (≤ 280), a fact, its own basis. */
function lineFrom(item: BriefInputItem, id: string): BriefItem {
  return {
    id, text: clip(item.title, BRIEF_LIMITS.itemTextChars) || "(untitled)", kind: "fact", basis: item.basis, band: item.band,
    aliases: [item.alias], fps: [item.fingerprint], refs: item.refs.map((r) => ({ ...r })),
    threadIds: [...item.threadIds], slackKeys: [...item.slackKeys], slackChannels: [...item.slackChannels]
  };
}

/** Deterministic content (mode "deterministic"): per section the new/changed/escalated items as lines (text = title, the item's basis),
 *  pending lines, unchanged counts, the deterministic top 3. */
export function composeDeterministic(gather: BriefGather, verdicts: ReadonlyMap<string, NoveltyVerdict>,
  meta: { rev: number; builtAt: string; trigger: BriefTrigger; reason: BriefModeReason }): BriefContent {
  const lines = new Map<BriefSectionKey, BriefItem[]>();
  const extra = new Map<BriefSectionKey, number>();
  let n = 0;
  for (const s of gather.sections) {
    const novel = s.items.filter((i) => isNovel(verdictOf(verdicts, i.fingerprint)));
    const shown = novel.slice(0, BRIEF_LIMITS.itemsPerSectionStored);
    lines.set(s.key, shown.map((i) => lineFrom(i, `b${++n}`)));
    if (novel.length > shown.length) extra.set(s.key, novel.length - shown.length);
  }
  const all = [...lines.values()].flat();
  const top3 = deterministicTop3(gatherItems(gather), verdicts)
    .map((i) => topItemFrom(i, all.find((l) => l.aliases.includes(i.alias))?.id ?? null));
  const { novelty, counts } = noveltyAndCounts(gather, verdicts);
  return {
    v: 1, localDate: gather.localDate, tz: gather.tz, rev: meta.rev, builtAt: meta.builtAt, trigger: meta.trigger,
    mode: "deterministic", modeReason: meta.reason, top3Fallback: false, headline: null,
    sections: contentSections(gather, verdicts, lines, extra), top3, novelty, counts, failures: [...gather.failures]
  };
}

/** The union of every item's, pending line's and top-3 entry's threadIds / slackKeys / slackChannels (feeds the RPC's arrays). Sorted,
 *  distinct (the order exec_brief_ref_array gives). */
export function contentRefs(content: BriefContent): { threadIds: string[]; slackKeys: string[]; slackChannels: string[] } {
  const all: { threadIds?: unknown; slackKeys?: unknown; slackChannels?: unknown }[] = [
    ...(content?.sections ?? []).flatMap((s) => [...(s?.items ?? []), ...(s?.pending ?? [])]),
    ...(content?.top3 ?? [])
  ];
  const pick = (k: "threadIds" | "slackKeys" | "slackChannels") =>
    uniq(all.flatMap((x) => (Array.isArray(x?.[k]) ? (x[k] as unknown[]).filter((v): v is string => typeof v === "string") : []))).sort();
  return { threadIds: pick("threadIds"), slackKeys: pick("slackKeys"), slackChannels: pick("slackChannels") };
}
