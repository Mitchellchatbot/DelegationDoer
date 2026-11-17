import type { FakeSlackDbError, Row } from "./fake-slack-db";
import { randomUUID } from "node:crypto";
import { PgError, arr, card, createEngine, isNull, isoOf, len, matches, ms, optional, raise, type EngineContext, type EngineSeed, type EngineSpec } from "./fake-p10-engine";

// P10 test fake: a standalone in-memory Supabase for slack-reply-store.ts (P10 contract §5.14; Area A), in the style of
// P8's fake-brief-db.ts. The INTERFACE is frozen at stage 0 (lead); Area A writes the body.
//
//   const db = createFakeReplyDb({ tables: { exec_slack_messages: [msg], exec_slack_channels: [ch] } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
//
// What it mirrors (§2.1.6, §2.1.8-§2.1.13, §2.1.16, kept equal to the SQL by Area A's twins of SQ12-SQ27): the three reply
// tables with their DDL defaults, NOT NULLs (23502), named CHECKs (23514; the destination, status, version, sending and
// text_presence CHECKs; the voice table's expires_at <= built_at + 31 days, so v1's "unchanged" update fails as in SQL), the
// active-draft unique key exec_slack_reply_drafts_active_key and the primary keys (23505), the FKs (23503) and the cascade
// when a fake P7a message row is deleted (deleteMessages, the FK ON UPDATE CASCADE ON DELETE CASCADE to exec_slack_messages);
// rpc(name, args) for the seven reply functions of §2.1.9-§2.1.13 with their bodies mirrored line for line (v1.1: RPC 13's
// p_from_draft copy and checks, RPC 15's external_seen and edit snapshot, RPC 18's p_before); the plain-row CAS updates of
// §2.1.16 X1-X13 through the client's update builders (v1.1: X4's content_purged_at fence, X4b, X10's verify_checks = 3
// fence, X12, X13); P7a's channels, messages, items, author opt-outs and installations as plain rows the RPCs read.
//   * missing tables / functions / columns: a name in `missing` → PGRST205 for a table, PGRST202 for an RPC, 42703 for a
//     "table.column" selected and PGRST204 for one written; failNext(op, code) makes the next matching request answer that
//     code once (op: a table or RPC name, or "<kind>:<table>", e.g. "update:exec_slack_reply_drafts");
//   * an aborted signal → postgrest-js's abort result (code "").
// Rows in `tables` are plain snake_case objects; tests read and mutate them directly. Areas B-D consume this fake; none
// edits it.

/** The tables the fake holds: the three reply tables and the P6 / P7a rows their functions read. */
export type FakeReplyTable =
  | "exec_slack_reply_drafts" | "exec_slack_reply_cards" | "exec_slack_voice_profile"
  | "exec_slack_messages" | "exec_slack_channels" | "exec_slack_items" | "exec_slack_author_optouts"
  | "exec_slack_installations" | "exec_settings";

/** The seven reply functions (§2.1.9-§2.1.13). */
export type FakeReplyRpc =
  | "exec_slack_rdraft_create" | "exec_slack_rdraft_regenerate" | "exec_slack_rdraft_finish" | "exec_slack_rdraft_edit"
  | "exec_slack_rdraft_target" | "exec_slack_rdraft_blank" | "exec_slack_rdraft_purge_expired";

export const FAKE_REPLY_TABLES: readonly FakeReplyTable[] = Object.freeze([
  "exec_slack_reply_drafts", "exec_slack_reply_cards", "exec_slack_voice_profile",
  "exec_slack_messages", "exec_slack_channels", "exec_slack_items", "exec_slack_author_optouts",
  "exec_slack_installations", "exec_settings"
] as FakeReplyTable[]);

export const FAKE_REPLY_RPCS: readonly FakeReplyRpc[] = Object.freeze([
  "exec_slack_rdraft_create", "exec_slack_rdraft_regenerate", "exec_slack_rdraft_finish", "exec_slack_rdraft_edit",
  "exec_slack_rdraft_target", "exec_slack_rdraft_blank", "exec_slack_rdraft_purge_expired"
] as FakeReplyRpc[]);

export type FakeReplyFilter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "contains" | "overlaps"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: FakeReplyFilter };

/** One request the client received, in order (P8's record shape). */
export interface FakeReplyDbCall {
  kind: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  /** The table, or the RPC name. */
  target: string;
  /** select(...)'s column list (also delete().select(...)'s), else null. */
  columns: string | null;
  /** The insert / update / upsert values, or the RPC's arguments. */
  payload: unknown;
  /** upsert / insert options (onConflict, ignoreDuplicates, count), else null. */
  options: Record<string, unknown> | null;
  filters: FakeReplyFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
  range: [number, number] | null;
  single: "maybe" | "single" | null;
  signal: AbortSignal | null;
}

export interface FakeReplyDbSeed {
  /** Initial rows per table (copied). */
  tables?: Partial<Record<FakeReplyTable, Row[]>>;
  /** Tables, RPCs and "table.column" names that don't exist (see the header). */
  missing?: readonly string[];
  /** An error for this request, or null / undefined to run it. */
  fail?: (call: FakeReplyDbCall) => FakeSlackDbError | null | undefined;
  /** Runs just before a request executes: simulate another writer (a purge mid-send, X6 between the CAS and the post) here. */
  before?: (call: FakeReplyDbCall, db: FakeReplyDb) => void | Promise<void>;
  /** The clock now() / the RPCs use (default: the real clock). */
  now?: () => Date;
}

