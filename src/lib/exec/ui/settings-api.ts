import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import type { BriefSettingsPatch, BriefSettingsView } from "@/lib/exec/brief-settings";
import type { SettingsPatch } from "@/lib/exec/settings-fields";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import type { MuteSource, WatchState } from "@/lib/exec/slack-read-types";
import type { PickerRow, SlackSettingsView } from "@/lib/exec/slack-types";
import type { WatchMode } from "@/lib/exec/types";
import type { SettingsView } from "@/lib/exec/view-types";
import { retryAfterOf, tooManyMessage } from "./feed-api";

// The Settings page's calls from the browser (P5a contract §3.7.3,
// §3.7.4, §3.13.2): PATCH /api/exec/settings (one change, CAS on the version
// the page loaded) and POST /api/exec/settings/voice-reset; P6 (contract
// §3.13) adds POST /api/exec/slack/disconnect; P7a (contract §3.16, §3.10.5-8)
// adds POST /api/exec/slack/reading/stop, PATCH /api/exec/slack/channels/:id
// and PUT /api/exec/slack/watch-mode, the "slack_reading_notice" confirmation
// on the settings PATCH, and Disconnect's reading-half answers (C47); P8 (contract
// §3.17.3, §3.17.5, §3.21.4) adds POST /api/exec/briefs/regenerate (Regenerate)
// and PATCH /api/exec/briefs/settings (the Brief section). Pure and
// client-safe: fetch with credentials "same-origin", JSON in and out, nothing
// server-only (boundary rule 16). Statuses become the words he sees.

export const SETTINGS_COPY = {
  saved: "Saved",
  failed: "Couldn't save. Try again.",
  conflict: "Settings changed elsewhere. The latest values are shown; make your change again.",
  notInstalled: "Not available yet: the team needs to apply the database update.",
  confirmFirst: "Tick the confirmation first.",
  framed: "Changes are off in an embedded view.",
  voiceReset: "Reset. It rebuilds next week.",
  // Review ui-6: the weekly rebuild can't run (the switch, drafts or email is off).
  voiceResetIdle: "Reset. It rebuilds once Learn my writing style, drafts and email are on.",
  voiceNeeds: "Needs email intelligence and assistant drafts on, and a linked mailbox, to build.",
  voiceNotInstalled: "Not available yet.",
  voiceFailed: "Couldn't reset. Try again.",
  voiceNoProfile: "No profile yet.",
  voiceConfirm: "Delete the learned writing style? Drafts use a neutral voice until the weekly rebuild."
} as const;

/**
 * Review ui-6: whether P4's weekly job can build a writing style at all
 * (voice.ts refreshVoiceProfile's gates besides the switch itself): drafts
 * and email intelligence installed and on, and a mailbox linked. An
 * unreadable pinned-mailbox read doesn't claim it can't. Pure: the server
 * page and the client form both use it.
 */
export function voiceCanBuild(view: Pick<SettingsView, "settings" | "pinnedMailbox">): boolean {
  const s = view.settings;
  const pinned = !view.pinnedMailbox.ok || view.pinnedMailbox.data.accountIds.length > 0;
  return s.draftsSchemaReady && s.draftsEnabled && s.emailSchemaReady && s.emailEnabled && pinned;
}

/** The line after a successful voice reset: when the weekly rebuild can run, and when it can't (review ui-6). */
export function voiceResetDoneText(rebuilds: boolean): string {
  return rebuilds ? SETTINGS_COPY.voiceReset : SETTINGS_COPY.voiceResetIdle;
}

