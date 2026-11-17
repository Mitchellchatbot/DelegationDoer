import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn(), runAudited: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn(), auditStart: vi.fn(), auditFinish: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()), getReadingHalf: vi.fn(), listActiveInstallationsForSystem: vi.fn()
}));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), listItemsForMessage: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-reading")>()), getSlackItemsByIds: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-pack", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-reply-pack")>()), findOwnPostByHash: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-send", () => ({ sendSlackReply: vi.fn(), reviewSlackReply: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-view", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-reply-view")>()), getReplyDraftPageView: vi.fn(), rerenderReplyCards: vi.fn()
}));

import * as createRoute from "@/app/api/exec/slack/replies/route";
import * as draftRoute from "@/app/api/exec/slack/replies/[id]/route";
import * as discardRoute from "@/app/api/exec/slack/replies/[id]/discard/route";
import * as regenerateRoute from "@/app/api/exec/slack/replies/[id]/regenerate/route";
import * as resolveRoute from "@/app/api/exec/slack/replies/[id]/resolve/route";
import * as reviewRoute from "@/app/api/exec/slack/replies/[id]/review/route";
import * as sendRoute from "@/app/api/exec/slack/replies/[id]/send/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditEvent } from "@/lib/exec/audit";
import { jsonError, rateLimit, runAudited, type AuditOutcomeSummary } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS, type ReplyDraftRow, type SendOutcome } from "@/lib/exec/slack-p10-types";
import { listItemsForMessage } from "@/lib/exec/slack-read-store";
import { getSlackItemsByIds } from "@/lib/exec/slack-reading";
import { findOwnPostByHash } from "@/lib/exec/slack-reply-pack";
import { reviewSlackReply, sendSlackReply } from "@/lib/exec/slack-reply-send";
import * as store from "@/lib/exec/slack-reply-store";
import { getReplyDraftPageView, rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import type { AuditEntry } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { FakeReplyDb } from "./__tests__/fake-reply-db";
import { assertNoReplyText } from "./__tests__/p10-assert";
import { CH, INST, MSG, NOW, P, compositeClient, installationRow, makeDraft, newWorld, rowOf, settings, sha256Hex } from "./__tests__/reply-d-harness";
import { itemRow } from "./__tests__/reply-d-rows";

// P10 §5.13 RU01-RU05 and §5.8 RS05 (the strict bodies), RS20 (the route's bucket), RS21 / RS21b (resolve and "Start a new draft
// with this text"), Area D. The seven routes with the gate, the rate limit and the audit mocked at their module boundaries
// (http.test.ts tests them); PATCH, discard and resolve run the real store over Area A's fake reply database (RPC 16, X1, X9,
// X10's fence); create runs Area C's real creation path over the same fake (RPC 13's p_from_draft copy), its P7a reads mocked;
// send / review / the page view are mocked (their own tests cover them). Invented names only.

const BASE = "https://operations.scaledai.org/api/exec/slack/replies";
let db: FakeReplyDb;
let audits: { entry: AuditEntry; finished: { ok: boolean; outcome?: string } | null }[];
let gateOpts: unknown[];

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { "sec-fetch-site": "same-origin", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return new Request(url, { method, headers: h, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const params = (id: string) => ({ params: { id } });
const cacheOf = (res: Response) => res.headers.get("cache-control");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.__resetReplyStoreForTests();
  const w = newWorld();
  db = w.db;
  vi.mocked(getSupabaseAdmin).mockReturnValue(compositeClient(db, w.users) as SupabaseClient);
  audits = [];
  gateOpts = [];
  vi.mocked(requireExecPrincipal).mockReset().mockImplementation(async (_req, _route, opts) => {
    gateOpts.push(opts);
    return { ok: true, principal: P };
  });
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(runAudited).mockReset().mockImplementation(async (_p, entry, fn, outcomeOf) => {
    const record: (typeof audits)[number] = { entry, finished: null };
    audits.push(record);
    try {
      const value = await fn();
      const s = (outcomeOf as (v: unknown) => AuditOutcomeSummary)(value);
      record.finished = { ok: s.ok, outcome: s.outcome };
      return { ok: true, value } as never;
    } catch {
      record.finished = { ok: false };
      return { ok: false, response: jsonError(503, "unavailable") };
    }
  });
  vi.mocked(auditEvent).mockReset().mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(getReadingHalf).mockReset().mockResolvedValue({ row: installationRow(), reading: { state: "ready", hasToken: true } } as never);
  const items = new Map<string, ReturnType<typeof itemRow>>();
  vi.mocked(listItemsForMessage).mockReset().mockImplementation(async (_p, ch, ts) => {
    // The item RPC 13 will look up: the seeded one for this message, else a new row in the fake's P7a items.
    const seeded = db.tables.exec_slack_items.find((i) => i.channel_id === ch && i.ts === ts);
    const id = seeded ? String(seeded.id) : `esl_${sha256Hex(`${ch}:${ts}`).slice(0, 32)}`;
    if (!seeded) db.tables.exec_slack_items.push({ id, principal_id: "ep_1", channel_id: ch, ts, urgency: "normal", responded_at: null });
    const item = itemRow(ch, ts, { id });
    items.set(item.id, item);
    return [item];
  });
  vi.mocked(getSlackItemsByIds).mockReset().mockImplementation(async (_p, ids) => ids.map((id) => items.get(id)).filter((i): i is ReturnType<typeof itemRow> => i !== undefined));
  vi.mocked(findOwnPostByHash).mockReset().mockResolvedValue({ found: false });
  vi.mocked(enqueueJob).mockReset().mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(sendSlackReply).mockReset().mockResolvedValue({ kind: "refused", reason: "not_found" });
  vi.mocked(reviewSlackReply).mockReset().mockResolvedValue({ kind: "refused", reason: "not_found" });
  vi.mocked(getReplyDraftPageView).mockReset();
  vi.mocked(rerenderReplyCards).mockReset().mockResolvedValue(0);
  for (const m of ["warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ALL = (id: string): [string, () => Promise<Response>][] => [
  ["create", () => createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "", fromDraftId: "" }))],
  ["get", () => draftRoute.GET(request("GET", `${BASE}/${id}`), params(id))],
  ["patch", () => draftRoute.PATCH(request("PATCH", `${BASE}/${id}`, { version: 1, text: "x" }), params(id))],
  ["regenerate", () => regenerateRoute.POST(request("POST", `${BASE}/${id}/regenerate`, { version: 1, instruction: "" }), params(id))],
  ["discard", () => discardRoute.POST(request("POST", `${BASE}/${id}/discard`, { version: 1 }), params(id))],
  ["review", () => reviewRoute.POST(request("POST", `${BASE}/${id}/review`, { version: 1 }), params(id))],
  ["send", () => sendRoute.POST(request("POST", `${BASE}/${id}/send`, { version: 1, textSha256: "a".repeat(64), acks: [] }), params(id))],
  ["resolve", () => resolveRoute.POST(request("POST", `${BASE}/${id}/resolve`, { action: "posted" }), params(id))]
];

describe("RU01 every route: the gate, same-origin, private no-store", () => {
  it("every handler gates with the step-up (his password and code); a refusal is the gate's answer, private no-store, nothing read", async () => {
    const id = `esr_${"1".repeat(32)}`;
    vi.mocked(getReplyDraftPageView).mockResolvedValue({ state: "not_found", draft: null });
    for (const [name, call] of ALL(id)) {
      gateOpts = [];
      const res = await call();
      expect(gateOpts, name).toEqual([{ requireStrongSignIn: true }]);
      expect(cacheOf(res), name).toBe("private, no-store");
    }
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: jsonError(404, "not_found") } as never);
    for (const [name, call] of ALL(id)) {
      const res = await call();
      expect(res.status, name).toBe(404);
      expect(cacheOf(res), name).toBe("private, no-store");
    }
    vi.mocked(sendSlackReply).mockClear();
    vi.mocked(reviewSlackReply).mockClear();
  });

  it("a cross-origin mutation → 403 before the body is read; GET needs no same-origin", async () => {
    const id = `esr_${"1".repeat(32)}`;
    const cross = { "sec-fetch-site": "cross-site" };
    const posts: [string, Promise<Response>][] = [
      ["create", createRoute.POST(request("POST", BASE, {}, cross))],
      ["patch", draftRoute.PATCH(request("PATCH", `${BASE}/${id}`, {}, cross), params(id))],
      ["regenerate", regenerateRoute.POST(request("POST", `${BASE}/${id}/regenerate`, {}, cross), params(id))],
      ["discard", discardRoute.POST(request("POST", `${BASE}/${id}/discard`, {}, cross), params(id))],
      ["review", reviewRoute.POST(request("POST", `${BASE}/${id}/review`, {}, cross), params(id))],
      ["send", sendRoute.POST(request("POST", `${BASE}/${id}/send`, {}, cross), params(id))],
      ["resolve", resolveRoute.POST(request("POST", `${BASE}/${id}/resolve`, {}, cross), params(id))]
    ];
    for (const [name, p] of posts) {
      const res = await p;
      expect(res.status, name).toBe(403);
      expect(cacheOf(res)).toBe("private, no-store");
    }
    vi.mocked(getReplyDraftPageView).mockResolvedValue({ state: "not_found", draft: null });
    expect((await draftRoute.GET(request("GET", `${BASE}/${id}`, undefined, cross), params(id))).status).toBe(404);
  });
});

