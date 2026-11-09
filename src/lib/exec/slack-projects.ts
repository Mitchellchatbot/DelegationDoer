import "server-only";

import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { dayBounds, listDigestViews } from "@/lib/exec/slack-digests";
import { listChannelsLinkedToClient, listProjectItemIds, searchSlackStored, slackIntelState } from "@/lib/exec/slack-intel-store";
import {
  SLACK_INTEL_LIMITS,
  compareTs,
  slackItemPolicy,
  storedSearchChannels,
  type ChannelRow,
  type SlackIntelState,
  type SlackItemKind,
  type SlackItemRow,
  type SlackPrivacy
} from "@/lib/exec/slack-intel-types";
import { slackChannelLabel, slackTsIso } from "@/lib/exec/slack-page";
import { getSlackItemsByIds, listIntelChannels } from "@/lib/exec/slack-reading";
import { localDateString, startOfLocalDayUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import type { DerivedClient } from "@/lib/exec/view-types";

// The Projects tab's Slack section (P7b contract §3.12.3, C19, P7-4; Area F; server-only): "Linked to this project's
// work" (record), "In <client>'s channels" (derived, channel link high), "Mentions" (AI-assessed). Rows show the AI
// summary only (never the excerpt), through the facade's screened getSlackItemsByIds and slackItemPolicy("page").
//
//   linked          RPC 4 (listProjectItemIds: message links to the project or its tasks, their thread replies, items in
//                   channels tagged to the project; 30 days, 3 × the 10 shown) → getSlackItemsByIds(surface "web", P7a's
//                   own C20 screen) → slackItemPolicy("page") → ≤ 10, newest first.
//   clientChannels  only with a derived client: the conversations whose link names it at high (a tag) → RPC 5 with an
//                   empty query over those of them storedSearchChannels allows (watched: every item; owner- or Slack-muted:
//                   bypass items only) → the same two screens → ≤ 10 items, plus ≤ 5 built digests of the last 7 days
//                   (Area C's listDigestViews: watched channels only).
//   mentions        RPC 5 over every allowed conversation with the project's name and the derived client's name (each
//                   ≥ 4 characters) as a phrase → the same two screens → kept only when the item's AI summary itself names
//                   one of them (word-bounded, case-insensitive) → not already shown → ≤ 5, newest first.
//
// An item with no summary (not assessed: P7a stores no summary and no excerpt for it) has nothing to show here and is
// left out. No author, no per-person count, no excerpt (P7-4, C29). A failed read throws: the caller (projects-view.ts)
// races this against 10 s and turns a throw into the section's "Couldn't load".

export interface SlackProjectRow { itemId: string | null; digestId: string | null; kind: SlackItemKind | "digest"; channelLabel: string;
  privacy: SlackPrivacy; at: string; summary: string; basis: "record" | "derived" | "ai"; via: "link" | "thread" | "tag" | "client_channel" | "mention";
  permalink: string | null }
export interface ProjectSlackSection { state: SlackIntelState; linked: SlackProjectRow[]; clientChannels: SlackProjectRow[];
  mentions: SlackProjectRow[]; derivedClientName: string | null }

const DAY_MS = 86_400_000;
const DIGEST_DAYS = 7;
/** Area C's cards include "not built" ones; read enough to keep 5 built ones. */
const DIGEST_READ_LIMIT = 60;
const MENTION_READ_LIMIT = 50;
const MIN_NAME_CHARS = 4;
const QUERY_MAX = SLACK_INTEL_LIMITS.searchQueryChars - 2;
const ITEM_IDS_MAX = 500;

/** The last `n` local dates in tz, today first (DST-correct). */
function lastLocalDates(now: Date, tz: string, n: number): string[] {
  const out = [localDateString(now, tz)];
  let start = startOfLocalDayUtc(now, tz);
  for (let i = 1; i < n; i += 1) {
    start = startOfLocalDayUtc(new Date(start.getTime() - 1), tz);
    out.push(localDateString(start, tz));
  }
  return out;
}

/** The start of a digest's local day as an ISO instant (Area C's dayBounds; null for a date that isn't one). */
function digestDayIso(localDate: string, tz: string): string | null {
  try {
    return slackTsIso(dayBounds(localDate, tz).fromTs);
  } catch {
    return null;
  }
}

/** A name usable for a mention: trimmed, at least 4 characters (code points), with a letter or digit. */
function mentionName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const t = name.trim().replace(/\s+/g, " ");
  if ([...t].length < MIN_NAME_CHARS || !/[\p{L}\p{N}]/u.test(t)) return null;
  return t;
}

