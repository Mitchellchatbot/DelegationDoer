"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";
import { useRouter } from "next/navigation";
import { BookOpenCheck, CircleStop, Link2Off } from "lucide-react";
import { SETTINGS_FIELDS, validateSettingsField, type SettingsFieldDef, type SettingsPatch } from "@/lib/exec/settings-fields";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import type { SlackReadingView } from "@/lib/exec/slack-types";
import { SETTINGS_COPY, patchSettings, stopReading } from "@/lib/exec/ui/settings-api";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";
import { refreshWithoutResult } from "./SlackConnectControls";

// The Slack reading half's actions (P7a contract §3.16, N4, N20, C47; Area E).
// A client island inside the server SlackReadingSection: top-level only (P4's
// useIsTopWindow). Framed, or on the server before mount, it offers nothing to
// click: the reading values as plain text and SLACK_READ_COPY.framed.
//
//   * Allow reading (not_consented, revoked, error): a plain <a> to the start
//     route with ?purpose=read, a same-origin navigation; never next/link (a
//     prefetch would GET the start route and issue an OAuth state). Off the
//     canonical host the link becomes P6's settingsWrongHost.
//   * The switch (paused, on): turning it on opens the enable confirm
//     (enableConfirmTitle, enableConfirmBody, the required checkbox
//     enableConfirmCheck attesting to the checklist above, "Turn on" /
//     "Cancel") and sends P5a's PATCH with confirm "slack_reading_notice";
//     turning it off writes the flag only. The Slack budget and the retention
//     are number fields saved one at a time (P5a's registry validates them).
//     Every save carries the settings version the page read; success
//     refreshes the page (the server re-reads the view).
//   * Stop reading Slack (discovering, paused, on, error: whenever a reading
//     half is live or failing, so he can always withdraw; readingNotice says
//     "You can stop at any time"): a confirm in place (stopTitle,
//     stopBody, "Stop reading" / "Cancel"), then POST the stop route. Success
//     refreshes; warning "revoke_failed" also shows stopRevokeFailed (C47:
//     reading stopped and the data was deleted, the permission may still be
//     live in Slack); any other answer shows its words (stopFailed).
// Escape closes an open confirm (unless its request is in flight) and focus
// goes back to the control that opened it.
//
// Imports only client-safe modules (B-P7a-8 / P5a rule 16): the copies, the
// pure settings-api and settings-fields, the frame guard. Types only from
// slack-types.

export const SLACK_READ_START_PATH = "/api/integrations/exec-slack/start?purpose=read";

/** The three registry fields this island renders (section "slack"), in its order: the switch, the budget, the retention. */
const FIELD_ORDER: readonly (keyof SettingsPatch)[] = ["slackReadingEnabled", "slackDailyCapUsd", "retentionDaysSlack"];
export const READING_FIELDS: readonly SettingsFieldDef[] = FIELD_ORDER.map((key) => SETTINGS_FIELDS.find((d) => d.key === key)).filter(
  (d): d is SettingsFieldDef => d !== undefined && d.section === "slack"
);
const fieldOf = (key: keyof SettingsPatch): SettingsFieldDef | undefined => READING_FIELDS.find((d) => d.key === key);

/** Which actions a state offers (§3.16's table; Stop also while discovering: withdrawal never waits, N4 / C42). A view DD
 *  couldn't read (readFailed, P7a fixer ui-3) offers Stop at most: nothing was rejected, so no Allow (a needless OAuth). */
export function readingActions(state: SlackReadingView["state"], opts: { readFailed?: boolean } = {}): { allow: boolean; settings: boolean; stop: boolean } {
  if (opts.readFailed === true) return { allow: false, settings: false, stop: state === "error" };
  return {
    allow: state === "not_consented" || state === "revoked" || state === "error",
    settings: state === "paused" || state === "on",
    stop: state === "discovering" || state === "paused" || state === "on" || state === "error"
  };
}

