import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getTaskDescriptions, listSubmittedNotesText, listTaskMessagesText, listTaskTimelineText } from "@/lib/exec/sources/dd-text";
import { CLIP_MARKER } from "@/lib/exec/text/untrusted";
import type { ExecPrincipal } from "@/lib/exec/types";

// P5b contract §3.7 and test 39: P5b's chat reads in P5a's DD text module.

const principal = { id: "ep_1", userId: "u_m", name: "Mitchell", timezone: "America/New_York" } as unknown as ExecPrincipal;
const ARROW = String.fromCharCode(0x2192);
const EM_DASH = String.fromCharCode(0x2014);
const ZWSP = String.fromCharCode(0x200b);

type Row = Record<string, unknown>;
interface Call { table: string; columns: string; filters: [string, string, unknown][]; orders: [string, boolean][]; limit: number | null; range: [number, number] | null; signal: boolean }

// A small PostgREST stand-in: select(cols) with eq / in / not(col, "is", null) / order / limit / range / abortSignal.
function fakeDb(tables: Record<string, Row[]>, fail: (c: Call) => string | null = () => null) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: Call = { table, columns, filters: [], orders: [], limit: null, range: null, signal: false };
          calls.push(call);
          const run = () => {
            const msg = fail(call);
            if (msg) return { data: null, error: { message: msg } };
            let rows = (tables[table] ?? []).filter((r) =>
              call.filters.every(([kind, col, v]) =>
                kind === "eq" ? r[col] === v : kind === "in" ? (v as unknown[]).includes(r[col]) : kind === "notnull" ? r[col] !== null && r[col] !== undefined : true
              )
            );
            for (const [col, asc] of [...call.orders].reverse()) rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
            if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
            if (call.limit !== null) rows = rows.slice(0, call.limit);
            const cols = columns.split(",");
            for (const r of rows) for (const c of cols) if (!(c in r)) return { data: null, error: { message: `column ${c} does not exist` } };
            return { data: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null };
          };
          const q = {
            eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), q),
            in: (col: string, v: unknown[]) => (call.filters.push(["in", col, v]), q),
            not: (col: string, op: string, v: unknown) => (op === "is" && v === null ? call.filters.push(["notnull", col, null]) : call.filters.push(["not", col, v]), q),
            order: (col: string, o: { ascending: boolean }) => (call.orders.push([col, o.ascending]), q),
            limit: (n: number) => ((call.limit = n), q),
            range: (a: number, b: number) => ((call.range = [a, b]), q),
            abortSignal: () => ((call.signal = true), q),
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej)
          };
          return q;
        }
      };
    }
  };
  return { client, calls };
}

let db: ReturnType<typeof fakeDb>;
const use = (tables: Record<string, Row[]>, fail?: (c: Call) => string | null) => {
  db = fakeDb(tables, fail);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as unknown as SupabaseClient);
};

const FORBIDDEN = /hosting_access|staging_server|client_email|\bcustom\b|missive_thread_url|transcript|token/;

beforeEach(() => use({}));

describe("getTaskDescriptions", () => {
  it("reads tasks.description only, sanitized and clipped; ≤ 50 ids; fails closed", async () => {
    use({ tasks: [{ id: "t_1", description: `Fix ${ZWSP}it ${"z".repeat(3000)}` }, { id: "t_2", description: null }, { id: "t_3", description: "  " }] });
    const map = await getTaskDescriptions(principal, ["t_1", "t_2", "t_3", "t_1"], { signal: new AbortController().signal });
    expect(db.calls[0]).toMatchObject({ table: "tasks", columns: "id,description", limit: 50, signal: true });
    expect(map.get("t_1")?.length).toBe(1500);
    expect(map.get("t_1")?.endsWith(CLIP_MARKER)).toBe(true);
    expect(map.get("t_1")).not.toContain(ZWSP);
    expect(map.get("t_2")).toBeNull();
    expect(map.get("t_3")).toBeNull();
    await expect(getTaskDescriptions(principal, Array.from({ length: 51 }, (_, i) => `t_${i}`))).rejects.toThrow(TypeError);
    expect(await getTaskDescriptions(principal, [])).toEqual(new Map());
    use({}, () => "boom");
    await expect(getTaskDescriptions(principal, ["t_1"])).rejects.toMatchObject({ name: "DdReadError", table: "tasks" });
  });
});

