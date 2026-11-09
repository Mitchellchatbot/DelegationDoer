import "server-only";

import { SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { DmTarget, SlackHomeView, SlackMessageParts, SlackMethod } from "@/lib/exec/slack-types";
import type { ConversationMeta, ConvType, ReadTarget } from "@/lib/exec/slack-read-types";
import type { ErrorClass } from "@/lib/exec/types";

// P6 Slack Web API client (contract §3.5, K14; Area B; server-only). The one
// module that talks to https://slack.com/api/ (boundary rule B-P6-4). Imports
// only node: modules, @/lib/exec/types and @/lib/exec/slack-types. No DB
// access. Nothing is logged by this module, ever. The only senders are
// postInDm / updateInDm / deleteInDm, each refusing any channel but the
// installation's DM before any network call (K11).
//
// HTTP rules (§3.5): POST https://slack.com/api/<method>. The block writes
// (chat.postMessage, chat.update, chat.delete, views.publish) send JSON; the
// rest send application/x-www-form-urlencoded (users.lookupByEmail rejects a
// JSON POST, CODE §2). Every call carries the token in the Authorization
// header and never in a URL or a body. A local AbortController with a
// timeout, linked to the caller's signal by a listener (never
// AbortSignal.any, P3 §0): our timeout → SlackApiError "timeout"
// (retryable); the caller's abort → its AbortError, rethrown. The response
// body is read with a 1 MiB cap. Every failure is a SlackApiError whose
// message is `slack:<method> → <code>` and nothing else (§0.3 rule 4): no
// token, no text, no cause chain.

/**
 * A failed Slack call. message = `slack:${method} → ${code}` and nothing else (§0.3 rule 4).
 * Constructor frozen at stage 0: Area B's mapping (§3.5 table) computes errorClass and retryAfterMs and passes them in.
 */
export class SlackApiError extends Error {
  readonly name = "SlackApiError";
  readonly method: string;
  /** Slack's `error`, or "http_<status>", "network", "timeout", "bad_response". */
  readonly code: string;
  /** 429 on a rate limit, the HTTP status on a non-2xx, else undefined. */
  readonly status: number | undefined;
  readonly errorClass: ErrorClass;
  readonly retryAfterMs: number | undefined;
  constructor(method: string, code: string, opts: { errorClass: ErrorClass; status?: number; retryAfterMs?: number }) {
    super(`slack:${method} → ${code}`);
    this.method = method;
    this.code = code;
    this.status = opts.status;
    this.errorClass = opts.errorClass;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** K11: a send, update, delete or read aimed at any channel but the installation's DM. Thrown before any network call. */
export class SlackChannelRefusedError extends Error {
  readonly name = "SlackChannelRefusedError";
  readonly errorClass = "fatal" as const;
  constructor() {
    super("slack: refused a channel other than the installation's DM");
  }
}

// --- the mapping (§3.5 table, K14) -------------------------------------------------------

/** ok:false codes that mean the token or its grant is bad: dead at once, plus the runner's auth:<kind> alert. */
const AUTH_CODES: ReadonlySet<string> = new Set([
  "invalid_auth", "token_revoked", "account_inactive", "not_authed", "missing_scope", "team_access_not_granted", "no_permission",
  "token_expired"
]);
/** ok:false codes that a retry can't fix. Every unlisted code is fatal too (C26); the list documents the expected ones. */
const FATAL_CODES: ReadonlySet<string> = new Set([
  "channel_not_found", "not_in_channel", "msg_too_long", "invalid_blocks", "invalid_arguments", "message_not_found",
  "cant_update_message", "edit_window_closed", "invalid_auth_code", "invalid_code", "bad_redirect_uri", "bad_client_secret",
  "oauth_authorization_url_mismatch", "invalid_team_for_non_distributed_app",
  // P7a (§3.6.1; documentation: an unlisted code is fatal anyway, C26).
  "invalid_types", "thread_not_found", "user_not_found", "bot_not_found", "invalid_cursor", "is_archived"
]);
/** Slack's transient codes, plus this module's own transport codes. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout", "timeout", "network"
]);
/** auth.revoke: the token is already dead, which is what revoking wanted. */
const ALREADY_INVALID_CODES: ReadonlySet<string> = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed"]);
/** chat.delete: the message is already gone (or was never ours to delete). */
const GONE_CODES: ReadonlySet<string> = new Set(["message_not_found", "cant_delete_message"]);
/** Slack's error codes are snake_case; anything else in that field is treated as a malformed answer. */
const CODE_SHAPE = /^[a-z0-9_]{1,64}$/;
const HTTP_CODE = /^http_([0-9]{3})$/;

/** §3.5's mapping table: auth / fatal / retryable for one Slack `error` code (unknown → fatal, C26). */
export function classifySlackCode(code: string): ErrorClass {
  if (AUTH_CODES.has(code)) return "auth";
  if (RETRYABLE_CODES.has(code)) return "retryable";
  if (FATAL_CODES.has(code)) return "fatal";
  const http = HTTP_CODE.exec(code);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) return "auth";
    if (status === 429 || status >= 500) return "retryable";
  }
  return "fatal";
}

export interface SlackCallOptions { signal?: AbortSignal; timeoutMs?: number /* SLACK_LIMITS.httpTimeoutMs */ }

// --- transport ----------------------------------------------------------------------------

const SLACK_API = "https://slack.com/api/";
const RESPONSE_MAX_BYTES = 1_048_576;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const JSON_TYPE = "application/json; charset=utf-8";
const FORM_TYPE = "application/x-www-form-urlencoded";
/** A token goes into a header, so it must be visible ASCII: anything else would make Headers throw with the value in its message. */
const HEADER_SAFE = /^[\x21-\x7e]{1,500}$/;

type Json = Record<string, unknown>;
type FormValue = string | null | undefined;
type CallBody = { json: Json } | { form: Record<string, FormValue> };

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const badResponse = (method: SlackMethod) => new SlackApiError(method, "bad_response", { errorClass: "fatal" });

function bearer(method: SlackMethod, token: string): string {
  if (typeof token !== "string" || !HEADER_SAFE.test(token)) throw new SlackApiError(method, "not_authed", { errorClass: "auth" });
  return `Bearer ${token}`;
}

function timeoutOf(opts: SlackCallOptions | undefined): number {
  const t = opts?.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.min(t, 600_000) : SLACK_LIMITS.httpTimeoutMs;
}

/** Retry-After in ms when it is a positive whole number of seconds, else Slack's usual 30 s. */
function retryAfterOf(headers: Headers): number {
  const raw = headers.get("retry-after")?.trim() ?? "";
  if (/^[0-9]{1,9}$/.test(raw)) {
    const seconds = Number(raw);
    if (seconds > 0) return seconds * 1000;
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to free.
  }
}

/** The response text, read with a cap; null when it is larger than the cap. */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = res.headers.get("content-length")?.trim();
  if (declared && /^[0-9]+$/.test(declared) && Number(declared) > maxBytes) {
    await discardBody(res);
    return null;
  }
  const stream = res.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released.
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}

