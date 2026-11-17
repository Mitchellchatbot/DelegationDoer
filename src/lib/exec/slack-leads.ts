import { channelSlug } from "@/lib/exec/slack-classes";
import { SLACK_P10_COPY, fillP10 } from "@/lib/exec/slack-p10-copy";
import {
  LEAD_KINDS_SHOWN,
  P10_LIMITS,
  type BriefLeads,
  type BriefLeadsBlock,
  type FbLeadListRow,
  type LeadChannelState,
  type LeadClientCounts,
  type LeadCountsView,
  type LeadCoverage,
  type LeadDayCount,
  type LeadKind,
  type LeadLink,
  type LeadMapRow,
  type LeadMarkerRow,
  type LeadPostShape,
  type LeadRunSummary,
  type LeadSummaryRow,
  type LeadTriple
} from "@/lib/exec/slack-p10-types";
import { tsToMs } from "@/lib/exec/slack-read-types";
import { addLocalDays, localDateString } from "@/lib/exec/time";
import type { ExecSettings } from "@/lib/exec/types";

// P10 lead counts, pure (contract §3.4.2, C13-C20, C44, C56, C62; Area B): kinds, links, windows, tallies, the due rule and
// the summaries. Imports only slack-p10-types, slack-p10-copy, slack-classes (channelSlug), slack-read-types (tsToMs), time
// and a type from types (B-P10-3, §3.4.2). Nothing here sees a post's content: shapes carry a ts and flags only (C12), names
// are the Slack channel names held in memory for one run (never returned by leadMapRows) and the DD labels of the typed list.
// withBriefLeads (§3.8 item 3) is generic over the content so this module needs no brief-types import (AM-P10-11).

type ShownKind = Exclude<LeadKind, "other">;

const SUFFIX_TOKENS: ReadonlySet<string> = new Set(["vob", "nonvob", "calendly", "failsafe", "lead", "leads"]);
const LEAD_WORDS: ReadonlySet<string> = new Set(["lead", "leads"]);
const ZAP_ERROR: ReadonlySet<string> = new Set(["error", "errors"]);
const PREFIX_MIN = 3;
const CHANNEL_ID_RE = /^[CG][A-Z0-9]{2,30}$/;
const TEAM_ID_RE = /^T[A-Z0-9]{2,30}$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** P2a's retention_days_slack default (principal.ts DEFAULT_SETTINGS.retentionDaysSlack), restated: this module is pure. */
const RETENTION_DEFAULT_DAYS = 90;
const LINKED: ReadonlySet<LeadLink> = new Set<LeadLink>(["fb_id", "fb_name", "fb_sibling"]);
/** The tab's chat list and the typed list's positions: the SQL function keeps ≤ 12 entries per onboarding. */
const LIST_POSITIONS = 12;

/** The name split into lower-case alphanumeric tokens (the classifier's split, slack-classes.ts nameTokens). */
function tokensOf(name: string | null): string[] {
  if (typeof name !== "string") return [];
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** C19 on lower-case alphanumeric tokens of the name. */
export function leadKindOf(name: string | null): LeadKind {
  const tokens = tokensOf(name);
  const found = new Set<ShownKind>();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = i + 1 < tokens.length ? tokens[i + 1] : null;
    if (t === "nonvob") found.add("nonvob");
    else if (t === "non" && next === "vob") {
      // "non" then "vob": that vob is consumed and doesn't also count as vob.
      found.add("nonvob");
      i += 1;
    } else if (t === "vob") found.add("vob");
    else if (t === "calendly") found.add("calendly");
    else if (t === "failsafe") found.add("zap_errors");
    else if (t === "zap" && next !== null && ZAP_ERROR.has(next)) {
      found.add("zap_errors");
      i += 1;
    }
  }
  return found.size === 1 ? [...found][0] : "other";
}

/** The index of the first token of the lead suffix, or -1 (slack-classes.ts' leadSuffixStart rule, restated: it is module-private
 *  there and this module may import only channelSlug from it). */
function suffixStart(tokens: readonly string[]): number {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = i + 1 < tokens.length ? tokens[i + 1] : null;
    if (SUFFIX_TOKENS.has(t)) return i;
    if (t === "non" && next === "vob") return i;
    if (t === "zap" && next !== null && ZAP_ERROR.has(next)) return i;
    if (t === "fb" && next !== null && LEAD_WORDS.has(next)) return i;
  }
  return -1;
}

/** The tokens before the lead suffix (the first vob / nonvob / calendly / failsafe / lead / leads token, "non" + "vob",
 *  "zap" + "error(s)", "fb" + "lead(s)"), joined with "-"; null when there is none or it is shorter than 3 characters. */
export function leadPrefixOf(name: string | null): string | null {
  const tokens = tokensOf(name);
  const at = suffixStart(tokens);
  if (at <= 0) return null;
  const prefix = tokens.slice(0, at).join("-");
  return prefix.length >= PREFIX_MIN ? prefix : null;
}

