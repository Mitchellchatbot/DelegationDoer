import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOpen } from "@/lib/exec/analysis/tasks";
import { principalFromRows } from "@/lib/exec/principal";
import {
  countOpenOverdueTasks,
  DdReadError,
  getPendingApprovals,
  listActivitySince,
  listClients,
  listDepartments,
  listEodNotesForDate,
  listIncidentLogsSince,
  listOpenTasks,
  listProjects,
  listProjectStages,
  listSiteHealthAlertsSince,
  listStatusChangeEntries,
  listTaskExtensionsSince,
  listTaskMessagesSince,
  listTaskNotificationsForUser,
  listTasksByIds,
  listTasksCompletedBetween,
  listTasksCreatedBetween,
  listTimeEntriesBetween,
  listUsers
} from "@/lib/exec/sources/dd";
import type { DdTask } from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// ---------------------------------------------------------------------------
// An in-memory PostgREST stand-in. Every query is recorded (table, columns,
// filters, order, range, limit, signal), and rows are filtered with SQL
// semantics: a comparison with NULL is never true, ascending order puts NULLs
// last. A selected column the fixture row doesn't have fails the query, the
// way PostgREST does, so fixture rows double as the schema.
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

const filtersOf = (q: Recorded) => q.filters;

// The open-task predicate as it goes over the wire (whereOpenTask in sources/dd.ts).
const OPEN_FILTERS: Filter[] = [
  { kind: "cmp", op: "eq", column: "is_draft", value: false },
  { kind: "is", column: "deleted_at", value: null },
  { kind: "not", column: "status", operator: "in", value: "(done,rejected)" },
  { kind: "or", expr: "archived_at.is.null,archived_by.is.null" }
];

// ---------------------------------------------------------------------------
// Fixtures. Every row carries the free-text columns exec must never read
// (filled with "SECRET…"), so a test can prove they don't come back.
// ---------------------------------------------------------------------------

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

describe("DdReadError", () => {
  it("names the table and keeps it on the error", () => {
    const err = new DdReadError("tasks", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DdReadError");
    expect(err.table).toBe("tasks");
    expect(err.message).toBe("DD read failed (tasks): boom");
  });
});

describe("the principal", () => {
  it("is required at runtime too: a missing one throws before any query", async () => {
    const db = fakeDb({ tables: { tasks: [taskRow()] } });
    const missing = undefined as unknown as ExecPrincipal;
    await expect(listOpenTasks(missing)).rejects.toThrow(TypeError);
    await expect(getPendingApprovals(missing, NOW)).rejects.toThrow(TypeError);
    expect(db.queries).toHaveLength(0);
  });

  it("never narrows the read: another principal sees the same company-wide rows, with no person or department filter", async () => {
    const rows = [
      taskRow({ id: "t_a", assignee_id: "u_owner", department_id: "dep_web" }),
      taskRow({ id: "t_b", assignee_id: "u_other", department_id: "dep_seo" }),
      taskRow({ id: "t_c", assignee_id: null, department_id: null })
    ];
    const db = fakeDb({ tables: { tasks: rows } });
    const mine = await listOpenTasks(principal);
    const theirs = await listOpenTasks(mint("u_worker"));
    expect(theirs).toEqual(mine);
    expect(mine.map((t) => t.id)).toEqual(["t_a", "t_b", "t_c"]);
    const columns = db.queries.flatMap((q) => q.filters.map((f) => ("column" in f ? f.column : f.expr)));
    expect(columns.join(" ")).not.toMatch(/assignee|department|creator|user_id/);
  });
});

describe("listOpenTasks", () => {
  const matrix: Array<[string, Row, boolean]> = [
    ["live pending", taskRow({ id: "t_01" }), true],
    ["in progress", taskRow({ id: "t_02", status: "in_progress" }), true],
    ["urgent", taskRow({ id: "t_03", status: "urgent" }), true],
    ["waiting on client", taskRow({ id: "t_04", status: "waiting_on_client" }), true],
    ["pending approval", taskRow({ id: "t_05", status: "pending_approval" }), true],
    ["auto-archived and open", taskRow({ id: "t_06", archived_at: "2026-10-30T02:00:00.000Z", archived_by: null }), true],
    ["shelved by a person", taskRow({ id: "t_07", archived_at: "2026-10-30T02:00:00.000Z", archived_by: "u_9" }), false],
    ["done", taskRow({ id: "t_08", status: "done", completed_at: "2026-11-01T00:00:00.000Z" }), false],
    ["rejected draft", taskRow({ id: "t_09", status: "rejected", assignee_id: null }), false],
    ["draft", taskRow({ id: "t_10", is_draft: true }), false],
    ["soft-deleted", taskRow({ id: "t_11", deleted_at: "2026-11-02T00:00:00.000Z" }), false],
    ["auto-archived but done", taskRow({ id: "t_12", status: "done", archived_at: "2026-10-30T02:00:00.000Z" }), false]
  ];

  it("sends exactly the open predicate, explicit columns and a stable page order", async () => {
    const db = fakeDb({ tables: { tasks: [] } });
    await listOpenTasks(principal);
    const [q] = db.queries;
    expect(q.table).toBe("tasks");
    expect(q.columns).toBe(
      "id,title,status,priority,tags,department_id,assignee_id,creator_id,project_id,stage_id,client_name," +
        "due_date,created_at,completed_at,last_activity_at,archived_at,archived_by,is_draft,deleted_at,estimated_hours"
    );
    expect(filtersOf(q)).toEqual(OPEN_FILTERS);
    expect(q.orders).toEqual([{ column: "id", ascending: true }]);
    expect(q.range).toEqual([0, 999]);
  });

  it.each(matrix)("%s → open: %s", async (_label, row, expected) => {
    fakeDb({ tables: { tasks: [row] } });
    const got = await listOpenTasks(principal);
    expect(got.length === 1).toBe(expected);
  });

  it("agrees with isOpen() on every row of the matrix (one predicate, two sides)", async () => {
    fakeDb({ tables: { tasks: matrix.map(([, row]) => row) } });
    const fromSql = (await listOpenTasks(principal)).map((t) => t.id);
    const everything = await (async () => {
      fakeDb({ tables: { tasks: matrix.map(([, row]) => row) } });
      return listTasksByIds(principal, matrix.map(([, row]) => String(row.id)));
    })();
    expect(everything).toHaveLength(matrix.length);
    expect(everything.filter(isOpen).map((t) => t.id)).toEqual(fromSql);
  });

  it("maps rows to camelCase, converts numerics and defaults arrays, and leaves the description behind", async () => {
    fakeDb({
      tables: {
        tasks: [
          taskRow({
            id: "t_map",
            tags: null,
            estimated_hours: "2.5",
            client_name: "Acme",
            project_id: "proj_1",
            stage_id: "stg_1",
            due_date: "2026-11-03T22:00:00.000Z",
            archived_at: "2026-11-03T02:00:00.000Z"
          })
        ]
      }
    });
    const [t] = await listOpenTasks(principal);
    const expected: DdTask = {
      id: "t_map",
      title: "Fix the contact form",
      status: "pending",
      priority: "medium",
      tags: [],
      departmentId: "dep_web",
      assigneeId: "u_1",
      creatorId: "u_2",
      projectId: "proj_1",
      stageId: "stg_1",
      clientName: "Acme",
      dueDate: "2026-11-03T22:00:00.000Z",
      createdAt: "2026-10-01T10:00:00.000Z",
      completedAt: null,
      lastActivityAt: "2026-11-01T10:00:00.000Z",
      archivedAt: "2026-11-03T02:00:00.000Z",
      archivedBy: null,
      isDraft: false,
      deletedAt: null,
      estimatedHours: 2.5
    };
    expect(t).toEqual(expected);
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });

  it("passes the signal to every page", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => taskRow({ id: `t_${String(i).padStart(5, "0")}` }));
    const db = fakeDb({ tables: { tasks: rows } });
    const controller = new AbortController();
    await listOpenTasks(principal, { signal: controller.signal });
    expect(db.queries).toHaveLength(2);
    for (const q of db.queries) expect(q.signal).toBe(controller.signal);
  });

  it("fails closed when the signal has already fired", async () => {
    fakeDb({ tables: { tasks: [taskRow()] } });
    const controller = new AbortController();
    controller.abort();
    await expect(listOpenTasks(principal, { signal: controller.signal })).rejects.toThrow(/AbortError/);
  });
});

