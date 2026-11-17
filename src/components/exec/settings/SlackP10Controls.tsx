"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";
import { useRouter } from "next/navigation";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { formatInZone } from "@/lib/exec/format";
import { SETTINGS_FIELDS, validateSettingsField, type SettingsFieldDef, type SettingsPatch } from "@/lib/exec/settings-fields";
import { SLACK_P10_COPY, fillP10 } from "@/lib/exec/slack-p10-copy";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import type { SlackP10ReadingPart } from "@/lib/exec/slack-types";
import { confirmFocusStep } from "@/lib/exec/ui/focus";
import { SETTINGS_COPY, patchSettings, type SettingsConfirm, type SettingsSaveResult } from "@/lib/exec/ui/settings-api";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";
import { SWITCH_BUTTON, switchKnobClass, switchTrackClass } from "./SettingsForm";
import { refreshWithoutResult } from "./SlackConnectControls";

// The P10 Slack controls (contract §3.7.5, C1, C9, C10, C25, C30, C52, v1.1 product-4, -12, -13, -14, security-5; Area B). A
// client island inside the server SlackReadingSection, for the paused and on states, in two parts the section places:
//
//   part "readAll"  the read-all switch, directly under P7a's "Which conversations to read" radio group (product-14), its
//                   status line (readAllUpdating while a re-discovery is pending, else readAllStatus) and off-help; turning
//                   it on opens its confirm, which lists every channel it will open (security-5: readAllConfirmOpens, the
//                   stored labels, +N more, readAllConfirmMuteFirst; nothing to open → none of the three).
//   part "rest"     the notice, then the six other controls in §3.7.2's order: lead counts, reply drafts, sending (with his
//                   DD Slack connection, product-4), automatic drafts, their daily budget (only while automatic drafts are
//                   on), style learning (its state line under it, product-12). Sending, automatic drafts and style learning
//                   are greyed with needsReplies while reply drafts are off; while reading is paused every switch says
//                   startsWhenReading (product-13).
//
// Each notice switch (read-all, lead counts, reply drafts, sending) turns on only through its confirm: the title, the body
// ({days} filled), one checkbox, S.turnOn / S.cancel; focus goes to the title on open and back to the switch on close (P8's
// confirmFocusStep); Escape closes it. Saves go through P5a's PATCH with the page's settings version and the confirm; a 409
// whose current value of the same field is still what this control showed is another card's write (the version moved, not
// this setting) and is sent once more on the new version (P8's saveBriefSettingsRetryingVersion rule). Framed, or on the
// server before mount, it offers nothing to click: the values as text and SLACK_READ_COPY.framed.
//
// Imports only client-safe modules (B-P10-13): the copies, settings-fields, the pure settings-api and focus helpers, the
// frame guard and the shared switch classes. Types only from slack-types. Nothing here logs.

const S = SLACK_P10_COPY.settings;

export type P10Notice = "readAll" | "leads" | "replies" | "send";
type P10Key = "slackReadAll" | "slackLeadCountsEnabled" | "slackRepliesEnabled" | "slackReplySendEnabled" | "slackReplyAuto"
  | "slackReplyDailyCapUsd" | "slackVoiceEnabled";

/** The four notice switches: the field, the confirm the PATCH carries, and the dialog's words. */
export const P10_NOTICES: Readonly<Record<P10Notice, { key: P10Key; confirm: SettingsConfirm; title: string; body: string; check: string }>> = Object.freeze({
  readAll: { key: "slackReadAll", confirm: "slack_read_all_notice", title: S.readAllConfirmTitle, body: S.readAllConfirmBody, check: S.readAllConfirmCheck },
  leads: { key: "slackLeadCountsEnabled", confirm: "slack_lead_counts_notice", title: S.leadsConfirmTitle, body: S.leadsConfirmBody, check: S.leadsConfirmCheck },
  replies: { key: "slackRepliesEnabled", confirm: "slack_replies_notice", title: S.repliesConfirmTitle, body: S.repliesConfirmBody, check: S.repliesConfirmCheck },
  send: { key: "slackReplySendEnabled", confirm: "slack_reply_send_notice", title: S.sendConfirmTitle, body: S.sendConfirmBody, check: S.sendConfirmCheck }
});

const fieldOf = (key: P10Key): SettingsFieldDef | undefined => SETTINGS_FIELDS.find((d) => d.key === key && d.group === "slackP10");

