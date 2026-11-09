import "server-only";

import { DdReadError, type DdReadOptions } from "@/lib/exec/sources/dd";
import { clipForModel, DD_TEXT_ITEM_CHARS, normalizeWhitespace, sanitizeText } from "@/lib/exec/text/untrusted";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The only reader of DD free text (P5a contract §3.11.2, §0.3, S4, K29; Area
// D): comment, status-change, handoff and extension text from activity_logs,
// submitted EOD/SOD blockers (only while unedited since submission, K28), and
// meeting-brief risks. Importable only by triage/ddtext.ts,
// handlers/ddtext-triage.ts, projects-view.ts (listMeetingBriefRisks only) and,
// among agent/** files, agent/tools.ts alone (boundary rule 10, narrowed by
// P5b §3.20 item 1). P5b's chat reads (task descriptions, a task's timeline
// and legacy messages, submitted EOD/SOD text) are at the end of this file.
//
// The rules of sources/dd.ts hold: fail closed (an error throws DdReadError
// naming the table, never an empty list), bounded (pages of 1000 by a unique
// key, 50 pages at most, ids 200 to a filter), explicit columns, every query
// on the caller's signal. On top of them: text is sanitized (no invisible or
// bidi characters), whitespace-normalized and clipped to 1,500 characters
// here, so no caller ever holds more than that per item; and nothing here
// logs anything. Errors carry the table name and the database's message only.

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const IN_CHUNK = 200;
const MAX_SCAN_ROWS = 2000;
const MAX_CONTEXT_ROWS = 5;
// Earlier rows read to find MAX_CONTEXT_ROWS that carry text (most status changes carry none).
const CONTEXT_READ_ROWS = 20;
const MAX_MEETINGS = 5;
const MAX_RISKS = 5;
const RISK_CHARS = 280;
const EM_DASH_SEPARATOR = " \u{2014} ";

/** The four activity_logs actions whose detail carries free text (C28: a status change's note is a comment). */
export const DD_TEXT_ACTIONS = ["comment", "status_change", "handoff", "extended"] as const;
type DdTextAction = (typeof DD_TEXT_ACTIONS)[number];
/** The comment class: comments and status-change notes (§3.12.3). */
const COMMENT_CLASS_ACTIONS: readonly DdTextAction[] = ["comment", "status_change"];

export interface DdTextActivity {
  id: string;
  taskId: string;
  userId: string;
  action: "comment" | "status_change" | "handoff" | "extended";
  createdAt: string;
  mentionedUserIds: string[];
  /** The free-text part only: comment → detail; status_change/handoff → lines after the first; extended → after the first
   *  " — " (U+2014). Sanitized, whitespace-normalized, clipped to 1,500. "" when none. */
  text: string;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function from(table: string, columns: string) {
  return getSupabaseAdmin().from(table).select(columns);
}
type Query = ReturnType<typeof from>;

function requirePrincipal(principal: ExecPrincipal): void {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("sources/dd-text: an ExecPrincipal is required");
  }
}

async function run(table: string, query: Query, signal: AbortSignal | undefined): Promise<unknown[]> {
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw new DdReadError(table, error.message);
  if (!Array.isArray(data)) throw new DdReadError(table, "the response carried no rows");
  return data as unknown[];
}

/** Every row of a query, page by page, in a stable order. Throws past MAX_PAGES. */
async function pageAll(table: string, build: () => Query, orderBy: readonly string[], signal: AbortSignal | undefined): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = build();
    for (const column of orderBy) query = query.order(column, { ascending: true });
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    const data = await run(table, query, signal);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new DdReadError(table, `too many rows (more than ${MAX_PAGES * PAGE_SIZE})`);
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
}

function chunked<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// A timestamp as PostgREST printed it ("2026-11-04T12:00:00.123456+00:00"), kept
// exactly (microseconds included) so a keyset position never skips or repeats a
// row; anything else is canonicalized through Date.parse. Either way it is safe
// inside an or() term.
const RAW_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function timestampParam(name: string, value: string): string {
  if (typeof value === "string" && RAW_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value.replace(" ", "T")))) return value;
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`sources/dd-text: ${name} must be an ISO timestamp`);
  return new Date(ms).toISOString();
}

