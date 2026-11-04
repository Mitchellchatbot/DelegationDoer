import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// jobs.ts (for classifyError) pulls these in; nothing here calls them.
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { classifyError } from "@/lib/exec/jobs";
import { principalFromRows } from "@/lib/exec/principal";
import {
  checkPinnedAccounts,
  CloneHttpError,
  countPendingReplyArtifacts,
  listAllReplyArtifacts,
  listInternalAddresses,
  listPrincipalMessagesFeed,
  listPrincipalThreadsSince,
  listReplyArtifacts,
  loadHisBodies,
  MailReadError,
  MailScopeError,
  readPrincipalThread
} from "@/lib/exec/sources/mail";
import type { PrincipalMailThread } from "@/lib/exec/email-types";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { __resetMessagesFeedProbeForTests } from "@/lib/missive-client";
import { expressNotFound, installFakeClone, json, type CloneRequest, type FakeClone } from "../__tests__/fake-clone";
import { createFakePostgrest, type FakeFilter, type FakePostgrestConfig, type Row } from "../__tests__/fake-postgrest";

const inValues = (f: FakeFilter | undefined): readonly unknown[] => (f && f.kind === "in" ? f.values : []);

// The I/O half of sources/mail.ts against a fake clone (the real
// missive-client runs underneath) and a fake PostgREST. Contract §3.5, §5 A.