/** A switch's current value in the part. */
export function p10Value(p10: SlackP10ReadingPart, key: P10Key): boolean | number {
  switch (key) {
    case "slackReadAll": return p10.readAll;
    case "slackLeadCountsEnabled": return p10.leadCounts;
    case "slackRepliesEnabled": return p10.replies;
    case "slackReplySendEnabled": return p10.replySend;
    case "slackReplyAuto": return p10.replyAuto;
    case "slackReplyDailyCapUsd": return p10.replyCapUsd;
    default: return p10.voice;
  }
}

/** Greyed with needsReplies while reply drafts are off: sending, automatic drafts, style learning (product-12). */
export function p10Disabled(p10: SlackP10ReadingPart, key: P10Key): string | null {
  if ((key === "slackReplySendEnabled" || key === "slackReplyAuto" || key === "slackVoiceEnabled" || key === "slackReplyDailyCapUsd") && !p10.replies) {
    return S.needsReplies;
  }
  return null;
}

/** The read-all status line: readAllUpdating while the switch's re-discovery hasn't applied (product-14), else readAllStatus
 *  with the finance count, while read-all is on. */
export function readAllStatusText(p10: SlackP10ReadingPart): string | null {
  if (p10.readAllPending) return S.readAllUpdating;
  if (!p10.readAll || p10.financeWatched === null) return null;
  // P10 fixer ui-10: the singular for one channel.
  return p10.financeWatched === 1 ? S.readAllStatusOne : fillP10(S.readAllStatus, { finance: p10.financeWatched });
}

/** security-5: the confirm's list of what read-all opens; null when there is nothing to open (none of the three lines). A list
 *  that couldn't be read is never "nothing": see readAllOpensUnknown. */
export function readAllOpensLines(p10: Pick<SlackP10ReadingPart, "readAllOpens">): { intro: string; labels: string[]; more: string | null; muteFirst: string } | null {
  const o = p10.readAllOpens;
  if (o === null) return null;
  const labels = Array.isArray(o.labels) ? o.labels.filter((l) => typeof l === "string" && l.length > 0) : [];
  const more = typeof o.more === "number" && o.more > 0 ? Math.trunc(o.more) : 0;
  if (labels.length + more === 0) return null;
  const n = labels.length + more;
  return {
    intro: n === 1 ? S.readAllConfirmOpensOne : fillP10(S.readAllConfirmOpens, { n }),
    labels,
    more: more > 0 ? fillP10(S.readAllConfirmMore, { n: more }) : null,
    muteFirst: S.readAllConfirmMuteFirst
  };
}

/** P10 fixer security-2: the read of "the channels read-all would open" failed (readAllOpens null: a store error, a timeout,
 *  the page's abort), which is NOT "nothing to open". The read-all confirm then says so and can't be confirmed (Appendix C #5:
 *  the confirm, not a heuristic, is the control, so it never turns read-all on without its list). */
export function readAllOpensUnknown(notice: P10Notice, p10: Pick<SlackP10ReadingPart, "readAllOpens" | "schemaReady">): boolean {
  return notice === "readAll" && p10.schemaReady === true && p10.readAllOpens === null;
}

/** The confirm body with {days} filled (the lead counts' kept days). */
export function noticeBody(notice: P10Notice, p10: Pick<SlackP10ReadingPart, "retentionDaysSlack">): string {
  return fillP10(P10_NOTICES[notice].body, { days: p10.retentionDaysSlack });
}

/** product-4: "Slack connection: {state}" in P8's tokenState words (P10's own slack-reply / token-health key). */
export function sendConnectionText(p10: Pick<SlackP10ReadingPart, "tokenHealth">, tz: string, now: string): string {
  const t = p10.tokenHealth;
  const state = t === null ? "unchecked" : t.state;
  const words: string = BRIEF_COPY.system.tokenState[state] ?? BRIEF_COPY.system.tokenState.unchecked;
  return fillP10(S.sendConnection, { state: fillBrief(words.replace(" ({code})", ""), { time: formatInZone(t?.checkedAt ?? null, tz, "datetime", now) }) });
}

/** product-12: the style's state line under the switch. */
export function voiceStateText(p10: Pick<SlackP10ReadingPart, "voiceState">, tz: string, now: string): string | null {
  const v = p10.voiceState;
  if (v === null) return null;
  switch (v.state) {
    case "ready":
      return fillP10(S.voiceReady, { n: v.samples, date: formatInZone(v.builtAt, tz, "date", now) });
    case "insufficient":
      return v.fallback === "email" ? S.voiceInsufficientEmail : S.voiceInsufficientHouse;
    case "failed": {
      const reasons = S.voiceReasons as Readonly<Record<string, string>>;
      return fillP10(S.voiceFailed, { reason: Object.prototype.hasOwnProperty.call(reasons, v.reason) ? reasons[v.reason] : reasons.read_failed });
    }
    default:
      return S.voiceNone;
  }
}

