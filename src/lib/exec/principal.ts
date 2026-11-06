import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SettingsSchemaKey } from "@/lib/exec/settings-fields";
import type { ExecPrincipal, ExecPrincipalData, ExecSettings, RestrictedPolicy, WatchMode } from "@/lib/exec/types";

// The one place an ExecPrincipal is created.
//
// A principal is an executive the assistant works for (Mitchell today; the
// model allows more). Everything here reads with the service role — the
// AUTHORIZATION decision (is this request really that executive?) lives in
// access.ts for web requests and in the job runner for background work. This
// module only turns database rows into a branded, frozen ExecPrincipal.
//
// Only access.ts, jobs.ts and scheduler.ts (and later the Slack verifier) may
// import loadPrincipal* / listEnabledPrincipals; the boundary test enforces it.

export const DEFAULT_TIMEZONE = "America/New_York";

export const DEFAULT_SETTINGS: Omit<ExecSettings, "principalId"> = {
  briefEnabled: false,
  briefLocalTime: "08:00",
  briefTimezone: null,
  supersedeLegacyBrief: false,
  checkinsEnabled: true,
  // Decision R (plan): until the owner chooses, restricted-sender mail stays
  // hidden from the assistant, matching DD's zero-viewer rule.
  restrictedPolicy: "hidden",
  watchMode: "active_public",
  mutedChannelIds: [],
  retentionDaysSlack: 90,
  retentionDaysEmail: 180,
  retentionDaysChat: 90,
  dailyCostCapUsd: 15,
  // Email stays off until the owner's team runs the enable script (L1), and a
  // settings read that never saw the P3 column can't vouch for the schema.
  emailEnabled: false,
  emailSchemaReady: false,
  // P4 (L1): drafts, send and voice stay off until the team runs the enable
  // scripts, and a settings read that never saw the P4 columns can't vouch
  // for the schema. Stage-0 seed; the P4 column tier comes with Area A (Y2).
  draftsEnabled: false,
  sendEnabled: false,
  voiceEnabled: false,
  draftsSchemaReady: false,
  // P5a (A5, A6): DD text triage stays off until he turns it on in Settings,
  // and a read that never saw the P5a columns can't vouch for the schema.
  // Stage -1 seed (contract §3.7.1); the column-group loader is Area B's.
  ddtextEnabled: false,
  retentionDaysDdtext: 90,
  ddtextSchemaReady: false
};

const PRINCIPAL_COLS = "id,user_id,enabled,mail_account_ids,slack_team_id,slack_user_id";
const USER_COLS = "id,email,name,work_timezone";
// The P2a columns, plus updated_at (the Settings CAS token, P5a). Every other
// settings column is added by a later migration, applied by hand, so deployed
// code can meet a database without it: those come in optional groups
// (SETTINGS_COLUMN_GROUPS) that the loader drops one at a time on a
// missing-column error (L1, contract §3.7.1).
const SETTINGS_BASE_COLS =
  "principal_id,brief_enabled,brief_local_time,brief_timezone,supersede_legacy_brief,checkins_enabled," +
  "restricted_policy,watch_mode,muted_channel_ids,retention_days_slack,retention_days_email," +
  "retention_days_chat,daily_cost_cap_usd,updated_at";
const P4_SETTINGS_COLUMNS = ["drafts_enabled", "send_enabled", "voice_enabled"] as const;
const DDTEXT_SETTINGS_COLUMNS = ["ddtext_enabled", "retention_days_ddtext"] as const;

/**
 * Optional exec_settings column groups, in migration order (contract §3.7.1,
 * K15). A group is "schema ready" when the settings read selected it. P5b
 * appends { key: "chat", columns: [...] }.
 */
export const SETTINGS_COLUMN_GROUPS: readonly { key: SettingsSchemaKey; columns: readonly string[] }[] = [
  { key: "email", columns: ["email_enabled"] },
  { key: "drafts", columns: P4_SETTINGS_COLUMNS },
  { key: "ddtext", columns: DDTEXT_SETTINGS_COLUMNS }
];

