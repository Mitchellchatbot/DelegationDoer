import { beforeEach, describe, expect, it, vi } from "vitest";

// P7b Area E (contract §3.13, B-P7b-5): the four client-update DD reads. sources/dd.ts's three select ids, enums, dates and
// counts only (never email_drafts.subject / body_text / body_html / rejection_note, never eod_client_work text); the one
// text read is sources/dd-text.ts's listEodClientWorkForClient (never user_id). Errors name the table and the database's
// code, never its message. Run over a generic in-memory PostgREST fake.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDraftsDb, type FakeDraftsDb, type Row } from "@/lib/exec/__tests__/fake-drafts-db";
import { countEodClientWorkForClient, DdReadError, getLastClientUpdate, listCompletedTasksForClient } from "@/lib/exec/sources/dd";
import { listEodClientWorkForClient } from "@/lib/exec/sources/dd-text";
import { principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const NOW = Date.parse("2026-11-08T15:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const P = principalFromRows(
  { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
) as ExecPrincipal;

let db: FakeDraftsDb;
function useDb(tables: Record<string, Row[]>, fail?: (q: { target: string }) => { code: string; message: string } | null) {
  db = createFakeDraftsDb({ tables, ...(fail ? { fail } : {}) });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
}
const reqs = (table: string) => db.requests.filter((q) => q.target === table);

function task(id: string, over: Row = {}): Row {
  return {
    id, title: `Task ${id}`, description: "SENTINEL-DESCRIPTION", status: "done", priority: "high", tags: [], department_id: null, assignee_id: "u_9",
    creator_id: "u_1", project_id: null, stage_id: null, client_name: "Acme Dental", due_date: null, created_at: iso(NOW - 20 * DAY),
    completed_at: iso(NOW - 2 * DAY), last_activity_at: iso(NOW - 2 * DAY), archived_at: null, archived_by: null, is_draft: false, deleted_at: null,
    estimated_hours: 1, reported_to_client_at: null, ...over
  };
}
function work(id: string, over: Row = {}): Row {
  return {
    id, user_id: "SENTINEL-AUTHOR", note_date: "2026-11-06", client_id: "c1", client_name: "Acme Dental", worked_on: `Worked on ${id}`, results: null,
    reported_to_client_at: null, dismissed_at: null, dismissed_by: null, created_at: iso(NOW - 2 * DAY), updated_at: iso(NOW - 2 * DAY), ...over
  };
}
function emailDraft(id: string, over: Row = {}): Row {
  return {
    id, author_id: "u_2", account_id: "acc", client_id: "c1", client_name: "Acme Dental", to_emails: ["x@acme.io"], cc_emails: [], bcc_emails: [],
    subject: "SENTINEL-SUBJECT", body_text: "SENTINEL-BODY", body_html: null, kind: "client_update", status: "sent", rejection_note: "SENTINEL-NOTE",
    sent_at: iso(NOW - 5 * DAY), created_at: iso(NOW - 6 * DAY), updated_at: iso(NOW - 5 * DAY), ...over
  };
}

beforeEach(() => useDb({}));

describe("listCompletedTasksForClient (E)", () => {
  it("P2b's task columns, done, the exact client, since, not a draft, not deleted; newest completion first; ≤ 50", async () => {
    useDb({ tasks: [
      task("t1", { completed_at: iso(NOW - 3 * DAY) }),
      task("t2", { completed_at: iso(NOW - DAY) }),
      task("t_old", { completed_at: iso(NOW - 20 * DAY) }),
      task("t_other", { client_name: "Acme Dental Group" }),
      task("t_open", { status: "in_progress" }),
      task("t_draft", { is_draft: true }),
      task("t_deleted", { deleted_at: iso(NOW - DAY) })
    ] });
    const out = await listCompletedTasksForClient(P, "Acme Dental", iso(NOW - 14 * DAY));
    expect(out.map((t) => t.id)).toEqual(["t2", "t1"]);
    const q = reqs("tasks")[0];
    expect(q.columns).toBe("id,title,status,priority,tags,department_id,assignee_id,creator_id,project_id,stage_id,client_name,due_date,created_at,completed_at,last_activity_at,archived_at,archived_by,is_draft,deleted_at,estimated_hours");
    expect(q.columns).not.toContain("description");
    expect(q.orders).toEqual([{ column: "completed_at", ascending: false }, { column: "id", ascending: false }]);
    expect(q.limit).toBe(50);
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
  });
  it("an empty name reads nothing; a bad since throws; a failed read names the table and the code only", async () => {
    expect(await listCompletedTasksForClient(P, "  ", iso(NOW))).toEqual([]);
    expect(reqs("tasks")).toHaveLength(0);
    await expect(listCompletedTasksForClient(P, "Acme", "not a date")).rejects.toThrow(TypeError);
    useDb({}, (q) => (q.target === "tasks" ? { code: "57014", message: "SENTINEL-DB-MESSAGE Acme Dental" } : null));
    const err = await listCompletedTasksForClient(P, "Acme Dental", iso(NOW)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DdReadError);
    expect((err as DdReadError).table).toBe("tasks");
    expect((err as Error).message).toBe("DD read failed (tasks): 57014");
  });
});

describe("getLastClientUpdate (E)", () => {
  it("the newest sent client_update / eod_digest email for the client id, and the later reported_to_client_at of work and tasks; timestamps only", async () => {
    useDb({
      email_drafts: [
        emailDraft("e1", { sent_at: iso(NOW - 9 * DAY) }),
        emailDraft("e2", { sent_at: iso(NOW - 4 * DAY), kind: "eod_digest" }),
        emailDraft("e3", { sent_at: iso(NOW - DAY), kind: "content_plan" }),
        emailDraft("e4", { sent_at: iso(NOW - DAY), status: "approved" }),
        emailDraft("e5", { sent_at: iso(NOW - DAY), client_id: "c2" })
      ],
      eod_client_work: [work("w1", { reported_to_client_at: iso(NOW - 6 * DAY) }), work("w2", { reported_to_client_at: iso(NOW - 3 * DAY), client_name: "Other" })],
      tasks: [task("t1", { reported_to_client_at: iso(NOW - 5 * DAY) })]
    });
    const r = await getLastClientUpdate(P, { clientId: "c1", clientName: "Acme Dental" });
    expect(r).toEqual({ teamEmailSentAt: iso(NOW - 4 * DAY), workReportedAt: iso(NOW - 5 * DAY) });
    expect(reqs("email_drafts")[0].columns).toBe("sent_at");
    expect(reqs("eod_client_work")[0].columns).toBe("reported_to_client_at");
    expect(reqs("tasks")[0].columns).toBe("reported_to_client_at");
    for (const q of db.requests) expect(String(q.columns)).not.toMatch(/subject|body_text|body_html|rejection_note|worked_on|results|message/);
  });
  it("nothing found → nulls; an empty id skips the email read; an empty name skips the two reported reads", async () => {
    expect(await getLastClientUpdate(P, { clientId: "c1", clientName: "Acme Dental" })).toEqual({ teamEmailSentAt: null, workReportedAt: null });
    useDb({ tasks: [task("t1", { reported_to_client_at: iso(NOW - 5 * DAY) })] });
    expect(await getLastClientUpdate(P, { clientId: "", clientName: "Acme Dental" })).toEqual({ teamEmailSentAt: null, workReportedAt: iso(NOW - 5 * DAY) });
    expect(reqs("email_drafts")).toHaveLength(0);
    useDb({});
    expect(await getLastClientUpdate(P, { clientId: "c1", clientName: "" })).toEqual({ teamEmailSentAt: null, workReportedAt: null });
    expect(reqs("eod_client_work")).toHaveLength(0);
    useDb({}, (q) => (q.target === "email_drafts" ? { code: "42501", message: "SENTINEL-DB-MESSAGE" } : null));
    await expect(getLastClientUpdate(P, { clientId: "c1", clientName: "Acme Dental" })).rejects.toThrow("DD read failed (email_drafts): 42501");
  });
});

describe("countEodClientWorkForClient (E)", () => {
  it("a head count of ids for the client name since the date, leaving out what the team discarded", async () => {
    useDb({ eod_client_work: [work("w1"), work("w2", { note_date: "2026-10-20" }), work("w3", { dismissed_at: iso(NOW - DAY) }), work("w4", { client_name: "Other" }), work("w5", { note_date: "2026-10-25" })] });
    expect(await countEodClientWorkForClient(P, "Acme Dental", "2026-10-25")).toBe(2);
    const q = reqs("eod_client_work")[0];
    expect(q.columns).toBe("id");
    expect(q.head).toBe(true);
    expect(q.count).toBe("exact");
    expect(await countEodClientWorkForClient(P, "", "2026-10-25")).toBe(0);
    await expect(countEodClientWorkForClient(P, "Acme", "2026-02-30")).rejects.toThrow(TypeError);
  });
});

describe("listEodClientWorkForClient (E, the DD text reader)", () => {
  it("the five columns (never user_id), by client id OR name, since the date, not discarded, newest first, clipped, at most `limit`", async () => {
    useDb({ eod_client_work: [
      work("w1", { note_date: "2026-11-06", results: "Leads up" }),
      work("w2", { note_date: "2026-11-07", client_id: null }),
      work("w3", { note_date: "2026-11-05", client_name: "Acme (renamed)" }),
      work("w4", { note_date: "2026-10-01" }),
      work("w5", { dismissed_at: iso(NOW - DAY) }),
      work("w6", { client_id: "c2", client_name: "Other" }),
      work("w7", { note_date: "2026-11-04", worked_on: `long ${"x".repeat(3_000)}`, results: "   ", reported_to_client_at: iso(NOW - DAY) })
    ] });
    const out = await listEodClientWorkForClient(P, { clientId: "c1", clientName: "Acme Dental", sinceDate: "2026-10-25", limit: 10 });
    expect(out.map((w) => w.id)).toEqual(["w2", "w1", "w3", "w7"]);
    expect(out[1]).toEqual({ id: "w1", noteDate: "2026-11-06", workedOn: "Worked on w1", results: "Leads up", reportedToClientAt: null });
    expect(out[3].workedOn.length).toBeLessThanOrEqual(1_500 + 20);
    expect(out[3].results).toBeNull();
    expect(out[3].reportedToClientAt).toBe(iso(NOW - DAY));
    for (const q of reqs("eod_client_work")) {
      expect(q.columns).toBe("id,note_date,worked_on,results,reported_to_client_at");
      expect(q.filters).toContainEqual({ op: "is", column: "dismissed_at", value: null });
    }
    expect(reqs("eod_client_work").map((q) => (q.filters.find((f) => f.op === "eq") as { column: string }).column)).toEqual(["client_id", "client_name"]);
    expect(JSON.stringify(out)).not.toContain("SENTINEL-AUTHOR");
    expect(await listEodClientWorkForClient(P, { clientId: "c1", clientName: "Acme Dental", sinceDate: "2026-10-25", limit: 2 })).toHaveLength(2);
  });
  it("a bad date throws; a failed read names the table and the code only", async () => {
    await expect(listEodClientWorkForClient(P, { clientId: "c1", clientName: "Acme", sinceDate: "11/01/2026", limit: 6 })).rejects.toThrow(TypeError);
    useDb({}, (q) => (q.target === "eod_client_work" ? { code: "57014", message: "SENTINEL-DB-MESSAGE worked on Acme" } : null));
    await expect(listEodClientWorkForClient(P, { clientId: "c1", clientName: "Acme", sinceDate: "2026-11-01", limit: 6 })).rejects.toThrow("DD read failed (eod_client_work): 57014");
  });
});
