import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASIS_META, BasisLabel } from "@/components/exec/BasisLabel";
import { CATEGORY_META, CategoryBadge } from "@/components/exec/CategoryBadge";
import { EmptyState } from "@/components/exec/EmptyState";
import { EXEC_TABS, ExecTabs } from "@/components/exec/ExecTabs";
import { ExecHeader } from "@/components/exec/ExecHeader";
import { FactList } from "@/components/exec/FactList";
import { BAND_META, PriorityBandBadge } from "@/components/exec/PriorityBandBadge";
import { SectionCard } from "@/components/exec/SectionCard";
import { SourceLinks } from "@/components/exec/SourceLinks";
import { Sparkline } from "@/components/exec/Sparkline";
import { StatTile } from "@/components/exec/StatTile";
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
    const tabs = [...EXEC_TABS, { key: "chat", href: "/executive/chat", label: "Chat" }];
    const out = html(createElement(ExecTabs, { active: "chat", tabs }));
    expect(hrefs(out)).toEqual(["/executive", "/executive/email", "/executive/team", "/executive/projects", "/executive/chat", "/executive/settings"]);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/executive\/chat"|<a[^>]*href="\/executive\/chat"[^>]*aria-current="page"/);
  });

  it("ships Overview, Email (P3), Team and Projects (P5a), the pages that exist, so it never links to a 404", () => {
    expect(EXEC_TABS).toEqual([
      { key: "overview", href: "/executive", label: "Overview" },
      { key: "email", href: "/executive/email", label: "Email" },
      { key: "team", href: "/executive/team", label: "Team" },
      { key: "projects", href: "/executive/projects", label: "Projects" }
    ]);
    const out = html(createElement(ExecTabs, { active: "overview", tabs: EXEC_TABS }));
    // The Settings gear is an icon with an aria-label: no visible text.
    expect(textOf(out)).toBe("OverviewEmailTeamProjects");
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
    expect(out).toContain("text-emerald-600");
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