describe("RU02 / RS05 POST create", () => {
  it("strict body: an extra key (a channel or thread for the destination) → 400; created → 201 with href; existing → 200", async () => {
    for (const extra of [{ channel: CH.im }, { thread_ts: MSG.ops }, { text: "post this" }]) {
      const res = await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "", fromDraftId: "", ...extra }));
      expect(res.status).toBe(400);
    }
    const res = await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "Say Friday works.", fromDraftId: "" }));
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ status: "generating", existing: false });
    expect(body.href).toBe(`/executive/slack/replies/${String(body.id)}`);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: P10_JOB_KINDS.replyGenerate, payload: { draft_id: body.id, seq: 1 } });
    expect(audits[0].entry).toMatchObject({ actor: "owner", action: "slack_reply.create", input: { channelId: CH.ops, ts: MSG.ops, instructionChars: 17 } });
    assertNoReplyText(audits, ["Say Friday works."]);
    const again = await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "", fromDraftId: "" }));
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe(body.id);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1, 4)).toEqual(["slack_reply_create", P10_LIMITS.replyCreateLimit, P10_LIMITS.replyRouteWindowMs]);
  });

  it("each refusal → 409 with its code; a malformed channel or ts → 400; a fromDraftId with an instruction → 400", async () => {
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackRepliesEnabled: false }));
    expect(await json(await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "", fromDraftId: "" })))).toEqual({ error: "off" });
    vi.mocked(getSlackItemsByIds).mockResolvedValueOnce([]);
    const screen = await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops2, itemId: "", instruction: "", fromDraftId: "" }));
    expect([screen.status, (await json(screen)).error]).toEqual([409, "screen"]);
    expect((await createRoute.POST(request("POST", BASE, { channelId: "nope", ts: MSG.ops, itemId: "", instruction: "", fromDraftId: "" }))).status).toBe(400);
    expect((await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "x", fromDraftId: `esr_${"2".repeat(32)}` }))).status).toBe(400);
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 30 }) });
    expect((await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "", fromDraftId: "" }))).status).toBe(429);
  });
});