/** The group a typed-list row belongs to: its DD client, else its onboarding task. */
const groupOf = (r: Pick<FbLeadListRow, "clientId" | "taskId">): string => (r.clientId !== null ? r.clientId : `task:${r.taskId}`);

const byTaskThenPosition = (a: FbLeadListRow, b: FbLeadListRow): number =>
  a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.i - b.i;

/** One rule's matches: exactly one group → that group's first row by taskId; more than one group → ambiguous; none → null. */
function judge(matches: readonly FbLeadListRow[]): { row: FbLeadListRow } | "ambiguous" | null {
  if (matches.length === 0) return null;
  const groups = new Set(matches.map(groupOf));
  if (groups.size > 1) return "ambiguous";
  return { row: [...matches].sort(byTaskThenPosition)[0] };
}

/** C20, first match wins; groups by clientId ?? "task:" + taskId; `row` = the matched group's first row by taskId. */
export function leadLinkOf(channel: { id: string; slackName: string | null }, list: readonly FbLeadListRow[]): { link: LeadLink; row: FbLeadListRow | null } {
  const rows = Array.isArray(list) ? list.filter((r) => r !== null && typeof r === "object" && typeof r.taskId === "string") : [];
  const id = typeof channel?.id === "string" ? channel.id : "";
  const slackName = typeof channel?.slackName === "string" ? channel.slackName : null;
  const rules: (() => FbLeadListRow[])[] = [
    () => rows.filter((r) => id.length > 0 && r.channelId === id),
    () => {
      const slug = slackName === null ? "" : channelSlug(slackName);
      return slug.length === 0 ? [] : rows.filter((r) => typeof r.name === "string" && channelSlug(r.name) === slug);
    },
    () => {
      const prefix = leadPrefixOf(slackName);
      return prefix === null ? [] : rows.filter((r) => leadPrefixOf(r.name) === prefix);
    }
  ];
  const links: LeadLink[] = ["fb_id", "fb_name", "fb_sibling"];
  for (let k = 0; k < rules.length; k += 1) {
    const verdict = judge(rules[k]());
    if (verdict === "ambiguous") return { link: "ambiguous", row: null };
    if (verdict !== null) return { link: links[k], row: verdict.row };
  }
  return { link: "none", row: null };
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The run's map (C18-C20, C24). members: his member channels (id → in-memory name); markers: listLeadMarkers' rows. */
export function leadMapRows(input: { members: ReadonlyMap<string, string | null>; markers: readonly LeadMarkerRow[]; list: readonly FbLeadListRow[] }):
  { rows: LeadMapRow[]; listedNotMember: number; notMember: { taskId: string; i: number }[]; toClassify: string[] } {
  const members = input.members instanceof Map ? input.members : new Map<string, string | null>();
  const markers = Array.isArray(input.markers) ? input.markers : [];
  const list = Array.isArray(input.list) ? input.list.filter((r) => r !== null && typeof r === "object" && typeof r.taskId === "string") : [];
  const rows: LeadMapRow[] = [];
  const seen = new Set<string>();
  for (const m of [...markers].sort((a, b) => byId(a.channelId, b.channelId))) {
    if (m.class !== "deny" || (m.denyReason !== "fb_list" && m.denyReason !== "lead_name")) continue;
    if (!members.has(m.channelId) || seen.has(m.channelId)) continue;   // C18: only the lead channels he is in
    seen.add(m.channelId);
    const slackName = members.get(m.channelId) ?? null;
    const typed = list.find((r) => r.channelId === m.channelId && typeof r.name === "string")?.name ?? null;
    const kind = leadKindOf(slackName ?? typed);
    const { link, row } = leadLinkOf({ id: m.channelId, slackName }, list);
    const linked = LINKED.has(link) && row !== null;
    rows.push({
      channelId: m.channelId,
      kind,
      link: linked ? link : link === "ambiguous" ? "ambiguous" : "none",
      taskId: linked ? row.taskId : null,
      clientId: linked ? row.clientId : null,
      clientLabel: linked ? row.clientLabel : null
    });
  }
  // listedNotMember: typed entries (by URL id, else by name) that match no member channel (product-10: their positions).
  const memberSlugs = new Set<string>();
  for (const name of members.values()) if (typeof name === "string") memberSlugs.add(channelSlug(name));
  const notMemberAll: { taskId: string; i: number }[] = [];
  for (const r of [...list].sort(byTaskThenPosition)) {
    const matched = r.channelId !== null ? members.has(r.channelId) : typeof r.name === "string" && memberSlugs.has(channelSlug(r.name));
    if (!matched && Number.isInteger(r.i) && r.i >= 0 && r.i < LIST_POSITIONS) notMemberAll.push({ taskId: r.taskId, i: r.i });
  }
  const toClassify = markers.filter((m) => m.listed === true && m.class !== "deny").map((m) => m.channelId);
  return {
    rows,
    listedNotMember: notMemberAll.length,
    notMember: notMemberAll.slice(0, P10_LIMITS.leadNotMemberMax),
    toClassify: [...new Set(toClassify)].sort(byId)
  };
}

/** v1.1 correctness-2 (C15): the channel needs its final pass ⇔ (finalThrough null or < yesterday) and (finalAttemptAt null or
 *  older than leadFinalRetryMs at nowMs). */
export function leadNeedsFinal(state: Pick<LeadChannelState, "finalThrough" | "finalAttemptAt">, today: string, nowMs: number): boolean {
  const yesterday = addLocalDays(today, -1);
  const through = typeof state.finalThrough === "string" && LOCAL_DATE_RE.test(state.finalThrough) ? state.finalThrough : null;
  if (through !== null && through >= yesterday) return false;
  const attempt = typeof state.finalAttemptAt === "string" ? Date.parse(state.finalAttemptAt) : Number.NaN;
  // A missing or unreadable attempt time retries (never strands a channel without its final pass).
  if (!Number.isFinite(attempt)) return true;
  return nowMs - attempt >= P10_LIMITS.leadFinalRetryMs;
}

/** C15: leadNeedsFinal → [today − 7, today], final true; else [today, today]. P10 fixer correctness-2: `force` (the brief's own
 *  run, 15 minutes before the brief) also takes the final window for a channel whose final pass hasn't covered yesterday,
 *  whatever the 6-hour retry gate says, so a final pass that failed at 01:00 is tried again before the brief reads yesterday. */
export function leadWindowFor(state: Pick<LeadChannelState, "finalThrough" | "finalAttemptAt">, today: string, nowMs: number,
  opts?: { force?: boolean }): { from: string; to: string; final: boolean } {
  const forced = opts?.force === true && !finalCovers(state, addLocalDays(today, -1));
  if (forced || leadNeedsFinal(state, today, nowMs)) return { from: addLocalDays(today, -P10_LIMITS.leadFinalDays), to: today, final: true };
  return { from: today, to: today, final: false };
}

/** A past local day is whole for a channel once a final pass covered it (finalThrough ≥ day). */
function finalCovers(s: Pick<LeadChannelState, "finalThrough">, day: string): boolean {
  const through = typeof s?.finalThrough === "string" && LOCAL_DATE_RE.test(s.finalThrough) ? s.finalThrough : null;
  return through !== null && LOCAL_DATE_RE.test(day) && through >= day;
}

/** P10 fixer correctness-2 / -3: whether a lead channel's stored count for `day` is the whole day (`today` and `tz` are the
 *  principal's). A past day: its final pass covered it (finalThrough ≥ day); a same-day snapshot written before the day ended
 *  says complete only for what it read, so it isn't. Today ("so far"): the channel was counted since the local day began, so
 *  a missing row before the day's first run, or after a read that failed, is never read as zero. A future day: false. */
export function leadDayCovered(s: Pick<LeadChannelState, "finalThrough" | "countedAt">, day: string, today: string, tz: string): boolean {
  if (typeof day !== "string" || typeof today !== "string" || !LOCAL_DATE_RE.test(day) || !LOCAL_DATE_RE.test(today) || day > today) return false;
  if (day < today) return finalCovers(s, day);
  const at = typeof s?.countedAt === "string" ? Date.parse(s.countedAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  try {
    return localDateString(new Date(at), tz) >= today;
  } catch {
    return false;
  }
}

/** P10 fixer correctness-3: every counted lead channel in `states` (a shown kind; `keep` narrows them) has a whole count for
 *  every local day in [from, to] (leadDayCovered). An empty set covers. */
export function leadStatesCover(states: readonly LeadChannelState[], from: string, to: string, today: string, tz: string,
  keep?: (s: LeadChannelState) => boolean): boolean {
  const days = daysOf(from, to);
  for (const s of Array.isArray(states) ? states : []) {
    if (s === null || typeof s !== "object" || !isShown(s.kind) || (keep !== undefined && !keep(s))) continue;
    if (!days.every((d) => leadDayCovered(s, d, today, tz))) return false;
  }
  return true;
}

/** P10 fixer ui-5: the lead surfaces' state from the last run summary and the coverage (C62, v1.1 product-2). No summary yet →
 *  first_run; a counted lead channel → ok. With none: no_channels ONLY when that run listed his membership in full and didn't
 *  fail (a partial listing proves nothing: first_run, nothing mapped yet); a failing run → unavailable, so the brief says
 *  "Couldn't load lead counts." instead of hiding its block (P8 M4: never a silent gap). */
export function leadsViewStateOf(run: LeadRunSummary | null, coverage: LeadCoverage | null): "first_run" | "ok" | "no_channels" | "unavailable" {
  if (run === null || run === undefined) return "first_run";
  if (coverage !== null && coverage !== undefined && typeof coverage.channels === "number" && coverage.channels > 0) return "ok";
  if (typeof run.failingRuns === "number" && run.failingRuns > 0) return "unavailable";
  if (run.complete !== true) return "first_run";
  return "no_channels";
}

/** C13: what a shape adds to its day. */
const countsPost = (s: LeadPostShape): boolean =>
  s.bot && !s.reply && !s.hidden && !s.excluded && (s.subtypeClass === "none" || s.subtypeClass === "bot_message");
const isSkipped = (s: LeadPostShape): boolean => !s.bot && !s.reply && !s.hidden && s.subtypeClass === "none";

/** Every local date from `from` to `to`, inclusive (≤ 400 days; an inverted window is empty). */
function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  if (!LOCAL_DATE_RE.test(from) || !LOCAL_DATE_RE.test(to) || from > to) return out;
  for (let d = from; d <= to && out.length <= 400; d = addLocalDays(d, 1)) out.push(d);
  return out;
}

/** C13 + C14 + v1.1 correctness-2. Not capped → one complete LeadDayCount per local day in [from, to] (zero days included),
 *  partialFrom null. Capped (pages run newest first) → let d0 = the local day of the oldest shape read: complete counts for
 *  every day strictly after d0 (zeros included), d0 itself as a lower bound (complete: false), NOTHING for the days before d0;
 *  partialFrom = d0 (d0 and every older day of the window still need reading). Capped with no usable shape → [], partialFrom = to.
 *  A single-day window (the per-day fallback) counts only shapes whose local day is that day. */
export function tallyShapes(shapes: readonly LeadPostShape[], tz: string, window: { from: string; to: string }, capped: boolean):
  { days: LeadDayCount[]; partialFrom: string | null } {
  const days = daysOf(window.from, window.to);
  const tally = new Map<string, { n: number; skipped: number }>(days.map((d) => [d, { n: 0, skipped: 0 }]));
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const s of Array.isArray(shapes) ? shapes : []) {
    if (s === null || typeof s !== "object" || typeof s.ts !== "string") continue;
    let ms: number;
    try {
      ms = tsToMs(s.ts);
    } catch {
      continue;   // a malformed ts never counts
    }
    if (!Number.isFinite(ms)) continue;
    if (ms < oldestMs) oldestMs = ms;
    const day = tally.get(localDateString(new Date(ms), tz));
    if (!day) continue;   // outside the window
    if (countsPost(s)) day.n += 1;
    else if (isSkipped(s)) day.skipped += 1;
  }
  const full = (d: string): LeadDayCount => ({ day: d, n: tally.get(d)?.n ?? 0, skipped: tally.get(d)?.skipped ?? 0, complete: true });
  if (!capped) return { days: days.map(full), partialFrom: null };
  if (!Number.isFinite(oldestMs) || days.length === 0) return { days: [], partialFrom: window.to };
  const d0 = localDateString(new Date(oldestMs), tz);
  if (d0 < window.from) return { days: days.map(full), partialFrom: null };   // the read reached past the window: all of it is in
  if (d0 > window.to) return { days: [], partialFrom: window.to };
  const out: LeadDayCount[] = [];
  for (const d of days) {
    if (d < d0) continue;   // never read in full: not written at all
    out.push(d === d0 ? { ...full(d), complete: false } : full(d));
  }
  return { days: out, partialFrom: d0 };
}

