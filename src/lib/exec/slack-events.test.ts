import { afterEach, describe, expect, it, vi } from "vitest";

import { SENTINELS } from "@/lib/exec/__tests__/slack-assert";
import { impliedFacts, routingRow, routingRows } from "@/lib/exec/__tests__/slack-route-helpers";
import { parseActionPayload, parseEventEnvelope } from "@/lib/exec/slack-events";

// P6 contract §3.9 (Area C): the envelope and interaction parsers. The routing rule
// itself is SQL's (C4); these tests pin the facts the parsers hand RPC 1 and RPC 2,
// row by row over the shared routing fixture (RT-V's parse half; the route half is
// in slack-routes-events.test.ts), EV16 (text is never read through [[Get]]) and
// the parse half of IA06 (response_url, message, view and state are never read).

type Row = Record<string, unknown>;
const ROWS = routingRows();
const row = (n: number) => routingRow(n);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseEventEnvelope: url_verification", () => {
  it("returns the challenge for printable ASCII of 1..200 characters", () => {
    expect(parseEventEnvelope({ type: "url_verification", token: "x", challenge: SENTINELS.challenge }, null)).toEqual({
      kind: "url_verification",
      challenge: SENTINELS.challenge
    });
    expect(parseEventEnvelope({ type: "url_verification", challenge: "!".repeat(200) }, null)).toMatchObject({ kind: "url_verification" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["201 characters", "a".repeat(201)],
    ["a space", "abc def"],
    ["a control character", `abc${String.fromCodePoint(0x7f)}`],
    ["non-ASCII", "café"],
    ["a number", 42]
  ])("a challenge that is %s → invalid", (_label, challenge) => {
    expect(parseEventEnvelope({ type: "url_verification", challenge }, null)).toEqual({ kind: "invalid" });
  });
});

describe("parseEventEnvelope: envelopes", () => {
  it.each([
    ["null", null],
    ["an array", [1, 2]],
    ["a string", "event_callback"],
    ["no type", { event_id: "Ev01ABC" }],
    ["a numeric type", { type: 5 }]
  ])("%s → invalid", (_label, json) => {
    expect(parseEventEnvelope(json, null)).toEqual({ kind: "invalid" });
  });

  it("another envelope type → other with its type code; an odd type is reported as unknown", () => {
    expect(parseEventEnvelope(row(30).envelope, null)).toEqual({ kind: "other", type: "app_rate_limited" });
    expect(parseEventEnvelope({ type: "Weird Type <x>" }, null)).toEqual({ kind: "other", type: "unknown" });
  });

  const base = () => row(1).envelope;
  it.each<[string, (env: Row) => void]>([
    ["a malformed event_id", (env) => (env.event_id = "evil id")],
    ["a missing event_id", (env) => delete env.event_id],
    ["a numeric team_id", (env) => (env.team_id = 5)],
    ["a missing api_app_id", (env) => delete env.api_app_id],
    ["an array event", (env) => (env.event = [])],
    ["a null event", (env) => (env.event = null)],
    ["an event without a type", (env) => delete (env.event as Row).type],
    ["a string event_time", (env) => (env.event_time = "1793977201")],
    ["a fractional event_time", (env) => (env.event_time = 1793977201.5)],
    ["a zero event_time", (env) => (env.event_time = 0)],
    ["an event_time past 2100", (env) => (env.event_time = 4102444801)]
  ])("event_callback with %s → invalid", (_label, mutate) => {
    const env = base();
    mutate(env);
    expect(parseEventEnvelope(env, null)).toEqual({ kind: "invalid" });
  });

  it("retryNum comes from x-slack-retry-num: 0..100, else 0", () => {
    const facts = (h: string | null) => {
      const p = parseEventEnvelope(base(), h);
      if (p.kind !== "event_callback") throw new Error("expected event_callback");
      return p.facts.retryNum;
    };
    expect(facts(null)).toBe(0);
    expect(facts("1")).toBe(1);
    expect(facts(" 3 ")).toBe(3);
    expect(facts("100")).toBe(100);
    expect(facts("101")).toBe(0);
    expect(facts("-1")).toBe(0);
    expect(facts("2.5")).toBe(0);
    expect(facts("abc")).toBe(0);
  });

  it("subtype: a string as given, present but not a string → unknown, absent → null", () => {
    const sub = (v: unknown, present = true) => {
      const env = base();
      if (present) (env.event as Row).subtype = v;
      const p = parseEventEnvelope(env, null);
      if (p.kind !== "event_callback") throw new Error("expected event_callback");
      return p.facts.subtype;
    };
    expect(sub("file_share")).toBe("file_share");
    expect(sub("")).toBe("");
    expect(sub(null)).toBe("unknown");
    expect(sub(7)).toBe("unknown");
    expect(sub(undefined, false)).toBeNull();
  });

  it("tokens_revoked id lists: only Slack user ids, at most 50 each", () => {
    const env = row(26).envelope;
    const many = Array.from({ length: 60 }, (_, i) => `U0X${String(i).padStart(3, "0")}`);
    (env.event as Row).tokens = { bot: ["U0BOT", "not an id", 5, "u0lower", "W0WORK"], oauth: many };
    const p = parseEventEnvelope(env, null);
    if (p.kind !== "event_callback") throw new Error("expected event_callback");
    expect(p.facts.revokedBotIds).toEqual(["U0BOT", "W0WORK"]);
    expect(p.facts.revokedUserIds).toEqual(many.slice(0, 50));
    (env.event as Row).tokens = "nope";
    const q = parseEventEnvelope(env, null);
    if (q.kind !== "event_callback") throw new Error("expected event_callback");
    expect([q.facts.revokedBotIds, q.facts.revokedUserIds]).toEqual([[], []]);
  });

  it("strings only: a numeric channel, user, ts or thread_ts becomes null; hidden must be exactly true", () => {
    const env = base();
    Object.assign(env.event as Row, { channel: 1, user: ["U0MITCH"], ts: 17, thread_ts: {}, channel_type: null, hidden: "true", tab: 3 });
    const p = parseEventEnvelope(env, null);
    if (p.kind !== "event_callback") throw new Error("expected event_callback");
    expect(p.facts).toMatchObject({ channel: null, user: null, ts: null, threadTs: null, channelType: null, hidden: false, tab: null });
  });
});

