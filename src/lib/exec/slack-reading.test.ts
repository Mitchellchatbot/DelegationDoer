import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), slackReadingSchemaReady: vi.fn(), getReadingHalf: vi.fn(), lastReadingEventAt: vi.fn()
}));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), lastSweepAt: vi.fn(), listItemsForAttention: vi.fn(), slackScreenRows: vi.fn()
}));

import { captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { NOW, PRINCIPAL, channelRow, installationRow, itemRow, readingHalf, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf, lastReadingEventAt, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { lastSweepAt, listItemsForAttention, slackScreenRows, type SlackScreenRows } from "@/lib/exec/slack-read-store";
import * as facade from "@/lib/exec/slack-reading";
import { __resetAnsweredExclusionForTests, getAnsweredExclusion, getSlackReadingState, listOpenSlackItems, registerAnsweredExclusion } from "@/lib/exec/slack-reading";
import { slackMsgFingerprint } from "@/lib/exec/slack-read-types";

// P7a contract §3.19, §5.14 AT14 (Area D): the facade P7b and P8 import.

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
  __resetAnsweredExclusionForTests();
  vi.mocked(slackReadingSchemaReady).mockResolvedValue(true);
  vi.mocked(getReadingHalf).mockResolvedValue({ row: installationRow(), reading: readingHalf() });
  vi.mocked(lastReadingEventAt).mockResolvedValue("2026-11-08T14:59:00.000Z");
  vi.mocked(lastSweepAt).mockResolvedValue("2026-11-08T14:30:00.000Z");
  vi.mocked(loadSettings).mockResolvedValue(settings());
});
afterEach(() => {
  out.assertClean();
});

describe("getSlackReadingState (P8 M4)", () => {
  it("every state, with the last sweep and event", async () => {
    expect(await getSlackReadingState(PRINCIPAL)).toEqual({ state: "on", discoveredAt: "2026-11-01T01:00:00.000Z", lastSweepAt: "2026-11-08T14:30:00.000Z",
      lastEventAt: "2026-11-08T14:59:00.000Z" });
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReadingEnabled: false }));
    expect((await getSlackReadingState(PRINCIPAL)).state).toBe("paused");
    const half = (over: Parameters<typeof readingHalf>[0]) => ({ row: installationRow(), reading: readingHalf(over) });
    vi.mocked(getReadingHalf).mockResolvedValueOnce(half({ discoveredAt: null, state: "discovering" }));
    expect((await getSlackReadingState(PRINCIPAL)).state).toBe("discovering");
    vi.mocked(getReadingHalf).mockResolvedValueOnce(half({ state: "revoked", hasToken: false }));
    expect((await getSlackReadingState(PRINCIPAL)).state).toBe("revoked");
    vi.mocked(getReadingHalf).mockResolvedValueOnce(half({ lastErrorCode: "invalid_auth" }));
    expect((await getSlackReadingState(PRINCIPAL)).state).toBe("error");
    vi.mocked(getReadingHalf).mockResolvedValueOnce(half({ state: "none", hasToken: false }));
    expect(await getSlackReadingState(PRINCIPAL)).toEqual({ state: "not_consented", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    vi.mocked(getReadingHalf).mockResolvedValueOnce(null);
    expect((await getSlackReadingState(PRINCIPAL)).state).toBe("bot_not_connected");
    vi.mocked(slackReadingSchemaReady).mockResolvedValueOnce(false);
    expect((await getSlackReadingState(PRINCIPAL)).state).toBe("not_installed");
  });
});