describe("listTaskTimelineText (C26)", () => {
  it("comments, status notes (from → to), handoff and extension text through P5a's parse; other actions by name only", async () => {
    use({
      activity_logs: [
        { id: "a_1", task_id: "t_1", user_id: "u_a", action: "comment", detail: "Blocked on logins", created_at: "2026-11-03T10:00:00.000Z" },
        { id: "a_2", task_id: "t_1", user_id: "u_a", action: "status_change", detail: `pending ${ARROW} in_progress\nNeed the brand kit`, created_at: "2026-11-03T09:00:00.000Z" },
        { id: "a_3", task_id: "t_1", user_id: "u_a", action: "handoff", detail: `Ann ${ARROW} Bob\nOver to you`, created_at: "2026-11-03T08:00:00.000Z" },
        { id: "a_4", task_id: "t_1", user_id: "u_a", action: "extended", detail: `+4h ${EM_DASH} vendor late`, created_at: "2026-11-03T07:00:00.000Z" },
        { id: "a_5", task_id: "t_1", user_id: "u_a", action: "assigned", detail: "SECRET DETAIL", created_at: "2026-11-03T06:00:00.000Z" },
        { id: "a_6", task_id: "t_other", user_id: "u_a", action: "comment", detail: "other task", created_at: "2026-11-03T05:00:00.000Z" }
      ]
    });
    const entries = await listTaskTimelineText(principal, "t_1");
    expect(db.calls[0]).toMatchObject({ table: "activity_logs", columns: "id,task_id,user_id,action,detail,created_at", limit: 60 });
    expect(db.calls[0].filters).toEqual([["eq", "task_id", "t_1"]]);
    expect(db.calls[0].orders).toEqual([["created_at", false], ["id", false]]);
    expect(entries).toEqual([
      { kind: "comment", id: "a_1", userId: "u_a", at: "2026-11-03T10:00:00.000Z", text: "Blocked on logins", from: null, to: null },
      { kind: "status_change", id: "a_2", userId: "u_a", at: "2026-11-03T09:00:00.000Z", text: "Need the brand kit", from: "pending", to: "in_progress" },
      { kind: "handoff", id: "a_3", userId: "u_a", at: "2026-11-03T08:00:00.000Z", text: "Over to you", from: null, to: null },
      { kind: "extended", id: "a_4", userId: "u_a", at: "2026-11-03T07:00:00.000Z", text: "vendor late", from: null, to: null },
      { kind: "action", id: "a_5", userId: "u_a", at: "2026-11-03T06:00:00.000Z", action: "assigned" }
    ]);
    expect(JSON.stringify(entries)).not.toContain("SECRET DETAIL");
  });
});

describe("listTaskMessagesText", () => {
  it("task_messages body of one task, newest first, ≤ 20", async () => {
    use({ task_messages: [{ id: "m_1", task_id: "t_1", user_id: null, body: "hello", created_at: "2026-11-01T00:00:00.000Z" }] });
    expect(await listTaskMessagesText(principal, "t_1")).toEqual([{ id: "m_1", userId: null, at: "2026-11-01T00:00:00.000Z", text: "hello" }]);
    expect(db.calls[0]).toMatchObject({ table: "task_messages", columns: "id,user_id,body,created_at", limit: 20 });
  });
});

