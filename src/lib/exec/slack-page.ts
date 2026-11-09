import "server-only";

import { isActiveClientStatus } from "@/lib/exec/correlate";
import { MISSING, ageLabel } from "@/lib/exec/format";
import { loadSettings } from "@/lib/exec/principal";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { listDigestViews, slackCatchUpCounts } from "@/lib/exec/slack-digests";
import { listChannelLinks, slackIntelSchemaReady, slackIntelState } from "@/lib/exec/slack-intel-store";
import {
  SLACK_INTEL_LIMITS,
  compareTs,
  slackItemPolicy,
  type ChannelRow,
  type DigestStatus,
  type SlackCatchUpCounts,
  type SlackChannelLink,
  type SlackDigestRow,
  type SlackIntelState,
  type SlackItemKind,
  type SlackItemRow,
  type SlackPrivacy
} from "@/lib/exec/slack-intel-types";
import { tsToMs } from "@/lib/exec/slack-read-types";
import { listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import { listClients, listProjects } from "@/lib/exec/sources/dd";
import { localDateString, startOfLocalDayUtc } from "@/lib/exec/time";
import type { ExecPrincipal } from "@/lib/exec/types";
import type { Section } from "@/lib/exec/view-types";

// The /executive/slack page's view (P7b contract §3.12.1, N19, C7, C28; Area F; server-only): catch-up (open items to
// him that need a response, through P7a's C20-screened listOpenSlackItems and slackItemPolicy("page")) and the
// selected day's digests (slackUsePolicy("page"), watched channels only, 1:1 DMs excluded). Each section fails soft.
//
//   * The state (C1) decides everything: unless it is "ok" nothing else is read and the page shows the state's copy.
//   * Catch-up: listOpenSlackItems(now − 14 d, 200, surface "web") → needsResponse ∧ unanswered → slackItemPolicy("page")
//     per item against the channel row P7a's facade returns (listIntelChannels); a muted or unwatched channel's item shows
//     only through P7a's bypass, and the rest are counted (hiddenMuted, the policy's "not_bypass"). ≤ 50 rows, newest
//     first by ts (compareTs). `quote` is P7a's stored excerpt (never for an external author), shown read-only here and
//     nowhere else; the field is deliberately not named excerpt (B-P7a-6). A permalink only when isAllowedLinkUrl.
//   * Digests: Area C's listDigestViews for the selected local date (watched channels, never a 1:1 DM; "not built" cards
//     for channels active that day), ≤ 30 cards, the rest counted (channelsWithoutDigest).
//   * Counts: Area C's slackCatchUpCounts (the Overview tile's numbers).
//
// Also here (additive, the Settings picker's tags, AM-P7b-6): getSlackPickerTags reads the conversations P7a's facade
// lists, their link rows, DD's clients and projects, and computes C25's taggable predicate on the server from the P7a
// ChannelRow (the same predicate RPC 1 enforces).
//
// Nothing here logs content (§0.3 rule 4): a failed section logs its fixed name, the principal id and the error's name.

/** `quote` is P7a's stored excerpt, shown read-only; the field is deliberately not named `excerpt` (B-P7a-6 flags that
 *  property name in any Slack file outside P7a's three). */
export interface CatchUpRow { itemId: string; kind: SlackItemKind; channelLabel: string; privacy: SlackPrivacy; at: string;
  summary: string | null; quote: string | null; assessed: boolean; permalink: string | null; ageLabel: string }
export interface DigestCardView { digestId: string | null; channelId: string; channelLabel: string; privacy: SlackPrivacy; date: string;
  status: DigestStatus | "not_built"; summary: string | null; highlights: { text: string; permalink: string | null }[];
  decisions: { text: string; permalink: string | null }[]; openQuestions: { text: string; permalink: string | null }[];
  counts: SlackDigestRow["counts"] | null; partial: boolean; canBuild: boolean; clientName: string | null }
export interface SlackPageView {
  generatedAt: string; timezone: string; state: SlackIntelState;
  date: { selected: string; label: string; options: { value: string; label: string }[] };
  catchUp: Section<{ rows: CatchUpRow[]; total: number; hiddenMuted: number }>;
  digests: Section<{ cards: DigestCardView[]; channelsWithoutDigest: number }>;
  counts: Section<SlackCatchUpCounts>;
}

const DAY_MS = 86_400_000;
/** One budget for the page's reads (the caller's signal is honoured too). */
const READ_TIMEOUT_MS = 15_000;
/** §3.12.1: the selected date is today, yesterday or one of the last 7 local days. */
const PAGE_DAYS = 7;
const DIGEST_CARDS = 30;
/** Read past the 30 shown so the rest can be counted (Area C: "pass a limit above 30"). */
const DIGEST_READ_LIMIT = 500;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHANNEL_LABEL_MAX = 80;
const UNAVAILABLE = { ok: false, error: "unavailable" } as const;
const EMPTY_COUNTS: SlackCatchUpCounts = Object.freeze({ unanswered: 0, decisionsPending: 0, notAssessed: 0 });

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

/** "#name" for a named channel (P7a stores a name only for standard/external/finance channels), else its kind's words.
 *  The name is cut to Slack's own character set, so a hostile stored value renders as plain text of bounded length. */
export function slackChannelLabel(ch: Pick<ChannelRow, "convType" | "name"> | null | undefined): string {
  if (!ch) return "Channel";
  const raw = typeof ch.name === "string" ? ch.name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, CHANNEL_LABEL_MAX - 1) : "";
  if ((ch.convType === "channel" || ch.convType === "group") && raw.length > 0) return `#${raw}`;
  if (ch.convType === "mpim") return "Group DM";
  if (ch.convType === "im") return "Direct message";
  return ch.convType === "group" ? "Private channel" : "Channel";
}

