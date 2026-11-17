import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { slackLeadsLine, slackRepliesLine } from "@/components/exec/overview/SystemSection";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";

// P10 fixer ui-10 (contract §3.9.3, C58): the System card's "Slack lead counts" and "Slack replies" rows read for a count of 1
// ("1 channel", "1 draft open"), through the copy's *One templates, and keep the plural otherwise. Pure.

const NOW = "2026-11-10T15:00:00.000Z";
const TZ = "America/New_York";
const leads = (channels: number) => ({ lastRunAt: "2026-11-10T14:30:00.000Z", channels, unlinked: 1, listedNotMember: 0, lastError: null, failingRuns: 0, failCode: null });
const replies = (open: number) => ({ open, sentToday: 1, unknown: 0, tokenState: "ok" as const, checkedAt: "2026-11-10T11:10:00.000Z" });

describe("P10 fixer ui-10: the System card's P10 rows in the singular", () => {
  it("Slack lead counts: 1 channel / 6 channels", () => {
    const one = slackLeadsLine(leads(1), NOW, TZ).value;
    expect(one).toMatch(/: 1 channel, 1 not linked, 0 listed but not a member$/);
    expect(one).not.toContain("1 channels");
    expect(slackLeadsLine(leads(6), NOW, TZ).value).toMatch(/: 6 channels, 1 not linked, 0 listed but not a member$/);
    expect(slackLeadsLine(leads(0), NOW, TZ).value).toMatch(/: 0 channels,/);
  });
  it("Slack replies: 1 draft open / 3 drafts open", () => {
    const one = slackRepliesLine(replies(1), NOW, TZ).value;
    expect(one.startsWith("1 draft open, 1 sent today, 0 unconfirmed · Slack connection: ")).toBe(true);
    expect(one).not.toContain("1 drafts");
    expect(slackRepliesLine(replies(3), NOW, TZ).value.startsWith("3 drafts open, ")).toBe(true);
    expect(SLACK_P10_COPY.system.repliesLineOne.startsWith("1 draft open")).toBe(true);
  });
});
