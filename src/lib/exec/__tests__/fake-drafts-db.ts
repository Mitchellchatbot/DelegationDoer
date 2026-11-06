// Test support: an in-memory stand-in for the service-role Supabase client
// covering every call exec/drafts-store.ts makes (P4 contract §5 "Fakes"):
//
//   from(t).select(cols[, { count, head }]) .eq/.neq/.lt/.lte/.gt/.gte/.is/.in/.not/.or/.order/.range/.limit
//                                            [.maybeSingle() | .single()] [.abortSignal()]
//   from(t).insert(row | rows) [.select(cols) [.single()]]
//   from(t).upsert(row, { onConflict }) [.select(cols)]
//   from(t).update(patch) ...filters... [.select(cols)]
//   from(t).delete({ count }) ...filters... [.select(cols)]
//   rpc("exec_drafts_purge_restricted" | "exec_drafts_purge_expired", args)
//
// exec_drafts behaves like the table: inserts get the DDL defaults, every
// insert and update is checked against the §2.1 CHECK subset below (23514 with
// the constraint's name) and against the partial unique index
// exec_drafts_one_active_per_thread (23505, the same predicate as the SQL:
// isActiveDraft). The two RPCs mirror the migration's bodies; the SQL suite
// runs the same cases against both (SQ19), so they can't drift. Filters follow
// SQL: a comparison with NULL is never true; timestamps compare as instants.
// Every request is logged in order. Wire it up with
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient)
//
// Areas B, C, D and E consume this fake; none edits it (contract §5).

export type Row = Record<string, unknown>;
export type DbError = { message: string; code?: string; details?: string };

export interface FakeRequest {
  kind: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  /** Table, or the RPC name. */
  target: string;
  columns: string | null;
  filters: Filter[];
  orders: { column: string; ascending: boolean }[];
  range: [number, number] | null;
  limit: number | null;
  single: "maybe" | "single" | null;
  count: string | null;
  head: boolean;
  payload: unknown;
  options: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

export type Filter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: Filter }
  | { op: "or"; terms: Filter[] }
  | { op: "and"; terms: Filter[] };

export interface FakeDraftsDbConfig {
  tables?: Record<string, Row[]>;
  /** Tables and RPCs that don't exist (the migration isn't applied). */
  missing?: readonly string[];
  /** An error for this request, or null to run it. */
  fail?: (r: FakeRequest) => DbError | null | undefined;
  /** Runs just before a request executes: simulate another writer here. */
  before?: (r: FakeRequest, db: FakeDraftsDb) => void | Promise<void>;
  /** The clock the defaults and the RPCs use. */
  now?: () => Date;
}

export interface FakeDraftsDb {
  client: unknown;
  tables: Record<string, Row[]>;
  requests: FakeRequest[];
  /** "select exec_drafts", "rpc exec_drafts_purge_restricted", ... in order. */
  log: string[];
  missing: Set<string>;
}

const DAY_MS = 86_400_000;
const DRAFTS = "exec_drafts";

// ---------------------------------------------------------------------------
// The §2.1 CHECK subset (also ST16's oracle) and the DDL defaults
// ---------------------------------------------------------------------------

const STATUSES = ["generating", "generation_failed", "draft", "saving", "saved", "sending", "sent_pending", "unknown", "sent", "sent_external", "gone", "discarding", "discarded"];
const TERMINAL = ["sent", "sent_external", "gone", "discarded"];
const LINKED = ["saved", "sending", "sent_pending", "unknown", "discarding", "sent", "sent_external", "gone"];
const ACTIVE = ["generating", "generation_failed", "draft", "saving", "saved", "sending", "sent_pending", "unknown", "discarding"];
const GENERATION_ERRORS = ["declined", "truncated", "invalid_output", "budget", "input_too_large", "thread_unavailable", "restricted", "model_error", "timeout", "stale", "stopped"];
const GENERATION_FLAGS = ["unexpected_url", "unexpected_email", "unexpected_phone", "unexpected_amount", "unexpected_number", "other_client_name", "teammate_name"];
const FACTS = ["used", "none", "not_matched", "medium_confidence", "unavailable", "recipients_outside_client"];
const BLOCKERS = ["already_replied", "newer_inbound", "reply_scheduled", "legacy_draft_pending", "opened_in_outlook", "changed_in_outlook",
  "recipients_changed", "reply_to_present", "placeholder_in_outlook", "thread_unavailable", "facts_outside_client", "unexpected_content"];