describe("AT14 listOpenSlackItems: C20's screen", () => {
  const T = (n: number) => `17941400${String(n).padStart(2, "0")}.000100`;
  const screen = (over: Partial<SlackScreenRows> = {}): SlackScreenRows => ({
    readingLive: true,
    channels: new Map([["C0GENERAL", { class: "standard", watchState: "watched", muteSource: null, financeName: false }]]),
    items: new Map(), messages: new Set([1, 2, 3, 4, 5, 6].map((n) => slackMsgFingerprint("C0GENERAL", T(n)))), markers: new Set(), ...over
  });
  beforeEach(() => {
    vi.mocked(listItemsForAttention).mockResolvedValue({ items: [1, 2, 3].map((n) => itemRow({ ts: T(n) })), channels: [channelRow()] });
    vi.mocked(slackScreenRows).mockResolvedValue(screen());
  });
  const list = (surface: "web" | "slack" = "web", limit = 50) => listOpenSlackItems(PRINCIPAL, { sinceIso: "2026-11-01T00:00:00.000Z", limit, surface });

  it("newest first, limited, since the given time", async () => {
    expect((await list()).map((i) => i.ts)).toEqual([T(3), T(2), T(1)]);
    expect((await list("web", 2)).map((i) => i.ts)).toEqual([T(3), T(2)]);
    expect(await listOpenSlackItems(PRINCIPAL, { sinceIso: "2026-11-09T00:00:00.000Z", limit: 5, surface: "web" })).toEqual([]);
  });

  it("withheld: reading not live; a deny / unclassified / hub / missing channel; a gone message or a marker", async () => {
    vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ readingLive: false }));
    expect(await list()).toEqual([]);
    for (const cls of ["deny", "unclassified", "hub"] as const) {
      vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ channels: new Map([["C0GENERAL", { class: cls, watchState: "watched", muteSource: null, financeName: false }]]) }));
      expect(await list()).toEqual([]);
    }
    vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ channels: new Map() }));
    expect(await list()).toEqual([]);
    vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ messages: new Set([slackMsgFingerprint("C0GENERAL", T(1))]), markers: new Set([slackMsgFingerprint("C0GENERAL", T(1))]) }));
    expect(await list()).toEqual([]);
  });

  it("muted: only bypass items, and never in a default_finance mute; surface slack withholds finance items and finance-named channels", async () => {
    vi.mocked(listItemsForAttention).mockResolvedValue({ items: [itemRow({ ts: T(1), bypassMute: true }), itemRow({ ts: T(2) }), itemRow({ ts: T(3), sourceClass: "finance" })], channels: [channelRow()] });
    vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ channels: new Map([["C0GENERAL", { class: "standard", watchState: "muted", muteSource: "owner", financeName: false }]]) }));
    expect((await list()).map((i) => i.ts)).toEqual([T(1)]);
    vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ channels: new Map([["C0GENERAL", { class: "finance", watchState: "muted", muteSource: "default_finance", financeName: true }]]) }));
    expect(await list()).toEqual([]);
    expect((await list("web")).map((i) => i.ts)).toEqual([T(3), T(2), T(1)]);
    expect((await list("slack")).map((i) => i.ts)).toEqual([T(2), T(1)]);
    vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ channels: new Map([["C0GENERAL", { class: "external", watchState: "watched", muteSource: null, financeName: true }]]) }));
    expect(await list("slack")).toEqual([]);
  });

  it("the feed's rule (integrator): a bypass item shows only under a mute he or Slack set; never unwatched, never a null mute source", async () => {
    vi.mocked(listItemsForAttention).mockResolvedValue({ items: [itemRow({ ts: T(1), bypassMute: true }), itemRow({ ts: T(2) })], channels: [channelRow()] });
    const ch = (watchState: "muted" | "unwatched", muteSource: "owner" | "slack" | null) =>
      screen({ channels: new Map([["C0GENERAL", { class: "standard", watchState, muteSource, financeName: false }]]) });
    vi.mocked(slackScreenRows).mockResolvedValueOnce(ch("muted", "slack"));
    expect((await list()).map((i) => i.ts)).toEqual([T(1)]);
    vi.mocked(slackScreenRows).mockResolvedValueOnce(ch("unwatched", null));
    expect(await list()).toEqual([]);
    vi.mocked(slackScreenRows).mockResolvedValueOnce(ch("muted", null));
    expect(await list()).toEqual([]);
    vi.mocked(slackScreenRows).mockResolvedValueOnce(screen({ channels: new Map([["C0GENERAL", { class: "finance", watchState: "watched", muteSource: null, financeName: false }]]) }));
    expect(await list("slack")).toEqual([]);
  });

  it("a read failure withholds everything", async () => {
    vi.mocked(slackScreenRows).mockRejectedValueOnce(new Error("down"));
    expect(await list()).toEqual([]);
    vi.mocked(listItemsForAttention).mockRejectedValueOnce(new Error("down"));
    expect(await list()).toEqual([]);
  });
});

describe("the hook and the re-exports", () => {
  it("registerAnsweredExclusion: last registration wins; none in P7a", async () => {
    expect(getAnsweredExclusion()).toBeNull();
    const a = vi.fn(async () => []);
    const b = vi.fn(async () => []);
    registerAnsweredExclusion(a);
    registerAnsweredExclusion(b);
    expect(getAnsweredExclusion()).toBe(b);
    expect(() => registerAnsweredExclusion("x" as never)).toThrow(TypeError);
  });

  it("re-exports the P7b / P8 surface", () => {
    for (const name of ["enqueueSlackSweepNow", "listPurgeLog", "listAuthorOptouts", "purgeAuthor", "getDdBotIdentity"]) expect(typeof (facade as Record<string, unknown>)[name]).toBe("function");
    expect(facade.SLACK_ATTENTION_KINDS).toEqual(["slack_decision", "slack_request", "slack_commitment", "slack_unassessed"]);
    expect(facade.SLACK_CAP_FEATURES).toEqual(["slack_triage"]);
    expect(NOW).toBeInstanceOf(Date);
  });
});
