import "server-only";

import { openSecret } from "@/lib/exec/crypto";
import { enqueueJob } from "@/lib/exec/jobs";
import type {
  AcceptActionResult,
  AcceptEventResult,
  DmTarget,
  InstallationRow,
  OpenInstallation,
  RedactionFollowups,
  ReplyState,
  RevokeReason,
  SlackActionFacts,
  SlackEventDecision,
  SlackEventFacts,
  SlackPostKind,
  SlackSystemSummary
} from "@/lib/exec/slack-types";
import { SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P6 Slack store (contract §3.7; Area A; server-only): every read and write of
// the P6 tables and RPCs (boundary rule B-P6-6) of
// 20261108100000_exec_slack.sql.
//
//   * The bot-token blob never leaves this module unopened: InstallationRow
//     carries hasToken only, and the open* functions hand back a DmTarget
//     whose JSON / inspect forms leave the token out.
//   * Errors are SlackStoreError(op, pgCode): the function's name and the
//     database's own code, never a value this module was handed or read (no
//     ids, ts values, tokens or text in a message). An aborted signal wins
//     (postgrest-js reports an abort as a result, not a throw): the signal's
//     reason is thrown instead, as P5b's chat store does.
//   * The schema-missing rule follows P5b's chat store: before the migration is
//     applied, the acks answer not_installed, the purge / follow-up RPCs and the
//     retention deletes answer null / 0, and the reads throw a SlackStoreError
//     whose pgCode isSlackSchemaMissing recognises.
//   * Every insert / upsert builds the identical key set (P3 §0). Times are
//     compared as epoch ms; timestamps the database handed us (RPC 7's
//     changed_at) go back verbatim, at full microsecond precision.
//   * Logs (recordSlackPost, recordSlackError, enqueueRevokeCheck) carry ids,
//     ts values and codes only (§0.3 rule 4).

const INSTALLATIONS = "exec_slack_installations";
const EVENTS = "exec_slack_events";
const STATES = "exec_oauth_states";
const FEEDBACK = "exec_chat_feedback";
const POSTS = "exec_slack_posts";
const MESSAGES = "exec_messages";

const RPC_ACCEPT_EVENT = "exec_slack_accept_event";
const RPC_ACCEPT_ACTION = "exec_slack_accept_action";
const RPC_REVOKE = "exec_slack_revoke_installation";
const RPC_PURGE = "exec_slack_purge_installation";
const RPC_CONVERSATION = "exec_slack_conversation_for_thread";
const RPC_REPLY_STEP = "exec_slack_reply_step";
const RPC_FOLLOWUPS = "exec_slack_redaction_followups";

const INSTALLATION_COLS =
  "id,principal_id,team_id,app_id,bot_user_id,bot_id,bot_token_enc,key_id,bot_scopes,user_id,slack_dm_channel_id," +
  "installed_at,updated_at,revoked_at,revoke_reason,last_dm_at,last_error_code,last_error_at,purged_at";
const OPEN_REPLY_COLS = "event_id,installation_id,principal_id,channel_id,message_ts,thread_ts,reply_state,placeholder_ts,received_at,updated_at";

const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);
const PG_CODE = /^[A-Z0-9]{2,10}$/;
const SEALED_BLOB = /^v1\.([0-9a-f]{8})\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KEY_ID = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONVERSATION_ID = /^ecv_[0-9a-f]{32}$/;
const MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;
const POST_REF = /^(ed|etp)_[0-9a-f]{32}$/;
const ERROR_CODE = /^[a-z_]{1,60}$/;
// RPC 7's changed_at as PostgREST hands it back (to_json of a timestamptz) or an ISO string.
const DB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const DECISIONS: readonly SlackEventDecision[] = ["reply", "home", "revoke", "revoke_check", "drop"];
const REPLY_STATES: readonly ReplyState[] = ["queued", "started", "placeholder", "answered", "failed", "skipped", "swept"];
const OPEN_STATES = ["queued", "started", "placeholder"] as const;
const REVOKE_REASONS: readonly RevokeReason[] = ["app_uninstalled", "tokens_revoked", "disconnected"];
const POST_KINDS: readonly SlackPostKind[] = ["answer", "note", "draft", "proposal"];
/** exec_slack_events rows per purge chunk (§2.6), and the most chunks one run deletes. */
const PURGE_CHUNK = 1000;
const PURGE_MAX_CHUNKS = 100;
const OAUTH_STATE_TTL_MAX_SEC = SLACK_LIMITS.oauthStateTtlSec;
const MAX_ROWS = 500;

/** Never content in the message. Constructor frozen at stage 0 (other areas' tests construct it). */
export class SlackStoreError extends Error {
  readonly op: string;
  readonly pgCode: string | null;
  constructor(op: string, pgCode: string | null) {
    super(`exec slack store: ${op} failed${pgCode ? ` (${pgCode})` : ""}`);
    this.name = "SlackStoreError";
    this.op = op;
    this.pgCode = pgCode;
  }
}

type DbError = { code?: string | null; message?: string | null };
type Row = Record<string, unknown>;

const db = () => getSupabaseAdmin();

function pgCodeOf(error: DbError | null | undefined): string | null {
  const code = error?.code;
  return typeof code === "string" && PG_CODE.test(code) ? code : null;
}

/** The error to throw for a failed request: the abort reason when the signal fired, else SlackStoreError(op, code). */
function failure(op: string, error: DbError | null | undefined, signal?: AbortSignal): SlackStoreError {
  signal?.throwIfAborted();
  return new SlackStoreError(op, pgCodeOf(error));
}

function missing(error: DbError | null | undefined): boolean {
  const code = pgCodeOf(error);
  return code !== null && SCHEMA_MISSING_CODES.has(code);
}

/** 42P01, PGRST205 (table) or 42883, PGRST202 (function): the P6 migration isn't applied. */
export function isSlackSchemaMissing(err: unknown): boolean {
  if (err instanceof SlackStoreError) return err.pgCode !== null && SCHEMA_MISSING_CODES.has(err.pgCode);
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
}

function requirePrincipal(principal: ExecPrincipal): string {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("exec slack store: an ExecPrincipal is required");
  }
  return principal.id;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const clampInt = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
