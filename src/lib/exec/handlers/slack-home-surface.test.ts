import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
// P5a's screened accessor and P3's email tab at their module boundary (as P6's slack-home.test.ts does).
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/email-view", () => ({ getEmailTab: vi.fn() }));

import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { getEmailTab, type EmailTabView } from "@/lib/exec/email-view";
import { slackHomeJobHandler } from "@/lib/exec/handlers/slack-home";

import { SLACK_TEXT_SENTINELS, assertNoSlackText, captureConsole } from "../__tests__/slack-read-assert";
import { ROUTING_INSTALLATION as RI } from "../__tests__/slack-assert";
import { INST, KEY, PRINCIPAL, callsOf, jobCtx, useSlack, useSlackDb } from "../__tests__/slack-jobs-harness";

// P7a contract §5.14 AS11 (Area E; §3.14, §3.20.3): P6's App Home is a Slack surface, so its one read of the
// screened accessor passes surface "slack" (finance items stay off it, C10/C45). A spy on the accessor's call.

const run = () => slackHomeJobHandler.run(jobCtx("exec.slack-home", { installation_id: INST, slack_user_id: RI.userId }));
const page = (items: AttentionFeedItem[]): ScreenedAttentionPage => ({ items, nextCursor: null, hiddenEmail: 0, emailScreen: "ok", hiddenSlack: 1, slackScreen: "ok" });
const item = { id: "ea_1", title: "Acme renewal is overdue", priority: { band: "high", score: 80 }, refs: [] } as unknown as AttentionFeedItem;

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.stubEnv("EXEC_ENABLED", undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  useSlackDb();
  out = captureConsole();
});
afterEach(() => {
  assertNoSlackText(out.calls(), { label: "console" });
  vi.unstubAllEnvs();
});

describe("App Home's screened read (AS11)", () => {
  it("AS11 the owner's Home reads the accessor with surface 'slack' (and its signal), once", async () => {
    vi.mocked(listScreenedAttention).mockResolvedValue(page([item]));
    vi.mocked(getEmailTab).mockResolvedValue({ state: "off", generatedAt: "x", timezone: "America/New_York" } as unknown as EmailTabView);
    const slack = useSlack();
    await run();
    expect(vi.mocked(listScreenedAttention)).toHaveBeenCalledTimes(1);
    const [principal, filters, opts] = vi.mocked(listScreenedAttention).mock.calls[0];
    expect(principal).toBe(PRINCIPAL);
    expect(filters).toEqual({ status: "default", limit: 5 });
    expect(opts?.surface).toBe("slack");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    // The Home renders what the screen kept; nothing Slack-side from the reading half reaches it.
    const publish = callsOf(slack.calls, "views.publish");
    expect(publish).toHaveLength(1);
    assertNoSlackText(publish[0].body, { label: "views.publish" });
    expect(JSON.stringify(publish[0].body)).not.toContain(SLACK_TEXT_SENTINELS.summary);
  });
});
