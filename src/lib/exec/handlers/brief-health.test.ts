import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), getActiveInstallation: vi.fn() }));

import { assertNoBriefText, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { ctxFor, installation, MITCH_SLACK, PRINCIPAL, TEAM, USER_TOKEN } from "@/lib/exec/__tests__/brief-d-harness";
import { createFakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import { fakeSlackWorkspace, installFakeSlack, type FakeSlackWorkspace } from "@/lib/exec/__tests__/fake-slack-api";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { __resetBriefStoreForTests } from "@/lib/exec/brief-store";
import { BRIEF_HEALTH_JOB_KIND, briefHealthJobHandler, briefHealthScheduledWork } from "@/lib/exec/handlers/brief-health";
import { notifyOps } from "@/lib/exec/ops";
import { getActiveInstallation } from "@/lib/exec/slack-install";
import { putSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 §5.11 CI30 (Area D): exec.brief-health: auth.test of his DD token daily, the verdict in exec_sync_state (brief /
// token-health) for the System card; a mismatch raises BRIEF_OPS.tokenMismatch; no installation → no_installation.

let ws: FakeSlackWorkspace;
let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  out = captureConsole();
  __resetBriefStoreForTests();
  const db = createFakeBriefDb({ tables: { users: [{ id: PRINCIPAL.userId, email: PRINCIPAL.email, name: "Mitchell", slack_user_token: USER_TOKEN }] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(putSyncState).mockReset();
  vi.mocked(putSyncState).mockResolvedValue(undefined);
  vi.mocked(notifyOps).mockReset();
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(getActiveInstallation).mockReset();
  vi.mocked(getActiveInstallation).mockResolvedValue(installation());
  ws = fakeSlackWorkspace({ tokens: { [USER_TOKEN]: { userId: MITCH_SLACK, teamId: TEAM } } });
  installFakeSlack(ws.handlers);
});
afterEach(() => {
  assertNoBriefText(out.calls(), { label: "console" });
  assertNoBriefText(vi.mocked(notifyOps), { label: "notifyOps" });
});

const run = () => briefHealthJobHandler.run(ctxFor(BRIEF_HEALTH_JOB_KIND, { local_date: "2026-11-09" }));
const healthWrites = () => vi.mocked(putSyncState).mock.calls.map((c) => [c[1], c[2], (c[3] as { state: string }).state]);

describe("CI30 exec.brief-health", () => {
  it("is bulk, 30 s, daily at 06:00 in the brief zone while the brief and check-ins are on, two attempts", () => {
    expect(briefHealthJobHandler).toMatchObject({ kind: "exec.brief-health", lane: "bulk", timeoutMs: 30_000 });
    expect(briefHealthScheduledWork).toMatchObject({ kind: "exec.brief-health", lane: "bulk", maxAttempts: 2 });
    expect(briefHealthScheduledWork.cadence.kind === "daily" && briefHealthScheduledWork.cadence.at({} as never)).toBe("06:00");
    expect(briefHealthScheduledWork.zone?.(PRINCIPAL)).toBe(PRINCIPAL.briefTimezone);
  });

  it("ok → token health ok, no alert", async () => {
    expect(await run()).toEqual({ state: "ok" });
    expect(healthWrites()).toEqual([["brief", "token-health", "ok"]]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("mismatch → token health mismatch and BRIEF_OPS.tokenMismatch (ids only)", async () => {
    ws.tokens.set(USER_TOKEN, { userId: "U0SOMEONE", teamId: TEAM });
    expect(await run()).toEqual({ state: "mismatch" });
    expect(healthWrites()).toEqual([["brief", "token-health", "mismatch"]]);
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{ key: BRIEF_OPS.tokenMismatch.key(PRINCIPAL.id), title: BRIEF_OPS.tokenMismatch.title, detail: "principal ep_1: health check" }]]);
  });

  it("no installation → no_installation, no Slack call", async () => {
    vi.mocked(getActiveInstallation).mockResolvedValue(null);
    const slack = installFakeSlack(ws.handlers);
    expect(await run()).toEqual({ state: "no_installation" });
    expect(healthWrites()).toEqual([["brief", "token-health", "no_installation"]]);
    expect(slack.calls).toEqual([]);
  });

  it("the result carries the state only (no token, no ids beyond the state)", async () => {
    const r = await run();
    assertNoBriefText(r);
    expect(Object.keys(r as object)).toEqual(["state"]);
  });
});
