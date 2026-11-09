import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttentionRow } from "@/components/exec/AttentionRow";
import { EXEC_TABS, ExecTabs } from "@/components/exec/ExecTabs";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { NOW, TZ, ddtextItem, emailItem, feedItem, textOf } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 tests 70 (C24, a-correct-11) and 71 (C23).

const row = (item: AttentionFeedItem, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AttentionRow, { item, now: NOW, tz: TZ, ...extra }));
/** The markup with every attribute removed: what remains is element names and text. */
const withoutAttributes = (html: string) => html.replace(/<([a-zA-Z0-9]+)(?:\s[^>]*)?>/g, "<$1>");

beforeEach(() => {
  // AttentionRow builds DD paths from refs; an origin here would change them.
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The opening <a> tag that carries `attr`, whatever the attribute order. */
const tagWith = (markup: string, attr: string) =>
  [...markup.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(attr)) ?? "";

describe("AttentionRow additions (test 70)", () => {
  it("renders the actions slot after the sources", () => {
    const html = row(feedItem(), { actions: createElement("div", { "data-slot": "x" }, "ACTIONS HERE") });
    expect(html).toContain("ACTIONS HERE");
    expect(html.indexOf("ACTIONS HERE")).toBeGreaterThan(html.lastIndexOf("Fix the sitemap"));
  });

  it("reasonsDisclosure adds a 'Why <band>' disclosure with the score and every reason", () => {
    const html = row(feedItem(), { reasonsDisclosure: true });
    const disclosure = html.slice(html.indexOf("<details data-reasons"));
    expect(disclosure).toMatch(/^<details data-reasons[^>]*><summary[^>]*>Why high<\/summary><ul[^>]*><li>Priority score 62 of 100<\/li>/);
    for (const reason of ["Overdue tasks (base 25)", "Overdue 14 days (+28)", "Count 3 (+6)"]) expect(disclosure).toContain(reason);
  });

  it("without the new props the markup is P2b's: no disclosure, no slot", () => {
    const plain = row(feedItem());
    expect(plain).not.toContain("data-reasons");
    expect(plain).toBe(row(feedItem(), { actions: null, reasonsDisclosure: false }));
    expect(plain).toBe(row(feedItem(), { actions: undefined }));
  });

  it("P4's draftReplyHref still renders its one link", () => {
    const html = row(emailItem(), { draftReplyHref: "/executive/email/drafts/new?threadId=t_thread1", reasonsDisclosure: true, actions: createElement("span", null, "A") });
    expect((html.match(/data-draft-reply/g) ?? []).length).toBe(1);
    expect(html).toContain('href="/executive/email/drafts/new?threadId=t_thread1"');
  });

  for (const kind of ["ddtext_blocker", "ddtext_waiting", "ddtext_decision"] as const) {
    it(`${kind}: a visible "AI-assessed" label beside the title, in the text and not only in a title attribute`, () => {
      const html = row(ddtextItem(kind, { facts: [] }));
      const text = textOf(withoutAttributes(html));
      expect(text).toContain("AI-assessed");
      // Right after the title.
      const title = html.indexOf("Possible blocker on");
      const label = html.indexOf(">AI-assessed<");
      expect(label).toBeGreaterThan(title);
      expect(html.slice(title, label)).not.toContain("<p");
    });
  }

  it("ddtext_mention (deterministic, no AI reading) carries no AI-assessed label", () => {
    const html = row(ddtextItem("ddtext_mention", { facts: [] }));
    expect(textOf(withoutAttributes(html))).not.toContain("AI-assessed");
  });

  it("other kinds don't get the title label", () => {
    expect(textOf(withoutAttributes(row(feedItem({ facts: [] }))))).not.toContain("AI-assessed");
  });
});

describe("ExecTabs (test 71)", () => {
  const html = (active: string) => renderToStaticMarkup(createElement(ExecTabs, { active, tabs: EXEC_TABS }));
  const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

  it("Overview, Email, Team, Projects, in order (and P5b's Chat after them), then the Settings link", () => {
    expect(EXEC_TABS.map((t) => t.label)).toEqual(["Overview", "Email", "Slack", "Team", "Projects", "Chat"]);
    expect(hrefs(html("overview"))).toEqual(["/executive", "/executive/email", "/executive/slack", "/executive/team", "/executive/projects", "/executive/chat", "/executive/settings"]);
    expect(tagWith(html("overview"), 'href="/executive/settings"')).toContain('aria-label="Settings"');
    expect(tagWith(html("overview"), 'href="/executive/settings"')).not.toContain("aria-current");
  });

  it("the Settings link is the current page only on Settings", () => {
    const settings = html("settings");
    expect(settings.match(/aria-current="page"/g)).toHaveLength(1);
    expect(tagWith(settings, 'href="/executive/settings"')).toContain('aria-current="page"');
    const team = html("team");
    expect(team.match(/aria-current="page"/g)).toHaveLength(1);
    expect(tagWith(team, 'href="/executive/team"')).toContain('aria-current="page"');
    expect(tagWith(team, 'href="/executive/settings"')).not.toContain("aria-current");
  });
});
