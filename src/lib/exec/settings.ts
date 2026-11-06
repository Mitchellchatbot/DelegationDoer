import "server-only";

import { feedbackTotals } from "@/lib/exec/attention-feedback";
import { getVoiceProfile } from "@/lib/exec/drafts-store";
import {
  loadSettings,
  loadSettingsSnapshot,
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
import { getSyncState, parseAccountsState } from "@/lib/exec/sync-state";
import { startOfLocalDayUtc } from "@/lib/exec/time";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type ExecSurface } from "@/lib/exec/types";
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
//     §3.12.6 step 1).
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
  | { outcome: "confirmation_required"; field: "ddtextEnabled" };

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
 * Throws on a database error (the route answers 503).
 */
export async function updateSettings(
  principal: ExecPrincipal,
  patch: SettingsPatch,
  opts: { expectedVersion: string | null; confirm?: "ddtext_notice"; now?: Date; signal?: AbortSignal }
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

  const [pinned, spend, recentAccess, feedback, voice] = await Promise.all([
    section("pinned mailbox", () => pinnedMailbox(principal, signal)),
    section("spend", () => spendTodayByFeature(principal, at, { capUsd: settings.dailyCostCapUsd, signal })),
    section("recent access", () => listRecentAccess(principal, RECENT_ACCESS_DEFAULT, { signal })),
    section("feedback totals", async () => (settings.ddtextSchemaReady ? feedbackTotals(principal, at, { signal }) : null)),
    section("voice profile", async () =>
      settings.draftsSchemaReady
        ? { installed: true, profile: await getVoiceProfile(principal, { signal }) }
        : { installed: false, profile: null }
    )
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
    voice
  };
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