// Row ids go into an or() term in double quotes: no quote, backslash, comma,
// parenthesis or whitespace can be in one.
const SAFE_ID = /^[A-Za-z0-9_.:@-]{1,200}$/;

function idParam(name: string, value: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new TypeError(`sources/dd-text: ${name} is not a row id`);
  return value;
}

/** Sanitized, whitespace-normalized, clipped to DD_TEXT_ITEM_CHARS. "" for nothing. */
function cleanText(raw: string): string {
  const text = normalizeWhitespace(sanitizeText(raw));
  return text === "" ? "" : clipForModel(text, DD_TEXT_ITEM_CHARS).text;
}

/** The free-text part of an activity row's detail, by action (§3.11.2); the rest never leaves this function. */
function freeText(action: DdTextAction, detail: unknown): string {
  if (typeof detail !== "string" || detail === "") return "";
  switch (action) {
    case "comment":
      return cleanText(detail);
    case "status_change":
    case "handoff": {
      // "{from} → {to}" (or "{from name} → {to name}") on the first line; a note, if any, after it.
      const lines = detail.replace(/\r\n?/g, "\n").split("\n");
      return cleanText(lines.slice(1).join("\n"));
    }
    case "extended": {
      // "+{h}h — {reason}" (api/tasks/[id]/extend).
      const at = detail.indexOf(EM_DASH_SEPARATOR);
      return at < 0 ? "" : cleanText(detail.slice(at + EM_DASH_SEPARATOR.length));
    }
  }
}

// ---------------------------------------------------------------------------
// activity_logs
// ---------------------------------------------------------------------------

const ACTIVITY_COLS = "id,task_id,user_id,action,detail,created_at,mentioned_user_ids";

function isDdTextAction(v: unknown): v is DdTextAction {
  return typeof v === "string" && (DD_TEXT_ACTIONS as readonly string[]).includes(v);
}

function activityFrom(raw: unknown): DdTextActivity {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.task_id !== "string" || typeof r.user_id !== "string" || typeof r.created_at !== "string" || !isDdTextAction(r.action)) {
    throw new DdReadError("activity_logs", "a row is malformed");
  }
  const mentioned = Array.isArray(r.mentioned_user_ids) ? r.mentioned_user_ids.filter((x): x is string => typeof x === "string") : [];
  return {
    id: r.id,
    taskId: r.task_id,
    userId: r.user_id,
    action: r.action,
    createdAt: r.created_at,
    mentionedUserIds: mentioned,
    text: freeText(r.action, r.detail)
  };
}

/**
 * activity_logs rows (id, task_id, user_id, action, detail, created_at,
 * mentioned_user_ids) with action in the four and created_at >= sinceIso, in
 * (created_at, id) order after `after` (a keyset position, exact to the
 * microsecond); at most maxRows (1..2000). hasMore: rows remain past the last
 * one returned. With no created_at index this is a sequential scan of the
 * window (20261106100500_optional_activity_logs_created_at_idx.sql helps).
 */
export async function listActivityTextSince(
  principal: ExecPrincipal,
  sinceIso: string,
  opts: { after: { at: string; id: string } | null; maxRows: number; signal?: AbortSignal }
): Promise<{ rows: DdTextActivity[]; hasMore: boolean }> {
  requirePrincipal(principal);
  const since = timestampParam("sinceIso", sinceIso);
  const maxRows = opts.maxRows;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_SCAN_ROWS) throw new TypeError(`sources/dd-text: maxRows must be 1-${MAX_SCAN_ROWS}`);
  let after = opts.after === null ? null : { at: timestampParam("after.at", opts.after.at), id: idParam("after.id", opts.after.id) };
  const rows: DdTextActivity[] = [];
  // One row past maxRows says whether there is more.
  const want = maxRows + 1;
  while (rows.length < want) {
    const limit = Math.min(PAGE_SIZE, want - rows.length);
    let query = from("activity_logs", ACTIVITY_COLS).in("action", [...DD_TEXT_ACTIONS]).gte("created_at", since);
    if (after) query = query.or(`created_at.gt."${after.at}",and(created_at.eq."${after.at}",id.gt."${after.id}")`);
    query = query.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
    const page = (await run("activity_logs", query, opts.signal)).map(activityFrom);
    rows.push(...page);
    if (page.length < limit) break;
    const last = page[page.length - 1];
    after = { at: timestampParam("created_at", last.createdAt), id: idParam("id", last.id) };
  }
  const hasMore = rows.length > maxRows;
  return { rows: hasMore ? rows.slice(0, maxRows) : rows, hasMore };
}