describe("RU03 PATCH", () => {
  it("stores sanitizeChars(NFC(text)) with its placeholders recomputed; a lost CAS → 409 with the status and version; the cards follow", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    // U+200B ZERO WIDTH SPACE and "e" + U+0301 COMBINING ACUTE ACCENT (NFD), built from code points.
    const typed = `Caf e${String.fromCodePoint(0x301)} on [day]${String.fromCodePoint(0x200b)} works`.replace("Caf e", "Cafe");
    const res = await draftRoute.PATCH(request("PATCH", `${BASE}/${row.id}`, { version: row.version, text: typed }), params(row.id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ version: row.version + 1 });
    const stored = rowOf(db, row.id);
    expect(stored.text).toBe(`Caf${String.fromCodePoint(0xe9)} on [day] works`);
    expect(stored.placeholders).toEqual(["[day]"]);
    expect(stored.edited).toBe(true);
    expect(rerenderReplyCards).toHaveBeenCalledWith(P, row.id, { now: expect.any(Date) });
    expect(audits[0].entry).toMatchObject({ action: "slack_reply.edit", input: { draftId: row.id, version: row.version, textChars: String(stored.text).length } });
    const stale = await draftRoute.PATCH(request("PATCH", `${BASE}/${row.id}`, { version: row.version, text: "again" }), params(row.id));
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ error: "conflict", status: "draft", version: row.version + 1 });
    expect((await draftRoute.PATCH(request("PATCH", `${BASE}/${row.id}`, { version: 1, text: "x", channel: CH.im }), params(row.id))).status).toBe(400);
    expect((await draftRoute.PATCH(request("PATCH", `${BASE}/${row.id}`, { version: 1, text: String.fromCodePoint(0x200b) }), params(row.id))).status).toBe(400);
    expect((await draftRoute.PATCH(request("PATCH", `${BASE}/esr_${"9".repeat(32)}`, { version: 1, text: "x" }), params(`esr_${"9".repeat(32)}`))).status).toBe(404);
    expect(vi.mocked(rateLimit).mock.calls[0][1]).toBe("slack_reply_edit");
  });

  it("GET answers the page view (200) or 404", async () => {
    const id = `esr_${"3".repeat(32)}`;
    vi.mocked(getReplyDraftPageView).mockResolvedValueOnce({ state: "off", draft: null });
    expect(await json(await draftRoute.GET(request("GET", `${BASE}/${id}`), params(id)))).toEqual({ state: "off", draft: null });
    vi.mocked(getReplyDraftPageView).mockResolvedValueOnce({ state: "not_found", draft: null });
    expect((await draftRoute.GET(request("GET", `${BASE}/${id}`), params(id))).status).toBe(404);
  });
});

