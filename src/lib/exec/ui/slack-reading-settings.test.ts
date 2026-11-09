import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
// Area A's reads at their module boundary (slack-install-reading.test.ts and slack-read-store.test.ts cover them).
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  slackReadingSchemaReady: vi.fn(),
  getReadingHalf: vi.fn(),
  lastReadingEventAt: vi.fn(),
  slackSchemaReady: vi.fn(),
  getActiveInstallation: vi.fn(),
  getLatestInstallation: vi.fn()
}));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-read-store")>()),
  countChannels: vi.fn(),
  listPickerChannels: vi.fn(),
  countPendingTriage: vi.fn(),
  countOpenItems: vi.fn(),
  lastSweepAt: vi.fn()
}));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettingsSnapshot: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/usage")>()), featureSpentTodayUsd: vi.fn() }));

import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { SlackReadingRow, SlackRow, SystemSection, READING_V2_MISSING_TEXT, slackReadingLine } from "@/components/exec/overview/SystemSection";
import { SettingsForm } from "@/components/exec/settings/SettingsForm";
import { SettingsPageView } from "@/components/exec/settings/SettingsPageView";
import {
  FinanceConfirm,
  SlackChannelPicker,
  WATCH_CHOICES,
  channelLabel,
  filterPickerRows,
  needsFinanceConfirm,
  neverReasonLines,
  pickerBadges,
  pickerShowingText,
  rowsAfterAnswer,
  withWatch
} from "@/components/exec/settings/SlackChannelPicker";
import { disconnectOutcome } from "@/components/exec/settings/SlackConnectControls";
import {
  READING_FIELDS,
  SLACK_READ_START_PATH,
  SlackReadingControls,
  enableReadingThenRefresh,
  readingActions,
  readingConfirmKeyAction,
  saveReadingSetting,
  stopReadingThenRefresh
} from "@/components/exec/settings/SlackReadingControls";
import { SlackReadingSection, readingRevokedText, readingSpendText, readingStatusLines } from "@/components/exec/settings/SlackReadingSection";
import { SlackSection, slackResultBannerShown } from "@/components/exec/settings/SlackSection";
import { formatInZone } from "@/lib/exec/format";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import type { OverviewSection, OverviewSystem } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, loadSettingsSnapshot, principalFromRows } from "@/lib/exec/principal";
import { SETTINGS_FIELDS } from "@/lib/exec/settings-fields";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { getActiveInstallation, getLatestInstallation, getReadingHalf, lastReadingEventAt, slackReadingSchemaReady, slackSchemaReady, SlackStoreError } from "@/lib/exec/slack-install";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import { SlackReadStoreError, countChannels, countOpenItems, countPendingTriage, lastSweepAt, listPickerChannels } from "@/lib/exec/slack-read-store";
import { SLACK_CAP_FEATURES, effectiveSlackCapUsd, type ChannelRow, type ReadingHalf } from "@/lib/exec/slack-read-types";
import { getSlackReadingView, orderPickerRows, pickerRowFromChannel, readingViewState } from "@/lib/exec/slack-reading-settings";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import type { InstallationRow, PickerRow, SlackReadingSummary, SlackReadingView } from "@/lib/exec/slack-types";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import {
  SETTINGS_COPY,
  SLACK_STOP_READING_PATH,
  SLACK_WATCH_MODE_PATH,
  disconnectSlack,
  isPickerRow,
  patchSettings,
  setChannelWatch,
  setWatchMode,
  slackChannelPath,
  stopReading
} from "@/lib/exec/ui/settings-api";
import { useRouter } from "next/navigation";
import { NNBSP, NOW, TZ, pickerRow, settings, settingsView, slackReadingView, slackSettingsView, textOf } from "../__tests__/p5a-ui-fixtures";
import { SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "../__tests__/slack-read-assert";

// P7a contract §5.16 SU01-SU17 and SY01-SY04 (Area E; §3.16, §3.17, §3.20.2-4, N4, N11, N12, N20, C10, C29, C30, C47,
// C48): getSlackReadingView in every state, the Settings reading section, its controls and the picker, the client
// calls, P5a's form without the three Slack fields, and the System card's "Slack reading" row. The static layout
// screenshots (SU16) are taken by <sp>/p7a-shots' harness from these same components.

const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const ESI = `esi_${hex32(1)}`;
const VERSION = "2026-11-05T12:00:00.123456+00:00";
const NOW_DATE = new Date(NOW);
const plain = (s: string) => s.split(NNBSP).join(" ");
const fill = (t: string, v: Record<string, string | number>) => Object.entries(v).reduce((s, [k, x]) => s.split(`{${k}}`).join(String(x)), t);

const P: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: "T0SCALED", slack_user_id: "U0MITCH" },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: TZ },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const installationRow = (over: Partial<InstallationRow> = {}): InstallationRow => ({
  id: ESI, principalId: "ep_owner", teamId: "T0SCALED", appId: "A0EXEC", botUserId: "U0BOT", botId: "B0BOT", keyId: "0a1b2c3d",
  botScopes: ["chat:write"], userId: "U0MITCH", dmChannelId: "D0MITCH", installedAt: "2026-11-01T14:30:00.000Z", updatedAt: "2026-11-01T14:30:00.000Z",
  revokedAt: null, revokeReason: null, lastDmAt: null, lastErrorCode: null, lastErrorAt: null, purgedAt: null, hasToken: true, ...over
});
const ALL_SCOPES = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"] as const;
const halfOf = (over: Partial<ReadingHalf> = {}) => ({
  row: installationRow(),
  reading: {
    state: "ready", scopes: [...ALL_SCOPES], installedAt: "2026-11-01T15:00:00.000Z", revokedAt: null, revokeReason: null,
    discoveredAt: "2026-11-01T15:05:00.000Z", purgedAt: null, lastErrorCode: null, lastErrorAt: null, hasToken: true, ...over
  } as ReadingHalf
});
const snapshot = (over: Partial<ExecSettings> = {}) => ({
  settings: settings({ slackReadingSchemaReady: true, slackReadingEnabled: true, slackDailyCapUsd: 2, watchMode: "member_only", retentionDaysSlack: 60, dailyCostCapUsd: 15, ...over }),
  version: VERSION
});
function channelRow(over: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channelId: "C0GENERAL", installationId: ESI, convType: "channel", class: "standard", denyReason: null, hubKind: null, financeName: false,
    watchState: "watched", muteSource: null, watchSetByOwnerAt: null, name: "general", imUserId: null, isMember: true, isPrivate: false,
    isExtShared: false, extEver: false, isArchived: false, histWatermarkTs: null, deepSweptAt: null, sweptAt: null, lastEventTs: null,
    lastActivityTs: null, activity30d: null, probedAt: null, classifiedAt: "2026-11-01T15:05:00.000Z", leftAt: null,
    updatedAt: "2026-11-01T15:05:00.000Z", ...over
  };
}
const COUNTS = {
  byWatch: { watched: 4, muted: 2, unwatched: 7 },
  denyByReason: { fb_list: 3, lead_name: 2, bot_im: 5, self_dm: 1 },
  hubs: 2,
  dms: { watched: 11, total: 12 },
  groupDms: { watched: 3, total: 4 }
};

