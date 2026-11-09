import "server-only";

import { effectiveChatCapUsd } from "@/lib/exec/agent/budget";
import { feedbackTotals } from "@/lib/exec/attention-feedback";
import type { BriefSettingsView } from "@/lib/exec/brief-settings";
import { getVoiceProfile } from "@/lib/exec/drafts-store";
import {
  loadSettings,
  loadSettingsSnapshot,
  resolveTimezone,
  settingsColumnsFor,
  settingsSchemaFlags,
  snapshotFromRow,
  type SettingsSnapshot
} from "@/lib/exec/principal";
import {
  SETTINGS_FIELDS,
  isSettingsFieldInstalled,
  settingsFieldFor,
  validateSettingsField,
  type SettingsFieldDef,
  type SettingsPatch
} from "@/lib/exec/settings-fields";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import { getSyncState, parseAccountsState } from "@/lib/exec/sync-state";
import { startOfLocalDayUtc } from "@/lib/exec/time";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type ExecSurface, type WatchMode } from "@/lib/exec/types";
import type { RecentAccessRow, Section, SettingsView, SpendToday } from "@/lib/exec/view-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The Settings service (P5a contract §3.7.2, A6, C14; Area B): the CAS writer
// over the field registry (settings-fields.ts), the page model, recent access
// and today's spend. Only this file and principal.ts write the settings table
// (boundary rule 14).
//
//   * A write validates every field against SETTINGS_FIELDS (the client-safe
//     registry the form also validates with) and against the schema flags of
//     a fresh tolerant read, then compare-and-sets on updated_at exactly as
//     PostgREST printed it (C3, C14). It writes the patch's columns and
//     updated_at, nothing else, and returns the row its CAS selected, so an
//     applied change needs no second read.
//   * Turning DD text triage on needs the notice confirmation (C14); turning
//     it off writes only the flag (the next ddtext run deletes its data,
//     §3.12.6 step 1). Turning Slack reading on (P7a N20) needs its own
//     notice confirmation ("slack_reading_notice"); turning it off writes only
//     the flag (reading pauses; stored items stay until their TTL, and
//     deletes, edits and lifecycle purges keep applying, C43).
//   * The page model's sections fail soft ({ ok: false }, never a zero); only
//     the settings read itself fails the page.
//   * Nothing here logs a value: errors name the section and the database's
//     own message.

const SETTINGS_TABLE = "exec_settings";
const ACCESS_TABLE = "exec_access_log";
const USAGE_TABLE = "exec_ai_usage";
const RECENT_ACCESS_DEFAULT = 50;
const RECENT_ACCESS_MAX = 200;
const DEVICE_CHARS = 120;
const SESSION_TAG_CHARS = 8;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const READ_TIMEOUT_MS = 15_000;
const VERSION_MAX_CHARS = 64;
const SURFACES: readonly ExecSurface[] = ["web", "slack", "cron", "job"];

export type UpdateSettingsResult =
  | { outcome: "updated"; snapshot: SettingsSnapshot }
  | { outcome: "conflict"; snapshot: SettingsSnapshot }
  | { outcome: "not_installed"; field: keyof SettingsPatch }
  | { outcome: "invalid"; field: keyof SettingsPatch | "patch"; detail: string }
  | { outcome: "confirmation_required"; field: "ddtextEnabled" | "slackReadingEnabled" };   // P7a §3.2 widens field

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requirePrincipal(principal: ExecPrincipal): void {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new NonRetryableError("exec settings: an ExecPrincipal is required");
  }
}

function validNow(now: Date | undefined): Date {
  const at = now ?? new Date();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new NonRetryableError("exec settings: now must be a valid Date");
  return at;
}