/** A ts or id for a log line, only when it has the expected shape (never an arbitrary value). */
const logId = (v: unknown, re: RegExp): string => (typeof v === "string" && re.test(v) ? v : "(malformed)");

function withSignal<T extends { abortSignal(signal: AbortSignal): T }>(q: T, signal: AbortSignal | undefined): T {
  return signal ? q.abortSignal(signal) : q;
}

// ---------------------------------------------------------------------------
// Installations
// ---------------------------------------------------------------------------

const tokenContext = (principalId: string) => `exec_slack_installations.bot_token:${principalId}`;

function toInstallationRow(r: Row, op: string): InstallationRow {
  const id = str(r.id);
  const principalId = str(r.principal_id);
  const teamId = str(r.team_id);
  const appId = str(r.app_id);
  const botUserId = str(r.bot_user_id);
  const botId = str(r.bot_id);
  const userId = str(r.user_id);
  const dmChannelId = str(r.slack_dm_channel_id);
  const installedAt = str(r.installed_at);
  const updatedAt = str(r.updated_at);
  const reason = str(r.revoke_reason);
  if (!id || !principalId || !teamId || !appId || !botUserId || !botId || !userId || !dmChannelId || !installedAt || !updatedAt) {
    throw new SlackStoreError(`${op}: malformed row`, null);
  }
  if (reason !== null && !(REVOKE_REASONS as readonly string[]).includes(reason)) throw new SlackStoreError(`${op}: malformed row`, null);
  return {
    id,
    principalId,
    teamId,
    appId,
    botUserId,
    botId,
    keyId: str(r.key_id),
    botScopes: Array.isArray(r.bot_scopes) ? r.bot_scopes.filter((s): s is string => typeof s === "string") : [],
    userId,
    dmChannelId,
    installedAt,
    updatedAt,
    revokedAt: str(r.revoked_at),
    revokeReason: reason as RevokeReason | null,
    lastDmAt: str(r.last_dm_at),
    lastErrorCode: str(r.last_error_code),
    lastErrorAt: str(r.last_error_at),
    purgedAt: str(r.purged_at),
    hasToken: typeof r.bot_token_enc === "string" && r.bot_token_enc.length > 0
  };
}

/**
 * The only object that carries a usable bot token. Frozen; its JSON form and its
 * util.inspect form (console.log) leave the token out, so a job result or a log
 * line that picks it up by mistake can't carry it.
 */
function dmTarget(token: string, dmChannelId: string): DmTarget {
  const target = { token, dmChannelId };
  Object.defineProperty(target, "toJSON", { value: () => ({ dmChannelId }), enumerable: false });
  Object.defineProperty(target, Symbol.for("nodejs.util.inspect.custom"), { value: () => `DmTarget { dmChannelId: '${dmChannelId}' }`, enumerable: false });
  return Object.freeze(target);
}

function openRow(raw: Row, op: string): OpenInstallation | null {
  const row = toInstallationRow(raw, op);
  const blob = raw.bot_token_enc;
  if (row.revokedAt !== null || typeof blob !== "string" || blob.length === 0) return null;
  // SecretUnavailableError propagates (not configured, unknown key, or a blob copied to another principal's row).
  const token = openSecret(blob, tokenContext(row.principalId));
  return { row, target: dmTarget(token, row.dmChannelId) };
}

function firstRow(op: string, result: { data: unknown; error: DbError | null }, signal?: AbortSignal): Row | null {
  if (result.error) throw failure(op, result.error, signal);
  return Array.isArray(result.data) ? ((result.data[0] as Row | undefined) ?? null) : null;
}

async function activeRaw(principalId: string, op: string, signal?: AbortSignal): Promise<Row | null> {
  const q = db().from(INSTALLATIONS).select(INSTALLATION_COLS).eq("principal_id", principalId).is("revoked_at", null)
    .order("installed_at", { ascending: false }).limit(1);
  return firstRow(op, await withSignal(q, signal), signal);
}

async function byIdRaw(installationId: string, op: string, signal?: AbortSignal): Promise<Row | null> {
  if (typeof installationId !== "string" || !SLACK_RE.installationId.test(installationId)) return null;
  return firstRow(op, await withSignal(db().from(INSTALLATIONS).select(INSTALLATION_COLS).eq("id", installationId).limit(1), signal), signal);
}

/** select 1 from exec_slack_installations limit 0 → true; schema missing → false; other errors throw. */
export async function slackSchemaReady(opts?: { signal?: AbortSignal }): Promise<boolean> {
  const signal = opts?.signal;
  // A GET (not a HEAD request): a missing table must come back with its error code in a body.
  const { error } = await withSignal(db().from(INSTALLATIONS).select("id").limit(0), signal);
  if (!error) return true;
  if (missing(error)) return false;
  throw failure("slackSchemaReady", error, signal);
}

export async function getActiveInstallation(principal: ExecPrincipal, opts?: { signal?: AbortSignal }): Promise<InstallationRow | null> {
  const raw = await activeRaw(requirePrincipal(principal), "getActiveInstallation", opts?.signal);
  return raw ? toInstallationRow(raw, "getActiveInstallation") : null;
}

/** Newest by installed_at, any state. */
export async function getLatestInstallation(principal: ExecPrincipal, opts?: { signal?: AbortSignal }): Promise<InstallationRow | null> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const q = db().from(INSTALLATIONS).select(INSTALLATION_COLS).eq("principal_id", pid).order("installed_at", { ascending: false }).limit(1);
  const raw = firstRow("getLatestInstallation", await withSignal(q, signal), signal);
  return raw ? toInstallationRow(raw, "getLatestInstallation") : null;
}

/** openSecret(bot_token_enc, `exec_slack_installations.bot_token:${principalId}`). null when no active row. SecretUnavailableError propagates. */
export async function openActiveInstallation(principal: ExecPrincipal, opts?: { signal?: AbortSignal }): Promise<OpenInstallation | null> {
  const pid = requirePrincipal(principal);
  const raw = await activeRaw(pid, "openActiveInstallation", opts?.signal);
  if (!raw || raw.principal_id !== pid) return null;
  return openRow(raw, "openActiveInstallation");
}