describe("paging", () => {
  it("reads every page in id order until a short page, whatever order the table holds them in", async () => {
    const ids = Array.from({ length: 2345 }, (_, i) => `t_${String(i).padStart(5, "0")}`);
    const shuffled = [...ids].reverse().map((id) => taskRow({ id }));
    const db = fakeDb({ tables: { tasks: shuffled } });
    const got = await listOpenTasks(principal);
    expect(got.map((t) => t.id)).toEqual(ids);
    expect(db.queries.map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999]
    ]);
    for (const q of db.queries) expect(q.orders).toEqual([{ column: "id", ascending: true }]);
  });

  it("asks once more after an exactly full page, and stops at the empty one", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => taskRow({ id: `t_${String(i).padStart(5, "0")}` }));
    const db = fakeDb({ tables: { tasks: rows } });
    expect(await listOpenTasks(principal)).toHaveLength(1000);
    expect(db.queries).toHaveLength(2);
  });

  it("throws past 50 full pages instead of returning a truncated list", async () => {
    const db = fakeDb({
      serve: (q) => {
        const [from, to] = q.range ?? [0, 0];
        return Array.from({ length: to - from + 1 }, (_, i) => taskRow({ id: `t_${from + i}` }));
      }
    });
    const read = listOpenTasks(principal);
    await expect(read).rejects.toBeInstanceOf(DdReadError);
    await expect(read).rejects.toThrow(/too many rows/);
    expect(db.queries).toHaveLength(50);
  });

  it("fails closed on an error in a later page: no partial list", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => taskRow({ id: `t_${String(i).padStart(5, "0")}` }));
    fakeDb({ tables: { tasks: rows }, fail: (q) => (q.range?.[0] === 1000 ? "upstream timeout" : null) });
    const read = listOpenTasks(principal);
    await expect(read).rejects.toBeInstanceOf(DdReadError);
    await expect(read).rejects.toMatchObject({ table: "tasks", message: "DD read failed (tasks): upstream timeout" });
  });

  it("fails closed on a reply with no rows array", async () => {
    fakeDb({ respond: () => ({ data: null }) });
    await expect(listOpenTasks(principal)).rejects.toThrow(/no rows/);
  });
});

describe("listTasksCompletedBetween / listTasksCreatedBetween", () => {
  const FROM = "2026-11-04T05:00:00.000Z";
  const TO = "2026-11-05T05:00:00.000Z";

  it("returns done tasks completed in [from, to), archived ones included, drafts and deleted rows not", async () => {
    const db = fakeDb({
      tables: {
        tasks: [
          taskRow({ id: "t_start", status: "done", completed_at: FROM }),
          taskRow({ id: "t_mid", status: "done", completed_at: "2026-11-04T12:00:00.000Z", archived_at: "2026-11-04T13:00:00.000Z", archived_by: "u_1" }),
          taskRow({ id: "t_end", status: "done", completed_at: TO }),
          taskRow({ id: "t_before", status: "done", completed_at: "2026-11-04T04:59:59.999Z" }),
          taskRow({ id: "t_reopened", status: "in_progress", completed_at: "2026-11-04T12:00:00.000Z" }),
          taskRow({ id: "t_draft", status: "done", completed_at: "2026-11-04T12:00:00.000Z", is_draft: true }),
          taskRow({ id: "t_deleted", status: "done", completed_at: "2026-11-04T12:00:00.000Z", deleted_at: "2026-11-04T14:00:00.000Z" })
        ]
      }
    });
    const got = await listTasksCompletedBetween(principal, FROM, TO);
    expect(got.map((t) => t.id)).toEqual(["t_mid", "t_start"]);
    expect(filtersOf(db.queries[0])).toEqual([
      { kind: "cmp", op: "eq", column: "status", value: "done" },
      { kind: "cmp", op: "gte", column: "completed_at", value: FROM },
      { kind: "cmp", op: "lt", column: "completed_at", value: TO },
      { kind: "cmp", op: "eq", column: "is_draft", value: false },
      { kind: "is", column: "deleted_at", value: null }
    ]);
  });

  it("returns tasks created in [from, to), done ones included, without drafts, deleted rows or rejected drafts", async () => {
    const db = fakeDb({
      tables: {
        tasks: [
          taskRow({ id: "t_a", created_at: FROM, status: "done" }),
          taskRow({ id: "t_b", created_at: "2026-11-04T20:00:00.000Z", status: "rejected" }),
          taskRow({ id: "t_c", created_at: TO }),
          taskRow({ id: "t_d", created_at: "2026-11-04T20:00:00.000Z", is_draft: true }),
          taskRow({ id: "t_e", created_at: "2026-11-04T20:00:00.000Z", deleted_at: "2026-11-04T21:00:00.000Z" })
        ]
      }
    });
    const got = await listTasksCreatedBetween(principal, FROM, TO);
    expect(got.map((t) => t.id)).toEqual(["t_a"]);
    expect(filtersOf(db.queries[0])).toEqual([
      { kind: "cmp", op: "gte", column: "created_at", value: FROM },
      { kind: "cmp", op: "lt", column: "created_at", value: TO },
      { kind: "cmp", op: "eq", column: "is_draft", value: false },
      { kind: "is", column: "deleted_at", value: null },
      { kind: "cmp", op: "neq", column: "status", value: "rejected" }
    ]);
  });

  it("canonicalises the window and refuses bad or reversed bounds before querying", async () => {
    const db = fakeDb({ tables: { tasks: [] } });
    await listTasksCreatedBetween(principal, "2026-11-04T00:00:00-05:00", "2026-11-05T00:00:00-05:00");
    expect(filtersOf(db.queries[0]).slice(0, 2)).toEqual([
      { kind: "cmp", op: "gte", column: "created_at", value: "2026-11-04T05:00:00.000Z" },
      { kind: "cmp", op: "lt", column: "created_at", value: "2026-11-05T05:00:00.000Z" }
    ]);
    await expect(listTasksCompletedBetween(principal, "yesterday", TO)).rejects.toThrow(TypeError);
    await expect(listTasksCompletedBetween(principal, TO, FROM)).rejects.toThrow(/after/);
    expect(db.queries).toHaveLength(1);
  });
});

