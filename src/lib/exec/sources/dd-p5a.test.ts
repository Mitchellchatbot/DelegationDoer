import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { principalFromRows } from "@/lib/exec/principal";
import {
  DdReadError,
  getPendingApprovals,
  listEodNotesBetween,
  listPendingApprovalItems,
  listProjectTasksAllStates,
  listStatusTransitions,
  listTaskExtensionsForTasks,
  listTaskHours,
  listTaskThreadLinks,
  listUpdateRepliesByUser,
  listUserSchedules
} from "@/lib/exec/sources/dd";
import type { ExecPrincipal } from "@/lib/exec/types";

// P5a contract §3.8 (Area C): the new DD reads. Same rules as P2b's reads,
// pinned the same way: fail closed, paged by a unique key, ids chunked at
// 200, explicit columns, never free text. The PostgREST stand-in below is
// sources/dd.test.ts's, copied so the two files evolve independently.

// ---------------------------------------------------------------------------
// An in-memory PostgREST stand-in (see sources/dd.test.ts).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type CmpOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
type Filter =
  | { kind: "cmp"; op: CmpOp; column: string; value: unknown }
  | { kind: "is"; column: string; value: boolean | null }
  | { kind: "in"; column: string; values: readonly unknown[] }
  | { kind: "not"; column: string; operator: string; value: unknown }
  | { kind: "or"; expr: string };

interface Recorded {
  table: string;
  columns: string | null;
  head: boolean;
  count: string | null;
  filters: Filter[];
  orders: { column: string; ascending: boolean }[];
  range: [number, number] | null;
  limit: number | null;
  signal: AbortSignal | null;
}

interface Reply {
  data: unknown;
  count: unknown;
  error: { message: string } | null;
}

interface FakeConfig {
  tables?: Record<string, Row[]>;
  /** A message fails the query. */
  fail?: (q: Recorded) => string | null | undefined;
  /** Rows served as-is (no filtering, ordering or range). */
  serve?: (q: Recorded) => Row[] | undefined;
  /** A raw reply, for malformed responses. */
  respond?: (q: Recorded) => Partial<Reply> | undefined;
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T/;

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  if (ISO_TS.test(x) && ISO_TS.test(y)) return Date.parse(x) - Date.parse(y);
  return x < y ? -1 : x > y ? 1 : 0;
}

function cmpMatches(op: CmpOp, cell: unknown, value: unknown): boolean {
  if (cell === null || cell === undefined || value === null || value === undefined) return false;
  if (typeof cell === "boolean") {
    const v = typeof value === "string" ? value === "true" : value;
    return op === "eq" ? cell === v : op === "neq" ? cell !== v : false;
  }
  const c = compare(cell, value);
  switch (op) {
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
    case "cmp":
      return cmpMatches(f.op, row[f.column], f.value);
    case "is":
      return f.value === null ? row[f.column] == null : row[f.column] === f.value;
    case "in":
      return row[f.column] != null && f.values.includes(row[f.column]);
    case "not": {
      const cell = row[f.column];
      if (f.operator === "is" && f.value === null) return cell != null;
      if (f.operator === "in") {
        const list = String(f.value).replace(/^\(|\)$/g, "").split(",");
        return cell != null && !list.includes(String(cell));
      }
      if (f.operator === "cs") {
        // Array contains, negated; NOT of a NULL comparison is still NULL.
        const wanted = String(f.value).replace(/^\{|\}$/g, "").split(",");
        return Array.isArray(cell) && !wanted.every((w) => cell.includes(w));
      }
      throw new Error(`fake: unsupported not.${f.operator}`);
    }
    case "or":
      return f.expr.split(",").some((cond) => {
        const [column, op, ...rest] = cond.split(".");
        const raw = rest.join(".");
        if (op === "is") return raw === "null" ? row[column] == null : row[column] === (raw === "true");
        return cmpMatches(op as CmpOp, row[column], raw);
      });
  }
}

