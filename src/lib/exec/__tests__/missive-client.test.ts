import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// unstable_cache is Next's; outside Next the module only needs it to exist.
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
// jobs.ts (for classifyError) pulls these in; nothing here calls them.
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { classifyError } from "@/lib/exec/jobs";
import {
  __resetMessagesFeedProbeForTests,
  fetchAttachment,
  fetchMessageBody,
  getThread,
  listAccounts,
  listAccountsFresh,
  listMessagesFeed,
  listThreadsPaged,
  MissiveHttpError
} from "@/lib/missive-client";
import { CLONE_TOKEN, expressNotFound, installFakeClone, json, type FakeClone } from "./fake-clone";

// The additive parts of src/lib/missive-client.ts (contract §3.3): the typed
// HTTP error, signals, snoozed, the account fields and the CL1 messages feed.

const FEED_PAGE = {
  messages: [],
  next_cursor: "MTc2MjI1OTIwMDAwMHw",
  has_more: false,
  settled_through: "1762259200000"
};

let clone: FakeClone;

beforeEach(() => {
  __resetMessagesFeedProbeForTests();
  clone = installFakeClone(() => json(200, {}), vi.stubGlobal);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MissiveHttpError", () => {
  it("keeps the old message text and adds status, path and whether the body was JSON", async () => {
    clone.setHandler(() => json(404, { error: "not found" }));
    const err = await getThread("t_404").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissiveHttpError);
    const e = err as MissiveHttpError;
    expect(e.message).toBe('missive /api/threads/t_404 → 404 {"error":"not found"}');
    expect(e.status).toBe(404);
    expect(e.path).toBe("/api/threads/t_404");
    expect(e.jsonBody).toBe(true);
    expect(e.retryAfterMs).toBeUndefined();
  });

  it("clips the body to 200 characters exactly as before", async () => {
    clone.setHandler(() => new Response("x".repeat(500), { status: 500, headers: { "content-type": "text/plain" } }));
    const e = (await getThread("t1").catch((x: unknown) => x)) as MissiveHttpError;
    expect(e.message).toBe(`missive /api/threads/t1 → 500 ${"x".repeat(200)}`);
    expect(e.jsonBody).toBe(false);
  });

  it("reads Retry-After as seconds or an HTTP date", async () => {
    clone.setHandler(() => json(429, { error: "slow down" }, { "retry-after": "30" }));
    expect(((await getThread("t1").catch((x: unknown) => x)) as MissiveHttpError).retryAfterMs).toBe(30_000);
    const at = new Date(Date.now() + 90_000).toUTCString();
    clone.setHandler(() => json(503, { error: "busy" }, { "retry-after": at }));
    const ms = ((await getThread("t1").catch((x: unknown) => x)) as MissiveHttpError).retryAfterMs ?? 0;
    expect(ms).toBeGreaterThan(80_000);
    expect(ms).toBeLessThanOrEqual(90_000);
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "fatal"],
    [400, "fatal"],
    [409, "retryable"],
    [429, "retryable"],
    [500, "retryable"],
    [503, "retryable"]
  ] as const)("a %i classifies as %s for the job runner", async (status, klass) => {
    clone.setHandler(() => json(status, { error: "x" }));
    const err = await fetchMessageBody("m1").catch((e: unknown) => e);
    expect(classifyError(err)).toBe(klass);
  });

  it("a missing endpoint or token is an auth-class configuration error with the same message", async () => {
    delete process.env.MISSIVE_API_URL;
    const noUrl = await getThread("t1").catch((e: unknown) => e);
    expect((noUrl as Error).message).toBe("MISSIVE_API_URL not set");
    expect(classifyError(noUrl)).toBe("auth");
    process.env.MISSIVE_API_URL = "https://clone.test";
    delete process.env.MISSIVE_API_TOKEN;
    const noToken = await listThreadsPaged({}).catch((e: unknown) => e);
    expect((noToken as Error).message).toBe("MISSIVE_API_TOKEN not set");
    expect(classifyError(noToken)).toBe("auth");
    expect(clone.requests).toHaveLength(0);
  });
});

