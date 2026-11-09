import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// Area A's store, P7a's facade and the build's enqueue, at their module boundaries.
vi.mock("@/lib/exec/slack-intel-store", () => ({ slackIntelSchemaReady: vi.fn(), slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => ({ listIntelChannels: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", () => ({ requestTodayDigests: vi.fn() }));

import * as digestsRoute from "@/app/api/exec/slack/digests/route";
import { assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { testPrincipal } from "@/lib/exec/__tests__/slack-route-helpers";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { loadSettings } from "@/lib/exec/principal";
import { requestTodayDigests } from "@/lib/exec/slack-digests";
import { slackIntelSchemaReady, slackIntelState } from "@/lib/exec/slack-intel-store";
import type { ChannelRow, SlackIntelState } from "@/lib/exec/slack-intel-types";
import { listIntelChannels } from "@/lib/exec/slack-reading";
import { AuditUnavailableError } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Area C: POST /api/exec/slack/digests (contract §3.10.2, C15; §5.10 RT11–RT15). The route runs with http.ts's real
// same-origin check, body reader, zod check, rate limiter (over a fake exec_audit_log read) and runAudited (over a mocked
// audit); the store's schema and state checks, P7a's channel read and requestTodayDigests are mocked at their modules.

const CH = (JSON.parse(readFileSync(new URL("./__tests__/fixtures/slack-intel/channels.json", import.meta.url), "utf8")) as { rows: Record<string, ChannelRow> }).rows;
const P = testPrincipal("ep_1");
const ROUTE = "POST /api/exec/slack/digests";
const NOW_MS = Date.now();

let auditReads: [string, unknown[]][][];
let auditAnswer: { data: unknown; error: { message: string } | null };
function fakeAuditDb(): SupabaseClient {
  return {
    from: (table: string) => {
      const steps: [string, unknown[]][] = [["from", [table]]];
      auditReads.push(steps);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "in", "order", "range", "abortSignal"]) {
        b[m] = (...args: unknown[]) => {
          steps.push([m, args]);
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(auditAnswer).then(resolve, reject);
      return b;
    }
  } as unknown as SupabaseClient;
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://operations.scaledai.org/api/exec/slack/digests", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}
const bodies: unknown[] = [];
async function post(body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await digestsRoute.POST(req(body, headers));
  const json = (await res.json()) as Record<string, unknown>;
  bodies.push(json);
  return { status: res.status, body: json, headers: res.headers };
}
const OK = { channelId: "C0ACMESEO" };

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
  bodies.length = 0;
  auditReads = [];
  auditAnswer = { data: [], error: null };
  vi.mocked(getSupabaseAdmin).mockReturnValue(fakeAuditDb());
  vi.mocked(requireExecPrincipal).mockReset().mockResolvedValue({ ok: true, principal: P });
  vi.mocked(auditStart).mockReset().mockResolvedValue(77);
  vi.mocked(auditFinish).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(slackIntelSchemaReady).mockReset().mockResolvedValue(true);
  vi.mocked(slackIntelState).mockReset().mockResolvedValue("ok");
  vi.mocked(listIntelChannels).mockReset().mockImplementation(async (_p, opts) =>
    Object.values(CH).filter((c) => c.class !== "deny" && (opts?.channelIds ?? []).includes(c.channelId)));
  vi.mocked(requestTodayDigests).mockReset().mockImplementation(async (_p, ids) => [...ids]);
});

afterEach(() => {
  // §0.3 rule 4: answers, logs and audit rows carry codes, the state and the channel id only.
  assertNoSlackLeak({ console: out, audit: [vi.mocked(auditStart), vi.mocked(auditFinish)], http: bodies }, { label: "slack-digests route" });
  for (const b of bodies) expect(JSON.stringify(b)).not.toMatch(/acme-dental|private-ops|partner-collab/);
});

const nothingDone = () => {
  expect(auditStart).not.toHaveBeenCalled();
  expect(requestTodayDigests).not.toHaveBeenCalled();
};

describe("the route module", () => {
  it("is dynamic, on Node, and exports POST only", () => {
    expect(digestsRoute.dynamic).toBe("force-dynamic");
    expect(digestsRoute.runtime).toBe("nodejs");
    expect(Object.keys(digestsRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  });
});

describe("POST /api/exec/slack/digests: the gate order (RT11)", () => {
  it("RT11 a link session gets the strong gate's own 404; nothing is read", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404 }) });
    expect(await post(OK)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(vi.mocked(requireExecPrincipal).mock.calls[0].slice(1)).toEqual([ROUTE, { requireStrongSignIn: true }]);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(auditReads).toEqual([]);
    nothingDone();
  });

  it("RT11 cross-origin → 403 before any read", async () => {
    for (const site of ["cross-site", "same-site"]) expect(await post(OK, { "sec-fetch-site": site })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(loadSettings).not.toHaveBeenCalled();
    expect(slackIntelSchemaReady).not.toHaveBeenCalled();
    nothingDone();
  });

  it("RT11 a schema missing → 503 not_installed before the rate limit; a failed check → 503 unavailable", async () => {
    vi.mocked(slackIntelSchemaReady).mockResolvedValue(false);
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "not_installed" } });
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingSchemaReady: false }));
    vi.mocked(slackIntelSchemaReady).mockClear();
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "not_installed" } });
    expect(slackIntelSchemaReady).not.toHaveBeenCalled();
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed"));
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(auditReads).toEqual([]);
    nothingDone();
  });

  it("RT11 20 builds requested in 10 minutes → 429 with Retry-After (before the body is read); a failed count → 503", async () => {
    auditAnswer = { data: [{ created_at: new Date(NOW_MS - 60_000).toISOString() }], error: null };
    const r = await post("{not json");
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: "rate_limited" });
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(480);
    const steps = auditReads[0];
    expect(steps[0]).toEqual(["from", ["exec_audit_log"]]);
    expect(steps.find((s) => s[0] === "in")).toEqual(["in", ["action", ["slack.digest.request"]]]);
    expect(steps.find((s) => s[0] === "range")).toEqual(["range", [19, 19]]);
    auditAnswer = { data: null, error: { message: "timeout" } };
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(slackIntelState).not.toHaveBeenCalled();
    nothingDone();
  });

  it.each<[string, unknown, number]>([
    ["an unknown key", { channelId: "C0ACMESEO", date: "2026-11-07" }, 400],
    ["no channel", {}, 400],
    ["a channel id outside the shape", { channelId: "acme-dental-seo" }, 400],
    ["a user id", { channelId: "U0JANE" }, 400],
    ["a body that isn't JSON", "{nope", 400],
    ["a body over 1 KB", { channelId: "C0ACMESEO", pad: "x".repeat(1_100) }, 413]
  ])("RT11 %s → %i, no state read, no audit", async (_label, body, status) => {
    const r = await post(body);
    expect(r.status).toBe(status);
    expect(r.body.error).toBe(status === 413 ? "too_large" : "invalid");
    expect(slackIntelState).not.toHaveBeenCalled();
    nothingDone();
  });
});

