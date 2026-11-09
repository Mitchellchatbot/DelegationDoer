import { readFileSync, readdirSync, statSync } from "node:fs";
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
vi.mock("@/lib/exec/brief-view", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/brief-view")>()),
  getBriefPageView: vi.fn(),
  getBriefPill: vi.fn()
}));

import { BriefCard } from "@/components/exec/brief/BriefCard";
import { BriefPill } from "@/components/exec/brief/BriefPill";
import { BriefView, briefStatsLine, restrictedLine } from "@/components/exec/brief/BriefView";
import { CheckinList } from "@/components/exec/brief/CheckinList";
import { REGENERATE_POLL_MAX_MS, REGENERATE_POLL_MS, RegenerateButton, regenerateWaitStep, startRegeneratePolling } from "@/components/exec/brief/RegenerateButton";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { EXEC_TABS, ExecTabs } from "@/components/exec/ExecTabs";
import { ExecHeader } from "@/components/exec/ExecHeader";
import { OverviewView } from "@/components/exec/overview/OverviewView";
import { SystemSection, aiLines, briefSystemLines, userTokenLine } from "@/components/exec/overview/SystemSection";
import BriefLoading from "@/app/(main)/executive/brief/loading";
import * as briefPage from "@/app/(main)/executive/brief/page";
import * as latestRoute from "@/app/api/exec/briefs/latest/route";
import * as regenerateRoute from "@/app/api/exec/briefs/regenerate/route";
import * as settingsRoute from "@/app/api/exec/briefs/settings/route";
import * as overviewPage from "@/app/(main)/executive/page";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { getBriefPageView, getBriefPill, type BriefContentView, type BriefPageView } from "@/lib/exec/brief-view";
import type { ExecOverview, OverviewBriefSystem, OverviewSection, OverviewSystem } from "@/lib/exec/overview";
import { loadSettings } from "@/lib/exec/principal";
import { regenerateBrief, regenerateMessageFor } from "@/lib/exec/ui/settings-api";
import { BRIEF_TEXT_SENTINELS } from "../__tests__/brief-assert";
import {
  BRIEF_ID,
  DD_TASK_URL,
  NOW_ISO,
  OUTLOOK_URL,
  SCHEDULED_AT,
  TZ,
  briefSettings,
  cardView,
  contentView,
  pageView,
  pill,
  principal
} from "../__tests__/brief-ui-fixtures";
import { textOf } from "../__tests__/p5a-ui-fixtures";

// P8 contract §5.16 (Area E), the rendering half: /executive/brief's page file and loading shapes (UI01), BriefView by
// state (UI02, UI03, UI05, UI25, UI27), the Overview card and TodayGlance (UI06, UI20), the header pill (UI07), the tabs
// (UI08), Regenerate (UI09), the System rows (UI19), the client graph (UI22), no MAC on the page (UI23) and the dynamic
// route files (UI28). Every component renders with renderToStaticMarkup from fixture views (no reads).

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const ok = <T,>(data: T): OverviewSection<T> => ({ ok: true, data });
const FAILED = { ok: false, error: "unavailable" } as const;

beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fullContent(): BriefContentView {
  const base = contentView();
  base.sections = base.sections.map((s) => {
    if (s.key === "emails") {
      return {
        ...s, title: BRIEF_COPY.sectionTitle.emails, stats: { reply: 4, urgent: 1 },
        lines: [{ id: "b1", text: "Reply to Acme", kind: "fact", basis: "ai", band: "high", refs: [{ label: "Acme renewal", href: OUTLOOK_URL }], withheld: null }],
        more: 2
      };
    }
    if (s.key === "work") {
      return {
        ...s, title: BRIEF_COPY.sectionTitle.work,
        lines: [
          { id: "b3", text: "Three tasks closed", kind: "fact", basis: "record", band: "normal", refs: [{ label: "Task t_42", href: DD_TASK_URL }], withheld: null },
          { id: "b4", text: "Ask Dana to move the audit up", kind: "recommendation", basis: "ai", band: "critical", refs: [], withheld: null },
          { id: "b5", text: BRIEF_COPY.removedRestricted, kind: "fact", basis: "ai", band: "normal", refs: [], withheld: "restricted" }
        ],
        pending: [{ title: "Approve the Q4 plan", withheld: false }],
        unchanged: 3
      };
    }
    if (s.key === "blockers") return { ...s, title: BRIEF_COPY.sectionTitle.blockers, stateLine: BRIEF_COPY.state.ddtext_off };
    return { ...s, title: BRIEF_COPY.sectionTitle[s.key], stateLine: BRIEF_COPY.nothingNew };
  });
  return base;
}

