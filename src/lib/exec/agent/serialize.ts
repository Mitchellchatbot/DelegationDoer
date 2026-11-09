import type { RefRegistry } from "@/lib/exec/agent/refs";
import type { CappedList } from "@/lib/exec/agent/types";
import type { ExecTextBlockParam, ExecToolResultBlockParam } from "@/lib/exec/llm/request";
import type { TextBudget } from "@/lib/exec/text/untrusted";

// Tool-result serialization (P5b contract §3.6; Area B; pure): capped lists
// (C53), the JSON "<" escape (C47 (2)), the result builder with its
// delivered-ref walk (C39), and the turn's consulted-thread budget (C41).
// Imports types only; nothing here logs or stores anything.

export const RESULT_JSON_CHARS = 16_000;

/** C53 (b-agent-9): the one helper for every capped list. total defaults to items.length; pass the true total when the
 *  source counted more than it returned. truncated = total > the returned count. */
export function capList<T>(items: readonly T[], cap: number, total?: number): CappedList<T> {
  const limit = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 0;
  const kept = items.slice(0, limit);
  const count = typeof total === "number" && Number.isFinite(total) ? Math.max(Math.floor(total), kept.length) : items.length;
  return { items: kept, total: count, truncated: count > kept.length };
}

// The six-character JSON escape for U+003C: a backslash, then "u003c". Built in code (§0 rule 12).
const LT_ESCAPE = String.fromCharCode(92) + "u003c";

/** C47 (2): every "<" in a serialized JSON string becomes the six-character JSON escape for U+003C (a backslash, then
 *  "u003c"), built from String.fromCharCode(92) + "u003c" and never typed into a source file (§0 rule 12). JSON.parse
 *  reads it back as "<", so the model sees the same data, but no string value can open or close an untrusted block. */
export function escapeJsonLt(json: string): string {
  if (typeof json !== "string" || json === "") return "";
  return json.split("<").join(LT_ESCAPE);
}

export interface ToolResultDraft {
  /** Free-text values already through neutralizeChatText; every list a CappedList. */
  json: Record<string, unknown>;
  /** The result's DD text items; null when it has none. */
  budget: TextBudget | null;
  /** Tool 11 only: the email blocks, ids "M<i>". */
  emailBlocks?: { id: string; block: string }[];
}

type Json = unknown;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A CappedList node: exactly items (an array), total (a number) and truncated (a boolean). */
function isCappedList(v: unknown): v is CappedList<unknown> {
  if (!isRecord(v)) return false;
  const keys = Object.keys(v);
  return (
    Array.isArray(v.items) &&
    typeof v.total === "number" &&
    typeof v.truncated === "boolean" &&
    keys.every((k) => k === "items" || k === "total" || k === "truncated" || k === "total_is_lower_bound" || k === "email_screen" || k === "email_hidden")
  );
}

function cappedLists(root: Json): CappedList<unknown>[] {
  const out: CappedList<unknown>[] = [];
  const visit = (v: Json): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isRecord(v)) return;
    if (isCappedList(v)) out.push(v);
    for (const x of Object.values(v)) visit(x);
  };
  visit(root);
  return out;
}

const REF_VALUE = /^r[0-9]{1,5}$/;
// "sources" is the attention shape's list of source refs (§3.11.2, security-5); elsewhere it holds no ref-shaped value.
const isRefKey = (k: string) => k === "ref" || k === "refs" || k === "sources" || k.endsWith("_ref") || k.endsWith("_refs");

/** C39: every ref under a ref key ("ref", "refs", "sources", "*_ref", "*_refs"), as a string or an array of strings. */
function refsIn(root: Json): string[] {
  const out: string[] = [];
  const visit = (v: Json): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isRecord(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (isRefKey(k)) {
        if (typeof x === "string" && REF_VALUE.test(x)) out.push(x);
        else if (Array.isArray(x)) for (const y of x) if (typeof y === "string" && REF_VALUE.test(y)) out.push(y);
      }
      visit(x);
    }
  };
  visit(root);
  return out;
}

/** Every string value in the JSON (block ids are looked up among them). */
function stringsIn(root: Json): Set<string> {
  const out = new Set<string>();
  const visit = (v: Json): void => {
    if (typeof v === "string") out.add(v);
    else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (isRecord(v)) for (const x of Object.values(v)) visit(x);
  };
  visit(root);
  return out;
}

const OVERSIZE_NOTE = "This result was too large to return; ask for a narrower view.";

const isBlank = (s: string) => s.trim() === "";

/**
 * Builds a tool_result's content:
 *  1. JSON.stringify(json) (with "<" escaped). While it exceeds RESULT_JSON_CHARS: drop the last item of the longest
 *     CappedList (the one whose serialized form is largest; its truncated → true, its total kept), and set top-level
 *     "truncated": true and "left_out": <items dropped>. If no list has an item left, the result is replaced by a short
 *     note.
 *  2. Blocks whose id no longer appears in the JSON are dropped.
 *  3. C39: the refs under a ref key of the FINAL JSON, plus the ref of every kept block, go to refs.markDelivered.
 *  4. content = [{ type: "text", text: escapeJsonLt(json) }, …each kept block as one text block]; no block empty.
 * The draft's json is not modified (a structured copy is trimmed).
 */
