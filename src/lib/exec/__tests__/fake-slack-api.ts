import { onTestFinished, vi } from "vitest";

import type { SlackMethod } from "@/lib/exec/slack-types";

// P6 test fake: a fetch stub that answers Slack Web API methods (contract
// §5.11; Area B). It stubs fetch (vi.stubGlobal) for https://slack.com/api/*,
// records every call and fails the test on any unstubbed host or method.
// Recorded shapes come from PLAT §3, §6, §7 (the OAuth success example,
// conversations.open, auth.test, chat.postMessage { ok, channel, ts }); see
// SLACK_RECORDED below.
//
//   const slack = installFakeSlack({ "chat.postMessage": () => ({ ok: true, channel: "D0MITCH", ts: "1.000001" }) });
//   ... expect(slack.calls.map((c) => c.method)).toEqual(["chat.postMessage"]);
//   slack.restore();
//
// Behaviour:
//   - A handler answers with a Response (any status, any headers: a 429 with Retry-After, a 503, a bad body) or a
//     plain object, sent as HTTP 200 JSON. It may return a promise; one that never settles models a hung Slack, and
//     the fake then rejects with the request's abort reason when the caller's signal aborts, as real fetch does.
//   - A call to any other host, to an unknown method, or to a method with no handler rejects with a TypeError (what a
//     network failure looks like) AND is remembered: the test fails when it finishes (onTestFinished), or at restore().
//   - restore() puts the previous fetch back; it runs on its own when the test finishes if the test didn't call it.

/** One recorded call: the method from the URL path, the request headers (lower-cased names) and the parsed body
 *  (JSON for the block writes, form fields for the rest). */
export interface FakeSlackCall { method: SlackMethod; headers: Record<string, string>; body: Record<string, unknown> }

/** A handler answers with a Response (any status, any headers) or a plain object sent as HTTP 200 JSON. */
export type FakeSlackHandler = (body: Record<string, unknown>, headers: Headers) => Response | object | Promise<Response | object>;

const SLACK_API = "https://slack.com/api/";
const METHODS: ReadonlySet<string> = new Set<SlackMethod>([
  "oauth.v2.access", "auth.test", "auth.revoke", "users.lookupByEmail", "conversations.open", "conversations.history",
  "conversations.replies", "chat.postMessage", "chat.update", "chat.delete", "views.publish",
  // P7a (§5.15; Area B): the seven reads.
  "conversations.list", "users.conversations", "conversations.info", "users.list", "users.info", "bots.info", "chat.getPermalink"
]);

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

async function bodyOf(input: RequestInfo | URL, init: RequestInit | undefined, headers: Headers): Promise<Record<string, unknown>> {
  let raw: string;
  if (input instanceof Request && init?.body === undefined) raw = await input.clone().text();
  else if (typeof init?.body === "string") raw = init.body;
  else if (init?.body instanceof URLSearchParams) raw = init.body.toString();
  else if (init?.body === undefined || init.body === null) raw = "";
  else raw = await new Response(init.body).text();
  const type = headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {};
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { _: parsed };
    } catch {
      return { _raw: raw };
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function toResponse(result: Response | object): Response {
  if (result instanceof Response) return result;
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function installFakeSlack(handlers: Partial<Record<SlackMethod, FakeSlackHandler>>): { calls: FakeSlackCall[]; restore(): void } {
  const calls: FakeSlackCall[] = [];
  const unexpected: string[] = [];
  const previous = globalThis.fetch;
  let restored = false;

  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const parsed = new URL(url);
    const method = url.startsWith(SLACK_API) ? parsed.pathname.slice("/api/".length) : null;
    const handler = method !== null && METHODS.has(method) ? handlers[method as SlackMethod] : undefined;
    if (method === null || handler === undefined) {
      // Never the URL itself (a query string could carry a token): the host and the method are enough to find the test bug.
      unexpected.push(method === null ? `a fetch to ${parsed.host}` : `Slack method ${method} (no handler)`);
      throw new TypeError("fetch failed");
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const recordedHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      recordedHeaders[key] = value;
    });
    const body = await bodyOf(input, init, headers);
    calls.push({ method: method as SlackMethod, headers: recordedHeaders, body });
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(abortError(signal as AbortSignal));
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => handler(body, headers))
        .then(
          (result) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(toResponse(result));
          },
          (err: unknown) => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          }
        );
    });
  };

  vi.stubGlobal("fetch", fake);
  const restore = (): void => {
    if (restored) return;
    restored = true;
    vi.stubGlobal("fetch", previous);
    if (unexpected.length > 0) {
      const list = [...unexpected];
      unexpected.length = 0;
      throw new Error(`fake-slack-api: unexpected call(s): ${list.join("; ")}`);
    }
  };
  try {
    onTestFinished(() => restore());
  } catch {
    // Installed outside a running test (a beforeAll): the caller restores it.
  }
  return { calls, restore };
}

