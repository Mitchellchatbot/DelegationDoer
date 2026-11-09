import "server-only";

import { mayDmAt } from "@/lib/exec/brief-ownership";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { getBriefByDate } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, briefDeliverKey, type BriefDeliverPayload } from "@/lib/exec/brief-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { isValidTimeZone, loadSettingsSnapshot, type SettingsSnapshot } from "@/lib/exec/principal";
import { updateBriefSettingsColumns, type BriefSettingsColumns } from "@/lib/exec/settings";
import { localDateString } from "@/lib/exec/time";
import type { ExecPrincipal } from "@/lib/exec/types";

// P8 brief settings (contract §3.17.5, C22, M2, M5; Area E; server-only): the five brief controls behind
// PATCH /api/exec/briefs/settings, with P5a's updated_at CAS; turning supersede on needs the confirm and may enqueue a
// same-day delivery.
//
//   * validateBriefSettingsPatch is pure: the five keys only, each checked (the time in 15-minute steps, the zone one of
//     BRIEF_TIMEZONES that this runtime accepts, or null for "my work zone"); the first problem wins.
//   * The write is settings.ts's updateBriefSettingsColumns (only settings.ts and principal.ts write exec_settings,
//     boundary rule 14); this module turns the patch into columns and decides around it.
//   * After an applied change, while the brief is on and superseding: today's row (in the brief zone) that stayed in DD
//     only because the DD brief still owned the morning (page_only, not_superseding or no_installation) is sent now when
//     the catch-up window is still open and a fresh ownership read says the assistant owns today (M2, C4, C22). The
//     deliver job re-checks all of it under its own CAS; this step only enqueues it (exec.brief-deliver, mode same_day,
//     one key per brief rev). A failure there never fails the save: it is logged by id and code. A save that also
//     changes the brief zone skips this step (today in the new zone can't be read without reloading the principal).
//
// Nothing here logs a value: ids, dates and error names only.

export interface BriefSettingsPatch { briefEnabled?: boolean; briefLocalTime?: string; briefTimezone?: string | null; checkinsEnabled?: boolean; supersedeLegacyBrief?: boolean }

export const BRIEF_TIMEZONES: readonly string[] = Object.freeze([
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Paris", "Asia/Manila", "Asia/Karachi", "Asia/Kolkata"
]);

const BRIEF_TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const PATCH_KEYS: readonly (keyof BriefSettingsPatch)[] = ["briefEnabled", "briefLocalTime", "briefTimezone", "checkinsEnabled", "supersedeLegacyBrief"];
const BOOLEAN_KEYS: ReadonlySet<string> = new Set(["briefEnabled", "checkinsEnabled", "supersedeLegacyBrief"]);

/** Pure: briefLocalTime ^([01]\d|2[0-3]):(00|15|30|45)$; briefTimezone null or a zone in BRIEF_TIMEZONES that Intl accepts; booleans. */
export function validateBriefSettingsPatch(patch: unknown): { ok: true; patch: BriefSettingsPatch } | { ok: false; field: string; detail: string } {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, field: "patch", detail: "must be an object" };
  const given = Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (given.length === 0) return { ok: false, field: "patch", detail: "must change at least one setting" };
  for (const [key] of given) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) return { ok: false, field: "patch", detail: "names a setting that can't be changed here" };
  }
  const values = new Map(given);
  const out: BriefSettingsPatch = {};
  for (const key of PATCH_KEYS) {
    if (!values.has(key)) continue;
    const v = values.get(key);
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof v !== "boolean") return { ok: false, field: key, detail: "must be true or false" };
      (out as Record<string, unknown>)[key] = v;
    } else if (key === "briefLocalTime") {
      if (typeof v !== "string" || !BRIEF_TIME.test(v)) return { ok: false, field: key, detail: "must be a time of day in 15-minute steps (HH:MM)" };
      out.briefLocalTime = v;
    } else {
      if (v !== null && (typeof v !== "string" || !BRIEF_TIMEZONES.includes(v) || !isValidTimeZone(v))) {
        return { ok: false, field: key, detail: "must be one of the listed time zones, or null for your work time zone" };
      }
      out.briefTimezone = v as string | null;
    }
  }
  return { ok: true, patch: out };
}

export type UpdateBriefSettingsResult =
  | { outcome: "updated"; snapshot: SettingsSnapshot; sameDayDelivery: boolean }
  | { outcome: "conflict"; snapshot: SettingsSnapshot }
  | { outcome: "invalid"; field: string; detail: string }
  | { outcome: "confirmation_required" };

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

