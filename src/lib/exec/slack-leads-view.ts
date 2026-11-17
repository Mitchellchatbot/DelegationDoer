import "server-only";

import { getActiveInstallation } from "@/lib/exec/slack-install";
import { briefLeadsFrom, leadCountsViewFrom, leadStatesCover, leadsViewStateOf } from "@/lib/exec/slack-leads";
import { leadCoverage, leadSchemaReady, leadSummary, listLeadChannelStates } from "@/lib/exec/slack-leads-store";
import { SLACK_P10_COPY, fillP10 } from "@/lib/exec/slack-p10-copy";
import {
  LEAD_KINDS_SHOWN,
  P10_LIMITS,
  type BriefLeadsBlock,
  type BriefLeadsUnavailable,
  type LeadChannelState,
  type LeadCountsView,
  type LeadCoverage,
  type LeadKind,
  type LeadRunSummary,
  type LeadSummaryRow,
  type LeadsViewState
} from "@/lib/exec/slack-p10-types";
import { getSlackReadingState } from "@/lib/exec/slack-reading";
import { listFbLeadChannelsV2 } from "@/lib/exec/sources/dd";
import { getSyncState, parseLeadRunSummary } from "@/lib/exec/sync-state";
import { addLocalDays, localDateString } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P10 every read of the lead counts for a surface (contract §3.4.6, §3.6.2, §3.8, §3.9, C33, C35, C56, C58; Area B;
// server-only). No Slack call, ever: the stored counts (exec_slack_lead_summary / _coverage), the lead channels' states, the
// last run's summary (exec_sync_state slack / lead-run), P7a's reading state, and (the Slack tab's fix lists only) DD's typed
// list and the installation's team id. Integers, enums, dates, DD labels and DD task ids only (H3): nothing here can hold a
// lead post's content, because nothing it reads does. Failures never log a value: the views answer "unavailable".

/** chat lists at most this many clients per part (the rest are counted in `more`). */
const CHAT_CLIENTS_MAX = 20;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

interface Basics { state: LeadsViewState; run: LeadRunSummary | null; coverage: LeadCoverage | null }

/** The state and the two reads every surface needs (§3.4.6). Throws on a read failure (the caller answers "unavailable"). */
async function basicsOf(principal: ExecPrincipal, settings: ExecSettings, now: Date, signal?: AbortSignal): Promise<Basics> {
  const none = (state: LeadsViewState): Basics => ({ state, run: null, coverage: null });
  if (settings.slackP10SchemaReady !== true) return none("not_installed");
  if (settings.slackLeadCountsEnabled !== true) return none("off");
  const opts = signal ? { signal } : {};
  if (!(await leadSchemaReady(opts))) return none("not_installed");
  const reading = await getSlackReadingState(principal);
  if (reading.state !== "on") return none("reading_off");
  const run = (await getSyncState(principal, "slack", "lead-run", parseLeadRunSummary, opts))?.value ?? null;
  const coverage = await leadCoverage(principal, localDateString(now, principal.timezone), opts);
  // P10 fixer ui-5: no_channels only after a complete, non-failing run; a failing run → unavailable; a partial listing that
  // mapped nothing → first_run (slack-leads.ts leadsViewStateOf).
  return { state: leadsViewStateOf(run, coverage), run, coverage };
}

/** No Slack call, ever. off | not_installed | reading_off (P7a's state isn't "on") | first_run (on, no run summary yet; v1.1
 *  product-10) | no_channels | ok | unavailable (a read failed). */
export async function leadsState(principal: ExecPrincipal, settings: ExecSettings, opts?: { signal?: AbortSignal }): Promise<LeadsViewState> {
  try {
    return (await basicsOf(principal, settings, new Date(), opts?.signal)).state;
  } catch (err) {
    opts?.signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] lead state unavailable for ${principal.id} (${errName(err)})`);
    return "unavailable";
  }
}

/** The brief's block (v1.1 product-2). localDate = yesterday in the LEAD zone (principal.timezone, C14) at gather time; `dated`
 *  when that differs from the brief zone's yesterday. null when the state is off / not_installed / reading_off / no_channels
 *  (the block is hidden); { v: 1, unavailable: true, localDate } when the state is "unavailable" or any read here fails (the
 *  block renders "Couldn't load lead counts." instead of vanishing); otherwise briefLeadsFrom(summary rows, channel states, …)
 *  with failing = the run summary's failingRuns > 0, and firstRun = the state is "first_run". */
export async function briefLeadsFor(principal: ExecPrincipal, settings: ExecSettings, now: Date, opts: { signal: AbortSignal }): Promise<BriefLeadsBlock | null> {
  const signal = opts?.signal;
  const localDate = addLocalDays(localDateString(now, principal.timezone), -1);
  const briefZone = typeof principal.briefTimezone === "string" && principal.briefTimezone.length > 0 ? principal.briefTimezone : principal.timezone;
  const dated = localDate !== addLocalDays(localDateString(now, briefZone), -1);
  const unavailable: BriefLeadsUnavailable = { v: 1, unavailable: true, localDate };
  if (settings.slackP10SchemaReady !== true || settings.slackLeadCountsEnabled !== true) return null;
  let basics: Basics;
  try {
    basics = await basicsOf(principal, settings, now, signal);
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] brief leads unavailable for ${principal.id} (${errName(err)})`);
    return unavailable;
  }
  if (basics.state === "off" || basics.state === "not_installed" || basics.state === "reading_off" || basics.state === "no_channels") return null;
  // ui-5: a failing job with nothing mapped lands here too ("Couldn't load lead counts.", never a hidden block).
  if (basics.state === "unavailable") return unavailable;
  try {
    const sig = signal ? { signal } : {};
    const [rows, states] = await Promise.all([leadSummary(principal, localDate, localDate, sig), listLeadChannelStates(principal, sig)]);
    return briefLeadsFrom(rows, states, localDate, basics.run?.at ?? null, {
      failing: (basics.run?.failingRuns ?? 0) > 0,
      dated,
      firstRun: basics.state === "first_run"
    });
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] brief leads unavailable for ${principal.id} (${errName(err)})`);
    return unavailable;
  }
}

/** §3.8 item 7 (C56, v1.1 product-2): whether the brief DM and the brief page show the stored leads block: lead counts on and
 *  the state ok, first_run or unavailable (a stored "Couldn't load" block shows rather than vanishing); off, not_installed,
 *  reading_off and no_channels hide it. A failure of this read → visible exactly when the settings say lead counts are on. */
export async function briefLeadsVisible(principal: ExecPrincipal, settings: ExecSettings, opts?: { signal?: AbortSignal }): Promise<boolean> {
  const on = settings.slackP10SchemaReady === true && settings.slackLeadCountsEnabled === true;
  if (!on) return false;
  try {
    const state = await leadsState(principal, settings, opts);
    return state === "ok" || state === "first_run" || state === "unavailable";
  } catch (err) {
    opts?.signal?.throwIfAborted();
    return on;
  }
}

/** The installation's team id for the fix lists' links; null when it can't be read (the card keeps its counts). */
async function teamIdOf(principal: ExecPrincipal, signal?: AbortSignal): Promise<string | null> {
  try {
    const row = await getActiveInstallation(principal, signal ? { signal } : undefined);
    return row !== null && typeof row.teamId === "string" ? row.teamId : null;
  } catch (err) {
    signal?.throwIfAborted();
    return null;
  }
}

/** The Slack tab (§3.9.1). v1.1 product-10: also reads the typed list (listFbLeadChannelsV2) and the installation's team id for
 *  the fix lists; a failure of either leaves `fix` with counts only (never fails the card). No Slack call. */
export async function leadCountsView(principal: ExecPrincipal, settings: ExecSettings, now: Date, opts: { signal: AbortSignal }): Promise<LeadCountsView> {
  const signal = opts?.signal;
  const tz = principal.timezone;
  const empty = (state: LeadsViewState): LeadCountsView => ({ state, asOf: null, tz, totals: null, clients: [], unlinked: null, coverage: null, fix: null });
  let basics: Basics;
  try {
    basics = await basicsOf(principal, settings, now, signal);
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] lead counts view unavailable for ${principal.id} (${errName(err)})`);
    return empty("unavailable");
  }
  if (basics.state !== "ok" && basics.state !== "no_channels") return empty(basics.state);
  try {
    const sig = signal ? { signal } : {};
    const today = localDateString(now, tz);
    const [rows, states, list, teamId] = await Promise.all([
      leadSummary(principal, addLocalDays(today, -6), today, sig),
      listLeadChannelStates(principal, sig),
      listFbLeadChannelsV2(principal, sig).catch((err: unknown) => {
        signal?.throwIfAborted();
        console.warn(`[exec-slack-leads] the typed list is unavailable for ${principal.id} (${errName(err)})`);
        return null;
      }),
      teamIdOf(principal, signal)
    ]);
    const view = leadCountsViewFrom({ today, tz, rows, coverage: basics.coverage, run: basics.run, states, list, teamId });
    return { ...view, state: basics.state };
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] lead counts view unavailable for ${principal.id} (${errName(err)})`);
    return empty("unavailable");
  }
}

export type ChatLeadsCounts = { vob: number; nonvob: number; calendly: number; zap_errors: number; kinds: LeadKind[] };
export type ChatLeadsPart =
  | { state: Exclude<LeadsViewState, "ok"> }
  | { state: "ok";
      parts: { part: "today_so_far" | "yesterday" | "last_7_days"; from: string; to: string;
        totals: ChatLeadsCounts;                                   // v1.1 product-9: linked clients only
        clients: ({ client: string } & ChatLeadsCounts)[]; more: number; unlinked: ChatLeadsCounts | null; incomplete: boolean }[];
      as_of: string | null; basis: string; note: string };        // basis = SLACK_P10_COPY.leads.chatBasis filled

type PartName = "today_so_far" | "yesterday" | "last_7_days";

const zeroCounts = (): ChatLeadsCounts => ({ vob: 0, nonvob: 0, calendly: 0, zap_errors: 0, kinds: [] });
const ordered = (kinds: Iterable<LeadKind>): LeadKind[] => {
  const set = new Set(kinds);
  return LEAD_KINDS_SHOWN.filter((k) => set.has(k));
};
const nonNeg = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);

function addRow(c: ChatLeadsCounts, r: LeadSummaryRow): void {
  const n = nonNeg(r.n);
  if (r.kind === "vob") c.vob += n;
  else if (r.kind === "nonvob") c.nonvob += n;
  else if (r.kind === "calendly") c.calendly += n;
  else if (r.kind === "zap_errors") c.zap_errors += n;
  else return;
  c.kinds = ordered([...c.kinds, r.kind]);
}

/** The rows of one client: its DD client id, else (no DD client) its label exactly. No filter → every row. */
function clientFilter(q: { clientId?: string | null; clientName?: string | null }): ((r: LeadSummaryRow) => boolean) | null {
  const id = typeof q.clientId === "string" && q.clientId.length > 0 ? q.clientId : null;
  const name = typeof q.clientName === "string" && q.clientName.length > 0 ? q.clientName : null;
  if (id === null && name === null) return null;
  return (r) => r.groupKey !== "unlinked" && ((id !== null && r.clientId === id) || (r.clientId === null && name !== null && r.clientLabel === name));
}

/** P10 fixer correctness-3: the lead channels of the same client as clientFilter's rows (linked, by id, else by exact label);
 *  null = every channel. */
function stateFilter(q: { clientId?: string | null; clientName?: string | null }): ((s: LeadChannelState) => boolean) | null {
  const id = typeof q.clientId === "string" && q.clientId.length > 0 ? q.clientId : null;
  const name = typeof q.clientName === "string" && q.clientName.length > 0 ? q.clientName : null;
  if (id === null && name === null) return null;
  return (s) => LINKED_LINKS.has(s.link) && ((id !== null && s.clientId === id) || (s.clientId === null && name !== null && s.clientLabel === name));
}
const LINKED_LINKS: ReadonlySet<string> = new Set(["fb_id", "fb_name", "fb_sibling"]);

/** One whole-local-days part of the chat answer. P10 fixer correctness-3: `incomplete` also when a counted channel of the
 *  part has no whole count for one of its days (leadStatesCover): a missing row is never a zero. */
function chatPart(rows: readonly LeadSummaryRow[], part: PartName, from: string, to: string, filtered: boolean,
  cover: { states: readonly LeadChannelState[]; keep: ((s: LeadChannelState) => boolean) | null; today: string; tz: string }):
  Extract<ChatLeadsPart, { state: "ok" }>["parts"][number] {
  const groups = new Map<string, { label: string; counts: ChatLeadsCounts }>();
  const totals = zeroCounts();
  let unlinked: ChatLeadsCounts | null = null;
  let incomplete = !leadStatesCover(cover.states, from, to, cover.today, cover.tz, cover.keep ?? undefined);
  for (const r of rows) {
    if (r.day < from || r.day > to || r.kind === "other") continue;
    if (r.complete !== true) incomplete = true;
    if (r.groupKey === "unlinked") {
      if (filtered) continue;
      unlinked ??= zeroCounts();
      addRow(unlinked, r);
      continue;
    }
    let g = groups.get(r.groupKey);
    if (!g) {
      g = { label: "", counts: zeroCounts() };
      groups.set(r.groupKey, g);
    }
    if (typeof r.clientLabel === "string" && r.clientLabel.length > 0 && (g.label === "" || r.clientLabel < g.label)) g.label = r.clientLabel;
    addRow(g.counts, r);
    addRow(totals, r);
  }
  const clients = [...groups.values()]
    .map((g) => ({ client: g.label.slice(0, P10_LIMITS.leadLabelChars), ...g.counts }))
    .sort((a, b) => (b.vob + b.nonvob + b.calendly) - (a.vob + a.nonvob + a.calendly) || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0));
  return { part, from, to, totals, clients: clients.slice(0, CHAT_CLIENTS_MAX), more: Math.max(0, clients.length - CHAT_CLIENTS_MAX), unlinked, incomplete };
}

/** "3:05 PM" in his zone (the basis line's {time}). P10 fixer correctness-3: a run from before today's local midnight says its
 *  date too ("Nov 17, 10:00 PM"), so "today so far as of" never names yesterday's run as if it were today's. */
function timeIn(iso: string, tz: string, today: string): string {
  try {
    const at = new Date(iso);
    const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
    if (localDateString(at, tz) === today) return time;
    return `${new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(at)}, ${time}`;
  } catch {
    return iso;
  }
}

/** Chat (§3.6.2): all clients or one, by get_overview's `since`. v1.1 product-18: every part is whole local days in
 *  principal.timezone; "last_24h" returns two parts, yesterday and today so far, never one sum. */
export async function chatLeadsPart(principal: ExecPrincipal, settings: ExecSettings, q: { since: "today" | "yesterday" | "last_24h" | "last_7_days";
  clientId?: string | null; clientName?: string | null }, now: Date, opts: { signal: AbortSignal }): Promise<ChatLeadsPart> {
  const signal = opts?.signal;
  const tz = principal.timezone;
  let basics: Basics;
  try {
    basics = await basicsOf(principal, settings, now, signal);
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] chat lead counts unavailable for ${principal.id} (${errName(err)})`);
    return { state: "unavailable" };
  }
  if (basics.state !== "ok") return { state: basics.state };
  const today = localDateString(now, tz);
  const yesterday = addLocalDays(today, -1);
  const windows: { part: PartName; from: string; to: string }[] =
    q.since === "yesterday" ? [{ part: "yesterday", from: yesterday, to: yesterday }]
      : q.since === "last_24h" ? [{ part: "yesterday", from: yesterday, to: yesterday }, { part: "today_so_far", from: today, to: today }]
        : q.since === "last_7_days" ? [{ part: "last_7_days", from: addLocalDays(today, -6), to: today }]
          : [{ part: "today_so_far", from: today, to: today }];
  const from = windows.reduce((m, w) => (w.from < m ? w.from : m), today);
  let rows: LeadSummaryRow[];
  let states: LeadChannelState[];
  try {
    const sig = signal ? { signal } : {};
    [rows, states] = await Promise.all([leadSummary(principal, from, today, sig), listLeadChannelStates(principal, sig)]);
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] chat lead counts unavailable for ${principal.id} (${errName(err)})`);
    return { state: "unavailable" };
  }
  const filter = clientFilter(q);
  const kept = filter === null ? rows : rows.filter(filter);
  const cover = { states, keep: stateFilter(q), today, tz };
  const asOf = basics.run?.at ?? null;
  return {
    state: "ok",
    parts: windows.map((w) => chatPart(kept, w.part, w.from, w.to, filter !== null, cover)),
    as_of: asOf,
    basis: fillP10(SLACK_P10_COPY.leads.chatBasis, { tz, time: timeIn(asOf ?? now.toISOString(), tz, today) }),
    note: SLACK_P10_COPY.leads.chatNote
  };
}

/** client_overview's lead part (§3.6.2): that client's today so far / yesterday / last 7 days. */
export type ChatClientLeads =
  | { state: Exclude<LeadsViewState, "ok"> }
  | { state: "ok"; kinds: LeadKind[]; today_so_far: ChatLeadsCounts; yesterday: ChatLeadsCounts; last_7_days: ChatLeadsCounts;
      incomplete: boolean; as_of: string | null; basis: string; note: string };

/** §3.6.2: clientDetail's `leads` part. The client by id, else (no DD client) by exact label; whole local days in
 *  principal.timezone. */
export async function chatClientLeads(principal: ExecPrincipal, settings: ExecSettings, q: { clientId: string | null; clientName: string | null },
  now: Date, opts: { signal: AbortSignal }): Promise<ChatClientLeads> {
  const signal = opts?.signal;
  const tz = principal.timezone;
  let basics: Basics;
  try {
    basics = await basicsOf(principal, settings, now, signal);
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] client lead counts unavailable for ${principal.id} (${errName(err)})`);
    return { state: "unavailable" };
  }
  if (basics.state !== "ok") return { state: basics.state };
  const today = localDateString(now, tz);
  const yesterday = addLocalDays(today, -1);
  const from7 = addLocalDays(today, -6);
  let rows: LeadSummaryRow[];
  let states: LeadChannelState[];
  try {
    const sig = signal ? { signal } : {};
    [rows, states] = await Promise.all([leadSummary(principal, from7, today, sig), listLeadChannelStates(principal, sig)]);
  } catch (err) {
    signal?.throwIfAborted();
    console.warn(`[exec-slack-leads] client lead counts unavailable for ${principal.id} (${errName(err)})`);
    return { state: "unavailable" };
  }
  const filter = clientFilter(q) ?? (() => false);
  const mine = rows.filter((r) => filter(r) && r.kind !== "other");
  const keep = stateFilter(q) ?? (() => false);
  const sum = (lo: string, hi: string): ChatLeadsCounts => {
    const c = zeroCounts();
    for (const r of mine) if (r.day >= lo && r.day <= hi) addRow(c, r);
    return c;
  };
  const asOf = basics.run?.at ?? null;
  return {
    state: "ok",
    kinds: ordered(mine.map((r) => r.kind)),
    today_so_far: sum(today, today),
    yesterday: sum(yesterday, yesterday),
    last_7_days: sum(from7, today),
    // P10 fixer correctness-3: a row's lower bound, or a channel of this client without a whole count for a day of the week.
    incomplete: mine.some((r) => r.complete !== true) || !leadStatesCover(states, from7, today, today, tz, keep),
    as_of: asOf,
    basis: fillP10(SLACK_P10_COPY.leads.chatBasis, { tz, time: timeIn(asOf ?? now.toISOString(), tz, today) }),
    note: SLACK_P10_COPY.leads.chatNote
  };
}