/** One P10 setting saved; a 409 whose current value of this field is still `shown` is another card's write: sent once more on the
 *  new version (P8's saveBriefSettingsRetryingVersion rule). */
export async function saveP10Setting(
  key: P10Key,
  value: boolean | number,
  version: string | null,
  shown: boolean | number,
  confirm?: SettingsConfirm,
  patch: typeof patchSettings = patchSettings
): Promise<SettingsSaveResult> {
  const def = fieldOf(key);
  if (!def) return { kind: "failed", status: 0, message: SETTINGS_COPY.failed };
  const check = validateSettingsField(def, value);
  if (!check.ok) return { kind: "failed", status: 400, message: S.saveFailed };
  const body = { patch: { [key]: value } as SettingsPatch, expectedVersion: version, ...(confirm ? { confirm } : {}) };
  const first = await patch(body);
  if (first.kind !== "conflict" || first.view === null) return first;
  const current = (first.view.settings as unknown as Record<string, unknown>)[key];
  if (current !== shown) return first;
  return patch({ ...body, expectedVersion: first.view.version });
}

const SMALL_BUTTON =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";
const ALERT = "rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700";

function P10Switch({ on, labelledBy, describedBy, disabled, onClick, buttonRef, name }: {
  on: boolean; labelledBy: string; describedBy?: string; disabled: boolean; onClick: () => void; buttonRef?: Ref<HTMLButtonElement>; name: string;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
      data-p10-switch={name}
      data-p10-on={on ? "on" : "off"}
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
      className={SWITCH_BUTTON}
    >
      <span aria-hidden className={switchTrackClass(on)}>
        <span className={switchKnobClass(on)} />
      </span>
    </button>
  );
}

