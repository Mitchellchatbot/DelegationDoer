import "server-only";

import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";

import { getAnthropic, resetAnthropic } from "@/lib/anthropic-client";
import {
  BudgetExceededError,
  NonRetryableError,
  type ErrorClass,
  type ExecLlmFeature,
  type ExecPrincipal
} from "@/lib/exec/types";
import { costUsd, isPricedModel } from "@/lib/exec/llm/models";
import { assertExecRequestShape, requiredBetas, type ExecRequestParams } from "@/lib/exec/llm/request";
import {
  LlmProtocolError,
  StreamAccumulator,
  StreamEventError,
  messageFromResponse,
  type ExecMessage
} from "@/lib/exec/llm/stream";
import { assertWithinDailyCap, recordUsage } from "@/lib/exec/llm/usage";

// The one place exec code calls the model.
//
// Every call: refuses unless EXEC_ENABLED, re-checks the request shape,
// checks the principal's daily cost cap, sends through the shared client
// (getAnthropic: platform fetch, key from env/Vault), reads the raw stream with
// our own accumulator, records usage (refusals included, and whatever a broken
// stream had already billed), and turns failures into LlmCallError with a
// class the job runner understands.

/** A failed model call, classified for the job runner (which reads `errorClass`). */
export class LlmCallError extends Error {
  /** HTTP status, or the status an error event's type maps to; null for network failures. */
  readonly status: number | null;
  readonly errorClass: ErrorClass;
  /** Anthropic's request id (request-id header), for support tickets and log correlation. */
  readonly requestId: string | null;
  /** The API error type, e.g. "overloaded_error", when one was given. */
  readonly errorType: string | null;
  constructor(
    message: string,
    init: { status: number | null; errorClass: ErrorClass; requestId?: string | null; errorType?: string | null; cause?: unknown }
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "LlmCallError";
    this.status = init.status;
    this.errorClass = init.errorClass;
    this.requestId = init.requestId ?? null;
    this.errorType = init.errorType ?? null;
  }
}

// API error types → the HTTP status they come with. Mid-stream `error` events
// carry only the type, so this is how they get classified like an HTTP error.
const ERROR_TYPE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isErrorClass(v: unknown): v is ErrorClass {
  return v === "retryable" || v === "fatal" || v === "auth";
}

interface ApiErrorInfo {
  type: string;
  message: string | null;
  requestId: string | null;
}

// The API's error object ({ type: "error", error: { type, message } }),
// wherever 0.32.1 left it: an HTTP error's APIError carries the parsed body in
// `error`; an SSE `error` event becomes an APIConnectionError (no status) whose
// message is the raw event JSON.
function apiErrorInfo(err: unknown): ApiErrorInfo | null {
  if (!isRecord(err)) return null;
  let body: unknown = err.error;
  if (!isRecord(body) && typeof err.message === "string" && err.message.startsWith("{")) {
    try {
      body = JSON.parse(err.message);
    } catch {
      return null; // an ordinary message that happens to start with "{"
    }
  }
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.type !== "string") return null;
  return {
    type: body.error.type,
    message: typeof body.error.message === "string" ? body.error.message : null,
    requestId: typeof body.request_id === "string" ? body.request_id : null
  };
}

function errorTypeOf(err: unknown): string | null {
  if (err instanceof StreamEventError) return err.errorType;
  return apiErrorInfo(err)?.type ?? null;
}

function statusOf(err: unknown): number | null {
  if (isRecord(err) && typeof err.status === "number" && Number.isInteger(err.status)) return err.status;
  const type = errorTypeOf(err);
  return type !== null && Object.prototype.hasOwnProperty.call(ERROR_TYPE_STATUS, type) ? ERROR_TYPE_STATUS[type] : null;
}

function requestIdOf(err: unknown): string | null {
  if (!isRecord(err)) return null;
  if (typeof err.request_id === "string" && err.request_id) return err.request_id;
  return apiErrorInfo(err)?.requestId ?? null;
}

function classForStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return "retryable";
  // 400 invalid request, 402 billing, 404 model/endpoint, 413 too large, 422: resending can't fix them.
  if (status >= 400) return "fatal";
  return "retryable";
}

