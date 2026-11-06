import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// sources/dd.ts, the P4 additions (contract §3.15 Y11, L19): PX14.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { principalFromRows } from "@/lib/exec/principal";
import { DdReadError, getMailTimezone, listOpenTasksForClient } from "@/lib/exec/sources/dd";
import type { ExecPrincipal } from "@/lib/exec/types";

type Row = Record<string, unknown>;
interface Seen { table: string; columns: string | null; filters: string[]; limit: number | null }

/** A chainable PostgREST stand-in: select, eq, is, in, not, or (is.null disjunctions), order, range, limit; optional failure. */
function fakeDb(tables: Record<string, Row[]>, opts: { fail?: (table: string) => string | null; seen?: Seen[] } = {}) {
  const from = (table: string) => {
    const seen: Seen = { table, columns: null, filters: [], limit: null };
    opts.seen?.push(seen);
    const filters: ((r: Row) => boolean)[] = [];
    let range: [number, number] | null = null;
    const orders: string[] = [];
    const run = () => {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const c of [...orders].reverse()) rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (seen.limit !== null) rows = rows.slice(0, seen.limit);
      const cols = seen.columns === null ? null : seen.columns.split(",").map((c) => c.trim());
      return cols === null ? rows : rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    };
    const b: Record<string, unknown> = {
      select(cols: string) {
        seen.columns = cols;
        return b;
      },
      eq(c: string, v: unknown) {
        seen.filters.push(`eq:${c}`);
        filters.push((r) => r[c] === v);
        return b;
      },
      is(c: string, v: unknown) {
        seen.filters.push(`is:${c}`);
        filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v));
        return b;
      },
      in(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[c]));
        return b;
      },
      not(c: string, op: string, v: unknown) {
        seen.filters.push(`not:${c}:${op}`);
        if (op === "in") {
          const vals = String(v).replace(/^\(|\)$/g, "").split(",");
          filters.push((r) => !vals.includes(String(r[c])));
        } else if (op === "is") filters.push((r) => r[c] !== v);
        return b;
      },
      or(expr: string) {
        seen.filters.push(`or:${expr}`);
        const parts = expr.split(",").map((p) => p.split("."));
        filters.push((r) => parts.some(([c, op, v]) => op === "is" && v === "null" && (r[c] === null || r[c] === undefined)));
        return b;
      },
      order(c: string) {
        orders.push(c);
        return b;
      },
      range(a: number, z: number) {
        range = [a, z];
        return b;
      },
      limit(n: number) {
        seen.limit = n;
        return b;
      },
      abortSignal() {
        return b;
      },
      then(resolve: (v: unknown) => void) {
        const failure = opts.fail?.(table) ?? null;
        resolve(failure === null ? { data: run(), error: null, count: null } : { data: null, error: { message: failure }, count: null });
      }
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acct_1"], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();

// Spied per test: the config's restoreMocks detaches any spy made earlier.
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getMailTimezone (PX14, L19)", () => {
  const users = (tz: unknown) => ({ users: [{ id: "u_1", work_timezone: tz, email: "mitchell@scaledai.org", slack_token: "SENTINEL_TOKEN" }, { id: "u_2", work_timezone: "Europe/Paris" }] });

  it("answers users.work_timezone when it is a valid zone", async () => {
    const seen: Seen[] = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeDb(users("America/Chicago"), { seen }));
    expect(await getMailTimezone(P)).toBe("America/Chicago");
    expect(seen).toEqual([{ table: "users", columns: "work_timezone", filters: ["eq:id"], limit: 1 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid zone", "Mars/Olympus"],
    ["an empty zone", "  "],
    ["a null zone", null],
    ["a non-string zone", 42]
  ])("answers the default for %s", async (_why, tz) => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeDb(users(tz)));
    expect(await getMailTimezone(P)).toBe("America/New_York");
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers the default when the user row is missing", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeDb({ users: [{ id: "u_9", work_timezone: "Europe/Paris" }] }));
    expect(await getMailTimezone(P)).toBe("America/New_York");
  });

  it("answers the default and logs one line on a read error (never throws)", async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeDb({}, { fail: () => "connection refused" }));
    expect(await getMailTimezone(P)).toBe("America/New_York");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("users.work_timezone");
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no client");
    });
    expect(await getMailTimezone(P)).toBe("America/New_York");
  });
});

describe("listOpenTasksForClient (PX14, C32)", () => {
  const base = {
    title: "t", status: "in_progress", priority: "high", tags: ["x"], department_id: null, assignee_id: "u_2", creator_id: "u_1", project_id: null, stage_id: null,
    client_name: "Sunrise Center", due_date: "2026-11-12", created_at: "2026-11-01T00:00:00.000Z", completed_at: null, last_activity_at: "2026-11-05T00:00:00.000Z",
    archived_at: null, archived_by: null, is_draft: false, deleted_at: null, estimated_hours: "1.5", description: "SENTINEL_DESCRIPTION"
  };
  const tasks: Row[] = [
    { ...base, id: "t_open" },
    { ...base, id: "t_auto_archived", archived_at: "2026-11-02T00:00:00.000Z", archived_by: null },
    { ...base, id: "t_shelved", archived_at: "2026-11-02T00:00:00.000Z", archived_by: "u_1" },
    { ...base, id: "t_done", status: "done", completed_at: "2026-11-03T00:00:00.000Z" },
    { ...base, id: "t_rejected", status: "rejected" },
    { ...base, id: "t_draft", is_draft: true },
    { ...base, id: "t_deleted", deleted_at: "2026-11-03T00:00:00.000Z" },
    { ...base, id: "t_other_client", client_name: "Bayview Health" },
    { ...base, id: "t_near_name", client_name: "Sunrise Center " },
    { ...base, id: "t_no_client", client_name: null }
  ];

  it("filters client_name exactly with the open predicate, paged by id, and maps DdTask columns", async () => {
    const seen: Seen[] = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeDb({ tasks }, { seen }));
    const rows = await listOpenTasksForClient(P, "Sunrise Center");
    expect(rows.map((t) => t.id)).toEqual(["t_auto_archived", "t_open"]);
    expect(rows[1]).toMatchObject({ id: "t_open", title: "t", status: "in_progress", clientName: "Sunrise Center", dueDate: "2026-11-12", estimatedHours: 1.5, isDraft: false, assigneeId: "u_2" });
    expect(Object.keys(rows[0])).not.toContain("description");
    expect(seen).toHaveLength(1);
    expect(seen[0].table).toBe("tasks");
    expect(seen[0].columns).not.toContain("description");
    expect(seen[0].columns).not.toBe("*");
    expect(seen[0].filters).toEqual(["eq:is_draft", "is:deleted_at", "not:status:in", "or:archived_at.is.null,archived_by.is.null", "eq:client_name"]);
    expect(await listOpenTasksForClient(P, "Bayview Health")).toHaveLength(1);
    expect(await listOpenTasksForClient(P, "Nobody")).toEqual([]);
  });

  it("reads nothing for an empty name, and throws DdReadError on a DD error", async () => {
    const seen: Seen[] = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeDb({ tasks }, { seen }));
    expect(await listOpenTasksForClient(P, "")).toEqual([]);
    expect(await listOpenTasksForClient(P, "   ")).toEqual([]);
    expect(seen).toEqual([]);
    vi.mocked(getSupabaseAdmin).mockReturnValue(fakeDb({ tasks }, { fail: () => "boom" }));
    await expect(listOpenTasksForClient(P, "Sunrise Center")).rejects.toThrow(DdReadError);
  });
});