function encode(body: CallBody): { contentType: string; payload: string } {
  if ("json" in body) return { contentType: JSON_TYPE, payload: JSON.stringify(body.json) };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body.form)) if (typeof value === "string") form.set(key, value);
  return { contentType: FORM_TYPE, payload: form.toString() };
}

/**
 * One Web API call. Returns the parsed `ok: true` answer; throws a SlackApiError for everything else (§3.5 mapping),
 * or the caller's AbortError when the caller aborted.
 */
async function callSlack(method: SlackMethod, authorization: string, body: CallBody, opts?: SlackCallOptions): Promise<Json> {
  const caller = opts?.signal;
  if (caller?.aborted) throw abortReasonOf(caller);
  const { contentType, payload } = encode(body);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutOf(opts));
  const onAbort = () => controller.abort(caller ? abortReasonOf(caller) : undefined);
  caller?.addEventListener("abort", onAbort, { once: true });
  // A transport failure: our timeout, the caller's abort (rethrown as is), or the network.
  const transport = (err: unknown): unknown => {
    if (err instanceof SlackApiError) return err;
    if (timedOut) return new SlackApiError(method, "timeout", { errorClass: "retryable" });
    if (caller?.aborted) return err;
    return new SlackApiError(method, "network", { errorClass: "retryable" });
  };
  try {
    let res: Response;
    try {
      res = await fetch(`${SLACK_API}${method}`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": contentType },
        body: payload,
        signal: controller.signal,
        redirect: "error"
      });
    } catch (err) {
      throw transport(err);
    }
    if (res.status === 429) {
      await discardBody(res);
      throw new SlackApiError(method, "ratelimited", { errorClass: "retryable", status: 429, retryAfterMs: retryAfterOf(res.headers) });
    }
    if (res.status < 200 || res.status > 299) {
      await discardBody(res);
      const status = res.status;
      const errorClass: ErrorClass = status >= 500 ? "retryable" : status === 401 || status === 403 ? "auth" : "fatal";
      throw new SlackApiError(method, `http_${status}`, { errorClass, status });
    }
    let text: string | null;
    try {
      text = await readCapped(res, RESPONSE_MAX_BYTES);
    } catch (err) {
      throw transport(err);
    }
    if (text === null) throw badResponse(method);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw badResponse(method);
    }
    if (!isRecord(parsed)) throw badResponse(method);
    if (parsed.ok !== true) {
      const code = typeof parsed.error === "string" && CODE_SHAPE.test(parsed.error) ? parsed.error : "bad_response";
      if (code === "ratelimited") {
        throw new SlackApiError(method, code, { errorClass: "retryable", status: 429, retryAfterMs: retryAfterOf(res.headers) });
      }
      throw new SlackApiError(method, code, { errorClass: classifySlackCode(code) });
    }
    return parsed;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onAbort);
  }
}

/** K11: the installation's own DM, and nothing else; checked before any network call. */
function assertDmChannel(target: DmTarget, channel: unknown): void {
  const dm = target?.dmChannelId;
  if (typeof dm !== "string" || !SLACK_RE.dm.test(dm) || channel !== dm) throw new SlackChannelRefusedError();
}

// --- OAuth and identity ----------------------------------------------------------------------

export interface OAuthAccessResult {
  ok: true; accessToken: string; tokenType: string; scope: string[]; botUserId: string | null; appId: string | null;
  teamId: string | null; isEnterpriseInstall: boolean; enterprisePresent: boolean;
  authedUserId: string | null; authedUserToken: string | null;   // present only if Slack issued one (K1: revoked at once)
  /** P7a (§3.6.1): authed_user.token_type and authed_user.scope split on "," (trimmed, deduplicated), null when Slack sent none.
   *  Optional in the type so P6's literals compile; exchangeOAuthCode always fills both, and undefined reads as "not issued". */
  authedUserTokenType?: string | null; authedUserScope?: string[] | null;
}

