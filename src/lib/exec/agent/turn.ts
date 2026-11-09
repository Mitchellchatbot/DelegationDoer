import "server-only";

import { chatSpentTodayUsd } from "@/lib/exec/agent/budget";
import { buildReplay, buildUserTurnText, CHAT_PROMPT_VERSION } from "@/lib/exec/agent/prompt";
import { runAgentTurn, type AgentTurnInput, type AgentTurnResult } from "@/lib/exec/agent/run";
import { ownSignal, withOwnSignal } from "@/lib/exec/agent/signal";
import { TOOLS_VERSION } from "@/lib/exec/agent/tool-defs";
import { createTurnMemo } from "@/lib/exec/agent/tools";
import type {
  AgentEventSink,
  ChatCard,
  ChatContextInput,
  ChatContextKind,
  CitedSource,
  RefEntry,
  ResolvedContext
} from "@/lib/exec/agent/types";
import { ATTENTION_ITEM_ID, parseEmailFingerprint } from "@/lib/exec/attention";
import { getScreenedAttentionItem } from "@/lib/exec/attention-read";
import {
  beginTurn,
  finishTurn,
  listChatDraftIdsForThreads,
  listProposalsForMessages,
  listRedactedSince,
  loadConversation,
  loadTurnByMessageId,
  proposalContentHash,
  redactChatForThreads,
  redactChatMessage,
  type BeginTurnResult,
  type ChatConversationRow,
  type FinishTurnInput,
  type ProposalRow,
  type StoredMessage,
  type StoredTurn
} from "@/lib/exec/chat-store";
import { FAILED_TEXT, REDACTED_TEXT, UNCHECKED_TEXT } from "@/lib/exec/chat/copy";
import { numberSources } from "@/lib/exec/chat/markers";
import type { CardView, ChatDonePayload, ChatMessageView, ProposalView } from "@/lib/exec/chat/view-types";
import { draftPageHref } from "@/lib/exec/drafts-links";
import { purgeDraftsByIds } from "@/lib/exec/drafts-store";
import { getEmailThread, listThreadScreenRows } from "@/lib/exec/email-store";
import type { ThinkingBindingBehavior } from "@/lib/exec/llm/request";
import { ddClientRef, ddPageRef, ddProjectRef, execEmailThreadRef } from "@/lib/exec/refs";
import { SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT } from "@/lib/exec/slack-intel-copy";
import { recheckSlackAnswer } from "@/lib/exec/slack-redact";
import { listClients, listDepartments, listProjects } from "@/lib/exec/sources/dd";
import { loadScreeningPolicy, screenStoredRow } from "@/lib/exec/sources/mail";
import type { ExecPrincipal, ExecSettings, SourceRef } from "@/lib/exec/types";

// One chat turn end to end (P5b contract §3.15; Area C; server-only):
// context resolution and the begin RPC on their own controller (C55),
// history and replay, runAgentTurn, the finish write on its own signal (B5),
// the post-finish screen (C21), and the done payload. Also the stored-turn
// mappers the GET route, the chat page and the confirm route share (bindings
// AM17).
//
// Every write after the model runs (finish, redaction, draft purge) and every
// read of the post-finish screen gets a FRESH controller, never the request's
// or the turn's signal: a Stop or a disconnect aborts the model call, not the
// bookkeeping that stores what happened. Logs carry ids only.

export interface ChatTurnRequest { conversationId: string | null; clientTurnId: string; surface: "web" | "slack"; text: string; context: ChatContextInput | null }

export type PreparedTurn =
  | { kind: "started"; begin: Extract<BeginTurnResult, { outcome: "started" }>; context: ResolvedContext | null }
  | { kind: "replay"; turn: StoredTurn; conversation: ChatConversationRow }
  // Integrator (C50): busy carries the begin RPC's conversation id, so a retried first question (sent with a null
  // conversationId) can poll GET /api/exec/conversations/:id. Additive and optional; the conversation is his own.
  | { kind: "busy"; conversationId?: string } | { kind: "busy_principal" } | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "not_found" } | { kind: "context_unavailable"; reason: "gone" | "check_failed" };

