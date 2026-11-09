import { describe, expect, it, vi } from "vitest";
import {
  FEED_COPY,
  attentionQuery,
  feedMessageFor,
  fetchAttentionPage,
  patchAttention,
  postFeedback,
  tooManyMessage
} from "@/lib/exec/ui/feed-api";
import { emailItem, feedItem } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 67: the feed's browser calls map every status to the
// words he sees, and send exactly what the routes take.

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fakeFetch(res: Response | Error) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    if (res instanceof Error) throw res;
    return res;
  });
}

const item = feedItem();

describe("feedMessageFor: status → message (test 67)", () => {
  const cases: [number, unknown, Record<string, string>, "action" | "feedback", string][] = [
    [409, { error: "conflict" }, {}, "action", "This item changed since you loaded it. Check it and try again."],
    [409, { error: "invalid_transition" }, {}, "action", "This item changed since you loaded it. Check it and try again."],
    [409, { error: "not_installed" }, {}, "feedback", "Feedback isn't available yet."],
    [404, { error: "not_found" }, {}, "action", "This item is gone."],
    [404, { error: "not found" }, {}, "action", "Couldn't save. Try again."],
    [429, { error: "rate_limited", retryAfterSeconds: 42 }, {}, "action", "Too many changes at once. Try again in 42 s."],
    [429, { error: "rate_limited" }, { "retry-after": "17" }, "feedback", "Too many changes at once. Try again in 17 s."],
    [429, null, {}, "action", "Too many changes at once. Try again in 60 s."],
    [403, { error: "forbidden" }, {}, "action", "Couldn't save. Try again."],
    [503, { error: "unavailable" }, {}, "action", "Couldn't save. Try again."],
    [400, { error: "invalid", detail: "snoozeUntil" }, {}, "action", "Couldn't save. Try again."],
    [401, { error: "unauthorized" }, {}, "feedback", "Couldn't save. Try again."]
  ];
  for (const [status, body, headers, kind, text] of cases) {
    it(`${status} ${JSON.stringify(body)} (${kind}) → ${text}`, () => {
      expect(feedMessageFor(status, body, new Headers(headers), kind)).toEqual({ tone: "error", text });
    });
  }

  it("rounds a fractional wait up and never says 0 s", () => {
    expect(tooManyMessage(1.2)).toBe("Too many changes at once. Try again in 2 s.");
    expect(tooManyMessage(0)).toBe("Too many changes at once. Try again in 60 s.");
  });
});

describe("patchAttention", () => {
  it("PATCHes same-origin JSON with the version, and snoozeUntil only for a snooze", async () => {
    const f = fakeFetch(json(200, { changed: true, item }));
    await patchAttention(item.id, { action: "dismiss", snoozeUntil: "2026-11-07T13:00:00.000Z", expectedUpdatedAt: item.version }, f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`/api/exec/attention/${item.id}`);
    expect(init).toMatchObject({ method: "PATCH", credentials: "same-origin", cache: "no-store" });
    expect(JSON.parse(String(init?.body))).toEqual({ action: "dismiss", expectedUpdatedAt: item.version });

    const g = fakeFetch(json(200, { changed: true, item }));
    await patchAttention(item.id, { action: "snooze", snoozeUntil: "2026-11-07T13:00:00.000Z", expectedUpdatedAt: item.version }, g);
    expect(JSON.parse(String(g.mock.calls[0][1]?.body))).toEqual({ action: "snooze", snoozeUntil: "2026-11-07T13:00:00.000Z", expectedUpdatedAt: item.version });
  });

  it("200: applied with the server's item (changed or not); hidden → item null", async () => {
    expect(await patchAttention(item.id, { action: "seen", expectedUpdatedAt: "v" }, fakeFetch(json(200, { changed: true, item })))).toEqual({ kind: "applied", changed: true, item });
    expect(await patchAttention(item.id, { action: "seen", expectedUpdatedAt: "v" }, fakeFetch(json(200, { changed: false, item })))).toEqual({ kind: "applied", changed: false, item });
    expect(await patchAttention(item.id, { action: "seen", expectedUpdatedAt: "v" }, fakeFetch(json(200, { changed: true, item: null, hidden: true })))).toEqual({
      kind: "applied",
      changed: true,
      item: null
    });
  });

  it("200 with a body it can't read: failed, saying to reload", async () => {
    const r = await patchAttention(item.id, { action: "seen", expectedUpdatedAt: "v" }, fakeFetch(json(200, { changed: true, item: { id: 1 } })));
    expect(r).toEqual({ kind: "failed", status: 200, message: { tone: "error", text: FEED_COPY.savedReload } });
  });

  it("409: conflict with the current item; 404 not_found: gone", async () => {
    const current = emailItem({ id: item.id, version: "v9" });
    expect(await patchAttention(item.id, { action: "dismiss", expectedUpdatedAt: "v" }, fakeFetch(json(409, { error: "conflict", item: current })))).toEqual({
      kind: "conflict",
      item: current,
      message: { tone: "error", text: FEED_COPY.conflict }
    });
    expect(await patchAttention(item.id, { action: "reopen", expectedUpdatedAt: "v" }, fakeFetch(json(409, { error: "invalid_transition", item: null, hidden: true })))).toMatchObject({
      kind: "conflict",
      item: null
    });
    expect(await patchAttention(item.id, { action: "dismiss", expectedUpdatedAt: "v" }, fakeFetch(json(404, { error: "not_found" })))).toEqual({
      kind: "gone",
      message: { tone: "error", text: "This item is gone." }
    });
  });

  it("429, 403, 503 and a network error: failed with the matching words", async () => {
    const r429 = await patchAttention(item.id, { action: "dismiss", expectedUpdatedAt: "v" }, fakeFetch(json(429, { error: "rate_limited", retryAfterSeconds: 30 }, { "retry-after": "30" })));
    expect(r429).toEqual({ kind: "failed", status: 429, message: { tone: "error", text: "Too many changes at once. Try again in 30 s." } });
    for (const status of [403, 503]) {
      expect(await patchAttention(item.id, { action: "dismiss", expectedUpdatedAt: "v" }, fakeFetch(json(status, { error: "x" })))).toMatchObject({ kind: "failed", status, message: { text: FEED_COPY.failed } });
    }
    expect(await patchAttention(item.id, { action: "dismiss", expectedUpdatedAt: "v" }, fakeFetch(new TypeError("fetch failed")))).toMatchObject({ kind: "failed", status: 0 });
  });
});