export interface FakeReplyDb {
  /** A Supabase-shaped client (from(table) builders and rpc(name, args)) for vi.mock("@/lib/supabase-admin"). */
  client: unknown;
  /** Every table of FakeReplyTable, always present (empty when unseeded). */
  tables: Record<FakeReplyTable, Row[]>;
  /** Every request, in order. */
  calls: FakeReplyDbCall[];
  /** The tables, RPCs and columns currently missing (mutable). */
  missing: Set<string>;
  /** One of the seven functions, called directly with its p_* arguments (the client's rpc() goes through it too). */
  rpc(name: FakeReplyRpc, args: Record<string, unknown>): Promise<{ data: unknown; error: FakeSlackDbError | null }>;
  /** The next request whose op matches (a table or RPC name, or "<kind>:<table>") answers { code, message } once. */
  failNext(op: string, code: string, message?: string): void;
  /** How many writes ran (insert / update / upsert / delete, and the writing RPCs: create, regenerate, finish, edit, blank,
   *  purge_expired). */
  mutations(): number;
  /** A P7a purge deletes these message rows (mark_deleted, purge_conversation, purge_author, purge_expired, purge_reading): the
   *  FK cascade removes every draft whose (principal_id, channel_id, source_ts) is one of them, in the same step. Returns the
   *  number of drafts removed. Cards stay (no FK). */
  deleteMessages(principalId: string, channelId: string, ts: readonly string[]): number;
}

// ---------------------------------------------------------------------------
// The body (Area A): the reply tables' DDL (§2.1.6, §2.1.8) and the seven functions (§2.1.9-§2.1.13), line for line.
// P7a's 26-hour deleted markers (exec_slack_deleted), which RPCs 13, 15 and 17 read, are held too, outside FakeReplyTable (the
// frozen union): seed them with `tables: { exec_slack_deleted: [...] } as never` and reach them as
// `(db.tables as Record<string, Row[]>).exec_slack_deleted`.
// ---------------------------------------------------------------------------

const RD = "exec_slack_reply_drafts";
const RC = "exec_slack_reply_cards";
const VP = "exec_slack_voice_profile";
const MS = "exec_slack_messages";
const CHN = "exec_slack_channels";
const ITM = "exec_slack_items";
const OPT = "exec_slack_author_optouts";
const INS = "exec_slack_installations";
const DEL = "exec_slack_deleted";
const TS_RE = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const USER_RE = /^[UW][A-Z0-9]{2,30}$/;
const CODE_RE = /^[a-z0-9_]{1,60}$/;
const ACTIVE = ["generating", "generation_failed", "draft", "sending", "unknown"];
const TERMINAL = ["sent", "failed", "discarded", "expired", "removed"];
const DRAFT_STATUSES = ["generating", "generation_failed", "draft", "sending", "sent", "unknown", "failed", "discarded", "expired", "removed"];
const FLAG_SET = ["unexpected_url", "unexpected_email", "unexpected_phone", "unexpected_amount", "unexpected_number", "mention", "broadcast"];
const GEN_ERRORS = ["refused", "truncated", "invalid_output", "empty", "too_long", "copied_external", "timeout", "model_error", "budget",
  "context_unavailable", "reading_off", "channel", "context_deleted", "author_optout"];
const CARD_STATE_SET = ["generating", "failed_generation", "live", "dd_only", "sending", "sent", "unknown", "failed", "discarded", "expired", "removed", "off"];
const RDAY = 86_400_000;

const REPLY_COLUMNS: Record<string, readonly string[]> = {
  [RD]: ["id", "principal_id", "installation_id", "channel_id", "conv_type", "item_id", "source_ts", "source_thread_ts", "reply_thread_ts", "origin", "status",
    "status_reason", "version", "generation_seq", "text", "instruction", "note", "placeholders", "edited", "flags", "injection_suspected", "voice_source",
    "model", "generation_error", "context_ts", "context_authors", "context_latest_ts", "source_edited_ts", "external", "finance", "generated_at", "sending_at",
    "audit_id", "sent_at", "posted_ts", "posted_permalink", "sent_text_sha256", "sent_words_sha256", "verify_checks", "owner_resolution", "chat_message_id",
    "terminal_at", "content_purged_at", "expires_at", "created_at", "updated_at"],
  [RC]: ["installation_id", "principal_id", "dm_channel_id", "dm_ts", "thread_ts", "draft_id", "origin", "rendered_version", "rendered_state", "posted_at",
    "followed_at", "expires_at"],
  [VP]: ["principal_id", "status", "formality", "typical_length", "capitalization", "punctuation", "greeting", "emoji", "abbreviations", "exclamations",
    "bullets", "sample_count", "sample_refs", "sample_channels", "samples_hash", "model", "prompt_version", "last_attempt_error", "built_at", "expires_at",
    "updated_at"]
};
const REPLY_NOT_NULL: Record<string, readonly string[]> = {
  [RD]: ["id", "principal_id", "installation_id", "channel_id", "conv_type", "source_ts", "origin", "status", "version", "generation_seq", "placeholders",
    "edited", "flags", "injection_suspected", "context_ts", "context_authors", "external", "finance", "verify_checks", "expires_at", "created_at", "updated_at"],
  [RC]: ["installation_id", "principal_id", "dm_channel_id", "dm_ts", "draft_id", "origin", "rendered_version", "rendered_state", "posted_at", "expires_at"],
  [VP]: ["principal_id", "status", "sample_count", "sample_refs", "sample_channels", "prompt_version", "built_at", "expires_at", "updated_at"]
};

const tsArrayOk = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && TS_RE.test(x));
const userArrayOk = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && USER_RE.test(x));
const refArrayOk = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && /^[CGD][A-Z0-9]{2,30}:[0-9]{1,12}\.[0-9]{1,8}$/.test(x));
const channelArrayOk = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string" && /^[CGD][A-Z0-9]{2,30}$/.test(x));
const inList = (v: unknown, list: readonly string[]) => isNull(v) || list.includes(String(v));