describe("listTasksByIds", () => {
  it("dedupes, drops empty ids and chunks the filter at 200", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `t_${String(i).padStart(4, "0")}`);
    const rows = ids.map((id) => taskRow({ id }));
    const db = fakeDb({ tables: { tasks: rows } });
    const got = await listTasksByIds(principal, [...ids, ...ids.slice(0, 10), ""]);
    expect(got).toHaveLength(450);
    const sizes = db.queries.map((q) => {
      const [f] = q.filters;
      return f.kind === "in" && f.column === "id" ? f.values.length : -1;
    });
    expect(sizes).toEqual([200, 200, 50]);
    expect(new Set(db.queries.flatMap((q) => (q.filters[0].kind === "in" ? q.filters[0].values : []))).size).toBe(450);
  });

  it("returns rows in any state, so callers can see drafts and deletions", async () => {
    fakeDb({ tables: { tasks: [taskRow({ id: "t_d", is_draft: true }), taskRow({ id: "t_x", deleted_at: "2026-11-01T00:00:00.000Z" })] } });
    const got = await listTasksByIds(principal, ["t_d", "t_x"]);
    expect(got.map((t) => [t.id, t.isDraft, t.deletedAt])).toEqual([
      ["t_d", true, null],
      ["t_x", false, "2026-11-01T00:00:00.000Z"]
    ]);
  });

  it("makes no query for no ids", async () => {
    const db = fakeDb();
    expect(await listTasksByIds(principal, [])).toEqual([]);
    expect(db.queries).toHaveLength(0);
  });
});

describe("countOpenOverdueTasks", () => {
  it("head-counts open tasks past due, auto-archived ones included and incidents not", async () => {
    const db = fakeDb({
      tables: {
        tasks: [
          taskRow({ id: "t_1", due_date: "2026-11-03T00:00:00.000Z" }),
          taskRow({ id: "t_2", due_date: "2026-10-01T00:00:00.000Z", archived_at: "2026-10-12T02:00:00.000Z", archived_by: null }),
          taskRow({ id: "t_3", due_date: "2026-10-01T00:00:00.000Z", archived_at: "2026-10-12T02:00:00.000Z", archived_by: "u_1" }),
          taskRow({ id: "t_4", due_date: "2026-11-30T00:00:00.000Z" }),
          taskRow({ id: "t_5", due_date: null }),
          taskRow({ id: "t_6", due_date: "2026-11-03T00:00:00.000Z", status: "done" }),
          taskRow({ id: "t_7", due_date: "2026-11-03T00:00:00.000Z", status: "rejected" }),
          // Due the minute it was reported: the Overview's tile and the feed don't count it as late work either.
          taskRow({ id: "t_8", due_date: "2026-11-03T00:00:00.000Z", status: "urgent", tags: ["urgent", "incident"] })
        ]
      }
    });
    expect(await countOpenOverdueTasks(principal, NOW.toISOString())).toBe(2);
    const [q] = db.queries;
    expect(q).toMatchObject({ head: true, count: "exact", columns: "id" });
    expect(filtersOf(q).slice(4)).toEqual([
      { kind: "cmp", op: "lt", column: "due_date", value: NOW.toISOString() },
      { kind: "not", column: "tags", operator: "cs", value: "{incident}" }
    ]);
    expect(filtersOf(q).slice(0, 4)).toEqual(OPEN_FILTERS);
  });

  it("fails closed on an error or a missing count", async () => {
    fakeDb({ fail: () => "permission denied" });
    await expect(countOpenOverdueTasks(principal, NOW.toISOString())).rejects.toMatchObject({ table: "tasks" });
    fakeDb({ respond: () => ({ count: null }) });
    await expect(countOpenOverdueTasks(principal, NOW.toISOString())).rejects.toThrow(/no count/);
  });

  it("passes the signal", async () => {
    const db = fakeDb({ tables: { tasks: [] } });
    const controller = new AbortController();
    await countOpenOverdueTasks(principal, NOW.toISOString(), { signal: controller.signal });
    expect(db.queries[0].signal).toBe(controller.signal);
  });
});

describe("listUsers", () => {
  const userRow = (over: Row = {}): Row => ({
    id: "u_1",
    name: "Sam",
    email: "sam@scaledai.org",
    role: "worker",
    is_admin: false,
    work_timezone: "Asia/Karachi",
    manager_user_id: "u_2",
    slack_user_token: "xoxp-SECRET",
    google_access_token: "ya29.SECRET",
    google_refresh_token: "1//SECRET",
    ...over
  });

  it("selects no token column (users holds plaintext Slack and Google tokens)", async () => {
    const db = fakeDb({ tables: { users: [userRow()], department_members: [] } });
    const users = await listUsers(principal);
    const q = db.on("users")[0];
    expect(q.columns).toBe("id,name,email,role,is_admin,work_timezone,manager_user_id");
    expect(q.columns).not.toMatch(/token|secret|\*/i);
    expect(JSON.stringify(users)).not.toContain("SECRET");
  });

  it("lists departments primary-first by (created_at, department_id), paged on a unique order", async () => {
    const db = fakeDb({
      tables: {
        users: [userRow(), userRow({ id: "u_2", name: "Ana", is_admin: null, manager_user_id: null }), userRow({ id: "u_3", name: "Lee" })],
        department_members: [
          { user_id: "u_1", department_id: "dep_web", created_at: "2026-05-05T00:00:00+00:00" },
          { user_id: "u_1", department_id: "dep_facebook", created_at: "2026-08-26T00:00:00+00:00" },
          { user_id: "u_2", department_id: "dep_web", created_at: "2026-05-05T00:00:00+00:00" },
          { user_id: "u_1", department_id: "dep_seo", created_at: "2026-05-05T00:00:00+00:00" }
        ]
      }
    });
    const users = await listUsers(principal);
    expect(users).toEqual([
      {
        id: "u_1",
        name: "Sam",
        email: "sam@scaledai.org",
        role: "worker",
        isAdmin: false,
        workTimezone: "Asia/Karachi",
        managerUserId: "u_2",
        departmentIds: ["dep_seo", "dep_web", "dep_facebook"]
      },
      { id: "u_2", name: "Ana", email: "sam@scaledai.org", role: "worker", isAdmin: false, workTimezone: "Asia/Karachi", managerUserId: null, departmentIds: ["dep_web"] },
      { id: "u_3", name: "Lee", email: "sam@scaledai.org", role: "worker", isAdmin: false, workTimezone: "Asia/Karachi", managerUserId: "u_2", departmentIds: [] }
    ]);
    expect(db.on("department_members")[0].orders).toEqual([
      { column: "created_at", ascending: true },
      { column: "department_id", ascending: true },
      { column: "user_id", ascending: true }
    ]);
  });

  it("fails closed when memberships can't be read (no user would show with empty departments)", async () => {
    fakeDb({ tables: { users: [userRow()] }, fail: (q) => (q.table === "department_members" ? "relation missing" : null) });
    await expect(listUsers(principal)).rejects.toMatchObject({ table: "department_members" });
  });
});

