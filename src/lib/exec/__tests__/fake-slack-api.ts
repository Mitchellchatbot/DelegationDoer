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
  "conversations.replies", "chat.postMessage", "chat.update", "chat.delete", "views.publish"
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
    user: { id: "U0MITCH", team_id: "T0SCALED", name: "mitchell", deleted: false, is_bot: false, is_app_user: false }
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
