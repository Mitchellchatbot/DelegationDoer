import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
// Area E's view, at its module boundary.
vi.mock("@/lib/exec/slack-settings", () => ({ getSlackSettingsView: vi.fn() }));
// Area A's real store over the fake DB, with call spies.
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/slack-install")>();
  return { ...a, revokeInstallation: vi.fn(a.revokeInstallation), openActiveInstallation: vi.fn(a.openActiveInstallation), slackSchemaReady: vi.fn(a.slackSchemaReady) };
});

import * as disconnectRoute from "@/app/api/exec/slack/disconnect/route";
import { installFakeSlack, SLACK_RECORDED, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { createFakeSlackDb, type FakeSlackDb, type FakeSlackDbSeed } from "@/lib/exec/__tests__/fake-slack-db";
import { SENTINELS, findSentinel } from "@/lib/exec/__tests__/slack-assert";
import { INSTALLATION_ID, hex32, installationRow, slackEnv, testPrincipal } from "@/lib/exec/__tests__/slack-route-helpers";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { jsonError, rateLimit } from "@/lib/exec/http";
import { revokeInstallation } from "@/lib/exec/slack-install";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import type { SlackSettingsView } from "@/lib/exec/slack-types";
import { AuditUnavailableError } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// POST /api/exec/slack/disconnect (P6 contract §3.10.5, K15, C23; Area C):
// DC01-DC06. The route runs with http.ts's real same-origin check, body reader,
// zod check and runAudited (over a mocked audit), Area A's real store over
// fake-slack-db.ts (RPC 3 mirrored: the revoke and its purge job), and Slack's
// auth.revoke through fake-slack-api.ts.

const P = testPrincipal("ep_1");
const URL_DISCONNECT = "https://operations.scaledai.org/api/exec/slack/disconnect";
const OTHER_ID = `esi_${hex32(2)}`;
const VIEW = { schema: true, configured: true, state: "revoked", installationId: INSTALLATION_ID } as unknown as SlackSettingsView;

let db: FakeSlackDb;
let spies: ReturnType<typeof vi.spyOn>[];

function useEnv(over: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries(slackEnv(over))) vi.stubEnv(k, v);
}
function useDb(seed?: FakeSlackDbSeed): FakeSlackDb {
  db = createFakeSlackDb(seed);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const owner = (over = {}): FakeSlackDbSeed => ({ tables: { exec_slack_installations: [installationRow(over)] } });
function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_DISCONNECT, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}
const ok = (installationId = INSTALLATION_ID) => ({ installationId, confirm: "disconnect" });
const post = (body: unknown, headers?: Record<string, string>) => disconnectRoute.POST(req(body, headers));
const revoke = (h: FakeSlackHandler) => installFakeSlack({ "auth.revoke": h });
const row = () => db.tables.exec_slack_installations.find((r) => r.id === INSTALLATION_ID);
const consoleCalls = () => spies.flatMap((s) => s.mock.calls);

beforeEach(() => {
  useEnv();
  useDb(owner());
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.mocked(requireExecPrincipal).mockReset().mockResolvedValue({ ok: true, principal: P });
  vi.mocked(auditStart).mockReset().mockResolvedValue(91);
  vi.mocked(auditFinish).mockReset().mockResolvedValue(undefined);
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(getSlackSettingsView).mockReset().mockResolvedValue(VIEW);
  vi.mocked(revokeInstallation).mockClear();
});