describe("listDepartments / listProjects / listProjectStages / listClients", () => {
  it("reads departments with their head", async () => {
    const db = fakeDb({
      tables: {
        departments: [
          { id: "dep_web", name: "Web", head_user_id: "u_5", description: "SECRET" },
          { id: "dep_mkt", name: "Marketing", head_user_id: null, description: null }
        ]
      }
    });
    expect(await listDepartments(principal)).toEqual([
      { id: "dep_mkt", name: "Marketing", headUserId: null },
      { id: "dep_web", name: "Web", headUserId: "u_5" }
    ]);
    expect(db.queries[0].columns).toBe("id,name,head_user_id");
  });

  it("reads projects without their description", async () => {
    const db = fakeDb({
      tables: { projects: [{ id: "proj_1", name: "Site rebuild", description: "SECRET", department_id: "dep_web", created_at: "2026-09-01T00:00:00.000Z" }] }
    });
    expect(await listProjects(principal)).toEqual([{ id: "proj_1", name: "Site rebuild", departmentId: "dep_web", createdAt: "2026-09-01T00:00:00.000Z" }]);
    expect(db.queries[0].columns).not.toContain("description");
  });

  const stageRow = (over: Row = {}): Row => ({
    id: "stg_1",
    project_id: "proj_1",
    position: 0,
    name: "Scope",
    kind: "scope",
    status: "active",
    notes: "SECRET notes",
    is_it: ["SECRET"],
    updated_at: "2026-10-01T00:00:00.000Z",
    ...over
  });

  it("reads the stages of the given projects in chunks, or of every project, without notes", async () => {
    const stages = [stageRow(), stageRow({ id: "stg_2", position: "1", status: "locked", kind: null }), stageRow({ id: "stg_9", project_id: "proj_9" })];
    let db = fakeDb({ tables: { project_stages: stages } });
    const some = await listProjectStages(principal, ["proj_1", "proj_1"]);
    expect(some.map((s) => s.id)).toEqual(["stg_1", "stg_2"]);
    expect(some[1]).toEqual({ id: "stg_2", projectId: "proj_1", position: 1, name: "Scope", kind: "custom", status: "locked", updatedAt: "2026-10-01T00:00:00.000Z" });
    expect(db.queries[0].filters).toEqual([{ kind: "in", column: "project_id", values: ["proj_1"] }]);
    expect(db.queries[0].columns).toBe("id,project_id,position,name,kind,status,updated_at");

    db = fakeDb({ tables: { project_stages: stages } });
    expect(await listProjectStages(principal)).toHaveLength(3);
    expect(db.queries[0].filters).toEqual([]);

    db = fakeDb({ tables: { project_stages: stages } });
    expect(await listProjectStages(principal, [])).toEqual([]);
    expect(db.queries).toHaveLength(0);

    const many = Array.from({ length: 401 }, (_, i) => `proj_${i}`);
    db = fakeDb({ tables: { project_stages: stages } });
    await listProjectStages(principal, many);
    expect(db.queries).toHaveLength(3);
  });

  it("reads clients' health and touchpoint columns, never their notes or summaries", async () => {
    const db = fakeDb({
      tables: {
        clients: [
          {
            id: "cl_1",
            name: "Acme",
            status: null,
            notes: "SECRET",
            health_summary: "SECRET",
            health_override_note: "SECRET",
            touchpoint_summary: "SECRET",
            touchpoint_override_note: "SECRET",
            last_outbound_subject_external: "SECRET",
            health_score: "82.5",
            health_label: "steady",
            health_sample_size: "40",
            health_computed_at: "2026-10-01T00:00:00.000Z",
            health_override_label: "shaky",
            health_override_by: "u_owner",
            health_override_at: "2026-10-02T00:00:00.000Z",
            touchpoint_override_label: null,
            touchpoint_override_by: null,
            touchpoint_override_at: null,
            last_outbound_email_at_external: "2026-10-28T15:00:00.000Z",
            touchpoint_synced_at: "2026-10-29T00:00:00.000Z"
          }
        ]
      }
    });
    const [c] = await listClients(principal);
    expect(c).toEqual({
      id: "cl_1",
      name: "Acme",
      status: "active",
      healthScore: 82.5,
      healthLabel: "steady",
      healthSampleSize: 40,
      healthComputedAt: "2026-10-01T00:00:00.000Z",
      healthOverrideLabel: "shaky",
      healthOverrideBy: "u_owner",
      healthOverrideAt: "2026-10-02T00:00:00.000Z",
      touchpointOverrideLabel: null,
      touchpointOverrideBy: null,
      touchpointOverrideAt: null,
      lastOutboundEmailAtExternal: "2026-10-28T15:00:00.000Z",
      touchpointSyncedAt: "2026-10-29T00:00:00.000Z"
    });
    expect(db.queries[0].columns).not.toMatch(/notes|summary|subject/);
    expect(JSON.stringify(c)).not.toContain("SECRET");
  });

  it("keeps a null health score null", async () => {
    fakeDb({
      tables: {
        clients: [
          {
            id: "cl_2",
            name: "Beta",
            status: "paused",
            health_score: null,
            health_label: null,
            health_sample_size: null,
            health_computed_at: null,
            health_override_label: null,
            health_override_by: null,
            health_override_at: null,
            touchpoint_override_label: "red",
            touchpoint_override_by: "u_1",
            touchpoint_override_at: "2026-10-03T00:00:00.000Z",
            last_outbound_email_at_external: null,
            touchpoint_synced_at: null
          }
        ]
      }
    });
    const [c] = await listClients(principal);
    expect(c).toMatchObject({ status: "paused", healthScore: null, healthSampleSize: null, touchpointOverrideLabel: "red" });
  });
});

