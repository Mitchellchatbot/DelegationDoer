import "server-only";

import { NextResponse } from "next/server";
import type { ZodType, ZodTypeDef } from "zod";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { AuditUnavailableError, type AuditEntry, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The exec routes' shared HTTP helpers (P4 contract §3.12.1; P5a contract §3.2,
// S2, C11-C13). One implementation of each, used by P3's assess route, P4's
// drafts routes and every P5a/P5b/P6 route.
//
// isSameOriginRequest is THE same-origin check (P3's rule, moved here from
// email-assess.ts at P5a, bindings AM1): Sec-Fetch-Site, when the browser
// sends it, must say same-origin; without it the Origin's host must equal
// Host or an X-Forwarded-Host entry. This is the only exec file that reads
// that header (boundary rule 13). assertSameOrigin wraps it for P5a routes.
//
// readJsonBody reads the body as text, bounded (C56), then parses it; the shape
// check (zod) is the route's. jsonError answers `{ error: code, ...extra }`
// with no-store caching and, on a 429, a Retry-After header. Answers carry
// codes, ids and counts only.
//
// rateLimit counts durable rows (the audit log), never memory: two Railway
// services serve the routes. It fails closed: an unreadable count is a 503.
// runAudited writes the audit row before the act and finishes it with the
// act's outcome, so a refused or conflicting call is on record as such.

const RETRY_AFTER_DEFAULT_SEC = 60;
/** C12: the P5a body cap. */
export const DEFAULT_BODY_MAX_BYTES = 4096;

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the request comes from a page on this same site: the browser's
 * Sec-Fetch-Site says same-origin, or, from a browser that doesn't send it,
 * the Origin's host equals Host (or X-Forwarded-Host behind a proxy). No
 * header to go on is a refusal.
 */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site.trim().toLowerCase() === "same-origin";
  const origin = hostOf(req.headers.get("origin"));
  if (origin === null) return false;
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")]
    .flatMap((h) => (h ? h.split(",") : []))
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  return hosts.includes(origin);
}

type BoundedText = { ok: true; text: string } | { ok: false; reason: "too_large" | "syntax" };

/**
 * The body as UTF-8 text, read as a stream and abandoned as soon as it passes
 * `maxBytes` (an oversized body is never buffered whole). A read error or
 * invalid UTF-8 is "syntax": the body isn't something we can parse.
 */
async function readBoundedText(req: Request, maxBytes: number): Promise<BoundedText> {
  const stream = req.body;
  if (stream === null) return { ok: true, text: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ArrayBuffer.isView(value)) return { ok: false, reason: "syntax" };
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "syntax" };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "syntax" };
  }
}

/**
 * C56: text ≤ maxBytes, then JSON.parse. P5a (contract §3.2): every failure
 * says why: "too_large" (a declared or streamed size past the cap, or a cap
 * nothing fits) or "syntax" (not JSON, empty, invalid UTF-8, unreadable). The
 * reason is typed optional so P4's call sites compile unchanged.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number
): Promise<{ ok: true; value: unknown } | { ok: false; reason?: "too_large" | "syntax" }> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return { ok: false, reason: "too_large" };
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared.trim());
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, reason: "too_large" };
  }
  const read = await readBoundedText(req, maxBytes);
  if (!read.ok) return { ok: false, reason: read.reason };
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return { ok: false, reason: "syntax" };
  }
}

/** A P4 success or mapped-outcome answer (additive): the body as given, never cached. */
export function jsonAnswer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

function retryAfterHeader(extra: Record<string, unknown> | undefined): string {
  // P4's routes hand in retryAfterSec; P5a's rateLimit puts retryAfterSeconds in the body (bindings AM2).
  const sec = extra?.retryAfterSec ?? extra?.retryAfterSeconds;
  return String(typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : RETRY_AFTER_DEFAULT_SEC);
}

/**
 * An error answer: `{ error: code, ...extra }`, never cached; a 429 carries
 * Retry-After (extra.retryAfterSec, else extra.retryAfterSeconds, else 60).
 * P5a widened `code` from P4's DraftErrorCode to string (every DraftErrorCode
 * is still accepted); codes are snake_case.
 */