const CLONE_FLAGS = ["send_status_unknown", "not_found_after_send", "verify_overdue", "create_unconfirmed", "gone_unconfirmed", "unverified", "signature_skipped"];
const HEX64 = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const CLONE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isNull = (v: unknown) => v === null || v === undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const len = (v: unknown) => (typeof v === "string" ? v.length : 0);

/** The DDL defaults a bare insert gets (the SQL suite's fixtures rely on them, and so does SQ19's parity). */
export function draftDefaults(now: Date): Row {
  const nowIso = now.toISOString();
  return {
    id: `ed_${randomHex(32)}`,
    origin: "web",
    prior_status: null,
    version: 1,
    saved_version: null,
    generation_seq: 0,
    thread_id: null,
    parent_message_id: null,
    reply_mode: null,
    thread_subject: null,
    reply_candidates: null,
    thread_addresses: [],
    to_recipients: [],
    cc_recipients: [],
    bcc_recipients: [],
    subject: null,
    body_doc: null,
    body_html: null,
    body_text: null,
    instruction: null,
    note_for_mitchell: null,
    placeholders: [],
    review_recipients: null,
    recipients_sig: null,
    screen_hashes: [],
    screen_truncated: false,
    screened_policy_hash: null,
    model: null,
    usage: null,
    generation_error: null,
    generation_flags: [],
    facts_status: null,
    client_id: null,
    generated_at: null,
    outlook_graph_id: null,
    internet_message_id: null,
    conversation_id: null,
    web_link: null,
    content_hash: null,
    observed_content_hash: null,
    review_hash: null,
    review_at: null,
    review_blockers: [],
    confirm_hash: null,
    save_attempt_key: null,
    save_version: null,
    save_timezone: null,
    save_if_content_hash: null,
    save_started_at: null,
    discard_attempt_key: null,
    discard_started_at: null,
    send_attempt_key: null,
    send_started_at: null,
    send_accepted_at: null,
    sent_at: null,
    sent_audit_id: null,
    sent_mismatch: false,
    unverified: false,
    gone_unconfirmed: false,
    signature_skipped: false,
    outlook_edited: false,
    restricted_purged: false,
    uses_private_refs: false,
    clone_flags: [],
    owner_resolution: null,
    opened_in_outlook_at: null,
    last_error_code: null,
    last_error_at: null,
    next_check_at: null,
    check_count: 0,
    gone_at: null,
    created_at: nowIso,
    updated_at: nowIso,
    terminal_at: null,
    content_purged_at: null,
    expires_at: null
  };
}

let seq = 0;
function randomHex(n: number): string {
  seq += 1;
  const tail = seq.toString(16);
  return (`${"0".repeat(n)}${tail}`).slice(-n);
}

/** The partial unique index's predicate (§2.1), on a snake_case row. */
export function isActiveDraftRow(row: Row): boolean {
  return ACTIVE.includes(String(row.status)) || (row.status === "gone" && row.gone_unconfirmed === true);
}

/**
 * The CHECK constraints of exec_drafts a snake_case row violates, by name
 * (§2.1): the enum and shape checks of the columns and every named table
 * constraint. Empty = the row satisfies the subset. ST16 runs every
 * state-machine patch through it; the fake refuses inserts and updates with it.
 */