describe("RU04 regenerate and discard", () => {
  it("regenerate: 202 { generationSeq }; busy / conflict → 409; its rate is the create bucket; \"\" keeps the last instruction", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const res = await regenerateRoute.POST(request("POST", `${BASE}/${row.id}/regenerate`, { version: row.version, instruction: "" }), params(row.id));
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ generationSeq: 2 });
    const busy = await regenerateRoute.POST(request("POST", `${BASE}/${row.id}/regenerate`, { version: row.version, instruction: "Shorter" }), params(row.id));
    expect([busy.status, (await json(busy)).error]).toEqual([409, "busy"]);
    expect(vi.mocked(rateLimit).mock.calls.map((c) => c[1])).toEqual(["slack_reply_create", "slack_reply_create"]);
    expect(audits.map((a) => a.entry.action)).toEqual(["slack_reply.regenerate", "slack_reply.regenerate"]);
  });

  it("discard: X1 on the version (200), the text nulled; a lost CAS → 409 with the status; the edit bucket", async () => {
    const row = await makeDraft(CH.ops, MSG.ops);
    const stale = await discardRoute.POST(request("POST", `${BASE}/${row.id}/discard`, { version: row.version + 5 }), params(row.id));
    expect([stale.status, await json(stale)]).toEqual([409, { error: "conflict", status: "draft", version: row.version }]);
    const res = await discardRoute.POST(request("POST", `${BASE}/${row.id}/discard`, { version: row.version }), params(row.id));
    expect(res.status).toBe(200);
    expect(rowOf(db, row.id)).toMatchObject({ status: "discarded", text: null });
    expect(vi.mocked(rateLimit).mock.calls[0][1]).toBe("slack_reply_edit");
  });
});

