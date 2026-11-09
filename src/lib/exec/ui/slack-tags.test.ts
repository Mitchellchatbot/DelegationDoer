import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })), notFound: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(() => new Headers({ host: "operations.scaledai.org" })) }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/settings", () => ({ getSettingsView: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()),
  slackIntelSchemaReady: vi.fn(),
  listChannelLinks: vi.fn()
}));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-reading")>()), listIntelChannels: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listClients: vi.fn(), listProjects: vi.fn() }));

import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { SettingsPageView } from "@/components/exec/settings/SettingsPageView";
import { SlackChannelPicker } from "@/components/exec/settings/SlackChannelPicker";
import {
  MAX_TAG_PROJECTS,
  SlackChannelTags,
  clientOptions,
  saveChannelTags,
  tagsBadge,
  tagsFailureMessage,
  tagsPath,
  toggleProject
} from "@/components/exec/settings/SlackChannelTags";
import { SlackReadingSection } from "@/components/exec/settings/SlackReadingSection";
import { SlackSection } from "@/components/exec/settings/SlackSection";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/exec/principal";
import { getSettingsView } from "@/lib/exec/settings";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { listChannelLinks, slackIntelSchemaReady } from "@/lib/exec/slack-intel-store";
import { getSlackPickerTags, taggableChannel, type SlackPickerTags } from "@/lib/exec/slack-page";
import { listIntelChannels } from "@/lib/exec/slack-reading";
import { listClients, listProjects } from "@/lib/exec/sources/dd";
import type { ExecSettings } from "@/lib/exec/types";
import * as settingsPage from "@/app/(main)/executive/settings/page";
import { pickerRow, settingsView, slackReadingView, slackSettingsView, textOf } from "../__tests__/p5a-ui-fixtures";
import { INTEL_SENTINELS, assertNoSlackLeak, captureConsole } from "../__tests__/slack-intel-assert";
import { CHANNEL_KEYS, NOW_ISO, TZ, channel, link, principal, type ChannelKey } from "../__tests__/p7b-ui-fixtures";

// P7b contract §5.13 UI12–UI13 (Area F; §3.12.4, §3.17.6 P7a-6, AM-P7b-6, C25): the picker's tags. The slot is a data
// prop (a function can't cross from the server section into the client picker); the server computes C25 on P7a's
// ChannelRow (getSlackPickerTags); SlackChannelTags renders the badge and the editor; the Settings page reads the tags
// beside its view and threads them SettingsPageView → SlackSection → SlackReadingSection → SlackChannelPicker.

const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);
const SETTINGS = { ...DEFAULT_SETTINGS, slackReadingSchemaReady: true } as ExecSettings;
const CLIENTS = [
  { id: "c_zeta", name: "Zeta Labs", active: true },
  { id: "c_acme", name: "Acme Dental", active: true },
  { id: "c_old", name: "Old Client", active: false }
];
const PROJECTS = Array.from({ length: 12 }, (_, i) => ({ id: `p_${i}`, name: `Project ${String(i).padStart(2, "0")}` }));
const TAGGED = link({ tagClientId: "c_acme", tagClientName: "Acme Dental", tagProjectIds: ["p_3", "p_1"], taggedAt: "2026-11-07T10:00:00.000Z",
  clientId: "c_acme", clientName: "Acme Dental", clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 });
const RULE_ONE = link({ clientId: "c_acme", clientName: "Acme Dental", clientMatchVia: "name", matchConfidence: "low", clientCandidates: 1 });
const RULE_MANY = link({ clientId: null, clientName: null, clientMatchVia: "name", matchConfidence: "low", clientCandidates: 3 });
const tags = (over: Partial<Parameters<typeof SlackChannelTags>[0]> = {}) =>
  html(createElement(SlackChannelTags, { channelId: "C0ACMESEO", taggable: true, links: TAGGED, clients: CLIENTS, projects: PROJECTS, initialOpen: true, ...over }));

