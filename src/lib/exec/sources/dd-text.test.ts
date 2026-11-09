import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// sources/dd.ts is Area C's: only its error class is used here.
vi.mock("@/lib/exec/sources/dd", () => ({
  DdReadError: class DdReadError extends Error {
    readonly table: string;
    constructor(table: string, message: string) {
      super(`DD read failed (${table}): ${message}`);
      this.name = "DdReadError";
      this.table = table;
    }
  }
}));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  listActivityTextByIds,
  listActivityTextSince,
  listEarlierCommentText,
  listMeetingBriefRisks,
  listNoteBlockersByIds,
  listSubmittedNoteBlockersSince,
  submittedTextIsCurrent
} from "@/lib/exec/sources/dd-text";
import { CLIP_MARKER } from "@/lib/exec/text/untrusted";
import type { ExecPrincipal } from "@/lib/exec/types";
import { createFakeDdtextDb, type FakeDdtextDb, type Row } from "../__tests__/fake-ddtext-db";

// P5a contract §3.11.2: the one reader of DD free text (S4, K26, K28).

const principal = { id: "ep_1", userId: "u_mitchell", name: "Mitchell", timezone: "America/New_York" } as unknown as ExecPrincipal;
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const ARROW = String.fromCharCode(0x2192);
const EM_DASH = String.fromCharCode(0x2014);

let db: FakeDdtextDb;
beforeEach(() => {
  db = createFakeDdtextDb();
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
});

function log(id: string, action: string, detail: string | null, createdAt: string, over: Row = {}): void {
  db.activity.push({ id, task_id: "t_1", user_id: "u_ann", action, detail, created_at: createdAt, mentioned_user_ids: [], ...over });
}

describe("listActivityTextSince", () => {
  it("reads the four actions with explicit columns, in (created_at, id) order, keeping only the free-text part", async () => {
    log("a_1", "comment", `  Blocked  on${ZWSP} the ${RLO}logins.  `, "2026-11-05T10:00:00.000Z", { mentioned_user_ids: ["u_mitchell"] });
    log("a_2", "status_change", `pending ${ARROW} in_progress (timer started)\nNeed the brand kit\nfrom the client`, "2026-11-05T10:01:00.000Z");
    log("a_3", "handoff", `Ann ${ARROW} Bob\n[Design] over to you`, "2026-11-05T10:02:00.000Z");
    log("a_4", "extended", `+4h ${EM_DASH} waiting on the vendor feed`, "2026-11-05T10:03:00.000Z");
    log("a_5", "extended", "+2h", "2026-11-05T10:04:00.000Z");
    log("a_6", "status_change", `in_progress ${ARROW} done`, "2026-11-05T10:05:00.000Z");
    log("a_7", "created", "Task created", "2026-11-05T10:06:00.000Z");
    log("a_0", "comment", "too early", "2026-11-04T10:00:00.000Z");
    const r = await listActivityTextSince(principal, "2026-11-05T00:00:00.000Z", { after: null, maxRows: 2000 });
    expect(r.hasMore).toBe(false);
    expect(r.rows.map((x) => [x.id, x.action, x.text])).toEqual([
      ["a_1", "comment", "Blocked on the logins."],
      ["a_2", "status_change", "Need the brand kit\nfrom the client"],
      ["a_3", "handoff", "[Design] over to you"],
      ["a_4", "extended", "waiting on the vendor feed"],
      ["a_5", "extended", ""],
      ["a_6", "status_change", ""]
    ]);
    expect(r.rows[0].mentionedUserIds).toEqual(["u_mitchell"]);
    const call = db.callsTo("activity_logs")[0];
    expect(call.columns).toBe("id,task_id,user_id,action,detail,created_at,mentioned_user_ids");
    expect(call.filters).toContainEqual({ kind: "in", column: "action", values: ["comment", "status_change", "handoff", "extended"] });
    expect(call.orders).toEqual([
      { column: "created_at", ascending: true },
      { column: "id", ascending: true }
    ]);
  });

  it("clips to 1,500 characters with the marker", async () => {
    log("a_1", "comment", "z".repeat(5000), "2026-11-05T10:00:00.000Z");
    const [row] = (await listActivityTextSince(principal, "2026-11-05T00:00:00.000Z", { after: null, maxRows: 10 })).rows;
    expect(row.text.length).toBe(1500);
    expect(row.text.endsWith(CLIP_MARKER)).toBe(true);
  });

  it("stops at maxRows with hasMore, and continues exactly after a microsecond keyset position", async () => {
    log("b_1", "comment", "one", "2026-11-05T10:00:00.000100+00:00");
    log("b_2", "comment", "two", "2026-11-05T10:00:00.000200+00:00");
    log("b_0", "comment", "two-a", "2026-11-05T10:00:00.000200+00:00");
    log("b_3", "comment", "three", "2026-11-05T10:00:00.000300+00:00");
    const first = await listActivityTextSince(principal, "2026-11-05T00:00:00.000Z", { after: null, maxRows: 2 });
    expect(first.rows.map((x) => x.id)).toEqual(["b_1", "b_0"]);
    expect(first.hasMore).toBe(true);
    const last = first.rows[1];
    const next = await listActivityTextSince(principal, "2026-11-05T00:00:00.000Z", { after: { at: last.createdAt, id: last.id }, maxRows: 2 });
    expect(next.rows.map((x) => x.id)).toEqual(["b_2", "b_3"]);
    expect(next.hasMore).toBe(false);
    const or = db.callsTo("activity_logs").at(-1)?.filters.find((f) => f.kind === "or");
    expect(or).toEqual({ kind: "or", expr: 'created_at.gt."2026-11-05T10:00:00.000200+00:00",and(created_at.eq."2026-11-05T10:00:00.000200+00:00",id.gt."b_0")' });
  });

  it("refuses bad arguments and fails closed", async () => {
    await expect(listActivityTextSince(principal, "not a time", { after: null, maxRows: 5 })).rejects.toThrow(TypeError);
    await expect(listActivityTextSince(principal, "2026-11-05T00:00:00Z", { after: null, maxRows: 2001 })).rejects.toThrow(TypeError);
    await expect(listActivityTextSince(principal, "2026-11-05T00:00:00Z", { after: { at: "2026-11-05T00:00:00Z", id: 'x",id.gt.' }, maxRows: 5 })).rejects.toThrow(TypeError);
    db.fail = () => ({ message: "boom" });
    await expect(listActivityTextSince(principal, "2026-11-05T00:00:00Z", { after: null, maxRows: 5 })).rejects.toMatchObject({ name: "DdReadError", table: "activity_logs" });
  });
});