describe("RU05 send / review", () => {
  it("every SendOutcome → its status code; textSha256 required and 64 hex; acks are blockers; the send bucket", async () => {
    const id = `esr_${"4".repeat(32)}`;
    const body = { version: 2, textSha256: sha256Hex("x"), acks: ["external"] };
    const cases: [SendOutcome, number, Record<string, unknown>][] = [
      [{ kind: "sent", postedTs: "1.000001", permalink: null }, 200, { kind: "sent", postedTs: "1.000001", permalink: null }],
      [{ kind: "in_flight" }, 202, { kind: "in_flight" }],
      [{ kind: "back_to_draft", reason: "not_in_channel", version: 3 }, 200, { kind: "back_to_draft", reason: "not_in_channel", version: 3 }],
      [{ kind: "unknown", reason: "timeout" }, 200, { kind: "unknown", reason: "timeout" }],
      [{ kind: "needs_ack", blockers: ["newer_messages"] }, 409, { error: "needs_ack", blockers: ["newer_messages"] }],
      [{ kind: "refused", reason: "placeholders", status: "draft" }, 409, { error: "refused", reason: "placeholders", status: "draft" }],
      [{ kind: "refused", reason: "not_found" }, 404, { error: "not_found" }]
    ];
    for (const [out, status, answer] of cases) {
      vi.mocked(sendSlackReply).mockResolvedValueOnce(out);
      const res = await sendRoute.POST(request("POST", `${BASE}/${id}/send`, body), params(id));
      expect([res.status, await json(res)], out.kind).toEqual([status, answer]);
    }
    expect(vi.mocked(sendSlackReply).mock.calls[0][1]).toMatchObject({ id, path: "web", version: 2, textSha256: sha256Hex("x"), acks: ["external"], actor: "owner" });
    for (const bad of [{ version: 2, acks: [] }, { version: 2, textSha256: "nothex", acks: [] }, { version: 2, textSha256: sha256Hex("x"), acks: ["sure"] },
      { version: 2, textSha256: sha256Hex("x"), acks: [], channel: CH.im }, { version: 0, textSha256: sha256Hex("x"), acks: [] }]) {
      expect((await sendRoute.POST(request("POST", `${BASE}/${id}/send`, bad), params(id))).status).toBe(400);
    }
    expect(vi.mocked(rateLimit).mock.calls.every((c) => c[1] === "slack_reply_send" && c[2] === 10)).toBe(true);
  });

  it("RS20 the 11th send in 10 minutes → 429 rate_limited, no send", async () => {
    const id = `esr_${"4".repeat(32)}`;
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 40 }) });
    const res = await sendRoute.POST(request("POST", `${BASE}/${id}/send`, { version: 2, textSha256: sha256Hex("x"), acks: [] }), params(id));
    expect(res.status).toBe(429);
    expect(sendSlackReply).not.toHaveBeenCalled();
  });

  it("review: 200 { version, blockers, destination }, one audit event slack_reply.review (the edit bucket); a refusal → 409 with the reason", async () => {
    const id = `esr_${"5".repeat(32)}`;
    vi.mocked(reviewSlackReply).mockResolvedValueOnce({ kind: "ok", version: 2, blockers: ["flags", "newer_messages"], place: "#zenith-house-ops", inThread: true });
    const res = await reviewRoute.POST(request("POST", `${BASE}/${id}/review`, { version: 2 }), params(id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ version: 2, blockers: ["flags", "newer_messages"], destination: "Reply in #zenith-house-ops, in the thread", place: "#zenith-house-ops", inThread: true });
    expect(vi.mocked(auditEvent).mock.calls[0][1]).toMatchObject({ actor: "owner", action: "slack_reply.review", input: { draftId: id, version: 2, blockers: 2 } });
    expect(vi.mocked(rateLimit).mock.calls[0][1]).toBe("slack_reply_edit");
    vi.mocked(reviewSlackReply).mockResolvedValueOnce({ kind: "refused", reason: "send_off", status: "draft" });
    const refused = await reviewRoute.POST(request("POST", `${BASE}/${id}/review`, { version: 2 }), params(id));
    expect([refused.status, await json(refused)]).toEqual([409, { error: "refused", reason: "send_off", status: "draft" }]);
    expect((await reviewRoute.POST(request("POST", `${BASE}/${id}/review`, { version: 2, extra: 1 }), params(id))).status).toBe(400);
  });
});