describe("task timelines", () => {
  const SINCE = "2026-10-21T00:00:00.000Z";
  const activityRow = (over: Row = {}): Row => ({
    id: "a_1",
    task_id: "t_1",
    user_id: "u_1",
    action: "comment",
    detail: "SECRET comment body",
    mentioned_user_ids: [],
    created_at: "2026-11-01T00:00:00.000Z",
    ...over
  });

  it("listActivitySince never selects the detail, and applies each filter it is given", async () => {
    const db = fakeDb({
      tables: {
        activity_logs: [
          activityRow(),
          activityRow({ id: "a_2", task_id: "t_2", user_id: "u_owner", action: "status_change" }),
          activityRow({ id: "a_3", created_at: "2026-10-01T00:00:00.000Z" })
        ]
      }
    });
    const all = await listActivitySince(principal, SINCE, {});
    expect(all).toEqual([
      { id: "a_1", taskId: "t_1", userId: "u_1", action: "comment", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "a_2", taskId: "t_2", userId: "u_owner", action: "status_change", createdAt: "2026-11-01T00:00:00.000Z" }
    ]);
    expect(db.queries[0].columns).toBe("id,task_id,user_id,action,created_at");
    expect(JSON.stringify(all)).not.toContain("SECRET");

    const narrowed = await listActivitySince(principal, SINCE, { taskIds: ["t_2", "t_1"], userId: "u_owner", actions: ["status_change"] });
    expect(narrowed.map((a) => a.id)).toEqual(["a_2"]);
    expect(db.queries[1].filters).toEqual([
      { kind: "cmp", op: "gte", column: "created_at", value: SINCE },
      { kind: "in", column: "task_id", values: ["t_2", "t_1"] },
      { kind: "cmp", op: "eq", column: "user_id", value: "u_owner" },
      { kind: "in", column: "action", values: ["status_change"] }
    ]);
  });

  it("listActivitySince reads nothing for an empty id or action filter, and chunks task ids", async () => {
    const db = fakeDb({ tables: { activity_logs: [activityRow()] } });
    expect(await listActivitySince(principal, SINCE, { taskIds: [] })).toEqual([]);
    expect(await listActivitySince(principal, SINCE, { actions: [] })).toEqual([]);
    expect(db.queries).toHaveLength(0);
    await listActivitySince(principal, SINCE, { taskIds: Array.from({ length: 201 }, (_, i) => `t_${i}`) });
    expect(db.queries).toHaveLength(2);
  });

  it("listStatusChangeEntries returns the latest entry into the status per task, and nothing of the text", async () => {
    const db = fakeDb({
      tables: {
        activity_logs: [
          activityRow({ id: "a_1", task_id: "t_1", action: "status_change", detail: "in_progress → waiting_on_client", created_at: "2026-10-01T10:00:00.000Z" }),
          activityRow({ id: "a_2", task_id: "t_1", action: "status_change", detail: "waiting_on_client → in_progress", created_at: "2026-10-05T10:00:00.000Z" }),
          activityRow({
            id: "a_3",
            task_id: "t_1",
            action: "status_change",
            detail: "in_progress → waiting_on_client\nSECRET: client went quiet",
            created_at: "2026-10-09T10:00:00.000Z"
          }),
          // The comment line mentions the status; only the first line counts.
          activityRow({
            id: "a_4",
            task_id: "t_2",
            action: "status_change",
            detail: "pending → in_progress\nSECRET moved from → waiting_on_client yesterday",
            created_at: "2026-10-20T10:00:00.000Z"
          }),
          activityRow({ id: "a_5", task_id: "t_3", action: "status_change", detail: "pending → waiting_on_client", created_at: "2026-10-15T10:00:00.000Z" }),
          activityRow({ id: "a_6", task_id: "t_3", action: "comment", detail: "pending → waiting_on_client", created_at: "2026-10-30T10:00:00.000Z" }),
          activityRow({ id: "a_7", task_id: "t_4", action: "status_change", detail: null, created_at: "2026-10-15T10:00:00.000Z" })
        ]
      }
    });
    const entries = await listStatusChangeEntries(principal, ["t_3", "t_1", "t_2", "t_4"], "waiting_on_client");
    expect(entries).toEqual([
      { taskId: "t_1", enteredAt: "2026-10-09T10:00:00.000Z" },
      { taskId: "t_3", enteredAt: "2026-10-15T10:00:00.000Z" }
    ]);
    for (const e of entries) expect(Object.keys(e).sort()).toEqual(["enteredAt", "taskId"]);
    expect(JSON.stringify(entries)).not.toMatch(/SECRET|client went quiet|→/);
    expect(db.queries[0].filters).toEqual([
      { kind: "cmp", op: "eq", column: "action", value: "status_change" },
      { kind: "in", column: "task_id", values: ["t_3", "t_1", "t_2", "t_4"] }
    ]);
  });

  it("listStatusChangeEntries reads the timer's transition too, and nothing for no task ids", async () => {
    const db = fakeDb({
      tables: {
        activity_logs: [activityRow({ id: "a_1", task_id: "t_9", action: "status_change", detail: "pending → in_progress (timer started)" })]
      }
    });
    expect(await listStatusChangeEntries(principal, ["t_9"], "in_progress")).toEqual([{ taskId: "t_9", enteredAt: "2026-11-01T00:00:00.000Z" }]);
    expect(await listStatusChangeEntries(principal, [], "in_progress")).toEqual([]);
    expect(db.queries).toHaveLength(1);
  });

  it("listTaskMessagesSince reads no bodies", async () => {
    const db = fakeDb({
      tables: {
        task_messages: [
          { id: "m_1", task_id: "t_1", user_id: null, body: "SECRET body", image_url: null, created_at: "2026-11-01T00:00:00.000Z" },
          { id: "m_2", task_id: "t_2", user_id: "u_owner", body: "SECRET", image_url: null, created_at: "2026-11-02T00:00:00.000Z" }
        ]
      }
    });
    const all = await listTaskMessagesSince(principal, SINCE, {});
    expect(all).toEqual([
      { id: "m_1", taskId: "t_1", userId: null, createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "m_2", taskId: "t_2", userId: "u_owner", createdAt: "2026-11-02T00:00:00.000Z" }
    ]);
    expect(db.queries[0].columns).toBe("id,task_id,user_id,created_at");
    expect((await listTaskMessagesSince(principal, SINCE, { taskIds: ["t_2"], userId: "u_owner" })).map((m) => m.id)).toEqual(["m_2"]);
    expect(await listTaskMessagesSince(principal, SINCE, { taskIds: [] })).toEqual([]);
    expect(db.queries).toHaveLength(2);
  });

  it("listTaskNotificationsForUser reads the recipient's notifications of the given kinds, without notes", async () => {
    const note = (over: Row): Row => ({
      id: "n_1",
      task_id: "t_1",
      user_id: "u_owner",
      from_user_id: "u_1",
      kind: "mention",
      note: "SECRET note",
      seen_at: null,
      created_at: "2026-11-01T00:00:00.000Z",
      ...over
    });
    const db = fakeDb({
      tables: {
        task_notifications: [
          note({}),
          note({ id: "n_2", kind: "notified", from_user_id: null, seen_at: "2026-11-01T01:00:00.000Z" }),
          note({ id: "n_3", user_id: "u_other" }),
          note({ id: "n_4", created_at: "2026-10-01T00:00:00.000Z" })
        ]
      }
    });
    const got = await listTaskNotificationsForUser(principal, "u_owner", SINCE, ["mention", "notified"]);
    expect(got).toEqual([
      { id: "n_1", userId: "u_owner", taskId: "t_1", kind: "mention", actorId: "u_1", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "n_2", userId: "u_owner", taskId: "t_1", kind: "notified", actorId: null, createdAt: "2026-11-01T00:00:00.000Z" }
    ]);
    expect(db.queries[0].columns).toBe("id,user_id,task_id,kind,from_user_id,created_at");
    expect(await listTaskNotificationsForUser(principal, "u_owner", SINCE, [])).toEqual([]);
    expect(db.queries).toHaveLength(1);
  });

  it("listTaskExtensionsSince reads no reasons", async () => {
    const db = fakeDb({
      tables: {
        task_extensions: [
          {
            id: "ext_1",
            task_id: "t_1",
            user_id: "u_1",
            previous_due_date: null,
            new_due_date: "2026-11-06T00:00:00.000Z",
            hours_added: "48.00",
            reason: "SECRET reason",
            created_at: "2026-11-04T00:00:00.000Z"
          }
        ]
      }
    });
    expect(await listTaskExtensionsSince(principal, SINCE)).toEqual([
      { id: "ext_1", taskId: "t_1", userId: "u_1", previousDueDate: null, newDueDate: "2026-11-06T00:00:00.000Z", createdAt: "2026-11-04T00:00:00.000Z" }
    ]);
    expect(db.queries[0].columns).not.toContain("reason");
  });
});

