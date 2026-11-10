import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })), notFound: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// Areas A and C at their module boundary (their own tests cover them), and P7a's facade.
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()),
  slackIntelState: vi.fn(),
  slackIntelSchemaReady: vi.fn(),
  listChannelLinks: vi.fn()
}));
vi.mock("@/lib/exec/slack-digests", () => ({ listDigestViews: vi.fn(), slackCatchUpCounts: vi.fn(), dayBounds: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reading")>()),
  listOpenSlackItems: vi.fn(),
  readOpenSlackItems: vi.fn(),
  listIntelChannels: vi.fn(),
  getSlackItemsByIds: vi.fn()
}));

import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { EXEC_TABS, ExecTabs } from "@/components/exec/ExecTabs";
import { BuildDigestButton, buildMessage, buildOutcome, requestDigestBuild } from "@/components/exec/slack/BuildDigestButton";
import { CatchUpList, catchUpShownText } from "@/components/exec/slack/CatchUpList";
import { DigestCard, digestCountsText, digestStatusText } from "@/components/exec/slack/DigestCard";
import { DigestDayNav, slackDayHref } from "@/components/exec/slack/DigestDayNav";
import { SlackPageView } from "@/components/exec/slack/SlackPageView";
import { SlackPrivacyChip } from "@/components/exec/slack/SlackPrivacyChip";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { loadSettings } from "@/lib/exec/principal";
import { listDigestViews, slackCatchUpCounts } from "@/lib/exec/slack-digests";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";
import { getSlackPageView, slackChannelLabel, slackPageDates, type DigestCardView } from "@/lib/exec/slack-page";
import { listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import type { ExecSettings } from "@/lib/exec/types";
import SlackLoading from "@/app/(main)/executive/slack/loading";
import * as slackPage from "@/app/(main)/executive/slack/page";
import { settings as p5aSettings, textOf } from "../__tests__/p5a-ui-fixtures";
import { INTEL_SENTINELS, assertNoSlackLeak, captureConsole } from "../__tests__/slack-intel-assert";
import { NOW, NOW_ISO, TZ, catchUpRow, channel, digestCard, permalinkFor, principal, slackItem, slackPageView } from "../__tests__/p7b-ui-fixtures";

// P7b contract §5.13 UI01–UI11, UI14, UI15 (Area F): the /executive/slack page's view (getSlackPageView over mocked
// Areas A/C and P7a's facade), its components rendered with renderToStaticMarkup, the page file's gate, the loading
// shapes and the tabs. UI12/UI13 are slack-tags.test.ts; UI16 is the static harness (<sp>/p7b-shots, SH01–SH03).

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const DAY = 86_400_000;
const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);
const NON_OK: SlackIntelState[] = ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"];
const SETTINGS = { ...p5aSettings(), slackReadingSchemaReady: true, slackReadingEnabled: true } as ExecSettings;

let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  out = captureConsole();
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [], mutedHidden: 0 });
  vi.mocked(listIntelChannels).mockImplementation(async (_p, o) => {
    const all = ["publicWatched", "publicMuted", "publicSlackMuted", "publicUnwatched", "financeWatched", "externalShared", "privateWatched", "denyLead", "hubOutbound"]
      .map((k) => channel(k as Parameters<typeof channel>[0]));
    return o?.channelIds ? all.filter((c) => o.channelIds?.includes(c.channelId)) : all;
  });
  vi.mocked(listDigestViews).mockResolvedValue([]);
  vi.mocked(slackCatchUpCounts).mockResolvedValue({ unanswered: 0, decisionsPending: 0, notAssessed: 0 });
});