export function checkDraftRow(row: Row): string[] {
  const bad: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name);
  };
  const s = String(row.status);
  const enumOrNull = (name: string, v: unknown, values: readonly string[]) => check(name, isNull(v) || (typeof v === "string" && values.includes(v)));
  const subset = (name: string, v: unknown, values: readonly string[]) => check(name, Array.isArray(v) && v.every((x) => typeof x === "string" && values.includes(x)));
  const hexOrNull = (name: string, v: unknown) => check(name, isNull(v) || (typeof v === "string" && HEX64.test(v)));
  const keyOrNull = (name: string, v: unknown) => check(name, isNull(v) || (typeof v === "string" && KEY.test(v)));

  check("exec_drafts_id_check", typeof row.id === "string" && /^ed_[0-9a-f]{32}$/.test(row.id));
  check("exec_drafts_account_id_check", typeof row.account_id === "string" && row.account_id.length >= 1 && row.account_id.length <= 200);
  check("exec_drafts_kind_check", row.kind === "reply" || row.kind === "new");
  check("exec_drafts_origin_check", ["web", "slack", "chat"].includes(String(row.origin)));
  check("exec_drafts_status_check", STATUSES.includes(s));
  enumOrNull("exec_drafts_prior_status_check", row.prior_status, ["draft", "saved", "generation_failed", "unknown"]);
  check("exec_drafts_version_check", typeof row.version === "number" && row.version >= 1);
  check("exec_drafts_saved_version_check", isNull(row.saved_version) || (typeof row.saved_version === "number" && row.saved_version >= 1));
  check("exec_drafts_generation_seq_check", typeof row.generation_seq === "number" && row.generation_seq >= 0);
  check("exec_drafts_thread_id_check", isNull(row.thread_id) || (typeof row.thread_id === "string" && CLONE_ID.test(row.thread_id)));
  check("exec_drafts_parent_message_id_check", isNull(row.parent_message_id) || (typeof row.parent_message_id === "string" && CLONE_ID.test(row.parent_message_id)));
  enumOrNull("exec_drafts_reply_mode_check", row.reply_mode, ["reply", "reply_all", "follow_up"]);
  check("exec_drafts_thread_subject_check", isNull(row.thread_subject) || len(row.thread_subject) <= 200);
  check("exec_drafts_reply_candidates_check", isNull(row.reply_candidates) || (typeof row.reply_candidates === "object" && !Array.isArray(row.reply_candidates)));
  check("exec_drafts_thread_addresses_check", Array.isArray(row.thread_addresses) && row.thread_addresses.length <= 200);
  check("exec_drafts_to_recipients_check", Array.isArray(row.to_recipients));
  check("exec_drafts_cc_recipients_check", Array.isArray(row.cc_recipients));
  check("exec_drafts_bcc_recipients_check", Array.isArray(row.bcc_recipients));
  check("exec_drafts_subject_check", isNull(row.subject) || (typeof row.subject === "string" && row.subject.length >= 1 && row.subject.length <= 998 && !/[\n\r]/.test(row.subject)));
  check("exec_drafts_body_doc_check", isNull(row.body_doc) || (typeof row.body_doc === "object" && !Array.isArray(row.body_doc) && JSON.stringify(row.body_doc).length <= 65536));
  check("exec_drafts_body_html_check", isNull(row.body_html) || len(row.body_html) <= 1_000_000);
  check("exec_drafts_body_text_check", isNull(row.body_text) || len(row.body_text) <= 20_000);
  check("exec_drafts_instruction_check", isNull(row.instruction) || len(row.instruction) <= 2_000);
  check("exec_drafts_note_for_mitchell_check", isNull(row.note_for_mitchell) || len(row.note_for_mitchell) <= 400);
  check("exec_drafts_placeholders_check", Array.isArray(row.placeholders) && row.placeholders.length <= 20);
  check("exec_drafts_review_recipients_check", isNull(row.review_recipients) || (typeof row.review_recipients === "object" && !Array.isArray(row.review_recipients)));
  hexOrNull("exec_drafts_recipients_sig_check", row.recipients_sig);
  check("exec_drafts_screen_hashes_check", Array.isArray(row.screen_hashes) && row.screen_hashes.length <= 600);
  hexOrNull("exec_drafts_screened_policy_hash_check", row.screened_policy_hash);
  check("exec_drafts_render_nonce_check", typeof row.render_nonce === "string" && /^[A-Za-z0-9]{16,64}$/.test(row.render_nonce));
  check("exec_drafts_model_check", isNull(row.model) || len(row.model) <= 64);
  check("exec_drafts_usage_check", isNull(row.usage) || (typeof row.usage === "object" && !Array.isArray(row.usage)));
  enumOrNull("exec_drafts_generation_error_check", row.generation_error, GENERATION_ERRORS);
  subset("exec_drafts_generation_flags_check", row.generation_flags, GENERATION_FLAGS);
  enumOrNull("exec_drafts_facts_status_check", row.facts_status, FACTS);
  check("exec_drafts_client_id_check", isNull(row.client_id) || len(row.client_id) <= 200);
  check("exec_drafts_outlook_graph_id_check", isNull(row.outlook_graph_id) || (typeof row.outlook_graph_id === "string" && /^[A-Za-z0-9_=-]{1,512}$/.test(row.outlook_graph_id)));
  check("exec_drafts_internet_message_id_check", isNull(row.internet_message_id) || (len(row.internet_message_id) >= 1 && len(row.internet_message_id) <= 998));
  check("exec_drafts_conversation_id_check", isNull(row.conversation_id) || len(row.conversation_id) <= 512);
  check("exec_drafts_web_link_check", isNull(row.web_link) || (typeof row.web_link === "string" && row.web_link.length <= 4096 && row.web_link.startsWith("https://")));
  hexOrNull("exec_drafts_content_hash_check", row.content_hash);
  hexOrNull("exec_drafts_observed_content_hash_check", row.observed_content_hash);
  hexOrNull("exec_drafts_review_hash_check", row.review_hash);
  subset("exec_drafts_review_blockers_check", row.review_blockers, BLOCKERS);
  hexOrNull("exec_drafts_confirm_hash_check", row.confirm_hash);
  keyOrNull("exec_drafts_save_attempt_key_check", row.save_attempt_key);
  check("exec_drafts_save_version_check", isNull(row.save_version) || (typeof row.save_version === "number" && row.save_version >= 1));
  check("exec_drafts_save_timezone_check", isNull(row.save_timezone) || len(row.save_timezone) <= 64);
  hexOrNull("exec_drafts_save_if_content_hash_check", row.save_if_content_hash);
  keyOrNull("exec_drafts_discard_attempt_key_check", row.discard_attempt_key);
  keyOrNull("exec_drafts_send_attempt_key_check", row.send_attempt_key);
  subset("exec_drafts_clone_flags_check", row.clone_flags, CLONE_FLAGS);
  enumOrNull("exec_drafts_owner_resolution_check", row.owner_resolution, ["sent", "not_sent"]);
  check("exec_drafts_last_error_code_check", isNull(row.last_error_code) || (typeof row.last_error_code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(row.last_error_code)));
  check("exec_drafts_check_count_check", typeof row.check_count === "number" && row.check_count >= 0 && row.check_count <= 10_000);

  const reply = row.kind === "reply";
  check("exec_drafts_kind_shape",
    (reply && !isNull(row.thread_id) && !isNull(row.parent_message_id) && !isNull(row.reply_mode) && isNull(row.subject) && arr(row.bcc_recipients).length === 0) ||
    (row.kind === "new" && isNull(row.thread_id) && isNull(row.parent_message_id) && isNull(row.reply_mode) && isNull(row.thread_subject) && isNull(row.reply_candidates)));
  check("exec_drafts_recipient_count", arr(row.to_recipients).length + arr(row.cc_recipients).length + arr(row.bcc_recipients).length <= 20);
  check("exec_drafts_versions", isNull(row.saved_version) || Number(row.saved_version) <= Number(row.version));
  check("exec_drafts_prior",
    isNull(row.prior_status) ||
    (s === "generating" && ["draft", "saved", "generation_failed"].includes(String(row.prior_status))) ||
    (s === "discarding" && ["draft", "saved", "unknown"].includes(String(row.prior_status))));
  check("exec_drafts_linked", !LINKED.includes(s) || !isNull(row.outlook_graph_id));
  check("exec_drafts_terminal", TERMINAL.includes(s) === !isNull(row.terminal_at));
  check("exec_drafts_expiry", isNull(row.terminal_at) === isNull(row.expires_at));
  const purged = row.restricted_purged === true || !isNull(row.content_purged_at);
  check("exec_drafts_content_purged", !purged || (
    isNull(row.thread_subject) && isNull(row.reply_candidates) && arr(row.thread_addresses).length === 0 &&
    arr(row.to_recipients).length === 0 && arr(row.cc_recipients).length === 0 && arr(row.bcc_recipients).length === 0 &&
    isNull(row.subject) && isNull(row.body_doc) && isNull(row.body_html) && isNull(row.body_text) &&
    isNull(row.instruction) && isNull(row.note_for_mitchell) && arr(row.placeholders).length === 0 && isNull(row.review_recipients)));
  check("exec_drafts_content_purged_when", isNull(row.content_purged_at) || !isNull(row.terminal_at) || row.restricted_purged === true);
  check("exec_drafts_review_pair", isNull(row.review_hash) === isNull(row.review_at));
  check("exec_drafts_save_attempt", s !== "saving" || (!isNull(row.save_attempt_key) && !isNull(row.save_version) && !isNull(row.save_started_at)));
  check("exec_drafts_send_attempt", s !== "sending" || (!isNull(row.send_attempt_key) && !isNull(row.send_started_at) && !isNull(row.confirm_hash)));
  check("exec_drafts_discard_attempt", s !== "discarding" || (!isNull(row.discard_attempt_key) && !isNull(row.discard_started_at) && !isNull(row.prior_status)));
  check("exec_drafts_gone", (s !== "gone" || !isNull(row.gone_at)) && (row.gone_unconfirmed !== true || s === "gone"));
  check("exec_drafts_resolution", isNull(row.owner_resolution) || s === "sent" || s === "discarded");
  return bad;
}