describe("operations", () => {
  const SINCE = "2026-08-06T00:00:00.000Z";

  it("listIncidentLogsSince reads no descriptions", async () => {
    const db = fakeDb({
      tables: {
        incident_logs: [
          { id: "i_1", issue_type: "site down", affected_url: "https://acme.com", description: "SECRET", assigned_to_id: "u_1", resolved_at: null, created_at: "2026-11-01T00:00:00.000Z" },
          { id: "i_0", issue_type: "malware", affected_url: null, description: "SECRET", assigned_to_id: null, resolved_at: null, created_at: "2026-01-01T00:00:00.000Z" }
        ]
      }
    });
    expect(await listIncidentLogsSince(principal, SINCE)).toEqual([
      { id: "i_1", issueType: "site down", affectedUrl: "https://acme.com", createdAt: "2026-11-01T00:00:00.000Z" }
    ]);
    expect(db.queries[0].columns).toBe("id,issue_type,affected_url,created_at");
  });

  it("listSiteHealthAlertsSince leaves out healthy scans but keeps alerts with a NULL skipped_reason", async () => {
    const alert = (over: Row): Row => ({
      id: "sha_1",
      source: "slack",
      source_event_id: "e1",
      reference: "SECRET",
      website: "https://www.acme.com",
      domain: "acme.com",
      site_score: 41,
      threshold: 70,
      priority: "high",
      task_id: "t_1",
      skipped_reason: null,
      detected_at: "2026-11-01T00:00:00.000Z",
      created_at: "2026-11-01T00:00:00.000Z",
      ...over
    });
    const db = fakeDb({
      tables: {
        site_health_alerts: [
          alert({}),
          alert({ id: "sha_2", skipped_reason: "above-threshold", site_score: 92, priority: null, task_id: null }),
          alert({ id: "sha_3", skipped_reason: "no-assignee", site_score: "55", priority: "medium", task_id: null, domain: null }),
          alert({ id: "sha_4", priority: "urgent" })
        ]
      }
    });
    const got = await listSiteHealthAlertsSince(principal, SINCE);
    expect(got).toEqual([
      { id: "sha_1", website: "https://www.acme.com", domain: "acme.com", score: 41, threshold: 70, priority: "high", taskId: "t_1", skippedReason: null, createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "sha_3", website: "https://www.acme.com", domain: null, score: 55, threshold: 70, priority: "medium", taskId: null, skippedReason: "no-assignee", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "sha_4", website: "https://www.acme.com", domain: "acme.com", score: 41, threshold: 70, priority: null, taskId: "t_1", skippedReason: null, createdAt: "2026-11-01T00:00:00.000Z" }
    ]);
    expect(db.queries[0].filters).toContainEqual({ kind: "or", expr: "skipped_reason.is.null,skipped_reason.neq.above-threshold" });
    expect(db.queries[0].columns).not.toContain("reference");
  });

  it("listTimeEntriesBetween returns every segment overlapping [from, to), running ones included", async () => {
    const FROM = "2026-11-04T05:00:00.000Z";
    const TO = "2026-11-05T05:00:00.000Z";
    const entry = (id: string, started: string, ended: string | null): Row => ({
      id,
      user_id: "u_1",
      task_id: null,
      started_at: started,
      ended_at: ended,
      note: "SECRET",
      created_at: started
    });
    const db = fakeDb({
      tables: {
        time_entries: [
          entry("te_before", "2026-11-03T20:00:00.000Z", "2026-11-04T04:59:00.000Z"),
          entry("te_edge_end", "2026-11-03T20:00:00.000Z", FROM),
          entry("te_across", "2026-11-04T03:00:00.000Z", "2026-11-04T07:00:00.000Z"),
          entry("te_inside", "2026-11-04T14:00:00.000Z", "2026-11-04T15:00:00.000Z"),
          entry("te_running", "2026-11-04T16:00:00.000Z", null),
          entry("te_old_running", "2026-11-02T16:00:00.000Z", null),
          entry("te_at_end", TO, null)
        ]
      }
    });
    const got = await listTimeEntriesBetween(principal, FROM, TO);
    expect(got.map((e) => e.id).sort()).toEqual(["te_across", "te_edge_end", "te_inside", "te_old_running", "te_running"]);
    expect(got.find((e) => e.id === "te_running")).toEqual({ id: "te_running", userId: "u_1", taskId: null, startedAt: "2026-11-04T16:00:00.000Z", endedAt: null });
    expect(db.queries[0].filters).toEqual([
      { kind: "cmp", op: "lt", column: "started_at", value: TO },
      { kind: "or", expr: `ended_at.is.null,ended_at.gte.${FROM}` }
    ]);
  });

  it("listEodNotesForDate reads one ET day's status and none of the text", async () => {
    const db = fakeDb({
      tables: {
        eod_notes: [
          { id: "eod_u_1_2026-11-04", user_id: "u_1", note_date: "2026-11-04", note: "", accomplished: "SECRET", blockers: "SECRET", submitted_at: "2026-11-04T22:00:00.000Z", reviewed_at: null },
          { id: "eod_u_2_2026-11-04", user_id: "u_2", note_date: "2026-11-04", note: "", accomplished: null, blockers: null, submitted_at: null, reviewed_at: null },
          { id: "eod_u_1_2026-11-03", user_id: "u_1", note_date: "2026-11-03", note: "", accomplished: null, blockers: null, submitted_at: "2026-11-03T22:00:00.000Z", reviewed_at: "2026-11-04T09:00:00.000Z" }
        ]
      }
    });
    const got = await listEodNotesForDate(principal, "2026-11-04");
    expect(got).toEqual([
      { userId: "u_1", noteDate: "2026-11-04", submittedAt: "2026-11-04T22:00:00.000Z", reviewedAt: null },
      { userId: "u_2", noteDate: "2026-11-04", submittedAt: null, reviewedAt: null }
    ]);
    expect(db.queries[0].columns).toBe("user_id,note_date,submitted_at,reviewed_at");
    expect(JSON.stringify(got)).not.toContain("SECRET");
  });

  it("listEodNotesForDate refuses anything but a real YYYY-MM-DD date", async () => {
    const db = fakeDb();
    for (const bad of ["2026-02-30", "11/04/2026", "2026-11-4", ""]) {
      await expect(listEodNotesForDate(principal, bad)).rejects.toThrow(TypeError);
    }
    expect(db.queries).toHaveLength(0);
  });

  it("refuses an unreadable since before querying", async () => {
    const db = fakeDb();
    await expect(listIncidentLogsSince(principal, "not a date")).rejects.toThrow(TypeError);
    await expect(listTimeEntriesBetween(principal, "2026-11-05T00:00:00.000Z", "2026-11-04T00:00:00.000Z")).rejects.toThrow(TypeError);
    expect(db.queries).toHaveLength(0);
  });
});