export function serializeToolResult(draft: ToolResultDraft, refs: RefRegistry): ExecToolResultBlockParam["content"] {
  const json = structuredClone(draft.json) as Record<string, unknown>;
  let leftOut = 0;
  let text = escapeJsonLt(JSON.stringify(json));
  let final: Record<string, unknown> = json;
  while (text.length > RESULT_JSON_CHARS) {
    const lists = cappedLists(json).filter((l) => l.items.length > 0);
    if (lists.length === 0) {
      final = { truncated: true, left_out: leftOut, notes: [OVERSIZE_NOTE] };
      text = JSON.stringify(final);
      break;
    }
    let longest = lists[0];
    let longestSize = JSON.stringify(longest.items).length;
    for (const l of lists.slice(1)) {
      const size = JSON.stringify(l.items).length;
      if (size > longestSize) {
        longest = l;
        longestSize = size;
      }
    }
    longest.items.pop();
    longest.truncated = true;
    leftOut += 1;
    json.truncated = true;
    json.left_out = leftOut;
    text = escapeJsonLt(JSON.stringify(json));
  }

  const present = stringsIn(final);
  const ddBlocks = (draft.budget?.blocks() ?? []).filter((b) => present.has(b.id) && !isBlank(b.block));
  const emailBlocks = (draft.emailBlocks ?? []).filter((b) => present.has(b.id) && !isBlank(b.block));

  const delivered = new Set(refsIn(final));
  for (const b of ddBlocks) if (b.ref !== null && REF_VALUE.test(b.ref)) delivered.add(b.ref);
  refs.markDelivered(delivered);

  const content: ExecTextBlockParam[] = [{ type: "text", text }];
  for (const b of [...ddBlocks, ...emailBlocks]) content.push({ type: "text", text: b.block });
  return content;
}

/** C41: the turn's budget of consulted threads from tools and intake links (cited-source threads are added at finish). */
export class ConsultedBudget {
  private readonly max: number;
  private readonly ids = new Set<string>();

  /** default 500 */
  constructor(max: number = 500) {
    this.max = Number.isFinite(max) && max >= 0 ? Math.floor(max) : 500;
  }

  /** Admits as many of ids as fit, in order, and returns the admitted ones; ids already admitted are free. Synchronous:
   *  a tool calls it and pushes the admitted items with no await in between, so parallel tools can't overshoot. */
  admit(ids: readonly string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (this.ids.has(id)) {
        out.push(id);
        continue;
      }
      if (this.ids.size >= this.max) continue;
      this.ids.add(id);
      out.push(id);
    }
    return out;
  }

  /** Already admitted this turn (additive helper: an email tool re-reading an admitted thread is free). */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  get full(): boolean {
    return this.ids.size >= this.max;
  }

  values(): string[] {
    return [...this.ids];
  }
}

/** P7b (contract §3.17.3 D2, N15): the privacies a Slack result can carry; every one but "public" sets the private flag. */
type SlackConsultPrivacy = "public" | "private" | "group_dm" | "dm" | "external" | "finance";

/**
 * P7b (§3.15.2 "Consulted", N15, C24): the turn's Slack consults. Every stored item, digest or live message that reaches a
 * result is admitted here first, with its ref keys (m:<C>:<ts> / d:<C>:<date>:<n>) and its channel; at most 600 keys and
 * 200 channels (exec_messages' CHECKs). admit is all-or-nothing and synchronous (P5b C41's pattern: no await between the
 * admit and the push, so parallel tools can't overshoot): false = it doesn't fit, nothing was recorded and the caller
 * drops the item. Already-admitted keys and channels are free. A non-public privacy sets the private flag (C24's
 * private_slack). Pure: no I/O, nothing logged.
 */
export class SlackConsultedBudget {
  private readonly maxRefs: number;
  private readonly maxChannels: number;
  private readonly refs = new Set<string>();
  private readonly channels = new Set<string>();
  private privateSeen = false;

  /** defaults 600 / 200 */
  constructor(maxRefs: number = 600, maxChannels: number = 200) {
    this.maxRefs = Number.isFinite(maxRefs) && maxRefs >= 0 ? Math.floor(maxRefs) : 600;
    this.maxChannels = Number.isFinite(maxChannels) && maxChannels >= 0 ? Math.floor(maxChannels) : 200;
  }

  admit(refKeys: readonly string[], channelId: string, privacy: SlackConsultPrivacy): boolean {
    if (typeof channelId !== "string" || channelId.length === 0) return false;
    const keys = [...new Set((Array.isArray(refKeys) ? refKeys : []).filter((k): k is string => typeof k === "string" && k.length > 0))];
    const newKeys = keys.filter((k) => !this.refs.has(k)).length;
    const newChannel = this.channels.has(channelId) ? 0 : 1;
    if (this.refs.size + newKeys > this.maxRefs || this.channels.size + newChannel > this.maxChannels) return false;
    for (const k of keys) this.refs.add(k);
    this.channels.add(channelId);
    if (privacy !== "public") this.privateSeen = true;
    return true;
  }

  /** At a limit: the next new key or channel is refused. */
  get full(): boolean {
    return this.refs.size >= this.maxRefs || this.channels.size >= this.maxChannels;
  }

  /** Whether a non-public Slack result was admitted this turn. */
  get privateSlack(): boolean {
    return this.privateSeen;
  }

  snapshot(): { refs: string[]; channels: string[]; privateSlack: boolean } {
    return { refs: [...this.refs], channels: [...this.channels], privateSlack: this.privateSeen };
  }
}