/** These activity_logs rows (the four actions only), in (created_at, id) order. A missing id is absent. */
export async function listActivityTextByIds(principal: ExecPrincipal, ids: readonly string[], opts: DdReadOptions = {}): Promise<DdTextActivity[]> {
  requirePrincipal(principal);
  const out: DdTextActivity[] = [];
  for (const chunk of chunked(uniqueIds(ids))) {
    const rows = await pageAll(
      "activity_logs",
      () => from("activity_logs", ACTIVITY_COLS).in("id", chunk).in("action", [...DD_TEXT_ACTIONS]),
      ["id"],
      opts.signal
    );
    out.push(...rows.map(activityFrom));
  }
  return out.sort((a, b) => cmpTime(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function cmpTime(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (x !== y) return (Number.isFinite(x) ? x : 0) - (Number.isFinite(y) ? y : 0);
  // Same millisecond: the raw strings carry the microseconds.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Up to `limit` (≤5) earlier comment-class rows (comments and status-change
 * notes) of one task before beforeIso that carry text, newest first, through
 * activity_logs' task_id index. Read-only context for a triage batch.
 */
export async function listEarlierCommentText(
  principal: ExecPrincipal,
  taskId: string,
  beforeIso: string,
  limit: number,
  opts: DdReadOptions = {}
): Promise<DdTextActivity[]> {
  requirePrincipal(principal);
  if (typeof taskId !== "string" || taskId.length === 0) throw new TypeError("sources/dd-text: taskId is required");
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CONTEXT_ROWS) throw new TypeError(`sources/dd-text: limit must be 0-${MAX_CONTEXT_ROWS}`);
  if (limit === 0) return [];
  const before = timestampParam("beforeIso", beforeIso);
  const query = from("activity_logs", ACTIVITY_COLS)
    .eq("task_id", taskId)
    .in("action", [...COMMENT_CLASS_ACTIONS])
    .lt("created_at", before)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(CONTEXT_READ_ROWS);
  const rows = (await run("activity_logs", query, opts.signal)).map(activityFrom);
  return rows.filter((r) => r.text !== "").slice(0, limit);
}

// ---------------------------------------------------------------------------
// EOD / SOD blockers
// ---------------------------------------------------------------------------

export interface DdNoteBlockers {
  id: string;
  kind: "eod" | "sod";
  userId: string;
  noteDate: string;
  submittedAt: string;
  updatedAt: string;
  /** the `blockers` column (EOD's "blockers"/"help" prompt in every flow; SOD's), sanitized, clipped */
  text: string;
}

/**
 * K28 (a-correct-9): the stored text is the submitted text only while
 * updated_at <= submitted_at (Date.parse; DD writes both from one ms-precision
 * `now`, §0.3). Unsubmitted or unreadable: false. Exported for P5b's note
 * reads, which must apply it too.
 */
export function submittedTextIsCurrent(n: { submittedAt: string | null; updatedAt: string }): boolean {
  if (!n || typeof n.submittedAt !== "string" || typeof n.updatedAt !== "string") return false;
  const submitted = Date.parse(n.submittedAt);
  const updated = Date.parse(n.updatedAt);
  return Number.isFinite(submitted) && Number.isFinite(updated) && updated <= submitted;
}

const NOTE_TABLES = { eod: "eod_notes", sod: "sod_notes" } as const;
const NOTE_COLS = "id,user_id,note_date,submitted_at,updated_at,blockers";

function noteTable(kind: "eod" | "sod"): "eod_notes" | "sod_notes" {
  if (kind !== "eod" && kind !== "sod") throw new TypeError("sources/dd-text: kind must be eod or sod");
  return NOTE_TABLES[kind];
}

/** Splits note rows: unedited since submission → rows (text read); edited after it (or unsubmitted) → ids only. */
function splitNotes(kind: "eod" | "sod", table: string, raw: readonly unknown[]): { rows: DdNoteBlockers[]; editedAfterSubmit: string[] } {
  const rows: DdNoteBlockers[] = [];
  const editedAfterSubmit: string[] = [];
  for (const x of raw) {
    const r = (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.user_id !== "string" || typeof r.note_date !== "string" || typeof r.updated_at !== "string") {
      throw new DdReadError(table, "a row is malformed");
    }
    const submittedAt = typeof r.submitted_at === "string" ? r.submitted_at : null;
    if (submittedAt === null || !submittedTextIsCurrent({ submittedAt, updatedAt: r.updated_at })) {
      // Its text is not the submitted text (or there is none): never returned.
      editedAfterSubmit.push(r.id);
      continue;
    }
    rows.push({
      id: r.id,
      kind,
      userId: r.user_id,
      noteDate: r.note_date,
      submittedAt,
      updatedAt: r.updated_at,
      text: typeof r.blockers === "string" ? cleanText(r.blockers) : ""
    });
  }
  return { rows, editedAfterSubmit };
}

/**
 * Submitted notes with submitted_at > sinceIso (eod_notes_submitted_at_idx /
 * sod_notes_submitted_idx), in (submitted_at, id) order; only id, user_id,
 * note_date, submitted_at, updated_at, blockers. Notes edited after
 * submission are left out of `rows` (their text is never returned) and
 * listed by id in `editedAfterSubmit`.
 */
export async function listSubmittedNoteBlockersSince(
  principal: ExecPrincipal,
  kind: "eod" | "sod",
  sinceIso: string,
  opts: DdReadOptions = {}
): Promise<{ rows: DdNoteBlockers[]; editedAfterSubmit: string[] }> {
  requirePrincipal(principal);
  const table = noteTable(kind);
  const since = timestampParam("sinceIso", sinceIso);
  const raw = await pageAll(table, () => from(table, NOTE_COLS).not("submitted_at", "is", null).gt("submitted_at", since), ["submitted_at", "id"], opts.signal);
  return splitNotes(kind, table, raw);
}

/** These notes by id, split as listSubmittedNoteBlockersSince does. A missing id is in neither list. */
export async function listNoteBlockersByIds(
  principal: ExecPrincipal,
  kind: "eod" | "sod",
  ids: readonly string[],
  opts: DdReadOptions = {}
): Promise<{ rows: DdNoteBlockers[]; editedAfterSubmit: string[] }> {
  requirePrincipal(principal);
  const table = noteTable(kind);
  const raw: unknown[] = [];
  for (const chunk of chunked(uniqueIds(ids))) raw.push(...(await pageAll(table, () => from(table, NOTE_COLS).in("id", chunk), ["id"], opts.signal)));
  return splitNotes(kind, table, raw);
}

// ---------------------------------------------------------------------------
// Meeting-brief risks (K26)
// ---------------------------------------------------------------------------

const MEETING_COLS = "id,client_id,title,meeting_date,risks:brief->risks";

interface MeetingRisks {
  meetingId: string;
  clientId: string;
  title: string;
  meetingAt: string;
  risks: string[];
  matchedBy: "client" | "task";
}

function meetingFrom(raw: unknown, matchedBy: "client" | "task"): MeetingRisks {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.client_id !== "string" || typeof r.meeting_date !== "string") {
    throw new DdReadError("client_meetings", "a row is malformed");
  }
  const risks: string[] = [];
  for (const x of Array.isArray(r.risks) ? r.risks : []) {
    if (risks.length >= MAX_RISKS) break;
    if (typeof x !== "string") continue;
    const one = clipForModel(normalizeWhitespace(sanitizeText(x)).replace(/\s+/g, " ").trim(), RISK_CHARS).text;
    if (one !== "") risks.push(one);
  }
  const title = typeof r.title === "string" ? clipForModel(normalizeWhitespace(sanitizeText(r.title)).replace(/\s+/g, " ").trim(), RISK_CHARS).text : "";
  return { meetingId: r.id, clientId: r.client_id, title, meetingAt: r.meeting_date, risks, matchedBy };
}

/**
 * K26 (a-correct-4). Meetings of q.clientId with meeting_date >= q.sinceIso
 * (client_meetings_client_id_idx (client_id, meeting_date desc)), plus
 * meetings whose task_ids overlap (`ov`) q.taskIds (kept as an extra match; on
 * today's data it finds none, K26); deduped by id (a client match wins),
 * newest first, at most q.limit (≤5). Columns: id, client_id, title,
 * meeting_date, risks:brief->risks only (never transcript or summary); each
 * risk sanitized, one line, clipped to 280, at most 5 per meeting.
 */
export async function listMeetingBriefRisks(
  principal: ExecPrincipal,
  q: { clientId: string; taskIds: readonly string[]; sinceIso: string; limit: number },
  opts: DdReadOptions = {}
): Promise<{ meetingId: string; clientId: string; title: string; meetingAt: string; risks: string[]; matchedBy: "client" | "task" }[]> {
  requirePrincipal(principal);
  if (typeof q.clientId !== "string" || q.clientId.length === 0) throw new TypeError("sources/dd-text: clientId is required");
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > MAX_MEETINGS) throw new TypeError(`sources/dd-text: limit must be 1-${MAX_MEETINGS}`);
  const since = timestampParam("sinceIso", q.sinceIso);
  const byId = new Map<string, MeetingRisks>();
  const clientRows = await run(
    "client_meetings",
    from("client_meetings", MEETING_COLS)
      .eq("client_id", q.clientId)
      .gte("meeting_date", since)
      .order("meeting_date", { ascending: false })
      .order("id", { ascending: false })
      .limit(q.limit),
    opts.signal
  );
  for (const row of clientRows) {
    const m = meetingFrom(row, "client");
    byId.set(m.meetingId, m);
  }
  for (const chunk of chunked(uniqueIds(q.taskIds))) {
    const rows = await run(
      "client_meetings",
      from("client_meetings", MEETING_COLS)
        .overlaps("task_ids", chunk)
        .order("meeting_date", { ascending: false })
        .order("id", { ascending: false })
        .limit(q.limit),
      opts.signal
    );
    for (const row of rows) {
      const m = meetingFrom(row, "task");
      if (!byId.has(m.meetingId)) byId.set(m.meetingId, m);
    }
  }
  return [...byId.values()]
    .sort((a, b) => cmpTime(b.meetingAt, a.meetingAt) || (a.meetingId < b.meetingId ? 1 : a.meetingId > b.meetingId ? -1 : 0))
    .slice(0, q.limit);
}

