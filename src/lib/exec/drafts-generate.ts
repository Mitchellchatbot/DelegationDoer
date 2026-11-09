import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { buildBody, docFromModelOutput, findPlaceholders, parseDraftOutput, scanDraftOutput, validateBodyDoc, type ScanContext } from "@/lib/exec/drafts-doc";
import { assertPackAllowed, buildDraftPack, buildDraftRequest, draftPackSources, type DraftPack, type PackSources } from "@/lib/exec/drafts-pack";
import { auditCode, type DraftPatch } from "@/lib/exec/drafts-state";
import { casDraft, getDraft, purgeDraftsForThreads } from "@/lib/exec/drafts-store";
import { DRAFT_LIMITS, type DraftUsage, type ExecDraftRow, type FactsStatus, type GenerationError, type GenerationFlag } from "@/lib/exec/drafts-types";
import { voiceRefreshNow } from "@/lib/exec/handlers/voice-refresh";
import { SCREEN_HASH_LIMIT } from "@/lib/exec/email-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel, LlmCallError, type CallModelResult } from "@/lib/exec/llm/client";
import { cacheWriteSplit } from "@/lib/exec/llm/models";
import { ExecRequestShapeError, type ExecRequestParams } from "@/lib/exec/llm/request";
import { messageText } from "@/lib/exec/llm/stream";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { getEaReadiness, pinnedAccounts, usableAccounts } from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, problemAccountIds } from "@/lib/exec/sync-state";
import { localDateString } from "@/lib/exec/time";
import { BudgetExceededError, NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";

// The exec.draft-generate body (P4 contract §3.9.2, L6, C55, C65, C72; Area C).
//
// One run: the row and its generation fence, the gates, the pack, one model
// call under its own 120 s deadline, the parse, the code-built doc, the output
// scan, then exactly one counted CAS (T05 on success, T06/T07 on a content
// failure). Content failures are written, never thrown (C55): only the job's
// own DB writes may throw, and the stale sweep recovers the row. Every outcome
// write runs on a fresh 10 s signal, never the job's (C72): a write that
// inherited an aborted job signal would abort and leave the row generating.
// What leaves this module is ids, codes and a cost: the audit event, the log
// lines and the return value carry no draft text.

export interface GenerationResult { draftId: string; outcome: "ok" | GenerationError | "skipped"; costUsd: number | null }

const SCAN_NAMES_TIMEOUT_MS = 5_000;
/**
 * C72 (data-5): the model call ends this long after the run began, so the
 * 150 s job timeout (handlers/draft-generate.ts) never fires first: 10 s stay
 * for the outcome write. The gates and the pack spend part of it.
 */
const GENERATION_RUN_BUDGET_MS = 140_000;
/** Less than this left for the model: no call, the run fails as a timeout. */
const MIN_MODEL_MS = 10_000;
const DAY_MS = 86_400_000;
const VOICE_FRESH_MS = 8 * DAY_MS;

class DeadlineError extends Error {
  constructor() {
    super("draft generation deadline");
    this.name = "DeadlineError";
  }
}

/**
 * C72: a signal aborted by `parent` or by an unref'd timer after `ms`,
 * whichever comes first, without assuming AbortSignal.any. dispose() detaches
 * the listener and the timer once the call is over.
 */
export function deadlineSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DeadlineError()), ms);
  if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    }
  };
}

/** The fresh signal every outcome write gets (C72). */
const writeSignal = () => AbortSignal.timeout(DRAFT_LIMITS.outcomeWriteTimeoutMs);

const errorName = (err: unknown): string => (err instanceof Error && err.name !== "" ? err.name : "error");

function usageOf(result: CallModelResult): DraftUsage {
  const u = result.message.usage ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: cacheWriteSplit(u).total,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    requestId: result.requestId
  };
}

function domainOf(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at > 0 && at < a.length - 1 ? a.slice(at + 1) : "";
}

