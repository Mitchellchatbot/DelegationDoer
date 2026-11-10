import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASIS_META, BasisLabel } from "@/components/exec/BasisLabel";
import { TONE as BRIEF_PILL_TONE } from "@/components/exec/brief/BriefPill";
import { BRIEF_WITHHELD_TEXT } from "@/components/exec/brief/BriefView";
import { CATEGORY_FALLBACK_CLASS, CATEGORY_META, CategoryBadge } from "@/components/exec/CategoryBadge";
import { prefersReducedMotion } from "@/components/exec/chat/ExecChat";
import { CHIP_TONE } from "@/components/exec/email/parts";
import { EmptyState } from "@/components/exec/EmptyState";
import { EXEC_GEAR, EXEC_TABS, EXEC_TAB_PILL, EXEC_TAB_STRIP, ExecTabs } from "@/components/exec/ExecTabs";
import { ExecHeader } from "@/components/exec/ExecHeader";
import { FactList } from "@/components/exec/FactList";
import { ZERO_COUNT_TEXT } from "@/components/exec/overview/ApprovalsSection";
import { STATUS_META as OVERVIEW_PROJECT_STATUS } from "@/components/exec/overview/ProjectsSection";
import { BAND_META, PriorityBandBadge } from "@/components/exec/PriorityBandBadge";
import { NEUTRAL_BADGE, PROJECT_STATUS_META } from "@/components/exec/projects/labels";
import { SectionCard } from "@/components/exec/SectionCard";
import { SWITCH_BUTTON, SWITCH_TRACK } from "@/components/exec/settings/SettingsForm";
import { SourceLinks } from "@/components/exec/SourceLinks";
import { Sparkline } from "@/components/exec/Sparkline";
import { StatTile, TINT as TILE_TINT, TONE as TILE_TONE } from "@/components/exec/StatTile";
import type { AttentionCategory, AttentionFact, FactBasis, PriorityBand } from "@/lib/exec/attention-types";
import type { SourceRef } from "@/lib/exec/types";

const html = (el: ReactElement) => renderToStaticMarkup(el);
/** Visible text: tags stripped, entities left as React wrote them. */
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, "");
const NNBSP = String.fromCharCode(0x202f);
const norm = (s: string) => s.split(NNBSP).join(" ");
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

const SCRIPT = "<script>alert(1)</script>";
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

const ddRef = (id: string, label = `Task ${id}`): SourceRef => ({
  system: "dd",
  id,
  url: `https://operations.scaledai.org/tasks/${id}`,
  label,
  class: "internal"
});
const slackRef: SourceRef = {
  system: "slack",
  id: "C1:1700000000.000100",
  url: "https://scaledai.slack.com/archives/C1/p1700000000000100",
  label: "#ops thread",
  class: "public"
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ExecHeader", () => {
  it("shows the title, the Private pill and the update time in the principal's zone", () => {
    const out = norm(html(createElement(ExecHeader, { updatedAt: "2026-11-04T13:02:00Z", tz: "America/New_York" })));
    expect(out).toContain("<h1");
    expect(out).toContain("Executive AI Assistant");
    expect(out).toContain("Private");
    expect(out).toContain('Updated <time dateTime="2026-11-04T13:02:00Z">Nov 4, 8:02 AM EST</time>');
  });

  it("renders the trailing slot", () => {
    const out = html(createElement(ExecHeader, { updatedAt: "2026-11-04T13:02:00Z", tz: "UTC", trailing: createElement("span", null, "TABS") }));
    expect(out).toContain("TABS");
  });

  it("shows a dash rather than a wrong time when updatedAt is unreadable", () => {
    expect(html(createElement(ExecHeader, { updatedAt: "nope", tz: "America/New_York" }))).toContain("Updated <time");
    expect(textOf(html(createElement(ExecHeader, { updatedAt: "nope", tz: "America/New_York" })))).toContain("Updated —");
  });
});

