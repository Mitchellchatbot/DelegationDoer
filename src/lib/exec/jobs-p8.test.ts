import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// P8 contract §3.13.9 (C18) and §3.13.2 / §3.13.5 (intel-11, C48): jobs.ts's two P8 reads, listReapedJobs and isJobLive.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));

import { createFakeJobsRead, type ReadRow } from "@/lib/exec/__tests__/fake-jobs-read";
import { REAPED_ERROR_PREFIX, isJobLive, listReapedJobs } from "@/lib/exec/jobs";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const job = (o: ReadRow): ReadRow => ({ id: 1, kind: "exec.brief", status: "dead", finished_at: "2026-11-06T13:05:00Z", last_error: null, dedupe_key: null, ...o });
const reaped = (worker = "w-1") => `${REAPED_ERROR_PREFIX}${worker}) after 3 attempts`;

function use(rows: ReadRow[]) {
  const db = createFakeJobsRead({ exec_jobs: rows });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

beforeEach(() => vi.mocked(getSupabaseAdmin).mockReset());

describe("listReapedJobs (C18)", () => {
  const FROM = "2026-11-06T13:00:00.000Z";
  const TO = "2026-11-06T13:15:00.000Z";

  it("dead jobs the reaper killed in [from, to): id and kind only, oldest first", async () => {
    const db = use([
      job({ id: 7, kind: "exec.brief", finished_at: "2026-11-06T13:10:00Z", last_error: reaped() }),
      job({ id: 3, kind: "exec.slack-sweep", finished_at: "2026-11-06T13:00:00Z", last_error: reaped("w-2") }),
      // killJob's dead jobs carry their own error: their alert already went out.
      job({ id: 4, kind: "exec.brief", finished_at: "2026-11-06T13:02:00Z", last_error: "fatal: bad_payload" }),
      // Outside the window: the end is exclusive, the start inclusive.
      job({ id: 5, kind: "exec.brief", finished_at: "2026-11-06T13:15:00Z", last_error: reaped() }),
      job({ id: 6, kind: "exec.brief", finished_at: "2026-11-06T12:59:59Z", last_error: reaped() }),
      // Not dead: a requeued job keeps the note but isn't counted.
      job({ id: 8, kind: "exec.brief", status: "queued", finished_at: "2026-11-06T13:03:00Z", last_error: reaped() })
    ]);
    await expect(listReapedJobs(FROM, TO, 200)).resolves.toEqual([{ id: 3, kind: "exec.slack-sweep" }, { id: 7, kind: "exec.brief" }]);
    const q = db.queries[0];
    expect(q.table).toBe("exec_jobs");
    expect(q.columns).toBe("id,kind");
    expect(q.filters).toEqual([
      { op: "eq", column: "status", value: "dead" },
      { op: "gte", column: "finished_at", value: FROM },
      { op: "lt", column: "finished_at", value: TO },
      { op: "like", column: "last_error", value: "lease expired (worker %" }
    ]);
    expect(q.order).toEqual({ column: "finished_at", ascending: true });
    expect(q.limit).toBe(200);
  });

  it("matches the reaper's note exactly as the foundation migration writes it", () => {
    expect(REAPED_ERROR_PREFIX).toBe("lease expired (worker ");
  });

  it("refuses bad arguments and throws on a read error", async () => {
    use([]);
    await expect(listReapedJobs("yesterday", TO, 10)).rejects.toThrow("ISO instants");
    await expect(listReapedJobs(FROM, TO, 0)).rejects.toThrow("limit must be");
    await expect(listReapedJobs(FROM, TO, 1.5)).rejects.toThrow("limit must be");
    const db = use([]);
    db.failNext("exec_jobs", { message: "permission denied" });
    await expect(listReapedJobs(FROM, TO, 10)).rejects.toThrow("exec_jobs read failed (reaped jobs): permission denied");
  });

  it("drops a row whose id or kind is malformed (never forwards it to an alert key)", async () => {
    use([job({ id: "12", last_error: reaped() }), job({ id: 13, kind: "bad kind!", last_error: reaped() }), job({ id: null, last_error: reaped() })]);
    await expect(listReapedJobs(FROM, TO, 10)).resolves.toEqual([{ id: 12, kind: "exec.brief" }]);
  });
});

describe("isJobLive (intel-11, C48)", () => {
  const KEY = "exec.brief-deliver:ep_1:2026-11-06:1:full";

  it("true while a job with the key is queued or running; false when it finished, died, was cancelled, or doesn't exist", async () => {
    for (const [status, live] of [["queued", true], ["running", true], ["succeeded", false], ["dead", false], ["cancelled", false]] as const) {
      use([job({ id: 1, status, dedupe_key: KEY }), job({ id: 2, status: "queued", dedupe_key: "exec.brief-deliver:ep_1:2026-11-06:2:full" })]);
      await expect(isJobLive(KEY), status).resolves.toBe(live);
    }
    use([]);
    await expect(isJobLive(KEY)).resolves.toBe(false);
  });

  it("reads one row by the key and the two live statuses, on the caller's signal", async () => {
    const db = use([job({ status: "queued", dedupe_key: KEY })]);
    const signal = new AbortController().signal;
    await isJobLive(KEY, { signal });
    expect(db.queries[0]).toMatchObject({
      table: "exec_jobs",
      columns: "id",
      filters: [{ op: "eq", column: "dedupe_key", value: KEY }, { op: "in", column: "status", value: ["queued", "running"] }],
      limit: 1,
      signal
    });
  });

  it("throws on a read error (callers treat a throw as live) and on a malformed key", async () => {
    const db = use([]);
    db.failNext("exec_jobs", { message: "timeout" });
    await expect(isJobLive(KEY)).rejects.toThrow("exec_jobs read failed (live job): timeout");
    await expect(isJobLive("")).rejects.toThrow("dedupeKey must be");
    await expect(isJobLive("k".repeat(301))).rejects.toThrow("dedupeKey must be");
  });
});
