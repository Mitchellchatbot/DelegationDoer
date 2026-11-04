import "server-only";

import { bounded } from "@/lib/agent-audit";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { AuditUnavailableError, type AuditEntry, type ExecPrincipal } from "@/lib/exec/types";

// exec_audit_log: every side effect the assistant takes, plus the reads and
// tool calls worth tracing.
//
// Side effects fail CLOSED. auditStart writes the row BEFORE the action and
// throws AuditUnavailableError when it can't, and the caller then doesn't act.
// Sending mail or posting as Mitchell without a record is worse than refusing.
// Everything after the action (auditFinish, auditEvent) never throws: by then
// the action has happened, and a logging failure must not turn into a 500
// that invites a retry.
//
// Rows never hold message bodies. sanitizeForAudit swaps anything under a
// body-like key for its size, then reuses agent-audit's redact/bounded:
// credential-named keys become "[redacted]", strings and arrays are capped,
// and the whole value's JSON stays within about 20,000 characters.

export interface AuditOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AuditEventEntry extends AuditEntry {
  /** Defaults to true unless `error` is set. */
  ok?: boolean;
  result?: unknown;
  error?: string;
}

const MAX_ERROR = 2_000;
const MAX_ACTION = 200;
const MAX_TARGET = 500;
// Same limits as agent-audit's redact(), which cuts anything deeper or longer
// anyway. Stopping the walk here too means a cyclic value can't loop forever.
const MAX_DEPTH = 6;
const MAX_ITEMS = 200;

// Keys whose values are message content: email and Slack bodies, model
// prompts and output, transcripts. The first list is the agreed one (exact key
// names). The second adds content fields that DD and its sources actually
// carry under other names: MissiveThread.last_snippet, Graph's
// bodyPreview/uniqueBody, Slack's Block Kit `blocks`.
const BODY_KEY =
  /^(body|body_?html|body_?text|html|text|content|contents|message|messages|snippet|transcript|excerpt|summary|prompt|completion|thinking)$/i;
const EXTRA_BODY_KEY = /^(last_?snippet|body_?preview|unique_?body|preview|blocks)$/i;
// Compound names that end in a content word: reply_text, draft-html,
// noteBody, draftHTML. "context" or "contentType" don't match.
const SNAKE_BODY_SUFFIX = /[_-](body|html|text|content|snippet|transcript)$/i;
const CAMEL_BODY_SUFFIX = /[a-z0-9](Body|Html|HTML|Text|Content|Snippet|Transcript)$/;

function isBodyKey(key: string): boolean {
  return BODY_KEY.test(key) || EXTRA_BODY_KEY.test(key) || SNAKE_BODY_SUFFIX.test(key) || CAMEL_BODY_SUFFIX.test(key);
}

// redact() only looks at key NAMES. These catch credentials sitting in a
// value: an upstream error that echoes a header, a token pasted into a field.
// Bearer values, Slack, Anthropic, Stripe and Supabase secret keys, and JWTs
// (the Supabase service key, Graph and clone tokens).
//
// The text comes from email senders, Slack users and the model, so the scan
// has to stay linear. Every alternative but the JWT ends on its open-ended
// run (Bearer's optional "=" padding can't fail), so an attempt either takes
// the whole run or fails within a few characters. The JWT needs a "." after
// its first run, and a failed attempt costs the length of that run. It starts
// only where a run of token characters starts (the lookbehind), so each run
// is tried once. A \b would also match after every "-" inside a run, and
// "eyJ-eyJ-eyJ-…" would then cost one full scan per "eyJ": quadratic,
// seconds of blocked event loop for 60,000 characters. The price is that a
// JWT stuck to the text before it by a letter, digit, "_" or "-" isn't
// masked.
const SECRET_VALUE = new RegExp(
  [
    String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*`,
    String.raw`\bxox[abposr]-[A-Za-z0-9-]{8,}`,
    String.raw`\bxapp-[A-Za-z0-9-]{8,}`,
    String.raw`\bsk-ant-[A-Za-z0-9_-]{8,}`,
    String.raw`\b[sr]k_live_[A-Za-z0-9]{8,}`,
    String.raw`\bsb_secret_[A-Za-z0-9_-]{8,}`,
    String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}`
  ].join("|"),
  "gi"
);

