import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => false) }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));
// The Overview's other reads, at their module boundary (overview-data.test.ts covers them); every one answers empty.
vi.mock("@/lib/exec/sources/dd", () => ({
  getPendingApprovals: vi.fn(async () => []),
  listActivitySince: vi.fn(async () => []),
  listDepartments: vi.fn(async () => []),
  listEodNotesForDate: vi.fn(async () => []),
  listOpenTasks: vi.fn(async () => []),
  listProjects: vi.fn(async () => []),
  listProjectStages: vi.fn(async () => []),
  listStatusChangeEntries: vi.fn(async () => []),
  listTasksByIds: vi.fn(async () => []),
  listTasksCompletedBetween: vi.fn(async () => []),
  listTasksCreatedBetween: vi.fn(async () => []),
  listTimeEntriesBetween: vi.fn(async () => []),
  listUsers: vi.fn(async () => [])
}));
vi.mock("@/lib/exec/attention", () => ({ lastAttentionRefresh: vi.fn(async () => null), syncAttention: vi.fn() }));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(async () => ({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "ok" })) }));
vi.mock("@/lib/exec/ddtext-store", () => ({ ddtextLastRunAt: vi.fn(async () => null) }));
vi.mock("@/lib/exec/email-view", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/email-view")>()), loadEmailGate: vi.fn() }));
// P7b: Area A's state and Area C's counts at their module boundary.
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/slack-digests", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-digests")>()), slackCatchUpCounts: vi.fn() }));

import { OverviewTileRow, slackTileShown } from "@/components/exec/overview/OverviewTileRow";
import { OverviewView } from "@/components/exec/overview/OverviewView";
import { loadEmailGate } from "@/lib/exec/email-view";
import { getOverview, type ExecOverview, type OverviewSections, type OverviewTiles } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import { slackCatchUpCounts } from "@/lib/exec/slack-digests";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";
import type { ExecSettings } from "@/lib/exec/types";
import { textOf } from "../__tests__/p5a-ui-fixtures";
import { assertNoSlackLeak, captureConsole } from "../__tests__/slack-intel-assert";
import { NOW, NOW_ISO, TZ, principal } from "../__tests__/p7b-ui-fixtures";

// P7b contract §5.13 OV01–OV05 (Area F; §3.12.2, C24): the Overview's Slack tile. getOverview's slack section (the
// email gate's settings → slackIntelState → slackCatchUpCounts raced against 8 s) and OverviewTileRow's seventh tile.

const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);
const SETTINGS = { ...DEFAULT_SETTINGS, slackReadingSchemaReady: true, slackReadingEnabled: true } as ExecSettings;
const ok = <T>(data: T) => ({ ok: true as const, data });
const NON_OK: SlackIntelState[] = ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"];

const TILES: OverviewTiles = {
  localDate: "2026-11-08",
  eodDate: "2026-11-08",
  completedToday: ok({ count: 4, basis: "record" as const, last7Days: [1, 2, 3, 4, 5, 6, 4].map((count, i) => ({ date: `2026-11-0${2 + i}`, count })) }),
  createdToday: ok({ count: 2, basis: "record" as const }),
  openOverdue: ok({ count: 3, autoArchived: 1, basis: "derived" as const }),
  activePeople: ok({ count: 5, basis: "derived" as const }),
  eodSubmitted: ok({ count: 1, basis: "record" as const }),
  hoursLogged: ok({ hours: 12.5, clockedIn: 1, basis: "derived" as const })
};
const row = (slack: OverviewSections["slack"] | null) => html(createElement(OverviewTileRow, { tiles: ok(TILES), tz: TZ, now: NOW_ISO, slack }));
const gridClass = (markup: string) => markup.match(/<div data-overview-tiles="true" class="([^"]*)"/)?.[1].split(" ") ?? [];
const tileCount = (markup: string) => (markup.match(/rounded-2xl border p-4 shadow-soft/g) ?? []).length;

let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  out = captureConsole();
  vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: SETTINGS } as Awaited<ReturnType<typeof loadEmailGate>>);
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(slackCatchUpCounts).mockResolvedValue({ unanswered: 7, decisionsPending: 2, notAssessed: 1 });
});