/**
 * How the job runner should treat a model-call failure: a class set on the
 * error wins (LlmCallError, NonRetryableError, ExecRequestShapeError); a spent
 * budget is fatal for today; otherwise by status. Network failures, timeouts,
 * aborts, broken streams and anything unrecognised are retryable (bounded by
 * the job's max_attempts).
 */
export function classifyLlmError(err: unknown): ErrorClass {
  if (isRecord(err) && isErrorClass(err.errorClass)) return err.errorClass;
  if (err instanceof BudgetExceededError) return "fatal";
  if (err instanceof LlmProtocolError) return "retryable";
  const status = statusOf(err);
  return status === null ? "retryable" : classForStatus(status);
}

// The API's own sentence when there is one (0.32.1's message for an HTTP error
// is the whole JSON body), clipped: it ends up in exec_jobs.last_error.
function clipMessage(err: unknown): string {
  const raw = apiErrorInfo(err)?.message ?? (err instanceof Error ? err.message : String(err));
  return raw.length > 500 ? `${raw.slice(0, 499)}…` : raw;
}

function toLlmCallError(err: unknown, requestId: string | null): LlmCallError {
  if (err instanceof LlmCallError) return err;
  const status = statusOf(err);
  const errorType = errorTypeOf(err);
  const label = [status ?? "no status", errorType].filter(Boolean).join(" ");
  return new LlmCallError(`model call failed (${label}): ${clipMessage(err)}`, {
    status,
    errorClass: classifyLlmError(err),
    errorType,
    requestId: requestIdOf(err) ?? requestId,
    cause: err
  });
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "This operation was aborted", "AbortError");
}

// The forms a caller's abort takes on its way out of 0.32.1 and fetch: the
// SDK's APIUserAbortError (whenever it sees the signal aborted before the
// response starts; its name is plain "Error"), an AbortError from fetch or a
// body read, or the caller's own reason.
function isAbortLike(err: unknown, signal: AbortSignal): boolean {
  return err === signal.reason || err instanceof APIUserAbortError || (isRecord(err) && err.name === "AbortError");
}

// ---------------------------------------------------------------------------
// SDK boundary
// ---------------------------------------------------------------------------

/** The subset of 0.32.1's per-request options exec uses. */
interface SdkRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  maxRetries?: number;
}

interface WithResponse {
  withResponse(): Promise<{ data: unknown; response?: { headers?: { get(name: string): string | null } } }>;
}

function hasWithResponse(v: unknown): v is WithResponse {
  return typeof v === "object" && v !== null && "withResponse" in v && typeof v.withResponse === "function";
}

interface Opened {
  data: unknown;
  requestId: string | null;
}

async function open(client: Anthropic, body: Record<string, unknown>, options: SdkRequestOptions): Promise<Opened> {
  // 0.32.1's create() is typed for its own, older request params (no
  // output_config, adaptive thinking or strict tools). The body has passed
  // assertExecRequestShape; this cast is the single crossing into the SDK.
  const create = client.messages.create.bind(client.messages) as unknown as (b: unknown, o: SdkRequestOptions) => unknown;
  const pending = create(body, options);
  if (hasWithResponse(pending)) {
    // withResponse() also hands back the HTTP response, for its request-id.
    const { data, response } = await pending.withResponse();
    return { data, requestId: response?.headers?.get("request-id") ?? null };
  }
  return { data: await pending, requestId: null };
}

async function openWithAuthRetry(body: Record<string, unknown>, options: SdkRequestOptions): Promise<Opened> {
  try {
    return await open(await getAnthropic(), body, options);
  } catch (err) {
    if (statusOf(err) !== 401 || options.signal?.aborted) throw err;
    // The client caches the key it was built with; a 401 usually means that
    // key went stale (rotated in Vault). Rebuild client + key and try once
    // more, as daily-briefing-runner does. A 401 can only come back before any
    // event is read, so nothing has been streamed to the caller yet.
    resetAnthropic();
    return open(await getAnthropic(), body, options);
  }
}

function asEvents(data: unknown): AsyncIterable<unknown> {
  if (typeof data === "object" && data !== null && Symbol.asyncIterator in data) return data as AsyncIterable<unknown>;
  throw new LlmProtocolError("a streaming request did not return an event stream", null);
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === "object" && v !== null && "then" in v && typeof v.then === "function";
}

