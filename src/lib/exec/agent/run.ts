import "server-only";

import { chatSpentTodayUsd, effectiveChatCapUsd } from "@/lib/exec/agent/budget";
import { CHAT_PROMPT_VERSION, CHAT_SYSTEM_PROMPT_V3, principalBlock, SLACK_SURFACE_PROMPT } from "@/lib/exec/agent/prompt";
import { RefRegistry, threadOfTarget } from "@/lib/exec/agent/refs";
import { ConsultedBudget, SlackConsultedBudget } from "@/lib/exec/agent/serialize";
import { linkSignals, semaphore, withOwnSignal, type LinkedSignal } from "@/lib/exec/agent/signal";
import { CHAT_TOOLS, CHAT_TOOL_DEFS, TOOLS_VERSION } from "@/lib/exec/agent/tool-defs";
import { createTurnMemo, executeToolCall, type ToolContext } from "@/lib/exec/agent/tools";
import {
  CHAT_TOOL_NAMES,
  type AgentEventSink,
  type ChatCard,
  type ChatStatus,
  type ChatStatusReason,
  type CitedSource,
  type PersistedToolCall,
  type RefEntry,
  type ResolvedContext,
  type ToolErrorCode,
  type ToolName,
  type TurnUsage
} from "@/lib/exec/agent/types";
import { clipUnits, finalizeAnswer, wellFormedText } from "@/lib/exec/chat/answer";
import {
  CAPPED_NOTE,
  CHAT_PAUSED_TEXT,
  DEADLINE_NOTE,
  FAILED_TEXT,
  REFUSED_TEXT,
  TOOL_BUDGET_RESULT,
  TOO_MANY_TOOLS_RESULT,
  TRUNCATED_NOTE
} from "@/lib/exec/chat/copy";
import { reportBindingTransformations } from "@/lib/exec/llm/binding-alert";
import { callModel } from "@/lib/exec/llm/client";
import { cacheWriteSplit, OPUS_MODEL, type ExecUsage } from "@/lib/exec/llm/models";
import {
  buildExecRequest,
  ExecRequestShapeError,
  type ExecContentBlockParam,
  type ExecMessageParam,
  type ExecRequestParams,
  type ExecToolResultBlockParam,
  type ExecToolUseBlock,
  type ThinkingBindingBehavior
} from "@/lib/exec/llm/request";
import { isReplayable, messageText, toolUses, type ExecMessage } from "@/lib/exec/llm/stream";
import { clipVerbatimRuns } from "@/lib/exec/slack-excerpt";
import { SLACK_LIMITS } from "@/lib/exec/slack-types";
import { BudgetExceededError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";

// The chat loop (P5b contract §3.14, B4, C1-C3, C11-C17, C39-C41, C55; Area
// C; server-only). Hand-built on P2a's callModel: Opus 5.5, effort medium,
// adaptive thinking with the API's default display (C2), strict tools,
// tool_choice auto. One turn = at most 12 model calls; between calls the tool
// round runs (≤ 8 tool calls, 4 at a time). Every failure is a status, never
// a throw (runAgentTurn never throws); the caller persists the result.
//
// What makes it safe to replay and cheap to repeat:
//   * the assistant content of each round goes back verbatim (thinking blocks
//     with their signatures, tool_use), minus empty text blocks;
//   * tools, tool_choice, system, thinking and output_config are the same
//     bytes in every call of the turn (B4);
//   * exactly two cache breakpoints per request: the builder's last system
//     block and one moving marker on the last block of the newest user
//     message (C3). Markers live only on the copies a request is built from,
//     never on the turn's history, so no earlier block keeps one.
//
// Content never leaves through a log: one line per turn (ids, counts, a
// cost), one line for a failing UI sink, and the binding count through
// llm/binding-alert.ts (coherence-15). Never notifyOps here.

export const CHAT_LIMITS = Object.freeze({
  maxModelCalls: 12, turnCostCeilingUsd: 1.5, toolConcurrency: 4, maxToolCallsPerRound: 8,
  cloneConcurrency: 4, softDeadlineMs: 360_000, hardDeadlineMs: 540_000,
  maxProposalsPerTurn: 5, maxDraftsPerTurn: 3, maxPersistedToolCalls: 100, maxConsultedThreads: 500,
  // P7b (N15): exec_messages_slack_refs_check / exec_messages_slack_channels_check.
  maxSlackRefs: 600, maxSlackChannels: 200
});

/** The §2.1 CHECK bounds the finish write must fit (the code keeps tighter limits; these are the backstop). */
const MAX_STORED_CARDS = 10;
const MAX_STORED_CONSULTED = 600;
const MAX_STORED_CLIENTS = 500;
const RECORD_ARG_CHARS = 500;
const LIVE_SPEND_READ_MS = 5_000;
const REFUSAL_CATEGORY_CHARS = 60;
const MODEL_CHARS = 64;

export interface AgentTurnInput {
  conversationId: string; assistantMessageId: string; turnId: string; surface: "web" | "slack";
  replay: ExecMessageParam[];            // buildReplay(...)
  userTurnText: string;                  // buildUserTurnText(...)
  priorRefs: readonly RefEntry[];        // refs cited in earlier answers
  contextRefs: readonly RefEntry[];      // earlier questions' context refs (re-resolved) + this turn's (b-agent-8)
  refSeq: number;
  context: ResolvedContext | null;
  prior: { threads: ReadonlySet<string>; clients: ReadonlySet<string>; ddText: boolean;   // C24
    /** P7b (N15, C24; optional): any replayed answer consulted non-public Slack. */
    privateSlack?: boolean };
  /** P7b (C8, C30; optional): his stored question text this turn (req.text); only prepare_client_update reads it. */
  question?: string;
  chatSpentAtStartUsd: number;
  settings: ExecSettings; now: Date;
}

export interface AgentDeps {
  callModel: typeof callModel; executeToolCall: typeof executeToolCall; nowMs: () => number;
  chatSpentTodayUsd: typeof chatSpentTodayUsd;          // C17: re-read after every call that asked for tools
}

export interface AgentTurnOptions {
  signal: AbortSignal;                   // web: the request's signal; Slack (P6): the job's signal
  sink?: AgentEventSink;
  binding?: ThinkingBindingBehavior;     // default "drop_block"; tests and the eval pass "error" (B4)
  deps?: Partial<AgentDeps>;
}

export interface AgentTurnResult {
  status: Exclude<ChatStatus, "running">; statusReason: ChatStatusReason | null; refusalCategory: string | null;
  answer: string; recommendations: string; cited: CitedSource[]; cards: ChatCard[];
  toolCalls: PersistedToolCall[];        // ≤ 100 (C14)
  consulted: string[];                   // ≤ 560: tools and intake (≤ 500) ∪ cited sources' threads (≤ 60) (C19, C41)
  consultedClients: string[]; consultedDdText: boolean;   // C24
  refSeq: number; usage: TurnUsage; model: string;
  streamedText: boolean;
  /** P6 X1 (additive): on a Slack turn, how many verbatim runs of tool output the answer, the recommendations and staged tasks had clipped.
   *  Present only when > 0; a count for the turn's audit row, never persisted with the message (not in usage). */
  slackVerbatimClipped?: number;
  /** P7b (§3.17.3 D5, N15; additive): the turn's Slack consults (keys ≤ 600, channels ≤ 200, the private flag), for the v2
   *  finish and the post-finish recheck. Absent when the turn ended before its tools could run. */
  consultedSlack?: { refs: string[]; channels: string[]; privateSlack: boolean };
}

type ToolState = "running" | "done" | "error" | "skipped";

interface Ending {
  status: Exclude<ChatStatus, "running">;
  statusReason: ChatStatusReason | null;
  refusalCategory: string | null;
  answer: string;
  recommendations: string;
  cited: CitedSource[];
}

type Exhausted = Extract<ChatStatusReason, "round_cap" | "cost_ceiling" | "chat_budget" | "deadline">;

const TOOL_NAME_SET: ReadonlySet<string> = new Set<string>(CHAT_TOOL_NAMES);
const isToolName = (name: unknown): name is ToolName => typeof name === "string" && TOOL_NAME_SET.has(name);

/** A turn id fit for a log line (ids only). */
function logId(id: string): string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "unknown";
}