describe("RT-V (parse half): every fixture row's facts", () => {
  it("the fixture is the shared one (35 rows)", () => {
    expect(ROWS).toHaveLength(35);
  });

  for (const r of ROWS) {
    it(`RT-V facts ${r.name}`, () => {
      const parsed = parseEventEnvelope(r.envelope, "2");
      if (r.expect.routeLevel === "other_type") {
        expect(parsed.kind).toBe("other");
        return;
      }
      expect(parsed.kind).toBe("event_callback");
      if (parsed.kind !== "event_callback") return;
      expect(parsed.facts).toEqual(impliedFacts(r.envelope, 2));
      expect(Object.keys(parsed.facts).sort()).toEqual(Object.keys(impliedFacts(r.envelope)).sort());
    });
  }

  it("the booleans the rule turns on, pinned on the rows that exercise them", () => {
    const f = (n: number) => {
      const p = parseEventEnvelope(row(n).envelope, null);
      if (p.kind !== "event_callback") throw new Error(`row ${n} did not parse`);
      return p.facts;
    };
    expect(f(1)).toMatchObject({ user: "U0MITCH", channel: "D0MITCH", channelType: "im", hasBotId: false, hasAppId: false, subtype: null, hidden: false, textIsString: true, hasMessage: false, threadTs: null });
    expect(f(2).threadTs).toBe("1793977200.000100");
    expect(f(5)).toMatchObject({ user: "U0BOT", hasBotId: true, hasAppId: true });
    expect(f(6)).toMatchObject({ user: "U0MITCH", hasBotId: true, hasAppId: false });
    expect(f(7)).toMatchObject({ hasBotId: false, hasAppId: true });
    expect(f(8)).toMatchObject({ user: null, subtype: "message_changed", hidden: true, hasMessage: true });
    expect(f(10)).toMatchObject({ user: null, subtype: null, hidden: true, hasMessage: true });
    expect(f(11)).toMatchObject({ user: "U0MITCH", hidden: true, hasMessage: true });
    expect(f(14).textIsString).toBe(false);
    expect(f(15)).toMatchObject({ hasMessage: true, hidden: false, subtype: null });
    expect(f(16).channelType).toBe("mpim");
    expect(f(21)).toMatchObject({ eventType: "app_home_opened", tab: "home", user: "U0MITCH" });
    expect(f(26)).toMatchObject({ eventType: "tokens_revoked", revokedBotIds: ["U0BOT"], revokedUserIds: [] });
    expect(f(27)).toMatchObject({ revokedBotIds: [], revokedUserIds: ["U0MITCH"] });
    expect(f(29).ts).toBe("1793977229");
  });
});

