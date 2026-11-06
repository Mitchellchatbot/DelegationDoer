import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FeedRowActions, rowButtons } from "@/components/exec/feed/FeedRowActions";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { FEED_COPY } from "@/lib/exec/ui/feed-api";
import { snoozePresets } from "@/lib/exec/ui/snooze-presets";
import { NOW, TZ, feedItem, textOf } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 65 (C2, C9, C10, coherence-16): FeedRowActions
// renders exactly the buttons of the item's effective status, the feedback
// controls, Ask AI only when given an href, and its pending and message states.

const NOW_MS = Date.parse(NOW);
const presets = snoozePresets(new Date(NOW), TZ);

function render(item: AttentionFeedItem, over: Partial<Parameters<typeof FeedRowActions>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(FeedRowActions, {
      item,
      pending: null,
      message: null,
      askAiHref: null,
      onAction: () => {},
      onFeedback: () => {},
      presets,
      now: NOW,
      tz: TZ,
      ...over
    })
  );
}

const actionsOf = (html: string) => [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);

const STATES: { name: string; item: AttentionFeedItem; actions: string[]; labels: string[] }[] = [
  { name: "open", item: feedItem({ status: "open" }), actions: ["seen", "snooze", "dismiss", "resolve"], labels: ["Mark seen", "Snooze", "Dismiss", "Resolve"] },
  { name: "seen", item: feedItem({ status: "seen" }), actions: ["snooze", "dismiss", "resolve", "reopen"], labels: ["Snooze", "Dismiss", "Resolve", "Mark new"] },
  {
    name: "snoozed (active)",
    item: feedItem({ status: "snoozed", snoozeUntil: "2026-11-07T13:00:00.000Z" }),
    actions: ["reopen", "dismiss", "resolve"],
    labels: ["Unsnooze", "Dismiss", "Resolve"]
  },
  { name: "dismissed", item: feedItem({ status: "dismissed" }), actions: ["reopen", "resolve"], labels: ["Reopen", "Resolve"] },
  {
    name: "resolved by him",
    item: feedItem({ status: "resolved", resolution: "owner", resolvedAt: "2026-11-06T13:00:00.000Z" }),
    actions: ["reopen"],
    labels: ["Reopen"]
  },
  {
    name: "resolved automatically",
    item: feedItem({ status: "resolved", resolution: "auto", resolvedAt: "2026-11-06T13:00:00.000Z" }),
    actions: [],
    labels: []
  }
];

describe("FeedRowActions: the C2 buttons per effective status (test 65)", () => {
  for (const s of STATES) {
    it(`${s.name}: exactly ${s.labels.join(", ") || "no buttons"}`, () => {
      const html = render(s.item);
      expect(actionsOf(html)).toEqual(s.actions);
      expect(rowButtons(s.item, NOW_MS).map((b) => b.label)).toEqual(s.labels);
      for (const label of s.labels) expect(textOf(html)).toContain(label);
    });
  }

  it("an expired snooze is open again: open's buttons, no 'Snoozed until'", () => {
    const html = render(feedItem({ status: "snoozed", snoozeUntil: "2026-11-06T14:00:00.000Z" }));
    expect(actionsOf(html)).toEqual(["seen", "snooze", "dismiss", "resolve"]);
    expect(textOf(html)).not.toContain("Snoozed until");
  });

  it("a live snooze says until when, in his zone", () => {
    expect(textOf(render(STATES[2].item))).toContain("Snoozed until Nov 7, 8:00 AM EST");
  });

  it("an automatic resolve says so and when, with no action button", () => {
    const html = render(STATES[5].item);
    expect(textOf(html)).toContain("Resolved automatically 2 h ago");
    expect(html).not.toContain("data-action");
  });

  it("the snooze menu lists the four presets", () => {
    const html = render(feedItem());
    expect([...html.matchAll(/data-snooze-preset="([^"]+)"/g)].map((m) => m[1])).toEqual(["3h", "tomorrow", "monday", "week"]);
    for (const label of ["3 hours", "Tomorrow 8:00", "Monday 8:00", "In a week, 8:00"]) expect(textOf(html)).toContain(label);
  });

  it("feedback: Useful, and Not useful with its six reasons", () => {
    const text = textOf(render(feedItem()));
    for (const label of ["Useful", "Not useful", "Not relevant", "Wrong priority", "Already handled", "Duplicate", "Facts are wrong", "Other"]) expect(text).toContain(label);
    for (const s of STATES) expect(render(s.item)).toContain('data-feedback="up"');
  });

  it("Ask AI: nothing for a null href (P5a), one link with the item id when given one (P5b)", () => {
    expect(render(feedItem())).not.toContain("data-exec-ask-ai");
    const html = render(feedItem(), { askAiHref: `/executive/chat?context=attention:${feedItem().id}` });
    expect(html.match(/data-exec-ask-ai=/g)).toHaveLength(1);
    expect(html).toContain(`href="/executive/chat?context=attention:${feedItem().id}"`);
    expect(html).toContain(`data-exec-ask-ai="${feedItem().id}"`);
  });

  it("pending: that button says Saving… and every control is disabled", () => {
    const html = render(feedItem(), { pending: "dismiss" });
    expect(html).toMatch(/data-action="dismiss"[^>]*disabled=""[^>]*>Saving…</);
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length).toBeGreaterThan(4);
    for (const b of buttons) expect(b).toContain('disabled=""');
  });

  it("a message sits in an aria-live region", () => {
    const html = render(feedItem(), { message: { tone: "error", text: FEED_COPY.conflict } });
    expect(html).toMatch(/aria-live="polite"[^>]*>.*This item changed since you loaded it\. Check it and try again\./);
  });

  it("wires each button to its action, a preset to snooze with its time, and a reason to a down vote", () => {
    const onAction = vi.fn();
    const onFeedback = vi.fn();
    const tree = FeedRowActions({ item: feedItem(), pending: null, message: null, askAiHref: null, onAction, onFeedback, presets, now: NOW, tz: TZ });
    const find = (attr: string, value: string) => findElement(tree, (props) => props[attr] === value);
    find("data-action", "dismiss")?.props.onClick();
    expect(onAction).toHaveBeenLastCalledWith("dismiss");
    find("data-action", "seen")?.props.onClick();
    expect(onAction).toHaveBeenLastCalledWith("seen");
    find("data-snooze-preset", "monday")?.props.onClick();
    expect(onAction).toHaveBeenLastCalledWith("snooze", presets.find((p) => p.key === "monday")?.until);
    find("data-feedback", "up")?.props.onClick();
    expect(onFeedback).toHaveBeenLastCalledWith(1, "useful");
    find("data-feedback-reason", "wrong_facts")?.props.onClick();
    expect(onFeedback).toHaveBeenLastCalledWith(-1, "wrong_facts");
  });

  it("escapes item text it shows", () => {
    const html = render(feedItem({ status: "snoozed", snoozeUntil: "<script>" }));
    expect(html).not.toContain("<script>");
  });
});

type Clickable = ReactElement<{ onClick: () => void; [k: string]: unknown }>;

function findElement(node: ReactNode, match: (props: Record<string, unknown>) => boolean): Clickable | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as Record<string, unknown>;
  if (match(props)) return node as Clickable;
  return findElement(props.children as ReactNode, match);
}