/** The patch's fields in registry order, each validated; the first problem wins. */
function checkPatch(patch: SettingsPatch): { ok: true; fields: { def: SettingsFieldDef; value: unknown }[] } | Extract<UpdateSettingsResult, { outcome: "invalid" }> {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return { outcome: "invalid", field: "patch", detail: "must be an object" };
  const entries = Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return { outcome: "invalid", field: "patch", detail: "must change at least one setting" };
  for (const [key] of entries) {
    if (!settingsFieldFor(key)) return { outcome: "invalid", field: "patch", detail: "names a setting that can't be changed here" };
  }
  const given = new Map(entries);
  const fields: { def: SettingsFieldDef; value: unknown }[] = [];
  for (const def of SETTINGS_FIELDS) {
    if (!given.has(def.key)) continue;
    const value = given.get(def.key);
    const check = validateSettingsField(def, value);
    if (!check.ok) return { outcome: "invalid", field: def.key, detail: check.detail };
    fields.push({ def, value });
  }
  return { ok: true, fields };
}

/**
 * Validates every field against SETTINGS_FIELDS and the current schema flags, then
 *   update exec_settings set <cols>, updated_at = now where principal_id = p and updated_at = expectedVersion
 *   (.select(...)); 0 rows → re-read → conflict. expectedVersion null and no row → insert … on conflict do nothing.
 * Turning ddtextEnabled false→true needs opts.confirm === "ddtext_notice".
 * P7a (§3.2, N20): turning slackReadingEnabled false→true needs opts.confirm === "slack_reading_notice"; a P7a key
 * ("slack" group) before the P7a migration is applied answers not_installed (the schema check above).
 * Throws on a database error (the route answers 503).
 */
export async function updateSettings(
  principal: ExecPrincipal,
  patch: SettingsPatch,
  opts: { expectedVersion: string | null; confirm?: "ddtext_notice" | "slack_reading_notice"; now?: Date; signal?: AbortSignal }
): Promise<UpdateSettingsResult> {
  requirePrincipal(principal);
  const now = validNow(opts.now);
  const expected = opts.expectedVersion;
  if (expected !== null && (typeof expected !== "string" || expected.length === 0 || expected.length > VERSION_MAX_CHARS)) {
    throw new NonRetryableError("exec settings: expectedVersion must be null or the version string the settings read returned");
  }
  const checked = checkPatch(patch);
  if (!("ok" in checked)) return checked;

  const current = await loadSettingsSnapshot(principal.id);
  const schema = settingsSchemaFlags(current.settings);
  for (const { def } of checked.fields) {
    if (!isSettingsFieldInstalled(def, schema)) return { outcome: "not_installed", field: def.key };
  }
  if (patch.ddtextEnabled === true && current.settings.ddtextEnabled !== true && opts.confirm !== "ddtext_notice") {
    return { outcome: "confirmation_required", field: "ddtextEnabled" };
  }
  if (patch.slackReadingEnabled === true && current.settings.slackReadingEnabled !== true && opts.confirm !== "slack_reading_notice") {
    return { outcome: "confirmation_required", field: "slackReadingEnabled" };
  }

  const columns: Record<string, unknown> = {};
  for (const { def, value } of checked.fields) columns[def.column] = value;
  // The new token must differ from the one it replaces, even if this server's
  // clock is behind the last writer's: otherwise a concurrent writer holding
  // the old token would pass the CAS too. (Date.parse drops microseconds, so
  // +1 ms is always later than the stored value.)
  const previousMs = expected === null ? Number.NaN : Date.parse(expected);
  const writeMs = Number.isFinite(previousMs) && previousMs >= now.getTime() ? previousMs + 1 : now.getTime();
  columns.updated_at = new Date(writeMs).toISOString();
  const returning = settingsColumnsFor(schema);

  let rows: unknown;
  if (expected === null) {
    // He saw no row. If one exists now, someone else wrote first.
    if (current.version !== null) return { outcome: "conflict", snapshot: current };
    let insert = getSupabaseAdmin()
      .from(SETTINGS_TABLE)
      .upsert({ principal_id: principal.id, ...columns }, { onConflict: "principal_id", ignoreDuplicates: true })
      .select(returning);
    if (opts.signal) insert = insert.abortSignal(opts.signal);
    const { data, error } = await insert;
    if (error) throw new Error(`exec_settings insert failed: ${error.message}`);
    rows = data;
  } else {
    let update = getSupabaseAdmin()
      .from(SETTINGS_TABLE)
      .update(columns)
      .eq("principal_id", principal.id)
      .eq("updated_at", expected)
      .select(returning);
    if (opts.signal) update = update.abortSignal(opts.signal);
    const { data, error } = await update;
    if (error) throw new Error(`exec_settings update failed: ${error.message}`);
    rows = data;
  }
  const written = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  if (written.length !== 1) return { outcome: "conflict", snapshot: await loadSettingsSnapshot(principal.id) };
  return { outcome: "updated", snapshot: snapshotFromRow(written[0], principal.id, schema) };
}