/** oauth.v2.access with HTTP Basic (clientId:clientSecret), form body code + redirect_uri; never a bearer header. */
export async function exchangeOAuthCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, opts?: SlackCallOptions): Promise<OAuthAccessResult> {
  const method: SlackMethod = "oauth.v2.access";
  const oauthCode = input.code;
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`, "utf8").toString("base64");
  const json = await callSlack(method, `Basic ${basic}`, { form: { code: oauthCode, redirect_uri: input.redirectUri } }, opts);
  const accessToken = str(json.access_token);
  // A bot install always carries the bot token at the top level (PLAT §3); without one there is nothing to install.
  if (accessToken === null) throw badResponse(method);
  const team = isRecord(json.team) ? json.team : null;
  const authed = isRecord(json.authed_user) ? json.authed_user : null;
  const scopes = typeof json.scope === "string" ? json.scope.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : [];
  return {
    ok: true,
    accessToken,
    tokenType: str(json.token_type) ?? "",
    scope: [...new Set(scopes)],
    botUserId: str(json.bot_user_id),
    appId: str(json.app_id),
    teamId: team ? str(team.id) : null,
    isEnterpriseInstall: json.is_enterprise_install === true,
    enterprisePresent: json.enterprise !== null && json.enterprise !== undefined && json.enterprise !== false,
    authedUserId: authed ? str(authed.id) : null,
    authedUserToken: authed ? str(authed.access_token) : null,
    authedUserTokenType: authed ? str(authed.token_type) : null,
    authedUserScope: authed && typeof authed.scope === "string"
      ? [...new Set(authed.scope.split(",").map((x) => x.trim()).filter((x) => x.length > 0))]
      : null
  };
}

export async function authTest(token: string, opts?: SlackCallOptions): Promise<{ teamId: string; userId: string; botId: string | null }> {
  const method: SlackMethod = "auth.test";
  const json = await callSlack(method, bearer(method, token), { form: {} }, opts);
  const teamId = str(json.team_id);
  const userId = str(json.user_id);
  if (teamId === null || userId === null) throw badResponse(method);
  return { teamId, userId, botId: str(json.bot_id) };
}

/** P8 (§3.21.3, C8): isRestricted / isUltraRestricted are Slack's guest flags (a multi-channel and a single-channel guest);
 *  false when Slack leaves them out. Optional in the type so P6's literals compile; lookupUserByEmail always fills both. */
export interface SlackUserSummary { id: string; deleted: boolean; isBot: boolean; teamId: string | null; isRestricted?: boolean; isUltraRestricted?: boolean }

/** users.lookupByEmail, form-encoded POST (CODE §2: JSON POST returns invalid_arguments). users_not_found → null. */
export async function lookupUserByEmail(token: string, email: string, opts?: SlackCallOptions): Promise<SlackUserSummary | null> {
  const method: SlackMethod = "users.lookupByEmail";
  let json: Json;
  try {
    json = await callSlack(method, bearer(method, token), { form: { email } }, opts);
  } catch (err) {
    if (err instanceof SlackApiError && err.code === "users_not_found") return null;
    throw err;
  }
  const user = isRecord(json.user) ? json.user : null;
  const id = user ? str(user.id) : null;
  if (user === null || id === null) throw badResponse(method);
  return {
    id, deleted: user.deleted === true, isBot: user.is_bot === true, teamId: str(user.team_id),
    isRestricted: user.is_restricted === true, isUltraRestricted: user.is_ultra_restricted === true
  };
}

/** conversations.open users=<id> → the D… channel id. */
export async function openDm(token: string, userId: string, opts?: SlackCallOptions): Promise<string> {
  const method: SlackMethod = "conversations.open";
  const json = await callSlack(method, bearer(method, token), { form: { users: userId } }, opts);
  const channel = isRecord(json.channel) ? str(json.channel.id) : null;
  if (channel === null) throw badResponse(method);
  return channel;
}

// --- reads in the DM ---------------------------------------------------------------------------

export interface SlackMessage { ts: string; user: string | null; botId: string | null; appId: string | null; subtype: string | null; hidden: boolean; text: string | null }

function messageOf(m: Json): SlackMessage | null {
  const ts = str(m.ts);
  if (ts === null) return null;
  return {
    ts,
    user: str(m.user),
    botId: str(m.bot_id),
    appId: str(m.app_id),
    subtype: str(m.subtype),
    hidden: m.hidden === true,
    text: typeof m.text === "string" ? m.text : null
  };
}

function messagesOf(json: Json): Json[] {
  return Array.isArray(json.messages) ? json.messages.filter(isRecord) : [];
}

/** The one message at ref.ts in the DM: threadTs null → conversations.history(channel, oldest=ts, latest=ts, inclusive, limit 1);
 *  else conversations.replies(channel, ts=threadTs, oldest=ts, latest=ts, inclusive, limit 2) and the entry whose ts === ref.ts.
 *  ref.channel must equal target.dmChannelId (else SlackChannelRefusedError). Not found → null. */
export async function readDmMessage(target: DmTarget, ref: { channel: string; ts: string; threadTs: string | null }, opts?: SlackCallOptions): Promise<SlackMessage | null> {
  assertDmChannel(target, ref.channel);
  let json: Json;
  if (ref.threadTs === null || ref.threadTs === undefined) {
    const method: SlackMethod = "conversations.history";
    json = await callSlack(
      method,
      bearer(method, target.token),
      { form: { channel: ref.channel, oldest: ref.ts, latest: ref.ts, inclusive: "true", limit: "1" } },
      opts
    );
  } else {
    const method: SlackMethod = "conversations.replies";
    try {
      json = await callSlack(
        method,
        bearer(method, target.token),
        { form: { channel: ref.channel, ts: ref.threadTs, oldest: ref.ts, latest: ref.ts, inclusive: "true", limit: "2" } },
        opts
      );
    } catch (err) {
      if (err instanceof SlackApiError && err.code === "thread_not_found") return null;
      throw err;
    }
  }
  const found = messagesOf(json).find((m) => m.ts === ref.ts);
  return found ? messageOf(found) : null;
}

export interface SlackHistoryItem { ts: string; botId: string | null; replyCount: number; threadTs: string | null }   // no text

/** For the DM purge (C19): conversations.history (latest, limit ≤ 200, cursor) or, with rootTs, conversations.replies of that thread. */
export async function listDmItems(target: DmTarget, q: { latest: string; cursor?: string | null; rootTs?: string | null; limit: number }, opts?: SlackCallOptions):
  Promise<{ items: SlackHistoryItem[]; nextCursor: string | null }> {
  assertDmChannel(target, target?.dmChannelId);
  const channel = target.dmChannelId;
  const limit = Number.isFinite(q.limit) ? Math.min(200, Math.max(1, Math.floor(q.limit))) : 200;
  const form: Record<string, FormValue> = { channel, latest: q.latest, limit: String(limit), cursor: str(q.cursor) };
  let json: Json;
  if (typeof q.rootTs === "string" && q.rootTs.length > 0) {
    const method: SlackMethod = "conversations.replies";
    try {
      json = await callSlack(method, bearer(method, target.token), { form: { ...form, ts: q.rootTs } }, opts);
    } catch (err) {
      if (err instanceof SlackApiError && err.code === "thread_not_found") return { items: [], nextCursor: null };
      throw err;
    }
  } else {
    const method: SlackMethod = "conversations.history";
    json = await callSlack(method, bearer(method, target.token), { form }, opts);
  }
  const items: SlackHistoryItem[] = [];
  for (const m of messagesOf(json)) {
    const ts = str(m.ts);
    if (ts === null) continue;
    const replyCount = typeof m.reply_count === "number" && Number.isInteger(m.reply_count) && m.reply_count > 0 ? m.reply_count : 0;
    items.push({ ts, botId: str(m.bot_id), replyCount, threadTs: str(m.thread_ts) });
  }
  const meta = isRecord(json.response_metadata) ? json.response_metadata : null;
  return { items, nextCursor: meta ? str(meta.next_cursor) : null };
}

/** P8 (§3.21.3, M2): how many conversations.history pages the metadata lookup reads (50 messages each). */
const METADATA_LOOKUP_PAGES = 2;

/** conversations.history(channel = target.dmChannelId, oldest, inclusive, limit 50, include_all_metadata = true) with the target's
 *  token; ≤ 2 pages; the first message whose metadata.event_type === eventType and whose event_payload has every match entry.
 *  Refuses q.channel !== target.dmChannelId before any network call, like the senders (K11). Reads no text: ts and metadata only. */
export async function findDmMessageByMetadata(target: DmTarget, q: { channel: string; oldest: string; eventType: string;
  match: Record<string, string | number> }, opts?: SlackCallOptions): Promise<{ ts: string } | null> {
  assertDmChannel(target, q?.channel);
  const method: SlackMethod = "conversations.history";
  if (typeof q.oldest !== "string" || !SLACK_RE.ts.test(q.oldest) || typeof q.eventType !== "string" || q.eventType.length === 0 ||
    !isRecord(q.match) || Object.keys(q.match).length === 0) {
    throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  }
  const wanted = Object.entries(q.match);
  let cursor: string | null = null;
  for (let page = 0; page < METADATA_LOOKUP_PAGES; page++) {
    const form: Record<string, FormValue> = {
      channel: q.channel, oldest: q.oldest, inclusive: "true", limit: "50", include_all_metadata: "true", cursor
    };
    const json = await callSlack(method, bearer(method, target.token), { form }, opts);
    for (const m of messagesOf(json)) {
      const ts = str(m.ts);
      const meta = isRecord(m.metadata) ? m.metadata : null;
      if (ts === null || meta === null || meta.event_type !== q.eventType || !isRecord(meta.event_payload)) continue;
      const payload = meta.event_payload;
      if (wanted.every(([k, v]) => payload[k] === v || (typeof v === "number" && payload[k] === String(v)))) return { ts };
    }
    cursor = isRecord(json.response_metadata) ? str(json.response_metadata.next_cursor) : null;
    if (cursor === null || json.has_more !== true) break;
  }
  return null;
}

// --- the only senders (K11) ----------------------------------------------------------------------

/** P8 (§3.21.3, M2): Slack message metadata on a post: an event type and a payload of ids and numbers only. */
export interface SlackMessageMetadata { event_type: string; event_payload: Record<string, string | number> }

const METADATA_EVENT = /^[a-z][a-z0-9_]{0,59}$/;
const METADATA_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const METADATA_VALUE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** The metadata object as Slack takes it; a malformed one throws before any network call (ids and numbers only, §0.3 rule 5). */
function metadataOf(m: SlackMessageMetadata): Json {
  const refuse = () => new SlackApiError("chat.postMessage", "invalid_metadata", { errorClass: "fatal" });
  if (!isRecord(m) || typeof m.event_type !== "string" || !METADATA_EVENT.test(m.event_type) || !isRecord(m.event_payload)) throw refuse();
  const entries = Object.entries(m.event_payload);
  if (entries.length === 0 || entries.length > 10) throw refuse();
  const payload: Json = {};
  for (const [k, v] of entries) {
    const ok = METADATA_KEY.test(k) && ((typeof v === "number" && Number.isSafeInteger(v)) || (typeof v === "string" && METADATA_VALUE.test(v)));
    if (!ok) throw refuse();
    payload[k] = v;
  }
  return { event_type: m.event_type, event_payload: payload };
}

/** P8 (§3.13.7): true when err is a SlackApiError from chat.postMessage itself (any earlier call's failure proves no post). */
export function failedOnPost(err: unknown): boolean {
  return err instanceof SlackApiError && err.method === "chat.postMessage";
}

/** K11: the only senders. Each throws SlackChannelRefusedError BEFORE any network call when msg.channel !== target.dmChannelId
 *  (so also for a C…, G…, U… or another D… id). postInDm always sends unfurl_links: false, unfurl_media: false, link_names: false.
 *  P8 (§3.21.3): msg.metadata, when given, is sent as Slack's `metadata` object (ids and numbers only). */
export async function postInDm(target: DmTarget, msg: { channel: string; threadTs?: string | null; metadata?: SlackMessageMetadata | null } & SlackMessageParts,
  opts?: SlackCallOptions): Promise<{ ts: string }> {
  assertDmChannel(target, msg.channel);
  const method: SlackMethod = "chat.postMessage";
  const body: Json = {
    channel: msg.channel,
    text: msg.text,
    blocks: msg.blocks,
    unfurl_links: false,
    unfurl_media: false,
    link_names: false
  };
  if (typeof msg.threadTs === "string" && msg.threadTs.length > 0) body.thread_ts = msg.threadTs;
  if (msg.metadata !== undefined && msg.metadata !== null) body.metadata = metadataOf(msg.metadata);
  const json = await callSlack(method, bearer(method, target.token), { json: body }, opts);
  const ts = str(json.ts);
  if (ts === null) throw badResponse(method);
  return { ts };
}

export async function updateInDm(target: DmTarget, msg: { channel: string; ts: string } & SlackMessageParts, opts?: SlackCallOptions): Promise<void> {
  assertDmChannel(target, msg.channel);
  const method: SlackMethod = "chat.update";
  // chat.update takes no unfurl flags (PLAT H14): the placeholder it replaces carries no link.
  await callSlack(method, bearer(method, target.token), { json: { channel: msg.channel, ts: msg.ts, text: msg.text, blocks: msg.blocks, link_names: false } }, opts);
}

/** message_not_found / cant_delete_message → "gone" (not an error). */
export async function deleteInDm(target: DmTarget, msg: { channel: string; ts: string }, opts?: SlackCallOptions): Promise<"deleted" | "gone"> {
  assertDmChannel(target, msg.channel);
  const method: SlackMethod = "chat.delete";
  try {
    await callSlack(method, bearer(method, target.token), { json: { channel: msg.channel, ts: msg.ts } }, opts);
    return "deleted";
  } catch (err) {
    if (err instanceof SlackApiError && GONE_CODES.has(err.code)) return "gone";
    throw err;
  }
}

/** K13: views.publish (by method string) with view = JSON.stringify(view); userId must match SLACK_RE.user. */
export async function setHomeView(token: string, userId: string, view: SlackHomeView, opts?: SlackCallOptions): Promise<void> {
  const method: SlackMethod = "views.publish";
  if (typeof userId !== "string" || !SLACK_RE.user.test(userId)) throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  const encoded = JSON.stringify({ type: "home", blocks: view.blocks });
  await callSlack(method, bearer(method, token), { json: { user_id: userId, view: encoded } }, opts);
}

/** auth.revoke on `token`: { revoked: true } → "revoked"; invalid_auth / token_revoked / account_inactive / not_authed → "already_invalid";
 *  anything else throws. */
export async function revokeToken(token: string, opts?: SlackCallOptions): Promise<"revoked" | "already_invalid"> {
  const method: SlackMethod = "auth.revoke";
  let json: Json;
  try {
    json = await callSlack(method, bearer(method, token), { form: {} }, opts);
  } catch (err) {
    if (err instanceof SlackApiError && ALREADY_INVALID_CODES.has(err.code)) return "already_invalid";
    throw err;
  }
  if (json.revoked === true) return "revoked";
  throw badResponse(method);
}

// --- P7a reads with his user token (P7a contract §3.6.1; Area B) -------------------------------
// The method literals of these reads live in this file only (B-P7a-5). HTTP rules as P6's: form-encoded with the bearer
// header, nothing logged, the 1 MiB body cap. Every read is read-only (§0.3 rule 8): no write method takes the user token.
// What leaves a read is ids, ts values, enums, booleans and counts, plus (readHistory / readReplies only) the message text,
// blocks and attachments the triage job reads in memory; users.list returns bot ids only, users.info one clipped label.

const CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const TEAM_ID = /^[TE][A-Z0-9]{2,30}$/;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** An id-like value (a bot or app id) we keep as is; any other truthy value still marks the message as a bot's / an app's. */
const ID_LIKE = /^[A-Z0-9]{2,40}$/;
const SUBTYPE_SHAPE = /^[a-z0-9_]{1,60}$/;
const REACTED_MAX = 50;
const LABEL_MAX = 80;
const PERMALINK_MAX = 500;
/** exec_slack_items_permalink_check's shape, anchored, plus the two parameters chat.getPermalink adds to a reply (thread_ts, cid).
 *  Every URL it accepts is one refs.ts#isAllowedLinkUrl accepts too (https, a well-formed slack.com subdomain, /archives/, only
 *  those parameters); §3.5 keeps refs.ts out of this file, so SR09 runs both on the same fixtures. */
const PERMALINK_RE =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.slack\.com\/archives\/[CGD][A-Z0-9]{2,30}\/p[0-9]{10,20}(?:\?(?:thread_ts=[0-9]{1,12}\.[0-9]{1,8}(?:&cid=[CGD][A-Z0-9]{2,30})?|cid=[CGD][A-Z0-9]{2,30}(?:&thread_ts=[0-9]{1,12}\.[0-9]{1,8})?))?$/;
/** conversations.list / users.conversations types for a ConvType. */
const SLACK_TYPE: Readonly<Record<ConvType, string>> = Object.freeze({ channel: "public_channel", group: "private_channel", im: "im", mpim: "mpim" });
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(["channel_not_found"]);
const PERMALINK_GONE_CODES: ReadonlySet<string> = new Set(["message_not_found", "channel_not_found"]);
const BOTS_INFO_NULL_CODES: ReadonlySet<string> = new Set(["bot_not_found", "missing_scope"]);

/** A page size: a whole number in [1, max], always sent (never Slack's default). */
function pageLimit(limit: unknown, max: number): string {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : max;
  return String(Math.min(max, Math.max(1, n)));
}

function typesParam(types: readonly ConvType[]): string | null {
  const out: string[] = [];
  for (const t of Array.isArray(types) ? types : []) {
    const s = SLACK_TYPE[t as ConvType];
    if (s !== undefined && !out.includes(s)) out.push(s);
  }
  return out.length > 0 ? out.join(",") : null;
}

const strOf = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
const nextCursorOf = (json: Json): string | null => (isRecord(json.response_metadata) ? str(json.response_metadata.next_cursor) : null);
const tsArg = (v: string | null | undefined): FormValue => (typeof v === "string" && SLACK_RE.ts.test(v) ? v : undefined);

/** A conversation object (conversations.list / conversations.info) → its metadata, or null when it has no usable id.
 *  The type comes from is_im / is_mpim / is_private (an MPIM also says is_group, so it is checked first). */
function conversationOf(c: unknown): SlackConversation | null {
  if (!isRecord(c)) return null;
  const id = strOf(c.id, CHANNEL_ID);
  if (id === null) return null;
  const convType: ConvType = c.is_im === true ? "im" : c.is_mpim === true ? "mpim" : c.is_private === true || c.is_group === true ? "group" : "channel";
  const named = convType === "channel" || convType === "group";
  return {
    id,
    convType,
    name: named ? strOf(c.name, CHANNEL_NAME) : null,
    // An IM always holds him; anything else says so itself.
    isMember: convType === "im" ? true : c.is_member === true,
    isPrivate: convType === "channel" ? c.is_private === true : true,
    isExtShared: c.is_ext_shared === true,
    isPendingExtShared: c.is_pending_ext_shared === true,
    isArchived: c.is_archived === true,
    imUser: convType === "im" ? strOf(c.user, SLACK_RE.user) : null,
    imUserDeleted: convType === "im" && c.is_user_deleted === true
  };
}

export interface SlackConversation extends ConversationMeta { imUserDeleted: boolean }
/** conversations.list (Tier 2): types channel→public_channel, group→private_channel, im, mpim; limit ≤ 200; exclude_archived.
 *  name only for channel/group and only when it matches /^[a-z0-9][a-z0-9._-]{0,79}$/ (else null); imUser for im. */
export async function listConversations(t: ReadTarget, q: { types: readonly ConvType[]; cursor?: string | null; limit: number;
  excludeArchived: boolean }, opts?: SlackCallOptions): Promise<{ items: SlackConversation[]; nextCursor: string | null }> {
  const method: SlackMethod = "conversations.list";
  const types = typesParam(q.types);
  // No type asked: nothing to list (Slack's default would be public channels nobody requested).
  if (types === null) return { items: [], nextCursor: null };
  const wanted = new Set<ConvType>(q.types);
  const json = await callSlack(method, bearer(method, t.userToken), {
    form: { types, limit: pageLimit(q.limit, 200), exclude_archived: q.excludeArchived === true ? "true" : "false", cursor: str(q.cursor) }
  }, opts);
  const items: SlackConversation[] = [];
  for (const c of Array.isArray(json.channels) ? json.channels : []) {
    const conv = conversationOf(c);
    // A type the caller didn't ask for is never classified (C26).
    if (conv !== null && wanted.has(conv.convType)) items.push(conv);
  }
  return { items, nextCursor: nextCursorOf(json) };
}

/** users.conversations (Tier 3): ids only. */
export async function listMemberConversationIds(t: ReadTarget, q: { types: readonly ConvType[]; cursor?: string | null; limit: number;
  excludeMuted: boolean }, opts?: SlackCallOptions): Promise<{ ids: string[]; nextCursor: string | null }> {
  const method: SlackMethod = "users.conversations";
  const types = typesParam(q.types);
  if (types === null) return { ids: [], nextCursor: null };
  const json = await callSlack(method, bearer(method, t.userToken), {
    form: { types, limit: pageLimit(q.limit, 200), exclude_muted: q.excludeMuted === true ? "true" : "false", cursor: str(q.cursor) }
  }, opts);
  const ids: string[] = [];
  for (const c of Array.isArray(json.channels) ? json.channels : []) {
    const id = isRecord(c) ? strOf(c.id, CHANNEL_ID) : null;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return { ids, nextCursor: nextCursorOf(json) };
}

/** conversations.info (Tier 3). channel_not_found → null. */
export async function getConversationInfo(t: ReadTarget, channel: string, opts?: SlackCallOptions): Promise<SlackConversation | null> {
  const method: SlackMethod = "conversations.info";
  if (typeof channel !== "string" || !CHANNEL_ID.test(channel)) throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  let json: Json;
  try {
    json = await callSlack(method, bearer(method, t.userToken), { form: { channel } }, opts);
  } catch (err) {
    if (err instanceof SlackApiError && NOT_FOUND_CODES.has(err.code)) return null;
    throw err;
  }
  const conv = conversationOf(json.channel);
  if (conv === null || conv.id !== channel) throw badResponse(method);
  return conv;
}

/** users.list (Tier 2), limit ≤ 200: ONLY the ids of members with is_bot (and USLACKBOT); no other field leaves the function. */
export async function listBotUserIds(t: ReadTarget, q: { cursor?: string | null; limit: number }, opts?: SlackCallOptions):
  Promise<{ botUserIds: string[]; nextCursor: string | null }> {
  const method: SlackMethod = "users.list";
  const json = await callSlack(method, bearer(method, t.userToken), { form: { limit: pageLimit(q.limit, 200), cursor: str(q.cursor) } }, opts);
  const botUserIds: string[] = [];
  for (const m of Array.isArray(json.members) ? json.members : []) {
    if (!isRecord(m)) continue;
    const id = strOf(m.id, SLACK_RE.user);
    if (id !== null && (m.is_bot === true || id === "USLACKBOT") && !botUserIds.includes(id)) botUserIds.push(id);
  }
  return { botUserIds, nextCursor: nextCursorOf(json) };
}

/** Code points a label never carries: C0 / C1 controls and DEL, the bidi marks and embeddings / isolates (U+061C,
 *  U+200E–U+200F, U+202A–U+202E, U+2066–U+2069), zero-width and invisible formatting (U+200B–U+200D, U+2060–U+2064,
 *  U+FEFF), line / paragraph separators (U+2028–U+2029), interlinear annotation (U+FFF9–U+FFFB) and tag characters
 *  (U+E0000–U+E007F). Compared as numbers: no escape sequence is typed anywhere. */
function isStrippedCodePoint(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x061c || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
    || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb)
    || (c >= 0xe0000 && c <= 0xe007f);
}

/** A display label: controls and bidi stripped, whitespace collapsed, clipped to 80 UTF-16 units without splitting a code point. */
function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let kept = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number;
    if (!isStrippedCodePoint(c)) kept += ch;
  }
  const collapsed = kept.replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of collapsed) {
    if (out.length + ch.length > LABEL_MAX) break;
    out += ch;
  }
  return out.trim();
}

/** users.info (Tier 4). user_not_found → null. label = profile.display_name || profile.real_name || name, control/bidi stripped,
 *  clipped to 80; teamId from user.team_id. */
export async function getUserBrief(t: ReadTarget, userId: string, opts?: SlackCallOptions):
  Promise<{ id: string; isBot: boolean; deleted: boolean; teamId: string | null; label: string } | null> {
  const method: SlackMethod = "users.info";
  if (typeof userId !== "string" || !SLACK_RE.user.test(userId)) throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  let json: Json;
  try {
    json = await callSlack(method, bearer(method, t.userToken), { form: { user: userId } }, opts);
  } catch (err) {
    if (err instanceof SlackApiError && err.code === "user_not_found") return null;
    throw err;
  }
  const user = isRecord(json.user) ? json.user : null;
  const id = user ? strOf(user.id, SLACK_RE.user) : null;
  if (user === null || id === null || id !== userId) throw badResponse(method);
  const profile = isRecord(user.profile) ? user.profile : {};
  const label = cleanLabel(profile.display_name) || cleanLabel(profile.real_name) || cleanLabel(user.name);
  return { id, isBot: user.is_bot === true, deleted: user.deleted === true, teamId: strOf(user.team_id, TEAM_ID), label };
}

export interface SlackReadMessage {
  ts: string; threadTs: string | null; user: string | null; userTeam: string | null; botId: string | null; botProfile: boolean;
  appId: string | null; subtype: string | null; hidden: boolean; text: string | null; blocks: unknown[] | null;
  attachments: unknown[] | null; replyCount: number; latestReply: string | null; parentUserId: string | null;
  editedTs: string | null; reactedUserIds: string[] /* ≤ 50, SLACK_RE.user */; fileCount: number;
}

/** A truthy id field: kept when well-formed or id-like, else the fallback, so a malformed value still marks a bot's / app's message. */
function idFlag(v: unknown, re: RegExp, fallback: string): string | null {
  if (!v) return null;
  if (typeof v === "string" && (re.test(v) || ID_LIKE.test(v))) return v;
  return fallback;
}

/** One history / replies message → SlackReadMessage, or null when it has no usable ts. File names are never read. */
function readMessageOf(m: unknown): SlackReadMessage | null {
  if (!isRecord(m)) return null;
  const ts = strOf(m.ts, SLACK_RE.ts);
  if (ts === null) return null;
  const reacted: string[] = [];
  for (const r of Array.isArray(m.reactions) ? m.reactions : []) {
    if (!isRecord(r)) continue;
    for (const u of Array.isArray(r.users) ? r.users : []) {
      if (reacted.length >= REACTED_MAX) break;
      if (typeof u === "string" && SLACK_RE.user.test(u) && !reacted.includes(u)) reacted.push(u);
    }
  }
  const subtype = typeof m.subtype === "string" && m.subtype.length > 0 ? (SUBTYPE_SHAPE.test(m.subtype) ? m.subtype : "unknown") : null;
  return {
    ts,
    threadTs: strOf(m.thread_ts, SLACK_RE.ts),
    user: strOf(m.user, SLACK_RE.user),
    userTeam: strOf(m.user_team, TEAM_ID) ?? strOf(m.team, TEAM_ID),
    botId: idFlag(m.bot_id, SLACK_RE.bot, "B00"),
    botProfile: m.bot_profile !== undefined && m.bot_profile !== null,
    appId: idFlag(m.app_id, SLACK_RE.app, "A00"),
    subtype,
    hidden: m.hidden === true,
    text: typeof m.text === "string" ? m.text : null,
    blocks: Array.isArray(m.blocks) ? m.blocks : null,
    attachments: Array.isArray(m.attachments) ? m.attachments : null,
    replyCount: typeof m.reply_count === "number" && Number.isSafeInteger(m.reply_count) && m.reply_count > 0 ? m.reply_count : 0,
    latestReply: strOf(m.latest_reply, SLACK_RE.ts),
    parentUserId: strOf(m.parent_user_id, SLACK_RE.user),
    editedTs: isRecord(m.edited) ? strOf(m.edited.ts, SLACK_RE.ts) : null,
    reactedUserIds: reacted,
    fileCount: Array.isArray(m.files) ? m.files.length : 0
  };
}

function pageOf(json: Json): { messages: SlackReadMessage[]; hasMore: boolean; nextCursor: string | null; isLimited: boolean } {
  const messages: SlackReadMessage[] = [];
  for (const m of messagesOf(json)) {
    const msg = readMessageOf(m);
    if (msg !== null) messages.push(msg);
  }
  return { messages, hasMore: json.has_more === true, nextCursor: nextCursorOf(json), isLimited: json.is_limited === true };
}

function windowForm(q: { channel: string; oldest?: string | null; latest?: string | null; inclusive?: boolean; limit: number; cursor?: string | null }):
  Record<string, FormValue> {
  return {
    channel: q.channel,
    oldest: tsArg(q.oldest),
    latest: tsArg(q.latest),
    inclusive: typeof q.inclusive === "boolean" ? (q.inclusive ? "true" : "false") : undefined,
    limit: pageLimit(q.limit, 200),
    cursor: str(q.cursor)
  };
}

/** conversations.history / conversations.replies (Tier 3), limit ≤ 200, explicit always; never persists cursors. */
export async function readHistory(t: ReadTarget, q: { channel: string; oldest?: string | null; latest?: string | null;
  inclusive?: boolean; limit: number; cursor?: string | null }, opts?: SlackCallOptions):
  Promise<{ messages: SlackReadMessage[]; hasMore: boolean; nextCursor: string | null; isLimited: boolean }> {
  const method: SlackMethod = "conversations.history";
  if (typeof q.channel !== "string" || !CHANNEL_ID.test(q.channel)) throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  return pageOf(await callSlack(method, bearer(method, t.userToken), { form: windowForm(q) }, opts));
}

export async function readReplies(t: ReadTarget, q: { channel: string; ts: string; oldest?: string | null; latest?: string | null;
  inclusive?: boolean; limit: number; cursor?: string | null }, opts?: SlackCallOptions):
  Promise<{ messages: SlackReadMessage[]; hasMore: boolean; nextCursor: string | null; isLimited: boolean }> {
  const method: SlackMethod = "conversations.replies";
  if (typeof q.channel !== "string" || !CHANNEL_ID.test(q.channel) || typeof q.ts !== "string" || !SLACK_RE.ts.test(q.ts)) {
    throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  }
  const form = windowForm(q);
  return pageOf(await callSlack(method, bearer(method, t.userToken), { form: { channel: form.channel, ts: q.ts, ...form } }, opts));
}

/** chat.getPermalink (special tier, no scope) with the user token; message_not_found / channel_not_found → null; a URL that fails
 *  isAllowedLinkUrl or the exec_slack_items_permalink_check shape → null. */
export async function getPermalink(t: ReadTarget, channel: string, ts: string, opts?: SlackCallOptions): Promise<string | null> {
  const method: SlackMethod = "chat.getPermalink";
  if (typeof channel !== "string" || !CHANNEL_ID.test(channel) || typeof ts !== "string" || !SLACK_RE.ts.test(ts)) {
    throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  }
  let json: Json;
  try {
    json = await callSlack(method, bearer(method, t.userToken), { form: { channel, message_ts: ts } }, opts);
  } catch (err) {
    if (err instanceof SlackApiError && PERMALINK_GONE_CODES.has(err.code)) return null;
    throw err;
  }
  const url = json.permalink;
  return typeof url === "string" && url.length <= PERMALINK_MAX && PERMALINK_RE.test(url) ? url : null;
}

/** bots.info with a bot token (the DD bot's). bot_not_found / missing_scope → null (never throws for those). */
export async function botsInfo(botToken: string, botId: string, opts?: SlackCallOptions): Promise<{ appId: string | null; userId: string | null } | null> {
  const method: SlackMethod = "bots.info";
  if (typeof botId !== "string" || !SLACK_RE.bot.test(botId)) throw new SlackApiError(method, "invalid_arguments", { errorClass: "fatal" });
  let json: Json;
  try {
    json = await callSlack(method, bearer(method, botToken), { form: { bot: botId } }, opts);
  } catch (err) {
    if (err instanceof SlackApiError && BOTS_INFO_NULL_CODES.has(err.code)) return null;
    throw err;
  }
  const bot = isRecord(json.bot) ? json.bot : null;
  if (bot === null) throw badResponse(method);
  return { appId: strOf(bot.app_id, SLACK_RE.app), userId: strOf(bot.user_id, SLACK_RE.user) };
}