/** By id, for jobs. null unless active (revoked_at null), principal_id === principal.id and a token is present. */
export async function openInstallationById(principal: ExecPrincipal, installationId: string, opts?: { signal?: AbortSignal }): Promise<OpenInstallation | null> {
  const pid = requirePrincipal(principal);
  const raw = await byIdRaw(installationId, "openInstallationById", opts?.signal);
  if (!raw || raw.principal_id !== pid) return null;
  return openRow(raw, "openInstallationById");
}

/** System jobs (uninstall check) open by id without a principal: same rules minus the principal check. */
export async function openInstallationForSystem(installationId: string, opts?: { signal?: AbortSignal }): Promise<OpenInstallation | null> {
  const raw = await byIdRaw(installationId, "openInstallationForSystem", opts?.signal);
  return raw ? openRow(raw, "openInstallationForSystem") : null;
}

export async function getInstallationForSystem(installationId: string, opts?: { signal?: AbortSignal }): Promise<InstallationRow | null> {
  const raw = await byIdRaw(installationId, "getInstallationForSystem", opts?.signal);
  return raw ? toInstallationRow(raw, "getInstallationForSystem") : null;
}

export interface NewInstallation {
  teamId: string; appId: string; botUserId: string; botId: string; botTokenSealed: string; keyId: string;
  botScopes: string[]; userId: string; dmChannelId: string;
}

function checkNewInstallation(input: NewInstallation): void {
  const bad = (what: string) => new TypeError(`exec slack store: saveInstallation: ${what}`);
  if (!input || typeof input !== "object") throw bad("an installation is required");
  if (!SLACK_RE.team.test(String(input.teamId))) throw bad("malformed team id");
  if (!SLACK_RE.app.test(String(input.appId))) throw bad("malformed app id");
  if (!SLACK_RE.user.test(String(input.botUserId))) throw bad("malformed bot user id");
  if (!SLACK_RE.bot.test(String(input.botId))) throw bad("malformed bot id");
  if (!SLACK_RE.user.test(String(input.userId))) throw bad("malformed user id");
  if (!SLACK_RE.dm.test(String(input.dmChannelId))) throw bad("malformed DM channel id");
  // Never a plaintext token: only sealSecret's output, sealed under the key it names.
  const sealed = typeof input.botTokenSealed === "string" ? SEALED_BLOB.exec(input.botTokenSealed) : null;
  if (!sealed) throw bad("botTokenSealed is not a sealed secret");
  if (typeof input.keyId !== "string" || !KEY_ID.test(input.keyId) || input.keyId !== sealed[1]) throw bad("keyId must be the sealed blob's key id");
  if (!Array.isArray(input.botScopes) || input.botScopes.length > 50 || !input.botScopes.every((s) => typeof s === "string" && /^[a-z0-9:._-]{1,100}$/i.test(s))) {
    throw bad("malformed bot scopes");
  }
}

/** K5 upsert: update the principal's active row in place (token, key_id, scopes, ids, dm channel, installed_at = updated_at = now,
 *  last_error_* cleared) or, when none, insert; a 23505 on insert (a concurrent install) → re-run the update once. Identical key set. */
export async function saveInstallation(principal: ExecPrincipal, input: NewInstallation): Promise<{ id: string; replaced: boolean }> {
  const pid = requirePrincipal(principal);
  checkNewInstallation(input);
  const nowIso = new Date().toISOString();
  const fields = {
    team_id: input.teamId,
    app_id: input.appId,
    bot_user_id: input.botUserId,
    bot_id: input.botId,
    bot_token_enc: input.botTokenSealed,
    key_id: input.keyId,
    bot_scopes: [...input.botScopes],
    user_id: input.userId,
    slack_dm_channel_id: input.dmChannelId,
    installed_at: nowIso,
    updated_at: nowIso,
    last_error_code: null,
    last_error_at: null
  };
  const updateInPlace = async (): Promise<string | null> => {
    const { data, error } = await db().from(INSTALLATIONS).update(fields).eq("principal_id", pid).is("revoked_at", null).select("id");
    if (error) throw failure("saveInstallation", error);
    const id = Array.isArray(data) ? str((data[0] as Row | undefined)?.id) : null;
    return id;
  };
  const replaced = await updateInPlace();
  if (replaced) return { id: replaced, replaced: true };
  const { data, error } = await db().from(INSTALLATIONS).insert({ principal_id: pid, ...fields }).select("id");
  if (!error) {
    const id = Array.isArray(data) ? str((data[0] as Row | undefined)?.id) : null;
    if (!id) throw new SlackStoreError("saveInstallation: no id returned", null);
    return { id, replaced: false };
  }
  if (pgCodeOf(error) === "23505") {
    // A concurrent install inserted the principal's active row first: replace it in place, once.
    const again = await updateInPlace();
    if (again) return { id: again, replaced: true };
  }
  throw failure("saveInstallation", error);
}

/** RPC 3. */
export async function revokeInstallation(installationId: string, reason: RevokeReason): Promise<{ revoked: boolean }> {
  if (!(REVOKE_REASONS as readonly string[]).includes(reason)) throw new TypeError("exec slack store: revokeInstallation: unknown reason");
  if (typeof installationId !== "string" || !SLACK_RE.installationId.test(installationId)) return { revoked: false };
  const { data, error } = await db().rpc(RPC_REVOKE, { p_installation_id: installationId, p_reason: reason });
  if (error) throw failure("revokeInstallation", error);
  const revoked = (data as Row | null)?.revoked;
  if (typeof revoked !== "boolean") throw new SlackStoreError("revokeInstallation: malformed answer", null);
  return { revoked };
}

/** RPC 4. null when the RPC is missing. */
export async function purgeInstallation(installationId: string): Promise<{ purged: boolean; events: number; posts: number; conversations: number } | null> {
  if (typeof installationId !== "string" || !SLACK_RE.installationId.test(installationId)) return { purged: false, events: 0, posts: 0, conversations: 0 };
  const { data, error } = await db().rpc(RPC_PURGE, { p_installation_id: installationId });
  if (error) {
    if (missing(error)) return null;
    throw failure("purgeInstallation", error);
  }
  const r = (data ?? {}) as Row;
  if (typeof r.purged !== "boolean") throw new SlackStoreError("purgeInstallation: malformed answer", null);
  const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return { purged: r.purged, events: n(r.events), posts: n(r.posts), conversations: n(r.conversations) };
}

