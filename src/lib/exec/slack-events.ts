import type { SlackActionFacts, SlackEventFacts } from "@/lib/exec/slack-types";
import { SLACK_RE } from "@/lib/exec/slack-types";

// P6: Events API envelope and interaction payload parsing into facts
// (contract §3.9; Area C; pure). The routing rule itself lives only in SQL
// (RPC 1, C4): this module extracts the facts the RPC decides on and nothing
// else. It never reads message text through [[Get]] (build-11): whether the
// event has a string `text` comes from its own-property descriptor, so no
// getter, proxy trap or later refactor can pull the text into a variable
// here. Interaction payloads are read for the ids the RPC checks only;
// message, view, state and response_url are never touched (C12).
//
// Both parsers are total: any input gives a ParsedEvent / ParsedAction, never a
// throw. The routes log the result kind and codes, never a value.

export type ParsedEvent =
  | { kind: "url_verification"; challenge: string }        // challenge: 1..200 printable ASCII (0x21–0x7E), else invalid
  | { kind: "event_callback"; facts: SlackEventFacts }
  | { kind: "other"; type: string }                        // app_rate_limited etc.
  | { kind: "invalid" };

export type ParsedAction =
  | { kind: "block_actions"; facts: SlackActionFacts; linkOnly: boolean }   // linkOnly: action_id "ea_open_dd" (a URL button)
  | { kind: "other"; type: string }
  | { kind: "invalid" };

type Obj = Record<string, unknown>;

const INVALID = Object.freeze({ kind: "invalid" as const });
const CHALLENGE_RE = /^[\x21-\x7e]{1,200}$/;
// An envelope / payload type as the routes may log it; anything else becomes "unknown".
const TYPE_CODE_RE = /^[a-z_.]{1,60}$/;
const RETRY_RE = /^[0-9]{1,3}$/;
const MAX_RETRY_NUM = 100;
const MAX_REVOKED_IDS = 50;
// RPC 1 refuses an event_time outside (0, 4102444800] (a raise, so a 500 Slack would retry): refuse it here as invalid.
const MAX_EVENT_TIME = 4_102_444_800;
const ACTION_ID_MAX = 255;
const ACTION_VALUE_MAX = 2_000;
const LINK_ACTION_ID = "ea_open_dd";

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const typeCode = (v: string): string => (TYPE_CODE_RE.test(v) ? v : "unknown");

/** x-slack-retry-num: 0..100, else 0. */
function retryNumOf(header: string | null): number {
  if (typeof header !== "string") return 0;
  const t = header.trim();
  if (!RETRY_RE.test(t)) return 0;
  const n = Number(t);
  return n <= MAX_RETRY_NUM ? n : 0;
}

/** tokens_revoked's id lists: strings matching SLACK_RE.user, at most 50. */
function userIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const id of v) {
    if (typeof id === "string" && SLACK_RE.user.test(id)) out.push(id);
    if (out.length >= MAX_REVOKED_IDS) break;
  }
  return out;
}

/** json = the parsed body. event_callback requires string event_id (SLACK_RE.eventId), team_id, api_app_id, an object event with a
 *  string type, and a numeric event_time; else invalid. Facts: channel/channelType/user/ts/threadTs only when strings; hasBotId =
 *  "bot_id" in event || "bot_profile" in event; hasAppId = "app_id" in event; subtype = string or (present but not a string → "unknown");
 *  hidden = event.hidden === true; textIsString from the own-property descriptor, never a property read (build-11):
 *  const d = Object.getOwnPropertyDescriptor(event, "text"); textIsString = d !== undefined && "value" in d && typeof d.value === "string"
 *  (JSON.parse output only has data properties, so this equals typeof event.text === "string" on real input); hasMessage = "message" in
 *  event || "previous_message" in event; tab = string or null; revokedBotIds / revokedUserIds = event.tokens.bot / .oauth filtered to
 *  SLACK_RE.user, ≤ 50 each; retryNum from the x-slack-retry-num header (0..100, else 0). Never reads event.text through [[Get]].
 *
 *  Beyond the frozen comment: event_time must be a safe integer in 1..4102444800 (the RPC's own bound), and an "other" type is
 *  reported as itself only when it is a plain type code (lowercase letters, "_" and "."), else as "unknown". */
