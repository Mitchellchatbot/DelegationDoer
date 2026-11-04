import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// The email step's own deletes are covered in email-store.test.ts (and the SQL suite).
vi.mock("@/lib/exec/email-store", () => ({ purgeExpiredEmailRows: vi.fn() }));

import { createFakeExecDb, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { runPurge } from "@/lib/exec/handlers/purge";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec.purge with the P3 email step (contract §3.13 "Retention", coherence-18).

const NOW = new Date("2026-11-04T12:00:00.000Z");
let db: FakeExecDb;

beforeEach(() => {
  db = createFakeExecDb();
  db.deleteResult = () => ({ count: 1, error: null });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(purgeExpiredEmailRows).mockReset();
  vi.mocked(purgeExpiredEmailRows).mockResolvedValue({ threads: 3, commitments: 4, signals: 5, attentionRows: 6 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("exec.purge: the email step", () => {
  it("runs after the P2a/P2b steps with the run's clock and signal, and reports its counts", async () => {
    const signal = new AbortController().signal;
    await expect(runPurge(signal, NOW)).resolves.toEqual({
      finishedJobs: 1,
      accessLog: 1,
      auditLog: 1,
      aiUsage: 1,
      resolvedAttention: 1,
      emailThreads: 3,
      emailCommitments: 4,
      emailSignals: 5,
      emailAttentionRows: 6
    });
    expect(purgeExpiredEmailRows).toHaveBeenCalledWith(NOW, { signal });
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs", "exec_access_log", "exec_audit_log", "exec_ai_usage", "exec_attention_items"]);
    expect(console.log).toHaveBeenCalledWith(
      "[exec-purge] deleted finishedJobs=1 accessLog=1 auditLog=1 aiUsage=1 resolvedAttention=1 " +
        "emailThreads=3 emailCommitments=4 emailSignals=5 emailAttentionRows=6"
    );
  });

  it("an email step failure doesn't stop the others, and still fails the run (the job retries)", async () => {
    vi.mocked(purgeExpiredEmailRows).mockRejectedValue(new Error("exec email store: exec_email_threads purge failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 6 steps failed: email: exec email store: exec_email_threads purge failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("emailThreads=0 emailCommitments=0 emailSignals=0 emailAttentionRows=0 failed=1"));
  });

  it("another step failing doesn't skip the email step", async () => {
    db.deleteResult = (d) => (d.table === "exec_access_log" ? { count: null, error: { message: "statement timeout" } } : { count: 1, error: null });
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 6 steps failed: accessLog");
    expect(purgeExpiredEmailRows).toHaveBeenCalledTimes(1);
  });

  it("before the P3 migration the step reports zeros (the store tolerates missing tables)", async () => {
    vi.mocked(purgeExpiredEmailRows).mockResolvedValue({ threads: 0, commitments: 0, signals: 0, attentionRows: 0 });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ emailThreads: 0, emailCommitments: 0, emailSignals: 0, emailAttentionRows: 0 });
  });

  it("an aborted signal stops before the email step", async () => {
    const controller = new AbortController();
    db.deleteResult = (d) => {
      if (d.table === "exec_attention_items") controller.abort(new Error("lease lost"));
      return { count: 1, error: null };
    };
    await expect(runPurge(controller.signal, NOW)).rejects.toThrow("lease lost");
    expect(purgeExpiredEmailRows).not.toHaveBeenCalled();
  });
});