afterEach(() => {
  expect(findSentinel([consoleCalls(), vi.mocked(auditStart).mock.calls.map((c) => c[1]), vi.mocked(auditFinish).mock.calls])).toBeNull();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("route module", () => {
  it("is dynamic, on the Node runtime, and exports POST only", () => {
    expect(disconnectRoute.dynamic).toBe("force-dynamic");
    expect(disconnectRoute.runtime).toBe("nodejs");
    expect(Object.keys(disconnectRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  });
});

describe("DC01 the gates and the body", () => {
  it("the strong gate: its answer passes through, and it is asked for the strong sign-in", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) });
    const res = await post(ok());
    expect(res.status).toBe(404);
    expect(vi.mocked(requireExecPrincipal).mock.calls[0].slice(1)).toEqual(["POST /api/exec/slack/disconnect", { requireStrongSignIn: true }]);
    expect(db.calls).toEqual([]);
  });

  it("same-origin: a cross-site request → 403 forbidden, nothing read", async () => {
    const res = await post(ok(), { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(db.calls).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["an unknown key", { ...ok(), extra: 1 }, "extra"],
    ["a malformed installation id", ok("esi_nothex"), "installationId"],
    ["the wrong confirmation", { installationId: INSTALLATION_ID, confirm: "yes" }, "confirm"],
    ["no confirmation", { installationId: INSTALLATION_ID }, "confirm"],
    ["not JSON", "{nope", "body"]
  ])("%s → 400 invalid (%s)", async (_label, body, detail) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", detail });
    expect(auditStart).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("a body over 1 KB → 413 too_large", async () => {
    const res = await post({ ...ok(), pad: "x".repeat(1100) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  });

  it("the P6 migration missing → 409 not_installed; its check failing → 503", async () => {
    useDb({ missing: ["exec_slack_installations"] });
    expect([(await post(ok())).status]).toEqual([409]);
    useDb({ fail: () => ({ code: "53300", message: "x" }) });
    const res = await post(ok());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("the rate limit (10 / 10 min on slack.disconnect rows) answers for itself", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 42 }) });
    const res = await post(ok());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(rateLimit).toHaveBeenCalledWith(P, "slack_disconnect", 10, 600_000);
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("the audit unavailable → 503 unavailable, nothing revoked", async () => {
    const s = revoke(() => SLACK_RECORDED.revoke());
    vi.mocked(auditStart).mockRejectedValueOnce(new AuditUnavailableError("audit log unavailable"));
    const res = await post(ok());
    expect(res.status).toBe(503);
    expect(s.calls).toEqual([]);
    expect(row()?.revoked_at).toBeNull();
  });
});

describe("the act", () => {
  it("DC02 auth.revoke on the BOT token, then revokeInstallation(id, disconnected); 200 with the Settings view", async () => {
    const order: string[] = [];
    const s = revoke(() => {
      order.push("auth.revoke");
      return SLACK_RECORDED.revoke();
    });
    const actual = await vi.importActual<typeof import("@/lib/exec/slack-install")>("@/lib/exec/slack-install");
    vi.mocked(revokeInstallation).mockImplementationOnce(async (id, reason) => {
      order.push(`revokeInstallation:${reason}`);
      return actual.revokeInstallation(id, reason);
    });
    const res = await post(ok());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slack: VIEW });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(order).toEqual(["auth.revoke", "revokeInstallation:disconnected"]);
    expect(s.calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${SENTINELS.token}`]);
    expect(vi.mocked(revokeInstallation).mock.calls[0]).toEqual([INSTALLATION_ID, "disconnected"]);
    expect(row()).toMatchObject({ revoke_reason: "disconnected" });
    expect(row()?.revoked_at).not.toBeNull();
    expect(db.tables.exec_jobs.map((j) => [j.kind, j.dedupe_key])).toEqual([["exec.slack-uninstall", `slack-uninstall:${INSTALLATION_ID}`]]);
    expect(auditStart).toHaveBeenCalledWith(P, {
      actor: "owner", action: "slack.disconnect", target: `exec_slack_installations:${INSTALLATION_ID}`, input: { installationId: INSTALLATION_ID }
    });
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "revoked" } });
    expect(getSlackSettingsView).toHaveBeenCalledWith(P);
  });

  it("DC03 Slack internal_error → 503 slack_unavailable, the row unchanged, the audit finished ok: false", async () => {
    const s = revoke(() => SLACK_RECORDED.error("internal_error"));
    const res = await post(ok());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "slack_unavailable" });
    expect(s.calls).toHaveLength(1);
    expect(revokeInstallation).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ revoked_at: null, revoke_reason: null });
    expect(db.tables.exec_jobs).toEqual([]);
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "slack_unavailable" } });
    expect(consoleCalls().some((c) => String(c[0]).includes("(internal_error)"))).toBe(true);
  });

  it("DC03 Slack unreachable (HTTP 503) → 503 slack_unavailable, nothing changed", async () => {
    revoke(() => new Response("", { status: 503 }));
    expect((await post(ok())).status).toBe(503);
    expect(row()?.revoked_at).toBeNull();
  });

  it("DC04 token_revoked (Slack already considers it dead) → proceeds: 200, revoked locally", async () => {
    revoke(() => SLACK_RECORDED.error("token_revoked"));
    const res = await post(ok());
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ revoke_reason: "disconnected" });
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: true, result: { outcome: "revoked" } });
  });

  it("DC05 a token that can't be opened here → local_only: no Slack call, revoked locally, 200", async () => {
    useDb(owner({ sealed_for: "ep_someone_else" }));
    const s = revoke(() => SLACK_RECORDED.revoke());
    const res = await post(ok());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slack: VIEW });
    expect(s.calls).toEqual([]);
    expect(row()).toMatchObject({ revoke_reason: "disconnected" });
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "local_only" } });
  });

  it("DC05 with EXEC_TOKEN_KEY gone too → local_only", async () => {
    const s = revoke(() => SLACK_RECORDED.revoke());
    useEnv({ EXEC_TOKEN_KEY: undefined });
    const res = await post(ok());
    expect(res.status).toBe(200);
    expect(s.calls).toEqual([]);
    expect(row()?.revoke_reason).toBe("disconnected");
  });

  it("DC06 the id of another installation → 404 not_found, no Slack call, the row unchanged", async () => {
    const s = revoke(() => SLACK_RECORDED.revoke());
    const res = await post(ok(OTHER_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(s.calls).toEqual([]);
    expect(row()?.revoked_at).toBeNull();
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "not_found" } });
  });

  it("DC06 another principal's installation (even with the right id) → 404", async () => {
    useDb(owner({ principal_id: "ep_2" }));
    const s = revoke(() => SLACK_RECORDED.revoke());
    expect((await post(ok())).status).toBe(404);
    expect(s.calls).toEqual([]);
    expect(row()?.revoked_at).toBeNull();
  });

  it("DC06 no active installation (already revoked) → 404", async () => {
    useDb(owner({ bot_token_enc: null, key_id: null, revoked_at: "2026-11-02T00:00:00.000Z", revoke_reason: "app_uninstalled" }));
    expect((await post(ok())).status).toBe(404);
  });

  it("a revoke that lands after another revoked it (RPC 3 answers revoked: false) → 200, on record as already_revoked", async () => {
    revoke(() => SLACK_RECORDED.revoke());
    vi.mocked(revokeInstallation).mockResolvedValueOnce({ revoked: false });
    const res = await post(ok());
    expect(res.status).toBe(200);
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, result: { outcome: "already_revoked" } });
  });

  it("the store failing during the act → 503 unavailable (runAudited), the audit finished as an exception", async () => {
    revoke(() => SLACK_RECORDED.revoke());
    vi.mocked(revokeInstallation).mockRejectedValueOnce(new Error("store down"));
    const res = await post(ok());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(auditFinish).toHaveBeenCalledWith(91, { ok: false, error: "exception" });
  });

  it("the Settings view failing after a revoke → still 200, slack: null", async () => {
    revoke(() => SLACK_RECORDED.revoke());
    vi.mocked(getSlackSettingsView).mockRejectedValueOnce(new Error("view broke"));
    const res = await post(ok());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slack: null });
  });
});