type Json = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function asObject(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function fetcher(f?: FetchLike): FetchLike {
  return f ?? ((input, init) => fetch(input, init));
}

/** Enough of a SettingsView to show: its settings, schema flags and CAS version. */
export function isSettingsView(v: unknown): v is SettingsView {
  const o = asObject(v);
  return o !== null && asObject(o.settings) !== null && asObject(o.schema) !== null && (o.version === null || typeof o.version === "string");
}

/** The words for a refused or failed settings change. */
export function settingsMessageFor(status: number, body: unknown, headers: Pick<Headers, "get"> | null): string {
  const obj = asObject(body);
  const code = obj && typeof obj.error === "string" ? obj.error : null;
  if (status === 409 && code === "conflict") return SETTINGS_COPY.conflict;
  if (status === 409 && code === "not_installed") return SETTINGS_COPY.notInstalled;
  if (status === 400 && code === "confirmation_required") return SETTINGS_COPY.confirmFirst;
  if (status === 429) return tooManyMessage(retryAfterOf(obj, headers));
  return SETTINGS_COPY.failed;
}

export type SettingsSaveResult =
  | { kind: "saved"; view: SettingsView; message: string }
  /** 409 conflict: the latest values (null when the answer carried none). */
  | { kind: "conflict"; view: SettingsView | null; message: string }
  | { kind: "failed"; status: number; message: string };

export const SETTINGS_PATH = "/api/exec/settings";
export const VOICE_RESET_PATH = "/api/exec/settings/voice-reset";

/** The confirmations the settings PATCH takes: DD text triage's notice (P5a) and Slack reading's (P7a N20). */
export type SettingsConfirm = "ddtext_notice" | "slack_reading_notice";

/** PATCH one change with the version the page loaded; the route validates, audits and checks the CAS again.
 *  P7a: confirm may also be "slack_reading_notice" (turning Slack reading on). Any other value is never sent. */
export async function patchSettings(
  body: { patch: SettingsPatch; expectedVersion: string | null; confirm?: SettingsConfirm },
  fetchImpl?: FetchLike
): Promise<SettingsSaveResult> {
  const payload: Json = { patch: body.patch, expectedVersion: body.expectedVersion };
  if (body.confirm === "ddtext_notice" || body.confirm === "slack_reading_notice") payload.confirm = body.confirm;
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(SETTINGS_PATH, {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    return { kind: "failed", status: 0, message: SETTINGS_COPY.failed };
  }
  const json = asObject(await readJson(res));
  if (res.status === 200 && json && isSettingsView(json.settings)) return { kind: "saved", view: json.settings, message: SETTINGS_COPY.saved };
  if (res.status === 409 && json?.error === "conflict") {
    return { kind: "conflict", view: isSettingsView(json.settings) ? json.settings : null, message: SETTINGS_COPY.conflict };
  }
  return { kind: "failed", status: res.status, message: settingsMessageFor(res.status, json, res.headers) };
}

export type VoiceResetResult = { kind: "reset"; hadProfile: boolean; message: string } | { kind: "failed"; status: number; message: string };

/** The words for a voice reset's answer. */
export function voiceResetMessageFor(status: number, body: unknown, headers: Pick<Headers, "get"> | null): string {
  if (status === 200) return SETTINGS_COPY.voiceReset;
  if (status === 409) return SETTINGS_COPY.voiceNotInstalled;
  if (status === 429) return tooManyMessage(retryAfterOf(asObject(body), headers));
  return SETTINGS_COPY.voiceFailed;
}

/** POST the reset, with no body (the route refuses one). */
export async function resetVoice(fetchImpl?: FetchLike): Promise<VoiceResetResult> {
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(VOICE_RESET_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" }
    });
  } catch {
    return { kind: "failed", status: 0, message: SETTINGS_COPY.voiceFailed };
  }
  const json = asObject(await readJson(res));
  if (res.status === 200 && json?.reset === true) return { kind: "reset", hadProfile: json.hadProfile === true, message: SETTINGS_COPY.voiceReset };
  return { kind: "failed", status: res.status, message: voiceResetMessageFor(res.status === 200 ? 500 : res.status, json, res.headers) };
}

// ---------------------------------------------------------------------------
// P6: Disconnect Slack (contract §3.13, §3.10.5, K15)
// ---------------------------------------------------------------------------

export const SLACK_DISCONNECT_PATH = "/api/exec/slack/disconnect";

