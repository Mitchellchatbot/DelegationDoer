import "server-only";

import type { RefEntry, RefTarget } from "@/lib/exec/agent/types";
import type { SourceRef } from "@/lib/exec/types";

// The ref registry (P5b contract §3.5; Area B): server-issued refs "r<n>"
// for every tool-result item, numbered per conversation (ref_seq), citable
// only once delivered (C39), prior cited and context refs citable from the
// start (C6, b-agent-8). Refs never carry SourceRef.excerpt. Nothing here
// logs anything.

export const MAX_NEW_REFS_PER_TURN = 400;

const REF_SHAPE = /^r[0-9]{1,5}$/;

/** The SourceRef without its excerpt (refs never carry one). */
function withoutExcerpt(source: SourceRef): SourceRef {
  return { system: source.system, id: source.id, url: source.url, label: source.label, class: source.class };
}

export class RefRegistry {
  private seq: number;
  private readonly byKey = new Map<string, RefEntry>();
  private readonly byRef = new Map<string, RefEntry>();
  /** Prior and context refs: citable from the start. */
  private readonly standing = new Set<string>();
  private readonly issued: RefEntry[] = [];
  private readonly issuedSet = new Set<string>();
  private readonly delivered = new Set<string>();

  /** refSeq = the conversation's ref_seq as the begin RPC returned it (it already counts a reserved context ref).
   *  prior = refs cited in earlier answers (exec_messages.sources). contexts = the context refs of earlier questions,
   *  re-resolved and screened this turn (≤ 5 newest distinct; unavailable ones left out; b-agent-8), plus this turn's
   *  context under its reserved ref (C18). Prior and context refs are citable from the start. */
  constructor(init: { refSeq: number; prior: readonly RefEntry[]; contexts: readonly RefEntry[] }) {
    let seq = Number.isSafeInteger(init.refSeq) && init.refSeq > 0 ? init.refSeq : 0;
    for (const e of [...init.contexts, ...init.prior]) {
      if (!e || typeof e.ref !== "string" || !REF_SHAPE.test(e.ref) || this.byRef.has(e.ref)) continue;
      const entry: RefEntry = { ref: e.ref, target: e.target, source: withoutExcerpt(e.source) };
      this.byRef.set(e.ref, entry);
      this.standing.add(e.ref);
      const key = targetKey(e.target);
      if (!this.byKey.has(key)) this.byKey.set(key, entry);
      // A standing ref above ref_seq (it can't be, but never reuse a number).
      seq = Math.max(seq, Number(e.ref.slice(1)));
    }
    this.seq = seq;
  }

  /** The ref for this target: an existing one (prior, context, or issued earlier this turn) or a new "r<n>"; null past
   *  the per-turn cap. A NEW ref is provisional: it isn't citable until markDelivered sees it (C39). */
  issue(target: RefTarget, source: SourceRef): string | null {
    const key = targetKey(target);
    const existing = this.byKey.get(key);
    if (existing) return existing.ref;
    if (this.issued.length >= MAX_NEW_REFS_PER_TURN) return null;
    this.seq += 1;
    const entry: RefEntry = { ref: `r${this.seq}`, target, source: withoutExcerpt(source) };
    this.byKey.set(key, entry);
    this.byRef.set(entry.ref, entry);
    this.issued.push(entry);
    this.issuedSet.add(entry.ref);
    return entry.ref;
  }

  /** C39: serializeToolResult passes the refs found in a result's FINAL content. Refs not issued this turn are ignored. */
  markDelivered(refs: Iterable<string>): void {
    for (const ref of refs) if (this.issuedSet.has(ref)) this.delivered.add(ref);
  }

  /** Delivered this turn ∪ prior ∪ contexts. Markers (§3.13) and get_source accept only these. */
  isCitable(ref: string): boolean {
    return typeof ref === "string" && (this.standing.has(ref) || this.delivered.has(ref));
  }

  /** isCitable(ref) ? the entry : null. */
  citable(ref: string): RefEntry | null {
    return this.isCitable(ref) ? (this.byRef.get(ref) ?? null) : null;
  }

  /** Every entry issued this turn, delivered or not (diagnostics only). */
  issuedThisTurn(): readonly RefEntry[] {
    return [...this.issued];
  }

  /** The entries issued this turn that reached the model. */
  deliveredThisTurn(): readonly RefEntry[] {
    return this.issued.filter((e) => this.delivered.has(e.ref));
  }

  /** The highest number handed out, delivered or not: numbers are never reused (ref_seq). */
  get refSeq(): number {
    return this.seq;
  }
}