describe("listActivityTextByIds and listEarlierCommentText", () => {
  it("reads rows by id (the four actions only)", async () => {
    log("a_1", "comment", "first", "2026-11-05T10:00:00.000Z");
    log("a_2", "created", "Task created", "2026-11-05T10:01:00.000Z");
    expect((await listActivityTextByIds(principal, ["a_1", "a_2", "a_missing"])).map((r) => r.id)).toEqual(["a_1"]);
    expect(await listActivityTextByIds(principal, [])).toEqual([]);
  });

  it("returns up to `limit` earlier comment-class rows with text, newest first", async () => {
    log("c_1", "comment", "oldest note", "2026-11-01T10:00:00.000Z");
    log("c_2", "status_change", `pending ${ARROW} in_progress\nstarted on it`, "2026-11-02T10:00:00.000Z");
    log("c_3", "status_change", `in_progress ${ARROW} urgent`, "2026-11-03T10:00:00.000Z");
    log("c_4", "handoff", `A ${ARROW} B\nnot comment-class`, "2026-11-03T11:00:00.000Z");
    log("c_5", "comment", "the newest earlier one", "2026-11-04T10:00:00.000Z");
    log("c_6", "comment", "the item itself", "2026-11-05T10:00:00.000Z");
    log("c_7", "comment", "another task", "2026-11-04T12:00:00.000Z", { task_id: "t_2" });
    const rows = await listEarlierCommentText(principal, "t_1", "2026-11-05T10:00:00.000Z", 2);
    expect(rows.map((r) => r.id)).toEqual(["c_5", "c_2"]);
    expect((await listEarlierCommentText(principal, "t_1", "2026-11-05T10:00:00.000Z", 5)).map((r) => r.id)).toEqual(["c_5", "c_2", "c_1"]);
    await expect(listEarlierCommentText(principal, "t_1", "2026-11-05T10:00:00.000Z", 6)).rejects.toThrow(TypeError);
  });
});