/** Response shapes recorded from Slack's docs (PLAT §3, §6, §7), with the ids of ROUTING_INSTALLATION. Each call returns a
 *  fresh object, so a test may change it. Tokens here are fakes in Slack's format; the sentinels live in slack-assert.ts. */
export const SLACK_RECORDED = Object.freeze({
  /** oauth.v2.access for a bot-only install (the OAV example with the six bot scopes, no rotation). */
  oauthAccess: () => ({
    ok: true,
    // Not the docs' example token: a value no secret scanner reads as a live Slack token.
    access_token: "xoxb-FAKE-recorded-bot-token",
    token_type: "bot",
    scope: "chat:write,im:history,im:read,im:write,users:read,users:read.email",
    bot_user_id: "U0BOT",
    app_id: "A0EXEC",
    team: { name: "ScaledAI", id: "T0SCALED" },
    enterprise: null,
    is_enterprise_install: false,
    authed_user: { id: "U0MITCH" }
  }),
  authTest: () => ({
    ok: true,
    url: "https://scaledai.slack.com/",
    team: "ScaledAI",
    user: "exec-assistant",
    team_id: "T0SCALED",
    user_id: "U0BOT",
    bot_id: "B0BOT",
    is_enterprise_install: false
  }),
  lookupByEmail: () => ({
    ok: true,
    user: { id: "U0MITCH", team_id: "T0SCALED", name: "mitchell", deleted: false, is_bot: false, is_app_user: false, is_restricted: false, is_ultra_restricted: false }
  }),
  conversationsOpen: () => ({ ok: true, channel: { id: "D0MITCH" } }),
  postMessage: (ts = "1793977201.000100") => ({
    ok: true,
    channel: "D0MITCH",
    ts,
    message: { type: "message", subtype: "bot_message", bot_id: "B0BOT", ts }
  }),
  update: (ts = "1793977201.000100") => ({ ok: true, channel: "D0MITCH", ts }),
  delete: (ts = "1793977201.000100") => ({ ok: true, channel: "D0MITCH", ts }),
  viewsPublish: () => ({ ok: true, view: { id: "V0HOME", type: "home" } }),
  revoke: () => ({ ok: true, revoked: true }),
  error: (code: string) => ({ ok: false, error: code })
});

// --- P7a (§5.15; Area B): the seven reads, their recorded shapes, and per-call error injection ---------------------------
//
// Shapes from p7/slackdocs (conversations.list / users.conversations / conversations.info: the CL / UC / CI examples, with
// is_member, is_ext_shared, is_pending_ext_shared and IM rows carrying `user`; conversations.history / replies: CH / CR,
// pages with has_more + response_metadata.next_cursor; chat.getPermalink: the GP examples; users.info: the UI example).
// users.list and bots.info aren't in slackdocs: their shapes follow Slack's method pages (members[] of user objects;
// { ok, bot: { id, deleted, name, updated, app_id, user_id, icons } }). Ids are ROUTING_INSTALLATION's (team T0SCALED, him
// U0MITCH, the assistant DM D0MITCH, its bot U0BOT / B0BOT) plus the DD bot (U0DDBOT / B0DDBOT / A0DDAPP).
//
//   installFakeSlack({ "conversations.list": slackSequence(SLACK_READ_RECORDED.conversationsListPage1(), slackRateLimitedAfter(7)) });