/** v1.1 correctness-11 (C44): retention_days_slack clamped to [leadRetentionMinDays, leadRetentionMaxDays]; every lead expiry uses it. */
export function leadRetentionDays(settings: Pick<ExecSettings, "retentionDaysSlack">): number {
  const raw = settings?.retentionDaysSlack;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : RETENTION_DEFAULT_DAYS;
  return Math.min(P10_LIMITS.leadRetentionMaxDays, Math.max(P10_LIMITS.leadRetentionMinDays, n));
}

/** v1.1 product-10 (C62): https://slack.com/app_redirect?channel=<channelId>&team=<teamId> (an allow-listed form,
 *  src/lib/exec/refs.ts:50-56); null for a malformed id. Pure. */
export function leadChannelHref(teamId: string, channelId: string): string | null {
  if (typeof teamId !== "string" || !TEAM_ID_RE.test(teamId)) return null;
  if (typeof channelId !== "string" || !CHANNEL_ID_RE.test(channelId)) return null;
  return `https://slack.com/app_redirect?channel=${channelId}&team=${teamId}`;
}

/** C16. bucket null (an unknown key) → true. */
export function leadRunDue(input: { forced: boolean; bucket: number | null; inWindow: boolean; last: LeadRunSummary | null }): boolean {
  if (input.forced === true) return true;
  const last = input.last;
  if (last !== null && last !== undefined && (last.partial === true || (typeof last.needsFinal === "number" && last.needsFinal > 0))) return true;
  const bucket = input.bucket;
  if (bucket === null || typeof bucket !== "number" || !Number.isSafeInteger(bucket) || bucket < 0) return true;
  return bucket % (input.inWindow === true ? P10_LIMITS.leadEveryInWindow : P10_LIMITS.leadEveryOffWindow) === 0;
}