export function jsonError(status: number, code: string, extra?: Record<string, unknown>): NextResponse {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (status === 429) headers["retry-after"] = retryAfterHeader(extra);
  return NextResponse.json({ error: code, ...(extra ?? {}) }, { status, headers });
}

// ---------------------------------------------------------------------------
// P5a additions (contract §3.2, S2, C11-C13)
// ---------------------------------------------------------------------------

export type GuardResult = { ok: true } | { ok: false; response: NextResponse };

/** S2/C13: isSameOriginRequest(req) ? { ok: true } : { ok: false, response: jsonError(403, "forbidden") }. Pure on headers. */
export function assertSameOrigin(req: Request): GuardResult {
  return isSameOriginRequest(req) ? { ok: true } : { ok: false, response: jsonError(403, "forbidden") };
}

/**
 * C12 for P5a/P5b/P6 routes: readJsonBody(req, maxBytes) mapped to answers:
 * "too_large" → 413 {error:"too_large"}; "syntax" or no reason → 400
 * {error:"invalid", detail:"body"}. maxBytes defaults to 4096.
 */
export async function readJsonBodyOrError(
  req: Request,
  maxBytes: number = DEFAULT_BODY_MAX_BYTES
): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  const read = await readJsonBody(req, maxBytes);
  if (read.ok) return read;
  return {
    ok: false,
    response: read.reason === "too_large" ? jsonError(413, "too_large") : jsonError(400, "invalid", { detail: "body" })
  };
}

const DETAIL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * C12's last step: the parsed body against a (strict) zod schema, or 400
 * {error:"invalid", detail:"<field path>"} naming the first bad field (an
 * unknown key names itself; anything unnamed is "body"). Additive (P5a).
 */
export function validateBody<T>(value: unknown, schema: ZodType<T, ZodTypeDef, unknown>): { ok: true; value: T } | { ok: false; response: NextResponse } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  let detail = "body";
  if (issue !== undefined) {
    const path = issue.path.map(String).join(".");
    if (path !== "") detail = path;
    else if (issue.code === "unrecognized_keys" && issue.keys.length > 0) detail = issue.keys[0];
  }
  if (!detail.split(".").every((part) => DETAIL_KEY.test(part) || /^\d{1,4}$/.test(part)) || detail.length > 128) detail = "body";
  return { ok: false, response: jsonError(400, "invalid", { detail }) };
}

/** P5b added "chat" (his questions, any surface) and "proposal" (his confirms and dismisses); P6 (§3.15.2) the Slack
 *  connect start and the Slack disconnect; P7a (§3.10.1) Stop reading and the picker / watch mode. */
export type RateBucket = "attention_action" | "attention_feedback" | "settings_update" | "assess" | "chat" | "proposal"
  | "slack_connect" | "slack_disconnect" | "slack_reading" | "slack_channels"
  // P7b (stage-0 seed, §0.2 step 5): the tag route (B, 60 / 10 min) and the digest build route (C, 20 / 10 min).
  | "slack_links" | "slack_digest_build";
export interface RateBucketDef {
  /** created_at of the n-th newest counted row at or after sinceIso, or null when there are fewer than n. Throws on a read error. */
  nthNewestAt: (principal: ExecPrincipal, sinceIso: string, n: number, signal?: AbortSignal) => Promise<string | null>;
}

/**
 * select created_at from exec_audit_log where principal_id = p and created_at >= since and action in (actions)
 * order by created_at desc range(n-1, n-1), served by exec_audit_log_principal_idx (principal_id, created_at desc).
 */