/** One recorded answer per call, in order; the last one repeats. A plain object is copied per call and a handler is called per
 *  call; a Response is handed over as is, so it answers once (pass a handler, like slackRateLimitedAfter, to repeat one: a cloned
 *  Response's body would keep P6's discardBody waiting on the other branch of the tee). */
export function slackSequence(...answers: (Response | object | FakeSlackHandler)[]): FakeSlackHandler {
  if (answers.length === 0) throw new Error("slackSequence: at least one answer");
  let i = 0;
  return (body, headers) => {
    const answer = answers[Math.min(i, answers.length - 1)];
    i++;
    if (typeof answer === "function") return (answer as FakeSlackHandler)(body, headers);
    return answer instanceof Response ? answer : structuredClone(answer);
  };
}

/** A handler answering HTTP 429 with Retry-After (seconds), Slack's rate-limit answer; a fresh Response per call. */
export function slackRateLimitedAfter(retryAfterSec = 30): FakeSlackHandler {
  return () => new Response("", { status: 429, headers: { "retry-after": String(retryAfterSec) } });
}

/** { ok: false, error } for the codes the reads must handle: not_in_channel, channel_not_found, invalid_auth, missing_scope,
 *  invalid_types, ratelimited (as an ok:false body), thread_not_found, user_not_found, bot_not_found, message_not_found. */
export const slackReadError = (code: string): { ok: false; error: string } => ({ ok: false, error: code });

/** A Slack message as conversations.history / replies return it (the CH / CR shape); `extra` overrides or adds fields. */
export function slackHistoryMessage(ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "message", user: "U0JANE", text: "SENTINEL-SLACK-TEXT-7f3a", ts, team: "T0SCALED", ...extra };
}