afterEach(() => {
  assertNoSlackLeak({ console: out }, { label: "overview slack" });
});

describe("getOverview: the Slack section (§3.12.2)", () => {
  it("ok: the counts, read with the page's now and a signal", async () => {
    const o = await getOverview(principal, NOW);
    expect(o.sections.slack).toEqual({ ok: true, data: { state: "ok", counts: { unanswered: 7, decisionsPending: 2, notAssessed: 1 } } });
    expect(vi.mocked(slackIntelState).mock.calls[0][0]).toBe(principal);
    expect(vi.mocked(slackIntelState).mock.calls[0][1]).toBe(SETTINGS);
    const [p, state, opts] = vi.mocked(slackCatchUpCounts).mock.calls[0];
    expect(p).toBe(principal);
    expect(state).toBe("ok");
    expect(opts?.now).toBe(NOW);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  for (const state of NON_OK) {
    it(`${state}: the state with no counts, and the counts are never read`, async () => {
      vi.mocked(slackIntelState).mockResolvedValue(state);
      const o = await getOverview(principal, NOW);
      expect(o.sections.slack).toEqual({ ok: true, data: { state, counts: null } });
      expect(slackCatchUpCounts).not.toHaveBeenCalled();
    });
  }

  it("the settings unreadable: { ok: false } (the state is unknown) and nothing Slack is read", async () => {
    vi.mocked(loadEmailGate).mockRejectedValue(new Error("settings down"));
    const o = await getOverview(principal, NOW);
    expect(o.sections.slack).toEqual({ ok: false, error: "unavailable" });
    expect(slackIntelState).not.toHaveBeenCalled();
    expect(slackCatchUpCounts).not.toHaveBeenCalled();
  });

  it("ok with the counts failing: counts null (the tile's Couldn't load), logged by the error's class only", async () => {
    vi.mocked(slackCatchUpCounts).mockRejectedValue(new TypeError("exec slack read store: listIntelChannels failed"));
    const o = await getOverview(principal, NOW);
    expect(o.sections.slack).toEqual({ ok: true, data: { state: "ok", counts: null } });
    expect(out.calls().map((c) => String(c[0])).some((l) => l.includes("slack counts failed for ep_owner (TypeError)"))).toBe(true);
  });

  it("ok with the counts past 8 s: counts null (the 8 s timer stood in by an already-fired one)", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
      ms === 8_000 ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")) : real(ms)
    );
    vi.mocked(slackCatchUpCounts).mockImplementation(() => new Promise(() => undefined));
    const o = await getOverview(principal, NOW);
    expect(timeout).toHaveBeenCalledWith(8_000);
    expect(o.sections.slack).toEqual({ ok: true, data: { state: "ok", counts: null } });
  });

  it("the email gate's settings with the P7a schema flag off: not_installed straight from slackIntelState", async () => {
    vi.mocked(slackIntelState).mockImplementation(async (_p, s) => (s.slackReadingSchemaReady ? "ok" : "not_installed"));
    vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: { ...SETTINGS, slackReadingSchemaReady: false } } as Awaited<ReturnType<typeof loadEmailGate>>);
    const o = await getOverview(principal, NOW);
    expect(o.sections.slack).toEqual({ ok: true, data: { state: "not_installed", counts: null } });
  });
});

