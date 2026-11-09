import { randomUUID } from "node:crypto";

import { tsToMs } from "@/lib/exec/slack-read-types";
import type { FakeSlackDbError, Row } from "./fake-slack-db";

// P7b test fake: a standalone in-memory Supabase for slack-intel-store.ts (P7b contract §5.11; Area A), in the style of
// P6's fake-slack-db.ts. The INTERFACE is frozen at stage 0 (lead); Area A wrote the body.
//
//   const db = createFakeSlackIntelDb({ tables: { exec_slack_channels: [row], exec_slack_digests: [digest] } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
//
// What it does (ST keeps it equal to the SQL, 20261110100000_exec_slack_intel.sql, on shared cases):
//   * from(table) builders for the three P7b tables (exec_slack_channel_links with its five GENERATED verdict columns
//     computed in code exactly as §2.1.2 — channelLinkVerdict below — and refused on write; exec_slack_message_links;
//     exec_slack_digests with search_tsv generated), P7a's exec_slack_channels (final columns: conv_type, is_private,
//     class, watch_state, mute_source, left_at, is_ext_shared, ext_ever, finance_name, is_archived, …),
//     exec_slack_messages (dd_paths, is_dd_post, role, author_external), exec_slack_items (source_class, bypass_mute,
//     assessed; no status / occurred_at: an item's time is its ts), exec_slack_deleted, exec_slack_purge_log,
//     exec_slack_author_optouts, exec_slack_installations' reading columns (revoked_at, user_revoked_at,
//     user_token_enc), exec_messages with the three P7b Slack columns, exec_drafts with the three P7b columns:
//     insert, select, update, upsert (onConflict), delete().select(); filters eq, neq, in, is, not, lt, lte, gt, gte,
//     contains, overlaps, order, limit, range, count / head; the P7b DDL defaults, CHECKs (23514 naming the
//     constraint), unique keys (23505) and FKs (23503) with ON DELETE / ON UPDATE CASCADE from P7a's channel and
//     message rows;
//   * rpc(name, args) for the fourteen P7b functions (§2.1.8–§2.1.11), bodies mirrored from the migration; RPC 9 runs
//     a minimal mirror of P5b's exec_chat_finish_turn (running → final, CAS) and RPC 10 a minimal mirror of P5b's
//     exec_chat_redact_message (text replaced, recommendations / sources / tool-call args cleared, redacted_at set),
//     each hit recorded in `redactions`;
//   * missing tables / functions / columns: a table in `missing` → PGRST205 (42P01 for an RPC body that reads it), an
//     RPC → PGRST202, a column "table.column" → 42703 when selected and PGRST204 when written;
//   * a RAISE inside an RPC → P0001 with the function's message; an aborted signal → postgrest-js's abort result.
// Rows in `tables` are plain snake_case objects; tests read and mutate them directly. Areas B–F consume this fake;
// none edits it.
//
// Mirror notes (Area A): the P7a tables hold whatever a test seeds (P7a's own CHECKs are P7a's fake's; only their keys,
// DDL defaults and the cascades P7b relies on are mirrored here). Full-text search is approximated: the 'simple'
// configuration's lexemes are lower-cased letter/digit runs, websearch syntax keeps words (AND), "or" and a leading
// "-" (NOT); a quoted phrase is read as its words; rank = the matched query words / 10. P5b's redaction mirror has no
// task proposals (the table isn't this fake's). Timestamps compare as instants (to the millisecond).

/** The three P7b tables (§2.1.2–§2.1.4). */
export type FakeSlackIntelP7bTable = "exec_slack_channel_links" | "exec_slack_message_links" | "exec_slack_digests";
/** Every table the fake holds. */
export type FakeSlackIntelTable =
  | FakeSlackIntelP7bTable
  | "exec_slack_channels" | "exec_slack_messages" | "exec_slack_items" | "exec_slack_deleted" | "exec_slack_purge_log"
  | "exec_slack_author_optouts" | "exec_slack_installations"
  | "exec_messages" | "exec_conversations" | "exec_drafts";
/** The fourteen P7b RPCs (§2.1.12). */
export type FakeSlackIntelRpc =
  | "exec_slack_set_channel_links" | "exec_slack_set_channel_rules" | "exec_slack_unlinked_messages" | "exec_slack_project_items"
  | "exec_slack_search" | "exec_slack_digest_claim" | "exec_slack_digest_finish" | "exec_slack_digest_blank"
  | "exec_chat_finish_turn_v2" | "exec_chat_redact_slack" | "exec_chat_slack_recheck" | "exec_chat_slack_orphan_channels"
  | "exec_slack_public_facts" | "exec_slack_intel_forget_channels";
export const FAKE_SLACK_INTEL_RPCS: readonly FakeSlackIntelRpc[] = Object.freeze([
  "exec_slack_set_channel_links", "exec_slack_set_channel_rules", "exec_slack_unlinked_messages", "exec_slack_project_items",
  "exec_slack_search", "exec_slack_digest_claim", "exec_slack_digest_finish", "exec_slack_digest_blank",
  "exec_chat_finish_turn_v2", "exec_chat_redact_slack", "exec_chat_slack_recheck", "exec_chat_slack_orphan_channels",
  "exec_slack_public_facts", "exec_slack_intel_forget_channels"
] as FakeSlackIntelRpc[]);

export type FakeSlackIntelFilter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "contains" | "overlaps"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: FakeSlackIntelFilter };

/** One request the client received, in order (P6's record shape, with P7b's array filters). */
export interface FakeSlackIntelDbCall {
  kind: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  /** The table, or the RPC name. */
  target: string;
  /** select(...)'s column list (also delete().select(...)'s), else null. ST10 checks no P7b request selects `excerpt`. */
  columns: string | null;
  /** The insert / update / upsert values, or the RPC's arguments. */
  payload: unknown;
  /** upsert / insert options (onConflict, ignoreDuplicates, count), else null. */
  options: Record<string, unknown> | null;
  filters: FakeSlackIntelFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
  range: [number, number] | null;
  single: "maybe" | "single" | null;
  signal: AbortSignal | null;
}

/** One assistant message RPC 10 (directly, or through RPC 11) redacted through the mirrored exec_chat_redact_message. */
export interface FakeSlackIntelRedaction { rpc: "exec_chat_redact_slack" | "exec_chat_slack_recheck"; messageId: string; text: string }

export interface FakeSlackIntelDbSeed {
  /** Initial rows per table (copied). */
  tables?: Partial<Record<FakeSlackIntelTable, Row[]>>;
  /** Tables, RPCs and "table.column" names that don't exist (see the header). */
  missing?: readonly string[];
  /** An error for this request, or null / undefined to run it. */
  fail?: (call: FakeSlackIntelDbCall) => FakeSlackDbError | null | undefined;
  /** Runs just before a request executes: simulate another writer (a blank during a finish) or a delay here. */
  before?: (call: FakeSlackIntelDbCall, db: FakeSlackIntelDb) => void | Promise<void>;
  /** The clock now() / the RPCs use (default: the real clock). */
  now?: () => Date;
}

export interface FakeSlackIntelDb {
  /** A Supabase-shaped client (from(table) builders and rpc(name, args)) for vi.mock("@/lib/supabase-admin"). */
  client: unknown;
  /** Every table of FakeSlackIntelTable, always present (empty when unseeded). */
  tables: Record<FakeSlackIntelTable, Row[]>;
  /** Every request, in order. */
  calls: FakeSlackIntelDbCall[];
  /** The tables, RPCs and columns currently missing (mutable). */
  missing: Set<string>;
  /** Every message the mirrored exec_chat_redact_message redacted, in order. */
  redactions: FakeSlackIntelRedaction[];
}

const TABLES: readonly FakeSlackIntelTable[] = [
  "exec_slack_channel_links", "exec_slack_message_links", "exec_slack_digests", "exec_slack_channels", "exec_slack_messages", "exec_slack_items",
  "exec_slack_deleted", "exec_slack_purge_log", "exec_slack_author_optouts", "exec_slack_installations", "exec_messages", "exec_conversations", "exec_drafts"
];

const CL = "exec_slack_channel_links";
const ML = "exec_slack_message_links";
const DG = "exec_slack_digests";
const CH = "exec_slack_channels";
const SM = "exec_slack_messages";
const IT = "exec_slack_items";
const DL = "exec_slack_deleted";
const PL = "exec_slack_purge_log";
const OO = "exec_slack_author_optouts";
const SI = "exec_slack_installations";
const MS = "exec_messages";
const CV = "exec_conversations";
const D = "exec_drafts";

const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;

const isNull = (v: unknown) => v === null || v === undefined;
const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : Number.NaN);
const hex32 = () => randomUUID().replace(/-/g, "");
const len = (v: unknown) => (typeof v === "string" ? v.length : -1);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const between = (v: unknown, lo: number, hi: number) => typeof v === "string" && v.length >= lo && v.length <= hi;
const intIn = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
/** to_timestamp(ts::numeric) in ms (NaN on a malformed ts). */
const tsTime = (ts: unknown): number => {
  if (typeof ts !== "string" || !TS.test(ts)) return Number.NaN;
  return tsToMs(ts);
};

