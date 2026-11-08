import { isDdHost } from "@/lib/exec/refs";
import { REASON, SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import type { ConvType, IngestFacts, LifecycleKind, MuteSource, PrefilterDrop } from "@/lib/exec/slack-read-types";
import { slackTextToPlain } from "@/lib/exec/slack-text";

// P7a ingest flags, the pre-DB filter and the candidate rule (P7a contract
// §3.3, P7-2, C3, C11, C33, C46; Area B; pure).
//
// The ack path reads a message's text, blocks and attachments IN MEMORY here
// to derive booleans, small integers and ids, and nothing else leaves:
// IngestFacts carries no text (IG14 walks it), and ingestFactsForRpc only
// renames its keys for v2's p_ingest (§2.4). previous_message is never read
// into facts; the edit no-op comparison in prefilterIngest reads its text and
// blocks only to compare them. sweepVerdict applies the same rules to the
// messages a sweep reads (v2 steps 9-15 minus the DB parts). Nothing here
// logs or throws on malformed input: a shape we can't read is "not a reading
// event" (null), which sends it down P6's path.

const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
const USER_RE = /^[UW][A-Z0-9]{2,30}$/;
const TEAM_RE = /^[TE][A-Z0-9]{2,30}$/;
const APP_RE = /^A[A-Z0-9]{2,30}$/;
const TS_RE = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SLACKBOT = "USLACKBOT";
const DD_BUTTON_LABEL = "Open in Scaled Operations";
const DD_PATH_MAX = 400;
/** C3's subtype allow-list (absent included). Anything else is noise: channel_join, pinned_item, huddle_thread, … */
const ALLOWED_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share", "me_message", "bot_message", "message_changed", "message_deleted"]);
/** The same allow-list for a message a sweep reads: history shows the current message, never an edit or delete event. */
const HISTORY_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share", "me_message", "bot_message"]);
/** §2.5: the lifecycle events v2 handles, and where each carries its channel id. */
const LIFECYCLE: Readonly<Record<string, { lc: LifecycleKind; at: "object" | "string" | "old" }>> = Object.freeze({
  channel_created: { lc: "created", at: "object" },
  channel_rename: { lc: "rename", at: "object" },
  group_rename: { lc: "rename", at: "object" },
  channel_archive: { lc: "archive", at: "string" },
  group_archive: { lc: "archive", at: "string" },
  channel_unarchive: { lc: "unarchive", at: "string" },
  group_unarchive: { lc: "unarchive", at: "string" },
  channel_deleted: { lc: "deleted", at: "string" },
  group_deleted: { lc: "deleted", at: "string" },
  channel_left: { lc: "left", at: "string" },
  group_left: { lc: "left", at: "string" },
  channel_shared: { lc: "shared", at: "string" },
  channel_unshared: { lc: "unshared", at: "string" },
  channel_id_changed: { lc: "id_changed", at: "old" }
});
const CONV_TYPES: ReadonlySet<string> = new Set(["channel", "group", "im", "mpim"]);
/** Walk limits for the block trees (a hostile message can't make the ack path walk forever). */
const MAX_DEPTH = 8;
const MAX_NODES = 5_000;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strMatch = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);

// --- text-derived flags (in memory only) -----------------------------------------------------------------------------