function tokens(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** C55 (b-agent-6): every sink call in its own try/catch; the first failure is logged once by turn id. */
function guardedSink(sink: AgentEventSink | undefined, turnId: string): AgentEventSink {
  let reported = false;
  const guard = (fn: (s: AgentEventSink) => unknown): void => {
    if (!sink) return;
    const fail = () => {
      if (reported) return;
      reported = true;
      console.warn(`[exec-chat] sink failed turn=${logId(turnId)}`);
    };
    try {
      const pending: unknown = fn(sink);
      if (typeof pending === "object" && pending !== null && typeof (pending as PromiseLike<unknown>).then === "function") {
        (pending as PromiseLike<unknown>).then(undefined, fail);
      }
    } catch {
      fail();
    }
  };
  return {
    text: (round, delta) => guard((s) => s.text(round, delta)),
    tool: (e) => guard((s) => s.tool(e)),
    retract: () => guard((s) => s.retract())
  };
}

/** C3: the request's copy of the history with one marker, on the last block of the last (user) message. */
function withMovingMarker(messages: readonly ExecMessageParam[]): ExecMessageParam[] {
  const lastIndex = messages.length - 1;
  return messages.map((m, i) => {
    if (m.role !== "user") return m; // replayed and returned assistant content is never touched
    const blocks: ExecContentBlockParam[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const copy = blocks.map((b) => {
      if (typeof b !== "object" || b === null || !("cache_control" in b)) return b;
      const { cache_control: _drop, ...rest } = b as ExecContentBlockParam & { cache_control?: unknown };
      void _drop;
      return rest as ExecContentBlockParam;
    });
    if (i === lastIndex && copy.length > 0) {
      const last = copy.length - 1;
      copy[last] = { ...(copy[last] as object), cache_control: { type: "ephemeral" } } as ExecContentBlockParam;
    }
    return { role: m.role, content: copy };
  });
}

/** C1: empty text blocks are dropped from a returned message (the guard refuses them; the binding check ignores them). */
function dropEmptyTextBlocks(message: ExecMessage): ExecMessage {
  const content = message.content.filter((b) => !(b.type === "text" && typeof (b as { text?: unknown }).text === "string" && (b as { text: string }).text === ""));
  return content.length === message.content.length ? message : { ...message, content };
}

function errorResult(toolUseId: string, text: string): ExecToolResultBlockParam {
  return { type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }], is_error: true };
}