/** T06 / T07: the content failure, keyed on G; false when the CAS matched no row. */
async function writeFailure(principal: ExecPrincipal, row: ExecDraftRow, seq: number, code: GenerationError, now: Date): Promise<boolean> {
  const patch: DraftPatch =
    row.priorStatus === null
      ? { status: "generation_failed", generation_error: code, prior_status: null, next_check_at: null }
      : {
          status: row.priorStatus,
          generation_error: code,
          last_error_code: `generation_${code}`,
          last_error_at: now.toISOString(),
          prior_status: null,
          next_check_at: null
        };
  return casDraft(principal, row.id, { status: "generating", version: row.version, generationSeq: seq }, patch, { signal: writeSignal() });
}

async function recordOutcome(principal: ExecPrincipal, draftId: string, outcome: "ok" | "skipped" | "restricted", costUsd: number | null,
  factsStatus: FactsStatus | null, generationSeq: number, flags: GenerationFlag[]): Promise<void> {
  await auditEvent(principal, {
    actor: "job",
    action: "draft.generate",
    target: `exec_drafts:${draftId}`,
    input: { draftId, outcome, costUsd, factsStatus, generationSeq, flags }
  });
}

async function recordFailure(principal: ExecPrincipal, draftId: string, outcome: GenerationError | "skipped", code: GenerationError,
  costUsd: number | null, generationSeq: number): Promise<void> {
  const error = `generation_${code}`;
  await auditEvent(principal, {
    actor: "job",
    action: "draft.generate",
    target: `exec_drafts:${draftId}`,
    input: { draftId, outcome, costUsd, generationSeq },
    error: auditCode(error)
  });
}

/** C65: the names for the scan, read within a short timeout; a failure skips the name checks (one log line, a code only). */
async function scanNamesWithin(sources: PackSources, principal: ExecPrincipal, clientId: string | null, draftId: string, ms: number):
  Promise<{ clientNames: string[] | null; userNames: string[] | null; internalDomains: string[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
    if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as { unref(): void }).unref();
  });
  try {
    const r = await Promise.race([sources.scanNames(principal, clientId), timeout]);
    return { clientNames: r.clientNames, userNames: r.userNames, internalDomains: r.internalDomains ?? [] };
  } catch (err) {
    console.warn(`[exec-drafts] generation ${draftId}: the name read was skipped (${errorName(err)})`);
    return { clientNames: null, userNames: null, internalDomains: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** §3.10: the lazy voice build when the profile is missing or more than 8 days old; one job per local day. */
async function queueVoiceRefresh(principal: ExecPrincipal, sources: PackSources, now: Date): Promise<void> {
  try {
    const profile = await sources.voiceProfile(principal);
    if (profile !== null && now.getTime() - Date.parse(profile.builtAt) <= VOICE_FRESH_MS) return;
    await enqueueJob(voiceRefreshNow(principal, localDateString(now, principal.timezone)));
  } catch (err) {
    console.warn(`[exec-drafts] voice refresh not queued (${errorName(err)})`);
  }
}

/** P5b F9 (C44): the code-written sentence a chat-started draft's note starts with while the assistant wrote its instruction. */
export const CHAT_INSTRUCTION_NOTE = "Started from Chat: the assistant wrote this draft's instruction, not you.";

/** T05's note_for_mitchell: the model's note (null when empty); F9 puts the provenance sentence first, clipped to P4's limit. */
export function noteFor(row: Pick<ExecDraftRow, "instructionBy">, modelNote: string): string | null {
  if (row.instructionBy !== "assistant") return modelNote === "" ? null : modelNote;
  const note = modelNote === "" ? CHAT_INSTRUCTION_NOTE : `${CHAT_INSTRUCTION_NOTE} ${modelNote}`;
  return note.length > DRAFT_LIMITS.noteChars ? note.slice(0, DRAFT_LIMITS.noteChars).trimEnd() : note;
}

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])].sort();

/**
 * C11 on T05: the stored and fresh screen hashes, capped at the column's
 * CHECK (cardinality <= SCREEN_HASH_LIMIT) the way the review path caps them;
 * past the cap the row is marked truncated (security-4).
 */