/** The most frequent error code of a run (ties by code), for the System row when the run itself didn't fail. */
function topError(errors: Readonly<Record<string, number>> | undefined): string | null {
  let best: string | null = null;
  let most = 0;
  for (const [code, n] of Object.entries(errors ?? {})) {
    if (n > most || (n === most && best !== null && code < best)) {
      best = code;
      most = n;
    }
  }
  return best;
}

/** The System card row (C58), from the run summary and coverage only. v1.1 product-2: the failure form's fields. */
export async function leadSystemRow(principal: ExecPrincipal, opts?: { signal?: AbortSignal }): Promise<{ lastRunAt: string | null; channels: number;
  unlinked: number; listedNotMember: number; lastError: string | null; failingRuns: number; failCode: string | null } | null> {
  const sig = opts?.signal ? { signal: opts.signal } : {};
  if (!(await leadSchemaReady(sig))) return null;
  const run = (await getSyncState(principal, "slack", "lead-run", parseLeadRunSummary, sig))?.value ?? null;
  const coverage = await leadCoverage(principal, localDateString(new Date(), principal.timezone), sig);
  return {
    lastRunAt: run?.at ?? null,
    channels: coverage !== null ? coverage.channels : run?.channels ?? 0,
    unlinked: coverage !== null ? coverage.unlinked + coverage.ambiguous : 0,
    listedNotMember: run?.listedNotMember ?? 0,
    lastError: run?.failCode ?? topError(run?.errors),
    failingRuns: run?.failingRuns ?? 0,
    failCode: run?.failCode ?? null
  };
}