export function auditNthNewestAt(actions: readonly string[]): RateBucketDef["nthNewestAt"] {
  const counted = [...actions];
  if (counted.length === 0 || counted.some((a) => typeof a !== "string" || a.length === 0)) {
    throw new TypeError("auditNthNewestAt needs at least one audit action");
  }
  return async (principal, sinceIso, n, signal) => {
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError("nthNewestAt: n must be a positive integer");
    if (!Number.isFinite(Date.parse(sinceIso))) throw new TypeError("nthNewestAt: sinceIso must be a timestamp");
    let query = getSupabaseAdmin()
      .from("exec_audit_log")
      .select("created_at")
      .eq("principal_id", principal.id)
      .gte("created_at", sinceIso)
      .in("action", counted)
      .order("created_at", { ascending: false })
      .range(n - 1, n - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) {
      signal?.throwIfAborted();
      throw new Error(`exec_audit_log rate count failed: ${error.message}`);
    }
    if (!Array.isArray(data)) throw new Error("exec_audit_log rate count failed: no rows array in the response");
    if (data.length === 0) return null;
    const at = (data[0] as { created_at?: unknown }).created_at;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) throw new Error("exec_audit_log rate count failed: created_at is not a timestamp");
    return at;
  };
}

/**
 * P5b (contract §3.0.1, S2; bindings AM2): the n-th newest value of `column` among the principal's rows of `table`
 * at or after sinceIso, optionally narrowed to one value of `role`:
 *   select <column> from <table> where principal_id = p [and role = r] and <column> >= since and <column> is not null
 *   order by <column> desc range(n-1, n-1)
 * served by exec_messages_rate_idx (user rows by created_at) and exec_task_proposals_decided_idx (decided rows by
 * decided_at). Throws on any read error, a missing table (42P01 / PGRST205) included, so rateLimit answers 503.
 */
function rowNthNewestAt(table: "exec_messages" | "exec_task_proposals", column: "created_at" | "decided_at", role: "user" | null): RateBucketDef["nthNewestAt"] {
  return async (principal, sinceIso, n, signal) => {
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError("nthNewestAt: n must be a positive integer");
    if (!Number.isFinite(Date.parse(sinceIso))) throw new TypeError("nthNewestAt: sinceIso must be a timestamp");
    let query = getSupabaseAdmin().from(table).select(column).eq("principal_id", principal.id);
    if (role !== null) query = query.eq("role", role);
    query = query
      .gte(column, sinceIso)
      .not(column, "is", null)
      .order(column, { ascending: false })
      .range(n - 1, n - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) {
      signal?.throwIfAborted();
      throw new Error(`${table} rate count failed: ${error.message}`);
    }
    if (!Array.isArray(data)) throw new Error(`${table} rate count failed: no rows array in the response`);
    if (data.length === 0) return null;
    const at = (data[0] as unknown as Record<string, unknown>)[column];
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) throw new Error(`${table} rate count failed: ${column} is not a timestamp`);
    return at;
  };
}

/**
 * Bucket registry (C11). Each audit-backed bucket counts the audit rows of its
 * actions. P4's drafts limiter (countRecentAudit, P4C C38) stays outside it,
 * as P4 built it (S2). P5b registered "chat" (exec_messages user rows, any
 * surface, so Slack DMs share it; the begin RPC repeats the exact count under
 * its lock, C49) and "proposal" (exec_task_proposals decided rows: confirms
 * and dismisses).
 */
export const RATE_BUCKETS: Readonly<Record<RateBucket, RateBucketDef>> = Object.freeze({
  attention_action: {
    nthNewestAt: auditNthNewestAt(["attention.seen", "attention.snooze", "attention.dismiss", "attention.resolve", "attention.reopen"])
  },
  attention_feedback: { nthNewestAt: auditNthNewestAt(["attention.feedback"]) },
  settings_update: { nthNewestAt: auditNthNewestAt(["settings.update", "settings.voice_reset"]) },
  assess: { nthNewestAt: auditNthNewestAt(["email.assess"]) },
  chat: { nthNewestAt: rowNthNewestAt("exec_messages", "created_at", "user") },
  proposal: { nthNewestAt: rowNthNewestAt("exec_task_proposals", "decided_at", null) },
  // P6 (§3.15.2; seeded at stage 0, final): the OAuth start (10 per 10 minutes) and Disconnect (10 per 10 minutes).
  slack_connect: { nthNewestAt: auditNthNewestAt(["slack.oauth.start"]) },
  slack_disconnect: { nthNewestAt: auditNthNewestAt(["slack.disconnect"]) },
  // P7a (§3.10.1; seeded at stage 0, then Area C's): Stop reading (10 per 10 minutes) and the picker plus the watch
  // mode (60 per 10 minutes).
  slack_reading: { nthNewestAt: auditNthNewestAt(["slack.read_stop"]) },
  slack_channels: { nthNewestAt: auditNthNewestAt(["slack.channel_watch", "settings.watch_mode"]) },
  slack_links: { nthNewestAt: auditNthNewestAt(["slack.channel.links"]) },
  slack_digest_build: { nthNewestAt: auditNthNewestAt(["slack.digest.request"]) }
});