// ---------------------------------------------------------------------------
// Summaries (the brief, the Slack tab)
// ---------------------------------------------------------------------------

const isShown = (k: LeadKind): k is ShownKind => k !== "other";
const orderedKinds = (kinds: Iterable<LeadKind>): LeadKind[] => {
  const set = new Set(kinds);
  return LEAD_KINDS_SHOWN.filter((k) => set.has(k));
};
const nonNeg = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
const labelOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const validRows = (rows: readonly LeadSummaryRow[]): LeadSummaryRow[] =>
  (Array.isArray(rows) ? rows : []).filter((r) => r !== null && typeof r === "object" && typeof r.groupKey === "string" && typeof r.day === "string");
/** The summary's group key of a channel state (exec_slack_lead_summary's first column, restated). */
const stateGroupKey = (s: Pick<LeadChannelState, "link" | "clientId" | "taskId">): string =>
  LINKED.has(s.link) && (s.clientId !== null || s.taskId !== null) ? (s.clientId !== null ? `c:${s.clientId}` : `t:${s.taskId}`) : "unlinked";

/** Adds one summary row's n to a per-kind tally. */
function addKind(t: { vob: number; nonvob: number; calendly: number; zapErrors: number }, kind: LeadKind, n: number): void {
  if (kind === "vob") t.vob += n;
  else if (kind === "nonvob") t.nonvob += n;
  else if (kind === "calendly") t.calendly += n;
  else if (kind === "zap_errors") t.zapErrors += n;
}

