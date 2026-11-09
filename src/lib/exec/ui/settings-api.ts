import type { SettingsPatch } from "@/lib/exec/settings-fields";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import type { SettingsView } from "@/lib/exec/view-types";
import { retryAfterOf, tooManyMessage } from "./feed-api";

// The Settings page's calls from the browser (P5a contract §3.7.3,
// §3.7.4, §3.13.2): PATCH /api/exec/settings (one change, CAS on the version
// the page loaded) and POST /api/exec/settings/voice-reset; P6 (contract
// §3.13) adds POST /api/exec/slack/disconnect. Pure and
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

/** PATCH one change with the version the page loaded; the route validates, audits and checks the CAS again. */
export async function patchSettings(
  body: { patch: SettingsPatch; expectedVersion: string | null; confirm?: "ddtext_notice" },
  fetchImpl?: FetchLike
): Promise<SettingsSaveResult> {
  const payload: Json = { patch: body.patch, expectedVersion: body.expectedVersion };
  if (body.confirm === "ddtext_notice") payload.confirm = "ddtext_notice";
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

export type SlackDisconnectResult = { kind: "disconnected" } | { kind: "failed"; status: number; message: string };

/** The words for a refused or failed Disconnect: 503 slack_unavailable (Slack unreachable, nothing changed) has its own; every other answer is the general one. */
export function slackDisconnectMessageFor(status: number, body: unknown): string {
  const obj = asObject(body);
  if (status === 503 && obj?.error === "slack_unavailable") return SLACK_COPY.disconnectSlackDown;
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
  if (res.status === 200) return { kind: "disconnected" };
  return { kind: "failed", status: res.status, message: slackDisconnectMessageFor(res.status, json) };
}
