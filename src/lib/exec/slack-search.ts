import "server-only";

import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { isDdPost } from "@/lib/exec/slack-ingest";
import { getDigestsByIds, listItemKeysLinkedToClient, searchSlackStored } from "@/lib/exec/slack-intel-store";
import {
  SLACK_INTEL_LIMITS,
  compareTs,
  localDateOfTs,
  slackItemPolicy,
  slackUsePolicy,
  storedSearchChannels,
  tsOfDate,
  type ChannelRow,
  type SlackChannelLink,
  type SlackDigestRow,
  type SlackIntelState,
  type SlackItemKind,
  type SlackItemRow,
  type SlackPrivacy
} from "@/lib/exec/slack-intel-types";
import { isRateLimited, isSlackAuthError, openReader, paced } from "@/lib/exec/slack-read";
import { tsToMs, type ReadingInstallation } from "@/lib/exec/slack-read-types";
import { getDdBotIdentity, getSlackItemsByIds, listAuthorOptouts } from "@/lib/exec/slack-reading";
import { slackTextToPlain } from "@/lib/exec/slack-text";
import { getPermalink, readHistory, readReplies, type SlackReadMessage } from "@/lib/exec/sources/slack";
import { clipForModel } from "@/lib/exec/text/untrusted";
import type { ExecPrincipal } from "@/lib/exec/types";

// search_slack's service (P7b contract §3.7, N1, N3, N10, N11, N16, C7, C16, C17, C20; Area D; server-only): P7a's stored
// items and P7b's digests (RPC 5, screened again per item through the facade's getSlackItemsByIds + slackItemPolicy, per
// digest through slackUsePolicy), plus, with includeLive and a channel or a client, the live history of at most 3 channels
// through P7a's openReader + paced (class "triage"). Live reads only here and in slack-digests.ts (B-P7b-7). A hit's model
// text is the field `text`, never a property named `excerpt` (B-P7a-6).
//
// The live read (C16, C17, C20), in order, and nothing before its gate holds:
//   * scope: the one channel named, or the client's channels (channel link high, then low, then channels holding a message
//     link to the client at high or medium in the last 30 days, each group newest activity first), ≤ 3, each passing
//     slackUsePolicy for "live_read" AND for this turn's use (so a finance channel is never read on the Slack surface);
//   * the reader (null → no read, "not_reading"), the DD bot's identity (null tolerated: isDdPost's template arm still
//     holds), the opted-out authors (a read failure → no read, "unavailable": fail closed);
//   * ≤ 2 history pages × 200 per channel within min(sinceDays, 30) days, then ≤ 5 thread reads; ≤ 8 + 8 calls; 30 s;
//   * before any text is kept: DD posts (isDdPost), bot and app messages, any subtype, hidden rows, author-less rows and
//     opted-out authors are dropped, and so is every thread an opted-out author started or replied in (P7a's purge
//     predicate); an external (Slack Connect) author's message, or one with no team in a Slack Connect conversation, is
//     kept as { external: true, text: "" };
//   * matching in memory (every query word, case-insensitive) on slackTextToPlain's text, clipped to 280;
//   * permalinks for the first 10 kept (isAllowedLinkUrl again);
//   * a rate refusal (P7a's limiter or Slack's ratelimited) stops the read (partial, "rate_budget"); an auth-class answer
//     stops it too ("auth"; paced already recorded it and started P7a's user check); the 30 s box → partial.
// Nothing here logs: no query, text, channel name or permalink leaves through a log line, an error or a return other
// than the hits handed to the tool (which puts their text only into its untrusted block).

export interface SlackSearchInput { query: string; channel: string; client: string; kind: SlackItemKind | "any"; sinceDays: 1 | 7 | 30 | 90;
  includeLive: boolean; limit: 10 | 25 }