// A UI sink that fails (a closed SSE connection, say) must not lose the turn:
// the message is still assembled and recorded. The first failure is logged and
// the sink is dropped. An async sink (a stream writer's write()) fails by
// rejecting, not throwing, so a returned promise is watched too; unwatched,
// each one would be an unhandled rejection and the sink would never be
// dropped. Rejections that arrive after the first are caught and not logged.
// Disconnects should also abort `signal` to stop paying.
function guardSink(
  sink: CallModelInput["onTextDelta"],
  feature: ExecLlmFeature
): ((text: string, index: number) => void) | undefined {
  if (!sink) return undefined;
  let broken = false;
  const fail = (err: unknown): void => {
    if (broken) return;
    broken = true;
    console.warn(`[exec-llm] ${feature}: onTextDelta failed, no further deltas forwarded:`, err instanceof Error ? err.message : err);
  };
  return (text, index) => {
    if (broken) return;
    try {
      const pending: unknown = sink(text, index);
      if (isThenable(pending)) pending.then(undefined, fail);
    } catch (err) {
      fail(err);
    }
  };
}

// The API echoes the requested id; if it ever sends one we can't price, price
// what we asked for (pricing an unknown Haiku id as Opus would over-count 40x).
function pricedModel(responseModel: string, requestModel: string): string {
  return responseModel && isPricedModel(responseModel) ? responseModel : requestModel;
}

// ---------------------------------------------------------------------------
// callModel
// ---------------------------------------------------------------------------

export interface CallModelInput {
  /** null only for system work with no principal: no budget check, usage recorded without one. */
  principal: ExecPrincipal | null;
  feature: ExecLlmFeature;
  /** Normally from buildExecRequest; checked again here whoever built it. */
  request: ExecRequestParams;
  /** Aborts the HTTP request. Pass the job's or the route's signal. */
  signal?: AbortSignal;
  /** Default: true for chat/draft/brief/voice, false for triage/digest/spike. */
  stream?: boolean;
  /** Extra anthropic-beta values. Betas the body needs (block_binding) are added automatically. */
  betas?: string[];
  /**
   * Text as it streams (streaming calls only). May be async; it is not awaited,
   * so an async sink keeps its own order (a stream writer does). A throw or a
   * rejection is logged once, stops further deltas, and never fails the call.
   * Typed `unknown` rather than `void | Promise<void>`: the return value is
   * inspected for a promise, and that union would refuse plain sinks like
   * `(t) => res.write(t)`, which return a boolean.
   */
  onTextDelta?: (text: string, blockIndex: number) => unknown;
  skipBudgetCheck?: boolean;
  /** SDK retries before the response starts (SDK default 2). */
  maxRetries?: number;
}

export interface CallModelResult {
  message: ExecMessage;
  /** stop_reason "refusal": any content is a partial answer to discard, not show or replay. */
  refused: boolean;
  /**
   * stop_reason "max_tokens" or "model_context_window_exceeded": the output was
   * cut off. Thinking counts toward max_tokens, so on a hard turn this can mean
   * a short or even empty answer. Not an error at this layer; a caller that
   * needs the whole answer (the brief, structured output) must not deliver it
   * as finished.
   */
  truncated: boolean;
  costUsd: number;
  latencyMs: number;
  requestId: string | null;
}

const STREAM_BY_DEFAULT: ReadonlySet<ExecLlmFeature> = new Set<ExecLlmFeature>(["chat", "draft", "brief", "voice"]);

const TRUNCATING_STOPS: ReadonlySet<string> = new Set(["max_tokens", "model_context_window_exceeded"]);

/**
 * Call the model once. Throws: ExecRequestShapeError for a request the 5.5
 * models would reject, NonRetryableError when exec is disabled,
 * BudgetExceededError past the daily cap (no API call is made in any of those),
 * the caller's own abort error (`signal.reason` when it is an Error, else an
 * AbortError) once `signal` has aborted, however far the call had got, and
 * LlmCallError for everything else.
 */