const cp = (n: number) => String.fromCodePoint(n);
// Emoji glue that \p{Extended_Pictographic} doesn't cover: U+FE0E / U+FE0F (variation selectors), U+200D (zero-width
// joiner), U+20E3 (combining keycap), U+E0020–U+E007F (tag characters). Built from code points, never typed as escapes.
const EMOJI_GLUE = new RegExp(`[${cp(0xfe0e)}${cp(0xfe0f)}${cp(0x200d)}${cp(0x20e3)}${cp(0xe0020)}-${cp(0xe007f)}]`, "gu");
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu;
const SHORTCODE = /:[a-z0-9_+'-]{1,100}:/gi;
const WHITESPACE = /\s+/gu;

export function lengthBucket(plain: string): 0 | 1 | 2 | 3 {
  if (typeof plain !== "string" || plain.length === 0) return 0;
  const rest = plain.replace(SHORTCODE, "").replace(PICTOGRAPHIC, "").replace(EMOJI_GLUE, "").replace(WHITESPACE, "");
  const n = [...rest].length;
  if (n <= 3) return 0;
  if (n <= 40) return 1;
  if (n <= 280) return 2;
  return 3;
}

const FENCED = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const ANGLE_TOKEN = /<[^<>]*>/g;
const BARE_URL = /\bhttps?:\/\/\S+/gi;

export function hasQuestion(plain: string): boolean {
  if (typeof plain !== "string" || plain.length === 0) return false;
  return plain.replace(FENCED, " ").replace(INLINE_CODE, " ").replace(ANGLE_TOKEN, " ").replace(BARE_URL, " ").includes("?");
}

const MENTION_RE = /<@([UW][A-Z0-9]{2,30})(?:\|[^<>]*)?>/g;

/** Every rich_text node (blocks of type rich_text, their nested elements), depth- and size-limited. */
function forEachRichNode(blocks: unknown, visit: (node: Json) => void): void {
  let seen = 0;
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || seen > MAX_NODES || !isRecord(node)) return;
    seen++;
    visit(node);
    for (const child of asArray(node.elements)) walk(child, depth + 1);
  };
  for (const block of asArray(blocks)) if (isRecord(block) && block.type === "rich_text") walk(block, 0);
}

export function extractMentions(text: string | null, blocks: unknown): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (out.length < SLACK_READ_LIMITS.mentionsMax && typeof id === "string" && USER_RE.test(id) && !out.includes(id)) out.push(id);
  };
  if (typeof text === "string") for (const m of text.matchAll(MENTION_RE)) add(m[1]);
  forEachRichNode(blocks, (node) => {
    if (node.type === "user") add(node.user_id);
  });
  return out;
}

const BROADCAST_RE = /<!(?:here|channel|everyone)(?:\|[^<>]*)?>/;

export function isBroadcast(text: string | null): boolean {
  return typeof text === "string" && BROADCAST_RE.test(text);
}

// Owner-tunable constants; they steer nothing in P7a (§3.3).
const HINT_COMMITMENT = /\b(i'?ll|i will|will (send|share|get|do)|by (mon|tues|wednes|thurs|fri|satur|sun)day|by (tomorrow|eod|end of (the )?day))\b/i;
const HINT_DECISION = /\b(approve|approval|sign[- ]?off|go ahead|ok to|okay to|should we|can we|which (one|option))\b/i;
const HINT_URGENT = /\b(urgent|asap|immediately|right away|today)\b/i;

export function hintBits(plain: string): number {
  if (typeof plain !== "string" || plain.length === 0) return 0;
  return (HINT_COMMITMENT.test(plain) ? 1 : 0) | (HINT_DECISION.test(plain) ? 2 : 0) | (HINT_URGENT.test(plain) ? 4 : 0);
}

/** The text elements of a message's rich_text blocks, joined (the plain text when `text` is empty). */
function richTextOf(blocks: unknown): string {
  const parts: string[] = [];
  forEachRichNode(blocks, (node) => {
    if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
  });
  return parts.join("");
}

interface MessageSignals { mentions: string[]; broadcast: boolean; question: boolean; len: 0 | 1 | 2 | 3; hints: number }

/** The text-derived flags of one message (an event's effective message or a history message). */
function signalsOf(text: string | null, blocks: unknown): MessageSignals {
  const hasText = typeof text === "string" && text.length > 0;
  const raw = hasText ? (text as string) : richTextOf(blocks);
  const plain = hasText ? slackTextToPlain(text as string) : raw;
  return {
    mentions: extractMentions(hasText ? text : null, blocks),
    broadcast: isBroadcast(hasText ? text : null),
    // The raw form: a "?" inside a <link|label> or a mention label is not a question.
    question: hasQuestion(raw),
    len: lengthBucket(plain),
    hints: hintBits(plain)
  };
}

// --- bots, DD's template, DD paths -------------------------------------------------------------------------------------

export function isBotMessage(m: { bot_id?: unknown; bot_profile?: unknown; subtype?: unknown; user?: unknown }): boolean {
  if (m === null || typeof m !== "object") return false;
  // A present-but-null bot_id is not a bot (ING §1.2, the file_share shape).
  return Boolean(m.bot_id) || (m.bot_profile !== undefined && m.bot_profile !== null) || m.subtype === "bot_message" || m.user === SLACKBOT;
}

/** A history/replies message or an event's inner message that is a tombstone (subtype "tombstone"). */
export function isTombstone(m: { subtype?: unknown }): boolean {
  return m !== null && typeof m === "object" && m.subtype === "tombstone";
}

/** A button URL that is DD's: https on a DD host. A URL that doesn't parse counts as DD (anchor, never triaged). */
function isDdButtonUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  return parsed.protocol === "https:" && isDdHost(parsed.hostname);
}