let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  out = captureConsole();
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(slackIntelSchemaReady).mockResolvedValue(true);
  vi.mocked(listIntelChannels).mockResolvedValue(CHANNEL_KEYS.filter((k) => k !== "denyLead" && k !== "ddBotDm" && k !== "selfDm").map((k) => channel(k)));
  vi.mocked(listChannelLinks).mockResolvedValue(new Map([["C0ACMESEO", { ...TAGGED }], ["C0DESIGN", { ...RULE_ONE, channelId: "C0DESIGN" }]]));
  vi.mocked(listClients).mockResolvedValue([
    { id: "c_zeta", name: "Zeta Labs", status: "active" },
    { id: "c_acme", name: "Acme Dental", status: "" },
    { id: "c_old", name: "Old Client", status: "churned" },
    { id: "c_blank", name: "  ", status: "active" }
  ] as never);
  vi.mocked(listProjects).mockResolvedValue([
    { id: "p_b", name: "Beta launch", departmentId: null, createdAt: "2026-10-01T00:00:00Z" },
    { id: "p_a", name: "acme site rebuild", departmentId: null, createdAt: "2026-10-01T00:00:00Z" }
  ]);
});

afterEach(() => {
  assertNoSlackLeak({ console: out }, { label: "slack tags" });
});

describe("taggableChannel (C25, the predicate RPC 1 enforces)", () => {
  it("standard, external or finance; not a 1:1 DM; muted may be tagged, unwatched and left may not", () => {
    const expected: Record<ChannelKey, boolean> = {
      denyLead: false, hubOutbound: false, hubClientEmail: false, unclassified: false,
      publicWatched: true, publicUnwatched: false, privateWatched: true, leftPrivate: false, mpim: true, im: false,
      publicMuted: true, publicSlackMuted: true, financeMuted: true, financeWatched: true, externalShared: true,
      externalFinanceName: true, extEverUnshared: true, archived: true, ddBotDm: false, selfDm: false
    };
    for (const key of CHANNEL_KEYS) expect(taggableChannel(channel(key)), key).toBe(expected[key]);
    expect(taggableChannel(null)).toBe(false);
    expect(taggableChannel(channel("publicWatched", { class: "nope" as never }))).toBe(false);
    expect(taggableChannel(channel("publicWatched", { watchState: "nope" as never }))).toBe(false);
  });
});

describe("getSlackPickerTags (the server half)", () => {
  it("per conversation (deny and hubs left out): C25 and the stored link; the clients by name with their active flag; the projects by name", async () => {
    const t = (await getSlackPickerTags(principal)) as SlackPickerTags;
    expect(Object.keys(t.byChannel)).not.toContain("C0OUTBOUND");
    expect(Object.keys(t.byChannel)).not.toContain("C0EMAILHUB");
    expect(t.byChannel.C0ACMESEO).toEqual({ taggable: true, links: TAGGED });
    expect(t.byChannel.C0DESIGN.links?.clientMatchVia).toBe("name");
    expect(t.byChannel.C0RANDOM).toEqual({ taggable: false, links: null });
    expect(t.byChannel.C0LEFTPRIV.taggable).toBe(false);
    expect(t.byChannel.D0JANE.taggable).toBe(false);
    expect(t.clients).toEqual([
      { id: "c_acme", name: "Acme Dental", active: true },
      { id: "c_old", name: "Old Client", active: false },
      { id: "c_zeta", name: "Zeta Labs", active: true }
    ]);
    expect(t.projects).toEqual([{ id: "p_a", name: "acme site rebuild" }, { id: "p_b", name: "Beta launch" }]);
  });

  it("null with no read when the P7a schema flag is off or the P7b schema is missing", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...SETTINGS, slackReadingSchemaReady: false });
    expect(await getSlackPickerTags(principal)).toBeNull();
    expect(slackIntelSchemaReady).not.toHaveBeenCalled();
    vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
    vi.mocked(slackIntelSchemaReady).mockResolvedValue(false);
    expect(await getSlackPickerTags(principal)).toBeNull();
    for (const fn of [listIntelChannels, listChannelLinks, listClients, listProjects]) expect(fn).not.toHaveBeenCalled();
  });

  it("any read failing: null (never a half list), logged by the error's class only; it never throws", async () => {
    vi.mocked(listClients).mockRejectedValue(new TypeError(`DD read failed ${INTEL_SENTINELS.clientName}`));
    expect(await getSlackPickerTags(principal)).toBeNull();
    vi.mocked(loadSettings).mockRejectedValue(new Error("settings"));
    expect(await getSlackPickerTags(principal)).toBeNull();
    const lines = out.calls().map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("picker tags unavailable for ep_owner"))).toHaveLength(2);
    expect(lines.some((l) => l.includes("(TypeError)"))).toBe(true);
  });
});