function replyChecks(table: string, r: Row): string[] {
  const out: [string, boolean][] = [];
  const check = (name: string, ok: boolean) => out.push([name, ok]);
  if (table === RD) {
    const st = String(r.status);
    check("exec_slack_reply_drafts_id_check", matches(r.id, /^esr_[0-9a-f]{32}$/));
    check("exec_slack_reply_drafts_channel_check", matches(r.channel_id, /^[CGD][A-Z0-9]{2,30}$/));
    check("exec_slack_reply_drafts_conv_check", ["channel", "group", "im", "mpim"].includes(String(r.conv_type)));
    check("exec_slack_reply_drafts_item_check", optional(r.item_id, /^esl_[0-9a-f]{32}$/));
    check("exec_slack_reply_drafts_source_ts_check", matches(r.source_ts, TS_RE));
    check("exec_slack_reply_drafts_source_thread_check", isNull(r.source_thread_ts) || (matches(r.source_thread_ts, TS_RE) && r.source_thread_ts !== r.source_ts));
    check("exec_slack_reply_drafts_reply_thread_check", optional(r.reply_thread_ts, TS_RE));
    check("exec_slack_reply_drafts_origin_check", ["web", "chat", "slack", "auto"].includes(String(r.origin)));
    check("exec_slack_reply_drafts_status_check", DRAFT_STATUSES.includes(st));
    check("exec_slack_reply_drafts_reason_check", optional(r.status_reason, CODE_RE));
    check("exec_slack_reply_drafts_version_check", typeof r.version === "number" && r.version >= 0 && r.version <= 9999);
    check("exec_slack_reply_drafts_seq_check", typeof r.generation_seq === "number" && r.generation_seq >= 1 && r.generation_seq <= 1000);
    check("exec_slack_reply_drafts_text_check", isNull(r.text) || (len(r.text) >= 1 && len(r.text) <= 4000));
    check("exec_slack_reply_drafts_instruction_check", isNull(r.instruction) || (len(r.instruction) >= 1 && len(r.instruction) <= 2000));
    check("exec_slack_reply_drafts_note_check", isNull(r.note) || (len(r.note) >= 1 && len(r.note) <= 400));
    check("exec_slack_reply_drafts_placeholders_check", card(r.placeholders) <= 20);
    check("exec_slack_reply_drafts_flags_check", arr(r.flags).every((f) => FLAG_SET.includes(f)));
    check("exec_slack_reply_drafts_voice_check", inList(r.voice_source, ["slack", "email", "house"]));
    check("exec_slack_reply_drafts_model_check", isNull(r.model) || (len(r.model) >= 1 && len(r.model) <= 64));
    check("exec_slack_reply_drafts_generror_check", inList(r.generation_error, GEN_ERRORS));
    check("exec_slack_reply_drafts_context_ts_check", card(r.context_ts) <= 80 && tsArrayOk(r.context_ts));
    check("exec_slack_reply_drafts_context_authors_check", card(r.context_authors) <= 80 && userArrayOk(r.context_authors));
    check("exec_slack_reply_drafts_latest_check", optional(r.context_latest_ts, TS_RE));
    check("exec_slack_reply_drafts_edited_check", optional(r.source_edited_ts, TS_RE));
    check("exec_slack_reply_drafts_posted_check", optional(r.posted_ts, TS_RE));
    check("exec_slack_reply_drafts_permalink_check", isNull(r.posted_permalink) || (len(r.posted_permalink) <= 500
      && matches(r.posted_permalink, /^https:\/\/[a-z0-9][a-z0-9-]*\.slack\.com\/archives\/[CGD][A-Z0-9]{2,30}\/p[0-9]{10,20}/)));
    check("exec_slack_reply_drafts_sha_check", optional(r.sent_text_sha256, /^[0-9a-f]{64}$/));
    check("exec_slack_reply_drafts_words_check", optional(r.sent_words_sha256, /^[0-9a-f]{64}$/));
    check("exec_slack_reply_drafts_verify_check", typeof r.verify_checks === "number" && r.verify_checks >= 0 && r.verify_checks <= 3);
    check("exec_slack_reply_drafts_resolution_check", inList(r.owner_resolution, ["posted", "not_posted"]));
    check("exec_slack_reply_drafts_chat_check", optional(r.chat_message_id, /^ecm_[0-9a-f]{32}$/));
    const root = isNull(r.source_thread_ts) ? r.source_ts : r.source_thread_ts;
    check("exec_slack_reply_drafts_destination_check", (isNull(r.reply_thread_ts) || r.reply_thread_ts === root)
      && (!["channel", "group"].includes(String(r.conv_type)) || !isNull(r.reply_thread_ts))
      && (!["im", "mpim"].includes(String(r.conv_type)) || (r.reply_thread_ts ?? null) === (r.source_thread_ts ?? null)));
    check("exec_slack_reply_drafts_text_presence_check", st !== "draft" || !isNull(r.text));
    check("exec_slack_reply_drafts_version_presence_check", !["draft", "sending", "sent", "unknown", "failed"].includes(st) || Number(r.version) >= 1);
    check("exec_slack_reply_drafts_terminal_check", TERMINAL.includes(st) === !isNull(r.terminal_at));
    check("exec_slack_reply_drafts_sent_check", (st === "sent") === !isNull(r.sent_at));
    check("exec_slack_reply_drafts_sent_refs_check", st !== "sent" || !isNull(r.posted_ts) || r.owner_resolution === "posted");
    check("exec_slack_reply_drafts_sending_check", !["sending", "sent", "unknown"].includes(st) || (!isNull(r.sending_at) && !isNull(r.audit_id)));
    check("exec_slack_reply_drafts_resolution_pair_check", isNull(r.owner_resolution) || (r.owner_resolution === "posted" && st === "sent")
      || (r.owner_resolution === "not_posted" && st === "failed"));
    check("exec_slack_reply_drafts_generation_check", st !== "generation_failed" || !isNull(r.generation_error));
    check("exec_slack_reply_drafts_content_check", isNull(r.content_purged_at)
      || (isNull(r.text) && isNull(r.instruction) && isNull(r.note) && card(r.placeholders) === 0));
    check("exec_slack_reply_drafts_expiry_check", ms(r.expires_at) > ms(r.created_at));
  } else if (table === RC) {
    check("exec_slack_reply_cards_channel_check", matches(r.dm_channel_id, /^D[A-Z0-9]{2,30}$/));
    check("exec_slack_reply_cards_ts_check", matches(r.dm_ts, TS_RE));
    check("exec_slack_reply_cards_thread_check", optional(r.thread_ts, TS_RE));
    check("exec_slack_reply_cards_draft_check", matches(r.draft_id, /^esr_[0-9a-f]{32}$/));
    check("exec_slack_reply_cards_origin_check", ["slack", "auto"].includes(String(r.origin)));
    check("exec_slack_reply_cards_version_check", typeof r.rendered_version === "number" && r.rendered_version >= 0 && r.rendered_version <= 9999);
    check("exec_slack_reply_cards_state_check", CARD_STATE_SET.includes(String(r.rendered_state)));
    check("exec_slack_reply_cards_expiry_check", ms(r.expires_at) > ms(r.posted_at));
  } else if (table === VP) {
    const ready = r.status === "ready";
    check("exec_slack_voice_profile_status_check", ["ready", "insufficient", "failed"].includes(String(r.status)));
    check("exec_slack_voice_profile_formality_check", inList(r.formality, ["very_casual", "casual", "neutral", "formal"]));
    check("exec_slack_voice_profile_length_check", inList(r.typical_length, ["one_liner", "short", "medium", "long"]));
    check("exec_slack_voice_profile_caps_check", inList(r.capitalization, ["mostly_lowercase", "standard"]));
    check("exec_slack_voice_profile_punct_check", inList(r.punctuation, ["minimal", "standard"]));
    check("exec_slack_voice_profile_greeting_check", inList(r.greeting, ["none", "name_only", "hey_name", "hi_name", "mixed"]));
    check("exec_slack_voice_profile_emoji_check", inList(r.emoji, ["never", "rarely", "sometimes", "often"]));
    check("exec_slack_voice_profile_abbrev_check", inList(r.abbreviations, ["never", "sometimes", "often"]));
    check("exec_slack_voice_profile_excl_check", inList(r.exclamations, ["never", "sometimes", "often"]));
    check("exec_slack_voice_profile_bullets_check", inList(r.bullets, ["never", "sometimes", "often"]));
    check("exec_slack_voice_profile_count_check", typeof r.sample_count === "number" && r.sample_count >= 0 && r.sample_count <= 60);
    check("exec_slack_voice_profile_refs_check", card(r.sample_refs) <= 60 && refArrayOk(r.sample_refs));
    check("exec_slack_voice_profile_channels_check", card(r.sample_channels) <= 10 && channelArrayOk(r.sample_channels));
    check("exec_slack_voice_profile_hash_check", optional(r.samples_hash, /^[0-9a-f]{64}$/));
    check("exec_slack_voice_profile_model_check", isNull(r.model) || (len(r.model) >= 1 && len(r.model) <= 64));
    check("exec_slack_voice_profile_prompt_check", len(r.prompt_version) >= 1 && len(r.prompt_version) <= 40);
    check("exec_slack_voice_profile_error_check", inList(r.last_attempt_error, ["declined", "truncated", "invalid_output", "budget", "read_failed", "insufficient"]));
    check("exec_slack_voice_profile_ready_check", !ready || ["formality", "typical_length", "capitalization", "punctuation", "greeting", "emoji",
      "abbreviations", "exclamations", "bullets"].every((c) => !isNull(r[c])));
    check("exec_slack_voice_profile_expiry_check", ms(r.expires_at) > ms(r.built_at) && ms(r.expires_at) <= ms(r.built_at) + 31 * RDAY);
  }
  return out.filter(([, ok]) => !ok).map(([name]) => name);
}