/** P7a (C47): `message` on a 200 that carries warning "revoke_failed" (disconnected, the reading permission maybe still
 *  live in Slack); `readingStopped` on a 503 slack_unavailable whose answer carries the view (reading was stopped and
 *  its data deleted before the bot revoke failed): the page refreshes to show it. */
export type SlackDisconnectResult =
  | { kind: "disconnected"; message?: string }
  | { kind: "failed"; status: number; message: string; readingStopped?: true };

/** The words for a refused or failed Disconnect: 503 slack_unavailable (Slack unreachable, nothing changed) has its own,
 *  and (P7a, C47) disconnectHalf when the answer carries the view (reading already stopped and purged); every other
 *  answer is the general one. */
export function slackDisconnectMessageFor(status: number, body: unknown): string {
  const obj = asObject(body);
  if (status === 503 && obj?.error === "slack_unavailable") return asObject(obj.slack) !== null ? SLACK_READ_COPY.disconnectHalf : SLACK_COPY.disconnectSlackDown;
  return SLACK_COPY.disconnectFailed;
}

/**
 * POST { installationId, confirm: "disconnect" } with credentials "same-origin" (the route re-checks the strong
 * sign-in, the origin, the body and that this is his active installation). 200 → disconnected (the caller refreshes
 * the page, which re-reads the Slack section on the server); anything else → failed with its words.
 */
export async function disconnectSlack(installationId: string, fetchImpl?: FetchLike): Promise<SlackDisconnectResult> {
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(SLACK_DISCONNECT_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ installationId, confirm: "disconnect" })
    });
  } catch {
    return { kind: "failed", status: 0, message: SLACK_COPY.disconnectFailed };
  }
  const json = await readJson(res);
  if (res.status === 200) {
    return asObject(json)?.warning === "revoke_failed" ? { kind: "disconnected", message: SLACK_READ_COPY.disconnectRevokeFailed } : { kind: "disconnected" };
  }
  const message = slackDisconnectMessageFor(res.status, json);
  return message === SLACK_READ_COPY.disconnectHalf ? { kind: "failed", status: res.status, message, readingStopped: true } : { kind: "failed", status: res.status, message };
}

// ---------------------------------------------------------------------------
// P7a: Stop reading, the picker, the watch mode (contract §3.16, §3.10.5-7)
// ---------------------------------------------------------------------------

export const SLACK_STOP_READING_PATH = "/api/exec/slack/reading/stop";
export const SLACK_WATCH_MODE_PATH = "/api/exec/slack/watch-mode";
/** The picker's PATCH path for one public (C…) or private (G…) channel. */
export const slackChannelPath = (channelId: string): string => `/api/exec/slack/channels/${encodeURIComponent(channelId)}`;
const PICKER_CHANNEL = /^[CG][A-Z0-9]{2,30}$/;
const INSTALLATION_ID = /^esi_[0-9a-f]{32}$/;
const WATCH_STATES: readonly WatchState[] = ["watched", "muted", "unwatched"];
const MUTE_SOURCES: readonly MuteSource[] = ["owner", "default_finance", "slack"];
const PICKER_CLASSES: readonly PickerRow["class"][] = ["standard", "external", "finance", "hub", "unclassified"];

/** C47: "stopped" (warning revoke_failed: reading stopped and its data deleted, the permission maybe still live in Slack). */
export type StopReadingResult = { kind: "stopped"; warning: "revoke_failed" | null } | { kind: "failed"; status: number; message: string };

/** The words for a refused or failed Stop reading: stopFailed, or the rate-limit line (§3.16). */
export function stopReadingMessageFor(status: number, body: unknown, headers: Pick<Headers, "get"> | null): string {
  if (status === 429) return tooManyMessage(retryAfterOf(asObject(body), headers));
  return SLACK_READ_COPY.stopFailed;
}

/**
 * POST { installationId, confirm: "stop_reading" } (the route re-checks the strong sign-in, the origin, the body and
 * that this is his live reading half). 200 → stopped, with warning "revoke_failed" when Slack couldn't be reached to
 * cancel the permission (the caller shows stopRevokeFailed and refreshes); anything else → failed with its words.
 */