/**
 * S2. ok when fewer than `limit` counted rows fall in the last windowMs; else 429
 * {error:"rate_limited", retryAfterSeconds} with Retry-After = ceil((nth + windowMs − now)/1000), min 1.
 * A read failure → 503 {error:"unavailable"} (fail closed). Never throws.
 */
export async function rateLimit(
  principal: ExecPrincipal,
  bucket: RateBucket,
  limit: number,
  windowMs: number,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<GuardResult> {
  try {
    const def = RATE_BUCKETS[bucket];
    if (!def) throw new TypeError(`unknown rate bucket ${String(bucket)}`);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("rateLimit: limit must be a positive integer");
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError("rateLimit: windowMs must be positive");
    const nowMs = (opts.now ?? new Date()).getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError("rateLimit: now must be a valid Date");
    const nth = await def.nthNewestAt(principal, new Date(nowMs - windowMs).toISOString(), limit, opts.signal);
    if (nth === null) return { ok: true };
    const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(nth) + windowMs - nowMs) / 1000));
    return { ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds }) };
  } catch (err) {
    // Ids and codes only: the error's text stays out of the answer.
    console.error(`[exec-http] rate limit ${String(bucket)} for ${principal.id} unavailable: ${err instanceof Error ? err.name : "error"}`);
    return { ok: false, response: jsonError(503, "unavailable") };
  }
}

/** What the audit row records about a finished call: ids and enums only. */
export interface AuditOutcomeSummary {
  ok: boolean;
  outcome: string;
}

/**
 * a-build-10. auditStart (AuditUnavailableError → 503 {error:"unavailable"}, fn never runs) → fn() →
 * auditFinish(id, { ok: s.ok, result: { outcome: s.outcome } }) with s = outcomeOf(value), so a refused,
 * conflicting or no-op call is on record as such. fn throws → auditFinish(id, { ok: false, error: "exception" })
 * and 503 {error:"unavailable"}; the error's message is never echoed or logged.
 */
export async function runAudited<T>(
  principal: ExecPrincipal,
  entry: AuditEntry,
  fn: () => Promise<T>,
  outcomeOf: (value: T) => AuditOutcomeSummary
): Promise<{ ok: true; value: T } | { ok: false; response: NextResponse }> {
  let id: number;
  try {
    id = await auditStart(principal, entry);
  } catch (err) {
    // auditStart already logged why; it only ever throws AuditUnavailableError.
    if (!(err instanceof AuditUnavailableError)) console.error(`[exec-http] ${entry.action} for ${principal.id}: audit start failed`);
    return { ok: false, response: jsonError(503, "unavailable") };
  }
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    await auditFinish(id, { ok: false, error: "exception" });
    console.error(`[exec-http] ${entry.action} for ${principal.id} failed (audit ${id}): ${err instanceof Error ? err.name : "error"}`);
    return { ok: false, response: jsonError(503, "unavailable") };
  }
  let summary: AuditOutcomeSummary;
  try {
    summary = outcomeOf(value);
  } catch {
    summary = { ok: false, outcome: "unknown" };
  }
  await auditFinish(id, { ok: summary.ok === true, result: { outcome: String(summary.outcome) } });
  return { ok: true, value };
}