/** A notice switch's confirm (title, body, the read-all list, one checkbox, Turn on / Cancel). */
export function P10Confirm({ notice, p10, checked, pending, onCheck, onConfirm, onCancel, titleRef }: {
  notice: P10Notice; p10: SlackP10ReadingPart; checked: boolean; pending: boolean; onCheck: (checked: boolean) => void;
  onConfirm: () => void; onCancel: () => void; titleRef?: Ref<HTMLParagraphElement>;
}) {
  const id = useId();
  const n = P10_NOTICES[notice];
  const opens = notice === "readAll" ? readAllOpensLines(p10) : null;
  const unknown = readAllOpensUnknown(notice, p10);
  return (
    <div
      role="group"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-b`}
      data-p10-confirm={notice}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || pending) return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
      className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3"
    >
      <p ref={titleRef} id={`${id}-t`} tabIndex={-1} className="text-[13px] font-semibold text-amber-950 outline-none">
        {n.title}
      </p>
      <p id={`${id}-b`} className="text-[12.5px] leading-relaxed text-amber-950">
        {noticeBody(notice, p10)}
      </p>
      {opens !== null && (
        <div data-p10-read-all-opens className="space-y-1">
          <p className="text-[12.5px] font-semibold text-amber-950">{opens.intro}</p>
          <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-[12.5px] text-amber-950">
            {opens.labels.map((label, i) => (
              <li key={i} data-p10-read-all-open className="break-words">{label}</li>
            ))}
          </ul>
          {opens.more !== null && <p data-p10-read-all-more className="text-[12px] text-amber-900">{opens.more}</p>}
          <p data-p10-read-all-mute-first className="text-[12.5px] font-semibold text-amber-950">{opens.muteFirst}</p>
        </div>
      )}
      {unknown && (
        <p role="alert" data-p10-read-all-unknown className="text-[12.5px] font-semibold text-amber-950">{S.readAllConfirmUnknown}</p>
      )}
      <label className="flex items-start gap-2 text-[12.5px] text-amber-950">
        <input
          type="checkbox"
          data-p10-confirm-check={notice}
          required
          checked={checked}
          onChange={(e) => onCheck(e.currentTarget.checked)}
          disabled={pending}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-300"
        />
        <span className="min-w-0">{n.check}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-p10-confirm-turn-on={notice} onClick={onConfirm} disabled={pending || !checked || unknown} className={cn(PRIMARY_BUTTON, "min-h-10 sm:min-h-0")}>
          {pending ? S.saving : S.turnOn}
        </button>
        <button type="button" data-p10-confirm-cancel={notice} onClick={onCancel} disabled={pending} className={cn(SMALL_BUTTON, "min-h-10 sm:min-h-0")}>
          {S.cancel}
        </button>
      </div>
    </div>
  );
}

interface Row { key: P10Key; notice: P10Notice | null; label: string; help: string }

const READ_ALL_ROW: Row = { key: "slackReadAll", notice: "readAll", label: S.readAllLabel, help: S.readAllHelp };
const REST_ROWS: readonly Row[] = [
  { key: "slackLeadCountsEnabled", notice: "leads", label: S.leadsLabel, help: S.leadsHelp },
  { key: "slackRepliesEnabled", notice: "replies", label: S.repliesLabel, help: S.repliesHelp },
  { key: "slackReplySendEnabled", notice: "send", label: S.sendLabel, help: S.sendHelp },
  { key: "slackReplyAuto", notice: null, label: S.autoLabel, help: S.autoHelp },
  { key: "slackReplyDailyCapUsd", notice: null, label: S.capLabel, help: S.capHelp },
  { key: "slackVoiceEnabled", notice: null, label: S.voiceLabel, help: S.voiceHelp }
];

/** The rows a part renders (the budget only while automatic drafts are on). Exported for the tests. */
export function p10Rows(part: "readAll" | "rest", p10: SlackP10ReadingPart): Row[] {
  if (part === "readAll") return [READ_ALL_ROW];
  return REST_ROWS.filter((r) => r.key !== "slackReplyDailyCapUsd" || p10.replyAuto);
}

const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");

/** The framed / pre-mount view: every value as text, nothing to click. */
function FramedRows({ rows, p10 }: { rows: Row[]; p10: SlackP10ReadingPart }) {
  return (
    <div data-p10-framed className="space-y-1.5">
      <ul className="space-y-1 text-[12.5px] text-slate-700">
        {rows.map((r) => {
          const v = p10Value(p10, r.key);
          return (
            <li key={r.key} data-p10-framed-row={r.key}>
              {`${r.label}: ${typeof v === "number" ? money(v) : v ? S.on : S.off}`}
            </li>
          );
        })}
      </ul>
      <p className="text-[12px] text-muted">{SLACK_READ_COPY.framed}</p>
    </div>
  );
}

export function SlackP10Controls({
  part,
  p10,
  version,
  tz,
  now,
  initialDialog = null,
  initialChecked = false
}: {
  part: "readAll" | "rest";
  p10: SlackP10ReadingPart;
  /** The settings version the page read (the CAS token). */
  version: string | null;
  tz: string;
  now: string;
  /** Static renders only (tests, screenshots): a confirm open on first render. The page never passes them. */
  initialDialog?: P10Notice | null;
  initialChecked?: boolean;
}) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const ids = useId();
  const [dialog, setDialog] = useState<P10Notice | null>(initialDialog);
  const [checked, setChecked] = useState(initialChecked);
  const [pending, setPending] = useState<P10Key | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cap, setCap] = useState<string>(String(p10.replyCapUsd));
  const [ver, setVer] = useState<string | null>(version);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const switchRefs = useRef(new Map<P10Notice, HTMLButtonElement>());
  const wasOpen = useRef<P10Notice | null>(initialDialog);

  // A refresh re-reads the part and the version: the island follows them.
  useEffect(() => setVer(version), [version]);
  useEffect(() => setCap(String(p10.replyCapUsd)), [p10.replyCapUsd]);
  // P8's confirmFocusStep: the title on open, the switch that opened it on close.
  useEffect(() => {
    const step = confirmFocusStep(wasOpen.current !== null, dialog !== null);
    if (step === "open") titleRef.current?.focus();
    if (step === "close" && wasOpen.current !== null) switchRefs.current.get(wasOpen.current)?.focus();
    wasOpen.current = dialog;
  }, [dialog]);

  if (!p10.schemaReady) {
    return part === "rest" ? <p data-p10-not-installed className="text-[12.5px] text-muted">{S.notInstalled}</p> : null;
  }
  const rows = p10Rows(part, p10);
  if (!isTop) return <FramedRows rows={rows} p10={p10} />;

  async function save(key: P10Key, value: boolean | number, confirm?: SettingsConfirm) {
    if (pending !== null) return;
    setPending(key);
    setMessage(null);
    const r = await saveP10Setting(key, value, ver, p10Value(p10, key), confirm);
    setPending(null);
    if (r.kind === "saved") {
      setDialog(null);
      setChecked(false);
      setVer(r.view.version);
      refreshWithoutResult(() => router.refresh());
      return;
    }
    setMessage(r.kind === "failed" && r.status === 0 ? S.saveFailed : r.message);
    if (r.kind === "conflict") refreshWithoutResult(() => router.refresh());
  }

  function toggle(row: Row) {
    const on = p10Value(p10, row.key) === true;
    if (!on && row.notice !== null) {
      setChecked(false);
      setDialog(row.notice);
      return;
    }
    void save(row.key, !on);
  }

  return (
    <div data-p10-controls={part} className="space-y-3">
      {part === "rest" && <p data-p10-notice className="text-[12.5px] leading-relaxed text-muted">{S.notice}</p>}
      <ul className="space-y-3">
        {rows.map((row) => {
          const labelId = `${ids}-${row.key}-l`;
          const helpId = `${ids}-${row.key}-h`;
          const value = p10Value(p10, row.key);
          const why = p10Disabled(p10, row.key);
          const busy = pending !== null;
          return (
            <li key={row.key} data-p10-row={row.key} data-p10-greyed={why !== null ? "" : undefined} className={cn("space-y-1", why !== null && "opacity-70")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p id={labelId} className="text-[12.5px] font-semibold text-ink">{row.label}</p>
                  <p id={helpId} className="text-[12px] leading-relaxed text-muted">{row.help}</p>
                </div>
                {typeof value === "number" ? (
                  <form
                    className="flex shrink-0 items-center gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const n = Number(cap);
                      if (!Number.isFinite(n)) {
                        setMessage(S.saveFailed);
                        return;
                      }
                      void save(row.key, n);
                    }}
                  >
                    <label htmlFor={`${ids}-cap`} className="sr-only">{row.label}</label>
                    <span aria-hidden className="text-[12.5px] text-slate-500">$</span>
                    <input
                      id={`${ids}-cap`}
                      data-p10-cap
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={20}
                      step={0.25}
                      value={cap}
                      disabled={busy || why !== null}
                      onChange={(e) => setCap(e.currentTarget.value)}
                      className="min-h-10 w-20 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[13px] text-ink sm:min-h-0"
                    />
                    <button type="submit" disabled={busy || why !== null} className={cn(SMALL_BUTTON, "min-h-10 sm:min-h-0")}>Save</button>
                  </form>
                ) : (
                  <P10Switch
                    name={row.key}
                    on={value === true}
                    labelledBy={labelId}
                    describedBy={helpId}
                    disabled={busy || why !== null}
                    onClick={() => toggle(row)}
                    buttonRef={row.notice !== null ? (el) => {
                      if (el) switchRefs.current.set(row.notice as P10Notice, el);
                    } : undefined}
                  />
                )}
              </div>
              {why !== null && <p data-p10-why={row.key} className="text-[12px] text-muted">{why}</p>}
              {p10.readingPaused && <p data-p10-starts-when-reading={row.key} className="text-[12px] text-muted">{S.startsWhenReading}</p>}
              {row.key === "slackReadAll" && (() => {
                const status = readAllStatusText(p10);
                return (
                  <>
                    {status !== null && <p data-p10-read-all-status={p10.readAllPending ? "updating" : "count"} className="text-[12px] text-slate-700">{status}</p>}
                    {p10.readAll && <p data-p10-read-all-off-help className="text-[12px] text-muted">{S.readAllOffHelp}</p>}
                  </>
                );
              })()}
              {row.key === "slackReplySendEnabled" && (
                <p data-p10-send-connection className="text-[12px] text-slate-700">{sendConnectionText(p10, tz, now)}</p>
              )}
              {row.key === "slackVoiceEnabled" && (() => {
                const line = voiceStateText(p10, tz, now);
                return line !== null ? <p data-p10-voice-state className="text-[12px] text-slate-700">{line}</p> : null;
              })()}
              {dialog !== null && row.notice === dialog && (
                <P10Confirm
                  notice={dialog}
                  p10={p10}
                  checked={checked}
                  pending={pending !== null}
                  onCheck={setChecked}
                  onConfirm={() => void save(P10_NOTICES[dialog].key, true, P10_NOTICES[dialog].confirm)}
                  onCancel={() => setDialog(null)}
                  titleRef={titleRef}
                />
              )}
            </li>
          );
        })}
      </ul>
      <p role="alert" aria-live="assertive" data-p10-message className={message ? ALERT : "sr-only"}>
        {message ?? ""}
      </p>
    </div>
  );
}
