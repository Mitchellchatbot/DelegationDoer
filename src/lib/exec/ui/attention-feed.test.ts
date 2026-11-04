import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionFeed } from "@/components/exec/AttentionFeed";
import { AttentionRow } from "@/components/exec/AttentionRow";
import type { AttentionItem, AttentionSource, PriorityBand } from "@/lib/exec/attention-types";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, "");
const NNBSP = String.fromCharCode(0x202f);
const norm = (s: string) => s.split(NNBSP).join(" ");
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

const NOW = new Date("2026-11-04T15:00:00Z");
const TZ = "America/New_York";
const SCRIPT = "<script>alert(1)</script>";
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "ea_1",
    principalId: "ep_1",
    fingerprint: "dd:overdue:assignee:u_sam",
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: "Sam has 3 overdue tasks",
    whatHappened: "3 open tasks assigned to Sam are past their due date.",
    whyItMatters: "Two of them are client-facing.",
    recommendedNext: "Ask Sam for new dates or decide whether to reassign.",
    facts: [
      {
        text: "Oldest is 14 days overdue",
        basis: "derived",
        refs: [{ system: "dd", id: "t_1", url: "https://operations.scaledai.org/tasks/t_1", label: "Fix the sitemap", class: "internal" }]
      },
      { text: "Due Oct 21, status in_progress", basis: "record", refs: [] }
    ],
    refs: [
      { system: "dd", id: "t_1", url: "https://operations.scaledai.org/tasks/t_1", label: "Fix the sitemap", class: "internal" },
      { system: "dd", id: "u_sam", url: null, label: "Sam", class: "internal" }
    ],
    priority: { score: 62, band: "high", reasons: ["Overdue tasks (base 25)", "Overdue 14 days (+28)", "Count 3 (+6)"] },
    stateHash: "abcd1234abcd1234",
    occurredAt: "2026-10-31T15:00:00Z",
    status: "open",
    snoozeUntil: null,
    firstSeenAt: "2026-11-04T13:00:00Z",
    lastSeenAt: "2026-11-04T14:50:00Z",
    resolvedAt: null,
    resolution: null,
    updatedAt: "2026-11-04T14:50:00Z",
    ...overrides
  };
}