/** C56: one local day's block for the brief; linked groups only (the unlinked group's lead posts into `unlinked` and
 *  `unlinkedCounts`), sorted by vob + nonvob + calendly descending, then label; ≤ leadBriefRows rows, the rest in `more`; totals
 *  and totalKinds over every linked group (product-9). `localDate` is a whole PAST local day (the lead zone's yesterday).
 *  v1.1 product-2 / P10 fixer correctness-2: `notCounted` = counted lead channels in `states` (a shown kind, linked OR not:
 *  the unlinked line and the "none" sentence read their rows too) without a whole count for localDate: no complete row for
 *  their group and kind, or a final pass that hasn't covered the day yet (finalThrough < localDate: a same-day snapshot from
 *  before midnight is not the day). `failing` from the run summary's failingRuns > 0.
 *  P10 fixer ui-12: `unlinked` counts lead posts only (VOB, non-VOB, Calendly; never Zapier errors), per kind in
 *  `unlinkedCounts`, as the Slack tab's unlinked row. */
export function briefLeadsFrom(rows: readonly LeadSummaryRow[], states: readonly LeadChannelState[], localDate: string, asOf: string | null,
  opts: { failing: boolean; dated: boolean; firstRun: boolean }): BriefLeads {
  const dayRows = validRows(rows).filter((r) => r.day === localDate);
  const groups = new Map<string, LeadClientCounts>();
  const loose = { ...zeroTriple(), kinds: new Set<LeadKind>() };
  let incomplete = false;
  for (const r of dayRows) {
    const n = nonNeg(r.n);
    if (r.complete !== true) incomplete = true;
    if (r.groupKey === "unlinked" || !isShown(r.kind)) {
      if (r.kind === "vob" || r.kind === "nonvob" || r.kind === "calendly") {
        addTriple(loose, r.kind, n);
        loose.kinds.add(r.kind);
      }
      continue;
    }
    let g = groups.get(r.groupKey);
    if (!g) {
      g = { label: "", clientId: r.clientId ?? null, vob: 0, nonvob: 0, calendly: 0, zapErrors: 0, complete: true, kinds: [] };
      groups.set(r.groupKey, g);
    }
    if (typeof r.clientLabel === "string" && r.clientLabel.length > 0 && (g.label === "" || r.clientLabel < g.label)) g.label = r.clientLabel;
    addKind(g, r.kind, n);
    if (r.complete !== true) g.complete = false;
    g.kinds = orderedKinds([...g.kinds, r.kind]);
  }
  const all = [...groups.values()].map((g) => ({ ...g, label: g.label.slice(0, P10_LIMITS.leadLabelChars) }));
  all.sort((a, b) => (b.vob + b.nonvob + b.calendly) - (a.vob + a.nonvob + a.calendly) || labelOrder(a.label, b.label));
  const totals = { vob: 0, nonvob: 0, calendly: 0, zapErrors: 0 };
  const totalKinds = new Set<LeadKind>();
  for (const g of all) {
    totals.vob += g.vob;
    totals.nonvob += g.nonvob;
    totals.calendly += g.calendly;
    totals.zapErrors += g.zapErrors;
    for (const k of g.kinds) totalKinds.add(k);
  }
  // notCounted: per group × kind (linked and unlinked alike), the counted channels whose day isn't whole: the day's row must be
  // complete AND the channel's final pass must have covered the day (a row's channels beyond that count for nothing).
  const stateCounts = new Map<string, { channels: number; covered: number }>();
  for (const s of Array.isArray(states) ? states : []) {
    if (s === null || typeof s !== "object" || !isShown(s.kind)) continue;
    const key = `${stateGroupKey(s)}|${s.kind}`;
    const c = stateCounts.get(key) ?? { channels: 0, covered: 0 };
    c.channels += 1;
    if (finalCovers(s, localDate)) c.covered += 1;
    stateCounts.set(key, c);
  }
  let notCounted = 0;
  for (const [key, c] of stateCounts) {
    const row = dayRows.find((r) => `${r.groupKey}|${r.kind}` === key);
    const counted = row !== undefined && row.complete === true ? Math.min(nonNeg(row.channels), c.covered) : 0;
    notCounted += Math.max(0, c.channels - counted);
  }
  return {
    v: 1,
    localDate,
    rows: all.slice(0, P10_LIMITS.leadBriefRows),
    more: Math.max(0, all.length - P10_LIMITS.leadBriefRows),
    totals,
    totalKinds: orderedKinds(totalKinds),
    unlinked: tripleSum(loose),
    incomplete,
    asOf: typeof asOf === "string" ? asOf : null,
    notCounted,
    failing: opts?.failing === true,
    dated: opts?.dated === true,
    firstRun: opts?.firstRun === true,
    unlinkedCounts: { vob: loose.vob, nonvob: loose.nonvob, calendly: loose.calendly, kinds: orderedKinds(loose.kinds) }
  };
}

