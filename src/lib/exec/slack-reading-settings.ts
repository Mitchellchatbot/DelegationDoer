import "server-only";

import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { DEFAULT_SETTINGS, loadSettingsSnapshot } from "@/lib/exec/principal";
import { SlackStoreError, getReadingHalf, lastReadingEventAt, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import {
  SlackReadStoreError,
  countChannels,
  countOpenItems,
  countPendingTriage,
  isSlackReadingSchemaMissing,
  lastSweepAt,
  listPickerChannels
} from "@/lib/exec/slack-read-store";
import {
  SLACK_CAP_FEATURES,
  SLACK_READ_LIMITS,
  effectiveSlackCapUsd,
  tsToMs,
  type ChannelRow,
  type DenyReason,
  type ReadingHalf,
  type SlackReadingViewState,
  type WatchState
} from "@/lib/exec/slack-read-types";
import type { PickerRow, SlackReadingView } from "@/lib/exec/slack-types";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P7a Settings: the reading view and the picker rows (P7a contract §3.16, N4,
// N11, N12, N20, C29; Area E; server-only). PickerRow and SlackReadingView are
// declared in slack-types.ts beside P6's SlackSettingsView (pure, so the
// client components import their types from there) and re-exported here as
// §3.16 names them.
//
// The state, in this order (§3.16):
//   no P7a schema (the installation's reading columns, or the settings'
//     "slack" group, missing)                          → not_installed
//   no active installation (P6 not_connected / revoked) → bot_not_connected
//   reading_state none                                  → not_consented
//   reading_state revoked                               → revoked
//   user_last_error_code set                            → error
//   discovered_at null                                  → discovering
//   the switch (slack_reading_enabled) off              → paused
//   else                                                → on
// What each state reads on top: the conversation counts for discovering,
// paused, on and error; the picker rows (≤ 1,000: watched, then muted, then
// unwatched, each by name) for paused and on; the status figures (last event,
// last sweep, pending triage, open items) for every live state; today's Slack
// spend for paused and on (null when it can't be read: the line says so).
//
// Fail soft: a read that fails gives state "error" with readFailed (P7a fixer
// ui-3: nothing was rejected by Slack, so no error code and no Allow; the
// installation id kept when it was read, so Stop reading is still offered),
// and one log line naming the principal id, the store operation and the
// database's error code. A missing P7a table, function or
// column is the not_installed answer, never a failure. Never a value from a
// row in a log: channel names are metadata the picker shows, never logged.

export type { PickerRow, SlackReadingView } from "@/lib/exec/slack-types";

const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]);
const WATCH_ORDER: Readonly<Record<WatchState, number>> = { watched: 0, muted: 1, unwatched: 2 };
const DM_SCOPES = ["im:history", "im:read"] as const;
const GROUP_DM_SCOPES = ["mpim:history", "mpim:read"] as const;

type Base = Omit<SlackReadingView, "state">;

/** A missing P7a (or P6) table, function or column, from either store's error or a raw PostgREST error. */
function schemaMissing(err: unknown): boolean {
  if (err instanceof SlackStoreError || err instanceof SlackReadStoreError) return err.pgCode !== null && SCHEMA_MISSING_CODES.has(err.pgCode);
  return isSlackReadingSchemaMissing(err);
}

/** What a failed read is called in the log: the store's op and code, else the error's class name. Never its message. */
function failureCode(err: unknown): string {
  if (err instanceof SlackStoreError || err instanceof SlackReadStoreError) return err.pgCode ? `${err.op}, ${err.pgCode}` : err.op;
  if (err instanceof Error) return err.name;
  return "error";
}

const zeroCounts = (): SlackReadingView["counts"] => ({
  watched: 0,
  muted: 0,
  unwatched: 0,
  never: 0,
  neverByReason: {},
  hubs: 0,
  dms: { watched: 0, total: 0 },
  groupDms: { watched: 0, total: 0 }
});