/** A result block the API accepts: never empty content (P2a's guard doesn't check tool_result content). */
function ensureContent(block: ExecToolResultBlockParam | undefined, use: ExecToolUseBlock, label: string): ExecToolResultBlockParam {
  const content = block?.content;
  const empty =
    content === undefined ||
    (typeof content === "string" && content.trim() === "") ||
    (Array.isArray(content) && (content.length === 0 || content.every((c) => c.type === "text" && (c as { text: string }).text.trim() === "")));
  if (!block || empty || block.tool_use_id !== use.id) {
    return errorResult(use.id, `${label} failed unexpectedly. Say this part couldn't be checked.`);
  }
  return block;
}

/** The persisted args of a call that never ran: primitives only, strings clipped to 500 (§3.11.1). */
function recordArgs(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input as Record<string, unknown>).slice(0, 20)) {
    // Clipped without leaving half a surrogate pair: Postgres's json refuses one and the whole finish would fail.
    const k = wellFormedText(clipUnits(key, 64));
    if (typeof v === "string") out[k] = wellFormedText(clipUnits(v, RECORD_ARG_CHARS));
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = null;
  }
  return out;
}

function emptyUsage(): TurnUsage {
  return {
    modelCalls: 0, toolCalls: 0, toolCallsNotPersisted: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, costUsd: 0, transformations: 0, unknownMarkers: 0, partialRoundUncounted: false,
    promptVersion: CHAT_PROMPT_VERSION, toolsVersion: "unknown"
  };
}

