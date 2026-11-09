import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));

import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { AttentionPageView } from "@/components/exec/feed/AttentionPageView";
import { FeedList, feedEmptyKind, type FeedListProps } from "@/components/exec/feed/FeedList";
import { FeedMessageLine, FeedRowActions } from "@/components/exec/feed/FeedRowActions";
import { feedFocusSelectors, focusFirst, focusLost } from "@/lib/exec/ui/focus";
import { AttentionSection } from "@/components/exec/overview/AttentionSection";
import type { OverviewAttention } from "@/lib/exec/overview";
import { NOW, TZ, emailItem, feedItem, itemId, textOf } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 69 (S2, K14, coherence-16, a-correct-16): FeedList
// rendered statically with P4's frame guard mocked.

const dd = feedItem();
const mail = emailItem();

function render(over: Partial<FeedListProps> = {}) {
  return renderToStaticMarkup(
    createElement(FeedList, {
      mode: "full",
      initialItems: [dd, mail],
      initialCursor: null,
      filters: {},
      now: NOW,
      tz: TZ,
      checkedAt: "2026-11-06T14:50:00.000Z",
      ddtextCheckedAt: null,
      hiddenEmail: 0,
      emailScreen: "ok",
      draftsAvailable: false,
      ...over
    })
  );
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.mocked(useIsTopWindow).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("FeedList: the frame guard (test 69, S2)", () => {
  it("framed: no action, feedback or Ask AI control, and the muted line", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    const html = render({ askAiEnabled: true });
    expect(html).not.toContain("data-row-actions");
    expect(html).not.toContain("data-action=");
    expect(html).not.toContain("data-feedback");
    expect(html).not.toContain("data-exec-ask-ai");
    expect(html).not.toMatch(/<button[^>]*>(Dismiss|Resolve|Mark seen|Useful)/);
    expect(textOf(html)).toContain("Actions are off in an embedded view.");
    // The rows themselves still show.
    expect(textOf(html)).toContain("Sam has 3 overdue tasks");
  });

  it("top-level: each row gets its actions (through FeedRowActions) and no framed line", () => {
    const html = render();
    expect(count(html, /data-row-actions=/g)).toBe(2);
    expect(html).toContain(`data-row-actions="${dd.id}"`);
    expect(html).toContain('data-action="dismiss"');
    expect(html).toContain('data-feedback="up"');
    expect(textOf(html)).not.toContain("Actions are off in an embedded view.");
  });

  it("every row's band reasons open in place", () => {
    const html = render();
    expect(count(html, /data-reasons/g)).toBe(2);
    expect(textOf(html)).toContain("Why high");
  });
});

describe("FeedList: Draft reply (test 69, K14, a-build-8)", () => {
  it("drafts available: exactly one Draft reply link, on the email thread row, to the new-draft page", () => {
    const html = render({ draftsAvailable: true });
    expect(count(html, /data-draft-reply/g)).toBe(1);
    expect(count(html, />Draft reply</g)).toBe(1);
    expect(html).toContain('href="/executive/email/drafts/new?threadId=t_thread1"');
    const ddRow = html.slice(html.indexOf(`data-feed-row="${dd.id}"`), html.indexOf(`data-feed-row="${mail.id}"`));
    expect(ddRow).not.toContain("Draft reply");
  });

  it("framed or not, the link is the same single one (a link, not an action)", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    expect(count(render({ draftsAvailable: true }), /data-draft-reply/g)).toBe(1);
  });

  it("drafts unavailable: none", () => {
    expect(render({ draftsAvailable: false })).not.toContain("Draft reply");
  });
});