// ---------------------------------------------------------------------------
// P5b's chat reads (P5b contract §3.7; Area B). Same rules as above: explicit
// columns, the caller's signal, bounded, DdReadError naming the table, text
// sanitized and clipped here, nothing logged. Never hosting_access,
// staging_server, client_email, custom, missive_thread_url, transcript, a
// token column, task_handoffs.reason or task_extensions.reason: handoff and
// extension text comes from their activity_logs rows through the parse above.
// ---------------------------------------------------------------------------

const MAX_DESCRIPTION_IDS = 50;
const MAX_TIMELINE_ROWS = 60;
const MAX_TASK_MESSAGES = 20;
const MAX_NOTE_PAIRS = 200;
const ARROW = "\u{2192}";
// P5a's STATUS_TRANSITION rule (sources/dd.ts): "{from} → {to}" on the first line.
const STATUS_TRANSITION_LINE = new RegExp(`^\\s*([a-z_]+)\\s*${ARROW}\\s*([a-z_]+)`);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** tasks.description for these ids (≤ 50 per call), any state. No other text column. A missing id is absent. */
export async function getTaskDescriptions(principal: ExecPrincipal, taskIds: readonly string[], opts: DdReadOptions = {}): Promise<Map<string, string | null>> {
  requirePrincipal(principal);
  const ids = uniqueIds(taskIds);
  if (ids.length > MAX_DESCRIPTION_IDS) throw new TypeError(`sources/dd-text: at most ${MAX_DESCRIPTION_IDS} task ids`);
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const rows = await run("tasks", from("tasks", "id,description").in("id", ids).limit(MAX_DESCRIPTION_IDS), opts.signal);
  for (const raw of rows) {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof r.id !== "string") throw new DdReadError("tasks", "a row is malformed");
    const text = typeof r.description === "string" ? cleanText(r.description) : "";
    out.set(r.id, text === "" ? null : text);
  }
  return out;
}

