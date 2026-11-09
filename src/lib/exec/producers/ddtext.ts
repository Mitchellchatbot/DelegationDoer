import { createHash } from "node:crypto";

import { isOpen } from "@/lib/exec/analysis/tasks";
import type { AttentionCandidate, AttentionCategory, AttentionFact, AttentionStatus } from "@/lib/exec/attention-types";
import {
  DDTEXT_LIVE_DAYS,
  DDTEXT_NOTE_LIVE_DAYS,
  type DdtextKind,
  type DdtextSignalRow,
  type DdtextSourceType
} from "@/lib/exec/ddtext-types";
import { formatInZone } from "@/lib/exec/format";
import { scorePriority, type AttentionKind, type PriorityFactors } from "@/lib/exec/priority";
import { ddFingerprintKey } from "@/lib/exec/producers/dd";
import { ddPageRef, ddTaskRef } from "@/lib/exec/refs";
import type { DdTask, DdUser, TaskStatus } from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal, SourceRef } from "@/lib/exec/types";

// DD text attention candidates (P5a contract §3.12.5, A5, C1, C17, C18; Area
// D). Pure: the handler reads, this decides.
//
// One candidate per live stored signal. The AI summary appears only as one
// fact labelled AI-assessed, never in the title or whatHappened; the titles of
// the AI kinds are hedged ("Possible blocker …", "… may be waiting on someone")
// and say whose text the model read. A mention is found by code and stays
// factual. Recommendations are fixed suggestions that blame nobody.
//
// The state hash is the signal's identity and its source's content hash, never
// the task's status (a-correct-10): P2b reopens a seen or owner-resolved row
// whenever the hash changes, so a task moving pending → in progress must not
// undo his "seen" or "resolve". A resubmitted note with new text does change
// the hash (comments are append-only). The status lives in a record fact,
// which updates without a reopen.

const DAY_MS = 86_400_000;

const ATTENTION_KIND: Readonly<Record<DdtextKind, AttentionKind>> = Object.freeze({
  blocker: "ddtext_blocker",
  waiting: "ddtext_waiting",
  decision: "ddtext_decision",
  mention: "ddtext_mention"
});

const CATEGORY: Readonly<Record<DdtextKind, AttentionCategory>> = Object.freeze({
  blocker: "intervene",
  waiting: "delegated",
  decision: "approval",
  mention: "my_action"
});

// How a task source reads in a sentence.
const TASK_SOURCE_LABEL: Readonly<Record<Exclude<DdtextSourceType, "eod_note" | "sod_note">, string>> = Object.freeze({
  comment: "comment",
  status_comment: "status note",
  handoff_note: "handoff note",
  extension_reason: "extension reason"
});

const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = Object.freeze({
  pending: "pending",
  in_progress: "in progress",
  urgent: "urgent",
  waiting_on_client: "waiting on the client",
  pending_approval: "waiting for approval",
  done: "done",
  rejected: "rejected"
});

const WHY: Readonly<Record<DdtextKind, string>> = Object.freeze({
  blocker: "Work that can't move often needs someone with the authority to unblock it.",
  waiting: "Work parked on someone else can slip when nobody owns the follow-up.",
  decision: "Someone may be waiting on a decision or an approval before the work can go on.",
  mention: "People usually mention you when they need your input or a decision."
});

const KINDS = ["blocker", "waiting", "decision", "mention"] as const;
const SOURCE_TYPES = ["comment", "status_comment", "handoff_note", "extension_reason", "eod_note", "sod_note"] as const;
const FINGERPRINT = /^dd:ddtext:(blocker|waiting|decision|mention):(comment|status_comment|handoff_note|extension_reason|eod_note|sod_note):([^:\s]+)$/;