/** C55: prepare's own controller (context resolution and the begin RPC). */
export const PREPARE_TIMEOUT_MS = 10_000;
/** B5: the finish write's own controller. */
const FINISH_TIMEOUT_MS = 10_000;
/** C21: each read attempt and each write of the post-finish screen. */
const SCREEN_TIMEOUT_MS = 10_000;
/** b-agent-8: earlier context refs re-resolved per turn, newest first. */
const MAX_EARLIER_CONTEXTS = 5;
const CONTEXT_RESOLVE_MS = 10_000;
const BUDGET_READ_MS = 5_000;
/** §3.15: the history the replay is built from. */
const HISTORY_TURNS = 200;
/** B5: a running answer older than this is shown as failed / stale. */
const STALE_MS = 600_000;
/** C49: the begin RPC's limits. */
const BEGIN_LIMITS = Object.freeze({ staleSeconds: 600, rateLimit: 30, rateWindowSeconds: 600, maxRunning: 2 });
const TITLE_MAX = 80;

const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** P3's thread id rule: 1-200 characters, no whitespace or control characters. */
function isThreadIdShape(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(v);
}

function logId(id: unknown): string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "unknown";
}

/** Refs never carry an excerpt (§3.5). */
function withoutExcerpt(s: SourceRef): SourceRef {
  return { system: s.system, id: s.id, url: s.url, label: s.label, class: s.class };
}

/** Whitespace collapsed, ≤ 80 characters with "…". */
export function newConversationTitle(question: string): string {
  const t = String(question ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= TITLE_MAX) return t;
  let cut = TITLE_MAX - 1;
  const code = t.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  return `${t.slice(0, cut).trimEnd()}${String.fromCharCode(0x2026)}`;
}

// ---------------------------------------------------------------------------
// Context resolution (C18; coherence-9)
// ---------------------------------------------------------------------------

type Resolved = { ok: true; context: ResolvedContext } | { ok: false; reason: "gone" | "check_failed" };

const GONE: Resolved = { ok: false, reason: "gone" };
const CHECK_FAILED: Resolved = { ok: false, reason: "check_failed" };

/** The chip's label for an attention item (§3.19.7, ui-1): its title, one line, ≤ 120; else its source's label. */
function attentionChipLabel(title: unknown, fallback: string): string {
  const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (t === "") return fallback;
  if (t.length <= CHIP_LABEL_MAX) return t;
  let cut = CHIP_LABEL_MAX - 1;
  const code = t.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  return `${t.slice(0, cut).trimEnd()}${String.fromCharCode(0x2026)}`;
}
const CHIP_LABEL_MAX = 120;

/**
 * The context, resolved and screened. `label` (ui-1) is what the chip shows when it isn't the source's label: an
 * attention item's title ("Sam Lee has 4 overdue tasks"), where the source is the item's first ref (one of its tasks).
 */
export async function resolveChatContext(principal: ExecPrincipal, settings: ExecSettings, input: ChatContextInput, now: Date, opts?: { signal?: AbortSignal }):
  Promise<{ ok: true; context: ResolvedContext; label?: string } | { ok: false; reason: "gone" | "check_failed" }> {
  const signal = opts?.signal;
  const kind = input?.kind;
  const id = input?.id;
  // Ids are never trusted beyond their shape; labels never come from the client.
  try {
    switch (kind) {
      case "attention": {
        if (typeof id !== "string" || !ATTENTION_ITEM_ID.test(id)) return GONE;
        const r = await getScreenedAttentionItem(principal, id, { now, signal });
        if (!r.ok) return r.reason === "screen_unavailable" ? CHECK_FAILED : GONE;
        const item = r.item;
        const threadId = parseEmailFingerprint(item.fingerprint)?.threadId ?? null;
        const first = Array.isArray(item.refs) && item.refs.length > 0 ? item.refs[0] : null;
        const source = withoutExcerpt(first ?? ddPageRef("/executive", "Needs Attention"));
        return { ok: true, context: { kind, id, target: { type: "attention", id, threadId }, source }, label: attentionChipLabel(item.title, source.label) };
      }
      case "project": {
        if (typeof id !== "string" || !ID_SHAPE.test(id)) return GONE;
        const project = (await listProjects(principal, { signal })).find((p) => p.id === id);
        if (!project) return GONE;
        return { ok: true, context: { kind, id, target: { type: "project", id }, source: withoutExcerpt(ddProjectRef({ id, name: project.name })) } };
      }
      case "client": {
        if (typeof id !== "string" || !ID_SHAPE.test(id)) return GONE;
        const client = (await listClients(principal, { signal })).find((c) => c.id === id);
        if (!client) return GONE;
        return { ok: true, context: { kind, id, target: { type: "client", id }, source: withoutExcerpt(ddClientRef({ id, name: client.name })) } };
      }
      case "thread": {
        if (!isThreadIdShape(id)) return GONE;
        const access = await createTurnMemo(principal, settings, now, signal ?? new AbortController().signal).email();
        if (access.state !== "on") return GONE;
        const row = await getEmailThread(principal, id, { signal });
        if (!row || row.state === "gone" || !access.usable.includes(row.accountId)) return GONE;
        // A tombstone, a rule match or a row that can't be screened is not shown (screenStoredRow fails closed).
        if (screenStoredRow(row, access.rules, access.policyHash).verdict !== "clean") return GONE;
        return { ok: true, context: { kind, id, target: { type: "email_thread", id }, source: withoutExcerpt(execEmailThreadRef(id, row.subject)) } };
      }
      default:
        return GONE;
    }
  } catch (err) {
    // prepare's own deadline: let the caller answer 503 rather than a misleading 409.
    if (signal?.aborted) throw err;
    return CHECK_FAILED;
  }
}