/** Pure: a stable key per target ("task:<id>", "email_thread:<id>", "eod_note:<userId>:<date>", …). */
export function targetKey(t: RefTarget): string {
  switch (t.type) {
    case "task":
    case "client":
    case "project":
    case "person":
    case "department":
    case "email_thread":
    case "attention":
    case "commitment":
    case "meeting":
      return `${t.type}:${t.id}`;
    case "eod_note":
    case "sod_note":
      return `${t.type}:${t.userId}:${t.date}`;
    case "approval":
      return `approval:${t.mechanism}:${t.id ?? ""}`;
    case "page":
      return `page:${t.path}`;
    // P7b (§3.17.3 D4; stage-0 seed, forced by the exhaustive switch): the frozen key formats.
    case "slack_message":
      return `slack_message:${t.channelId}:${t.ts}`;
    case "slack_digest":
      return `slack_digest:${t.channelId}:${t.localDate}:${t.rebuilds}`;
  }
}

function decodeSegment(seg: string): string | null {
  try {
    const out = decodeURIComponent(seg);
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** The path (no query) of a DD ref: its id when that is a path (ddPageRef, execEmailThreadRef), else its url's path. */
function ddPathOf(r: SourceRef): { path: string; query: boolean; fromId: boolean } | null {
  if (r.id.startsWith("/")) {
    const q = r.id.indexOf("?");
    return { path: q < 0 ? r.id : r.id.slice(0, q), query: q >= 0, fromId: true };
  }
  if (typeof r.url !== "string") return null;
  try {
    const u = new URL(r.url);
    return { path: u.pathname, query: u.search !== "", fromId: false };
  } catch {
    return null;
  }
}

/** Pure: map a SourceRef from P2b/P3 builders to a target. dd /tasks/<id> → task, /clients/<id> → client,
 *  /projects/<id> → project, /team/<id> → person, /executive/email/<id> → email_thread; outlook → email_thread
 *  (id = thread id); anything else → page. */
export function targetFromSourceRef(r: SourceRef): RefTarget {
  if (r.system === "outlook") return { type: "email_thread", id: r.id };
  if (r.system === "slack") return slackTargetOf(r);
  if (r.system !== "dd") return { type: "page", path: typeof r.url === "string" ? r.url : r.id };
  const at = ddPathOf(r);
  if (at === null) return { type: "page", path: r.id };
  const parts = at.path.split("/").filter((p) => p !== "");
  if (!at.query) {
    // ddTaskRef / ddClientRef / ddProjectRef keep the record id as the ref id; a path ref carries it in the path.
    const idOf = (seg: string) => (at.fromId ? decodeSegment(seg) : r.id);
    if (parts.length === 2) {
      const [section, seg] = parts;
      const id = idOf(seg);
      if (id !== null) {
        if (section === "tasks") return { type: "task", id };
        if (section === "clients") return { type: "client", id };
        if (section === "projects") return { type: "project", id };
        if (section === "team") return { type: "person", id };
      }
    }
    if (parts.length === 3 && parts[0] === "executive" && parts[1] === "email" && parts[2] !== "drafts") {
      const id = decodeSegment(parts[2]);
      if (id !== null) return { type: "email_thread", id };
    }
  }
  return { type: "page", path: r.id.startsWith("/") ? r.id : at.path };
}

const SLACK_CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;
const SLACK_TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const SLACK_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** P7b (§3.15.2 Refs, D4): a Slack SourceRef's id "<C>:<ts>" (slackMessageRef) → slack_message (no item id: get_source
 *  then says it was read live), "<C>:d:<YYYY-MM-DD>" (slackDigestRef) → slack_digest with rebuilds -1 (a SourceRef doesn't
 *  carry the generation: get_source reads the day's current row); anything else stays a page. */
function slackTargetOf(r: SourceRef): RefTarget {
  const parts = typeof r.id === "string" ? r.id.split(":") : [];
  if (parts.length === 2 && SLACK_CHANNEL.test(parts[0]) && SLACK_TS.test(parts[1])) {
    return { type: "slack_message", channelId: parts[0], ts: parts[1], itemId: null };
  }
  if (parts.length === 3 && SLACK_CHANNEL.test(parts[0]) && parts[1] === "d" && SLACK_DATE.test(parts[2])) {
    return { type: "slack_digest", channelId: parts[0], localDate: parts[2], rebuilds: -1 };
  }
  return { type: "page", path: typeof r.url === "string" ? r.url : r.id };
}

/** The email thread a target carries data from, or null (C19). */
export function threadOfTarget(t: RefTarget): string | null {
  switch (t.type) {
    case "email_thread":
      return t.id;
    case "attention":
      return t.threadId;
    case "commitment":
      return t.threadId;
    default:
      return null;
  }
}