afterEach(() => {
  // §0.3 rule 4: nothing this page logs carries Slack text, a name, a summary, an excerpt or a permalink.
  assertNoSlackLeak({ console: out }, { label: "slack page" });
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

describe("getSlackPageView: the state gate (C1, UI01)", () => {
  for (const state of NON_OK) {
    it(`${state}: reads nothing past the settings and the state; every section is empty`, async () => {
      vi.mocked(slackIntelState).mockResolvedValue(state);
      const view = await getSlackPageView(principal, { date: "yesterday" }, { now: NOW });
      expect(view.state).toBe(state);
      expect(readOpenSlackItems).not.toHaveBeenCalled();
      expect(listIntelChannels).not.toHaveBeenCalled();
      expect(listDigestViews).not.toHaveBeenCalled();
      expect(slackCatchUpCounts).not.toHaveBeenCalled();
      expect(view.catchUp).toEqual({ ok: true, data: { rows: [], total: 0, hiddenMuted: 0 } });
      expect(view.digests).toEqual({ ok: true, data: { cards: [], channelsWithoutDigest: 0 } });
    });
  }

  it("passes the settings it read to slackIntelState, and a settings failure is the page's error (it can't tell what to show)", async () => {
    await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(vi.mocked(slackIntelState).mock.calls[0][1]).toBe(SETTINGS);
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed"));
    await expect(getSlackPageView(principal, { date: "" }, { now: NOW })).rejects.toThrow("exec_settings read failed");
  });
});

describe("getSlackPageView: catch-up (§3.12.1, C7, AM-P7b-2, UI02, UI03)", () => {
  it("reads P7a's open items for 14 days, 200 rows, surface web; keeps needs-response unanswered items the item policy allows", async () => {
    const keep = slackItem({ channelId: "C0ACMESEO" });
    const noResponse = slackItem({ needsResponse: false });
    const answered = slackItem({ kind: "commitment", commitmentDirection: "owed_to_mitchell", respondedAt: "2026-11-08T14:30:00.000Z" });
    const finance = slackItem({ channelId: "C0PAYROLL", sourceClass: "finance" });
    const bypassMuted = slackItem({ channelId: "C0DESIGN", bypassMute: true });
    const muted = slackItem({ channelId: "C0DESIGN", bypassMute: false });
    const slackMuted = slackItem({ channelId: "C0LAUNCH", bypassMute: false });
    const unwatched = slackItem({ channelId: "C0RANDOM", bypassMute: true });
    const denied = slackItem({ channelId: "C0FBLEADS" });
    const hub = slackItem({ channelId: "C0OUTBOUND" });
    const unknownChannel = slackItem({ channelId: "C0GONE" });
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [keep, noResponse, answered, finance, bypassMuted, muted, slackMuted, unwatched, denied, hub, unknownChannel], mutedHidden: 0 });
    const view = await getSlackPageView(principal, { date: "yesterday" }, { now: NOW });
    expect(readOpenSlackItems).toHaveBeenCalledWith(principal, { sinceIso: new Date(NOW.getTime() - 14 * DAY).toISOString(), limit: 200, surface: "web" });
    const ids = vi.mocked(listIntelChannels).mock.calls[0][1]?.channelIds ?? [];
    expect([...ids].sort()).toEqual([...new Set([keep, finance, bypassMuted, muted, slackMuted, unwatched, denied, hub, unknownChannel].map((i) => i.channelId))].sort());
    expect(view.catchUp.ok).toBe(true);
    if (!view.catchUp.ok) return;
    expect(view.catchUp.data.rows.map((r) => r.itemId).sort()).toEqual([keep.id, finance.id, bypassMuted.id].sort());
    // The muted and unwatched items the policy held back (not_bypass); deny / hub / unknown are never counted.
    expect(view.catchUp.data.hiddenMuted).toBe(3);
    expect(view.catchUp.data.total).toBe(3);
    const fin = view.catchUp.data.rows.find((r) => r.itemId === finance.id);
    expect(fin?.privacy).toBe("finance");
    expect(fin?.channelLabel).toBe("#payroll");
  });

  it("rows: newest first by ts, ≤ 50 (total counts all), the quote only when stored and never for an external author, a permalink only when allowed", async () => {
    const items = Array.from({ length: 60 }, (_, i) => slackItem({ ts: `${1794100000 + i}.000100` }));
    const external = slackItem({ ts: "1794200000.000100", authorExternal: true, excerpt: "should never show" });
    const unassessed = slackItem({ ts: "1794200001.000100", assessed: false, summary: null, excerpt: null });
    const badLink = slackItem({ ts: "1794200002.000100", permalink: "https://evil.example/archives/C0ACMESEO/p1" });
    const httpLink = slackItem({ ts: "1794200003.000100", permalink: "http://scaledai.slack.com/archives/C0ACMESEO/p1794200003000100" });
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [...items, external, unassessed, badLink, httpLink], mutedHidden: 0 });
    const view = await getSlackPageView(principal, { date: "today" }, { now: NOW });
    if (!view.catchUp.ok) throw new Error("catch-up failed");
    const rows = view.catchUp.data.rows;
    expect(rows).toHaveLength(50);
    expect(view.catchUp.data.total).toBe(64);
    expect(rows.slice(0, 4).map((r) => r.itemId)).toEqual([httpLink.id, badLink.id, unassessed.id, external.id]);
    expect(rows[4].itemId).toBe(items[59].id);
    const byId = new Map(rows.map((r) => [r.itemId, r]));
    expect(byId.get(external.id)?.quote).toBeNull();
    expect(byId.get(unassessed.id)).toMatchObject({ assessed: false, summary: null, quote: null });
    expect(byId.get(badLink.id)?.permalink).toBeNull();
    expect(byId.get(httpLink.id)?.permalink).toBeNull();
    expect(byId.get(items[59].id)).toMatchObject({ quote: items[59].excerpt, permalink: items[59].permalink, channelLabel: "#acme-dental-seo", kind: "request" });
    expect(byId.get(items[59].id)?.at).toBe(new Date(1794100059 * 1000).toISOString());
  });

  it("UI03 (fixer ui-8) the muted line counts what P7a's screen withheld (it never reaches the policy); a read failure is Couldn't load (ui-9)", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [slackItem()], mutedHidden: 4 });
    const view = await getSlackPageView(principal, { date: "" }, { now: NOW });
    if (!view.catchUp.ok) throw new Error("catch-up failed");
    expect(view.catchUp.data).toMatchObject({ total: 1, hiddenMuted: 4 });
    // Nothing open but a muted conversation holds some: the empty list still says how many are hidden.
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [], mutedHidden: 2 });
    const empty = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(empty.catchUp).toEqual({ ok: true, data: { rows: [], total: 0, hiddenMuted: 2 } });
    // A failed read is never "Nothing in Slack is waiting on you".
    vi.mocked(readOpenSlackItems).mockRejectedValue(new Error("down"));
    const failed = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(failed.catchUp).toEqual({ ok: false, error: "unavailable" });
  });

  it("the row carries no author: no author id, no display name, no author field", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [slackItem()], mutedHidden: 0 });
    const view = await getSlackPageView(principal, { date: "" }, { now: NOW });
    if (!view.catchUp.ok) throw new Error("catch-up failed");
    expect(Object.keys(view.catchUp.data.rows[0]).sort()).toEqual(["ageLabel", "assessed", "at", "channelLabel", "itemId", "kind", "permalink", "privacy", "quote", "summary"]);
    expect(JSON.stringify(view)).not.toContain(INTEL_SENTINELS.authorName);
    expect(JSON.stringify(view)).not.toContain("U0ALICE");
  });
});