describe("getPendingApprovals", () => {
  function approvalTables(): Record<string, Row[]> {
    return {
      tasks: [
        taskRow({ id: "t_draft1", is_draft: true, created_at: "2026-11-01T09:00:00.000Z" }),
        taskRow({ id: "t_draft2", is_draft: true, created_at: "2026-11-03T09:00:00.000Z", status: "rejected" }),
        taskRow({ id: "t_draft_deleted", is_draft: true, created_at: "2026-10-01T09:00:00.000Z", deleted_at: "2026-10-02T00:00:00.000Z" }),
        taskRow({ id: "t_fb1", status: "pending_approval", created_at: "2026-09-01T00:00:00.000Z" }),
        taskRow({ id: "t_fb2", status: "pending_approval", created_at: "2026-10-15T00:00:00.000Z" }),
        taskRow({ id: "t_fb_deleted", status: "pending_approval", deleted_at: "2026-10-21T00:00:00.000Z" }),
        taskRow({ id: "t_fb_done", status: "done", completed_at: "2026-10-12T00:00:00.000Z" })
      ],
      fb_proof: [
        { task_id: "t_fb1", submitted_at: "2026-11-03T15:00:00.000Z", review_status: "pending", work_done: "SECRET" },
        { task_id: "t_fb2", submitted_at: "2026-11-04T10:00:00.000Z", review_status: "pending", work_done: "SECRET" },
        { task_id: "t_fb_deleted", submitted_at: "2026-10-20T10:00:00.000Z", review_status: "pending", work_done: "SECRET" },
        // review_status goes stale when a PATCH moves the task on; the task status decides.
        { task_id: "t_fb_done", submitted_at: "2026-10-10T10:00:00.000Z", review_status: "pending", work_done: "SECRET" }
      ],
      email_drafts: [
        { id: "ed_1", status: "pending", dismissed_at: null, created_at: "2026-11-02T08:00:00.000Z", body_text: "SECRET" },
        { id: "ed_2", status: "pending", dismissed_at: "2026-10-02T00:00:00.000Z", created_at: "2026-10-01T08:00:00.000Z", body_text: "SECRET" },
        { id: "ed_3", status: "needs_revision", dismissed_at: null, created_at: "2026-10-15T08:00:00.000Z", body_text: "SECRET" },
        { id: "ed_4", status: "pending", dismissed_at: null, created_at: "2026-11-04T08:00:00.000Z", body_text: "SECRET" }
      ],
      email_draft_events: [
        // Only a resubmission restarts the wait; other events don't.
        { id: "ede_1", draft_id: "ed_1", type: "comment", created_at: "2026-11-03T09:00:00.000Z", body: "SECRET" },
        { id: "ede_2", draft_id: "ed_3", type: "resubmitted", created_at: "2026-10-20T09:00:00.000Z", body: "SECRET" }
      ],
      routing_decisions: [
        { id: "rd_1", needs_review: true, task_id: null, created_at: "2026-10-30T12:00:00.000Z" },
        { id: "rd_2", needs_review: true, task_id: "t_x", created_at: "2026-10-01T12:00:00.000Z" },
        { id: "rd_3", needs_review: false, task_id: null, created_at: "2026-10-01T12:00:00.000Z" }
      ],
      eod_notes: [
        { id: "eod_a", note_date: "2026-11-03", submitted_at: "2026-11-03T23:00:00.000Z", reviewed_at: null, blockers: "SECRET" },
        { id: "eod_b", note_date: "2026-10-29", submitted_at: "2026-10-29T22:00:00.000Z", reviewed_at: null, blockers: null },
        { id: "eod_c", note_date: "2026-10-28", submitted_at: "2026-10-28T22:00:00.000Z", reviewed_at: null, blockers: null },
        { id: "eod_d", note_date: "2026-11-04", submitted_at: null, reviewed_at: null, blockers: null },
        { id: "eod_e", note_date: "2026-11-02", submitted_at: "2026-11-02T22:00:00.000Z", reviewed_at: "2026-11-03T09:00:00.000Z", blockers: null }
      ],
      daily_briefings: [
        {
          id: "brief_2026-11-04",
          brief_date: "2026-11-04",
          created_at: "2026-11-04T13:00:00.000Z",
          update_text: "SECRET",
          messages: [
            { id: "m1", userId: "u_1", name: "Sam", status: "pending", text: "SECRET check-in" },
            { id: "m2", userId: "u_2", name: "Ana", status: "sent", text: "SECRET" },
            { id: "m3", userId: "u_3", name: "Lee", status: "pending", text: "SECRET" },
            { id: "m4", userId: "u_4", name: "Kim", status: "failed", text: "SECRET" },
            null,
            "junk"
          ]
        },
        {
          id: "brief_2026-11-03",
          brief_date: "2026-11-03",
          created_at: "2026-11-03T13:00:00.000Z",
          update_text: "SECRET",
          messages: [{ id: "m1", status: "pending", text: "SECRET" }]
        }
      ]
    };
  }

  it("returns all six buckets in display order with §5's predicates and when each started waiting", async () => {
    fakeDb({ tables: approvalTables() });
    const buckets = await getPendingApprovals(principal, NOW);
    expect(buckets).toEqual([
      { mechanism: "draft_tasks", count: 2, oldestAt: "2026-11-01T09:00:00.000Z" },
      // Aged from the proof submission, not the tasks' September/October creation.
      { mechanism: "fb_proofs", count: 2, oldestAt: "2026-11-03T15:00:00.000Z" },
      { mechanism: "email_drafts", count: 2, oldestAt: "2026-11-02T08:00:00.000Z" },
      { mechanism: "unrouted_mail", count: 1, oldestAt: "2026-10-30T12:00:00.000Z" },
      // ET window 2026-10-29 … 2026-11-04.
      { mechanism: "eod_reviews", count: 2, oldestAt: "2026-10-29T22:00:00.000Z" },
      // Only today's brief, only pending messages.
      { mechanism: "checkins", count: 2, oldestAt: "2026-11-04T13:00:00.000Z" }
    ]);
    expect(JSON.stringify(buckets)).not.toContain("SECRET");
  });

  it("ages an email draft from its latest resubmission: the days it spent back with its author aren't the approver's", async () => {
    const tables = approvalTables();
    // ed_1 was sent back for revision and resubmitted twice; it has waited on an approver since the last one.
    tables.email_draft_events.push(
      { id: "ede_3", draft_id: "ed_1", type: "resubmitted", created_at: "2026-11-03T10:00:00.000Z", body: "SECRET" },
      { id: "ede_4", draft_id: "ed_1", type: "resubmitted", created_at: "2026-11-04T09:30:00.000Z", body: "SECRET" }
    );
    const db = fakeDb({ tables });
    const buckets = await getPendingApprovals(principal, NOW);
    // ed_4, created at 08:00 and never sent back, is now the one that has waited longest.
    expect(buckets[2]).toEqual({ mechanism: "email_drafts", count: 2, oldestAt: "2026-11-04T08:00:00.000Z" });
    expect(JSON.stringify(buckets)).not.toContain("SECRET");
    const [events] = db.on("email_draft_events");
    expect(events.columns).toBe("draft_id,created_at");
    expect(events.filters).toEqual([
      { kind: "cmp", op: "eq", column: "type", value: "resubmitted" },
      { kind: "in", column: "draft_id", values: ["ed_1", "ed_4"] }
    ]);
  });

  it("sends exactly the predicates, head counts, and one oldest-first read of one row", async () => {
    const db = fakeDb({ tables: approvalTables() });
    await getPendingApprovals(principal, NOW);
    const heads = db.queries.filter((q) => q.head);
    expect(heads.map((q) => [q.table, q.count, q.columns, q.filters])).toEqual([
      ["tasks", "exact", "id", [{ kind: "cmp", op: "eq", column: "is_draft", value: true }, { kind: "is", column: "deleted_at", value: null }]],
      ["routing_decisions", "exact", "id", [{ kind: "cmp", op: "eq", column: "needs_review", value: true }, { kind: "is", column: "task_id", value: null }]],
      [
        "eod_notes",
        "exact",
        "id",
        [
          { kind: "not", column: "submitted_at", operator: "is", value: null },
          { kind: "is", column: "reviewed_at", value: null },
          { kind: "cmp", op: "gte", column: "note_date", value: "2026-10-29" }
        ]
      ]
    ]);
    const oldest = db.queries.filter((q) => q.limit !== null);
    expect(oldest.map((q) => [q.table, q.columns, q.orders, q.limit])).toEqual([
      ["tasks", "created_at", [{ column: "created_at", ascending: true }], 1],
      ["routing_decisions", "created_at", [{ column: "created_at", ascending: true }], 1],
      ["eod_notes", "submitted_at", [{ column: "submitted_at", ascending: true }], 1],
      ["fb_proof", "submitted_at", [{ column: "submitted_at", ascending: true }], 1]
    ]);
    const fbTasks = db.queries.find((q) => q.table === "tasks" && q.columns === "id" && !q.head);
    expect(fbTasks?.filters).toEqual([
      { kind: "cmp", op: "eq", column: "status", value: "pending_approval" },
      { kind: "is", column: "deleted_at", value: null }
    ]);
    // Email drafts are listed (no text) so each one's wait can start at its latest resubmission.
    const [drafts] = db.on("email_drafts");
    expect([drafts.columns, drafts.filters, drafts.orders]).toEqual([
      "id,created_at",
      [{ kind: "cmp", op: "eq", column: "status", value: "pending" }, { kind: "is", column: "dismissed_at", value: null }],
      [{ column: "id", ascending: true }]
    ]);
    const brief = db.on("daily_briefings")[0];
    expect(brief.filters).toEqual([{ kind: "cmp", op: "eq", column: "brief_date", value: "2026-11-04" }]);
  });

  it("counts zero with no age when nothing waits", async () => {
    fakeDb({ tables: { tasks: [], fb_proof: [], email_drafts: [], routing_decisions: [], eod_notes: [], daily_briefings: [] } });
    const buckets = await getPendingApprovals(principal, NOW);
    expect(buckets.map((b) => b.mechanism)).toEqual(["draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews", "checkins"]);
    for (const b of buckets) expect(b).toMatchObject({ count: 0, oldestAt: null });
  });

  it("never pairs a zero count with an age (the two reads aren't one snapshot)", async () => {
    fakeDb({ tables: approvalTables(), respond: (q) => (q.head && q.table === "routing_decisions" ? { count: 0 } : undefined) });
    const buckets = await getPendingApprovals(principal, NOW);
    expect(buckets.find((b) => b.mechanism === "unrouted_mail")).toEqual({ mechanism: "unrouted_mail", count: 0, oldestAt: null });
  });

  it("leaves the FB age unknown when no proof row is found, rather than guessing", async () => {
    const tables = approvalTables();
    tables.fb_proof = [];
    fakeDb({ tables });
    const buckets = await getPendingApprovals(principal, NOW);
    expect(buckets[1]).toEqual({ mechanism: "fb_proofs", count: 2, oldestAt: null });
  });

  it("uses the ET calendar day for check-ins and the EOD window", async () => {
    // 22:30 EST on Nov 4 is already Nov 5 in UTC.
    fakeDb({ tables: approvalTables() });
    const late = await getPendingApprovals(principal, new Date("2026-11-05T03:30:00.000Z"));
    expect(late[5]).toEqual({ mechanism: "checkins", count: 2, oldestAt: "2026-11-04T13:00:00.000Z" });
    // 00:30 EST on Nov 5: a new ET day with no brief yet.
    const db = fakeDb({ tables: approvalTables() });
    const next = await getPendingApprovals(principal, new Date("2026-11-05T05:30:00.000Z"));
    expect(next[5]).toEqual({ mechanism: "checkins", count: 0, oldestAt: null });
    expect(db.on("eod_notes").find((q) => q.head)?.filters.at(-1)).toEqual({ kind: "cmp", op: "gte", column: "note_date", value: "2026-10-30" });
    expect(next[4]).toEqual({ mechanism: "eod_reviews", count: 1, oldestAt: "2026-11-03T23:00:00.000Z" });
  });

  it("fails closed when any mechanism can't be read", async () => {
    for (const table of ["tasks", "fb_proof", "email_drafts", "email_draft_events", "routing_decisions", "eod_notes", "daily_briefings"]) {
      fakeDb({ tables: approvalTables(), fail: (q) => (q.table === table ? "boom" : null) });
      await expect(getPendingApprovals(principal, NOW)).rejects.toMatchObject({ name: "DdReadError", table });
    }
  });

  it("fails closed on a malformed brief or a missing count", async () => {
    const tables = approvalTables();
    tables.daily_briefings[0] = { ...tables.daily_briefings[0], messages: { m1: "pending" } };
    fakeDb({ tables });
    await expect(getPendingApprovals(principal, NOW)).rejects.toThrow(/not a list/);
    fakeDb({ tables: approvalTables(), respond: (q) => (q.head && q.table === "routing_decisions" ? { count: null } : undefined) });
    await expect(getPendingApprovals(principal, NOW)).rejects.toMatchObject({ table: "routing_decisions" });
  });

  it("refuses an invalid now and passes the signal to every query", async () => {
    const db = fakeDb({ tables: approvalTables() });
    await expect(getPendingApprovals(principal, new Date("nope"))).rejects.toThrow(TypeError);
    expect(db.queries).toHaveLength(0);
    const controller = new AbortController();
    await getPendingApprovals(principal, NOW, { signal: controller.signal });
    expect(db.queries.length).toBeGreaterThan(0);
    for (const q of db.queries) expect(q.signal).toBe(controller.signal);
  });
});

