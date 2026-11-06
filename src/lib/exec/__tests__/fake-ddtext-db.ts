// Test support for P5a's DD text triage (Area D): one in-memory stand-in for
// the service-role Supabase client behind sources/dd-text.ts, ddtext-store.ts
// and the exec_attention_items deletes they make, with P2b's
// fake-attention-db.ts serving every other exec_attention_items request
// (select / upsert / update, so syncAttention runs for real).
//
//   DD tables (rows as PostgREST returns them): activity_logs, eod_notes,
//   sod_notes, client_meetings; tasks and users as id sets (the FK targets).
//   exec_ddtext_items / exec_ddtext_signals: select, delete({ count }).
//   rpc("exec_ddtext_replace_item"): the migration's function in TypeScript:
//   FK targets checked first ("source_gone", nothing written), then the item
//   and signal CHECKs (a 23514 error, nothing written), then the item upsert
//   and the signal replacement, all or nothing.
//   Cascades: deleting a DD row (or a user, task or note) removes the items
//   that point at it and their signals, as the typed FKs do.
//
// Filters: eq, neq, in, gt, gte, lt, lte, not(col, "is", null), overlaps, and
// or() with the keyset form `a.gt."x",and(a.eq."x",b.gt."y")` (values may be
// double-quoted). Timestamps compare as instants to the microsecond. A select
// item may be aliased and may read a JSON path (`risks:brief->risks`).
// Every request is recorded; `fail` injects an error; `installed = false`
// makes the ddtext tables and the RPC answer 42P01 / 42883.

import { createFakeAttentionDb, type FakeAttentionDb } from "./fake-attention-db";

export type Row = Record<string, unknown>;
type Cmp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
type Filter =
  | { kind: Cmp; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "notnull"; column: string }
  | { kind: "overlaps"; column: string; values: unknown[] }
  | { kind: "or"; expr: string };

export interface DdtextCall {
  table: string;
  op: "select" | "delete" | "rpc";
  columns: string | null;
  filters: Filter[];
  orders: { column: string; ascending: boolean }[];
  range: [number, number] | null;
  limit: number | null;
  count: string | null;
  args: Row | null;
  signal: AbortSignal | null;
}

type Reply = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

export interface FakeDdtextDb {
  client: unknown;
  attention: FakeAttentionDb;
  activity: Row[];
  eod: Row[];
  sod: Row[];
  meetings: Row[];
  taskIds: Set<string>;
  userIds: Set<string>;
  items: Row[];
  signals: Row[];
  calls: DdtextCall[];
  installed: boolean;
  fail: (call: DdtextCall) => { message: string; code?: string } | null;
  /** Runs just before a request executes. */
  before: (call: DdtextCall) => void;
  callsTo(table: string, op?: DdtextCall["op"]): DdtextCall[];
  /** Delete a DD row the way DD would, with the FK cascades onto the ddtext items. */
  deleteActivity(id: string): void;
  deleteNote(kind: "eod" | "sod", id: string): void;
  deleteTask(id: string): void;
  deleteUser(id: string): void;
}

const TIMESTAMP_COLUMNS = new Set([
  "created_at",
  "submitted_at",
  "updated_at",
  "meeting_date",
  "source_created_at",
  "expires_at",
  "triaged_at",
  "occurred_at"
]);
const DDTEXT_TABLES = new Set(["exec_ddtext_items", "exec_ddtext_signals"]);

/** An instant in microseconds, or null when the value isn't a timestamp. */
export function instantMicros(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v.replace(" ", "T"));
  if (!Number.isFinite(ms)) return null;
  const frac = /\.(\d+)/.exec(v);
  const micros = frac ? Number((frac[1] + "000000").slice(3, 6)) : 0;
  return ms * 1000 + micros;
}