/** RPC 5's websearch query for a name, as one phrase (quotes and backslashes dropped, so nothing in the name is an operator). */
function phraseQuery(name: string): string {
  const inner = name.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX);
  return `"${inner}"`;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The word-bounded, case-insensitive test of a summary for a name (letters and digits of any script bound a word). */
export function summaryNames(summary: string, name: string): boolean {
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?:$|[^\\p{L}\\p{N}])`, "iu");
  return re.test(summary);
}

function newestFirst(a: { at: string; key: string }, b: { at: string; key: string }): number {
  const d = Date.parse(b.at) - Date.parse(a.at);
  if (Number.isFinite(d) && d !== 0) return d;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function tsNewestFirst(a: SlackItemRow, b: SlackItemRow): number {
  let c = 0;
  try {
    c = compareTs(b.ts, a.ts);
  } catch {
    c = 0;
  }
  return c !== 0 ? c : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** §3.12.3. A failed read throws (the caller makes the section "Couldn't load"); nothing but the state is read unless it is ok. */
export async function getProjectSlackSection(principal: ExecPrincipal, settings: ExecSettings,
  q: { projectId: string; projectName: string; taskIds: readonly string[]; derivedClient: DerivedClient | null }, opts: { now: Date; signal?: AbortSignal }):
  Promise<ProjectSlackSection> {
  const signal = opts?.signal;
  const now = opts?.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
  const derived = q?.derivedClient ?? null;
  const derivedClientName = derived !== null && typeof derived.clientName === "string" && derived.clientName.length > 0 ? derived.clientName : null;
  const state = await slackIntelState(principal, settings, { signal });
  const empty: ProjectSlackSection = { state, linked: [], clientChannels: [], mentions: [], derivedClientName };
  if (state !== "ok" || typeof q?.projectId !== "string" || q.projectId.length === 0) return empty;

  const sinceIso = new Date(now.getTime() - SLACK_INTEL_LIMITS.projectWindowDays * DAY_MS).toISOString();
  const [linkedHits, channels, highLinks] = await Promise.all([
    listProjectItemIds(principal, { projectId: q.projectId, taskIds: Array.isArray(q.taskIds) ? q.taskIds : [], sinceIso, limit: SLACK_INTEL_LIMITS.projectLinkedRows * 3 }, { signal }),
    listIntelChannels(principal, { signal }),
    derived !== null ? listChannelsLinkedToClient(principal, derived.clientId, ["high"], { signal }) : Promise.resolve([])
  ]);
  const byChannel = new Map<string, ChannelRow>(channels.map((c) => [c.channelId, c]));
  const allowed = storedSearchChannels(state, channels, "page");
  const highIds = new Set(
    derived === null ? [] : highLinks.filter((l) => l.clientId === derived.clientId && l.matchConfidence === "high").map((l) => l.channelId)
  );
  const names = [...new Set([mentionName(q.projectName), mentionName(derivedClientName)].filter((n): n is string => n !== null))];

  const [clientHits, clientCards, ...mentionHits] = await Promise.all([
    highIds.size === 0
      ? Promise.resolve([])
      : searchSlackStored(principal, {
          query: "",
          channelIds: allowed.full.filter((c) => highIds.has(c)),
          bypassChannelIds: allowed.bypass.filter((c) => highIds.has(c)),
          kinds: null,
          sinceIso,
          includeDigests: false,
          limit: SLACK_INTEL_LIMITS.projectClientItems * 3
        }, { signal }),
    highIds.size === 0
      ? Promise.resolve([])
      : listDigestViews(principal, state, { dates: lastLocalDates(now, principal.timezone, DIGEST_DAYS), channelIds: [...highIds], use: "page", limit: DIGEST_READ_LIMIT }, { signal, now }),
    ...names.map((name) =>
      searchSlackStored(principal, {
        query: phraseQuery(name),
        channelIds: allowed.full,
        bypassChannelIds: allowed.bypass,
        kinds: null,
        sinceIso,
        includeDigests: false,
        limit: MENTION_READ_LIMIT
      }, { signal })
    )
  ]);

  const ids = [...new Set([...linkedHits.map((h) => h.itemId), ...clientHits.filter((h) => h.src === "item").map((h) => h.id),
    ...mentionHits.flat().filter((h) => h.src === "item").map((h) => h.id)])].slice(0, ITEM_IDS_MAX);
  const items = ids.length === 0 ? [] : await getSlackItemsByIds(principal, ids, { surface: "web", signal });
  const byId = new Map(items.map((i) => [i.id, i]));

  /** The row for an item the screens allow, with its summary; null otherwise. */
  const rowOf = (itemId: string, basis: SlackProjectRow["basis"], via: SlackProjectRow["via"]): SlackProjectRow | null => {
    const item = byId.get(itemId);
    if (!item) return null;
    const ch = byChannel.get(item.channelId) ?? null;
    const verdict = slackItemPolicy(state, ch, item, "page");
    if (!verdict.allowed) return null;
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    if (!item.assessed || summary.length === 0) return null;
    return {
      itemId: item.id,
      digestId: null,
      kind: item.kind,
      channelLabel: slackChannelLabel(ch),
      privacy: verdict.privacy,
      at: slackTsIso(item.ts) ?? item.createdAt,
      summary,
      basis,
      via,
      permalink: typeof item.permalink === "string" && isAllowedLinkUrl(item.permalink) ? item.permalink : null
    };
  };
  const sortRows = (rows: SlackProjectRow[]) => rows.sort((a, b) => newestFirst({ at: a.at, key: a.itemId ?? a.digestId ?? "" }, { at: b.at, key: b.itemId ?? b.digestId ?? "" }));

  const shown = new Set<string>();
  const linked: SlackProjectRow[] = [];
  for (const hit of linkedHits) {
    if (shown.has(hit.itemId)) continue;
    const row = rowOf(hit.itemId, "record", hit.via);
    if (row === null) continue;
    shown.add(hit.itemId);
    linked.push(row);
  }
  sortRows(linked).splice(SLACK_INTEL_LIMITS.projectLinkedRows);

  const clientItems: SlackProjectRow[] = [];
  const clientCandidates = clientHits
    .filter((h) => h.src === "item" && highIds.has(h.channelId))
    .map((h) => byId.get(h.id))
    .filter((i): i is SlackItemRow => i !== undefined && highIds.has(i.channelId))
    .sort(tsNewestFirst);
  for (const item of clientCandidates) {
    if (clientItems.length >= SLACK_INTEL_LIMITS.projectClientItems) break;
    if (shown.has(item.id)) continue;
    const row = rowOf(item.id, "derived", "client_channel");
    if (row === null) continue;
    shown.add(item.id);
    clientItems.push(row);
  }
  const digestRows: SlackProjectRow[] = clientCards
    .filter((c) => c.status === "built" && c.digestId !== null && typeof c.summary === "string" && c.summary.trim().length > 0 && highIds.has(c.channelId)
      && byChannel.has(c.channelId))
    .slice(0, SLACK_INTEL_LIMITS.projectClientDigests)
    .map((c) => ({
      itemId: null,
      digestId: c.digestId,
      kind: "digest" as const,
      channelLabel: c.channelLabel,
      privacy: c.privacy,
      at: digestDayIso(c.date, principal.timezone) ?? now.toISOString(),
      summary: (c.summary as string).trim(),
      basis: "derived" as const,
      via: "client_channel" as const,
      permalink: null
    }));
  const clientChannels = sortRows([...clientItems, ...digestRows]);

  const mentions: SlackProjectRow[] = [];
  if (names.length > 0) {
    const candidates = [...new Set(mentionHits.flat().filter((h) => h.src === "item").map((h) => h.id))]
      .map((id) => byId.get(id))
      .filter((i): i is SlackItemRow => i !== undefined)
      .sort(tsNewestFirst);
    for (const item of candidates) {
      if (mentions.length >= SLACK_INTEL_LIMITS.projectMentions) break;
      if (shown.has(item.id)) continue;
      const row = rowOf(item.id, "ai", "mention");
      if (row === null || !names.some((n) => summaryNames(row.summary, n))) continue;
      shown.add(item.id);
      mentions.push(row);
    }
  }
  signal?.throwIfAborted();
  return { state, linked, clientChannels, mentions: sortRows(mentions), derivedClientName };
}