export async function stopReading(installationId: string, fetchImpl?: FetchLike): Promise<StopReadingResult> {
  if (typeof installationId !== "string" || !INSTALLATION_ID.test(installationId)) return { kind: "failed", status: 0, message: SLACK_READ_COPY.stopFailed };
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(SLACK_STOP_READING_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ installationId, confirm: "stop_reading" })
    });
  } catch {
    return { kind: "failed", status: 0, message: SLACK_READ_COPY.stopFailed };
  }
  const json = asObject(await readJson(res));
  if (res.status === 200) return { kind: "stopped", warning: json?.warning === "revoke_failed" ? "revoke_failed" : null };
  return { kind: "failed", status: res.status, message: stopReadingMessageFor(res.status, json, res.headers) };
}

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const isNullableCount = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** A picker row as the channels route answers it (§3.16 PickerRow), checked field by field; anything else is not one. */
export function isPickerRow(v: unknown): v is PickerRow {
  const o = asObject(v);
  return (
    o !== null &&
    typeof o.channelId === "string" &&
    PICKER_CHANNEL.test(o.channelId) &&
    typeof o.name === "string" &&
    (o.kind === "public" || o.kind === "private") &&
    typeof o.class === "string" &&
    (PICKER_CLASSES as readonly string[]).includes(o.class) &&
    typeof o.financeName === "boolean" &&
    typeof o.watchState === "string" &&
    (WATCH_STATES as readonly string[]).includes(o.watchState) &&
    (o.muteSource === null || (typeof o.muteSource === "string" && (MUTE_SOURCES as readonly string[]).includes(o.muteSource))) &&
    typeof o.isMember === "boolean" &&
    isNullableCount(o.activity30d) &&
    isNullableString(o.lastActivityAt) &&
    typeof o.version === "string" &&
    typeof o.canChange === "boolean"
  );
}

export type ChannelWatchResult =
  | { kind: "updated"; channel: PickerRow }
  /** 409 conflict: the row as it is now (null when the answer carried none); the picker re-renders it and says so. */
  | { kind: "conflict"; channel: PickerRow | null; message: string }
  /** 400 confirmation_required: a finance channel (class finance, or a finance-named Slack Connect channel) needs confirm "finance_channel". */
  | { kind: "confirmation_required" }
  | { kind: "failed"; status: number; message: string };

/**
 * PATCH { watchState, expectedVersion, confirm? } for one picker row (the route re-checks everything; SQL refuses a
 * never-read, hub or unclassified conversation and asks for the finance confirmation). confirm is sent only as
 * "finance_channel".
 */