const zeroTriple = (): LeadTriple => ({ vob: 0, nonvob: 0, calendly: 0 });
function addTriple(t: LeadTriple, kind: LeadKind, n: number): void {
  if (kind === "vob") t.vob += n;
  else if (kind === "nonvob") t.nonvob += n;
  else if (kind === "calendly") t.calendly += n;
}
const tripleSum = (t: LeadTriple): number => t.vob + t.nonvob + t.calendly;

/** The Slack tab's view from three summaries (today, yesterday, the 7 days ending today), the coverage, the channel states and,
 *  for the fix lists, the typed list and the team id (v1.1 product-9, -10, -19). */
export function leadCountsViewFrom(input: { today: string; tz: string; rows: readonly LeadSummaryRow[]; coverage: LeadCoverage | null;
  run: LeadRunSummary | null; states: readonly LeadChannelState[]; list: readonly FbLeadListRow[] | null; teamId: string | null }): LeadCountsView {
  const today = input.today;
  const yesterday = addLocalDays(today, -1);
  const from7 = addLocalDays(today, -6);
  const rows = validRows(input.rows).filter((r) => r.day >= from7 && r.day <= today);
  type Client = LeadCountsView["clients"][number];
  const clients = new Map<string, Client & { kindSet: Set<LeadKind> }>();
  let unlinked: { today: LeadTriple; yesterday: LeadTriple; last7: LeadTriple } | null = null;
  let oldest: string | null = null;
  for (const r of rows) {
    const n = nonNeg(r.n);
    if (typeof r.oldestCountedAt === "string" && (oldest === null || Date.parse(r.oldestCountedAt) < Date.parse(oldest))) oldest = r.oldestCountedAt;
    if (!isShown(r.kind)) continue;
    if (r.groupKey === "unlinked") {
      unlinked ??= { today: zeroTriple(), yesterday: zeroTriple(), last7: zeroTriple() };
      addTriple(unlinked.last7, r.kind, n);
      if (r.day === today) addTriple(unlinked.today, r.kind, n);
      if (r.day === yesterday) addTriple(unlinked.yesterday, r.kind, n);
      continue;
    }
    let c = clients.get(r.groupKey);
    if (!c) {
      c = { label: "", clientId: r.clientId ?? null, today: zeroTriple(), yesterday: zeroTriple(), last7: zeroTriple(), kinds: [], zapToday: 0,
        zapYesterday: 0, incomplete: false, kindSet: new Set() };
      clients.set(r.groupKey, c);
    }
    if (typeof r.clientLabel === "string" && r.clientLabel.length > 0 && (c.label === "" || r.clientLabel < c.label)) c.label = r.clientLabel;
    c.kindSet.add(r.kind);
    if (r.complete !== true) c.incomplete = true;
    addTriple(c.last7, r.kind, n);
    if (r.day === today) {
      addTriple(c.today, r.kind, n);
      if (r.kind === "zap_errors") c.zapToday += n;
    }
    if (r.day === yesterday) {
      addTriple(c.yesterday, r.kind, n);
      if (r.kind === "zap_errors") c.zapYesterday += n;
    }
  }
  // P10 fixer correctness-3: a counted lead channel with no whole count for a day of the window (today before its first run of
  // the day or after a read that failed; a past day its final pass hasn't covered) marks its client incomplete, and the view,
  // whether or not that client has a row yet (a missing row is never a zero). The unlinked group's channels mark the view.
  const states = (Array.isArray(input.states) ? input.states : []).filter((s) => s !== null && typeof s === "object");
  const short = new Set<string>();
  for (const s of states) {
    if (!isShown(s.kind) || leadStatesCover([s], from7, today, today, input.tz)) continue;
    short.add(stateGroupKey(s));
  }
  for (const [key, c] of clients) if (short.has(key)) c.incomplete = true;
  const list = [...clients.values()]
    .map(({ kindSet, ...c }) => ({ ...c, label: c.label.slice(0, P10_LIMITS.leadLabelChars), kinds: orderedKinds(kindSet) }))
    .sort((a, b) => tripleSum(b.last7) - tripleSum(a.last7) || labelOrder(a.label, b.label));
  let totals: LeadCountsView["totals"] = null;
  if (list.length > 0) {
    const t = { today: zeroTriple(), yesterday: zeroTriple(), last7: zeroTriple(), kinds: [] as LeadKind[] };
    const kinds = new Set<LeadKind>();
    for (const c of list) {
      for (const k of ["vob", "nonvob", "calendly"] as const) {
        t.today[k] += c.today[k];
        t.yesterday[k] += c.yesterday[k];
        t.last7[k] += c.last7[k];
      }
      for (const k of c.kinds) kinds.add(k);
    }
    t.kinds = orderedKinds(kinds);
    totals = t;
  }
  const run = input.run;
  const coverage = input.coverage === null || input.coverage === undefined ? null : {
    ...input.coverage,
    listedNotMember: nonNeg(run?.listedNotMember),
    lastRunAt: typeof run?.at === "string" ? run.at : null,
    lastError: typeof run?.failCode === "string" ? run.failCode : null
  };
  // P10 fixer ui-5: the one state rule every lead surface uses.
  const state: LeadCountsView["state"] = leadsViewStateOf(run ?? null, input.coverage ?? null);
  return {
    state,
    asOf: oldest ?? (typeof run?.at === "string" ? run.at : null),
    tz: input.tz,
    totals,
    clients: list,
    unlinked,
    coverage,
    fix: fixLists(input.states, input.list, input.teamId, run),
    incomplete: short.size > 0 || rows.some((r) => isShown(r.kind) && r.complete !== true)
  };
}