export const SLACK_READ_RECORDED = Object.freeze({
  /** conversations.list, first page: a public channel he is in, a public one he isn't, a private channel, a Slack Connect
   *  channel, a pending share, an MPIM, two IMs (a colleague, a deleted user), and a malformed name; next_cursor set. */
  conversationsListPage1: () => ({
    ok: true,
    channels: [
      { id: "C0GENERAL", name: "general", is_channel: true, is_group: false, is_im: false, created: 1449252889, creator: "U0JANE",
        is_archived: false, is_general: true, unlinked: 0, name_normalized: "general", is_shared: false, is_ext_shared: false,
        is_org_shared: false, pending_shared: [], is_pending_ext_shared: false, is_member: true, is_private: false, is_mpim: false,
        updated: 1678229664302, topic: { value: "SENTINEL-TOPIC-7f3a", creator: "", last_set: 0 },
        purpose: { value: "SENTINEL-TOPIC-7f3a", creator: "", last_set: 0 }, previous_names: [], num_members: 4 },
      { id: "C0RANDOM", name: "random-public", is_channel: true, is_group: false, is_im: false, created: 1449252889, creator: "U0JANE",
        is_archived: false, is_general: false, unlinked: 0, name_normalized: "random-public", is_shared: false, is_ext_shared: false,
        is_org_shared: false, pending_shared: [], is_pending_ext_shared: false, is_member: false, is_private: false, is_mpim: false,
        updated: 1678229664302, topic: { value: "SENTINEL-TOPIC-7f3a", creator: "", last_set: 0 },
        purpose: { value: "", creator: "", last_set: 0 }, previous_names: [], num_members: 9 },
      { id: "G0PRIV", name: "private-ops", is_channel: false, is_group: true, is_im: false, created: 1449252889, creator: "U0JANE",
        is_archived: false, is_general: false, unlinked: 0, name_normalized: "private-ops", is_shared: false, is_ext_shared: false,
        is_org_shared: false, pending_shared: [], is_pending_ext_shared: false, is_member: true, is_private: true, is_mpim: false,
        updated: 1678229664302, topic: { value: "SENTINEL-TOPIC-7f3a", creator: "", last_set: 0 },
        purpose: { value: "", creator: "", last_set: 0 }, previous_names: [] },
      { id: "C0SHARED", name: "partner-collab", is_channel: true, is_group: false, is_im: false, created: 1449252889, creator: "U0JANE",
        is_archived: false, is_general: false, unlinked: 0, name_normalized: "partner-collab", is_shared: true, is_ext_shared: true,
        is_org_shared: false, pending_shared: [], is_pending_ext_shared: false, is_member: true, is_private: false, is_mpim: false,
        updated: 1678229664302, topic: { value: "SENTINEL-TOPIC-7f3a", creator: "", last_set: 0 },
        purpose: { value: "", creator: "", last_set: 0 }, previous_names: [] },
      { id: "C0PENDING", name: "partner-pending", is_channel: true, is_group: false, is_im: false, created: 1449252889, creator: "U0JANE",
        is_archived: false, is_general: false, unlinked: 0, name_normalized: "partner-pending", is_shared: false, is_ext_shared: false,
        is_org_shared: false, pending_shared: ["T0PARTNER"], is_pending_ext_shared: true, is_member: true, is_private: false, is_mpim: false,
        updated: 1678229664302, topic: { value: "", creator: "", last_set: 0 }, purpose: { value: "", creator: "", last_set: 0 },
        previous_names: [] },
      { id: "G0MPIM", name: "mpdm-mitchell--jane--bob-1", is_channel: false, is_group: true, is_im: false, created: 1493657761,
        creator: "U0JANE", is_archived: false, is_general: false, unlinked: 0, name_normalized: "mpdm-mitchell--jane--bob-1",
        is_shared: false, is_ext_shared: false, is_org_shared: false, pending_shared: [], is_pending_ext_shared: false,
        is_member: true, is_private: true, is_mpim: true, is_open: true, updated: 1678229664302,
        topic: { value: "Group messaging", creator: "U0JANE", last_set: 1493657761 },
        purpose: { value: "SENTINEL-TOPIC-7f3a", creator: "U0JANE", last_set: 1493657761 }, priority: 0 },
      { id: "D0JANE", created: 1498500348, is_im: true, is_org_shared: false, user: "U0JANE", is_user_deleted: false, priority: 0 },
      { id: "D0GONE", created: 1498511030, is_im: true, is_org_shared: false, user: "U0GONE", is_user_deleted: true, priority: 0 },
      { id: "C0BADNAME", name: "Bad Name!", is_channel: true, is_group: false, is_im: false, is_archived: false, is_ext_shared: false,
        is_pending_ext_shared: false, is_member: true, is_private: false, is_mpim: false }
    ],
    response_metadata: { next_cursor: "dGVhbTpDMDYxRkE1UEI=" }
  }),
  /** conversations.list, last page: an archived channel and the assistant DM; next_cursor "". */
  conversationsListPage2: () => ({
    ok: true,
    channels: [
      { id: "C0OLD", name: "old-project", is_channel: true, is_group: false, is_im: false, is_archived: true, is_ext_shared: false,
        is_pending_ext_shared: false, is_member: true, is_private: false, is_mpim: false },
      { id: "D0MITCH", created: 1498500348, is_im: true, is_org_shared: false, user: "U0BOT", is_user_deleted: false, priority: 0 }
    ],
    response_metadata: { next_cursor: "" }
  }),
  /** users.conversations: the conversations he is a member of (UC shape; ids are all that is kept). */
  usersConversations: () => ({
    ok: true,
    channels: [
      { id: "C0GENERAL", name: "general", is_channel: true, is_group: false, is_im: false, is_archived: false, is_ext_shared: false,
        is_private: false, is_mpim: false, topic: { value: "SENTINEL-TOPIC-7f3a", creator: "", last_set: 0 } },
      { id: "G0PRIV", name: "private-ops", is_channel: false, is_group: true, is_im: false, is_private: true, is_mpim: false },
      { id: "D0JANE", created: 1498500348, is_im: true, user: "U0JANE", is_user_deleted: false, priority: 0 }
    ],
    response_metadata: { next_cursor: "" }
  }),
  /** conversations.info for a public channel (CI's first example, with our ids). */
  conversationsInfoChannel: () => ({
    ok: true,
    channel: { id: "C0GENERAL", name: "general", is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false,
      created: 1654868334, is_archived: false, is_general: true, unlinked: 0, name_normalized: "general", is_shared: false,
      is_frozen: false, is_org_shared: false, is_pending_ext_shared: false, pending_shared: [], context_team_id: "T0SCALED",
      updated: 1723130875818, parent_conversation: null, creator: "U0JANE", is_ext_shared: false, shared_team_ids: ["T0SCALED"],
      pending_connected_team_ids: [], topic: { value: "SENTINEL-TOPIC-7f3a", creator: "U0JANE", last_set: 1449709364 },
      purpose: { value: "SENTINEL-TOPIC-7f3a", creator: "U0JANE", last_set: 1449709364 }, previous_names: [], is_member: true }
  }),
  /** conversations.info for an IM (CI's IM example, with our ids; `latest` carries text that must never leave). */
  conversationsInfoIm: () => ({
    ok: true,
    channel: { id: "D0JANE", created: 1507235627, is_im: true, is_org_shared: false, user: "U0JANE", last_read: "1513718191.000038",
      latest: { type: "message", user: "U0JANE", text: "SENTINEL-SLACK-TEXT-7f3a", ts: "1513718191.000038" }, unread_count: 0,
      unread_count_display: 0, is_open: true, locale: "en-US", priority: 0.043016851216706 }
  }),
  /** users.list: a human (with every profile field a sentinel), a bot, a deleted bot, Slackbot; next_cursor "". */
  usersList: () => ({
    ok: true,
    members: [
      { id: "U0JANE", team_id: "T0SCALED", name: "jane", deleted: false, real_name: "Sentinel Slackauthor", is_bot: false, is_app_user: false,
        profile: { real_name: "Sentinel Slackauthor", display_name: "Sentinel Slackauthor", email: "jane@scaledai.org", title: "SENTINEL-TOPIC-7f3a" } },
      { id: "U0ZAP", team_id: "T0SCALED", name: "zapier", deleted: false, is_bot: true, is_app_user: false,
        profile: { real_name: "Zapier", bot_id: "B0ZAP", api_app_id: "A0ZAP" } },
      { id: "U0OLDBOT", team_id: "T0SCALED", name: "oldbot", deleted: true, is_bot: true, is_app_user: false, profile: { real_name: "Old bot" } },
      { id: "USLACKBOT", team_id: "T0SCALED", name: "slackbot", deleted: false, is_bot: false, is_app_user: false, profile: { real_name: "Slackbot" } }
    ],
    cache_ts: 1498777272,
    response_metadata: { next_cursor: "" }
  }),
  /** users.info (UI's example, with our ids; the label fields hold the author sentinel). */
  usersInfo: (id = "U0JANE", teamId = "T0SCALED") => ({
    ok: true,
    user: { id, team_id: teamId, name: "jane", deleted: false, color: "9f69e7", real_name: "Sentinel Slackauthor", tz: "America/New_York",
      tz_label: "Eastern Standard Time", tz_offset: -18000,
      profile: { avatar_hash: "ge3b51ca72de", status_text: "SENTINEL-TOPIC-7f3a", status_emoji: ":books:", real_name: "Sentinel Slackauthor",
        display_name: "Sentinel Slackauthor", real_name_normalized: "Sentinel Slackauthor", display_name_normalized: "Sentinel Slackauthor",
        email: "jane@scaledai.org", team: teamId },
      is_admin: false, is_owner: false, is_primary_owner: false, is_restricted: false, is_ultra_restricted: false, is_bot: false,
      updated: 1502138686, is_app_user: false, has_2fa: false }
  }),
  /** conversations.history page (CH shape, newest first). */
  history: (messages: readonly Record<string, unknown>[], opts: { hasMore?: boolean; nextCursor?: string } = {}) => ({
    ok: true,
    messages: messages.map((m) => structuredClone(m)),
    has_more: opts.hasMore === true,
    pin_count: 0,
    response_metadata: { next_cursor: opts.nextCursor ?? "" }
  }),
  /** conversations.replies page (CR shape, parent first). */
  replies: (messages: readonly Record<string, unknown>[], opts: { hasMore?: boolean; nextCursor?: string } = {}) => ({
    ok: true,
    messages: messages.map((m) => structuredClone(m)),
    has_more: opts.hasMore === true,
    response_metadata: { next_cursor: opts.nextCursor ?? "" }
  }),
  /** chat.getPermalink (GP's two examples: a top-level message and a reply). */
  permalink: (channel = "C0GENERAL", reply = false) => ({
    ok: true,
    channel,
    permalink: reply
      ? `https://scaledai.slack.com/archives/${channel}/p1794150001000101?thread_ts=1794150000.000100&cid=${channel}`
      : `https://scaledai.slack.com/archives/${channel}/p1794150001000101`
  }),
  /** bots.info for the DD bot (with its app id and bot user). */
  botsInfo: (botId = "B0DDBOT", appId: string | null = "A0DDAPP", userId: string | null = "U0DDBOT") => ({
    ok: true,
    bot: { id: botId, deleted: false, name: "Scaled Operations", updated: 1449272004, app_id: appId, user_id: userId,
      icons: { image_36: "https://a.slack-edge.com/x36.png", image_48: "https://a.slack-edge.com/x48.png", image_72: "https://a.slack-edge.com/x72.png" } }
  }),
  /** auth.test with the DD bot's token (DD's own app, not the assistant's). */
  ddBotAuthTest: (teamId = "T0SCALED") => ({
    ok: true, url: "https://scaledai.slack.com/", team: "ScaledAI", user: "scaled-operations", team_id: teamId, user_id: "U0DDBOT",
    bot_id: "B0DDBOT", is_enterprise_install: false
  })
});