function isDdButton(el: unknown): boolean {
  if (!isRecord(el)) return false;
  const label = isRecord(el.text) ? el.text.text : el.text;
  return label === DD_BUTTON_LABEL || isDdButtonUrl(el.url);
}

export function isDdTemplate(blocks: unknown, attachments: unknown): boolean {
  for (const block of asArray(blocks)) {
    if (!isRecord(block)) continue;
    if (block.type === "actions" && asArray(block.elements).some((el) => isRecord(el) && el.type === "button" && isDdButton(el))) return true;
    if (block.type === "section" && isRecord(block.accessory) && block.accessory.type === "button" && isDdButton(block.accessory)) return true;
  }
  for (const att of asArray(attachments)) {
    if (!isRecord(att)) continue;
    if (asArray(att.actions).some((a) => isRecord(a) && (a.type === undefined || a.type === "button") && isDdButton(a))) return true;
  }
  return false;
}

const ANGLE_LINK = /<(https?:\/\/[^|<>\s]+)(?:\|[^<>]*)?>/g;
const PLAIN_HOST = /^[a-z0-9.-]{1,253}$/;

function angleLinks(text: unknown, out: string[]): void {
  if (typeof text !== "string") return;
  for (const m of text.matchAll(ANGLE_LINK)) out.push(m[1]);
}

/** Every URL of a message's link-bearing parts: rich_text link elements, section text / field links, section accessory and
 *  actions buttons, legacy attachments[].actions (§3.3 DD paths). */
function linkUrlsOf(blocks: unknown, attachments: unknown): string[] {
  const urls: string[] = [];
  for (const block of asArray(blocks)) {
    if (!isRecord(block)) continue;
    if (block.type === "rich_text") {
      forEachRichNode([block], (node) => {
        if (node.type === "link" && typeof node.url === "string") urls.push(node.url);
      });
    } else if (block.type === "section") {
      if (isRecord(block.text)) angleLinks(block.text.text, urls);
      for (const f of asArray(block.fields)) if (isRecord(f)) angleLinks(f.text, urls);
      if (isRecord(block.accessory) && typeof block.accessory.url === "string") urls.push(block.accessory.url);
    } else if (block.type === "actions") {
      for (const el of asArray(block.elements)) if (isRecord(el) && typeof el.url === "string") urls.push(el.url);
    }
  }
  for (const att of asArray(attachments)) {
    if (!isRecord(att)) continue;
    for (const a of asArray(att.actions)) if (isRecord(a) && typeof a.url === "string") urls.push(a.url);
  }
  return urls;
}