function columnsOf(p: BriefSettingsPatch): BriefSettingsColumns {
  const c: BriefSettingsColumns = {};
  if (p.briefEnabled !== undefined) c.brief_enabled = p.briefEnabled;
  if (p.briefLocalTime !== undefined) c.brief_local_time = p.briefLocalTime;
  if (p.briefTimezone !== undefined) c.brief_timezone = p.briefTimezone;
  if (p.checkinsEnabled !== undefined) c.checkins_enabled = p.checkinsEnabled;
  if (p.supersedeLegacyBrief !== undefined) c.supersede_legacy_brief = p.supersedeLegacyBrief;
  return c;
}

/**
 * M2 / C22: after an applied change, today's page-only brief that the DD brief kept from Slack is sent now, when the
 * brief is on and superseding, the catch-up window is open (mayDmAt) and a fresh loadBriefOwnership says "exec". True
 * when the deliver job was enqueued (or already queued under its key). Never throws.
 */
async function sameDayDelivery(principal: ExecPrincipal, snapshot: SettingsSnapshot, patch: BriefSettingsPatch, now: Date): Promise<boolean> {
  const settings = snapshot.settings;
  if (settings.briefEnabled !== true || settings.supersedeLegacyBrief !== true) return false;
  // A zone changed in this same save: the principal in hand still carries the old brief zone, and only access.ts, jobs.ts,
  // the scheduler and the runtime may load a principal (rule 3), so today can't be told here; the next brief is sent as usual.
  if (patch.briefTimezone !== undefined) return false;
  const p = principal;
  try {
    const localDate = localDateString(now, p.briefTimezone);
    const row = await getBriefByDate(p, localDate);
    if (row === null || row.status !== "page_only") return false;
    if (row.statusReason !== "not_superseding" && row.statusReason !== "no_installation") return false;
    if (!mayDmAt(now, localDate, new Date(row.scheduledAt), row.tz.length > 0 ? row.tz : p.briefTimezone)) return false;
    const own = await loadBriefOwnership(p, settings, localDate, now);
    if (own.verdict.owner !== "exec") return false;
    const payload: BriefDeliverPayload = { brief_id: row.id, local_date: localDate, rev: row.rev, mode: "same_day" };
    await enqueueJob({
      kind: BRIEF_JOB_KINDS.deliver, lane: "interactive", principalId: p.id, payload: { ...payload },
      dedupeKey: briefDeliverKey(p.id, localDate, row.rev, "same_day"), maxAttempts: 1
    });
    return true;
  } catch (err) {
    console.warn(`[exec-brief] principal ${principal.id} same_day_check_failed (${errName(err)})`);
    return false;
  }
}

/** P5a's CAS: update exec_settings set <cols>, updated_at = now where principal_id and updated_at = expectedVersion.
 *  supersede false → true needs confirm "supersede_legacy_brief"; after the update, when today's row is page_only with reason
 *  not_superseding or no_installation, mayDmAt(now) and a fresh loadBriefOwnership says exec → enqueue exec.brief-deliver mode same_day. */
export async function updateBriefSettings(principal: ExecPrincipal, patch: BriefSettingsPatch,
  opts: { expectedVersion: string | null; confirm?: "supersede_legacy_brief"; now?: Date }): Promise<UpdateBriefSettingsResult> {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) throw new TypeError("updateBriefSettings: an ExecPrincipal is required");
  const checked = validateBriefSettingsPatch(patch);
  if (!checked.ok) return { outcome: "invalid", field: checked.field, detail: checked.detail };
  const now = opts?.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("updateBriefSettings: now must be a valid Date");
  const current = await loadSettingsSnapshot(principal.id);
  // M5: switching the morning DM to the assistant drops the DD brief's finance lines; he confirms the list first.
  if (checked.patch.supersedeLegacyBrief === true && current.settings.supersedeLegacyBrief !== true && opts?.confirm !== "supersede_legacy_brief") {
    return { outcome: "confirmation_required" };
  }
  const written = await updateBriefSettingsColumns(principal, columnsOf(checked.patch), { expectedVersion: opts?.expectedVersion ?? null, now, current });
  if (written.outcome === "conflict") return written;
  return { outcome: "updated", snapshot: written.snapshot, sameDayDelivery: await sameDayDelivery(principal, written.snapshot, checked.patch, now) };
}

export interface BriefSettingsView { enabled: boolean; time: string; timezone: string | null; effectiveTz: string; workTz: string;
  checkinsEnabled: boolean; supersede: boolean; version: string | null }
