import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// The email step's own deletes are covered in email-store.test.ts (and the SQL suite).
vi.mock("@/lib/exec/email-store", () => ({ purgeExpiredEmailRows: vi.fn() }));
// The drafts step's own RPC loop is covered in drafts-store.test.ts (and the SQL suite).
vi.mock("@/lib/exec/drafts-store", () => ({ purgeExpiredDrafts: vi.fn() }));
// The P5a steps' own deletes are covered in ddtext-store's and attention-feedback's suites (and the SQL suite).
vi.mock("@/lib/exec/ddtext-store", () => ({ purgeExpiredDdtext: vi.fn(), purgeOrphanDdtextAttention: vi.fn() }));
vi.mock("@/lib/exec/attention-feedback", () => ({ purgeOldFeedback: vi.fn() }));
// P5b's chat step's own deletes are covered in chat-store.test.ts (T71) and the SQL suite.
vi.mock("@/lib/exec/chat-store", () => ({ purgeExpiredChatRows: vi.fn() }));

import { createFakeExecDb, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { purgeOldFeedback } from "@/lib/exec/attention-feedback";
import { purgeExpiredChatRows } from "@/lib/exec/chat-store";
import { purgeExpiredDdtext, purgeOrphanDdtextAttention } from "@/lib/exec/ddtext-store";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { RETENTION_DAYS, runPurge } from "@/lib/exec/handlers/purge";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec.purge with the P3 email step (contract §3.13 "Retention", coherence-18),
// the P4 drafts step (P4 contract §2.8, Y6; PX11) and the P5a DD text and
// feedback steps (P5a contract §3.12.8, §2.6; test 28).

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
  vi.mocked(purgeExpiredDdtext).mockReset();
  vi.mocked(purgeExpiredDdtext).mockResolvedValue(11);
  vi.mocked(purgeOrphanDdtextAttention).mockReset();
  vi.mocked(purgeOrphanDdtextAttention).mockResolvedValue(12);
  vi.mocked(purgeOldFeedback).mockReset();
  vi.mocked(purgeOldFeedback).mockResolvedValue(13);
  vi.mocked(purgeExpiredChatRows).mockReset();
  vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 14, messages: 15, staleFailed: 16 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const FULL_LOG =
  "[exec-purge] deleted finishedJobs=1 accessLog=1 auditLog=1 aiUsage=1 resolvedAttention=1 " +
  "emailThreads=3 emailCommitments=4 emailSignals=5 emailAttentionRows=6 " +
  "draftsContentPurged=7 draftsDeleted=8 draftsClosedIdle=9 draftsChecksScheduled=10 " +
  "ddtextItems=11 ddtextAttention=12 attentionFeedback=13 " +
  "chatConversations=14 chatMessages=15 chatStaleFailed=16";

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
      draftsChecksScheduled: 10,
      ddtextItems: 11,
      ddtextAttention: 12,
      attentionFeedback: 13,
      chatConversations: 14,
      chatMessages: 15,
      chatStaleFailed: 16
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
      "exec.purge: 1 of 11 steps failed: email: exec email store: exec_email_threads purge failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredDrafts).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("emailThreads=0 emailCommitments=0 emailSignals=0 emailAttentionRows=0 draftsContentPurged=7"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("failed=1"));
  });

  it("PX11: a drafts step failure fails the run after every other step ran", async () => {
    vi.mocked(purgeExpiredDrafts).mockRejectedValue(new Error("exec drafts store: exec_drafts_purge_expired failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 11 steps failed: drafts: exec drafts store: exec_drafts_purge_expired failed: lock timeout"
    );
    expect(db.deletes).toHaveLength(5);
    expect(purgeExpiredEmailRows).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("draftsContentPurged=0 draftsDeleted=0 draftsClosedIdle=0 draftsChecksScheduled=0 ddtextItems=11 ddtextAttention=12 attentionFeedback=13 chatConversations=14 chatMessages=15 chatStaleFailed=16 failed=1"));
  });

  it("another step failing doesn't skip the email or drafts steps", async () => {
    db.deleteResult = (d) => (d.table === "exec_access_log" ? { count: null, error: { message: "statement timeout" } } : { count: 1, error: null });
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 11 steps failed: accessLog");
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
    expect(purgeExpiredDdtext).not.toHaveBeenCalled();
    expect(purgeOrphanDdtextAttention).not.toHaveBeenCalled();
    expect(purgeOldFeedback).not.toHaveBeenCalled();
  });
});