/** C62 / product-10: what to fix. hrefs from the stored channel ids; notMember names as typed on the FB cards. */
function fixLists(states: readonly LeadChannelState[], list: readonly FbLeadListRow[] | null, teamId: string | null,
  run: LeadRunSummary | null): NonNullable<LeadCountsView["fix"]> {
  const max = P10_LIMITS.leadFixListMax;
  let more = 0;
  const links = (link: LeadLink): { href: string; kind: LeadKind }[] => {
    const out: { href: string; kind: LeadKind }[] = [];
    if (teamId === null) return out;   // the team id couldn't be read: counts only
    const matching = (Array.isArray(states) ? states : [])
      .filter((s) => s !== null && typeof s === "object" && s.link === link && isShown(s.kind))
      .sort((a, b) => byId(a.channelId, b.channelId));
    for (const s of matching) {
      const href = leadChannelHref(teamId, s.channelId);
      if (href === null) continue;
      if (out.length >= max) more += 1;
      else out.push({ href, kind: s.kind });
    }
    return out;
  };
  const unlinked = links("none");
  const ambiguous = links("ambiguous");
  const notMember: { client: string; names: string[] }[] = [];
  if (Array.isArray(list) && run !== null && run !== undefined && Array.isArray(run.notMember)) {
    const byGroup = new Map<string, { client: string; names: string[] }>();
    let shown = 0;
    for (const nm of run.notMember) {
      const row = list.find((r) => r !== null && typeof r === "object" && r.taskId === nm.taskId && r.i === nm.i);
      if (!row || typeof row.name !== "string" || row.name.length === 0) {
        more += 1;   // a typed entry with no name (a URL only) is counted, never shown by id
        continue;
      }
      if (shown >= max) {
        more += 1;
        continue;
      }
      const key = groupOf(row);
      let g = byGroup.get(key);
      if (!g) {
        g = { client: row.clientLabel.slice(0, P10_LIMITS.leadLabelChars), names: [] };
        byGroup.set(key, g);
        notMember.push(g);
      }
      g.names.push(`#${row.name}`);
      shown += 1;
    }
  }
  return { unlinked, ambiguous, notMember, more };
}

/** v1.1 product-9: "10 VOBs · 8 non-VOBs · 3 Calendly posts" — every kind in c.kinds among vob / nonvob / calendly, in that
 *  order, zeros included ("10 VOBs · 0 non-VOBs"); never a kind not in c.kinds; singular for 1 (kindOne). No kind → "". */
export function leadCountsLine(c: Pick<LeadClientCounts, "vob" | "nonvob" | "calendly" | "kinds">): string {
  const kinds = new Set(Array.isArray(c?.kinds) ? c.kinds : []);
  const parts: string[] = [];
  for (const k of ["vob", "nonvob", "calendly"] as const) {
    if (!kinds.has(k)) continue;
    const n = nonNeg(c[k]);
    parts.push(`${n} ${n === 1 ? SLACK_P10_COPY.leads.kindOne[k] : SLACK_P10_COPY.leads.kinds[k]}`);
  }
  return parts.join(SLACK_P10_COPY.leads.countSep);
}