describe("ExecTabs", () => {
  it("marks the active tab and links each tab to its page, then Settings (P5a C23)", () => {
    // P5b ships the Chat tab in EXEC_TABS itself (contract §3.19.11).
    const tabs = EXEC_TABS;
    const out = html(createElement(ExecTabs, { active: "chat", tabs }));
    // P8 (AM-P8-23, forced): Brief after Overview.
    expect(hrefs(out)).toEqual(["/executive", "/executive/brief", "/executive/email", "/executive/slack", "/executive/team", "/executive/projects", "/executive/chat", "/executive/settings"]);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/executive\/chat"|<a[^>]*href="\/executive\/chat"[^>]*aria-current="page"/);
  });

  it("ships Overview, Email (P3), Team and Projects (P5a) and Chat (P5b), the pages that exist, so it never links to a 404", () => {
    expect(EXEC_TABS).toEqual([
      { key: "overview", href: "/executive", label: "Overview" },
      // P8 (AM-P8-23, forced): the Brief tab.
      { key: "brief", href: "/executive/brief", label: "Brief" },
      { key: "email", href: "/executive/email", label: "Email" },
      { key: "slack", href: "/executive/slack", label: "Slack" },
      { key: "team", href: "/executive/team", label: "Team" },
      { key: "projects", href: "/executive/projects", label: "Projects" },
      { key: "chat", href: "/executive/chat", label: "Chat" }
    ]);
    const out = html(createElement(ExecTabs, { active: "overview", tabs: EXEC_TABS }));
    // The Settings gear is an icon with an aria-label: no visible text.
    expect(textOf(out)).toBe("OverviewBriefEmailSlackTeamProjectsChat");
    expect(out).toContain('aria-current="page"');
  });

  it("marks nothing current for an unknown key", () => {
    expect(html(createElement(ExecTabs, { active: "nope", tabs: EXEC_TABS }))).not.toContain("aria-current");
  });
});

describe("SectionCard", () => {
  const card = (props: Partial<Parameters<typeof SectionCard>[0]>) =>
    html(createElement(SectionCard, { title: "Approvals", ...props }, createElement("p", null, "BODY")));

  it("renders title, action and children on a good read", () => {
    const out = card({ action: createElement("span", null, "3 waiting"), subtitle: "Checked 9:00 AM" });
    expect(out).toContain("<h2");
    expect(out).toContain("Approvals");
    expect(out).toContain("3 waiting");
    expect(out).toContain("Checked 9:00 AM");
    expect(out).toContain("BODY");
  });

  it("replaces the body with the couldn't-load banner on a failed read: no children, no zeros", () => {
    const out = card({ error: true });
    expect(out).not.toContain("BODY");
    expect(out).toContain("Couldn&#x27;t load this section");
    expect(out).toContain('role="status"');
    expect(textOf(out)).not.toMatch(/\b0\b/);
  });

  it("uses the caller's error copy when given, and error wins over empty", () => {
    const out = card({ error: "Couldn't load approvals.", empty: "Nothing waiting." });
    expect(out).toContain("Couldn&#x27;t load approvals.");
    expect(out).not.toContain("Nothing waiting.");
    expect(out).not.toContain("BODY");
  });

  it("shows the empty message instead of the body when the read found nothing", () => {
    const out = card({ empty: "Nothing waiting on approval." });
    expect(out).toContain("Nothing waiting on approval.");
    expect(out).not.toContain("BODY");
  });

  it("treats error: false and an empty error string as a good read", () => {
    expect(card({ error: false })).toContain("BODY");
    expect(card({ error: "" })).toContain("BODY");
  });

  it("labels a derived section and escapes its title", () => {
    const out = html(createElement(SectionCard, { title: SCRIPT, basis: "derived" }));
    expect(out).toContain(ESCAPED);
    expect(out).not.toContain("<script");
    expect(out).toContain("Derived");
  });
});

