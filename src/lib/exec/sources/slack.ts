import "server-only";

import { SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { DmTarget, SlackHomeView, SlackMessageParts, SlackMethod } from "@/lib/exec/slack-types";
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
  "oauth_authorization_url_mismatch", "invalid_team_for_non_distributed_app"
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
    authedUserToken: authed ? str(authed.access_token) : null
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

export interface SlackUserSummary { id: string; deleted: boolean; isBot: boolean; teamId: string | null }

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
  return { id, deleted: user.deleted === true, isBot: user.is_bot === true, teamId: str(user.team_id) };
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

// --- the only senders (K11) ----------------------------------------------------------------------

/** K11: the only senders. Each throws SlackChannelRefusedError BEFORE any network call when msg.channel !== target.dmChannelId
 *  (so also for a C…, G…, U… or another D… id). postInDm always sends unfurl_links: false, unfurl_media: false, link_names: false. */
export async function postInDm(target: DmTarget, msg: { channel: string; threadTs?: string | null } & SlackMessageParts, opts?: SlackCallOptions): Promise<{ ts: string }> {
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