export async function setChannelWatch(
  channelId: string,
  body: { watchState: WatchState; expectedVersion: string; confirm?: "finance_channel" },
  fetchImpl?: FetchLike
): Promise<ChannelWatchResult> {
  if (typeof channelId !== "string" || !PICKER_CHANNEL.test(channelId)) return { kind: "failed", status: 0, message: SLACK_READ_COPY.pickerFailed };
  const payload: Json = { watchState: body.watchState, expectedVersion: body.expectedVersion };
  if (body.confirm === "finance_channel") payload.confirm = "finance_channel";
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(slackChannelPath(channelId), {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    return { kind: "failed", status: 0, message: SLACK_READ_COPY.pickerFailed };
  }
  const json = asObject(await readJson(res));
  if (res.status === 200 && json && isPickerRow(json.channel) && json.channel.channelId === channelId) return { kind: "updated", channel: json.channel };
  if (res.status === 409 && json?.error === "conflict") {
    const row = isPickerRow(json.channel) && json.channel.channelId === channelId ? json.channel : null;
    return { kind: "conflict", channel: row, message: SLACK_READ_COPY.pickerConflict };
  }
  if (res.status === 400 && json?.error === "confirmation_required") return { kind: "confirmation_required" };
  if (res.status === 429) return { kind: "failed", status: 429, message: tooManyMessage(retryAfterOf(json, res.headers)) };
  return { kind: "failed", status: res.status, message: SLACK_READ_COPY.pickerFailed };
}

/** Enough of a SlackSettingsView to use: its state and, when present, its reading half as an object. */
function isSlackView(v: unknown): v is SlackSettingsView {
  const o = asObject(v);
  return o !== null && typeof o.state === "string" && (o.reading === undefined || asObject(o.reading) !== null);
}

export type WatchModeResult =
  | { kind: "saved"; slack: SlackSettingsView | null }
  | { kind: "conflict"; slack: SlackSettingsView | null; message: string }
  | { kind: "failed"; status: number; message: string };

/** PUT { watchMode, expectedVersion } (the settings CAS token); the route re-checks everything. */
export async function setWatchMode(watchMode: WatchMode, expectedVersion: string | null, fetchImpl?: FetchLike): Promise<WatchModeResult> {
  if (watchMode !== "member_only" && watchMode !== "active_public") return { kind: "failed", status: 0, message: SETTINGS_COPY.failed };
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(SLACK_WATCH_MODE_PATH, {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ watchMode, expectedVersion: typeof expectedVersion === "string" ? expectedVersion : null })
    });
  } catch {
    return { kind: "failed", status: 0, message: SETTINGS_COPY.failed };
  }
  const json = asObject(await readJson(res));
  const slack = json && isSlackView(json.slack) ? json.slack : null;
  if (res.status === 200) return { kind: "saved", slack };
  if (res.status === 409 && json?.error === "conflict") return { kind: "conflict", slack, message: SETTINGS_COPY.conflict };
  return { kind: "failed", status: res.status, message: settingsMessageFor(res.status, json, res.headers) };
}

// ---------------------------------------------------------------------------
// P8: Regenerate and the brief settings (contract §3.17.3, §3.17.5, §3.21.4)
// ---------------------------------------------------------------------------

export const BRIEF_REGENERATE_PATH = "/api/exec/briefs/regenerate";
export const BRIEF_SETTINGS_PATH = "/api/exec/briefs/settings";

export type RegenerateResult =
  | { kind: "queued"; rev: number }
  | { kind: "busy" }
  /** 409 conflict: the brief changed since the page loaded (rev = the current one, when the answer carried it). */
  | { kind: "conflict"; rev: number | null }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "failed"; status: number };

/** The words for a Regenerate answer (§3.17.3): queued, busy, conflict, the rate limit in whole minutes (at least 1), else failed. */
export function regenerateMessageFor(r: RegenerateResult): string {
  switch (r.kind) {
    case "queued":
      return BRIEF_COPY.regenerateQueued;
    case "busy":
      return BRIEF_COPY.regenerateBusy;
    case "conflict":
      return BRIEF_COPY.regenerateConflict;
    case "rate_limited": {
      const sec = r.retryAfterSeconds;
      const n = typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? Math.max(1, Math.ceil(sec / 60)) : 60;
      return fillBrief(BRIEF_COPY.regenerateRateLimited, { n });
    }
    default:
      return BRIEF_COPY.regenerateFailed;
  }
}

const isRev = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** POST { expectedRev } (the rev the page showed); the route re-checks the strong sign-in, the origin, the body and the claim. */
export async function regenerateBrief(expectedRev: number, fetchImpl?: FetchLike): Promise<RegenerateResult> {
  if (!isRev(expectedRev)) return { kind: "failed", status: 0 };
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(BRIEF_REGENERATE_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ expectedRev })
    });
  } catch {
    return { kind: "failed", status: 0 };
  }
  const json = asObject(await readJson(res));
  const code = json && typeof json.error === "string" ? json.error : null;
  if (res.status === 202 && json?.status === "queued") return { kind: "queued", rev: isRev(json.rev) ? json.rev : expectedRev };
  if (res.status === 409 && code === "busy") return { kind: "busy" };
  if (res.status === 409 && code === "conflict") return { kind: "conflict", rev: isRev(json?.rev) ? (json?.rev as number) : null };
  if (res.status === 429) return { kind: "rate_limited", retryAfterSeconds: retryAfterOf(json, res.headers) };
  return { kind: "failed", status: res.status };
}