function settingsPart(s: Pick<ExecSettings, "slackReadingEnabled" | "watchMode" | "slackDailyCapUsd" | "dailyCostCapUsd" | "retentionDaysSlack">): Pick<
  Base,
  "switchOn" | "watchMode" | "capUsd" | "effectiveCapUsd" | "retentionDaysSlack"
> {
  return {
    switchOn: s.slackReadingEnabled === true,
    watchMode: s.watchMode === "active_public" ? "active_public" : "member_only",
    capUsd: typeof s.slackDailyCapUsd === "number" && Number.isFinite(s.slackDailyCapUsd) ? s.slackDailyCapUsd : DEFAULT_SETTINGS.slackDailyCapUsd,
    effectiveCapUsd: effectiveSlackCapUsd(s),
    retentionDaysSlack: Number.isInteger(s.retentionDaysSlack) ? s.retentionDaysSlack : DEFAULT_SETTINGS.retentionDaysSlack
  };
}

/** The view with nothing read: every count zero, no installation, the default settings. */
function emptyView(state: SlackReadingViewState): SlackReadingView {
  return {
    state,
    settingsVersion: null,
    ...settingsPart(DEFAULT_SETTINGS),
    switchOn: false,
    installationId: null,
    scopes: [],
    dmsGranted: false,
    groupDmsGranted: false,
    consentedAt: null,
    discoveredAt: null,
    revokedAt: null,
    revokeReason: null,
    lastErrorCode: null,
    counts: zeroCounts(),
    channels: [],
    lastEventAt: null,
    lastSweepAt: null,
    pendingTriage: 0,
    openItems: 0,
    spentTodayUsd: null
  };
}

/** §3.16's state from the reading half and the switch. */
export function readingViewState(reading: Pick<ReadingHalf, "state" | "lastErrorCode" | "discoveredAt">, switchOn: boolean): SlackReadingViewState {
  if (reading.state === "none") return "not_consented";
  if (reading.state === "revoked") return "revoked";
  if (reading.lastErrorCode !== null) return "error";
  if (reading.discoveredAt === null) return "discovering";
  return switchOn ? "on" : "paused";
}

/**
 * One channel row as the picker shows it (§3.16, C29), or null for a row the picker never lists (a never-read
 * marker, a DM or group DM: those are counts only). kind "private" for a private channel; canChange false for a hub,
 * an unclassified conversation and a private conversation he left. version = the row's updated_at (the CAS token
 * exec_slack_set_watch compares).
 */
export function pickerRowFromChannel(row: ChannelRow): PickerRow | null {
  if (!row || row.class === "deny" || (row.convType !== "channel" && row.convType !== "group")) return null;
  let lastActivityAt: string | null = null;
  if (typeof row.lastActivityTs === "string") {
    try {
      lastActivityAt = new Date(tsToMs(row.lastActivityTs)).toISOString();
    } catch {
      lastActivityAt = null;
    }
  }
  const isPrivate = row.isPrivate === true || row.convType === "group";
  return {
    channelId: row.channelId,
    name: typeof row.name === "string" ? row.name : "",
    kind: isPrivate ? "private" : "public",
    class: row.class,
    financeName: row.financeName === true,
    watchState: row.watchState,
    muteSource: row.muteSource,
    isMember: row.isMember === true,
    activity30d: typeof row.activity30d === "number" && Number.isFinite(row.activity30d) ? row.activity30d : null,
    lastActivityAt,
    version: row.updatedAt,
    canChange: row.class !== "hub" && row.class !== "unclassified" && !(isPrivate && row.leftAt !== null)
  };
}

const byName = (a: PickerRow, b: PickerRow): number => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;
};

/** C29: watched, then muted, then unwatched; each by name (then id); at most SLACK_READ_LIMITS.pickerRows. */
export function orderPickerRows(rows: readonly PickerRow[]): PickerRow[] {
  return [...rows]
    .sort((a, b) => WATCH_ORDER[a.watchState] - WATCH_ORDER[b.watchState] || byName(a, b))
    .slice(0, SLACK_READ_LIMITS.pickerRows);
}