/** A Slack ts as an ISO instant (P7a's tsToMs); null for a malformed ts. */
export function slackTsIso(ts: string): string | null {
  try {
    return new Date(tsToMs(ts)).toISOString();
  } catch {
    return null;
  }
}

/** Newest first by ts (P7a's numeric compareTs); a malformed ts sorts last, ties by id. */
function byTsDesc(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  let c = 0;
  try {
    c = compareTs(b.ts, a.ts);
  } catch {
    c = 0;
  }
  return c !== 0 ? c : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** "3 h ago", "just now", or "—". */
function agoText(iso: string, now: Date): string {
  const age = ageLabel(iso, now);
  return age === MISSING || age === "just now" ? age : `${age} ago`;
}

const weekdayLabel = (localDate: string): string => {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
};

/** The page's date choice (§3.12.1, UI07): today, yesterday and the 5 local days before them (the last 7 local days, his
 *  zone, DST-correct through startOfLocalDayUtc). `requested` is ?date= as given: "today", "yesterday" or one of those
 *  YYYY-MM-DD dates; anything else falls back to yesterday. `localDate` is the chosen day itself. */
export function slackPageDates(now: Date, tz: string, requested: string | null | undefined): SlackPageView["date"] & { localDate: string } {
  const dates: string[] = [localDateString(now, tz)];
  let start = startOfLocalDayUtc(now, tz);
  for (let i = 1; i < PAGE_DAYS; i += 1) {
    start = startOfLocalDayUtc(new Date(start.getTime() - 1), tz);
    dates.push(localDateString(start, tz));
  }
  const options = dates.map((d, i) => ({ value: i === 0 ? "today" : i === 1 ? "yesterday" : d, label: i === 0 ? "Today" : i === 1 ? "Yesterday" : weekdayLabel(d) }));
  let index = 1;
  if (requested === "today") index = 0;
  else if (requested === "yesterday") index = 1;
  else if (typeof requested === "string" && LOCAL_DATE_RE.test(requested) && dates.includes(requested)) index = dates.indexOf(requested);
  return { selected: options[index].value, label: options[index].label, options, localDate: dates[index] };
}

/** One combined signal: the caller's and the page's own deadline. */
function deadlineSignal(caller: AbortSignal | undefined, ms: number): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!caller) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, deadline]);
  const controller = new AbortController();
  const abort = (from: AbortSignal) => () => controller.abort(from.reason);
  if (caller.aborted) controller.abort(caller.reason);
  else {
    caller.addEventListener("abort", abort(caller), { once: true });
    deadline.addEventListener("abort", abort(deadline), { once: true });
  }
  return controller.signal;
}

