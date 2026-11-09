import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// P8 contract §5.15 OP01 and OP03 (OP02 is in scheduler-p8.test.ts): exec.ops-watch, the reaper alert, and which code path
// raises each M12 ops alert. listReapedJobs is the real jobs.ts read over a fake exec_jobs table.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { assertNoBriefText } from "@/lib/exec/__tests__/brief-assert";
import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";
import { createFakeJobsRead, type ReadRow } from "@/lib/exec/__tests__/fake-jobs-read";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { OPS_WATCH_JOB_KIND, opsWatchJobHandler, opsWatchSystemWork } from "@/lib/exec/handlers/ops-watch";
import { REAPED_ERROR_PREFIX } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { intervalBucket } from "@/lib/exec/time";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const NOW = new Date("2026-11-06T13:07:00Z");
const BUCKET = intervalBucket(NOW, 15);              // the bucket 13:00-13:15; the window is the one before it
const WINDOW_START = "2026-11-06T12:45:00Z";
const reaped = (worker = "w-1") => `${REAPED_ERROR_PREFIX}${worker})`;
const dead = (o: ReadRow): ReadRow => ({ status: "dead", finished_at: "2026-11-06T12:50:00Z", last_error: reaped(), ...o });

function run(rows: ReadRow[], payload: Record<string, unknown> = { bucket: BUCKET }) {
  const db = createFakeJobsRead({ exec_jobs: rows });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  const ctx = { job: jobRow({ kind: OPS_WATCH_JOB_KIND, payload }), principal: null, signal: new AbortController().signal, workerId: "w" };
  return { db, result: opsWatchJobHandler.run(ctx) };
}

beforeEach(() => {
  vi.mocked(notifyOps).mockReset();
  vi.mocked(notifyOps).mockResolvedValue(true);
});

