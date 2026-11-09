import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-read-store")>();
  return { ...actual, getDdBotRow: vi.fn(), saveDdBotRow: vi.fn() };
});

import { installFakeSlack, SLACK_READ_RECORDED, slackReadError } from "@/lib/exec/__tests__/fake-slack-api";
import { assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { getDdBotRow, saveDdBotRow, SlackReadStoreError } from "@/lib/exec/slack-read-store";

// P7a §5.16 DB01-DB06 (Area B): the DD bot's identity (N3, C28). The store is mocked at the module boundary; Slack is the fake
// fetch. The DD bot's token is a fake in Slack's format; every assertion also proves it never reaches a stored row or a log.

const TEAM = "T0SCALED";
const DD_TOKEN = "xoxb-FAKE-dd-bot-token-0000000000";
const NOW = new Date("2026-11-08T15:00:00.000Z");
const okRow = (checkedAt: string, appId: string | null = "A0DDAPP") => ({ ok: true, userId: "U0DDBOT", botId: "B0DDBOT", appId, errorCode: null, checkedAt });

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
  vi.stubEnv("SLACK_BOT_TOKEN", DD_TOKEN);
  vi.mocked(getDdBotRow).mockResolvedValue(null);
  vi.mocked(saveDdBotRow).mockResolvedValue(undefined);
});
afterEach(() => {
  expect(out.calls()).toEqual([]);
  for (const call of vi.mocked(saveDdBotRow).mock.calls) {
    expect(JSON.stringify(call)).not.toContain("xoxb-");
    assertNoSlackText(call, { label: "saveDdBotRow" });
  }
  vi.unstubAllEnvs();
});