let out: ReturnType<typeof captureConsole>;
let refresh: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  refresh = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ refresh } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(slackReadingSchemaReady).mockResolvedValue(true);
  vi.mocked(getReadingHalf).mockResolvedValue(halfOf());
  vi.mocked(lastReadingEventAt).mockResolvedValue("2026-11-06T14:40:00.000Z");
  vi.mocked(loadSettingsSnapshot).mockResolvedValue(snapshot());
  vi.mocked(countChannels).mockResolvedValue(structuredClone(COUNTS));
  vi.mocked(listPickerChannels).mockResolvedValue([]);
  vi.mocked(countPendingTriage).mockResolvedValue(3);
  vi.mocked(countOpenItems).mockResolvedValue(5);
  vi.mocked(lastSweepAt).mockResolvedValue("2026-11-06T14:30:00.000Z");
  vi.mocked(featureSpentTodayUsd).mockResolvedValue(0.42);
  out = captureConsole();
});
afterEach(() => {
  // §0.3 rule 4: channel names live in the view (Settings shows them) but never in a log line.
  assertNoSlackText(out.calls(), { label: "console" });
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const section = (view: SlackReadingView, props: Partial<Parameters<typeof SlackReadingSection>[0]> = {}) =>
  renderToStaticMarkup(createElement(SlackReadingSection, { view, tz: TZ, now: NOW, ...props }));
const picker = (view: Partial<SlackReadingView>, props: Partial<Parameters<typeof SlackChannelPicker>[0]> = {}) =>
  renderToStaticMarkup(createElement(SlackChannelPicker, { view: slackReadingView({ state: "paused", ...view }), ...props }));
const buttons = (html: string) => (html.match(/<button/g) ?? []).length;
const inputs = (html: string) => (html.match(/<input/g) ?? []).length;
const ON_VIEW = slackReadingView({
  state: "on", switchOn: true, settingsVersion: VERSION, installationId: ESI, scopes: [...ALL_SCOPES], dmsGranted: true, groupDmsGranted: true,
  consentedAt: "2026-11-01T15:00:00.000Z", discoveredAt: "2026-11-01T15:05:00.000Z", counts: { watched: 4, muted: 2, unwatched: 7, never: 11,
    neverByReason: { fb_list: 3, lead_name: 2, bot_im: 5, self_dm: 1 }, hubs: 2, dms: { watched: 11, total: 12 }, groupDms: { watched: 3, total: 4 } },
  channels: [
    pickerRow({ channelId: "C0OUT", name: "dd-outbound", class: "hub", canChange: false }),
    pickerRow({ channelId: "C0GENERAL", name: "general", activity30d: 42 }),
    pickerRow({ channelId: "G0LEAD", name: "leadership", kind: "private" }),
    pickerRow({ channelId: "C0FIN", name: "finance-team", class: "finance", financeName: true, watchState: "muted", muteSource: "default_finance" }),
    pickerRow({ channelId: "C0ACME", name: "acme-shared", class: "external", watchState: "muted", muteSource: "owner" }),
    pickerRow({ channelId: "C0PAY", name: "acme-payroll", class: "external", financeName: true, watchState: "muted", muteSource: "default_finance" }),
    pickerRow({ channelId: "C0RAND", name: "random", watchState: "unwatched", isMember: false, activity30d: 3 }),
    pickerRow({ channelId: "G0OLD", name: "old-private", kind: "private", watchState: "unwatched", isMember: false, canChange: false }),
    pickerRow({ channelId: "C0NEW", name: "", class: "unclassified", watchState: "unwatched", canChange: false })
  ],
  lastEventAt: "2026-11-06T14:40:00.000Z", lastSweepAt: "2026-11-06T14:30:00.000Z", pendingTriage: 3, openItems: 5, capUsd: 2, effectiveCapUsd: 2,
  spentTodayUsd: 0.42, retentionDaysSlack: 60
});
const PAUSED_VIEW = slackReadingView({ ...ON_VIEW, state: "paused", switchOn: false });

// ---------------------------------------------------------------------------
// getSlackReadingView (§3.16)
// ---------------------------------------------------------------------------

describe("getSlackReadingView (§3.16)", () => {
  it("SU01 every state, in §3.16's order", async () => {
    vi.mocked(slackReadingSchemaReady).mockResolvedValueOnce(false);
    expect(await getSlackReadingView(P, NOW_DATE)).toEqual(slackReadingView({ state: "not_installed", effectiveCapUsd: effectiveSlackCapUsd(DEFAULT_SETTINGS) }));
    vi.mocked(getReadingHalf).mockResolvedValueOnce(null);
    expect((await getSlackReadingView(P, NOW_DATE)).state).toBe("bot_not_connected");
    // The settings' "slack" group missing is not installed too (nothing reading-side can be set).
    vi.mocked(loadSettingsSnapshot).mockResolvedValueOnce(snapshot({ slackReadingSchemaReady: false }));
    expect((await getSlackReadingView(P, NOW_DATE)).state).toBe("not_installed");
    const cases: [Partial<ReadingHalf>, boolean, SlackReadingView["state"]][] = [
      [{ state: "none", scopes: [], installedAt: null, discoveredAt: null, hasToken: false }, true, "not_consented"],
      [{ state: "revoked", revokedAt: "2026-11-05T18:00:00.000Z", revokeReason: "stopped", hasToken: false, discoveredAt: null }, true, "revoked"],
      [{ state: "revoked", revokedAt: "2026-11-05T18:00:00.000Z", revokeReason: "stopped", lastErrorCode: "revoke_failed", hasToken: false }, true, "revoked"],
      [{ lastErrorCode: "invalid_auth", lastErrorAt: "2026-11-06T13:00:00.000Z" }, true, "error"],
      [{ state: "discovering", discoveredAt: null }, true, "discovering"],
      [{}, false, "paused"],
      [{}, true, "on"]
    ];
    for (const [reading, on, want] of cases) {
      vi.mocked(getReadingHalf).mockResolvedValueOnce(halfOf(reading));
      vi.mocked(loadSettingsSnapshot).mockResolvedValueOnce(snapshot({ slackReadingEnabled: on }));
      expect((await getSlackReadingView(P, NOW_DATE)).state, JSON.stringify(reading)).toBe(want);
    }
    expect(readingViewState({ state: "ready", lastErrorCode: null, discoveredAt: "x" }, true)).toBe("on");
  });

  it("SU01 the on view: the half's facts, the settings and their version, the counts, the rows, the status figures, today's spend", async () => {
    vi.mocked(listPickerChannels).mockResolvedValue([channelRow({ lastActivityTs: "1794150000.000100", activity30d: 12, name: S.channelName })]);
    const view = await getSlackReadingView(P, NOW_DATE);
    expect(view).toEqual({
      state: "on", switchOn: true, settingsVersion: VERSION, watchMode: "member_only", installationId: ESI, scopes: [...ALL_SCOPES],
      dmsGranted: true, groupDmsGranted: true, consentedAt: "2026-11-01T15:00:00.000Z", discoveredAt: "2026-11-01T15:05:00.000Z",
      revokedAt: null, revokeReason: null, lastErrorCode: null,
      counts: { watched: 4, muted: 2, unwatched: 7, never: 11, neverByReason: { fb_list: 3, lead_name: 2, bot_im: 5, self_dm: 1 }, hubs: 2,
        dms: { watched: 11, total: 12 }, groupDms: { watched: 3, total: 4 } },
      channels: [pickerRow({ channelId: "C0GENERAL", name: S.channelName, activity30d: 12, lastActivityAt: "2026-11-08T15:00:00.000Z", version: "2026-11-01T15:05:00.000Z" })],
      lastEventAt: "2026-11-06T14:40:00.000Z", lastSweepAt: "2026-11-06T14:30:00.000Z", pendingTriage: 3, openItems: 5,
      capUsd: 2, effectiveCapUsd: 2, spentTodayUsd: 0.42, retentionDaysSlack: 60
    });
    expect(featureSpentTodayUsd).toHaveBeenCalledWith("ep_owner", P.timezone, SLACK_CAP_FEATURES, NOW_DATE, { signal: undefined });
    expect(listPickerChannels).toHaveBeenCalledWith(P, 1000);
    // Without the optional DM scopes, the two summary flags say so; a $10 cap under a $15 daily budget applies as $3 (C17).
    vi.mocked(getReadingHalf).mockResolvedValueOnce(halfOf({ scopes: ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:read"] }));
    vi.mocked(loadSettingsSnapshot).mockResolvedValueOnce(snapshot({ slackDailyCapUsd: 10 }));
    expect(await getSlackReadingView(P, NOW_DATE)).toMatchObject({ dmsGranted: false, groupDmsGranted: false, capUsd: 10, effectiveCapUsd: 3 });
  });

  it("SU02 counts: never = the sum by reason (counts only, never names); DMs and group DMs as watched / total; what each state reads", async () => {
    vi.mocked(countChannels).mockResolvedValueOnce({ byWatch: { watched: 1, muted: 0, unwatched: 0 }, denyByReason: { assistant_dm: 1, dd_bot_dm: 0 }, hubs: 0, dms: { watched: 0, total: 2 }, groupDms: { watched: 0, total: 0 } });
    expect((await getSlackReadingView(P, NOW_DATE)).counts).toEqual({ watched: 1, muted: 0, unwatched: 0, never: 1, neverByReason: { assistant_dm: 1 }, hubs: 0, dms: { watched: 0, total: 2 }, groupDms: { watched: 0, total: 0 } });
    // discovering: counts and status, no picker rows and no spend read.
    vi.mocked(getReadingHalf).mockResolvedValueOnce(halfOf({ state: "discovering", discoveredAt: null }));
    vi.mocked(listPickerChannels).mockClear();
    vi.mocked(featureSpentTodayUsd).mockClear();
    const d = await getSlackReadingView(P, NOW_DATE);
    expect(d).toMatchObject({ state: "discovering", channels: [], spentTodayUsd: null, counts: { never: 11 } });
    expect(listPickerChannels).not.toHaveBeenCalled();
    expect(featureSpentTodayUsd).not.toHaveBeenCalled();
    // not_consented and revoked read nothing past the settings.
    vi.mocked(countChannels).mockClear();
    vi.mocked(getReadingHalf).mockResolvedValueOnce(halfOf({ state: "none", hasToken: false, discoveredAt: null, scopes: [] }));
    expect(await getSlackReadingView(P, NOW_DATE)).toMatchObject({ state: "not_consented", retentionDaysSlack: 60, counts: { watched: 0, never: 0 } });
    expect(countChannels).not.toHaveBeenCalled();
  });

  it("SU03 picker rows: watched, then muted, then unwatched, each by name; at most 1,000; a deny or DM row is never a picker row", async () => {
    const rows = [
      channelRow({ channelId: "C0Z", name: "zeta", watchState: "unwatched" }),
      channelRow({ channelId: "C0B", name: "Beta", watchState: "muted", muteSource: "owner" }),
      channelRow({ channelId: "C0A", name: "alpha", watchState: "unwatched" }),
      channelRow({ channelId: "C0C", name: "charlie" }),
      channelRow({ channelId: "C0D", name: "alpha", watchState: "unwatched" }),
      channelRow({ channelId: "D0X", convType: "im", name: null }),
      channelRow({ channelId: "C0X", class: "deny", denyReason: "fb_list", name: null, watchState: "unwatched" })
    ];
    vi.mocked(listPickerChannels).mockResolvedValueOnce(rows);
    const view = await getSlackReadingView(P, NOW_DATE);
    expect(view.channels.map((r) => r.channelId)).toEqual(["C0C", "C0B", "C0A", "C0D", "C0Z"]);
    const many = Array.from({ length: 1005 }, (_, i) => pickerRow({ channelId: `C0${String(i).padStart(5, "0")}`, name: `c${String(i).padStart(5, "0")}`, watchState: i % 2 ? "muted" : "watched" }));
    const ordered = orderPickerRows(many);
    expect(ordered).toHaveLength(1000);
    expect(ordered[0].watchState).toBe("watched");
    expect(ordered.at(-1)?.watchState).toBe("muted");
    expect(pickerRowFromChannel(rows[5])).toBeNull();
    expect(pickerRowFromChannel(rows[6])).toBeNull();
    expect(pickerRowFromChannel(channelRow({ convType: "group", isPrivate: false, lastActivityTs: "bogus" }))).toMatchObject({ kind: "private", lastActivityAt: null });
    expect(pickerRowFromChannel(channelRow({ name: null }))).toMatchObject({ name: "" });
  });

  it("SU04 canChange: false for a hub, an unclassified conversation and a private conversation he left; a public one he left can change", () => {
    const can = (over: Partial<ChannelRow>) => pickerRowFromChannel(channelRow(over))?.canChange;
    expect(can({})).toBe(true);
    expect(can({ class: "finance", financeName: true })).toBe(true);
    expect(can({ class: "external" })).toBe(true);
    expect(can({ class: "hub", hubKind: "outbound" })).toBe(false);
    expect(can({ class: "unclassified", name: null })).toBe(false);
    expect(can({ isPrivate: true, leftAt: "2026-11-05T00:00:00.000Z" })).toBe(false);
    expect(can({ convType: "group", leftAt: "2026-11-05T00:00:00.000Z" })).toBe(false);
    expect(can({ leftAt: "2026-11-05T00:00:00.000Z" })).toBe(true);
  });

  it("SU05 (fixer ui-3) fail soft: a failed read is state error with readFailed and no error code (the installation id kept), logged by id and code only; a missing P7a piece is not_installed", async () => {
    vi.mocked(countChannels).mockRejectedValueOnce(new SlackReadStoreError("countChannels", "57014"));
    expect(await getSlackReadingView(P, NOW_DATE)).toEqual({ ...slackReadingView({ state: "error", lastErrorCode: null, installationId: ESI }), readFailed: true });
    vi.mocked(slackReadingSchemaReady).mockRejectedValueOnce(new TypeError(`bad ${S.text}`));
    expect(await getSlackReadingView(P, NOW_DATE)).toEqual({ ...slackReadingView({ state: "error", lastErrorCode: null }), readFailed: true });
    const lines = out.calls().map((c) => String(c[0]));
    expect(lines).toEqual([
      "[exec-slack] reading view read failed for ep_owner (countChannels, 57014)",
      "[exec-slack] reading view read failed for ep_owner (TypeError)"
    ]);
    // A missing column / table / function → not_installed, silently.
    vi.mocked(getReadingHalf).mockRejectedValueOnce(new SlackStoreError("getReadingHalf", "42703"));
    expect((await getSlackReadingView(P, NOW_DATE)).state).toBe("not_installed");
    vi.mocked(listPickerChannels).mockRejectedValueOnce(new SlackReadStoreError("listPickerChannels", "PGRST205"));
    expect((await getSlackReadingView(P, NOW_DATE)).state).toBe("not_installed");
    expect(out.calls()).toHaveLength(2);
    // The spend alone failing: the line says it couldn't be read; the rest of the view stands.
    vi.mocked(featureSpentTodayUsd).mockRejectedValueOnce(new Error("exec_ai_usage read failed (57014)"));
    expect(await getSlackReadingView(P, NOW_DATE)).toMatchObject({ state: "on", spentTodayUsd: null, openItems: 5 });
    expect(String(out.calls().at(-1)?.[0])).toBe("[exec-slack] reading spend not read for ep_owner (Error)");
  });

  it("SU15 getSlackSettingsView carries the reading half once P6's reads succeeded (signal and now passed); a failed P6 read carries none", async () => {
    vi.mocked(slackSchemaReady).mockResolvedValue(true);
    vi.mocked(getActiveInstallation).mockResolvedValue(installationRow());
    vi.mocked(getLatestInstallation).mockResolvedValue(null);
    const signal = new AbortController().signal;
    const view = await getSlackSettingsView(P, { signal, now: NOW_DATE });
    expect(view.state).toBe("connected");
    expect(view.reading?.state).toBe("on");
    expect(vi.mocked(slackReadingSchemaReady).mock.calls[0][0]).toEqual({ signal });
    expect(vi.mocked(featureSpentTodayUsd).mock.calls[0][3]).toEqual(NOW_DATE);
    vi.mocked(getActiveInstallation).mockRejectedValueOnce(new SlackStoreError("getActiveInstallation", "XX000"));
    const failed = await getSlackSettingsView(P, { now: NOW_DATE });
    expect(failed).toMatchObject({ readFailed: true, state: "not_connected" });
    expect(failed.reading).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The section, by state (§3.16's table; exact copy)
// ---------------------------------------------------------------------------

describe("SlackReadingSection: every state's words (§3.16, §3.17)", () => {
  it("SU06 not_installed, bot_not_connected, discovering", () => {
    const ni = section(slackReadingView());
    expect(textOf(ni)).toBe(`${SLACK_READ_COPY.readingHeading} ${SLACK_READ_COPY.readingNotInstalled}`);
    expect(buttons(ni) + inputs(ni)).toBe(0);
    expect(section(slackReadingView({ state: "bot_not_connected" }))).toBe("");
    const disc = section(slackReadingView({ state: "discovering", installationId: ESI, counts: ON_VIEW.counts }));
    // 4 + 2 + 7 watched / muted / unwatched, 11 never read, 2 hubs, 12 DMs, 4 group DMs; only Stop reading to click.
    expect(textOf(disc)).toBe(`${SLACK_READ_COPY.readingHeading} ${SLACK_READ_COPY.discovering} ${fill(SLACK_READ_COPY.discoveringCount, { n: 42 })} ${SLACK_READ_COPY.stopReading}`);
    expect(buttons(disc)).toBe(1);
    expect(disc).toContain("data-reading-stop");
    expect(inputs(disc)).toBe(0);
    expect(disc).not.toContain("data-picker");
  });

  it("SU06 not_consented: the intro, the four 'what it reads' lines, the notice with his retention, and the Allow link (off the canonical host: P6's wrong-host line)", () => {
    const view = slackReadingView({ state: "not_consented", installationId: ESI, retentionDaysSlack: 60 });
    const html = section(view);
    const text = textOf(html);
    expect(text).toContain(SLACK_READ_COPY.readingIntro);
    for (const line of SLACK_READ_COPY.readingWhat) expect(textOf(html.replace(/&quot;/g, '"'))).toContain(line);
    expect(text).toContain(fill(SLACK_READ_COPY.readingNotice, { days: 60 }));
    expect(html).toContain(`href="${SLACK_READ_START_PATH}"`);
    expect(SLACK_READ_START_PATH).toBe("/api/integrations/exec-slack/start?purpose=read");
    expect(text).toContain(SLACK_READ_COPY.allowReading);
    expect(html).not.toContain("data-reading-stop");
    expect(html).not.toContain("data-reading-switch");
    const off = section(view, { onCanonicalHost: false });
    expect(off).not.toContain(SLACK_READ_START_PATH);
    expect(textOf(off)).toContain(SLACK_COPY.settingsWrongHost);
  });

  it("SU06 / SU17 paused: paused, the checklist's five items exactly, the switch (off), the budget, the retention, Stop reading, the picker", () => {
    const html = section(PAUSED_VIEW);
    const text = textOf(html);
    expect(text).toContain(SLACK_READ_COPY.paused);
    expect(text).toContain(SLACK_READ_COPY.checklistTitle);
    const items = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => textOf(m[1]));
    for (const line of SLACK_READ_COPY.checklist) expect(items).toContain(line);
    expect(SLACK_READ_COPY.checklist).toHaveLength(5);
    expect(SLACK_READ_COPY.checklist[0]).toContain("BAA/DPA");
    expect(SLACK_READ_COPY.checklist[4]).toBe("The team ran the pre-enable live checks, including a test lead channel that stays unread.");
    // The checklist sits above the switch (N20).
    expect(html.indexOf("data-reading-checklist")).toBeLessThan(html.indexOf("data-reading-switch"));
    expect(html).toContain('data-reading-switch="off"');
    expect(text).toContain(SLACK_READ_COPY.fieldReadingLabel);
    expect(text).toContain(SLACK_READ_COPY.fieldCapLabel);
    expect(text).toContain(SLACK_READ_COPY.fieldRetentionLabel);
    expect(text).toContain(SLACK_READ_COPY.stopReading);
    expect(html).toContain("data-picker");
    expect(html).not.toContain("data-reading-status");
    expect(html).not.toContain("data-reading-allow");
  });

  it("SU06 on: the five status rows (his zone, today's spend against the cap that applies), the switch on, the picker, Stop", () => {
    const html = section(ON_VIEW);
    const rows = [...html.matchAll(/data-reading-status-row="[a-z]+"[^>]*>([^<]*)</g)].map((m) => plain(textOf(m[1])));
    expect(rows).toEqual([
      fill(SLACK_READ_COPY.statusLastEvent, { time: plain(formatInZone("2026-11-06T14:40:00.000Z", TZ, "datetime", NOW)) }),
      fill(SLACK_READ_COPY.statusLastSweep, { time: plain(formatInZone("2026-11-06T14:30:00.000Z", TZ, "datetime", NOW)) }),
      fill(SLACK_READ_COPY.statusPending, { n: 3 }),
      fill(SLACK_READ_COPY.statusOpen, { n: 5 }),
      "Today: $0.42 of $2.00"
    ]);
    expect(html).toContain('data-reading-switch="on"');
    expect(html).toContain("data-picker");
    expect(textOf(html)).toContain(SLACK_READ_COPY.stopReading);
    expect(html).not.toContain("data-reading-checklist");
    // Nothing yet and an unreadable spend.
    const fresh = readingStatusLines({ ...ON_VIEW, lastEventAt: null, lastSweepAt: null, spentTodayUsd: null }, TZ, NOW).map((l) => l.text);
    expect(fresh[0]).toBe(fill(SLACK_READ_COPY.statusLastEvent, { time: SLACK_READ_COPY.none }));
    expect(fresh[1]).toBe(fill(SLACK_READ_COPY.statusLastSweep, { time: SLACK_READ_COPY.none }));
    expect(readingSpendText({ spentTodayUsd: null, effectiveCapUsd: 1.5 })).toBe("Today: — of $1.50");
  });

  it("SU06 revoked: the date in his zone and the reason's label, every reason; revoke_failed adds stopRevokeFailed (C47); then Allow again", () => {
    for (const [reason, label] of Object.entries(SLACK_READ_COPY.revokeReasons)) {
      const view = slackReadingView({ state: "revoked", installationId: ESI, revokedAt: "2026-11-05T18:00:00.000Z", revokeReason: reason as SlackReadingView["revokeReason"] });
      const text = textOf(section(view));
      expect(text).toContain(fill(SLACK_READ_COPY.revoked, { date: plain(formatInZone("2026-11-05T18:00:00.000Z", TZ, "date", NOW)), reason: label }));
      expect(text).not.toContain(SLACK_READ_COPY.stopRevokeFailed);
    }
    const failed = section(slackReadingView({ state: "revoked", installationId: ESI, revokedAt: "2026-11-05T18:00:00.000Z", revokeReason: "stopped", lastErrorCode: "revoke_failed" }));
    expect(textOf(failed)).toContain(SLACK_READ_COPY.stopRevokeFailed);
    expect(failed).toContain(`href="${SLACK_READ_START_PATH}"`);
    expect(failed).not.toContain("data-reading-stop");
    expect(readingRevokedText({ revokedAt: null, revokeReason: null }, TZ, NOW)).toBe(fill(SLACK_READ_COPY.revoked, { date: "—", reason: "—" }));
  });

  it("SU06 error: the code, the Allow link (re-consent) and Stop reading; a failed read (unavailable) without an installation offers no Stop", () => {
    const html = section(slackReadingView({ state: "error", installationId: ESI, lastErrorCode: "invalid_auth" }));
    expect(textOf(html)).toContain(fill(SLACK_READ_COPY.error, { code: "invalid_auth" }));
    expect(html).toContain(`href="${SLACK_READ_START_PATH}"`);
    expect(html).toContain("data-reading-stop");
    expect(html).not.toContain("data-picker");
    const unread = section(slackReadingView({ state: "error", lastErrorCode: "unavailable" }));
    expect(textOf(unread)).toContain(fill(SLACK_READ_COPY.error, { code: "unavailable" }));
    expect(unread).not.toContain("data-reading-stop");
    expect(readingActions("error")).toEqual({ allow: true, settings: false, stop: true });
    expect(readingActions("discovering")).toEqual({ allow: false, settings: false, stop: true });
    for (const s of ["not_installed", "bot_not_connected", "not_consented", "revoked"] as const) expect(readingActions(s).stop, s).toBe(false);
  });

  it("SU07 framed: no link, no button, no input anywhere in the reading half; the values as words and the framed line", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    for (const view of [ON_VIEW, PAUSED_VIEW, slackReadingView({ state: "not_consented", installationId: ESI }), slackReadingView({ state: "error", installationId: ESI, lastErrorCode: "x" })]) {
      const html = section(view);
      expect(buttons(html), view.state).toBe(0);
      expect(inputs(html), view.state).toBe(0);
      expect(html).not.toContain("/api/integrations/exec-slack/start");
      expect(textOf(html)).toContain(SLACK_READ_COPY.framed);
    }
    const on = textOf(section(ON_VIEW));
    expect(on).toContain(`${SLACK_READ_COPY.fieldReadingLabel} On`);
    expect(on).toContain(`${SLACK_READ_COPY.fieldCapLabel} $2.00`);
    expect(on).toContain(`${SLACK_READ_COPY.fieldRetentionLabel} 60 days`);
    expect(on).toContain(SLACK_READ_COPY.watchModeMember);
  });
});

// ---------------------------------------------------------------------------
// The controls: the enable confirm, Stop, the settings (§3.16, N20, C47)
// ---------------------------------------------------------------------------

describe("SlackReadingControls (§3.16)", () => {
  it("SU08 / SU17 the enable confirm: title, body, the required checkbox attesting to the checklist; Turn on disabled until it is ticked", () => {
    const html = renderToStaticMarkup(createElement(SlackReadingControls, { view: PAUSED_VIEW, initialDialog: "enable" }));
    const confirm = /<div[^>]*data-reading-enable-confirm[^]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";
    const text = textOf(confirm);
    expect(text).toContain(SLACK_READ_COPY.enableConfirmTitle);
    expect(text).toContain(SLACK_READ_COPY.enableConfirmBody);
    expect(text).toContain(SLACK_READ_COPY.enableConfirmCheck);
    expect(SLACK_READ_COPY.enableConfirmCheck).toBe("The checklist above is done.");
    expect(confirm).toMatch(/<input[^>]*type="checkbox"[^>]*required/);
    expect(confirm).toMatch(/<button[^>]*data-reading-enable-turn-on[^>]*disabled=""[^>]*>Turn on<\/button>/);
    expect(textOf(confirm)).toContain("Cancel");
    const ticked = renderToStaticMarkup(createElement(SlackReadingControls, { view: PAUSED_VIEW, initialDialog: "enable", initialChecked: true }));
    expect(ticked).toMatch(/<button[^>]*data-reading-enable-turn-on(?![^>]*disabled="")[^>]*>Turn on<\/button>/);
    // The switch is disabled while the confirm is open.
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
  });

  it("SU08 turning on sends P5a's PATCH with confirm slack_reading_notice and the page's version, then refreshes; a conflict refreshes and says so", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { settings: settingsView({ version: "v2" }) }));
    vi.stubGlobal("fetch", f);
    const r1 = vi.fn();
    expect(await enableReadingThenRefresh(VERSION, r1)).toEqual({ message: null, version: "v2" });
    expect(r1).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/exec/settings");
    expect(init).toMatchObject({ method: "PATCH", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({ patch: { slackReadingEnabled: true }, expectedVersion: VERSION, confirm: "slack_reading_notice" });
    const r2 = vi.fn();
    const conflict = vi.fn(async () => ({ kind: "conflict" as const, view: settingsView({ version: "v3" }), message: SETTINGS_COPY.conflict }));
    expect(await enableReadingThenRefresh(VERSION, r2, conflict)).toEqual({ message: SETTINGS_COPY.conflict, version: "v3" });
    expect(r2).toHaveBeenCalledTimes(1);
    const r3 = vi.fn();
    const refused = vi.fn(async () => ({ kind: "failed" as const, status: 400, message: SETTINGS_COPY.confirmFirst }));
    expect(await enableReadingThenRefresh(VERSION, r3, refused)).toEqual({ message: SETTINGS_COPY.confirmFirst, version: VERSION });
    expect(r3).not.toHaveBeenCalled();
    // patchSettings sends either confirmation, never any other value.
    const g = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { settings: settingsView() }));
    await patchSettings({ patch: { ddtextEnabled: true }, expectedVersion: null, confirm: "ddtext_notice" }, g);
    await patchSettings({ patch: { slackReadingEnabled: true }, expectedVersion: null, confirm: "bogus" as never }, g);
    expect(JSON.parse(String(g.mock.calls[0][1]?.body)).confirm).toBe("ddtext_notice");
    expect(JSON.parse(String(g.mock.calls[1][1]?.body))).not.toHaveProperty("confirm");
  });

  it("SU08 the switch off, the budget and the retention save on their own (no confirmation), validated by P5a's registry first", async () => {
    expect(READING_FIELDS.map((d) => d.key)).toEqual(["slackReadingEnabled", "slackDailyCapUsd", "retentionDaysSlack"]);
    const patch = vi.fn(async (_b: Parameters<typeof patchSettings>[0]) => ({ kind: "saved" as const, view: settingsView({ version: "v9" }), message: SETTINGS_COPY.saved }));
    const r = vi.fn();
    const [sw, cap, ret] = READING_FIELDS;
    expect(await saveReadingSetting(sw, false, VERSION, r, patch)).toEqual({ ok: true, message: SETTINGS_COPY.saved, version: "v9" });
    expect(patch.mock.calls[0][0]).toEqual({ patch: { slackReadingEnabled: false }, expectedVersion: VERSION });
    expect(await saveReadingSetting(cap, 5, VERSION, r, patch)).toMatchObject({ ok: true });
    expect(patch.mock.calls[1][0]).toEqual({ patch: { slackDailyCapUsd: 5 }, expectedVersion: VERSION });
    const bad = await saveReadingSetting(ret, 3, VERSION, r, patch);
    expect(bad.ok).toBe(false);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(r).toHaveBeenCalledTimes(2);
  });

  it("SU09 Stop reading: the confirm's words and buttons; POST { installationId, confirm: stop_reading }; revoke_failed → stopRevokeFailed; failures → stopFailed", async () => {
    const html = renderToStaticMarkup(createElement(SlackReadingControls, { view: ON_VIEW, initialDialog: "stop" }));
    const confirm = /<div[^>]*data-reading-stop-confirm[^]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";
    expect(textOf(confirm)).toBe(`${SLACK_READ_COPY.stopTitle} ${SLACK_READ_COPY.stopBody} Stop reading Cancel`);
    // While it is open the Stop button itself is hidden.
    expect(html).not.toMatch(/<button[^>]*data-reading-stop(?!-)/);
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { slack: slackSettingsView() }));
    expect(await stopReading(ESI, f)).toEqual({ kind: "stopped", warning: null });
    expect(f.mock.calls[0][0]).toBe(SLACK_STOP_READING_PATH);
    expect(SLACK_STOP_READING_PATH).toBe("/api/exec/slack/reading/stop");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ installationId: ESI, confirm: "stop_reading" });
    expect(await stopReading(ESI, async () => json(200, { slack: slackSettingsView(), warning: "revoke_failed" }))).toEqual({ kind: "stopped", warning: "revoke_failed" });
    for (const [status, body] of [[404, { error: "not_found" }], [409, { error: "not_installed" }], [503, { error: "unavailable" }], [403, { error: "forbidden" }], [500, "x"]] as const) {
      expect(await stopReading(ESI, async () => json(status, body))).toEqual({ kind: "failed", status, message: SLACK_READ_COPY.stopFailed });
    }
    expect(await stopReading(ESI, async () => json(429, { error: "rate_limited", retryAfterSeconds: 30 }))).toMatchObject({ kind: "failed", status: 429 });
    expect(await stopReading(ESI, async () => { throw new TypeError("fetch failed"); })).toEqual({ kind: "failed", status: 0, message: SLACK_READ_COPY.stopFailed });
    const nofetch = vi.fn();
    expect(await stopReading("not-an-id", nofetch as never)).toMatchObject({ kind: "failed" });
    expect(nofetch).not.toHaveBeenCalled();
    // The confirmed flow.
    const r1 = vi.fn();
    expect(await stopReadingThenRefresh(ESI, r1, async () => ({ kind: "stopped", warning: null }))).toEqual({ message: null, tone: null });
    expect(r1).toHaveBeenCalledTimes(1);
    const r2 = vi.fn();
    expect(await stopReadingThenRefresh(ESI, r2, async () => ({ kind: "stopped", warning: "revoke_failed" }))).toEqual({ message: SLACK_READ_COPY.stopRevokeFailed, tone: "warning" });
    expect(r2).toHaveBeenCalledTimes(1);
    const r3 = vi.fn();
    expect(await stopReadingThenRefresh(ESI, r3, async () => ({ kind: "failed", status: 503, message: SLACK_READ_COPY.stopFailed }))).toEqual({ message: SLACK_READ_COPY.stopFailed, tone: "error" });
    expect(r3).not.toHaveBeenCalled();
    expect(readingConfirmKeyAction("Escape", false)).toBe("close");
    expect(readingConfirmKeyAction("Escape", true)).toBeNull();
    expect(readingConfirmKeyAction("Enter", false)).toBeNull();
  });

  it("SU09b Disconnect's reading half (C47): 200 warning → disconnectRevokeFailed and nothing more; 503 with the view → disconnectHalf and a refresh", async () => {
    expect(await disconnectSlack(ESI, async () => json(200, { slack: slackSettingsView(), warning: "revoke_failed" }))).toEqual({ kind: "disconnected", message: SLACK_READ_COPY.disconnectRevokeFailed });
    expect(await disconnectSlack(ESI, async () => json(503, { error: "slack_unavailable", slack: slackSettingsView() }))).toEqual({ kind: "failed", status: 503, message: SLACK_READ_COPY.disconnectHalf, readingStopped: true });
    expect(await disconnectSlack(ESI, async () => json(503, { error: "slack_unavailable" }))).toEqual({ kind: "failed", status: 503, message: SLACK_COPY.disconnectSlackDown });
    const r1 = vi.fn();
    expect(await disconnectOutcome(ESI, r1, async () => ({ kind: "disconnected", message: SLACK_READ_COPY.disconnectRevokeFailed }))).toEqual({ message: SLACK_READ_COPY.disconnectRevokeFailed, done: true });
    expect(r1).not.toHaveBeenCalled();
    const r2 = vi.fn();
    expect(await disconnectOutcome(ESI, r2, async () => ({ kind: "failed", status: 503, message: SLACK_READ_COPY.disconnectHalf, readingStopped: true }))).toEqual({ message: SLACK_READ_COPY.disconnectHalf, done: false });
    expect(r2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The picker (C29, C10, N11, N12)
// ---------------------------------------------------------------------------

describe("SlackChannelPicker (§3.16, C29)", () => {
  it("SU14 the summary rows, the never-read counts by reason (merged labels, never names), hubs with their badge and no control", () => {
    const html = picker(ON_VIEW);
    expect(textOf(/<li data-picker-dms[^]*?<\/li>/.exec(html)?.[0] ?? "")).toBe(fill(SLACK_READ_COPY.pickerDms, { watched: 11, total: 12 }));
    expect(textOf(/<li data-picker-group-dms[^]*?<\/li>/.exec(html)?.[0] ?? "")).toBe(fill(SLACK_READ_COPY.pickerGroupDms, { watched: 3, total: 4 }));
    expect(textOf(html)).toContain(fill(SLACK_READ_COPY.pickerNever, { n: 11 }));
    expect(neverReasonLines(ON_VIEW.counts.neverByReason)).toEqual([
      { label: SLACK_READ_COPY.neverReasons.self_dm, n: 1 },
      { label: SLACK_READ_COPY.neverReasons.bot_im, n: 5 },
      { label: SLACK_READ_COPY.neverReasons.fb_list, n: 5 }
    ]);
    const reasons = [...html.matchAll(/<li data-picker-never-reason[^>]*>([^<]*)</g)].map((m) => textOf(m[1]));
    expect(reasons).toEqual(["notes to yourself: 1", "bots and apps: 5", "lead channels: 5"]);
    const hub = /<li data-picker-hub="C0OUT"[^]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(textOf(hub)).toContain(SLACK_READ_COPY.badgeHub);
    expect(hub).not.toContain("<button");
    expect(html).not.toContain('data-picker-row="C0OUT"');
  });

  it("SU14 rows: #name and badges, activity, the three-way control; no control on a row that can't change; an id-only row shows its id", () => {
    const html = picker(ON_VIEW);
    const row = (id: string) => /<li data-picker-row="[^"]*"[^]*?<\/li>/g.exec(html.slice(html.indexOf(`data-picker-row="${id}"`) - 4))?.[0] ?? "";
    const general = row("C0GENERAL");
    expect(textOf(general)).toContain("general");
    expect(textOf(general)).toContain(fill(SLACK_READ_COPY.activity, { n: 42 }));
    expect([...general.matchAll(/data-picker-choice="([a-z]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], textOf(m[2])])).toEqual([
      ["watched", SLACK_READ_COPY.watchLabel], ["muted", SLACK_READ_COPY.muteLabel], ["unwatched", SLACK_READ_COPY.unwatchLabel]
    ]);
    expect(general).toMatch(/role="radio" aria-checked="true" tabindex="0" data-picker-choice="watched"/);
    // Fixer ui-9: one tab stop per row (the checked option; the arrows move between the three).
    expect([...general.matchAll(/tabindex="(-?[0-9])" data-picker-choice="([a-z]+)"/g)].map((m) => [m[2], m[1]])).toEqual([["watched", "0"], ["muted", "-1"], ["unwatched", "-1"]]);
    expect(textOf(row("G0LEAD"))).toContain(SLACK_READ_COPY.badgePrivate);
    expect(textOf(row("C0ACME"))).toContain(SLACK_READ_COPY.badgeExternal);
    expect(textOf(row("C0FIN"))).toContain(SLACK_READ_COPY.badgeFinance);
    const pay = textOf(row("C0PAY"));
    expect(pay).toContain(SLACK_READ_COPY.badgeExternal);
    expect(pay).toContain(SLACK_READ_COPY.badgeFinance);
    expect(textOf(row("C0RAND"))).toContain(SLACK_READ_COPY.badgeNotMember);
    expect(row("G0OLD")).not.toContain("data-picker-choice");
    expect(textOf(row("G0OLD"))).toContain(SLACK_READ_COPY.unwatchLabel);
    expect(row("C0NEW")).not.toContain("data-picker-choice");
    expect(textOf(row("C0NEW"))).toContain("C0NEW");
    expect(channelLabel(pickerRow({ name: "", channelId: "C0NEW" }))).toBe("C0NEW");
    expect(channelLabel(pickerRow({ name: "general" }))).toBe("#general");
    expect(pickerBadges(pickerRow({ class: "external", kind: "private", financeName: true, isMember: false }))).toEqual([
      SLACK_READ_COPY.badgePrivate, SLACK_READ_COPY.badgeExternal, SLACK_READ_COPY.badgeFinance, SLACK_READ_COPY.badgeNotMember
    ]);
    expect(WATCH_CHOICES.map((c) => c.state)).toEqual(["watched", "muted", "unwatched"]);
  });

  it("SU14 the filter (by name, case-insensitive, a leading # ignored) and the watch mode (both choices, the help line)", () => {
    expect(filterPickerRows(ON_VIEW.channels, "#ACME").map((r) => r.channelId)).toEqual(["C0ACME", "C0PAY"]);
    expect(filterPickerRows(ON_VIEW.channels, "  ")).toHaveLength(ON_VIEW.channels.length);
    expect(filterPickerRows(ON_VIEW.channels, "c0new").map((r) => r.channelId)).toEqual(["C0NEW"]);
    const filtered = picker(ON_VIEW, { initialFilter: "acme" });
    expect((filtered.match(/data-picker-row=/g) ?? []).length).toBe(2);
    expect(filtered).toMatch(/<input[^>]*type="search"[^>]*placeholder="Filter channels"/);
    const html = picker(ON_VIEW);
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*data-picker-mode="member_only"[^>]*checked=""/);
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*data-picker-mode="active_public"(?![^>]*checked="")/);
    for (const s of [SLACK_READ_COPY.watchModeMember, SLACK_READ_COPY.watchModeActive, SLACK_READ_COPY.watchModeHelp]) expect(textOf(html.replace(/&#x27;/g, "'"))).toContain(s);
  });

  it("SU10 / SU17 the finance confirm: class finance or a finance-named Slack Connect row; its words exactly; Watch sends confirm finance_channel", async () => {
    expect(needsFinanceConfirm(pickerRow({ class: "finance", financeName: true, watchState: "muted" }), "watched")).toBe(true);
    expect(needsFinanceConfirm(pickerRow({ class: "external", financeName: true, watchState: "muted" }), "watched")).toBe(true);
    expect(needsFinanceConfirm(pickerRow({ class: "external", financeName: true, watchState: "muted" }), "unwatched")).toBe(false);
    expect(needsFinanceConfirm(pickerRow({ class: "external", watchState: "muted" }), "watched")).toBe(false);
    expect(needsFinanceConfirm(pickerRow({ class: "finance", financeName: true, watchState: "watched" }), "watched")).toBe(false);
    const html = picker(ON_VIEW, { initialFinanceConfirm: "C0PAY" });
    const confirm = /<div[^>]*data-finance-confirm="C0PAY"[^]*?<\/div>\s*<\/div>/.exec(html)?.[0] ?? "";
    expect(textOf(confirm)).toBe(`${SLACK_READ_COPY.financeConfirmTitle} ${SLACK_READ_COPY.financeConfirmBody} ${SLACK_READ_COPY.watchLabel} Cancel`);
    expect(SLACK_READ_COPY.financeConfirmBody).toBe("Items from this channel are shown only in DD, never in Slack or in drafts. Until you watch it, nothing in it is read, not even messages to you.");
    // While it is open, no row can be changed.
    expect(html).toMatch(/data-picker-choice="watched"[^>]*disabled=""/);
    const alone = renderToStaticMarkup(createElement(FinanceConfirm, { row: pickerRow({ channelId: "C0FIN" }), pending: false, onConfirm: () => {}, onCancel: () => {}, autoFocus: false }));
    expect(alone).toContain('data-finance-confirm="C0FIN"');
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { channel: pickerRow({ channelId: "C0PAY", watchState: "watched", class: "external", financeName: true }) }));
    expect(await setChannelWatch("C0PAY", { watchState: "watched", expectedVersion: VERSION, confirm: "finance_channel" }, f)).toMatchObject({ kind: "updated", channel: { watchState: "watched" } });
    expect(f.mock.calls[0][0]).toBe("/api/exec/slack/channels/C0PAY");
    expect(slackChannelPath("C0PAY")).toBe("/api/exec/slack/channels/C0PAY");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "PATCH", credentials: "same-origin" });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ watchState: "watched", expectedVersion: VERSION, confirm: "finance_channel" });
    await setChannelWatch("C0ACME", { watchState: "muted", expectedVersion: VERSION }, f);
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ watchState: "muted", expectedVersion: VERSION });
  });

  it("SU11 a 409 conflict re-renders the row from the answer with pickerConflict; a failure reverts it with pickerFailed; confirmation_required opens the finance confirm", async () => {
    const prior = pickerRow({ channelId: "C0ACME", watchState: "muted", muteSource: "owner" });
    const moved = withWatch([prior], "C0ACME", "watched");
    expect(moved[0]).toMatchObject({ watchState: "watched", muteSource: null });
    expect(withWatch([prior], "C0ACME", "muted")[0].muteSource).toBe("owner");
    const server = pickerRow({ channelId: "C0ACME", watchState: "unwatched", version: "2026-11-06T00:00:00.000Z" });
    expect(rowsAfterAnswer(moved, prior, { kind: "conflict", channel: server, message: SLACK_READ_COPY.pickerConflict })).toEqual({ rows: [server], message: SLACK_READ_COPY.pickerConflict, finance: false });
    expect(rowsAfterAnswer(moved, prior, { kind: "conflict", channel: null, message: SLACK_READ_COPY.pickerConflict }).rows).toEqual([prior]);
    expect(rowsAfterAnswer(moved, prior, { kind: "failed", status: 503, message: SLACK_READ_COPY.pickerFailed })).toEqual({ rows: [prior], message: SLACK_READ_COPY.pickerFailed, finance: false });
    expect(rowsAfterAnswer(moved, prior, { kind: "confirmation_required" })).toEqual({ rows: [prior], message: null, finance: true });
    expect(rowsAfterAnswer(moved, prior, { kind: "updated", channel: server }).rows).toEqual([server]);
    // The client call's answers.
    const ask = (status: number, body: unknown) => setChannelWatch("C0ACME", { watchState: "watched", expectedVersion: VERSION }, async () => json(status, body));
    expect(await ask(409, { error: "conflict", channel: server })).toEqual({ kind: "conflict", channel: server, message: SLACK_READ_COPY.pickerConflict });
    expect(await ask(409, { error: "conflict", channel: { ...server, channelId: "C0OTHER" } })).toEqual({ kind: "conflict", channel: null, message: SLACK_READ_COPY.pickerConflict });
    expect(await ask(400, { error: "confirmation_required", field: "finance_channel" })).toEqual({ kind: "confirmation_required" });
    for (const [status, body] of [[409, { error: "refused" }], [404, { error: "not_found" }], [200, { channel: { bogus: true } }], [503, { error: "unavailable" }]] as const) {
      expect(await ask(status, body)).toEqual({ kind: "failed", status, message: SLACK_READ_COPY.pickerFailed });
    }
    expect(await ask(429, { error: "rate_limited", retryAfterSeconds: 10 })).toMatchObject({ kind: "failed", status: 429 });
    expect(await setChannelWatch("D0MITCH", { watchState: "watched", expectedVersion: VERSION })).toEqual({ kind: "failed", status: 0, message: SLACK_READ_COPY.pickerFailed });
    expect(isPickerRow(server)).toBe(true);
    expect(isPickerRow({ ...server, class: "deny" })).toBe(false);
    expect(isPickerRow({ ...server, watchState: "maybe" })).toBe(false);
  });

  it("SU13 the watch mode: PUT { watchMode, expectedVersion }; saved / conflict / failed", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { slack: slackSettingsView({ state: "connected" }) }));
    expect(await setWatchMode("active_public", VERSION, f)).toMatchObject({ kind: "saved", slack: { state: "connected" } });
    expect(f.mock.calls[0][0]).toBe(SLACK_WATCH_MODE_PATH);
    expect(SLACK_WATCH_MODE_PATH).toBe("/api/exec/slack/watch-mode");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "PUT", credentials: "same-origin" });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ watchMode: "active_public", expectedVersion: VERSION });
    expect(await setWatchMode("member_only", null, async () => json(409, { error: "conflict", slack: slackSettingsView() }))).toMatchObject({ kind: "conflict", message: SETTINGS_COPY.conflict });
    expect(await setWatchMode("member_only", null, async () => json(409, { error: "not_installed" }))).toEqual({ kind: "failed", status: 409, message: SETTINGS_COPY.notInstalled });
    expect(await setWatchMode("everything" as never, null, f)).toMatchObject({ kind: "failed", status: 0 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("SU07 framed: the rows and the mode as words, no control, no filter, no radio", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    const html = picker(ON_VIEW);
    expect(buttons(html)).toBe(0);
    expect(inputs(html)).toBe(0);
    expect(textOf(html)).toContain(SLACK_READ_COPY.watchModeMember);
    expect((html.match(/data-picker-readonly/g) ?? []).length).toBe(ON_VIEW.channels.filter((r) => r.class !== "hub").length);
  });
});