function screenPatch(row: ExecDraftRow, pack: DraftPack): DraftPatch {
  const merged = union(row.screenHashes, pack.screenHashes);
  return {
    screen_hashes: merged.slice(0, SCREEN_HASH_LIMIT),
    screen_truncated: row.screenTruncated || pack.screenTruncated || merged.length > SCREEN_HASH_LIMIT,
    ...(pack.screenedPolicyHash ? { screened_policy_hash: pack.screenedPolicyHash } : {})
  };
}

/**
 * The exec.draft-generate body (§3.11). Content failures never throw (C55).
 * Steps: (1) the row, status and seq fence; (2) the gates (settings, pin,
 * usable account, EA readiness: C24/C25) → `stale`; (3) the pack → its error,
 * or the restricted purge (T08); (4) the pack guard; (5) the model call under
 * the 120 s deadline; (6)-(8) refusal, truncation, parse, doc, body; (8b) the
 * output scan; (9) the T05 CAS; (10) the audit event; (11) the lazy voice
 * build; (12) ids and codes only.
 */
export async function runDraftGeneration(input: {
  principal: ExecPrincipal; draftId: string; seq: number; signal: AbortSignal; now?: () => Date; sources?: PackSources;
}): Promise<GenerationResult> {
  const { principal, draftId, seq, signal } = input;
  const now = input.now ?? (() => new Date());
  const startedMs = now().getTime();
  const sources = input.sources ?? draftPackSources();
  const skipped: GenerationResult = { draftId, outcome: "skipped", costUsd: null };

  // 1. The row and the fence (C6, C71): a newer request or a stop makes this run a no-op.
  const row = await getDraft(principal, draftId, { signal });
  if (row === null || row.status !== "generating" || row.generationSeq !== seq) return skipped;

  const failure = async (code: GenerationError, costUsd: number | null): Promise<GenerationResult> => {
    const landed = await writeFailure(principal, row, seq, code, now());
    const outcome: GenerationError | "skipped" = landed ? code : "skipped";
    await recordFailure(principal, draftId, outcome, code, costUsd, seq);
    return { draftId, outcome, costUsd };
  };

  // 2. The gates (L1, C24, C25).
  const settings = await loadSettings(principal.id);
  const on = settings.draftsSchemaReady && settings.draftsEnabled && settings.emailSchemaReady && settings.emailEnabled && pinnedAccounts(principal).length > 0;
  if (!on) return failure("stale", null);
  const accounts = (await getSyncState(principal, "mail", "accounts", parseAccountsState, { signal }))?.value ?? null;
  const usable = usableAccounts(principal, problemAccountIds(accounts));
  if (!usable.includes(row.accountId)) return failure("stale", null);
  const readiness = await getEaReadiness(principal);
  if (!readiness.ok) return failure("stale", null);

  // 3. The pack: the live read, both screens, the facts, the voice block.
  let pack: DraftPack;
  try {
    const built = await buildDraftPack(principal, row, sources, now(), signal, { usable });
    if (!built.ok) {
      if (built.error === "restricted") {
        // T08: no model call; the purge closes or reverts the row and empties its content.
        if (row.threadId !== null) await purgeDraftsForThreads(principal, [row.threadId], { signal: writeSignal() });
        await recordOutcome(principal, draftId, "restricted", null, null, seq, []);
        return { draftId, outcome: "restricted", costUsd: null };
      }
      return failure(built.error, null);
    }
    pack = built.pack;
  } catch (err) {
    void err;
    return failure(signal.aborted ? "timeout" : "thread_unavailable", null);
  }

  // 4. Nothing but internal facts of the pack's own client (L11).
  assertPackAllowed(pack);

  // 5. One model call under the deadline (C72): Opus, structured output, no fallbacks, no streaming to anyone.
  // The deadline is 120 s or what is left of the run's budget, whichever is less (data-5).
  const modelMs = Math.min(DRAFT_LIMITS.generationDeadlineMs, startedMs + GENERATION_RUN_BUDGET_MS - now().getTime());
  if (modelMs < MIN_MODEL_MS) return failure("timeout", null);
  const deadline = deadlineSignal(signal, modelMs);
  let request: ExecRequestParams;
  let result: CallModelResult;
  try {
    request = buildDraftRequest(pack);
    result = await callModel({ principal, feature: "draft", request, signal: deadline.signal });
  } catch (err) {
    if (err instanceof BudgetExceededError) return failure("budget", null);
    if (deadline.signal.aborted) return failure("timeout", null);
    if (err instanceof ExecRequestShapeError) {
      void notifyOps({ key: "draft-generate-request-shape", title: "draft generation built a request the model would reject" });
      return failure("model_error", null);
    }
    if (err instanceof LlmCallError || err instanceof NonRetryableError) return failure("model_error", null);
    throw err;
  } finally {
    deadline.dispose();
  }
  const costUsd = result.costUsd;

  // 6-8. The answer: refusal before parsing; truncation; the parse; the code-built doc, validated before it is rendered.
  if (result.refused) return failure("declined", costUsd);
  if (result.truncated) return failure("truncated", costUsd);
  const parsed = parseDraftOutput(messageText(result.message), row.kind);
  if (!parsed.ok) return failure("invalid_output", costUsd);
  const doc = docFromModelOutput(parsed.out);
  const valid = validateBodyDoc(doc);
  if (!valid.ok) return failure("invalid_output", costUsd);
  const built = buildBody(valid.doc);
  if (built.empty) return failure("invalid_output", costUsd);

  // 8b. The output scan (C65): codes only.
  const names = await scanNamesWithin(sources, principal, pack.clientId, draftId, SCAN_NAMES_TIMEOUT_MS);
  const ctx: ScanContext = {
    // P5b F6 (C44): only his own instruction allows what it names; one the chat assistant wrote allows nothing, so a
    // link, address, phone, amount, number or name found only there is flagged (unexpected_content at review).
    instruction: row.instructionBy === "owner" ? row.instruction : null,
    factLines: pack.facts.map((f) => f.line),
    ownDomains: new Set([domainOf(principal.email)].filter((d) => d !== "")),
    internalDomains: new Set(names.internalDomains),
    recipients: new Set([...row.toRecipients, ...row.ccRecipients, ...row.bccRecipients].map((a) => a.address.trim().toLowerCase())),
    clientNames: names.clientNames,
    userNames: names.userNames,
    // P7b E7 (C34): a client update keeps the other-client check even for names in his words.
    strictClientNames: row.purpose === "client_update"
  };
  const flags = scanDraftOutput(parsed.out, ctx);

  // 9. T05: one counted CAS on G; zero rows (a purge, a stop or a newer request) drops the output.
  const subject = row.kind === "new" ? parsed.out.subject : null;
  const patch: DraftPatch = {
    status: "draft",
    version: row.version + 1,
    body_doc: valid.doc,
    body_html: built.html,
    body_text: built.text,
    placeholders: findPlaceholders(`${built.text}\n${subject ?? ""}`),
    note_for_mitchell: noteFor(row, parsed.out.noteForMitchell),
    ...(row.kind === "new" ? { subject } : {}),
    model: request.model,
    usage: usageOf(result),
    facts_status: pack.factsStatus,
    client_id: pack.clientId,
    generation_flags: flags,
    generated_at: now().toISOString(),
    // P7b E4 (C9): the version this generation produced, so a later edit (version moves) is told apart from it; and,
    // for a client update, the pack's slot record (counts and statuses only).
    generated_version: row.version + 1,
    ...(row.purpose === "client_update" ? { client_update_facts: pack.clientUpdate ?? null } : {}),
    generation_error: null,
    prior_status: null,
    next_check_at: null,
    ...(row.kind === "reply" ? screenPatch(row, pack) : {})
  };
  const landed = await casDraft(principal, draftId, { status: "generating", version: row.version, generationSeq: seq }, patch, { signal: writeSignal() });
  if (!landed) {
    await recordOutcome(principal, draftId, "skipped", costUsd, pack.factsStatus, seq, flags);
    return { draftId, outcome: "skipped", costUsd };
  }

  // 10. The audit event: ids, codes, the cost.
  await recordOutcome(principal, draftId, "ok", costUsd, pack.factsStatus, seq, flags);

  // 11. The lazy voice build.
  if (settings.voiceEnabled) await queueVoiceRefresh(principal, sources, now());

  return { draftId, outcome: "ok", costUsd };
}
