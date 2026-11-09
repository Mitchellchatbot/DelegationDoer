import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// Area A's store, at its module boundary.
vi.mock("@/lib/exec/slack-intel-store", () => ({ slackIntelSchemaReady: vi.fn(), setChannelTags: vi.fn(), listChannelLinks: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listClients: vi.fn(), listProjects: vi.fn() }));

import * as linksRoute from "@/app/api/exec/slack/channels/[channelId]/links/route";
import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { testPrincipal } from "@/lib/exec/__tests__/slack-route-helpers";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { listChannelLinks, setChannelTags, slackIntelSchemaReady } from "@/lib/exec/slack-intel-store";
import type { SlackChannelLink } from "@/lib/exec/slack-intel-types";
import { DdReadError, listClients, listProjects } from "@/lib/exec/sources/dd";
import type { DdClient, DdProject } from "@/lib/exec/sources/dd-types";
import { AuditUnavailableError } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Area B: PUT /api/exec/slack/channels/:channelId/links (contract §3.10.1, C25; §5.10 RT01–RT10). The route runs with
// http.ts's real same-origin check, body reader, zod check, rate limiter (over a fake exec_audit_log read) and runAudited
// (over a mocked audit); Area A's store, the DD reads and the job queue are mocked at their module boundaries.

const P = testPrincipal("ep_1");
const ROUTE = "PUT /api/exec/slack/channels/:id/links";
const NOW_MS = Date.now();

function client(id: string, name: string, status = "active"): DdClient {
  return { id, name, status, healthScore: null, healthLabel: null, healthSampleSize: null, healthComputedAt: null, healthOverrideLabel: null,
    healthOverrideBy: null, healthOverrideAt: null, touchpointOverrideLabel: null, touchpointOverrideBy: null, touchpointOverrideAt: null,
    lastOutboundEmailAtExternal: null, touchpointSyncedAt: null };
}
const project = (id: string): DdProject => ({ id, name: `${S.clientName} ${id}`, departmentId: null, createdAt: "2026-10-01T00:00:00.000Z" });
const CLIENTS = [client("cl_acme", S.clientName), client("cl_old", "Old Client", "churned"), client("cl_blank", "  ")];
const PROJECTS = [project("pr_1"), project("pr_2"), project("pr_3")];
const LINK: SlackChannelLink = {
  channelId: "C0ACMESEO", tagClientId: "cl_acme", tagClientName: S.clientName, tagProjectIds: ["pr_1"], taggedAt: "2026-11-08T15:00:00.000Z",
  clientId: "cl_acme", clientName: S.clientName, clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1
};

/** exec_audit_log's rate read (auditNthNewestAt): every step recorded, the answer settable. */
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

function req(channelId: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://operations.scaledai.org/api/exec/slack/channels/${channelId}/links`, {
    method: "PUT",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}
const bodies: unknown[] = [];
async function put(channelId: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await linksRoute.PUT(req(channelId, body, headers), { params: { channelId } });
  const json = (await res.json()) as Record<string, unknown>;
  bodies.push(json);
  return { status: res.status, body: json, headers: res.headers };
}
const OK_BODY = { clientId: "cl_acme", projectIds: ["pr_1", "pr_2", "pr_1"] };

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
  bodies.length = 0;
  auditReads = [];
  auditAnswer = { data: [], error: null };
  vi.mocked(getSupabaseAdmin).mockReturnValue(fakeAuditDb());
  vi.mocked(requireExecPrincipal).mockReset().mockResolvedValue({ ok: true, principal: P });
  vi.mocked(auditStart).mockReset().mockResolvedValue(91);
  vi.mocked(auditFinish).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(slackIntelSchemaReady).mockReset().mockResolvedValue(true);
  vi.mocked(setChannelTags).mockReset().mockResolvedValue("ok");
  vi.mocked(listChannelLinks).mockReset().mockResolvedValue(new Map([["C0ACMESEO", LINK]]));
  vi.mocked(listClients).mockReset().mockResolvedValue(CLIENTS);
  vi.mocked(listProjects).mockReset().mockResolvedValue(PROJECTS);
  vi.mocked(enqueueJob).mockReset().mockResolvedValue({ enqueued: true, id: 7 });
});