describe("postFeedback", () => {
  it("POSTs the vote and reason; 200 is recorded", async () => {
    const f = fakeFetch(json(200, { itemId: item.id, vote: -1, reason: "duplicate" }));
    expect(await postFeedback(item.id, -1, "duplicate", f)).toEqual({ kind: "recorded", vote: -1, reason: "duplicate" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`/api/exec/attention/${item.id}/feedback`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({ vote: -1, reason: "duplicate" });
  });

  it("409 not_installed, 404 and 429 map to their words", async () => {
    expect(await postFeedback(item.id, 1, "useful", fakeFetch(json(409, { error: "not_installed" })))).toMatchObject({ kind: "failed", message: { text: FEED_COPY.notInstalled } });
    expect(await postFeedback(item.id, 1, "useful", fakeFetch(json(404, { error: "not_found" })))).toMatchObject({ kind: "gone", message: { text: FEED_COPY.gone } });
    expect(await postFeedback(item.id, 1, "useful", fakeFetch(json(429, { error: "rate_limited", retryAfterSeconds: 5 })))).toMatchObject({
      kind: "failed",
      message: { text: "Too many changes at once. Try again in 5 s." }
    });
  });
});

describe("fetchAttentionPage", () => {
  it("asks for the next page with the same filters and the cursor", async () => {
    const f = fakeFetch(json(200, { generatedAt: "x", items: [item, { bogus: true }], nextCursor: "next", hiddenEmail: 2, emailScreen: "ok" }));
    const r = await fetchAttentionPage({ status: "dismissed", source: "email", band: "high" }, "cur", f);
    expect(r).toEqual({ ok: true, items: [item], nextCursor: "next", hiddenEmail: 2, emailScreen: "ok" });
    const url = new URL(String(f.mock.calls[0][0]), "https://x.test");
    expect(url.pathname).toBe("/api/exec/attention");
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "dismissed", source: "email", band: "high", cursor: "cur", limit: "50" });
    expect(f.mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin" });
  });

  it("leaves the default status out of the query", () => {
    expect(attentionQuery({ status: "default" }, null)).toBe("limit=50");
  });

  it("a refusal or a network error is { ok: false }", async () => {
    expect(await fetchAttentionPage({}, "cur", fakeFetch(json(400, { error: "invalid_cursor" })))).toEqual({ ok: false, status: 400 });
    expect(await fetchAttentionPage({}, "cur", fakeFetch(new TypeError("fetch failed")))).toEqual({ ok: false, status: 0 });
  });

  it("an unknown screen state reads as none; a bad hidden count as 0", async () => {
    const r = await fetchAttentionPage({}, "c", fakeFetch(json(200, { items: [], nextCursor: "", hiddenEmail: -3, emailScreen: "weird" })));
    expect(r).toEqual({ ok: true, items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" });
  });
});