describe("notes (K28, a-correct-9)", () => {
  function note(kind: "eod" | "sod", id: string, submittedAt: string | null, updatedAt: string, blockers: string | null): void {
    (kind === "eod" ? db.eod : db.sod).push({ id, user_id: "u_ann", note_date: "2026-11-04", submitted_at: submittedAt, updated_at: updatedAt, blockers, worked_on: "SECRET-not-read" });
  }

  it("submittedTextIsCurrent: unedited since submission only", () => {
    expect(submittedTextIsCurrent({ submittedAt: "2026-11-04T22:00:00.000Z", updatedAt: "2026-11-04T22:00:00.000Z" })).toBe(true);
    expect(submittedTextIsCurrent({ submittedAt: "2026-11-04T22:00:00.000Z", updatedAt: "2026-11-04T21:00:00.000Z" })).toBe(true);
    expect(submittedTextIsCurrent({ submittedAt: "2026-11-04T22:00:00.000Z", updatedAt: "2026-11-04T22:00:00.001Z" })).toBe(false);
    expect(submittedTextIsCurrent({ submittedAt: null, updatedAt: "2026-11-04T22:00:00.000Z" })).toBe(false);
    expect(submittedTextIsCurrent({ submittedAt: "garbage", updatedAt: "2026-11-04T22:00:00.000Z" })).toBe(false);
  });

  it("returns submitted notes since the position; a note edited after submission comes back by id only (M36)", async () => {
    note("eod", "e_1", "2026-11-04T22:00:00.000+00:00", "2026-11-04T22:00:00.000+00:00", " Waiting  on the client's logins ");
    note("eod", "e_2", "2026-11-04T22:05:00.000+00:00", "2026-11-04T23:30:00.000+00:00", "SECRET edited after submit");
    note("eod", "e_3", null, "2026-11-04T22:10:00.000+00:00", "SECRET draft never submitted");
    note("eod", "e_0", "2026-11-03T22:00:00.000+00:00", "2026-11-03T22:00:00.000+00:00", "before the position");
    note("eod", "e_4", "2026-11-04T22:20:00.000+00:00", "2026-11-04T22:20:00.000+00:00", null);
    const r = await listSubmittedNoteBlockersSince(principal, "eod", "2026-11-04T00:00:00.000Z");
    expect(r.rows.map((x) => [x.id, x.kind, x.text, x.noteDate])).toEqual([
      ["e_1", "eod", "Waiting on the client's logins", "2026-11-04"],
      ["e_4", "eod", "", "2026-11-04"]
    ]);
    expect(r.editedAfterSubmit).toEqual(["e_2"]);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    const call = db.callsTo("eod_notes")[0];
    expect(call.columns).toBe("id,user_id,note_date,submitted_at,updated_at,blockers");
    expect(call.filters).toEqual([
      { kind: "notnull", column: "submitted_at" },
      { kind: "gt", column: "submitted_at", value: "2026-11-04T00:00:00.000Z" }
    ]);
    expect(call.orders.map((o) => o.column)).toEqual(["submitted_at", "id"]);
  });

  it("reads SOD notes from sod_notes, and notes by id split the same way", async () => {
    note("sod", "s_1", "2026-11-04T13:00:00.000+00:00", "2026-11-04T13:00:00.000+00:00", "Need access to the CMS today please");
    note("sod", "s_2", "2026-11-04T13:00:00.000+00:00", "2026-11-04T14:00:00.000+00:00", "SECRET");
    const r = await listNoteBlockersByIds(principal, "sod", ["s_1", "s_2", "s_gone"]);
    expect(r.rows.map((x) => [x.id, x.kind])).toEqual([["s_1", "sod"]]);
    expect(r.editedAfterSubmit).toEqual(["s_2"]);
    expect(db.callsTo("sod_notes")).toHaveLength(1);
    await expect(listSubmittedNoteBlockersSince(principal, "xod" as "eod", "2026-11-04T00:00:00Z")).rejects.toThrow(TypeError);
  });
});

describe("listMeetingBriefRisks (K26, a-correct-4)", () => {
  function meeting(id: string, clientId: string, at: string, risks: unknown, taskIds: string[] = []): void {
    db.meetings.push({ id, client_id: clientId, title: `Meeting ${id}`, meeting_date: at, brief: { risks, keyDecisions: ["SECRET decision"] }, transcript: "SECRET transcript", summary: "SECRET summary", task_ids: taskIds });
  }

  it("the derived client's recent meetings plus task overlaps, deduped, newest first, risks only, clipped", async () => {
    meeting("m_1", "cl_1", "2026-11-01T15:00:00.000Z", ["Budget may be cut", 42, "x".repeat(400), "a", "b", "c", "d"]);
    meeting("m_2", "cl_1", "2026-11-03T15:00:00.000Z", null, ["t_9"]);
    meeting("m_old", "cl_1", "2026-08-01T15:00:00.000Z", ["too old"]);
    meeting("m_3", "cl_2", "2026-11-02T15:00:00.000Z", ["Overlap risk"], ["t_1"]);
    meeting("m_4", "cl_3", "2026-11-04T15:00:00.000Z", ["unrelated"], ["t_7"]);
    const rows = await listMeetingBriefRisks(principal, { clientId: "cl_1", taskIds: ["t_1", "t_9"], sinceIso: "2026-09-06T00:00:00.000Z", limit: 5 });
    expect(rows.map((r) => [r.meetingId, r.matchedBy, r.clientId])).toEqual([
      ["m_2", "client", "cl_1"],
      ["m_3", "task", "cl_2"],
      ["m_1", "client", "cl_1"]
    ]);
    const m1 = rows[2];
    expect(m1.risks).toHaveLength(5);
    expect(m1.risks[0]).toBe("Budget may be cut");
    expect(m1.risks[1].length).toBe(280);
    expect(rows[0].risks).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    for (const c of db.callsTo("client_meetings")) expect(c.columns).toBe("id,client_id,title,meeting_date,risks:brief->risks");
    expect((await listMeetingBriefRisks(principal, { clientId: "cl_1", taskIds: [], sinceIso: "2026-09-06T00:00:00.000Z", limit: 1 })).map((r) => r.meetingId)).toEqual(["m_2"]);
    await expect(listMeetingBriefRisks(principal, { clientId: "cl_1", taskIds: [], sinceIso: "2026-09-06T00:00:00.000Z", limit: 6 })).rejects.toThrow(TypeError);
  });
});
