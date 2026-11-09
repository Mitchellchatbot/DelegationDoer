import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() })) }));

import { askAiClickContext, chatPageHref, EXEC_CHAT_COPY, type AskAiClickLike } from "@/components/exec/chat/ExecChat";
import { EXEC_TABS, ExecTabs } from "@/components/exec/ExecTabs";
import { askAiHrefFor, FeedList } from "@/components/exec/feed/FeedList";
import { OverviewView } from "@/components/exec/overview/OverviewView";
import { ProjectDetailPageView } from "@/components/exec/projects/ProjectDetailPageView";
import { askAiLockedText, CHAT_SECTION_TITLE, effectiveChatCapText, SettingsForm } from "@/components/exec/settings/SettingsForm";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { chatContextHref } from "@/lib/exec/chat/context-param";
import { ASK_ABOUT_PROJECT_LINK, CHAT_NOT_INSTALLED_TEXT, CHAT_STARTERS, CHAT_TAB_LABEL, RAIL_TITLE } from "@/lib/exec/chat/copy";
import type { ExecOverview } from "@/lib/exec/overview";
import { SETTINGS_FIELDS } from "@/lib/exec/settings-fields";
import { feedReducer, initialFeedState } from "@/lib/exec/ui/feed-state";
import { ATTENTION_ID, hrefsOf, textOf } from "../__tests__/chat-ui-fixtures";
import { feedItem, itemId, projectDetailView, settings, settingsView } from "../__tests__/p5a-ui-fixtures";

// P5b contract §5 test 100 (Area E; §3.19.8, §3.19.11, §3.19.12, C33, C34):
// the Chat tab, the Overview rail only with `chat`, the rail's interception of
// a plain click on a feed row's Ask AI (and not of a modified one), Ask AI on
// Load-more rows; plus the Settings Chat section and the page links.

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const source = (file: string) => readFileSync(path.join(SRC, file), "utf8");
const NOW = "2026-11-06T15:00:00.000Z";
const TZ = "America/New_York";

function overview(): ExecOverview {
  const down = { ok: false as const, error: "unavailable" as const };
  return {
    generatedAt: NOW,
    timezone: TZ,
    sections: {
      tiles: down,
      attention: {
        ok: true,
        data: { items: [feedItem({ id: itemId(1), title: "Overdue: Acme renewal" }), feedItem({ id: itemId(2), title: "Waiting on client" })], limit: 20, checkedAt: NOW, emailUnchecked: false, hasMore: false, hiddenEmail: 0, emailScreen: "none", ddtextCheckedAt: null }
      },
      approvals: down,
      deadlines: down,
      projects: down,
      system: down,
      email: down
    }
  } as unknown as ExecOverview;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.mocked(useIsTopWindow).mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tabs and the Overview rail (test 100)", () => {
  it("ExecTabs lists Chat, to /executive/chat, before the Settings gear", () => {
    expect(EXEC_TABS.find((t) => t.key === "chat")).toEqual({ key: "chat", href: "/executive/chat", label: CHAT_TAB_LABEL });
    const html = renderToStaticMarkup(createElement(ExecTabs, { active: "chat", tabs: EXEC_TABS }));
    expect(hrefsOf(html).slice(-2)).toEqual(["/executive/chat", "/executive/settings"]);
  });

  it("OverviewView renders the rail only with `chat`, and the feed rows' Ask AI with it", () => {
    const without = renderToStaticMarkup(createElement(OverviewView, { overview: overview(), principalTz: TZ }));
    expect(without).not.toContain("data-exec-chat");
    expect(without).not.toContain("data-exec-ask-ai");
    const nulled = renderToStaticMarkup(createElement(OverviewView, { overview: overview(), principalTz: TZ, chat: null }));
    expect(nulled).not.toContain("data-exec-chat");
    const withChat = renderToStaticMarkup(createElement(OverviewView, { overview: overview(), principalTz: TZ, chat: { starters: CHAT_STARTERS } }));
    expect(withChat).toContain('data-exec-chat="rail"');
    expect(textOf(withChat)).toContain(RAIL_TITLE);
    expect(withChat.match(/data-exec-ask-ai="/g)).toHaveLength(2);
    expect(withChat).toContain(`href="/executive/chat?context=attention:${itemId(1)}"`);
    // The rail heads the right column: after the feed card, before the other cards.
    expect(withChat.indexOf('data-exec-chat="rail"')).toBeGreaterThan(withChat.indexOf("data-feed-list"));
    // A fresh conversation on every load (C34): no Open in Chat until an answer exists.
    expect(withChat).not.toContain("data-open-in-chat");
  });

  it("the Overview page passes chat only while chat is installed and on", () => {
    const page = source("app/(main)/executive/page.tsx");
    expect(page).toContain("settings.chatSchemaReady && settings.chatEnabled ? { starters: CHAT_STARTERS, emailOn: chatEmailOn(settings, principal) } : null");
    expect(page).toContain("loadSettings(principal.id).catch(() => null)");
  });
});

describe("the rail's Ask AI interception (test 100, C33)", () => {
  // A minimal DOM: the link inside its feed row, the row's title in an h3.
  function linkIn(rowTitle: string | null, id = ATTENTION_ID) {
    const row = { getAttribute: () => null, closest: () => null, querySelector: (s: string) => (s === "h3" && rowTitle !== null ? { textContent: `  ${rowTitle}\n ` } : null) };
    const link = {
      getAttribute: (n: string) => (n === "data-exec-ask-ai" ? id : null),
      closest: (s: string) => (s === "[data-feed-row]" ? row : s === "a[data-exec-ask-ai]" ? link : null),
      querySelector: () => null
    };
    const icon = { getAttribute: () => null, closest: (s: string) => (s === "a[data-exec-ask-ai]" ? link : s === "[data-feed-row]" ? row : null), querySelector: () => null };
    return { link, icon };
  }
  const click = (target: unknown, over: Partial<AskAiClickLike> = {}): AskAiClickLike => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, target, ...over });

  it("a plain left click on the link (or inside it) is taken: the item and the row's title", () => {
    const { link, icon } = linkIn("Overdue: Acme renewal");
    expect(askAiClickContext(click(link))).toEqual({ kind: "attention", id: ATTENTION_ID, label: "Overdue: Acme renewal" });
    expect(askAiClickContext(click(icon))).toEqual({ kind: "attention", id: ATTENTION_ID, label: "Overdue: Acme renewal" });
    expect(askAiClickContext(click(linkIn(null).link))).toEqual({ kind: "attention", id: ATTENTION_ID, label: EXEC_CHAT_COPY.askAiFallbackLabel });
  });

  it("a modified, middle or already-handled click isn't (the link navigates), nor another link, nor a bad id", () => {
    const { link } = linkIn("Overdue: Acme renewal");
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      expect(askAiClickContext(click(link, over)), JSON.stringify(over)).toBeNull();
    }
    const other = { getAttribute: () => null, closest: () => null, querySelector: () => null };
    expect(askAiClickContext(click(other))).toBeNull();
    expect(askAiClickContext(click(null))).toBeNull();
    expect(askAiClickContext(click(linkIn("x", "ea_bad").link))).toBeNull();
  });

  it("ExecChat listens on the document only with interceptAskAiLinks, in a top-level window, and prevents the navigation", () => {
    const src = source("components/exec/chat/ExecChat.tsx");
    expect(src).toContain("if (!interceptAskAiLinks || !isTop || typeof document === \"undefined\") return;");
    expect(src).toMatch(/const context = askAiClickContext\(e\);\s+if \(!context\) return;\s+e\.preventDefault\(\);\s+dispatch\(\{ type: "set_context", context \}\);/);
    expect(chatPageHref(null)).toBe("/executive/chat");
    expect(chatPageHref("ecv_1")).toBe("/executive/chat?c=ecv_1");
  });
});

