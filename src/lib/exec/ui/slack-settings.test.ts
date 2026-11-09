import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
// Area C's canonical-host check, at its module boundary (slack-oauth.test.ts covers it).
vi.mock("@/lib/exec/slack-oauth", () => ({ isCanonicalRequestHost: vi.fn() }));
// The env readers and the store keep their real bodies (restoreMocks puts them back before each test); a test overrides one.
vi.mock("@/lib/exec/slack-config", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/slack-config")>();
  return { ...real, slackConfig: vi.fn(real.slackConfig) };
});
vi.mock("@/lib/exec/crypto", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/crypto")>();
  return { ...real, cryptoConfigured: vi.fn(real.cryptoConfigured) };
});
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/slack-install")>();
  return {
    ...real,
    slackSchemaReady: vi.fn(real.slackSchemaReady),
    getActiveInstallation: vi.fn(real.getActiveInstallation),
    getLatestInstallation: vi.fn(real.getLatestInstallation)
  };
});
vi.mock("@/lib/exec/slack-settings", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/slack-settings")>();
  return { ...real, getSlackSettingsView: vi.fn(real.getSlackSettingsView) };
});
// P7a (§3.16, AM-P7a-4): the reading half at its module boundary (ui/slack-reading-settings.test.ts covers it); once
// P6's reads succeed the view carries it as `reading`.
vi.mock("@/lib/exec/slack-reading-settings", async () => {
  const { slackReadingView } = await import("../__tests__/p5a-ui-fixtures");
  return { getSlackReadingView: vi.fn(async () => slackReadingView()) };
});
vi.mock("@/lib/exec/access", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/access")>();
  return { ...real, requireExecPrincipalForPage: vi.fn() };
});
vi.mock("@/lib/exec/settings", async (orig) => {
  const real = await orig<typeof import("@/lib/exec/settings")>();
  return { ...real, getSettingsView: vi.fn(real.getSettingsView) };
});

import ExecutiveSettingsPage from "@/app/(main)/executive/settings/page";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { SlackRow, SystemSection, slackSystemLine } from "@/components/exec/overview/SystemSection";
import { SettingsPageView } from "@/components/exec/settings/SettingsPageView";
import { SLACK_START_PATH, SlackConnectControls, disconnectThenRefresh } from "@/components/exec/settings/SlackConnectControls";
import {
  SLACK_CONNECT_RESULTS,
  SlackSection,
  parseSlackResult,
  parseSlackWho,
  slackResultBannerShown,
  slackResultText,
  slackRevokedText,
  slackSectionState
} from "@/components/exec/settings/SlackSection";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { cryptoConfigured } from "@/lib/exec/crypto";
import { formatInZone } from "@/lib/exec/format";
import type { OverviewSection, OverviewSystem } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { getSettingsView } from "@/lib/exec/settings";
import { slackConfig } from "@/lib/exec/slack-config";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { getActiveInstallation, slackSchemaReady } from "@/lib/exec/slack-install";
import { isCanonicalRequestHost } from "@/lib/exec/slack-oauth";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import { SLACK_BOT_SCOPES, type SlackConnectResult, type SlackSettingsView, type SlackSystemSummary } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { SLACK_DISCONNECT_PATH, disconnectSlack, slackDisconnectMessageFor } from "@/lib/exec/ui/settings-api";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { headers } from "next/headers";
import { useRouter } from "next/navigation";
import { createFakeSlackDb, type FakeSlackDb, type Row } from "../__tests__/fake-slack-db";
import { NNBSP, NOW, TZ, settingsView, slackReadingView, slackSettingsView, textOf } from "../__tests__/p5a-ui-fixtures";
import { getSlackReadingView } from "@/lib/exec/slack-reading-settings";
import { SENTINELS, findSentinel } from "../__tests__/slack-assert";

// P6 contract §5.9 SE01-SE12 (Area E; §3.13, §3.15.2, §3.15.3, K15, C24, C25, C45, C48): the Settings page's Slack
// section in every state, its result banner, the framed and wrong-host variants, Disconnect, the System card's
// Slack row, getSlackSettingsView over Area A's fake database, and the page's ?slack= / ?who= / host handling.

const ESI = `esi_${"1".repeat(32)}`;
const ESI_OLD = `esi_${"2".repeat(32)}`;
const PRINCIPAL_ID = "ep_owner";
const START = "/api/integrations/exec-slack/start";
const INSTALLED = "2026-11-01T14:30:00.000Z";
const LAST_DM = "2026-11-06T14:12:00.000Z";
const REVOKED = "2026-11-05T18:00:00.000Z";
const SEALED = "v1.0a1b2c3d.AAAA.BBBB.CCCC";
const CONFIG = { clientId: "1234.5678", clientSecret: SENTINELS.clientSecret, signingSecret: SENTINELS.signingSecret, teamId: "T0SCALED", appId: "A0EXEC" };

const P: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: PRINCIPAL_ID, user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: TZ },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

/** Visible text with Intl's narrow spaces made plain (textOf does the same to the markup). */
const plain = (s: string) => s.split(NNBSP).join(" ");
const dateTime = (iso: string) => plain(formatInZone(iso, TZ, "datetime", NOW));

const connectedView = (over: Partial<SlackSettingsView> = {}): SlackSettingsView =>
  slackSettingsView({
    state: "connected",
    installationId: ESI,
    teamId: "T0SCALED",
    dmChannelId: "D0MITCH",
    userId: "U0MITCH",
    installedAt: INSTALLED,
    scopes: [...SLACK_BOT_SCOPES],
    ...over
  });
