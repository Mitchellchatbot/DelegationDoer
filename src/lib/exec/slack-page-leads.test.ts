import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", () => ({ listDigestViews: vi.fn(), slackCatchUpCounts: vi.fn(), dayBounds: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reading")>()),
  readOpenSlackItems: vi.fn(),
  listIntelChannels: vi.fn()
}));
vi.mock("@/lib/exec/slack-leads-view", () => ({ leadCountsView: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-view", () => ({ replyBadgesFor: vi.fn() }));

import { channel, principal, slackItem } from "@/lib/exec/__tests__/p7b-ui-fixtures";
import { loadSettings } from "@/lib/exec/principal";
import { listDigestViews, slackCatchUpCounts } from "@/lib/exec/slack-digests";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { leadCountsView } from "@/lib/exec/slack-leads-view";
import { getSlackPageView } from "@/lib/exec/slack-page";
import type { LeadCountsView } from "@/lib/exec/slack-p10-types";
import { listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import { replyBadgesFor } from "@/lib/exec/slack-reply-view";
import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import type { ExecSettings } from "@/lib/exec/types";

// P10 §5.5 / §3.9.1 (contract §3.9.1, v1.1 product-10, -16; Area B): the Slack tab's page model gains the lead counts card
// (its own soft section, read through leadCountsView), repliesOn, and each catch-up row's channel id, ts and reply draft (one
// batched replyBadgesFor read; a failure leaves every reply null). Invented names only.

const NOW = new Date("2026-11-08T15:00:00.000Z");
const S = (over: Partial<ExecSettings> = {}): ExecSettings => ({ ...DEFAULT_SETTINGS, principalId: principal.id, slackReadingSchemaReady: true, slackReadingEnabled: true, ...over });
const LEADS: LeadCountsView = { state: "ok", asOf: null, tz: "America/New_York", totals: null, clients: [], unlinked: null, coverage: null,
  fix: { unlinked: [], ambiguous: [], notMember: [], more: 0 } };

let ITEM: ReturnType<typeof slackItem>;
beforeEach(() => {
  vi.clearAllMocks();
  ITEM = slackItem();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(loadSettings).mockResolvedValue(S());
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [ITEM], mutedHidden: 0 });
  vi.mocked(listIntelChannels).mockImplementation(async (_p, o) => {
    const all = [channel("publicWatched")];
    return o?.channelIds ? all.filter((c) => o.channelIds?.includes(c.channelId)) : all;
  });
  vi.mocked(listDigestViews).mockResolvedValue([]);
  vi.mocked(slackCatchUpCounts).mockResolvedValue({ unanswered: 1, decisionsPending: 0, notAssessed: 0 });
  vi.mocked(leadCountsView).mockResolvedValue(LEADS);
  vi.mocked(replyBadgesFor).mockResolvedValue(new Map());
});

describe("the leads section", () => {
  it("read through leadCountsView with the page's settings, clock and deadline; a failure is its own Couldn't load", async () => {
    const v = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(v.leads).toEqual({ ok: true, data: LEADS });
    expect(vi.mocked(leadCountsView)).toHaveBeenCalledWith(principal, S(), NOW, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.mocked(leadCountsView).mockRejectedValueOnce(new Error("down"));
    const failed = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(failed.leads).toEqual({ ok: false, error: "unavailable" });
    expect(failed.catchUp.ok).toBe(true);
  });
  it("not read while the intel state isn't ok (the page shows only the state's sentence)", async () => {
    vi.mocked(slackIntelState).mockResolvedValue("reading_off");
    const v = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(vi.mocked(leadCountsView)).not.toHaveBeenCalled();
    expect(v.leads.ok).toBe(false);
  });
});

describe("repliesOn and the catch-up rows' reply drafts (product-16)", () => {
  it("replies off: repliesOn false, every reply null, no badge read", async () => {
    const v = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(v.repliesOn).toBe(false);
    if (!v.catchUp.ok) throw new Error("catch-up");
    expect(v.catchUp.data.rows[0]).toMatchObject({ channelId: ITEM.channelId, ts: ITEM.ts, reply: null });
    expect(vi.mocked(replyBadgesFor)).not.toHaveBeenCalled();
  });
  it("replies on: one batched read for the shown rows; a draft's id, status and sentAt on its row; a failure leaves them null", async () => {
    vi.mocked(loadSettings).mockResolvedValue(S({ slackP10SchemaReady: true, slackRepliesEnabled: true }));
    const item = ITEM;
    vi.mocked(replyBadgesFor).mockResolvedValueOnce(new Map([[`${item.channelId}:${item.ts}`, { id: `esr_${"1".repeat(32)}`, status: "sent", sentAt: "2026-11-08T14:00:00.000Z" }]]));
    const v = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(v.repliesOn).toBe(true);
    if (!v.catchUp.ok) throw new Error("catch-up");
    expect(v.catchUp.data.rows[0].reply).toEqual({ id: `esr_${"1".repeat(32)}`, status: "sent", sentAt: "2026-11-08T14:00:00.000Z" });
    expect(vi.mocked(replyBadgesFor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replyBadgesFor).mock.calls[0][1]).toEqual([{ channelId: item.channelId, ts: item.ts }]);
    vi.mocked(replyBadgesFor).mockRejectedValueOnce(new Error("down"));
    const failed = await getSlackPageView(principal, { date: "" }, { now: NOW });
    if (!failed.catchUp.ok) throw new Error("catch-up");
    expect(failed.catchUp.data.rows[0].reply).toBeNull();
  });
});