describe("Ask AI on Load-more rows (test 100, coherence-16)", () => {
  it("askAiHrefFor builds the chat link per item when on, nothing when off", () => {
    expect(askAiHrefFor(itemId(7), true)).toBe(`/executive/chat?context=attention:${itemId(7)}`);
    expect(askAiHrefFor(itemId(7), false)).toBeNull();
  });

  it("FeedList with askAiEnabled gives every row an Ask AI link, Load more's included", () => {
    const first = [feedItem({ id: itemId(1) }), feedItem({ id: itemId(2) })];
    const more = [feedItem({ id: itemId(3) }), feedItem({ id: itemId(4) })];
    // The rows FeedList draws after Load more: its reducer's rows.
    const s = feedReducer(initialFeedState({ items: first, cursor: "cur1", tz: TZ }), { type: "load_more_succeeded", items: more, nextCursor: null, hiddenEmail: 0, emailScreen: "none" });
    expect(s.rows.map((r) => askAiHrefFor(r.item.id, true))).toEqual([1, 2, 3, 4].map((n) => `/executive/chat?context=attention:${itemId(n)}`));
    // FeedList renders that link for each row of its state (the same rows render the same way).
    const html = renderToStaticMarkup(
      createElement(FeedList, { mode: "full", initialItems: [...first, ...more], initialCursor: null, filters: {}, now: NOW, tz: TZ, checkedAt: NOW, ddtextCheckedAt: null, hiddenEmail: 0, emailScreen: "none", draftsAvailable: false, askAiEnabled: true })
    );
    for (const n of [1, 2, 3, 4]) expect(html).toContain(`data-exec-ask-ai="${itemId(n)}"`);
    expect(source("components/exec/feed/FeedList.tsx")).toContain("askAiHref={askAiHrefFor(row.item.id, askAiEnabled)}");
  });

  it("the full feed page passes askAiEnabled from the settings (chat installed and on)", () => {
    const page = source("app/(main)/executive/attention/page.tsx");
    expect(page).toContain("const askAiEnabled = gate !== null && gate.settings.chatSchemaReady && gate.settings.chatEnabled;");
    expect(page).toContain("askAiEnabled={askAiEnabled}");
    expect(source("components/exec/feed/AttentionPageView.tsx")).toContain("askAiEnabled={askAiEnabled}");
  });
});