// ---------------------------------------------------------------------------
// Prepare (C18, C49, C55)
// ---------------------------------------------------------------------------

/** Resolve and screen the context, then exec_chat_begin_turn, on its OWN controller (timeoutMs, default 10 s): never the
 *  request's signal (C55, b-agent-7). No model call. DB errors throw. */
export async function prepareChatTurn(principal: ExecPrincipal, settings: ExecSettings, req: ChatTurnRequest, now: Date, opts?: { timeoutMs?: number }): Promise<PreparedTurn> {
  const own = ownSignal(opts?.timeoutMs ?? PREPARE_TIMEOUT_MS);
  const signal = own.signal;
  try {
    let context: ResolvedContext | null = null;
    if (req.context) {
      const r = await resolveChatContext(principal, settings, req.context, now, { signal });
      if (!r.ok) return { kind: "context_unavailable", reason: r.reason };
      context = r.context;
    }
    const begin = await beginTurn(
      principal,
      {
        conversationId: req.conversationId,
        clientTurnId: req.clientTurnId,
        surface: req.surface,
        text: req.text,
        context: req.context ? { kind: req.context.kind, id: req.context.id } : null,
        title: newConversationTitle(req.text),
        retentionDays: settings.retentionDaysChat,
        ...BEGIN_LIMITS
      },
      { signal }
    );
    switch (begin.outcome) {
      case "started":
        // The begin RPC reserves the context's ref (C18); without one the turn runs without the context.
        return { kind: "started", begin, context: begin.contextRef ? context : null };
      case "replay": {
        const [turn, loaded] = await Promise.all([
          loadTurnByMessageId(principal, begin.assistantMessageId, { signal }),
          loadConversation(principal, begin.conversationId, { maxTurns: 1, signal })
        ]);
        if (!turn || !loaded) return { kind: "not_found" };
        return { kind: "replay", turn, conversation: loaded.conversation };
      }
      case "busy":
        return { kind: "busy", conversationId: begin.conversationId };
      case "busy_principal":
        return { kind: "busy_principal" };
      case "rate_limited":
        return { kind: "rate_limited", retryAfterSeconds: begin.retryAfterSeconds };
      default:
        return { kind: "not_found" };
    }
  } finally {
    own.dispose();
  }
}

// ---------------------------------------------------------------------------
// Cards and views
// ---------------------------------------------------------------------------

interface CardSource {
  messageId: string;
  cards: readonly ChatCard[];
  /** C23: the message consulted email or S4 DD text. */
  privacy: boolean;
}

/** Department names for proposal cards; an unreadable roster falls back to the id (never a guess, never a throw). */
async function departmentNames(principal: ExecPrincipal, rows: readonly ProposalRow[], signal?: AbortSignal): Promise<(id: string | null) => string | null> {
  if (!rows.some((r) => r.departmentId !== null)) return () => null;
  let names: Map<string, string> | null = null;
  try {
    names = new Map((await listDepartments(principal, { signal })).map((d) => [d.id, d.name]));
  } catch {
    names = null;
  }
  return (id) => (id === null ? null : (names?.get(id) ?? id));
}

function proposalViewOf(row: ProposalRow, departmentName: (id: string | null) => string | null, privacy: boolean, now: Date): ProposalView {
  const expired = row.status === "pending" && Date.parse(row.expiresAt) <= now.getTime();
  return {
    id: row.id,
    status: expired ? "expired" : row.status,
    title: row.title,
    description: row.description,
    assigneeName: row.assigneeName,
    departmentName: departmentName(row.departmentId),
    dueOn: row.dueOn,
    clientName: row.clientName,
    priority: row.priority,
    taskHref: row.taskId ? `/tasks/${encodeURIComponent(row.taskId)}` : null,
    expiresAt: row.expiresAt,
    contentHash: proposalContentHash(row),
    privacyNotice: privacy,
    redacted: row.redactedAt !== null
  };
}

