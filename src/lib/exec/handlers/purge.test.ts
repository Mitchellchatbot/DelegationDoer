import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// The email step's own deletes are covered in email-store.test.ts (and the SQL suite).
vi.mock("@/lib/exec/email-store", () => ({ purgeExpiredEmailRows: vi.fn() }));
// The drafts step's own RPC loop is covered in drafts-store.test.ts (and the SQL suite).
vi.mock("@/lib/exec/drafts-store", () => ({ purgeExpiredDrafts: vi.fn() }));

import { createFakeExecDb, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { runPurge } from "@/lib/exec/handlers/purge";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec.purge with the P3 email step (contract §3.13 "Retention", coherence-18)
// and the P4 drafts step (P4 contract §2.8, Y6; PX11).

const NOW = new Date("2026-11-04T12:00:00.000Z");
let db: FakeExecDb;

beforeEach(() => {
  db = createFakeExecDb();
  db.deleteResult = () => ({ count: 1, error: null });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(purgeExpiredEmailRows).mockReset();
  vi.mocked(purgeExpiredEmailRows).mockResolvedValue({ threads: 3, commitments: 4, signals: 5, attentionRows: 6 });
  vi.mocked(purgeExpiredDrafts).mockReset();
  vi.mocked(purgeExpiredDrafts).mockResolvedValue({ contentPurged: 7, deleted: 8, closedIdle: 9, checksScheduled: 10 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const FULL_LOG =
  "[exec-purge] deleted finishedJobs=1 accessLog=1 auditLog=1 aiUsage=1 resolvedAttention=1 " +
  "emailThreads=3 emailCommitments=4 emailSignals=5 emailAttentionRows=6 " +
  "draftsContentPurged=7 draftsDeleted=8 draftsClosedIdle=9 draftsChecksScheduled=10";

describe("exec.purge: the email and drafts steps", () => {
  it("run after the P2a/P2b steps with the run's clock and signal, and report their counts", async () => {
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
      emailAttentionRows: 6,
      draftsContentPurged: 7,
      draftsDeleted: 8,
      draftsClosedIdle: 9,
      draftsChecksScheduled: 10
    });
    expect(purgeExpiredEmailRows).toHaveBeenCalledWith(NOW, { signal });
    expect(purgeExpiredDrafts).toHaveBeenCalledWith(NOW, { signal });
    expect(vi.mocked(purgeExpiredEmailRows).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(purgeExpiredDrafts).mock.invocationCallOrder[0]);
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs", "exec_access_log", "exec_audit_log", "exec_ai_usage", "exec_attention_items"]);
    expect(console.log).toHaveBeenCalledWith(FULL_LOG);
  });

  it("an email step failure doesn't stop the others (the drafts step still runs), and still fails the run (the job retries)", async () => {
    vi.mocked(purgeExpiredEmailRows).mockRejectedValue(new Error("exec email store: exec_email_threads purge failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 7 steps failed: email: exec email store: exec_email_threads purge failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredDrafts).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("emailThreads=0 emailCommitments=0 emailSignals=0 emailAttentionRows=0 draftsContentPurged=7"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("failed=1"));
  });

  it("PX11: a drafts step failure fails the run after every other step ran", async () => {
    vi.mocked(purgeExpiredDrafts).mockRejectedValue(new Error("exec drafts store: exec_drafts_purge_expired failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 7 steps failed: drafts: exec drafts store: exec_drafts_purge_expired failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredEmailRows).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("draftsContentPurged=0 draftsDeleted=0 draftsClosedIdle=0 draftsChecksScheduled=0 failed=1"));
  });

  it("another step failing doesn't skip the email or drafts steps", async () => {
    db.deleteResult = (d) => (d.table === "exec_access_log" ? { count: null, error: { message: "statement timeout" } } : { count: 1, error: null });
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 7 steps failed: accessLog");
    expect(purgeExpiredEmailRows).toHaveBeenCalledTimes(1);
    expect(purgeExpiredDrafts).toHaveBeenCalledTimes(1);
  });

  it("before the P3 / P4 migrations the steps report zeros (the stores tolerate missing tables and functions)", async () => {
    vi.mocked(purgeExpiredEmailRows).mockResolvedValue({ threads: 0, commitments: 0, signals: 0, attentionRows: 0 });
    vi.mocked(purgeExpiredDrafts).mockResolvedValue({ contentPurged: 0, deleted: 0, closedIdle: 0, checksScheduled: 0 });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({
      emailThreads: 0, emailCommitments: 0, emailSignals: 0, emailAttentionRows: 0,
      draftsContentPurged: 0, draftsDeleted: 0, draftsClosedIdle: 0, draftsChecksScheduled: 0
    });
  });

  it("an aborted signal stops before the email step, so the drafts step never runs either", async () => {
    const controller = new AbortController();
    db.deleteResult = (d) => {
      if (d.table === "exec_attention_items") controller.abort(new Error("lease lost"));
      return { count: 1, error: null };
    };
    await expect(runPurge(controller.signal, NOW)).rejects.toThrow("lease lost");
    expect(purgeExpiredEmailRows).not.toHaveBeenCalled();
    expect(purgeExpiredDrafts).not.toHaveBeenCalled();
  });
});