// ---------------------------------------------------------------------------
// The page model
// ---------------------------------------------------------------------------

async function section<T>(what: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (err) {
    console.error(`[exec-settings] ${what} read failed: ${errMessage(err)}`);
    return { ok: false, error: "unavailable" };
  }
}

/** His pinned mailbox ids, and their addresses as P3's mail/accounts state last recorded them (ids alone when it has none). */
async function pinnedMailbox(principal: ExecPrincipal, signal: AbortSignal): Promise<{ accountIds: string[]; emails: string[] }> {
  const accountIds = [...principal.mailAccountIds];
  if (accountIds.length === 0) return { accountIds, emails: [] };
  const state = await getSyncState(principal, "mail", "accounts", parseAccountsState, { signal });
  const byId = new Map((state?.value.accounts ?? []).map((a) => [a.id, a.email] as const));
  const emails = accountIds.map((id) => byId.get(id)).filter((e): e is string => typeof e === "string" && e.length > 0);
  return { accountIds, emails };
}

/**
 * The Settings page model. The settings read (or the snapshot a write
 * returned, `opts.snapshot`) is the one input that fails the page: it throws,
 * and the routes answer 503. Every other section fails soft. Voice uses P4's
 * getVoiceProfile; "installed" comes from draftsSchemaReady, because that
 * read answers null both without the table and without a row (AM8).
 */
export async function getSettingsView(
  principal: ExecPrincipal,
  now: Date = new Date(),
  opts: { snapshot?: SettingsSnapshot } = {}
): Promise<SettingsView> {
  requirePrincipal(principal);
  const at = validNow(now);
  const snapshot = opts.snapshot ?? (await loadSettingsSnapshot(principal.id));
  const settings: ExecSettings = snapshot.settings;
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);

  const [pinned, spend, recentAccess, feedback, voice, slack] = await Promise.all([
    section("pinned mailbox", () => pinnedMailbox(principal, signal)),
    section("spend", () => spendTodayByFeature(principal, at, { capUsd: settings.dailyCostCapUsd, signal })),
    section("recent access", () => listRecentAccess(principal, RECENT_ACCESS_DEFAULT, { signal })),
    section("feedback totals", async () => (settings.ddtextSchemaReady ? feedbackTotals(principal, at, { signal }) : null)),
    section("voice profile", async () =>
      settings.draftsSchemaReady
        ? { installed: true, profile: await getVoiceProfile(principal, { signal }) }
        : { installed: false, profile: null }
    ),
    // P6 (contract §3.13): the Slack section's view. It fails soft itself (never throws), under the same deadline.
    getSlackSettingsView(principal, { signal })
  ]);

  return {
    generatedAt: at.toISOString(),
    timezone: principal.timezone,
    version: snapshot.version,
    settings,
    schema: settingsSchemaFlags(settings),
    pinnedMailbox: pinned,
    spend,
    recentAccess,
    feedback,
    voice,
    // P5b (C30): pure, from the settings read (P5b's columns missing → chatDailyCapUsd is its default).
    effectiveChatCapUsd: effectiveChatCapUsd(settings),
    slack,
    // P8 (§3.17.5, §3.21.4, C22): the Brief section, from the same snapshot (its CAS version is the page's).
    brief: briefSettingsViewOf(principal, snapshot)
  };
}

