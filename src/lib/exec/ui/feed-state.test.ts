import { describe, expect, it } from "vitest";
import { FEED_COPY } from "@/lib/exec/ui/feed-api";
import { HIDDEN_AFTER_ACTION, HIDDEN_NOW, effectiveStatus, feedReducer, inView, initialFeedState, type FeedState } from "@/lib/exec/ui/feed-state";
import { NOW, TZ, feedItem, itemId } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 66: the feed list's pure reducer.

const a = feedItem({ id: itemId(1), title: "A" });
const b = feedItem({ id: itemId(2), title: "B" });
const c = feedItem({ id: itemId(3), title: "C" });
const start = (status: FeedState["status"] = "default") => initialFeedState({ items: [a, b], cursor: "cur1", status, tz: TZ });
const NOW_MS = Date.parse(NOW);

describe("feedReducer (test 66)", () => {
  it("starts from the page's items, deduped, with the page's cursor", () => {
    const s = initialFeedState({ items: [a, b, a], cursor: "cur1", tz: TZ, hiddenEmail: 2, emailScreen: "ok" });
    expect(s.rows.map((r) => r.item.id)).toEqual([a.id, b.id]);
    expect(s).toMatchObject({ cursor: "cur1", hiddenEmail: 2, emailScreen: "ok", status: "default", notice: null });
  });

  it("optimistic pending: the row is marked and its old message cleared", () => {
    let s = feedReducer(start(), { type: "action_failed", id: a.id, message: { tone: "error", text: "x" } });
    s = feedReducer(s, { type: "action_started", id: a.id, action: "dismiss" });
    expect(s.rows[0]).toMatchObject({ pending: "dismiss", message: null, outOfView: false });
    expect(s.rows[1].pending).toBeNull();
  });

  it("applied, still in view: replaces the item and its version", () => {
    const seen = { ...a, status: "seen" as const, version: "2026-11-06T15:00:01.5+00:00" };
    let s = feedReducer(start(), { type: "action_started", id: a.id, action: "seen" });
    s = feedReducer(s, { type: "action_applied", id: a.id, action: "seen", changed: true, item: seen, now: NOW });
    expect(s.rows[0]).toEqual({ item: seen, pending: null, message: null, outOfView: false });
    expect(s.rows[0].item.version).toBe("2026-11-06T15:00:01.5+00:00");
  });

  it("applied, out of view: a stub with Undo carrying the new version", () => {
    const dismissed = { ...a, status: "dismissed" as const, version: "v2" };
    const s = feedReducer(start(), { type: "action_applied", id: a.id, action: "dismiss", changed: true, item: dismissed, now: NOW });
    expect(s.rows[0]).toMatchObject({ outOfView: true, pending: null, message: { text: "Dismissed.", undo: true } });
    expect(s.rows[0].item.version).toBe("v2");

    const resolved = feedReducer(start(), { type: "action_applied", id: a.id, action: "resolve", changed: true, item: { ...a, status: "resolved", resolution: "owner" }, now: NOW });
    expect(resolved.rows[0].message).toEqual({ tone: "ok", text: "Resolved.", undo: true });

    const snoozed = feedReducer(start(), {
      type: "action_applied",
      id: a.id,
      action: "snooze",
      changed: true,
      item: { ...a, status: "snoozed", snoozeUntil: "2026-11-09T13:00:00.000Z" },
      now: NOW
    });
    expect(snoozed.rows[0].message?.text.split(String.fromCharCode(0x202f)).join(" ")).toBe("Snoozed until Nov 9, 8:00 AM EST.");
    expect(snoozed.rows[0].message?.undo).toBe(true);
  });

  it("Undo (reopen) applied brings the full row back", () => {
    let s = feedReducer(start(), { type: "action_applied", id: a.id, action: "dismiss", changed: true, item: { ...a, status: "dismissed", version: "v2" }, now: NOW });
    s = feedReducer(s, { type: "action_started", id: a.id, action: "reopen" });
    expect(s.rows[0]).toMatchObject({ outOfView: true, pending: "reopen" });
    s = feedReducer(s, { type: "action_applied", id: a.id, action: "reopen", changed: true, item: { ...a, status: "open", version: "v3" }, now: NOW });
    expect(s.rows[0]).toMatchObject({ outOfView: false, message: null, pending: null });
    expect(s.rows[0].item.version).toBe("v3");
  });

  it("an undo in flight keeps the stub's line; a failed undo keeps Undo for another try", () => {
    let s = feedReducer(start(), { type: "action_applied", id: a.id, action: "resolve", changed: true, item: { ...a, status: "resolved", resolution: "owner", version: "v2" }, now: NOW });
    s = feedReducer(s, { type: "action_started", id: a.id, action: "reopen" });
    expect(s.rows[0].message).toEqual({ tone: "ok", text: "Resolved.", undo: true });
    s = feedReducer(s, { type: "action_failed", id: a.id, message: { tone: "error", text: FEED_COPY.failed } });
    expect(s.rows[0]).toMatchObject({ outOfView: true, pending: null, message: { tone: "error", text: "Couldn't save. Try again.", undo: true } });
  });

  it("Mark seen in the Open view leaves it: 'Marked seen.' with no Undo", () => {
    const s = feedReducer(start("open"), { type: "action_applied", id: a.id, action: "seen", changed: true, item: { ...a, status: "seen" }, now: NOW });
    expect(s.rows[0]).toMatchObject({ outOfView: true, message: { text: "Marked seen." } });
    expect(s.rows[0].message?.undo).toBeUndefined();
  });

  it("applied but now hidden by the screen: the row goes, with a notice", () => {
    const s = feedReducer(start(), { type: "action_applied", id: a.id, action: "seen", changed: true, item: null, now: NOW });
    expect(s.rows.map((r) => r.item.id)).toEqual([b.id]);
    expect(s.notice?.text).toBe(HIDDEN_AFTER_ACTION);
  });

  it("409: merges the server's current item into the row and shows the message", () => {
    const current = { ...a, title: "A (changed)", status: "seen" as const, version: "v9" };
    let s = feedReducer(start(), { type: "action_started", id: a.id, action: "dismiss" });
    s = feedReducer(s, { type: "action_conflict", id: a.id, item: current, message: { tone: "error", text: FEED_COPY.conflict } });
    expect(s.rows[0]).toEqual({ item: current, pending: null, message: { tone: "error", text: FEED_COPY.conflict }, outOfView: false });
    const hidden = feedReducer(start(), { type: "action_conflict", id: a.id, item: null, message: { tone: "error", text: FEED_COPY.conflict } });
    expect(hidden.rows).toHaveLength(1);
    expect(hidden.notice?.text).toBe(HIDDEN_NOW);
  });

  it("404: removes the row, with the gone notice", () => {
    const s = feedReducer(start(), { type: "action_gone", id: b.id, message: { tone: "error", text: FEED_COPY.gone } });
    expect(s.rows.map((r) => r.item.id)).toEqual([a.id]);
    expect(s.notice).toEqual({ tone: "error", text: "This item is gone." });
  });

  it("a failed action keeps the row and shows why", () => {
    const s = feedReducer(feedReducer(start(), { type: "action_started", id: a.id, action: "resolve" }), {
      type: "action_failed",
      id: a.id,
      message: { tone: "error", text: FEED_COPY.failed }
    });
    expect(s.rows[0]).toMatchObject({ pending: null, outOfView: false, message: { text: "Couldn't save. Try again." } });
    expect(s.rows[0].item).toBe(a);
  });

  it("feedback: pending, then 'Thanks, noted.', or the failure message", () => {
    let s = feedReducer(start(), { type: "feedback_started", id: a.id });
    expect(s.rows[0].pending).toBe("feedback");
    s = feedReducer(s, { type: "feedback_recorded", id: a.id });
    expect(s.rows[0]).toMatchObject({ pending: null, message: { tone: "ok", text: "Thanks, noted." } });
    s = feedReducer(s, { type: "feedback_failed", id: a.id, message: { tone: "error", text: FEED_COPY.notInstalled } });
    expect(s.rows[0].message?.text).toBe("Feedback isn't available yet.");
  });

  it("load more: dedupes by id, moves the cursor, adds the hidden count, keeps the worst screen state", () => {
    let s = initialFeedState({ items: [a, b], cursor: "cur1", tz: TZ, hiddenEmail: 1, emailScreen: "ok" });
    s = feedReducer(s, { type: "load_more_started" });
    expect(s.loadingMore).toBe(true);
    s = feedReducer(s, { type: "load_more_succeeded", items: [b, c], nextCursor: "cur2", hiddenEmail: 2, emailScreen: "unavailable" });
    expect(s.rows.map((r) => r.item.id)).toEqual([a.id, b.id, c.id]);
    expect(s).toMatchObject({ cursor: "cur2", loadingMore: false, loadMoreFailed: false, hiddenEmail: 3, emailScreen: "unavailable" });
    s = feedReducer(s, { type: "load_more_succeeded", items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "ok" });
    expect(s).toMatchObject({ cursor: null, emailScreen: "unavailable" });
  });

  it("load more failed: the cursor stays for another try", () => {
    const s = feedReducer(feedReducer(start(), { type: "load_more_started" }), { type: "load_more_failed" });
    expect(s).toMatchObject({ cursor: "cur1", loadingMore: false, loadMoreFailed: true });
  });

  it("an event for an id not on the list changes nothing", () => {
    const s0 = start();
    expect(feedReducer(s0, { type: "action_started", id: "ea_nope", action: "seen" })).toBe(s0);
    expect(feedReducer(s0, { type: "action_gone", id: "ea_nope", message: { tone: "error", text: "x" } })).toBe(s0);
  });
});