function readyView(over: Partial<BriefPageView> = {}): BriefPageView {
  const v = pageView();
  return { ...v, brief: v.brief ? { ...v.brief, content: fullContent() } : null, ...over };
}

describe("UI02: BriefView, each state's exact copy", () => {
  it("not_installed, off (with a Settings link), none (with the due time), building", () => {
    expect(textOf(html(createElement(BriefView, { view: pageView({ state: "not_installed", brief: null }) })))).toBe(BRIEF_COPY.notInstalled);
    const off = html(createElement(BriefView, { view: pageView({ state: "off", brief: null }) }));
    expect(textOf(off)).toContain(BRIEF_COPY.off);
    expect(hrefs(off)).toEqual(["/executive/settings"]);
    expect(textOf(html(createElement(BriefView, { view: pageView({ state: "none", brief: null }) })))).toBe(fillBrief(BRIEF_COPY.none, { time: "8:00 AM EST" }));
    expect(textOf(html(createElement(BriefView, { view: pageView({ state: "building", brief: null }) })))).toBe(BRIEF_COPY.status.building);
  });

  it("UI02 (fixer ui-5) building with a backup already sent (the watchdog's placeholder): the status line says so", () => {
    const v = pageView({ state: "building" });
    const line = `${BRIEF_COPY.status.building} ${fillBrief(BRIEF_COPY.status.fallback, { time: "8:45 AM EST" })}`;
    const view = { ...v, brief: v.brief ? { ...v.brief, status: "building" as const, statusLine: line, content: null, fallbackSentAt: "2026-11-09T13:45:00.000Z" } : null };
    expect(textOf(html(createElement(BriefView, { view })))).toBe(line);
  });

  it("UI27: another brief time renders its own due time on the none state", () => {
    const out = html(createElement(BriefView, { view: pageView({ state: "none", brief: null, dueAt: "2026-11-09T13:30:00.000Z", tz: "America/Chicago" }) }));
    expect(textOf(out)).toBe(fillBrief(BRIEF_COPY.none, { time: "7:30 AM CST" }));
  });

  it("failed with no content: the status line; failed with content: the brief", () => {
    const v = pageView({ state: "failed" });
    const failed = html(createElement(BriefView, { view: { ...v, brief: v.brief ? { ...v.brief, status: "failed", statusLine: BRIEF_COPY.status.failed, content: null } : null } }));
    expect(textOf(failed)).toBe(BRIEF_COPY.status.failed);
    expect(html(createElement(BriefView, { view: readyView({ state: "failed" }) }))).toContain("data-brief-section");
  });

  it("ready: the status and mode lines, the headline, the top 3, every section in key order with its parts", () => {
    const out = html(createElement(BriefView, { view: readyView() }));
    const text = textOf(out);
    expect(text).toContain("Sent to you in Slack at 8:02 AM EST.");
    expect(text).toContain(BRIEF_COPY.modeAi);
    expect(text).toContain("Acme renewal is the morning's one decision");
    // P8 fixer ui-6: a top-3 entry's next step is the model's recommendation, tagged Suggested (as the DM's "_Suggested:_").
    expect(text).toContain(`${BRIEF_COPY.top3Title} 1 Answer Acme ${BRIEF_COPY.suggested}: Reply today 2 Move the Acme audit 3 ${BRIEF_COPY.removedSlack}`);
    const keys = [...out.matchAll(/data-brief-section="([a-z_]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["emails", "slack", "client_requests", "progress", "work", "delayed", "blockers", "approvals", "decisions", "commitments"]);
    expect(text).toContain(`${BRIEF_COPY.sectionTitle.emails} 4 to reply · 1 urgent`);
    expect(text).toContain(`High ${BRIEF_COPY.basis.ai} Reply to Acme`);
    expect(text).toContain(`${BRIEF_COPY.basis.record} Three tasks closed`);
    expect(text).toContain(`Critical ${BRIEF_COPY.basis.ai} ${BRIEF_COPY.suggested} Ask Dana to move the audit up`);
    expect(out.match(/data-brief-suggested/g)).toHaveLength(1);
    expect(text).toContain(`${BRIEF_COPY.pendingPrefix}Approve the Q4 plan`);
    expect(text).toContain(fillBrief(BRIEF_COPY.unchanged, { n: 3 }));
    expect(text).toContain(fillBrief(BRIEF_COPY.more, { n: 2 }));
    expect(text).toContain(BRIEF_COPY.state.ddtext_off);
    expect(text).toContain(fillBrief(BRIEF_COPY.restricted, { n: 2 }));
    expect(hrefs(out)).toEqual(expect.arrayContaining([OUTLOOK_URL, "/tasks/t_42"]));
  });

  it("a withheld line is muted text with no basis label and no link (C31)", () => {
    const out = html(createElement(BriefView, { view: readyView() }));
    const withheld = /<li[^>]*data-brief-line="b5"[^>]*>([^]*?)<\/li>/.exec(out)?.[1] ?? "";
    expect(textOf(withheld)).toBe(BRIEF_COPY.removedRestricted);
    expect(withheld).not.toContain("href");
  });

  it("UI03: the finance line with its one /finance link, and nothing else about finance (M5)", () => {
    const out = html(createElement(BriefView, { view: readyView() }));
    expect(textOf(out)).toContain(`${BRIEF_COPY.financeLine} ${BRIEF_COPY.financeLink}`);
    expect(hrefs(out).filter((h) => h.includes("finance"))).toEqual(["/finance"]);
    for (const word of ["MRR", "Stripe", "P&L", "payroll", "revenue", "burn"]) expect(textOf(out)).not.toContain(word);
  });

  it("restrictedLine: one, many, none or unknown", () => {
    expect(restrictedLine(1)).toBe(BRIEF_COPY.restrictedOne);
    expect(restrictedLine(5)).toBe(fillBrief(BRIEF_COPY.restricted, { n: 5 }));
    expect([restrictedLine(0), restrictedLine(null)]).toEqual([null, null]);
  });

  it("the counters: only the named ones, in order; Slack commitments read as owed to him (AM-P8-28); never 'more'", () => {
    expect(briefStatsLine("slack", { requests: 2, decisions: 1, commitments: 1, notAssessed: 0 })).toBe("2 requests · 1 decision · 1 owed to you · 0 not assessed");
    expect(briefStatsLine("emails", { more: 9, urgent: 1 })).toBe("1 urgent");
    expect(briefStatsLine("decisions", { anything: 3 })).toBeNull();
  });

  it("UI05: every brief string renders as text, never markup", () => {
    const evil = "<script>alert(1)</script>";
    const v = readyView();
    if (v.brief?.content) {
      v.brief.content.headline = evil;
      v.brief.content.sections[0].lines[0].text = evil;
      v.brief.content.top3[0].title = evil;
    }
    const out = html(createElement(BriefView, { view: v }));
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("UI05: no dangerouslySetInnerHTML under components/exec/brief (or the brief settings files)", () => {
    const dir = path.join(SRC, "components", "exec", "brief");
    const files = [
      ...readdirSync(dir).map((f) => path.join(dir, f)),
      path.join(SRC, "components", "exec", "settings", "BriefSettingsForm.tsx"),
      path.join(SRC, "components", "exec", "settings", "BriefSettingsSection.tsx")
    ];
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe("UI23 / UI25: check-ins on the page", () => {
  const rows = [
    { id: "ebc_1", firstName: "Dana", text: BRIEF_TEXT_SENTINELS.checkinText, status: "sent" as const, statusLine: "Sent to Dana at 8:30 AM EST.", sentAt: "x" },
    { id: "ebc_2", firstName: "Sam", text: "Thanks for the audit", status: "proposed" as const, statusLine: "", sentAt: null }
  ];

  it("rows with their status lines and the page note; no Send, no button, no MAC", () => {
    const out = html(createElement(CheckinList, { rows, posted: true }));
    const text = textOf(out);
    expect(text).toContain("Dana");
    expect(text).toContain("Sent to Dana at 8:30 AM EST.");
    expect(text).toContain(BRIEF_COPY.checkinsPageNote);
    expect(text).not.toContain(BRIEF_COPY.checkinsNotPosted);
    expect(out).not.toMatch(/<button|<form|value="|c1\.ebc_/);
  });

  it("UI25: check-ins whose message never reached Slack say so, and only so (fixer ui-3: no \"send them from your Slack DM\")", () => {
    const notPosted = textOf(html(createElement(CheckinList, { rows, posted: false })));
    expect(notPosted).toContain(BRIEF_COPY.checkinsNotPosted);
    expect(notPosted).not.toContain(BRIEF_COPY.checkinsPageNote);
    expect(html(createElement(CheckinList, { rows: [], posted: false }))).toBe("");
    expect(textOf(html(createElement(BriefView, { view: readyView({ checkins: rows, checkinsPosted: false }) })))).toContain(BRIEF_COPY.checkinsNotPosted);
  });
});

describe("UI06 / UI20: the Overview card in TodayGlance's slot", () => {
  const overview = (brief?: ExecOverview["sections"]["brief"]): ExecOverview => ({
    generatedAt: NOW_ISO,
    timezone: TZ,
    sections: { tiles: FAILED, attention: FAILED, approvals: FAILED, deadlines: FAILED, projects: FAILED, system: FAILED, email: FAILED, ...(brief === undefined ? {} : { brief }) }
  });
  const glance = (markup: string) => markup.includes("exec-glance-title");

  it("today's brief → BriefCard (title, pill, headline, top 3, status line, Open the brief), no TodayGlance", () => {
    const out = html(createElement(OverviewView, { overview: overview(ok(cardView())), principalTz: TZ }));
    expect(glance(out)).toBe(false);
    const card = /<section[^>]*data-brief-card[^]*?<\/section>/.exec(out)?.[0] ?? "";
    const text = textOf(card);
    expect(text).toContain(`${BRIEF_COPY.pageTitle} · Nov 9`);
    expect(card).toContain('data-brief-pill="delivered"');
    expect(text).toContain("Acme renewal is the morning's one decision");
    expect(text).toContain(`${BRIEF_COPY.top3Title} 1 Answer Acme`);
    expect(text).toContain(BRIEF_COPY.removedSlack);
    expect(text).toContain("Sent to you in Slack at 8:02 AM EST.");
    expect(text).toContain(BRIEF_COPY.openBrief);
    expect(hrefs(card)).toContain("/executive/brief");
  });

  it("no card (data null), a failed card read, or no brief section → TodayGlance exactly as before", () => {
    for (const o of [overview(ok(null)), overview(FAILED), overview()]) {
      const out = html(createElement(OverviewView, { overview: o, principalTz: TZ }));
      expect(glance(out)).toBe(true);
      expect(out).not.toContain("data-brief-card");
    }
  });

  it("UI06 (fixer ui-6) the card labels its AI (or deterministic) mode, and a top-3 next step reads Suggested", () => {
    const ai = html(createElement(BriefCard, { view: cardView({ mode: "ai", modeLine: BRIEF_COPY.modeAi }), tz: TZ, now: NOW_ISO }));
    expect(ai).toContain('data-brief-mode="ai"');
    expect(textOf(ai)).toContain(BRIEF_COPY.modeAi);
    expect(textOf(ai)).toContain(`1 Answer Acme ${BRIEF_COPY.suggested}: Reply today`);
    const det = html(createElement(BriefCard, { view: cardView({ mode: "deterministic", modeLine: "Built without AI today (timeout)." }), tz: TZ, now: NOW_ISO }));
    expect(det).toContain('data-brief-mode="deterministic"');
    expect(textOf(det)).toContain("Built without AI today (timeout).");
  });

  it("a withheld top-3 entry has no link; the headline is left out when null", () => {
    const out = html(createElement(BriefCard, { view: cardView({ headline: null }), tz: TZ, now: NOW_ISO }));
    expect(out).not.toContain("data-brief-headline");
    const withheld = /<li[^>]*data-brief-top="withheld"[^>]*>([^]*?)<\/li>/.exec(out)?.[1] ?? "";
    expect(textOf(withheld)).toContain(BRIEF_COPY.removedSlack);
    expect(withheld).not.toContain("href");
  });

  it("the header pill and Regenerate on the Overview (C42); without the prop the header is unchanged", () => {
    const withBrief = html(createElement(OverviewView, { overview: overview(), principalTz: TZ, brief: { pill: pill(), canRegenerate: true, expectedRev: 2 } }));
    expect(withBrief).toContain('data-brief-pill="delivered"');
    expect(withBrief).toContain("data-regenerate");
    const without = html(createElement(OverviewView, { overview: overview(), principalTz: TZ }));
    expect(without).not.toContain("data-brief-pill");
    expect(without).not.toContain("data-regenerate");
  });
});

describe("UI07: the header pill", () => {
  it("renders next to Private and links to the Brief tab; a page that doesn't pass it is unchanged", () => {
    const out = html(createElement(ExecHeader, { updatedAt: NOW_ISO, tz: TZ, brief: pill() }));
    expect(textOf(out)).toContain("Private Brief 8:02 AM EST · live");
    expect(hrefs(out)).toEqual(["/executive/brief"]);
    const plain = html(createElement(ExecHeader, { updatedAt: NOW_ISO, tz: TZ }));
    expect(plain).not.toContain("data-brief-pill");
    expect(textOf(plain)).not.toContain("Brief");
    for (const state of Object.keys(BRIEF_COPY.pillState) as (keyof typeof BRIEF_COPY.pillState)[]) {
      expect(html(createElement(BriefPill, { pill: { state, label: `Brief 8:00 AM EST · ${BRIEF_COPY.pillState[state]}` } }))).toContain(`data-brief-pill="${state}"`);
    }
  });
});

describe("UI08: the tabs", () => {
  it("Overview, Brief, Email, Slack, Team, Projects, Chat, then Settings; Brief current on the Brief page", () => {
    expect(EXEC_TABS.map((t) => t.label)).toEqual(["Overview", BRIEF_COPY.tab, "Email", "Slack", "Team", "Projects", "Chat"]);
    expect(EXEC_TABS.find((t) => t.key === "brief")).toEqual({ key: "brief", href: "/executive/brief", label: BRIEF_COPY.tab });
    const out = html(createElement(ExecTabs, { active: "brief", tabs: EXEC_TABS }));
    expect(hrefs(out)).toEqual(["/executive", "/executive/brief", "/executive/email", "/executive/slack", "/executive/team", "/executive/projects", "/executive/chat", "/executive/settings"]);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="page"[^>]*href="\/executive\/brief"|href="\/executive\/brief"[^>]*aria-current="page"/);
  });
});

describe("UI09: Regenerate", () => {
  it("framed → nothing interactive; top-level → the button while it can run, nothing to click otherwise", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    expect(html(createElement(RegenerateButton, { expectedRev: 1, canRegenerate: true }))).toBe("");
    vi.mocked(useIsTopWindow).mockReturnValue(true);
    const top = html(createElement(RegenerateButton, { expectedRev: 1, canRegenerate: true }));
    expect(textOf(top)).toBe(BRIEF_COPY.regenerate);
    expect(top).toContain("<button");
    expect(html(createElement(RegenerateButton, { expectedRev: 1, canRegenerate: false }))).not.toContain("<button");
    expect(html(createElement(RegenerateButton, { expectedRev: null, canRegenerate: true }))).not.toContain("<button");
  });

  it("the confirm first; after a 202 the queued line (and no button while it waits)", () => {
    const confirm = html(createElement(RegenerateButton, { expectedRev: 1, canRegenerate: true, initialConfirm: true }));
    expect(textOf(confirm)).toBe(`${BRIEF_COPY.regenerateConfirm} ${BRIEF_COPY.regenerate} ${BRIEF_COPY.settings.cancel}`);
    const queued = html(createElement(RegenerateButton, { expectedRev: 1, canRegenerate: true, initialResult: { kind: "queued", rev: 1 } }));
    expect(textOf(queued)).toBe(BRIEF_COPY.regenerateQueued);
    expect(queued).not.toContain("<button");
  });

  it("the call: POST { expectedRev } same-origin; 202 queued, 409 busy / conflict, 429 in minutes, else failed", async () => {
    const fetchImpl = vi.fn();
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
    answer(202, { status: "queued", rev: 4 });
    expect(await regenerateBrief(4, fetchImpl)).toEqual({ kind: "queued", rev: 4 });
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/exec/briefs/regenerate");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", body: JSON.stringify({ expectedRev: 4 }) });
    answer(409, { error: "busy" });
    const busy = await regenerateBrief(4, fetchImpl);
    expect(regenerateMessageFor(busy)).toBe(BRIEF_COPY.regenerateBusy);
    answer(409, { error: "conflict", rev: 5 });
    const conflict = await regenerateBrief(4, fetchImpl);
    expect(conflict).toEqual({ kind: "conflict", rev: 5 });
    expect(regenerateMessageFor(conflict)).toBe(BRIEF_COPY.regenerateConflict);
    answer(429, { error: "rate_limited", retryAfterSeconds: 610 });
    expect(regenerateMessageFor(await regenerateBrief(4, fetchImpl))).toBe(fillBrief(BRIEF_COPY.regenerateRateLimited, { n: 11 }));
    answer(503, { error: "unavailable" });
    expect(regenerateMessageFor(await regenerateBrief(4, fetchImpl))).toBe(BRIEF_COPY.regenerateFailed);
    fetchImpl.mockRejectedValueOnce(new TypeError("offline"));
    expect(await regenerateBrief(4, fetchImpl)).toEqual({ kind: "failed", status: 0 });
    expect(await regenerateBrief(0, fetchImpl)).toEqual({ kind: "failed", status: 0 });
  });

  it("the polling: a refresh every 10 s, and none after 5 minutes", () => {
    let t = 0;
    const box: { tick: (() => void) | null } = { tick: null };
    const tick = () => box.tick?.();
    const cleared: unknown[] = [];
    const refresh = vi.fn();
    const stop = startRegeneratePolling(refresh, { setInterval: (fn) => ((box.tick = fn), 7), clearInterval: (id) => cleared.push(id), now: () => t });
    expect(REGENERATE_POLL_MS).toBe(10_000);
    for (t = 10_000; t < REGENERATE_POLL_MAX_MS; t += 10_000) tick();
    expect(refresh).toHaveBeenCalledTimes(29);
    tick();
    expect(refresh).toHaveBeenCalledTimes(29);
    expect(cleared).toEqual([7]);
    stop();
    expect(cleared).toEqual([7]);
  });
});

describe("UI09: waiting for a queued regenerate", () => {
  it("a newer rev → done; withheld → busy; the same rev offered again after busy → failed; else wait", () => {
    expect(regenerateWaitStep(1, false, { expectedRev: 2, canRegenerate: false })).toBe("done");
    expect(regenerateWaitStep(1, false, { expectedRev: 1, canRegenerate: false })).toBe("busy");
    expect(regenerateWaitStep(1, true, { expectedRev: 1, canRegenerate: true })).toBe("failed");
    // Right after the 202 the page still shows the old render (canRegenerate true): keep waiting, never "failed".
    expect(regenerateWaitStep(1, false, { expectedRev: 1, canRegenerate: true })).toBe("wait");
    expect(regenerateWaitStep(1, true, { expectedRev: null, canRegenerate: true })).toBe("wait");
  });
});

describe("UI19: the System card's brief rows", () => {
  const base: OverviewSystem = { kinds: [], successLookbackHours: 48, dead24h: 0, queued: 0, due: 0, oldestDueAt: null };
  const brief = (over: Partial<OverviewBriefSystem> = {}): OverviewBriefSystem => ({
    localDate: "2026-11-09", owner: "exec", ownerReason: "owns", status: "delivered", statusReason: null, channel: "exec_bot", mode: "ai", modeReason: null,
    builtAt: "2026-11-09T13:01:00.000Z", deliveredAt: "2026-11-09T13:02:00.000Z", fallbackSentAt: null, fallbackErrorCode: null, legacyDeliveredToday: false,
    checkins: { proposed: 1, sending: 0, sent: 2, unknown: 0, failed: 0, expired: 0 }, ...over
  });
  const rows = (system: Partial<OverviewSystem>) => {
    const out = html(createElement(SystemSection, { system: ok({ ...base, ...system }), now: NOW_ISO, tz: TZ }));
    return Object.fromEntries([...out.matchAll(/<li[^>]*data-brief-system-row="([a-z]+)"[^>]*>([^]*?)<\/li>/g)].map((m) => [m[1], textOf(m[2])]));
  };

  it("a delivered day", () => {
    expect(rows({ brief: brief() }).brief).toBe(
      `${BRIEF_COPY.system.brief} Assistant · Sent to you in Slack at 8:02 AM EST. · Sent by the assistant · AI summary DD brief today: not sent · Check-ins: 1 proposed, 2 sent`
    );
  });

  it("a fallback day and a page-only day", () => {
    const fallback = rows({ brief: brief({ status: "page_only", statusReason: "after_fallback", channel: "dd_bot_fallback", deliveredAt: null, fallbackSentAt: "2026-11-09T13:45:00.000Z", checkins: { proposed: 0, sending: 0, sent: 0, unknown: 0, failed: 0, expired: 0 } }) });
    expect(fallback.brief).toBe(
      `${BRIEF_COPY.system.brief} Assistant · In DD only. The backup already went out, so this stayed in DD. The DD bot sent a short backup at 8:45 AM EST. · Backup sent by the DD bot · AI summary DD brief today: not sent`
    );
    const pageOnly = rows({ brief: brief({ owner: "exec_page_only", ownerReason: "not_superseding", status: "page_only", statusReason: "not_superseding", channel: "page_only", deliveredAt: null, legacyDeliveredToday: true, mode: "deterministic", modeReason: "budget" }) });
    expect(pageOnly.brief).toContain("DD brief (assistant in DD only) · In DD only. The DD brief sends your morning DM until you switch. · In DD only · AI summary unavailable today (the daily AI budget is used up).");
    expect(pageOnly.brief).toContain("DD brief today: sent");
  });

  it("the token rows: mismatch, ok, unchecked; the AI rows; couldn't load", () => {
    expect(rows({ userToken: { state: "mismatch", checkedAt: "2026-11-09T11:00:00.000Z" } }).token).toBe(`${BRIEF_COPY.system.token} ${BRIEF_COPY.system.tokenState.mismatch}`);
    expect(rows({ userToken: { state: "ok", checkedAt: "2026-11-09T11:00:00.000Z" } }).token).toBe(`${BRIEF_COPY.system.token} Yours, checked Nov 9, 6:00 AM EST`);
    expect(rows({ userToken: { state: "unchecked", checkedAt: null } }).token).toBe(`${BRIEF_COPY.system.token} ${BRIEF_COPY.system.tokenState.unchecked}`);
    expect(rows({ userToken: { state: "revoked", checkedAt: null } }).token).toBe(`${BRIEF_COPY.system.token} Revoked`);
    const ai = rows({ ai: { spentTodayUsd: 3.456, capUsd: 15, byFeature: { brief: 3, chat: 0.456 }, refusals24h: 2 } });
    expect([ai.spend, ai.refusals]).toEqual(["AI spend today: $3.46 of $15.00", "Model refusals in 24 hours: 2"]);
    const failed = rows({ brief: null, userToken: null, ai: null });
    expect(failed).toEqual({ brief: `${BRIEF_COPY.system.brief} couldn't load`, token: `${BRIEF_COPY.system.token} couldn't load`, ai: "Couldn't load today's AI spend." });
    expect(html(createElement(SystemSection, { system: ok(base), now: NOW_ISO, tz: TZ }))).not.toContain("data-brief-system");
  });

  it("the line helpers' tones", () => {
    expect(briefSystemLines(brief({ status: "failed", deliveredAt: null }), NOW_ISO, TZ).tone).toBe("rose");
    expect(briefSystemLines(brief({ status: "delivery_unknown", deliveredAt: null }), NOW_ISO, TZ).tone).toBe("amber");
    expect(briefSystemLines(brief({ status: "none", channel: "none", mode: null }), NOW_ISO, TZ).value).toBe("Assistant · Not built yet today · Not sent");
    expect(userTokenLine({ state: "ok", checkedAt: null }, NOW_ISO, TZ).tone).toBe("ok");
    expect(aiLines({ spentTodayUsd: 15, capUsd: 15, byFeature: {}, refusals24h: 0 }).spend.tone).toBe("rose");
    expect(aiLines({ spentTodayUsd: 12, capUsd: 15, byFeature: { brief: 12 }, refusals24h: 0 }).spend).toEqual({ value: "AI spend today: $12.00 of $15.00", tone: "amber", title: "brief $12.00" });
  });
});

describe("UI01: /executive/brief's page file and its loading shapes", () => {
  const NOT_FOUND = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });

  it("the gate first, with its route string; then the settings, the view and the pill", async () => {
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    vi.mocked(loadSettings).mockResolvedValue(briefSettings());
    vi.mocked(getBriefPageView).mockResolvedValue(readyView());
    vi.mocked(getBriefPill).mockResolvedValue(pill());
    const out = html(await briefPage.default());
    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive/brief");
    const gate = vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0];
    expect(gate).toBeLessThan(vi.mocked(loadSettings).mock.invocationCallOrder[0]);
    expect(gate).toBeLessThan(vi.mocked(getBriefPageView).mock.invocationCallOrder[0]);
    expect(out).toContain("Executive AI Assistant");
    expect(out).toContain('data-brief-pill="delivered"');
    expect(out).toMatch(/aria-current="page"[^>]*href="\/executive\/brief"|href="\/executive\/brief"[^>]*aria-current="page"/);
    expect(out).toContain("data-regenerate");
    expect(out).toContain('data-brief-section="emails"');
  });

  it("a non-owner gets the not-found page and nothing is read", async () => {
    vi.mocked(requireExecPrincipalForPage).mockRejectedValue(NOT_FOUND);
    await expect(briefPage.default()).rejects.toBe(NOT_FOUND);
    for (const fn of [loadSettings, getBriefPageView, getBriefPill]) expect(fn).not.toHaveBeenCalled();
  });

  it("a failed pill read still draws the page (no pill); no row → no Regenerate", async () => {
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    vi.mocked(loadSettings).mockResolvedValue(briefSettings());
    vi.mocked(getBriefPageView).mockResolvedValue(pageView({ state: "none", brief: null, expectedRev: null, canRegenerate: false }));
    vi.mocked(getBriefPill).mockRejectedValue(new Error("pill"));
    const out = html(await briefPage.default());
    expect(out).not.toContain("data-brief-pill");
    expect(out).not.toContain("data-regenerate");
  });

  it("force-dynamic, no metadata, a server component whose first await is the gate", () => {
    expect(briefPage.dynamic).toBe("force-dynamic");
    expect("metadata" in briefPage).toBe(false);
    expect("generateMetadata" in briefPage).toBe(false);
    const src = readFileSync(path.join(SRC, "app", "(main)", "executive", "brief", "page.tsx"), "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/);
    const body = src.slice(src.indexOf("export default async function"));
    expect(body.slice(body.indexOf("await "), body.indexOf("await ") + 40)).toContain("await requireExecPrincipalForPage(");
  });

  it("loading.tsx: shapes only, no words, no feature words in its source, no imports or awaits", () => {
    const out = html(createElement(BriefLoading));
    expect(textOf(out)).toBe("");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("dd-skeleton");
    const src = readFileSync(path.join(SRC, "app", "(main)", "executive", "brief", "loading.tsx"), "utf8");
    expect(src).not.toMatch(/exec|executive|assistant|brief/i);
    expect(src).not.toMatch(/\bawait\b|\basync\b|^import /m);
  });
});

describe("UI28: the dynamic route files", () => {
  it("the three routes and both pages are force-dynamic on the Node runtime; the dry run may take 300 s", () => {
    for (const m of [latestRoute, regenerateRoute, settingsRoute]) {
      expect(m.dynamic).toBe("force-dynamic");
      expect(m.runtime).toBe("nodejs");
    }
    expect(regenerateRoute.maxDuration).toBe(300);
    expect(overviewPage.dynamic).toBe("force-dynamic");
    expect(Object.keys(latestRoute).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["GET"]);
    expect(Object.keys(regenerateRoute).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["POST"]);
    expect(Object.keys(settingsRoute).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["PATCH"]);
  });
});

describe("UI22: the client components reach no server-only module", () => {
  // The value-import graph (type-only imports are erased) of every "use client" file under components/exec/brief and
  // settings/Brief*, followed within src; a module with `import "server-only"` anywhere in it fails (P5a rule 16, B-P8-9).
  const read = (f: string) => readFileSync(f, "utf8");
  const resolve = (spec: string, from: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
    else return null;
    for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      try {
        if (statSync(base + ext).isFile()) return base + ext;
      } catch {
        // next extension
      }
    }
    return null;
  };
  const valueImports = (src: string): string[] =>
    [...src.matchAll(/^\s*import\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']/gm)]
      .filter((m) => !/^\{[^}]*\}$/.test(m[1].trim()) || !m[1].trim().slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type ")))
      .map((m) => m[2]);

  it("RegenerateButton and BriefSettingsForm are client roots and their graphs hold no server-only module", () => {
    const roots = [path.join(SRC, "components", "exec", "brief", "RegenerateButton.tsx"), path.join(SRC, "components", "exec", "settings", "BriefSettingsForm.tsx")];
    for (const root of roots) {
      expect(read(root).trimStart().startsWith('"use client";'), root).toBe(true);
      const seen = new Set<string>([root]);
      const queue = [root];
      while (queue.length > 0) {
        const file = queue.shift() as string;
        const src = read(file);
        expect(src, `${path.relative(SRC, file)} (from ${path.basename(root)})`).not.toMatch(/^\s*import\s+["']server-only["']/m);
        for (const spec of valueImports(src)) {
          const next = resolve(spec, file);
          if (next && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.size).toBeGreaterThan(2);
    }
  });

  it("the server components under components/exec/brief aren't client files", () => {
    for (const f of ["BriefView.tsx", "BriefCard.tsx", "BriefPill.tsx", "CheckinList.tsx"]) {
      expect(read(path.join(SRC, "components", "exec", "brief", f)).trimStart().startsWith('"use client"'), f).toBe(false);
    }
  });
});

describe("the page view carries no button value (UI23)", () => {
  it("a full view's JSON has no MAC or button value", () => {
    const v = readyView({ checkins: [{ id: "ebc_1", firstName: "Dana", text: "x", status: "proposed", statusLine: "", sentAt: null }] });
    expect(JSON.stringify(v)).not.toMatch(/"value"|c1\.ebc_/);
    expect(v.brief?.id).toBe(BRIEF_ID);
    expect(SCHEDULED_AT).toBe(v.dueAt);
  });
});