export interface SlackSearchHit {
  src: "item" | "digest" | "live"; channelId: string; ts: string | null; localDate: string | null; kind: SlackItemKind | null;
  privacy: SlackPrivacy; at: string; channelLabel: string;
  /** Text for the model (summary, excerpt, digest summary or live text): goes only into the TextBudget block. */
  text: string; external: boolean; assessed: boolean; answered: boolean | null;
  permalink: string | null; itemId: string | null; digestId: string | null; rebuilds: number | null;
  /** Fixer security-5: a digest the model flagged as holding an instruction-like message (the tool tells him). */
  injectionSuspected?: boolean;
  /** Fixer security-6: a stored commitment's direction (P7a records only owed_to_mitchell ones; his own aren't stored). */
  direction?: "mitchell_owes" | "owed_to_mitchell" | null;
}

type LiveReason = "needs_scope" | "no_channels" | "not_reading" | "unavailable" | "rate_budget" | "auth" | "time_budget" | "state";
interface LiveResult { read: boolean; channels: number; partial: boolean; reason: LiveReason | null }
interface SearchCtx {
  state: SlackIntelState; use: "chat_web" | "chat_slack"; channels: ReadonlyMap<string, ChannelRow>; links: ReadonlyMap<string, SlackChannelLink>;
  clientId: string | null; channelId: string | null; now: Date; signal: AbortSignal;
}

const L = SLACK_INTEL_LIMITS;
const DAY_MS = 86_400_000;
const CHANNEL_LABEL_MAX = 80;
const ITEM_TEXT_MAX = 1_400;
const KINDS: readonly (SlackItemKind | "any")[] = ["any", "request", "question", "decision", "commitment", "action_item", "fyi"];

/** "#name" for a named channel, else its kind (the tool neutralizes and clips it again). Never logged. */
export function slackChannelLabel(ch: Pick<ChannelRow, "convType" | "name"> | null | undefined): string {
  if (!ch) return "Slack conversation";
  const raw = typeof ch.name === "string" ? ch.name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, CHANNEL_LABEL_MAX - 1) : "";
  if ((ch.convType === "channel" || ch.convType === "group") && raw.length > 0) return `#${raw}`;
  if (ch.convType === "mpim") return "Group DM";
  if (ch.convType === "im") return "Direct message";
  return ch.convType === "group" ? "Private channel" : "Channel";
}

function tsCmp(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  try {
    return compareTs(a, b);
  } catch {
    return 0;
  }
}

/** Newest activity first, then the channel id (stable). */
function byActivity(a: ChannelRow, b: ChannelRow): number {
  return tsCmp(b.lastActivityTs, a.lastActivityTs) || (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0);
}

function tsIso(ts: string): string | null {
  try {
    return new Date(tsToMs(ts)).toISOString();
  } catch {
    return null;
  }
}

function localDate(ts: string, tz: string): string | null {
  try {
    return localDateOfTs(ts, tz);
  } catch {
    return null;
  }
}

/** The query's words: lowercased, whitespace-split, ≤ 200 characters in all. */
function wordsOf(query: string): string[] {
  const q = typeof query === "string" ? query.slice(0, L.searchQueryChars).toLowerCase() : "";
  return q.split(/\s+/).filter((w) => w.length > 0);
}

const matches = (plain: string, words: readonly string[]): boolean => {
  if (words.length === 0) return true;
  const hay = plain.toLowerCase();
  return words.every((w) => hay.includes(w));
};

const safePermalink = (url: string | null | undefined): string | null => (typeof url === "string" && isAllowedLinkUrl(url) ? url : null);

