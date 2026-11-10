"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import type { BriefSettingsPatch, BriefSettingsView } from "@/lib/exec/brief-settings";
import { confirmFocusStep } from "@/lib/exec/ui/focus";
import { saveBriefSettingsRetryingVersion } from "@/lib/exec/ui/settings-api";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";
import { SWITCH_BUTTON, switchKnobClass, switchTrackClass } from "./SettingsForm";

// The Settings page's Brief controls (P8 contract §3.17.5, C22, M5): build a brief, its time (15-minute steps) and zone
// (his work zone by default, or one of the twelve listed), suggest check-ins, and send it to Slack in place of the 8am DD
// brief. Changes are saved together with Save (PATCH /api/exec/briefs/settings, CAS on the version the page loaded).
// Turning the Slack switch on opens the confirm first: it lists exactly what the DD brief has that the new one doesn't
// (BRIEF_COPY.supersedeLose, §7.6); "Replace it" saves with confirm "supersede_legacy_brief", Cancel puts the switch back.
// Top-level only: framed (P4's useIsTopWindow false, which is also the server HTML) the values show read-only.

/** The zones the select offers, in order (= brief-settings.ts BRIEF_TIMEZONES; that module is server-only). */
export const BRIEF_ZONE_OPTIONS: readonly string[] = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Paris", "Asia/Manila", "Asia/Karachi", "Asia/Kolkata"
];

/** Every 15-minute step of the day, "00:00" … "23:45". */
export const BRIEF_TIME_OPTIONS: readonly string[] = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