const CONTENT_EMPTY: Row = Object.freeze({
  thread_subject: null, reply_candidates: null, thread_addresses: [], to_recipients: [], cc_recipients: [], bcc_recipients: [],
  subject: null, body_doc: null, body_html: null, body_text: null, instruction: null, note_for_mitchell: null, placeholders: [],
  review_recipients: null
});

const retentionOf = (tables: Record<string, Row[]>, principal: unknown): number => {
  const days = (tables.exec_settings ?? []).filter((s) => s.principal_id === principal).map((s) => s.retention_days_email)
    .filter((d): d is number => typeof d === "number");
  return days.length > 0 ? Math.max(...days) : 180;
};
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

/** exec_drafts_purge_restricted, on the fake's rows (the migration's SQL, line for line). Exported so fake-email-db shares it. */
export function purgeRestrictedRows(tables: Record<string, Row[]>, args: Row, now: Date): number {
  const principal = args.p_principal;
  if (isNull(principal)) throw Object.assign(new Error("exec_drafts_purge_restricted: p_principal is required"), { code: "P0001" });
  const ids = args.p_thread_ids;
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const days = retentionOf(tables, principal);
  const nowIso = now.toISOString();
  let n = 0;
  for (const d of tables[DRAFTS] ?? []) {
    if (d.principal_id !== principal || !ids.includes(d.thread_id) || d.restricted_purged === true) continue;
    const s = String(d.status);
    const ddOnlyOpen = isNull(d.outlook_graph_id) && ["generating", "generation_failed", "draft"].includes(s);
    const patch: Row = {
      status: ddOnlyOpen ? "discarded" : s === "generating" ? (d.prior_status ?? "draft") : s,
      terminal_at: ddOnlyOpen ? (d.terminal_at ?? nowIso) : d.terminal_at,
      expires_at: ddOnlyOpen ? (d.expires_at ?? addDays(nowIso, days)) : d.expires_at,
      next_check_at: ["generating", "generation_failed", "draft"].includes(s) ? null : d.next_check_at,
      prior_status: s === "discarding" ? d.prior_status : null,
      ...structuredClone(CONTENT_EMPTY),
      review_hash: null,
      review_at: null,
      review_blockers: [],
      restricted_purged: true,
      content_purged_at: d.content_purged_at ?? nowIso,
      version: Number(d.version) + 1,
      updated_at: nowIso
    };
    Object.assign(d, patch);
    n += 1;
  }
  return n;
}

