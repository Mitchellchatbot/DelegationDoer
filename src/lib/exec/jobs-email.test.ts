import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The P3 additions to jobs.ts: the email job builders and keys, the batch
// enqueue (identical key sets), the queued count, the shared stagger, the
// capped bulk triage enqueue, and the dead-letter keyset (contract §3.11,
// v3.1 A7, round-4 addenda §1.2/§1.8).

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadPrincipalById: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { createFakePipelineDb, type FakePipelineDb, type Row } from "@/lib/exec/__tests__/fake-pipeline-db";
import {
  BULK_STAGGER_SPACING_MS,
  BULK_TRIAGE_CAP,
  EMAIL_ATTENTION_JOB_KIND,
  EMAIL_TRIAGE_JOB_KIND,
  TRIAGE_REASONS,
  __resetJobsForTests,
  attentionKick,
  countQueuedJobs,
  describeErrorSafe,
  emailJobKey,
  enqueueBacklogTriage,
  enqueueBulkTriage,
  enqueueJobs,
  existingJobKeys,
  isAttentionKick,
  isTriageReason,
  kickAttention,
  listDeadJobs,
  mailBacklogKey,
  mailEventKey,
  parseTriagePayload,
  reconKey,
  registerJobHandler,
  reserveStagger,
  retriageKey,
  triageJob,
  type BulkTriageItem
} from "@/lib/exec/jobs";
import { loadPrincipalById, principalFromRows } from "@/lib/exec/principal";
import { NonRetryableError, type EnqueueJobInput, type ExecPrincipal } from "@/lib/exec/types";

const NOW = new Date("2026-11-04T17:03:20.000Z");