// ---------------------------------------------------------------------------
// P5a's form, P6's section, the page (§3.20.2)
// ---------------------------------------------------------------------------

describe("the Settings page (§3.20.2)", () => {
  it("SU12 P5a's SettingsForm no longer renders the three section 'slack' fields; every other registry field still renders", () => {
    const slackKeys = SETTINGS_FIELDS.filter((d) => d.section === "slack").map((d) => d.key);
    expect(slackKeys.sort()).toEqual(["retentionDaysSlack", "slackDailyCapUsd", "slackReadingEnabled"]);
    const html = renderToStaticMarkup(createElement(SettingsForm, { view: settingsView({ schema: { email: true, drafts: true, ddtext: true, chat: true, slack: true }, settings: settings({ chatSchemaReady: true, slackReadingSchemaReady: true }) }) }));
    for (const key of slackKeys) expect(html).not.toContain(`data-setting="${key}"`);
    for (const def of SETTINGS_FIELDS.filter((d) => d.section !== "slack")) expect(html, def.key).toContain(`data-setting="${def.key}"`);
  });

  it("SU15 SlackSection renders the reading half below the installation rows while connected (or error); nothing for other P6 states or without a view", () => {
    const connected = slackSettingsView({ state: "connected", installationId: ESI, teamId: "T0SCALED", dmChannelId: "D0MITCH", userId: "U0MITCH", installedAt: "2026-11-01T14:30:00.000Z", reading: ON_VIEW });
    const html = renderToStaticMarkup(createElement(SlackSection, { view: connected, tz: TZ, now: NOW }));
    expect(html).toContain('data-reading-state="on"');
    expect(html.indexOf("data-slack-installation")).toBeLessThan(html.indexOf("data-slack-reading"));
    expect(renderToStaticMarkup(createElement(SlackSection, { view: { ...connected, state: "error", lastErrorCode: "invalid_auth" }, tz: TZ, now: NOW }))).toContain("data-slack-reading");
    for (const state of ["not_connected", "revoked"] as const) {
      expect(renderToStaticMarkup(createElement(SlackSection, { view: { ...connected, state }, tz: TZ, now: NOW }))).not.toContain("data-slack-reading");
    }
    const { reading: _r, ...without } = connected;
    expect(renderToStaticMarkup(createElement(SlackSection, { view: without, tz: TZ, now: NOW }))).not.toContain("data-slack-reading");
    // A read_connected banner (the consent's callback) shows over the section while it still asks him to act (paused), as a
    // success (fixer ui-4); not once reading is on, nor after Stop reading.
    const paused = { ...connected, reading: { ...ON_VIEW, state: "paused" as const, switchOn: false } };
    const banner = renderToStaticMarkup(createElement(SlackSection, { view: paused, tz: TZ, now: NOW, result: "read_connected" }));
    expect(textOf(banner)).toContain(SLACK_READ_COPY.connectResult.read_connected);
    expect(banner).toMatch(/data-slack-result="read_connected" class="[^"]*border-emerald-200/);
    expect(renderToStaticMarkup(createElement(SlackSection, { view: connected, tz: TZ, now: NOW, result: "read_connected" }))).not.toContain("data-slack-result");
  });

  it("SU16 the five screenshot states render inside the whole Settings page (the harness's fixtures), each with its own section state", () => {
    const states: SlackReadingView[] = [
      slackReadingView({ state: "not_consented", installationId: ESI }),
      slackReadingView({ state: "discovering", installationId: ESI, counts: ON_VIEW.counts }),
      PAUSED_VIEW,
      ON_VIEW,
      slackReadingView({ state: "revoked", installationId: ESI, revokedAt: "2026-11-05T18:00:00.000Z", revokeReason: "stopped" })
    ];
    for (const reading of states) {
      const view = settingsView({ slack: slackSettingsView({ state: "connected", installationId: ESI, teamId: "T0SCALED", dmChannelId: "D0MITCH", userId: "U0MITCH", installedAt: "2026-11-01T14:30:00.000Z", reading }) });
      const html = renderToStaticMarkup(createElement(SettingsPageView, { view, now: NOW, tz: TZ } as Parameters<typeof SettingsPageView>[0]));
      expect(html, reading.state).toContain(`data-reading-state="${reading.state}"`);
      expect(html).not.toContain("<script");
      // Settings may show channel names; nothing else Slack-side is in the page.
      assertNoSlackText(html, { label: reading.state, allow: ["channelName"] });
    }
  });
});