describe("getSlackPageView: digests and counts (§3.12.1)", () => {
  it("asks Area C for the chosen day's cards (use page, past the 30 shown) and counts the rest", async () => {
    const cards: DigestCardView[] = Array.from({ length: 35 }, (_, i) => digestCard({ channelId: `C0CH${String(i).padStart(3, "0")}`, date: "2026-11-07" }));
    vi.mocked(listDigestViews).mockResolvedValue(cards);
    const view = await getSlackPageView(principal, { date: "yesterday" }, { now: NOW });
    const [p, state, q, o] = vi.mocked(listDigestViews).mock.calls[0];
    expect(p).toBe(principal);
    expect(state).toBe("ok");
    expect(q.dates).toEqual(["2026-11-07"]);
    expect(q.use).toBe("page");
    expect(q.limit).toBeGreaterThan(30);
    expect(q.channelIds).toBeUndefined();
    expect(o?.now).toBe(NOW);
    expect(view.digests).toEqual({ ok: true, data: { cards: cards.slice(0, 30), channelsWithoutDigest: 5 } });
  });

  it("the counts are slackCatchUpCounts' (with the page's now)", async () => {
    vi.mocked(slackCatchUpCounts).mockResolvedValue({ unanswered: 7, decisionsPending: 2, notAssessed: 1 });
    const view = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(view.counts).toEqual({ ok: true, data: { unanswered: 7, decisionsPending: 2, notAssessed: 1 } });
    expect(vi.mocked(slackCatchUpCounts).mock.calls[0][2]?.now).toBe(NOW);
  });

  it("UI08 (data): each section fails on its own, and the log names the section and the error's class only", async () => {
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [slackItem()], mutedHidden: 0 });
    vi.mocked(listIntelChannels).mockRejectedValue(new TypeError(`fetch failed ${INTEL_SENTINELS.channelName}`));
    vi.mocked(listDigestViews).mockResolvedValue([digestCard()]);
    const one = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(one.catchUp).toEqual({ ok: false, error: "unavailable" });
    expect(one.digests.ok).toBe(true);
    expect(one.counts.ok).toBe(true);
    vi.mocked(listDigestViews).mockRejectedValue(new Error(INTEL_SENTINELS.summary));
    vi.mocked(slackCatchUpCounts).mockRejectedValue(new Error(INTEL_SENTINELS.summary));
    vi.mocked(listIntelChannels).mockResolvedValue([channel("publicWatched")]);
    const two = await getSlackPageView(principal, { date: "" }, { now: NOW });
    expect(two.catchUp.ok).toBe(true);
    expect(two.digests).toEqual({ ok: false, error: "unavailable" });
    expect(two.counts).toEqual({ ok: false, error: "unavailable" });
    const logged = out.calls().map((c) => String(c[0]));
    expect(logged.some((l) => l.includes("catch-up failed for ep_owner (TypeError)"))).toBe(true);
    expect(logged.some((l) => l.includes("digests failed for ep_owner (Error)"))).toBe(true);
  });
});