class PgError extends Error {
  readonly code: string;
  readonly details?: string;
  constructor(code: string, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const raise = (message: string) => new PgError("P0001", message);

// ---------------------------------------------------------------------------
// §2.1.2's generated verdict columns
// ---------------------------------------------------------------------------

/** §2.1.2's five generated verdict columns of one exec_slack_channel_links row (tag_* and rule_* in, the verdict out), the
 *  fake's own computation (exported so SQ05's TS twin and the correlator tests compare against one rule). */
export function channelLinkVerdict(row: Pick<Row, "tag_client_id" | "tag_client_name" | "rule_client_id" | "rule_client_name" | "rule_candidates">): {
  client_id: string | null; client_name: string | null; client_match_via: "tag" | "name" | null; match_confidence: "high" | "low" | null; client_candidates: number;
} {
  const tagged = !isNull(row.tag_client_id);
  const candidates = typeof row.rule_candidates === "number" ? row.rule_candidates : 0;
  const rule = !isNull(row.rule_client_id) || candidates > 1;
  return {
    client_id: tagged ? String(row.tag_client_id) : isNull(row.rule_client_id) ? null : String(row.rule_client_id),
    client_name: tagged ? (isNull(row.tag_client_name) ? null : String(row.tag_client_name)) : isNull(row.rule_client_name) ? null : String(row.rule_client_name),
    client_match_via: tagged ? "tag" : rule ? "name" : null,
    match_confidence: tagged ? "high" : rule ? "low" : null,
    client_candidates: tagged ? 1 : candidates
  };
}

/** A link row as channelLinkVerdict reads it. */
type LinkBase = Pick<Row, "tag_client_id" | "tag_client_name" | "rule_client_id" | "rule_client_name" | "rule_candidates">;
const LINK_GENERATED = ["client_id", "client_name", "client_match_via", "match_confidence", "client_candidates"] as const;

/** The 'simple' text-search configuration's lexemes (approximated: lower-cased letter / digit runs). */
function lexemes(text: unknown): string[] {
  return typeof text === "string" ? text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0) : [];
}

// ---------------------------------------------------------------------------
// Columns, defaults, CHECKs, keys
// ---------------------------------------------------------------------------

const COLUMNS: Partial<Record<FakeSlackIntelTable, readonly string[]>> = {
  [CL]: ["principal_id", "channel_id", "tag_client_id", "tag_client_name", "tag_project_ids", "tagged_at", "rule_client_id", "rule_client_name",
    "rule_candidates", "rule_computed_at", ...LINK_GENERATED, "created_at", "updated_at"],
  [ML]: ["principal_id", "channel_id", "ts", "client_id", "client_name", "client_match_via", "match_confidence", "client_candidates", "task_ids",
    "project_ids", "email_thread_ids", "checked_at"],
  [DG]: ["id", "principal_id", "channel_id", "local_date", "tz", "from_ts", "to_ts", "status", "summary", "highlights", "decisions", "open_questions",
    "source_ts", "human_count", "bot_count", "dd_post_count", "external_count", "thread_count", "privacy", "partial", "full_day", "injection_suspected",
    "rebuilds", "model", "cost_usd", "requested_at", "built_at", "expires_at", "created_at", "updated_at", "search_tsv"]
};
const GENERATED: Partial<Record<FakeSlackIntelTable, readonly string[]>> = { [CL]: LINK_GENERATED, [DG]: ["search_tsv"] };
const NOT_NULL: Partial<Record<FakeSlackIntelTable, readonly string[]>> = {
  [CL]: ["principal_id", "channel_id", "tag_project_ids", "rule_candidates", "created_at", "updated_at"],
  [ML]: ["principal_id", "channel_id", "ts", "client_candidates", "task_ids", "project_ids", "email_thread_ids", "checked_at"],
  [DG]: ["id", "principal_id", "channel_id", "local_date", "tz", "from_ts", "to_ts", "status", "highlights", "decisions", "open_questions", "source_ts",
    "human_count", "bot_count", "dd_post_count", "external_count", "thread_count", "partial", "full_day", "injection_suspected", "rebuilds",
    "requested_at", "expires_at", "created_at", "updated_at"]
};

function defaults(table: string, nowIso: string, nextLogId: () => number): Row {
  switch (table) {
    case CL:
      return { tag_client_id: null, tag_client_name: null, tag_project_ids: [], tagged_at: null, rule_client_id: null, rule_client_name: null, rule_candidates: 0,
        rule_computed_at: null, created_at: nowIso, updated_at: nowIso };
    case ML:
      return { client_id: null, client_name: null, client_match_via: null, match_confidence: null, client_candidates: 0, task_ids: [], project_ids: [],
        email_thread_ids: [], checked_at: nowIso };
    case DG:
      return { id: `esd_${hex32()}`, summary: null, highlights: [], decisions: [], open_questions: [], source_ts: [], human_count: 0, bot_count: 0,
        dd_post_count: 0, external_count: 0, thread_count: 0, privacy: null, partial: false, full_day: false, injection_suspected: false, rebuilds: 0,
        model: null, cost_usd: null, requested_at: nowIso, built_at: null, created_at: nowIso, updated_at: nowIso };
    case CH:
      return { class: "unclassified", deny_reason: null, hub_kind: null, finance_name: false, watch_state: "unwatched", mute_source: null, name: null,
        im_user_id: null, is_member: false, is_private: true, is_ext_shared: false, ext_ever: false, is_archived: false, last_activity_ts: null,
        left_at: null, created_at: nowIso, updated_at: nowIso };
    case SM:
      return { thread_ts: null, author_user_id: null, author_external: false, is_dd_post: false, dd_paths: [], reasons: 0, triage_state: "pending",
        created_at: nowIso, updated_at: nowIso };
    case IT:
      return { id: `esl_${hex32()}`, thread_ts: null, author_user_id: null, author_label: null, author_external: false, addressed_to_you: false,
        needs_response: false, bypass_mute: false, urgency: "normal", summary: null, excerpt: null, due_text: null, due_at: null,
        commitment_direction: null, permalink: null, responded_ts: null, responded_at: null, acknowledged_at: null, created_at: nowIso, updated_at: nowIso };
    case DL:
      return { deleted_at: nowIso };
    case PL:
      return { id: nextLogId(), channel_id: null, ts: null, created_at: nowIso };
    case OO:
      return { created_at: nowIso };
    case SI:
      return { revoked_at: null, user_revoked_at: null, user_token_enc: null };
    case MS:
      return { id: `ecm_${hex32()}`, status: "running", status_reason: null, refusal_category: null, text: "", recommendations: "", sources: [], cards: [],
        tool_calls: [], consulted_email_thread_ids: [], consulted_client_ids: [], consulted_dd_text: false, usage: null, model: null, redacted_at: null,
        finished_at: null, consulted_slack_refs: [], consulted_slack_channels: [], consulted_private_slack: false, created_at: nowIso, updated_at: nowIso };
    case CV:
      return { id: `ecv_${hex32()}`, ref_seq: 0, last_message_at: nowIso, created_at: nowIso, updated_at: nowIso };
    case D:
      return { id: `ed_${hex32()}`, version: 1, purpose: "reply", generated_version: null, client_update_facts: null, created_at: nowIso, updated_at: nowIso };
    default:
      return {};
  }
}

/** The CHECK constraints a snake_case row of `table` violates, by name, in PostgreSQL's (alphabetical) evaluation order. */
function violatedChecks(table: string, r: Row): string[] {
  const bad: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name);
  };
  const optional = (v: unknown, lo: number, hi: number) => isNull(v) || between(v, lo, hi);
  if (table === CL) {
    const projects = arr(r.tag_project_ids);
    check("exec_slack_channel_links_channel_check", typeof r.channel_id === "string" && CHANNEL.test(r.channel_id));
    check("exec_slack_channel_links_rule_candidates_check", intIn(r.rule_candidates, 0, 1000));
    check("exec_slack_channel_links_rule_client_check", optional(r.rule_client_id, 1, 100));
    check("exec_slack_channel_links_rule_name_check", optional(r.rule_client_name, 1, 200));
    check("exec_slack_channel_links_rule_pair_check", isNull(r.rule_client_id) === isNull(r.rule_client_name));
    check("exec_slack_channel_links_rule_shape_check",
      (!isNull(r.rule_client_id) && r.rule_candidates === 1) || (isNull(r.rule_client_id) && r.rule_candidates !== 1));
    check("exec_slack_channel_links_tag_client_check", optional(r.tag_client_id, 1, 100));
    check("exec_slack_channel_links_tag_name_check", optional(r.tag_client_name, 1, 200));
    check("exec_slack_channel_links_tag_pair_check", isNull(r.tag_client_id) === isNull(r.tag_client_name));
    check("exec_slack_channel_links_tag_projects_check", projects.length <= 10);
    check("exec_slack_channel_links_tagged_at_check", isNull(r.tagged_at) === (isNull(r.tag_client_id) && projects.length === 0));
  } else if (table === ML) {
    const via = r.client_match_via;
    const conf = r.match_confidence;
    const cands = r.client_candidates;
    check("exec_slack_message_links_candidates_check", intIn(cands, 0, 1000));
    check("exec_slack_message_links_client_check", optional(r.client_id, 1, 100));
    check("exec_slack_message_links_client_name_check", optional(r.client_name, 1, 200));
    check("exec_slack_message_links_confidence_check", isNull(conf) || ["high", "medium", "low"].includes(String(conf)));
    check("exec_slack_message_links_pair_check", isNull(r.client_id) === isNull(r.client_name));
    check("exec_slack_message_links_projects_check", arr(r.project_ids).length <= 20);
    check("exec_slack_message_links_tasks_check", arr(r.task_ids).length <= 20);
    check("exec_slack_message_links_threads_check", arr(r.email_thread_ids).length <= 5);
    check("exec_slack_message_links_ts_check", typeof r.ts === "string" && TS.test(r.ts));
    check("exec_slack_message_links_verdict_check",
      (isNull(via) && isNull(conf))
      || (!isNull(via) && !isNull(conf) && (
        ((via === "dd_post" || via === "dd_link") && conf === "high" && !isNull(r.client_id) && cands === 1)
        || (via === "domain" && ((conf === "medium" && !isNull(r.client_id) && cands === 1) || (conf === "low" && typeof cands === "number" && cands >= 1))))));
    check("exec_slack_message_links_via_check", isNull(via) || ["dd_post", "dd_link", "domain"].includes(String(via)));
  } else if (table === DG) {
    const status = r.status;
    const built = status === "built";
    const hl = arr(r.highlights);
    const dc = arr(r.decisions);
    const oq = arr(r.open_questions);
    const src = arr(r.source_ts);
    const nonNeg = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
    check("exec_slack_digests_bot_check", nonNeg(r.bot_count));
    check("exec_slack_digests_content_check",
      (built && !isNull(r.summary) && src.length >= 1 && !isNull(r.built_at))
      || (!built && isNull(r.summary) && hl.length === 0 && dc.length === 0 && oq.length === 0));
    check("exec_slack_digests_cost_check", isNull(r.cost_usd) || Number(r.cost_usd) >= 0);
    check("exec_slack_digests_dd_check", nonNeg(r.dd_post_count));
    check("exec_slack_digests_decisions_check", Array.isArray(r.decisions) && dc.length <= 6);
    check("exec_slack_digests_external_check", nonNeg(r.external_count));
    check("exec_slack_digests_from_check", typeof r.from_ts === "string" && TS.test(r.from_ts));
    check("exec_slack_digests_full_day_check", r.full_day !== true || status === "built" || status === "empty");
    check("exec_slack_digests_highlights_check", Array.isArray(r.highlights) && hl.length <= 6);
    check("exec_slack_digests_human_check", nonNeg(r.human_count));
    check("exec_slack_digests_model_check", isNull(r.model) || len(r.model) <= 64);
    check("exec_slack_digests_privacy_check", isNull(r.privacy) || ["public", "private", "group_dm", "external", "finance"].includes(String(r.privacy)));
    check("exec_slack_digests_questions_check", Array.isArray(r.open_questions) && oq.length <= 6);
    check("exec_slack_digests_range_check", String(r.from_ts) <= String(r.to_ts) || len(r.from_ts) !== len(r.to_ts));
    check("exec_slack_digests_rebuilds_check", intIn(r.rebuilds, 0, 1000));
    check("exec_slack_digests_source_check", src.length <= 2000);
    check("exec_slack_digests_sources_check", status === "built" || status === "empty" || src.length === 0);
    check("exec_slack_digests_status_check", ["building", "built", "empty", "stale", "failed", "skipped_cap"].includes(String(status)));
    check("exec_slack_digests_summary_check", optional(r.summary, 1, 1200));
    check("exec_slack_digests_thread_check", nonNeg(r.thread_count));
    check("exec_slack_digests_to_check", typeof r.to_ts === "string" && TS.test(r.to_ts));
    check("exec_slack_digests_tz_check", between(r.tz, 1, 64));
  } else if (table === MS) {
    const refs = arr(r.consulted_slack_refs);
    const chans = arr(r.consulted_slack_channels);
    check("exec_messages_slack_channels_check", chans.length <= 200);
    check("exec_messages_slack_pair_check", refs.length === 0 || chans.length >= 1);
    check("exec_messages_slack_refs_check", refs.length <= 600);
    check("exec_messages_user_row_slack_check", r.role === "assistant" || (refs.length === 0 && chans.length === 0 && r.consulted_private_slack !== true));
  } else if (table === D) {
    check("exec_drafts_client_update_facts_check", isNull(r.client_update_facts)
      || (typeof r.client_update_facts === "object" && !Array.isArray(r.client_update_facts) && r.purpose === "client_update"
        && JSON.stringify(r.client_update_facts).length <= 2048));
    check("exec_drafts_generated_version_check", isNull(r.generated_version)
      || (typeof r.generated_version === "number" && r.generated_version >= 1 && r.generated_version <= Number(r.version ?? 1)));
    check("exec_drafts_purpose_check", r.purpose === "reply" || r.purpose === "client_update");
    check("exec_drafts_purpose_kind_check", r.purpose === "reply" || r.kind === "reply");
  }
  return bad.sort();
}