function draftCardView(card: Extract<ChatCard, { kind: "draft" }>): CardView {
  return { kind: "draft", draftId: card.id, href: draftPageHref(card.id), existing: card.existing === true, privateRefKinds: [...(card.privateRefKinds ?? [])] };
}

/** Cards per message id, in each message's card order. A proposal whose row is missing is left out. Reads throw. */
async function resolveCards(principal: ExecPrincipal, sources: readonly CardSource[], now: Date, signal?: AbortSignal): Promise<Map<string, CardView[]>> {
  const withProposals = sources.filter((s) => s.cards.some((c) => c.kind === "task_proposal")).map((s) => s.messageId);
  const rows = withProposals.length > 0 ? await listProposalsForMessages(principal, withProposals, { signal }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deptName = await departmentNames(principal, rows, signal);
  const out = new Map<string, CardView[]>();
  for (const s of sources) {
    const views: CardView[] = [];
    for (const card of s.cards) {
      if (card.kind === "draft") {
        views.push(draftCardView(card));
        continue;
      }
      const row = byId.get(card.id);
      if (row) views.push({ kind: "task_proposal", proposal: proposalViewOf(row, deptName, s.privacy, now) });
    }
    out.set(s.messageId, views);
  }
  return out;
}

const privacyOf = (m: Pick<StoredMessage, "consultedEmailThreadIds" | "consultedDdText" | "consultedPrivateSlack">): boolean =>
  m.consultedEmailThreadIds.length > 0 || m.consultedDdText === true || m.consultedPrivateSlack === true;

/** A stored assistant row as it is shown: a running row older than 600 s is failed / stale (B5). */
function shownAssistant(a: StoredMessage, now: Date): { status: ChatMessageView["status"]; statusReason: string | null; text: string; recommendations: string } {
  if (a.status === "running" && now.getTime() - Date.parse(a.createdAt) > STALE_MS) {
    return { status: "failed", statusReason: "stale", text: FAILED_TEXT, recommendations: "" };
  }
  return { status: a.status, statusReason: a.statusReason, text: a.text, recommendations: a.recommendations };
}

/** The stored turn as a done payload (replay path and GET). */
export async function storedTurnPayload(principal: ExecPrincipal, conversation: ChatConversationRow, turn: StoredTurn, now: Date, opts?: { signal?: AbortSignal }): Promise<ChatDonePayload> {
  const a = turn.assistant;
  if (!a) throw new Error("exec chat: the stored turn has no answer row");
  const shown = shownAssistant(a, now);
  const cards = await resolveCards(principal, [{ messageId: a.id, cards: a.cards, privacy: privacyOf(a) }], now, opts?.signal);
  return {
    messageId: a.id,
    conversationId: conversation.id,
    turnId: turn.turnId,
    conversationTitle: conversation.title,
    status: shown.status,
    statusReason: shown.statusReason,
    answer: shown.text,
    recommendations: shown.recommendations,
    sources: numberSources(a.sources, shown.text, shown.recommendations),
    cards: cards.get(a.id) ?? [],
    saved: true
  };
}

/** Lead addition (bindings AM17): the stored turns as message views, oldest first, two per turn (user, then assistant when
 *  present), with the same source numbering and card resolution as storedTurnPayload; a running answer older than 600 s
 *  shows as failed / stale. Used by GET /api/exec/conversations/:id (D) and /executive/chat (E). */
export async function storedMessageViews(principal: ExecPrincipal, turns: readonly StoredTurn[], now: Date, opts?: { signal?: AbortSignal }): Promise<ChatMessageView[]> {
  const sources: CardSource[] = turns
    .filter((t) => t.assistant !== null)
    .map((t) => ({ messageId: (t.assistant as StoredMessage).id, cards: (t.assistant as StoredMessage).cards, privacy: privacyOf(t.assistant as StoredMessage) }));
  const cards = await resolveCards(principal, sources, now, opts?.signal);
  const out: ChatMessageView[] = [];
  for (const t of turns) {
    out.push({
      id: t.user.id,
      turnId: t.turnId,
      role: "user",
      status: "complete",
      statusReason: null,
      text: t.user.text,
      recommendations: "",
      sources: [],
      cards: [],
      createdAt: t.user.createdAt,
      finishedAt: t.user.finishedAt,
      redacted: false,
      contextKind: t.user.context?.kind ?? null
    });
    const a = t.assistant;
    if (!a) continue;
    const shown = shownAssistant(a, now);
    out.push({
      id: a.id,
      turnId: t.turnId,
      role: "assistant",
      status: shown.status,
      statusReason: shown.statusReason,
      text: shown.text,
      recommendations: shown.recommendations,
      sources: numberSources(a.sources, shown.text, shown.recommendations),
      cards: cards.get(a.id) ?? [],
      createdAt: a.createdAt,
      finishedAt: a.finishedAt,
      redacted: a.redactedAt !== null,
      contextKind: null
    });
  }
  return out;
}

/** Lead addition (bindings AM17): one proposal as its card, as the done payload builds it (contentHash via
 *  proposalContentHash, privacyNotice from its message's consulted flags, departmentName, expired when pending past
 *  expires_at, redacted). Used by the confirm route's 409 { error: "changed", proposal } (D). */
export async function proposalViewFor(principal: ExecPrincipal, row: ProposalRow, now: Date, opts?: { signal?: AbortSignal }): Promise<ProposalView> {
  const [turn, deptName] = await Promise.all([
    loadTurnByMessageId(principal, row.messageId, { signal: opts?.signal }),
    departmentNames(principal, [row], opts?.signal)
  ]);
  // Unknown message: show the notice (fail closed: he is told to check for private text).
  const privacy = turn?.assistant ? privacyOf(turn.assistant) : true;
  return proposalViewOf(row, deptName, privacy, now);
}

// ---------------------------------------------------------------------------
// The post-finish screen (C21)
// ---------------------------------------------------------------------------

async function attempt<T>(fn: (signal: AbortSignal) => Promise<T>, tries = 2): Promise<{ ok: true; value: T } | { ok: false }> {
  for (let i = 0; i < tries; i++) {
    try {
      return { ok: true, value: await withOwnSignal(SCREEN_TIMEOUT_MS, fn) };
    } catch {
      // retried once on a fresh controller
    }
  }
  return { ok: false };
}

/**
 * C21 (b-agent-1, b-security-5). Returns the text this message must carry instead of its answer, or null.
 * Verified restricted threads are redacted principal-wide (with the purge of chat drafts by id: the stored cards' and
 * this turn's own, which a finish that didn't commit never stored); anything unverified, and a screen that couldn't run,
 * hides this message only. The per-message write runs whether or not the finish answered in time (loop-2): a finish
 * that committed after its deadline must still be hidden, and the RPC refuses a row still running, so on a finish that
 * really failed it changes nothing. The principal-wide redaction runs either way (it acts on other answers too).
 */
async function postFinishScreen(principal: ExecPrincipal, scope: {
  messageId: string; conversationId: string; sinceIso: string; consulted: readonly string[]; ownDraftIds: readonly string[];
  checkEarlier: boolean; saved: boolean;
}): Promise<string | null> {
  const verified: string[] = [];
  let unverified = false;
  let screenFailed = false;
  if (scope.consulted.length > 0) {
    const read = await attempt(async (signal) => {
      const rows = await listThreadScreenRows(principal, scope.consulted, { signal });
      if (rows.size === 0) return { verified: [] as string[], unverified: false };
      const policy = await loadScreeningPolicy(principal, { signal });
      const v: string[] = [];
      let u = false;
      for (const [threadId, row] of rows) {
        const s = screenStoredRow(row, policy.rules, policy.hash);
        if (s.verdict !== "restricted") continue;
        if (s.reason === "tombstone" || s.reason === "rule_match") v.push(threadId);
        else u = true;
      }
      return { verified: v, unverified: u };
    });
    if (read.ok) {
      verified.push(...read.value.verified);
      unverified = read.value.unverified;
    } else {
      screenFailed = true;
    }
  }

  let decision: string | null = null;
  let coveredByThreads = false;
  if (verified.length > 0) {
    decision = REDACTED_TEXT;
    const redacted = await attempt((signal) => redactChatForThreads(principal, verified, { signal }));
    coveredByThreads = redacted.ok;
    if (!redacted.ok) console.warn(`[exec-chat] redaction write failed message=${logId(scope.messageId)}`);
    const drafts = await attempt((signal) => listChatDraftIdsForThreads(principal, verified, { signal }));
    if (!drafts.ok) console.warn(`[exec-chat] draft purge failed message=${logId(scope.messageId)}`);
    const ids = [...new Set([...(drafts.ok ? drafts.value : []), ...scope.ownDraftIds])];
    if (ids.length > 0) {
      const purged = await attempt((signal) => purgeDraftsByIds(principal, ids, { signal }));
      if (!purged.ok) console.warn(`[exec-chat] draft purge failed message=${logId(scope.messageId)}`);
    }
  } else if (unverified || screenFailed) {
    decision = UNCHECKED_TEXT;
  }

  // (5) an earlier answer of this conversation redacted after this turn began: its text was in this turn's replay.
  if (scope.checkEarlier) {
    const earlier = await attempt((signal) => listRedactedSince(principal, scope.conversationId, scope.sinceIso, { signal }));
    if (!earlier.ok) {
      if (decision === null) decision = UNCHECKED_TEXT;
    } else {
      const others = earlier.value.filter((m) => m.id !== scope.messageId);
      if (others.length > 0) {
        // P7b (N15): an earlier answer removed for Slack reasons (its own sentence) makes this one carry the Slack sentence.
        const verified = others.filter((m) => m.verified);
        if (verified.length > 0) decision = verified.every((m) => m.slack === true) && decision !== REDACTED_TEXT ? SLACK_REDACTED_TEXT : REDACTED_TEXT;
        else if (decision === null) decision = others.every((m) => m.slack === true) ? SLACK_UNCHECKED_TEXT : UNCHECKED_TEXT;
      }
    }
  }

  if (decision !== null && !(decision === REDACTED_TEXT && coveredByThreads)) {
    const text = decision;
    const wrote = await attempt((signal) => redactChatMessage(principal, scope.messageId, text, { signal }));
    if (!wrote.ok) console.warn(`[exec-chat] redaction write failed message=${logId(scope.messageId)}`);
  }
  return decision;
}

// ---------------------------------------------------------------------------
// The turn (§3.15)
// ---------------------------------------------------------------------------

interface History {
  conversation: ChatConversationRow | null;
  earlier: StoredTurn[];
}

const sameContext = (a: { kind: ChatContextKind; id: string }, b: { kind: ChatContextKind; id: string }) => a.kind === b.kind && a.id === b.id;

/** b-agent-8: earlier questions' context refs, re-resolved and screened (≤ 5 distinct items, newest first). */
async function earlierContextRefs(
  principal: ExecPrincipal, settings: ExecSettings, earlier: readonly StoredTurn[], current: { kind: ChatContextKind; id: string; resolved: ResolvedContext } | null, now: Date
): Promise<RefEntry[]> {
  const groups: { kind: ChatContextKind; id: string; refs: string[] }[] = [];
  for (let i = earlier.length - 1; i >= 0; i--) {
    const c = earlier[i].user.context;
    if (!c || typeof c.ref !== "string") continue;
    const g = groups.find((x) => sameContext(x, c));
    if (g) g.refs.push(c.ref);
    else groups.push({ kind: c.kind, id: c.id, refs: [c.ref] });
  }
  const out: RefEntry[] = [];
  const toResolve: typeof groups = [];
  for (const g of groups) {
    // The same item as this turn's context needs no second resolution.
    if (current && sameContext(g, current)) {
      for (const ref of g.refs) out.push({ ref, target: current.resolved.target, source: current.resolved.source });
    } else if (toResolve.length < MAX_EARLIER_CONTEXTS) {
      toResolve.push(g);
    }
  }
  const results = await Promise.all(
    toResolve.map((g) =>
      withOwnSignal(CONTEXT_RESOLVE_MS, (signal) => resolveChatContext(principal, settings, { kind: g.kind, id: g.id }, now, { signal })).catch(
        (): Resolved => CHECK_FAILED
      )
    )
  );
  results.forEach((r, i) => {
    if (!r.ok) return; // unavailable ones are skipped: their refs stay unknown
    for (const ref of toResolve[i].refs) out.push({ ref, target: r.context.target, source: r.context.source });
  });
  return out;
}

function noModelResult(status: "failed" | "aborted", reason: "internal" | "client_abort", answer: string, refSeq: number, usage: AgentTurnResult["usage"]): AgentTurnResult {
  return {
    status, statusReason: reason, refusalCategory: null, answer, recommendations: "", cited: [], cards: [], toolCalls: [],
    consulted: [], consultedClients: [], consultedDdText: false, refSeq, usage, model: "claude-opus-5-5", streamedText: false
  };
}

/** History → runAgentTurn → finish (own signal) → post-finish screen (C21, own signal) → done payload. Never throws for
 *  model/tool failures. opts.signal is the request's (web) or the job's (Slack) signal: already aborted → the turn is
 *  finished as aborted with no model call (C55). */
export async function runPreparedTurn(principal: ExecPrincipal, settings: ExecSettings,
  prepared: Extract<PreparedTurn, { kind: "started" }>, req: ChatTurnRequest,
  opts: { signal: AbortSignal; sink?: AgentEventSink; now: Date; binding?: ThinkingBindingBehavior }):
  Promise<{ done: ChatDonePayload; audit: { status: string; statusReason: string | null; modelCalls: number; toolCalls: number; costUsd: number; slackVerbatimClipped?: number } }> {
  const { begin } = prepared;
  const now = opts.now;
  const tz = principal.timezone;
  const contextRef = begin.contextRef;
  const current = prepared.context && contextRef ? { kind: prepared.context.kind, id: prepared.context.id, resolved: prepared.context } : null;
  const userTurnText = buildUserTurnText(begin.userCreatedAt, tz, req.text, current && contextRef ? { ref: contextRef, kind: current.kind } : null);
  const baseInput = (over: Partial<AgentTurnInput>): AgentTurnInput => ({
    conversationId: begin.conversationId,
    assistantMessageId: begin.assistantMessageId,
    turnId: begin.turnId,
    surface: req.surface,
    replay: [],
    userTurnText,
    priorRefs: [],
    contextRefs: current && contextRef ? [{ ref: contextRef, target: current.resolved.target, source: current.resolved.source }] : [],
    refSeq: begin.refSeq,
    context: current ? current.resolved : null,
    prior: { threads: new Set(), clients: new Set(), ddText: false },
    // P7b (C8, C30): his stored question text; only prepare_client_update reads it.
    question: req.text,
    chatSpentAtStartUsd: 0,
    settings,
    now,
    ...over
  });

  let history: History = { conversation: null, earlier: [] };
  let historyKnown = false;
  let agent: AgentTurnResult;
  if (opts.signal.aborted) {
    // C55: a 0.0 s turn; runAgentTurn returns aborted before any model call.
    agent = await runAgentTurn(principal, baseInput({}), { signal: opts.signal, sink: opts.sink, binding: opts.binding });
  } else {
    let prep: { input: AgentTurnInput } | { failed: true };
    try {
      const loaded = await withOwnSignal(FINISH_TIMEOUT_MS, (signal) => loadConversation(principal, begin.conversationId, { maxTurns: HISTORY_TURNS, signal }));
      if (!loaded) throw new Error("conversation not found");
      history = { conversation: loaded.conversation, earlier: loaded.turns.filter((t) => t.turnId !== begin.turnId) };
      historyKnown = true;
      const earlier = history.earlier;
      const priorRefs = new Map<string, CitedSource>();
      const threads = new Set<string>();
      const clients = new Set<string>();
      let ddText = false;
      let privateSlack = false;
      for (const t of earlier) {
        const a = t.assistant;
        if (!a) continue;
        for (const s of a.sources) if (s && typeof s.ref === "string" && !priorRefs.has(s.ref)) priorRefs.set(s.ref, s);
        for (const id of a.consultedEmailThreadIds) threads.add(id);
        for (const id of a.consultedClientIds) clients.add(id);
        ddText = ddText || a.consultedDdText === true;
        // P7b (N15, C24): a replayed answer that consulted non-public Slack makes this turn's drafts private_slack.
        privateSlack = privateSlack || a.consultedPrivateSlack === true;
      }
      const contexts = await earlierContextRefs(principal, settings, earlier, current, now);
      const spent = await withOwnSignal(BUDGET_READ_MS, (signal) => chatSpentTodayUsd(principal, now, { signal }));
      prep = {
        input: baseInput({
          replay: buildReplay(earlier, tz),
          priorRefs: [...priorRefs.values()],
          // This turn's context first, so its (newest) ref is the one an item with the same target is given.
          contextRefs: [...baseInput({}).contextRefs, ...contexts],
          prior: { threads, clients, ddText, privateSlack },
          chatSpentAtStartUsd: spent
        })
      };
    } catch {
      // A history or budget read that fails ends the turn before any model call (fail closed).
      prep = { failed: true };
    }
    agent =
      "failed" in prep
        ? noModelResult("failed", "internal", FAILED_TEXT, begin.refSeq, emptyTurnUsage())
        : await runAgentTurn(principal, prep.input, { signal: opts.signal, sink: opts.sink, binding: opts.binding });
  }

  const finishInput: FinishTurnInput = {
    messageId: begin.assistantMessageId,
    status: agent.status,
    statusReason: agent.statusReason,
    refusalCategory: agent.refusalCategory,
    text: agent.answer,
    recommendations: agent.recommendations,
    sources: agent.cited,
    cards: agent.cards,
    toolCalls: agent.toolCalls,
    consultedEmailThreadIds: agent.consulted,
    consultedClientIds: agent.consultedClients,
    consultedDdText: agent.consultedDdText,
    usage: agent.usage,
    model: agent.model,
    refSeq: agent.refSeq,
    // P7b (D5, D6, N15): the Slack consults go with the answer, in the same transaction (RPC 9).
    slackRefs: agent.consultedSlack?.refs ?? [],
    slackChannels: agent.consultedSlack?.channels ?? [],
    privateSlack: agent.consultedSlack?.privateSlack === true
  };
  let saved = false;
  try {
    // B5: never the request's or the turn's signal.
    saved = await withOwnSignal(FINISH_TIMEOUT_MS, (signal) => finishTurn(principal, finishInput, { signal }));
  } catch {
    saved = false;
  }
  if (!saved) console.warn(`[exec-chat] finish not saved turn=${logId(begin.turnId)}`);

  const screenDecision = await postFinishScreen(principal, {
    messageId: begin.assistantMessageId,
    conversationId: begin.conversationId,
    sinceIso: begin.userCreatedAt,
    consulted: agent.consulted,
    ownDraftIds: agent.cards.filter((c) => c.kind === "draft").map((c) => c.id),
    checkEarlier: !historyKnown || history.earlier.length > 0,
    saved
  }).catch((): string | null => UNCHECKED_TEXT);

  // P7b (D5, §3.9): after P5b's C21 screen, an answer that consulted Slack is re-checked (RPC 11, its own controller): a
  // message, digest or channel it used that is already gone redacts it (and later answers); a check that can't run twice
  // hides this answer only (fail closed). Only when the screen left the answer shown. A finish that wasn't saved never
  // recorded the consults, so nothing could redact the answer later (P6 would keep it in the DM): it is hidden, and the
  // per-message write runs in case the finish committed after its deadline (the RPC refuses a row still running).
  let decision = screenDecision;
  if (decision === null && (agent.consultedSlack?.channels.length ?? 0) > 0) {
    if (!saved) {
      decision = SLACK_UNCHECKED_TEXT;
      const wrote = await attempt((signal) => redactChatMessage(principal, begin.assistantMessageId, SLACK_UNCHECKED_TEXT, { signal }));
      if (!wrote.ok) console.warn(`[exec-chat] redaction write failed message=${logId(begin.assistantMessageId)}`);
    } else {
      const recheck = await recheckSlackAnswer(principal, begin.assistantMessageId).catch((): "unchecked" => "unchecked");
      if (recheck === "redacted") decision = SLACK_REDACTED_TEXT;
      else if (recheck === "unchecked") decision = SLACK_UNCHECKED_TEXT;
    }
  }

  const answer = decision ?? agent.answer;
  const recommendations = decision ? "" : agent.recommendations;
  const cited = decision ? [] : agent.cited;
  let cards: CardView[] = [];
  try {
    const resolved = await withOwnSignal(SCREEN_TIMEOUT_MS, (signal) =>
      resolveCards(principal, [{
        messageId: begin.assistantMessageId,
        cards: agent.cards,
        privacy: agent.consulted.length > 0 || agent.consultedDdText || agent.consultedSlack?.privateSlack === true
      }], now, signal)
    );
    cards = resolved.get(begin.assistantMessageId) ?? [];
  } catch {
    // The stored cards stay; a reload of the conversation shows them. Draft cards need no read.
    cards = agent.cards.filter((c): c is Extract<ChatCard, { kind: "draft" }> => c.kind === "draft").map(draftCardView);
    console.warn(`[exec-chat] cards unavailable message=${logId(begin.assistantMessageId)}`);
  }

  const done: ChatDonePayload = {
    messageId: begin.assistantMessageId,
    conversationId: begin.conversationId,
    turnId: begin.turnId,
    conversationTitle: history.conversation?.title ?? newConversationTitle(req.text),
    status: agent.status,
    statusReason: agent.statusReason,
    answer,
    recommendations,
    sources: numberSources(cited, answer, recommendations),
    cards,
    saved
  };
  return {
    done,
    audit: {
      status: agent.status,
      statusReason: agent.statusReason,
      modelCalls: agent.usage.modelCalls,
      toolCalls: agent.usage.toolCalls,
      costUsd: agent.usage.costUsd,
      // P6 X1 (AM3, additive): the Slack clip's count for the turn's audit row; present only when > 0.
      ...(typeof agent.slackVerbatimClipped === "number" && agent.slackVerbatimClipped > 0 ? { slackVerbatimClipped: agent.slackVerbatimClipped } : {})
    }
  };
}

function emptyTurnUsage(): AgentTurnResult["usage"] {
  return {
    modelCalls: 0, toolCalls: 0, toolCallsNotPersisted: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, costUsd: 0, transformations: 0, unknownMarkers: 0, partialRoundUncounted: false,
    promptVersion: CHAT_PROMPT_VERSION, toolsVersion: TOOLS_VERSION
  };
}
