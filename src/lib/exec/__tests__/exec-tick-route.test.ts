import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// /api/cron/exec-tick, end to end through the real cron-auth gate and the
// real exec runtime; only Supabase and the principal loaders are faked.
// (Route files under src/app aren't collected by vitest.config.mts, hence
// this test lives here.)

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, listEnabledPrincipals: vi.fn(), loadSettings: vi.fn(), loadPrincipalById: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listEnabledPrincipals, loadSettings, settingsFromRow } from "@/lib/exec/principal";
import { createFakeExecDb, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { __resetJobsForTests } from "@/lib/exec/jobs";
import { __resetSchedulerForTests } from "@/lib/exec/scheduler";
import { __resetExecRuntimeForTests } from "@/lib/exec/runtime";
import * as route from "@/app/api/cron/exec-tick/route";

const SECRET = "test-cron-secret-0123456789";
const URL_ = "https://operations.scaledai.org/api/cron/exec-tick";

let db: FakeExecDb;

function request(method: "GET" | "POST", headers: Record<string, string> = {}, url = URL_): Request {
  return new Request(url, { method, headers });
}

const authed = (method: "GET" | "POST" = "GET") => request(method, { authorization: `Bearer ${SECRET}` });
const call = (req: Request) => (req.method === "POST" ? route.POST(req) : route.GET(req));

function resetExec(): void {
  __resetExecRuntimeForTests();
  __resetJobsForTests();
  __resetSchedulerForTests();
}

beforeEach(() => {
  resetExec();
  db = createFakeExecDb();
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(listEnabledPrincipals).mockResolvedValue([]);
  vi.mocked(loadSettings).mockImplementation(async (id: string) => settingsFromRow(null, id));
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetExec();
});

describe("route config", () => {
  it("is dynamic with a 60 s ceiling", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBe(60);
  });
});

describe.each(["GET", "POST"] as const)("%s /api/cron/exec-tick", (method) => {
  it("answers 503 and runs nothing when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("EXEC_ENABLED", "true");
    const res = await call(authed(method));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "cron endpoint disabled: CRON_SECRET is not set" });
    expect(db.rpcCalls).toEqual([]);
  });

  it.each<[string, Record<string, string>, string]>([
    ["no header", {}, URL_],
    ["a wrong secret", { authorization: "Bearer not-the-secret" }, URL_],
    ["a non-Bearer scheme", { authorization: `Basic ${SECRET}` }, URL_],
    ["the secret in the query string", {}, `${URL_}?secret=${SECRET}`]
  ])("answers 403 and runs nothing for %s", async (_label, headers, url) => {
    vi.stubEnv("EXEC_ENABLED", "true");
    const res = await call(request(method, headers, url));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("skips while EXEC_ENABLED is off", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    const res = await call(authed(method));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, skipped: "disabled" });
    expect(db.rpcCalls).toEqual([]);
  });

  it("runs the tick with a 40 s budget and reports every part", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    // P8 (M10, C18): the two system works (exec.purge daily at 03:30 UTC, exec.ops-watch every 15 minutes) enqueue on every
    // tick with no principal, so the summary counts them and depends on the time of day: 12:00Z is past the purge's 03:30.
    // They are upserts into exec_jobs, not RPCs, so the RPC list is unchanged. P9 (F16): exec.slack-dm-purge is a third
    // system work (daily at 04:10 UTC, so also due at 12:00Z): system=3.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
    const res = await call(authed(method));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      scheduler: { principals: 0, enqueued: 0, reaped: 0, summary: "principals=0 enqueued=0 reaped=0 system=3" },
      interactive: { lane: "interactive", claimed: 0, running: 0 },
      bulk: { lane: "bulk", claimed: 0, running: 0 },
      budgetMs: 40_000
    });
    expect(typeof body.elapsedMs).toBe("number");
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["exec_reap_expired_leases", "exec_claim_jobs", "exec_claim_jobs"]);
  });

  it("answers 500 with ok: false when a part fails", async () => {
    vi.stubEnv("EXEC_ENABLED", "true");
    db.rpc.set("exec_claim_jobs", () => ({ data: null, error: { message: "connection refused" } }));
    const res = await call(authed(method));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      interactive: { lane: "interactive", error: "exec_claim_jobs failed (interactive): connection refused" },
      bulk: { lane: "bulk", error: "exec_claim_jobs failed (bulk): connection refused" }
    });
  });
});

describe("an unexpected throw from the runtime", () => {
  it("answers 500 with the message", async () => {
    vi.resetModules();
    vi.doMock("@/lib/exec/runtime", () => ({
      runExecTickForCron: vi.fn(async () => {
        throw new Error("runtime exploded");
      })
    }));
    try {
      const fresh = await import("@/app/api/cron/exec-tick/route");
      const res = await fresh.GET(authed());
      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ ok: false, error: "runtime exploded" });
      expect(console.error).toHaveBeenCalledWith("[cron:exec-tick] failed:", expect.any(Error));
    } finally {
      vi.doUnmock("@/lib/exec/runtime");
      vi.resetModules();
    }
  });
});