describe("effectiveStatus and inView (C6)", () => {
  it("an expired or unreadable snooze is open", () => {
    expect(effectiveStatus({ status: "snoozed", snoozeUntil: "2026-11-06T14:00:00Z" }, NOW_MS)).toBe("open");
    expect(effectiveStatus({ status: "snoozed", snoozeUntil: null }, NOW_MS)).toBe("open");
    expect(effectiveStatus({ status: "snoozed", snoozeUntil: "2026-11-07T14:00:00Z" }, NOW_MS)).toBe("snoozed");
  });

  it("each view keeps exactly its statuses; the default is open + seen", () => {
    const st = (status: "open" | "seen" | "dismissed" | "resolved") => ({ status, snoozeUntil: null });
    expect(inView(st("open"), "default", NOW_MS)).toBe(true);
    expect(inView(st("seen"), "default", NOW_MS)).toBe(true);
    expect(inView(st("dismissed"), "default", NOW_MS)).toBe(false);
    expect(inView({ status: "snoozed", snoozeUntil: "2026-11-07T14:00:00Z" }, "default", NOW_MS)).toBe(false);
    expect(inView({ status: "snoozed", snoozeUntil: "2026-11-07T14:00:00Z" }, "snoozed", NOW_MS)).toBe(true);
    expect(inView(st("seen"), "open", NOW_MS)).toBe(false);
    expect(inView(st("resolved"), "resolved", NOW_MS)).toBe(true);
    expect(inView(st("open"), "dismissed", NOW_MS)).toBe(false);
  });
});