describe("signals and new options", () => {
  it("passes the caller's signal to every read", async () => {
    clone.setHandler((req) => {
      if (req.path === "/api/accounts") return json(200, { accounts: [] });
      if (req.path.endsWith("/body")) return json(200, { body_html: null, body_text: null });
      if (req.path.startsWith("/api/attachments/")) return new Response("bytes");
      if (req.path === "/api/threads") return json(200, { threads: [], limit: 50, offset: 0, hasMore: false });
      return json(200, { thread: { id: "t1", participants: "", last_message_at: "0" }, messages: [] });
    });
    const signal = new AbortController().signal;
    await getThread("t1", { signal });
    await fetchMessageBody("m1", { signal });
    await fetchAttachment("a1", { signal });
    await listThreadsPaged({ mailboxId: "acc", signal });
    await listAccountsFresh({ signal });
    expect(clone.requests.map((r) => r.signal)).toEqual([signal, signal, signal, signal, signal]);
    expect(clone.requests[0].headers.authorization).toBe(`Bearer ${CLONE_TOKEN}`);
  });

  it("an aborted signal ends a hung request", async () => {
    clone.setHandler(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = getThread("t1", { signal: controller.signal });
    controller.abort(new Error("job timed out"));
    await expect(pending).rejects.toThrow("job timed out");
  });

  it("sends snoozed=true only when asked, and leaves every existing query unchanged", async () => {
    clone.setHandler(() => json(200, { threads: [], limit: 50, offset: 0, hasMore: false }));
    await listThreadsPaged({ folder: "INBOX", status: "open", q: "from:x", limit: 25, offset: 50, mailboxId: "acc" });
    await listThreadsPaged({ mailboxId: "acc", snoozed: true });
    await listThreadsPaged({ mailboxId: "acc", snoozed: false });
    expect(clone.requests.map((r) => r.url.search)).toEqual([
      "?folder=INBOX&status=open&q=from%3Ax&limit=25&offset=50&mailbox_id=acc",
      "?mailbox_id=acc&snoozed=true",
      "?mailbox_id=acc"
    ]);
  });
});

describe("account and thread fields", () => {
  it("converts last_sync_error_at (BIGINT ms) to ISO and keeps the error text", async () => {
    clone.setHandler(() =>
      json(200, {
        accounts: [
          { id: "a1", email: "m@x.com", last_synced_at: "1762259200000", last_sync_error: "AADSTS700082", last_sync_error_at: "1762259100000" },
          { id: "a2", email: "n@x.com", last_synced_at: null }
        ]
      })
    );
    const [a1, a2] = await listAccountsFresh();
    expect(a1.last_synced_at).toBe("2025-11-04T12:26:40.000Z");
    expect(a1.last_sync_error).toBe("AADSTS700082");
    expect(a1.last_sync_error_at).toBe("2025-11-04T12:25:00.000Z");
    expect(a2.last_sync_error_at).toBeNull();
    // The cached reader returns the same shape.
    const viaCache = await listAccounts();
    expect(viaCache[0].last_sync_error_at).toBe("2025-11-04T12:25:00.000Z");
  });

  it("turns CL1's last_inbound_at into ISO, and leaves it out when the clone doesn't send it", async () => {
    clone.setHandler((req) =>
      req.path === "/api/threads/new"
        ? json(200, { thread: { id: "new", participants: "a@x.com; b@y.com", last_message_at: "1762259200000", last_inbound_at: "1762259100000" }, messages: [] })
        : req.path === "/api/threads/none"
          ? json(200, { thread: { id: "none", participants: [], last_message_at: "1762259200000", last_inbound_at: null }, messages: [] })
          : json(200, { thread: { id: "old", participants: [], last_message_at: "1762259200000" }, messages: [] })
    );
    const cl1 = await getThread("new");
    expect(cl1.thread.last_inbound_at).toBe("2025-11-04T12:25:00.000Z");
    expect(cl1.thread.participants).toEqual(["a@x.com", "b@y.com"]);
    expect((await getThread("none")).thread.last_inbound_at).toBeNull();
    const old = await getThread("old");
    expect("last_inbound_at" in old.thread).toBe(false);
  });
});

describe("listMessagesFeed (CL1 GET /api/messages)", () => {
  it("sends CL1's exact parameters, and a cursor wins over since", async () => {
    clone.setHandler(() => json(200, FEED_PAGE));
    await listMessagesFeed({ accountId: "acc 1", order: "changed", since: "2026-11-04T00:00:00.000Z", limit: 200 });
    await listMessagesFeed({ accountId: "acc", order: "created", cursor: "abc_-1", since: "2026-11-04T00:00:00.000Z", direction: "inbound", includeRemoved: false, limit: 5 });
    expect(clone.requests[0].path).toBe("/api/messages");
    expect(Object.fromEntries(clone.requests[0].url.searchParams)).toEqual({
      account_id: "acc 1",
      order: "changed",
      since: "2026-11-04T00:00:00.000Z",
      limit: "200"
    });
    expect(Object.fromEntries(clone.requests[1].url.searchParams)).toEqual({
      account_id: "acc",
      order: "created",
      cursor: "abc_-1",
      direction: "inbound",
      include_removed: "false",
      limit: "5"
    });
  });

  it("returns the raw rows with next_cursor, has_more and settled_through", async () => {
    const row = { id: "m1", thread_id: "t1", account_id: "acc", direction: "inbound", created_at: "1762259200000", subject: "raw" };
    clone.setHandler(() => json(200, { ...FEED_PAGE, messages: [row], has_more: true }));
    const page = await listMessagesFeed({ accountId: "acc" });
    expect(page).toEqual({ supported: true, messages: [row], next_cursor: FEED_PAGE.next_cursor, has_more: true, settled_through: "1762259200000" });
  });

  it("a pre-CL1 clone's HTML 404 means unsupported, cached for 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
    clone.setHandler((req) => expressNotFound(req.path));
    expect(await listMessagesFeed({ accountId: "acc" })).toEqual({ supported: false });
    expect(clone.requests).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-04T12:09:59.000Z"));
    expect(await listMessagesFeed({ accountId: "acc" })).toEqual({ supported: false });
    expect(clone.requests).toHaveLength(1);
    // After 10 minutes it asks again, and a CL1 deploy is picked up.
    vi.setSystemTime(new Date("2026-11-04T12:10:01.000Z"));
    clone.setHandler(() => json(200, FEED_PAGE));
    expect((await listMessagesFeed({ accountId: "acc" })).supported).toBe(true);
    expect(clone.requests).toHaveLength(2);
  });

  it("a JSON 404 (an account the clone doesn't have) throws and isn't cached", async () => {
    clone.setHandler(() => json(404, { error: "not found" }));
    const err = await listMessagesFeed({ accountId: "foreign" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissiveHttpError);
    expect((err as MissiveHttpError).status).toBe(404);
    expect(classifyError(err)).toBe("fatal");
    clone.setHandler(() => json(200, FEED_PAGE));
    expect((await listMessagesFeed({ accountId: "acc" })).supported).toBe(true);
  });

  it("other failures throw: 503 retryable, 401 auth", async () => {
    clone.setHandler(() => json(503, { error: "database not ready yet; retry shortly" }));
    expect(classifyError(await listMessagesFeed({ accountId: "acc" }).catch((e: unknown) => e))).toBe("retryable");
    clone.setHandler(() => json(401, { error: "invalid token" }));
    expect(classifyError(await listMessagesFeed({ accountId: "acc" }).catch((e: unknown) => e))).toBe("auth");
  });

  it.each([
    ["messages", { ...FEED_PAGE, messages: "nope" }],
    ["messages", { ...FEED_PAGE, messages: [null] }],
    ["next_cursor", { ...FEED_PAGE, next_cursor: null }],
    ["has_more", { ...FEED_PAGE, has_more: "false" }],
    ["settled_through", { ...FEED_PAGE, settled_through: "soon" }]
  ])("a page with a malformed %s throws", async (field, body) => {
    clone.setHandler(() => json(200, body));
    await expect(listMessagesFeed({ accountId: "acc" })).rejects.toThrow(`malformed feed page (${field})`);
  });
});