// --- P8 (§5.19; Area D): a stateful workspace for the brief's DMs ------------------------------------------------------------
//
// Handlers that keep the messages they were sent, keyed by the bearer token that sent them:
//   * chat.postMessage records { channel, ts, token, text, blocks, metadata } and answers its ts; chat.update / chat.delete
//     act only on a message that token posted (message_not_found otherwise, and once deleted);
//   * conversations.history answers the channel's messages (newest first, ts >= oldest when inclusive) with their metadata
//     only when include_all_metadata=true, as Slack does, paged by `limit` with a next_cursor;
//   * conversations.open answers the IM between the token's user and `users` (a stable D... id per pair);
//   * auth.test answers per token; users.lookupByEmail answers the seeded users with the guest flags;
//   * failNext(method, failure) queues one answer: "pass" (run normally), our timeout (a hung call), a network drop, HTTP 503, a rate limit with
//     Retry-After, a Slack error code, or "posted but ..." (the message is stored, then the call fails), for DL04-DL06.
//
//   const ws = fakeSlackWorkspace({ tokens: { [BOT]: { userId: "U0BOT", teamId: "T0SCALED", botId: "B0BOT" } } });
//   const slack = installFakeSlack(ws.handlers);

export interface FakeSlackStoredMessage {
  channel: string; ts: string; token: string; text: unknown; blocks: unknown; metadata: Record<string, unknown> | null; deleted: boolean; updates: number;
}
export type FakeSlackFailure =
  | "pass" | "timeout" | "network" | "http_503" | "posted_timeout" | "posted_network" | "posted_503"
  | { ratelimited: number } | { error: string };