// ---------------------------------------------------------------------------
// P8: the brief settings (contract §3.17.5, C22; Area E). brief-settings.ts validates and decides; the write itself is
// here because only settings.ts and principal.ts write exec_settings (boundary rule 14).
// ---------------------------------------------------------------------------

/** The five brief columns P2a's foundation created (always present: no schema group gates them). */
export interface BriefSettingsColumns {
  brief_enabled?: boolean;
  brief_local_time?: string;
  brief_timezone?: string | null;
  checkins_enabled?: boolean;
  supersede_legacy_brief?: boolean;
}

const BRIEF_COLUMNS: ReadonlySet<string> = new Set(["brief_enabled", "brief_local_time", "brief_timezone", "checkins_enabled", "supersede_legacy_brief"]);

/** P8 (§3.17.5): the Settings page's Brief section, from a snapshot. The effective zone follows principalFromRows' rule
 *  (brief_timezone → his work zone → America/New_York), recomputed from the snapshot so a just-saved zone shows at once. */
export function briefSettingsViewOf(principal: ExecPrincipal, snapshot: SettingsSnapshot): BriefSettingsView {
  const s = snapshot.settings;
  return {
    enabled: s.briefEnabled === true,
    time: s.briefLocalTime,
    timezone: s.briefTimezone ?? null,
    effectiveTz: resolveTimezone(s.briefTimezone ?? null, principal.workTimezone),
    workTz: principal.workTimezone,
    checkinsEnabled: s.checkinsEnabled === true,
    supersede: s.supersedeLegacyBrief === true,
    version: snapshot.version
  };
}

/**
 * P8 (§3.17.5, C22): the brief settings write, with updateSettings' CAS on exec_settings.updated_at exactly as PostgREST
 * printed it: `update exec_settings set <columns>, updated_at = now where principal_id and updated_at = expectedVersion`
 * (expectedVersion null and no row → insert … on conflict do nothing). Writes only the five brief columns given (any
 * other key is a TypeError, before anything is read) and updated_at; returns the row its CAS selected, or the current
 * snapshot on a conflict. The caller (brief-settings.ts) has validated the values and the supersede confirmation.
 * Throws on a database error (the route answers 503).
 */