describe("StatTile", () => {
  it("server-renders the real value, formatted, with its basis label", () => {
    const out = html(createElement(StatTile, { label: "Completed today", value: 1204, basis: "record", sub: "since midnight ET" }));
    expect(out).toContain("1,204");
    expect(out).toContain("Completed today");
    expect(out).toContain("Record");
    expect(out).toContain("since midnight ET");
  });

  it("shows a dash, never 0, for an unknown value", () => {
    const out = textOf(html(createElement(StatTile, { label: "Open overdue", value: null })));
    expect(out).toContain("—");
    expect(out).not.toMatch(/\b0\b/);
    expect(textOf(html(createElement(StatTile, { label: "x", value: "" })))).toContain("—");
  });

  it("shows a real zero as 0 and a string value as given", () => {
    expect(textOf(html(createElement(StatTile, { label: "Open overdue", value: 0 })))).toContain("0");
    expect(textOf(html(createElement(StatTile, { label: "Hours logged", value: "6.5 h" })))).toContain("6.5 h");
  });

  it("draws a sparkline only for a series of two or more points", () => {
    expect(html(createElement(StatTile, { label: "x", value: 3, series: [1, 2, 3] }))).toContain("<svg");
    expect(html(createElement(StatTile, { label: "x", value: 3, series: [3] }))).not.toContain("<svg");
    expect(html(createElement(StatTile, { label: "x", value: 3 }))).not.toContain("<svg");
  });

  it("links to a DD path, and ignores an href that isn't one", () => {
    expect(hrefs(html(createElement(StatTile, { label: "x", value: 1, href: "/tasks" })))).toEqual(["/tasks"]);
    expect(hrefs(html(createElement(StatTile, { label: "x", value: 1, href: "https://evil.example/" })))).toEqual([]);
    expect(hrefs(html(createElement(StatTile, { label: "x", value: 1, href: "javascript:alert(1)" })))).toEqual([]);
  });

  it("renders a delta in its tone and escapes text", () => {
    const out = html(createElement(StatTile, { label: SCRIPT, value: SCRIPT, delta: { text: "+3 vs yesterday", tone: "good" } }));
    expect(out).toContain("+3 vs yesterday");
    // P9 F5 (flip): emerald-600 was 3.77:1 on white; emerald-700 is 5.48:1.
    expect(out).toContain("text-emerald-700");
    expect(out).not.toContain("<script");
  });
});

describe("Sparkline", () => {
  it("draws the series on a zero baseline, hidden from screen readers by default", () => {
    const out = html(createElement(Sparkline, { data: [0, 5, 10] }));
    expect(out).toContain('aria-hidden="true"');
    // The max point sits at the top (y = 1), zero at the bottom (y = 23).
    expect(out).toContain('points="0.0,23.0 60.0,12.0 120.0,1.0"');
  });

  it("is an image with a label when one is given", () => {
    const out = html(createElement(Sparkline, { data: [1, 2], label: "Completed per day: 1, 2" }));
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="Completed per day: 1, 2"');
    expect(out).not.toContain("aria-hidden");
  });

  it("renders nothing for a series it can't draw truthfully", () => {
    for (const data of [[], [4], [1, Number.NaN], [1, Number.POSITIVE_INFINITY], [2, -1]]) {
      expect(html(createElement(Sparkline, { data }))).toBe("");
    }
  });

  it("draws an all-zero series flat on the baseline", () => {
    expect(html(createElement(Sparkline, { data: [0, 0] }))).toContain('points="0.0,23.0 120.0,23.0"');
  });
});

describe("PriorityBandBadge", () => {
  it("title-cases each band and keeps the score and reasons in the tooltip", () => {
    const bands: PriorityBand[] = ["critical", "high", "normal"];
    for (const band of bands) {
      const out = html(createElement(PriorityBandBadge, { band, score: 82, reasons: ["Overdue tasks (base 25)", "Overdue 14 days (+28)"] }));
      expect(textOf(out)).toContain(BAND_META[band].label);
      expect(out).toContain(BAND_META[band].className);
      expect(out).toContain('title="Priority score 82 of 100\nOverdue tasks (base 25)\nOverdue 14 days (+28)"');
    }
    expect(BAND_META.critical.label).toBe("Critical");
  });

  it("has no tooltip without a score or reasons, and escapes reasons", () => {
    expect(html(createElement(PriorityBandBadge, { band: "high" }))).not.toContain("title=");
    expect(html(createElement(PriorityBandBadge, { band: "high", reasons: [SCRIPT] }))).not.toContain("<script");
  });

  it("is not Badges.tsx's PriorityBadge (task priority)", () => {
    expect(textOf(html(createElement(PriorityBandBadge, { band: "normal" })))).toContain("Normal");
  });
});