export type TimelineTextEntry =
  /** comment → detail; status_change → the note after its first line (C26, coherence-13; P5a C28); handoff → the lines
   *  after the first; extended → the reason after the first " — ". P5a's DdTextActivity parse, sanitized, ≤ 1,500. */
  | { kind: "comment" | "status_change" | "handoff" | "extended"; id: string; userId: string; at: string; text: string;
      /** status_change only: the first line parsed (P5a's STATUS_TRANSITION rule), else null. */
      from: string | null; to: string | null }
  /** Every other action: its name only, never its detail. */
  | { kind: "action"; id: string; userId: string; at: string; action: string };

const TIMELINE_COLS = "id,task_id,user_id,action,detail,created_at";
const ACTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** One task's activity_logs rows (activity_logs task_id index), newest first, ≤ 60. */
export async function listTaskTimelineText(principal: ExecPrincipal, taskId: string, opts: DdReadOptions = {}): Promise<TimelineTextEntry[]> {
  requirePrincipal(principal);
  if (typeof taskId !== "string" || taskId.length === 0) throw new TypeError("sources/dd-text: taskId is required");
  const rows = await run(
    "activity_logs",
    from("activity_logs", TIMELINE_COLS)
      .eq("task_id", taskId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_TIMELINE_ROWS),
    opts.signal
  );
  return rows.map((raw): TimelineTextEntry => {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.user_id !== "string" || typeof r.created_at !== "string" || typeof r.action !== "string") {
      throw new DdReadError("activity_logs", "a row is malformed");
    }
    if (isDdTextAction(r.action)) {
      let fromStatus: string | null = null;
      let toStatus: string | null = null;
      if (r.action === "status_change" && typeof r.detail === "string") {
        const match = STATUS_TRANSITION_LINE.exec(r.detail.split("\n", 1)[0]);
        if (match) {
          fromStatus = match[1];
          toStatus = match[2];
        }
      }
      return { kind: r.action, id: r.id, userId: r.user_id, at: r.created_at, text: freeText(r.action, r.detail), from: fromStatus, to: toStatus };
    }
    // Every other action is its name, never its detail.
    return { kind: "action", id: r.id, userId: r.user_id, at: r.created_at, action: ACTION_NAME.test(r.action) ? r.action : "other" };
  });
}