// Each string is scanned only up to a fixed window, so the cost per string
// has a ceiling whatever the input or any pattern above does. agent-audit's
// redact() keeps 4,000 characters of a string, and errors keep MAX_ERROR. The
// margin past that lets a token that starts inside the kept text be seen
// whole (a Graph JWT runs to a few KB), so it can't survive as an unmatched
// fragment. Text past the window is dropped unscanned and marked.
const KEPT_STRING = 4_000;
const TOKEN_MARGIN = 16_000;

// Postgres refuses a NUL and a lone UTF-16 surrogate in text and jsonb, and one
// bad character would fail the whole insert, which for auditStart means a
// refused action. Replace them before they get that far.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NUL = /\u0000/g;

function pgSafe(s: string): string {
  return s.replace(NUL, "").replace(LONE_SURROGATE, "�");
}

/** The first n UTF-16 units of s, never ending on the first half of a surrogate pair. */
function cutAt(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** pgSafe plus credential masking over the first `window` characters; anything past them becomes `marker`. */
function scrubString(s: string, window: number, marker: string): string {
  const head = s.length > window ? `${cutAt(s, window)}${marker}` : s;
  return pgSafe(head).replace(SECRET_VALUE, "[redacted]");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "Name: message" for an Error (bare message for a plain Error), String() otherwise. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.name && err.name !== "Error" ? `${err.name}: ${err.message}` : err.message;
  try {
    return String(err);
  } catch {
    // A thrown value whose toString throws. The caller still rethrows the
    // original error. Only its description is lost.
    return "non-Error value thrown";
  }
}

/** At most n UTF-16 units including the trailing "…", never splitting a surrogate pair. */
function clipText(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n - 1;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${s.slice(0, end)}…`;
}

function errorText(error: string | null | undefined): string | null {
  if (typeof error !== "string" || error.length === 0) return null;
  return clipText(scrubString(error, MAX_ERROR + TOKEN_MARGIN, "…"), MAX_ERROR);
}

/** Size of a value that's being omitted. null when it can't be serialized (cycle, throwing toJSON). */
function jsonChars(value: unknown): number | null {
  try {
    const s = JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    return typeof s === "string" ? s.length : 0;
  } catch {
    // The content is omitted either way; only the size is unknown, and null says so.
    return null;
  }
}

function omitted(value: string | object): { omitted: true; chars: number | null } {
  return { omitted: true, chars: typeof value === "string" ? value.length : jsonChars(value) };
}

// Turns a value into plain JSON data (what bounded() expects) with body-like
// keys replaced. Values JSON can't hold are converted here, because bounded()
// calls JSON.stringify and would otherwise throw on a BigInt or a bare function.
function stripBodies(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") return scrubString(value, KEPT_STRING + TOKEN_MARGIN, "…[truncated]");
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return null;
  if (value === null || typeof value !== "object") return value ?? null;
  // Binary data: its size is the only useful part, and walking a Buffer would
  // turn every byte into a key.
  if (value instanceof ArrayBuffer) return { omitted: true, bytes: value.byteLength };
  if (ArrayBuffer.isView(value)) return { omitted: true, bytes: value.byteLength };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => stripBodies(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Keys get the same scrub as values: a map keyed by tokens would otherwise
    // store them as names.
    const key = scrubString(k, KEPT_STRING + TOKEN_MARGIN, "…[truncated]");
    out[key] = isBodyKey(k) && (typeof v === "string" || (typeof v === "object" && v !== null)) ? omitted(v) : stripBodies(v, depth + 1);
  }
  return out;
}

/**
 * The form of `value` that may be stored in exec_audit_log: body-like keys
 * replaced by `{ omitted: true, chars }`, then agent-audit's bounded()
 * (credential keys redacted, size-capped). Never throws.
 */
export function sanitizeForAudit(value: unknown): unknown {
  try {
    return bounded(stripBodies(value, 0));
  } catch (err) {
    // Only an exotic value gets here (a getter or toJSON that throws). Store a
    // marker so the row itself still lands.
    console.error(`[exec-audit] could not sanitize a value, storing a marker: ${describeError(err)}`);
    return { unserializable: true };
  }
}

function baseRow(principal: ExecPrincipal | null, entry: AuditEntry) {
  return {
    principal_id: principal?.id ?? null,
    actor: entry.actor,
    action: clipText(pgSafe(String(entry.action)), MAX_ACTION),
    target: entry.target == null ? null : clipText(pgSafe(String(entry.target)), MAX_TARGET),
    input: entry.input === undefined ? null : sanitizeForAudit(entry.input)
  };
}

function rowId(data: unknown): number | null {
  const id = (data as { id?: unknown } | null)?.id;
  // PostgREST returns bigint identity values as JSON numbers; accept a numeric
  // string too, in case anything in between stringifies them.
  const n = typeof id === "string" && /^\d+$/.test(id) ? Number(id) : id;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Record a side effect BEFORE it runs. Returns the row id for auditFinish.
 * Throws AuditUnavailableError when the row can't be written, and the caller
 * must then not perform the side effect.
 */
export async function auditStart(principal: ExecPrincipal | null, entry: AuditEntry): Promise<number> {
  let failure: string;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("exec_audit_log")
      .insert(baseRow(principal, entry))
      .select("id")
      .single();
    if (!error) {
      const id = rowId(data);
      if (id !== null) return id;
      failure = "insert returned no row id";
    } else {
      failure = error.message;
    }
  } catch (err) {
    failure = errMessage(err);
  }
  console.error(`[exec-audit] refusing ${entry.action}: audit log unavailable: ${failure}`);
  throw new AuditUnavailableError(`audit log unavailable: ${failure}`);
}

/** Record how a side effect ended. Never throws, because the action already happened. */
export async function auditFinish(id: number, outcome: AuditOutcome): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("exec_audit_log")
      .update({
        ok: outcome.ok,
        result: outcome.result === undefined ? null : sanitizeForAudit(outcome.result),
        error: errorText(outcome.error),
        finished_at: new Date().toISOString()
      })
      .eq("id", id);
    if (error) console.error(`[exec-audit] could not finish audit row ${id}: ${error.message}`);
  } catch (err) {
    console.error(`[exec-audit] could not finish audit row ${id}: ${errMessage(err)}`);
  }
}

/**
 * One finished row for something that isn't gated on the audit: a read, a
 * tool call. Never throws. A lost row is logged, and the caller carries on.
 */
export async function auditEvent(principal: ExecPrincipal | null, entry: AuditEventEntry): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("exec_audit_log")
      .insert({
        ...baseRow(principal, entry),
        ok: entry.ok ?? !entry.error,
        result: entry.result === undefined ? null : sanitizeForAudit(entry.result),
        error: errorText(entry.error),
        finished_at: new Date().toISOString()
      });
    if (error) console.error(`[exec-audit] could not record ${entry.action}: ${error.message}`);
  } catch (err) {
    console.error(`[exec-audit] could not record ${entry.action}: ${errMessage(err)}`);
  }
}

/**
 * Run `fn` as an audited side effect: start the row (fn never runs if that
 * fails), run it, finish the row, and rethrow fn's error unchanged.
 *
 * The row's result stays null. fn's return value can be anything, including
 * the content that was just sent. A caller that wants a small result recorded
 * calls auditStart/auditFinish itself.
 */
export async function withAudit<T>(principal: ExecPrincipal | null, entry: AuditEntry, fn: () => Promise<T>): Promise<T> {
  const id = await auditStart(principal, entry);
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    await auditFinish(id, { ok: false, error: describeError(err) });
    throw err;
  }
  await auditFinish(id, { ok: true });
  return value;
}
