import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// The sender, wrapped so the test sees the exact target it is handed (B-P10-9: built only in slack-reply-post.ts).
vi.mock("@/lib/exec/sources/slack", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/sources/slack")>();
  return { ...real, postAsOwnerInConversation: vi.fn(real.postAsOwnerInConversation) };
});

import { postReplyAsOwner, verifyReplyToken } from "@/lib/exec/slack-reply-post";
import { postAsOwnerInConversation } from "@/lib/exec/sources/slack";
import type { InstallationRow } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { fakeSlackP10Workspace, installFakeSlack, type FakeSlackP10Workspace } from "./__tests__/fake-slack-api";

// P10 §5.8 RS11 and RS22 (Area D): his DD token (users.slack_user_token of principal.userId, read in this module only), the
// auth.test binding (the installation's user and team, no bot) and the post through the one owner sender, against the fake
// Slack workspace and a fake users table. No live call; the token never leaves the module. Invented names only.

const TOKEN = ["xoxp", "fake", "owner", "dd"].join("-");
const OTHER_TOKEN = ["xoxp", "fake", "jane", "dd"].join("-");
const BOT_TOKEN = ["xoxb", "fake", "bot", "dd"].join("-");
const ENV_TOKEN = ["xoxp", "fake", "env", "sentinel"].join("-");
const P = { id: "ep_1", userId: "user-mitchell", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York" } as unknown as ExecPrincipal;
const INST = { id: `esi_${"a".repeat(32)}`, principalId: "ep_1", teamId: "T0SCALED", userId: "U0MITCH", dmChannelId: "D0MITCH" } as unknown as InstallationRow;

let users: Record<string, { slack_user_token: string | null }>;
let userReads: { column: string; id: unknown }[];
let usersFail: string | null;
let ws: FakeSlackP10Workspace;

function usersClient(): unknown {
  return {
    from(table: string) {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      let column = "";
      let id: unknown = null;
      const q = {
        select(c: string) {
          column = c;
          return q;
        },
        eq(k: string, v: unknown) {
          if (k === "id") id = v;
          return q;
        },
        limit() {
          return q;
        },
        abortSignal() {
          return q;
        },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          userReads.push({ column, id });
          if (usersFail !== null) return Promise.resolve({ data: null, error: { code: usersFail, message: "x" } }).then(res, rej);
          const row = typeof id === "string" ? users[id] : undefined;
          return Promise.resolve({ data: row ? [row] : [], error: null }).then(res, rej);
        }
      };
      return q;
    }
  };
}

beforeEach(() => {
  users = { "user-mitchell": { slack_user_token: TOKEN }, "user-jane": { slack_user_token: OTHER_TOKEN } };
  userReads = [];
  usersFail = null;
  vi.mocked(getSupabaseAdmin).mockReturnValue(usersClient() as SupabaseClient);
  ws = fakeSlackP10Workspace({
    tokens: {
      [TOKEN]: { userId: "U0MITCH", teamId: "T0SCALED" },
      [OTHER_TOKEN]: { userId: "U0JANE", teamId: "T0SCALED" },
      [BOT_TOKEN]: { userId: "U0BOT", teamId: "T0SCALED", botId: "B0BOT" }
    }
  });
  installFakeSlack(ws.handlers);
  vi.stubEnv("SLACK_USER_TOKEN", ENV_TOKEN);
  vi.mocked(postAsOwnerInConversation).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const sig = () => new AbortController().signal;

describe("RS11 verifyReplyToken: his token, bound to the installation (C39)", () => {
  it("ok only for the installation's user and team with no bot id", async () => {
    expect(await verifyReplyToken(P, INST, { signal: sig() })).toEqual({ state: "ok", userId: "U0MITCH", teamId: "T0SCALED" });
    expect(userReads).toEqual([{ column: "slack_user_token", id: "user-mitchell" }]);
  });

  it("missing / another user / another team / a bot token / revoked / a read failure → the matching verdict, never a post", async () => {
    users["user-mitchell"] = { slack_user_token: null };
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "missing" });
    users["user-mitchell"] = { slack_user_token: "   " };
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "missing" });
    users["user-mitchell"] = { slack_user_token: OTHER_TOKEN };
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "mismatch" });
    users["user-mitchell"] = { slack_user_token: TOKEN };
    expect(await verifyReplyToken(P, { ...INST, teamId: "T0OTHER" } as InstallationRow)).toEqual({ state: "mismatch" });
    users["user-mitchell"] = { slack_user_token: BOT_TOKEN };
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "mismatch" });
    ws.tokens.set(TOKEN, { error: "token_revoked" });
    users["user-mitchell"] = { slack_user_token: TOKEN };
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "revoked", code: "token_revoked" });
    ws.tokens.set(TOKEN, { error: "ratelimited" });
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "error", code: "ratelimited" });
    usersFail = "57014";
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "error", code: "token_read_failed" });
    expect(ws.posts).toHaveLength(0);
  });

  it("the environment's SLACK_USER_TOKEN is never used, and a principal without a user id reads nothing", async () => {
    users = {};
    expect(await verifyReplyToken(P, INST)).toEqual({ state: "missing" });
    expect(await verifyReplyToken({ ...P, userId: "" } as ExecPrincipal, INST)).toEqual({ state: "missing" });
    for (const call of ws.posts) expect(call.token).not.toBe(ENV_TOKEN);
    expect(userReads.every((r) => r.id === "user-mitchell")).toBe(true);
  });
});