/** C46, moved here from P7b's slack-links.ts (P7b imports it): the exact pattern and behaviour of P7bC §3.3. */
export const DD_PATH_RE: RegExp =
  /^\/(?:tasks|clients|projects)\/[A-Za-z0-9_-]{1,100}$|^\/inboxes\/[A-Za-z0-9_-]{1,100}\?(?:[^#\s]*&)?thread=[A-Za-z0-9_.:-]{1,200}(?:&[^#\s]*)?$/;

/** One URL → its DD-relative path, or null. */
function ddPathOf(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  const host = parsed.hostname.toLowerCase();
  // A plain host name only: isDdHost counts a malformed host as DD, which is right for buttons and wrong for a path signal.
  if (!PLAIN_HOST.test(host) || !isDdHost(host)) return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  path = path.replace(/\/+$/, "");
  if (path.length === 0) return null;
  const candidate = path.startsWith("/inboxes/") ? `${path}${parsed.search}` : path;
  return candidate.length <= DD_PATH_MAX && DD_PATH_RE.test(candidate) ? candidate : null;
}

/** Every DD path in a Slack message: <url|label> and <url> tokens of the text, block link elements and URL buttons. Only https
 *  URLs whose host isDdHost (WT3:refs.ts:148; localhost and every other host ignored); path normalized (no trailing slash,
 *  decoded once), query kept only for /inboxes; each must match DD_PATH_RE and be ≤ 400 characters. Deduped, ≤ 20, in order.
 *  Never throws. The SQL twin of the pattern is exec_slack_dd_paths_ok (§2.9.3; RQ34 runs the LK fixtures through both). */
export function extractDdPaths(input: { text: string; urls: readonly string[] }): string[] {
  const out: string[] = [];
  try {
    const candidates: string[] = [];
    angleLinks(input?.text, candidates);
    for (const u of Array.isArray(input?.urls) ? input.urls : []) if (typeof u === "string") candidates.push(u);
    for (const url of candidates) {
      if (out.length >= SLACK_READ_LIMITS.mentionsMax) break;
      const path = ddPathOf(url);
      if (path !== null && !out.includes(path)) out.push(path);
    }
  } catch {
    // Never throws: whatever was found so far stands.
  }
  return out;
}

function ddPathsOfMessage(text: unknown, blocks: unknown, attachments: unknown): string[] {
  return extractDdPaths({ text: typeof text === "string" ? text : "", urls: linkUrlsOf(blocks, attachments) });
}

// --- the event → facts ---------------------------------------------------------------------------------------------------

interface ReadingEvent { event: Json; eventType: string; channel: string | null; envelope: Json }

/** A reading event (a message, or a §2.5 lifecycle event) of an event_callback envelope, with its channel id; else null. */
function readingEvent(json: unknown): ReadingEvent | null {
  if (!isRecord(json) || json.type !== "event_callback" || !isRecord(json.event)) return null;
  const event = json.event;
  const eventType = typeof event.type === "string" ? event.type : null;
  if (eventType === null) return null;
  if (eventType === "message") return { event, eventType, channel: strMatch(event.channel, CHANNEL_RE), envelope: json };
  const lifecycle = LIFECYCLE[eventType];
  if (!lifecycle) return null;
  const raw = lifecycle.at === "object" ? (isRecord(event.channel) ? event.channel.id : null) : lifecycle.at === "old" ? event.old_channel_id : event.channel;
  return { event, eventType, channel: strMatch(raw, CHANNEL_RE), envelope: json };
}

function emptyFacts(kind: IngestFacts["kind"], envelope: Json): IngestFacts {
  const auth = asArray(envelope.authorizations)[0];
  return {
    kind, conv: null, ts: null, threadTs: null, editedTs: null, deletedTs: null,
    author: null, authorTeam: null, parentUser: null, mentions: [],
    isBot: false, appId: null, ddTemplate: false, broadcast: false, question: false,
    len: 0, hints: 0, files: false, extShared: envelope.is_ext_shared_channel === true,
    authUser: isRecord(auth) ? strMatch(auth.user_id, USER_RE) : null, authIsBot: isRecord(auth) && auth.is_bot === true,
    lc: null, name: null, newChannel: null, isExtShared: null, ddPaths: []
  };
}

/** A reading event (a message event, or a lifecycle event of §2.5) → its facts and its channel id; anything else → null.
 *  The effective message: event.message for message_changed (+ edited.ts), event.deleted_ts for message_deleted, the event itself
 *  otherwise. A message_changed whose event.message.subtype is "tombstone" (a deleted thread parent that keeps its replies) is
 *  returned as kind "delete" with deletedTs = event.message.ts, no author, isBot false (C16, N13).
 *  Reads text, blocks and attachments IN MEMORY to derive flags; the result holds no text (IG14 walks it). */
export function deriveIngestFacts(json: unknown): { facts: IngestFacts; channel: string | null; eventType: string } | null {
  const re = readingEvent(json);
  if (re === null) return null;
  const { event, eventType, channel, envelope } = re;

  if (eventType !== "message") {
    const lifecycle = LIFECYCLE[eventType];
    const facts = emptyFacts("lifecycle", envelope);
    facts.lc = lifecycle.lc;
    if (lifecycle.lc === "created" || lifecycle.lc === "rename") facts.name = isRecord(event.channel) ? strMatch(event.channel.name, NAME_RE) : null;
    if (lifecycle.lc === "unshared") facts.isExtShared = typeof event.is_ext_shared === "boolean" ? event.is_ext_shared : null;
    if (lifecycle.lc === "id_changed") {
      facts.newChannel = strMatch(event.new_channel_id, CHANNEL_RE);
      // Without the new id there is nothing to re-key: not a reading event v2 can act on.
      if (facts.newChannel === null) return null;
    }
    return { facts, channel, eventType };
  }

  const conv = typeof event.channel_type === "string" && CONV_TYPES.has(event.channel_type) ? (event.channel_type as ConvType) : null;
  const subtype = event.subtype;

  if (subtype === "message_deleted" || (subtype === "message_changed" && isRecord(event.message) && isTombstone(event.message))) {
    const deletedTs = subtype === "message_deleted" ? strMatch(event.deleted_ts, TS_RE) : strMatch((event.message as Json).ts, TS_RE);
    if (deletedTs === null) return null;
    const facts = emptyFacts("delete", envelope);
    facts.conv = conv;
    facts.deletedTs = deletedTs;
    return { facts, channel, eventType };
  }

  let m: Json = event;
  let kind: IngestFacts["kind"] = "msg";
  let editedTs: string | null = null;
  if (subtype === "message_changed") {
    if (!isRecord(event.message)) return null;
    m = event.message;
    kind = "edit";
    editedTs = isRecord(m.edited) ? strMatch(m.edited.ts, TS_RE) : null;
  }
  const ts = strMatch(m.ts, TS_RE);
  if (ts === null) return null;
  const text = typeof m.text === "string" ? m.text : null;
  const signals = signalsOf(text, m.blocks);
  const facts = emptyFacts(kind, envelope);
  facts.conv = conv;
  facts.ts = ts;
  facts.threadTs = strMatch(m.thread_ts, TS_RE);
  facts.editedTs = editedTs;
  facts.author = strMatch(m.user, USER_RE);
  facts.authorTeam = strMatch(m.user_team, TEAM_RE) ?? strMatch(m.team, TEAM_RE);
  facts.parentUser = strMatch(m.parent_user_id, USER_RE);
  facts.mentions = signals.mentions;
  facts.isBot = isBotMessage(m);
  facts.appId = strMatch(m.app_id, APP_RE);
  facts.ddTemplate = isDdTemplate(m.blocks, m.attachments);
  facts.broadcast = signals.broadcast;
  facts.question = signals.question;
  facts.len = signals.len;
  facts.hints = signals.hints;
  // File names are never read: only whether files are there.
  facts.files = (Array.isArray(m.files) && m.files.length > 0) || m.subtype === "file_share";
  facts.ddPaths = ddPathsOfMessage(m.text, m.blocks, m.attachments);
  return { facts, channel, eventType };
}

/** C3, text-free: "pass" or the drop reason. The subtype is judged BEFORE `hidden` (Slack marks every edit and delete hidden). */
export function prefilterIngest(json: unknown, facts: IngestFacts): "pass" | PrefilterDrop {
  const re = readingEvent(json);
  // No usable channel id: v2 could only raise on it.
  if (re === null || re.channel === null) return "no_channel";
  if (facts.kind === "lifecycle" || re.eventType !== "message") return "pass";
  const event = re.event;
  const subtype = event.subtype;
  // (2) The subtype first. A delete only removes data: never the bot or hidden rule.
  if (subtype === "message_deleted") return "pass";
  if (subtype === "message_changed") {
    const next = isRecord(event.message) ? event.message : null;
    if (next !== null && isTombstone(next)) return "pass";
    const prev = isRecord(event.previous_message) ? event.previous_message : null;
    // Language detection and other no-op edits: compared in memory only, never kept.
    if (next !== null && prev !== null && typeof next.text === "string" && next.text === prev.text
        && JSON.stringify(next.blocks ?? null) === JSON.stringify(prev.blocks ?? null)) {
      return "edit_noop";
    }
    if (next !== null && isBotMessage(next) && facts.mentions.length === 0) return "bot_no_mention";
    return "pass";
  }
  // (3) A subtype outside the allow-list is noise.
  if (subtype !== undefined && subtype !== null && (typeof subtype !== "string" || !ALLOWED_SUBTYPES.has(subtype))) return "noise_subtype";
  // (4) Only now hidden (the message_replied shape with no subtype).
  if (event.hidden === true) return "hidden";
  // (5) A bot that mentions nobody.
  if (isBotMessage(event) && facts.mentions.length === 0) return "bot_no_mention";
  return "pass";
}

/** C33 / N10, fail closed. teamId = the installation's team; extConversation = class external, ext_ever or is_ext_shared.
 *  true when: candidateExternal; or userTeam set and ≠ teamId; or briefTeamId set and ≠ teamId; or extConversation and NOT
 *  (briefTeamId === teamId and (userTeam === null or userTeam === teamId)). verifiedInternal = briefTeamId === teamId and
 *  (userTeam === null or userTeam === teamId) and !candidateExternal. */
export function isExternalAuthor(i: { candidateExternal: boolean; userTeam: string | null; briefTeamId: string | null;
  teamId: string; extConversation: boolean }): { external: boolean; verifiedInternal: boolean } {
  const userTeam = typeof i.userTeam === "string" && i.userTeam.length > 0 ? i.userTeam : null;
  const briefTeam = typeof i.briefTeamId === "string" && i.briefTeamId.length > 0 ? i.briefTeamId : null;
  const confirmedOurs = briefTeam !== null && briefTeam === i.teamId && (userTeam === null || userTeam === i.teamId);
  const external = i.candidateExternal !== false
    || (userTeam !== null && userTeam !== i.teamId)
    || (briefTeam !== null && briefTeam !== i.teamId)
    || (i.extConversation !== false && !confirmedOurs);
  return { external, verifiedInternal: confirmedOurs && i.candidateExternal === false };
}

/** §2.4's key for each IngestFacts field (snake_case). */
const RPC_KEYS: readonly (readonly [keyof IngestFacts, string])[] = [
  ["kind", "kind"], ["conv", "conv"], ["ts", "ts"], ["threadTs", "thread_ts"], ["editedTs", "edited_ts"], ["deletedTs", "deleted_ts"],
  ["author", "author"], ["authorTeam", "author_team"], ["parentUser", "parent_user"], ["mentions", "mentions"],
  ["isBot", "is_bot"], ["appId", "app_id"], ["ddTemplate", "dd_template"], ["broadcast", "broadcast"], ["question", "question"],
  ["len", "len"], ["hints", "hints"], ["files", "files"], ["ddPaths", "dd_paths"], ["extShared", "ext_shared"],
  ["authUser", "auth_user"], ["authIsBot", "auth_is_bot"], ["lc", "lc"], ["name", "name"], ["newChannel", "new_channel"],
  ["isExtShared", "is_ext_shared"]
];

/** IngestFacts → v2's p_ingest (§2.4 keys, snake_case; null and false-y optional keys omitted except booleans; dd_paths only
 *  when non-empty). */
export function ingestFactsForRpc(f: IngestFacts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, key] of RPC_KEYS) {
    const value = f[field];
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") {
      // v2 reads an absent is_bot as a bot (fail closed), so every flag is always sent.
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      if (key === "dd_paths" && value.length === 0) continue;
      out[key] = [...value];
      continue;
    }
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

/** N8 / C11 — the SQL twin is v2 step 15; fixture slack-ingest.json drives both (IG20, V2 rows). */
export function candidateReasons(i: { conv: ConvType; len: 0 | 1 | 2 | 3; question: boolean; mentionsHim: boolean;
  isReply: boolean; parentIsHim: boolean; hePostedInThread: boolean }): number {
  let reasons = 0;
  if (i.conv === "im" && i.len >= 1) reasons |= REASON.dm;
  if (i.conv === "mpim" && i.len >= 1 && (i.mentionsHim || i.question || i.len >= 2)) reasons |= REASON.dm;
  if (i.mentionsHim) reasons |= REASON.mention;
  if (i.isReply && (i.parentIsHim || i.hePostedInThread)) reasons |= REASON.hisThread;
  return reasons;
}

/** The sweep's per-message verdict (same rules as v2 steps 9–15, minus the DB parts the caller supplies). The tombstone test
 *  runs first (before the bot and noise rules: a tombstone is authored by USLACKBOT and hidden). */
export type SweepVerdict =
  | { role: "deleted" }                                   // a tombstone: markDeleted(ts, "tombstone"); the thread's other rows stay
  | { role: "anchor"; ddPaths: string[] } | { role: "from_him"; mentions: string[] }
  | { role: "candidate"; reasons: number; authorExternal: boolean; ddPaths: string[] }
  | { role: "ignore"; reason: "bot" | "noise" | "not_addressed" | "muted" | "hub" | "opted_out" };
export function sweepVerdict(m: import("@/lib/exec/sources/slack").SlackReadMessage, ctx: { conv: ConvType; hisId: string;
  teamId: string; ddBot: { userId: string | null; appId: string | null }; isHub: boolean; muted: boolean;
  /** N11 + N1: with "default_finance" nothing is a candidate (no DM/mention bypass). */
  muteSource: MuteSource | null;
  /** C33: class external, ext_ever or is_ext_shared; a missing userTeam then counts as external. */
  extConversation: boolean;
  /** C44: opted-out authors → ignore "opted_out". */
  optedOut: ReadonlySet<string>;
  hePostedInThread: (rootTs: string) => boolean }): SweepVerdict {
  if (isTombstone(m)) return { role: "deleted" };
  const isDd = isDdTemplate(m.blocks, m.attachments)
    || (ctx.ddBot.userId !== null && m.user === ctx.ddBot.userId)
    || (ctx.ddBot.appId !== null && m.appId === ctx.ddBot.appId);
  if (isDd) return { role: "anchor", ddPaths: ddPathsOfMessage(m.text, m.blocks, m.attachments) };
  if (isBotMessage({ bot_id: m.botId, bot_profile: m.botProfile ? {} : undefined, subtype: m.subtype, user: m.user })) {
    return { role: "ignore", reason: "bot" };
  }
  if ((m.subtype !== null && !HISTORY_SUBTYPES.has(m.subtype)) || m.hidden) return { role: "ignore", reason: "noise" };
  if (ctx.isHub) return { role: "ignore", reason: "hub" };
  const signals = signalsOf(m.text, m.blocks);
  if (m.user !== null && m.user === ctx.hisId) return { role: "from_him", mentions: signals.mentions };
  const isReply = m.threadTs !== null && m.threadTs !== m.ts;
  const reasons = candidateReasons({
    conv: ctx.conv,
    len: signals.len,
    question: signals.question,
    mentionsHim: signals.mentions.includes(ctx.hisId),
    isReply,
    parentIsHim: isReply && m.parentUserId !== null && m.parentUserId === ctx.hisId,
    hePostedInThread: isReply && m.threadTs !== null && ctx.hePostedInThread(m.threadTs) === true
  });
  if (reasons === 0) return { role: "ignore", reason: "not_addressed" };
  // N11 + N1: only an owner or Slack mute is bypassed, and only by a DM or a mention; a finance default mute never is.
  const bypass = (ctx.muteSource === "owner" || ctx.muteSource === "slack") && (reasons & (REASON.dm | REASON.mention)) !== 0;
  if (ctx.muted && !bypass) return { role: "ignore", reason: "muted" };
  if (m.user !== null && ctx.optedOut.has(m.user)) return { role: "ignore", reason: "opted_out" };
  const authorExternal = (m.userTeam !== null && m.userTeam !== ctx.teamId) || (m.userTeam === null && ctx.extConversation);
  return { role: "candidate", reasons, authorExternal, ddPaths: ddPathsOfMessage(m.text, m.blocks, m.attachments) };
}