describe("listSubmittedNotesText (C52)", () => {
  const eod = (id: string, userId: string, over: Row = {}): Row => ({
    id,
    user_id: userId,
    note_date: "2026-11-04",
    submitted_at: "2026-11-04T22:00:00.000Z",
    reviewed_at: null,
    updated_at: "2026-11-04T22:00:00.000Z",
    worked_on: "Audit",
    accomplished: "",
    plan_tomorrow: "Fix",
    blockers: null,
    note: "Note",
    ideas: null,
    left_where_off: "Step 3",
    leads_messaged: "4",
    linkedin_comments: null,
    ...over
  });

  it("EOD: submitted only, selects updated_at, fields in display order; edited after submission → no fields", async () => {
    use({ eod_notes: [eod("e_1", "u_a"), eod("e_2", "u_b", { updated_at: "2026-11-04T23:00:00.000Z" }), eod("e_3", "u_c", { submitted_at: null })] });
    const notes = await listSubmittedNotesText(principal, { kind: "eod", noteDate: "2026-11-04", userId: null });
    const call = db.calls[0];
    expect(call.columns.split(",")).toEqual(expect.arrayContaining(["updated_at", "submitted_at", "reviewed_at"]));
    expect(call.filters).toEqual(expect.arrayContaining([["eq", "note_date", "2026-11-04"], ["notnull", "submitted_at", null]]));
    expect(notes.map((n) => n.id)).toEqual(["e_1", "e_2"]);
    expect(notes[0]).toMatchObject({ kind: "eod", editedAfterSubmit: false });
    expect(notes[0].fields).toEqual([
      { label: "Worked on", text: "Audit" },
      { label: "Plan for tomorrow", text: "Fix" },
      { label: "Notes", text: "Note" },
      { label: "Left off at", text: "Step 3" },
      { label: "Leads messaged", text: "4" }
    ]);
    expect(notes[1]).toMatchObject({ editedAfterSubmit: true, fields: [] });
    await listSubmittedNotesText(principal, { kind: "eod", noteDate: "2026-11-04", userId: "u_a" });
    expect(db.calls.at(-1)?.filters).toContainEqual(["eq", "user_id", "u_a"]);
    await expect(listSubmittedNotesText(principal, { kind: "eod", noteDate: "Nov 4", userId: null })).rejects.toThrow(TypeError);
  });

  it("SOD: (user, own date) pairs, grouped by date; only the wanted pairs; ≤ 200 pairs", async () => {
    use({
      sod_notes: [
        { id: "s_1", user_id: "u_a", note_date: "2026-11-04", submitted_at: "2026-11-04T13:00:00.000Z", updated_at: "2026-11-04T13:00:00.000Z", top_priority: "Audit", tasks_planned: "A, B", blockers: "" },
        { id: "s_2", user_id: "u_b", note_date: "2026-11-05", submitted_at: "2026-11-04T13:00:00.000Z", updated_at: "2026-11-04T13:00:00.000Z", top_priority: "Kiri", tasks_planned: null, blockers: null },
        { id: "s_3", user_id: "u_b", note_date: "2026-11-04", submitted_at: "2026-11-04T13:00:00.000Z", updated_at: "2026-11-04T13:00:00.000Z", top_priority: "wrong day", tasks_planned: null, blockers: null }
      ]
    });
    const notes = await listSubmittedNotesText(principal, { kind: "sod", pairs: [{ userId: "u_a", noteDate: "2026-11-04" }, { userId: "u_b", noteDate: "2026-11-05" }] });
    expect(notes.map((n) => [n.id, n.fields.map((f) => f.label)])).toEqual([
      ["s_1", ["Top priority", "Tasks planned"]],
      ["s_2", ["Top priority"]]
    ]);
    expect(notes.every((n) => n.reviewedAt === null)).toBe(true);
    expect(db.calls).toHaveLength(2);
    await expect(listSubmittedNotesText(principal, { kind: "sod", pairs: Array.from({ length: 201 }, (_, i) => ({ userId: `u_${i}`, noteDate: "2026-11-04" })) })).rejects.toThrow(TypeError);
  });
});

describe("selected columns (test 39)", () => {
  it("never a forbidden column; the note reads select updated_at and filter submitted", async () => {
    use({
      tasks: [{ id: "t_1", description: "d" }],
      activity_logs: [],
      task_messages: [],
      eod_notes: [],
      sod_notes: []
    });
    await getTaskDescriptions(principal, ["t_1"]);
    await listTaskTimelineText(principal, "t_1");
    await listTaskMessagesText(principal, "t_1");
    await listSubmittedNotesText(principal, { kind: "eod", noteDate: "2026-11-04", userId: null });
    await listSubmittedNotesText(principal, { kind: "sod", pairs: [{ userId: "u_a", noteDate: "2026-11-04" }] });
    for (const c of db.calls) expect(c.columns).not.toMatch(FORBIDDEN);
    expect(db.calls.map((c) => c.table)).toEqual(["tasks", "activity_logs", "task_messages", "eod_notes", "sod_notes"]);
    for (const c of db.calls.filter((x) => x.table.endsWith("_notes"))) {
      expect(c.columns).toContain("updated_at");
      expect(c.filters).toContainEqual(["notnull", "submitted_at", null]);
    }
    expect(db.calls.some((c) => c.table === "task_handoffs" || c.table === "task_extensions")).toBe(false);
  });
});