describe("the page links (§3.19.11)", () => {
  it("chatContextHref builds /executive/chat?context=<kind>:<id>, the id encoded", () => {
    expect(chatContextHref("project", "p_1")).toBe("/executive/chat?context=project:p_1");
    expect(chatContextHref("thread", "AAMk/x=+")).toBe("/executive/chat?context=thread:AAMk%2Fx%3D%2B");
  });

  it("the project page shows 'Ask about this project' only with an href", () => {
    const view = projectDetailView();
    const without = renderToStaticMarkup(createElement(ProjectDetailPageView, { view }));
    expect(textOf(without)).not.toContain(ASK_ABOUT_PROJECT_LINK);
    const href = chatContextHref("project", view.project.id);
    const withLink = renderToStaticMarkup(createElement(ProjectDetailPageView, { view, askHref: href }));
    expect(textOf(withLink)).toContain(ASK_ABOUT_PROJECT_LINK);
    expect(hrefsOf(withLink)).toContain(href);
    const page = source("app/(main)/executive/projects/[id]/page.tsx");
    expect(page).toContain('settings.chatSchemaReady && settings.chatEnabled ? chatContextHref("project", id) : null');
  });

  it("the thread page passes the thread link only while chat is on", () => {
    const page = source("app/(main)/executive/email/[threadId]/page.tsx");
    expect(page).toContain('settings.chatSchemaReady && settings.chatEnabled ? chatContextHref("thread", page.view.threadId) : null');
    expect(source("components/exec/email/EmailThreadView.tsx")).toMatch(/\{askHref && \([\s\S]*?ASK_ABOUT_THREAD_LINK/);
  });
});

describe("Settings: the Chat section (§3.19.12)", () => {
  const form = (view = settingsView()) => renderToStaticMarkup(createElement(SettingsForm, { view }));
  const installed = (over: Parameters<typeof settings>[0] = {}) =>
    settingsView({ schema: { email: true, drafts: true, ddtext: true, chat: true }, settings: settings({ chatSchemaReady: true, chatEnabled: true, askAiUsesExec: false, chatDailyCapUsd: 9, ...over }), effectiveChatCapUsd: 9 });
  const fieldOf = (html: string, key: string) => {
    const at = html.indexOf(`data-setting="${key}"`);
    const next = html.indexOf("data-setting=", at + 10);
    return at < 0 ? "" : html.slice(html.lastIndexOf("<div", at), next < 0 ? undefined : html.lastIndexOf("<div", next));
  };

  it("not installed: the one sentence and no control", () => {
    const html = form();
    const section = html.slice(html.indexOf("data-chat-settings"));
    expect(textOf(section)).toContain(CHAT_NOT_INSTALLED_TEXT);
    for (const key of ["chatEnabled", "askAiUsesExec", "chatDailyCapUsd"]) expect(html).not.toContain(`data-setting="${key}"`);
    expect(section).not.toMatch(/<(button|input)\b/);
  });

  it("installed: Chat, its budget with the effective cap beside it, then Ask AI, with the §3.19.12 copy", () => {
    const html = form(installed());
    const section = html.slice(html.indexOf("data-chat-settings"));
    expect(textOf(section)).toContain(CHAT_SECTION_TITLE);
    const order = ["chatEnabled", "chatDailyCapUsd", "askAiUsesExec"].map((k) => section.indexOf(`data-setting="${k}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const def of SETTINGS_FIELDS.filter((d) => d.group === "chat")) {
      expect(textOf(fieldOf(html, def.key)), def.key).toContain(def.label);
      expect(textOf(fieldOf(html, def.key)), def.key).toContain(def.help);
    }
    expect(textOf(fieldOf(html, "chatEnabled"))).toContain("Ask questions in DD. Answers use Opus and count toward the daily AI budget.");
    expect(textOf(fieldOf(html, "chatDailyCapUsd"))).toContain(effectiveChatCapText(9));
    expect(effectiveChatCapText(4.5)).toBe("Chat can use up to $4.50 a day: this budget or 60% of the daily AI budget, whichever is lower.");
    // The chat fields are no longer in the generic groups.
    expect(html.match(/data-setting="chatEnabled"/g)).toHaveLength(1);
  });

  it("Ask AI is disabled while Chat is off, and says why", () => {
    const off = form(installed({ chatEnabled: false }));
    expect(fieldOf(off, "askAiUsesExec")).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/);
    expect(textOf(fieldOf(off, "askAiUsesExec"))).toContain(askAiLockedText({ settings: settings({ chatEnabled: false }) })!);
    const on = form(installed({ chatEnabled: true }));
    expect(fieldOf(on, "askAiUsesExec")).not.toMatch(/role="switch"[^>]*disabled=""/);
    expect(askAiLockedText({ settings: settings({ chatEnabled: true }) })).toBeNull();
  });
});