const errorView = (over: Partial<SlackSettingsView> = {}) =>
  connectedView({ state: "error", lastErrorCode: "invalid_auth", lastErrorAt: "2026-11-06T13:00:00.000Z", ...over });
const revokedView = (over: Partial<SlackSettingsView> = {}) =>
  connectedView({ state: "revoked", revokedAt: REVOKED, revokeReason: "disconnected", ...over });

/** getSlackSettingsView's failed read (ui-8): not connected, marked readFailed. */
const FAILED: SlackSettingsView = { ...slackSettingsView(), readFailed: true };

const render = (view: SlackSettingsView, props: Partial<Parameters<typeof SlackSection>[0]> = {}) =>
  renderToStaticMarkup(createElement(SlackSection, { view, tz: TZ, now: NOW, ...props }));
const bannerOf = (html: string) => /<div[^>]*data-slack-result="[^"]*"[^]*?<\/div>/.exec(html)?.[0] ?? "";
const startLinks = (html: string) => html.split(`href="${START}"`).length - 1;
const disconnectButtons = (html: string) => (html.match(/<button[^>]*data-slack-disconnect/g) ?? []).length;

let refresh: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  refresh = vi.fn();
  vi.mocked(useRouter).mockReturnValue({ refresh } as unknown as ReturnType<typeof useRouter>);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// SE01-SE06: each state's copy, exactly
// ---------------------------------------------------------------------------

describe("SlackSection: each state (SE01-SE06)", () => {
  it("SE01 the P6 migration isn't applied: settingsNotInstalled, nothing to click, no installation rows", () => {
    for (const configured of [true, false]) {
      const html = render(slackSettingsView({ schema: false, configured }));
      const text = textOf(html);
      expect(text).toBe(`Slack ${SLACK_COPY.settingsNotInstalled}`);
      expect(html).toContain('data-slack-state="not_installed"');
      expect(startLinks(html)).toBe(0);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("data-slack-installation");
    }
    expect(slackSectionState(slackSettingsView({ schema: false, state: "connected" }))).toBe("not_installed");
  });

  it("SE02 not configured: settingsNotConfigured, whatever the state, nothing to click", () => {
    for (const view of [slackSettingsView({ configured: false }), connectedView({ configured: false }), revokedView({ configured: false })]) {
      const html = render(view);
      expect(textOf(html)).toBe(`Slack ${SLACK_COPY.settingsNotConfigured}`);
      expect(html).toContain('data-slack-state="not_configured"');
      expect(startLinks(html)).toBe(0);
      expect(html).not.toContain("<button");
    }
  });

  it("SE03 not connected: the intro, the password note, Connect to the start route; no Disconnect, no rows", () => {
    const html = render(slackSettingsView());
    expect(textOf(html)).toBe(`Slack ${SLACK_COPY.settingsIntro} ${SLACK_COPY.settingsPasswordNote} ${SLACK_COPY.settingsConnect}`);
    expect(html).toContain('data-slack-state="not_connected"');
    expect(html).toMatch(new RegExp(`<a[^>]*data-slack-connect[^>]*href="${START}"[^>]*>${SLACK_COPY.settingsConnect}</a>`));
    expect(startLinks(html)).toBe(1);
    expect(disconnectButtons(html)).toBe(0);
    expect(html).not.toContain("data-slack-installation");
    expect(SLACK_START_PATH).toBe(START);
  });

  it("SE04 connected: Workspace, DM channel, Slack id, Connected (his zone), Permissions, Last message handled", () => {
    const none = textOf(render(connectedView()));
    expect(none).toContain(
      [
        "Workspace T0SCALED",
        "DM channel D0MITCH",
        "Your Slack id U0MITCH",
        `Connected ${dateTime(INSTALLED)}`,
        "Permissions chat:write, im:history, im:read, im:write, users:read, users:read.email",
        "Last message handled None yet"
      ].join(" ")
    );
    expect(dateTime(INSTALLED)).toBe("Nov 1, 9:30 AM EST");
    const seen = textOf(render(connectedView({ lastDmAt: LAST_DM })));
    expect(seen).toContain(`Last message handled ${dateTime(LAST_DM)}`);
    expect(dateTime(LAST_DM)).toBe("Nov 6, 9:12 AM EST");
    expect(seen).not.toContain(SLACK_COPY.settingsError.slice(0, 20));
    expect(render(connectedView())).toContain('data-slack-state="connected"');
    // No scopes recorded: a dash, never an empty value.
    expect(textOf(render(connectedView({ scopes: [] })))).toContain("Permissions —");
  });

  it("SE05 error: the same rows plus settingsError naming the code", () => {
    const html = render(errorView());
    const text = textOf(html);
    expect(html).toContain('data-slack-state="error"');
    expect(text).toContain("Workspace T0SCALED DM channel D0MITCH Your Slack id U0MITCH");
    expect(text).toContain("Slack rejected the last request (invalid_auth). Reconnect if this keeps happening.");
    expect(/<div[^>]*data-slack-error[^]*?<\/div>/.exec(html)?.[0]).toContain("invalid_auth");
  });

  it("SE06 revoked: settingsRevoked with the date and each reason's label, then Connect; no Disconnect", () => {
    for (const [reason, label] of Object.entries(SLACK_COPY.revokeReasons)) {
      const html = render(revokedView({ revokeReason: reason as SlackSettingsView["revokeReason"] }));
      const text = textOf(html);
      expect(html).toContain('data-slack-state="revoked"');
      expect(text).toBe(`Slack Record Disconnected on Nov 5 (${label}). ${SLACK_COPY.settingsConnect}`);
      expect(startLinks(html)).toBe(1);
      expect(disconnectButtons(html)).toBe(0);
      expect(html).not.toContain("data-slack-installation");
    }
    expect(slackRevokedText({ revokedAt: REVOKED, revokeReason: "app_uninstalled" }, TZ, NOW)).toBe("Disconnected on Nov 5 (the app was removed in Slack).");
    expect(slackRevokedText({ revokedAt: REVOKED, revokeReason: null }, TZ, NOW)).toBe("Disconnected on Nov 5 (—).");
  });
});