function mint(accounts: string[], over: { id?: string; email?: string } = {}): ExecPrincipal {
  const p = principalFromRows(
    { id: over.id ?? "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: over.email ?? "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const HIS = "acc_his";
const principal = mint([HIS]);
const T0 = 1_762_250_000_000;
const at = (minutes: number) => String(T0 + minutes * 60_000);
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

// A clone message row as GET /api/threads/:id?defer_bodies=1 sends it.
function cloneMsg(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "m_x",
    thread_id: "t1",
    account_id: HIS,
    workspace_id: "w1",
    direction: "inbound",
    folder: "Inbox",
    message_id: null,
    in_reply_to: null,
    subject: "SECRET subject",
    from_addr: "Client <client@acme.io>",
    to_addrs: "Mitchell <mitchell@scaledai.org>",
    cc_addrs: "",
    sent_at: at(0),
    created_at: at(0),
    is_automated: 0,
    has_attachments: 0,
    snippet: "SECRET snippet",
    body_html: null,
    body_text: null,
    body_deferred: true,
    attachments: [],
    account_email: "mitchell@scaledai.org",
    account_name: "Mitchell",
    ...over
  };
}

function threadDetail(messages: Record<string, unknown>[], thread: Record<string, unknown> = {}) {
  return {
    thread: { id: "t1", subject: "SECRET thread subject", participants: "Client <client@acme.io>; mitchell@scaledai.org", last_message_at: at(90), last_snippet: "SECRET", ...thread },
    messages,
    comments: [{ id: "c1", body: "SECRET internal comment" }]
  };
}

let clone: FakeClone;

beforeEach(() => {
  __resetMessagesFeedProbeForTests();
  clone = installFakeClone(() => json(500, { error: "no handler" }), vi.stubGlobal);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// readPrincipalThread
// ---------------------------------------------------------------------------

describe("readPrincipalThread", () => {
  const serve = (detail: unknown) => clone.setHandler(() => json(200, detail));

  it("reads with deferred bodies and returns his messages only; the rest is metadata", async () => {
    serve(
      threadDetail([
        cloneMsg({ id: "m_in", message_id: "<in@acme.io>", sent_at: at(0), created_at: at(1) }),
        cloneMsg({
          id: "m_team",
          account_id: "acc_teammate",
          direction: "outbound",
          folder: "Sent Items",
          from_addr: "Teammate <tm@scaledai.org>",
          to_addrs: "client@acme.io",
          cc_addrs: "Payroll <payroll@deel.com>",
          message_id: "<team@scaledai.org>",
          sent_at: at(30),
          created_at: at(31),
          body_deferred: false,
          body_text: "SECRET teammate body"
        }),
        cloneMsg({ id: "m_out", direction: "outbound", folder: "Sent Items", from_addr: "", to_addrs: "Client <client@acme.io>", message_id: "<out@x>", sent_at: at(60), created_at: at(61), body_deferred: false, body_html: "<p>hi</p>" })
      ])
    );
    const r = await readPrincipalThread(principal, "t1");
    expect(clone.requests).toHaveLength(1);
    expect(clone.requests[0].path).toBe("/api/threads/t1");
    expect(clone.requests[0].url.search).toBe("?defer_bodies=1");
    expect(r.kind).toBe("ok");
    const t = (r as { thread: PrincipalMailThread }).thread;
    expect(t.his.map((m) => m.id)).toEqual(["m_in", "m_out"]);
    expect(t.his[0]).toMatchObject({
      accountId: HIS,
      direction: "inbound",
      folder: "Inbox",
      isJunk: false,
      rfcMessageId: "<in@acme.io>",
      subject: "SECRET subject",
      from: { name: "Client", email: "client@acme.io" },
      to: [{ name: "Mitchell", email: "mitchell@scaledai.org" }],
      cc: [],
      sentAt: iso(0),
      createdAtMs: T0 + 60_000,
      bodyDeferred: true,
      bodyHtml: null
    });
    expect(t.his[1]).toMatchObject({ from: null, bodyDeferred: false, bodyHtml: "<p>hi</p>" });
    // Every message, any account, as raw-address metadata: no subject, body or snippet.
    expect(t.all.map((m) => m.id)).toEqual(["m_in", "m_team", "m_out"]);
    expect(t.all[1]).toEqual({
      id: "m_team",
      accountId: "acc_teammate",
      direction: "outbound",
      from: "Teammate <tm@scaledai.org>",
      to: ["client@acme.io"],
      cc: ["Payroll <payroll@deel.com>"],
      rfcMessageId: "<team@scaledai.org>",
      inReplyTo: null,
      createdAtMs: T0 + 31 * 60_000,
      sentAt: iso(30)
    });
    expect(JSON.stringify(t.all)).not.toContain("SECRET");
    expect(JSON.stringify(t)).not.toContain("SECRET internal comment");
    expect(JSON.stringify(t)).not.toContain("SECRET teammate body");
    expect(t.participants).toEqual(["Client <client@acme.io>", "mitchell@scaledai.org"]);
    expect(t.lastMessageAt).toBe(iso(90));
  });

  it("dedupes his copies by (rfc id, direction) keeping the lowest id; rows without an rfc id are all kept", async () => {
    const two = mint([HIS, "acc_two"]);
    serve(
      threadDetail([
        cloneMsg({ id: "m_b", message_id: "<same@x>", account_id: "acc_two", sent_at: at(1) }),
        cloneMsg({ id: "m_a", message_id: "<same@x>", sent_at: at(1) }),
        cloneMsg({ id: "m_c", message_id: "<same@x>", direction: "outbound", folder: "Sent Items", sent_at: at(1) }),
        cloneMsg({ id: "m_n1", message_id: "", sent_at: at(2) }),
        cloneMsg({ id: "m_n2", message_id: null, sent_at: at(2) })
      ])
    );
    const r = await readPrincipalThread(two, "t1");
    const t = (r as { thread: PrincipalMailThread }).thread;
    expect(t.his.map((m) => m.id)).toEqual(["m_a", "m_c", "m_n1", "m_n2"]);
    expect(t.all).toHaveLength(5);
  });

  it("builds the snapshot from every message of the thread, any account", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(T0 + 1000).mockReturnValueOnce(T0 + 1450);
    serve(
      threadDetail([
        cloneMsg({ id: "m1", message_id: "<a@x>", sent_at: at(0), created_at: at(5) }),
        // The same rfc id on another account is another identity...
        cloneMsg({ id: "m2", message_id: "<a@x>", account_id: "acc_other", sent_at: at(0), created_at: at(6) }),
        // ...on the same account and direction it is the same one.
        cloneMsg({ id: "m3", message_id: "<a@x>", sent_at: at(0), created_at: at(7) }),
        cloneMsg({ id: "m4", message_id: null, account_id: "acc_other", sent_at: at(80), created_at: at(9) }),
        cloneMsg({ id: "m5", message_id: "", account_id: "acc_other", sent_at: at(10), created_at: at(99) })
      ])
    );
    const r = await readPrincipalThread(principal, "t1");
    now.mockRestore();
    expect((r as { thread: PrincipalMailThread }).thread.snapshot).toEqual({
      identityCount: 4,
      maxCreatedAtMs: T0 + 99 * 60_000,
      maxSentAtMs: T0 + 80 * 60_000,
      readStartedAtMs: T0 + 1000,
      readDoneAtMs: T0 + 1450
    });
  });

  it("orders his messages by (sentAt, id), flags junk and normalizes the automated flag from 0/1", async () => {
    serve(
      threadDetail([
        cloneMsg({ id: "m_9", direction: "outbound", folder: "Sent", is_automated: 1, sent_at: at(9) }),
        cloneMsg({ id: "m_2", folder: "Junk Email", is_automated: "1", sent_at: at(5) }),
        cloneMsg({ id: "m_1", is_automated: true, sent_at: at(5) }),
        cloneMsg({ id: "m_0", is_automated: "0", sent_at: at(1) }),
        cloneMsg({ id: "m_n", is_automated: null, sent_at: at(0) }),
        cloneMsg({ id: "m_u", is_automated: undefined, sent_at: at(-1) })
      ])
    );
    const t = ((await readPrincipalThread(principal, "t1")) as { thread: PrincipalMailThread }).thread;
    expect(t.his.map((m) => [m.id, m.isAutomated, m.isJunk])).toEqual([
      ["m_u", false, false],
      ["m_n", false, false],
      ["m_0", false, false],
      ["m_1", true, false],
      ["m_2", true, true],
      ["m_9", true, false]
    ]);
  });

  it("not_found is the clone's own JSON 404; any other 404 is retried, never read as gone", async () => {
    clone.setHandler(() => json(404, { error: "not found" }));
    const before = Date.now();
    const gone = await readPrincipalThread(principal, "t_gone");
    expect(gone).toEqual({ kind: "not_found", readDoneAtMs: expect.any(Number) });
    // The 404 read's own end: the gone proposal's time (amendments-7(a)).
    if (gone.kind !== "not_found") throw new Error("expected not_found");
    expect(gone.readDoneAtMs).toBeGreaterThanOrEqual(before);
    expect(gone.readDoneAtMs).toBeLessThanOrEqual(Date.now());
    clone.setHandler((req) => expressNotFound(req.path));
    const err = await readPrincipalThread(principal, "t1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneHttpError);
    expect(classifyError(err)).toBe("retryable");
  });

  it("clone errors keep their status for the job runner but drop the response text", async () => {
    clone.setHandler(() => json(500, { error: "invalid input syntax for type bigint: \"client@acme.io\"" }));
    const err = (await readPrincipalThread(principal, "t1").catch((e: unknown) => e)) as CloneHttpError;
    expect(err).toBeInstanceOf(CloneHttpError);
    expect(err.status).toBe(500);
    expect(err.message).toBe("clone thread read answered HTTP 500");
    expect(classifyError(err)).toBe("retryable");
    clone.setHandler(() => json(401, { error: "invalid token" }));
    expect(classifyError(await readPrincipalThread(principal, "t1").catch((e: unknown) => e))).toBe("auth");
  });

  it("not_his when no message is on an allowed account", async () => {
    serve(threadDetail([cloneMsg({ id: "m1", account_id: "acc_other" }), cloneMsg({ id: "m2", account_id: null })]));
    expect(await readPrincipalThread(principal, "t1")).toEqual({ kind: "not_his" });
  });

  it("`usable` narrows what counts as his; an empty one answers not_his without a request", async () => {
    const two = mint([HIS, "acc_two"]);
    serve(threadDetail([cloneMsg({ id: "m1", account_id: "acc_two" }), cloneMsg({ id: "m2", account_id: HIS, sent_at: at(1) })]));
    const t = ((await readPrincipalThread(two, "t1", { usable: [HIS] })) as { thread: PrincipalMailThread }).thread;
    expect(t.his.map((m) => m.id)).toEqual(["m2"]);
    expect(await readPrincipalThread(two, "t1", { usable: ["acc_two"] })).toMatchObject({ kind: "ok" });
    const before = clone.requests.length;
    expect(await readPrincipalThread(two, "t1", { usable: [] })).toEqual({ kind: "not_his" });
    expect(clone.requests).toHaveLength(before);
  });

  it("refuses a usable account outside the pin, an empty pin and a malformed id, before any request", async () => {
    await expect(readPrincipalThread(principal, "t1", { usable: ["acc_other"] })).rejects.toBeInstanceOf(MailScopeError);
    await expect(readPrincipalThread(mint([]), "t1")).rejects.toBeInstanceOf(MailScopeError);
    await expect(readPrincipalThread(principal, "")).rejects.toBeInstanceOf(NonRetryableError);
    await expect(readPrincipalThread(principal, "t\n1")).rejects.toBeInstanceOf(NonRetryableError);
    await expect(readPrincipalThread(principal, "x".repeat(201))).rejects.toBeInstanceOf(NonRetryableError);
    expect(clone.requests).toHaveLength(0);
  });

  it("every call has a timeout, combined with the caller's signal", async () => {
    clone.setHandler(() => new Promise<Response>(() => {}));
    const timedOut = await readPrincipalThread(principal, "t1", { timeoutMs: 20 }).catch((e: unknown) => e);
    expect((timedOut as Error).name).toBe("TimeoutError");
    expect(classifyError(timedOut)).toBe("retryable");
    const job = new AbortController();
    const pending = readPrincipalThread(principal, "t1", { signal: job.signal, timeoutMs: 60_000 });
    job.abort(new Error("lease lost"));
    await expect(pending).rejects.toThrow("lease lost");
    // The request saw a signal of its own, not the job's.
    expect(clone.requests.every((r) => r.signal !== null && r.signal !== job.signal)).toBe(true);
  });

  it("drops a message the clone attributes to another thread", async () => {
    serve(threadDetail([cloneMsg({ id: "m1" }), cloneMsg({ id: "m_stray", thread_id: "t_other" })]));
    const t = ((await readPrincipalThread(principal, "t1")) as { thread: PrincipalMailThread }).thread;
    expect(t.all.map((m) => m.id)).toEqual(["m1"]);
  });
});

// ---------------------------------------------------------------------------
// loadHisBodies
// ---------------------------------------------------------------------------

describe("loadHisBodies", () => {
  async function readWith(p: ExecPrincipal, messages: Record<string, unknown>[]) {
    clone.setHandler((req) => (req.path === "/api/threads/t1" ? json(200, threadDetail(messages)) : json(500, {})));
    const r = await readPrincipalThread(p, "t1");
    return (r as { thread: PrincipalMailThread }).thread;
  }

  it("fills in deferred bodies, skips ones that have a body, and re-derives inline attachments", async () => {
    const t = await readWith(principal, [
      cloneMsg({ id: "m1", attachments: [{ id: "a1", message_id: "m1", filename: "logo.png", content_type: "image/png", size_bytes: 10, content_id: "logo@1" }] }),
      cloneMsg({ id: "m2", sent_at: at(1), body_deferred: false, body_text: "already here" })
    ]);
    expect(t.his[0].attachments[0].inline).toBe(false);
    clone.setHandler((req) => (req.path === "/api/messages/m1/body" ? json(200, { id: "m1", body_html: '<img src="cid:logo@1">', body_text: "hello" }) : json(500, {})));
    await loadHisBodies(principal, t, ["m1", "m2"]);
    expect(clone.requests.map((r) => r.path).filter((p) => p.endsWith("/body"))).toEqual(["/api/messages/m1/body"]);
    expect(t.his[0]).toMatchObject({ bodyDeferred: false, bodyHtml: '<img src="cid:logo@1">', bodyText: "hello" });
    expect(t.his[0].attachments[0]).toEqual({ id: "a1", filename: "logo.png", contentType: "image/png", size: 10, inline: true });
    expect(t.his[1].bodyText).toBe("already here");
  });

  it("a body the clone no longer has loads as empty", async () => {
    const t = await readWith(principal, [cloneMsg({ id: "m1" })]);
    clone.setHandler(() => json(404, { error: "not found" }));
    await loadHisBodies(principal, t, ["m1"]);
    expect(t.his[0]).toMatchObject({ bodyDeferred: false, bodyHtml: null, bodyText: null });
  });

  it("any other body failure throws", async () => {
    const t = await readWith(principal, [cloneMsg({ id: "m1" })]);
    clone.setHandler(() => json(503, { error: "busy" }));
    await expect(loadHisBodies(principal, t, ["m1"])).rejects.toBeInstanceOf(CloneHttpError);
  });

  it("refuses a message that isn't one of his, before fetching anything", async () => {
    const t = await readWith(principal, [cloneMsg({ id: "m1" }), cloneMsg({ id: "m_foreign", account_id: "acc_teammate" })]);
    const before = clone.requests.length;
    await expect(loadHisBodies(principal, t, ["m1", "m_foreign"])).rejects.toBeInstanceOf(MailScopeError);
    expect(clone.requests).toHaveLength(before);
  });

  it("refuses one of his messages on an account that isn't pinned for this principal", async () => {
    const t = await readWith(mint([HIS, "acc_two"]), [cloneMsg({ id: "m1" }), cloneMsg({ id: "m2", account_id: "acc_two", sent_at: at(1) })]);
    await expect(loadHisBodies(principal, t, ["m2"])).rejects.toBeInstanceOf(MailScopeError);
  });

  it("runs at most 4 body reads at a time", async () => {
    const t = await readWith(principal, Array.from({ length: 10 }, (_, i) => cloneMsg({ id: `m${i}`, sent_at: at(i) })));
    let inFlight = 0;
    let peak = 0;
    clone.setHandler(async (req: CloneRequest) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json(200, { id: req.path, body_html: null, body_text: "b" });
    });
    await loadHisBodies(principal, t, t.his.map((m) => m.id));
    expect(peak).toBe(4);
    expect(t.his.every((m) => m.bodyText === "b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("listPrincipalThreadsSince (list-mode reconcile)", () => {
  const page = (threads: unknown[], over: Record<string, unknown> = {}) => json(200, { threads, limit: 200, offset: 0, hasMore: false, ...over });

  it("always scopes to the mailbox and builds q itself, quoting a normalized ISO time; no folder, no before:", async () => {
    clone.setHandler(() =>
      page([{ id: "t1", subject: "SECRET", participants: "a@x.com", last_message_at: at(5), last_from: "SECRET", last_snippet: "SECRET" }], { hasMore: true, limit: 150 })
    );
    const r = await listPrincipalThreadsSince(principal, HIS, { afterIso: "2026-11-04T10:00:00+02:00", limit: 150, offset: 299 });
    const params = Object.fromEntries(clone.requests[0].url.searchParams);
    expect(params).toEqual({ q: 'after:"2026-11-04T08:00:00.000Z"', limit: "150", offset: "299", mailbox_id: HIS });
    expect(clone.requests[0].url.search).not.toContain("before");
    expect(r).toEqual({ threads: [{ threadId: "t1", lastMessageAt: iso(5) }], hasMore: true, limitEchoed: 150 });
  });

  it("asks for snoozed threads only when told to, and clamps the page size", async () => {
    clone.setHandler(() => page([]));
    await listPrincipalThreadsSince(principal, HIS, { afterIso: iso(0), limit: 1000, offset: 0, snoozed: true });
    expect(clone.requests[0].url.searchParams.get("snoozed")).toBe("true");
    expect(clone.requests[0].url.searchParams.get("limit")).toBe("200");
    await listPrincipalThreadsSince(principal, HIS, { afterIso: iso(0), limit: 10, offset: 0 });
    expect(clone.requests[1].url.searchParams.has("snoozed")).toBe(false);
  });

  it("refuses an unpinned account, an empty pin and bad arguments before any request", async () => {
    await expect(listPrincipalThreadsSince(principal, "acc_other", { afterIso: iso(0), limit: 10, offset: 0 })).rejects.toBeInstanceOf(MailScopeError);
    await expect(listPrincipalThreadsSince(mint([]), HIS, { afterIso: iso(0), limit: 10, offset: 0 })).rejects.toBeInstanceOf(MailScopeError);
    await expect(listPrincipalThreadsSince(principal, HIS, { afterIso: '2026-11-04T10:00:00Z" from:x', limit: 10, offset: 0 })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(listPrincipalThreadsSince(principal, HIS, { afterIso: iso(0), limit: 0, offset: 0 })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(listPrincipalThreadsSince(principal, HIS, { afterIso: iso(0), limit: 10, offset: -1 })).rejects.toBeInstanceOf(NonRetryableError);
    expect(clone.requests).toHaveLength(0);
  });
});

describe("listPrincipalMessagesFeed (CL1)", () => {
  const SETTLED = String(T0 + 3_600_000);
  const feedRow = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    thread_id: "t1",
    account_id: HIS,
    direction: "inbound",
    folder: "Inbox",
    message_id: "<m1@x>",
    in_reply_to: null,
    from_addr: "Client <client@acme.io>",
    to_addrs: "Mitchell <mitchell@scaledai.org>, ops@acme.io",
    cc_addrs: "",
    subject: "SECRET subject",
    sent_at: at(0),
    created_at: at(1),
    has_attachments: 0,
    graph_id: "AAMk",
    web_link: "https://outlook.office365.com/owa/?ItemID=AAMk&exvsurl=1",
    is_read: false,
    importance: "high",
    flag_status: "Flagged",
    categories: [],
    parent_folder_id: null,
    inference_classification: "focused",
    change_key: "ck",
    removed_at: null,
    removed_reason: null,
    signals_updated_at: at(3),
    ...over
  });
  const page = (messages: unknown[], over: Record<string, unknown> = {}) =>
    json(200, { messages, next_cursor: "bmV4dA", has_more: false, settled_through: SETTLED, ...over });

  it("normalizes rows: epoch-ms times, typed signals, split addresses, no automated flag and no subject", async () => {
    clone.setHandler(() =>
      page([
        feedRow(),
        feedRow({ id: "m2", direction: "outbound", folder: "Junk Email", signals_updated_at: null, flag_status: null, is_read: null, importance: "urgent", web_link: "javascript:alert(1)", removed_at: at(9) })
      ], { has_more: true })
    );
    const r = await listPrincipalMessagesFeed(principal, HIS, { order: "changed", cursor: null, sinceIso: iso(-60), limit: 200 });
    expect(r).toMatchObject({ supported: true, nextCursor: "bmV4dA", hasMore: true, settledThrough: new Date(Number(SETTLED)).toISOString(), settledThroughMs: Number(SETTLED) });
    if (!r.supported) throw new Error("unreachable");
    expect(r.rows[0]).toEqual({
      messageId: "m1",
      threadId: "t1",
      accountId: HIS,
      direction: "inbound",
      folder: "Inbox",
      isJunk: false,
      rfcMessageId: "<m1@x>",
      inReplyTo: null,
      sentAtMs: T0,
      createdAtMs: T0 + 60_000,
      signalsAtMs: T0 + 180_000,
      flagStatus: "flagged",
      isRead: false,
      importance: "high",
      webLink: "https://outlook.office365.com/owa/?ItemID=AAMk&exvsurl=1",
      removedAtMs: null,
      from: "Client <client@acme.io>",
      to: ["Mitchell <mitchell@scaledai.org>", "ops@acme.io"],
      cc: []
    });
    expect(r.rows[1]).toMatchObject({ direction: "outbound", isJunk: true, signalsAtMs: T0 + 60_000, flagStatus: null, isRead: null, importance: null, webLink: null, removedAtMs: T0 + 540_000 });
    for (const row of r.rows) {
      expect("isAutomated" in row).toBe(false);
      expect(JSON.stringify(row)).not.toContain("SECRET");
    }
  });

  it("sends since (normalized) on a first page and the cursor afterwards", async () => {
    clone.setHandler(() => page([]));
    await listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: "2026-10-21T00:00:00-04:00", limit: 50 });
    await listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: "bmV4dA", sinceIso: "2026-10-21T00:00:00Z", limit: 50 });
    expect(Object.fromEntries(clone.requests[0].url.searchParams)).toEqual({ account_id: HIS, order: "created", since: "2026-10-21T04:00:00.000Z", limit: "50" });
    expect(Object.fromEntries(clone.requests[1].url.searchParams)).toEqual({ account_id: HIS, order: "created", cursor: "bmV4dA", limit: "50" });
  });

  it("a pre-CL1 clone (HTML 404) is unsupported, and that answer is cached", async () => {
    clone.setHandler((req) => expressNotFound(req.path));
    expect(await listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: iso(0), limit: 10 })).toEqual({ supported: false });
    expect(await listPrincipalMessagesFeed(principal, HIS, { order: "changed", cursor: null, sinceIso: iso(0), limit: 10 })).toEqual({ supported: false });
    expect(clone.requests).toHaveLength(1);
  });

  it("a JSON 404 throws (fatal), it doesn't mean 'no feed'", async () => {
    clone.setHandler(() => json(404, { error: "not found" }));
    const err = await listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: iso(0), limit: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneHttpError);
    expect(classifyError(err)).toBe("fatal");
  });

  it.each([
    ["another account", { account_id: "acc_other" }],
    ["no id", { id: "" }],
    ["no thread", { thread_id: null }],
    ["a bad direction", { direction: "sideways" }],
    ["no created_at", { created_at: null }]
  ])("a row with %s throws rather than being read as his", async (_name, over) => {
    clone.setHandler(() => page([feedRow(), feedRow(over)]));
    await expect(listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: iso(0), limit: 10 })).rejects.toThrow(/malformed/);
  });

  it("refuses an unpinned account and bad arguments", async () => {
    await expect(listPrincipalMessagesFeed(principal, "acc_other", { order: "created", cursor: null, sinceIso: null, limit: 10 })).rejects.toBeInstanceOf(MailScopeError);
    await expect(listPrincipalMessagesFeed(principal, HIS, { order: "newest" as "created", cursor: null, sinceIso: null, limit: 10 })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: "", sinceIso: null, limit: 10 })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(listPrincipalMessagesFeed(principal, HIS, { order: "created", cursor: null, sinceIso: "later", limit: 10 })).rejects.toBeInstanceOf(NonRetryableError);
    expect(clone.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Accounts and internal addresses
// ---------------------------------------------------------------------------

describe("checkPinnedAccounts", () => {
  it("reports each pinned mailbox and flags the ones that can't be used", async () => {
    const p = mint(["acc_ok", "acc_gone", "acc_someone", "acc_imap"]);
    clone.setHandler(() =>
      json(200, {
        accounts: [
          {
            id: "acc_ok",
            email: " Mitchell@ScaledAI.org ",
            provider: "Microsoft",
            last_synced_at: at(10),
            last_sync_error: "AADSTS700082: refresh token expired.\n Bearer eyJhbGciOiJIUzI1NiJ9abcdef1234 " + "x".repeat(300),
            last_sync_error_at: at(9)
          },
          { id: "acc_someone", email: "someone@scaledai.org", provider: "microsoft", last_synced_at: null },
          { id: "acc_imap", email: "mitchell@scaledai.org", provider: null, last_synced_at: at(1) },
          { id: "acc_unrelated", email: "x@y.com", provider: "microsoft" }
        ]
      })
    );
    const r = await checkPinnedAccounts(p);
    expect(r.problems).toEqual([
      { accountId: "acc_gone", reason: "not_found" },
      { accountId: "acc_someone", reason: "email_mismatch" },
      { accountId: "acc_imap", reason: "not_microsoft" }
    ]);
    expect(r.accounts.map((a) => a.id)).toEqual(["acc_ok", "acc_someone", "acc_imap"]);
    const ok = r.accounts[0];
    expect(ok).toMatchObject({ email: "mitchell@scaledai.org", lastSyncedAt: iso(10), lastSyncErrorAt: iso(9) });
    expect(ok.lastSyncError?.length).toBeLessThanOrEqual(200);
    expect(ok.lastSyncError).toContain("AADSTS700082");
    expect(ok.lastSyncError).toContain("[redacted]");
    expect(ok.lastSyncError).not.toContain("eyJhbGci");
    expect(ok.lastSyncError).not.toContain("\n");
  });

  it("throws when the clone can't be read, and refuses an empty pin", async () => {
    clone.setHandler(() => json(502, { error: "bad gateway" }));
    await expect(checkPinnedAccounts(principal)).rejects.toBeInstanceOf(CloneHttpError);
    await expect(checkPinnedAccounts(mint([]))).rejects.toBeInstanceOf(MailScopeError);
  });
});

describe("listInternalAddresses", () => {
  it("every connected address, their non-free-mail domains, plus scaledai.org", async () => {
    clone.setHandler(() =>
      json(200, {
        accounts: [
          { id: "a1", email: "Mitchell@ScaledAI.org" },
          { id: "a2", email: "team@outpatient-partner.com" },
          { id: "a3", email: "someone@gmail.com" },
          { id: "a4", email: "broken" },
          { id: "a5", email: null }
        ]
      })
    );
    expect(await listInternalAddresses(principal)).toEqual({
      addresses: ["mitchell@scaledai.org", "someone@gmail.com", "team@outpatient-partner.com"],
      domains: ["outpatient-partner.com", "scaledai.org"]
    });
  });

  it("throws when the clone can't be read", async () => {
    clone.setHandler(() => json(500, {}));
    await expect(listInternalAddresses(principal)).rejects.toBeInstanceOf(CloneHttpError);
  });
});

// ---------------------------------------------------------------------------
// Reply artifacts (DD tables)
// ---------------------------------------------------------------------------

describe("reply artifacts", () => {
  const scheduled = (over: Row): Row => ({
    id: "se_1",
    thread_id: "t1",
    account_id: HIS,
    user_id: "u_delegate",
    status: "pending",
    scheduled_for: "2026-11-05T14:00:00.000Z",
    body_text: "SECRET scheduled body",
    subject: "SECRET",
    to_emails: ["SECRET@x.com"],
    ...over
  });
  const draft = (over: Row): Row => ({
    id: "ed_1",
    source_thread_id: "t1",
    account_id: HIS,
    status: "pending",
    dismissed_at: null,
    kind: "auto_reply",
    body_text: "SECRET draft body",
    subject: "SECRET",
    ...over
  });

  function artifactsDb(cfg: FakePostgrestConfig) {
    const db = createFakePostgrest(cfg);
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    return db;
  }

  const TABLES = {
    scheduled_emails: [
      scheduled({ id: "se_1", thread_id: "t1", scheduled_for: "2026-11-05T14:00:00.000Z" }),
      scheduled({ id: "se_2", thread_id: "t1", scheduled_for: "2026-11-05T09:00:00.000Z" }),
      scheduled({ id: "se_3", thread_id: "t2", status: "sent" }),
      scheduled({ id: "se_4", thread_id: "t3", account_id: "acc_teammate" }),
      scheduled({ id: "se_5", thread_id: "t4" })
    ],
    email_drafts: [
      draft({ id: "ed_1", source_thread_id: "t1" }),
      draft({ id: "ed_2", source_thread_id: "t2", dismissed_at: "2026-11-01T00:00:00.000Z" }),
      draft({ id: "ed_3", source_thread_id: "t5" }),
      draft({ id: "ed_4", source_thread_id: "t6", account_id: "acc_teammate" }),
      draft({ id: "ed_5", source_thread_id: null, kind: "client_update" }),
      draft({ id: "ed_6", source_thread_id: "t7", status: "approved" })
    ]
  };

  it("listReplyArtifacts: pending, undismissed, his accounts, the earliest scheduled send; explicit columns", async () => {
    const db = artifactsDb({ tables: TABLES });
    const map = await listReplyArtifacts(principal, ["t1", "t2", "t3", "t5", "t6", "t7", "t1"]);
    expect([...map.entries()].sort()).toEqual([
      ["t1", { scheduledFor: "2026-11-05T09:00:00.000Z", draftPending: true }],
      ["t5", { scheduledFor: null, draftPending: true }]
    ]);
    expect(db.on("scheduled_emails")[0].columns).toBe("id, thread_id, scheduled_for");
    expect(db.on("email_drafts")[0].columns).toBe("id, source_thread_id");
    expect(db.on("scheduled_emails")[0].filters).toContainEqual({ kind: "in", column: "account_id", values: [HIS] });
    expect(db.on("email_drafts")[0].filters).toContainEqual({ kind: "is", column: "dismissed_at", value: null });
  });

  it("chunks thread ids at 200 and asks nothing for no ids", async () => {
    const db = artifactsDb({ tables: TABLES });
    expect((await listReplyArtifacts(principal, [])).size).toBe(0);
    expect(db.queries).toHaveLength(0);
    await listReplyArtifacts(principal, Array.from({ length: 450 }, (_, i) => `t_${i}`));
    expect(db.on("scheduled_emails").map((q) => inValues(q.filters.find((f) => f.kind === "in" && f.column === "thread_id")).length)).toEqual([200, 200, 50]);
  });

  it("listAllReplyArtifacts: every thread of his with one", async () => {
    artifactsDb({ tables: TABLES });
    const map = await listAllReplyArtifacts(principal);
    expect([...map.keys()].sort()).toEqual(["t1", "t4", "t5"]);
    expect(map.get("t4")).toEqual({ scheduledFor: "2026-11-05T14:00:00.000Z", draftPending: false });
  });

  it("countPendingReplyArtifacts: pending undismissed drafts of any kind, and pending sends, his accounts only", async () => {
    artifactsDb({ tables: TABLES });
    expect(await countPendingReplyArtifacts(principal)).toEqual({ draftsPending: 3, scheduledReplies: 3 });
  });

  it("fails closed: a read error throws, and a missing count is an error, never zero", async () => {
    artifactsDb({ tables: TABLES, fail: (q) => (q.table === "email_drafts" ? "permission denied" : null) });
    await expect(listReplyArtifacts(principal, ["t1"])).rejects.toBeInstanceOf(MailReadError);
    await expect(listAllReplyArtifacts(principal)).rejects.toBeInstanceOf(MailReadError);
    await expect(countPendingReplyArtifacts(principal)).rejects.toBeInstanceOf(MailReadError);
    artifactsDb({ tables: TABLES, respond: (q) => (q.head ? { count: null } : undefined) });
    await expect(countPendingReplyArtifacts(principal)).rejects.toThrow(/no count/);
  });

  it("refuses an empty pin", async () => {
    artifactsDb({ tables: TABLES });
    await expect(listReplyArtifacts(mint([]), ["t1"])).rejects.toBeInstanceOf(MailScopeError);
    await expect(countPendingReplyArtifacts(mint([]))).rejects.toBeInstanceOf(MailScopeError);
  });
});