describe("getDdBotIdentity (§3.6.2)", () => {
  it("DB01 a cached ok row younger than 24 h answers without a Slack call", async () => {
    vi.mocked(getDdBotRow).mockResolvedValue(okRow("2026-11-08T00:00:00.000Z"));
    const slack = installFakeSlack({});
    expect(await getDdBotIdentity(TEAM, { now: NOW })).toEqual({
      teamId: TEAM, userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", checkedAt: "2026-11-08T00:00:00.000Z"
    });
    expect(slack.calls).toEqual([]);
    expect(vi.mocked(saveDdBotRow)).not.toHaveBeenCalled();
    expect(vi.mocked(getDdBotRow)).toHaveBeenCalledWith(TEAM);
  });

  it("DB02 a stale row (or refresh, or a failed row) → auth.test + bots.info with the DD bot's token, then the row is stored", async () => {
    vi.mocked(getDdBotRow).mockResolvedValue(okRow("2026-11-07T14:59:59.000Z"));
    const slack = installFakeSlack({ "auth.test": () => SLACK_READ_RECORDED.ddBotAuthTest(), "bots.info": () => SLACK_READ_RECORDED.botsInfo() });
    const id = await getDdBotIdentity(TEAM, { now: NOW });
    expect(id).toEqual({ teamId: TEAM, userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", checkedAt: NOW.toISOString() });
    expect(slack.calls.map((c) => c.method)).toEqual(["auth.test", "bots.info"]);
    expect(slack.calls.every((c) => c.headers.authorization === `Bearer ${DD_TOKEN}`)).toBe(true);
    expect(slack.calls[1].body).toEqual({ bot: "B0DDBOT" });
    expect(vi.mocked(saveDdBotRow)).toHaveBeenCalledWith({ teamId: TEAM, ok: true, userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", errorCode: null, checkedAt: NOW.toISOString() });
    // refresh skips the cache even when it is fresh; a failed row is never a cache hit.
    slack.restore();
    vi.mocked(getDdBotRow).mockClear();
    vi.mocked(getDdBotRow).mockResolvedValue(okRow(NOW.toISOString()));
    const again = installFakeSlack({ "auth.test": () => SLACK_READ_RECORDED.ddBotAuthTest(), "bots.info": () => SLACK_READ_RECORDED.botsInfo() });
    await getDdBotIdentity(TEAM, { now: NOW, refresh: true });
    expect(again.calls).toHaveLength(2);
    expect(vi.mocked(getDdBotRow)).not.toHaveBeenCalled();
    again.restore();
    vi.mocked(getDdBotRow).mockResolvedValue({ ok: false, userId: null, botId: null, appId: null, errorCode: "invalid_auth", checkedAt: NOW.toISOString() });
    const third = installFakeSlack({ "auth.test": () => SLACK_READ_RECORDED.ddBotAuthTest(), "bots.info": () => SLACK_READ_RECORDED.botsInfo() });
    expect(await getDdBotIdentity(TEAM, { now: NOW })).not.toBeNull();
    expect(third.calls).toHaveLength(2);
    // A row from the future (a clock skew) isn't trusted either.
    third.restore();
    vi.mocked(getDdBotRow).mockResolvedValue(okRow("2026-11-09T15:00:00.000Z"));
    const fourth = installFakeSlack({ "auth.test": () => SLACK_READ_RECORDED.ddBotAuthTest(), "bots.info": () => SLACK_READ_RECORDED.botsInfo() });
    await getDdBotIdentity(TEAM, { now: NOW });
    expect(fourth.calls).toHaveLength(2);
  });

  it("DB03 an unset (or blank) SLACK_BOT_TOKEN → null, with no Slack call and no row written", async () => {
    const slack = installFakeSlack({});
    for (const value of [undefined, "", "   ", "xoxb has spaces"]) {
      vi.stubEnv("SLACK_BOT_TOKEN", value);
      expect(await getDdBotIdentity(TEAM, { now: NOW })).toBeNull();
    }
    expect(slack.calls).toEqual([]);
    expect(vi.mocked(saveDdBotRow)).not.toHaveBeenCalled();
  });

  it("DB04 auth.test answering another team → null, and the row says team_mismatch; a Slack failure stores its code", async () => {
    const slack = installFakeSlack({ "auth.test": () => SLACK_READ_RECORDED.ddBotAuthTest("T0OTHER") });
    expect(await getDdBotIdentity(TEAM, { now: NOW })).toBeNull();
    expect(slack.calls.map((c) => c.method)).toEqual(["auth.test"]);
    expect(vi.mocked(saveDdBotRow)).toHaveBeenLastCalledWith({ teamId: TEAM, ok: false, userId: null, botId: null, appId: null, errorCode: "team_mismatch", checkedAt: NOW.toISOString() });
    slack.restore();
    for (const [answer, code] of [[slackReadError("invalid_auth"), "invalid_auth"], [slackReadError("token_revoked"), "token_revoked"],
      [new Response("", { status: 503 }), "slack_error"], [{ ok: true, team_id: TEAM, user_id: "U0DDBOT" }, "not_a_bot_token"]] as const) {
      const s = installFakeSlack({ "auth.test": () => answer });
      expect(await getDdBotIdentity(TEAM, { now: NOW })).toBeNull();
      expect(vi.mocked(saveDdBotRow)).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, errorCode: code }));
      s.restore();
    }
    // A malformed team id is never asked about.
    const none = installFakeSlack({});
    expect(await getDdBotIdentity("not-a-team", { now: NOW })).toBeNull();
    expect(none.calls).toEqual([]);
  });

  it("DB05 bots.info failing (missing_scope [U], bot_not_found, a 500, no app id) → app id null, still ok", async () => {
    for (const answer of [slackReadError("missing_scope"), slackReadError("bot_not_found"), new Response("", { status: 500 }),
      SLACK_READ_RECORDED.botsInfo("B0DDBOT", null, "U0DDBOT"), SLACK_READ_RECORDED.botsInfo("B0DDBOT", "not-an-app", "U0DDBOT")]) {
      const slack = installFakeSlack({ "auth.test": () => SLACK_READ_RECORDED.ddBotAuthTest(), "bots.info": () => answer });
      expect(await getDdBotIdentity(TEAM, { now: NOW })).toMatchObject({ userId: "U0DDBOT", botId: "B0DDBOT", appId: null });
      expect(vi.mocked(saveDdBotRow)).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, appId: null, errorCode: null }));
      slack.restore();
    }
  });

  it("a store error throws; the caller's abort rethrows and stores nothing", async () => {
    vi.mocked(getDdBotRow).mockRejectedValueOnce(new SlackReadStoreError("dd_bot_get", "42P01"));
    await expect(getDdBotIdentity(TEAM, { now: NOW })).rejects.toBeInstanceOf(SlackReadStoreError);
    installFakeSlack({ "auth.test": () => SLACK_READ_RECORDED.ddBotAuthTest(), "bots.info": () => SLACK_READ_RECORDED.botsInfo() });
    vi.mocked(saveDdBotRow).mockRejectedValueOnce(new SlackReadStoreError("dd_bot_save", null));
    await expect(getDdBotIdentity(TEAM, { now: NOW })).rejects.toBeInstanceOf(SlackReadStoreError);
    const controller = new AbortController();
    controller.abort();
    vi.mocked(saveDdBotRow).mockClear();
    await expect(getDdBotIdentity(TEAM, { now: NOW, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(saveDdBotRow)).not.toHaveBeenCalled();
  });

  it("DB06 dd-bot.ts never imports @/lib/slack; it reads SLACK_BOT_TOKEN itself and calls Slack only through sources/slack.ts", () => {
    const file = fileURLToPath(new URL("./dd-bot.ts", import.meta.url));
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const specs: string[] = [];
    sf.forEachChild((n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) specs.push(n.moduleSpecifier.text);
    });
    // P8 (Area D, §3.13.3): postDdBotDm / deleteDdBotDm add @/lib/exec/types (NonRetryableError, ExecPrincipal).
    expect(specs.sort()).toEqual(["@/lib/exec/slack-read-store", "@/lib/exec/slack-read-types", "@/lib/exec/slack-types", "@/lib/exec/sources/slack", "@/lib/exec/types", "server-only"].sort());
    expect(specs.some((s) => s === "@/lib/slack" || s.endsWith("/lib/slack"))).toBe(false);
    expect(text).toContain("process.env.SLACK_BOT_TOKEN");
    expect(text).not.toContain("slack.com/api");
  });
});