export interface FakeSlackIdentity { userId: string; teamId: string; botId?: string | null }
export interface FakeSlackUser { id: string; teamId?: string; deleted?: boolean; isBot?: boolean; isRestricted?: boolean; isUltraRestricted?: boolean }
export interface FakeSlackWorkspace {
  handlers: Partial<Record<SlackMethod, FakeSlackHandler>>;
  messages: FakeSlackStoredMessage[];
  /** Per token: auth.test's answer, or a Slack error code. Mutable. */
  tokens: Map<string, FakeSlackIdentity | { error: string }>;
  /** By e-mail address (lower-cased). Mutable. */
  users: Map<string, FakeSlackUser>;
  failNext(method: SlackMethod, failure: FakeSlackFailure): void;
  /** The IM conversations.open answers for (token, user). */
  imFor(token: string, userId: string): string;
  /** Messages stored in a channel (deleted ones included). */
  inChannel(channel: string): FakeSlackStoredMessage[];
}

const bearerOf = (headers: Headers): string => (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

export function fakeSlackWorkspace(seed: { tokens?: Record<string, FakeSlackIdentity | { error: string }>; users?: Record<string, FakeSlackUser>;
  ims?: Record<string, string>; firstTs?: number } = {}): FakeSlackWorkspace {
  const messages: FakeSlackStoredMessage[] = [];
  const tokens = new Map(Object.entries(seed.tokens ?? {}));
  const users = new Map(Object.entries(seed.users ?? {}).map(([email, u]) => [email.toLowerCase(), u] as const));
  const ims = new Map(Object.entries(seed.ims ?? {}));
  const failures = new Map<string, FakeSlackFailure[]>();
  let seq = 0;
  /** Slack-like ts values at the (possibly faked) current time, strictly increasing. */
  const nextTs = () => `${seed.firstTs ?? Math.floor(Date.now() / 1000)}.${String(100 + ++seq).padStart(6, "0")}`;
  const imFor = (token: string, userId: string): string => {
    const key = `${token}|${userId}`;
    let id = ims.get(key);
    if (!id) {
      id = `D0IM${String(ims.size + 1).padStart(3, "0")}`;
      ims.set(key, id);
    }
    return id;
  };
  const error = (code: string) => ({ ok: false, error: code });
  const hang = (): Promise<never> => new Promise<never>(() => undefined);
  /** The injected failure for this call, if any: a Response, a thrown TypeError, a hang, or null (run normally). */
  const injected = (method: SlackMethod, store: () => void): Promise<Response | object> | Response | object | null => {
    const queue = failures.get(method);
    const f = queue?.shift();
    if (f === undefined || f === "pass") return null;
    if (typeof f === "object" && "ratelimited" in f) return new Response("", { status: 429, headers: { "retry-after": String(f.ratelimited) } });
    if (typeof f === "object" && "error" in f) return error(f.error);
    if (f.startsWith("posted_")) store();
    if (f === "timeout" || f === "posted_timeout") return hang();
    if (f === "http_503" || f === "posted_503") return new Response("", { status: 503 });
    throw new TypeError("fetch failed");
  };
  const tokenError = (headers: Headers): string | null => {
    const id = tokens.get(bearerOf(headers));
    if (id === undefined) return "invalid_auth";
    return "error" in id ? id.error : null;
  };

  const handlers: Partial<Record<SlackMethod, FakeSlackHandler>> = {
    "auth.test": (_body, headers) => {
      const failure = injected("auth.test", () => undefined);
      if (failure !== null) return failure;
      const bad = tokenError(headers);
      if (bad !== null) return error(bad);
      const id = tokens.get(bearerOf(headers)) as FakeSlackIdentity;
      return { ok: true, url: "https://scaledai.slack.com/", team: "ScaledAI", user: "someone", team_id: id.teamId, user_id: id.userId,
        ...(id.botId ? { bot_id: id.botId } : {}), is_enterprise_install: false };
    },
    "users.lookupByEmail": (body, headers) => {
      const failure = injected("users.lookupByEmail", () => undefined);
      if (failure !== null) return failure;
      const bad = tokenError(headers);
      if (bad !== null) return error(bad);
      const u = users.get(String(body.email ?? "").toLowerCase());
      if (!u) return error("users_not_found");
      return { ok: true, user: { id: u.id, team_id: u.teamId ?? "T0SCALED", name: "member", deleted: u.deleted === true, is_bot: u.isBot === true,
        is_app_user: false, is_restricted: u.isRestricted === true, is_ultra_restricted: u.isUltraRestricted === true } };
    },
    "conversations.open": (body, headers) => {
      const failure = injected("conversations.open", () => undefined);
      if (failure !== null) return failure;
      const bad = tokenError(headers);
      if (bad !== null) return error(bad);
      return { ok: true, channel: { id: imFor(bearerOf(headers), String(body.users ?? "")) } };
    },
    "chat.postMessage": (body, headers) => {
      const token = bearerOf(headers);
      const ts = nextTs();
      const store = () => {
        messages.push({ channel: String(body.channel), ts, token, text: body.text, blocks: body.blocks,
          metadata: body.metadata && typeof body.metadata === "object" ? structuredClone(body.metadata as Record<string, unknown>) : null, deleted: false, updates: 0 });
      };
      const failure = injected("chat.postMessage", store);
      if (failure !== null) return failure;
      const bad = tokenError(headers);
      if (bad !== null) return error(bad);
      store();
      return { ok: true, channel: body.channel, ts, message: { type: "message", ts, text: body.text } };
    },
    "chat.update": (body, headers) => {
      const failure = injected("chat.update", () => undefined);
      if (failure !== null) return failure;
      const bad = tokenError(headers);
      if (bad !== null) return error(bad);
      const m = messages.find((x) => x.channel === body.channel && x.ts === body.ts && x.token === bearerOf(headers) && !x.deleted);
      if (!m) return error("message_not_found");
      m.text = body.text;
      m.blocks = body.blocks;
      m.updates += 1;
      return { ok: true, channel: body.channel, ts: body.ts };
    },
    "chat.delete": (body, headers) => {
      const failure = injected("chat.delete", () => undefined);
      if (failure !== null) return failure;
      const bad = tokenError(headers);
      if (bad !== null) return error(bad);
      const m = messages.find((x) => x.channel === body.channel && x.ts === body.ts && x.token === bearerOf(headers) && !x.deleted);
      if (!m) return error("message_not_found");
      m.deleted = true;
      return { ok: true, channel: body.channel, ts: body.ts };
    },
    "conversations.history": (body, headers) => {
      const failure = injected("conversations.history", () => undefined);
      if (failure !== null) return failure;
      const bad = tokenError(headers);
      if (bad !== null) return error(bad);
      const withMeta = body.include_all_metadata === "true";
      const oldest = typeof body.oldest === "string" ? Number(body.oldest) : 0;
      const inclusive = body.inclusive === "true";
      const rows = messages.filter((m) => m.channel === body.channel && !m.deleted && (inclusive ? Number(m.ts) >= oldest : Number(m.ts) > oldest))
        .sort((a, b) => Number(b.ts) - Number(a.ts));
      const limit = Math.max(1, Number(body.limit ?? 100));
      const start = typeof body.cursor === "string" && /^[0-9]+$/.test(body.cursor) ? Number(body.cursor) : 0;
      const page = rows.slice(start, start + limit);
      const more = start + limit < rows.length;
      return {
        ok: true,
        messages: page.map((m) => ({ type: "message", ts: m.ts, text: m.text, ...(withMeta && m.metadata ? { metadata: structuredClone(m.metadata) } : {}) })),
        has_more: more,
        response_metadata: { next_cursor: more ? String(start + limit) : "" }
      };
    }
  };

  return {
    handlers, messages, tokens, users, imFor,
    failNext(method, failure) {
      const q = failures.get(method) ?? [];
      q.push(failure);
      failures.set(method, q);
    },
    inChannel: (channel) => messages.filter((m) => m.channel === channel)
  };
}