/**
 * A group that can't exist without another (bindings AM9): P4's migration
 * refuses to run before P3's email_enabled column exists, so a read that
 * finds email_enabled missing drops the drafts group with it. P5a's ddtext
 * group needs only P2a and P2b, so it stands alone.
 */
const GROUP_REQUIRES: Readonly<Partial<Record<SettingsSchemaKey, SettingsSchemaKey>>> = Object.freeze({ drafts: "email" });

/** Which optional column groups a settings read selected (= whose migration is applied). */
export type SettingsSchemaFlags = Record<SettingsSchemaKey, boolean>;

/** A settings read with its CAS token (contract §3.7.1). */
export interface SettingsSnapshot {
  settings: ExecSettings;
  /** raw exec_settings.updated_at, or null without a row */
  version: string | null;
}

interface PrincipalRow {
  id: string;
  user_id: string;
  enabled: boolean;
  mail_account_ids: string[] | null;
  slack_team_id: string | null;
  slack_user_id: string | null;
}

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  work_timezone: string | null;
}

interface SettingsRow {
  principal_id: string;
  brief_enabled: boolean | null;
  brief_local_time: string | null;
  brief_timezone: string | null;
  supersede_legacy_brief: boolean | null;
  checkins_enabled: boolean | null;
  restricted_policy: string | null;
  watch_mode: string | null;
  muted_channel_ids: string[] | null;
  retention_days_slack: number | null;
  retention_days_email: number | null;
  retention_days_chat: number | null;
  daily_cost_cap_usd: number | string | null;
  /** Absent when the P3 migration isn't applied (the fallback read leaves it out). */
  email_enabled?: boolean | null;
  /** Absent when the P4 migration isn't applied (the P3 and base tiers leave them out). */
  drafts_enabled?: boolean | null;
  send_enabled?: boolean | null;
  voice_enabled?: boolean | null;
  /** Absent when the P5a migration isn't applied. */
  ddtext_enabled?: boolean | null;
  retention_days_ddtext?: number | null;
  /** The CAS token, exactly as PostgREST printed it (never parsed: microseconds matter). */
  updated_at?: string | null;
}

/** True when `tz` is an IANA zone this runtime understands. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** settings.brief_timezone → users.work_timezone → America/New_York. Invalid zones are skipped. */
export function resolveTimezone(settingsTz: string | null | undefined, userTz: string | null | undefined): string {
  if (isValidTimeZone(settingsTz)) return settingsTz;
  if (isValidTimeZone(userTz)) return userTz;
  return DEFAULT_TIMEZONE;
}