/** exec_drafts_purge_expired, on the fake's rows (the migration's four steps, each limited). */
export function purgeExpiredRows(tables: Record<string, Row[]>, args: Row): Row {
  const pNow = args.p_now;
  if (typeof pNow !== "string" || !Number.isFinite(Date.parse(pNow))) throw Object.assign(new Error("exec_drafts_purge_expired: p_now is required"), { code: "P0001" });
  const limitArg = typeof args.p_limit === "number" ? args.p_limit : 1000;
  const limit = Math.min(Math.max(limitArg, 1), 5000);
  const nowMs = Date.parse(pNow);
  const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : Number.NaN);
  const rows = () => tables[DRAFTS] ?? [];
  const sortBy = (list: Row[], col: string) => [...list].sort((a, b) => ms(a[col]) - ms(b[col]));

  const content = sortBy(rows().filter((d) => !isNull(d.terminal_at) && isNull(d.content_purged_at) && ms(d.terminal_at) < nowMs - 30 * DAY_MS), "terminal_at").slice(0, limit);
  for (const d of content) Object.assign(d, structuredClone(CONTENT_EMPTY), { content_purged_at: pNow, updated_at: pNow });

  const doomed = sortBy(rows().filter((d) => !isNull(d.expires_at) && ms(d.expires_at) < nowMs && !isNull(d.terminal_at)), "expires_at").slice(0, limit);
  tables[DRAFTS] = rows().filter((d) => !doomed.includes(d));

  const idle = sortBy(rows().filter((d) => isNull(d.outlook_graph_id) && ["draft", "generation_failed"].includes(String(d.status)) && ms(d.updated_at) < nowMs - 30 * DAY_MS), "updated_at").slice(0, limit);
  for (const d of idle) {
    Object.assign(d, {
      status: "discarded",
      terminal_at: pNow,
      expires_at: addDays(pNow, retentionOf(tables, d.principal_id)),
      next_check_at: null,
      last_error_code: "expired_idle",
      last_error_at: pNow,
      version: Number(d.version) + 1,
      updated_at: pNow
    });
  }

  const checks = sortBy(rows().filter((d) =>
    !isNull(d.outlook_graph_id) && isNull(d.next_check_at) &&
    (["draft", "saved", "unknown"].includes(String(d.status)) || (d.status === "gone" && d.gone_unconfirmed === true)) &&
    ms(d.updated_at) < nowMs - 30 * DAY_MS), "updated_at").slice(0, limit);
  for (const d of checks) d.next_check_at = pNow;

  return { contentPurged: content.length, deleted: doomed.length, closedIdle: idle.length, checksScheduled: checks.length };
}