class ExecutorFailure extends Error {
  constructor() {
    super("tool executor failed");
    this.name = "ExecutorFailure";
  }
}

/** Never throws: every failure is a status. Surface-agnostic: P6 calls it with no sink. */
export async function runAgentTurn(principal: ExecPrincipal, input: AgentTurnInput, opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const deps: AgentDeps = {
    callModel,
    executeToolCall,
    nowMs: () => Date.now(),
    chatSpentTodayUsd,
    ...(opts?.deps ?? {})
  };
  const sink = guardedSink(opts?.sink, input.turnId);
  const usage = emptyUsage();
  const records: PersistedToolCall[] = [];
  const cards: ChatCard[] = [];
  const staged = { proposals: 0, drafts: 0 };
  const consultedClients = new Set<string>();
  let ddText = false;
  let consulted: ConsultedBudget | null = null;
  let slackConsulted: SlackConsultedBudget | null = null;
  let registry: RefRegistry | null = null;
  let turnSignal: LinkedSignal | null = null;
  let streamed = false;
  let model: string = OPUS_MODEL;
  // P6 X1: the text of every tool-result block the turn sent to the model (the corpus of the Slack clip).
  const toolResultTexts: string[] = [];
  // P6 X1: runs clipped from task proposals' text before propose_task staged it (counted with the answer's).
  let stagedVerbatimClipped = 0;
  const slackClipOpts = { maxRun: SLACK_LIMITS.verbatimRunChars, keep: SLACK_LIMITS.verbatimKeepChars };

  /**
   * P6 X1 (K12) for staged tasks: a proposal's title and description are model output that the Slack card shows in full
   * and that the stored row, its content hash and the confirm all carry. On a Slack turn they get the answer's clip
   * against every tool result the turn has delivered so far (a model can only copy what an earlier round returned)
   * before propose_task stages them, so the DM, the stored row and what he confirms stay one text. The model's own
   * tool_use block (its history) is unchanged.
   */
  const slackStagedUse = (use: ExecToolUseBlock): ExecToolUseBlock => {
    if (input.surface !== "slack" || use?.name !== "propose_task" || toolResultTexts.length === 0) return use;
    const args = use.input;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return use;
    const next: Record<string, unknown> = { ...args };
    let clipped = 0;
    for (const field of ["title", "description"] as const) {
      const value = args[field];
      if (typeof value !== "string") continue;
      const r = clipVerbatimRuns(value, toolResultTexts, slackClipOpts);
      if (r.clipped > 0) {
        next[field] = r.text;
        clipped += r.clipped;
      }
    }
    if (clipped === 0) return use;
    stagedVerbatimClipped += clipped;
    return { ...use, input: next };
  };

  const finish = (ending: Ending): AgentTurnResult => {
    // P6 X1 (contract §3.15.1, C27, K12): on Slack, no verbatim run of more than 300 characters of any tool result
    // leaves in the answer or the recommendations; the clipped text is what is stored, screened and shown.
    let e = ending;
    let slackVerbatimClipped = stagedVerbatimClipped;
    if (input.surface === "slack" && toolResultTexts.length > 0) {
      const answer = clipVerbatimRuns(e.answer, toolResultTexts, slackClipOpts);
      const recommendations = clipVerbatimRuns(e.recommendations, toolResultTexts, slackClipOpts);
      const outputClipped = answer.clipped + recommendations.clipped;
      slackVerbatimClipped += outputClipped;
      if (outputClipped > 0) e = { ...e, answer: answer.text, recommendations: recommendations.text };
    }
    let citedThreads: string[] = [];
    let toolThreads: string[] = [];
    try {
      citedThreads = e.cited.map((c) => threadOfTarget(c.target)).filter((t): t is string => typeof t === "string" && t !== "");
      toolThreads = consulted?.values() ?? [];
    } catch {
      // Fail closed below: the context thread at least.
      const t = input.context ? safeThreadOf(input.context) : null;
      toolThreads = t ? [t] : [];
    }
    const consultedIds = [...new Set([...toolThreads, ...citedThreads])].slice(0, MAX_STORED_CONSULTED);
    const result: AgentTurnResult = {
      status: e.status,
      statusReason: e.statusReason,
      refusalCategory: e.refusalCategory,
      answer: e.answer,
      recommendations: e.recommendations,
      cited: e.cited,
      cards: cards.slice(0, MAX_STORED_CARDS),
      toolCalls: records.slice(0, CHAT_LIMITS.maxPersistedToolCalls),
      consulted: consultedIds,
      consultedClients: [...consultedClients].slice(0, MAX_STORED_CLIENTS),
      consultedDdText: ddText,
      refSeq: registry?.refSeq ?? (Number.isSafeInteger(input.refSeq) ? input.refSeq : 0),
      usage: { ...usage, costUsd: Number(usage.costUsd.toFixed(6)) },
      model: model.slice(0, MODEL_CHARS),
      streamedText: streamed,
      ...(slackVerbatimClipped > 0 ? { slackVerbatimClipped } : {}),
      ...(slackConsulted !== null ? { consultedSlack: slackConsulted.snapshot() } : {})
    };
    // C12: a refused or failed answer takes back what was streamed (a refusal always sends it).
    if (e.status === "refused" || (e.status === "failed" && streamed)) sink.retract();
    const turn = logId(input.turnId);
    const reason = e.statusReason ?? "none";
    console.info(
      `[exec-chat] turn ${turn} status=${e.status} reason=${reason} calls=${usage.modelCalls} tools=${usage.toolCalls} ` +
        `cost=${usage.costUsd.toFixed(2)} unknownMarkers=${usage.unknownMarkers}`
    );
    if (usage.transformations > 0) void reportBindingTransformations(input.turnId, usage.transformations);
    return result;
  };

  const fixed = (status: Ending["status"], statusReason: ChatStatusReason | null, answer: string): Ending => ({
    status, statusReason, refusalCategory: null, answer, recommendations: "", cited: []
  });

  // fin(text, note?): the finishing pipeline, the note appended inside the 40,000 limit (C11, b-agent-5).
  const fin = (status: Ending["status"], statusReason: ChatStatusReason | null, raw: string, note?: string): Ending => {
    const refs = registry ?? { citable: () => null };
    const f = finalizeAnswer(raw, refs, { reserveChars: note ? note.length + 2 : 0 });
    usage.unknownMarkers += f.unknownMarkers;
    const answer = note ? (f.answer ? `${f.answer}\n\n${note}` : note) : f.answer;
    return { status, statusReason, refusalCategory: null, answer, recommendations: f.recommendations, cited: f.cited };
  };

  try {
    // C55: a signal already aborted (a Stop during begin) ends the turn at once, with no model call.
    if (opts.signal.aborted) return finish(fixed("aborted", "client_abort", ""));

    usage.toolsVersion = TOOLS_VERSION;
    turnSignal = linkSignals(opts.signal, CHAT_LIMITS.hardDeadlineMs);
    const turn = turnSignal;
    const startedMs = deps.nowMs();
    const refs = new RefRegistry({ refSeq: input.refSeq, prior: input.priorRefs, contexts: input.contextRefs });
    registry = refs;
    const budget = new ConsultedBudget(CHAT_LIMITS.maxConsultedThreads);
    consulted = budget;
    const contextThread = input.context ? threadOfTarget(input.context.target) : null;
    if (contextThread) budget.admit([contextThread]);
    // P7b (N15): the turn's Slack consults (≤ 600 keys, ≤ 200 channels, exec_messages' CHECKs).
    const slackBudget = new SlackConsultedBudget(CHAT_LIMITS.maxSlackRefs, CHAT_LIMITS.maxSlackChannels);
    slackConsulted = slackBudget;
    // C34: one prepare_client_update per turn; the first take() is true, every later one false.
    let clientUpdateTaken = false;
    const clientUpdateCalls = {
      take: (): boolean => {
        if (clientUpdateTaken) return false;
        clientUpdateTaken = true;
        return true;
      }
    };

    const cap = effectiveChatCapUsd(input.settings);
    if (cap <= 0 || !(input.chatSpentAtStartUsd < cap)) return finish(fixed("capped", "chat_budget", CHAT_PAUSED_TEXT));

    const memo = createTurnMemo(principal, input.settings, input.now, turn.signal);
    const cloneSlots = semaphore(CHAT_LIMITS.cloneConcurrency);
    const tools = [...CHAT_TOOL_DEFS];
    const labels = new Map<string, string>(CHAT_TOOLS.map((t) => [t.name, t.label]));
    const labelOf = (name: string) => labels.get(name) ?? "The tool";
    const system = [
      { type: "text" as const, text: CHAT_SYSTEM_PROMPT_V3 },
      { type: "text" as const, text: principalBlock(principal) },
      // P6 X2: the Slack surface block, constant per surface (the cached prefix holds).
      ...(input.surface === "slack" ? [{ type: "text" as const, text: SLACK_SURFACE_PROMPT }] : [])
    ];
    const messages: ExecMessageParam[] = [...input.replay, { role: "user", content: [{ type: "text", text: input.userTurnText }] }];
    const shared = {
      principal, settings: input.settings, now: input.now, refs, memo, cloneSlots, consulted: budget, consultedClients,
      markDdText: () => {
        ddText = true;
      },
      prior: input.prior, staged, cards, conversationId: input.conversationId, assistantMessageId: input.assistantMessageId,
      surface: input.surface,
      // P7b (§3.17.3 D2/D5, C8, C30, C34, N15).
      question: typeof input.question === "string" ? input.question : "",
      consultedSlack: slackBudget,
      clientUpdateCalls
    };
    const ctxFor = (round: number): ToolContext => ({ ...shared, round, signal: turn.signal });

    const emit = (round: number, index: number, use: ExecToolUseBlock, state: ToolState) => {
      if (!isToolName(use.name)) return;
      sink.tool({ round, callId: `${round}.${index}`, name: use.name, label: labelOf(use.name), state });
    };
    const keep = (r: PersistedToolCall) => {
      usage.toolCalls += 1;
      if (records.length < CHAT_LIMITS.maxPersistedToolCalls) records.push(r);
      else usage.toolCallsNotPersisted += 1;
    };
    const skippedRecord = (round: number, use: ExecToolUseBlock, error: ToolErrorCode): PersistedToolCall => ({
      round, name: (typeof use.name === "string" ? use.name.slice(0, 64) : "unknown") as ToolName, args: recordArgs(use.input), ok: false, error, ms: 0
    });

    // One tool round: ≤ 8 run (4 at a time), the rest get TOO_MANY_TOOLS_RESULT; results in tool_use order (C14).
    const runRound = async (round: number, uses: ExecToolUseBlock[]): Promise<ExecToolResultBlockParam[]> => {
      const blocks: ExecToolResultBlockParam[] = new Array(uses.length);
      const recs: (PersistedToolCall | undefined)[] = new Array(uses.length);
      const executed = uses.slice(0, CHAT_LIMITS.maxToolCallsPerRound);
      const pool = semaphore(CHAT_LIMITS.toolConcurrency);
      const settled = await Promise.allSettled(
        executed.map((use, i) =>
          pool.run(async () => {
            emit(round, i, use, "running");
            const out = await deps.executeToolCall(slackStagedUse(use), ctxFor(round));
            blocks[i] = ensureContent(out?.block, use, labelOf(use.name));
            recs[i] = out?.record ?? skippedRecord(round, use, "internal");
            emit(round, i, use, blocks[i].is_error ? "error" : "done");
          })
        )
      );
      if (settled.some((s) => s.status === "rejected")) throw new ExecutorFailure();
      uses.slice(CHAT_LIMITS.maxToolCallsPerRound).forEach((use, j) => {
        const i = CHAT_LIMITS.maxToolCallsPerRound + j;
        blocks[i] = errorResult(use.id, TOO_MANY_TOOLS_RESULT);
        recs[i] = skippedRecord(round, use, "too_many");
        emit(round, i, use, "skipped");
      });
      for (const r of recs) if (r) keep(r);
      return blocks;
    };

    let exhausted: Exhausted | null = null;
    let lastRoundText = "";
    const abortEnding = (raw: string): Ending =>
      turn.timedOut() ? fin("capped", "deadline", raw, DEADLINE_NOTE) : fin("aborted", "client_abort", raw);

    for (let call = 1; call <= CHAT_LIMITS.maxModelCalls; call++) {
      if (turn.signal.aborted) return finish(abortEnding(lastRoundText));
      let roundText = "";
      let request: ExecRequestParams;
      let result: Awaited<ReturnType<typeof callModel>>;
      try {
        request = buildExecRequest({ feature: "chat", system, messages: withMovingMarker(messages), tools, thinkingBinding: opts.binding ?? "drop_block" });
        usage.modelCalls += 1;
        result = await deps.callModel({
          principal,
          feature: "chat",
          request,
          signal: turn.signal,
          // b-agent-6: the buffer grows FIRST; the sink can't stop it (its calls are guarded).
          onTextDelta: (t: string) => {
            roundText += t;
            streamed = true;
            sink.text(call, t);
          }
        });
      } catch (err) {
        lastRoundText = roundText;
        if (err instanceof BudgetExceededError) return finish(fixed("capped", "daily_budget", CHAT_PAUSED_TEXT));
        if (err instanceof ExecRequestShapeError) return finish(fixed("failed", "internal", FAILED_TEXT));
        usage.partialRoundUncounted = true;
        if (turn.signal.aborted) return finish(abortEnding(roundText));
        return finish(fixed("failed", "model_error", FAILED_TEXT));
      }
      lastRoundText = roundText;

      const msg0 = result.message;
      const u: ExecUsage = msg0.usage ?? {};
      usage.inputTokens += tokens(u.input_tokens);
      usage.outputTokens += tokens(u.output_tokens);
      usage.cacheReadTokens += tokens(u.cache_read_input_tokens);
      usage.cacheWriteTokens += tokens(cacheWriteSplit(u).total);
      usage.costUsd += typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd > 0 ? result.costUsd : 0;
      usage.transformations += Array.isArray(msg0.input_transformations) ? msg0.input_transformations.length : 0;
      if (typeof msg0.model === "string" && msg0.model !== "") model = msg0.model;

      if (result.refused) {
        const category = msg0.stop_details?.category;
        return finish({
          ...fixed("refused", "refusal", REFUSED_TEXT),
          refusalCategory: typeof category === "string" && category !== "" ? category.slice(0, REFUSAL_CATEGORY_CHARS) : null
        });
      }

      const msg = dropEmptyTextBlocks(msg0);
      const uses = toolUses(msg);
      if (uses.length === 0) {
        if (result.truncated) return finish(fin("capped", "truncated", messageText(msg), TRUNCATED_NOTE));
        if (msg.unknownDeltas > 0 || (msg.stop_reason !== "end_turn" && msg.stop_reason !== "stop_sequence")) {
          return finish(fixed("failed", "protocol", FAILED_TEXT));
        }
        const f = fin("complete", null, messageText(msg));
        // b-agent-11: blank AFTER finalize (an image, an unknown marker, a definition, a bare heading) is no answer.
        if (f.answer.trim() === "" && f.recommendations.trim() === "") return finish(fixed("failed", "empty_answer", FAILED_TEXT));
        return finish(f);
      }
      if (result.truncated) return finish(fin("capped", "truncated", messageText(msg), TRUNCATED_NOTE));
      if (!isReplayable(msg)) return finish(fixed("failed", "protocol", FAILED_TEXT));
      if (exhausted) return finish(fin("capped", exhausted, messageText(msg), exhausted === "deadline" ? DEADLINE_NOTE : CAPPED_NOTE));

      // Verbatim: thinking blocks with their signatures, text, tool_use (B4).
      messages.push({ role: "assistant", content: msg.content });

      // C17 (b-security-11): the live chat spend, on its own short controller; a failed read fails closed.
      let live: number;
      try {
        live = await withOwnSignal(LIVE_SPEND_READ_MS, (signal) => deps.chatSpentTodayUsd(principal, input.now, { signal }));
      } catch {
        return finish(fin("capped", "chat_budget", messageText(msg), CAPPED_NOTE));
      }
      exhausted =
        call >= CHAT_LIMITS.maxModelCalls - 1 ? "round_cap"
        : usage.costUsd >= CHAT_LIMITS.turnCostCeilingUsd ? "cost_ceiling"
        : !(live < cap) ? "chat_budget"
        : deps.nowMs() - startedMs >= CHAT_LIMITS.softDeadlineMs ? "deadline"
        : null;

      let results: ExecToolResultBlockParam[];
      if (exhausted) {
        results = uses.map((use, i) => {
          emit(call, i, use, "skipped");
          keep(skippedRecord(call, use, "budget"));
          return errorResult(use.id, TOOL_BUDGET_RESULT);
        });
      } else {
        try {
          results = await runRound(call, uses);
        } catch {
          if (turn.signal.aborted) return finish(abortEnding(roundText));
          return finish(fixed("failed", "internal", FAILED_TEXT));
        }
      }
      // Every tool_result, in tool_use order, and nothing else (parallel results go back in one message).
      messages.push({ role: "user", content: results });
      if (input.surface === "slack") for (const block of results) toolResultTexts.push(...toolResultTextsOf(block));
      // An abort during the tools ends the turn: no further model call.
      if (turn.signal.aborted) return finish(abortEnding(roundText));
    }
    // Unreachable (exhaustion at call 11 makes call 12 final); kept so the loop can't fall through silently.
    return finish(fin("capped", "round_cap", lastRoundText, CAPPED_NOTE));
  } catch {
    try {
      return finish(fixed("failed", "internal", FAILED_TEXT));
    } catch {
      return {
        status: "failed", statusReason: "internal", refusalCategory: null, answer: FAILED_TEXT, recommendations: "", cited: [],
        cards: [], toolCalls: [], consulted: [], consultedClients: [], consultedDdText: ddText,
        refSeq: Number.isSafeInteger(input.refSeq) ? input.refSeq : 0, usage, model: OPUS_MODEL, streamedText: streamed
      };
    }
  } finally {
    turnSignal?.dispose();
  }
}

/** P6 X1: a tool_result block's text (string content, or each text block; images carry none). */
function toolResultTextsOf(block: ExecToolResultBlockParam): string[] {
  const content = block?.content;
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const c of content) if (c && c.type === "text" && typeof (c as { text?: unknown }).text === "string" && (c as { text: string }).text.length > 0) out.push((c as { text: string }).text);
  return out;
}

function safeThreadOf(context: ResolvedContext): string | null {
  const t = context.target;
  if (t.type === "email_thread") return t.id;
  if (t.type === "attention" || t.type === "commitment") return t.threadId;
  return null;
}