describe("UI13: SlackChannelTags", () => {
  it("options come from the props: No client, then the active clients (the tagged one kept even if inactive)", () => {
    const markup = tags();
    const options = [...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([["", "No client"], ["c_zeta", "Zeta Labs"], ["c_acme", "Acme Dental"]]);
    expect(clientOptions(CLIENTS, "c_old").map((c) => c.id)).toEqual(["c_zeta", "c_acme", "c_old"]);
    expect(markup).toMatch(/<option value="c_acme" selected="">/);
    // The projects as checkboxes, the tagged ones first and checked.
    const boxes = [...markup.matchAll(/<input type="checkbox" data-tags-project="([^"]*)"([^>]*)>/g)].map((m) => [m[1], /checked=""/.test(m[2])]);
    expect(boxes.slice(0, 2)).toEqual([["p_1", true], ["p_3", true]]);
    expect(boxes).toHaveLength(PROJECTS.length);
    expect(boxes.slice(2).every(([, checked]) => checked === false)).toBe(true);
  });

  it("greyed when not taggable: 'Not taggable' and nothing to edit", () => {
    const markup = tags({ taggable: false });
    expect(textOf(markup)).toBe(SLACK_INTEL_COPY.tagsGreyed);
    expect(markup).toContain('data-tags-badge="greyed"');
    expect(markup).not.toMatch(/<select|<input|<button|<details/);
  });

  it("badges: a tag (High), the name rule's one client or N clients (Low), or none", () => {
    expect(textOf(tags({ links: TAGGED, initialOpen: false }))).toContain("Tagged: Acme Dental (High)");
    expect(textOf(tags({ links: RULE_ONE, initialOpen: false }))).toContain("Name suggests Acme Dental (Low)");
    expect(textOf(tags({ links: RULE_MANY, initialOpen: false }))).toContain("Name matches 3 clients (Low)");
    expect(tagsBadge(true, null)).toBeNull();
    expect(tagsBadge(true, link({ clientMatchVia: "name", matchConfidence: "low", clientCandidates: 0 }))).toBeNull();
    expect(tagsBadge(false, TAGGED)).toEqual({ text: SLACK_INTEL_COPY.tagsGreyed, confidence: null, greyed: true });
    expect(textOf(tags({ links: TAGGED, initialOpen: false }))).toContain("Project 01, Project 03");
  });

  it("UI13 (fixer ui-12, C2) a tag to a client that is no longer active: 'inactive client', greyed, no (High); still chosen in the editor", () => {
    const inactive = [{ id: TAGGED.tagClientId as string, name: "Acme Dental", active: false }];
    expect(tagsBadge(true, TAGGED, inactive)).toEqual({ text: "Tagged: Acme Dental (inactive client)", confidence: null, greyed: true });
    expect(tagsBadge(true, TAGGED, [{ ...inactive[0], active: true }])).toMatchObject({ confidence: "High", greyed: false });
    // An unknown client (not in the list) is read as before.
    expect(tagsBadge(true, TAGGED, [])).toMatchObject({ confidence: "High" });
    const markup = tags({ links: TAGGED, clients: inactive, initialOpen: false });
    expect(textOf(markup)).toContain("Tagged: Acme Dental (inactive client)");
    expect(textOf(markup)).not.toContain("(High)");
    expect(markup).toContain('data-tags-badge="greyed"');
  });

  it("closed by default; open only on a static render that asks for it", () => {
    expect(tags({ initialOpen: false })).toMatch(/<details data-tags="C0ACMESEO" data-tags-taggable="true" class=/);
    expect(tags({ initialOpen: true })).toMatch(/<details[^>]*open=""/);
  });

  it("framed: read-only text (the badge, the projects, the framed line), nothing to click", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    const markup = tags();
    expect(markup).not.toMatch(/<select|<input|<button/);
    expect(textOf(markup)).toContain(SLACK_INTEL_COPY.tagsFramed);
    expect(textOf(markup)).toContain("Tagged: Acme Dental (High)");
  });

  it("each save state's words", () => {
    expect(tagsFailureMessage(409)).toBe(SLACK_INTEL_COPY.tagsNotTaggable);
    expect(tagsFailureMessage(422)).toBe(SLACK_INTEL_COPY.tagsUnknown);
    expect(tagsFailureMessage(429)).toBe(SLACK_INTEL_COPY.tagsRateLimited);
    for (const s of [0, 400, 403, 404, 413, 500, 503]) expect(tagsFailureMessage(s), String(s)).toBe(SLACK_INTEL_COPY.tagsError);
  });

  it("saveChannelTags: PUT { clientId, projectIds } (≤ 10, deduped) to the links route; the answers", async () => {
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    const saved = answer(200, { links: TAGGED });
    const ids = [...PROJECTS.map((p) => p.id), "p_1"];
    expect(await saveChannelTags("C0ACMESEO", { clientId: "c_acme", projectIds: ids }, saved)).toEqual({ kind: "saved", links: TAGGED });
    const [url, init] = saved.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/exec/slack/channels/C0ACMESEO/links");
    expect(url).toBe(tagsPath("C0ACMESEO"));
    expect(init).toMatchObject({ method: "PUT", credentials: "same-origin" });
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["clientId", "projectIds"]);
    expect(body.projectIds).toHaveLength(MAX_TAG_PROJECTS);
    expect(await saveChannelTags("C0ACMESEO", { clientId: null, projectIds: [] }, answer(200, { links: null }))).toEqual({ kind: "saved", links: null });
    expect(await saveChannelTags("C0ACMESEO", { clientId: null, projectIds: [] }, answer(200, { links: { channelId: "C0OTHER", tagProjectIds: [], clientCandidates: 0 } }))).toEqual({ kind: "saved", links: null });
    for (const [status, text] of [[409, SLACK_INTEL_COPY.tagsNotTaggable], [422, SLACK_INTEL_COPY.tagsUnknown], [429, SLACK_INTEL_COPY.tagsRateLimited], [503, SLACK_INTEL_COPY.tagsError]] as const) {
      expect(await saveChannelTags("C0ACMESEO", { clientId: "c_acme", projectIds: [] }, answer(status, { error: "x" }))).toEqual({ kind: "failed", status, message: text });
    }
    expect(await saveChannelTags("C0ACMESEO", { clientId: null, projectIds: [] }, vi.fn(async () => { throw new TypeError("offline"); }))).toEqual({ kind: "failed", status: 0, message: SLACK_INTEL_COPY.tagsError });
    const never = vi.fn();
    expect((await saveChannelTags("../x", { clientId: null, projectIds: [] }, never)).kind).toBe("failed");
    expect(never).not.toHaveBeenCalled();
  });

  it("toggleProject keeps at most 10; at 10 the unchecked boxes are disabled", () => {
    const ten = PROJECTS.slice(0, 10).map((p) => p.id);
    expect(toggleProject(ten, "p_11", true)).toEqual(ten);
    expect(toggleProject(ten, "p_0", false)).toEqual(ten.slice(1));
    expect(toggleProject([], "p_1", true)).toEqual(["p_1"]);
    const markup = tags({ links: { ...TAGGED, tagProjectIds: ten } });
    const disabled = [...markup.matchAll(/<input type="checkbox" data-tags-project="([^"]*)"([^>]*)>/g)].filter((m) => /disabled=""/.test(m[2])).map((m) => m[1]);
    expect(disabled.sort()).toEqual(["p_10", "p_11"]);
  });
});