// ---------------------------------------------------------------------------
// The System card's "Slack reading" row (§3.20.4; SY01-SY04)
// ---------------------------------------------------------------------------

const summary = (over: Partial<SlackReadingSummary> = {}): SlackReadingSummary => ({
  state: "on", lastEventAt: "2026-11-06T14:40:00.000Z", lastSweepAt: "2026-11-06T14:30:00.000Z", blockedMethods: 0, pendingTriage: 3,
  userErrorCode: null, v2Missing: false, ...over
});
const row = (reading: SlackReadingSummary | null | undefined) => {
  const html = renderToStaticMarkup(createElement(SlackReadingRow, { reading, now: NOW }));
  return html === "" ? null : textOf(html);
};

describe("the System card's Slack reading row (§3.20.4)", () => {
  it("SY01 the row's words per state", () => {
    expect(row(summary())).toBe("Slack reading On · last check 30 min ago · 3 waiting");
    expect(row(summary({ lastSweepAt: null, pendingTriage: 0 }))).toBe("Slack reading On · last check not yet · 0 waiting");
    expect(row(summary({ state: "paused" }))).toBe("Slack reading Set up, turned off");
    expect(row(summary({ state: "discovering" }))).toBe("Slack reading Sorting conversations");
    expect(row(summary({ state: "error", userErrorCode: "token_revoked" }))).toBe("Slack reading Needs attention: Slack rejected the reading permission (token_revoked)");
    expect(row(summary({ state: "revoked" }))).toBe("Slack reading Stopped");
    // Integrator: §3.20.4's "Stopped {date}", in his zone, when the summary carries the date.
    expect(slackReadingLine(summary({ state: "revoked", revokedAt: "2026-11-05T18:00:00.000Z" }), NOW, TZ)?.value)
      .toBe(`Stopped ${formatInZone("2026-11-05T18:00:00.000Z", TZ, "date", NOW)}`);
    expect(slackReadingLine(summary({ state: "error", userErrorCode: "x" }), NOW)?.tone).toBe("rose");
    expect(slackReadingLine(summary(), NOW)?.tone).toBe("ok");
  });

  it("SY02 a blocked method adds ' · Slack is rate-limiting us' (amber)", () => {
    expect(row(summary({ blockedMethods: 2 }))).toBe("Slack reading On · last check 30 min ago · 3 waiting · Slack is rate-limiting us");
    expect(slackReadingLine(summary({ blockedMethods: 1 }), NOW)?.tone).toBe("amber");
    expect(row(summary({ state: "paused", blockedMethods: 1 }))).toBe("Slack reading Set up, turned off · Slack is rate-limiting us");
  });

  it("SY03 null, absent, not_consented, bot_not_connected and not_installed: no row; the System card renders it under P6's Slack row", () => {
    expect(row(null)).toBeNull();
    expect(row(undefined)).toBeNull();
    for (const state of ["not_consented", "bot_not_connected", "not_installed"] as const) expect(row(summary({ state }))).toBeNull();
    const system = (slack: OverviewSystem["slack"]): OverviewSection<OverviewSystem> => ({
      ok: true,
      data: { kinds: [], successLookbackHours: 48, dead24h: 0, queued: 0, due: 0, oldestDueAt: null, slack }
    });
    const html = renderToStaticMarkup(createElement(SystemSection, { system: system({ state: "connected", lastDmAt: null, lastErrorCode: null, revokedAt: null, reading: summary() }), now: NOW, tz: TZ }));
    expect(html.indexOf("data-slack-system")).toBeLessThan(html.indexOf("data-slack-reading-system"));
    expect(textOf(/<ul data-slack-system[^]*?<\/ul>/.exec(html)?.[0] ?? "")).toBe("Slack Connected · last message none yet");
    const p6 = renderToStaticMarkup(createElement(SystemSection, { system: system({ state: "connected", lastDmAt: null, lastErrorCode: null, revokedAt: null }), now: NOW, tz: TZ }));
    expect(p6).not.toContain("data-slack-reading-system");
    expect(renderToStaticMarkup(createElement(SlackRow, { slack: null, now: NOW, tz: TZ }))).not.toContain("data-slack-reading-system");
  });

  it("SY04 v2Missing adds the fallback warning in every state, alone where the state has no words of its own (C48)", () => {
    for (const state of ["on", "paused", "discovering", "error", "revoked"] as const) {
      const text = row(summary({ state, v2Missing: true, userErrorCode: state === "error" ? "x" : null }));
      expect(text?.endsWith(` · ${READING_V2_MISSING_TEXT}`), state).toBe(true);
      expect(slackReadingLine(summary({ state, v2Missing: true }), NOW)?.tone).toBe("rose");
    }
    for (const state of ["not_consented", "bot_not_connected", "not_installed"] as const) {
      expect(row(summary({ state, v2Missing: true }))).toBe(`Slack reading ${READING_V2_MISSING_TEXT}`);
    }
    expect(READING_V2_MISSING_TEXT).toBe("Needs attention: reading events are falling back to the old handler (apply or reload the P7a database update)");
  });
});

