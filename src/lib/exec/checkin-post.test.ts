import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), putSyncState: vi.fn() }));

import { assertNoBriefText, BRIEF_TEXT_SENTINELS, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { installation, MITCH_SLACK, NOW, PRINCIPAL, TEAM, USER_TOKEN } from "@/lib/exec/__tests__/brief-d-harness";
import { createFakeBriefDb, type FakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import { fakeSlackWorkspace, installFakeSlack, type FakeSlackWorkspace } from "@/lib/exec/__tests__/fake-slack-api";
import { postCheckinAsOwner, verifyOwnerUserToken } from "@/lib/exec/checkin-post";
import { putSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 §5.11 CI12 (the binding half), CI13, CI14, CI20 (Area D): checkin-post.ts, the only reader of users.slack_user_token and
// the only module that posts as Mitchell. The users table is the standalone brief fake's; Slack is the stateful fake.

let db: FakeBriefDb;
let ws: FakeSlackWorkspace;
let slack: ReturnType<typeof installFakeSlack>;
let out: ReturnType<typeof captureConsole>;

function useDb(token: string | null = USER_TOKEN, userId = PRINCIPAL.userId) {
  db = createFakeBriefDb({ tables: { users: [{ id: userId, email: PRINCIPAL.email, name: "Mitchell Owner", slack_user_token: token }] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
}

beforeEach(() => {
  out = captureConsole();
  vi.mocked(putSyncState).mockReset();
  vi.mocked(putSyncState).mockResolvedValue(undefined);
  useDb();
  ws = fakeSlackWorkspace({ tokens: { [USER_TOKEN]: { userId: MITCH_SLACK, teamId: TEAM } } });
  slack = installFakeSlack(ws.handlers);
});
afterEach(() => {
  assertNoBriefText(out.calls(), { label: "console" });
  assertNoBriefText(vi.mocked(putSyncState), { label: "putSyncState" });
  vi.unstubAllEnvs();
});

describe("verifyOwnerUserToken (C19, M6)", () => {
  it("ok when auth.test answers the installation's user and team; the verdict is stored as token health", async () => {
    const v = await verifyOwnerUserToken(PRINCIPAL, installation(), NOW);
    expect(v).toEqual({ state: "ok", userId: MITCH_SLACK, teamId: TEAM });
    expect(vi.mocked(putSyncState)).toHaveBeenCalledWith(PRINCIPAL, "brief", "token-health", { state: "ok", checkedAt: NOW.toISOString() });
    assertNoBriefText(v);
  });

  it("CI12 another user id → mismatch; another team → mismatch; a bot token → mismatch", async () => {
    ws.tokens.set(USER_TOKEN, { userId: "U0SOMEONE", teamId: TEAM });
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "mismatch" });
    ws.tokens.set(USER_TOKEN, { userId: MITCH_SLACK, teamId: "T0OTHER" });
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "mismatch" });
    ws.tokens.set(USER_TOKEN, { userId: MITCH_SLACK, teamId: TEAM, botId: "B0DD" });
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "mismatch" });
    expect(vi.mocked(putSyncState).mock.calls.map((c) => (c[3] as { state: string }).state)).toEqual(["mismatch", "mismatch", "mismatch"]);
  });

  it("CI13 the token comes only from users.slack_user_token of principal.userId: the column empty and SLACK_USER_TOKEN set → missing, no Slack call", async () => {
    vi.stubEnv("SLACK_USER_TOKEN", USER_TOKEN);
    useDb(null);
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "missing" });
    expect(slack.calls).toEqual([]);
    useDb("   ");
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "missing" });
    // Another user's row (even with his email) is never read.
    useDb(USER_TOKEN, "u_someone_else");
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "missing" });
    const reads = db.calls.filter((c) => c.target === "users");
    expect(reads.every((c) => c.filters.some((f) => f.op === "eq" && f.column === "id" && f.value === PRINCIPAL.userId))).toBe(true);
    expect(reads.every((c) => !c.filters.some((f) => "column" in f && f.column === "email"))).toBe(true);
  });

  it("CI14 token_revoked → revoked(token_revoked); another Slack error → error(code); a users read failure → error", async () => {
    ws.tokens.set(USER_TOKEN, { error: "token_revoked" });
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "revoked", code: "token_revoked" });
    ws.tokens.set(USER_TOKEN, { error: "team_not_found" });
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "error", code: "team_not_found" });
    db.failNext("users", "53300");
    expect(await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).toEqual({ state: "error", code: "token_read_failed" });
  });

  it("a failed token-health write is logged by name and never changes the verdict", async () => {
    vi.mocked(putSyncState).mockRejectedValueOnce(new Error("boom"));
    expect((await verifyOwnerUserToken(PRINCIPAL, installation(), NOW)).state).toBe("ok");
    expect(out.calls().flat().join(" ")).toContain("token health not stored");
  });
});

describe("postCheckinAsOwner (C7, CI20)", () => {
  it("conversations.open with HIS token for the recipient, then chat.postMessage to that IM only: unfurls off, no as_user", async () => {
    const r = await postCheckinAsOwner(PRINCIPAL, installation(), "U0JANE", "Hey <!channel>, how is your week going?", { signal: new AbortController().signal });
    const im = ws.imFor(USER_TOKEN, "U0JANE");
    expect(r).toEqual({ channel: im, ts: expect.any(String) });
    expect(ws.messages).toHaveLength(1);
    expect(ws.messages[0]).toMatchObject({ channel: im, token: USER_TOKEN, text: "Hey &lt;!channel&gt;, how is your week going?" });
    // The request bodies: the IM channel, the flags, nothing else of note.
    expect(r).not.toHaveProperty("token");
    assertNoBriefText(r);
  });

  it("re-verifies before posting: a mismatched or missing token is refused with no post", async () => {
    ws.tokens.set(USER_TOKEN, { userId: "U0SOMEONE", teamId: TEAM });
    expect(await postCheckinAsOwner(PRINCIPAL, installation(), "U0JANE", "Hi", { signal: new AbortController().signal })).toEqual({ refused: { state: "mismatch" } });
    useDb(null);
    expect(await postCheckinAsOwner(PRINCIPAL, installation(), "U0JANE", "Hi", { signal: new AbortController().signal })).toEqual({ refused: { state: "missing" } });
    expect(ws.messages).toEqual([]);
  });

  it("a Slack failure on the post propagates unchanged (the caller classifies it)", async () => {
    ws.failNext("chat.postMessage", { error: "channel_not_found" });
    await expect(postCheckinAsOwner(PRINCIPAL, installation(), "U0JANE", "Hi", { signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: "SlackApiError", code: "channel_not_found", method: "chat.postMessage" });
  });

  it("the request bodies carry no as_user, and the token rides only in the Authorization header", async () => {
    await postCheckinAsOwner(PRINCIPAL, installation(), "U0JANE", `Note ${BRIEF_TEXT_SENTINELS.checkinText}`, { signal: new AbortController().signal });
    expect(slack.calls.map((c) => c.method)).toEqual(["auth.test", "conversations.open", "chat.postMessage"]);
    const post = slack.calls[2];
    expect(post.body).toMatchObject({ unfurl_links: false, unfurl_media: false, link_names: false });
    expect(post.body).not.toHaveProperty("as_user");
    expect(post.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(slack.calls[1].body).toEqual({ users: "U0JANE" });
    for (const c of slack.calls) expect(JSON.stringify(c.body)).not.toContain("xoxp-");
  });
});