/** The confirmed enable: PATCH { slackReadingEnabled: true } with confirm "slack_reading_notice". null = saved (and refreshed). */
export async function enableReadingThenRefresh(
  version: string | null,
  refresh: () => void,
  patch: typeof patchSettings = patchSettings
): Promise<{ message: string | null; version: string | null }> {
  const r = await patch({ patch: { slackReadingEnabled: true }, expectedVersion: version, confirm: "slack_reading_notice" });
  if (r.kind === "saved") {
    refresh();
    return { message: null, version: r.view.version };
  }
  if (r.kind === "conflict") {
    refresh();
    return { message: r.message, version: r.view?.version ?? version };
  }
  return { message: r.message, version };
}

/** One reading setting saved on its own (turning the switch off, the budget, the retention); never the confirmation. */
export async function saveReadingSetting(
  def: SettingsFieldDef,
  value: boolean | number,
  version: string | null,
  refresh: () => void,
  patch: typeof patchSettings = patchSettings
): Promise<{ ok: boolean; message: string; version: string | null }> {
  const check = validateSettingsField(def, value);
  if (!check.ok) return { ok: false, message: sentence(check.detail), version };
  const r = await patch({ patch: { [def.key]: value } as SettingsPatch, expectedVersion: version });
  if (r.kind === "saved") {
    refresh();
    return { ok: true, message: r.message, version: r.view.version };
  }
  if (r.kind === "conflict") {
    refresh();
    return { ok: false, message: r.message, version: r.view?.version ?? version };
  }
  return { ok: false, message: r.message, version };
}

/** The confirmed Stop reading: success refreshes; revoke_failed also returns stopRevokeFailed; a failure returns its words. */
export async function stopReadingThenRefresh(
  installationId: string,
  refresh: () => void,
  stop: typeof stopReading = stopReading
): Promise<{ message: string | null; tone: "warning" | "error" | null }> {
  const r = await stop(installationId);
  if (r.kind === "stopped") {
    refresh();
    return r.warning === "revoke_failed" ? { message: SLACK_READ_COPY.stopRevokeFailed, tone: "warning" } : { message: null, tone: null };
  }
  return { message: r.message, tone: "error" };
}

/** What a key press inside an open confirm does: Escape closes it (unless its request is in flight). */
export function readingConfirmKeyAction(key: string, pending: boolean): "close" | null {
  return key === "Escape" && !pending ? "close" : null;
}

function sentence(detail: string): string {
  return detail.length > 0 ? `${detail[0].toUpperCase()}${detail.slice(1)}.` : SETTINGS_COPY.failed;
}

const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");
const LINK_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500";
const SMALL_BUTTON =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_BUTTON = "rounded-lg bg-rose-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50";

export function AllowReadingLink({ onCanonicalHost }: { onCanonicalHost: boolean }) {
  return onCanonicalHost ? (
    <a data-reading-allow href={SLACK_READ_START_PATH} className={LINK_PRIMARY}>
      <BookOpenCheck className="h-3.5 w-3.5" aria-hidden />
      {SLACK_READ_COPY.allowReading}
    </a>
  ) : (
    <p data-reading-wrong-host className="flex items-start gap-1.5 text-[12px] font-medium text-amber-800">
      <Link2Off className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{SLACK_COPY.settingsWrongHost}</span>
    </p>
  );
}

/** The framed form: the values he would change, as words, and why nothing can be clicked. */
function FramedValues({ view, settings }: { view: SlackReadingView; settings: boolean }) {
  return (
    <div data-reading-framed className="space-y-1.5">
      {settings && (
        <dl className="divide-y divide-slate-100 text-[12.5px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5">
            <dt className="text-slate-600">{SLACK_READ_COPY.fieldReadingLabel}</dt>
            <dd className="font-medium text-ink">{view.switchOn ? "On" : "Off"}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5">
            <dt className="text-slate-600">{SLACK_READ_COPY.fieldCapLabel}</dt>
            <dd className="font-medium tabular-nums text-ink">{money(view.capUsd)}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5">
            <dt className="text-slate-600">{SLACK_READ_COPY.fieldRetentionLabel}</dt>
            <dd className="font-medium tabular-nums text-ink">{`${view.retentionDaysSlack} days`}</dd>
          </div>
        </dl>
      )}
      <p className="text-[12px] text-muted">{SLACK_READ_COPY.framed}</p>
    </div>
  );
}