/** The conversation counts as the picker shows them; never = every never-read conversation, by reason (counts only). */
function countsFrom(c: Awaited<ReturnType<typeof countChannels>>): SlackReadingView["counts"] {
  const neverByReason: Partial<Record<DenyReason, number>> = {};
  let never = 0;
  for (const [reason, n] of Object.entries(c.denyByReason) as [DenyReason, number | undefined][]) {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    neverByReason[reason] = n;
    never += n;
  }
  return {
    watched: c.byWatch.watched,
    muted: c.byWatch.muted,
    unwatched: c.byWatch.unwatched,
    never,
    neverByReason,
    hubs: c.hubs,
    dms: { watched: c.dms.watched, total: c.dms.total },
    groupDms: { watched: c.groupDms.watched, total: c.groupDms.total }
  };
}

/**
 * The Settings reading view (§3.16). Fail soft: a read failure → state "error" with readFailed (no error code),
 * logged by id. `opts.signal` (additive) bounds the reads that take one (the schema check, the installation, the
 * spend), e.g. the Settings page's shared deadline. Never throws.
 */
export async function getSlackReadingView(principal: ExecPrincipal, now: Date, opts: { signal?: AbortSignal } = {}): Promise<SlackReadingView> {
  const signal = opts.signal;
  const principalId = principal && typeof principal.id === "string" ? principal.id : "(none)";
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  let installationId: string | null = null;
  try {
    if (!(await slackReadingSchemaReady({ signal }))) return emptyView("not_installed");
    const half = await getReadingHalf(principal, { signal });
    if (half === null) return emptyView("bot_not_connected");
    const { row, reading } = half;
    installationId = row.id;
    const snapshot = await loadSettingsSnapshot(principal.id);
    const settings = snapshot.settings;
    // The "slack" settings group missing means the P7a migration isn't (fully) there: nothing reading-side can be set.
    if (settings.slackReadingSchemaReady !== true) return emptyView("not_installed");
    const base: SlackReadingView = {
      ...emptyView(readingViewState(reading, settings.slackReadingEnabled === true)),
      ...settingsPart(settings),
      settingsVersion: snapshot.version,
      installationId: row.id,
      scopes: [...reading.scopes],
      dmsGranted: DM_SCOPES.every((s) => reading.scopes.includes(s)),
      groupDmsGranted: GROUP_DM_SCOPES.every((s) => reading.scopes.includes(s)),
      consentedAt: reading.installedAt,
      discoveredAt: reading.discoveredAt,
      revokedAt: reading.revokedAt,
      revokeReason: reading.revokeReason,
      lastErrorCode: reading.lastErrorCode
    };
    const state = base.state;
    if (state === "not_consented" || state === "revoked") return base;

    // A live (or failing) reading half: the counts and the status figures.
    const [counts, lastEventAt, lastSweep, pendingTriage, openItems] = await Promise.all([
      countChannels(principal),
      lastReadingEventAt(row.id),
      lastSweepAt(principal),
      countPendingTriage(principal),
      countOpenItems(principal)
    ]);
    const view: SlackReadingView = { ...base, counts: countsFrom(counts), lastEventAt, lastSweepAt: lastSweep, pendingTriage, openItems };
    if (state !== "paused" && state !== "on") return view;

    const rows = await listPickerChannels(principal, SLACK_READ_LIMITS.pickerRows);
    view.channels = orderPickerRows(rows.flatMap((r) => {
      const p = pickerRowFromChannel(r);
      return p === null ? [] : [p];
    }));
    try {
      view.spentTodayUsd = await featureSpentTodayUsd(principal.id, principal.timezone, SLACK_CAP_FEATURES, at, { signal });
    } catch (err) {
      // The spend line says it couldn't be read (null); the rest of the view stands.
      console.error(`[exec-slack] reading spend not read for ${principalId} (${failureCode(err)})`);
      view.spentTodayUsd = null;
    }
    return view;
  } catch (err) {
    if (schemaMissing(err)) return emptyView("not_installed");
    console.error(`[exec-slack] reading view read failed for ${principalId} (${failureCode(err)})`);
    return { ...emptyView("error"), installationId, readFailed: true };
  }
}
