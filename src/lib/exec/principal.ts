import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
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
  draftsSchemaReady: false
};

const PRINCIPAL_COLS = "id,user_id,enabled,mail_account_ids,slack_team_id,slack_user_id";
const USER_COLS = "id,email,name,work_timezone";
// The P2a columns. email_enabled is added by the P3 migration and the three
// P4 switches by the P4 migration, both applied by hand, so deployed code can
// meet a database without them: the loader asks for the widest set and moves
// down a tier only on a missing-column error (L1).
const SETTINGS_BASE_COLS =
  "principal_id,brief_enabled,brief_local_time,brief_timezone,supersede_legacy_brief,checkins_enabled," +
  "restricted_policy,watch_mode,muted_channel_ids,retention_days_slack,retention_days_email," +
  "retention_days_chat,daily_cost_cap_usd";
const SETTINGS_P3_COLS = `${SETTINGS_BASE_COLS},email_enabled`;
const P4_SETTINGS_COLUMNS = ["drafts_enabled", "send_enabled", "voice_enabled"] as const;
const SETTINGS_P4_COLS = `${SETTINGS_P3_COLS},${P4_SETTINGS_COLUMNS.join(",")}`;

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
 * P3 email_enabled column, and `draftsSchemaReady` whether it selected the
 * three P4 switches. The loader always says; when a caller doesn't, the row
 * itself answers (it has the key only if the column was selected), and no row
 * means not ready. Each switch is on only when its schema is ready and the
 * column is exactly true: NULL or a missing column is off (L1).
 */
export function settingsFromRow(
  row: SettingsRow | null,
  principalId: string,
  opts: { emailSchemaReady?: boolean; draftsSchemaReady?: boolean } = {}
): ExecSettings {
  const d = DEFAULT_SETTINGS;
  const has = (column: string) => row !== null && Object.prototype.hasOwnProperty.call(row, column);
  const emailSchemaReady = opts.emailSchemaReady ?? has("email_enabled");
  const draftsSchemaReady = opts.draftsSchemaReady ?? P4_SETTINGS_COLUMNS.every(has);
  if (!row) return { principalId, ...d, mutedChannelIds: [], emailEnabled: false, emailSchemaReady, draftsEnabled: false, sendEnabled: false, voiceEnabled: false, draftsSchemaReady };
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
    draftsSchemaReady
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

/**
 * The error a select of a hand-migrated column gets before its migration:
 * Postgres' "column does not exist" (42703), PostgREST's schema-cache miss
 * (PGRST204), or any message that names one of `columns`. Nothing else falls
 * back: a timeout or a 5xx must fail the read, not quietly turn a switch off.
 */
function isMissingColumn(error: { code?: string | null; message?: string | null }, columns: readonly string[]): boolean {
  if (error.code === "42703" || error.code === "PGRST204") return true;
  const message = error.message ?? "";
  return columns.some((c) => message.includes(c));
}

interface SettingsRead {
  row: SettingsRow | null;
  /** The read selected email_enabled (the P3 migration is applied). */
  emailSchemaReady: boolean;
  /** The read selected the three P4 switches (the P4 migration is applied). */
  draftsSchemaReady: boolean;
}

/** The column tiers, widest first: P4 = P3 + the switches; P3 = base + email_enabled; base. */
const SETTINGS_TIERS: readonly { columns: string; emailSchemaReady: boolean; draftsSchemaReady: boolean; missing: readonly string[] }[] = [
  { columns: SETTINGS_P4_COLS, emailSchemaReady: true, draftsSchemaReady: true, missing: [...P4_SETTINGS_COLUMNS, "email_enabled"] },
  { columns: SETTINGS_P3_COLS, emailSchemaReady: true, draftsSchemaReady: false, missing: ["email_enabled"] },
  { columns: SETTINGS_BASE_COLS, emailSchemaReady: false, draftsSchemaReady: false, missing: [] }
];

/**
 * Code ahead of a hand-applied migration moves down one tier per
 * missing-column error (P4 -> P3 -> base); the features whose columns were
 * never read are then off and not installed, so everything else keeps working
 * (L1). Any other error throws.
 */
async function fetchSettingsRow(principalId: string): Promise<SettingsRead> {
  const read = (columns: string) =>
    getSupabaseAdmin().from("exec_settings").select(columns).eq("principal_id", principalId).maybeSingle();
  for (let i = 0; i < SETTINGS_TIERS.length; i += 1) {
    const tier = SETTINGS_TIERS[i];
    const { data, error } = await read(tier.columns);
    if (!error) return { row: (data as SettingsRow | null) ?? null, emailSchemaReady: tier.emailSchemaReady, draftsSchemaReady: tier.draftsSchemaReady };
    const last = i === SETTINGS_TIERS.length - 1;
    if (last || !isMissingColumn(error, tier.missing)) throw new Error(`exec_settings read failed: ${error.message}`);
  }
  throw new Error("exec_settings read failed: no tier answered");
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
 * exec_settings for a principal, defaults filled in. Before the P3 migration
 * is applied it still loads (emailEnabled and emailSchemaReady false); any
 * other read failure throws.
 */
export async function loadSettings(principalId: string): Promise<ExecSettings> {
  const read = await fetchSettingsRow(principalId);
  return settingsFromRow(read.row, principalId, { emailSchemaReady: read.emailSchemaReady, draftsSchemaReady: read.draftsSchemaReady });
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