describe("FeedList: Ask AI (test 69, coherence-16)", () => {
  it("askAiEnabled omitted: no data-exec-ask-ai element", () => {
    expect(render()).not.toContain("data-exec-ask-ai");
  });

  it("askAiEnabled true: one link per row, to /executive/chat?context=attention:<id>", () => {
    const html = render({ askAiEnabled: true });
    expect(count(html, /data-exec-ask-ai=/g)).toBe(2);
    for (const item of [dd, mail]) {
      expect(html).toContain(`href="/executive/chat?context=attention:${item.id}"`);
      expect(html).toContain(`data-exec-ask-ai="${item.id}"`);
    }
  });
});

describe("FeedList: freshness, notices and empty states (test 69)", () => {
  it("'DD text checked <time>' renders when ddtextCheckedAt is set, and not otherwise", () => {
    expect(textOf(render({ ddtextCheckedAt: "2026-11-06T14:50:00.000Z" }))).toContain("DD text checked 10 min ago");
    expect(render()).not.toContain("DD text checked");
  });

  it("hidden email items are counted; an unavailable screen says so instead", () => {
    expect(textOf(render({ hiddenEmail: 1 }))).toContain("1 email item hidden: restricted sender.");
    expect(textOf(render({ hiddenEmail: 3 }))).toContain("3 email items hidden: restricted sender.");
    const down = textOf(render({ hiddenEmail: 3, emailScreen: "unavailable" }));
    expect(down).toContain("Email items are hidden: the restricted-sender check couldn't run. Reload to try again.");
    expect(down).not.toContain("3 email items hidden");
  });

  it("empty with a check: 'Nothing needs you right now.' and when it was checked", () => {
    const text = textOf(render({ initialItems: [] }));
    expect(text).toContain("Nothing needs you right now.");
    expect(text).toContain("Last checked Nov 6, 9:50 AM EST");
  });

  it("empty, never checked: 'Nothing here yet.'", () => {
    const text = textOf(render({ initialItems: [], checkedAt: null }));
    expect(text).toContain("Nothing here yet.");
    expect(text).toContain("Items appear after the first scan.");
  });

  it("empty while the freshness or the email screen is unknown: a neutral line, never 'nothing needs you' or 'first scan' (ui-4)", () => {
    for (const [why, over] of [
      ["freshness unknown, never checked", { freshnessUnknown: true, checkedAt: null }],
      ["freshness unknown, checked", { freshnessUnknown: true }],
      ["email screen unavailable", { emailScreen: "unavailable" as const }]
    ] as const) {
      const text = textOf(render({ initialItems: [], ...over }));
      expect(text, why).toContain("No items to show.");
      expect(text, why).not.toContain("Nothing needs you right now.");
      expect(text, why).not.toContain("Items appear after the first scan.");
    }
    expect(feedEmptyKind({ filtered: true, freshnessUnknown: true, emailScreen: "unavailable", checkedAt: null })).toBe("no_match");
    expect(feedEmptyKind({ filtered: false, freshnessUnknown: false, emailScreen: "ok", checkedAt: "2026-11-06T14:50:00.000Z" })).toBe("checked");
    expect(feedEmptyKind({ filtered: false, freshnessUnknown: false, emailScreen: "none", checkedAt: null })).toBe("never_checked");
    // The full page passes its freshness failure through.
    const page = (freshnessUnavailable: boolean) =>
      textOf(
        renderToStaticMarkup(
          createElement(AttentionPageView, {
            page: { items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" },
            filters: {},
            now: NOW,
            tz: TZ,
            checkedAt: null,
            ddtextCheckedAt: null,
            draftsAvailable: false,
            ignoredParams: false,
            freshnessUnavailable
          })
        )
      );
    expect(page(true)).toContain("Couldn't read when the feed was last checked.");
    expect(page(true)).toContain("No items to show.");
    expect(page(true)).not.toContain("Items appear after the first scan.");
    expect(page(false)).toContain("Items appear after the first scan.");
  });

  it("empty under filters (full): 'No items match these filters.' and a Clear filters link", () => {
    const html = render({ initialItems: [], filters: { status: "dismissed" } });
    expect(textOf(html)).toContain("No items match these filters.");
    expect(html).toMatch(/href="\/executive\/attention"[^>]*>Clear filters</);
    // The Overview never says "filters".
    expect(textOf(render({ mode: "overview", initialItems: [], filters: { status: "dismissed" } }))).toContain("Nothing needs you right now.");
  });

  it("Load more (full, with a cursor) carries the C5 note; none in the Overview or without a cursor", () => {
    const text = textOf(render({ initialCursor: "cur" }));
    expect(text).toContain("Load more");
    expect(text).toContain("Items whose priority changed after this list loaded may have moved. Reload to see the current order.");
    expect(render({ mode: "overview", initialCursor: "cur" })).not.toContain("data-load-more");
    expect(render({ initialCursor: null })).not.toContain("data-load-more");
  });

  it("renders the items in the order given, deduped", () => {
    const html = render({ initialItems: [feedItem({ id: itemId(7), title: "First" }), feedItem({ id: itemId(8), title: "Second" }), feedItem({ id: itemId(7), title: "First" })] });
    expect(count(html, /data-feed-row=/g)).toBe(2);
    expect(html.indexOf(">First<")).toBeLessThan(html.indexOf(">Second<"));
  });
});

describe("FeedList: feedback controls only while the feedback table exists (ui-5)", () => {
  it("feedbackAvailable false: no Useful / Not useful on any row, the actions stay; default and true: offered", () => {
    const off = render({ feedbackAvailable: false });
    expect(off).not.toContain("data-feedback");
    expect(count(off, /data-row-actions=/g)).toBe(2);
    expect(off).toContain('data-action="dismiss"');
    expect(count(render(), /data-feedback-controls/g)).toBe(2);
    expect(count(render({ feedbackAvailable: true }), /data-feedback-controls/g)).toBe(2);
  });

  it("the Overview card and the full page pass it through", () => {
    const card = (feedbackAvailable?: false) =>
      renderToStaticMarkup(
        createElement(AttentionSection, {
          attention: {
            ok: true,
            data: { items: [dd], limit: 20, checkedAt: NOW, emailUnchecked: false, hasMore: false, hiddenEmail: 0, emailScreen: "ok", ddtextCheckedAt: null, ...(feedbackAvailable === false ? { feedbackAvailable } : {}) }
          },
          tz: TZ,
          now: NOW
        })
      );
    expect(card(false)).not.toContain("data-feedback");
    expect(card()).toContain("data-feedback-controls");
    const page = (feedbackAvailable: boolean) =>
      renderToStaticMarkup(
        createElement(AttentionPageView, {
          page: { items: [dd], nextCursor: null, hiddenEmail: 0, emailScreen: "none" },
          filters: {},
          now: NOW,
          tz: TZ,
          checkedAt: NOW,
          ddtextCheckedAt: null,
          draftsAvailable: false,
          ignoredParams: false,
          feedbackAvailable
        })
      );
    expect(page(false)).not.toContain("data-feedback");
    expect(page(true)).toContain("data-feedback-controls");
  });
});

describe("FeedList: focus after an action (ui-7)", () => {
  const fakeRoot = (present: Record<string, string>) => {
    const focused: string[] = [];
    return {
      focused,
      root: { querySelector: (sel: string) => (sel in present ? { focus: () => focused.push(present[sel]) } : null) }
    };
  };

  it("a row moved out of view: its stub's Undo, else the stub itself; a row still in view: its first action button", () => {
    const id = itemId(1);
    const [undo, stub] = feedFocusSelectors(id, true);
    const withUndo = fakeRoot({ [undo]: "undo", [stub]: "stub" });
    expect(focusFirst(withUndo.root, feedFocusSelectors(id, true))).toBe(true);
    expect(withUndo.focused).toEqual(["undo"]);
    const noUndo = fakeRoot({ [stub]: "stub" });
    focusFirst(noUndo.root, feedFocusSelectors(id, true));
    expect(noUndo.focused).toEqual(["stub"]);
    const [action] = feedFocusSelectors(id, false);
    const inView = fakeRoot({ [action]: "action" });
    focusFirst(inView.root, feedFocusSelectors(id, false));
    expect(inView.focused).toEqual(["action"]);
    expect(focusFirst(fakeRoot({}).root, feedFocusSelectors(id, false))).toBe(false);
    expect(focusFirst(null, [action])).toBe(false);
    expect(feedFocusSelectors('a"b\\c', true)[1]).toBe('[data-feed-stub="a\\"b\\\\c"]');
  });

  it("only when focus was lost with the control: nothing focused, or the body", () => {
    const body = {};
    expect(focusLost(null, body)).toBe(true);
    expect(focusLost(body, body)).toBe(true);
    expect(focusLost({}, body)).toBe(false);
  });

  it("the selectors name the markup the list and the row actions really render", () => {
    const actions = renderToStaticMarkup(createElement(FeedRowActions, { item: dd, pending: null, message: null, askAiHref: null, onAction: () => {}, onFeedback: () => {}, presets: [], now: NOW, tz: TZ }));
    expect(actions).toMatch(/<button[^>]*data-action="seen"/);
    const line = renderToStaticMarkup(createElement(FeedMessageLine, { message: { tone: "ok", text: "Dismissed.", undo: true }, onUndo: () => {} }));
    expect(line).toMatch(/<button[^>]*data-undo/);
    expect(render()).toContain(`data-feed-row="${dd.id}"`);
  });
});

describe("AttentionSection: the Overview card on FeedList (§3.13.3)", () => {
  const data = (over: Partial<OverviewAttention> = {}): OverviewAttention => ({
    items: [dd, mail],
    limit: 20,
    checkedAt: "2026-11-06T14:50:00.000Z",
    emailUnchecked: false,
    hasMore: false,
    hiddenEmail: 0,
    emailScreen: "ok",
    ddtextCheckedAt: null,
    ...over
  });
  const card = (over: Partial<OverviewAttention> = {}) => renderToStaticMarkup(createElement(AttentionSection, { attention: { ok: true, data: data(over) }, tz: TZ, now: NOW }));

  it("links to the full feed, counts by hasMore, and keeps the freshness line", () => {
    const html = card();
    expect(html).toMatch(/href="\/executive\/attention"[^>]*>See all and filter</);
    expect(textOf(html)).toContain("2 items");
    expect(textOf(html)).toContain("Checked 10 min ago");
    expect(textOf(card({ hasMore: true }))).toContain("Top 2 by priority");
  });

  it("row actions in a top-level window; P4's Draft reply when drafts are on; the DD text line", () => {
    const html = card({ draftsEnabled: true, ddtextCheckedAt: "2026-11-06T14:40:00.000Z" });
    expect(html).toContain('data-feed-list="overview"');
    expect(count(html, /data-row-actions=/g)).toBe(2);
    expect(count(html, /data-draft-reply/g)).toBe(1);
    expect(textOf(html)).toContain("DD text checked 20 min ago");
    expect(card()).not.toContain("data-draft-reply");
  });

  it("an unavailable screen and hidden email items show on the card", () => {
    expect(textOf(card({ emailScreen: "unavailable", emailUnchecked: true }))).toContain("Email items are hidden: the restricted-sender check couldn't run.");
    expect(textOf(card({ hiddenEmail: 2 }))).toContain("2 email items hidden: restricted sender.");
  });

  it("a failed read is the card's error, not an empty feed", () => {
    const text = textOf(renderToStaticMarkup(createElement(AttentionSection, { attention: { ok: false, error: "unavailable" }, tz: TZ, now: NOW })));
    expect(text).toContain("Couldn't load this section right now.");
    expect(text).not.toContain("Nothing needs you");
  });
});