describe("exec.ops-watch (C18)", () => {
  it("is a bulk system job, 30 s, its schedule every 15 minutes with the bucket in the payload", () => {
    expect(opsWatchJobHandler).toMatchObject({ kind: "exec.ops-watch", lane: "bulk", timeoutMs: 30_000 });
    expect(opsWatchSystemWork.payload?.({ now: NOW, utcDate: "2026-11-06", dueKey: "k" })).toEqual({ bucket: BUCKET });
    expect(Object.isFrozen(opsWatchJobHandler) && Object.isFrozen(opsWatchSystemWork)).toBe(true);
  });

  it("OP01 reaped jobs in the previous bucket → one notifyOps per kind with the count and the first id", async () => {
    const { db, result } = run([
      dead({ id: 21, kind: "exec.brief", finished_at: "2026-11-06T12:46:00Z" }),
      dead({ id: 25, kind: "exec.brief", finished_at: "2026-11-06T12:59:00Z", last_error: reaped("w-2") }),
      dead({ id: 22, kind: "exec.slack-sweep", finished_at: "2026-11-06T12:47:00Z" })
    ]);
    await expect(result).resolves.toEqual({ bucket: BUCKET, reaped: 3, kinds: 2 });
    expect(vi.mocked(notifyOps).mock.calls.map(([a]) => a)).toEqual([
      { key: "job-reaped:exec.brief", title: BRIEF_OPS.reaped.title, detail: "exec.brief: 2 job(s), first 21" },
      { key: "job-reaped:exec.slack-sweep", title: BRIEF_OPS.reaped.title, detail: "exec.slack-sweep: 1 job(s), first 22" }
    ]);
    expect(db.queries[0].filters).toEqual(expect.arrayContaining([
      { op: "gte", column: "finished_at", value: new Date(WINDOW_START).toISOString() },
      { op: "lt", column: "finished_at", value: "2026-11-06T13:00:00.000Z" }
    ]));
  });

  it("OP01 dead jobs killJob ended (another last_error) → no alert (theirs already went out)", async () => {
    const { result } = run([
      dead({ id: 30, kind: "exec.brief", last_error: "fatal: bad_payload" }),
      dead({ id: 31, kind: "exec.brief", last_error: "out of attempts: exec_jobs enqueue failed" })
    ]);
    await expect(result).resolves.toEqual({ bucket: BUCKET, reaped: 0, kinds: 0 });
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("OP01 reaped jobs outside the window (this bucket, or two back) → no alert", async () => {
    const { result } = run([
      dead({ id: 40, kind: "exec.brief", finished_at: "2026-11-06T13:00:00Z" }),
      dead({ id: 41, kind: "exec.brief", finished_at: "2026-11-06T12:44:59Z" }),
      dead({ id: 42, kind: "exec.brief", finished_at: null })
    ]);
    await expect(result).resolves.toEqual({ bucket: BUCKET, reaped: 0, kinds: 0 });
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it.each([[undefined], ["12"], [-1], [0], [1.5], [null]])("a payload bucket of %j is refused (NonRetryableError bad_payload)", async (bucket) => {
    const { result } = run([], bucket === undefined ? {} : { bucket });
    await expect(result).rejects.toMatchObject({ name: "NonRetryableError", message: "bad_payload", errorClass: "fatal" });
  });

  it("a read failure throws (the job retries nothing: maxAttempts 1, the next bucket's run reads its own window)", async () => {
    const db = createFakeJobsRead({ exec_jobs: [] });
    db.failNext("exec_jobs", { message: "timeout" });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    const ctx = { job: jobRow({ kind: OPS_WATCH_JOB_KIND, payload: { bucket: BUCKET } }), principal: null, signal: new AbortController().signal, workerId: "w" };
    await expect(opsWatchJobHandler.run(ctx)).rejects.toThrow("exec_jobs read failed");
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("returns and alerts ids, kinds and counts only", async () => {
    const { result } = run([dead({ id: 50, kind: "exec.checkin-send" })]);
    assertNoBriefText(await result);
    assertNoBriefText(notifyOps, { label: "notifyOps" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// OP03: every M12 alert key is raised by exactly the code paths §3.13 names. A static scan of src: a BRIEF_OPS.<key>
// reference outside its allowed files fails now; once those files are no longer stage-0 placeholders, the key must be
// referenced by at least one of them (the integrator's stage-2 tree makes this strict).
// ---------------------------------------------------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const ROOT = path.dirname(path.resolve(SRC));
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "__tests__") sourceFiles(abs, out);
    } else if (/\.(?:ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}

/** §3.13 / §3.11 / §1.1 M12: the files whose code raises each alert. */
const ALERT_PATHS: Record<keyof typeof BRIEF_OPS, readonly string[]> = {
  failed: ["src/lib/exec/handlers/brief.ts", "src/lib/exec/brief-build.ts", "src/lib/exec/brief-deliver.ts"],
  deliveryUnknown: ["src/lib/exec/brief-deliver.ts"],
  fallback: ["src/lib/exec/handlers/brief-fallback.ts"],
  fallbackFailed: ["src/lib/exec/handlers/brief-fallback.ts"],
  late: ["src/lib/exec/brief-build.ts", "src/lib/exec/brief-deliver.ts", "src/lib/exec/handlers/brief-fallback.ts"],
  notOwned: ["src/lib/exec/brief-build.ts"],
  tokenMismatch: ["src/lib/exec/handlers/checkin-send.ts", "src/lib/exec/handlers/brief-health.ts"],
  reaped: ["src/lib/exec/handlers/ops-watch.ts"],
  newNetwork: ["src/lib/exec/handlers/access-alert.ts"]
};

describe("OP03 the M12 ops alerts and their code paths", () => {
  const files = sourceFiles(path.join(SRC, "lib")).concat(sourceFiles(path.join(SRC, "app")), sourceFiles(path.join(SRC, "components")));
  const text = new Map(files.map((f) => [rel(f), readFileSync(f, "utf8")]));
  const REF = /\bBRIEF_OPS\s*(?:\.\s*([A-Za-z]+)|\[\s*["']([A-Za-z]+)["']\s*\])/g;
  const refs = new Map<string, Set<string>>();
  for (const [file, src] of text) {
    for (const m of src.matchAll(REF)) {
      const key = m[1] ?? m[2];
      if (!refs.has(key)) refs.set(key, new Set());
      refs.get(key)?.add(file);
    }
  }

  it("the table covers exactly BRIEF_OPS's keys, each a key function and a title", () => {
    expect(Object.keys(ALERT_PATHS).sort()).toEqual(Object.keys(BRIEF_OPS).sort());
    for (const [name, alert] of Object.entries(BRIEF_OPS)) {
      expect(typeof alert.key, name).toBe("function");
      expect(alert.title.length, name).toBeGreaterThan(0);
    }
    expect(BRIEF_OPS.reaped.key("exec.brief")).toBe("job-reaped:exec.brief");
    expect(BRIEF_OPS.newNetwork.key("ep_1")).toBe("exec-access-new-network:ep_1");
  });

  it.each(Object.keys(ALERT_PATHS) as (keyof typeof BRIEF_OPS)[])("BRIEF_OPS.%s is referenced only by its code paths", (name) => {
    const allowed = new Set(ALERT_PATHS[name]);
    const outside = [...(refs.get(name) ?? [])].filter((f) => !allowed.has(f));
    expect(outside, `${name} outside ${[...allowed].join(", ")}`).toEqual([]);
    // Stage 2 (integrator): every placeholder is gone, so each alert must be raised by at least one of its paths.
    expect(refs.get(name)?.size ?? 0, `${name} raised by none of ${ALERT_PATHS[name].join(", ")}`).toBeGreaterThan(0);
  });

  it("Area B's two alerts are raised by their handlers", () => {
    expect([...(refs.get("reaped") ?? [])]).toEqual(["src/lib/exec/handlers/ops-watch.ts"]);
    expect([...(refs.get("newNetwork") ?? [])]).toEqual(["src/lib/exec/handlers/access-alert.ts"]);
  });

  it("nothing names an ops key by its literal outside brief-copy.ts (every alert goes through BRIEF_OPS)", () => {
    const LITERAL = /["'`](?:brief-failed|brief-delivery-unknown|brief-fallback-failed|brief-late|brief-not-owned|checkin-token-mismatch|job-reaped|exec-access-new-network):/;
    const offenders = [...text].filter(([file, src]) => file !== "src/lib/exec/brief-copy.ts" && LITERAL.test(src)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