function num(v: number | string | null | undefined, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/**
 * exec_settings row (or none) → ExecSettings, filling every gap with DEFAULT_SETTINGS.
 *
 * `emailSchemaReady` says whether the read that produced `row` selected the
 * P3 email_enabled column, `draftsSchemaReady` whether it selected the three
 * P4 switches, and `ddtextSchemaReady` whether it selected both P5a columns.
 * The loader always says; when a caller doesn't, the row itself answers (it
 * has the key only if the column was selected), and no row means not ready.
 * Each switch is on only when its schema is ready and the column is exactly
 * true: NULL or a missing column is off (L1). A missing or unreadable
 * retention takes its default (retentionDaysDdtext 90).
 */
export function settingsFromRow(
  row: SettingsRow | null,
  principalId: string,
  opts: { emailSchemaReady?: boolean; draftsSchemaReady?: boolean; ddtextSchemaReady?: boolean } = {}
): ExecSettings {
  const d = DEFAULT_SETTINGS;
  const has = (column: string) => row !== null && Object.prototype.hasOwnProperty.call(row, column);
  const emailSchemaReady = opts.emailSchemaReady ?? has("email_enabled");
  const draftsSchemaReady = opts.draftsSchemaReady ?? P4_SETTINGS_COLUMNS.every(has);
  const ddtextSchemaReady = opts.ddtextSchemaReady ?? DDTEXT_SETTINGS_COLUMNS.every(has);
  if (!row) {
    return {
      principalId, ...d, mutedChannelIds: [], emailEnabled: false, emailSchemaReady, draftsEnabled: false, sendEnabled: false, voiceEnabled: false,
      draftsSchemaReady, ddtextEnabled: false, ddtextSchemaReady
    };
  }
  const policy: RestrictedPolicy = row.restricted_policy === "dd_only" ? "dd_only" : "hidden";
  const watch: WatchMode = row.watch_mode === "member_only" ? "member_only" : "active_public";
  return {
    principalId,
    briefEnabled: row.brief_enabled ?? d.briefEnabled,
    briefLocalTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(row.brief_local_time ?? "") ? (row.brief_local_time as string) : d.briefLocalTime,
    briefTimezone: row.brief_timezone ?? null,
    supersedeLegacyBrief: row.supersede_legacy_brief ?? d.supersedeLegacyBrief,
    checkinsEnabled: row.checkins_enabled ?? d.checkinsEnabled,
    restrictedPolicy: policy,
    watchMode: watch,
    mutedChannelIds: Array.isArray(row.muted_channel_ids) ? [...row.muted_channel_ids] : [],
    retentionDaysSlack: num(row.retention_days_slack, d.retentionDaysSlack),
    retentionDaysEmail: num(row.retention_days_email, d.retentionDaysEmail),
    retentionDaysChat: num(row.retention_days_chat, d.retentionDaysChat),
    dailyCostCapUsd: num(row.daily_cost_cap_usd, d.dailyCostCapUsd),
    emailEnabled: emailSchemaReady && row.email_enabled === true,
    emailSchemaReady,
    draftsEnabled: draftsSchemaReady && row.drafts_enabled === true,
    sendEnabled: draftsSchemaReady && row.send_enabled === true,
    voiceEnabled: draftsSchemaReady && row.voice_enabled === true,
    draftsSchemaReady,
    ddtextEnabled: ddtextSchemaReady && row.ddtext_enabled === true,
    retentionDaysDdtext: num(row.retention_days_ddtext, d.retentionDaysDdtext),
    ddtextSchemaReady
  };
}

function mint(data: ExecPrincipalData): ExecPrincipal {
  return Object.freeze({
    ...data,
    mailAccountIds: Object.freeze([...data.mailAccountIds])
  }) as ExecPrincipal;
}

/** Pure: rows → principal. Exported for tests; production callers use the loaders. */
export function principalFromRows(p: PrincipalRow, u: UserRow, s: SettingsRow | null): ExecPrincipal | null {
  if (!p.enabled) return null;
  if (!u.email) return null;
  return mint({
    id: p.id,
    userId: u.id,
    email: u.email.trim().toLowerCase(),
    name: (u.name ?? "").trim() || u.email.trim(),
    timezone: resolveTimezone(s?.brief_timezone ?? null, u.work_timezone),
    mailAccountIds: Array.isArray(p.mail_account_ids) ? p.mail_account_ids.filter((x) => typeof x === "string" && x) : [],
    slackTeamId: p.slack_team_id ?? null,
    slackUserId: p.slack_user_id ?? null
  });
}

// ---------------------------------------------------------------------------
// The tolerant settings read (contract §3.7.1, K15; bindings AM9)
// ---------------------------------------------------------------------------

/** The select for a read that includes exactly the optional groups `schema` marks ready, in migration order. */
export function settingsColumnsFor(schema: Readonly<SettingsSchemaFlags>): string {
  const optional = SETTINGS_COLUMN_GROUPS.filter((g) => schema[g.key] === true).flatMap((g) => g.columns);
  return [SETTINGS_BASE_COLS, ...optional].join(",");
}

/** The schema flags a settings value carries, by column-group key (SettingsView.schema). */
export function settingsSchemaFlags(s: Pick<ExecSettings, "emailSchemaReady" | "draftsSchemaReady" | "ddtextSchemaReady">): SettingsSchemaFlags {
  return { email: s.emailSchemaReady === true, drafts: s.draftsSchemaReady === true, ddtext: s.ddtextSchemaReady === true };
}

function schemaOpts(schema: Readonly<SettingsSchemaFlags>): { emailSchemaReady: boolean; draftsSchemaReady: boolean; ddtextSchemaReady: boolean } {
  return { emailSchemaReady: schema.email === true, draftsSchemaReady: schema.drafts === true, ddtextSchemaReady: schema.ddtext === true };
}

/**
 * A settings row as read with the groups `schema` marks ready → the snapshot
 * (settings + raw updated_at). settings.ts builds its write answers with it
 * from the row its CAS returned, so they need no second read.
 */
export function snapshotFromRow(row: Record<string, unknown> | null, principalId: string, schema: Readonly<SettingsSchemaFlags>): SettingsSnapshot {
  const r = row !== null && typeof row === "object" && !Array.isArray(row) ? (row as unknown as SettingsRow) : null;
  const version = r !== null && typeof r.updated_at === "string" && r.updated_at.length > 0 ? r.updated_at : null;
  return { settings: settingsFromRow(r, principalId, schemaOpts(schema)), version };
}

type DbErrorLike = { code?: string | null; message?: string | null };

/** `column` as a whole word of `message` (column names are [a-z0-9_], so nothing needs escaping). */
function namesColumn(message: string, column: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${column}(?![A-Za-z0-9_])`).test(message);
}

/** Drop `key`, and every group that can't exist without it (GROUP_REQUIRES). */
function dropGroup(selected: Set<SettingsSchemaKey>, key: SettingsSchemaKey): void {
  selected.delete(key);
  for (const g of SETTINGS_COLUMN_GROUPS) {
    if (selected.has(g.key) && GROUP_REQUIRES[g.key] === key) dropGroup(selected, g.key);
  }
}

interface SettingsRead {
  row: SettingsRow | null;
  /** Each optional group: the successful read selected it (its migration is applied). */
  schema: SettingsSchemaFlags;
}

/**
 * Select the base columns plus every optional group. On a missing-column
 * error (Postgres 42703, PostgREST PGRST204, or a message naming a column of
 * a still-selected group) drop the group whose column the message names, or,
 * when it names none, the last still-selected group (migrations apply in
 * order), and read again: at most one retry per group. A group's features
 * are then off and not installed, and everything else keeps working (L1).
 * Any other error, or a failure once every optional group is gone (a base
 * column), throws: a timeout or a 5xx must fail the read, never quietly turn
 * a switch off.
 */
async function fetchSettingsRow(principalId: string): Promise<SettingsRead> {
  const read = (columns: string) =>
    getSupabaseAdmin().from("exec_settings").select(columns).eq("principal_id", principalId).maybeSingle();
  const selected = new Set<SettingsSchemaKey>(SETTINGS_COLUMN_GROUPS.map((g) => g.key));
  const flags = (): SettingsSchemaFlags => {
    const out = {} as SettingsSchemaFlags;
    for (const g of SETTINGS_COLUMN_GROUPS) out[g.key] = selected.has(g.key);
    return out;
  };
  for (let attempt = 0; attempt <= SETTINGS_COLUMN_GROUPS.length; attempt += 1) {
    const schema = flags();
    const { data, error } = await read(settingsColumnsFor(schema));
    if (!error) return { row: (data as SettingsRow | null) ?? null, schema };
    const e = error as DbErrorLike;
    const message = e.message ?? "";
    const still = SETTINGS_COLUMN_GROUPS.filter((g) => selected.has(g.key));
    const named = still.find((g) => g.columns.some((c) => namesColumn(message, c)));
    const missingColumn = e.code === "42703" || e.code === "PGRST204" || named !== undefined;
    if (!missingColumn || still.length === 0) throw new Error(`exec_settings read failed: ${message}`);
    dropGroup(selected, (named ?? still[still.length - 1]).key);
  }
  throw new Error("exec_settings read failed: no column set answered");
}

async function fetchUserRow(userId: string): Promise<UserRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("users")
    .select(USER_COLS)
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`users read failed: ${error.message}`);
  return (data as UserRow | null) ?? null;
}

async function fromPrincipalRow(p: PrincipalRow | null): Promise<ExecPrincipal | null> {
  if (!p || !p.enabled) return null;
  const [u, s] = await Promise.all([fetchUserRow(p.user_id), fetchSettingsRow(p.id)]);
  if (!u) return null;
  return principalFromRows(p, u, s.row);
}

/** The enabled principal for a DD user, or null. Caller must already have authenticated that user. */
export async function loadPrincipalForUser(userId: string): Promise<ExecPrincipal | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("exec_principals")
    .select(PRINCIPAL_COLS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`exec_principals read failed: ${error.message}`);
  return fromPrincipalRow((data as PrincipalRow | null) ?? null);
}

/** The enabled principal by id (job runner: job.principal_id), or null. */
export async function loadPrincipalById(principalId: string): Promise<ExecPrincipal | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("exec_principals")
    .select(PRINCIPAL_COLS)
    .eq("id", principalId)
    .maybeSingle();
  if (error) throw new Error(`exec_principals read failed: ${error.message}`);
  return fromPrincipalRow((data as PrincipalRow | null) ?? null);
}

/** Every enabled principal (scheduler). */
export async function listEnabledPrincipals(): Promise<ExecPrincipal[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("exec_principals")
    .select(PRINCIPAL_COLS)
    .eq("enabled", true);
  if (error) throw new Error(`exec_principals read failed: ${error.message}`);
  const out: ExecPrincipal[] = [];
  for (const row of (data as PrincipalRow[] | null) ?? []) {
    const p = await fromPrincipalRow(row);
    if (p) out.push(p);
  }
  return out;
}

/**
 * exec_settings for a principal, defaults filled in. Before a later migration
 * is applied it still loads (that group's switches off and its *SchemaReady
 * false); any other read failure throws.
 */
export async function loadSettings(principalId: string): Promise<ExecSettings> {
  return (await loadSettingsSnapshot(principalId)).settings;
}

/**
 * exec_settings with its raw updated_at (the Settings CAS token; null without
 * a row), through the same tolerant read as loadSettings (contract §3.7.1).
 */
export async function loadSettingsSnapshot(principalId: string): Promise<SettingsSnapshot> {
  const read = await fetchSettingsRow(principalId);
  return snapshotFromRow(read.row as Record<string, unknown> | null, principalId, read.schema);
}

/**
 * P4 (contract §3.15 Y2, L4): how many enabled principals have a non-empty mail
 * pin (service role, exec_principals id + mail_account_ids where enabled;
 * errors throw). The EA readiness check refuses to run with more than one. It
 * is not one of the three principal loaders, so sources/mail.ts may import it;
 * the table name stays in this file (boundary rule 8).
 */
export async function countEnabledMailPinnedPrincipals(): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("exec_principals")
    .select("id,mail_account_ids")
    .eq("enabled", true);
  if (error) throw new Error(`exec_principals read failed: ${error.message}`);
  let n = 0;
  for (const row of (data as Pick<PrincipalRow, "id" | "mail_account_ids">[] | null) ?? []) {
    const pin = Array.isArray(row.mail_account_ids) ? row.mail_account_ids.filter((x) => typeof x === "string" && x) : [];
    if (pin.length > 0) n += 1;
  }
  return n;
}