/** C18 backstop (the daily purge): ids of installations revoked before `revokedBefore` whose purge never ran (purged_at null),
 *  oldest revocation first, at most `limit` (1..50). Schema missing → []; other errors throw. Ids only. */
export async function listUnpurgedRevokedInstallations(revokedBefore: string, limit: number, opts?: { signal?: AbortSignal }): Promise<string[]> {
  if (!isTime(revokedBefore)) throw new TypeError("exec slack store: listUnpurgedRevokedInstallations: revokedBefore must be a timestamp");
  const signal = opts?.signal;
  const q = db()
    .from(INSTALLATIONS)
    .select("id,revoked_at")
    .not("revoked_at", "is", null)
    .is("purged_at", null)
    .lt("revoked_at", revokedBefore)
    .order("revoked_at", { ascending: true })
    .limit(clampInt(limit, 1, 50, 10));
  const { data, error } = await (signal ? q.abortSignal(signal) : q);
  if (error) {
    if (missing(error)) return [];
    throw failure("listUnpurgedRevokedInstallations", error, signal);
  }
  const out: string[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const id = str(r.id);
    if (id && SLACK_RE.installationId.test(id)) out.push(id);
  }
  return out;
}

/** A Slack (or our own) error code as the CHECK accepts it: lowercase letters and underscores, at most 60. */
function healthCode(code: string): string {
  const c = String(code ?? "").toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 60);
  return ERROR_CODE.test(c) && /[a-z]/.test(c) ? c : "unknown_error";
}

/** Health (C34). Never throws (logs the id and code). */
export async function recordSlackError(installationId: string, code: string): Promise<void> {
  const c = healthCode(code);
  try {
    if (typeof installationId !== "string" || !SLACK_RE.installationId.test(installationId)) {
      console.warn(`[exec-slack] installation health not recorded (malformed installation id, code ${c})`);
      return;
    }
    const nowIso = new Date().toISOString();
    const { error } = await db()
      .from(INSTALLATIONS)
      .update({ last_error_code: c, last_error_at: nowIso, updated_at: nowIso })
      .eq("id", installationId)
      .is("revoked_at", null);
    if (error) console.error(`[exec-slack] installation health not recorded (${installationId}, code ${c}): ${pgCodeOf(error) ?? "error"}`);
  } catch (err) {
    console.error(`[exec-slack] installation health not recorded (${logId(installationId, SLACK_RE.installationId)}, code ${c}): ${err instanceof Error ? err.name : "error"}`);
  }
}

/** A successful post clears the health error (C34). Never throws (logs the id). */
export async function clearSlackError(installationId: string): Promise<void> {
  try {
    if (typeof installationId !== "string" || !SLACK_RE.installationId.test(installationId)) return;
    const { error } = await db()
      .from(INSTALLATIONS)
      .update({ last_error_code: null, last_error_at: null, updated_at: new Date().toISOString() })
      .eq("id", installationId)
      .is("revoked_at", null)
      .not("last_error_code", "is", null);
    if (error) console.error(`[exec-slack] installation health not cleared (${installationId}): ${pgCodeOf(error) ?? "error"}`);
  } catch (err) {
    console.error(`[exec-slack] installation health not cleared (${logId(installationId, SLACK_RE.installationId)}): ${err instanceof Error ? err.name : "error"}`);
  }
}

// ---------------------------------------------------------------------------
// OAuth states (C1)
// ---------------------------------------------------------------------------