const hex32 = () => randomUUID().replace(/-/g, "");

const REPLY_SPEC: EngineSpec = {
  tables: [...FAKE_REPLY_TABLES, DEL],
  columns: REPLY_COLUMNS,
  notNull: REPLY_NOT_NULL,
  unique: {
    [RD]: [
      { name: "exec_slack_reply_drafts_pkey", cols: ["id"] },
      { name: "exec_slack_reply_drafts_active_key", cols: ["principal_id", "channel_id", "source_ts"], where: (r) => ACTIVE.includes(String(r.status)) }
    ],
    [RC]: [{ name: "exec_slack_reply_cards_pkey", cols: ["installation_id", "dm_ts"] }],
    [VP]: [{ name: "exec_slack_voice_profile_pkey", cols: ["principal_id"] }],
    [MS]: [{ name: "exec_slack_messages_pkey", cols: ["principal_id", "channel_id", "ts"] }]
  },
  defaults(table, nowIso) {
    if (table === RD) {
      return { ...Object.fromEntries(REPLY_COLUMNS[RD].map((c) => [c, null])), id: `esr_${hex32()}`, status: "generating", version: 0, generation_seq: 1,
        placeholders: [], edited: false, flags: [], injection_suspected: false, context_ts: [], context_authors: [], verify_checks: 0, created_at: nowIso,
        updated_at: nowIso };
    }
    if (table === RC) return { thread_ts: null, followed_at: null, posted_at: nowIso };
    if (table === VP) {
      return { ...Object.fromEntries(REPLY_COLUMNS[VP].map((c) => [c, null])), sample_count: 0, sample_refs: [], sample_channels: [], updated_at: nowIso };
    }
    return {};
  },
  checks: replyChecks,
  foreignKeys(table, candidates, changed, tables) {
    const touches = changed === "all" || ["principal_id", "channel_id", "source_ts"].some((c) => changed.has(c));
    if (table === RD && touches) {
      for (const c of candidates) {
        if (!(tables[MS] ?? []).some((m) => m.principal_id === c.principal_id && m.channel_id === c.channel_id && m.ts === c.source_ts)) {
          return new PgError("23503", 'insert or update on table "exec_slack_reply_drafts" violates foreign key constraint "exec_slack_reply_drafts_message_fkey"');
        }
      }
    }
    return null;
  },
  onDelete(table, removed, ctx) {
    if (table === MS) {
      const keys = new Set(removed.map((m) => `${String(m.principal_id)}|${String(m.channel_id)}|${String(m.ts)}`));
      ctx.deleteRows(RD, ctx.rowsOf(RD).filter((d) => keys.has(`${String(d.principal_id)}|${String(d.channel_id)}|${String(d.source_ts)}`)));
      ctx.deleteRows(ITM, ctx.rowsOf(ITM).filter((i) => keys.has(`${String(i.principal_id)}|${String(i.channel_id)}|${String(i.ts)}`)));
    } else if (table === CHN) {
      const keys = new Set(removed.map((c) => `${String(c.principal_id)}|${String(c.channel_id)}`));
      ctx.deleteRows(MS, ctx.rowsOf(MS).filter((m) => keys.has(`${String(m.principal_id)}|${String(m.channel_id)}`)));
    } else if (table === INS) {
      const ids = new Set(removed.map((i) => i.id));
      ctx.deleteRows(CHN, ctx.rowsOf(CHN).filter((c) => ids.has(c.installation_id)));
      ctx.deleteRows(RD, ctx.rowsOf(RD).filter((d) => ids.has(d.installation_id)));
      ctx.deleteRows(RC, ctx.rowsOf(RC).filter((c) => ids.has(c.installation_id)));
    }
  },
  writeRpcs: new Set(["exec_slack_rdraft_create", "exec_slack_rdraft_regenerate", "exec_slack_rdraft_finish", "exec_slack_rdraft_edit",
    "exec_slack_rdraft_blank", "exec_slack_rdraft_purge_expired"])
};