function Switch({ on, labelledBy, disabled, onClick, buttonRef }: { on: boolean; labelledBy: string; disabled: boolean; onClick: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
      data-reading-switch={on ? "on" : "off"}
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        on ? "bg-indigo-600" : "bg-slate-300"
      )}
    >
      <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", on ? "translate-x-[22px]" : "translate-x-0.5")} />
    </button>
  );
}

/** The enable confirm (N20): the required checkbox attests to the checklist the section shows above the switch. */
export function EnableReadingConfirm({
  checked,
  pending,
  onCheck,
  onConfirm,
  onCancel,
  autoFocus = true,
  extra = null
}: {
  checked: boolean;
  pending: boolean;
  onCheck: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
  /** P7b fixer (ui-3): what P7b adds to the switch, shown under the body (null: nothing). */
  extra?: string | null;
}) {
  const id = useId();
  const titleRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (autoFocus) titleRef.current?.focus();
  }, [autoFocus]);
  return (
    <div
      role="group"
      aria-labelledby={`${id}-t`}
      aria-describedby={extra ? `${id}-b ${id}-x` : `${id}-b`}
      data-reading-enable-confirm
      onKeyDown={(e) => {
        if (readingConfirmKeyAction(e.key, pending) !== "close") return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
      className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3"
    >
      <p ref={titleRef} id={`${id}-t`} tabIndex={-1} className="text-[13px] font-semibold text-amber-950 outline-none">
        {SLACK_READ_COPY.enableConfirmTitle}
      </p>
      <p id={`${id}-b`} className="text-[12.5px] leading-relaxed text-amber-950">
        {SLACK_READ_COPY.enableConfirmBody}
      </p>
      {extra ? (
        <p id={`${id}-x`} data-reading-enable-intel className="text-[12.5px] leading-relaxed text-amber-950">
          {extra}
        </p>
      ) : null}
      <label className="flex items-start gap-2 text-[12.5px] text-amber-950">
        <input
          type="checkbox"
          data-reading-enable-check
          required
          checked={checked}
          onChange={(e) => onCheck(e.currentTarget.checked)}
          disabled={pending}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-300"
        />
        <span className="min-w-0">{SLACK_READ_COPY.enableConfirmCheck}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-reading-enable-turn-on onClick={onConfirm} disabled={pending || !checked} className={PRIMARY_BUTTON}>
          {pending ? "Saving…" : "Turn on"}
        </button>
        <button type="button" data-reading-enable-cancel onClick={onCancel} disabled={pending} className={SMALL_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The Stop reading confirm (N4, C42). */
export function StopReadingConfirm({ pending, onConfirm, onCancel, autoFocus = true }: { pending: boolean; onConfirm: () => void; onCancel: () => void; autoFocus?: boolean }) {
  const id = useId();
  const titleRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (autoFocus) titleRef.current?.focus();
  }, [autoFocus]);
  return (
    <div
      role="group"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-b`}
      data-reading-stop-confirm
      onKeyDown={(e) => {
        if (readingConfirmKeyAction(e.key, pending) !== "close") return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
      className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3"
    >
      <p ref={titleRef} id={`${id}-t`} tabIndex={-1} className="text-[13px] font-semibold text-rose-950 outline-none">
        {SLACK_READ_COPY.stopTitle}
      </p>
      <p id={`${id}-b`} className="text-[12.5px] leading-relaxed text-rose-950">
        {SLACK_READ_COPY.stopBody}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-reading-stop-confirm-button onClick={onConfirm} disabled={pending} className={DANGER_BUTTON}>
          {pending ? "Stopping…" : "Stop reading"}
        </button>
        <button type="button" data-reading-stop-cancel onClick={onCancel} disabled={pending} className={SMALL_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Status = { tone: "ok" | "warning" | "error"; text: string } | null;

function NumberSetting({
  def,
  value,
  busy,
  pending,
  draft,
  onDraft,
  onSave,
  formatted
}: {
  def: SettingsFieldDef;
  value: number;
  busy: boolean;
  pending: boolean;
  draft: string | undefined;
  onDraft: (v: string) => void;
  onSave: () => void;
  formatted: string;
}) {
  const labelId = useId();
  const helpId = useId();
  return (
    <div data-reading-setting={def.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-60">
        <p id={labelId} className="text-[13px] font-semibold text-ink">
          {def.key === "slackDailyCapUsd" ? SLACK_READ_COPY.fieldCapLabel : SLACK_READ_COPY.fieldRetentionLabel}
        </p>
        <p id={helpId} className="text-[12px] leading-relaxed text-muted">
          {def.key === "slackDailyCapUsd" ? SLACK_READ_COPY.fieldCapHelp : SLACK_READ_COPY.fieldRetentionHelp}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <input
          type="number"
          inputMode={def.kind === "money" ? "decimal" : "numeric"}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          title={formatted}
          min={def.min}
          max={def.max}
          step={def.kind === "money" ? 0.01 : 1}
          value={draft ?? String(value)}
          disabled={busy}
          onChange={(e) => onDraft(e.currentTarget.value)}
          className="w-28 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-right text-[13px] tabular-nums text-ink focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-muted"
        />
        <button type="button" onClick={onSave} disabled={busy || draft === undefined} className={SMALL_BUTTON}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export function SlackReadingControls({
  view,
  onCanonicalHost = true,
  initialDialog = null,
  initialChecked = false,
  enableConfirmExtra = null
}: {
  view: SlackReadingView;
  /** C45: false replaces the Allow link with P6's settingsWrongHost. */
  onCanonicalHost?: boolean;
  /** Static renders only (tests, screenshots): a confirm open on first render. The page never passes it. */
  initialDialog?: "enable" | "stop" | null;
  /** Static renders only: the enable confirm's checkbox ticked. */
  initialChecked?: boolean;
  /** P7b fixer (ui-3): a second paragraph in the enable confirm (P7b's digests and live reads); null shows none. */
  enableConfirmExtra?: string | null;
}) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const actions = readingActions(view.state, { readFailed: view.readFailed === true });
  const [version, setVersion] = useState<string | null>(view.settingsVersion);
  const [dialog, setDialog] = useState<"enable" | "stop" | null>(initialDialog);
  const [checked, setChecked] = useState(initialChecked);
  const [pending, setPending] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({});
  const [status, setStatus] = useState<Status>(null);
  const switchLabel = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const wasDialog = useRef(dialog);

  // A refresh re-reads the view: the version follows it.
  useEffect(() => setVersion(view.settingsVersion), [view.settingsVersion]);
  // When a confirm closes, focus goes back to the control that opened it, never to <body>.
  useEffect(() => {
    if (dialog === null && wasDialog.current === "enable") switchRef.current?.focus();
    if (dialog === null && wasDialog.current === "stop") stopRef.current?.focus();
    wasDialog.current = dialog;
  }, [dialog]);

  if (!actions.allow && !actions.settings && !actions.stop) return null;
  if (!isTop) return <FramedValues view={view} settings={actions.settings} />;

  // P7a fixer ui-4: every reading action drops ?slack= / ?who= (a "read_connected" banner must not outlive the next step).
  const refresh = () => refreshWithoutResult(() => router.refresh());
  const busy = pending !== null;
  const canStop = actions.stop && typeof view.installationId === "string" && view.installationId.length > 0;

  async function turnOn() {
    if (busy || !checked) return;
    setPending("slackReadingEnabled");
    setStatus(null);
    const r = await enableReadingThenRefresh(version, refresh);
    setPending(null);
    setVersion(r.version);
    if (r.message === null) {
      setDialog(null);
      setChecked(false);
      setStatus({ tone: "ok", text: SETTINGS_COPY.saved });
    } else {
      setStatus({ tone: "error", text: r.message });
    }
  }

  async function save(key: keyof SettingsPatch, value: boolean | number) {
    const def = fieldOf(key);
    if (busy || !def) return;
    setPending(key);
    setStatus(null);
    const r = await saveReadingSetting(def, value, version, refresh);
    setPending(null);
    setVersion(r.version);
    if (r.ok) setDrafts((d) => ({ ...d, [key]: undefined }));
    setStatus({ tone: r.ok ? "ok" : "error", text: r.message });
  }

  async function stop() {
    if (busy || !canStop) return;
    setPending("stop");
    setStatus(null);
    const r = await stopReadingThenRefresh(view.installationId as string, refresh);
    setPending(null);
    setDialog(null);
    setStatus(r.message === null ? null : { tone: r.tone === "warning" ? "warning" : "error", text: r.message });
  }

  const cap = fieldOf("slackDailyCapUsd");
  const retention = fieldOf("retentionDaysSlack");

  return (
    <div data-reading-controls={view.state} className="space-y-2">
      {actions.settings && (
        <div className="divide-y divide-slate-100">
          <div data-reading-setting="slackReadingEnabled" className="space-y-2 py-3">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1 basis-60">
                <p id={switchLabel} className="text-[13px] font-semibold text-ink">
                  {SLACK_READ_COPY.fieldReadingLabel}
                </p>
                <p className="text-[12px] leading-relaxed text-muted">{SLACK_READ_COPY.fieldReadingHelp}</p>
              </div>
              <Switch
                buttonRef={switchRef}
                on={view.switchOn}
                labelledBy={switchLabel}
                disabled={busy || dialog !== null}
                onClick={() => {
                  setStatus(null);
                  if (view.switchOn) void save("slackReadingEnabled", false);
                  else {
                    setChecked(false);
                    setDialog("enable");
                  }
                }}
              />
            </div>
            {dialog === "enable" && !view.switchOn && (
              <EnableReadingConfirm
                checked={checked}
                pending={pending === "slackReadingEnabled"}
                onCheck={setChecked}
                onConfirm={() => void turnOn()}
                onCancel={() => setDialog(null)}
                autoFocus={initialDialog === null}
                extra={enableConfirmExtra}
              />
            )}
          </div>
          {cap && (
            <NumberSetting
              def={cap}
              value={view.capUsd}
              formatted={money(view.capUsd)}
              busy={busy}
              pending={pending === cap.key}
              draft={drafts[cap.key]}
              onDraft={(v) => setDrafts((d) => ({ ...d, [cap.key]: v }))}
              onSave={() => {
                const raw = (drafts[cap.key] ?? "").trim();
                void save(cap.key, raw === "" ? Number.NaN : Number(raw));
              }}
            />
          )}
          {retention && (
            <NumberSetting
              def={retention}
              value={view.retentionDaysSlack}
              formatted={`${view.retentionDaysSlack} days`}
              busy={busy}
              pending={pending === retention.key}
              draft={drafts[retention.key]}
              onDraft={(v) => setDrafts((d) => ({ ...d, [retention.key]: v }))}
              onSave={() => {
                const raw = (drafts[retention.key] ?? "").trim();
                void save(retention.key, raw === "" ? Number.NaN : Number(raw));
              }}
            />
          )}
        </div>
      )}
      {(actions.allow || canStop) && dialog !== "stop" && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {actions.allow && <AllowReadingLink onCanonicalHost={onCanonicalHost} />}
          {canStop && (
            <button
              ref={stopRef}
              type="button"
              data-reading-stop
              onClick={() => {
                setStatus(null);
                setDialog("stop");
              }}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CircleStop className="h-3.5 w-3.5" aria-hidden />
              {SLACK_READ_COPY.stopReading}
            </button>
          )}
        </div>
      )}
      {dialog === "stop" && canStop && (
        <StopReadingConfirm pending={pending === "stop"} onConfirm={() => void stop()} onCancel={() => setDialog(null)} autoFocus={initialDialog === null} />
      )}
      <p
        aria-live="polite"
        role="status"
        data-reading-message={status?.tone ?? ""}
        className={cn("text-[12px]", status?.tone === "ok" ? "text-emerald-700" : status?.tone === "warning" ? "font-medium text-amber-800" : "text-rose-700")}
      >
        {status?.text ?? ""}
      </p>
    </div>
  );
}