describe("slackPageDates (UI07)", () => {
  it("offers today, yesterday and the 5 days before them, in his zone; a known value is chosen, anything else is yesterday", () => {
    const d = slackPageDates(NOW, TZ, "");
    expect(d.options.map((o) => o.value)).toEqual(["today", "yesterday", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02"]);
    expect(d.options.map((o) => o.label)).toEqual(["Today", "Yesterday", "Fri, Nov 6", "Thu, Nov 5", "Wed, Nov 4", "Tue, Nov 3", "Mon, Nov 2"]);
    expect(d).toMatchObject({ selected: "yesterday", label: "Yesterday", localDate: "2026-11-07" });
    expect(slackPageDates(NOW, TZ, "today")).toMatchObject({ selected: "today", localDate: "2026-11-08" });
    expect(slackPageDates(NOW, TZ, "2026-11-08")).toMatchObject({ selected: "today", localDate: "2026-11-08" });
    expect(slackPageDates(NOW, TZ, "2026-11-07")).toMatchObject({ selected: "yesterday", localDate: "2026-11-07" });
    expect(slackPageDates(NOW, TZ, "2026-11-04")).toMatchObject({ selected: "2026-11-04", localDate: "2026-11-04", label: "Wed, Nov 4" });
    for (const bad of ["2026-11-01", "2026-11-09", "2026-13-01", "tomorrow", "../x", "2026-11-04T00:00", "<script>"]) {
      expect(slackPageDates(NOW, TZ, bad), bad).toMatchObject({ selected: "yesterday", localDate: "2026-11-07" });
    }
  });

  it("is DST-correct: the day after the fall-back change, and across the spring-forward one, in New York and Karachi", () => {
    expect(slackPageDates(new Date("2026-11-02T04:30:00Z"), TZ, "").options.map((o) => o.value).slice(2)).toEqual(["2026-10-30", "2026-10-29", "2026-10-28", "2026-10-27", "2026-10-26"]);
    expect(slackPageDates(new Date("2026-03-09T12:00:00Z"), TZ, "2026-03-08")).toMatchObject({ selected: "yesterday", localDate: "2026-03-08" });
    expect(slackPageDates(new Date("2026-03-09T12:00:00Z"), "Asia/Karachi", "").localDate).toBe("2026-03-08");
  });

  it("the view uses the chosen local date for its digests read", async () => {
    await getSlackPageView(principal, { date: "2026-11-03" }, { now: NOW });
    expect(vi.mocked(listDigestViews).mock.calls[0][2].dates).toEqual(["2026-11-03"]);
  });
});

describe("slackChannelLabel", () => {
  it("#name for a named channel (cut to Slack's characters), the kind's words otherwise", () => {
    expect(slackChannelLabel(channel("publicWatched"))).toBe("#acme-dental-seo");
    expect(slackChannelLabel(channel("privateWatched"))).toBe("#private-ops");
    expect(slackChannelLabel(channel("mpim"))).toBe("Group DM");
    expect(slackChannelLabel(channel("im"))).toBe("Direct message");
    expect(slackChannelLabel(channel("publicWatched", { name: "<b>x</b> y" }))).toBe("#bxby");
    expect(slackChannelLabel(channel("publicWatched", { name: null }))).toBe("Channel");
    expect(slackChannelLabel(channel("privateWatched", { name: "" }))).toBe("Private channel");
    expect(slackChannelLabel(null)).toBe("Channel");
  });
});

// ---------------------------------------------------------------------------
// The components
// ---------------------------------------------------------------------------

describe("UI01: each state renders its exact copy and no catch-up or digest section", () => {
  for (const state of NON_OK) {
    it(state, () => {
      const out = html(createElement(SlackPageView, { view: slackPageView({ state }) }));
      expect(textOf(out)).toContain(SLACK_INTEL_COPY.state[state as keyof typeof SLACK_INTEL_COPY.state]);
      expect(out).toContain(`data-slack-intel-state="${state}"`);
      for (const marker of ["data-catchup", "data-digests", "data-digest-card", "data-slack-counts"]) expect(out).not.toContain(marker);
      expect(textOf(out)).toContain(SLACK_INTEL_COPY.pageIntro);
      expect(out).toContain('href="/executive/settings"');
    });
  }

  it("ok: no state sentence; the counts, catch-up and digests", () => {
    const out = html(createElement(SlackPageView, { view: slackPageView() }));
    expect(out).not.toContain("data-slack-intel-state");
    for (const marker of ["data-catchup", "data-digests", "data-digest-card", "data-slack-counts"]) expect(out).toContain(marker);
    expect(textOf(out)).toContain(SLACK_INTEL_COPY.pickerLink);
    expect(textOf(out)).toContain(SLACK_INTEL_COPY.catchUpTitle);
    expect(textOf(out)).toContain(SLACK_INTEL_COPY.digestsTitle);
  });
});

// P9 F28, F30: the counts strip labels the model's readings as AI-assessed, and says when a count is a floor; the
// catch-up list says how many there are past the 50 it shows.
describe("P9 F28 / F30: the counts and the catch-up total", () => {
  const strip = (counts: Record<string, unknown>) => {
    const out = html(createElement(SlackPageView, { view: slackPageView({ counts: { ok: true, data: counts as never } }) }));
    return out.slice(out.indexOf("data-slack-counts"), out.indexOf("data-catchup"));
  };

  it("F28: Unanswered and Decisions pending are AI-assessed; Not assessed stays Derived", () => {
    const text = textOf(strip({ unanswered: 7, decisionsPending: 2, notAssessed: 1 }));
    expect(text).toMatch(/Unanswered AI-assessed 7/);
    expect(text).toMatch(/Decisions pending AI-assessed 2/);
    expect(text).toMatch(/Not assessed Derived 1/);
    expect(text.match(/AI-assessed/g)).toHaveLength(2);
  });

  it("F30: a count from a full page of rows reads 'N+'; below the limit it is exact", () => {
    const text = textOf(strip({ unanswered: 200, decisionsPending: 12, notAssessed: 0, truncated: true }));
    expect(text).toMatch(/Unanswered AI-assessed 200\+/);
    expect(text).toMatch(/Decisions pending AI-assessed 12\+/);
    expect(textOf(strip({ unanswered: 3, decisionsPending: 0, notAssessed: 0 }))).not.toContain("+");
  });

  it("F30: slackCatchUpCounts (the real one) marks a full page of rows truncated; below the limit the key is absent", async () => {
    const { slackCatchUpCounts: realCounts } = await vi.importActual<typeof import("@/lib/exec/slack-digests")>("@/lib/exec/slack-digests");
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: Array.from({ length: 200 }, () => slackItem({ channelId: "C0ACMESEO" })), mutedHidden: 0 });
    const full = await realCounts(principal, "ok", { now: NOW });
    expect(full).toMatchObject({ unanswered: 200, truncated: true });
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: Array.from({ length: 199 }, () => slackItem({ channelId: "C0ACMESEO" })), mutedHidden: 0 });
    const below = await realCounts(principal, "ok", { now: NOW });
    expect(below).toMatchObject({ unanswered: 199 });
    expect(below).not.toHaveProperty("truncated");
  });

  it("F30: catch-up shows 'Showing the newest 50 of 73' when it holds back rows; nothing when it shows them all", () => {
    const rows = Array.from({ length: 50 }, (_, i) => catchUpRow({ itemId: `esi_${String(i).padStart(32, "0")}` }));
    const cut = html(createElement(CatchUpList, { section: { ok: true, data: { rows, total: 73, hiddenMuted: 0 } }, tz: TZ, now: NOW_ISO }));
    expect(textOf(cut)).toContain("Showing the newest 50 of 73");
    expect(cut).toContain("data-catchup-shown");
    const all = html(createElement(CatchUpList, { section: { ok: true, data: { rows: rows.slice(0, 3), total: 3, hiddenMuted: 0 } }, tz: TZ, now: NOW_ISO }));
    expect(all).not.toContain("data-catchup-shown");
    expect(catchUpShownText(50, 1234)).toBe("Showing the newest 50 of 1,234");
  });
});