/** task_messages (id, user_id, body, created_at) of one task, newest first, ≤ 20. Legacy: no writer today (TP). */
export async function listTaskMessagesText(
  principal: ExecPrincipal,
  taskId: string,
  opts: DdReadOptions = {}
): Promise<{ id: string; userId: string | null; at: string; text: string }[]> {
  requirePrincipal(principal);
  if (typeof taskId !== "string" || taskId.length === 0) throw new TypeError("sources/dd-text: taskId is required");
  const rows = await run(
    "task_messages",
    from("task_messages", "id,user_id,body,created_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_TASK_MESSAGES),
    opts.signal
  );
  return rows.map((raw) => {
    const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.created_at !== "string") throw new DdReadError("task_messages", "a row is malformed");
    return { id: r.id, userId: typeof r.user_id === "string" ? r.user_id : null, at: r.created_at, text: typeof r.body === "string" ? cleanText(r.body) : "" };
  });
}

export interface SubmittedNoteText {
  kind: "eod" | "sod"; id: string; userId: string; noteDate: string; submittedAt: string; reviewedAt: string | null;
  /** C52 (a-correct-9): !submittedTextIsCurrent({ submittedAt, updatedAt }). Then `fields` is empty: the text is never returned. */
  editedAfterSubmit: boolean;
  /** In display order, non-empty fields only. EOD: Worked on, Accomplished, Plan for tomorrow, Blockers, Notes, Ideas,
   *  Left off at, Leads messaged, LinkedIn comments. SOD: Top priority, Tasks planned, Blockers. */
  fields: { label: string; text: string }[];
}