/** Resolves with `work` or rejects once `signal` aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function soft<T>(principal: ExecPrincipal, what: "catch-up" | "digests" | "counts", signal: AbortSignal, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await untilAborted(Promise.resolve().then(run), signal) };
  } catch (err) {
    console.error(`[exec-slack-page] ${what} failed for ${principal.id} (${errName(err)})`);
    return UNAVAILABLE;
  }
}

/** One catch-up row from a stored item the policy allowed (the AI summary only once assessed; no author anywhere). */
function catchUpRow(item: SlackItemRow, ch: ChannelRow, privacy: SlackPrivacy, now: Date): CatchUpRow {
  const at = slackTsIso(item.ts) ?? item.createdAt;
  const summary = item.assessed && typeof item.summary === "string" && item.summary.trim().length > 0 ? item.summary : null;
  const quote = item.authorExternal !== true && typeof item.excerpt === "string" && item.excerpt.trim().length > 0 ? item.excerpt : null;
  return {
    itemId: item.id,
    kind: item.kind,
    channelLabel: slackChannelLabel(ch),
    privacy,
    at,
    summary,
    quote,
    assessed: item.assessed === true,
    permalink: typeof item.permalink === "string" && isAllowedLinkUrl(item.permalink) ? item.permalink : null,
    ageLabel: agoText(at, now)
  };
}

async function readCatchUp(principal: ExecPrincipal, state: SlackIntelState, now: Date, signal: AbortSignal):
  Promise<{ rows: CatchUpRow[]; total: number; hiddenMuted: number }> {
  // Fixer ui-8 / ui-9: P7a's throwing read (a failure is this card's "Couldn't load", never "Nothing in Slack is waiting
  // on you"), and its count of open items the C20 screen withheld only because their conversation is muted (the screen
  // drops them before P7b sees them, so the policy below alone would always count 0).
  const { items, mutedHidden } = await readOpenSlackItems(principal, {
    sinceIso: new Date(now.getTime() - SLACK_INTEL_LIMITS.catchUpWindowDays * DAY_MS).toISOString(),
    limit: SLACK_INTEL_LIMITS.catchUpReadRows,
    surface: "web"
  });
  signal.throwIfAborted();
  const open = items.filter((i) => i.needsResponse === true && i.respondedAt === null);
  if (open.length === 0) return { rows: [], total: 0, hiddenMuted: mutedHidden };
  const ids = [...new Set(open.map((i) => i.channelId))];
  const channels = new Map((await listIntelChannels(principal, { channelIds: ids, signal })).map((c) => [c.channelId, c]));
  let hiddenMuted = mutedHidden;
  const kept: { item: SlackItemRow; ch: ChannelRow; privacy: SlackPrivacy }[] = [];
  for (const item of open) {
    const ch = channels.get(item.channelId) ?? null;
    const verdict = slackItemPolicy(state, ch, item, "page");
    if (!verdict.allowed) {
      if (verdict.reason === "not_bypass") hiddenMuted += 1;
      continue;
    }
    kept.push({ item, ch: ch as ChannelRow, privacy: verdict.privacy });
  }
  kept.sort((a, b) => byTsDesc(a.item, b.item));
  return {
    rows: kept.slice(0, SLACK_INTEL_LIMITS.catchUpRows).map((k) => catchUpRow(k.item, k.ch, k.privacy, now)),
    total: kept.length,
    hiddenMuted
  };
}

async function readDigests(principal: ExecPrincipal, state: SlackIntelState, localDate: string, now: Date, signal: AbortSignal):
  Promise<{ cards: DigestCardView[]; channelsWithoutDigest: number }> {
  const all = await listDigestViews(principal, state, { dates: [localDate], use: "page", limit: DIGEST_READ_LIMIT }, { signal, now });
  // listDigestViews already keeps watched channels only and never a 1:1 DM; the date filter is belt and braces.
  const cards = all.filter((c) => c.date === localDate && c.privacy !== "dm");
  return { cards: cards.slice(0, DIGEST_CARDS), channelsWithoutDigest: Math.max(0, cards.length - DIGEST_CARDS) };
}

/** §3.12.1. The settings read is the only read that throws (the page can't tell what to show without it: the segment's
 *  error page); every other read fails inside its own section. Nothing but the state is read unless the state is "ok". */