describe("OV01–OV05: the tile", () => {
  it("OV01: shown only when the state is ok with counts (or with the counts unread: OV05)", () => {
    expect(slackTileShown(ok({ state: "ok" as const, counts: { unanswered: 1, decisionsPending: 0, notAssessed: 0 } }))).toBe(true);
    expect(slackTileShown(ok({ state: "ok" as const, counts: null }))).toBe(true);
    for (const state of NON_OK) expect(slackTileShown(ok({ state, counts: null })), state).toBe(false);
    expect(slackTileShown({ ok: false, error: "unavailable" })).toBe(false);
    expect(slackTileShown(undefined)).toBe(false);
    expect(slackTileShown(null)).toBe(false);
    expect(textOf(row(ok({ state: "ok" as const, counts: { unanswered: 7, decisionsPending: 2, notAssessed: 1 } })))).toContain(SLACK_INTEL_COPY.overviewTileLabel);
  });

  it("OV02: the value is the unanswered count, Derived, with its sub line", () => {
    const markup = row(ok({ state: "ok" as const, counts: { unanswered: 7, decisionsPending: 2, notAssessed: 1 } }));
    const tile = markup.slice(markup.indexOf(">", markup.indexOf('href="/executive/slack"')) + 1);
    expect(textOf(tile)).toMatch(/^Slack Derived 7 Unanswered in Slack/);
    expect(tileCount(markup)).toBe(7);
  });

  it("OV03: the grid is xl:grid-cols-7 only with the tile; P2b's six keep xl:grid-cols-6", () => {
    const withTile = gridClass(row(ok({ state: "ok" as const, counts: { unanswered: 0, decisionsPending: 0, notAssessed: 0 } })));
    expect(withTile).toContain("xl:grid-cols-7");
    expect(withTile).not.toContain("xl:grid-cols-6");
    for (const slack of [null, ok({ state: "reading_off" as const, counts: null }), { ok: false as const, error: "unavailable" as const }]) {
      const cls = gridClass(row(slack));
      expect(cls).toContain("xl:grid-cols-6");
      expect(cls).not.toContain("xl:grid-cols-7");
    }
  });

  it("OV04: the tile links to /executive/slack", () => {
    const markup = row(ok({ state: "ok" as const, counts: { unanswered: 3, decisionsPending: 0, notAssessed: 0 } }));
    expect(markup).toMatch(/<a[^>]*href="\/executive\/slack"/);
    expect((markup.match(/href="/g) ?? []).length).toBe(1);
  });

  it("OV05: a failed read with ok → Couldn't load (no link); with another state, or no section → no tile, P2b's row unchanged", () => {
    const failed = row(ok({ state: "ok" as const, counts: null }));
    expect(textOf(failed)).toContain("Slack — Couldn't load");
    expect(failed).not.toContain('href="/executive/slack"');
    expect(tileCount(failed)).toBe(7);
    const base = row(null);
    expect(tileCount(base)).toBe(6);
    for (const state of NON_OK) expect(row(ok({ state, counts: null })), state).toBe(base);
    expect(row({ ok: false, error: "unavailable" })).toBe(base);
    expect(textOf(base)).not.toContain(SLACK_INTEL_COPY.overviewTileSub);
  });

  it("the tiles' failure banner stays as P2b's (no Slack tile under it)", () => {
    const banner = html(createElement(OverviewTileRow, { tiles: { ok: false, error: "unavailable" }, tz: TZ, now: NOW_ISO, slack: ok({ state: "ok" as const, counts: { unanswered: 1, decisionsPending: 0, notAssessed: 0 } }) }));
    expect(textOf(banner)).toContain("Couldn't load today's numbers.");
    expect(banner).not.toContain("/executive/slack");
  });

  it("OverviewView hands sections.slack to the tile row", () => {
    const view = (slack?: OverviewSections["slack"]): ExecOverview => ({
      generatedAt: NOW_ISO,
      timezone: TZ,
      sections: {
        tiles: ok(TILES),
        attention: { ok: false, error: "unavailable" },
        approvals: { ok: false, error: "unavailable" },
        deadlines: { ok: false, error: "unavailable" },
        projects: { ok: false, error: "unavailable" },
        system: { ok: false, error: "unavailable" },
        email: ok({ state: "off" }) as ExecOverview["sections"]["email"],
        ...(slack ? { slack } : {})
      }
    });
    // The Slack tab links there too (EXEC_TABS); the tile is the second link.
    const links = (markup: string) => (markup.match(/href="\/executive\/slack"/g) ?? []).length;
    expect(links(html(createElement(OverviewView, { overview: view(ok({ state: "ok", counts: { unanswered: 9, decisionsPending: 0, notAssessed: 0 } })), principalTz: TZ })))).toBe(2);
    expect(links(html(createElement(OverviewView, { overview: view(), principalTz: TZ })))).toBe(1);
  });
});