/** C1: dd:ddtext:<kind>:<source_type>:<ddFingerprintKey(source_id)>, under the mandatory dd: prefix (K1). */
export function ddtextFingerprint(kind: DdtextKind, sourceType: DdtextSourceType, sourceId: string): string {
  if (!(KINDS as readonly string[]).includes(kind) || !(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    throw new TypeError("ddtextFingerprint: unknown kind or source type");
  }
  return `dd:ddtext:${kind}:${sourceType}:${ddFingerprintKey(sourceId)}`;
}

/** The parts of a ddtext fingerprint, or null when it isn't one. */
export function parseDdtextFingerprint(fp: string): { kind: DdtextKind; sourceType: DdtextSourceType; key: string } | null {
  const m = typeof fp === "string" ? FINGERPRINT.exec(fp) : null;
  return m ? { kind: m[1] as DdtextKind, sourceType: m[2] as DdtextSourceType, key: m[3] } : null;
}

export interface DdtextAttentionInput {
  principal: Pick<ExecPrincipal, "userId" | "name" | "timezone">;
  now: Date;
  /** source_created_at within the longest live window */
  signals: readonly DdtextSignalRow[];
  /** `${type}:${id}` → content hash (state hash input) */
  itemHashes: ReadonlyMap<string, string>;
  tasksById: ReadonlyMap<string, DdTask>;
  usersById: ReadonlyMap<string, DdUser>;
  /** his latest activity_logs/task_messages ms per task (P2b latestResponses rule) */
  principalActivityByTask: ReadonlyMap<string, number>;
  /** his latest update_replies ms per EOD note id */
  repliesByNote: ReadonlyMap<string, number>;
  /** tasks with a dd:mention:task:<id> row whose status ≠ resolved (C18) */
  liveP2bMentionTaskIds: ReadonlySet<string>;
  /** restrictedIntakeTaskIds at step 9 (C25): never live */
  withheldTaskIds: ReadonlySet<string>;
  /**
   * The current status of the stored ddtext rows of heldFingerprints() (review
   * data-1; optional, additive): a signal that fails only a status-dependent
   * check stays a candidate while his row holds one of HOLDS' statuses.
   */
  ownerStatusByFingerprint?: ReadonlyMap<string, AttentionStatus>;
}

function isNoteSource(t: DdtextSourceType): t is "eod_note" | "sod_note" {
  return t === "eod_note" || t === "sod_note";
}

function ms(iso: string | null | undefined): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

/**
 * Liveness (§3.12.5). Task sources: the task exists and is open, isn't
 * withheld by the restricted-sender screen, the signal is at most 14 days old;
 * a wait isn't live while the task already waits on the client; a decision or
 * a mention isn't live once he has acted on the task after it; a mention isn't
 * live while P2b's own mention item for the task is (C18). Note sources: at
 * most 3 days old; a decision on an EOD isn't live once he replied to it.
 */
export function isLiveDdtextSignal(s: DdtextSignalRow, ctx: DdtextAttentionInput): boolean {
  return livenessOf(s, ctx) === "live";
}

/**
 * "live", "dead", or the one status-dependent check that alone keeps a
 * signal from being live: the task is closed ("task_closed"), a wait while
 * the task already waits on the client ("waiting_on_client"), a mention while
 * P2b's own mention row is live ("p2b_mention"). The checks are the ones
 * isLiveDdtextSignal documents; only their order differs (all must hold).
 */
type Liveness = "live" | "dead" | "task_closed" | "waiting_on_client" | "p2b_mention";

function livenessOf(s: DdtextSignalRow, ctx: DdtextAttentionInput): Liveness {
  const at = ms(s.sourceCreatedAt);
  if (!Number.isFinite(at)) return "dead";
  const ageMs = ctx.now.getTime() - at;
  if (isNoteSource(s.sourceType)) {
    if (ageMs > DDTEXT_NOTE_LIVE_DAYS * DAY_MS) return "dead";
    if (s.kind === "decision" && s.sourceType === "eod_note") {
      const replied = ctx.repliesByNote.get(s.sourceId);
      if (replied !== undefined && replied > at) return "dead";
    }
    return s.kind !== "mention" ? "live" : "dead";
  }
  if (s.taskId === null) return "dead";
  if (ctx.withheldTaskIds.has(s.taskId)) return "dead";
  const task = ctx.tasksById.get(s.taskId);
  if (!task) return "dead";
  if (ageMs > DDTEXT_LIVE_DAYS * DAY_MS) return "dead";
  if (s.kind === "decision" || s.kind === "mention") {
    const acted = ctx.principalActivityByTask.get(s.taskId);
    if (acted !== undefined && acted > at) return "dead";
  }
  if (!isOpen(task)) return "task_closed";
  if (s.kind === "waiting" && task.status === "waiting_on_client") return "waiting_on_client";
  if (s.kind === "mention" && ctx.liveP2bMentionTaskIds.has(s.taskId)) return "p2b_mention";
  return "live";
}

/**
 * Review data-1. A status-dependent check that fails makes P2b's reconcile
 * auto-resolve the ddtext row whatever its status, and when the check passes
 * again the same signal (same state hash) reopens it as open: a status move
 * there and back would undo his seen, dismiss or snooze with nothing new to
 * show (against a-correct-10's intent). So a signal that fails ONLY such a
 * check stays a candidate while his row holds an action the candidate can't
 * show wrongly, and reconcile leaves the row where he put it:
 *   waiting_on_client: seen, dismissed or snoozed (the row's "Task is waiting
 *     on the client" fact says it; a seen row stays seen, not reopened);
 *   p2b_mention: dismissed or snoozed (a seen row would sit in the feed next
 *     to P2b's own mention item);
 *   task_closed: dismissed only (it stays out of the feed; a seen row would
 *     show a closed task's item).
 * Any other status (open, an owner-resolved row, no row) keeps P2b's rule.
 */
const HOLDS: Readonly<Record<Exclude<Liveness, "live" | "dead">, ReadonlySet<AttentionStatus>>> = Object.freeze({
  waiting_on_client: new Set<AttentionStatus>(["seen", "dismissed", "snoozed"]),
  p2b_mention: new Set<AttentionStatus>(["dismissed", "snoozed"]),
  task_closed: new Set<AttentionStatus>(["dismissed"])
});

/** The fingerprints of the signals that fail only a status-dependent check: the rows whose status the handler reads for ownerStatusByFingerprint. */
export function heldFingerprints(input: DdtextAttentionInput): string[] {
  const out = new Set<string>();
  for (const s of input.signals) {
    const l = livenessOf(s, input);
    if (l !== "live" && l !== "dead") out.add(ddtextFingerprint(s.kind, s.sourceType, s.sourceId));
  }
  return [...out].sort();
}

function isCandidateSignal(s: DdtextSignalRow, input: DdtextAttentionInput): boolean {
  const l = livenessOf(s, input);
  if (l === "live") return true;
  if (l === "dead") return false;
  const status = input.ownerStatusByFingerprint?.get(ddtextFingerprint(s.kind, s.sourceType, s.sourceId));
  return status !== undefined && HOLDS[l].has(status);
}

function fact(text: string, basis: AttentionFact["basis"], refs: SourceRef[] = []): AttentionFact {
  return { text, basis, refs };
}

/** sha256 hex (first 32) of { kind, sourceType, sourceId, contentHash }: no task status, no timestamps (a-correct-10). */
export function ddtextStateHash(kind: DdtextKind, sourceType: DdtextSourceType, sourceId: string, contentHash: string): string {
  return createHash("sha256").update(JSON.stringify({ kind, sourceType, sourceId, contentHash })).digest("hex").slice(0, 32);
}

function candidateFor(s: DdtextSignalRow, input: DdtextAttentionInput): AttentionCandidate | null {
  const tz = input.principal.timezone;
  const author = input.usersById.get(s.authorUserId)?.name?.trim() || "A teammate";
  const personRef = ddPageRef(`/team/${encodeURIComponent(s.authorUserId)}`, author);
  const date = formatInZone(s.sourceCreatedAt, tz, "date", input.now);
  const when = formatInZone(s.sourceCreatedAt, tz, "datetime", input.now);
  const factors: Omit<PriorityFactors, "kind"> = {};
  const facts: AttentionFact[] = [];
  let title: string;
  let whatHappened: string;
  let recommendedNext: string;
  let refs: SourceRef[];

  if (isNoteSource(s.sourceType)) {
    const note = s.sourceType === "eod_note" ? "EOD" : "SOD";
    const page = s.sourceType === "eod_note" ? ddPageRef("/eod/history", "EOD history") : ddPageRef("/sod/history", "SOD history");
    refs = [page];
    switch (s.kind) {
      case "blocker":
        title = `Possible blocker in ${author}'s ${note}`;
        whatHappened = `An AI reading of ${author}'s ${note} blockers submitted on ${date} found a possible blocker.`;
        recommendedNext = `Check with ${author} whether they still need help.`;
        break;
      case "waiting":
        title = `Possible wait in ${author}'s ${note}`;
        whatHappened = `An AI reading of ${author}'s ${note} blockers submitted on ${date} found work possibly waiting on someone.`;
        recommendedNext = `Check with ${author} what the work is waiting on and whether a nudge would help.`;
        break;
      case "decision":
        title = `Possible decision request in ${author}'s ${note}`;
        whatHappened = `An AI reading of ${author}'s ${note} blockers submitted on ${date} found a possible request for a decision.`;
        recommendedNext = `Read ${author}'s ${note} and see whether a decision from you is needed.`;
        break;
      default:
        return null;
    }
    if (s.summary) facts.push(fact(s.summary, "ai", [page]));
    facts.push(fact(`${author} wrote this ${when}`, "record", [personRef]));
  } else {
    const task = s.taskId === null ? undefined : input.tasksById.get(s.taskId);
    if (!task) return null;
    const label = TASK_SOURCE_LABEL[s.sourceType];
    const taskRef = ddTaskRef(task);
    refs = [taskRef];
    factors.taskPriority = task.priority;
    switch (s.kind) {
      case "blocker":
        title = `Possible blocker on "${task.title}" (AI reading of ${author}'s ${label})`;
        whatHappened = `An AI reading of ${author}'s ${label} on ${date} found a possible blocker.`;
        recommendedNext = `Open the task and check whether ${author} still needs help.`;
        break;
      case "waiting":
        title = `"${task.title}" may be waiting on someone (AI reading of ${author}'s ${label})`;
        whatHappened = `An AI reading of ${author}'s ${label} on ${date} found the work possibly waiting on someone.`;
        recommendedNext = "Open the task and check who it is waiting on and whether a nudge would help.";
        break;
      case "decision":
        title = `Possible decision request on "${task.title}" (AI reading of ${author}'s ${label})`;
        whatHappened = `An AI reading of ${author}'s ${label} on ${date} found a possible request for a decision.`;
        recommendedNext = "Open the task and see whether a decision from you is needed.";
        break;
      case "mention":
        title = `${author} mentioned you on "${task.title}"`;
        whatHappened =
          `${author} wrote "@${input.principal.name}" in a ${label} on ${date}. DD didn't notify you, and DD shows no comment, ` +
          "status change or other action from you on the task since.";
        recommendedNext = `Reply on the task, or tell ${author} who should handle it.`;
        factors.aboutPrincipal = true;
        break;
    }
    if (s.kind !== "mention" && s.summary) facts.push(fact(s.summary, "ai", [taskRef]));
    facts.push(fact(`${author} wrote this ${when}`, "record", [personRef]));
    const due = task.dueDate ? `due ${formatInZone(task.dueDate, tz, "date", input.now)}` : "no due date";
    const status = Object.hasOwn(STATUS_LABEL, task.status) ? STATUS_LABEL[task.status] : String(task.status);
    facts.push(fact(`Task is ${status}, ${due}`, "record", [taskRef]));
    if (s.kind === "mention") facts.push(fact("No DD notification was sent to you for this mention", "derived"));
  }

  const kind = ATTENTION_KIND[s.kind];
  const contentHash = input.itemHashes.get(`${s.sourceType}:${s.sourceId}`) ?? "";
  return {
    fingerprint: ddtextFingerprint(s.kind, s.sourceType, s.sourceId),
    source: "dd",
    kind,
    category: CATEGORY[s.kind],
    title,
    whatHappened,
    whyItMatters: WHY[s.kind],
    recommendedNext,
    facts,
    refs,
    priority: scorePriority({ ...factors, kind }),
    stateHash: ddtextStateHash(s.kind, s.sourceType, s.sourceId, contentHash),
    occurredAt: s.sourceCreatedAt
  };
}

/** One candidate per live signal, or per signal his row holds through a status move (HOLDS, data-1); C1 fingerprints, source dd, in fingerprint order. */
export function buildDdtextCandidates(input: DdtextAttentionInput): AttentionCandidate[] {
  const out = new Map<string, AttentionCandidate>();
  for (const s of input.signals) {
    if (!isCandidateSignal(s, input)) continue;
    const c = candidateFor(s, input);
    if (c && !out.has(c.fingerprint)) out.set(c.fingerprint, c);
  }
  return [...out.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
}