describe("EV16: event.text is never read through [[Get]] (build-11)", () => {
  const proxied = (event: Row) =>
    new Proxy(event, {
      get(target, key, receiver) {
        if (key === "text") throw new Error("event.text was read");
        return Reflect.get(target, key, receiver);
      }
    });

  it("parses through a Proxy whose get trap throws for text; textIsString comes from the descriptor", () => {
    const env = row(1).envelope;
    env.event = proxied(env.event as Row);
    const p = parseEventEnvelope(env, null);
    expect(p.kind).toBe("event_callback");
    if (p.kind === "event_callback") expect(p.facts.textIsString).toBe(true);
  });

  it("text absent → false; text: 5 → false; an accessor text (never invoked) → false", () => {
    const absent = row(14).envelope;
    absent.event = proxied(absent.event as Row);
    const a = parseEventEnvelope(absent, null);
    expect(a.kind === "event_callback" && a.facts.textIsString).toBe(false);

    const numeric = row(1).envelope;
    (numeric.event as Row).text = 5;
    numeric.event = proxied(numeric.event as Row);
    const n = parseEventEnvelope(numeric, null);
    expect(n.kind === "event_callback" && n.facts.textIsString).toBe(false);

    const accessor = row(1).envelope;
    const getter = vi.fn(() => "boom");
    delete (accessor.event as Row).text;
    Object.defineProperty(accessor.event, "text", { get: getter, enumerable: true, configurable: true });
    const g = parseEventEnvelope(accessor, null);
    expect(g.kind === "event_callback" && g.facts.textIsString).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it("the facts carry no text: a sentinel text in the event and its blocks appears nowhere in the result", () => {
    const env = row(1).envelope;
    (env.event as Row).text = SENTINELS.text;
    (env.event as Row).blocks = [{ type: "rich_text", elements: [{ type: "text", text: SENTINELS.text }] }];
    expect(JSON.stringify(parseEventEnvelope(env, null))).not.toContain("SENTINEL");
  });
});

// ---------------------------------------------------------------------------
// parseActionPayload

const ED = `ed_${"a".repeat(32)}`;
function blockActions(over: Row = {}): Row {
  return {
    type: "block_actions",
    api_app_id: "A0EXEC",
    team: { id: "T0SCALED", domain: "scaledai" },
    user: { id: "U0MITCH", username: SENTINELS.displayName, name: SENTINELS.displayName, team_id: "T0SCALED" },
    trigger_id: SENTINELS.triggerId,
    response_url: SENTINELS.responseUrl,
    container: { type: "message", message_ts: "1793977201.000100", channel_id: "D0MITCH", is_ephemeral: false },
    channel: { id: "D0MITCH", name: "directmessage" },
    message: { type: "message", text: SENTINELS.text, ts: "1793977201.000100" },
    state: { values: {} },
    actions: [{ action_id: "ea_draft_save", block_id: "draft", value: `d1.${ED}.3`, type: "button", action_ts: "1793977300.000001" }],
    ...over
  };
}
const form = (payload: unknown, extra = "") => `payload=${encodeURIComponent(JSON.stringify(payload))}${extra}`;

describe("parseActionPayload", () => {
  it("block_actions → the ids RPC 2 checks, nothing else", () => {
    const p = parseActionPayload(form(blockActions()));
    expect(p).toEqual({
      kind: "block_actions",
      linkOnly: false,
      facts: {
        teamId: "T0SCALED",
        apiAppId: "A0EXEC",
        userId: "U0MITCH",
        triggerId: SENTINELS.triggerId,
        actionId: "ea_draft_save",
        value: `d1.${ED}.3`,
        containerType: "message",
        channelId: "D0MITCH",
        messageTs: "1793977201.000100"
      }
    });
    const out = JSON.stringify(p);
    for (const s of [SENTINELS.responseUrl, SENTINELS.text, SENTINELS.displayName]) expect(out).not.toContain(s);
  });

  it("Open in DD (ea_open_dd, a URL button with no value) → linkOnly, value \"\"", () => {
    const p = parseActionPayload(form(blockActions({ actions: [{ action_id: "ea_open_dd", type: "button", url: "https://operations.scaledai.org/x" }] })));
    expect(p).toMatchObject({ kind: "block_actions", linkOnly: true, facts: { actionId: "ea_open_dd", value: "" } });
  });

  it("container ids that aren't strings → null (RPC 2 then ignores the action)", () => {
    const p = parseActionPayload(form(blockActions({ container: { type: "view", view_id: "V1" } })));
    expect(p).toMatchObject({ kind: "block_actions", facts: { containerType: "view", channelId: null, messageTs: null } });
  });

  it("another payload type → other", () => {
    expect(parseActionPayload(form({ type: "view_submission", view: {} }))).toEqual({ kind: "other", type: "view_submission" });
    expect(parseActionPayload(form({ type: "Odd Type" }))).toEqual({ kind: "other", type: "unknown" });
  });

  it.each<[string, string]>([
    ["no payload field", "foo=bar"],
    ["an empty body", ""],
    ["two payload fields", form(blockActions(), `&payload=${encodeURIComponent("{}")}`)],
    ["a payload that isn't JSON", "payload=%7Bnot-json"],
    ["a JSON array", form([1])],
    ["no type", form({ ...blockActions(), type: undefined })],
    ["no api_app_id", form(blockActions({ api_app_id: undefined }))],
    ["no team id", form(blockActions({ team: {} }))],
    ["no user", form(blockActions({ user: undefined }))],
    ["a numeric trigger id", form(blockActions({ trigger_id: 12345 }))],
    ["no container type", form(blockActions({ container: { channel_id: "D0MITCH" } }))],
    ["no actions", form(blockActions({ actions: [] }))],
    ["two actions", form(blockActions({ actions: [{ action_id: "ea_fb_up" }, { action_id: "ea_fb_down" }] }))],
    ["an action that isn't an object", form(blockActions({ actions: ["ea_fb_up"] }))],
    ["a numeric action_id", form(blockActions({ actions: [{ action_id: 1 }] }))],
    ["an empty action_id", form(blockActions({ actions: [{ action_id: "" }] }))],
    ["an action_id over 255", form(blockActions({ actions: [{ action_id: "a".repeat(256) }] }))],
    ["a numeric value", form(blockActions({ actions: [{ action_id: "ea_fb_up", value: 1 }] }))],
    ["a value over 2,000", form(blockActions({ actions: [{ action_id: "ea_fb_up", value: "v".repeat(2001) }] }))]
  ])("%s → invalid", (_label, body) => {
    expect(parseActionPayload(body)).toEqual({ kind: "invalid" });
  });

  it("IA06 (parse half): response_url, message, view and state are never read", () => {
    const reads = new Set<PropertyKey>();
    const record = (v: unknown): unknown => {
      if (typeof v !== "object" || v === null) return v;
      return new Proxy(v as object, {
        get(t, k, r) {
          reads.add(k);
          return record(Reflect.get(t, k, r));
        },
        has(t, k) {
          reads.add(k);
          return Reflect.has(t, k);
        },
        getOwnPropertyDescriptor(t, k) {
          reads.add(k);
          return Reflect.getOwnPropertyDescriptor(t, k);
        }
      });
    };
    const realParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((s: string) => record(realParse(s)));
    const p = parseActionPayload(form(blockActions({ view: { id: "V1" } })));
    expect(p.kind).toBe("block_actions");
    for (const k of ["response_url", "message", "view", "state", "channel"]) expect(reads.has(k), k).toBe(false);
    expect(reads.has("trigger_id")).toBe(true);
  });
});
