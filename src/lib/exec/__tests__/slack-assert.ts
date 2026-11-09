import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { SLACK_ACTION_IDS, SLACK_LIMITS, type SlackHomeView, type SlackMessageParts } from "@/lib/exec/slack-types";

// P6 shared test helper (contract §5; stage 0, lead-owned, frozen). Every
// area's renderer and job tests use it:
//
//   assertSlackParts(parts)     every block P6 emits obeys the Block Kit rules of §3.6.2 (K10)
//   slackPartsProblems(parts)   the same checks, returned as a list (for negative tests)
//   SENTINELS                   values that must never reach a log, a payload, a result or a response
//   findSentinel(value)         the first sentinel name found anywhere inside a value, or null
//   ROUTING_INSTALLATION        the installation the routing fixture (fixtures/slack-routing.json) runs against
//
// Pure: no server-only, no Supabase. Imports only P6's frozen seeds and refs.ts.

const LINK_ACTION_ID = "ea_open_dd";
const ALLOWED_ACTION_IDS: ReadonlySet<string> = new Set<string>([...SLACK_ACTION_IDS, LINK_ACTION_ID]);
const BLOCK_TYPES: ReadonlySet<string> = new Set(["section", "context", "actions", "header", "divider"]);
/** Slack's own limits that §3.6.2 doesn't restate (a block past them is invalid_blocks). */
const HEADER_TEXT_MAX = 150;
const BLOCK_ID_MAX = 255;
const ACTION_ID_MAX = 255;
const ACTIONS_ELEMENTS_MAX = 25;
const BUTTON_URL_MAX = 3000;
const BUTTON_TEXT_MAX = 75;
/** An allow-listed link: <https://…|label>, the url with no whitespace, "|", "<", ">" or "`", the label with no "<", ">" or "|". */
const LINK = /<(https:\/\/[^\s|<>`]+)\|([^<>|]*)>/g;
/** Every "&" in escaped mrkdwn starts one of the three entities escapeMrkdwn writes. */
const BARE_AMP = /&(?!amp;|lt;|gt;)/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function checkMrkdwn(v: unknown, where: string, out: string[]): string | null {
  if (!isObj(v) || v.type !== "mrkdwn") {
    out.push(`${where}: not a mrkdwn text object`);
    return null;
  }
  if (v.verbatim !== true) out.push(`${where}: mrkdwn without verbatim: true`);
  if (typeof v.text !== "string") {
    out.push(`${where}: mrkdwn text is not a string`);
    return null;
  }
  const keys = Object.keys(v).filter((k) => k !== "type" && k !== "text" && k !== "verbatim");
  if (keys.length > 0) out.push(`${where}: unexpected mrkdwn keys ${keys.join(",")}`);
  checkEscaped(v.text, where, out);
  return v.text;
}

function checkPlain(v: unknown, where: string, out: string[], max: number): void {
  if (!isObj(v) || v.type !== "plain_text") {
    out.push(`${where}: not a plain_text object`);
    return;
  }
  if (v.emoji !== false) out.push(`${where}: plain_text without emoji: false`);
  if (typeof v.text !== "string" || v.text.length === 0) out.push(`${where}: plain_text text is empty or not a string`);
  else if (v.text.length > max) out.push(`${where}: plain_text longer than ${max} (${v.text.length})`);
}

/** No raw "<" or ">" outside an allow-listed https link; every "&" an entity. */
function checkEscaped(text: string, where: string, out: string[]): void {
  let rest = "";
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const url = m[1].replace(/&amp;/g, "&");
    if (!isAllowedLinkUrl(url)) out.push(`${where}: link to a url isAllowedLinkUrl refuses`);
    rest += text.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
  }
  rest += text.slice(last);
  if (rest.includes("<")) out.push(`${where}: raw "<" outside an allow-listed link`);
  if (rest.includes(">")) out.push(`${where}: raw ">" outside an allow-listed link`);
  if (BARE_AMP.test(text)) out.push(`${where}: a bare "&" (not &amp; / &lt; / &gt;)`);
}

function checkButton(v: unknown, where: string, out: string[]): void {
  if (!isObj(v) || v.type !== "button") {
    out.push(`${where}: not a button`);
    return;
  }
  const actionId = v.action_id;
  if (typeof actionId !== "string" || !ALLOWED_ACTION_IDS.has(actionId) || actionId.length > ACTION_ID_MAX) {
    out.push(`${where}: action_id outside the allowed set`);
  }
  checkPlain(v.text, `${where}.text`, out, BUTTON_TEXT_MAX);
  if (v.value !== undefined && (typeof v.value !== "string" || v.value.length > SLACK_LIMITS.actionValueChars)) {
    out.push(`${where}: value not a string of at most ${SLACK_LIMITS.actionValueChars}`);
  }
  if (v.url !== undefined) {
    if (typeof v.url !== "string" || v.url.length > BUTTON_URL_MAX || !v.url.startsWith("https://") || !isAllowedLinkUrl(v.url)) {
      out.push(`${where}: url not an allow-listed https url`);
    }
    if (actionId !== LINK_ACTION_ID) out.push(`${where}: a url button must use ${LINK_ACTION_ID}`);
  } else if (actionId === LINK_ACTION_ID) {
    out.push(`${where}: ${LINK_ACTION_ID} without a url`);
  }
  if (v.style !== undefined && v.style !== "primary" && v.style !== "danger") out.push(`${where}: bad style`);
  if (v.confirm !== undefined) {
    const c = v.confirm;
    if (!isObj(c)) out.push(`${where}: bad confirm`);
    else for (const k of ["title", "text", "confirm", "deny"]) checkPlain(c[k], `${where}.confirm.${k}`, out, 300);
  }
}

function checkBlockId(v: unknown, where: string, out: string[], required: boolean): void {
  if (v === undefined && !required) return;
  if (typeof v !== "string" || v.length === 0 || v.length > BLOCK_ID_MAX) out.push(`${where}: bad block_id`);
}

/**
 * Every rule §5 lists, as a list of problems (empty = fine):
 *  - only section / context / actions / header / divider blocks; no fields, accessory, image, markdown or rich_text;
 *  - verbatim: true on every mrkdwn object, emoji: false on every plain_text;
 *  - no raw "<" (or ">") except inside an allow-listed <https://…|…> link; every "&" an entity;
 *  - section text ≤ 3,000; ≤ 50 blocks (100 for a Home view); context ≤ 10 elements;
 *  - button value ≤ 200 and text ≤ 75; action_id in SLACK_ACTION_IDS + ea_open_dd;
 *  - message parts: text === SLACK_COPY.fallbackText.
 */
export function slackPartsProblems(parts: SlackMessageParts | SlackHomeView): string[] {
  const out: string[] = [];
  if (!isObj(parts)) return ["parts: not an object"];
  const home = (parts as Obj).type === "home";
  if (home) {
    const keys = Object.keys(parts).filter((k) => k !== "type" && k !== "blocks");
    if (keys.length > 0) out.push(`home: unexpected keys ${keys.join(",")}`);
  } else {
    if ((parts as Obj).text !== SLACK_COPY.fallbackText) out.push("text: not SLACK_COPY.fallbackText");
    const keys = Object.keys(parts).filter((k) => k !== "text" && k !== "blocks");
    if (keys.length > 0) out.push(`parts: unexpected keys ${keys.join(",")}`);
  }
  const blocks = (parts as Obj).blocks;
  if (!Array.isArray(blocks)) return [...out, "blocks: not an array"];
  const max = home ? SLACK_LIMITS.blocksPerHome : SLACK_LIMITS.blocksPerMessage;
  if (blocks.length === 0) out.push("blocks: empty");
  if (blocks.length > max) out.push(`blocks: ${blocks.length} > ${max}`);
  blocks.forEach((b: unknown, i: number) => {
    const where = `blocks[${i}]`;
    if (!isObj(b) || typeof b.type !== "string" || !BLOCK_TYPES.has(b.type)) {
      out.push(`${where}: block type not allowed`);
      return;
    }
    for (const banned of ["fields", "accessory"]) {
      if (banned in b) out.push(`${where}: has ${banned}`);
    }
    switch (b.type) {
      case "section": {
        checkBlockId(b.block_id, where, out, false);
        const text = checkMrkdwn(b.text, `${where}.text`, out);
        if (text !== null && text.length > SLACK_LIMITS.sectionChars) out.push(`${where}: section text ${text.length} > ${SLACK_LIMITS.sectionChars}`);
        if (text !== null && text.length === 0) out.push(`${where}: empty section text`);
        break;
      }
      case "context": {
        checkBlockId(b.block_id, where, out, false);
        const els = b.elements;
        if (!Array.isArray(els) || els.length === 0) {
          out.push(`${where}: context without elements`);
          break;
        }
        if (els.length > SLACK_LIMITS.contextElements) out.push(`${where}: ${els.length} context elements > ${SLACK_LIMITS.contextElements}`);
        els.forEach((e: unknown, j: number) => {
          const text = checkMrkdwn(e, `${where}.elements[${j}]`, out);
          if (text !== null && text.length > SLACK_LIMITS.sectionChars) out.push(`${where}.elements[${j}]: text over ${SLACK_LIMITS.sectionChars}`);
        });
        break;
      }
      case "actions": {
        checkBlockId(b.block_id, where, out, true);
        const els = b.elements;
        if (!Array.isArray(els) || els.length === 0) {
          out.push(`${where}: actions without elements`);
          break;
        }
        if (els.length > ACTIONS_ELEMENTS_MAX) out.push(`${where}: ${els.length} actions > ${ACTIONS_ELEMENTS_MAX}`);
        els.forEach((e: unknown, j: number) => checkButton(e, `${where}.elements[${j}]`, out));
        break;
      }
      case "header":
        checkPlain(b.text, `${where}.text`, out, HEADER_TEXT_MAX);
        break;
      case "divider":
        if (Object.keys(b).some((k) => k !== "type")) out.push(`${where}: divider with extra keys`);
        break;
    }
  });
  return out;
}

/** Throws one Error naming every problem slackPartsProblems finds. */
export function assertSlackParts(parts: SlackMessageParts | SlackHomeView): void {
  const problems = slackPartsProblems(parts);
  if (problems.length > 0) throw new Error(`Slack parts break ${problems.length} rule(s):\n  ${problems.join("\n  ")}`);
}

/**
 * §0.3 rule 4's never-log list, one recognizable value each. A test feeds them in (the DM text, the bot token,
 * his email, Slack's secrets and query values) and proves none comes out through console.*, notifyOps, an audit
 * input, a job payload or result, an error message or an HTTP response (findSentinel over each).
 */
export const SENTINELS = Object.freeze({
  /** A DM / answer / email text. */
  text: "SENTINEL-TEXT the board deck numbers 7f3a9c",
  /** A bot token (xoxb-). */
  token: "xoxb-SENTINEL-1111111111-2222222222222-sentinelbottokenvalue00",
  /** A user token (xoxp-), as an unexpected authed_user.access_token. */
  userToken: "xoxp-SENTINEL-3333333333-4444444444444-sentinelusertokenvalue",
  /** A refresh token (xoxe-). */
  refreshToken: "xoxe-1-SENTINEL-refresh-5555555555",
  /** An email address. */
  email: "sentinel.owner@sentinel-mail.example",
  /** A Slack display name. */
  displayName: "Sentinel Displayname",
  /** EXEC_SLACK_CLIENT_SECRET. */
  clientSecret: "sentinelclientsecret0123456789abcdef",
  /** EXEC_SLACK_SIGNING_SECRET. */
  signingSecret: "sentinelsigningsecret0123456789abcdef",
  /** An x-slack-signature header value (v0=, 64 hex). */
  signature: "v0=5e7e1e15e7e1e15e7e1e15e7e1e15e7e1e15e7e1e15e7e1e15e7e1e15e7e1e",
  /** A url_verification challenge. */
  challenge: "SENTINELchallenge3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
  /** The OAuth callback's code query value. */
  oauthCode: "SENTINEL.oauth.code.1234567890.abcdef",
  /** An OAuth state token (s1.<nonce>.<exp>.<mac>); the 64 hex is the nonce. */
  oauthState: "s1.5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e.1793977800.SENTINELmacSENTINELmacSENTINELmacSENTINELma",
  /** An interaction trigger_id. */
  triggerId: "13345224609.738474920.SENTINEL8bf3d1a7c4",
  /** An interaction response_url. */
  responseUrl: "https://hooks.slack.com/actions/T0SCALED/SENTINEL/responseurlsentinel"
});
export type SentinelName = keyof typeof SENTINELS;

const SENTINEL_ENTRIES = Object.entries(SENTINELS) as [SentinelName, string][];
const MAX_WALK_NODES = 20_000;
/** §0.3 rule 4: any Slack token, sentinel or not (a clipped or re-encoded one included). */
const ANY_TOKEN = /xox[abpe]-/;

/**
 * The first sentinel whose exact value appears in `value`, else "token" when any string holds a Slack token prefix
 * (xoxa-/xoxb-/xoxp-/xoxe-, §0.3 rule 4), else null. Walks strings, arrays, plain objects (keys too), Maps, Sets,
 * Errors (name, message, stack, cause, own fields), Headers and URLSearchParams. Never throws.
 */
export function findSentinel(value: unknown): SentinelName | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [value];
  let tokenLike = false;
  for (let i = 0; i < queue.length && i < MAX_WALK_NODES; i++) {
    const v = queue[i];
    if (typeof v === "string") {
      for (const [name, s] of SENTINEL_ENTRIES) if (v.includes(s)) return name;
      if (ANY_TOKEN.test(v)) tokenLike = true;
      continue;
    }
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") continue;
    if (typeof v === "function" || typeof v === "symbol") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    try {
      if (v instanceof Error) {
        queue.push(v.name, v.message, v.stack, (v as { cause?: unknown }).cause, { ...v });
        continue;
      }
      if (typeof Headers !== "undefined" && v instanceof Headers) {
        v.forEach((val, key) => queue.push(key, val));
        continue;
      }
      if (v instanceof URLSearchParams) {
        queue.push(v.toString());
        continue;
      }
      if (v instanceof Map) {
        for (const [k, x] of v) queue.push(k, x);
        continue;
      }
      if (v instanceof Set) {
        for (const x of v) queue.push(x);
        continue;
      }
      if (Array.isArray(v)) {
        queue.push(...v);
        continue;
      }
      if (typeof v === "object") {
        for (const [k, x] of Object.entries(v as Obj)) queue.push(k, x);
      }
    } catch {
      // A hostile getter or a revoked proxy: skip the node.
    }
  }
  return tokenLike ? "token" : null;
}

/**
 * The installation fixtures/slack-routing.json runs against (§5.3): RT-V (C), RT-S (A, SQL) and RT-F (A, the fake)
 * seed exactly this row. `installation: "owner"` = active; `"revoked"` = the same row with revoked_at set (reason
 * app_uninstalled, token null, purged); `null` = no row. installedAt lies after rows 25 and 35's event_time
 * (2026-10-25T12:00:00Z) and before every other row's (2026-11-06T15:00:00Z onwards), so only those two are
 * stale_revoke; any value inside that window gives the same decisions.
 */
export const ROUTING_INSTALLATION = Object.freeze({
  teamId: "T0SCALED",
  appId: "A0EXEC",
  userId: "U0MITCH",
  dmChannelId: "D0MITCH",
  botUserId: "U0BOT",
  botId: "B0BOT",
  installedAt: "2026-11-01T00:00:00.000Z",
  installedAtEpochSec: 1793491200
});