describe("exec.purge: the P5b chat step (T71, contract §3.21)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("runs last, with the run's clock and signal, and reports its three counts", async () => {
    const signal = new AbortController().signal;
    const counts = await runPurge(signal, NOW);
    expect(purgeExpiredChatRows).toHaveBeenCalledWith(NOW, { signal });
    expect(counts).toMatchObject({ chatConversations: 14, chatMessages: 15, chatStaleFailed: 16 });
    expect(order(purgeOldFeedback)).toBeLessThan(order(purgeExpiredChatRows));
  });

  it("before the P5b migration the step reports zeros (the store tolerates missing tables)", async () => {
    vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 0, messages: 0, staleFailed: 0 });
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ chatConversations: 0, chatMessages: 0, chatStaleFailed: 0, attentionFeedback: 13 });
  });

  it("a chat step failure fails the run after every other step ran; another step failing doesn't skip it", async () => {
    vi.mocked(purgeExpiredChatRows).mockRejectedValue(new Error("exec chat store: exec_conversations purge failed: lock timeout (55P03)"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow(
      "exec.purge: 1 of 11 steps failed: chat: exec chat store: exec_conversations purge failed: lock timeout (55P03)"
    );
    expect(purgeOldFeedback).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("chatConversations=0 chatMessages=0 chatStaleFailed=0 failed=1"));
    vi.mocked(purgeExpiredChatRows).mockResolvedValue({ conversations: 1, messages: 2, staleFailed: 3 });
    vi.mocked(purgeOldFeedback).mockRejectedValue(new Error("exec_attention_feedback purge failed: down"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 11 steps failed: attentionFeedback");
    expect(purgeExpiredChatRows).toHaveBeenCalledTimes(2);
  });
});

describe("exec.purge: the P5a DD text and feedback steps (test 28)", () => {
  const order = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];

  it("run after the drafts step, in the order expiry → orphan sweep (every principal) → feedback, with the run's clock and signal", async () => {
    const signal = new AbortController().signal;
    await runPurge(signal, NOW);
    expect(purgeExpiredDdtext).toHaveBeenCalledWith(NOW, { signal });
    // No principal and no backing: the sweep covers every principal and reads the signals itself.
    expect(purgeOrphanDdtextAttention).toHaveBeenCalledWith(NOW, { signal });
    expect(purgeOldFeedback).toHaveBeenCalledWith(NOW, { signal });
    const seq = [purgeExpiredEmailRows, purgeExpiredDrafts, purgeExpiredDdtext, purgeOrphanDdtextAttention, purgeOldFeedback].map(order);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    expect(RETENTION_DAYS).toMatchObject({ attentionFeedback: 365, resolvedAttention: 90 });
  });

  it("an attention row whose ddtext item expires in this run is gone after the same run (a-correct-1)", async () => {
    // A tiny model of the two stores: items with their expiry, and the ddtext
    // attention rows that live only while an item (its signals) backs them.
    const items = new Map([
      ["comment:al_old", { expiresAt: "2026-11-04T00:00:00.000Z" }],
      ["comment:al_new", { expiresAt: "2026-12-01T00:00:00.000Z" }]
    ]);
    const attention = new Map([
      ["ea_old", "comment:al_old"],
      ["ea_new", "comment:al_new"]
    ]);
    vi.mocked(purgeExpiredDdtext).mockImplementation(async (now: Date) => {
      let n = 0;
      for (const [key, item] of items) if (Date.parse(item.expiresAt) <= now.getTime()) (items.delete(key), (n += 1));
      return n;
    });
    vi.mocked(purgeOrphanDdtextAttention).mockImplementation(async () => {
      let n = 0;
      for (const [id, key] of attention) if (!items.has(key)) (attention.delete(id), (n += 1));
      return n;
    });
    const counts = await runPurge(undefined, NOW);
    expect([...attention.keys()]).toEqual(["ea_new"]);
    expect(counts).toMatchObject({ ddtextItems: 1, ddtextAttention: 1 });
  });

  it("before the P5a migration the steps report zeros (the stores tolerate missing tables)", async () => {
    vi.mocked(purgeExpiredDdtext).mockResolvedValue(0);
    vi.mocked(purgeOrphanDdtextAttention).mockResolvedValue(0);
    vi.mocked(purgeOldFeedback).mockResolvedValue(0);
    await expect(runPurge(undefined, NOW)).resolves.toMatchObject({ ddtextItems: 0, ddtextAttention: 0, attentionFeedback: 0 });
  });

  it("a failing expiry step doesn't skip the orphan sweep or the feedback step, and still fails the run", async () => {
    vi.mocked(purgeExpiredDdtext).mockRejectedValue(new Error("exec ddtext store: purge failed: lock timeout"));
    await expect(runPurge(undefined, NOW)).rejects.toThrow("exec.purge: 1 of 11 steps failed: ddtextItems: exec ddtext store: purge failed: lock timeout");
    expect(purgeOrphanDdtextAttention).toHaveBeenCalledTimes(1);
    expect(purgeOldFeedback).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("ddtextItems=0 ddtextAttention=12 attentionFeedback=13 chatConversations=14 chatMessages=15 chatStaleFailed=16 failed=1"));
  });

  it("P2b's 90-day resolved-row step is unchanged: resolved rows of every kind, by resolved_at and last_seen_at only", async () => {
    await runPurge(undefined, NOW);
    const attentionDelete = db.deletes.find((d) => d.table === "exec_attention_items");
    const cutoff = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    expect(attentionDelete?.filters).toEqual([
      ["eq", "status", "resolved"],
      ["lt", "resolved_at", cutoff],
      ["lt", "last_seen_at", cutoff]
    ]);
  });
});