/** Enough of a BriefSettingsView to show. */
export function isBriefSettingsView(v: unknown): v is BriefSettingsView {
  const o = asObject(v);
  return (
    o !== null &&
    typeof o.enabled === "boolean" &&
    typeof o.time === "string" &&
    (o.timezone === null || typeof o.timezone === "string") &&
    typeof o.effectiveTz === "string" &&
    typeof o.workTz === "string" &&
    typeof o.checkinsEnabled === "boolean" &&
    typeof o.supersede === "boolean" &&
    (o.version === null || typeof o.version === "string")
  );
}

export type BriefSettingsSaveResult =
  | { kind: "saved"; settings: BriefSettingsView; sameDayDelivery: boolean; message: string }
  /** 409 conflict: the latest values (null when the answer carried none). */
  | { kind: "conflict"; settings: BriefSettingsView | null; message: string }
  | { kind: "confirmation_required" }
  | { kind: "failed"; status: number; message: string };

/** PATCH { patch, expectedVersion, confirm? } (confirm only as "supersede_legacy_brief"); the route validates, audits and
 *  re-checks the CAS. saved → BRIEF_COPY.settings.saved (+ sameDay when today's brief is being sent now). */
export async function updateBriefSettings(
  body: { patch: BriefSettingsPatch; expectedVersion: string | null; confirm?: "supersede_legacy_brief" },
  fetchImpl?: FetchLike
): Promise<BriefSettingsSaveResult> {
  const copy = BRIEF_COPY.settings;
  const payload: Json = { patch: body.patch, expectedVersion: body.expectedVersion };
  if (body.confirm === "supersede_legacy_brief") payload.confirm = body.confirm;
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(BRIEF_SETTINGS_PATH, {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    return { kind: "failed", status: 0, message: copy.failed };
  }
  const json = asObject(await readJson(res));
  if (res.status === 200 && json && isBriefSettingsView(json.settings)) {
    const sameDay = json.sameDayDelivery === true;
    return { kind: "saved", settings: json.settings, sameDayDelivery: sameDay, message: sameDay ? `${copy.saved} ${copy.sameDay}` : copy.saved };
  }
  if (res.status === 409 && json?.error === "conflict") {
    return { kind: "conflict", settings: isBriefSettingsView(json.settings) ? json.settings : null, message: copy.conflict };
  }
  if (res.status === 400 && json?.error === "confirmation_required") return { kind: "confirmation_required" };
  if (res.status === 429) return { kind: "failed", status: 429, message: tooManyMessage(retryAfterOf(json, res.headers)) };
  return { kind: "failed", status: res.status, message: copy.failed };
}

/**
 * P8 fixer ui-8: the Brief section and P5a's settings card CAS on the same exec_settings version (updated_at). A 409 whose
 * current values for the five brief fields still equal what this form last saved means only another card's columns moved the
 * version: not a conflict for these fields, so the same patch is sent once more on the new version. Anything else is returned
 * as is (a real conflict resets the form to the current values).
 */
export async function saveBriefSettingsRetryingVersion(
  body: { patch: BriefSettingsPatch; expectedVersion: string | null; confirm?: "supersede_legacy_brief" },
  saved: { enabled: boolean; time: string; timezone: string | null; checkinsEnabled: boolean; supersede: boolean },
  call: (b: typeof body) => Promise<BriefSettingsSaveResult> = (b) => updateBriefSettings(b)
): Promise<BriefSettingsSaveResult> {
  const first = await call(body);
  if (first.kind !== "conflict" || first.settings === null) return first;
  const now = first.settings;
  const same = now.enabled === saved.enabled && now.time === saved.time && now.timezone === saved.timezone
    && now.checkinsEnabled === saved.checkinsEnabled && now.supersede === saved.supersede;
  if (!same) return first;
  return call({ ...body, expectedVersion: now.version });
}