const EOD_TEXT_FIELDS: readonly [string, string][] = [
  ["worked_on", "Worked on"],
  ["accomplished", "Accomplished"],
  ["plan_tomorrow", "Plan for tomorrow"],
  ["blockers", "Blockers"],
  ["note", "Notes"],
  ["ideas", "Ideas"],
  ["left_where_off", "Left off at"],
  ["leads_messaged", "Leads messaged"],
  ["linkedin_comments", "LinkedIn comments"]
];
const SOD_TEXT_FIELDS: readonly [string, string][] = [
  ["top_priority", "Top priority"],
  ["tasks_planned", "Tasks planned"],
  ["blockers", "Blockers"]
];
const EOD_TEXT_COLS =
  "id,user_id,note_date,submitted_at,reviewed_at,updated_at,worked_on,accomplished,plan_tomorrow,blockers,note,ideas,left_where_off,leads_messaged,linkedin_comments";
const SOD_TEXT_COLS = "id,user_id,note_date,submitted_at,updated_at,top_priority,tasks_planned,blockers";

function noteTextFrom(kind: "eod" | "sod", table: string, raw: unknown): SubmittedNoteText {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.user_id !== "string" ||
    typeof r.note_date !== "string" ||
    typeof r.submitted_at !== "string" ||
    typeof r.updated_at !== "string"
  ) {
    throw new DdReadError(table, "a row is malformed");
  }
  const editedAfterSubmit = !submittedTextIsCurrent({ submittedAt: r.submitted_at, updatedAt: r.updated_at });
  const fields: { label: string; text: string }[] = [];
  if (!editedAfterSubmit) {
    for (const [column, label] of kind === "eod" ? EOD_TEXT_FIELDS : SOD_TEXT_FIELDS) {
      const text = typeof r[column] === "string" ? cleanText(r[column] as string) : "";
      if (text !== "") fields.push({ label, text });
    }
  }
  return {
    kind,
    id: r.id,
    userId: r.user_id,
    noteDate: r.note_date,
    submittedAt: r.submitted_at,
    reviewedAt: kind === "eod" && typeof r.reviewed_at === "string" ? r.reviewed_at : null,
    editedAfterSubmit,
    fields
  };
}

/** Submitted notes only (submitted_at is not null), selecting updated_at with the text columns. EOD: one ET date,
 *  optionally one user (eod_notes_date_idx). SOD: (user, the user's own local date) pairs, ≤ 200. */
export async function listSubmittedNotesText(
  principal: ExecPrincipal,
  q: { kind: "eod"; noteDate: string; userId: string | null } | { kind: "sod"; pairs: readonly { userId: string; noteDate: string }[] },
  opts: DdReadOptions = {}
): Promise<SubmittedNoteText[]> {
  requirePrincipal(principal);
  if (q.kind === "eod") {
    if (typeof q.noteDate !== "string" || !YMD.test(q.noteDate)) throw new TypeError("sources/dd-text: noteDate must be YYYY-MM-DD");
    const userId = q.userId;
    if (userId !== null && (typeof userId !== "string" || userId.length === 0)) throw new TypeError("sources/dd-text: userId must be an id or null");
    const raw = await pageAll(
      "eod_notes",
      () => {
        const base = from("eod_notes", EOD_TEXT_COLS).eq("note_date", q.noteDate).not("submitted_at", "is", null);
        return userId === null ? base : base.eq("user_id", userId);
      },
      ["id"],
      opts.signal
    );
    return raw.map((row) => noteTextFrom("eod", "eod_notes", row));
  }
  if (q.kind !== "sod") throw new TypeError("sources/dd-text: kind must be eod or sod");
  const pairs = q.pairs.filter((p) => p && typeof p.userId === "string" && p.userId.length > 0 && typeof p.noteDate === "string" && YMD.test(p.noteDate));
  if (pairs.length > MAX_NOTE_PAIRS) throw new TypeError(`sources/dd-text: at most ${MAX_NOTE_PAIRS} (user, date) pairs`);
  const wanted = new Set(pairs.map((p) => `${p.userId}|${p.noteDate}`));
  const byDate = new Map<string, string[]>();
  for (const p of pairs) byDate.set(p.noteDate, [...new Set([...(byDate.get(p.noteDate) ?? []), p.userId])]);
  const out: SubmittedNoteText[] = [];
  for (const [noteDate, users] of [...byDate].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const chunk of chunked(users)) {
      const raw = await pageAll(
        "sod_notes",
        () => from("sod_notes", SOD_TEXT_COLS).eq("note_date", noteDate).in("user_id", chunk).not("submitted_at", "is", null),
        ["id"],
        opts.signal
      );
      for (const row of raw) {
        const note = noteTextFrom("sod", "sod_notes", row);
        if (wanted.has(`${note.userId}|${note.noteDate}`)) out.push(note);
      }
    }
  }
  return out;
}