/** The unique keys the store and the RPCs can hit: name and columns. */
const UNIQUE: Partial<Record<FakeSlackIntelTable, { name: string; cols: string[] }[]>> = {
  [CL]: [{ name: "exec_slack_channel_links_pkey", cols: ["principal_id", "channel_id"] }],
  [ML]: [{ name: "exec_slack_message_links_pkey", cols: ["principal_id", "channel_id", "ts"] }],
  [DG]: [
    { name: "exec_slack_digests_pkey", cols: ["id"] },
    { name: "exec_slack_digests_day_key", cols: ["principal_id", "channel_id", "local_date"] }
  ],
  [CH]: [{ name: "exec_slack_channels_pkey", cols: ["principal_id", "channel_id"] }],
  [SM]: [{ name: "exec_slack_messages_pkey", cols: ["principal_id", "channel_id", "ts"] }],
  [IT]: [{ name: "exec_slack_items_pkey", cols: ["id"] }, { name: "exec_slack_items_key", cols: ["principal_id", "channel_id", "ts", "kind"] }],
  [DL]: [{ name: "exec_slack_deleted_pkey", cols: ["principal_id", "channel_id", "ts"] }],
  [OO]: [{ name: "exec_slack_author_optouts_pkey", cols: ["principal_id", "author_user_id"] }],
  [MS]: [{ name: "exec_messages_pkey", cols: ["id"] }],
  [CV]: [{ name: "exec_conversations_pkey", cols: ["id"] }],
  [D]: [{ name: "exec_drafts_pkey", cols: ["id"] }]
};

// ---------------------------------------------------------------------------
// Filters (SQL semantics)
// ---------------------------------------------------------------------------

function isTimeText(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));
}

function compare(a: unknown, b: unknown): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (isTimeText(a) && isTimeText(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && (typeof b === "number" || (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))))) return a - Number(b);
  if (typeof a === "boolean") return a === (b === true || b === "true") ? 0 : 1;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function test(row: Row, f: FakeSlackIntelFilter): boolean {
  switch (f.op) {
    case "not": {
      if (f.inner.op === "is") return !test(row, f.inner);
      const v = row[f.inner.column];
      return !isNull(v) && !test(row, f.inner);
    }
    case "is": {
      const v = row[f.column];
      if (f.value === null || f.value === "null") return isNull(v);
      return v === (f.value === true || f.value === "true");
    }
    case "in": {
      const v = row[f.column];
      return !isNull(v) && f.values.some((x) => compare(v, x) === 0);
    }
    case "contains": {
      const v = row[f.column];
      return Array.isArray(v) && f.values.every((x) => v.some((y) => compare(y, x) === 0));
    }
    case "overlaps": {
      const v = row[f.column];
      return Array.isArray(v) && f.values.some((x) => v.some((y) => compare(y, x) === 0));
    }
    default: {
      const c = compare(row[f.column], f.value);
      if (c === null) return false;
      return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[f.op];
    }
  }
}

function parseNot(column: string, operator: string, value: unknown): FakeSlackIntelFilter {
  if (operator === "is") return { op: "not", column, inner: { op: "is", column, value: value === "null" ? null : value } };
  if (operator === "in") {
    const values = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    return { op: "not", column, inner: { op: "in", column, values } };
  }
  if (["eq", "neq", "lt", "lte", "gt", "gte"].includes(operator)) {
    return { op: "not", column, inner: { op: operator as "eq", column, value } };
  }
  throw new Error(`fake slack intel db: unsupported not() operator ${operator}`);
}

function project(row: Row, columns: string, table: string, gone: Set<string>): Row {
  if (columns.trim() === "*") {
    const all = structuredClone(row);
    for (const k of Object.keys(all)) if (gone.has(`${table}.${k}`)) delete all[k];
    return all;
  }
  const out: Row = {};
  for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (gone.has(`${table}.${c}`) || (!(c in row) && COLUMNS[table as FakeSlackIntelTable] && !COLUMNS[table as FakeSlackIntelTable]?.includes(c))) {
      throw new PgError("42703", `column ${table}.${c} does not exist`);
    }
    out[c] = c in row ? structuredClone(row[c]) : null;
  }
  return out;
}