function principalFor(id: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acct_1"], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = principalFor("ep_1");

let db: FakePipelineDb;
function useDb(cfg: Parameters<typeof createFakePipelineDb>[0] = {}): FakePipelineDb {
  db = createFakePipelineDb(cfg);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

const staggerRow = (lastRunAfter: string | null, rev = 1): Row => ({
  principal_id: "ep_1",
  source: "mail",
  key: "stagger",
  cursor: { lastRunAfter, rev },
  updated_at: NOW.toISOString()
});

function queuedJob(over: Row = {}): Row {
  return {
    kind: EMAIL_TRIAGE_JOB_KIND,
    lane: "bulk",
    principal_id: "ep_1",
    payload: { threadId: "t", reason: "backfill" },
    dedupe_key: `k-${Math.random()}`,
    status: "queued",
    max_attempts: 10,
    run_after: NOW.toISOString(),
    ...over
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.EXEC_ENABLED = "true";
  __resetJobsForTests();
  useDb({ pg: { tables: { exec_sync_state: [] } } });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.EXEC_ENABLED;
});

describe("triage jobs", () => {
  it("TRIAGE_REASONS is exactly the TriageReason union, with no catch-all retriage", () => {
    expect([...TRIAGE_REASONS].sort()).toEqual(
      ["assess", "backfill", "budget_retry", "dead_letter", "event", "flag", "policy", "reconcile", "runbook", "version"].sort()
    );
    expect(isTriageReason("retriage")).toBe(false);
    expect(isTriageReason("pending_sweep")).toBe(false);
    expect(isTriageReason("toString")).toBe(false);
  });

  it("triageJob sets the kind, 10 attempts, the lane and a references-only payload", () => {
    const at = new Date(NOW.getTime() + 8_000);
    const job = triageJob({
      principalId: "ep_1",
      lane: "interactive",
      threadId: "t1",
      messageId: "m1",
      accountId: "acct_1",
      reason: "event",
      dedupeKey: mailEventKey("ep_1", "m1"),
      runAfter: at
    });
    expect(job).toEqual({
      kind: EMAIL_TRIAGE_JOB_KIND,
      lane: "interactive",
      principalId: "ep_1",
      payload: { threadId: "t1", reason: "event", messageId: "m1", accountId: "acct_1" },
      dedupeKey: "mail:ep_1:m1",
      maxAttempts: 10,
      runAfter: at
    });
  });

  it("triageJob carries force and originalJobId only when set, and leaves runAfter to the database otherwise", () => {
    const assess = triageJob({ principalId: "ep_1", lane: "interactive", threadId: "t1", reason: "assess", force: true, dedupeKey: "k" });
    expect(assess.payload).toEqual({ threadId: "t1", reason: "assess", force: true });
    expect("runAfter" in assess).toBe(false);
    const dead = triageJob({ principalId: "ep_1", lane: "bulk", threadId: "t1", reason: "dead_letter", originalJobId: 77, force: false, dedupeKey: "k" });
    expect(dead.payload).toEqual({ threadId: "t1", reason: "dead_letter", originalJobId: 77 });
  });

  it.each([
    [{ reason: "retriage" }],
    [{ reason: "pending_sweep" }],
    [{ threadId: "" }],
    [{ threadId: "t\n1" }],
    [{ threadId: "x".repeat(201) }],
    [{ messageId: "" }],
    [{ accountId: 5 }],
    [{ originalJobId: 0 }],
    [{ dedupeKey: "" }]
  ])("triageJob refuses a malformed input %j (a bug, not a retry)", (over) => {
    const input = { principalId: "ep_1", lane: "bulk", threadId: "t1", reason: "reconcile", dedupeKey: "k", ...over };
    expect(() => triageJob(input as Parameters<typeof triageJob>[0])).toThrow(NonRetryableError);
  });

  it("parseTriagePayload reads back what triageJob wrote and refuses anything else", () => {
    const job = triageJob({ principalId: "ep_1", lane: "bulk", threadId: "t1", reason: "flag", messageId: "m1", accountId: "a1", dedupeKey: "k" });
    expect(parseTriagePayload(job.payload)).toEqual({ threadId: "t1", reason: "flag", messageId: "m1", accountId: "a1" });
    expect(parseTriagePayload({ threadId: "t1", reason: "assess", force: true, originalJobId: 4 })).toEqual({ threadId: "t1", reason: "assess", force: true, originalJobId: 4 });
    expect(parseTriagePayload({ threadId: "t1", reason: "retriage" })).toBeNull();
    expect(parseTriagePayload({ reason: "event" })).toBeNull();
    expect(parseTriagePayload({ threadId: "t1", reason: "event", force: "yes" })).toBeNull();
    expect(parseTriagePayload({ threadId: "t1", reason: "event", originalJobId: 1.5 })).toBeNull();
    expect(parseTriagePayload(null)).toBeNull();
    expect(parseTriagePayload([])).toBeNull();
  });
});

describe("dedupe keys (L20, L5, addenda)", () => {
  it("builds every key family", () => {
    expect(mailEventKey("ep_1", "m1")).toBe("mail:ep_1:m1");
    expect(mailBacklogKey("ep_1", "m1")).toBe("mail:ep_1:m1:bulk");
    expect(reconKey("ep_1", "t1", "m9")).toBe("recon:ep_1:t1:m9");
    expect(reconKey("ep_1", "t1", 1762275600000)).toBe("recon:ep_1:t1:1762275600000");
    expect(retriageKey("ep_1", "t1", "policy", "g3.l1")).toBe("retriage:ep_1:t1:policy:g3.l1");
    expect(retriageKey("ep_1", "t1", "dead", 42)).toBe("retriage:ep_1:t1:dead:42");
    expect(retriageKey("ep_1", "t1", "flag", "m7")).toBe("retriage:ep_1:t1:flag:m7");
  });

  it("hashes the variable part of a key past 300 characters, deterministically", () => {
    const longThread = "t".repeat(200);
    const longPrincipal = "p".repeat(90);
    expect(retriageKey("ep_1", longThread, "policy", "g1.l0").length).toBeLessThan(300);
    const a = retriageKey(longPrincipal, longThread, "policy", "g1.l0");
    const b = retriageKey(longPrincipal, longThread, "policy", "g1.l0");
    const c = retriageKey(longPrincipal, longThread, "policy", "g2.l0");
    expect(a.length).toBeLessThanOrEqual(300);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith(`retriage:${longPrincipal}:#`)).toBe(true);
    expect(emailJobKey("mail", "ep_1", "x".repeat(400))).not.toBe(emailJobKey("mail", "ep_1", "x".repeat(400), "bulk"));
  });
});

describe("attention kicks (L5)", () => {
  it("keys the next epoch minute and runs 2 s after it starts, with 3 attempts, on the given lane", () => {
    const minute = Math.floor(NOW.getTime() / 60_000);
    const kick = attentionKick(principal, "interactive", NOW);
    expect(kick).toEqual({
      kind: EMAIL_ATTENTION_JOB_KIND,
      lane: "interactive",
      principalId: "ep_1",
      payload: { kick: true },
      dedupeKey: `email-attn:ep_1:m${minute + 1}`,
      runAfter: new Date((minute + 1) * 60_000 + 2_000),
      maxAttempts: 3
    });
    expect(attentionKick(principal, "bulk", NOW).lane).toBe("bulk");
    // Every write in one minute shares the pass.
    expect(attentionKick(principal, "bulk", new Date(NOW.getTime() + 30_000)).dedupeKey).toBe(kick.dedupeKey);
    expect(attentionKick(principal, "bulk", new Date((minute + 1) * 60_000)).dedupeKey).toBe(`email-attn:ep_1:m${minute + 2}`);
  });

  it("tells a kick from the scheduled pass", () => {
    expect(isAttentionKick({ dedupe_key: "email-attn:ep_1:m5", payload: {} })).toBe(true);
    expect(isAttentionKick({ dedupe_key: null, payload: { kick: true } })).toBe(true);
    expect(isAttentionKick({ dedupe_key: "exec.email-attention:ep_1:i123", payload: {} })).toBe(false);
  });

  it("kickAttention enqueues once per minute and never throws", async () => {
    expect(await kickAttention(principal, "bulk", NOW)).toBe(true);
    expect(await kickAttention(principal, "interactive", NOW)).toBe(false);
    expect(db.jobsOf(EMAIL_ATTENTION_JOB_KIND)).toHaveLength(1);
    expect(db.jobsOf(EMAIL_ATTENTION_JOB_KIND)[0]).toMatchObject({ lane: "bulk", max_attempts: 3 });
    useDb({ failJobs: () => "connection reset" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(kickAttention(principal, "bulk", NOW)).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("enqueueJobs", () => {
  const job = (key: string, over: Partial<EnqueueJobInput> = {}): EnqueueJobInput => ({
    kind: EMAIL_TRIAGE_JOB_KIND,
    lane: "bulk",
    principalId: "ep_1",
    payload: { threadId: key, reason: "reconcile" },
    dedupeKey: key,
    maxAttempts: 10,
    runAfter: new Date(NOW.getTime() + 60_000),
    ...over
  });

  it("sends each request with one key set, so no column is nulled (contract §0)", async () => {
    const mixed = [job("a"), job("b", { runAfter: undefined }), job("c", { maxAttempts: undefined, runAfter: undefined }), job("d")];
    const r = await enqueueJobs(mixed);
    expect(r.enqueued).toBe(4);
    const upserts = db.jobRequests.filter((q) => q.kind === "upsert");
    expect(upserts).toHaveLength(3);
    for (const u of upserts) {
      const rows = u.payload as Row[];
      const shape = Object.keys(rows[0]).sort().join(",");
      expect(rows.every((row) => Object.keys(row).sort().join(",") === shape)).toBe(true);
      expect(u.options).toMatchObject({ onConflict: "dedupe_key", ignoreDuplicates: true });
    }
    // The defaults applied where a row left them out: run_after now, max_attempts 6.
    expect(db.job("b")).toMatchObject({ run_after: NOW.toISOString(), max_attempts: 10 });
    expect(db.job("c")).toMatchObject({ run_after: NOW.toISOString(), max_attempts: 6 });
    expect(db.job("a")?.run_after).toBe(new Date(NOW.getTime() + 60_000).toISOString());
  });

  it("the fake really nulls a missing key in a mixed array (what the grouping prevents)", async () => {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("exec_jobs")
      .upsert([{ kind: "k", lane: "bulk", payload: {}, dedupe_key: "x", run_after: NOW.toISOString() }, { kind: "k", lane: "bulk", payload: {}, dedupe_key: "y" }], {
        onConflict: "dedupe_key",
        ignoreDuplicates: true
      })
      .select("id");
    expect(error?.message).toMatch(/run_after/);
  });

  it("chunks at 200 rows per request and reports only new rows", async () => {
    await enqueueJobs([job("dup")]);
    const many = Array.from({ length: 449 }, (_, i) => job(`k${i}`));
    const r = await enqueueJobs([...many, job("dup"), job("k0")]);
    expect(r.enqueued).toBe(449);
    expect(r.inserted.map((x) => x.dedupeKey)).not.toContain("dup");
    const sizes = db.jobRequests.filter((q) => q.kind === "upsert").slice(1).map((q) => (q.payload as Row[]).length);
    expect(sizes).toEqual([200, 200, 50]);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
  });

  it("validates every row before writing any", async () => {
    await expect(enqueueJobs([job("ok"), job("bad", { kind: "not a kind!" })])).rejects.toThrow(/kind/);
    expect(db.jobs).toHaveLength(0);
  });

  it("throws on a database error (the caller's job retries)", async () => {
    useDb({ failJobs: (q) => (q.kind === "upsert" ? "service unavailable" : null) });
    await expect(enqueueJobs([job("a")])).rejects.toThrow(/service unavailable/);
  });

  it("kicks the interactive lane when interactive work was added", async () => {
    registerJobHandler({ kind: "test.noop", lane: "interactive", timeoutMs: 1_000, run: async () => null });
    await enqueueJobs([job("i1", { lane: "interactive", runAfter: undefined })]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.rpcCalls.some((c) => c.fn === "exec_claim_jobs" && c.args.p_lane === "interactive")).toBe(true);
  });
});

describe("existingJobKeys and countQueuedJobs", () => {
  it("existingJobKeys finds the keys that have a row, in URL-sized chunks", async () => {
    await enqueueJobs([
      triageJob({ principalId: "ep_1", lane: "bulk", threadId: "t1", reason: "reconcile", dedupeKey: "a" }),
      triageJob({ principalId: "ep_1", lane: "bulk", threadId: "t2", reason: "reconcile", dedupeKey: "c" })
    ]);
    expect(await existingJobKeys(["a", "b", "c", "a"])).toEqual(new Set(["a", "c"]));
    const longKeys = Array.from({ length: 90 }, (_, i) => `retriage:ep_1:${"t".repeat(120)}${i}:policy:g1.l0`);
    const before = db.jobRequests.length;
    await existingJobKeys(longKeys);
    expect(db.jobRequests.length - before).toBeGreaterThan(1);
  });

  it("countQueuedJobs counts queued jobs of one principal, kind and lane due by the instant, any reason by default", async () => {
    db.jobs.push(
      ...[
        queuedJob({ id: 1 }),
        queuedJob({ id: 2, run_after: new Date(NOW.getTime() + 4 * 60_000).toISOString(), payload: { threadId: "t", reason: "policy" } }),
        queuedJob({ id: 3, run_after: new Date(NOW.getTime() + 6 * 60_000).toISOString() }),
        queuedJob({ id: 4, status: "running" }),
        queuedJob({ id: 5, lane: "interactive" }),
        queuedJob({ id: 6, principal_id: "ep_2" }),
        queuedJob({ id: 7, kind: EMAIL_ATTENTION_JOB_KIND })
      ]
    );
    const q = { principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk" as const, runAfterBefore: new Date(NOW.getTime() + 5 * 60_000) };
    expect(await countQueuedJobs(q)).toBe(2);
    expect(await countQueuedJobs({ ...q, reasons: ["policy"] })).toBe(1);
    expect(await countQueuedJobs({ ...q, lane: undefined })).toBe(3);
  });

  it("countQueuedJobs throws on an error or a missing count, never reads it as zero", async () => {
    useDb({ failJobs: () => "timeout" });
    await expect(countQueuedJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, runAfterBefore: NOW })).rejects.toThrow(/timeout/);
    useDb();
    const supabase = getSupabaseAdmin() as unknown as { from(t: string): unknown };
    const real = supabase.from.bind(supabase);
    vi.spyOn(supabase, "from").mockImplementation((t: string) => {
      const builder = real(t) as Record<string, unknown>;
      if (t !== "exec_jobs") return builder;
      return {
        select: () => {
          const chain: Record<string, unknown> = {};
          for (const m of ["eq", "lte", "in", "abortSignal"]) chain[m] = () => chain;
          chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, count: null, error: null });
          return chain;
        }
      };
    });
    await expect(countQueuedJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, runAfterBefore: NOW })).rejects.toThrow(/no count/);
  });
});

describe("the shared stagger (mail/stagger)", () => {
  it("hands out slots 20 s apart from now when nothing is reserved, and stores the last one", async () => {
    const slots = await reserveStagger(principal, 3, NOW);
    expect(slots.map((d) => d.getTime() - NOW.getTime())).toEqual([0, 20_000, 40_000]);
    const row = db.pg.tables.exec_sync_state.find((r) => r.key === "stagger");
    expect((row?.cursor as Row).lastRunAfter).toBe(slots[2].toISOString());
  });

  it("continues 20 s after the last slot anyone took, so consecutive callers never overlap", async () => {
    const first = await reserveStagger(principal, 2, NOW);
    const second = await reserveStagger(principal, 2, new Date(NOW.getTime() + 5_000));
    expect(second[0].getTime()).toBe(first[1].getTime() + BULK_STAGGER_SPACING_MS);
    expect(second[1].getTime() - second[0].getTime()).toBe(BULK_STAGGER_SPACING_MS);
  });

  it("starts from now once the last slot is in the past", async () => {
    useDb({ pg: { tables: { exec_sync_state: [staggerRow(new Date(NOW.getTime() - 3_600_000).toISOString())] } } });
    expect((await reserveStagger(principal, 1, NOW))[0].getTime()).toBe(NOW.getTime());
  });

  it("restarts from now when the stored position is absurdly far out (corrupt)", async () => {
    useDb({ pg: { tables: { exec_sync_state: [staggerRow(new Date(NOW.getTime() + 30 * 86_400_000).toISOString())] } } });
    expect((await reserveStagger(principal, 1, NOW))[0].getTime()).toBe(NOW.getTime());
  });

  it("re-reads and retries when another writer moved the position in between", async () => {
    let raced = false;
    useDb({
      pg: {
        tables: { exec_sync_state: [staggerRow(NOW.toISOString(), 4)] },
        beforeExecute: (q, fake) => {
          if (!raced && q.op === "update" && q.table === "exec_sync_state") {
            raced = true;
            const row = fake.tables.exec_sync_state[0];
            row.cursor = { lastRunAfter: new Date(NOW.getTime() + 100_000).toISOString(), rev: 5 };
          }
        }
      }
    });
    const slots = await reserveStagger(principal, 1, NOW);
    expect(raced).toBe(true);
    expect(slots[0].getTime()).toBe(NOW.getTime() + 120_000);
  });

  it("replaces an unreadable row instead of wedging every writer", async () => {
    useDb({ pg: { tables: { exec_sync_state: [{ principal_id: "ep_1", source: "mail", key: "stagger", cursor: { lastRunAfter: 12, rev: 3 }, updated_at: NOW.toISOString() }] } } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const slots = await reserveStagger(principal, 1, NOW);
    expect(slots[0].getTime()).toBe(NOW.getTime());
    expect((db.pg.tables.exec_sync_state[0].cursor as Row).lastRunAfter).toBe(NOW.toISOString());
  });

  it("refuses a bad count, and reserves nothing for zero", async () => {
    await expect(reserveStagger(principal, -1, NOW)).rejects.toThrow(NonRetryableError);
    await expect(reserveStagger(principal, 1.5, NOW)).rejects.toThrow(NonRetryableError);
    expect(await reserveStagger(principal, 0, NOW)).toEqual([]);
    expect(db.pg.queries).toHaveLength(0);
  });

  it("throws (retryable) when the row keeps changing", async () => {
    useDb({
      pg: {
        tables: { exec_sync_state: [staggerRow(NOW.toISOString(), 1)] },
        beforeExecute: (q, fake) => {
          if (q.op === "update" && q.table === "exec_sync_state") {
            const row = fake.tables.exec_sync_state[0];
            row.cursor = { lastRunAfter: NOW.toISOString(), rev: Number((row.cursor as Row).rev) + 1 };
          }
        }
      }
    });
    const err = await reserveStagger(principal, 1, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });
});

describe("bulk triage under the cap (addenda §1.8)", () => {
  const item = (n: number, over: Partial<BulkTriageItem> = {}): BulkTriageItem => ({
    threadId: `t${n}`,
    reason: "backfill",
    dedupeKey: reconKey("ep_1", `t${n}`, `m${n}`),
    accountId: "acct_1",
    ...over
  });

  it("adds at most 12 minus the bulk triage jobs already due within 5 minutes, in order, at staggered slots", async () => {
    db.jobs.push(...Array.from({ length: 10 }, (_, i) => queuedJob({ id: 900 + i, run_after: new Date(NOW.getTime() + i * 20_000).toISOString() })));
    const r = await enqueueBulkTriage(principal, [item(1), item(2), item(3), item(4), item(5)], NOW);
    expect(r).toMatchObject({ enqueued: 2, duplicates: 0, blocked: 3 });
    expect(r.blockedKeys).toEqual([item(3).dedupeKey, item(4).dedupeKey, item(5).dedupeKey]);
    const added = db.jobs.filter((j) => (j.id as number) < 900);
    expect(added.map((j) => j.dedupe_key)).toEqual([item(1).dedupeKey, item(2).dedupeKey]);
    for (const j of added) expect(j).toMatchObject({ kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", max_attempts: 10 });
    expect(added.map((j) => Date.parse(j.run_after as string))).toEqual(r.runAfter.map((d) => d.getTime()));
    expect(r.runAfter[1].getTime() - r.runAfter[0].getTime()).toBe(BULK_STAGGER_SPACING_MS);
  });

  it("counts every reason and ignores other principals, lanes and far-future jobs", async () => {
    db.jobs.push(
      queuedJob({ id: 901, payload: { threadId: "x", reason: "event" } }),
      queuedJob({ id: 902, payload: { threadId: "x", reason: "dead_letter" } }),
      queuedJob({ id: 903, principal_id: "ep_2" }),
      queuedJob({ id: 904, lane: "interactive" }),
      queuedJob({ id: 905, run_after: new Date(NOW.getTime() + 10 * 60_000).toISOString() })
    );
    const r = await enqueueBulkTriage(principal, Array.from({ length: 20 }, (_, i) => item(i)), NOW);
    expect(r.enqueued).toBe(BULK_TRIAGE_CAP - 2);
  });

  it("drops work whose key already has a job before applying the cap (a re-read page never stalls)", async () => {
    await enqueueBulkTriage(principal, [item(1), item(2)], NOW);
    db.jobs.forEach((j) => (j.status = "succeeded"));
    const r = await enqueueBulkTriage(principal, [item(1), item(2), item(3), item(1)], NOW);
    expect(r).toMatchObject({ enqueued: 1, duplicates: 3, blocked: 0 });
  });

  it("work that is already queued doesn't take a place under the cap", async () => {
    await enqueueBulkTriage(principal, [item(1)], NOW);
    db.jobs.push(...Array.from({ length: 10 }, (_, i) => queuedJob({ id: 950 + i })));
    // 11 due soon: room for one. The known item must not take it from the new one.
    const r = await enqueueBulkTriage(principal, [item(1), item(2)], NOW);
    expect(r).toMatchObject({ enqueued: 1, duplicates: 1, blocked: 0 });
    expect(db.job(item(2).dedupeKey)).toBeDefined();
  });

  it("a batch never pushes the near-window count above 12", async () => {
    for (let round = 0; round < 6; round += 1) {
      const at = new Date(NOW.getTime() + round * 30_000);
      await enqueueBulkTriage(principal, Array.from({ length: 40 }, (_, i) => item(round * 100 + i)), at);
      const near = await countQueuedJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, lane: "bulk", runAfterBefore: new Date(at.getTime() + 5 * 60_000) });
      expect(near).toBeLessThanOrEqual(BULK_TRIAGE_CAP);
    }
  });

  it("enqueueBacklogTriage loads the principal through the trusted loader; a disabled one enqueues nothing", async () => {
    vi.mocked(loadPrincipalById).mockResolvedValueOnce(null);
    const none = await enqueueBacklogTriage("ep_1", [item(1)], NOW);
    expect(none).toMatchObject({ enqueued: 0, blocked: 1 });
    expect(db.jobs).toHaveLength(0);
    vi.mocked(loadPrincipalById).mockResolvedValueOnce(principal);
    const some = await enqueueBacklogTriage("ep_1", [item(1)], NOW);
    expect(some.enqueued).toBe(1);
    expect(loadPrincipalById).toHaveBeenLastCalledWith("ep_1");
  });
});

describe("listDeadJobs (addenda §1.2)", () => {
  const dead = (id: number, finishedAt: string, reason = "reconcile", over: Row = {}): Row =>
    queuedJob({ id, status: "dead", finished_at: finishedAt, payload: { threadId: `t${id}`, reason }, ...over });

  it("reads oldest death first, ties by id, and resumes after its cursor", async () => {
    const t1 = "2026-11-04T10:00:00.123456+00:00";
    const t2 = "2026-11-04T11:00:00.000001+00:00";
    db.jobs.push(dead(30, t2), dead(10, t1), dead(20, t1), dead(40, t2, "event", { principal_id: "ep_2" }), dead(50, t2, "event", { kind: EMAIL_ATTENTION_JOB_KIND }), queuedJob({ id: 60 }));
    const page1 = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: null, limit: 2 });
    expect(page1.jobs.map((j) => j.id)).toEqual([10, 20]);
    expect(page1.next).toEqual({ finishedAt: t1, id: 20 });
    const page2 = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: page1.next, limit: 2 });
    expect(page2.jobs.map((j) => j.id)).toEqual([30]);
    const page3 = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: page2.next, limit: 2 });
    expect(page3).toEqual({ jobs: [], next: null });
  });

  it("a job that dies later lands after the cursor even with a lower id", async () => {
    db.jobs.push(dead(500, "2026-11-04T10:00:00.000Z"));
    const first = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: null, limit: 10 });
    db.jobs.push(dead(100, "2026-11-04T12:00:00.000Z"));
    const later = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: first.next, limit: 10 });
    expect(later.jobs.map((j) => j.id)).toEqual([100]);
  });

  it("skips dead-letter re-runs but moves its cursor past them", async () => {
    db.jobs.push(dead(1, "2026-11-04T10:00:00.000Z", "dead_letter"), dead(2, "2026-11-04T10:01:00.000Z"));
    const r = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: null, limit: 10 });
    expect(r.jobs.map((j) => j.id)).toEqual([2]);
    const onlySkipped = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: null, limit: 1 });
    expect(onlySkipped).toEqual({ jobs: [], next: { finishedAt: "2026-11-04T10:00:00.000Z", id: 1 } });
  });

  it("leaves deaths newer than finishedBefore for a later run", async () => {
    db.jobs.push(dead(1, "2026-11-04T17:00:00.000Z"), dead(2, "2026-11-04T17:03:00.000Z"));
    const r = await listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: null, limit: 10, finishedBefore: new Date(NOW.getTime() - 60_000) });
    expect(r.jobs.map((j) => j.id)).toEqual([1]);
  });

  it("refuses a malformed cursor or limit, and throws on a database error", async () => {
    await expect(listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: { finishedAt: "", id: 1 }, limit: 1 })).rejects.toThrow(NonRetryableError);
    await expect(listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: null, limit: 0 })).rejects.toThrow(NonRetryableError);
    useDb({ failJobs: () => "boom" });
    await expect(listDeadJobs({ principalId: "ep_1", kind: EMAIL_TRIAGE_JOB_KIND, after: null, limit: 1 })).rejects.toThrow(/boom/);
  });
});

describe("describeErrorSafe", () => {
  it("is one clipped, scrubbed line", () => {
    const text = describeErrorSafe(new TypeError(`upstream said Bearer sk-ant-api03-${"a".repeat(40)} and ${"x".repeat(5_000)}`));
    expect(text.startsWith("TypeError: upstream said")).toBe(true);
    expect(text).not.toContain("sk-ant-api03");
    expect(text.length).toBeLessThanOrEqual(1_000);
  });
});