describe("CategoryBadge", () => {
  it("labels every category", () => {
    const categories: AttentionCategory[] = ["my_action", "approval", "delegated", "intervene", "fyi", "on_track"];
    for (const category of categories) {
      expect(textOf(html(createElement(CategoryBadge, { category })))).toBe(CATEGORY_META[category].label);
    }
    expect(CATEGORY_META.my_action.label).toBe("Your action");
  });

  it("shows an unknown category as its raw (escaped) value instead of crashing", () => {
    const out = html(createElement(CategoryBadge, { category: SCRIPT as AttentionCategory }));
    expect(out).toContain(ESCAPED);
  });
});

describe("BasisLabel", () => {
  it("says Record, Derived or AI-assessed", () => {
    const expected: Record<FactBasis, string> = { record: "Record", derived: "Derived", ai: "AI-assessed" };
    for (const basis of Object.keys(expected) as FactBasis[]) {
      expect(textOf(html(createElement(BasisLabel, { basis })))).toBe(expected[basis]);
      expect(html(createElement(BasisLabel, { basis }))).toContain(BASIS_META[basis].light);
      expect(html(createElement(BasisLabel, { basis, onDark: true }))).toContain(BASIS_META[basis].dark);
    }
  });

  it("presents an unknown basis as an assessment, never as a record", () => {
    expect(textOf(html(createElement(BasisLabel, { basis: "rumor" as FactBasis })))).toBe("AI-assessed");
  });
});

describe("FactList", () => {
  const facts: AttentionFact[] = [
    { text: "Due Oct 21, status in_progress", basis: "record", refs: [ddRef("t1")] },
    { text: "14 days overdue", basis: "derived", refs: [] },
    { text: SCRIPT, basis: "ai", refs: [] },
    { text: "Fourth fact", basis: "record", refs: [] },
    { text: "Fifth fact", basis: "derived", refs: [] }
  ];

  it("shows each fact with its basis label and its own sources", () => {
    const out = html(createElement(FactList, { facts: facts.slice(0, 2) }));
    expect(out).toContain("Due Oct 21, status in_progress");
    expect(out).toContain("Record");
    expect(out).toContain("Derived");
    expect(hrefs(out)).toEqual(["/tasks/t1"]);
  });

  it("keeps facts past max reachable behind a native disclosure", () => {
    const out = html(createElement(FactList, { facts, max: 3 }));
    expect(out).toContain("<details");
    expect(out).toContain("Show 2 more facts");
    expect(out).toContain("Fourth fact");
    expect(out).toContain("Fifth fact");
  });

  it("escapes fact text and renders nothing for no facts", () => {
    expect(html(createElement(FactList, { facts }))).toContain(ESCAPED);
    expect(html(createElement(FactList, { facts }))).not.toContain("<script");
    expect(html(createElement(FactList, { facts: [] }))).toBe("");
  });
});