const answer = (v: Row) => ({ outcome: v.outcome, id: v.id, status: v.status, version: v.version, generation_seq: v.generation_seq, edited: v.edited });

function replyRpcs(): Record<string, (args: Row, ctx: EngineContext) => unknown> {
  const expiresOk = (v: unknown, now: Date) => !isNull(v) && ms(v) > now.getTime() && ms(v) <= now.getTime() + 8 * RDAY;
  const deletedAt = (ctx: EngineContext, p: unknown, ch: unknown, ts: unknown) =>
    ctx.rowsOf(DEL).some((x) => x.principal_id === p && x.channel_id === ch && x.ts === ts);
  const activeOf = (ctx: EngineContext, p: unknown, ch: unknown, ts: unknown) =>
    ctx.rowsOf(RD).find((d) => d.principal_id === p && d.channel_id === ch && d.source_ts === ts && ACTIVE.includes(String(d.status)));
  return {
    // 13. exec_slack_rdraft_create
    exec_slack_rdraft_create(a, ctx) {
      const now = ctx.now();
      if (isNull(a.p_principal) || isNull(a.p_installation)) throw raise("exec_slack_rdraft_create: principal and installation are required");
      if (isNull(a.p_origin) || !["web", "chat", "slack", "auto"].includes(String(a.p_origin))) throw raise("exec_slack_rdraft_create: bad origin");
      if (!matches(a.p_channel, /^[CGD][A-Z0-9]{2,30}$/) || !matches(a.p_ts, TS_RE)) throw raise("exec_slack_rdraft_create: bad channel or ts");
      if (!isNull(a.p_item_id) && !matches(a.p_item_id, /^esl_[0-9a-f]{32}$/)) throw raise("exec_slack_rdraft_create: bad item");
      if (!isNull(a.p_instruction) && (len(a.p_instruction) < 1 || len(a.p_instruction) > 2000)) throw raise("exec_slack_rdraft_create: instruction");
      if (!isNull(a.p_from_draft) && (a.p_origin !== "web" || !matches(a.p_from_draft, /^esr_[0-9a-f]{32}$/) || !isNull(a.p_instruction))) {
        throw raise("exec_slack_rdraft_create: from_draft");
      }
      if (!expiresOk(a.p_expires_at, now)) throw raise("exec_slack_rdraft_create: expires_at");
      const inst = ctx.rowsOf(INS).find((i) => i.id === a.p_installation);
      if (!inst || inst.principal_id !== a.p_principal || !isNull(inst.revoked_at) || isNull(inst.user_token_enc)
          || !["discovering", "ready"].includes(String(inst.reading_state))) {
        return { outcome: "refused", reason: "not_reading" };
      }
      const ch = ctx.rowsOf(CHN).find((c) => c.principal_id === a.p_principal && c.channel_id === a.p_channel);
      if (!ch || ch.installation_id !== a.p_installation || !["standard", "external", "finance"].includes(String(ch.class)) || ch.is_member !== true
          || !isNull(ch.left_at)) {
        return { outcome: "refused", reason: "channel" };
      }
      const m = ctx.rowsOf(MS).find((x) => x.principal_id === a.p_principal && x.channel_id === a.p_channel && x.ts === a.p_ts);
      if (!m || m.role === "anchor" || (m.author_user_id ?? null) === (inst.user_id ?? null)) return { outcome: "refused", reason: "message" };
      if (deletedAt(ctx, a.p_principal, a.p_channel, a.p_ts)) return { outcome: "refused", reason: "deleted" };
      if (!isNull(m.author_user_id) && ctx.rowsOf(OPT).some((o) => o.principal_id === a.p_principal && o.author_user_id === m.author_user_id)) {
        return { outcome: "refused", reason: "author_optout" };
      }
      if (!isNull(a.p_item_id) && !ctx.rowsOf(ITM).some((i) => i.id === a.p_item_id && i.principal_id === a.p_principal && i.channel_id === a.p_channel
          && i.ts === a.p_ts)) {
        return { outcome: "refused", reason: "item" };
      }
      let src: Row | undefined;
      if (!isNull(a.p_from_draft)) {
        src = ctx.rowsOf(RD).find((s) => s.id === a.p_from_draft && s.principal_id === a.p_principal);
        if (!src || src.status !== "failed" || src.owner_resolution !== "not_posted" || isNull(src.text) || !isNull(src.content_purged_at)) {
          return { outcome: "refused", reason: "from_draft" };
        }
        if (src.channel_id !== a.p_channel || src.source_ts !== a.p_ts || src.installation_id !== a.p_installation) {
          return { outcome: "refused", reason: "from_draft_mismatch" };
        }
        const ctxTs = arr(src.context_ts);
        if (ctx.rowsOf(DEL).some((x) => x.principal_id === a.p_principal && x.channel_id === a.p_channel && ctxTs.includes(String(x.ts)))) {
          return { outcome: "refused", reason: "deleted" };
        }
        const authors = arr(src.context_authors);
        if (ctx.rowsOf(OPT).some((o) => o.principal_id === a.p_principal && authors.includes(String(o.author_user_id)))) {
          return { outcome: "refused", reason: "author_optout" };
        }
      }
      const existing = activeOf(ctx, a.p_principal, a.p_channel, a.p_ts);
      if (existing) return answer({ ...existing, outcome: "existing" });
      const conv = String(ch.conv_type);
      const reply = ["channel", "group"].includes(conv) ? (m.thread_ts ?? m.ts) : (m.thread_ts ?? null);
      const fromCopy = src !== undefined;
      const [row] = ctx.insertRows(RD, [{
        principal_id: a.p_principal, installation_id: a.p_installation, channel_id: a.p_channel, conv_type: conv, item_id: a.p_item_id ?? null,
        source_ts: a.p_ts, source_thread_ts: m.thread_ts ?? null, reply_thread_ts: reply, origin: a.p_origin, status: fromCopy ? "draft" : "generating",
        version: fromCopy ? 1 : 0, text: src?.text ?? null, instruction: a.p_instruction ?? src?.instruction ?? null, note: src?.note ?? null,
        placeholders: structuredClone(src?.placeholders ?? []), edited: src?.edited ?? false, flags: structuredClone(src?.flags ?? []),
        injection_suspected: src?.injection_suspected ?? false, voice_source: src?.voice_source ?? null, model: src?.model ?? null,
        generated_at: src?.generated_at ?? null, context_ts: structuredClone(src?.context_ts ?? []), context_authors: structuredClone(src?.context_authors ?? []),
        context_latest_ts: src?.context_latest_ts ?? null, source_edited_ts: fromCopy ? src?.source_edited_ts ?? null : m.edited_ts ?? null,
        external: ch.class === "external" || ch.is_ext_shared === true || ch.ext_ever === true || m.author_external === true || src?.external === true,
        finance: ch.class === "finance" || ch.finance_name === true || src?.finance === true, chat_message_id: a.p_chat_message_id ?? null,
        expires_at: isoOf(a.p_expires_at)
      }], { onConflictDoNothing: true });
      if (!row) return answer({ ...(activeOf(ctx, a.p_principal, a.p_channel, a.p_ts) as Row), outcome: "existing" });
      return answer({ ...row, outcome: "created" });
    },

    // 14. exec_slack_rdraft_regenerate
    exec_slack_rdraft_regenerate(a, ctx) {
      const now = ctx.now();
      if (!isNull(a.p_instruction) && (len(a.p_instruction) < 1 || len(a.p_instruction) > 2000)) throw raise("exec_slack_rdraft_regenerate: instruction");
      if (!expiresOk(a.p_expires_at, now)) throw raise("exec_slack_rdraft_regenerate: expires_at");
      const v = ctx.rowsOf(RD).find((d) => d.id === a.p_id && d.principal_id === a.p_principal);
      if (!v) return { outcome: "not_found" };
      if (!["draft", "generation_failed"].includes(String(v.status))) return { outcome: "busy", status: v.status };
      if (isNull(a.p_expected_version) || Number(v.version) !== Number(a.p_expected_version)) return { outcome: "conflict", version: v.version };
      if (Number(v.generation_seq) >= 1000) return { outcome: "busy", status: v.status };
      const seq = Number(v.generation_seq) + 1;
      ctx.updateRows(RD, [v], { status: "generating", generation_seq: seq, instruction: a.p_keep_instruction === true ? v.instruction : a.p_instruction ?? null,
        status_reason: null, generation_error: null, expires_at: isoOf(a.p_expires_at), updated_at: now.toISOString() });
      return { outcome: "claimed", generation_seq: seq, version: v.version };
    },

    // 15. exec_slack_rdraft_finish
    exec_slack_rdraft_finish(a, ctx) {
      const out = a.p_out !== null && typeof a.p_out === "object" && !Array.isArray(a.p_out) ? (a.p_out as Row) : null;
      if (!out || typeof out.ok !== "boolean") throw raise("exec_slack_rdraft_finish: bad output");
      if (Object.prototype.hasOwnProperty.call(out, "external_seen") && typeof out.external_seen !== "boolean") throw raise("exec_slack_rdraft_finish: bad output");
      let v = ctx.rowsOf(RD).find((d) => d.id === a.p_id && d.principal_id === a.p_principal);
      if (!v) return { outcome: "not_found" };
      const ch = ctx.rowsOf(CHN).find((c) => c.principal_id === a.p_principal && c.channel_id === v?.channel_id);
      const m = ctx.rowsOf(MS).find((x) => x.principal_id === a.p_principal && x.channel_id === v?.channel_id && x.ts === v?.source_ts);
      v = ctx.rowsOf(RD).find((d) => d.id === a.p_id);
      if (!v || v.status !== "generating" || Number(v.generation_seq) !== Number(a.p_seq)) return { outcome: "stale" };
      const ctxTs = Array.isArray(out.context_ts) ? arr(out.context_ts) : [];
      const authors = Array.isArray(out.context_authors) ? arr(out.context_authors) : [];
      const nowIso = ctx.now().toISOString();
      const err = !out.ok ? String(out.error ?? "model_error")
        : !ch || !["standard", "external", "finance"].includes(String(ch.class)) || ch.is_member !== true || !isNull(ch.left_at) ? "channel"
          : ctx.rowsOf(DEL).some((x) => x.principal_id === a.p_principal && x.channel_id === v?.channel_id && (x.ts === v?.source_ts || ctxTs.includes(String(x.ts))))
            ? "context_deleted"
            : ctx.rowsOf(OPT).some((o) => o.principal_id === a.p_principal && authors.includes(String(o.author_user_id))) ? "author_optout" : null;
      if (err !== null) {
        if (["context_deleted", "author_optout"].includes(err) && Number(v.version) >= 1) {
          ctx.updateRows(RD, [v], { status: "removed", status_reason: err, terminal_at: nowIso, text: null, instruction: null, note: null, placeholders: [],
            content_purged_at: nowIso, expires_at: new Date(Date.parse(nowIso) + 30 * RDAY).toISOString(), updated_at: nowIso });
        } else if (Number(v.version) >= 1) {
          ctx.updateRows(RD, [v], { status: "draft", status_reason: err, updated_at: nowIso });
        } else {
          ctx.updateRows(RD, [v], { status: "generation_failed", generation_error: err, updated_at: nowIso });
        }
        return { outcome: "failed", error: err };
      }
      const version = Math.min(Number(v.version) + 1, 9999);
      ctx.updateRows(RD, [v], {
        status: "draft", text: out.text ?? null, note: isNull(out.note) || out.note === "" ? null : out.note,
        placeholders: Array.isArray(out.placeholders) ? arr(out.placeholders) : [], flags: Array.isArray(out.flags) ? arr(out.flags) : [],
        injection_suspected: out.injection_suspected === true, voice_source: out.voice_source ?? null, model: out.model ?? null, context_ts: ctxTs,
        context_authors: authors, context_latest_ts: out.context_latest_ts ?? null, source_edited_ts: m?.edited_ts ?? null,
        external: v.external === true || out.external_seen === true, generated_at: nowIso, version, edited: false, status_reason: null, generation_error: null,
        expires_at: isoOf(out.expires_at), updated_at: nowIso
      });
      return { outcome: "written", version };
    },

    // 16. exec_slack_rdraft_edit
    exec_slack_rdraft_edit(a, ctx) {
      const now = ctx.now();
      if (isNull(a.p_text) || len(a.p_text) < 1 || len(a.p_text) > 4000) throw raise("exec_slack_rdraft_edit: text");
      if (!expiresOk(a.p_expires_at, now)) throw raise("exec_slack_rdraft_edit: expires_at");
      const v = ctx.rowsOf(RD).find((d) => d.id === a.p_id && d.principal_id === a.p_principal);
      if (v && v.status === "draft" && Number(v.version) === Number(a.p_expected_version) && isNull(v.content_purged_at)) {
        const version = Math.min(Number(v.version) + 1, 9999);
        ctx.updateRows(RD, [v], { text: a.p_text, placeholders: Array.isArray(a.p_placeholders) ? arr(a.p_placeholders) : [], edited: true, version,
          status_reason: null, expires_at: isoOf(a.p_expires_at), updated_at: now.toISOString() });
        return { outcome: "updated", version };
      }
      if (!v) return { outcome: "not_found" };
      return { outcome: "conflict", status: v.status, version: v.version };
    },

    // 17. exec_slack_rdraft_target
    exec_slack_rdraft_target(a, ctx) {
      const v = ctx.rowsOf(RD).find((d) => d.id === a.p_id && d.principal_id === a.p_principal);
      if (!v) return { found: false };
      const inst = ctx.rowsOf(INS).find((i) => i.id === v.installation_id);
      const settings = ctx.rowsOf("exec_settings").find((s) => s.principal_id === a.p_principal);
      const live = !!inst && isNull(inst.revoked_at) && !isNull(inst.user_token_enc) && ["discovering", "ready"].includes(String(inst.reading_state))
        && settings?.slack_reading_enabled === true;
      const ch = ctx.rowsOf(CHN).find((c) => c.principal_id === a.p_principal && c.channel_id === v.channel_id);
      const m = ctx.rowsOf(MS).find((x) => x.principal_id === a.p_principal && x.channel_id === v.channel_id && x.ts === v.source_ts);
      const items = ctx.rowsOf(ITM).filter((i) => i.principal_id === a.p_principal && i.channel_id === v.channel_id && i.ts === v.source_ts);
      const responded = [...items.map((i) => i.responded_at), m?.responded_at].filter((x) => !isNull(x)).map((x) => ms(x));
      const urgency = ctx.rowsOf(ITM).find((i) => i.id === v.item_id && i.principal_id === a.p_principal)?.urgency ?? null;
      return {
        found: true,
        reading_live: live,
        channel_ok: !!ch && ["standard", "external", "finance"].includes(String(ch.class)) && ch.is_member === true && isNull(ch.left_at)
          && ch.installation_id === v.installation_id,
        finance: (ch ? ch.class === "finance" || ch.finance_name === true : true) || v.finance === true,
        external: (ch ? ch.class === "external" || ch.is_ext_shared === true || ch.ext_ever === true : true) || v.external === true
          || ctx.rowsOf(MS).some((x) => x.principal_id === a.p_principal && x.channel_id === v.channel_id && x.author_external === true),
        message: !!m,
        deleted: deletedAt(ctx, a.p_principal, v.channel_id, v.source_ts),
        edited_ts: m?.edited_ts ?? null,
        responded_at: responded.length === 0 ? null : new Date(Math.max(...responded)).toISOString(),
        item_urgency: urgency
      };
    },

    // 18. exec_slack_rdraft_blank
    exec_slack_rdraft_blank(a, ctx) {
      if (isNull(a.p_reason) || !["deleted", "author_optout", "conversation", "reading"].includes(String(a.p_reason))) throw raise("exec_slack_rdraft_blank: reason");
      if (isNull(a.p_channel) && isNull(a.p_authors)) throw raise("exec_slack_rdraft_blank: a channel or authors are required");
      if (!isNull(a.p_ts) && !tsArrayOk(a.p_ts)) throw raise("exec_slack_rdraft_blank: ts");
      if (!isNull(a.p_authors) && !userArrayOk(a.p_authors)) throw raise("exec_slack_rdraft_blank: authors");
      const ts = isNull(a.p_ts) ? null : arr(a.p_ts);
      const authors = isNull(a.p_authors) ? null : arr(a.p_authors);
      const before = isNull(a.p_before) ? null : ms(a.p_before);
      const nowIso = ctx.now().toISOString();
      const hit = ctx.rowsOf(RD)
        .filter((d) => d.principal_id === a.p_principal && isNull(d.content_purged_at) && (before === null || ms(d.created_at) <= before)
          && ((!isNull(a.p_channel) && d.channel_id === a.p_channel
               && (ts === null || ts.includes(String(d.source_ts)) || arr(d.context_ts).some((x) => ts.includes(x))))
              || (authors !== null && arr(d.context_authors).some((x) => authors.includes(x)))))
        .sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1));
      for (const d of hit) {
        if (["generating", "generation_failed", "draft"].includes(String(d.status))) {
          ctx.updateRows(RD, [d], { status: "removed", status_reason: a.p_reason, terminal_at: nowIso, text: null, instruction: null, note: null, placeholders: [],
            content_purged_at: nowIso, expires_at: new Date(Date.parse(nowIso) + 30 * RDAY).toISOString(), updated_at: nowIso });
        } else {
          ctx.updateRows(RD, [d], { text: null, instruction: null, note: null, placeholders: [], content_purged_at: nowIso, updated_at: nowIso });
        }
      }
      return hit.map((d) => d.id);
    },

    // 19. exec_slack_rdraft_purge_expired
    exec_slack_rdraft_purge_expired(a, ctx) {
      const nowMs = isNull(a.p_now) ? ctx.now().getTime() : ms(a.p_now);
      const nowIso = new Date(nowMs).toISOString();
      const stamp = ctx.now().toISOString();
      const plus30 = new Date(nowMs + 30 * RDAY).toISOString();
      const expired = ctx.rowsOf(RD).filter((d) => ["generating", "generation_failed", "draft"].includes(String(d.status)) && ms(d.expires_at) < nowMs).slice(0, 1000);
      for (const d of expired) {
        ctx.updateRows(RD, [d], { status: "expired", status_reason: "idle", terminal_at: nowIso, text: null, instruction: null, note: null, placeholders: [],
          content_purged_at: nowIso, expires_at: plus30, updated_at: stamp });
      }
      const blank = { text: null, instruction: null, note: null, placeholders: [], content_purged_at: nowIso, updated_at: stamp };
      const closed = ctx.rowsOf(RD).filter((d) => isNull(d.content_purged_at) && TERMINAL.includes(String(d.status)) && ms(d.terminal_at) < nowMs - 7 * RDAY)
        .slice(0, 1000);
      for (const d of closed) ctx.updateRows(RD, [d], blank);
      const unknown = ctx.rowsOf(RD).filter((d) => isNull(d.content_purged_at) && d.status === "unknown" && ms(d.sending_at) < nowMs - 7 * RDAY).slice(0, 1000);
      for (const d of unknown) ctx.updateRows(RD, [d], blank);
      const gone = ctx.rowsOf(RD).filter((d) => (TERMINAL.includes(String(d.status)) && ms(d.terminal_at) < nowMs - 30 * RDAY)
        || (d.status === "unknown" && ms(d.sending_at) < nowMs - 30 * RDAY)).slice(0, 1000);
      ctx.deleteRows(RD, gone);
      const cards = ctx.rowsOf(RC).filter((c) => ms(c.expires_at) < nowMs);
      ctx.deleteRows(RC, cards);
      const voice = ctx.rowsOf(VP).filter((p) => ms(p.expires_at) < nowMs);
      ctx.deleteRows(VP, voice);
      return { expired: expired.length, contentPurged: closed.length + unknown.length, deleted: gone.length, cards: cards.length, voice: voice.length };
    }
  };
}