describe("UI02: catch-up rows", () => {
  const list = (rows: ReturnType<typeof catchUpRow>[], hiddenMuted = 0) =>
    html(createElement(CatchUpList, { section: { ok: true, data: { rows, total: rows.length, hiddenMuted } }, tz: TZ, now: NOW_ISO }));

  it("chip, kind, AI label, the quote when present and Open in Slack for an allowed permalink", () => {
    const out = list([catchUpRow()]);
    const text = textOf(out);
    expect(text).toContain("Public");
    expect(text).toContain("Request");
    expect(text).toContain("#acme-dental-seo");
    expect(text).toContain("Asks you to approve the October SEO report.");
    expect(text).toContain("AI-assessed");
    expect(out).toContain("data-catchup-quote");
    expect(text).toContain("can you sign off on the october report today?");
    expect(out).toMatch(/<a [^>]*href="https:\/\/scaledai\.slack\.com\/archives\/C0ACMESEO\/p1794146400000100"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(text).toContain(SLACK_INTEL_COPY.openInSlack);
    expect(text).toContain("1 h ago");
  });

  it("an unassessed row says so and has no AI label; no quote, no link when there is none", () => {
    const out = list([catchUpRow({ assessed: false, summary: null, quote: null, permalink: null })]);
    expect(textOf(out)).toContain(SLACK_INTEL_COPY.notAssessed);
    expect(textOf(out)).not.toContain("AI-assessed");
    expect(out).not.toContain("data-catchup-quote");
    expect(out).not.toContain("<a ");
    expect(textOf(out)).not.toContain(SLACK_INTEL_COPY.openInSlack);
  });

  it("a permalink the allow-list refuses is never a link, whatever the view says", () => {
    for (const bad of ["https://evil.example/archives/C1/p1", "http://scaledai.slack.com/archives/C0ACMESEO/p1", "javascript:alert(1)", "https://scaledai.slack.com/oauth/v2/authorize?x=1"]) {
      const out = list([catchUpRow({ permalink: bad })]);
      expect(out, bad).not.toContain("<a ");
    }
  });

  it("each kind and privacy has its label (Finance and Slack Connect chips)", () => {
    for (const [kind, label] of Object.entries(SLACK_INTEL_COPY.kinds)) {
      expect(textOf(list([catchUpRow({ kind: kind as ReturnType<typeof catchUpRow>["kind"] })]))).toContain(label);
    }
    expect(textOf(list([catchUpRow({ privacy: "finance" })]))).toContain("Finance");
    expect(textOf(list([catchUpRow({ privacy: "external" })]))).toContain("Slack Connect");
    expect(textOf(html(createElement(SlackPrivacyChip, { privacy: "nope" as never })))).toBe("Private");
  });

  it("empty: the empty sentence", () => {
    expect(textOf(list([]))).toContain(SLACK_INTEL_COPY.catchUpEmpty);
  });
});

describe("UI03: the muted / unwatched hidden count", () => {
  it("says how many the policy held back, only when there are some", () => {
    const shown = html(createElement(CatchUpList, { section: { ok: true, data: { rows: [], total: 0, hiddenMuted: 4 } }, tz: TZ, now: NOW_ISO }));
    expect(textOf(shown)).toContain("4 more in muted conversations aren't shown.");
    const none = html(createElement(CatchUpList, { section: { ok: true, data: { rows: [catchUpRow()], total: 1, hiddenMuted: 0 } }, tz: TZ, now: NOW_ISO }));
    expect(none).not.toContain("data-catchup-hidden-muted");
  });
});

describe("UI04: digest cards", () => {
  const card = (over: Partial<DigestCardView>) => html(createElement(DigestCard, { card: digestCard(over) }));

  it("every status has its sentence", () => {
    const expected: Record<string, string> = {
      building: SLACK_INTEL_COPY.digestBuilding,
      empty: SLACK_INTEL_COPY.digestEmpty,
      stale: SLACK_INTEL_COPY.digestStale,
      failed: SLACK_INTEL_COPY.digestFailed,
      skipped_cap: SLACK_INTEL_COPY.digestSkippedCap,
      not_built: SLACK_INTEL_COPY.digestNotBuilt
    };
    for (const [status, text] of Object.entries(expected)) {
      const out = card({ status: status as DigestCardView["status"], summary: null, highlights: [], decisions: [], openQuestions: [] });
      expect(textOf(out), status).toContain(text);
      expect(out, status).not.toContain("data-digest-summary");
    }
    expect(digestStatusText("stale", false)).toBe(SLACK_INTEL_COPY.digestStaleOld);
    expect(digestStatusText("built")).toBeNull();
  });

  it("built: the summary, the three lists, AI-labelled; the counts line (people incl. Slack Connect, bots incl. DD, threads)", () => {
    const out = card({});
    const text = textOf(out);
    expect(text).toContain("The team finished the October report");
    expect(text).toContain("AI-assessed");
    expect(text).toContain("October report finished.");
    expect(text).toContain("Audit moves to Tuesday.");
    expect(text).toContain("Who reviews the backlinks?");
    expect(text).toContain("6 messages from people · 3 from bots and DD · 1 threads");
    expect(digestCountsText({ human: 0, bot: 0, ddPost: 0, external: 0, threads: 0 })).toBe("0 messages from people · 0 from bots and DD · 0 threads");
    expect(out).toContain('id="ch-C0ACMESEO"');
  });

  it("finance and Slack Connect chips; the partial line; the tagged client's name", () => {
    expect(textOf(card({ privacy: "finance", channelLabel: "#payroll" }))).toContain("Finance");
    expect(textOf(card({ privacy: "external" }))).toContain("Slack Connect");
    expect(textOf(card({ partial: true }))).toContain(SLACK_INTEL_COPY.digestPartial);
    expect(card({ partial: false })).not.toContain("data-digest-partial");
    expect(textOf(card({ clientName: "Acme Dental" }))).toContain("Acme Dental");
    expect(card({ clientName: null })).not.toContain("data-digest-client");
  });

  it("the counts line shows for built and empty only", () => {
    expect(card({ status: "failed", summary: null })).not.toContain("data-digest-counts");
    expect(card({ status: "empty", summary: null })).toContain("data-digest-counts");
    expect(card({ counts: null })).not.toContain("data-digest-counts");
  });
});

describe("UI05: BuildDigestButton", () => {
  it("not rendered when framed or when canBuild is false", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    expect(html(createElement(BuildDigestButton, { channelId: "C0ACMESEO", canBuild: true }))).toBe("");
    vi.mocked(useIsTopWindow).mockReturnValue(true);
    expect(html(createElement(BuildDigestButton, { channelId: "C0ACMESEO", canBuild: false }))).toBe("");
    const out = html(createElement(BuildDigestButton, { channelId: "C0ACMESEO", canBuild: true }));
    expect(out).toContain("data-build-digest-button");
    expect(textOf(out)).toContain(SLACK_INTEL_COPY.buildToday);
  });

  it("its four states: idle, queued, fresh, error (the button comes back after an error)", () => {
    const at = (initialState: "idle" | "queued" | "fresh" | "error") => html(createElement(BuildDigestButton, { channelId: "C0ACMESEO", canBuild: true, initialState }));
    expect(at("idle")).toContain('data-build-state="idle"');
    expect(textOf(at("queued"))).toContain(SLACK_INTEL_COPY.buildQueued);
    expect(at("queued")).not.toContain("data-build-digest-button");
    expect(textOf(at("fresh"))).toContain(SLACK_INTEL_COPY.buildFresh);
    expect(at("fresh")).not.toContain("data-build-digest-button");
    expect(textOf(at("error"))).toContain(SLACK_INTEL_COPY.buildError);
    expect(at("error")).toContain("data-build-digest-button");
    expect(buildMessage("idle")).toBeNull();
  });

  it("a card renders the button only when it can build (top-level)", () => {
    expect(html(createElement(DigestCard, { card: digestCard({ canBuild: true }) }))).toContain("data-build-digest-button");
    expect(html(createElement(DigestCard, { card: digestCard({ canBuild: false }) }))).not.toContain("data-build-digest");
  });

  it("POSTs { channelId } to the digests route and maps the answers", async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    const queued = answer(202, { status: "queued" });
    expect(await requestDigestBuild("C0ACMESEO", queued)).toBe("queued");
    const [url, init] = queued.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/exec/slack/digests");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init.body))).toEqual({ channelId: "C0ACMESEO" });
    expect(await requestDigestBuild("C0ACMESEO", answer(200, { status: "fresh" }))).toBe("fresh");
    for (const [status, body] of [[409, { error: "slack_off", state: "reading_off" }], [429, { error: "rate_limited" }], [503, { error: "unavailable" }], [200, { status: "queued" }], [202, {}]] as const) {
      expect(await requestDigestBuild("C0ACMESEO", answer(status, body)), `${status}`).toBe("error");
    }
    expect(await requestDigestBuild("C0ACMESEO", vi.fn(async () => { throw new TypeError("network"); }))).toBe("error");
    const never = vi.fn();
    expect(await requestDigestBuild("not a channel", never)).toBe("error");
    expect(never).not.toHaveBeenCalled();
    expect(buildOutcome(202, "queued")).toBe("error");
  });
});