const row = (overrides: Partial<AttentionItem> = {}) => html(createElement(AttentionRow, { item: item(overrides), now: NOW, tz: TZ }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AttentionRow", () => {
  it("shows source, band, category, title, what happened, why it matters, suggestion, facts, sources and age", () => {
    const out = norm(row());
    const text = textOf(out);
    expect(text).toContain("Source: DD");
    expect(text).toContain("High");
    expect(text).toContain("Delegated");
    expect(out).toContain("<h3");
    expect(text).toContain("Sam has 3 overdue tasks");
    expect(text).toContain("3 open tasks assigned to Sam are past their due date.");
    expect(text).toContain("Why it matters: Two of them are client-facing.");
    expect(text).toContain("Suggested next step");
    expect(text).toContain("Ask Sam for new dates or decide whether to reassign.");
    expect(text).toContain("Oldest is 14 days overdue");
    expect(text).toContain("Derived");
    expect(text).toContain("Record");
    expect(hrefs(out)).toEqual(["/tasks/t_1", "/tasks/t_1"]);
    expect(text).toContain("Sam");
    expect(out).toContain('<time dateTime="2026-10-31T15:00:00Z" title="Oct 31, 11:00 AM EDT"');
    expect(text).toContain("4 d");
  });

  it("puts the score and every priority reason in the band's tooltip", () => {
    expect(row()).toContain('title="Priority score 62 of 100\nOverdue tasks (base 25)\nOverdue 14 days (+28)\nCount 3 (+6)"');
  });

  it("always shows the Suggested label when there is a recommendation, and never without one", () => {
    expect(textOf(row({ recommendedNext: "Decide whether to reassign." }))).toContain("Suggested next step");
    expect(textOf(row({ recommendedNext: null }))).not.toContain("Suggested");
    expect(textOf(row({ recommendedNext: "   " }))).not.toContain("Suggested");
  });

  it("keeps the suggestion apart from the facts, inside its own labeled block", () => {
    const out = row();
    const suggested = out.indexOf("Suggested next step");
    const recommendation = out.indexOf("Ask Sam for new dates");
    const firstFact = out.indexOf("Oldest is 14 days overdue");
    expect(suggested).toBeGreaterThan(-1);
    expect(recommendation).toBeGreaterThan(suggested);
    expect(firstFact).toBeGreaterThan(recommendation);
  });

  it("escapes <script> everywhere text appears", () => {
    const out = row({
      title: SCRIPT,
      whatHappened: SCRIPT,
      whyItMatters: SCRIPT,
      recommendedNext: SCRIPT,
      facts: [{ text: SCRIPT, basis: "ai", refs: [] }],
      refs: [{ system: "dd", id: "x", url: null, label: SCRIPT, class: "internal" }]
    });
    expect(out).not.toContain("<script");
    // title, what happened, why, suggestion, fact, and the ref label twice
    // (its text and its tooltip).
    expect(out.split(ESCAPED).length - 1).toBe(7);
  });

  it("leaves out empty text blocks", () => {
    const text = textOf(row({ whatHappened: "", whyItMatters: "  ", facts: [], refs: [] }));
    expect(text).not.toContain("Why it matters");
    expect(text).toContain("Sam has 3 overdue tasks");
  });

  it("dates the age from occurredAt, else says it is since first seen", () => {
    const fromFirstSeen = norm(row({ occurredAt: null }));
    expect(textOf(fromFirstSeen)).toContain("first seen 2 h");
    expect(fromFirstSeen).toContain('title="First seen Nov 4, 8:00 AM EST"');
    expect(textOf(row({ occurredAt: "2026-11-04T14:59:30Z" }))).toContain("just now");
    expect(textOf(row({ occurredAt: "2026-11-04T14:59:30Z" }))).not.toContain("ago");
  });

  it("shows the year on an age tooltip from an earlier year", () => {
    expect(norm(row({ occurredAt: "2025-12-15T15:00:00Z" }))).toContain('title="Dec 15, 2025, 10:00 AM EST"');
  });

  it("uses the source's icon and label, and names an unknown source as stored rather than as DD", () => {
    const sources: Array<[AttentionSource, string]> = [["dd", "DD"], ["email", "Email"], ["slack", "Slack"]];
    for (const [source, label] of sources) {
      const out = row({ source });
      expect(textOf(out)).toContain(`Source: ${label}`);
      expect(out).toContain(`title="${label}"`);
    }
    const unknown = textOf(row({ source: "fax" as AttentionSource }));
    expect(unknown).toContain("Source: fax");
    expect(unknown).not.toContain("Source: DD");
  });

  it("colors the icon tile by band", () => {
    const tones: Array<[PriorityBand, string]> = [["critical", "bg-rose-50"], ["high", "bg-amber-50"], ["normal", "bg-slate-100"]];
    for (const [band, tone] of tones) {
      const out = row({ priority: { score: 10, band, reasons: [] } });
      expect(out).toContain(tone);
    }
  });
});

describe("AttentionFeed", () => {
  it("renders the items in the order given, as a list", () => {
    const items = [item({ id: "ea_a", title: "First" }), item({ id: "ea_b", title: "Second" }), item({ id: "ea_c", title: "Third" })];
    const out = html(createElement(AttentionFeed, { items, now: NOW, tz: TZ, checkedAt: "2026-11-04T14:50:00Z" }));
    expect(out.startsWith("<ol")).toBe(true);
    expect(out.match(/<li/g)?.length).toBeGreaterThanOrEqual(3);
    const order = ["First", "Second", "Third"].map((t) => out.indexOf(`>${t}<`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("says nothing needs him only when a check is known to have run", () => {
    const out = norm(html(createElement(AttentionFeed, { items: [], now: NOW, tz: TZ, checkedAt: "2026-11-04T14:50:00Z" })));
    expect(textOf(out)).toContain("Nothing needs you right now.");
    expect(out).toContain('Last checked <time dateTime="2026-11-04T14:50:00Z">Nov 4, 9:50 AM EST</time>');
  });

  it("says nothing has been checked yet, not 'nothing needs you', before the first scan", () => {
    for (const checkedAt of [null, undefined]) {
      const text = textOf(html(createElement(AttentionFeed, { items: [], now: NOW, tz: TZ, checkedAt })));
      expect(text).toContain("Nothing here yet.");
      expect(text).not.toContain("Nothing needs you");
    }
  });
});