/** C1. Deletes the principal's other slack states and every expired state, then inserts. */
export async function issueOAuthState(principal: ExecPrincipal, s: { nonceHash: string; authUserId: string; sessionId: string; ttlSeconds: number }): Promise<void> {
  const pid = requirePrincipal(principal);
  if (!s || typeof s.nonceHash !== "string" || !HEX64.test(s.nonceHash)) throw new TypeError("exec slack store: issueOAuthState: the nonce hash must be 64 lowercase hex");
  if (typeof s.authUserId !== "string" || s.authUserId.length < 1 || s.authUserId.length > 128) throw new TypeError("exec slack store: issueOAuthState: malformed auth user id");
  if (typeof s.sessionId !== "string" || s.sessionId.length < 1 || s.sessionId.length > 128) throw new TypeError("exec slack store: issueOAuthState: malformed session id");
  if (!Number.isInteger(s.ttlSeconds) || s.ttlSeconds < 1 || s.ttlSeconds > OAUTH_STATE_TTL_MAX_SEC) {
    throw new TypeError(`exec slack store: issueOAuthState: the TTL must be 1-${OAUTH_STATE_TTL_MAX_SEC} seconds`);
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // One live flow at a time: the principal's earlier states go, and so does every expired one.
  const other = await db().from(STATES).delete().eq("principal_id", pid).eq("provider", "slack");
  if (other.error) throw failure("issueOAuthState", other.error);
  const expired = await db().from(STATES).delete().lt("expires_at", nowIso);
  if (expired.error) throw failure("issueOAuthState", expired.error);
  const { error } = await db().from(STATES).insert({
    nonce_hash: s.nonceHash,
    provider: "slack",
    principal_id: pid,
    auth_user_id: s.authUserId,
    session_id: s.sessionId,
    created_at: nowIso,
    expires_at: new Date(now + s.ttlSeconds * 1000).toISOString()
  });
  if (error) throw failure("issueOAuthState", error);
}

/** C1 v2: delete … where nonce_hash = $1 returning principal_id, auth_user_id, session_id, expires_at (PostgREST
 *  .delete().eq("nonce_hash", h).select(...)). Single use whether expired or not; null only when no row exists (replayed,
 *  never issued, or already swept by issueOAuthState / the purge). The caller decides expiry from expiresAt. */
export async function consumeOAuthState(nonceHash: string): Promise<{ principalId: string; authUserId: string; sessionId: string; expiresAt: string } | null> {
  // No row can have another shape (exec_oauth_states_hash_check), so there is nothing to delete.
  if (typeof nonceHash !== "string" || !HEX64.test(nonceHash)) return null;
  const { data, error } = await db()
    .from(STATES)
    .delete()
    .eq("nonce_hash", nonceHash)
    .eq("provider", "slack")
    .select("principal_id,auth_user_id,session_id,expires_at");
  if (error) throw failure("consumeOAuthState", error);
  const r = Array.isArray(data) ? (data[0] as Row | undefined) : undefined;
  if (!r) return null;
  const principalId = str(r.principal_id);
  const authUserId = str(r.auth_user_id);
  const sessionId = str(r.session_id);
  const expiresAt = str(r.expires_at);
  if (!principalId || !authUserId || !sessionId || !isTime(expiresAt)) throw new SlackStoreError("consumeOAuthState: malformed row", null);
  return { principalId, authUserId, sessionId, expiresAt };
}

// ---------------------------------------------------------------------------
// The acks (RPCs 1 and 2)
// ---------------------------------------------------------------------------

/** RPC 1, on opts.signal (the route's 2 s controller). Schema missing → { outcome: "not_installed" }; any other error throws SlackStoreError. */
export async function acceptEvent(facts: SlackEventFacts, opts: { signal: AbortSignal }): Promise<AcceptEventResult> {
  const signal = opts?.signal;
  const { data, error } = await withSignal(
    db().rpc(RPC_ACCEPT_EVENT, {
      p_event_id: facts.eventId,
      p_team_id: facts.teamId,
      p_api_app_id: facts.apiAppId,
      p_event_type: facts.eventType,
      p_event_time: facts.eventTime,
      p_retry_num: facts.retryNum,
      p_channel: facts.channel,
      p_channel_type: facts.channelType,
      p_user: facts.user,
      p_ts: facts.ts,
      p_thread_ts: facts.threadTs,
      p_has_bot_id: facts.hasBotId,
      p_has_app_id: facts.hasAppId,
      p_subtype: facts.subtype,
      p_hidden: facts.hidden,
      p_text_is_string: facts.textIsString,
      p_has_message: facts.hasMessage,
      p_tab: facts.tab,
      p_revoked_bot_ids: facts.revokedBotIds,
      p_revoked_user_ids: facts.revokedUserIds
    }),
    signal
  );
  if (error) {
    signal?.throwIfAborted();
    if (missing(error)) return { outcome: "not_installed" };
    throw failure("acceptEvent", error, signal);
  }
  const r = (data ?? {}) as Row;
  if (r.outcome === "duplicate") return { outcome: "duplicate" };
  if (
    r.outcome === "accepted" &&
    typeof r.decision === "string" &&
    (DECISIONS as readonly string[]).includes(r.decision) &&
    (r.reason === null || typeof r.reason === "string") &&
    typeof r.enqueued === "boolean" &&
    typeof r.interactive === "boolean"
  ) {
    return { outcome: "accepted", decision: r.decision as SlackEventDecision, reason: r.reason as string | null, enqueued: r.enqueued, interactive: r.interactive };
  }
  throw new SlackStoreError("acceptEvent: malformed answer", null);
}

/** RPC 2, same rules. */
export async function acceptAction(facts: SlackActionFacts, opts: { signal: AbortSignal }): Promise<AcceptActionResult> {
  const signal = opts?.signal;
  const { data, error } = await withSignal(
    db().rpc(RPC_ACCEPT_ACTION, {
      p_team_id: facts.teamId,
      p_api_app_id: facts.apiAppId,
      p_user_id: facts.userId,
      p_trigger_id: facts.triggerId,
      p_action_id: facts.actionId,
      p_value: facts.value,
      p_container_type: facts.containerType,
      p_channel_id: facts.channelId,
      p_message_ts: facts.messageTs
    }),
    signal
  );
  if (error) {
    signal?.throwIfAborted();
    if (missing(error)) return { outcome: "not_installed" };
    throw failure("acceptAction", error, signal);
  }
  const r = (data ?? {}) as Row;
  if (r.outcome === "enqueued" || r.outcome === "duplicate") return { outcome: r.outcome };
  if (r.outcome === "ignored" && typeof r.reason === "string" && /^[a-z_]{1,40}$/.test(r.reason)) return { outcome: "ignored", reason: r.reason };
  throw new SlackStoreError("acceptAction: malformed answer", null);
}

// ---------------------------------------------------------------------------
// The DM reply (RPCs 5 and 6, the open-reply read)
// ---------------------------------------------------------------------------

/** RPC 5. */
export async function conversationForThread(principal: ExecPrincipal, input: { channel: string; rootTs: string; title: string; retentionDays: number }): Promise<string> {
  const pid = requirePrincipal(principal);
  const { data, error } = await db().rpc(RPC_CONVERSATION, {
    p_principal: pid,
    p_channel: input.channel,
    p_root_ts: input.rootTs,
    p_title: input.title,
    p_retention_days: input.retentionDays
  });
  if (error) throw failure("conversationForThread", error);
  if (typeof data !== "string" || !CONVERSATION_ID.test(data)) throw new SlackStoreError("conversationForThread: malformed answer", null);
  return data;
}

/** RPC 6. */
export async function replyStep(eventId: string, from: readonly ReplyState[], to: ReplyState,
  refs?: { placeholderTs?: string; conversationId?: string; assistantMessageId?: string }): Promise<boolean> {
  if (!Array.isArray(from) || !from.every((s) => (REPLY_STATES as readonly string[]).includes(s))) throw new TypeError("exec slack store: replyStep: unknown from state");
  if (!(REPLY_STATES as readonly string[]).includes(to)) throw new TypeError("exec slack store: replyStep: unknown target state");
  const { data, error } = await db().rpc(RPC_REPLY_STEP, {
    p_event_id: eventId,
    p_from: [...from],
    p_to: to,
    p_placeholder_ts: refs?.placeholderTs ?? null,
    p_conversation_id: refs?.conversationId ?? null,
    p_assistant_message_id: refs?.assistantMessageId ?? null
  });
  if (error) throw failure("replyStep", error);
  if (typeof data !== "boolean") throw new SlackStoreError("replyStep: malformed answer", null);
  return data;
}

export interface OpenReplyRow { eventId: string; installationId: string; principalId: string; channelId: string; messageTs: string;
  threadTs: string | null; replyState: "queued" | "started" | "placeholder"; placeholderTs: string | null; receivedAt: string; updatedAt: string }

/** C8 v2: principal_id = principal.id, reply_state in (queued, started, placeholder) and **updated_at** between since and before
 *  (exec_slack_events_open_idx on (principal_id, updated_at)), oldest updated_at first. received_at is returned, never filtered on. */
export async function listOpenReplies(principal: ExecPrincipal, q: { before: string; since: string; limit: number }): Promise<OpenReplyRow[]> {
  const pid = requirePrincipal(principal);
  if (!isTime(q?.before) || !isTime(q?.since)) throw new TypeError("exec slack store: listOpenReplies: before and since must be timestamps");
  const { data, error } = await db()
    .from(EVENTS)
    .select(OPEN_REPLY_COLS)
    .eq("principal_id", pid)
    .in("reply_state", [...OPEN_STATES])
    .gte("updated_at", q.since)
    .lte("updated_at", q.before)
    .order("updated_at", { ascending: true })
    .limit(clampInt(q.limit, 1, 100, 20));
  if (error) throw failure("listOpenReplies", error);
  const out: OpenReplyRow[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const state = str(r.reply_state);
    const eventId = str(r.event_id);
    const installationId = str(r.installation_id);
    const principalId = str(r.principal_id);
    const channelId = str(r.channel_id);
    const messageTs = str(r.message_ts);
    const receivedAt = str(r.received_at);
    const updatedAt = str(r.updated_at);
    // The reply-refs CHECK makes these present on every reply row; a row without them can't be swept by ts anyway.
    if (!eventId || !installationId || !principalId || !channelId || !messageTs || !receivedAt || !updatedAt) continue;
    if (state !== "queued" && state !== "started" && state !== "placeholder") continue;
    out.push({ eventId, installationId, principalId, channelId, messageTs, threadTs: str(r.thread_ts), replyState: state, placeholderTs: str(r.placeholder_ts), receivedAt, updatedAt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The post ledger (C43) and the redaction follow-ups (C42)
// ---------------------------------------------------------------------------

/** C43: one ledger row per successful post (identical key set; a 23505 on (installation_id, ts) is a no-op). Never throws:
 *  a failure is logged by installation id and ts. */
export async function recordSlackPost(principal: ExecPrincipal, p: { installationId: string; channelId: string; ts: string;
  threadTs: string | null; kind: SlackPostKind; messageId?: string | null; refId?: string | null }): Promise<void> {
  const where = `installation ${logId(p?.installationId, SLACK_RE.installationId)}, ts ${logId(p?.ts, SLACK_RE.ts)}`;
  try {
    const pid = requirePrincipal(principal);
    const messageId = p.messageId ?? null;
    const refId = p.refId ?? null;
    const shapeOk =
      SLACK_RE.installationId.test(String(p.installationId)) &&
      SLACK_RE.dm.test(String(p.channelId)) &&
      SLACK_RE.ts.test(String(p.ts)) &&
      (p.threadTs === null || SLACK_RE.ts.test(String(p.threadTs))) &&
      (POST_KINDS as readonly string[]).includes(p.kind) &&
      (messageId === null || MESSAGE_ID.test(String(messageId))) &&
      (refId === null || POST_REF.test(String(refId))) &&
      (p.kind === "draft" || p.kind === "proposal") === (refId !== null) &&
      (refId === null || (p.kind === "draft") === refId.startsWith("ed_"));
    if (!shapeOk) {
      console.warn(`[exec-slack] ledger row not written (${where}): malformed reference`);
      return;
    }
    const { error } = await db().from(POSTS).insert({
      installation_id: p.installationId,
      principal_id: pid,
      channel_id: p.channelId,
      ts: p.ts,
      thread_ts: p.threadTs,
      kind: p.kind,
      message_id: messageId,
      ref_id: refId
    });
    if (error && pgCodeOf(error) !== "23505") console.error(`[exec-slack] ledger row not written (${where}): ${pgCodeOf(error) ?? "error"}`);
  } catch (err) {
    console.error(`[exec-slack] ledger row not written (${where}): ${err instanceof Error ? err.name : "error"}`);
  }
}

/** The card posts (kind draft/proposal) of one assistant message, oldest first: { ts, kind, refId }. */
export async function listCardPostsForMessage(principal: ExecPrincipal, installationId: string, messageId: string): Promise<{ ts: string; kind: "draft" | "proposal"; refId: string }[]> {
  const pid = requirePrincipal(principal);
  if (!SLACK_RE.installationId.test(String(installationId)) || !MESSAGE_ID.test(String(messageId))) return [];
  const { data, error } = await db()
    .from(POSTS)
    .select("ts,kind,ref_id,posted_at")
    .eq("principal_id", pid)
    .eq("installation_id", installationId)
    .eq("message_id", messageId)
    .in("kind", ["draft", "proposal"])
    .order("posted_at", { ascending: true })
    .order("ts", { ascending: true })
    .limit(50);
  if (error) throw failure("listCardPostsForMessage", error);
  const out: { ts: string; kind: "draft" | "proposal"; refId: string }[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const ts = str(r.ts);
    const refId = str(r.ref_id);
    if (!ts || !refId || (r.kind !== "draft" && r.kind !== "proposal")) continue;
    out.push({ ts, kind: r.kind, refId });
  }
  return out;
}

/** C42: RPC 7. null when the RPC is missing (schema not applied). */
export async function listRedactionFollowups(principal: ExecPrincipal, installationId: string, limit: number): Promise<RedactionFollowups | null> {
  const pid = requirePrincipal(principal);
  if (!SLACK_RE.installationId.test(String(installationId))) return { answers: [], drafts: [] };
  const { data, error } = await db().rpc(RPC_FOLLOWUPS, {
    p_principal: pid,
    p_installation_id: installationId,
    p_limit: clampInt(limit, 1, 100, SLACK_LIMITS.followupsPerSweep)
  });
  if (error) {
    if (missing(error)) return null;
    throw failure("listRedactionFollowups", error);
  }
  const r = (data ?? {}) as Row;
  if (!Array.isArray(r.answers) || !Array.isArray(r.drafts)) throw new SlackStoreError("listRedactionFollowups: malformed answer", null);
  const answers: RedactionFollowups["answers"] = [];
  for (const a of r.answers as Row[]) {
    const ts = str(a?.ts);
    const messageId = str(a?.message_id);
    const conversationId = str(a?.conversation_id);
    const changedAt = str(a?.changed_at);
    if (!ts || !messageId || !conversationId || !changedAt || !DB_TIMESTAMP.test(changedAt)) throw new SlackStoreError("listRedactionFollowups: malformed answer", null);
    answers.push({ ts, messageId, conversationId, changedAt });
  }
  const drafts: RedactionFollowups["drafts"] = [];
  for (const d of r.drafts as Row[]) {
    const ts = str(d?.ts);
    const draftId = str(d?.draft_id);
    const changedAt = str(d?.changed_at);
    if (!ts || !draftId || !changedAt || !DB_TIMESTAMP.test(changedAt)) throw new SlackStoreError("listRedactionFollowups: malformed answer", null);
    drafts.push({ ts, draftId, changedAt });
  }
  // (c) proposal cards on their own (a card can post after (a) followed its answer).
  if (!Array.isArray(r.proposals)) throw new SlackStoreError("listRedactionFollowups: malformed answer", null);
  const proposals: NonNullable<RedactionFollowups["proposals"]> = [];
  for (const t of r.proposals as Row[]) {
    const ts = str(t?.ts);
    const proposalId = str(t?.proposal_id);
    const changedAt = str(t?.changed_at);
    if (!ts || !proposalId || !changedAt || !DB_TIMESTAMP.test(changedAt)) throw new SlackStoreError("listRedactionFollowups: malformed answer", null);
    proposals.push({ ts, proposalId, changedAt });
  }
  return { answers, drafts, proposals };
}

/** C42: update exec_slack_posts set followed_at = changedAt where installation_id, ts and (followed_at is null or followed_at < changedAt).
 *  changedAt goes back exactly as RPC 7 returned it (microseconds included): a value rounded to milliseconds would sit
 *  below the row's updated_at and bring the post back on every sweep. Two guarded updates (null first, then older),
 *  each of which only ever moves followed_at forward. */
export async function markPostFollowed(installationId: string, ts: string, changedAt: string): Promise<void> {
  if (!SLACK_RE.installationId.test(String(installationId)) || !SLACK_RE.ts.test(String(ts))) return;
  if (typeof changedAt !== "string" || !DB_TIMESTAMP.test(changedAt) || !Number.isFinite(Date.parse(changedAt))) {
    throw new TypeError("exec slack store: markPostFollowed: changedAt must be the timestamp RPC 7 returned");
  }
  const first = await db().from(POSTS).update({ followed_at: changedAt }).eq("installation_id", installationId).eq("ts", ts).is("followed_at", null).select("ts");
  if (first.error) throw failure("markPostFollowed", first.error);
  if (Array.isArray(first.data) && first.data.length > 0) return;
  const later = await db().from(POSTS).update({ followed_at: changedAt }).eq("installation_id", installationId).eq("ts", ts).lt("followed_at", changedAt);
  if (later.error) throw failure("markPostFollowed", later.error);
}

/** C42: a job other than the sweep re-rendered this post from rows it read earlier (a feedback vote, a card action or
 *  refresh). Its chat.update can land after the sweep followed a redaction, so the follow marker goes back to null and
 *  RPC 7 re-checks the post next sweep (at most one idempotent re-render of an already-redacted post). Never throws:
 *  a failure is logged by installation id and ts. */
export async function resetPostFollowed(installationId: string, ts: string): Promise<void> {
  const where = `installation ${logId(installationId, SLACK_RE.installationId)}, ts ${logId(ts, SLACK_RE.ts)}`;
  try {
    if (!SLACK_RE.installationId.test(String(installationId)) || !SLACK_RE.ts.test(String(ts))) return;
    const { error } = await db().from(POSTS).update({ followed_at: null }).eq("installation_id", installationId).eq("ts", ts).not("followed_at", "is", null);
    if (error) console.error(`[exec-slack] follow marker not reset (${where}): ${pgCodeOf(error) ?? "error"}`);
  } catch (err) {
    console.error(`[exec-slack] follow marker not reset (${where}): ${err instanceof Error ? err.name : "error"}`);
  }
}

/** C19: ledger rows of the installation with posted_at < cutoff, oldest first (exec_slack_posts_posted_idx). */
export async function listOldSlackPosts(installationId: string, cutoff: string, limit: number): Promise<{ ts: string; kind: SlackPostKind }[]> {
  if (!SLACK_RE.installationId.test(String(installationId))) return [];
  if (!isTime(cutoff)) throw new TypeError("exec slack store: listOldSlackPosts: cutoff must be a timestamp");
  const { data, error } = await db()
    .from(POSTS)
    .select("ts,kind,posted_at")
    .eq("installation_id", installationId)
    .lt("posted_at", cutoff)
    .order("posted_at", { ascending: true })
    .order("ts", { ascending: true })
    .limit(clampInt(limit, 1, MAX_ROWS, 100));
  if (error) throw failure("listOldSlackPosts", error);
  const out: { ts: string; kind: SlackPostKind }[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const ts = str(r.ts);
    const kind = str(r.kind);
    if (!ts || !kind || !(POST_KINDS as readonly string[]).includes(kind)) continue;
    out.push({ ts, kind: kind as SlackPostKind });
  }
  return out;
}

export async function deleteSlackPostRecord(installationId: string, ts: string): Promise<void> {
  if (!SLACK_RE.installationId.test(String(installationId)) || !SLACK_RE.ts.test(String(ts))) return;
  const { error } = await db().from(POSTS).delete().eq("installation_id", installationId).eq("ts", ts);
  if (error) throw failure("deleteSlackPostRecord", error);
}

/** C17 v2 (security-2): enqueue exec.slack-uninstall { installation_id, mode: "check", event_time: nowSec } on the bulk lane,
 *  maxAttempts 3, dedupe `slack-revoke-check:auth:<installationId>:<yyyymmddhh UTC>` (enqueueJob). Never throws. */
export async function enqueueRevokeCheck(installationId: string, now: Date): Promise<void> {
  const where = logId(installationId, SLACK_RE.installationId);
  try {
    if (!SLACK_RE.installationId.test(String(installationId)) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
      console.warn(`[exec-slack] revoke check not enqueued (${where}): bad input`);
      return;
    }
    const hour = now.toISOString().slice(0, 13).replace(/[-T]/g, "");
    await enqueueJob({
      kind: SLACK_JOB_KINDS.uninstall,
      lane: "bulk",
      principalId: null,
      payload: { installation_id: installationId, mode: "check", event_time: Math.floor(now.getTime() / 1000) },
      dedupeKey: `slack-revoke-check:auth:${installationId}:${hour}`,
      maxAttempts: 3
    });
  } catch (err) {
    console.error(`[exec-slack] revoke check not enqueued (${where}): ${err instanceof Error ? err.name : "error"}`);
  }
}

// ---------------------------------------------------------------------------
// Answer feedback (C16, C41)
// ---------------------------------------------------------------------------

/** C41: the assistant row whose slack_ts = ts (exec_messages_slack_ts_key): { messageId, conversationId } or null. Reads only id, conversation_id. */
export async function findAnswerBySlackTs(principal: ExecPrincipal, ts: string): Promise<{ messageId: string; conversationId: string } | null> {
  const pid = requirePrincipal(principal);
  if (typeof ts !== "string" || !SLACK_RE.ts.test(ts)) return null;
  const { data, error } = await db()
    .from(MESSAGES)
    .select("id,conversation_id")
    .eq("principal_id", pid)
    .eq("slack_ts", ts)
    .eq("role", "assistant")
    .limit(1);
  if (error) throw failure("findAnswerBySlackTs", error);
  const r = Array.isArray(data) ? (data[0] as Row | undefined) : undefined;
  const messageId = str(r?.id);
  const conversationId = str(r?.conversation_id);
  return messageId && conversationId ? { messageId, conversationId } : null;
}

/** C16 upsert (identical key set). The message must be the principal's assistant row (checked first) → else "not_found". */
export async function recordChatFeedback(principal: ExecPrincipal, messageId: string, vote: 1 | -1, surface: "web" | "slack"): Promise<"recorded" | "not_found"> {
  const pid = requirePrincipal(principal);
  if (vote !== 1 && vote !== -1) throw new TypeError("exec slack store: recordChatFeedback: the vote must be 1 or -1");
  if (surface !== "web" && surface !== "slack") throw new TypeError("exec slack store: recordChatFeedback: unknown surface");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return "not_found";
  const own = await db().from(MESSAGES).select("id").eq("id", messageId).eq("principal_id", pid).eq("role", "assistant").limit(1);
  if (own.error) throw failure("recordChatFeedback", own.error);
  if (!Array.isArray(own.data) || own.data.length === 0) return "not_found";
  const { error } = await db()
    .from(FEEDBACK)
    .upsert({ principal_id: pid, message_id: messageId, vote, surface, updated_at: new Date().toISOString() }, { onConflict: "principal_id,message_id" });
  if (error) {
    // The answer went (chat retention, a purge) between the check and the write.
    if (pgCodeOf(error) === "23503") return "not_found";
    throw failure("recordChatFeedback", error);
  }
  return "recorded";
}

// ---------------------------------------------------------------------------
// Retention (§2.6) and the System card
// ---------------------------------------------------------------------------

/** exec_slack_events received more than `hours` ago, in chunks of 1,000 by event_id (each chunk: find its last id, delete up to it). */
export async function deleteOldSlackEvents(now: Date, hours: number, opts?: { signal?: AbortSignal }): Promise<number> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("exec slack store: deleteOldSlackEvents needs a valid now");
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 1) throw new TypeError("exec slack store: deleteOldSlackEvents needs hours >= 1");
  const signal = opts?.signal;
  const cutoff = new Date(now.getTime() - hours * 3_600_000).toISOString();
  let total = 0;
  for (let chunk = 0; chunk < PURGE_MAX_CHUNKS; chunk += 1) {
    signal?.throwIfAborted();
    const edge = await withSignal(
      db().from(EVENTS).select("event_id").lt("received_at", cutoff).order("event_id", { ascending: true }).range(PURGE_CHUNK - 1, PURGE_CHUNK - 1),
      signal
    );
    if (edge.error) {
      if (missing(edge.error)) return total;
      throw failure("deleteOldSlackEvents", edge.error, signal);
    }
    const last = Array.isArray(edge.data) ? str((edge.data[0] as Row | undefined)?.event_id) : null;
    let q = db().from(EVENTS).delete({ count: "exact" }).lt("received_at", cutoff);
    if (last !== null) q = q.lte("event_id", last);
    const { count, error } = await withSignal(q, signal);
    if (error) {
      if (missing(error)) return total;
      throw failure("deleteOldSlackEvents", error, signal);
    }
    total += typeof count === "number" && count > 0 ? count : 0;
    // Fewer than a chunk left: that delete took the rest.
    if (last === null) return total;
  }
  return total;
}

/** exec_oauth_states past their expires_at (the start route also sweeps them, issueOAuthState). */
export async function deleteExpiredOAuthStates(now: Date, opts?: { signal?: AbortSignal }): Promise<number> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("exec slack store: deleteExpiredOAuthStates needs a valid now");
  const signal = opts?.signal;
  const { count, error } = await withSignal(db().from(STATES).delete({ count: "exact" }).lt("expires_at", now.toISOString()), signal);
  if (error) {
    if (missing(error)) return 0;
    throw failure("deleteExpiredOAuthStates", error, signal);
  }
  return typeof count === "number" && count > 0 ? count : 0;
}

/** null = schema missing. */
export async function slackSystemSummary(principal: ExecPrincipal): Promise<SlackSystemSummary | null> {
  let row: InstallationRow | null;
  try {
    row = (await getActiveInstallation(principal)) ?? (await getLatestInstallation(principal));
  } catch (err) {
    if (isSlackSchemaMissing(err)) return null;
    throw err;
  }
  if (!row) return { state: "not_connected", lastDmAt: null, lastErrorCode: null, revokedAt: null };
  if (row.revokedAt !== null) return { state: "revoked", lastDmAt: row.lastDmAt, lastErrorCode: row.lastErrorCode, revokedAt: row.revokedAt };
  return { state: row.lastErrorCode !== null ? "error" : "connected", lastDmAt: row.lastDmAt, lastErrorCode: row.lastErrorCode, revokedAt: null };
}