/** "08:00" → "8:00 AM"; anything else as given. */
export function briefTimeLabel(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

interface Values { enabled: boolean; time: string; timezone: string | null; checkinsEnabled: boolean; supersede: boolean }

const valuesOf = (v: BriefSettingsView): Values => ({ enabled: v.enabled, time: v.time, timezone: v.timezone, checkinsEnabled: v.checkinsEnabled, supersede: v.supersede });

/** The patch from the saved values to the edited ones (only what changed). */
export function briefSettingsPatch(saved: Values, edited: Values): BriefSettingsPatch {
  const p: BriefSettingsPatch = {};
  if (edited.enabled !== saved.enabled) p.briefEnabled = edited.enabled;
  if (edited.time !== saved.time) p.briefLocalTime = edited.time;
  if (edited.timezone !== saved.timezone) p.briefTimezone = edited.timezone;
  if (edited.checkinsEnabled !== saved.checkinsEnabled) p.checkinsEnabled = edited.checkinsEnabled;
  if (edited.supersede !== saved.supersede) p.supersedeLegacyBrief = edited.supersede;
  return p;
}

function Switch({ on, disabled, labelledBy, onClick, name, buttonRef }: {
  on: boolean; disabled?: boolean; labelledBy: string; onClick: () => void; name: string; buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      data-brief-setting={name}
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

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p id={id} className="text-[13px] font-semibold text-ink">{label}</p>
        {help && <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{help}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** The supersede confirm (M5, §7.6): title, body, the five things he loses, the foot, Replace it / Cancel. */
export function SupersedeConfirm({ pending, onConfirm, onCancel, titleRef }: {
  pending: boolean; onConfirm: () => void; onCancel: () => void; titleRef?: Ref<HTMLParagraphElement>;
}) {
  const titleId = useId();
  const s = BRIEF_COPY.settings;
  return (
    <div role="alertdialog" aria-modal="false" aria-labelledby={titleId} data-supersede-confirm className="space-y-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
      {/* P8 fixer ui-11: focused as it opens (tabIndex -1), so the dialog is announced. */}
      <p id={titleId} ref={titleRef} tabIndex={-1} data-supersede-title className="text-[13px] font-semibold text-amber-950 outline-none">{s.supersedeConfirmTitle}</p>
      <p className="text-[12.5px] leading-relaxed text-amber-950">{s.supersedeConfirmBody}</p>
      <ul data-supersede-lose className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-amber-950">
        {BRIEF_COPY.supersedeLose.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="text-[12.5px] leading-relaxed text-amber-950">{s.supersedeConfirmFoot}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          data-supersede-confirm-button
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {s.supersedeConfirm}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50"
        >
          {s.cancel}
        </button>
      </div>
    </div>
  );
}

const onOff = (on: boolean) => (on ? "On" : "Off");

/** Framed: the saved values as text, nothing to click. */
function ReadOnly({ view }: { view: BriefSettingsView }) {
  const s = BRIEF_COPY.settings;
  const rows: [string, string][] = [
    [s.enabled, onOff(view.enabled)],
    [s.time, briefTimeLabel(view.time)],
    [s.timezone, view.timezone ?? fillBrief(s.timezoneDefault, { tz: view.workTz })],
    [s.checkins, onOff(view.checkinsEnabled)],
    [s.supersede, onOff(view.supersede)]
  ];
  return (
    <dl data-brief-settings-readonly className="divide-y divide-slate-100">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 text-[12.5px]">
          <dt className="text-slate-600">{label}</dt>
          <dd className="min-w-0 break-words text-right font-medium text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BriefSettingsForm({ view, initialConfirm = false }: { view: BriefSettingsView; initialConfirm?: boolean }) {
  const isTop = useIsTopWindow();
  const ids = { enabled: useId(), time: useId(), zone: useId(), checkins: useId(), supersede: useId() };
  const [saved, setSaved] = useState<Values>(() => valuesOf(view));
  const [edited, setEdited] = useState<Values>(() => (initialConfirm ? { ...valuesOf(view), supersede: true } : valuesOf(view)));
  const [version, setVersion] = useState<string | null>(view.version);
  const [workTz, setWorkTz] = useState(view.workTz);
  const [confirming, setConfirming] = useState(initialConfirm);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const s = BRIEF_COPY.settings;
  // P8 fixer ui-8: a re-read of the page (another card's save, a refresh) brings a newer version: follow it (P7a's pattern).
  useEffect(() => setVersion(view.version), [view.version]);
  // P8 fixer ui-11: the confirm takes focus as it opens; Cancel or Replace it gives it back to the supersede switch.
  const supersedeRef = useRef<HTMLButtonElement>(null);
  const confirmTitleRef = useRef<HTMLParagraphElement>(null);
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    const step = confirmFocusStep(wasConfirming.current, confirming);
    wasConfirming.current = confirming;
    if (step === "open") confirmTitleRef.current?.focus();
    else if (step === "close") supersedeRef.current?.focus();
  }, [confirming]);

  if (!isTop) return <ReadOnly view={view} />;

  const patch = briefSettingsPatch(saved, edited);
  const dirty = Object.keys(patch).length > 0;

  async function save(confirm: boolean): Promise<void> {
    if (pending) return;
    const body = briefSettingsPatch(saved, edited);
    if (Object.keys(body).length === 0) return;
    if (body.supersedeLegacyBrief === true && !confirm) {
      setConfirming(true);
      return;
    }
    setPending(true);
    // P8 fixer ui-8: a 409 caused only by another card's save on the shared version is retried once on the new version.
    const result = await saveBriefSettingsRetryingVersion(
      { patch: body, expectedVersion: version, ...(confirm ? { confirm: "supersede_legacy_brief" as const } : {}) }, saved);
    setPending(false);
    setConfirming(false);
    if (result.kind === "saved") {
      setSaved(valuesOf(result.settings));
      setEdited(valuesOf(result.settings));
      setVersion(result.settings.version);
      setWorkTz(result.settings.workTz);
      setMessage({ tone: "ok", text: result.message });
    } else if (result.kind === "conflict") {
      if (result.settings) {
        setSaved(valuesOf(result.settings));
        setEdited(valuesOf(result.settings));
        setVersion(result.settings.version);
      }
      setMessage({ tone: "error", text: result.message });
    } else if (result.kind === "confirmation_required") {
      setConfirming(true);
    } else {
      setMessage({ tone: "error", text: result.message });
    }
  }

  const set = (next: Partial<Values>) => {
    setMessage(null);
    setEdited((e) => ({ ...e, ...next }));
  };

  return (
    <div data-brief-settings-form className="space-y-1">
      <div className="divide-y divide-slate-100">
        <Field id={ids.enabled} label={s.enabled} help={s.enabledHelp}>
          <Switch name="enabled" on={edited.enabled} labelledBy={ids.enabled} disabled={pending} onClick={() => set({ enabled: !edited.enabled })} />
        </Field>
        <Field id={ids.time} label={s.time}>
          <select
            aria-labelledby={ids.time}
            data-brief-setting="time"
            value={edited.time}
            disabled={pending}
            onChange={(e) => set({ time: e.target.value })}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[12.5px] text-ink"
          >
            {(BRIEF_TIME_OPTIONS.includes(edited.time) ? BRIEF_TIME_OPTIONS : [edited.time, ...BRIEF_TIME_OPTIONS]).map((t) => (
              <option key={t} value={t}>
                {briefTimeLabel(t)}
              </option>
            ))}
          </select>
        </Field>
        <div className="py-3">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <p id={ids.zone} className="text-[13px] font-semibold text-ink">{s.timezone}</p>
            <select
              aria-labelledby={ids.zone}
              data-brief-setting="timezone"
              value={edited.timezone ?? ""}
              disabled={pending}
              onChange={(e) => set({ timezone: e.target.value === "" ? null : e.target.value })}
              className="max-w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-[12.5px] text-ink"
            >
              <option value="">{fillBrief(s.timezoneDefault, { tz: workTz })}</option>
              {/* P8 fixer ui-10: a stored zone outside the list (P2a's column is free text) is shown as itself, as the time select does. */}
              {edited.timezone !== null && !BRIEF_ZONE_OPTIONS.includes(edited.timezone) && <option value={edited.timezone}>{edited.timezone}</option>}
              {BRIEF_ZONE_OPTIONS.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-1 text-[12px] text-muted">{s.timeZoneNote}</p>
        </div>
        <Field id={ids.checkins} label={s.checkins} help={s.checkinsHelp}>
          <Switch name="checkins" on={edited.checkinsEnabled} labelledBy={ids.checkins} disabled={pending} onClick={() => set({ checkinsEnabled: !edited.checkinsEnabled })} />
        </Field>
        <Field id={ids.supersede} label={s.supersede} help={s.supersedeHelp}>
          <Switch
            name="supersede"
            buttonRef={supersedeRef}
            on={edited.supersede}
            labelledBy={ids.supersede}
            disabled={pending}
            onClick={() => {
              const next = !edited.supersede;
              set({ supersede: next });
              setConfirming(next && !saved.supersede);
            }}
          />
        </Field>
      </div>
      {confirming && (
        <SupersedeConfirm
          titleRef={confirmTitleRef}
          pending={pending}
          onConfirm={() => void save(true)}
          onCancel={() => {
            setConfirming(false);
            setEdited((e) => ({ ...e, supersede: saved.supersede }));
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-3 pb-2 pt-1">
        <button
          type="button"
          data-brief-settings-save
          onClick={() => void save(false)}
          disabled={!dirty || pending || confirming}
          className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {s.save}
        </button>
        <p aria-live="polite" role="status" className={message?.tone === "error" ? "text-[12px] text-rose-700" : "text-[12px] text-emerald-700"}>
          {message?.text ?? ""}
        </p>
      </div>
    </div>
  );
}