function sortRows(rows: Row[], orders: FakeSlackIntelDbCall["orders"]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const x = a[column];
      const y = b[column];
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return ascending ? 1 : -1;
      if (isNull(y)) return ascending ? -1 : 1;
      const c = compare(x, y) ?? 0;
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// websearch_to_tsquery('simple', q), approximated (see the header)
// ---------------------------------------------------------------------------

type TsQuery = { groups: { pos: string[]; neg: string[] }[] };

function webQuery(q: unknown): TsQuery {
  const text = typeof q === "string" ? q.replace(/"/g, " ") : "";
  const groups: { pos: string[]; neg: string[] }[] = [{ pos: [], neg: [] }];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if (raw.toLowerCase() === "or") {
      if (groups[groups.length - 1].pos.length + groups[groups.length - 1].neg.length > 0) groups.push({ pos: [], neg: [] });
      continue;
    }
    const neg = raw.startsWith("-");
    const words = lexemes(neg ? raw.slice(1) : raw);
    const g = groups[groups.length - 1];
    if (neg) g.neg.push(...words);
    else g.pos.push(...words);
  }
  return { groups: groups.filter((g) => g.pos.length > 0) };
}
const queryEmpty = (q: TsQuery) => q.groups.length === 0;
function queryMatch(q: TsQuery, text: string): boolean {
  const words = new Set(lexemes(text));
  return q.groups.some((g) => g.pos.every((w) => words.has(w)) && !g.neg.some((w) => words.has(w)));
}
function queryRank(q: TsQuery, text: string): number {
  const words = new Set(lexemes(text));
  const hit = new Set(q.groups.flatMap((g) => g.pos).filter((w) => words.has(w)));
  return hit.size / 10;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

type Result = { data: unknown; count: number | null; error: FakeSlackDbError | null };

const ABORTED: FakeSlackDbError = { message: "AbortError: This operation was aborted", code: "", details: "" };

/** The tables each RPC body reads or writes (a missing one → 42P01, as PostgreSQL raises inside the body). */
const RPC_TABLES: Record<FakeSlackIntelRpc, readonly FakeSlackIntelTable[]> = {
  exec_slack_set_channel_links: [CH, CL],
  exec_slack_set_channel_rules: [CH, CL],
  exec_slack_unlinked_messages: [SM, IT, ML],
  exec_slack_project_items: [ML, CL, IT],
  exec_slack_search: [IT, DG, OO],
  exec_slack_digest_claim: [CH, DG],
  exec_slack_digest_finish: [DG, CH, DL, PL, OO],
  exec_slack_digest_blank: [DG],
  exec_chat_finish_turn_v2: [MS, CV],
  exec_chat_redact_slack: [MS],
  exec_chat_slack_recheck: [MS, SI, DL, PL, DG, CH, OO],
  exec_chat_slack_orphan_channels: [MS, CH],
  exec_slack_public_facts: [CH, CL, IT, SM, DL, OO, ML, DG],
  exec_slack_intel_forget_channels: [DG, CH, CL]
};

export function createFakeSlackIntelDb(seed?: FakeSlackIntelDbSeed): FakeSlackIntelDb {
  const cfg = seed ?? {};
  const tables = {} as Record<FakeSlackIntelTable, Row[]>;
  for (const t of TABLES) tables[t] = (cfg.tables?.[t] ?? []).map((r) => structuredClone(r));
  const fdb: FakeSlackIntelDb = { client: null, tables, calls: [], missing: new Set(cfg.missing ?? []), redactions: [] };
  const now = () => (cfg.now ? cfg.now() : new Date());
  const rowsOf = (t: string): Row[] => ((tables as Record<string, Row[]>)[t] ??= []);
  let logSeq = tables.exec_slack_purge_log.reduce((m, j) => Math.max(m, typeof j.id === "number" ? j.id : 0), 0);
  const nextLogId = () => ++logSeq;
  // Seeded P7b rows get the DDL defaults for the columns they leave out, and their generated columns.
  const seedIso = now().toISOString();
  for (const t of [CL, ML, DG] as const) tables[t] = tables[t].map((r) => ({ ...defaults(t, seedIso, () => 0), ...r }));
  for (const r of tables.exec_slack_channel_links) Object.assign(r, channelLinkVerdict(r as LinkBase));
  for (const r of tables.exec_slack_digests) r.search_tsv = lexemes(r.summary).join(" ");

  /** Recompute a row's generated columns (in place). */
  function generate(table: string, r: Row): void {
    if (table === CL) Object.assign(r, channelLinkVerdict(r as LinkBase));
    if (table === DG) r.search_tsv = lexemes(r.summary).join(" ");
  }

  // --- the tables' own refusals ------------------------------------------------

  function refusal(table: string, candidates: Row[], others: Row[], fkColumns: ReadonlySet<string> | "all" = "all"): PgError | null {
    const fk = (cols: string[]) => fkColumns === "all" || cols.some((c) => fkColumns.has(c));
    for (const c of candidates) {
      for (const col of NOT_NULL[table as FakeSlackIntelTable] ?? []) {
        if (isNull(c[col])) return new PgError("23502", `null value in column "${col}" of relation "${table}" violates not-null constraint`);
      }
      const bad = violatedChecks(table, c);
      if (bad.length > 0) return new PgError("23514", `new row for relation "${table}" violates check constraint "${bad[0]}"`);
    }
    for (const key of UNIQUE[table as FakeSlackIntelTable] ?? []) {
      const all = [...others, ...candidates];
      for (const c of candidates) {
        if (key.cols.some((col) => isNull(c[col]))) continue;
        const twin = all.find((o) => o !== c && key.cols.every((col) => compare(o[col], c[col]) === 0));
        if (twin) return new PgError("23505", `duplicate key value violates unique constraint "${key.name}"`, `Key (${key.cols.join(", ")}) already exists.`);
      }
    }
    for (const c of candidates) {
      if ((table === CL || table === DG) && fk(["principal_id", "channel_id"])
        && !rowsOf(CH).some((x) => x.principal_id === c.principal_id && x.channel_id === c.channel_id)) {
        const name = table === CL ? "exec_slack_channel_links_channel_fkey" : "exec_slack_digests_channel_fkey";
        return new PgError("23503", `insert or update on table "${table}" violates foreign key constraint "${name}"`);
      }
      if (table === ML && fk(["principal_id", "channel_id", "ts"])
        && !rowsOf(SM).some((x) => x.principal_id === c.principal_id && x.channel_id === c.channel_id && x.ts === c.ts)) {
        return new PgError("23503", 'insert or update on table "exec_slack_message_links" violates foreign key constraint "exec_slack_message_links_message_fkey"');
      }
    }
    return null;
  }

  function unknownColumn(table: string, payload: Row, op: "insert" | "update"): PgError | null {
    for (const k of Object.keys(payload)) {
      if (fdb.missing.has(`${table}.${k}`)) return new PgError("PGRST204", `Could not find the '${k}' column of '${table}' in the schema cache`);
      if ((GENERATED[table as FakeSlackIntelTable] ?? []).includes(k)) {
        return op === "insert"
          ? new PgError("428C9", `cannot insert a non-DEFAULT value into column "${k}"`)
          : new PgError("428C9", `column "${k}" can only be updated to DEFAULT`);
      }
      const cols = COLUMNS[table as FakeSlackIntelTable];
      if (cols && !cols.includes(k)) return new PgError("PGRST204", `Could not find the '${k}' column of '${table}' in the schema cache`);
    }
    return null;
  }

  /** Insert rows (with the DDL defaults and the generated columns) the way the RPCs do: refusals raise. */
  function insertRows(table: string, payloads: Row[], opts: { onConflictDoNothing?: boolean } = {}): Row[] {
    const nowIso = now().toISOString();
    const table$ = rowsOf(table);
    const inserted: Row[] = [];
    for (const p of payloads) {
      const row = { ...defaults(table, nowIso, nextLogId), ...structuredClone(p) };
      generate(table, row);
      const err = refusal(table, [row], table$);
      if (err) {
        if (opts.onConflictDoNothing && err.code === "23505") continue;
        throw err;
      }
      table$.push(row);
      inserted.push(row);
    }
    return inserted;
  }

  /** Update rows in place (generated columns recomputed), with the ON UPDATE CASCADE of the keys P7b's FKs reference. */
  function updateRows(table: string, rows: Row[], patch: Row): void {
    const table$ = rowsOf(table);
    const next = rows.map((r) => {
      const n = Object.assign(structuredClone(r), structuredClone(patch));
      generate(table, n);
      return n;
    });
    const err = refusal(table, next, table$.filter((r) => !rows.includes(r)), new Set(Object.keys(patch)));
    if (err) throw err;
    rows.forEach((r, i) => {
      const before = { principal_id: r.principal_id, channel_id: r.channel_id, ts: r.ts };
      Object.assign(r, next[i]);
      cascadeUpdate(table, before, r);
    });
  }

  function cascadeUpdate(table: string, before: Row, after: Row): void {
    if (table === CH && before.channel_id !== after.channel_id) {
      for (const t of [CL, DG, SM, IT, ML]) {
        for (const x of rowsOf(t)) if (x.principal_id === before.principal_id && x.channel_id === before.channel_id) x.channel_id = after.channel_id;
      }
    }
    if (table === SM && (before.channel_id !== after.channel_id || before.ts !== after.ts)) {
      for (const t of [IT, ML]) {
        for (const x of rowsOf(t)) {
          if (x.principal_id === before.principal_id && x.channel_id === before.channel_id && x.ts === before.ts) {
            x.channel_id = after.channel_id;
            x.ts = after.ts;
          }
        }
      }
    }
  }

  /** Delete rows of a table with ON DELETE CASCADE (channels → links, digests, messages; messages → items, message links). */
  function deleteRows(table: string, doomed: Row[]): void {
    const gone = new Set(doomed);
    (tables as Record<string, Row[]>)[table] = rowsOf(table).filter((r) => !gone.has(r));
    if (table === CH) {
      const keys = new Set(doomed.map((r) => `${String(r.principal_id)}|${String(r.channel_id)}`));
      const of = (x: Row) => keys.has(`${String(x.principal_id)}|${String(x.channel_id)}`);
      for (const t of [CL, DG]) (tables as Record<string, Row[]>)[t] = rowsOf(t).filter((x) => !of(x));
      deleteRows(SM, rowsOf(SM).filter(of));
    }
    if (table === SM) {
      const keys = new Set(doomed.map((r) => `${String(r.principal_id)}|${String(r.channel_id)}|${String(r.ts)}`));
      const of = (x: Row) => keys.has(`${String(x.principal_id)}|${String(x.channel_id)}|${String(x.ts)}`);
      for (const t of [IT, ML]) (tables as Record<string, Row[]>)[t] = rowsOf(t).filter((x) => !of(x));
    }
    if (table === CV) {
      const ids = new Set(doomed.map((r) => r.id));
      (tables as Record<string, Row[]>)[MS] = rowsOf(MS).filter((m) => !ids.has(m.conversation_id));
    }
  }

  const channelOf = (p: unknown, c: unknown) => rowsOf(CH).find((x) => x.principal_id === p && x.channel_id === c) ?? null;
  const readable = (ch: Row | null) => ch !== null && ["standard", "external", "finance"].includes(String(ch.class)) && isNull(ch.left_at);
  const clampLimit = (v: unknown, lo: number, hi: number, dflt: number) =>
    Math.min(Math.max(typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt, lo), hi);
  const byTsText = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

  // --- the fourteen RPCs, line for line with §2.1 ------------------------------

  /** RPC 1. */
  function setChannelLinks(a: Row): unknown {
    const projects = a.p_project_ids;
    if (!Array.isArray(projects) || projects.length > 10) throw raise("exec_slack_set_channel_links: bad project ids");
    if (isNull(a.p_client_id) !== isNull(a.p_client_name)) throw raise("exec_slack_set_channel_links: client id and name go together");
    const ch = channelOf(a.p_principal, a.p_channel_id);
    if (!ch) return "not_found";
    if (!["standard", "external", "finance"].includes(String(ch.class)) || ch.conv_type === "im" || ch.watch_state === "unwatched" || !isNull(ch.left_at)) {
      return "not_taggable";
    }
    const nowIso = now().toISOString();
    const tags = {
      tag_client_id: a.p_client_id ?? null, tag_client_name: a.p_client_name ?? null, tag_project_ids: [...projects],
      tagged_at: isNull(a.p_client_id) && projects.length === 0 ? null : nowIso
    };
    const existing = rowsOf(CL).filter((x) => x.principal_id === a.p_principal && x.channel_id === a.p_channel_id);
    if (existing.length > 0) updateRows(CL, existing, { ...tags, updated_at: nowIso });
    else insertRows(CL, [{ principal_id: a.p_principal, channel_id: a.p_channel_id, ...tags, created_at: nowIso, updated_at: nowIso }]);
    return "ok";
  }

  /** RPC 2. */
  function setChannelRules(a: Row): unknown {
    const rows = a.p_rows;
    if (!Array.isArray(rows) || rows.length > 2000) throw raise("exec_slack_set_channel_rules: rows must be an array of at most 2000");
    const nowIso = now().toISOString();
    const seen = new Set<string>();
    let n = 0;
    for (const raw of rows as Row[]) {
      const r = raw && typeof raw === "object" ? raw : {};
      if (!channelOf(a.p_principal, r.channel_id)) continue;
      const key = String(r.channel_id);
      if (seen.has(key)) throw new PgError("21000", "ON CONFLICT DO UPDATE command cannot affect row a second time");
      seen.add(key);
      const rule = { rule_client_id: r.client_id ?? null, rule_client_name: r.client_name ?? null, rule_candidates: typeof r.candidates === "number" ? r.candidates : 0 };
      const existing = rowsOf(CL).find((x) => x.principal_id === a.p_principal && x.channel_id === r.channel_id);
      if (!existing) {
        insertRows(CL, [{ principal_id: a.p_principal, channel_id: r.channel_id, ...rule, rule_computed_at: nowIso, created_at: nowIso, updated_at: nowIso }]);
        n += 1;
      } else if (existing.rule_client_id !== rule.rule_client_id || existing.rule_client_name !== rule.rule_client_name
        || existing.rule_candidates !== rule.rule_candidates || isNull(existing.rule_computed_at)) {
        updateRows(CL, [existing], { ...rule, rule_computed_at: nowIso, updated_at: nowIso });
        n += 1;
      }
    }
    return n;
  }

  /** RPC 3. */
  function unlinkedMessages(a: Row): unknown {
    const limit = clampLimit(a.p_limit, 1, 2000, 500);
    const linked = new Set(rowsOf(ML).filter((l) => l.principal_id === a.p_principal).map((l) => `${String(l.channel_id)}|${String(l.ts)}`));
    return rowsOf(SM)
      .filter((m) => m.principal_id === a.p_principal && !linked.has(`${String(m.channel_id)}|${String(m.ts)}`))
      .sort((x, y) => (ms(x.created_at) - ms(y.created_at)) || byTsText(x.channel_id, y.channel_id) || byTsText(x.ts, y.ts))
      .slice(0, limit)
      .map((m) => ({
        channel_id: m.channel_id, ts: m.ts, thread_ts: m.thread_ts ?? null, role: m.role, is_dd_post: m.is_dd_post === true, dd_paths: strs(m.dd_paths),
        summaries: rowsOf(IT).filter((i) => i.principal_id === m.principal_id && i.channel_id === m.channel_id && i.ts === m.ts && !isNull(i.summary))
          .map((i) => i.summary)
      }));
  }

  /** RPC 4. */
  function projectItems(a: Row): unknown {
    const since = ms(a.p_since);
    const tasks = strs(a.p_task_ids);
    const keys = rowsOf(ML).filter((l) => l.principal_id === a.p_principal && (strs(l.project_ids).includes(String(a.p_project_id))
      || strs(l.task_ids).some((t) => tasks.includes(t))));
    const tagged = new Set(rowsOf(CL).filter((l) => l.principal_id === a.p_principal && strs(l.tag_project_ids).includes(String(a.p_project_id)))
      .map((l) => l.channel_id));
    const best = new Map<string, { id: string; via: string; at: number; rank: number }>();
    const put = (id: string, via: string, at: number, rank: number) => {
      const prior = best.get(id);
      if (!prior || rank < prior.rank) best.set(id, { id, via, at, rank });
    };
    for (const i of rowsOf(IT)) {
      if (i.principal_id !== a.p_principal) continue;
      const at = tsTime(i.ts);
      if (!(at >= since)) continue;
      if (keys.some((k) => k.channel_id === i.channel_id && k.ts === i.ts)) put(String(i.id), "link", at, 0);
      if (!isNull(i.thread_ts) && i.thread_ts !== i.ts && keys.some((k) => k.channel_id === i.channel_id && k.ts === i.thread_ts)) put(String(i.id), "thread", at, 1);
      if (tagged.has(i.channel_id)) put(String(i.id), "tag", at, 2);
    }
    return [...best.values()]
      .sort((x, y) => (y.at - x.at) || byTsText(x.id, y.id))
      .slice(0, clampLimit(a.p_limit, 1, 150, 30))
      .map((h) => ({ item_id: h.id, via: h.via, at: new Date(h.at).toISOString() }));
  }

  /** The newest opt-out's created_at as epoch ms (-Infinity when none): RPC 5's and RPC 13's digest guard (fixer security-3). */
  function latestOptout(principal: unknown): number {
    // A seeded opt-out without created_at reads as made now (the column's default now(), at its insert).
    return rowsOf(OO).filter((o) => o.principal_id === principal)
      .reduce((m, o) => Math.max(m, Number.isFinite(ms(o.created_at)) ? ms(o.created_at) : now().getTime()), Number.NEGATIVE_INFINITY);
  }

  /** RPC 5. */
  function search(a: Row): unknown {
    const q = webQuery(a.p_query ?? "");
    const since = ms(a.p_since);
    const channels = strs(a.p_channel_ids);
    const bypass = strs(a.p_bypass_channel_ids);
    const kinds = isNull(a.p_kinds) ? null : strs(a.p_kinds);
    const out: { src: string; id: string; channel_id: string; rank: number; at: number }[] = [];
    for (const i of rowsOf(IT)) {
      if (i.principal_id !== a.p_principal) continue;
      if (!(channels.includes(String(i.channel_id)) || (i.bypass_mute === true && bypass.includes(String(i.channel_id))))) continue;
      const at = tsTime(i.ts);
      if (!(at >= since) || (kinds !== null && !kinds.includes(String(i.kind)))) continue;
      const text = `${typeof i.summary === "string" ? i.summary : ""} ${typeof i.excerpt === "string" ? i.excerpt : ""}`;
      if (!queryEmpty(q) && !queryMatch(q, text)) continue;
      out.push({ src: "item", id: String(i.id), channel_id: String(i.channel_id), rank: queryRank(q, text), at });
    }
    if (a.p_include_digests === true && kinds === null) {
      const cut = latestOptout(a.p_principal);
      for (const d of rowsOf(DG)) {
        if (d.principal_id !== a.p_principal || d.status !== "built" || !channels.includes(String(d.channel_id))) continue;
        if (!(ms(d.requested_at) > cut)) continue;
        const at = ms(d.built_at);
        if (!(at >= since)) continue;
        const text = typeof d.summary === "string" ? d.summary : "";
        if (!queryEmpty(q) && !queryMatch(q, text)) continue;
        out.push({ src: "digest", id: String(d.id), channel_id: String(d.channel_id), rank: queryRank(q, text), at });
      }
    }
    return out
      .sort((x, y) => (y.rank - x.rank) || (y.at - x.at) || byTsText(x.id, y.id))
      .slice(0, clampLimit(a.p_limit, 1, 50, 10))
      .map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
  }

  /** RPC 6. */
  function digestClaim(a: Row): unknown {
    if (isNull(a.p_mode) || !["plan", "today", "rebuild"].includes(String(a.p_mode))) {
      throw raise(`exec_slack_digest_claim: bad mode ${isNull(a.p_mode) ? "<NULL>" : String(a.p_mode)}`);
    }
    if (!channelOf(a.p_principal, a.p_channel_id)) return { outcome: "not_found" };
    const nowDate = now();
    const nowIso = nowDate.toISOString();
    const v = rowsOf(DG).find((d) => d.principal_id === a.p_principal && d.channel_id === a.p_channel_id && d.local_date === a.p_local_date);
    if (!v) {
      const [row] = insertRows(DG, [{ principal_id: a.p_principal, channel_id: a.p_channel_id, local_date: a.p_local_date, tz: a.p_tz, from_ts: a.p_from_ts,
        to_ts: a.p_to_ts, status: "building", requested_at: nowIso, expires_at: a.p_expires_at }]);
      return { outcome: "claimed", id: row.id, rebuilds: row.rebuilds };
    }
    if (v.status === "building" && ms(v.requested_at) > nowDate.getTime() - 600_000) return { outcome: "busy" };
    const mode = String(a.p_mode);
    const reclaim = ["stale", "failed", "skipped_cap", "building"].includes(String(v.status))
      || ((mode === "plan" || mode === "rebuild") && (v.status === "built" || v.status === "empty") && v.full_day !== true)
      || (mode === "today" && (v.status === "built" || v.status === "empty") && ms(v.built_at ?? v.requested_at) < nowDate.getTime() - 3_600_000);
    if (!reclaim) return { outcome: "fresh" };
    updateRows(DG, [v], {
      status: "building", summary: null, highlights: [], decisions: [], open_questions: [], source_ts: [], full_day: false, tz: a.p_tz, from_ts: a.p_from_ts,
      to_ts: a.p_to_ts, requested_at: nowIso, expires_at: a.p_expires_at, updated_at: nowIso
    });
    return { outcome: "claimed", id: v.id, rebuilds: v.rebuilds };
  }

  /** RPC 7. */
  function digestFinish(a: Row): unknown {
    const status = a.p_status;
    if (isNull(status) || !["built", "empty", "failed", "skipped_cap"].includes(String(status))) {
      throw raise(`exec_slack_digest_finish: bad status ${isNull(status) ? "<NULL>" : String(status)}`);
    }
    const v = rowsOf(DG).find((d) => d.id === a.p_id && d.principal_id === a.p_principal);
    if (!v || v.status !== "building") return "lost";
    const nowIso = now().toISOString();
    if (!readable(channelOf(a.p_principal, v.channel_id))) {
      deleteRows(DG, [v]);
      return "channel_gone";
    }
    const src = strs(a.p_source_ts);
    const requested = ms(v.requested_at);
    if ((status === "built" || status === "empty") && (
      rowsOf(DL).some((x) => x.principal_id === a.p_principal && x.channel_id === v.channel_id && src.includes(String(x.ts)))
      || rowsOf(PL).some((x) => x.principal_id === a.p_principal && x.scope === "message" && x.channel_id === v.channel_id && src.includes(String(x.ts))
        && ms(x.created_at) >= requested)
      || rowsOf(OO).some((x) => x.principal_id === a.p_principal && ms(x.created_at) >= requested))) {
      updateRows(DG, [v], { status: "stale", summary: null, highlights: [], decisions: [], open_questions: [], source_ts: [], full_day: false,
        rebuilds: Math.min(Number(v.rebuilds) + 1, 1000), updated_at: nowIso });
      return "deleted_source";
    }
    const built = status === "built";
    const counts = (a.p_counts && typeof a.p_counts === "object" ? a.p_counts : {}) as Row;
    const n = (k: string) => (typeof counts[k] === "number" ? (counts[k] as number) : 0);
    updateRows(DG, [v], {
      status,
      summary: built ? a.p_summary ?? null : null,
      highlights: built ? arr(a.p_highlights ?? []) : [],
      decisions: built ? arr(a.p_decisions ?? []) : [],
      open_questions: built ? arr(a.p_questions ?? []) : [],
      source_ts: status === "built" || status === "empty" ? src : [],
      human_count: n("human"), bot_count: n("bot"), dd_post_count: n("ddPost"), external_count: n("external"), thread_count: n("threads"),
      privacy: a.p_privacy ?? null, partial: a.p_partial === true, injection_suspected: a.p_injection === true,
      full_day: (status === "built" || status === "empty") && a.p_full_day === true,
      model: a.p_model ?? null, cost_usd: a.p_cost ?? null, built_at: nowIso, updated_at: nowIso
    });
    return "ok";
  }

  /** RPC 8. */
  function digestBlank(a: Row): unknown {
    const all = a.p_all === true;
    const ts = Array.isArray(a.p_ts) ? strs(a.p_ts) : null;
    const dates = Array.isArray(a.p_dates) ? strs(a.p_dates) : null;
    if (!all && (isNull(a.p_channel_id) || ts === null || ts.length === 0 || ts.length > 500 || dates === null || dates.length > 30)) {
      throw raise("exec_slack_digest_blank: a channel, 1..500 ts and at most 30 dates, or p_all");
    }
    const nowIso = now().toISOString();
    const hits = rowsOf(DG).filter((d) => d.principal_id === a.p_principal && (
      (all && ["built", "empty", "building"].includes(String(d.status)))
      || (!all && d.channel_id === a.p_channel_id && (dates ?? []).includes(String(d.local_date))
        && (strs(d.source_ts).some((x) => (ts ?? []).includes(x)) || d.status === "building"))));
    const out = hits.map((d) => ({ id: d.id, channel_id: d.channel_id, local_date: d.local_date, old_rebuilds: d.rebuilds }));
    for (const d of hits) {
      updateRows(DG, [d], { status: "stale", summary: null, highlights: [], decisions: [], open_questions: [], source_ts: [], full_day: false,
        rebuilds: Math.min(Number(d.rebuilds) + 1, 1000), updated_at: nowIso });
    }
    return out;
  }

  /** P5b's exec_chat_finish_turn, minimally (running → final, CAS; the conversation's ref_seq). */
  function finishTurnV1(a: Row): boolean {
    if (isNull(a.p_status) || !["complete", "aborted", "refused", "failed", "capped"].includes(String(a.p_status))) {
      throw raise(`exec_chat_finish_turn: bad status ${String(a.p_status)}`);
    }
    const m = rowsOf(MS).find((x) => x.id === a.p_message_id && x.principal_id === a.p_principal && x.role === "assistant" && x.status === "running");
    if (!m) return false;
    const nowIso = now().toISOString();
    updateRows(MS, [m], {
      status: a.p_status, status_reason: a.p_status_reason ?? null, refusal_category: a.p_refusal_category ?? null, text: a.p_text ?? "",
      recommendations: a.p_recommendations ?? "", sources: a.p_sources ?? [], cards: a.p_cards ?? [], tool_calls: a.p_tool_calls ?? [],
      consulted_email_thread_ids: a.p_consulted ?? [], consulted_client_ids: a.p_consulted_clients ?? [], consulted_dd_text: a.p_consulted_dd_text === true,
      usage: a.p_usage ?? null, model: a.p_model ?? null, finished_at: nowIso, updated_at: nowIso
    });
    const conv = rowsOf(CV).find((c) => c.id === m.conversation_id);
    if (conv) {
      const seq = Math.min(Math.max(typeof a.p_ref_seq === "number" ? a.p_ref_seq : 0, 0), 100000);
      conv.ref_seq = Math.max(Number(conv.ref_seq ?? 0), seq);
      conv.last_message_at = nowIso;
      conv.updated_at = nowIso;
    }
    return true;
  }

  /** RPC 9. */
  function finishTurnV2(a: Row): unknown {
    if (arr(a.p_slack_refs).length > 600 || arr(a.p_slack_channels).length > 200) throw raise("exec_chat_finish_turn_v2: too many Slack refs");
    const ok = finishTurnV1(a);
    if (ok && (arr(a.p_slack_channels).length > 0 || a.p_private_slack === true)) {
      const m = rowsOf(MS).filter((x) => x.id === a.p_message_id && x.principal_id === a.p_principal && x.role === "assistant");
      updateRows(MS, m, { consulted_slack_refs: strs(a.p_slack_refs), consulted_slack_channels: strs(a.p_slack_channels),
        consulted_private_slack: a.p_private_slack === true });
    }
    return ok;
  }

  const hasArgs = (m: Row) => arr(m.tool_calls).some((e) => e !== null && typeof e === "object" && "args" in (e as Row));
  const needsRedaction = (m: Row) => isNull(m.redacted_at) || m.recommendations !== "" || arr(m.sources).length > 0 || hasArgs(m);

  /** P5b's exec_chat_redact_message, minimally (no task proposals: not this fake's table). */
  function redactMessage(principal: unknown, id: unknown, text: string, via: FakeSlackIntelRedaction["rpc"]): boolean {
    const m = rowsOf(MS).find((x) => x.id === id && x.principal_id === principal && x.role === "assistant" && x.status !== "running");
    if (!m || !needsRedaction(m)) return false;
    const nowIso = now().toISOString();
    updateRows(MS, [m], {
      text: isNull(m.redacted_at) ? text : m.text,
      recommendations: "",
      sources: [],
      tool_calls: arr(m.tool_calls).map((e) => {
        const t = (e ?? {}) as Row;
        return { round: t.round ?? null, name: t.name ?? null, ok: t.ok ?? null, error: t.error ?? null };
      }),
      redacted_at: m.redacted_at ?? nowIso,
      updated_at: nowIso
    });
    fdb.redactions.push({ rpc: via, messageId: String(id), text });
    return true;
  }

  /** RPC 10 (via: which RPC called it, for `redactions`). */
  function redactSlack(a: Row, via: FakeSlackIntelRedaction["rpc"] = "exec_chat_redact_slack"): number {
    if (isNull(a.p_principal)) return 0;
    const text = a.p_text;
    if (typeof text !== "string" || text.length < 1 || text.length > 400) throw raise("exec_chat_redact_slack: bad text");
    const mk = strs(a.p_message_keys);
    const dk = strs(a.p_digest_keys);
    const ch = strs(a.p_channel_ids);
    const all = a.p_all === true;
    if (mk.length + dk.length + ch.length > 500) throw raise("exec_chat_redact_slack: at most 500 keys and channels per call");
    if (!all && mk.length + dk.length + ch.length === 0) return 0;
    const mine = rowsOf(MS).filter((m) => m.principal_id === a.p_principal && m.role === "assistant");
    const firstHit = new Map<unknown, number>();
    for (const m of mine) {
      const refs = strs(m.consulted_slack_refs);
      const chans = strs(m.consulted_slack_channels);
      const direct = refs.some((r) => mk.includes(r) || dk.includes(r)) || chans.some((c) => ch.includes(c)) || (all && chans.length > 0);
      const cited = arr(m.sources).some((s) => {
        const src = s && typeof s === "object" ? ((s as Row).source as Row | undefined) : undefined;
        if (!src || src.system !== "slack") return false;
        const id = typeof src.id === "string" ? src.id : "";
        return all || ch.includes(id.split(":")[0]) || mk.includes(`m:${id}`);
      });
      if (!direct && !cited) continue;
      const at = ms(m.created_at);
      const prior = firstHit.get(m.conversation_id);
      if (prior === undefined || at < prior) firstHit.set(m.conversation_id, at);
    }
    const targets = mine
      .filter((m) => m.status !== "running" && firstHit.has(m.conversation_id) && ms(m.created_at) >= (firstHit.get(m.conversation_id) as number) && needsRedaction(m))
      .sort((x, y) => (ms(x.created_at) - ms(y.created_at)) || byTsText(x.id, y.id))
      .slice(0, 2000);
    let n = 0;
    for (const m of targets) if (redactMessage(a.p_principal, m.id, text, via)) n += 1;
    return n;
  }

  /** RPC 11. */
  function slackRecheck(a: Row): unknown {
    const m = rowsOf(MS).find((x) => x.id === a.p_message_id && x.principal_id === a.p_principal && x.role === "assistant");
    if (!m || strs(m.consulted_slack_channels).length === 0) return false;
    const began = ms(m.created_at);
    const all = !rowsOf(SI).some((i) => i.principal_id === a.p_principal && isNull(i.revoked_at) && isNull(i.user_revoked_at) && !isNull(i.user_token_enc))
      // Fixer correctness-7: an opt-out since the turn began.
      || rowsOf(OO).some((o) => o.principal_id === a.p_principal && ms(o.created_at) >= began);
    const refs = strs(m.consulted_slack_refs);
    const mk = refs.filter((k) => k.startsWith("m:")
      && (rowsOf(DL).some((x) => x.principal_id === a.p_principal && `m:${String(x.channel_id)}:${String(x.ts)}` === k)
        || rowsOf(PL).some((x) => x.principal_id === a.p_principal && x.scope === "message" && `m:${String(x.channel_id)}:${String(x.ts)}` === k)));
    const keyOf = (d: Row) => `d:${String(d.channel_id)}:${String(d.local_date)}:${String(d.rebuilds)}`;
    // Fixer security-4: a row reclaimed since the turn began whose window holds a deleted marker or a message outbox row.
    const inWindow = (d: Row, ts: unknown) => tsTime(ts) >= tsTime(d.from_ts) && tsTime(ts) <= tsTime(d.to_ts);
    const replacedOverDelete = (d: Row) => ms(d.requested_at) >= began
      && (rowsOf(DL).some((x) => x.principal_id === a.p_principal && x.channel_id === d.channel_id && inWindow(d, x.ts))
        || rowsOf(PL).some((x) => x.principal_id === a.p_principal && x.scope === "message" && x.channel_id === d.channel_id && inWindow(d, x.ts)));
    const dk = refs.filter((k) => k.startsWith("d:")
      && (!rowsOf(DG).some((d) => d.principal_id === a.p_principal && keyOf(d) === k)
        || rowsOf(DG).some((d) => d.principal_id === a.p_principal && keyOf(d) === k && replacedOverDelete(d))));
    const ch = strs(m.consulted_slack_channels).filter((c) => !readable(channelOf(a.p_principal, c))
      // Fixer correctness-7: a conversation purge (not a re-key) since the turn began.
      || rowsOf(PL).some((x) => x.principal_id === a.p_principal && x.scope === "conversation" && x.channel_id === c && x.reason !== "rekey" && ms(x.created_at) >= began));
    if (!all && mk.length + dk.length + ch.length === 0) return false;
    return redactSlack({ p_principal: a.p_principal, p_message_keys: mk, p_digest_keys: dk, p_channel_ids: ch, p_all: all, p_text: a.p_text },
      "exec_chat_slack_recheck") > 0;
  }

  /** RPC 12 (setof text: PostgREST answers the scalars). */
  function orphanChannels(a: Row): unknown {
    const out: string[] = [];
    for (const m of rowsOf(MS)) {
      if (m.principal_id !== a.p_principal || m.role !== "assistant" || !isNull(m.redacted_at)) continue;
      for (const c of strs(m.consulted_slack_channels)) if (!out.includes(c) && !readable(channelOf(a.p_principal, c))) out.push(c);
    }
    return out.slice(0, clampLimit(a.p_limit, 1, 200, 200));
  }

  /** RPC 13. */
  function publicFacts(a: Row): unknown {
    const p = a.p_principal;
    const since = ms(a.p_since);
    const okChannels = new Set(rowsOf(CH).filter((c) => c.principal_id === p && c.conv_type === "channel" && c.is_private === false && c.class === "standard"
      && c.watch_state === "watched" && isNull(c.left_at) && c.is_ext_shared !== true && c.ext_ever !== true && c.finance_name !== true).map((c) => c.channel_id));
    const high = new Set(rowsOf(CL).filter((l) => l.principal_id === p && okChannels.has(l.channel_id) && l.client_id === a.p_client_id
      && l.match_confidence === "high").map((l) => l.channel_id));
    const out: { src: string; id: unknown; channel_id: unknown; ts: unknown; local_date: unknown; kind: unknown; body: unknown; at: number }[] = [];
    for (const i of rowsOf(IT)) {
      if (i.principal_id !== p || !okChannels.has(i.channel_id)) continue;
      const m = rowsOf(SM).find((x) => x.principal_id === i.principal_id && x.channel_id === i.channel_id && x.ts === i.ts);
      const at = tsTime(i.ts);
      if (!m || !(at >= since) || isNull(i.summary) || i.source_class !== "public" || i.assessed !== true) continue;
      if (!["decision", "commitment", "action_item", "fyi"].includes(String(i.kind))) continue;
      if (i.author_external === true || m.is_dd_post === true || m.author_external === true) continue;
      if (rowsOf(DL).some((x) => x.principal_id === p && x.channel_id === i.channel_id && x.ts === i.ts)) continue;
      if (rowsOf(OO).some((x) => x.principal_id === p && !isNull(i.author_user_id) && x.author_user_id === i.author_user_id)) continue;
      const root = isNull(i.thread_ts) ? i.ts : i.thread_ts;
      const linked = high.has(i.channel_id) || rowsOf(ML).some((l) => l.principal_id === p && l.channel_id === i.channel_id && (l.ts === i.ts || l.ts === root)
        && l.client_id === a.p_client_id && l.match_confidence === "high");
      if (!linked) continue;
      out.push({ src: "item", id: i.id, channel_id: i.channel_id, ts: i.ts, local_date: null, kind: i.kind, body: i.summary, at });
    }
    const sinceDate = Number.isFinite(since) ? new Date(since).toISOString().slice(0, 10) : "9999-12-31";
    const cut = latestOptout(p);
    for (const d of rowsOf(DG)) {
      if (d.principal_id !== p || !high.has(d.channel_id) || d.status !== "built" || d.privacy !== "public" || String(d.local_date) < sinceDate) continue;
      if (d.injection_suspected === true || !(ms(d.requested_at) > cut)) continue;
      const at = ms(d.built_at);
      for (const [kind, list] of [["decision", d.decisions], ["fyi", d.highlights]] as const) {
        for (const e of arr(list)) {
          const body = e && typeof e === "object" ? (e as Row).text : undefined;
          if (typeof body === "string") out.push({ src: "digest", id: d.id, channel_id: d.channel_id, ts: null, local_date: d.local_date, kind, body, at });
        }
      }
    }
    return out
      .sort((x, y) => (y.at - x.at) || byTsText(x.id, y.id))
      .slice(0, clampLimit(a.p_limit, 1, 20, 8))
      .map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
  }

  /** RPC 14. */
  function forgetChannels(a: Row): unknown {
    if (isNull(a.p_principal)) return [];
    let ids = strs(a.p_channel_ids);
    if (ids.length > 500) throw raise("exec_slack_intel_forget_channels: at most 500 channels");
    const p = a.p_principal;
    if (a.p_scan === true) {
      const found: string[] = [];
      for (const d of rowsOf(DG)) {
        const c = channelOf(p, d.channel_id);
        if (d.principal_id === p && c && (["deny", "hub", "unclassified"].includes(String(c.class)) || !isNull(c.left_at))) found.push(String(d.channel_id));
      }
      for (const l of rowsOf(CL)) {
        const c = channelOf(p, l.channel_id);
        if (l.principal_id === p && c && ["deny", "hub"].includes(String(c.class))) found.push(String(l.channel_id));
      }
      ids = [...ids, ...[...new Set(found)].slice(0, 500)];
    }
    const out: { channel_id: string; digests: number; links: number }[] = [];
    for (const c of [...new Set(ids)].sort()) {
      const digests = rowsOf(DG).filter((d) => d.principal_id === p && d.channel_id === c);
      deleteRows(DG, digests);
      const ch = channelOf(p, c);
      const links = rowsOf(CL).filter((l) => l.principal_id === p && l.channel_id === c && !(ch && !["deny", "hub"].includes(String(ch.class))));
      deleteRows(CL, links);
      out.push({ channel_id: c, digests: digests.length, links: links.length });
    }
    return out;
  }

  const rpcs: Record<FakeSlackIntelRpc, (args: Row) => unknown> = {
    exec_slack_set_channel_links: setChannelLinks,
    exec_slack_set_channel_rules: setChannelRules,
    exec_slack_unlinked_messages: unlinkedMessages,
    exec_slack_project_items: projectItems,
    exec_slack_search: search,
    exec_slack_digest_claim: digestClaim,
    exec_slack_digest_finish: digestFinish,
    exec_slack_digest_blank: digestBlank,
    exec_chat_finish_turn_v2: finishTurnV2,
    exec_chat_redact_slack: (args) => redactSlack(args),
    exec_chat_slack_recheck: slackRecheck,
    exec_chat_slack_orphan_channels: orphanChannels,
    exec_slack_public_facts: publicFacts,
    exec_slack_intel_forget_channels: forgetChannels
  };

  // --- one request ------------------------------------------------------------

  function errorOf(err: unknown): FakeSlackDbError {
    if (err instanceof PgError) return { message: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
    const e = err as { message?: string; code?: string };
    return { message: typeof e?.message === "string" ? e.message : String(err), ...(typeof e?.code === "string" ? { code: e.code } : {}) };
  }

  /** A whole request is atomic: on any refusal the tables go back to how they were (one statement, one transaction). */
  function atomically<T>(fn: () => T): T {
    const snapshot = structuredClone(tables);
    const seq = logSeq;
    const redactions = fdb.redactions.length;
    try {
      return fn();
    } catch (err) {
      for (const t of TABLES) tables[t] = snapshot[t];
      logSeq = seq;
      fdb.redactions.length = redactions;
      throw err;
    }
  }

  function run(r: FakeSlackIntelDbCall): Result {
    const opts = r.options ?? {};
    const wantCount = opts.count === "exact";
    if (r.kind === "rpc") {
      const impl = rpcs[r.target as FakeSlackIntelRpc];
      if (!impl) return { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } };
      const dep = RPC_TABLES[r.target as FakeSlackIntelRpc].find((t) => fdb.missing.has(t));
      if (dep) return { data: null, count: null, error: { code: "42P01", message: `relation "public.${dep}" does not exist` } };
      return { data: structuredClone(atomically(() => impl((r.payload ?? {}) as Row))), count: null, error: null };
    }
    const table = r.target;
    let affected: Row[];
    if (r.kind === "insert" || r.kind === "upsert") {
      const payloads = (Array.isArray(r.payload) ? r.payload : [r.payload]) as Row[];
      for (const p of payloads) {
        const bad = unknownColumn(table, p, "insert");
        if (bad) throw bad;
      }
      affected = atomically(() => {
        if (r.kind === "insert") return insertRows(table, payloads);
        const keys = String(opts.onConflict ?? "id").split(",").map((s) => s.trim());
        const out: Row[] = [];
        for (const p of payloads) {
          const existing = rowsOf(table).find((row) => keys.every((k) => compare(row[k], p[k]) === 0));
          if (existing) {
            if (opts.ignoreDuplicates) continue;
            updateRows(table, [existing], p);
            out.push(existing);
          } else {
            out.push(...insertRows(table, [p]));
          }
        }
        return out;
      });
    } else {
      const rows = rowsOf(table).filter((row) => r.filters.every((f) => test(row, f)));
      if (r.kind === "update") {
        const bad = unknownColumn(table, (r.payload ?? {}) as Row, "update");
        if (bad) throw bad;
        atomically(() => updateRows(table, rows, (r.payload ?? {}) as Row));
        affected = rows;
      } else if (r.kind === "delete") {
        atomically(() => deleteRows(table, rows));
        affected = rows;
      } else {
        affected = sortRows(rows, r.orders);
        if (r.range) affected = affected.slice(r.range[0], r.range[1] + 1);
        if (r.limit !== null) affected = affected.slice(0, r.limit);
      }
    }
    const count = wantCount ? affected.length : null;
    if (opts.head === true || r.columns === null) return { data: null, count, error: null };
    const out = affected.map((row) => project(row, r.columns as string, table, fdb.missing));
    if (r.single === "single") {
      if (out.length !== 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0], count, error: null };
    }
    if (r.single === "maybe") {
      if (out.length > 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0] ?? null, count, error: null };
    }
    return { data: out, count, error: null };
  }

  async function execute(r: FakeSlackIntelDbCall): Promise<Result> {
    fdb.calls.push(r);
    await cfg.before?.(r, fdb);
    if (r.signal?.aborted) return { data: null, count: null, error: { ...ABORTED } };
    if (fdb.missing.has(r.target)) {
      return r.kind === "rpc"
        ? { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } }
        : { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${r.target}' in the schema cache` } };
    }
    const failed = cfg.fail?.(r);
    if (failed) return { data: null, count: null, error: failed };
    try {
      return run(r);
    } catch (err) {
      return { data: null, count: null, error: errorOf(err) };
    }
  }

  /** Like postgrest-js: a request whose signal fires before it settles resolves with the abort result. */
  function settle(r: FakeSlackIntelDbCall): Promise<Result> {
    const signal = r.signal;
    if (signal?.aborted) {
      fdb.calls.push(r);
      return Promise.resolve({ data: null, count: null, error: { ...ABORTED } });
    }
    const pending = execute(r);
    if (!signal) return pending;
    return new Promise<Result>((resolve, reject) => {
      const onAbort = () => resolve({ data: null, count: null, error: { ...ABORTED } });
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  function builder(r: FakeSlackIntelDbCall) {
    let settled: Promise<Result> | null = null;
    const b = {
      select(columns: string = "*", options?: { count?: string; head?: boolean }) {
        r.columns = columns;
        if (options) r.options = { ...(r.options ?? {}), ...options };
        return b;
      },
      eq: (column: string, value: unknown) => (r.filters.push({ op: "eq", column, value }), b),
      neq: (column: string, value: unknown) => (r.filters.push({ op: "neq", column, value }), b),
      lt: (column: string, value: unknown) => (r.filters.push({ op: "lt", column, value }), b),
      lte: (column: string, value: unknown) => (r.filters.push({ op: "lte", column, value }), b),
      gt: (column: string, value: unknown) => (r.filters.push({ op: "gt", column, value }), b),
      gte: (column: string, value: unknown) => (r.filters.push({ op: "gte", column, value }), b),
      is: (column: string, value: unknown) => (r.filters.push({ op: "is", column, value }), b),
      in: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "in", column, values: [...values] }), b),
      contains: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "contains", column, values: [...values] }), b),
      overlaps: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "overlaps", column, values: [...values] }), b),
      not: (column: string, operator: string, value: unknown) => (r.filters.push(parseNot(column, operator, value)), b),
      order(column: string, options?: { ascending?: boolean }) {
        r.orders.push({ column, ascending: options?.ascending !== false });
        return b;
      },
      range(from: number, to: number) {
        r.range = [from, to];
        return b;
      },
      limit(n: number) {
        r.limit = n;
        return b;
      },
      maybeSingle() {
        r.single = "maybe";
        return b;
      },
      single() {
        r.single = "single";
        return b;
      },
      abortSignal(signal: AbortSignal) {
        r.signal = signal;
        return b;
      },
      then<A, B>(onFulfilled?: (v: Result) => A, onRejected?: (e: unknown) => B) {
        settled ??= Promise.resolve().then(() => settle(r));
        return settled.then(onFulfilled, onRejected);
      }
    };
    return b;
  }

  const request = (kind: FakeSlackIntelDbCall["kind"], target: string, payload: unknown = null, options: Record<string, unknown> | null = null): FakeSlackIntelDbCall => ({
    kind, target, columns: null, payload: structuredClone(payload), options, filters: [], orders: [], limit: null, range: null, single: null, signal: null
  });

  fdb.client = {
    from(table: string) {
      return {
        select: (columns = "*", options?: { count?: string; head?: boolean }) => builder(request("select", table, null, options ? { ...options } : null)).select(columns, options),
        insert: (rows: unknown, options?: Record<string, unknown>) => builder(request("insert", table, rows, options ? { ...options } : null)),
        upsert: (row: unknown, options?: Record<string, unknown>) => builder(request("upsert", table, row, options ? { ...options } : {})),
        update: (patch: Row, options?: { count?: string }) => builder(request("update", table, patch, options ? { ...options } : null)),
        delete: (options?: { count?: string }) => builder(request("delete", table, null, options ? { ...options } : null))
      };
    },
    rpc(fn: string, args: Row = {}) {
      return builder(request("rpc", fn, args));
    }
  };
  return fdb;
}
