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
  dailyCostCapUsd: 15
};

const PRINCIPAL_COLS = "id,user_id,enabled,mail_account_ids,slack_team_id,slack_user_id";
const USER_COLS = "id,email,name,work_timezone";
const SETTINGS_COLS =
  "principal_id,brief_enabled,brief_local_time,brief_timezone,supersede_legacy_brief,checkins_enabled," +
  "restricted_policy,watch_mode,muted_channel_ids,retention_days_slack,retention_days_email," +
  "retention_days_chat,daily_cost_cap_usd";

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

/** exec_settings row (or none) → ExecSettings, filling every gap with DEFAULT_SETTINGS. */
export function settingsFromRow(row: SettingsRow | null, principalId: string): ExecSettings {
  const d = DEFAULT_SETTINGS;
  if (!row) return { principalId, ...d, mutedChannelIds: [] };
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
    dailyCostCapUsd: num(row.daily_cost_cap_usd, d.dailyCostCapUsd)
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

async function fetchSettingsRow(principalId: string): Promise<SettingsRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("exec_settings")
    .select(SETTINGS_COLS)
    .eq("principal_id", principalId)
    .maybeSingle();
  if (error) throw new Error(`exec_settings read failed: ${error.message}`);
  return (data as SettingsRow | null) ?? null;
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
  return principalFromRows(p, u, s);
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

/** exec_settings for a principal, defaults filled in. */
export async function loadSettings(principalId: string): Promise<ExecSettings> {
  return settingsFromRow(await fetchSettingsRow(principalId), principalId);
}