export async function getSlackPageView(principal: ExecPrincipal, q: { date: string }, opts: { now: Date; signal?: AbortSignal }): Promise<SlackPageView> {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) throw new TypeError("slack page: an ExecPrincipal is required");
  const now = opts?.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
  const tz = principal.timezone;
  const signal = deadlineSignal(opts?.signal, READ_TIMEOUT_MS);
  const date = slackPageDates(now, tz, q?.date);
  const settings = await loadSettings(principal.id);
  const state = await slackIntelState(principal, settings, { signal });
  const { localDate, ...dateView } = date;
  const base = { generatedAt: now.toISOString(), timezone: tz, state, date: dateView };
  if (state !== "ok") {
    return {
      ...base,
      catchUp: { ok: true, data: { rows: [], total: 0, hiddenMuted: 0 } },
      digests: { ok: true, data: { cards: [], channelsWithoutDigest: 0 } },
      counts: { ok: true, data: { ...EMPTY_COUNTS } }
    };
  }
  const [catchUp, digests, counts] = await Promise.all([
    soft(principal, "catch-up", signal, () => readCatchUp(principal, state, now, signal)),
    soft(principal, "digests", signal, () => readDigests(principal, state, localDate, now, signal)),
    soft(principal, "counts", signal, async () => (await slackCatchUpCounts(principal, state, { signal, now })) ?? { ...EMPTY_COUNTS })
  ]);
  opts?.signal?.throwIfAborted();
  return { ...base, catchUp, digests, counts };
}

// ---------------------------------------------------------------------------
// The Settings picker's tags (§3.12.4, C25, AM-P7b-6)
// ---------------------------------------------------------------------------

export interface SlackTagOption { id: string; name: string }
/** What the picker's tags control needs, per conversation and once for the lists (serializable: it crosses into the client
 *  picker as a prop). `taggable` is C25 on the server's P7a ChannelRow; `links` is the stored link row (null: none yet). */
export interface SlackPickerTags {
  byChannel: Record<string, { taggable: boolean; links: SlackChannelLink | null }>;
  clients: (SlackTagOption & { active: boolean })[];
  projects: SlackTagOption[];
}

const TAG_NAME_MAX = 200;
const TAG_LIST_MAX = 2_000;

/** C25 (the predicate RPC 1 enforces): class standard, external or finance; not a 1:1 DM; not unwatched; not left. */
export function taggableChannel(ch: Pick<ChannelRow, "class" | "convType" | "watchState" | "leftAt"> | null | undefined): boolean {
  if (!ch) return false;
  if (ch.class !== "standard" && ch.class !== "external" && ch.class !== "finance") return false;
  if (ch.convType !== "channel" && ch.convType !== "group" && ch.convType !== "mpim") return false;
  if (ch.watchState !== "watched" && ch.watchState !== "muted") return false;
  return ch.leftAt === null || ch.leftAt === undefined;
}

const byName = (a: SlackTagOption, b: SlackTagOption): number => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const optionName = (name: unknown): string => (typeof name === "string" ? name.trim().slice(0, TAG_NAME_MAX) : "");

/** The tags control's data for the Settings picker, or null when tagging isn't possible (the P7a or P7b schema missing)
 *  or anything it needs couldn't be read (the picker then shows no tags; it never shows a half list). Never throws. */
export async function getSlackPickerTags(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<SlackPickerTags | null> {
  try {
    const signal = deadlineSignal(opts.signal, READ_TIMEOUT_MS);
    const settings = await loadSettings(principal.id);
    if (settings.slackReadingSchemaReady !== true) return null;
    if (!(await slackIntelSchemaReady({ signal }))) return null;
    const [channels, links, clients, projects] = await untilAborted(
      Promise.all([listIntelChannels(principal, { signal }), listChannelLinks(principal, { signal }), listClients(principal, { signal }), listProjects(principal, { signal })]),
      signal
    );
    const byChannel: SlackPickerTags["byChannel"] = {};
    for (const ch of channels) {
      if (ch.class === "deny" || ch.class === "hub") continue;
      byChannel[ch.channelId] = { taggable: taggableChannel(ch), links: links.get(ch.channelId) ?? null };
    }
    return {
      byChannel,
      clients: clients
        .map((c) => ({ id: c.id, name: optionName(c.name), active: isActiveClientStatus(c.status) }))
        .filter((c) => c.name.length > 0)
        .sort(byName)
        .slice(0, TAG_LIST_MAX),
      projects: projects
        .map((p) => ({ id: p.id, name: optionName(p.name) }))
        .filter((p) => p.name.length > 0)
        .sort(byName)
        .slice(0, TAG_LIST_MAX)
    };
  } catch (err) {
    console.error(`[exec-slack-page] picker tags unavailable for ${principal?.id ?? "?"} (${errName(err)})`);
    return null;
  }
}