describe("postReplyAsOwner (§3.5.7)", () => {
  it("re-verifies, then posts escapeMrkdwn(text) into the target channel and thread with his token", async () => {
    const out = await postReplyAsOwner(P, INST, { channelId: "C0ZENOPS1", threadTs: "1794300000.000100", text: "Fine & <done>" }, { signal: sig() });
    expect(out).toEqual({ ts: expect.stringMatching(/^[0-9]+\.[0-9]+$/) });
    expect(ws.posts).toHaveLength(1);
    expect(ws.posts[0].token).toBe(TOKEN);
    expect(ws.posts[0].body).toMatchObject({ channel: "C0ZENOPS1", thread_ts: "1794300000.000100", text: "Fine &amp; &lt;done&gt;" });
  });

  it("a verdict other than ok → { refused }, nothing posted; a timeout before the post is a refusal too (C36)", async () => {
    users["user-mitchell"] = { slack_user_token: OTHER_TOKEN };
    expect(await postReplyAsOwner(P, INST, { channelId: "C0ZENOPS1", threadTs: null, text: "x" }, { signal: sig() })).toEqual({ refused: { state: "mismatch" } });
    const aborted = new AbortController();
    aborted.abort();
    users["user-mitchell"] = { slack_user_token: TOKEN };
    expect(await postReplyAsOwner(P, INST, { channelId: "C0ZENOPS1", threadTs: null, text: "x" }, { signal: aborted.signal }))
      .toEqual({ refused: { state: "error", code: "timeout" } });
    expect(ws.posts).toHaveLength(0);
  });

  it("RS22 the token never appears in the result, the target's JSON or inspect form, an error message or a log line", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    const out = await postReplyAsOwner(P, INST, { channelId: "C0ZENOPS1", threadTs: null, text: "hello" }, { signal: sig() });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const target = vi.mocked(postAsOwnerInConversation).mock.calls[0][0];
    expect(target.channelId).toBe("C0ZENOPS1");
    expect(Object.isFrozen(target)).toBe(true);
    expect(JSON.stringify(target)).toBe(JSON.stringify({ channelId: "C0ZENOPS1" }));
    expect(inspect(target)).not.toContain(TOKEN);
    ws.failNext("chat.postMessage", { error: "not_in_channel" });
    const err = await postReplyAsOwner(P, INST, { channelId: "C0ZENOPS1", threadTs: null, text: "hello" }, { signal: sig() }).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
    for (const s of spies) s.mockRestore();
  });

  it("B-P10-9 / B-P10-11: the module reads slack_user_token by the user id only, and builds the one OwnerPostTarget", () => {
    const src = readFileSync(fileURLToPath(new URL("./slack-reply-post.ts", import.meta.url)), "utf8");
    expect(src).toContain('.from("users").select("slack_user_token").eq("id", userId)');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\.eq\("email"/);
  });
});