describe("SourceLinks", () => {
  it("opens DD refs in place as paths and Slack/Outlook refs in a new tab with noopener noreferrer", () => {
    const out = html(createElement(SourceLinks, { refs: [ddRef("t1"), slackRef] }));
    expect(hrefs(out)).toEqual(["/tasks/t1", "https://scaledai.slack.com/archives/C1/p1700000000000100"]);
    expect(out.match(/target="_blank"/g)).toHaveLength(1);
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toMatch(/<a[^>]*href="https:\/\/scaledai\.slack\.com[^"]*"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|<a[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*href="https:\/\/scaledai\.slack\.com/);
  });

  it("renders a ref with no url as its label, as text", () => {
    const out = html(createElement(SourceLinks, { refs: [{ ...ddRef("t2", "Unlinked task"), url: null }] }));
    expect(out).toContain("Unlinked task");
    expect(hrefs(out)).toEqual([]);
  });

  it("re-checks urls read back from storage: a url off the allowlist is shown as text", () => {
    const hostile: SourceRef[] = [
      { ...ddRef("t3", "Evil"), url: "https://evil.example/x" },
      { ...ddRef("t4", "Script"), url: "javascript:alert(1)" },
      { ...ddRef("t5", "Proto-relative"), url: "//evil.example/x" }
    ];
    const out = html(createElement(SourceLinks, { refs: hostile }));
    expect(hrefs(out)).toEqual([]);
    expect(out).toContain("Evil");
    expect(out).toContain("Script");
  });

  it("names each ref's system for screen readers, and an unknown system as stored", () => {
    const out = textOf(html(createElement(SourceLinks, { refs: [ddRef("t7"), slackRef, { ...ddRef("t8"), system: "fax" as SourceRef["system"] }] })));
    expect(out).toContain("DD: Task t7");
    expect(out).toContain("Slack: #ops thread");
    expect(out).toContain("fax: Task t8");
  });

  it("escapes labels", () => {
    const out = html(createElement(SourceLinks, { refs: [ddRef("t6", SCRIPT)] }));
    expect(out).toContain(ESCAPED);
    expect(out).not.toContain("<script");
  });

  it("keeps refs past max reachable behind a disclosure, and renders nothing for none", () => {
    const refs = ["a", "b", "c", "d"].map((id) => ddRef(id));
    const out = html(createElement(SourceLinks, { refs, max: 2 }));
    expect(hrefs(out)).toEqual(["/tasks/a", "/tasks/b", "/tasks/c", "/tasks/d"]);
    expect(out).toContain("+2 more sources");
    expect(out).toContain("<details");
    expect(html(createElement(SourceLinks, { refs: [] }))).toBe("");
  });
});

describe("EmptyState", () => {
  it("renders its message, detail and action", () => {
    const out = html(createElement(EmptyState, { message: "Nothing waiting.", detail: "Checked 9:00 AM", action: createElement("a", { href: "/approvals" }, "Open approvals") }));
    expect(out).toContain("Nothing waiting.");
    expect(out).toContain("Checked 9:00 AM");
    expect(hrefs(out)).toEqual(["/approvals"]);
  });

  it("escapes its message", () => {
    expect(html(createElement(EmptyState, { message: SCRIPT }))).toContain(ESCAPED);
  });
});

// ---------------------------------------------------------------------------
// P9 (contract §2.7, F5, F25, F33): contrast, tap targets, reduced motion
// ---------------------------------------------------------------------------

const P9_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const palette = createRequire(import.meta.url)("tailwindcss/colors") as Record<string, Record<string, string> | string>;

/** The tailwind.config.ts tokens the exec classes use, read from the config file itself (so the test follows it). */
function configTokens(): Record<string, string> {
  const text = readFileSync(path.join(P9_ROOT, "tailwind.config.ts"), "utf8");
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*"?([a-z0-9-]+)"?:\s*"(#[0-9A-Fa-f]{6})"/gm)) out[m[1]] = m[2];
  return out;
}
const TOKENS = configTokens();