function compare(column: string, a: unknown, b: unknown): number {
  if (TIMESTAMP_COLUMNS.has(column)) {
    const x = instantMicros(a);
    const y = instantMicros(b);
    if (x !== null && y !== null) return x - y;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function unquote(v: string): string {
  return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;
}

/** Split on top-level commas (outside parentheses and quotes). */
function splitTerms(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      cur += c;
      if (c === "\\") {
        cur += s[i + 1] ?? "";
        i += 1;
      } else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur !== "") out.push(cur);
  return out;
}

function termMatches(row: Row, term: string): boolean {
  const t = term.trim();
  const group = /^(and|or)\((.*)\)$/s.exec(t);
  if (group) {
    const parts = splitTerms(group[2]);
    return group[1] === "and" ? parts.every((p) => termMatches(row, p)) : parts.some((p) => termMatches(row, p));
  }
  const m = /^([a-z_]+)\.(eq|neq|gt|gte|lt|lte)\.(.*)$/s.exec(t);
  if (!m) throw new Error(`fake-ddtext-db: unsupported or() term ${t}`);
  return cmpMatches(row, m[2] as Cmp, m[1], unquote(m[3]));
}

function cmpMatches(row: Row, kind: Cmp, column: string, value: unknown): boolean {
  const cell = row[column];
  if (cell === null || cell === undefined || value === null || value === undefined) return false;
  const c = compare(column, cell, value);
  switch (kind) {
    case "eq":
      return c === 0;
    case "neq":
      return c !== 0;
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
  }
}

function matches(row: Row, f: Filter): boolean {
  switch (f.kind) {
    case "in":
      return row[f.column] !== null && row[f.column] !== undefined && f.values.some((v) => String(v) === String(row[f.column]));
    case "notnull":
      return row[f.column] !== null && row[f.column] !== undefined;
    case "overlaps":
      return Array.isArray(row[f.column]) && (row[f.column] as unknown[]).some((x) => f.values.some((v) => String(v) === String(x)));
    case "or":
      return splitTerms(f.expr).some((t) => termMatches(row, t));
    default:
      return cmpMatches(row, f.kind, f.column, f.value);
  }
}

function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const raw of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
    const colon = raw.indexOf(":");
    const alias = colon > 0 ? raw.slice(0, colon) : null;
    const ref = alias ? raw.slice(colon + 1) : raw;
    const path = ref.split(/->>|->/);
    if (!(path[0] in row)) throw new Error(`column ${path[0]} does not exist`);
    let v: unknown = row[path[0]];
    for (const key of path.slice(1)) v = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Row)[key] : undefined;
    out[alias ?? ref] = v === undefined ? null : structuredClone(v);
  }
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SOURCE_TYPES = ["comment", "status_comment", "handoff_note", "extension_reason", "eod_note", "sod_note"];

class CheckViolation extends Error {
  readonly code: string;
  constructor(constraint: string, code = "23514") {
    super(`new row violates check constraint "${constraint}"`);
    this.code = code;
  }
}