function sortRows(rows: Row[], orders: Recorded["orders"]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const x = a[column];
      const y = b[column];
      if (x == null && y == null) continue;
      if (x == null) return ascending ? 1 : -1;
      if (y == null) return ascending ? -1 : 1;
      const c = compare(x, y);
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

function reply(q: Recorded, cfg: FakeConfig): Reply {
  if (q.signal?.aborted) return { data: null, count: null, error: { message: "AbortError: This operation was aborted" } };
  const failure = cfg.fail?.(q);
  if (failure) return { data: null, count: null, error: { message: failure } };
  const raw = cfg.respond?.(q);
  if (raw) return { data: null, count: null, error: null, ...raw };
  let rows = cfg.serve?.(q);
  if (!rows) {
    rows = sortRows(
      (cfg.tables?.[q.table] ?? []).filter((r) => q.filters.every((f) => matches(r, f))),
      q.orders
    );
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    if (q.limit !== null) rows = rows.slice(0, q.limit);
  }
  if (q.head) return { data: null, count: rows.length, error: null };
  const columns = (q.columns ?? "").split(",");
  const out: Row[] = [];
  for (const row of rows) {
    const picked: Row = {};
    for (const column of columns) {
      if (!(column in row)) return { data: null, count: null, error: { message: `column ${q.table}.${column} does not exist` } };
      picked[column] = row[column];
    }
    out.push(picked);
  }
  return { data: out, count: null, error: null };
}

function fakeDb(cfg: FakeConfig = {}) {
  const queries: Recorded[] = [];
  const client = {
    from(table: string) {
      const q: Recorded = { table, columns: null, head: false, count: null, filters: [], orders: [], range: null, limit: null, signal: null };
      queries.push(q);
      const cmp = (op: CmpOp) => (column: string, value: unknown) => {
        q.filters.push({ kind: "cmp", op, column, value });
        return builder;
      };
      const builder = {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          q.columns = columns;
          q.head = options?.head === true;
          q.count = options?.count ?? null;
          return builder;
        },
        eq: cmp("eq"),
        neq: cmp("neq"),
        gt: cmp("gt"),
        gte: cmp("gte"),
        lt: cmp("lt"),
        lte: cmp("lte"),
        is(column: string, value: boolean | null) {
          q.filters.push({ kind: "is", column, value });
          return builder;
        },
        in(column: string, values: readonly unknown[]) {
          q.filters.push({ kind: "in", column, values: [...values] });
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          q.filters.push({ kind: "not", column, operator, value });
          return builder;
        },
        or(expr: string) {
          q.filters.push({ kind: "or", expr });
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          q.orders.push({ column, ascending: options?.ascending !== false });
          return builder;
        },
        range(from: number, to: number) {
          q.range = [from, to];
          return builder;
        },
        limit(n: number) {
          q.limit = n;
          return builder;
        },
        abortSignal(signal: AbortSignal) {
          q.signal = signal;
          return builder;
        },
        then<A, B>(onFulfilled?: (v: Reply) => A, onRejected?: (e: unknown) => B) {
          return Promise.resolve()
            .then(() => reply(q, cfg))
            .then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
  return { queries, on: (table: string) => queries.filter((q) => q.table === table) };
}


function mint(userId: string): ExecPrincipal {
  const p = principalFromRows(
    { id: `ep_${userId}`, user_id: userId, enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: userId, email: `${userId}@scaledai.org`, name: userId, work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const principal = mint("u_owner");

const taskRow = (over: Row = {}): Row => ({
  id: "t_1",
  title: "Fix the contact form",
  description: "SECRET task description",
  status: "pending",
  priority: "medium",
  tags: [],
  department_id: "dep_web",
  assignee_id: "u_1",
  creator_id: "u_2",
  project_id: null,
  stage_id: null,
  client_name: null,
  due_date: null,
  created_at: "2026-10-01T10:00:00.000Z",
  completed_at: null,
  last_activity_at: "2026-11-01T10:00:00.000Z",
  archived_at: null,
  archived_by: null,
  is_draft: false,
  deleted_at: null,
  estimated_hours: 2,
  ...over
});

const NOW = new Date("2026-11-04T17:00:00.000Z"); // 12:00 EST, ET day 2026-11-04

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
});

// ---------------------------------------------------------------------------
// P5a reads (contract §3.8): tests 42, 46, 47 and the rest of the new reads.
// ---------------------------------------------------------------------------

const SECRET = "SECRET-PHRASE-do-not-leak";

const userRow = (over: Row = {}): Row => ({
  id: "u_1",
  name: "Ana",
  email: "ana@scaledai.org",
  role: "worker",
  daily_capacity: 8,
  weekly_schedule: {},
  work_hours_start: null,
  work_hours_end: null,
  daily_prompts_enabled: true,
  daily_prompts_required: false,
  clock_enabled: true,
  created_at: "2026-01-02T00:00:00.000Z",
  slack_access_token: SECRET,
  google_refresh_token: SECRET,
  ...over
});

describe("listUserSchedules (test 42)", () => {
  it("selects the schedule columns and never a token column", async () => {
    const db = fakeDb({ tables: { users: [userRow()] } });
    const rows = await listUserSchedules(principal);
    const [q] = db.on("users");
    expect(q.columns).toBe(
      "id,daily_capacity,weekly_schedule,work_hours_start,work_hours_end,daily_prompts_enabled,daily_prompts_required,clock_enabled,created_at"
    );
    expect(q.columns).not.toMatch(/token|slack|google|\*/);
    expect(q.orders).toEqual([{ column: "id", ascending: true }]);
    expect(rows).toEqual([
      {
        userId: "u_1",
        dailyCapacity: 8,
        weeklySchedule: {},
        workHoursStart: null,
        workHoursEnd: null,
        dailyPromptsEnabled: true,
        dailyPromptsRequired: false,
        clockEnabled: true,
        createdAt: "2026-01-02T00:00:00.000Z"
      }
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("keeps a well-formed weekly schedule and reads a malformed one as {}", async () => {
    const good = { mon: { start: "09:00", end: "17:00" }, sat: null, tue: { start: " 19:00", end: "03:00 " } };
    fakeDb({
      tables: {
        users: [
          userRow({ id: "u_good", weekly_schedule: good, daily_capacity: "6.5", work_hours_start: "09:00", work_hours_end: "17:00" }),
          userRow({ id: "u_array", weekly_schedule: [1, 2] }),
          userRow({ id: "u_key", weekly_schedule: { monday: { start: "09:00", end: "17:00" } } }),
          userRow({ id: "u_time", weekly_schedule: { mon: { start: "9am", end: "17:00" } } }),
          userRow({ id: "u_shape", weekly_schedule: { mon: "09:00-17:00" } }),
          userRow({ id: "u_null", weekly_schedule: null, daily_prompts_enabled: false, daily_prompts_required: true, clock_enabled: false })
        ]
      }
    });
    const byId = new Map((await listUserSchedules(principal)).map((s) => [s.userId, s]));
    expect(byId.get("u_good")).toMatchObject({
      dailyCapacity: 6.5,
      weeklySchedule: { mon: { start: "09:00", end: "17:00" }, sat: null, tue: { start: "19:00", end: "03:00" } },
      workHoursStart: "09:00",
      workHoursEnd: "17:00"
    });
    for (const id of ["u_array", "u_key", "u_time", "u_shape", "u_null"]) expect(byId.get(id)?.weeklySchedule).toEqual({});
    expect(byId.get("u_null")).toMatchObject({ dailyPromptsEnabled: false, dailyPromptsRequired: true, clockEnabled: false });
  });

  it("fails closed", async () => {
    fakeDb({ tables: { users: [userRow()] }, fail: () => "boom" });
    await expect(listUserSchedules(principal)).rejects.toThrow(DdReadError);
  });
});

describe("listTaskHours / listTaskExtensionsForTasks / listProjectTasksAllStates", () => {
  it("reads hours by id in chunks of 200, the override kept apart", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `t_${String(i).padStart(3, "0")}`);
    const db = fakeDb({
      tables: {
        tasks: ids.map((id, i) => taskRow({ id, estimated_hours: "3", actual_hours: i === 0 ? "1.5" : 0, actual_hours_override: i === 0 ? "0.5" : null }))
      }
    });
    const rows = await listTaskHours(principal, [...ids, ids[0]]);
    expect(db.on("tasks").map((q) => (q.filters[0] as { values?: readonly unknown[] }).values?.length)).toEqual([200, 50]);
    expect(db.on("tasks")[0].columns).toBe("id,estimated_hours,actual_hours,actual_hours_override");
    expect(rows).toHaveLength(250);
    expect(rows[0]).toEqual({ taskId: "t_000", estimatedHours: 3, actualHours: 1.5, actualHoursOverride: 0.5 });
    expect(rows[1]).toEqual({ taskId: "t_001", estimatedHours: 3, actualHours: 0, actualHoursOverride: null });
    expect(await listTaskHours(principal, [])).toEqual([]);
  });

  it("reads every extension of the tasks, any age, without the reason", async () => {
    const db = fakeDb({
      tables: {
        task_extensions: [
          { id: "x1", task_id: "t_1", user_id: "u_2", previous_due_date: null, new_due_date: "2026-11-05T00:00:00.000Z", created_at: "2025-01-01T00:00:00.000Z", reason: SECRET },
          { id: "x2", task_id: "t_2", user_id: "u_2", previous_due_date: "2026-11-01T00:00:00.000Z", new_due_date: "2026-11-08T00:00:00.000Z", created_at: "2026-10-31T00:00:00.000Z", reason: SECRET },
          { id: "x3", task_id: "t_9", user_id: "u_2", previous_due_date: null, new_due_date: "2026-11-05T00:00:00.000Z", created_at: "2026-10-31T00:00:00.000Z", reason: SECRET }
        ]
      }
    });
    const rows = await listTaskExtensionsForTasks(principal, ["t_1", "t_2"]);
    expect(db.on("task_extensions")[0].columns).toBe("id,task_id,user_id,previous_due_date,new_due_date,created_at");
    expect(rows.map((r) => r.id)).toEqual(["x1", "x2"]);
    expect(rows[0]).toEqual({ id: "x1", taskId: "t_1", userId: "u_2", previousDueDate: null, newDueDate: "2026-11-05T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("returns a project's tasks in every state, with the batch columns", async () => {
    const db = fakeDb({
      tables: {
        tasks: [
          taskRow({ id: "p1", project_id: "proj_1", parallel_group: 1, stage_position: "2" }),
          taskRow({ id: "p2", project_id: "proj_1", is_draft: true, parallel_group: null, stage_position: null }),
          taskRow({ id: "p3", project_id: "proj_1", deleted_at: "2026-11-01T00:00:00.000Z", parallel_group: 2, stage_position: 0 }),
          taskRow({ id: "p4", project_id: "proj_1", status: "rejected", parallel_group: 2, stage_position: 1 }),
          taskRow({ id: "other", project_id: "proj_2", parallel_group: 1, stage_position: 0 })
        ]
      }
    });
    const rows = await listProjectTasksAllStates(principal, ["proj_1"]);
    const [q] = db.on("tasks");
    expect(q.columns?.endsWith(",parallel_group,stage_position")).toBe(true);
    expect(q.columns).not.toContain("description");
    expect(q.filters).toEqual([{ kind: "in", column: "project_id", values: ["proj_1"] }]);
    expect(rows.map((r) => [r.id, r.isDraft, r.deletedAt !== null, r.status, r.parallelGroup, r.stagePosition])).toEqual([
      ["p1", false, false, "pending", 1, 2],
      ["p2", true, false, "pending", null, null],
      ["p3", false, true, "pending", 2, 0],
      ["p4", false, false, "rejected", 2, 1]
    ]);
  });
});

describe("listEodNotesBetween", () => {
  it("reads status for an ET date range by note_date, never text", async () => {
    const db = fakeDb({
      tables: {
        eod_notes: [
          { id: "e1", user_id: "u_1", note_date: "2026-10-31", submitted_at: "2026-10-31T22:00:00.000Z", reviewed_at: null, blockers: SECRET, note: SECRET },
          { id: "e2", user_id: "u_1", note_date: "2026-11-02", submitted_at: null, reviewed_at: null, blockers: SECRET, note: SECRET },
          { id: "e3", user_id: "u_2", note_date: "2026-11-03", submitted_at: "2026-11-03T22:00:00.000Z", reviewed_at: "2026-11-04T09:00:00.000Z", blockers: SECRET, note: SECRET },
          { id: "e4", user_id: "u_2", note_date: "2026-11-04", submitted_at: "2026-11-04T22:00:00.000Z", reviewed_at: null, blockers: SECRET, note: SECRET }
        ]
      }
    });
    const rows = await listEodNotesBetween(principal, "2026-11-01", "2026-11-03");
    const [q] = db.on("eod_notes");
    expect(q.columns).toBe("user_id,note_date,submitted_at,reviewed_at");
    expect(q.orders).toEqual([
      { column: "note_date", ascending: true },
      { column: "user_id", ascending: true }
    ]);
    expect(rows).toEqual([
      { userId: "u_1", noteDate: "2026-11-02", submittedAt: null, reviewedAt: null },
      { userId: "u_2", noteDate: "2026-11-03", submittedAt: "2026-11-03T22:00:00.000Z", reviewedAt: "2026-11-04T09:00:00.000Z" }
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("refuses bad or reversed dates before querying", async () => {
    const db = fakeDb();
    await expect(listEodNotesBetween(principal, "2026-11-04", "2026-11-01")).rejects.toThrow(TypeError);
    await expect(listEodNotesBetween(principal, "2026-02-30", "2026-03-01")).rejects.toThrow(TypeError);
    expect(db.queries).toHaveLength(0);
  });
});

describe("listStatusTransitions (test 46)", () => {
  const log = (over: Row = {}): Row => ({
    id: "al_1",
    task_id: "t_1",
    user_id: "u_1",
    action: "status_change",
    detail: "pending → in_progress",
    created_at: "2026-11-02T10:00:00.000Z",
    mentioned_user_ids: [],
    ...over
  });

  it("parses the first line and never returns the text after it", async () => {
    const db = fakeDb({
      tables: {
        activity_logs: [
          log({ id: "al_1", detail: `in_progress → waiting_on_client\n${SECRET} the client still owes us the logo` }),
          log({ id: "al_2", detail: "waiting_on_client → done (timer started)", created_at: "2026-11-03T10:00:00.000Z" }),
          log({ id: "al_3", detail: `${SECRET} not a transition` }),
          log({ id: "al_4", detail: null }),
          log({ id: "al_5", action: "comment", detail: `pending → done ${SECRET}` }),
          log({ id: "al_6", detail: "pending → done", created_at: "2026-10-01T10:00:00.000Z" }),
          log({ id: "al_7", task_id: "t_other", detail: "pending → done" })
        ]
      }
    });
    const rows = await listStatusTransitions(principal, ["t_1"], "2026-11-01T00:00:00.000Z");
    expect(rows).toEqual([
      { id: "al_1", taskId: "t_1", userId: "u_1", from: "in_progress", to: "waiting_on_client", at: "2026-11-02T10:00:00.000Z" },
      { id: "al_2", taskId: "t_1", userId: "u_1", from: "waiting_on_client", to: "done", at: "2026-11-03T10:00:00.000Z" }
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const [q] = db.on("activity_logs");
    expect(q.columns).toBe("id,task_id,user_id,detail,created_at");
    expect(q.filters).toEqual([
      { kind: "cmp", op: "eq", column: "action", value: "status_change" },
      { kind: "in", column: "task_id", values: ["t_1"] },
      { kind: "cmp", op: "gte", column: "created_at", value: "2026-11-01T00:00:00.000Z" }
    ]);
  });

  it("reads nothing for no tasks and refuses a bad since", async () => {
    const db = fakeDb();
    expect(await listStatusTransitions(principal, [], "2026-11-01T00:00:00.000Z")).toEqual([]);
    await expect(listStatusTransitions(principal, ["t_1"], "yesterday")).rejects.toThrow(TypeError);
    expect(db.queries).toHaveLength(0);
  });
});

describe("listUpdateRepliesByUser", () => {
  it("reads one user's EOD replies on these notes, without bodies", async () => {
    const db = fakeDb({
      tables: {
        update_replies: [
          { id: "r1", target_type: "eod", target_id: "eod_1", user_id: "u_owner", body: SECRET, created_at: "2026-11-03T10:00:00.000Z" },
          { id: "r2", target_type: "eod", target_id: "eod_1", user_id: "u_2", body: SECRET, created_at: "2026-11-03T11:00:00.000Z" },
          { id: "r3", target_type: "sod", target_id: "eod_1", user_id: "u_owner", body: SECRET, created_at: "2026-11-03T12:00:00.000Z" },
          { id: "r4", target_type: "eod", target_id: "eod_9", user_id: "u_owner", body: SECRET, created_at: "2026-11-03T12:00:00.000Z" }
        ]
      }
    });
    const rows = await listUpdateRepliesByUser(principal, "u_owner", ["eod_1", "eod_2"]);
    expect(rows).toEqual([{ id: "r1", targetId: "eod_1", userId: "u_owner", createdAt: "2026-11-03T10:00:00.000Z" }]);
    expect(db.on("update_replies")[0].columns).toBe("id,target_id,user_id,created_at");
  });
});

describe("listTaskThreadLinks (C25)", () => {
  it("reads both links and the recorded sender, whatever the tags", async () => {
    const enc = encodeURIComponent("th/1 x");
    const db = fakeDb({
      tables: {
        tasks: [
          taskRow({ id: "t_url", missive_thread_url: `https://missive.example/inbox?thread=${enc}`, client_email: null }),
          taskRow({ id: "t_mail", missive_thread_url: null, client_email: "  boss@deel.com " }),
          taskRow({ id: "t_both", missive_thread_url: "https://x/?thread=th_2", client_email: "a@b.com" }),
          taskRow({ id: "t_none", missive_thread_url: "https://example.com/no-thread", client_email: "" }),
          taskRow({ id: "t_bad", missive_thread_url: "https://x/?thread=%E0%A4%A", client_email: null }),
          taskRow({ id: "t_log", missive_thread_url: null, client_email: null })
        ],
        email_intake_log: [
          { thread_id: "th_log", task_id: "t_log", account_id: "acc", routed_via: "rule:1" },
          { thread_id: "th_2", task_id: "t_both", account_id: "acc", routed_via: "rule:1" },
          { thread_id: "th_other", task_id: "t_elsewhere", account_id: "acc", routed_via: "rule:1" },
          { thread_id: "th_null", task_id: null, account_id: "acc", routed_via: "rule:1" }
        ]
      }
    });
    const links = await listTaskThreadLinks(principal, ["t_url", "t_mail", "t_both", "t_none", "t_bad", "t_log"]);
    expect(links).toEqual([
      { taskId: "t_both", threadIds: ["th_2"], clientEmail: "a@b.com" },
      { taskId: "t_log", threadIds: ["th_log"], clientEmail: null },
      { taskId: "t_mail", threadIds: [], clientEmail: "boss@deel.com" },
      { taskId: "t_url", threadIds: ["th/1 x"], clientEmail: null }
    ]);
    expect(db.on("tasks")[0].columns).toBe("id,missive_thread_url,client_email");
    expect(db.on("email_intake_log")[0]).toMatchObject({
      columns: "thread_id,task_id",
      filters: [{ kind: "in", column: "task_id", values: ["t_url", "t_mail", "t_both", "t_none", "t_bad", "t_log"] }],
      orders: [{ column: "thread_id", ascending: true }]
    });
  });

  it("reads nothing for no tasks, and fails closed", async () => {
    const db = fakeDb();
    expect(await listTaskThreadLinks(principal, [])).toEqual([]);
    expect(db.queries).toHaveLength(0);
    fakeDb({ tables: { tasks: [taskRow({ missive_thread_url: null, client_email: null })] }, fail: (q) => (q.table === "email_intake_log" ? "boom" : null) });
    await expect(listTaskThreadLinks(principal, ["t_1"])).rejects.toThrow(DdReadError);
  });
});

describe("listPendingApprovalItems (test 47, S5)", () => {
  function approvalTables(): Record<string, Row[]> {
    return {
      tasks: [
        taskRow({ id: "t_draft1", title: "Draft one", is_draft: true, created_at: "2026-11-01T09:00:00.000Z", creator_id: "u_2", department_id: "dep_seo", client_name: "Acme" }),
        taskRow({ id: "t_draft2", title: "Draft two", is_draft: true, created_at: "2026-10-30T09:00:00.000Z", creator_id: "u_3", department_id: null }),
        taskRow({ id: "t_draft_deleted", is_draft: true, created_at: "2026-10-01T09:00:00.000Z", deleted_at: "2026-10-02T00:00:00.000Z" }),
        taskRow({ id: "t_fb1", title: "Proof one", status: "pending_approval", assignee_id: "u_4", last_activity_at: "2026-11-03T16:00:00.000Z" }),
        taskRow({ id: "t_fb2", title: "Proof two", status: "pending_approval", assignee_id: "u_5", last_activity_at: "2026-10-31T10:00:00.000Z" }),
        taskRow({ id: "t_fb_deleted", status: "pending_approval", deleted_at: "2026-10-21T00:00:00.000Z" }),
        taskRow({ id: "t_fb_done", status: "done", completed_at: "2026-10-12T00:00:00.000Z" })
      ],
      fb_proof: [
        { task_id: "t_fb1", submitted_by: "u_6", submitted_at: "2026-11-03T15:00:00.000Z", review_status: "pending", work_done: SECRET },
        { task_id: "t_fb_deleted", submitted_by: "u_6", submitted_at: "2026-10-20T10:00:00.000Z", review_status: "pending", work_done: SECRET },
        { task_id: "t_fb_done", submitted_by: "u_6", submitted_at: "2026-10-10T10:00:00.000Z", review_status: "pending", work_done: SECRET }
      ],
      email_drafts: [
        { id: "ed_1", author_id: "u_2", client_id: "cl_acme", client_name: "Acme Co", department_id: "dep_web", status: "pending", dismissed_at: null, created_at: "2026-11-02T08:00:00.000Z", subject: SECRET, body_text: SECRET, to_emails: [SECRET] },
        { id: "ed_2", author_id: "u_2", client_name: "Beta", department_id: null, status: "pending", dismissed_at: "2026-10-02T00:00:00.000Z", created_at: "2026-10-01T08:00:00.000Z", subject: SECRET, body_text: SECRET, to_emails: [] },
        { id: "ed_3", author_id: "u_3", client_id: "cl_gamma", client_name: "Gamma", department_id: null, status: "pending", dismissed_at: null, created_at: "2026-10-15T08:00:00.000Z", subject: SECRET, body_text: SECRET, to_emails: [] },
        // DD's email intake writes the sender's address into client_name when no client matched (security-2).
        { id: "ed_5", author_id: "u_3", client_id: null, client_name: "alice@acme.com", department_id: null, status: "pending", dismissed_at: null, created_at: "2026-11-04T08:00:00.000Z", subject: SECRET, body_text: SECRET, to_emails: [] },
        { id: "ed_6", author_id: "u_3", client_id: "cl_acme", client_name: " Bob <bob@acme.com> ", department_id: null, status: "pending", dismissed_at: null, created_at: "2026-11-04T09:00:00.000Z", subject: SECRET, body_text: SECRET, to_emails: [] },
        { id: "ed_7", author_id: "u_3", client_id: null, client_name: "Unlinked Name", department_id: null, status: "pending", dismissed_at: null, created_at: "2026-11-04T10:00:00.000Z", subject: SECRET, body_text: SECRET, to_emails: [] },
        { id: "ed_4", author_id: "u_3", client_name: "Delta", department_id: null, status: "needs_revision", dismissed_at: null, created_at: "2026-10-15T08:00:00.000Z", subject: SECRET, body_text: SECRET, to_emails: [] }
      ],
      email_draft_events: [
        { id: "ede_1", draft_id: "ed_3", type: "resubmitted", created_at: "2026-11-03T09:00:00.000Z", body: SECRET },
        { id: "ede_2", draft_id: "ed_1", type: "comment", created_at: "2026-11-03T10:00:00.000Z", body: SECRET }
      ],
      routing_decisions: [
        { id: "rd_1", needs_review: true, task_id: null, created_at: "2026-10-30T12:00:00.000Z", reason: SECRET, review_reason: SECRET, classifier_output: { subject: SECRET } },
        { id: "rd_2", needs_review: true, task_id: "t_x", created_at: "2026-10-01T12:00:00.000Z", reason: SECRET, review_reason: SECRET, classifier_output: null },
        { id: "rd_3", needs_review: false, task_id: null, created_at: "2026-10-01T12:00:00.000Z", reason: SECRET, review_reason: SECRET, classifier_output: null }
      ],
      eod_notes: [
        { id: "eod_a", user_id: "u_7", note_date: "2026-11-03", submitted_at: "2026-11-03T23:00:00.000Z", reviewed_at: null, blockers: SECRET },
        { id: "eod_b", user_id: "u_8", note_date: "2026-10-29", submitted_at: "2026-10-29T22:00:00.000Z", reviewed_at: null, blockers: SECRET },
        { id: "eod_c", user_id: "u_7", note_date: "2026-10-28", submitted_at: "2026-10-28T22:00:00.000Z", reviewed_at: null, blockers: SECRET },
        { id: "eod_d", user_id: "u_7", note_date: "2026-11-04", submitted_at: null, reviewed_at: null, blockers: SECRET }
      ],
      department_members: [
        { user_id: "u_7", department_id: "dep_seo", created_at: "2026-01-01T00:00:00.000Z" },
        { user_id: "u_7", department_id: "dep_web", created_at: "2026-02-01T00:00:00.000Z" }
      ],
      daily_briefings: [
        {
          id: "brief_2026-11-04",
          brief_date: "2026-11-04",
          created_at: "2026-11-04T13:00:00.000Z",
          messages: [
            { id: "m1", status: "pending", text: SECRET },
            { id: "m2", status: "sent", text: SECRET },
            { id: "m3", status: "pending", text: SECRET }
          ]
        }
      ]
    };
  }

  it("matches getPendingApprovals' count for every mechanism on the same rows", async () => {
    fakeDb({ tables: approvalTables() });
    const buckets = await getPendingApprovals(principal, NOW);
    for (const b of buckets) {
      const list = await listPendingApprovalItems(principal, b.mechanism, NOW);
      expect([b.mechanism, list.total]).toEqual([b.mechanism, b.count]);
      if (list.mode === "items") expect(list.items).toHaveLength(b.count);
    }
  });

  it("itemizes draft tasks oldest first, approved by leaders or the department's heads", async () => {
    fakeDb({ tables: approvalTables() });
    const list = await listPendingApprovalItems(principal, "draft_tasks", NOW);
    expect(list).toEqual({
      mechanism: "draft_tasks",
      mode: "items",
      total: 2,
      truncated: false,
      items: [
        {
          mechanism: "draft_tasks",
          id: "t_draft2",
          title: "Draft two",
          requesterId: "u_3",
          waitingSince: "2026-10-30T09:00:00.000Z",
          waitingSinceIsLowerBound: false,
          approver: { kind: "leaders_or_department_heads", departmentIds: [] },
          taskId: "t_draft2",
          clientName: null,
          departmentId: null
        },
        {
          mechanism: "draft_tasks",
          id: "t_draft1",
          title: "Draft one",
          requesterId: "u_2",
          waitingSince: "2026-11-01T09:00:00.000Z",
          waitingSinceIsLowerBound: false,
          approver: { kind: "leaders_or_department_heads", departmentIds: ["dep_seo"] },
          taskId: "t_draft1",
          clientName: "Acme",
          departmentId: "dep_seo"
        }
      ]
    });
  });

  it("waits a proof from its submission, else from the task's last activity as a lower bound; never the submitter", async () => {
    fakeDb({ tables: approvalTables() });
    const list = await listPendingApprovalItems(principal, "fb_proofs", NOW);
    expect(list.items.map((i) => [i.id, i.requesterId, i.waitingSince, i.waitingSinceIsLowerBound, i.approver])).toEqual([
      ["t_fb2", "u_5", "2026-10-31T10:00:00.000Z", true, { kind: "fb_managers_or_leaders", excludeUserId: null }],
      ["t_fb1", "u_6", "2026-11-03T15:00:00.000Z", false, { kind: "fb_managers_or_leaders", excludeUserId: "u_6" }]
    ]);
  });

  it("titles email drafts, unrouted mail and EOD reviews with fixed labels, never mail content", async () => {
    const db = fakeDb({ tables: approvalTables() });
    const drafts = await listPendingApprovalItems(principal, "email_drafts", NOW);
    expect(drafts.items.map((i) => [i.id, i.title, i.clientName, i.waitingSince, i.approver])).toEqual([
      ["ed_1", "Email draft for Acme Co", "Acme Co", "2026-11-02T08:00:00.000Z", { kind: "email_approvers_or_department_head", departmentId: "dep_web" }],
      // Waits from its resubmission, not its creation.
      ["ed_3", "Email draft for Gamma", "Gamma", "2026-11-03T09:00:00.000Z", { kind: "email_approvers_or_department_head", departmentId: null }],
      // An intake auto-draft with no matched client (client_name = the sender's address), an address-shaped
      // name on a linked client, and a free-text name with no client link: never a name in the item (security-2).
      ["ed_5", "Email draft", null, "2026-11-04T08:00:00.000Z", { kind: "email_approvers_or_department_head", departmentId: null }],
      ["ed_6", "Email draft", null, "2026-11-04T09:00:00.000Z", { kind: "email_approvers_or_department_head", departmentId: null }],
      ["ed_7", "Email draft", null, "2026-11-04T10:00:00.000Z", { kind: "email_approvers_or_department_head", departmentId: null }]
    ]);
    expect(JSON.stringify(drafts)).not.toMatch(/@|Unlinked/);
    const unrouted = await listPendingApprovalItems(principal, "unrouted_mail", NOW);
    expect(unrouted.items).toEqual([
      {
        mechanism: "unrouted_mail",
        id: "rd_1",
        title: "Email waiting to be routed",
        requesterId: null,
        waitingSince: "2026-10-30T12:00:00.000Z",
        waitingSinceIsLowerBound: false,
        approver: { kind: "leaders_or_any_department_head" },
        taskId: null,
        clientName: null,
        departmentId: null
      }
    ]);
    const eods = await listPendingApprovalItems(principal, "eod_reviews", NOW);
    expect(eods.items.map((i) => [i.id, i.title, i.requesterId, i.approver, i.departmentId])).toEqual([
      ["eod_b", "EOD for 2026-10-29", "u_8", { kind: "leaders_or_department_heads", departmentIds: [] }, null],
      ["eod_a", "EOD for 2026-11-03", "u_7", { kind: "leaders_or_department_heads", departmentIds: ["dep_seo", "dep_web"] }, "dep_seo"]
    ]);
    const all = JSON.stringify([drafts, unrouted, eods]);
    expect(all).not.toContain(SECRET);
    for (const q of db.queries) expect(q.columns ?? "").not.toMatch(/subject|body|to_emails|reason|classifier_output|blockers|note\b|text/);
  });

  it("keeps check-ins count-only", async () => {
    fakeDb({ tables: approvalTables() });
    expect(await listPendingApprovalItems(principal, "checkins", NOW)).toEqual({ mechanism: "checkins", mode: "count_only", items: [], total: 2, truncated: false });
  });

  it("limits the items, says when it truncated, and refuses a bad limit", async () => {
    fakeDb({ tables: approvalTables() });
    const one = await listPendingApprovalItems(principal, "draft_tasks", NOW, { limit: 1 });
    expect(one).toMatchObject({ total: 2, truncated: true });
    expect(one.items.map((i) => i.id)).toEqual(["t_draft2"]);
    for (const limit of [0, 201, 1.5]) await expect(listPendingApprovalItems(principal, "draft_tasks", NOW, { limit })).rejects.toThrow(TypeError);
  });

  it("fails closed", async () => {
    fakeDb({ tables: approvalTables(), fail: (q) => (q.table === "fb_proof" ? "boom" : null) });
    await expect(listPendingApprovalItems(principal, "fb_proofs", NOW)).rejects.toThrow(DdReadError);
  });
});