afterEach(() => {
  // §0.3 rule 4: logs, audit rows and job payloads hold ids, counts and codes only. A 200 answer is the link row itself (its
  // client name is the tag he chose); every other answer holds no name.
  assertNoSlackLeak({ console: out, audit: [vi.mocked(auditStart), vi.mocked(auditFinish)], jobs: vi.mocked(enqueueJob) }, { label: "slack-links route" });
  assertNoSlackLeak({ http: bodies.filter((b) => !(b as { links?: unknown }).links) }, { label: "error bodies" });
});

const nothingWritten = () => {
  expect(auditStart).not.toHaveBeenCalled();
  expect(setChannelTags).not.toHaveBeenCalled();
  expect(enqueueJob).not.toHaveBeenCalled();
};

describe("the route module", () => {
  it("is dynamic, on Node, and exports PUT only", () => {
    expect(linksRoute.dynamic).toBe("force-dynamic");
    expect(linksRoute.runtime).toBe("nodejs");
    expect(Object.keys(linksRoute).sort()).toEqual(["PUT", "dynamic", "runtime"]);
  });
});

describe("PUT /api/exec/slack/channels/:channelId/links", () => {
  it("RT01 a link (magic-link) session gets the strong gate's own 404; nothing is read", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not_found" }, { status: 404 }) });
    const r = await put("C0ACMESEO", OK_BODY);
    expect([r.status, r.body]).toEqual([404, { error: "not_found" }]);
    expect(vi.mocked(requireExecPrincipal).mock.calls[0].slice(1)).toEqual([ROUTE, { requireStrongSignIn: true }]);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(auditReads).toEqual([]);
    nothingWritten();
  });

  it("RT02 cross-origin → 403 before any read", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const r = await put("C0ACMESEO", OK_BODY, { "sec-fetch-site": site });
      expect([r.status, r.body]).toEqual([403, { error: "forbidden" }]);
    }
    expect(loadSettings).not.toHaveBeenCalled();
    expect(slackIntelSchemaReady).not.toHaveBeenCalled();
    expect(listClients).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("RT03 a channel id outside the stored shape → 404, before the schema check", async () => {
    for (const id of ["c0acmeseo", "X0ACMESEO", "U0JANE", "C0", `C${"A".repeat(31)}`, "C0ACME-SEO", "C0ACME%20", ""]) {
      const r = await linksRoute.PUT(req(id || "x", OK_BODY), { params: { channelId: id } });
      expect(r.status, id).toBe(404);
      const body = await r.json();
      bodies.push(body);
      expect(body).toEqual({ error: "not_found" });
    }
    expect(loadSettings).not.toHaveBeenCalled();
    // Public, private and DM ids are the shape; whether one can be tagged is the store's decision (409).
    for (const id of ["C0ACMESEO", "G0PRIVOPS", "D0JANE"]) expect((await put(id, { clientId: null, projectIds: [] })).status, id).toBe(200);
  });

  it("RT04 the P7a or P7b schema missing → 503 not_installed, before the rate limit; a failed check → 503 unavailable", async () => {
    vi.mocked(slackIntelSchemaReady).mockResolvedValue(false);
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "not_installed" } });
    vi.mocked(slackIntelSchemaReady).mockClear();
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingSchemaReady: false }));
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "not_installed" } });
    expect(slackIntelSchemaReady).not.toHaveBeenCalled();
    expect(auditReads).toEqual([]);
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed"));
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    vi.mocked(loadSettings).mockResolvedValue(settings());
    vi.mocked(slackIntelSchemaReady).mockRejectedValue(new Error("probe failed"));
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(auditReads).toEqual([]);
    nothingWritten();
  });

  it("RT05 60 slack.channel.links rows in 10 minutes → 429 with Retry-After; a failed count → 503; neither audits or writes", async () => {
    auditAnswer = { data: [{ created_at: new Date(NOW_MS - 120_000).toISOString() }], error: null };
    const r = await put("C0ACMESEO", OK_BODY);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: "rate_limited" });
    const retry = Number(r.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(400);
    expect(retry).toBeLessThanOrEqual(480);
    // The count: the principal's slack.channel.links audit rows of the last 10 minutes, the 60th newest.
    const steps = auditReads[0];
    expect(steps[0]).toEqual(["from", ["exec_audit_log"]]);
    expect(steps.find((s) => s[0] === "eq")).toEqual(["eq", ["principal_id", "ep_1"]]);
    expect(steps.find((s) => s[0] === "in")).toEqual(["in", ["action", ["slack.channel.links"]]]);
    expect(steps.find((s) => s[0] === "range")).toEqual(["range", [59, 59]]);
    const since = Date.parse(String((steps.find((s) => s[0] === "gte") as [string, unknown[]])[1][1]));
    expect(Math.abs(since - (NOW_MS - 600_000))).toBeLessThan(60_000);
    expect(listClients).not.toHaveBeenCalled();
    auditAnswer = { data: null, error: { message: "canceling statement due to statement timeout" } };
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    nothingWritten();
  });

  it.each<[string, unknown, number]>([
    ["an unknown key", { ...OK_BODY, channelName: "x" }, 400],
    ["no projectIds", { clientId: "cl_acme" }, 400],
    ["more than 10 projects", { clientId: null, projectIds: Array.from({ length: 11 }, (_, i) => `pr_${i}`) }, 400],
    ["a project id over 100 characters", { clientId: null, projectIds: ["p".repeat(101)] }, 400],
    ["an empty client id", { clientId: "", projectIds: [] }, 400],
    ["a client id of the wrong type", { clientId: 7, projectIds: [] }, 400],
    ["a body that isn't JSON", "{nope", 400],
    ["a body over 2 KB", { clientId: null, projectIds: [], pad: "x".repeat(2_100) }, 413]
  ])("RT06 %s → %i, no DD read, no audit", async (_label, body, status) => {
    const r = await put("C0ACMESEO", body);
    expect(r.status).toBe(status);
    expect(r.body.error).toBe(status === 413 ? "too_large" : "invalid");
    expect(listClients).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("RT07 an inactive client → 422 inactive_client; an unknown client or project → 422; a failed DD read → 503; nothing written", async () => {
    expect(await put("C0ACMESEO", { clientId: "cl_old", projectIds: [] })).toMatchObject({ status: 422, body: { error: "inactive_client" } });
    expect(await put("C0ACMESEO", { clientId: "cl_nope", projectIds: [] })).toMatchObject({ status: 422, body: { error: "unknown_client" } });
    expect(await put("C0ACMESEO", { clientId: "cl_blank", projectIds: [] })).toMatchObject({ status: 422, body: { error: "unknown_client" } });
    expect(await put("C0ACMESEO", { clientId: "cl_acme", projectIds: ["pr_1", "pr_9"] })).toMatchObject({ status: 422, body: { error: "unknown_project" } });
    expect(await put("C0ACMESEO", { clientId: null, projectIds: ["pr_9"] })).toMatchObject({ status: 422, body: { error: "unknown_project" } });
    vi.mocked(listClients).mockRejectedValue(new DdReadError("clients", "53300"));
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    vi.mocked(listClients).mockResolvedValue(CLIENTS);
    vi.mocked(listProjects).mockRejectedValue(new DdReadError("projects", "53300"));
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    // The bodies name no client or project.
    for (const b of bodies) expect(Object.keys(b as object)).toEqual(["error"]);
    nothingWritten();
  });

  it("RT08 audit first: the audit row failing → 503 and no write, no kick", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("audit log unavailable"));
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(setChannelTags).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("RT09 the store's not_taggable → 409, not_found → 404; both audited with their outcome, no kick", async () => {
    vi.mocked(setChannelTags).mockResolvedValueOnce("not_taggable");
    expect(await put("C0FBLEADS", OK_BODY)).toMatchObject({ status: 409, body: { error: "not_taggable" } });
    expect(auditFinish).toHaveBeenLastCalledWith(91, { ok: false, result: { outcome: "not_taggable" } });
    vi.mocked(setChannelTags).mockResolvedValueOnce("not_found");
    expect(await put("C0GONE", OK_BODY)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(auditFinish).toHaveBeenLastCalledWith(91, { ok: false, result: { outcome: "not_found" } });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(listChannelLinks).not.toHaveBeenCalled();
    // The store throwing → 503, the audit row finished as an exception.
    vi.mocked(setChannelTags).mockRejectedValueOnce(new Error("exec slack intel store: setChannelTags failed (23514)"));
    expect(await put("C0ACMESEO", OK_BODY)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(auditFinish).toHaveBeenLastCalledWith(91, { ok: false, error: "exception" });
  });

  it("RT10 success → 200 with the link row, the tags replaced (client name from DD, projects deduped), audited first, a correlate kick", async () => {
    const r = await put("C0ACMESEO", OK_BODY);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ links: LINK });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(setChannelTags).toHaveBeenCalledWith(P, { channelId: "C0ACMESEO", client: { id: "cl_acme", name: S.clientName }, projectIds: ["pr_1", "pr_2"] });
    expect(auditStart).toHaveBeenCalledWith(P, { actor: "owner", action: "slack.channel.links", target: "exec_slack_channels:C0ACMESEO",
      input: { channelId: "C0ACMESEO", hasClient: true, projectCount: 2 } });
    expect(vi.mocked(auditStart).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(setChannelTags).mock.invocationCallOrder[0]);
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "ok" } });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "exec.slack-correlate", lane: "bulk", principalId: "ep_1", payload: {},
      dedupeKey: expect.stringMatching(/^slkcorr:ep_1:m\d+$/) });
    expect(listChannelLinks).toHaveBeenCalledWith(P, { channelIds: ["C0ACMESEO"] });
  });

  it("RT10 clearing the tags: no client, no projects, no DD read", async () => {
    vi.mocked(listChannelLinks).mockResolvedValue(new Map());
    const r = await put("C0ACMESEO", { clientId: null, projectIds: [] });
    expect([r.status, r.body]).toEqual([200, { links: null }]);
    expect(setChannelTags).toHaveBeenCalledWith(P, { channelId: "C0ACMESEO", client: null, projectIds: [] });
    expect(auditStart).toHaveBeenCalledWith(P, expect.objectContaining({ input: { channelId: "C0ACMESEO", hasClient: false, projectCount: 0 } }));
    expect(listClients).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("RT10 a failed kick or read-back doesn't undo the write: 200, logged by id only", async () => {
    vi.mocked(enqueueJob).mockRejectedValue(new Error("exec_jobs enqueue failed (exec.slack-correlate): 53300"));
    vi.mocked(listChannelLinks).mockRejectedValue(new Error("exec slack intel store: listChannelLinks failed (53300)"));
    const r = await put("C0ACMESEO", OK_BODY);
    expect([r.status, r.body]).toEqual([200, { links: null }]);
    const logged = out.calls().map((c) => String(c[0]));
    expect(logged).toEqual([`[exec-slack-intel] ${ROUTE} for ep_1: correlate kick failed (Error)`, `[exec-slack-intel] ${ROUTE} for ep_1: read-back failed (Error)`]);
  });
});
