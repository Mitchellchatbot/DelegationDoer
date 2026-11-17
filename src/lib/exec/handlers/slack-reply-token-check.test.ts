import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), getActiveInstallation: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { slackReplyTokenCheckJobHandler, slackReplyTokenCheckScheduledWork } from "@/lib/exec/handlers/slack-reply-token-check";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { getActiveInstallation } from "@/lib/exec/slack-install";
import { SLACK_P10_OPS } from "@/lib/exec/slack-p10-copy";
import { P10_JOB_KINDS, P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { putSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fakeSlackP10Workspace, installFakeSlack, type FakeSlackP10Workspace } from "../__tests__/fake-slack-api";
import { NOW, OWNER_TOKEN, P, compositeClient, installationRow, jobCtx, newWorld, settings, type UsersTable } from "../__tests__/reply-d-harness";

// P10 §5.9 RK13 (C60, v1.1 product-4; Area D): exec.slack-reply-token-check runs auth.test of his DD token (never a post),
// writes slack-reply / token-health and raises the mismatch alert, so the DM card's Send and the System row have a verdict
// before his first send. His token comes from the fake users table, auth.test from the fake Slack. Invented names only.

let ws: FakeSlackP10Workspace;
let users: UsersTable;
const run = () => slackReplyTokenCheckJobHandler.run(jobCtx(P10_JOB_KINDS.replyTokenCheck, {}));
const healthWrites = () => vi.mocked(putSyncState).mock.calls.map((c) => [c[1], c[2], (c[3] as { state: string }).state]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const w = newWorld();
  users = w.users;
  vi.mocked(getSupabaseAdmin).mockReturnValue(compositeClient(w.db, users) as SupabaseClient);
  ws = fakeSlackP10Workspace({ tokens: { [OWNER_TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" } } });
  installFakeSlack(ws.handlers);
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(getActiveInstallation).mockReset().mockResolvedValue(installationRow());
  vi.mocked(putSyncState).mockReset().mockResolvedValue(undefined);
  vi.mocked(notifyOps).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RK13 the reply token check", () => {
  it("registration: bulk, 30 s; daily at 06:10 in his zone while replies and sending are on; maxAttempts 2", () => {
    expect(slackReplyTokenCheckJobHandler).toMatchObject({ kind: P10_JOB_KINDS.replyTokenCheck, lane: "bulk", timeoutMs: P10_LIMITS.tokenCheckTimeoutMs });
    expect(slackReplyTokenCheckScheduledWork.maxAttempts).toBe(2);
    const cadence = slackReplyTokenCheckScheduledWork.cadence as { kind: string; at: (s: unknown) => string };
    expect(cadence.kind).toBe("daily");
    expect(cadence.at(settings())).toBe("06:10");
    const on = (s: ReturnType<typeof settings>) => slackReplyTokenCheckScheduledWork.enabled?.(s);
    expect(on(settings())).toBe(true);
    expect(on(settings({ slackReplySendEnabled: false }))).toBe(false);
    expect(on(settings({ slackRepliesEnabled: false }))).toBe(false);
    expect(on(settings({ slackP10SchemaReady: false }))).toBe(false);
  });

  it("ok / mismatch (one notifyOps with the key) / missing / revoked / no installation, each written to slack-reply / token-health", async () => {
    expect(await run()).toEqual({ state: "ok" });
    const jane = ["xoxp", "fake", "jane", "check"].join("-");
    ws.tokens.set(jane, { userId: "U0JANE", teamId: "T0SCALED" });
    users.rows["user-mitchell"] = { slack_user_token: jane };
    expect(await run()).toEqual({ state: "mismatch" });
    expect(vi.mocked(notifyOps).mock.calls).toEqual([[{ key: SLACK_P10_OPS.tokenMismatch.key("ep_1"), title: SLACK_P10_OPS.tokenMismatch.title, detail: "token check: mismatch" }]]);
    users.rows["user-mitchell"] = { slack_user_token: null };
    expect(await run()).toEqual({ state: "missing" });
    users.rows["user-mitchell"] = { slack_user_token: OWNER_TOKEN };
    ws.tokens.set(OWNER_TOKEN, { error: "token_revoked" });
    expect(await run()).toEqual({ state: "revoked" });
    vi.mocked(getActiveInstallation).mockResolvedValueOnce(null);
    expect(await run()).toEqual({ state: "no_installation" });
    expect(healthWrites()).toEqual([
      ["slack-reply", "token-health", "ok"], ["slack-reply", "token-health", "mismatch"], ["slack-reply", "token-health", "missing"],
      ["slack-reply", "token-health", "revoked"], ["slack-reply", "token-health", "no_installation"]
    ]);
    expect(vi.mocked(putSyncState).mock.calls.every((c) => typeof (c[3] as { checkedAt: unknown }).checkedAt === "string")).toBe(true);
    // Never a post, never a token in a write or the result.
    expect(ws.posts).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(putSyncState).mock.calls)).not.toContain(OWNER_TOKEN);
  });

  it("off (replies or sending off, P10 not installed) → skipped, no Slack call", async () => {
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReplySendEnabled: false }));
    expect(await run()).toEqual({ skipped: "off" });
    expect(putSyncState).not.toHaveBeenCalled();
    expect(await slackReplyTokenCheckJobHandler.run(jobCtx(P10_JOB_KINDS.replyTokenCheck, {}, { principal: null }))).toEqual({ skipped: "no_principal" });
  });

  it("B-P10-11: it imports only verifyReplyToken and the ReplyTokenVerdict type from slack-reply-post.ts", () => {
    const src = readFileSync(fileURLToPath(new URL("./slack-reply-token-check.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/import \{ verifyReplyToken, type ReplyTokenVerdict \} from "@\/lib\/exec\/slack-reply-post";/);
    expect(src).not.toMatch(/postReplyAsOwner|sendSlackReply/);
  });
});