describe("RS21 / RS21b resolve and Start a new draft with this text", () => {
  async function unknownDraft(checks: number): Promise<ReplyDraftRow> {
    const row = await makeDraft(CH.ops, MSG.ops, { flags: ["unexpected_url"], injectionSuspected: true, contextTs: [MSG.ops, MSG.ops3], contextAuthors: ["U0JANE", "U0BOB"] });
    Object.assign(rowOf(db, row.id), { status: "unknown", status_reason: "timeout", sending_at: new Date(NOW.getTime() - 2 * 60_000).toISOString(), audit_id: 61,
      sent_text_sha256: sha256Hex(row.text ?? ""), verify_checks: checks });
    return row;
  }
  const resolve = (id: string, action: string) => resolveRoute.POST(request("POST", `${BASE}/${id}/resolve`, { action }), params(id));

  it("RS21b \"It didn't post\" before the third check (0, 1, 2) → 409 too_early with until; after it → failed; \"It posted\" → sent at any count", async () => {
    const row = await unknownDraft(0);
    for (const checks of [0, 1, 2]) {
      rowOf(db, row.id).verify_checks = checks;
      const res = await resolve(row.id, "not_posted");
      expect([res.status, await json(res)]).toEqual([409, { error: "too_early", until: new Date(NOW.getTime() - 2 * 60_000 + 31 * 60_000).toISOString() }]);
    }
    rowOf(db, row.id).verify_checks = 3;
    const res = await resolve(row.id, "not_posted");
    expect([res.status, await json(res)]).toEqual([200, { status: "failed" }]);
    expect(rowOf(db, row.id)).toMatchObject({ status: "failed", owner_resolution: "not_posted" });
    const other = await makeDraft(CH.priv, MSG.priv);
    Object.assign(rowOf(db, other.id), { status: "unknown", sending_at: NOW.toISOString(), audit_id: 62, verify_checks: 0 });
    expect(await json(await resolve(other.id, "posted"))).toEqual({ status: "sent" });
    expect(rowOf(db, other.id)).toMatchObject({ status: "sent", owner_resolution: "posted" });
    // Any other status → 409; the send bucket counts it.
    const fresh = await makeDraft(CH.im, MSG.im);
    expect([(await resolve(fresh.id, "posted")).status]).toEqual([409]);
    expect(vi.mocked(rateLimit).mock.calls.every((c) => c[1] === "slack_reply_send")).toBe(true);
    expect((await resolveRoute.POST(request("POST", `${BASE}/${fresh.id}/resolve`, { action: "maybe" }), params(fresh.id))).status).toBe(400);
  });

  it("RS21 a new draft from the old text: version 1, the old row's flags, injection mark and context refs carried in SQL, needing its own Send", async () => {
    const row = await unknownDraft(3);
    await resolve(row.id, "not_posted");
    const res = await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "", fromDraftId: row.id }));
    expect(res.status).toBe(201);
    const id = String((await json(res)).id);
    expect(id).not.toBe(row.id);
    const fresh = rowOf(db, id);
    expect(fresh).toMatchObject({ status: "draft", version: 1, text: rowOf(db, row.id).text ?? fresh.text, flags: ["unexpected_url"], injection_suspected: true,
      context_ts: [MSG.ops, MSG.ops3], context_authors: ["U0JANE", "U0BOB"] });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(sendSlackReply).not.toHaveBeenCalled();
  });

  it("RS21 a fromDraftId of another message → 409 from_draft_mismatch, nothing created; the pre-check finding the post → X13 and 409 already_posted", async () => {
    const row = await unknownDraft(3);
    await resolve(row.id, "not_posted");
    const before = db.tables.exec_slack_reply_drafts.length;
    const mismatch = await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops2, itemId: "", instruction: "", fromDraftId: row.id }));
    expect([mismatch.status, (await json(mismatch)).error]).toEqual([409, "from_draft_mismatch"]);
    expect(db.tables.exec_slack_reply_drafts.length).toBe(before);
    vi.mocked(findOwnPostByHash).mockResolvedValueOnce({ found: true, ts: "1794322790.000100" });
    const found = await createRoute.POST(request("POST", BASE, { channelId: CH.ops, ts: MSG.ops, itemId: "", instruction: "", fromDraftId: row.id }));
    expect([found.status, (await json(found)).error]).toEqual([409, "already_posted"]);
    expect(rowOf(db, row.id)).toMatchObject({ status: "sent", posted_ts: "1794322790.000100", owner_resolution: null });
    expect(db.tables.exec_slack_reply_drafts.length).toBe(before);
    void INST;
  });
  it("RS21 (security-6) the SQL half: RPC 13 refuses a copy of another message's draft on its own (the route's pre-check bypassed): from_draft_mismatch, nothing created", async () => {
    // Integrator (contract section 5.17, M58): the route's own pre-check answers 409 from_draft_mismatch before RPC 13 runs, so
    // RPC 13's same-message check (the fake mirrors the SQL) is reached here through the store, as a race past the pre-check
    // would reach it.
    const row = await unknownDraft(3);
    await resolve(row.id, "not_posted");
    const before = db.tables.exec_slack_reply_drafts.length;
    const expiresAt = new Date(NOW.getTime() + 7 * 86_400_000);
    for (const ts of [MSG.ops2, MSG.ops3]) {
      expect(await store.createReplyDraftRow(P, { installationId: INST, channelId: CH.ops, ts, itemId: null, origin: "web", instruction: null,
        fromDraftId: row.id, chatMessageId: null, expiresAt })).toEqual({ outcome: "refused", reason: "from_draft_mismatch" });
    }
    expect(db.tables.exec_slack_reply_drafts.length).toBe(before);
    expect(rowOf(db, row.id)).toMatchObject({ status: "failed", owner_resolution: "not_posted" });
  });
});
