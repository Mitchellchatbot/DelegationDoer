import { createHash } from "node:crypto";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => false) }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));
// Area A's store, Area C's digests and P7a's facade at their module boundary.
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()),
  slackIntelState: vi.fn(),
  listProjectItemIds: vi.fn(),
  listChannelsLinkedToClient: vi.fn(),
  searchSlackStored: vi.fn()
}));
vi.mock("@/lib/exec/slack-digests", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-digests")>()), listDigestViews: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reading")>()),
  listIntelChannels: vi.fn(),
  getSlackItemsByIds: vi.fn()
}));
// projects-view.ts's own reads (for the wiring of §3.17.4); the section itself is mocked there and real here.
vi.mock("@/lib/exec/slack-projects", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/slack-projects")>();
  return { ...actual, getProjectSlackSection: vi.fn(actual.getProjectSlackSection) };
});
vi.mock("@/lib/exec/sources/dd", () => ({
  listActivitySince: vi.fn(),
  listClients: vi.fn(),
  listDepartments: vi.fn(),
  listOpenTasks: vi.fn(),
  listProjects: vi.fn(),
  listProjectStages: vi.fn(),
  listProjectTasksAllStates: vi.fn(),
  listStatusChangeEntries: vi.fn(),
  listStatusTransitions: vi.fn(),
  listTaskExtensionsForTasks: vi.fn(),
  listTaskMessagesSince: vi.fn(),
  listTasksCompletedBetween: vi.fn(),
  listUsers: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd-text", () => ({ listMeetingBriefRisks: vi.fn() }));
vi.mock("@/lib/exec/ddtext-store", () => ({ listLiveDdtextSignals: vi.fn() }));
vi.mock("@/lib/exec/email-store", () => ({ listBucketRows: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));

import { ProjectDetailPageView } from "@/components/exec/projects/ProjectDetailPageView";
import { ProjectSlackSection } from "@/components/exec/slack/ProjectSlackSection";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/exec/principal";
import { getProjectDetail } from "@/lib/exec/projects-view";
import { listDigestViews } from "@/lib/exec/slack-digests";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { listChannelsLinkedToClient, listProjectItemIds, searchSlackStored, slackIntelState } from "@/lib/exec/slack-intel-store";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";
import { getProjectSlackSection, summaryNames, type ProjectSlackSection as ProjectSlackModel } from "@/lib/exec/slack-projects";
import { getSlackItemsByIds, listIntelChannels } from "@/lib/exec/slack-reading";
import * as dd from "@/lib/exec/sources/dd";
import { listMeetingBriefRisks } from "@/lib/exec/sources/dd-text";
import type { ExecSettings } from "@/lib/exec/types";
import type { DerivedClient, ProjectDetailView, Section } from "@/lib/exec/view-types";
import { projectDetailView, textOf } from "../__tests__/p5a-ui-fixtures";
import { INTEL_SENTINELS, assertNoSlackLeak, captureConsole } from "../__tests__/slack-intel-assert";
import { NOW, NOW_ISO, TZ, channel, digestCard, link, principal, projectRow, projectSlack, slackItem } from "../__tests__/p7b-ui-fixtures";

// P7b contract §5.13 PJ01–PJ08 (Area F): the Projects tab's Slack section (getProjectSlackSection over mocked Areas A/C
// and P7a's facade), its card (ProjectSlackSection) and the P5a wiring (projects-view.ts races it; ProjectDetailPageView
// renders it after Conversations).

const DAY = 86_400_000;
const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);
const SETTINGS = { ...DEFAULT_SETTINGS, slackReadingSchemaReady: true, slackReadingEnabled: true } as ExecSettings;
const DERIVED: DerivedClient = { clientId: "c_acme", clientName: "Acme Dental", taskCount: 4, namedTaskCount: 5, share: 0.8, basis: "derived" };
const Q = { projectId: "p_acme", projectName: "Acme site rebuild", taskIds: ["t_1", "t_2"], derivedClient: DERIVED };
const CHANNELS = ["publicWatched", "publicMuted", "publicUnwatched", "financeWatched", "externalShared", "privateWatched", "publicSlackMuted"].map((k) =>
  channel(k as Parameters<typeof channel>[0])
);
const NON_OK: SlackIntelState[] = ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"];

let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  out = captureConsole();
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(listProjectItemIds).mockResolvedValue([]);
  vi.mocked(listChannelsLinkedToClient).mockResolvedValue([]);
  vi.mocked(searchSlackStored).mockResolvedValue([]);
  vi.mocked(listDigestViews).mockResolvedValue([]);
  vi.mocked(listIntelChannels).mockResolvedValue(CHANNELS);
  vi.mocked(getSlackItemsByIds).mockResolvedValue([]);
});

afterEach(() => {
  assertNoSlackLeak({ console: out }, { label: "projects slack" });
});

// ---------------------------------------------------------------------------
// The data
// ---------------------------------------------------------------------------

describe("getProjectSlackSection: the state gate", () => {
  for (const state of NON_OK) {
    it(`${state}: only the state is read; empty groups; the derived client's name kept`, async () => {
      vi.mocked(slackIntelState).mockResolvedValue(state);
      const s = await getProjectSlackSection(principal, SETTINGS, Q, { now: NOW });
      expect(s).toEqual({ state, linked: [], clientChannels: [], mentions: [], derivedClientName: "Acme Dental" });
      for (const fn of [listProjectItemIds, listChannelsLinkedToClient, searchSlackStored, listDigestViews, listIntelChannels, getSlackItemsByIds]) expect(fn).not.toHaveBeenCalled();
    });
  }
});

describe("getProjectSlackSection: Linked to this project's work (record)", () => {
  it("RPC 4 over 30 days (3 × 10), the facade's screened items, slackItemPolicy('page'), ≤ 10 newest first, summaries only", async () => {
    const items = Array.from({ length: 12 }, (_, i) => slackItem({ ts: `${1794100000 + i}.000100`, excerpt: INTEL_SENTINELS.excerpt, summary: `Linked item ${i}` }));
    const muted = slackItem({ channelId: "C0DESIGN", bypassMute: false, ts: "1794200000.000100" });
    const unassessed = slackItem({ assessed: false, summary: null, excerpt: null, ts: "1794200001.000100" });
    const finance = slackItem({ channelId: "C0PAYROLL", sourceClass: "finance", ts: "1794200002.000100", summary: "Payroll timing." });
    vi.mocked(listProjectItemIds).mockResolvedValue([...items, muted, unassessed, finance].map((i, n) => ({ itemId: i.id, via: n === 0 ? "thread" : n === 1 ? "tag" : "link", at: new Date(NOW.getTime() - n * 1000).toISOString() })));
    vi.mocked(getSlackItemsByIds).mockResolvedValue([...items, muted, unassessed, finance]);
    const s = await getProjectSlackSection(principal, SETTINGS, { ...Q, derivedClient: null }, { now: NOW });
    expect(listProjectItemIds).toHaveBeenCalledWith(principal, { projectId: "p_acme", taskIds: ["t_1", "t_2"], sinceIso: new Date(NOW.getTime() - 30 * DAY).toISOString(), limit: 30 }, { signal: undefined });
    expect(vi.mocked(getSlackItemsByIds).mock.calls[0][2]).toEqual({ surface: "web", signal: undefined });
    expect(s.linked).toHaveLength(10);
    expect(s.linked[0]).toMatchObject({ itemId: finance.id, privacy: "finance", basis: "record", via: "link", summary: "Payroll timing.", digestId: null });
    expect(s.linked.map((r) => r.itemId)).not.toContain(muted.id);
    expect(s.linked.map((r) => r.itemId)).not.toContain(unassessed.id);
    expect(s.linked.slice(1).map((r) => r.itemId)).toEqual(items.slice(3).reverse().map((i) => i.id));
    expect(JSON.stringify(s)).not.toContain(INTEL_SENTINELS.excerpt);
    expect(Object.keys(s.linked[0]).sort()).toEqual(["at", "basis", "channelLabel", "digestId", "itemId", "kind", "permalink", "privacy", "summary", "via"]);
    // No derived client: nothing about a client is read.
    expect(listChannelsLinkedToClient).not.toHaveBeenCalled();
    expect(listDigestViews).not.toHaveBeenCalled();
  });
});

describe("getProjectSlackSection: In <client>'s channels (derived)", () => {
  it("the client's high links → RPC 5 with an empty query over the allowed ones (watched full, owner/Slack-muted bypass), ≤ 10 items + ≤ 5 built digests", async () => {
    vi.mocked(listChannelsLinkedToClient).mockResolvedValue([
      link({ channelId: "C0ACMESEO", tagClientId: "c_acme", tagClientName: "Acme Dental", clientId: "c_acme", clientName: "Acme Dental", clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 }),
      link({ channelId: "C0DESIGN", tagClientId: "c_acme", tagClientName: "Acme Dental", clientId: "c_acme", clientName: "Acme Dental", clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 }),
      link({ channelId: "C0RANDOM", tagClientId: "c_acme", tagClientName: "Acme Dental", clientId: "c_acme", clientName: "Acme Dental", clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 }),
      // A different client's or a low verdict never counts.
      link({ channelId: "C0PRIVOPS", clientId: "c_other", clientName: "Other", clientMatchVia: "tag", matchConfidence: "high", clientCandidates: 1 })
    ]);
    const linkedItem = slackItem({ ts: "1794149000.000100", summary: "Already linked." });
    const clientItems = Array.from({ length: 12 }, (_, i) => slackItem({ ts: `${1794100000 + i}.000100`, summary: `Client item ${i}` }));
    const bypassItem = slackItem({ channelId: "C0DESIGN", bypassMute: true, ts: "1794120000.000100", summary: "Urgent in a muted channel." });
    vi.mocked(listProjectItemIds).mockResolvedValue([{ itemId: linkedItem.id, via: "link", at: NOW_ISO }]);
    vi.mocked(searchSlackStored).mockImplementation(async (_p, q) =>
      q.query === "" ? [linkedItem, ...clientItems, bypassItem].map((i) => ({ src: "item" as const, id: i.id, channelId: i.channelId, rank: 0, at: NOW_ISO })) : []
    );
    vi.mocked(getSlackItemsByIds).mockResolvedValue([linkedItem, ...clientItems, bypassItem]);
    vi.mocked(listDigestViews).mockResolvedValue([
      ...Array.from({ length: 7 }, (_, i) => digestCard({ digestId: `esd_${String(i).padStart(32, "0")}`, date: `2026-11-0${7 - (i % 6)}`, summary: `Digest ${i}` })),
      digestCard({ digestId: null, status: "not_built", summary: null, date: "2026-11-08" }),
      digestCard({ digestId: "esd_ffffffffffffffffffffffffffffffff", status: "failed", summary: null })
    ]);
    const s = await getProjectSlackSection(principal, SETTINGS, Q, { now: NOW });
    expect(listChannelsLinkedToClient).toHaveBeenCalledWith(principal, "c_acme", ["high"], { signal: undefined });
    const empty = vi.mocked(searchSlackStored).mock.calls.find((c) => c[1].query === "")?.[1];
    expect(empty).toMatchObject({ channelIds: ["C0ACMESEO"], bypassChannelIds: ["C0DESIGN"], kinds: null, includeDigests: false, limit: 30 });
    const [, state, dq] = vi.mocked(listDigestViews).mock.calls[0];
    expect(state).toBe("ok");
    expect(dq).toMatchObject({ channelIds: ["C0ACMESEO", "C0DESIGN", "C0RANDOM"], use: "page" });
    expect(dq.dates).toEqual(["2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02"]);
    const items = s.clientChannels.filter((r) => r.kind !== "digest");
    const digests = s.clientChannels.filter((r) => r.kind === "digest");
    expect(items).toHaveLength(10);
    expect(items.map((r) => r.itemId)).not.toContain(linkedItem.id);
    expect(items.every((r) => r.basis === "derived" && r.via === "client_channel")).toBe(true);
    expect(digests).toHaveLength(5);
    expect(digests.every((r) => r.itemId === null && r.digestId !== null && r.basis === "derived" && r.permalink === null)).toBe(true);
    expect(s.derivedClientName).toBe("Acme Dental");
    // Newest first across items and digests.
    const times = s.clientChannels.map((r) => Date.parse(r.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("getProjectSlackSection: Mentions (AI-assessed)", () => {
  it("RPC 5 with each name (≥ 4 characters) as a phrase; kept only when the summary names it, word-bounded; ≤ 5; never one already shown", async () => {
    const hit = (summary: string, ts: string) => slackItem({ summary, ts });
    const project = hit("Asked about the Acme site rebuild schedule.", "1794140000.000100");
    const client = hit("ACME DENTAL wants a call.", "1794140001.000100");
    const partial = hit("The acme dentalcare team called.", "1794140002.000100");
    const excerptOnly = hit("Asked about the launch.", "1794140003.000100");
    const many = Array.from({ length: 6 }, (_, i) => hit(`Acme Dental update ${i}`, `${1794130000 + i}.000100`));
    vi.mocked(searchSlackStored).mockImplementation(async (_p, q) => (q.query === "" ? [] : [project, client, partial, excerptOnly, ...many].map((i) => ({ src: "item" as const, id: i.id, channelId: i.channelId, rank: 1, at: NOW_ISO }))));
    vi.mocked(getSlackItemsByIds).mockResolvedValue([project, client, partial, excerptOnly, ...many]);
    const s = await getProjectSlackSection(principal, SETTINGS, Q, { now: NOW });
    const queries = vi.mocked(searchSlackStored).mock.calls.map((c) => c[1]).filter((q) => q.query !== "");
    expect(queries.map((q) => q.query).sort()).toEqual(['"Acme Dental"', '"Acme site rebuild"']);
    for (const q of queries) {
      expect([...q.channelIds].sort()).toEqual(["C0ACMESEO", "C0PARTNER", "C0PAYROLL", "C0PRIVOPS"]);
      expect([...q.bypassChannelIds].sort()).toEqual(["C0DESIGN", "C0LAUNCH"]);
      expect(q).toMatchObject({ includeDigests: false, kinds: null });
    }
    expect(s.mentions.map((r) => r.itemId)).toEqual([client.id, project.id, many[5].id, many[4].id, many[3].id]);
    expect(s.mentions.every((r) => r.basis === "ai" && r.via === "mention")).toBe(true);
    expect(s.mentions.map((r) => r.itemId)).not.toContain(partial.id);
    expect(s.mentions.map((r) => r.itemId)).not.toContain(excerptOnly.id);
  });

  it("a name under 4 characters is never searched; a mention already linked isn't repeated", async () => {
    const linkedItem = slackItem({ summary: "The Acme site rebuild is late." });
    vi.mocked(listProjectItemIds).mockResolvedValue([{ itemId: linkedItem.id, via: "link", at: NOW_ISO }]);
    vi.mocked(searchSlackStored).mockResolvedValue([{ src: "item", id: linkedItem.id, channelId: linkedItem.channelId, rank: 1, at: NOW_ISO }]);
    vi.mocked(getSlackItemsByIds).mockResolvedValue([linkedItem]);
    const s = await getProjectSlackSection(principal, SETTINGS, { ...Q, derivedClient: { ...DERIVED, clientName: "Abc" } }, { now: NOW });
    expect(vi.mocked(searchSlackStored).mock.calls.map((c) => c[1].query)).toEqual(['"Acme site rebuild"']);
    expect(s.linked.map((r) => r.itemId)).toEqual([linkedItem.id]);
    expect(s.mentions).toEqual([]);
  });

  it("summaryNames: word-bounded and case-insensitive, any script, regex characters literal", () => {
    expect(summaryNames("Re: the ACME site rebuild.", "Acme site rebuild")).toBe(true);
    expect(summaryNames("acmesite rebuild", "Acme site")).toBe(false);
    expect(summaryNames("(C++ Labs) asked", "C++ Labs")).toBe(true);
    expect(summaryNames("Zürich team", "Zürich")).toBe(true);
    expect(summaryNames("Zürichsee", "Zürich")).toBe(false);
  });

  it("any read failing throws (the caller's card says Couldn't load)", async () => {
    vi.mocked(searchSlackStored).mockRejectedValue(new Error("exec slack intel store: searchSlackStored failed"));
    await expect(getProjectSlackSection(principal, SETTINGS, Q, { now: NOW })).rejects.toThrow("searchSlackStored failed");
  });
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

const card = (section: Section<ProjectSlackModel> | undefined, derivedNote: string | null = "Derived from 4 of 5 tasks that name a client") =>
  html(createElement(ProjectSlackSection, { section, derivedNote, tz: TZ, now: NOW_ISO }));

describe("PJ01–PJ07: the Slack card", () => {
  it("PJ01: three groups in order, with their titles and basis labels; rows show chip, kind, channel, AI summary, Open in Slack", () => {
    const out = card({ ok: true, data: projectSlack() });
    const order = ["linked", "client", "mentions"].map((g) => out.indexOf(`data-project-slack-group="${g}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const text = textOf(out);
    expect(text).toContain(SLACK_INTEL_COPY.projectSection);
    expect(text).toContain(SLACK_INTEL_COPY.projectLinked);
    expect(text).toContain("In Acme's channels");
    expect(text).toContain(SLACK_INTEL_COPY.projectMentions);
    const group = (g: string) => out.slice(out.indexOf(`data-project-slack-group="${g}"`), out.indexOf("</ul>", out.indexOf(`data-project-slack-group="${g}"`)));
    expect(textOf(group("linked"))).toContain("Record");
    expect(textOf(group("client"))).toContain("Derived");
    expect(textOf(group("mentions"))).toContain("AI-assessed");
    expect(text).toContain("Asks for the launch checklist.");
    expect(text).toContain("Public");
    expect(text).toContain("Request");
    expect(text).toContain("#acme-dental-seo");
    expect(text).toContain(SLACK_INTEL_COPY.openInSlack);
  });

  it("PJ02: the derived client line under the client group; no client group without a derived client", () => {
    const out = card({ ok: true, data: projectSlack() });
    expect(out).toContain("data-project-slack-derived");
    expect(textOf(out)).toContain("Derived from 4 of 5 tasks that name a client");
    const none = card({ ok: true, data: projectSlack({ derivedClientName: null }) });
    expect(none).not.toContain('data-project-slack-group="client"');
  });

  it("PJ03: mentions are a <details>, closed by default", () => {
    const out = card({ ok: true, data: projectSlack() });
    const tag = out.match(/<details[^>]*data-project-slack-group="mentions"[^>]*>/)?.[0] ?? "";
    expect(tag).not.toBe("");
    expect(tag).not.toMatch(/\sopen/);
  });

  it("PJ04: nothing linked, no client channel, no mention → the empty copy", () => {
    const out = card({ ok: true, data: projectSlack({ linked: [], clientChannels: [], mentions: [] }) });
    expect(textOf(out)).toContain(SLACK_INTEL_COPY.projectEmpty);
    expect(out).not.toContain("data-project-slack-group");
  });

  it("PJ05: a state other than ok shows its sentence and no group", () => {
    for (const state of NON_OK) {
      const out = card({ ok: true, data: projectSlack({ state }) });
      expect(textOf(out), state).toContain(SLACK_INTEL_COPY.state[state as keyof typeof SLACK_INTEL_COPY.state]);
      expect(out, state).not.toContain("data-project-slack-group");
    }
  });

  it("PJ06: summaries only: a row has no excerpt field and the card renders no quote", async () => {
    expect(Object.keys(projectRow())).not.toContain("excerpt");
    const item = slackItem({ excerpt: INTEL_SENTINELS.excerpt, authorLabel: INTEL_SENTINELS.authorName, authorUserId: "U0SENTINEL", summary: "A linked request." });
    vi.mocked(listProjectItemIds).mockResolvedValue([{ itemId: item.id, via: "link", at: NOW_ISO }]);
    vi.mocked(getSlackItemsByIds).mockResolvedValue([item]);
    const s = await getProjectSlackSection(principal, SETTINGS, { ...Q, derivedClient: null }, { now: NOW });
    const out = card({ ok: true, data: s });
    expect(textOf(out)).toContain("A linked request.");
    for (const needle of [INTEL_SENTINELS.excerpt, INTEL_SENTINELS.authorName, "U0SENTINEL", "blockquote"]) expect(out, needle).not.toContain(needle);
  });

  it("PJ07: a failed read is the card's Couldn't load; no section (a view before P7b) renders nothing", () => {
    expect(textOf(card({ ok: false, error: "unavailable" }))).toContain("Couldn't load this section right now.");
    expect(card(undefined)).toBe("");
  });

  it("a digest row shows its kind and the day; hostile summaries render as text", () => {
    const hostile = "<img src=x onerror=alert(1)> [x](https://evil.example)";
    const out = card({ ok: true, data: projectSlack({ linked: [projectRow({ kind: "digest", itemId: null, digestId: "esd_1", summary: hostile, permalink: null })], clientChannels: [], mentions: [] }) });
    expect(textOf(out)).toContain("Digest");
    expect(out).not.toMatch(/<img|href="https:\/\/evil/);
  });
});

// ---------------------------------------------------------------------------
// P5a's page and service (§3.17.4)
// ---------------------------------------------------------------------------

const stripTabs = (markup: string) => markup.replace(/<nav aria-label="Executive AI Assistant"[\s\S]*?<\/nav>/, "<nav/>");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("PJ08: P5a's other sections are unchanged", () => {
  // sha256 of P5a's fixture page (projectDetailView(), no slack section) rendered by base 1134fbc's ProjectDetailPageView,
  // with the tab strip cut out (P7b adds the Slack tab there): computed once against the base file (Area F's stage-1
  // golden check: <sp>/p7b-F/pj08-golden.README.txt).
  const BASE_SHA = "20d897078bd9dcce7f82856812f2749e1a0fb356f50ac9275762aae31d45e323";

  // P9 F5 (flip): three tones changed on this page for WCAG AA, and nothing else: the Private pill (slate-500 → slate-600)
  // and the neutral badges (the global badge-low, 4.34:1 → NEUTRAL_BADGE). Undoing exactly those gives P5a's base back.
  // P9 F25 likewise spaces the task lists' links 10 px apart below sm (space-y-2.5 sm:space-y-1; it was space-y-1) and makes
  // a source link chip 40 px tall below sm (min-h-10 … sm:min-h-0).
  const undoP9Tones = (markup: string) =>
    markup
      .replace('text-slate-600">Private', 'text-slate-500">Private')
      .split('class="badge border-slate-200 bg-slate-100 text-slate-600"')
      .join('class="badge badge-low"')
      .split('class="mt-1 space-y-2.5 sm:space-y-1"')
      .join('class="mt-1 space-y-1"')
      .split("text-slate-600 min-h-10 transition-colors hover:border-slate-300 hover:text-ink sm:min-h-0")
      .join("text-slate-600 transition-colors hover:border-slate-300 hover:text-ink");

  it("a view without the section renders P5a's page exactly (the base golden, tabs aside; P9's AA tones undone)", () => {
    const out = html(createElement(ProjectDetailPageView, { view: projectDetailView() }));
    expect(out).toContain('text-slate-600">Private');
    expect(out).not.toContain("badge-low");
    expect(sha(undoP9Tones(stripTabs(out)))).toBe(BASE_SHA);
  });

  it("with the section, the page is P5a's plus the Slack card after Conversations, nothing else moved", () => {
    const base = html(createElement(ProjectDetailPageView, { view: projectDetailView() }));
    const withSlack = html(createElement(ProjectDetailPageView, { view: projectDetailView({ slack: { ok: true, data: projectSlack() } }) }));
    const cardMarkup = card({ ok: true, data: projectSlack() }, "Derived from 4 of 5 tasks that name a client");
    expect(withSlack).toContain(cardMarkup);
    expect(withSlack.replace(cardMarkup, "")).toBe(base);
    expect(withSlack.indexOf(cardMarkup)).toBeGreaterThan(withSlack.indexOf("Email threads with the derived client"));
  });
});

describe("§3.17.4: getProjectDetail fills slack, raced and failing soft", () => {
  const PROJECT = { id: "p_acme", name: "Acme site rebuild", departmentId: null, createdAt: "2026-10-01T15:00:00.000Z" };
  const task = (id: string, clientName: string | null) => ({
    id, title: `Task ${id}`, status: "pending", priority: "normal", dueDate: null, createdAt: "2026-10-02T15:00:00.000Z", completedAt: null,
    lastActivityAt: "2026-11-01T15:00:00.000Z", projectId: "p_acme", clientName, assigneeId: null, creatorId: "u_1", departmentId: null,
    tags: [], isDraft: false, deletedAt: null, archivedAt: null, archivedBy: null, estimatedHours: null, stageId: null, flowGroup: null
  });

  beforeEach(() => {
    vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
    vi.mocked(dd.listProjects).mockResolvedValue([PROJECT]);
    vi.mocked(dd.listProjectStages).mockResolvedValue([]);
    vi.mocked(dd.listProjectTasksAllStates).mockResolvedValue(["t_1", "t_2", "t_3"].map((id) => task(id, "Acme Dental")) as never);
    vi.mocked(dd.listUsers).mockResolvedValue([]);
    vi.mocked(dd.listDepartments).mockResolvedValue([]);
    vi.mocked(dd.listClients).mockResolvedValue([{ id: "c_acme", name: "Acme Dental", status: "active" } as never]);
    vi.mocked(dd.listStatusChangeEntries).mockResolvedValue([]);
    vi.mocked(dd.listTaskExtensionsForTasks).mockResolvedValue([]);
    vi.mocked(dd.listStatusTransitions).mockResolvedValue([]);
    vi.mocked(dd.listActivitySince).mockResolvedValue([]);
    vi.mocked(dd.listTaskMessagesSince).mockResolvedValue([]);
    vi.mocked(listMeetingBriefRisks).mockResolvedValue([]);
  });

  it("passes the project, its task ids and the derived client to getProjectSlackSection with the settings it read", async () => {
    const view = (await getProjectDetail(principal, "p_acme", { now: NOW })) as ProjectDetailView;
    expect(view.slack?.ok).toBe(true);
    const [p, s, q, o] = vi.mocked(getProjectSlackSection).mock.calls[0];
    expect(p).toBe(principal);
    expect(s).toBe(SETTINGS);
    expect(q).toMatchObject({ projectId: "p_acme", projectName: "Acme site rebuild", taskIds: ["t_1", "t_2", "t_3"] });
    expect(q.derivedClient).toMatchObject({ clientId: "c_acme", clientName: "Acme Dental" });
    expect(o.now).toBe(NOW);
    expect(o.signal).toBeInstanceOf(AbortSignal);
  });

  it("a throw is { ok: false } (logged by the error's class only); the other sections are unaffected", async () => {
    vi.mocked(getProjectSlackSection).mockRejectedValueOnce(new TypeError(INTEL_SENTINELS.clientName));
    const view = (await getProjectDetail(principal, "p_acme", { now: NOW })) as ProjectDetailView;
    expect(view.slack).toEqual({ ok: false, error: "unavailable" });
    expect(view.summary.ok).toBe(true);
    expect(out.calls().map((c) => String(c[0])).some((l) => l.includes("slack section failed for") && l.includes("(TypeError)"))).toBe(true);
  });

  it("past 10 s it gives up: { ok: false } (the 10 s timer stood in by an already-fired one)", async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
      ms === 10_000 ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")) : real(ms)
    );
    vi.mocked(getProjectSlackSection).mockImplementationOnce(() => new Promise(() => undefined));
    const view = (await getProjectDetail(principal, "p_acme", { now: NOW })) as ProjectDetailView;
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(view.slack).toEqual({ ok: false, error: "unavailable" });
    expect(view.summary.ok).toBe(true);
  });

  it("a failed settings read fails the card only", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("settings"));
    const view = (await getProjectDetail(principal, "p_acme", { now: NOW })) as ProjectDetailView;
    expect(view.slack).toEqual({ ok: false, error: "unavailable" });
    expect(getProjectSlackSection).not.toHaveBeenCalled();
  });
});