describe("POST /api/exec/slack/digests: the decision (RT12–RT15)", () => {
  it.each(["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as SlackIntelState[])(
    "RT12 state %s → 409 slack_off with the state; no channel read, no audit, nothing queued", async (state) => {
      vi.mocked(slackIntelState).mockResolvedValue(state);
      expect(await post(OK)).toMatchObject({ status: 409, body: { error: "slack_off", state } });
      expect(listIntelChannels).not.toHaveBeenCalled();
      nothingDone();
    });

  it("RT12 a failed state or channel read → 503 unavailable", async () => {
    vi.mocked(slackIntelState).mockRejectedValueOnce(new Error("x"));
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    vi.mocked(listIntelChannels).mockRejectedValueOnce(new Error("y"));
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    nothingDone();
  });

  it.each(["publicUnwatched", "leftPrivate", "publicMuted", "financeMuted", "hubOutbound", "unclassified", "im", "denyLead", "archived"])(
    "RT13 %s → 409 not_digestible (no today build); nothing audited or queued", async (key) => {
      expect(await post({ channelId: CH[key].channelId })).toMatchObject({ status: 409, body: { error: "not_digestible" } });
      nothingDone();
    });

  it("RT13 a conversation with no row → 409 not_digestible", async () => {
    expect(await post({ channelId: "C0GONE" })).toMatchObject({ status: 409, body: { error: "not_digestible" } });
    nothingDone();
  });

  it("RT14 a build queued → 202 queued; one built within the hour → 200 fresh; a watched finance channel and a group DM may build", async () => {
    const r = await post(OK);
    expect(r).toMatchObject({ status: 202, body: { status: "queued" } });
    expect(r.headers.get("cache-control")).toBe("no-store");
    const [p, ids, now, max] = vi.mocked(requestTodayDigests).mock.calls[0];
    expect([p, ids, max]).toEqual([P, ["C0ACMESEO"], 1]);
    expect(now).toBeInstanceOf(Date);
    vi.mocked(requestTodayDigests).mockResolvedValueOnce([]);
    expect(await post(OK)).toMatchObject({ status: 200, body: { status: "fresh" } });
    expect(await post({ channelId: CH.financeWatched.channelId })).toMatchObject({ status: 202 });
    expect(await post({ channelId: CH.mpim.channelId })).toMatchObject({ status: 202 });
  });

  it("RT15 audit first: slack.digest.request on the channel, input { channelId } only, finished with queued / fresh", async () => {
    await post(OK);
    expect(auditStart).toHaveBeenCalledWith(P, { actor: "owner", action: "slack.digest.request", target: "exec_slack_channels:C0ACMESEO", input: { channelId: "C0ACMESEO" } });
    expect(Object.keys(vi.mocked(auditStart).mock.calls[0][1].input as object)).toEqual(["channelId"]);
    expect(auditFinish).toHaveBeenLastCalledWith(77, { ok: true, result: { outcome: "queued" } });
    vi.mocked(requestTodayDigests).mockResolvedValueOnce([]);
    await post(OK);
    expect(auditFinish).toHaveBeenLastCalledWith(77, { ok: true, result: { outcome: "fresh" } });
    expect(vi.mocked(auditStart).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(requestTodayDigests).mock.invocationCallOrder[0]);
  });

  it("RT15 the audit row failing → 503 and nothing queued; the enqueue failing → 503, the audit row finished as an exception", async () => {
    vi.mocked(auditStart).mockRejectedValueOnce(new AuditUnavailableError("audit log unavailable"));
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(requestTodayDigests).not.toHaveBeenCalled();
    vi.mocked(requestTodayDigests).mockRejectedValueOnce(new Error("exec_jobs batch enqueue failed (1 rows): permission denied"));
    expect(await post(OK)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(auditFinish).toHaveBeenLastCalledWith(77, { ok: false, error: "exception" });
  });
});