export function parseEventEnvelope(json: unknown, retryNumHeader: string | null): ParsedEvent {
  if (!isObject(json)) return INVALID;
  const type = json.type;
  if (typeof type !== "string") return INVALID;

  if (type === "url_verification") {
    const challenge = json.challenge;
    return typeof challenge === "string" && CHALLENGE_RE.test(challenge) ? { kind: "url_verification", challenge } : INVALID;
  }
  if (type !== "event_callback") return { kind: "other", type: typeCode(type) };

  const eventId = json.event_id;
  const teamId = json.team_id;
  const apiAppId = json.api_app_id;
  const eventTime = json.event_time;
  const event = json.event;
  if (typeof eventId !== "string" || !SLACK_RE.eventId.test(eventId)) return INVALID;
  if (typeof teamId !== "string" || typeof apiAppId !== "string") return INVALID;
  if (typeof eventTime !== "number" || !Number.isSafeInteger(eventTime) || eventTime <= 0 || eventTime > MAX_EVENT_TIME) return INVALID;
  if (!isObject(event)) return INVALID;
  const eventType = event.type;
  if (typeof eventType !== "string") return INVALID;

  // build-11: the text's presence and type from its descriptor; the value is never read.
  const textDescriptor = Object.getOwnPropertyDescriptor(event, "text");
  const textIsString = textDescriptor !== undefined && "value" in textDescriptor && typeof textDescriptor.value === "string";

  let subtype: string | null = null;
  if ("subtype" in event) {
    const raw = event.subtype;
    subtype = typeof raw === "string" ? raw : "unknown";
  }
  const tokens = isObject(event.tokens) ? event.tokens : null;

  const facts: SlackEventFacts = {
    eventId,
    teamId,
    apiAppId,
    eventType,
    eventTime,
    retryNum: retryNumOf(retryNumHeader),
    channel: strOrNull(event.channel),
    channelType: strOrNull(event.channel_type),
    user: strOrNull(event.user),
    ts: strOrNull(event.ts),
    threadTs: strOrNull(event.thread_ts),
    hasBotId: "bot_id" in event || "bot_profile" in event,
    hasAppId: "app_id" in event,
    subtype,
    hidden: event.hidden === true,
    textIsString,
    hasMessage: "message" in event || "previous_message" in event,
    tab: strOrNull(event.tab),
    revokedBotIds: tokens ? userIds(tokens.bot) : [],
    revokedUserIds: tokens ? userIds(tokens.oauth) : []
  };
  return { kind: "event_callback", facts };
}

/** body = the raw form body (application/x-www-form-urlencoded); reads only `payload`, JSON.parse → block_actions requires
 *  api_app_id, team.id, user.id, trigger_id, container.type, exactly one actions[] entry with string action_id (≤ 255) and an optional
 *  string value (≤ 2,000). Never reads message, view, state or response_url.
 *
 *  Beyond the frozen comment: exactly one `payload` field (a repeated one is invalid); a missing value is "" (RPC 2 then ignores
 *  it as bad_value); container.channel_id / message_ts are null unless strings; action_id must be 1..255 characters. */
export function parseActionPayload(body: string): ParsedAction {
  if (typeof body !== "string") return INVALID;
  const fields = new URLSearchParams(body).getAll("payload");
  if (fields.length !== 1) return INVALID;
  let payload: unknown;
  try {
    payload = JSON.parse(fields[0]);
  } catch {
    return INVALID;
  }
  if (!isObject(payload)) return INVALID;
  const type = payload.type;
  if (typeof type !== "string") return INVALID;
  if (type !== "block_actions") return { kind: "other", type: typeCode(type) };

  const apiAppId = payload.api_app_id;
  const team = payload.team;
  const user = payload.user;
  const triggerId = payload.trigger_id;
  const container = payload.container;
  const actions = payload.actions;
  if (typeof apiAppId !== "string" || typeof triggerId !== "string") return INVALID;
  if (!isObject(team) || typeof team.id !== "string") return INVALID;
  if (!isObject(user) || typeof user.id !== "string") return INVALID;
  if (!isObject(container) || typeof container.type !== "string") return INVALID;
  if (!Array.isArray(actions) || actions.length !== 1) return INVALID;
  const action: unknown = actions[0];
  if (!isObject(action)) return INVALID;
  const actionId = action.action_id;
  if (typeof actionId !== "string" || actionId.length === 0 || actionId.length > ACTION_ID_MAX) return INVALID;
  const rawValue = action.value;
  if (rawValue !== undefined && (typeof rawValue !== "string" || rawValue.length > ACTION_VALUE_MAX)) return INVALID;

  const facts: SlackActionFacts = {
    teamId: team.id,
    apiAppId,
    userId: user.id,
    triggerId,
    actionId,
    value: typeof rawValue === "string" ? rawValue : "",
    containerType: container.type,
    channelId: strOrNull(container.channel_id),
    messageTs: strOrNull(container.message_ts)
  };
  return { kind: "block_actions", facts, linkOnly: actionId === LINK_ACTION_ID };
}