describe("P7a fixer: Settings", () => {
  it("SU20 (fixer ui-1) the picker's optimistic Mute on a finance row is the closed finance mute, never an owner mute", () => {
    const rows = [pickerRow({ channelId: "C0FIN", class: "finance", financeName: true, watchState: "unwatched" }),
      pickerRow({ channelId: "C0PAY", class: "external", financeName: true, watchState: "watched" }), pickerRow({ channelId: "C0GEN" })];
    expect(withWatch(rows, "C0FIN", "muted")[0]).toMatchObject({ watchState: "muted", muteSource: "default_finance" });
    expect(withWatch(rows, "C0PAY", "muted")[1]).toMatchObject({ watchState: "muted", muteSource: "default_finance" });
    expect(withWatch(rows, "C0GEN", "muted")[2]).toMatchObject({ watchState: "muted", muteSource: "owner" });
    expect(withWatch(rows, "C0FIN", "unwatched")[0]).toMatchObject({ watchState: "unwatched", muteSource: null });
  });

  it("SU21 (fixer ui-3) a view DD couldn't read says so: never 'Slack rejected', no Allow link; Stop reading only with the installation id", () => {
    const failed = { ...slackReadingView({ state: "error", installationId: ESI, lastErrorCode: null }), readFailed: true as const };
    const html = section(failed);
    expect(textOf(html)).toContain(SLACK_READ_COPY.readFailed);
    expect(textOf(html)).not.toContain("Slack rejected");
    expect(html).not.toContain("data-reading-allow");
    expect(html).toContain("data-reading-stop");
    expect(readingActions("error", { readFailed: true })).toEqual({ allow: false, settings: false, stop: true });
    expect(readingActions("error")).toEqual({ allow: true, settings: false, stop: true });
    // No installation id read: nothing to click at all.
    expect(section({ ...failed, installationId: null })).not.toContain("data-reading-stop");
    // A genuine error still says what Slack answered and offers Allow.
    const genuine = section(slackReadingView({ state: "error", installationId: ESI, lastErrorCode: "invalid_auth" }));
    expect(textOf(genuine)).toContain(fill(SLACK_READ_COPY.error, { code: "invalid_auth" }));
    expect(genuine).toContain("data-reading-allow");
  });

  it("SU22 (fixer ui-4) the read banners agree with the reading state: read_connected while discovering / paused only (a success), the read failures never over a set-up reading half", () => {
    for (const r of ["discovering", "paused"] as const) expect(slackResultBannerShown("read_connected", "connected", true, r), r).toBe(true);
    for (const r of ["on", "revoked", "not_consented", "error"] as const) expect(slackResultBannerShown("read_connected", "connected", true, r), r).toBe(false);
    expect(slackResultBannerShown("read_connected", "connected", true, null)).toBe(true);
    for (const code of ["read_not_connected", "missing_user_scopes", "extra_user_scopes", "read_taken"] as const) {
      for (const r of ["discovering", "paused", "on"] as const) expect(slackResultBannerShown(code, "connected", true, r), `${code} over ${r}`).toBe(false);
      for (const r of ["not_consented", "revoked", "error"] as const) expect(slackResultBannerShown(code, "connected", true, r), `${code} over ${r}`).toBe(true);
    }
    // Stop reading's revoked state never sits under "The assistant can now read your Slack".
    const connected = slackSettingsView({ state: "connected", installationId: ESI, teamId: "T0SCALED", dmChannelId: "D0MITCH", userId: "U0MITCH",
      installedAt: "2026-11-01T14:30:00.000Z", reading: slackReadingView({ state: "revoked", installationId: ESI, revokedAt: "2026-11-06T15:00:00.000Z", revokeReason: "stopped" }) });
    expect(renderToStaticMarkup(createElement(SlackSection, { view: connected, tz: TZ, now: NOW, result: "read_connected" }))).not.toContain("data-slack-result");
  });

  it("SU23 (fixer ui-8) a capped picker says how many of how many channels it shows; an uncapped one says nothing", () => {
    expect(pickerShowingText(ON_VIEW)).toBe(fill(SLACK_READ_COPY.pickerShowing, { shown: "9", total: "15" }));
    expect(textOf(picker(ON_VIEW))).toContain(fill(SLACK_READ_COPY.pickerShowing, { shown: "9", total: "15" }));
    const full = { ...ON_VIEW, counts: { ...ON_VIEW.counts, watched: 4, muted: 3, unwatched: 1, hubs: 1 } };
    expect(pickerShowingText(full)).toBeNull();
    expect(picker(full)).not.toContain("data-picker-showing");
  });

  it("SU24 (fixer ui-10) with a reading half set up, the Disconnect confirm also says reading stops and its data is deleted", () => {
    const base = { state: "connected" as const, installationId: ESI, teamId: "T0SCALED", dmChannelId: "D0MITCH", userId: "U0MITCH", installedAt: "2026-11-01T14:30:00.000Z" };
    for (const state of ["discovering", "paused", "on", "error"] as const) {
      const html = renderToStaticMarkup(createElement(SlackSection, { view: slackSettingsView({ ...base, reading: slackReadingView({ ...ON_VIEW, state }) }), tz: TZ, now: NOW, confirmOpen: true }));
      expect(textOf(html), state).toContain(`${SLACK_COPY.disconnectConfirmBody} ${SLACK_READ_COPY.disconnectAlsoStops}`);
    }
    for (const reading of [slackReadingView({ state: "not_consented", installationId: ESI }), slackReadingView({ state: "revoked", installationId: ESI }), undefined]) {
      const html = renderToStaticMarkup(createElement(SlackSection, { view: slackSettingsView({ ...base, ...(reading ? { reading } : {}) }), tz: TZ, now: NOW, confirmOpen: true }));
      expect(textOf(html)).toContain(SLACK_COPY.disconnectConfirmBody);
      expect(textOf(html)).not.toContain(SLACK_READ_COPY.disconnectAlsoStops);
    }
  });
});