/** P7b: the eod_client_work columns the team-work slot reads (never user_id: no author reaches a draft, C11). */
const CLIENT_WORK_COLS = "id,note_date,worked_on,results,reported_to_client_at";
const CLIENT_WORK_MAX = 50;

/** A Supabase error's own code (never its message: a message may quote a value). */
function codeOnly(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? code : "error";
}

/**
 * P7b (§3.13; Area E; P5a's one DD text reader, S4; B-P7b-5): a client's eod_client_work entries for the client-update
 * draft's team-work slot. Columns id, note_date, worked_on, results, reported_to_client_at; never user_id. client_id =
 * clientId OR client_name = clientName (two reads merged by id: a name can't go into an or() term safely);
 * note_date >= sinceDate; entries the team discarded in DD (dismissed_at set) are left out; newest first (note_date,
 * then id); at most `limit` (1..50). Text is sanitized, whitespace-normalized and clipped to 1,500 like every text
 * here; an empty results reads null. A failed read throws DdReadError naming the table and the database's code.
 */
export async function listEodClientWorkForClient(principal: ExecPrincipal, q: { clientId: string; clientName: string; sinceDate: string; limit: number },
  opts: DdReadOptions = {}): Promise<{ id: string; noteDate: string; workedOn: string; results: string | null; reportedToClientAt: string | null }[]> {
  requirePrincipal(principal);
  if (typeof q?.sinceDate !== "string" || !YMD.test(q.sinceDate) || new Date(Date.parse(`${q.sinceDate}T00:00:00Z`)).toISOString().slice(0, 10) !== q.sinceDate) {
    throw new TypeError("sources/dd-text: sinceDate must be YYYY-MM-DD");
  }
  const limit = Number.isSafeInteger(q.limit) ? Math.min(Math.max(q.limit, 1), CLIENT_WORK_MAX) : 6;
  const clientId = typeof q.clientId === "string" ? q.clientId.trim() : "";
  const clientName = typeof q.clientName === "string" ? q.clientName : "";
  const reads: { column: "client_id" | "client_name"; value: string }[] = [];
  if (clientId !== "") reads.push({ column: "client_id", value: clientId });
  if (clientName.trim() !== "") reads.push({ column: "client_name", value: clientName });
  const byId = new Map<string, { id: string; noteDate: string; workedOn: string; results: string | null; reportedToClientAt: string | null }>();
  for (const r of reads) {
    let query = from("eod_client_work", CLIENT_WORK_COLS)
      .eq(r.column, r.value)
      .gte("note_date", q.sinceDate)
      .is("dismissed_at", null)
      .order("note_date", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) throw new DdReadError("eod_client_work", codeOnly(error));
    if (!Array.isArray(data)) throw new DdReadError("eod_client_work", "the response carried no rows");
    for (const raw of data as unknown[]) {
      const row = raw as { id?: unknown; note_date?: unknown; worked_on?: unknown; results?: unknown; reported_to_client_at?: unknown };
      if (typeof row.id !== "string" || row.id.length === 0 || typeof row.note_date !== "string") continue;
      const noteDate = row.note_date.slice(0, 10);
      if (!YMD.test(noteDate)) continue;
      const clean = (v: unknown) => clipForModel(normalizeWhitespace(sanitizeText(typeof v === "string" ? v : ""))).text;
      const results = clean(row.results);
      const reported = typeof row.reported_to_client_at === "string" && Number.isFinite(Date.parse(row.reported_to_client_at))
        ? new Date(Date.parse(row.reported_to_client_at)).toISOString()
        : null;
      byId.set(row.id, { id: row.id, noteDate, workedOn: clean(row.worked_on), results: results === "" ? null : results, reportedToClientAt: reported });
    }
  }
  return [...byId.values()]
    .sort((a, b) => (a.noteDate < b.noteDate ? 1 : a.noteDate > b.noteDate ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, limit);
}