export async function callModel(input: CallModelInput): Promise<CallModelResult> {
  const { principal, feature, request, signal } = input;
  // A malformed request is a bug wherever it runs, so it is reported first.
  assertExecRequestShape(request);
  if (process.env.EXEC_ENABLED !== "true") {
    throw new NonRetryableError('exec assistant is disabled (EXEC_ENABLED is not "true")');
  }
  if (signal?.aborted) throw abortError(signal);
  if (principal && !input.skipBudgetCheck) {
    await assertWithinDailyCap(principal);
    // The cap read is a database round trip. An abort that lands during it
    // shouldn't go on to build a client (which can mean a Vault read).
    if (signal?.aborted) throw abortError(signal);
  }

  const stream = input.stream ?? STREAM_BY_DEFAULT.has(feature);
  const betas = [...new Set([...(input.betas ?? []), ...requiredBetas(request)])];
  const options: SdkRequestOptions = {
    ...(signal ? { signal } : {}),
    ...(betas.length > 0 ? { headers: { "anthropic-beta": betas.join(",") } } : {}),
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {})
  };
  const body: Record<string, unknown> = { ...request, stream };
  const principalId = principal?.id ?? null;

  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  let requestId: string | null = null;
  let acc: StreamAccumulator | null = null;

  try {
    const opened = await openWithAuthRetry(body, options);
    requestId = opened.requestId;
    let message: ExecMessage;
    if (stream) {
      acc = new StreamAccumulator({ onTextDelta: guardSink(input.onTextDelta, feature) });
      for await (const event of asEvents(opened.data)) acc.push(event);
      // 0.32.1's Stream ends quietly (no throw) when its signal aborts mid-body.
      if (!acc.complete && signal?.aborted) throw abortError(signal);
      message = acc.finish();
    } else {
      message = messageFromResponse(opened.data);
    }

    const latencyMs = elapsed();
    const model = pricedModel(message.model, request.model);
    if (message.unknownDeltas > 0 || message.toolInputErrors.length > 0) {
      console.warn(
        `[exec-llm] ${feature}: ${message.unknownDeltas} unapplied stream events and ` +
          `${message.toolInputErrors.length} unparseable tool inputs (request ${requestId ?? "n/a"}); not replayable`
      );
    }
    await recordUsage({ principalId, feature, model, usage: message.usage, latencyMs, stopReason: message.stop_reason, requestId });
    const truncated = message.stop_reason !== null && TRUNCATING_STOPS.has(message.stop_reason);
    if (truncated) {
      // Logged so caps that are too tight show up before anyone reads a cut-off answer.
      console.warn(
        `[exec-llm] ${feature}: stopped at ${message.stop_reason} (max_tokens ${request.max_tokens}, ` +
          `output_tokens ${String(message.usage.output_tokens ?? "unknown")}, request ${requestId ?? "n/a"}); the answer is cut off`
      );
    }
    return {
      message,
      refused: message.stop_reason === "refusal",
      truncated,
      costUsd: costUsd(model, message.usage),
      latencyMs,
      requestId
    };
  } catch (err) {
    const aborted = signal?.aborted === true;
    // Input tokens are billed from message_start on: put them on the books
    // before reporting the failure, so the cost cap sees them.
    if (acc?.started) {
      const partial = acc.message;
      await recordUsage({
        principalId,
        feature,
        model: pricedModel(partial.model, request.model),
        usage: partial.usage,
        latencyMs: elapsed(),
        stopReason: aborted ? "aborted" : "error",
        requestId
      });
    }
    if (aborted && signal) {
      // One identity for a cancelled call, however the SDK surfaced the abort:
      // APIUserAbortError while the request was in flight (for a non-streamed
      // call, the whole generation), an AbortError from a body read, a quiet
      // end mid-stream. So `err === signal.reason` is a test callers can rely
      // on. A real failure that raced the abort (a 401, a client that couldn't
      // be built) is logged here rather than lost.
      if (!isAbortLike(err, signal)) {
        const failure = toLlmCallError(err, requestId);
        console.warn(
          `[exec-llm] ${feature}: aborted by the caller; the call had also failed: ${failure.message} ` +
            `(request ${failure.requestId ?? "n/a"})`
        );
      }
      throw abortError(signal);
    }
    throw toLlmCallError(err, requestId);
  }
}