describe("UI12 (P7a-6): the picker renders SlackChannelTags per row through its tags data prop", () => {
  const VIEW = slackReadingView({
    state: "on",
    channels: [
      pickerRow({ channelId: "C0ACMESEO", name: "acme-dental-seo" }),
      pickerRow({ channelId: "C0DESIGN", name: "design", watchState: "muted", muteSource: "owner" }),
      pickerRow({ channelId: "C0RANDOM", name: "random", watchState: "unwatched", isMember: false }),
      pickerRow({ channelId: "C0NOTAGS", name: "no-entry" })
    ],
    counts: { watched: 2, muted: 1, unwatched: 1, never: 0, neverByReason: {}, hubs: 0, dms: { watched: 0, total: 0 }, groupDms: { watched: 0, total: 0 } }
  });
  const TAGS: SlackPickerTags = {
    byChannel: { C0ACMESEO: { taggable: true, links: TAGGED }, C0DESIGN: { taggable: true, links: RULE_ONE }, C0RANDOM: { taggable: false, links: null } },
    clients: CLIENTS,
    projects: PROJECTS
  };

  it("a row with an entry gets its tags under it; a row without one gets none; Don't watch is greyed", () => {
    const markup = html(createElement(SlackChannelPicker, { view: VIEW, tags: TAGS }));
    for (const id of ["C0ACMESEO", "C0DESIGN", "C0RANDOM"]) {
      const li = markup.slice(markup.indexOf(`data-picker-row="${id}"`), markup.indexOf("</li>", markup.indexOf(`data-picker-row="${id}"`)));
      expect(li, id).toContain(`data-tags="${id}"`);
    }
    expect(markup).not.toContain('data-tags="C0NOTAGS"');
    expect(markup).toContain('data-tags="C0RANDOM" data-tags-taggable="false"');
    expect(textOf(markup)).toContain("Tagged: Acme Dental (High)");
    expect(textOf(markup)).toContain("Name suggests Acme Dental (Low)");
    // A row he set to Don't watch here is greyed at once, whatever the server said.
    const flipped = html(createElement(SlackChannelPicker, { view: { ...VIEW, channels: [pickerRow({ channelId: "C0ACMESEO", watchState: "unwatched" })] }, tags: TAGS }));
    expect(flipped).toContain('data-tags="C0ACMESEO" data-tags-taggable="false"');
  });

  it("without tags (null or absent) the picker is P7a's, unchanged", () => {
    const plain = html(createElement(SlackChannelPicker, { view: VIEW }));
    expect(html(createElement(SlackChannelPicker, { view: VIEW, tags: null }))).toBe(plain);
    expect(plain).not.toContain("data-tags");
  });

  it("the static-render seam opens one row's editor", () => {
    const markup = html(createElement(SlackChannelPicker, { view: VIEW, tags: TAGS, initialTagsOpen: "C0DESIGN" }));
    expect(markup).toMatch(/<details data-tags="C0DESIGN"[^>]*open=""/);
    expect(markup).not.toMatch(/<details data-tags="C0ACMESEO"[^>]*open=""/);
  });

  it("the tags travel SettingsPageView → SlackSection → SlackReadingSection → the picker", () => {
    const reading = html(createElement(SlackReadingSection, { view: VIEW, tz: TZ, now: NOW_ISO, tags: TAGS }));
    expect(reading).toContain('data-tags="C0ACMESEO"');
    expect(html(createElement(SlackReadingSection, { view: VIEW, tz: TZ, now: NOW_ISO }))).not.toContain("data-tags");
    const slack = slackSettingsView({ state: "connected", installationId: "esi_0123456789abcdef0123456789abcdef", teamId: "T0SCALED", dmChannelId: "D0MITCH", userId: "U0MITCH", installedAt: "2026-11-01T14:30:00.000Z", reading: VIEW });
    expect(html(createElement(SlackSection, { view: slack, tz: TZ, now: NOW_ISO, tags: TAGS }))).toContain('data-tags="C0DESIGN"');
    expect(html(createElement(SettingsPageView, { view: settingsView({ slack }), slackTags: TAGS }))).toContain('data-tags="C0RANDOM"');
    expect(html(createElement(SettingsPageView, { view: settingsView({ slack }) }))).not.toContain("data-tags");
  });

  it("the Settings page reads the tags beside its view, after the gate, and hands them down", async () => {
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    const slack = slackSettingsView({ state: "connected", installationId: "esi_0123456789abcdef0123456789abcdef", teamId: "T0SCALED", dmChannelId: "D0MITCH", userId: "U0MITCH", installedAt: "2026-11-01T14:30:00.000Z", reading: slackReadingView({ ...VIEW, channels: [pickerRow({ channelId: "C0ACMESEO" })] }) });
    vi.mocked(getSettingsView).mockResolvedValue(settingsView({ slack }));
    const markup = html(await settingsPage.default({ searchParams: {} }));
    expect(vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(loadSettings).mock.invocationCallOrder[0]);
    expect(markup).toContain('data-tags="C0ACMESEO"');
    expect(textOf(markup)).toContain("Tagged: Acme Dental (High)");
    // The tags failing leave the page as it was, without tags.
    vi.mocked(listIntelChannels).mockRejectedValue(new Error("read failed"));
    const without = html(await settingsPage.default({ searchParams: {} }));
    expect(without).not.toContain("data-tags");
    expect(without).toContain("data-picker-row");
  });
});