function hex(token: string): string {
  if (token === "white") return "#ffffff";
  if (token === "black") return "#000000";
  if (TOKENS[token]) return TOKENS[token];
  const m = /^([a-z]+)-(\d{2,3})$/.exec(token);
  const shades = m ? palette[m[1]] : undefined;
  const value = m && typeof shades === "object" ? shades[m[2]] : undefined;
  if (typeof value !== "string") throw new Error(`no color for ${token}`);
  return value;
}
type Rgb = [number, number, number];
const rgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const blend = (fg: Rgb, under: Rgb, alpha: number): Rgb => fg.map((c, i) => c * alpha + under[i] * (1 - alpha)) as Rgb;
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** "amber-50", "ok/10", "white/10" → a color, blended over `under` when it has an alpha. */
function colorOf(spec: string, under: Rgb): Rgb {
  const [token, alpha] = spec.split("/");
  const c = rgb(hex(token));
  return alpha === undefined ? c : blend(c, under, Number(alpha) / 100);
}
/** The text and background color classes of one class string (state and breakpoint variants ignored). */
function colorClasses(classes: string): { text: string | null; bg: string | null } {
  let text: string | null = null;
  let bg: string | null = null;
  for (const t of classes.split(/\s+/)) {
    if (t.includes(":")) continue;
    // A palette color ("amber-800"), a config token ("ok", "surface2", "accent"), each with an optional "/alpha".
    const tm = /^text-([a-z]+[0-9]?(?:-\d{1,3})?(?:\/\d{1,3})?)$/.exec(t);
    if (tm && !/^(?:left|right|center|justify|xs|sm|base|lg|xl|\d?xl)$/.test(tm[1])) text = tm[1];
    const bm = /^bg-([a-z]+[0-9]?(?:-\d{1,3})?(?:\/\d{1,3})?)$/.exec(t);
    if (bm && !/^(?:gradient|clip|fixed|cover|contain|center|none|repeat)$/.test(bm[1])) bg = bm[1];
  }
  return { text, bg };
}
const WHITE: Rgb = [255, 255, 255];
/** text vs its own background (or `fallbackBg` when the class string has none), each alpha blended over `under`. */
function ratioOf(classes: string, opts: { under?: Rgb; fallbackBg?: string } = {}): number {
  const under = opts.under ?? WHITE;
  const { text, bg } = colorClasses(classes);
  if (text === null) throw new Error(`no text color in "${classes}"`);
  const background = bg !== null ? colorOf(bg, under) : opts.fallbackBg ? colorOf(opts.fallbackBg, under) : under;
  return contrast(colorOf(text, background), background);
}