/** One line of the brief's leads block (§3.8 item 6, C56): its role and its plain text (labels are DD data; the DM escapes them,
 *  the page renders them as React text). */
export interface BriefLeadsLine { kind: "total" | "client" | "more" | "zap" | "unlinked" | "status"; text: string }

/** C56 / v1.1 product-2, product-9: the block's title and lines, the one rule the brief DM and the brief page share (LV05, LV07):
 *  the title (titleDated when dated, + partial when incomplete); unavailable → only its line; else, when any client row has a
 *  count, the All clients total first, then ≤ maxRows client lines (each leadCountsLine over its kinds), +N more in DD, the
 *  Zapier-errors line when any row has them; the unlinked line when unlinked > 0; then notReady (notReadyFirst on a first run
 *  or with no channel to name) when the run is new or failing or a counted channel isn't complete, and "none" only when nothing
 *  of that holds, nothing was counted and the day is complete. Labels are clipped to labelMax. */
export function briefLeadsText(leads: BriefLeadsBlock, opts: { maxRows: number; labelMax: number; datePhrase: string }): { title: string; lines: BriefLeadsLine[] } {
  const c = SLACK_P10_COPY.leads.brief;
  const label = (s: unknown): string => {
    const v = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
    return v.length > opts.labelMax ? `${v.slice(0, Math.max(0, opts.labelMax - 1))}…` : v;
  };
  if ("unavailable" in leads && leads.unavailable === true) return { title: c.title, lines: [{ kind: "status", text: c.unavailable }] };
  const b = leads as BriefLeads;
  let title = b.dated === true && opts.datePhrase.length > 0 ? fillP10(c.titleDated, { date: opts.datePhrase }) : c.title;
  if (b.incomplete === true) title = `${title} ${c.partial}`;
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const lines: BriefLeadsLine[] = [];
  const anyCount = rows.some((r) => nonNeg(r.vob) + nonNeg(r.nonvob) + nonNeg(r.calendly) + nonNeg(r.zapErrors) > 0);
  if (anyCount) {
    const total = leadCountsLine({ ...b.totals, kinds: Array.isArray(b.totalKinds) ? b.totalKinds : [] });
    if (total.length > 0) lines.push({ kind: "total", text: fillP10(c.total, { counts: total }) });
    const printable = rows.map((r) => ({ r, counts: leadCountsLine(r) })).filter((x) => x.counts.length > 0);
    const shown = printable.slice(0, Math.max(0, opts.maxRows));
    for (const x of shown) lines.push({ kind: "client", text: fillP10(c.line, { client: label(x.r.label), counts: x.counts }) });
    const more = printable.length - shown.length + nonNeg(b.more);
    if (more > 0) lines.push({ kind: "more", text: fillP10(c.more, { n: more }) });
    const zap = rows.filter((r) => nonNeg(r.zapErrors) > 0);
    if (zap.length > 0) lines.push({ kind: "zap", text: fillP10(c.zap, { list: zap.map((r) => `${label(r.label)} ${nonNeg(r.zapErrors)}`).join(", ") }) });
  }
  const unlinked = nonNeg(b.unlinked);
  if (unlinked > 0) {
    // P10 fixer ui-12: a counts line by kind ("2 VOBs · 1 non-VOB"), as the Slack tab's unlinked row; a block stored before
    // unlinkedCounts existed keeps its bare number.
    const detail = b.unlinkedCounts;
    const counts = detail !== null && detail !== undefined && typeof detail === "object" ? leadCountsLine(detail) : "";
    lines.push({ kind: "unlinked", text: fillP10(c.unlinked, { counts: counts.length > 0 ? counts : String(unlinked) }) });
  }
  const notCounted = nonNeg(b.notCounted);
  if (b.firstRun === true || b.failing === true || notCounted > 0) {
    // P10 fixer ui-10: the singular for one channel.
    const text = b.firstRun === true || notCounted === 0 ? c.notReadyFirst : notCounted === 1 ? c.notReadyOne : fillP10(c.notReady, { n: notCounted });
    lines.push({ kind: "status", text });
  } else if (!anyCount && unlinked === 0 && b.incomplete !== true) {
    lines.push({ kind: "status", text: c.none });
  }
  return { title, lines };
}

/** §3.8 item 3 (LK16): `{ ...content, leads }` when leads is non-null, the content untouched otherwise. Pure; generic over the
 *  content (BriefContent carries `leads?`), so slack-leads.ts keeps its import allow-list. */
export function withBriefLeads<C extends { leads?: BriefLeadsBlock | null }>(content: C, leads: BriefLeadsBlock | null): C {
  if (leads === null || leads === undefined) return content;
  return { ...content, leads };
}

/** The local date `n` days before `today` (whole local days; DST-safe: calendar arithmetic). */
export function leadDayBefore(today: string, n: number): string {
  return addLocalDays(today, -n);
}

/** Yesterday in `tz` at `now` (the lead zone's latest whole local day, C14 / C56). */
export function leadYesterday(now: Date, tz: string): string {
  return addLocalDays(localDateString(now, tz), -1);
}