describe("every read", () => {
  const SINCE = "2026-10-01T00:00:00.000Z";
  const UNTIL = "2026-11-04T00:00:00.000Z";
  const reads: Array<[string, (signal?: AbortSignal) => Promise<unknown>, string[]]> = [
    ["listOpenTasks", (signal) => listOpenTasks(principal, { signal }), ["tasks"]],
    ["listTasksCompletedBetween", (signal) => listTasksCompletedBetween(principal, SINCE, UNTIL, { signal }), ["tasks"]],
    ["listTasksCreatedBetween", (signal) => listTasksCreatedBetween(principal, SINCE, UNTIL, { signal }), ["tasks"]],
    ["listTasksByIds", (signal) => listTasksByIds(principal, ["t_1"], { signal }), ["tasks"]],
    ["countOpenOverdueTasks", (signal) => countOpenOverdueTasks(principal, UNTIL, { signal }), ["tasks"]],
    ["listUsers", (signal) => listUsers(principal, { signal }), ["users", "department_members"]],
    ["listDepartments", (signal) => listDepartments(principal, { signal }), ["departments"]],
    ["listProjects", (signal) => listProjects(principal, { signal }), ["projects"]],
    ["listProjectStages", (signal) => listProjectStages(principal, undefined, { signal }), ["project_stages"]],
    ["listClients", (signal) => listClients(principal, { signal }), ["clients"]],
    ["listActivitySince", (signal) => listActivitySince(principal, SINCE, { taskIds: ["t_1"] }, { signal }), ["activity_logs"]],
    ["listStatusChangeEntries", (signal) => listStatusChangeEntries(principal, ["t_1"], "waiting_on_client", { signal }), ["activity_logs"]],
    ["listTaskMessagesSince", (signal) => listTaskMessagesSince(principal, SINCE, {}, { signal }), ["task_messages"]],
    ["listTaskNotificationsForUser", (signal) => listTaskNotificationsForUser(principal, "u_owner", SINCE, ["mention"], { signal }), ["task_notifications"]],
    ["listTaskExtensionsSince", (signal) => listTaskExtensionsSince(principal, SINCE, { signal }), ["task_extensions"]],
    ["listIncidentLogsSince", (signal) => listIncidentLogsSince(principal, SINCE, { signal }), ["incident_logs"]],
    ["listSiteHealthAlertsSince", (signal) => listSiteHealthAlertsSince(principal, SINCE, { signal }), ["site_health_alerts"]],
    ["listTimeEntriesBetween", (signal) => listTimeEntriesBetween(principal, SINCE, UNTIL, { signal }), ["time_entries"]],
    ["listEodNotesForDate", (signal) => listEodNotesForDate(principal, "2026-11-04", { signal }), ["eod_notes"]],
    [
      "getPendingApprovals",
      (signal) => getPendingApprovals(principal, NOW, { signal }),
      ["tasks", "fb_proof", "email_drafts", "email_draft_events", "routing_decisions", "eod_notes", "daily_briefings"]
    ]
  ];

  it.each(reads)("%s fails closed with a DdReadError naming its table", async (_name, read, tables) => {
    fakeDb({ fail: () => "connection reset" });
    const err: unknown = await read().then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(DdReadError);
    expect(tables).toContain((err as DdReadError).table);
  });

  it.each(reads)("%s passes the signal to every query it makes", async (_name, read) => {
    const db = fakeDb({ tables: {} });
    const controller = new AbortController();
    await read(controller.signal);
    expect(db.queries.length).toBeGreaterThan(0);
    for (const q of db.queries) expect(q.signal).toBe(controller.signal);
  });
});