describe("UI06: model and Slack text are plain text", () => {
  const HOSTILE = '**bold** [click](https://evil.example/x) ![img](https://evil.example/i.png) <img src=x onerror=alert(1)> <script>alert(1)</script> <a href="https://evil.example">a</a>';
  it("a hostile summary, quote, digest line, channel label and client name render inert", () => {
    const view = slackPageView({
      catchUp: { ok: true, data: { rows: [catchUpRow({ summary: HOSTILE, quote: HOSTILE, channelLabel: HOSTILE, permalink: null })], total: 1, hiddenMuted: 0 } },
      digests: {
        ok: true,
        data: {
          cards: [digestCard({ summary: HOSTILE, channelLabel: HOSTILE, clientName: HOSTILE, highlights: [{ text: HOSTILE, permalink: "https://evil.example/x" }], decisions: [{ text: HOSTILE, permalink: null }], openQuestions: [{ text: HOSTILE, permalink: null }] })],
          channelsWithoutDigest: 0
        }
      }
    });
    const out = html(createElement(SlackPageView, { view }));
    expect(out).not.toMatch(/<img|<script|<strong|<em>|<[^>]*\sonerror=/i);
    expect(out).not.toContain('href="https://evil.example');
    expect(out).toContain("**bold** [click](https://evil.example/x)");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("UI07: the date nav", () => {
  it("links today, yesterday and the last 7 days to ?date=, the chosen one current", () => {
    const view = slackPageView();
    const out = html(createElement(DigestDayNav, { date: { ...view.date, selected: "2026-11-04", label: "Wed, Nov 4" } }));
    const hrefs = [...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(view.date.options.map((o) => slackDayHref(o.value)));
    expect(hrefs[0]).toBe("/executive/slack?date=today");
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/executive\/slack\?date=2026-11-04"|<a[^>]*href="\/executive\/slack\?date=2026-11-04"[^>]*aria-current="page"/);
    expect(textOf(out)).toBe("Today Yesterday Fri, Nov 6 Thu, Nov 5 Wed, Nov 4 Tue, Nov 3 Mon, Nov 2");
  });

  it("an invalid ?date reaches the view as yesterday (the page passes the raw value; the view decides)", async () => {
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    await slackPage.default({ searchParams: { date: "1999-01-01" } });
    expect(vi.mocked(listDigestViews).mock.calls[0][2].dates).toEqual([slackPageDates(new Date(), TZ, "").localDate]);
  });
});

describe("UI08: a failed section is 'Couldn't load' for that card only", () => {
  it("catch-up failed: its card says so; the digests still render", () => {
    const out = html(createElement(SlackPageView, { view: slackPageView({ catchUp: { ok: false, error: "unavailable" } }) }));
    expect(textOf(out)).toContain("Couldn't load this section right now.");
    expect(out).toContain("data-digest-card");
    expect(out).not.toContain("data-catchup-row");
  });

  it("digests failed: its card says so; catch-up and the counts still render", () => {
    const out = html(createElement(SlackPageView, { view: slackPageView({ digests: { ok: false, error: "unavailable" } }) }));
    expect(textOf(out)).toContain("Couldn't load this section right now.");
    expect(out).toContain("data-catchup-row");
    expect(out).not.toContain("data-digest-card");
    expect(out).toContain("data-slack-counts");
  });

  it("counts failed: its line says so; the two cards still render", () => {
    const out = html(createElement(SlackPageView, { view: slackPageView({ counts: { ok: false, error: "unavailable" } }) }));
    expect(textOf(out)).toContain("Couldn't load the counts.");
    expect(out).toContain("data-catchup-row");
    expect(out).toContain("data-digest-card");
  });

  it("the channels-without-digest line and the empty day", () => {
    expect(textOf(html(createElement(SlackPageView, { view: slackPageView({ digests: { ok: true, data: { cards: [digestCard()], channelsWithoutDigest: 12 } } }) })))).toContain("12 more conversations had activity.");
    expect(textOf(html(createElement(SlackPageView, { view: slackPageView({ digests: { ok: true, data: { cards: [], channelsWithoutDigest: 0 } } }) })))).toContain(SLACK_INTEL_COPY.digestsEmpty);
  });
});

describe("UI09: ExecTabs", () => {
  it("Overview, Email, Slack, Team, Projects, Chat in order, then Settings; Slack current on the Slack page", () => {
    // P8 (AM-P8-23, forced): the Brief tab comes right after Overview; Slack keeps its place after Email.
    expect(EXEC_TABS.map((t) => t.label)).toEqual(["Overview", "Brief", "Email", "Slack", "Team", "Projects", "Chat"]);
    expect(EXEC_TABS.find((t) => t.key === "slack")).toEqual({ key: "slack", href: "/executive/slack", label: SLACK_INTEL_COPY.tabLabel });
    const out = html(createElement(ExecTabs, { active: "slack", tabs: EXEC_TABS }));
    expect([...out.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "/executive", "/executive/brief", "/executive/email", "/executive/slack", "/executive/team", "/executive/projects", "/executive/chat", "/executive/settings"
    ]);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/executive\/slack"|<a[^>]*href="\/executive\/slack"[^>]*aria-current="page"/);
    expect(html(createElement(SlackPageView, { view: slackPageView() }))).toMatch(/aria-current="page"[^>]*href="\/executive\/slack"|href="\/executive\/slack"[^>]*aria-current="page"/);
  });
});

describe("UI10: loading.tsx is shapes only", () => {
  it("renders no text, names nothing, imports nothing", () => {
    const out = html(createElement(SlackLoading));
    expect(textOf(out)).toBe("");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("dd-skeleton");
    const src = readFileSync(path.join(SRC, "app", "(main)", "executive", "slack", "loading.tsx"), "utf8");
    expect(src).not.toMatch(/exec|executive|assistant|slack/i);
    expect(src).not.toMatch(/\bawait\b|\basync\b|^import /m);
  });
});

describe("UI11: the page calls requireExecPrincipalForPage first", () => {
  const NOT_FOUND = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });

  it("the gate runs before any read, with its route string; the view gets ?date=", async () => {
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    const out = html(await slackPage.default({ searchParams: { date: "today" } }));
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/slack");
    expect(requireExecPrincipalForPage).toHaveBeenCalledTimes(1);
    const gate = vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0];
    expect(gate).toBeLessThan(vi.mocked(loadSettings).mock.invocationCallOrder[0]);
    expect(vi.mocked(listDigestViews).mock.calls[0][2].dates).toEqual([slackPageDates(new Date(), TZ, "today").localDate]);
    expect(out).toContain("Executive AI Assistant");
  });

  it("reads nothing when the gate refuses", async () => {
    vi.mocked(requireExecPrincipalForPage).mockRejectedValue(NOT_FOUND);
    await expect(slackPage.default({ searchParams: {} })).rejects.toBe(NOT_FOUND);
    for (const fn of [loadSettings, slackIntelState, readOpenSlackItems, listIntelChannels, listDigestViews, slackCatchUpCounts]) expect(fn).not.toHaveBeenCalled();
  });

  it("a repeated ?date= is ignored (yesterday); force-dynamic, no metadata, a server component whose first await is the gate", async () => {
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    await slackPage.default({ searchParams: { date: ["today", "2026-11-04"] } });
    expect(vi.mocked(listDigestViews).mock.calls[0][2].dates).toEqual([slackPageDates(new Date(), TZ, "").localDate]);
    expect(slackPage.dynamic).toBe("force-dynamic");
    expect("metadata" in slackPage).toBe(false);
    expect("generateMetadata" in slackPage).toBe(false);
    const src = readFileSync(path.join(SRC, "app", "(main)", "executive", "slack", "page.tsx"), "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/);
    const body = src.slice(src.indexOf("export default async function"));
    expect(body.slice(body.indexOf("await "), body.indexOf("await ") + 40)).toContain("await requireExecPrincipalForPage(");
  });
});

describe("UI14 / UI15: no author anywhere; the excerpt only inside the catch-up list", () => {
  it("a page built from items with a display name, an author id and an excerpt sentinel", async () => {
    const withExcerpt = slackItem({ excerpt: INTEL_SENTINELS.excerpt, authorLabel: INTEL_SENTINELS.authorName, authorUserId: "U0SENTINEL" });
    const external = slackItem({ excerpt: `${INTEL_SENTINELS.externalText}`, authorExternal: true, authorLabel: INTEL_SENTINELS.authorName, authorUserId: "U0EXTERNAL" });
    vi.mocked(readOpenSlackItems).mockResolvedValue({ items: [withExcerpt, external], mutedHidden: 0 });
    vi.mocked(listDigestViews).mockResolvedValue([digestCard()]);
    const view = await getSlackPageView(principal, { date: "" }, { now: NOW });
    const out = html(createElement(SlackPageView, { view }));
    for (const needle of [INTEL_SENTINELS.authorName, "U0SENTINEL", "U0EXTERNAL", "U0ALICE", INTEL_SENTINELS.externalText]) expect(out, needle).not.toContain(needle);
    // UI15: the excerpt appears exactly once, inside the catch-up list's quote.
    expect(out.split(INTEL_SENTINELS.excerpt)).toHaveLength(2);
    const quote = out.match(/<blockquote data-catchup-quote="true"[^>]*>([^<]*)<\/blockquote>/);
    expect(quote?.[1]).toBe(INTEL_SENTINELS.excerpt);
    const catchUpEnd = out.indexOf("</section>", out.indexOf("data-catchup"));
    expect(out.indexOf(INTEL_SENTINELS.excerpt)).toBeLessThan(catchUpEnd);
    expect(out.indexOf(INTEL_SENTINELS.excerpt)).toBeGreaterThan(out.indexOf("data-catchup"));
  });

  it("the digest card holds no excerpt field and renders none", () => {
    expect(Object.keys(digestCard())).not.toContain("excerpt");
    expect(html(createElement(DigestCard, { card: digestCard() }))).not.toContain("quote");
  });

  it("permalinkFor matches P3's allow-list (fixture sanity)", () => {
    expect(permalinkFor("C0ACMESEO", "1794146400.000100")).toBe("https://scaledai.slack.com/archives/C0ACMESEO/p1794146400000100");
  });
});