// ---------------------------------------------------------------------------
// Filters (SQL semantics)
// ---------------------------------------------------------------------------

function isTimeText(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));
}

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (isTimeText(a) && isTimeText(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && (typeof b === "number" || (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))))) return a - Number(b);
  if (typeof a === "boolean") return a === (b === true || b === "true") ? 0 : 1;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function test(row: Row, f: Filter): boolean {
  switch (f.op) {
    case "or":
      return f.terms.some((t) => test(row, t));
    case "and":
      return f.terms.every((t) => test(row, t));
    case "not": {
      if (f.inner.op === "is") return !test(row, f.inner);
      const inner = f.inner as Extract<Filter, { column: string }>;
      const v = row[inner.column];
      return v !== null && v !== undefined && !test(row, f.inner);
    }
    case "is": {
      const v = row[f.column];
      if (f.value === null || f.value === "null") return v === null || v === undefined;
      return v === (f.value === true || f.value === "true");
    }
    case "in": {
      const v = row[f.column];
      return v !== null && v !== undefined && f.values.some((x) => compare(v, x) === 0);
    }
    default: {
      const c = compare(row[f.column], f.value);
      if (c === null) return false;
      return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[f.op];
    }
  }
}

/** Split on commas outside parentheses and double quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function parseTerm(term: string): Filter {
  const t = term.trim();
  if (t.startsWith("and(") && t.endsWith(")")) return { op: "and", terms: splitTop(t.slice(4, -1)).map(parseTerm) };
  if (t.startsWith("or(") && t.endsWith(")")) return { op: "or", terms: splitTop(t.slice(3, -1)).map(parseTerm) };
  const m = /^([a-z_]+)\.(not\.)?(eq|neq|lt|lte|gt|gte|is|in)\.([\s\S]*)$/.exec(t);
  if (!m) throw new Error(`fake drafts db: unsupported or() term ${t}`);
  const [, column, negate, op, raw] = m;
  let f: Filter;
  if (op === "is") f = { op: "is", column, value: raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw };
  else if (op === "in") f = { op: "in", column, values: splitTop(raw.replace(/^\(|\)$/g, "")).map((v) => unquote(v.trim())) };
  else f = { op: op as "eq", column, value: unquote(raw) };
  return negate ? { op: "not", column, inner: f } : f;
}

function project(row: Row, columns: string, table: string): Row {
  if (columns.trim() === "*") return structuredClone(row);
  const out: Row = {};
  for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!(c in row)) throw Object.assign(new Error(`column ${table}.${c} does not exist`), { code: "42703" });
    out[c] = structuredClone(row[c]);
  }
  return out;
}

function sortRows(rows: Row[], orders: FakeRequest["orders"]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const x = a[column];
      const y = b[column];
      if ((x === null || x === undefined) && (y === null || y === undefined)) continue;
      if (x === null || x === undefined) return ascending ? 1 : -1;
      if (y === null || y === undefined) return ascending ? -1 : 1;
      const c = compare(x, y) ?? 0;
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export function createFakeDraftsDb(cfg: FakeDraftsDbConfig = {}): FakeDraftsDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(cfg.tables ?? {})) tables[name] = rows.map((r) => structuredClone(r));
  const fdb: FakeDraftsDb = { client: null, tables, requests: [], log: [], missing: new Set(cfg.missing ?? []) };
  const now = () => (cfg.now ? cfg.now() : new Date());
  const rowsOf = (t: string) => (tables[t] ??= []);

  const rpcs: Record<string, (args: Row) => unknown> = {
    exec_drafts_purge_restricted: (args) => purgeRestrictedRows(tables, args, now()),
    exec_drafts_purge_expired: (args) => purgeExpiredRows(tables, args)
  };

  /** The table's own refusals: CHECKs (23514) and the one-active index (23505), on the rows as they would be after the write. */
  function refuses(table: string, candidates: Row[], others: Row[]): DbError | null {
    if (table !== DRAFTS) return null;
    for (const c of candidates) {
      const bad = checkDraftRow(c);
      if (bad.length > 0) return { code: "23514", message: `new row for relation "exec_drafts" violates check constraint "${bad[0]}"` };
    }
    const all = [...others, ...candidates];
    for (const c of candidates) {
      if (isNull(c.thread_id) || !isActiveDraftRow(c)) continue;
      const twin = all.find((o) => o !== c && o.principal_id === c.principal_id && o.thread_id === c.thread_id && isActiveDraftRow(o));
      if (twin) {
        return {
          code: "23505",
          message: 'duplicate key value violates unique constraint "exec_drafts_one_active_per_thread"',
          details: `Key (principal_id, thread_id)=(${String(c.principal_id)}, ${String(c.thread_id)}) already exists.`
        };
      }
    }
    return null;
  }

  async function execute(r: FakeRequest): Promise<{ data: unknown; count: number | null; error: DbError | null }> {
    fdb.requests.push(r);
    fdb.log.push(`${r.kind} ${r.target}`);
    if (r.signal?.aborted) return { data: null, count: null, error: { message: "AbortError: This operation was aborted" } };
    await cfg.before?.(r, fdb);
    if (fdb.missing.has(r.target)) {
      return r.kind === "rpc"
        ? { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } }
        : { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${r.target}' in the schema cache` } };
    }
    const failed = cfg.fail?.(r);
    if (failed) return { data: null, count: null, error: failed };
    try {
      if (r.kind === "rpc") {
        const impl = rpcs[r.target];
        if (!impl) return { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } };
        return { data: structuredClone(impl(r.payload as Row)), count: null, error: null };
      }
      const table = rowsOf(r.target);
      let affected: Row[];
      if (r.kind === "insert" || r.kind === "upsert") {
        const payloads = (Array.isArray(r.payload) ? r.payload : [r.payload]) as Row[];
        const keys = String(r.options?.onConflict ?? "id").split(",").map((s) => s.trim());
        const created: Row[] = [];
        const updated: Row[] = [];
        for (const p of payloads) {
          const existing = r.kind === "upsert" ? table.find((row) => keys.every((k) => row[k] === p[k])) : undefined;
          if (existing) {
            if (!r.options?.ignoreDuplicates) updated.push(Object.assign(structuredClone(existing), structuredClone(p)));
          } else {
            const defaults = r.target === DRAFTS ? draftDefaults(now()) : {};
            created.push({ ...defaults, ...structuredClone(p) });
          }
        }
        if (r.kind === "insert" && r.target === DRAFTS) {
          for (const c of created) {
            if (table.some((row) => row.id === c.id)) return { data: null, count: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "exec_drafts_pkey"' } };
          }
        }
        const refusal = refuses(r.target, [...created, ...updated], table.filter((row) => !updated.some((u) => u.id === row.id)));
        if (refusal) return { data: null, count: null, error: refusal };
        for (const u of updated) {
          const target = table.find((row) => keys.every((k) => row[k] === u[k]));
          if (target) Object.assign(target, u);
        }
        table.push(...created);
        affected = [...updated.map((u) => table.find((row) => keys.every((k) => row[k] === u[k])) as Row), ...created];
      } else {
        affected = table.filter((row) => r.filters.every((f) => test(row, f)));
        if (r.kind === "update") {
          const next = affected.map((row) => Object.assign(structuredClone(row), structuredClone(r.payload as Row)));
          const refusal = refuses(r.target, next, table.filter((row) => !affected.includes(row)));
          if (refusal) return { data: null, count: null, error: refusal };
          affected.forEach((row, i) => Object.assign(row, next[i]));
        }
        if (r.kind === "delete") tables[r.target] = table.filter((row) => !affected.includes(row));
        if (r.kind === "select") {
          affected = sortRows(affected, r.orders);
          if (r.range) affected = affected.slice(r.range[0], r.range[1] + 1);
          if (r.limit !== null) affected = affected.slice(0, r.limit);
        }
      }
      const count = r.count === "exact" ? affected.length : null;
      if (r.head) return { data: null, count, error: null };
      if (r.columns === null) return { data: null, count, error: null };
      const out = affected.map((row) => project(row, r.columns as string, r.target));
      if (r.single === "single") {
        if (out.length !== 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        return { data: out[0], count, error: null };
      }
      if (r.single === "maybe") {
        if (out.length > 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        return { data: out[0] ?? null, count, error: null };
      }
      return { data: out, count, error: null };
    } catch (err) {
      const e = err as Error & { code?: string };
      return { data: null, count: null, error: { message: e.message, code: e.code } };
    }
  }

  function builder(r: FakeRequest) {
    const b = {
      select(columns: string, options?: { count?: string; head?: boolean }) {
        r.columns = columns;
        if (options?.count) r.count = options.count;
        if (options?.head) r.head = true;
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
      not(column: string, operator: string, value: unknown) {
        const inner = parseTerm(`${column}.${operator}.${String(value)}`);
        r.filters.push({ op: "not", column, inner });
        return b;
      },
      or(expr: string) {
        r.filters.push({ op: "or", terms: splitTop(expr).map(parseTerm) });
        return b;
      },
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
      then<A, B>(onFulfilled?: (v: { data: unknown; count: number | null; error: DbError | null }) => A, onRejected?: (e: unknown) => B) {
        return Promise.resolve()
          .then(() => execute(r))
          .then(onFulfilled, onRejected);
      }
    };
    return b;
  }

  const request = (kind: FakeRequest["kind"], target: string, payload: unknown = null, options: Record<string, unknown> | null = null): FakeRequest => ({
    kind,
    target,
    columns: null,
    filters: [],
    orders: [],
    range: null,
    limit: null,
    single: null,
    count: null,
    head: false,
    payload,
    options,
    signal: null
  });

  fdb.client = {
    from(table: string) {
      return {
        select: (columns: string, options?: { count?: string; head?: boolean }) => builder(request("select", table)).select(columns, options),
        insert: (rows: unknown) => builder(request("insert", table, rows, {})),
        upsert: (row: unknown, options?: Record<string, unknown>) => builder(request("upsert", table, row, options ?? {})),
        update: (patch: Row) => builder(request("update", table, patch)),
        delete: (options?: { count?: string }) => {
          const r = request("delete", table);
          r.count = options?.count ?? null;
          return builder(r);
        }
      };
    },
    rpc(fn: string, args: Row) {
      return builder(request("rpc", fn, args));
    }
  };
  return fdb;
}