/** The tool's own abort (its timeout or the turn's Stop): never swallowed by a per-read catch. */
function abortedBy(signal: AbortSignal, _err: unknown): boolean {
  return signal.aborted;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Channels whose message links name the client (high or medium) since `sinceIso`, in the order the store gives (newest). */
async function clientMessageChannels(principal: ExecPrincipal, clientId: string, sinceIso: string, signal: AbortSignal): Promise<string[]> {
  const keys = await listItemKeysLinkedToClient(principal, clientId, { sinceIso, limit: 2_000 }, { signal });
  const out: string[] = [];
  for (const k of keys) if ((k.confidence === "high" || k.confidence === "medium") && !out.includes(k.channelId)) out.push(k.channelId);
  return out;
}

/** The channels a channel link names the client in, at the given confidence. */
function linkedChannels(links: ReadonlyMap<string, SlackChannelLink>, clientId: string, confidence: "high" | "low"): string[] {
  const out: string[] = [];
  for (const [channelId, link] of links) if (link.clientId === clientId && link.matchConfidence === confidence) out.push(channelId);
  return out;
}

// ---------------------------------------------------------------------------
// Stored
// ---------------------------------------------------------------------------

function itemText(item: SlackItemRow): string {
  const parts: string[] = [];
  if (typeof item.summary === "string" && item.summary.trim() !== "") parts.push(item.summary.trim());
  // P7a keeps no excerpt for an external author (N10); a stored one is the only verbatim text a stored hit carries.
  if (!item.authorExternal && typeof item.excerpt === "string" && item.excerpt.trim() !== "") parts.push(`Quote: ${item.excerpt.trim()}`);
  return clipForModel(parts.join("\n"), ITEM_TEXT_MAX).text;
}

function digestText(row: SlackDigestRow): string {
  return clipForModel(typeof row.summary === "string" ? row.summary.trim() : "", ITEM_TEXT_MAX).text;
}

async function storedHits(principal: ExecPrincipal, ctx: SearchCtx, input: SlackSearchInput, scope: { full: string[]; bypass: string[] },
  optouts: ReadonlySet<string> | null): Promise<{ hit: SlackSearchHit; rank: number }[]> {
  if (scope.full.length === 0 && scope.bypass.length === 0) return [];
  const sinceIso = new Date(ctx.now.getTime() - input.sinceDays * DAY_MS).toISOString();
  const found = await searchSlackStored(principal, {
    query: typeof input.query === "string" ? input.query.slice(0, L.searchQueryChars) : "",
    channelIds: scope.full,
    bypassChannelIds: scope.bypass,
    kinds: input.kind === "any" ? null : [input.kind],
    sinceIso,
    includeDigests: input.kind === "any",
    limit: Math.min(50, input.limit * 2)
  }, { signal: ctx.signal });
  if (found.length === 0) return [];
  const rankOf = new Map(found.map((f) => [`${f.src}:${f.id}`, f]));
  const itemIds = found.filter((f) => f.src === "item").map((f) => f.id);
  const digestIds = found.filter((f) => f.src === "digest").map((f) => f.id);
  const [items, digests] = await Promise.all([
    itemIds.length > 0 ? getSlackItemsByIds(principal, itemIds, { surface: ctx.use === "chat_slack" ? "slack" : "web", signal: ctx.signal }) : Promise.resolve([]),
    digestIds.length > 0 ? getDigestsByIds(principal, digestIds, { signal: ctx.signal }) : Promise.resolve([])
  ]);
  const tz = principal.timezone;
  const out: { hit: SlackSearchHit; rank: number }[] = [];
  for (const item of items) {
    const ch = ctx.channels.get(item.channelId) ?? null;
    const p = slackItemPolicy(ctx.state, ch, item, ctx.use);
    if (!p.allowed) continue;
    if (optouts !== null && item.authorUserId !== null && optouts.has(item.authorUserId)) continue;
    const f = rankOf.get(`item:${item.id}`);
    out.push({
      rank: f?.rank ?? 0,
      hit: {
        src: "item", channelId: item.channelId, ts: item.ts, localDate: localDate(item.ts, tz), kind: item.kind, privacy: p.privacy,
        at: f?.at ?? tsIso(item.ts) ?? item.createdAt, channelLabel: slackChannelLabel(ch), text: itemText(item), external: item.authorExternal,
        assessed: item.assessed, answered: item.respondedAt !== null, permalink: safePermalink(item.permalink), itemId: item.id, digestId: null,
        rebuilds: null, direction: item.kind === "commitment" ? item.commitmentDirection ?? null : null
      }
    });
  }
  for (const row of digests) {
    const ch = ctx.channels.get(row.channelId) ?? null;
    const p = slackUsePolicy(ctx.state, ch, ctx.use);
    if (!p.allowed || row.status !== "built" || typeof row.summary !== "string" || row.summary.trim() === "") continue;
    const f = rankOf.get(`digest:${row.id}`);
    out.push({
      rank: f?.rank ?? 0,
      hit: {
        src: "digest", channelId: row.channelId, ts: null, localDate: row.localDate, kind: null, privacy: p.privacy, at: f?.at ?? row.builtAt ?? row.requestedAt,
        channelLabel: slackChannelLabel(ch), text: digestText(row), external: false, assessed: true, answered: null, permalink: null, itemId: null,
        digestId: row.id, rebuilds: row.rebuilds, injectionSuspected: row.injectionSuspected === true
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live (C16, C17, C20)
// ---------------------------------------------------------------------------

/** C16's one rule: the named channel, or the client's channels (link high, link low, message links high/medium in 30 days). */
async function liveChannels(principal: ExecPrincipal, ctx: SearchCtx): Promise<ChannelRow[]> {
  const ok = (ch: ChannelRow | undefined): ch is ChannelRow =>
    ch !== undefined && slackUsePolicy(ctx.state, ch, "live_read").allowed && slackUsePolicy(ctx.state, ch, ctx.use).allowed;
  if (ctx.channelId !== null) {
    const ch = ctx.channels.get(ctx.channelId);
    return ok(ch) ? [ch] : [];
  }
  if (ctx.clientId === null) return [];
  const since = new Date(ctx.now.getTime() - L.searchLiveDaysMax * DAY_MS).toISOString();
  const groups: string[][] = [
    linkedChannels(ctx.links, ctx.clientId, "high"),
    linkedChannels(ctx.links, ctx.clientId, "low"),
    await clientMessageChannels(principal, ctx.clientId, since, ctx.signal)
  ];
  const chosen: ChannelRow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const rows = group.map((id) => ctx.channels.get(id)).filter(ok).filter((c) => !seen.has(c.channelId)).sort(byActivity);
    for (const ch of rows) {
      if (chosen.length >= L.searchLiveChannels) break;
      seen.add(ch.channelId);
      chosen.push(ch);
    }
    if (chosen.length >= L.searchLiveChannels) break;
  }
  return chosen;
}

/** A person's own message (before any text is kept): no DD post, bot, app, subtype, hidden row or opted-out author. */
function keepLive(m: SlackReadMessage, ddBot: { userId: string | null; appId: string | null }, optouts: ReadonlySet<string>): boolean {
  if (isDdPost(m, ddBot)) return false;
  if (m.botId !== null || m.botProfile || m.appId !== null || m.subtype !== null || m.hidden || m.user === null) return false;
  return !optouts.has(m.user);
}

class LiveStop extends Error {
  constructor(readonly reason: "rate_budget" | "auth" | "time_budget") {
    super(reason);
    this.name = "LiveStop";
  }
}

async function liveHits(principal: ExecPrincipal, ctx: SearchCtx, input: SlackSearchInput, live: LiveResult): Promise<SlackSearchHit[]> {
  const chosen = await liveChannels(principal, ctx);
  if (chosen.length === 0) {
    live.reason = "no_channels";
    return [];
  }
  let ri: ReadingInstallation | null;
  try {
    ri = await openReader(principal, undefined, { signal: ctx.signal });
  } catch (err) {
    if (abortedBy(ctx.signal, err)) throw err;
    live.reason = err instanceof Error && (err as { errorClass?: unknown }).errorClass === "auth" ? "auth" : "unavailable";
    return [];
  }
  if (ri === null) {
    live.reason = "not_reading";
    return [];
  }
  const reader = ri;
  let optouts: Set<string>;
  try {
    optouts = new Set(await listAuthorOptouts(principal));
  } catch (err) {
    if (abortedBy(ctx.signal, err)) throw err;
    live.reason = "unavailable";
    return [];
  }
  let ddBot: { userId: string | null; appId: string | null } = { userId: null, appId: null };
  try {
    const id = await getDdBotIdentity(reader.row.teamId, { signal: ctx.signal });
    if (id) ddBot = { userId: id.userId, appId: id.appId };
  } catch (err) {
    if (abortedBy(ctx.signal, err)) throw err;
    // Tolerated: the template arm of isDdPost still drops DD's own posts.
  }

  // The 30 s box: its own controller, linked to the tool's signal; a box timeout is a partial read, not an error.
  const box = new AbortController();
  const onAbort = () => box.abort(ctx.signal.reason);
  if (ctx.signal.aborted) box.abort(ctx.signal.reason);
  else ctx.signal.addEventListener("abort", onAbort, { once: true });
  let boxed = false;
  const timer = setTimeout(() => {
    boxed = true;
    box.abort(new LiveStop("time_budget"));
  }, L.searchLiveBudgetMs);
  const signal = box.signal;
  try {
    return await liveRead(principal, ctx, input, live, { reader, chosen, optouts, ddBot, signal, boxed: () => boxed });
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

async function liveRead(principal: ExecPrincipal, ctx: SearchCtx, input: SlackSearchInput, live: LiveResult, r: {
  reader: ReadingInstallation; chosen: readonly ChannelRow[]; optouts: ReadonlySet<string>; ddBot: { userId: string | null; appId: string | null };
  signal: AbortSignal; boxed: () => boolean;
}): Promise<SlackSearchHit[]> {
  const { reader, chosen, optouts, ddBot, signal } = r;

  const days = Math.min(input.sinceDays, L.searchLiveDaysMax);
  const oldest = tsOfDate(new Date(ctx.now.getTime() - days * DAY_MS));
  const latest = tsOfDate(ctx.now);
  const words = wordsOf(input.query);
  const tz = principal.timezone;
  let historyCalls = 0;
  let replyCalls = 0;
  let kept: { m: SlackReadMessage; ch: ChannelRow; privacy: SlackPrivacy; external: boolean; text: string }[] = [];
  const seen = new Set<string>();
  // §0.3 rule 14 (fixer correctness-5): P7a's per-author purge deletes every thread rooted at or holding an opted-out
  // author's message (others' replies may describe their words), so the live read drops those threads whole, root and
  // replies, before anything is returned: the tainted thread roots, per conversation.
  const tainted = new Map<string, Set<string>>();
  const rootOf = (m: SlackReadMessage): string => m.threadTs ?? m.ts;
  const optedOut = (user: string | null): boolean => user !== null && optouts.has(user);
  const taint = (ch: ChannelRow, m: SlackReadMessage): void => {
    const own = optedOut(m.user);
    const parent = m.threadTs !== null && optedOut(m.parentUserId);
    if (!own && !parent) return;
    let set = tainted.get(ch.channelId);
    if (!set) tainted.set(ch.channelId, (set = new Set()));
    set.add(rootOf(m));
  };

  const keep = (m: SlackReadMessage, ch: ChannelRow, privacy: SlackPrivacy) => {
    const key = `${ch.channelId}:${m.ts}`;
    if (seen.has(key) || !keepLive(m, ddBot, optouts)) return false;
    if (tsCmp(m.ts, oldest) < 0 || tsCmp(m.ts, latest) > 0) return false;
    const plain = slackTextToPlain(m.text ?? "");
    if (!matches(plain, words)) return false;
    seen.add(key);
    // N10 / C17 (fixer security-1): P7a's rule (slack-ingest.ts) and the digest's: a missing user_team in a Slack Connect
    // conversation (class external, shared now or ever) counts as external, so its text never reaches the model.
    const extConversation = ch.class === "external" || ch.isExtShared === true || ch.extEver === true;
    const external = m.userTeam !== null ? m.userTeam !== reader.row.teamId : extConversation;
    kept.push({ m, ch, privacy, external, text: external ? "" : clipForModel(plain, L.searchTextChars).text });
    return true;
  };

  /** A Slack failure: rate → stop all; auth → stop all; the box → stop all; the tool's abort → rethrow; else skip. */
  const stopOrSkip = (err: unknown): void => {
    if (ctx.signal.aborted) throw err;
    if (r.boxed() || err instanceof LiveStop) throw new LiveStop("time_budget");
    if (isRateLimited(err)) throw new LiveStop("rate_budget");
    if (isSlackAuthError(err)) throw new LiveStop("auth");
    live.partial = true;
  };

  try {
    for (const ch of chosen) {
      const privacy = slackUsePolicy(ctx.state, ch, ctx.use);
      if (!privacy.allowed) continue;
      const parents: SlackReadMessage[] = [];
      let cursor: string | null = null;
      let read = false;
      for (let page = 0; page < L.searchLivePages; page++) {
        if (historyCalls >= L.searchLiveHistoryCalls) {
          live.partial = true;
          break;
        }
        historyCalls += 1;
        let res: Awaited<ReturnType<typeof readHistory>>;
        try {
          const pageCursor = cursor;
          res = await paced(reader, "conversations.history", "triage", () =>
            readHistory(reader.target, { channel: ch.channelId, oldest, latest, inclusive: true, limit: L.searchLivePageSize, cursor: pageCursor }, { signal }),
          { signal });
        } catch (err) {
          stopOrSkip(err);
          break;
        }
        read = true;
        for (const m of res.messages) {
          taint(ch, m);
          const matched = keep(m, ch, privacy.privacy);
          // An opted-out author's thread is dropped whole: its replies are never read.
          if (m.replyCount > 0 && !optedOut(m.user) && (matched || (m.latestReply !== null && tsCmp(m.latestReply, oldest) >= 0))) parents.push(m);
        }
        if (!res.hasMore || res.nextCursor === null) break;
        cursor = res.nextCursor;
        if (page + 1 >= L.searchLivePages) live.partial = true;
      }
      if (read) live.channels += 1;
      live.read = live.read || read;
      // Threads: ≤ 5 parents a call, ≤ 8 reply reads in all.
      let threads = 0;
      for (const parent of parents) {
        if (threads >= L.searchLiveThreads) break;
        if (replyCalls >= L.searchLiveReplyCalls) {
          live.partial = true;
          break;
        }
        threads += 1;
        replyCalls += 1;
        let res: Awaited<ReturnType<typeof readReplies>>;
        try {
          res = await paced(reader, "conversations.replies", "triage", () =>
            readReplies(reader.target, { channel: ch.channelId, ts: parent.ts, oldest, latest, inclusive: true, limit: L.searchLivePageSize }, { signal }),
          { signal });
        } catch (err) {
          stopOrSkip(err);
          continue;
        }
        for (const m of res.messages) {
          taint(ch, m);
          if (m.ts !== parent.ts) keep(m, ch, privacy.privacy);
        }
      }
    }
  } catch (err) {
    if (!(err instanceof LiveStop)) throw err;
    live.partial = true;
    live.reason = err.reason;
  }
  // The tainted threads go before anything is returned or a permalink is asked for.
  kept = kept.filter((k) => !(tainted.get(k.ch.channelId)?.has(rootOf(k.m)) ?? false));

  // Newest first; permalinks for the first 10 kept (stopped by a rate or auth answer, never by a missing one).
  kept.sort((a, b) => tsCmp(b.m.ts, a.m.ts));
  const permalinks = new Map<string, string | null>();
  if (live.reason !== "auth" && live.reason !== "rate_budget") {
    try {
      for (const k of kept.slice(0, L.searchPermalinksPerCall)) {
        try {
          const url = await paced(reader, "chat.getPermalink", "triage", () => getPermalink(reader.target, k.ch.channelId, k.m.ts, { signal }), { signal });
          permalinks.set(`${k.ch.channelId}:${k.m.ts}`, safePermalink(url));
        } catch (err) {
          stopOrSkip(err);
        }
      }
    } catch (err) {
      if (!(err instanceof LiveStop)) throw err;
      live.partial = true;
      if (live.reason === null) live.reason = err.reason;
    }
  }
  ctx.signal.throwIfAborted();

  return kept.map((k) => ({
    src: "live" as const,
    channelId: k.ch.channelId,
    ts: k.m.ts,
    localDate: localDate(k.m.ts, tz),
    kind: null,
    privacy: k.privacy,
    at: tsIso(k.m.ts) ?? ctx.now.toISOString(),
    channelLabel: slackChannelLabel(k.ch),
    text: k.text,
    external: k.external,
    assessed: true,
    answered: null,
    permalink: permalinks.get(`${k.ch.channelId}:${k.m.ts}`) ?? null,
    itemId: null,
    digestId: null,
    rebuilds: null
  }));
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/** §3.7. The state gate is the caller's too: anything but "ok" returns nothing and reads nothing. */
export async function searchSlack(principal: ExecPrincipal, ctx: { state: SlackIntelState; use: "chat_web" | "chat_slack";
  channels: ReadonlyMap<string, ChannelRow>; links: ReadonlyMap<string, SlackChannelLink>; clientId: string | null; channelId: string | null;
  now: Date; signal: AbortSignal }, input: SlackSearchInput):
  Promise<{ hits: SlackSearchHit[]; total: number; truncated: boolean; live: { read: boolean; channels: number; partial: boolean; reason: string | null } }> {
  const live: LiveResult = { read: false, channels: 0, partial: false, reason: null };
  const limit = input.limit === 25 ? 25 : 10;
  if (ctx.state !== "ok" || !KINDS.includes(input.kind)) {
    live.reason = input.includeLive ? "state" : null;
    return { hits: [], total: 0, truncated: false, live };
  }
  const use = ctx.use === "chat_slack" ? "chat_slack" : "chat_web";
  const c: SearchCtx = { ...ctx, use };

  // 1. Scope (§3.7 step 1).
  const scope = storedSearchChannels(c.state, c.channels.values(), use);
  let full = scope.full;
  let bypass = scope.bypass;
  if (c.channelId !== null) {
    full = full.filter((id) => id === c.channelId);
    bypass = bypass.filter((id) => id === c.channelId);
  } else if (c.clientId !== null) {
    const sinceIso = new Date(c.now.getTime() - input.sinceDays * DAY_MS).toISOString();
    const allowed = new Set([
      ...linkedChannels(c.links, c.clientId, "high"),
      ...linkedChannels(c.links, c.clientId, "low"),
      ...(await clientMessageChannels(principal, c.clientId, sinceIso, c.signal))
    ]);
    full = full.filter((id) => allowed.has(id));
    bypass = bypass.filter((id) => allowed.has(id));
  }

  // The opted-out authors, read once for both paths. A failure leaves the stored path as P7a keeps it (its author purge
  // removes their items in the same transaction that records the opt-out) and stops the live read (fail closed).
  let optouts: Set<string> | null = null;
  try {
    optouts = new Set(await listAuthorOptouts(principal));
  } catch (err) {
    if (abortedBy(c.signal, err)) throw err;
    optouts = null;
  }

  // 2. Stored.
  const stored = await storedHits(principal, c, input, { full, bypass }, optouts);

  // 3. Live.
  let liveFound: SlackSearchHit[] = [];
  if (input.includeLive) {
    if (c.channelId === null && c.clientId === null) live.reason = "needs_scope";
    else if (optouts === null) live.reason = "unavailable";
    else liveFound = await liveHits(principal, c, input, live);
  }

  // 4. Merge: live newest first, then stored by rank (then newest); deduped on (channel, ts), a digest on its id.
  stored.sort((a, b) => b.rank - a.rank || (Date.parse(b.hit.at) || 0) - (Date.parse(a.hit.at) || 0));
  const merged: SlackSearchHit[] = [];
  const keys = new Set<string>();
  for (const hit of [...liveFound, ...stored.map((s) => s.hit)]) {
    const key = hit.ts !== null ? `m:${hit.channelId}:${hit.ts}` : `d:${hit.digestId ?? ""}`;
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(hit);
  }
  return { hits: merged.slice(0, limit), total: merged.length, truncated: merged.length > limit, live };
}