// ---------------------------------------------------------------------------
// SE07: the ?slack= result banner and ?who=
// ---------------------------------------------------------------------------

const ALL_RESULTS: SlackConnectResult[] = [
  "connected", "denied", "state_invalid", "state_expired", "not_configured", "not_installed", "session_unbound",
  "rate_limited", "unavailable", "slack_unavailable", "exchange_failed", "enterprise", "wrong_team", "wrong_app",
  "missing_scopes", "identity_not_found", "wrong_user", "wrong_host", "extra_scopes",
  // P7a (§3.10.4, §3.17): the five read-consent codes, from SLACK_READ_COPY.connectResult.
  "read_connected", "read_not_connected", "missing_user_scopes", "extra_user_scopes", "read_taken"
];

describe("The result banner (SE07)", () => {
  it("SE07 every ?slack= code maps to its message; an unknown code renders nothing", () => {
    expect([...SLACK_CONNECT_RESULTS].sort()).toEqual([...ALL_RESULTS].sort());
    for (const result of ALL_RESULTS) {
      // Over a connection every code shows (slackResultBannerShown: the banner agrees with the state; SE07b).
      for (const view of [connectedView(), errorView()]) {
        const html = render(view, { result, who: "U0OTHER" });
        const banner = bannerOf(html);
        expect(banner, result).toContain(`data-slack-result="${result}"`);
        const expected = result === "wrong_user" ? SLACK_COPY.connectResult.wrong_user.replace("{who}", "U0OTHER") : SLACK_COPY.connectResult[result];
        expect(textOf(banner), result).toBe(expected);
        expect(banner).toContain('role="status"');
      }
    }
    expect(bannerOf(render(connectedView(), { result: "connected" }))).toContain("emerald");
    expect(bannerOf(render(connectedView(), { result: "denied" }))).toContain("amber");
    for (const bogus of ["bogus", "toString", "__proto__", "constructor", "CONNECTED", "connected ", ""]) {
      expect(render(slackSettingsView(), { result: bogus as SlackConnectResult })).not.toContain("data-slack-result");
    }
    expect(render(slackSettingsView(), { result: null })).not.toContain("data-slack-result");
  });

  it("SE07b (fixer ui-3, ui-8, ui-9): the banner agrees with the state: connected only over a connection, never over a failed read, never repeating the body", () => {
    // ui-3: Connect → ?slack=connected → Disconnect → refresh: the section is revoked, so no "Slack is connected" above it.
    for (const view of [revokedView(), slackSettingsView(), slackSettingsView({ schema: false }), slackSettingsView({ configured: false })]) {
      const html = render(view, { result: "connected" });
      expect(html, view.state).not.toContain("data-slack-result");
      expect(textOf(html)).not.toContain(SLACK_COPY.connectResult.connected);
    }
    for (const view of [connectedView(), errorView()]) expect(bannerOf(render(view, { result: "connected" }))).toContain("emerald");
    // Other outcomes still show over not_connected and revoked (a failed connect leaves the section as it was).
    for (const view of [slackSettingsView(), revokedView()]) expect(bannerOf(render(view, { result: "denied" }))).toContain("amber");
    // ui-9: the same sentence twice.
    const notInstalled = render(slackSettingsView({ schema: false }), { result: "not_installed" });
    expect(notInstalled).not.toContain("data-slack-result");
    expect(textOf(notInstalled).split(SLACK_COPY.settingsNotInstalled).length - 1).toBe(1);
    const notConfigured = render(slackSettingsView({ configured: false }), { result: "not_configured" });
    expect(notConfigured).not.toContain("data-slack-result");
    expect(textOf(notConfigured).split(SLACK_COPY.settingsNotConfigured).length - 1).toBe(1);
    // ui-9: wrong_host off the canonical host is settingsWrongHost already; on it, the banner says where he is now.
    expect(render(slackSettingsView(), { result: "wrong_host", onCanonicalHost: false })).not.toContain("data-slack-result");
    expect(textOf(bannerOf(render(slackSettingsView(), { result: "wrong_host" })))).toBe(SLACK_COPY.connectResult.wrong_host);
    // ui-8: a failed read shows no banner at all.
    for (const result of ALL_RESULTS) expect(render(slackSettingsView({ readFailed: true }), { result })).not.toContain("data-slack-result");
    expect(slackResultBannerShown("connected", "revoked", true)).toBe(false);
    expect(slackResultBannerShown("connected", "connected", true)).toBe(true);
  });

  it("SE07c (fixer ui-8): a failed read says it couldn't load, with nothing to click: no Connect, no Disconnect, no rows", () => {
    for (const onCanonicalHost of [true, false]) {
      const html = render(slackSettingsView({ readFailed: true }), { onCanonicalHost });
      expect(html).toContain('data-slack-state="read_failed"');
      expect(textOf(html)).toContain(SLACK_COPY.settingsReadFailed);
      expect(startLinks(html)).toBe(0);
      expect(disconnectButtons(html)).toBe(0);
      expect(html).not.toContain("data-slack-installation");
      expect(textOf(html)).not.toContain(SLACK_COPY.settingsIntro);
      expect(textOf(html)).not.toContain(SLACK_COPY.settingsWrongHost);
    }
    expect(slackSectionState(slackSettingsView({ readFailed: true, schema: false }))).toBe("read_failed");
  });

  it("SE07 who is shown only when it is a Slack user id (SLACK_RE.user)", () => {
    expect(textOf(bannerOf(render(slackSettingsView(), { result: "wrong_user", who: "W0ABC123" })))).toBe(
      "Slack says Slack member W0ABC123 approved this install, not you. Nothing was saved. Sign in to Slack as yourself and try again."
    );
    for (const who of ["<b>U0X</b>", "u0lower", "U0", "T0SCALED", "U0MITCH extra", `U0${"A".repeat(40)}`, "", null]) {
      const html = render(slackSettingsView(), { result: "wrong_user", who });
      expect(textOf(bannerOf(html)), String(who)).toBe("Slack says Slack member — approved this install, not you. Nothing was saved. Sign in to Slack as yourself and try again.");
      expect(html).not.toContain("<b>");
    }
    // who appears in no other message.
    expect(textOf(bannerOf(render(slackSettingsView(), { result: "denied", who: "U0OTHER" })))).not.toContain("U0OTHER");
    expect(slackResultText("wrong_user", "U0OTHER")).toContain("U0OTHER");
  });

  it("SE07 the page's parsers: exact codes only, Next's string[] form, a Slack user id only", () => {
    for (const r of ALL_RESULTS) expect(parseSlackResult(r)).toBe(r);
    expect(parseSlackResult(["wrong_host", "connected"])).toBe("wrong_host");
    for (const bad of [undefined, null, 1, "toString", "hasOwnProperty", "__proto__", "Connected", " connected", "connected\n", ["nope"], []]) {
      expect(parseSlackResult(bad), String(bad)).toBeNull();
    }
    expect(parseSlackWho("U0OTHER")).toBe("U0OTHER");
    expect(parseSlackWho(["W0ABC", "U0X"])).toBe("W0ABC");
    for (const bad of [undefined, null, "", "u0other", "D0MITCH", "U0 OTHER", "<script>", "U0OTHER\n", ["x"]]) expect(parseSlackWho(bad), String(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SE08: framed
// ---------------------------------------------------------------------------

describe("Framed (SE08)", () => {
  beforeEach(() => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
  });

  it("SE08 framed: no Connect or Reconnect link, no Disconnect button, settingsFramed instead", () => {
    for (const view of [slackSettingsView(), connectedView(), errorView(), revokedView()]) {
      for (const onCanonicalHost of [true, false]) {
        const html = render(view, { onCanonicalHost, confirmOpen: true });
        expect(startLinks(html), view.state).toBe(0);
        expect(html, view.state).not.toContain("<button");
        expect(html).not.toContain("data-slack-confirm");
        expect(html).toContain("data-slack-framed");
        expect(textOf(html)).toContain(SLACK_COPY.settingsFramed);
        expect(textOf(html)).not.toContain(SLACK_COPY.settingsWrongHost);
      }
    }
    // The rows and the error stay readable.
    expect(textOf(render(errorView()))).toContain("Workspace T0SCALED");
    expect(textOf(render(errorView()))).toContain("(invalid_auth)");
  });

  it("SE08 the whole Settings page framed: no button, no start link", () => {
    for (const slack of [slackSettingsView(), connectedView(), errorView()]) {
      const html = renderToStaticMarkup(createElement(SettingsPageView, { view: settingsView({ slack }) }));
      expect(html).not.toContain("<button");
      expect(startLinks(html)).toBe(0);
      expect(textOf(html)).toContain(SLACK_COPY.settingsFramed);
    }
  });
});

// ---------------------------------------------------------------------------
// SE09: Disconnect
// ---------------------------------------------------------------------------

describe("Disconnect (SE09)", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("SE09 POSTs { installationId, confirm: 'disconnect' } same-origin as JSON; 200 → disconnected", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { slack: revokedView() }));
    expect(await disconnectSlack(ESI, f)).toEqual({ kind: "disconnected" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/exec/slack/disconnect");
    expect(SLACK_DISCONNECT_PATH).toBe(url);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ installationId: ESI, confirm: "disconnect" });
  });

  it("SE09 503 slack_unavailable → disconnectSlackDown; every other answer and a network failure → disconnectFailed", async () => {
    expect(await disconnectSlack(ESI, async () => json(503, { error: "slack_unavailable" }))).toEqual({ kind: "failed", status: 503, message: SLACK_COPY.disconnectSlackDown });
    for (const [status, body] of [
      [503, { error: "unavailable" }],
      [404, { error: "not_found" }],
      [409, { error: "not_installed" }],
      [429, { error: "rate_limited", retryAfterSeconds: 30 }],
      [403, { error: "forbidden" }],
      [401, { error: "unauthorized" }],
      [400, { error: "invalid", detail: "installationId" }],
      [500, "not json"]
    ] as const) {
      expect(await disconnectSlack(ESI, async () => json(status, body)), String(status)).toEqual({ kind: "failed", status, message: SLACK_COPY.disconnectFailed });
    }
    expect(await disconnectSlack(ESI, async () => new Response("<html>", { status: 503 }))).toMatchObject({ message: SLACK_COPY.disconnectFailed });
    expect(
      await disconnectSlack(ESI, async () => {
        throw new TypeError("fetch failed");
      })
    ).toEqual({ kind: "failed", status: 0, message: SLACK_COPY.disconnectFailed });
    expect(slackDisconnectMessageFor(503, { error: "slack_unavailable" })).toBe("Couldn't reach Slack, so nothing changed. Try again.");
    expect(slackDisconnectMessageFor(200, null)).toBe("Couldn't disconnect. Try again.");
  });

  it("SE09 the confirmed flow: success refreshes the page; a failure shows its words and doesn't refresh", async () => {
    const ok = vi.fn(async () => ({ kind: "disconnected" as const }));
    const r1 = vi.fn();
    expect(await disconnectThenRefresh(ESI, r1, ok)).toBeNull();
    expect(ok).toHaveBeenCalledWith(ESI);
    expect(r1).toHaveBeenCalledTimes(1);
    const r2 = vi.fn();
    expect(await disconnectThenRefresh(ESI, r2, async () => ({ kind: "failed", status: 503, message: SLACK_COPY.disconnectSlackDown }))).toBe(SLACK_COPY.disconnectSlackDown);
    expect(r2).not.toHaveBeenCalled();
    // The default transport is disconnectSlack over the global fetch.
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, {}));
    vi.stubGlobal("fetch", f);
    const r3 = vi.fn();
    expect(await disconnectThenRefresh(ESI, r3)).toBeNull();
    expect(f.mock.calls[0][0]).toBe(SLACK_DISCONNECT_PATH);
    expect(r3).toHaveBeenCalledTimes(1);
  });

  it("SE09 the confirm: title, body, Disconnect and Cancel, labelled; the links hidden while it is open", () => {
    const html = render(connectedView(), { confirmOpen: true });
    const confirm = /<div[^>]*data-slack-confirm[^]*$/.exec(html)?.[0] ?? "";
    expect(textOf(confirm)).toContain(`${SLACK_COPY.disconnectConfirmTitle} ${SLACK_COPY.disconnectConfirmBody} Disconnect Cancel`);
    const group = /<div[^>]*data-slack-confirm[^>]*>/.exec(html)?.[0] ?? "";
    expect(group).toContain('role="group"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(group)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(group)?.[1];
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toMatch(/<p[^>]*tabindex="-1"[^>]*>Disconnect Slack\?<\/p>/);
    expect(html).toMatch(/<button[^>]*data-slack-confirm-disconnect[^>]*>Disconnect<\/button>/);
    expect(startLinks(html)).toBe(0);
    expect(disconnectButtons(html)).toBe(0);
    // Without an installation id there is nothing to disconnect.
    const noId = renderToStaticMarkup(createElement(SlackConnectControls, { mode: "manage", installationId: null, initialConfirm: true }));
    expect(noId).not.toContain("<button");
    expect(noId).not.toContain("data-slack-confirm");
    expect(startLinks(noId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SE10: the System card's Slack row
// ---------------------------------------------------------------------------

const summary = (over: Partial<SlackSystemSummary> = {}): SlackSystemSummary => ({ state: "connected", lastDmAt: null, lastErrorCode: null, revokedAt: null, ...over });
const systemData = (slack?: SlackSystemSummary | null): OverviewSection<OverviewSystem> => ({
  ok: true,
  data: { kinds: [], successLookbackHours: 48, dead24h: 0, queued: 0, due: 0, oldestDueAt: null, ...(slack === undefined ? {} : { slack }) }
});
const systemHtml = (slack?: SlackSystemSummary | null) => renderToStaticMarkup(createElement(SystemSection, { system: systemData(slack), now: NOW, tz: TZ }));
const slackRowOf = (html: string) => /<li[^>]*data-slack-row[^]*?<\/li>/.exec(html)?.[0] ?? "";

describe("The System card's Slack row (SE10)", () => {
  it("SE10 one row per state, in words", () => {
    const cases: [SlackSystemSummary | null, string, string][] = [
      [summary({ lastDmAt: "2026-11-06T14:55:00.000Z" }), "Slack Connected · last message 5 min ago", "text-slate-700"],
      [summary(), "Slack Connected · last message none yet", "text-slate-700"],
      [summary({ state: "error", lastErrorCode: "invalid_auth", lastDmAt: LAST_DM }), "Slack Needs attention: Slack rejected a request (invalid_auth)", "text-rose-700"],
      [summary({ state: "revoked", revokedAt: REVOKED }), "Slack Disconnected Nov 5", "text-muted"],
      [summary({ state: "not_connected" }), "Slack Not connected", "text-muted"],
      [null, "Slack couldn't load", "text-amber-700"]
    ];
    for (const [slack, words, tone] of cases) {
      const row = slackRowOf(systemHtml(slack));
      expect(textOf(row), words).toBe(words);
      expect(row, words).toContain(tone);
      expect(row).toContain(`data-slack-row="${slack === null ? "unavailable" : slack.state}"`);
    }
    expect(slackSystemLine(summary({ state: "error" }), NOW, TZ).value).toBe("Needs attention: Slack rejected a request (unknown)");
  });

  it("SE10 absent (before the P6 schema): no row at all; the rest of the card unchanged", () => {
    const without = systemHtml(undefined);
    expect(without).not.toContain("data-slack-system");
    expect(renderToStaticMarkup(createElement(SlackRow, { slack: undefined, now: NOW, tz: TZ }))).toBe("");
    const withRow = systemHtml(summary());
    expect(withRow.replace(/<ul data-slack-system[^]*?<\/ul>/, "")).toBe(without);
  });
});

// ---------------------------------------------------------------------------
// SE11, SE12: Reconnect + Disconnect; the canonical host
// ---------------------------------------------------------------------------

describe("Reconnect and Disconnect (SE11)", () => {
  it("SE11 connected and error both offer Reconnect (the start route) and Disconnect", () => {
    for (const view of [connectedView(), errorView()]) {
      const html = render(view);
      expect(html, view.state).toMatch(new RegExp(`<a[^>]*data-slack-reconnect[^>]*href="${START}"`));
      expect(textOf(html)).toContain(`${SLACK_COPY.settingsReconnect} ${SLACK_COPY.settingsDisconnect}`);
      expect(startLinks(html)).toBe(1);
      expect(disconnectButtons(html)).toBe(1);
      expect(html).not.toContain("data-slack-connect");
    }
    // Connect / Reconnect are plain anchors (never next/link: a prefetch would GET the start route).
    const src = readFileSync(path.join(SRC, "components/exec/settings/SlackConnectControls.tsx"), "utf8");
    expect(src).not.toMatch(/from\s+["']next\/link["']/);
  });
});

describe("The canonical host (SE12, C45)", () => {
  it("SE12 off the canonical host: no Connect or Reconnect link, settingsWrongHost, Disconnect still there", () => {
    for (const view of [slackSettingsView(), revokedView(), connectedView(), errorView()]) {
      const html = render(view, { onCanonicalHost: false });
      expect(startLinks(html), view.state).toBe(0);
      expect(textOf(html)).toContain(SLACK_COPY.settingsWrongHost);
      expect(html).toContain("data-slack-wrong-host");
      expect(disconnectButtons(html)).toBe(view.state === "connected" || view.state === "error" ? 1 : 0);
    }
    expect(textOf(render(slackSettingsView(), { onCanonicalHost: true }))).not.toContain(SLACK_COPY.settingsWrongHost);
  });

  it("SE12 the wrong_host and extra_scopes results render their copy", () => {
    // On the canonical host, where start's 303 lands (off it, settingsWrongHost stands in: SE07b).
    expect(textOf(bannerOf(render(slackSettingsView(), { result: "wrong_host" })))).toBe(
      "You started from a different DD address, so you've been moved to operations.scaledai.org. Press Connect Slack again here."
    );
    expect(textOf(bannerOf(render(slackSettingsView(), { result: "extra_scopes" })))).toBe(
      "The Slack app has more permissions than the assistant uses. Ask the team to remove them, and uninstall the app first if it was installed with them. Nothing was saved."
    );
  });
});

// ---------------------------------------------------------------------------
// getSlackSettingsView over Area A's fake database (§3.13)
// ---------------------------------------------------------------------------

function installation(over: Row = {}): Row {
  return {
    id: ESI,
    principal_id: PRINCIPAL_ID,
    team_id: "T0SCALED",
    app_id: "A0EXEC",
    bot_user_id: "U0BOT",
    bot_id: "B0BOT",
    bot_token_enc: SEALED,
    key_id: "0a1b2c3d",
    bot_scopes: [...SLACK_BOT_SCOPES],
    user_scopes: [],
    user_token_enc: null,
    user_id: "U0MITCH",
    slack_dm_channel_id: "D0MITCH",
    installed_at: INSTALLED,
    updated_at: INSTALLED,
    revoked_at: null,
    revoke_reason: null,
    last_dm_at: null,
    last_error_code: null,
    last_error_at: null,
    purged_at: null,
    ...over
  };
}
const revokedRow = (over: Row = {}) =>
  installation({ id: ESI_OLD, revoked_at: REVOKED, revoke_reason: "app_uninstalled", bot_token_enc: null, key_id: null, purged_at: REVOKED, ...over });

let db: FakeSlackDb;
function useDb(rows: Row[], seed: Partial<Parameters<typeof createFakeSlackDb>[0]> = {}): FakeSlackDb {
  db = createFakeSlackDb({ tables: { exec_slack_installations: rows }, ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

const VIEW_KEYS = [
  "configured", "dmChannelId", "installationId", "installedAt", "lastDmAt", "lastErrorAt", "lastErrorCode", "reading", "revokeReason", "revokedAt",
  "schema", "scopes", "state", "teamId", "userId"
];
/** P7a: a view as getSlackSettingsView returns it once P6's reads succeeded (the reading half, mocked above). */
const withReading = (v: SlackSettingsView): SlackSettingsView => ({ ...v, reading: slackReadingView() });

describe("getSlackSettingsView (§3.13)", () => {
  let errors: MockInstance<typeof console.error>;
  beforeEach(() => {
    vi.mocked(slackConfig).mockReturnValue(CONFIG);
    vi.mocked(cryptoConfigured).mockReturnValue(true);
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("connected: his active installation's ids, scopes and times; never the sealed token or its key id", async () => {
    useDb([installation({ last_dm_at: LAST_DM })]);
    const view = await getSlackSettingsView(P);
    expect(view).toEqual(withReading(connectedView({ lastDmAt: LAST_DM, scopes: [...SLACK_BOT_SCOPES] })));
    expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    expect(JSON.stringify(view)).not.toContain(SEALED);
    expect(JSON.stringify(view)).not.toContain("0a1b2c3d");
    expect(errors).not.toHaveBeenCalled();
  });

  it("error: the active installation with a last error code", async () => {
    useDb([installation({ last_error_code: "invalid_auth", last_error_at: "2026-11-06T13:00:00.000Z" })]);
    expect(await getSlackSettingsView(P)).toEqual(withReading(errorView()));
  });

  it("revoked: no active installation and the newest one revoked (date and reason)", async () => {
    useDb([revokedRow({ installed_at: "2026-10-01T00:00:00.000Z" }), revokedRow({ id: `esi_${"3".repeat(32)}`, installed_at: INSTALLED, revoke_reason: "disconnected" })]);
    expect(await getSlackSettingsView(P)).toMatchObject({ schema: true, configured: true, state: "revoked", installationId: `esi_${"3".repeat(32)}`, revokedAt: REVOKED, revokeReason: "disconnected" });
  });

  it("an active installation wins over an older revoked one; none at all, or another principal's, is not_connected", async () => {
    useDb([revokedRow(), installation({ installed_at: "2026-11-02T00:00:00.000Z" })]);
    expect((await getSlackSettingsView(P)).state).toBe("connected");
    useDb([]);
    expect(await getSlackSettingsView(P)).toEqual(withReading(slackSettingsView()));
    useDb([installation({ principal_id: "ep_other" }), revokedRow({ principal_id: "ep_other" })]);
    expect(await getSlackSettingsView(P)).toEqual(withReading(slackSettingsView()));
  });

  it("the P6 migration not applied: schema false, not_connected, no installation read", async () => {
    useDb([], { missing: ["exec_slack_installations"] });
    expect(await getSlackSettingsView(P)).toEqual(withReading(slackSettingsView({ schema: false })));
    expect(getActiveInstallation).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("configured = slackConfig() !== null && cryptoConfigured(), read without the database", async () => {
    useDb([installation()]);
    for (const [cfg, crypto, want] of [
      [CONFIG, true, true],
      [null, true, false],
      [CONFIG, false, false],
      [null, false, false]
    ] as const) {
      vi.mocked(slackConfig).mockReturnValue(cfg);
      vi.mocked(cryptoConfigured).mockReturnValue(crypto);
      expect((await getSlackSettingsView(P)).configured, `${cfg !== null} ${crypto}`).toBe(want);
    }
    vi.mocked(slackConfig).mockImplementation(() => {
      throw new Error("never");
    });
    expect((await getSlackSettingsView(P)).configured).toBe(false);
    useDb([], { missing: ["exec_slack_installations"] });
    vi.mocked(slackConfig).mockReturnValue(CONFIG);
    vi.mocked(cryptoConfigured).mockReturnValue(true);
    expect(await getSlackSettingsView(P)).toMatchObject({ schema: false, configured: true });
  });

  it("a read failure fails soft: schema true, not_connected, one log line with ids and codes only", async () => {
    useDb([installation({ team_id: "T0SCALED" })], { fail: (c) => (c.kind === "select" && c.columns !== "id" ? { message: `boom ${SENTINELS.token} ${SENTINELS.email}`, code: "XX000" } : null) });
    // ui-8: marked readFailed, so the section never offers Connect over a connection it couldn't read.
    expect(await getSlackSettingsView(P)).toEqual(FAILED);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]).toEqual([`[exec-slack] settings view read failed for ${PRINCIPAL_ID} (getActiveInstallation, XX000)`]);
    expect(findSentinel(errors.mock.calls)).toBeNull();

    // The schema check itself failing, and the store throwing something else.
    vi.mocked(slackSchemaReady).mockRejectedValueOnce(new TypeError(`bad ${SENTINELS.token}`));
    expect(await getSlackSettingsView(P)).toEqual(FAILED);
    expect(errors.mock.calls[1]).toEqual([`[exec-slack] settings view read failed for ${PRINCIPAL_ID} (TypeError)`]);
    vi.mocked(slackSchemaReady).mockRejectedValueOnce("a string");
    expect(await getSlackSettingsView(P)).toEqual(FAILED);
    expect(errors.mock.calls[2]).toEqual([`[exec-slack] settings view read failed for ${PRINCIPAL_ID} (error)`]);
    expect(findSentinel(errors.mock.calls)).toBeNull();
  });

  it("a malformed row and a missing principal fail soft too", async () => {
    useDb([installation({ team_id: null })]);
    expect(await getSlackSettingsView(P)).toEqual(FAILED);
    expect(String(errors.mock.calls[0][0])).toContain("getActiveInstallation: malformed row");
    useDb([installation()]);
    expect(await getSlackSettingsView(null as unknown as ExecPrincipal)).toEqual(FAILED);
    expect(String(errors.mock.calls[1][0])).toBe("[exec-slack] settings view read failed for (none) (TypeError)");
  });

  it("passes the caller's signal to every read; an aborted read fails soft", async () => {
    useDb([installation()]);
    const signal = new AbortController().signal;
    await getSlackSettingsView(P, { signal });
    const selects = db.calls.filter((c) => c.kind === "select");
    expect(selects.length).toBe(2);
    for (const c of selects) expect(c.signal).toBe(signal);
    // P7a: the reading half gets the same signal.
    expect(vi.mocked(getSlackReadingView).mock.calls.at(-1)?.[2]).toEqual({ signal });
    const ac = new AbortController();
    ac.abort();
    expect(await getSlackSettingsView(P, { signal: ac.signal })).toEqual(FAILED);
    expect(String(errors.mock.calls.at(-1)?.[0])).toMatch(/\((AbortError|getActiveInstallation|slackSchemaReady)/);
  });

  it("getSettingsView carries it as view.slack, under the page's deadline (fail soft: the other sections don't matter)", async () => {
    useDb([installation()]);
    const view = await getSettingsView(P, new Date(NOW), { snapshot: { settings: { principalId: PRINCIPAL_ID, ...DEFAULT_SETTINGS }, version: null } });
    expect(view.slack).toEqual(withReading(connectedView()));
    expect(getSlackSettingsView).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getSlackSettingsView).mock.calls[0][0]).toBe(P);
    expect(vi.mocked(getSlackSettingsView).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    vi.mocked(getSlackSettingsView).mockResolvedValueOnce(errorView());
    expect((await getSettingsView(P, new Date(NOW), { snapshot: { settings: { principalId: PRINCIPAL_ID, ...DEFAULT_SETTINGS }, version: null } })).slack).toEqual(errorView());
  });
});

// ---------------------------------------------------------------------------
// The page: ?slack=, ?who= and the host (§3.13, C24, C25, C45)
// ---------------------------------------------------------------------------

describe("/executive/settings: the Slack params and the host", () => {
  const page = async (searchParams?: Record<string, string | string[] | undefined>) =>
    renderToStaticMarkup((await (searchParams === undefined ? ExecutiveSettingsPage({}) : ExecutiveSettingsPage({ searchParams }))) as Parameters<typeof renderToStaticMarkup>[0]);
  const HEADERS = new Headers({ host: "operations.scaledai.org" });

  beforeEach(() => {
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(P);
    vi.mocked(getSettingsView).mockResolvedValue(settingsView({ slack: connectedView() }));
    vi.mocked(headers).mockReturnValue(HEADERS as unknown as ReturnType<typeof headers>);
    vi.mocked(isCanonicalRequestHost).mockReturnValue(true);
  });

  it("the gate first; then the section with the validated result and who", async () => {
    const html = await page({ slack: "wrong_user", who: "U0OTHER" });
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/settings");
    expect(vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getSettingsView).mock.invocationCallOrder[0]);
    expect(textOf(bannerOf(html))).toBe(slackResultText("wrong_user", "U0OTHER"));
    expect(textOf(bannerOf(html))).toContain("U0OTHER");
    expect(textOf(bannerOf(await page({ slack: ["connected", "denied"] })))).toBe(SLACK_COPY.connectResult.connected);
  });

  it("an unknown code is ignored, a who that isn't a Slack id never shows, no params at all renders", async () => {
    expect(await page({ slack: "<script>alert(1)</script>" })).not.toContain("data-slack-result");
    const html = await page({ slack: "wrong_user", who: "<img src=x>" });
    expect(textOf(bannerOf(html))).toContain("Slack member — approved");
    expect(html).not.toContain("<img");
    for (const html2 of [await page(), await page({})]) {
      expect(html2).not.toContain("data-slack-result");
      expect(html2).toContain('data-slack-state="connected"');
    }
  });

  it("C45: the request's headers decide the link; unreadable headers mean no link; Next's own errors pass through", async () => {
    await page();
    expect(isCanonicalRequestHost).toHaveBeenCalledWith(HEADERS);
    vi.mocked(isCanonicalRequestHost).mockReturnValue(false);
    const off = await page();
    expect(startLinks(off)).toBe(0);
    expect(textOf(off)).toContain(SLACK_COPY.settingsWrongHost);
    vi.mocked(isCanonicalRequestHost).mockReturnValue(true);
    vi.mocked(headers).mockImplementation(() => {
      throw new Error("`headers` was called outside a request scope");
    });
    expect(startLinks(await page())).toBe(0);
    const dynamic = Object.assign(new Error("Dynamic server usage"), { digest: "DYNAMIC_SERVER_USAGE" });
    vi.mocked(headers).mockImplementation(() => {
      throw dynamic;
    });
    await expect(page()).rejects.toBe(dynamic);
  });

  it("SettingsPageView without the new props renders as before (Connect shown, no banner)", () => {
    const html = renderToStaticMarkup(createElement(SettingsPageView, { view: settingsView() }));
    expect(startLinks(html)).toBe(1);
    expect(html).not.toContain("data-slack-result");
    expect(textOf(html)).not.toContain("arrives with the Slack app");
    // The read-only card no longer names Slack.
    // P8 (AM-P8-15, forced): the brief moved to its own section, so the read-only card is "Email and drafts".
    expect(textOf(html)).toContain("Email and drafts");
  });
});

// ---------------------------------------------------------------------------
// B-P6-8 / rule 16: the client component's module graph
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** Every module a file reaches through value imports (type-only imports erased), with whether it is server-only. */
function reach(entry: string): { files: string[]; serverOnly: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const serverOnly: string[] = [];
  const bare = new Set<string>();
  const stack = [entry];
  const re = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    if (/^\s*import\s+["']server-only["']/m.test(src)) serverOnly.push(path.relative(SRC, file));
    for (const m of src.matchAll(re)) {
      const spec = m[4] ?? m[3];
      if (!m[4]) {
        const clause = m[2].trim();
        if (/^type\s/.test(clause)) continue;
        const braces = /^\{([\s\S]*)\}$/.exec(clause);
        if (braces && braces[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
      }
      const next = resolveImport(file, spec);
      if (next) stack.push(next);
      else bare.add(spec);
    }
  }
  return { files: [...seen].map((f) => path.relative(SRC, f).split(path.sep).join("/")), serverOnly, bare };
}

describe("B-P6-8: the Slack client component is client-safe", () => {
  it('SlackConnectControls starts with "use client" and reaches no server-only module; SlackSection holds no server module either', () => {
    const client = path.join(SRC, "components/exec/settings/SlackConnectControls.tsx");
    expect(readFileSync(client, "utf8").trimStart().startsWith('"use client";')).toBe(true);
    const r = reach(client);
    expect(r.serverOnly).toEqual([]);
    expect([...r.bare].sort()).toEqual(["lucide-react", "next/navigation", "react"]);
    expect(r.files).toEqual(expect.arrayContaining(["lib/exec/slack-copy.ts", "lib/exec/ui/settings-api.ts", "components/exec/drafts/frame-guard.ts"]));
    // The server section is presentational: nothing server-only in its graph (tests and the screenshot harness render it as is).
    expect(reach(path.join(SRC, "components/exec/settings/SlackSection.tsx")).serverOnly).toEqual([]);
    // The control: the walk does see a server-only module.
    expect(reach(path.join(SRC, "lib/exec/slack-settings.ts")).serverOnly.length).toBeGreaterThan(0);
  });
});