/** The interface above, with the body: a fake P7a message delete cascades to its drafts (and items); cards stay (no FK). */
export function createFakeReplyDb(seed?: FakeReplyDbSeed): FakeReplyDb {
  const engine = createEngine<FakeReplyDbCall>(REPLY_SPEC, replyRpcs(), seed as EngineSeed<FakeReplyDbCall>, "fake reply db");
  const db: FakeReplyDb = {
    client: engine.client,
    tables: engine.tables as Record<FakeReplyTable, Row[]>,
    calls: engine.calls as FakeReplyDbCall[],
    missing: engine.missing,
    rpc: (name, args) => engine.rpc(name, args),
    failNext: (op, code, message) => engine.failNext(op, code, message),
    mutations: () => engine.mutations(),
    deleteMessages(principalId, channelId, ts) {
      const before = engine.rowsOf(RD).length;
      const set = new Set(ts);
      engine.deleteRows(MS, engine.rowsOf(MS).filter((m) => m.principal_id === principalId && m.channel_id === channelId && set.has(String(m.ts))));
      // A draft whose message row the test never seeded goes too (the cascade P7a's delete would run).
      engine.deleteRows(RD, engine.rowsOf(RD).filter((d) => d.principal_id === principalId && d.channel_id === channelId && set.has(String(d.source_ts))));
      return before - engine.rowsOf(RD).length;
    }
  };
  return db;
}