export function createFakeDdtextDb(): FakeDdtextDb {
  const attention = createFakeAttentionDb();
  const db: FakeDdtextDb = {
    client: null,
    attention,
    activity: [],
    eod: [],
    sod: [],
    meetings: [],
    taskIds: new Set(),
    userIds: new Set(),
    items: [],
    signals: [],
    calls: [],
    installed: true,
    fail: () => null,
    before: () => {},
    callsTo: (table, op) => db.calls.filter((c) => c.table === table && (op === undefined || c.op === op)),
    deleteActivity(id) {
      db.activity = db.activity.filter((r) => r.id !== id);
      cascade((i) => i.activity_log_id === id);
    },
    deleteNote(kind, id) {
      if (kind === "eod") db.eod = db.eod.filter((r) => r.id !== id);
      else db.sod = db.sod.filter((r) => r.id !== id);
      cascade((i) => (kind === "eod" ? i.eod_note_id : i.sod_note_id) === id);
    },
    deleteTask(id) {
      db.taskIds.delete(id);
      const logs = new Set(db.activity.filter((r) => r.task_id === id).map((r) => r.id));
      db.activity = db.activity.filter((r) => r.task_id !== id);
      cascade((i) => i.task_id === id || logs.has(i.activity_log_id as string));
    },
    deleteUser(id) {
      db.userIds.delete(id);
      const logs = new Set(db.activity.filter((r) => r.user_id === id).map((r) => r.id));
      db.activity = db.activity.filter((r) => r.user_id !== id);
      db.eod = db.eod.filter((r) => r.user_id !== id);
      db.sod = db.sod.filter((r) => r.user_id !== id);
      cascade((i) => i.author_user_id === id || logs.has(i.activity_log_id as string));
    }
  };

  function cascade(doomed: (item: Row) => boolean): void {
    const gone = db.items.filter(doomed);
    const keys = new Set(gone.map((i) => `${i.principal_id}|${i.source_type}|${i.source_id}`));
    db.items = db.items.filter((i) => !doomed(i));
    db.signals = db.signals.filter((s) => !keys.has(`${s.principal_id}|${s.source_type}|${s.source_id}`));
  }

  const tableRows = (table: string): Row[] => {
    switch (table) {
      case "activity_logs":
        return db.activity;
      case "eod_notes":
        return db.eod;
      case "sod_notes":
        return db.sod;
      case "client_meetings":
        return db.meetings;
      case "exec_ddtext_items":
        return db.items;
      case "exec_ddtext_signals":
        return db.signals;
      case "exec_attention_items":
        return attention.rows;
      default:
        throw new Error(`fake-ddtext-db: unexpected table ${table}`);
    }
  };
  const setRows = (table: string, rows: Row[]) => {
    if (table === "exec_ddtext_items") db.items = rows;
    else if (table === "exec_ddtext_signals") db.signals = rows;
    else if (table === "exec_attention_items") attention.rows = rows;
    else throw new Error(`fake-ddtext-db: deletes from ${table} aren't modelled`);
  };

  function replaceItem(args: Row): string {
    const principal = args.p_principal as string;
    const item = args.p_item as Row;
    const signals = args.p_signals as Row[];
    const type = item.source_type as string;
    const id = item.source_id as string;
    if (!principal || !type || !id) {
      const e = new CheckViolation("exec_ddtext_replace_item", "P0001");
      throw e;
    }
    if (!Array.isArray(signals)) throw new CheckViolation("exec_ddtext_replace_item: p_signals", "P0001");
    // FK targets first: a missing one is source_gone (the function's foreign_key_violation handler).
    const fk: [unknown, (v: string) => boolean][] = [
      [item.activity_log_id, (v) => db.activity.some((r) => r.id === v)],
      [item.eod_note_id, (v) => db.eod.some((r) => r.id === v)],
      [item.sod_note_id, (v) => db.sod.some((r) => r.id === v)],
      [item.task_id, (v) => db.taskIds.has(v)],
      [item.author_user_id, (v) => db.userIds.has(v)]
    ];
    for (const [v, ok] of fk) if (typeof v === "string" && !ok(v)) return "source_gone";
    // The item CHECKs.
    if (!SOURCE_TYPES.includes(type)) throw new CheckViolation("exec_ddtext_items_source_type_check");
    if (id.length < 1 || id.length > 200) throw new CheckViolation("exec_ddtext_items_source_id_check");
    const nul = (k: string) => item[k] === null || item[k] === undefined;
    const pointerOk =
      type === "eod_note"
        ? !nul("eod_note_id") && item.eod_note_id === id && nul("activity_log_id") && nul("sod_note_id") && nul("task_id") && !nul("note_date")
        : type === "sod_note"
          ? !nul("sod_note_id") && item.sod_note_id === id && nul("activity_log_id") && nul("eod_note_id") && nul("task_id") && !nul("note_date")
          : !nul("activity_log_id") && item.activity_log_id === id && nul("eod_note_id") && nul("sod_note_id") && !nul("task_id") && nul("note_date");
    if (!pointerOk) throw new CheckViolation("exec_ddtext_items_pointer_check");
    if (!["signals", "none", "failed", "deferred"].includes(item.outcome as string)) throw new CheckViolation("exec_ddtext_items_outcome_check");
    const failed = item.outcome === "failed";
    if (failed !== !nul("failure") || (!nul("failure") && !["refusal", "truncated", "invalid_output", "input_too_large"].includes(item.failure as string))) {
      throw new CheckViolation("exec_ddtext_items_failure_check");
    }
    if (typeof item.content_hash !== "string" || !HEX64.test(item.content_hash)) throw new CheckViolation("exec_ddtext_items_hash_check");
    if (!nul("model") && ((item.model as string).length < 1 || (item.model as string).length > 64)) throw new CheckViolation("exec_ddtext_items_model_check");
    if (typeof item.triage_version !== "string" || item.triage_version.length < 1 || item.triage_version.length > 40) {
      throw new CheckViolation("exec_ddtext_items_version_check");
    }
    const kinds = new Set<string>();
    for (const s of signals) {
      const kind = s.kind as string;
      if (!["blocker", "waiting", "decision", "mention"].includes(kind)) throw new CheckViolation("exec_ddtext_signals_kind_check");
      const summary = s.summary;
      const ok =
        (kind === "mention" && (summary === null || summary === undefined) && s.confidence === "deterministic" && (type === "comment" || type === "status_comment")) ||
        (kind !== "mention" && typeof summary === "string" && summary.length >= 1 && summary.length <= 200 && (s.confidence === "high" || s.confidence === "medium"));
      if (!ok) throw new CheckViolation("exec_ddtext_signals_summary_check");
      if (!(type === "eod_note" || type === "sod_note" || !nul("task_id"))) throw new CheckViolation("exec_ddtext_signals_task_check");
      if (kinds.has(kind)) throw new CheckViolation("exec_ddtext_signals_pkey", "23505");
      kinds.add(kind);
    }
    const now = new Date().toISOString();
    const stored: Row = {
      principal_id: principal,
      source_type: type,
      source_id: id,
      activity_log_id: item.activity_log_id ?? null,
      eod_note_id: item.eod_note_id ?? null,
      sod_note_id: item.sod_note_id ?? null,
      task_id: item.task_id ?? null,
      author_user_id: item.author_user_id,
      source_created_at: item.source_created_at,
      note_date: item.note_date ?? null,
      outcome: item.outcome,
      failure: item.failure ?? null,
      content_hash: item.content_hash,
      model: item.model ?? null,
      triage_version: item.triage_version,
      triaged_at: now,
      expires_at: item.expires_at
    };
    const same = (r: Row) => r.principal_id === principal && r.source_type === type && r.source_id === id;
    db.items = [...db.items.filter((r) => !same(r)), stored];
    db.signals = [
      ...db.signals.filter((r) => !same(r)),
      ...signals.map((s) => ({
        principal_id: principal,
        source_type: type,
        source_id: id,
        kind: s.kind,
        summary: s.summary ?? null,
        confidence: s.confidence,
        task_id: item.task_id ?? null,
        author_user_id: item.author_user_id,
        source_created_at: item.source_created_at,
        created_at: now
      }))
    ];
    return "written";
  }

  function execute(call: DdtextCall): Reply {
    db.calls.push(call);
    if (call.signal?.aborted) return { data: null, error: { message: "AbortError: This operation was aborted" } };
    db.before(call);
    const injected = db.fail(call);
    if (injected) return { data: null, error: injected };
    if (!db.installed && (DDTEXT_TABLES.has(call.table) || call.op === "rpc")) {
      return call.op === "rpc"
        ? { data: null, error: { message: "function public.exec_ddtext_replace_item(text, jsonb, jsonb) does not exist", code: "42883" } }
        : { data: null, error: { message: `relation "public.${call.table}" does not exist`, code: "42P01" } };
    }
    try {
      if (call.op === "rpc") return { data: replaceItem(call.args ?? {}), error: null };
      const all = tableRows(call.table);
      let rows = all.filter((r) => call.filters.every((f) => matches(r, f)));
      if (call.op === "delete") {
        const doomed = new Set(rows);
        setRows(
          call.table,
          all.filter((r) => !doomed.has(r))
        );
        if (call.table === "exec_ddtext_items") {
          const keys = new Set(rows.map((i) => `${i.principal_id}|${i.source_type}|${i.source_id}`));
          db.signals = db.signals.filter((s) => !keys.has(`${s.principal_id}|${s.source_type}|${s.source_id}`));
        }
        return { data: null, error: null, count: call.count === "exact" ? rows.length : null };
      }
      rows = [...rows].sort((a, b) => {
        for (const { column, ascending } of call.orders) {
          const av = a[column];
          const bv = b[column];
          if (av === bv) continue;
          if (av === null || av === undefined) return ascending ? 1 : -1;
          if (bv === null || bv === undefined) return ascending ? -1 : 1;
          const c = compare(column, av, bv);
          if (c !== 0) return ascending ? c : -c;
        }
        return 0;
      });
      if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
      if (call.limit !== null) rows = rows.slice(0, call.limit);
      return { data: rows.map((r) => project(r, call.columns ?? "")), error: null };
    } catch (err) {
      const e = err as { message?: string; code?: string };
      return { data: null, error: { message: e.message ?? String(err), ...(e.code ? { code: e.code } : {}) } };
    }
  }

  function builder(call: DdtextCall) {
    const b = {
      eq: (column: string, value: unknown) => (call.filters.push({ kind: "eq", column, value }), b),
      neq: (column: string, value: unknown) => (call.filters.push({ kind: "neq", column, value }), b),
      gt: (column: string, value: unknown) => (call.filters.push({ kind: "gt", column, value }), b),
      gte: (column: string, value: unknown) => (call.filters.push({ kind: "gte", column, value }), b),
      lt: (column: string, value: unknown) => (call.filters.push({ kind: "lt", column, value }), b),
      lte: (column: string, value: unknown) => (call.filters.push({ kind: "lte", column, value }), b),
      in: (column: string, values: readonly unknown[]) => (call.filters.push({ kind: "in", column, values: [...values] }), b),
      not: (column: string, operator: string, value: unknown) => {
        if (operator !== "is" || value !== null) throw new Error(`fake-ddtext-db: unsupported not.${operator}`);
        call.filters.push({ kind: "notnull", column });
        return b;
      },
      overlaps: (column: string, values: readonly unknown[]) => (call.filters.push({ kind: "overlaps", column, values: [...values] }), b),
      or: (expr: string) => (call.filters.push({ kind: "or", expr }), b),
      order: (column: string, o?: { ascending?: boolean }) => (call.orders.push({ column, ascending: o?.ascending !== false }), b),
      range: (from: number, to: number) => ((call.range = [from, to]), b),
      limit: (n: number) => ((call.limit = n), b),
      abortSignal: (signal: AbortSignal) => ((call.signal = signal), b),
      then: <A, B>(onFulfilled?: (v: Reply) => A, onRejected?: (e: unknown) => B) =>
        Promise.resolve()
          .then(() => execute(call))
          .then(onFulfilled, onRejected)
    };
    return b;
  }

  const blank = (table: string, op: DdtextCall["op"]): DdtextCall => ({
    table,
    op,
    columns: null,
    filters: [],
    orders: [],
    range: null,
    limit: null,
    count: null,
    args: null,
    signal: null
  });

  const attentionClient = attention.client as { from(table: string): Record<string, unknown> };
  db.client = {
    from(table: string) {
      if (table === "exec_attention_items") {
        return {
          ...attentionClient.from(table),
          delete: (opts?: { count?: string }) => builder({ ...blank(table, "delete"), count: opts?.count ?? null })
        };
      }
      return {
        select: (columns: string) => builder({ ...blank(table, "select"), columns }),
        delete: (opts?: { count?: string }) => builder({ ...blank(table, "delete"), count: opts?.count ?? null })
      };
    },
    rpc(name: string, args: Row) {
      if (name !== "exec_ddtext_replace_item") throw new Error(`fake-ddtext-db: unexpected rpc ${name}`);
      return builder({ ...blank(name, "rpc"), args: structuredClone(args) });
    }
  };
  return db;
}