export async function updateBriefSettingsColumns(
  principal: ExecPrincipal,
  columns: BriefSettingsColumns,
  opts: { expectedVersion: string | null; now?: Date; current?: SettingsSnapshot }
): Promise<{ outcome: "updated"; snapshot: SettingsSnapshot } | { outcome: "conflict"; snapshot: SettingsSnapshot }> {
  requirePrincipal(principal);
  const now = validNow(opts.now);
  const keys = Object.keys(columns ?? {}).filter((k) => (columns as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0 || keys.some((k) => !BRIEF_COLUMNS.has(k))) throw new TypeError("exec settings: only the five brief columns, at least one");
  const expected = opts.expectedVersion;
  if (expected !== null && (typeof expected !== "string" || expected.length === 0 || expected.length > VERSION_MAX_CHARS)) {
    throw new NonRetryableError("exec settings: expectedVersion must be null or the version string the settings read returned");
  }
  const current = opts.current ?? (await loadSettingsSnapshot(principal.id));
  const schema = settingsSchemaFlags(current.settings);
  const write: Record<string, unknown> = {};
  for (const k of keys) write[k] = (columns as Record<string, unknown>)[k];
  // As updateSettings: the new token always differs from the one it replaces.
  const previousMs = expected === null ? Number.NaN : Date.parse(expected);
  const writeMs = Number.isFinite(previousMs) && previousMs >= now.getTime() ? previousMs + 1 : now.getTime();
  write.updated_at = new Date(writeMs).toISOString();
  const returning = settingsColumnsFor(schema);
  let rows: unknown;
  if (expected === null) {
    if (current.version !== null) return { outcome: "conflict", snapshot: current };
    const { data, error } = await getSupabaseAdmin()
      .from(SETTINGS_TABLE)
      .upsert({ principal_id: principal.id, ...write }, { onConflict: "principal_id", ignoreDuplicates: true })
      .select(returning);
    if (error) throw new Error(`exec_settings insert failed: ${error.message}`);
    rows = data;
  } else {
    const { data, error } = await getSupabaseAdmin()
      .from(SETTINGS_TABLE)
      .update(write)
      .eq("principal_id", principal.id)
      .eq("updated_at", expected)
      .select(returning);
    if (error) throw new Error(`exec_settings update failed: ${error.message}`);
    rows = data;
  }
  const written = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  if (written.length !== 1) return { outcome: "conflict", snapshot: await loadSettingsSnapshot(principal.id) };
  return { outcome: "updated", snapshot: snapshotFromRow(written[0], principal.id, schema) };
}

// ---------------------------------------------------------------------------
// Recent access and today's spend
// ---------------------------------------------------------------------------

interface AccessRow {
  created_at: unknown;
  route: unknown;
  surface: unknown;
  ip: unknown;
  user_agent: unknown;
  session_id: unknown;
}

const clip = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/**
 * The access log's last `limit` (default 50, at most 200) rows of his, newest
 * first, by the (principal_id, created_at desc) index. device = user_agent
 * clipped to 120 characters; sessionTag = the session id's first 8. Throws on
 * a read error or a malformed row.
 */
export async function listRecentAccess(
  principal: ExecPrincipal,
  limit: number = RECENT_ACCESS_DEFAULT,
  opts: { signal?: AbortSignal } = {}
): Promise<RecentAccessRow[]> {
  requirePrincipal(principal);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new NonRetryableError("exec settings: limit must be a positive integer");
  const n = Math.min(limit, RECENT_ACCESS_MAX);
  let query = getSupabaseAdmin()
    .from(ACCESS_TABLE)
    .select("created_at,route,surface,ip,user_agent,session_id")
    .eq("principal_id", principal.id)
    .order("created_at", { ascending: false })
    .limit(n);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw new Error(`exec_access_log read failed: ${error.message}`);
  return ((data ?? []) as AccessRow[]).map((row) => {
    if (typeof row.created_at !== "string" || typeof row.route !== "string" || !SURFACES.includes(row.surface as ExecSurface)) {
      throw new Error("exec_access_log read failed: a row is malformed");
    }
    return {
      at: row.created_at,
      route: row.route,
      surface: row.surface as ExecSurface,
      ip: clip(row.ip, 64),
      device: clip(row.user_agent, DEVICE_CHARS),
      sessionTag: clip(row.session_id, SESSION_TAG_CHARS)
    };
  });
}

function dollars(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Sums of many numeric(12,6) costs, kept to the column's precision so float noise doesn't show. */
const usd = (n: number) => Math.round(n * 1e6) / 1e6;

const WATCH_MODES: readonly WatchMode[] = ["member_only", "active_public"];

/**
 * P7a (§3.2, §3.10.7, N12, C30): the watch mode, through its own route because P5a's field kinds have no choice type.
 * The same CAS as updateSettings on exec_settings.updated_at, writing watch_mode and updated_at only; returns the row
 * its CAS selected (an applied change needs no second read). A mode other than the two → invalid. Throws on a
 * database error (the route answers 503).
 */
export async function updateWatchMode(principal: ExecPrincipal, mode: WatchMode, opts: { expectedVersion: string | null }): Promise<UpdateSettingsResult> {
  requirePrincipal(principal);
  if (!(WATCH_MODES as readonly unknown[]).includes(mode)) return { outcome: "invalid", field: "patch", detail: "names a watch mode that doesn't exist" };
  const expected = opts?.expectedVersion ?? null;
  if (expected !== null && (typeof expected !== "string" || expected.length === 0 || expected.length > VERSION_MAX_CHARS)) {
    throw new NonRetryableError("exec settings: expectedVersion must be null or the version string the settings read returned");
  }
  const now = new Date();
  const current = await loadSettingsSnapshot(principal.id);
  const schema = settingsSchemaFlags(current.settings);
  const previousMs = expected === null ? Number.NaN : Date.parse(expected);
  const writeMs = Number.isFinite(previousMs) && previousMs >= now.getTime() ? previousMs + 1 : now.getTime();
  const columns = { watch_mode: mode, updated_at: new Date(writeMs).toISOString() };
  const returning = settingsColumnsFor(schema);
  let rows: unknown;
  if (expected === null) {
    if (current.version !== null) return { outcome: "conflict", snapshot: current };
    const { data, error } = await getSupabaseAdmin()
      .from(SETTINGS_TABLE)
      .upsert({ principal_id: principal.id, ...columns }, { onConflict: "principal_id", ignoreDuplicates: true })
      .select(returning);
    if (error) throw new Error(`exec_settings insert failed: ${error.message}`);
    rows = data;
  } else {
    const { data, error } = await getSupabaseAdmin()
      .from(SETTINGS_TABLE)
      .update(columns)
      .eq("principal_id", principal.id)
      .eq("updated_at", expected)
      .select(returning);
    if (error) throw new Error(`exec_settings update failed: ${error.message}`);
    rows = data;
  }
  const written = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  if (written.length !== 1) return { outcome: "conflict", snapshot: await loadSettingsSnapshot(principal.id) };
  return { outcome: "updated", snapshot: snapshotFromRow(written[0], principal.id, schema) };
}

/**
 * His AI spend since local midnight (his zone), by feature, keyset-paged by id
 * as spentTodayUsd (llm/usage.ts). capUsd is his daily cap (read from his
 * settings unless the caller has it). Throws when the spend can't be read.
 */
export async function spendTodayByFeature(
  principal: ExecPrincipal,
  now: Date = new Date(),
  opts: { capUsd?: number; signal?: AbortSignal } = {}
): Promise<SpendToday> {
  requirePrincipal(principal);
  const at = validNow(now);
  const since = startOfLocalDayUtc(at, principal.timezone).toISOString();
  const byFeature = new Map<string, number>();
  let afterId = 0;
  let done = false;
  for (let page = 0; page < MAX_PAGES && !done; page += 1) {
    let query = getSupabaseAdmin()
      .from(USAGE_TABLE)
      .select("id,feature,cost_usd")
      .eq("principal_id", principal.id)
      .gte("created_at", since)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) throw new Error(`exec_ai_usage read failed: ${error.message}`);
    const rows = (data ?? []) as { id: unknown; feature: unknown; cost_usd: unknown }[];
    for (const row of rows) {
      const feature = typeof row.feature === "string" && row.feature.length > 0 ? row.feature : "unknown";
      byFeature.set(feature, (byFeature.get(feature) ?? 0) + dollars(row.cost_usd));
    }
    if (rows.length < PAGE_SIZE) {
      done = true;
    } else {
      const last = rows[rows.length - 1].id;
      const id = typeof last === "string" && /^\d+$/.test(last) ? Number(last) : last;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("exec_ai_usage read failed: a row id is malformed");
      afterId = id;
    }
  }
  if (!done) throw new Error(`exec_ai_usage: over ${PAGE_SIZE * MAX_PAGES} rows today; not guessing the spend`);
  const capUsd = opts.capUsd ?? (await loadSettings(principal.id)).dailyCostCapUsd;
  const features = [...byFeature.entries()]
    .map(([feature, total]) => ({ feature, usd: usd(total) }))
    .sort((a, b) => b.usd - a.usd || a.feature.localeCompare(b.feature));
  return { totalUsd: usd(features.reduce((sum, f) => sum + f.usd, 0)), capUsd, byFeature: features };
}