describe("P9 F5: meaning-carrying tones meet WCAG AA (4.5:1 for text, 3:1 for the switch track)", () => {
  const AA = 4.5;

  it("the computation itself: known pairs from the audit (the old tones fail, the new ones pass)", () => {
    expect(ratioOf("text-warn bg-warn/10")).toBeLessThan(3);
    expect(ratioOf("text-ok bg-ok/10")).toBeLessThan(3);
    expect(ratioOf("text-muted bg-surface2")).toBeLessThan(AA);
    expect(ratioOf("text-slate-400")).toBeLessThan(3);
    expect(ratioOf("text-amber-800 bg-amber-50")).toBeCloseTo(6.84, 1);
    expect(ratioOf("text-slate-500")).toBeCloseTo(4.76, 1);
  });

  it("PriorityBandBadge: every band", () => {
    for (const [band, meta] of Object.entries(BAND_META)) expect(ratioOf(meta.className), band).toBeGreaterThanOrEqual(AA);
    expect(Object.values(BAND_META).map((m) => m.className).join(" ")).not.toMatch(/\bbadge-(?:high|critical|low)\b/);
  });

  it("CategoryBadge: every category and the unknown fallback", () => {
    for (const [category, meta] of Object.entries(CATEGORY_META)) expect(ratioOf(meta.className), category).toBeGreaterThanOrEqual(AA);
    expect(ratioOf(CATEGORY_FALLBACK_CLASS)).toBeGreaterThanOrEqual(AA);
  });

  it("project status (the Projects pages and the Overview section) and the neutral badge", () => {
    for (const [status, meta] of Object.entries(PROJECT_STATUS_META)) expect(ratioOf(meta.className), status).toBeGreaterThanOrEqual(AA);
    for (const [status, meta] of Object.entries(OVERVIEW_PROJECT_STATUS)) expect(ratioOf(meta.className), status).toBeGreaterThanOrEqual(AA);
    expect(ratioOf(NEUTRAL_BADGE)).toBeGreaterThanOrEqual(AA);
  });

  it("the email chips", () => {
    for (const [tone, classes] of Object.entries(CHIP_TONE)) expect(ratioOf(classes), tone).toBeGreaterThanOrEqual(AA);
  });

  it("StatTile: every delta tone on every tint (the tint's 60% wash over the page background)", () => {
    const page = rgb(hex("bg"));
    for (const [tint, tintClasses] of Object.entries(TILE_TINT)) {
      const bg = colorClasses(tintClasses).bg;
      for (const [tone, textClass] of Object.entries(TILE_TONE)) {
        expect(ratioOf(textClass, { under: page, fallbackBg: bg ?? undefined }), `${tone} on ${tint}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("BasisLabel: light on white, dark on the brief card's slate-900", () => {
    const card = rgb(hex("slate-900"));
    for (const [basis, meta] of Object.entries(BASIS_META)) {
      expect(ratioOf(meta.light), `${basis} light`).toBeGreaterThanOrEqual(AA);
      expect(ratioOf(meta.dark, { under: card }), `${basis} dark`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("a withheld brief line, a zero count, the header's Private pill and every brief pill state", () => {
    expect(ratioOf(BRIEF_WITHHELD_TEXT)).toBeGreaterThanOrEqual(AA);
    expect(ratioOf(ZERO_COUNT_TEXT)).toBeGreaterThanOrEqual(AA);
    const header = html(createElement(ExecHeader, { updatedAt: "2026-11-04T13:02:00Z", tz: "UTC" }));
    const pill = /<span class="([^"]*)">Private<\/span>/.exec(header)?.[1] ?? "";
    expect(ratioOf(pill)).toBeGreaterThanOrEqual(AA);
    for (const [state, classes] of Object.entries(BRIEF_PILL_TONE)) expect(ratioOf(classes), state).toBeGreaterThanOrEqual(AA);
  });

  it("the switches' off track stands out from white (3:1, WCAG 1.4.11), and all three switches use it", () => {
    expect(contrast(colorOf(SWITCH_TRACK.off.replace(/^bg-/, ""), WHITE), WHITE)).toBeGreaterThanOrEqual(3);
    expect(contrast(colorOf(SWITCH_TRACK.on.replace(/^bg-/, ""), WHITE), WHITE)).toBeGreaterThanOrEqual(3);
    for (const rel of ["settings/SettingsForm.tsx", "settings/BriefSettingsForm.tsx", "settings/SlackReadingControls.tsx"]) {
      const src = readFileSync(path.join(P9_ROOT, "src/components/exec", rel), "utf8");
      expect(src, rel).toMatch(/className=\{switchTrackClass\(on\)\}/);
      expect(src, rel).not.toMatch(/bg-slate-300/);
    }
  });
});

describe("P9 F25: 40 px tap targets below sm", () => {
  it("every tab pill carries a base (unprefixed) min-h-10, and the gear is 40x40 below sm", () => {
    expect(EXEC_TAB_PILL.split(" ")).toEqual(expect.arrayContaining(["min-h-10", "sm:min-h-0"]));
    expect(EXEC_GEAR.split(" ")).toEqual(expect.arrayContaining(["h-10", "w-10", "sm:h-8", "sm:w-8"]));
    const out = html(createElement(ExecTabs, { active: "overview", tabs: EXEC_TABS }));
    const links = [...out.matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => m[1].split(" "));
    expect(links).toHaveLength(EXEC_TABS.length + 1);
    for (const c of links.slice(0, EXEC_TABS.length)) expect(c).toContain("min-h-10");
    expect(links[EXEC_TABS.length]).toEqual(expect.arrayContaining(["h-10", "w-10"]));
  });

  it("P9 fixer ui-2: below sm the strip wraps, so the current pill is on screen with no script; one row from sm up", () => {
    const classes = EXEC_TAB_STRIP.split(" ");
    // Below sm (unprefixed): wraps onto rows inside a rounded box; nothing forces one line.
    expect(classes).toEqual(expect.arrayContaining(["flex-wrap", "rounded-2xl", "min-w-0", "max-w-full"]));
    expect(classes).not.toContain("flex-nowrap");
    expect(classes).not.toContain("whitespace-nowrap");
    expect(classes).not.toContain("rounded-full");
    // From sm up: the one-row pill as before.
    expect(classes).toEqual(expect.arrayContaining(["sm:flex-nowrap", "sm:rounded-full", "sm:gap-0.5"]));
    for (const active of ["overview", "projects", "chat"]) {
      const out = html(createElement(ExecTabs, { active, tabs: EXEC_TABS }));
      expect(/<div data-exec-tab-strip="true" class="([^"]*)"/.exec(out)?.[1], active).toBe(EXEC_TAB_STRIP);
    }
  });

  it("the switches are a 40x56 px hit area below sm around the 24x44 track", () => {
    expect(SWITCH_BUTTON.split(" ")).toEqual(expect.arrayContaining(["h-10", "w-14", "sm:h-6", "sm:w-11"]));
  });

  it("the draft page makes the shared editor's two format buttons 40x40 px with an 8 px gap below sm, the editor's own 28 px from sm", () => {
    // DD's shared email editor (src/components/email-editor) draws them at 28x28 with a 4 px gap and stays unchanged; the
    // exec draft panel's wrapper sizes its direct children, the two buttons, with Tailwind's child variant (the §2.7
    // harness's TT01 at 390 px).
    const src = readFileSync(path.join(P9_ROOT, "src/components/exec/drafts/DraftPanel.tsx"), "utf8");
    const wrap = /export const FORMAT_BUTTONS_WRAP = "([^"]*)";/.exec(src)?.[1] ?? "";
    expect(wrap.split(" ")).toEqual(expect.arrayContaining(["gap-2", "sm:gap-1", "*:h-10", "*:w-10", "sm:*:h-7", "sm:*:w-7"]));
    expect(src).toMatch(/<span className=\{FORMAT_BUTTONS_WRAP\}>\s*<EmailFormatButtons /);
    expect(src.match(/<EmailFormatButtons /g)).toHaveLength(1);
  });
});

describe("P9 F33: reduced motion", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : []));
  const EXEC_COMPONENTS = path.join(P9_ROOT, "src/components/exec");

  /** Every string literal (quotes or backticks) in a source file: the class lists among them. */
  const literals = (src: string) => [...src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");

  /** The motion classes of one literal that have no reduced-motion partner. */
  function unguarded(literal: string): string[] {
    const tokens = literal.split(/\s+/);
    const bad: string[] = [];
    for (const t of tokens) {
      if (/(?:^|:)animate-(?!none)/.test(t) && !t.startsWith("motion-safe:") && !tokens.includes("motion-reduce:animate-none")) bad.push(t);
      if (/(?:^|:)transition-transform$/.test(t) && !t.startsWith("motion-safe:") && !tokens.includes("motion-reduce:transition-none")) bad.push(t);
    }
    return bad;
  }

  it("the check finds an unguarded spin and a bare transform transition (control)", () => {
    expect(unguarded("h-3 w-3 animate-spin text-slate-400")).toEqual(["animate-spin"]);
    expect(unguarded("transition-transform group-open:rotate-180")).toEqual(["transition-transform"]);
    expect(unguarded("motion-safe:animate-spin")).toEqual([]);
    expect(unguarded("transition-transform motion-reduce:transition-none")).toEqual([]);
  });

  it("every animate-* and transition-transform under components/exec has a motion-safe: / motion-reduce: partner", () => {
    const found: string[] = [];
    for (const file of files(EXEC_COMPONENTS)) {
      const src = readFileSync(file, "utf8");
      for (const lit of literals(src)) for (const t of unguarded(lit)) found.push(`${path.relative(EXEC_COMPONENTS, file)}: ${t}`);
    }
    expect(found).toEqual([]);
  });

  it("no smooth scroll that ignores prefers-reduced-motion", () => {
    for (const file of files(EXEC_COMPONENTS)) {
      const src = readFileSync(file, "utf8");
      expect(src, path.relative(EXEC_COMPONENTS, file)).not.toMatch(/behavior:\s*["']smooth["']/);
    }
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(prefersReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
  });
});
