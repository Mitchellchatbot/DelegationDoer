import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/dd-bot", () => ({ getDdBotIdentity: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { installFakeSlack } from "@/lib/exec/__tests__/fake-slack-api";
import { captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { DD_BOT, HIM, NOW, NOW_MS, TOKEN_KEY, channelDbRow, historyPage, installationDbRow, jobCtx, rawMessage, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { sealSecret } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackProbeJobHandler, slackProbeScheduledWork } from "@/lib/exec/handlers/slack-probe";
import { loadSettings } from "@/lib/exec/principal";
import { SlackRateBudgetError, takeSlackBudget } from "@/lib/exec/slack-rate";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.11.4, §5.5 PR01-PR05 (Area D): exec.slack-probe against fake-slack-read-db.

let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;
const unjoined = (id: string, over: Row = {}) => channelDbRow({ channel_id: id, name: id.toLowerCase(), is_member: false, watch_state: "unwatched", probed_at: null, ...over });
function useDb(channels: Row[]): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), tables: { exec_slack_channels: channels }, slack: { tables: { exec_slack_installations: [installationDbRow(sealSecret)] } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const people = (n: number, base = 1794100000) => Array.from({ length: n }, (_, i) => rawMessage(`${base + i * 60}.000100`, { user: `U0P${i}`, text: "lorem" }));
const row = (id: string) => db.tables.exec_slack_channels.find((r) => r.channel_id === id);
const run = () => slackProbeJobHandler.run(jobCtx("exec.slack-probe", {}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  vi.mocked(loadSettings).mockResolvedValue(settings({ watchMode: "active_public" }));
  vi.mocked(takeSlackBudget).mockResolvedValue(undefined);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: "T0SCALED", userId: DD_BOT.userId, botId: "B0DDBOT", appId: DD_BOT.appId, checkedAt: NOW.toISOString() });
});
afterEach(() => {
  out.assertClean();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("exec.slack-probe", () => {
  it("PR01 only under active_public and with reading on", async () => {
    useDb([unjoined("C0PUB")]);
    const s = installFakeSlack({});
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ watchMode: "member_only" }));
    expect(await run()).toEqual({ skipped: "member_only" });
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ watchMode: "active_public", slackReadingEnabled: false }));
    expect(await run()).toEqual({ skipped: "reading_off" });
    expect(s.calls).toEqual([]);
    expect(slackProbeScheduledWork).toMatchObject({ cadence: { kind: "interval", minutes: 15 }, maxAttempts: 1 });
    expect(slackProbeScheduledWork.enabled?.(settings({ watchMode: "member_only" }))).toBe(false);
    expect(slackProbeScheduledWork.enabled?.(settings({ watchMode: "active_public" }))).toBe(true);
  });

  it("PR02 ≥ 10 people's messages in 30 days → watched; fewer → unwatched; an owner-set row keeps its state", async () => {
    useDb([unjoined("C0BUSY"), unjoined("C0QUIET"), unjoined("C0MINE", { watch_set_by_owner_at: "2026-11-02T00:00:00.000Z", watch_state: "unwatched" })]);
    const s = installFakeSlack({ "conversations.history": (body) => historyPage(body.channel === "C0QUIET" ? people(9) : people(12)) });
    expect(await run()).toMatchObject({ probed: 3, partial: false });
    expect(s.calls.every((c) => c.body.oldest === `${(NOW_MS - 30 * 86_400_000) / 1000}.000000` && c.body.limit === "100")).toBe(true);
    expect(row("C0BUSY")).toMatchObject({ watch_state: "watched", activity_30d: 12, probed_at: NOW.toISOString() });
    expect(row("C0QUIET")).toMatchObject({ watch_state: "unwatched", activity_30d: 9 });
    expect(row("C0MINE")).toMatchObject({ watch_state: "unwatched", activity_30d: 12 });
    expect(vi.mocked(takeSlackBudget).mock.calls.every((c) => c[1] === "conversations.history" && c[2] === "probe")).toBe(true);
  });

  it("PR03 DD posts, bots and his own messages don't count", async () => {
    useDb([unjoined("C0MIX")]);
    installFakeSlack({ "conversations.history": () => historyPage([
      ...people(9),
      rawMessage("1794149000.000100", { user: HIM }),
      rawMessage("1794149100.000100", { user: "U0DDBOT", bot_id: "B0DDBOT", app_id: "A0DDAPP" }),
      rawMessage("1794149200.000100", { subtype: "bot_message", bot_id: "B0ZAP", user: undefined }),
      rawMessage("1794149300.000100", { user: "U0X", app_id: "A0OTHER" }),
      rawMessage("1794149400.000100", { subtype: "channel_join", user: "U0NEW" })
    ]) });
    await run();
    expect(row("C0MIX")).toMatchObject({ activity_30d: 9, watch_state: "unwatched" });
  });

  it("PR04 the limiter's probe class refusing → the run stops (partial)", async () => {
    useDb([unjoined("C0A"), unjoined("C0B")]);
    const s = installFakeSlack({ "conversations.history": () => historyPage(people(12)) });
    vi.mocked(takeSlackBudget).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new SlackRateBudgetError(30_000));
    expect(await run()).toMatchObject({ probed: 1, partial: true });
    expect(s.calls).toHaveLength(1);
  });

  it("PR05 a probed channel isn't probed again for 7 days", async () => {
    useDb([unjoined("C0RECENT", { probed_at: new Date(NOW_MS - 6 * 86_400_000).toISOString() }), unjoined("C0STALE", { probed_at: new Date(NOW_MS - 8 * 86_400_000).toISOString() })]);
    const s = installFakeSlack({ "conversations.history": () => historyPage(people(1)) });
    await run();
    expect(s.calls.map((c) => c.body.channel)).toEqual(["C0STALE"]);
  });
});
