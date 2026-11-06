"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";
import { SETTINGS_FIELDS, validateSettingsField, type SettingsFieldDef, type SettingsPatch, type SettingsSchemaKey } from "@/lib/exec/settings-fields";
import { focusLost } from "@/lib/exec/ui/focus";
import { SETTINGS_COPY, patchSettings, voiceCanBuild } from "@/lib/exec/ui/settings-api";
import type { SettingsView } from "@/lib/exec/view-types";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";

// The editable settings (P5a contract §3.13.2, A6, C14, S2). Every field
// comes from the client-safe registry (settings-fields.ts; P5b appends its
// own), is validated here with validateSettingsField before it is sent, and
// is saved on its own as one PATCH with the version the page loaded (the
// route checks everything again, audits it and compares the version). A
// field whose migration isn't applied says so and can't be changed.
//
// Framed (P4's useIsTopWindow false, which includes the server render): every
// value is plain text, with no button, no toggle and no input, and a line
// saying changes are off (a-build-2). Turning DD text triage on asks for an
// explicit confirmation first (the notice and the data terms); turning it off
// says what that deletes.

type FieldKey = keyof SettingsPatch;
type Status = { field: FieldKey; tone: "ok" | "error"; text: string } | null;
type Confirm = { turningOn: boolean; checked: boolean } | null;

export const DDTEXT_KEY: FieldKey = "ddtextEnabled";

export function ddtextConfirmText(turningOn: boolean, retentionDays: number): { question: string; body: string } {
  return turningOn
    ? {
        question: "Turn on DD text triage?",
        body:
          // Names every source the job sends to the model (DdtextSourceType and the batch context; review ui-2).
          `Every 10 minutes Claude Haiku reads new task comments (including the notes on status changes), handoff notes, extension reasons and submitted EOD/SOD blocker notes, with up to five earlier comments and the task's title and client for context, and stores short AI summaries ` +
          `(up to 200 characters) for ${retentionDays} days. Turning it off deletes them within 10 minutes. Confirm first that the team ` +
          `has been told and that Anthropic's data terms cover employee text.`
      }
    : { question: "Turn off DD text triage?", body: "Its stored summaries and items are deleted within 10 minutes." };
}

function installed(def: Pick<SettingsFieldDef, "group">, schema: Readonly<Partial<Record<SettingsSchemaKey, boolean>>>): boolean {
  return def.group === "base" || schema[def.group] === true;
}

function valueOf(view: SettingsView, key: FieldKey): unknown {
  return (view.settings as unknown as Record<string, unknown>)[key];
}

/** A field's value as words: "On", "Off", "90 days", "$15.00". */
export function settingValueText(def: SettingsFieldDef, value: unknown): string {
  if (def.kind === "boolean") return value === true ? "On" : "Off";
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (def.kind === "money") return `$${value.toFixed(2)}`;
  return /^retentionDays/.test(def.key) ? `${value} days` : String(value);
}

function sentence(detail: string): string {
  return detail.length > 0 ? `${detail[0].toUpperCase()}${detail.slice(1)}.` : SETTINGS_COPY.failed;
}

const GROUPS: readonly { title: string; test: (def: SettingsFieldDef) => boolean }[] = [
  { title: "Assistant switches", test: (d) => d.kind === "boolean" },
  { title: "Retention", test: (d) => d.kind === "int" },
  { title: "Daily AI budget", test: (d) => d.kind === "money" }
];

const SMALL_BUTTON =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";

function Switch({
  on,
  labelledBy,
  disabled,
  onClick,
  buttonRef
}: {
  on: boolean;
  labelledBy: string;
  disabled: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="switch"
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

export function DdtextConfirm({
  turningOn,
  retentionDays,
  checked,
  pending,
  onCheck,
  onConfirm,
  onCancel
}: {
  turningOn: boolean;
  retentionDays: number;
  checked: boolean;
  pending: boolean;
  onCheck: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const text = ddtextConfirmText(turningOn, retentionDays);
  // Review ui-7: the switch that opened it is disabled while it is open, so
  // focus moves to the question (tabIndex -1) as it opens; the group's label
  // and description make a screen reader read the question and the notice.
  const questionRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    questionRef.current?.focus({ preventScroll: false });
  }, []);
  return (
    <div
      role="group"
      aria-labelledby={`${id}-q`}
      aria-describedby={`${id}-b`}
      data-ddtext-confirm={turningOn ? "on" : "off"}
      className="mt-2 space-y-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3"
    >
      <p ref={questionRef} id={`${id}-q`} tabIndex={-1} data-confirm-question className="text-[13px] font-semibold text-amber-950 focus:outline-none">
        {text.question}
      </p>
      <p id={`${id}-b`} className="text-[12.5px] leading-relaxed text-amber-950">
        {text.body}
      </p>
      {turningOn && (
        <label className="flex items-start gap-2 text-[12.5px] text-amber-950">
          <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.currentTarget.checked)} disabled={pending} className="mt-0.5 h-4 w-4 rounded border-amber-300" />
          <span>I&apos;ve confirmed both</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-confirm-ddtext onClick={onConfirm} disabled={pending || (turningOn && !checked)} className={PRIMARY_BUTTON}>
          {pending ? "Saving…" : turningOn ? "Turn on" : "Turn off"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className={SMALL_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  def,
  view,
  isTop,
  pending,
  status,
  draft,
  error,
  confirm,
  onToggle,
  onDraft,
  onSave,
  onConfirmCheck,
  onConfirm,
  onCancel
}: {
  def: SettingsFieldDef;
  view: SettingsView;
  isTop: boolean;
  pending: FieldKey | null;
  status: Status;
  draft: string | undefined;
  error: string | undefined;
  confirm: Confirm;
  onToggle: () => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onConfirmCheck: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const labelId = useId();
  const helpId = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  // Review ui-7: when the DD text confirm closes (Cancel, a save, a conflict)
  // and its control took focus with it, focus goes back to the switch.
  const wasConfirming = useRef(confirm !== null);
  useEffect(() => {
    const closed = wasConfirming.current && confirm === null;
    wasConfirming.current = confirm !== null;
    if (closed && typeof document !== "undefined" && focusLost(document.activeElement, document.body)) switchRef.current?.focus();
  }, [confirm]);
  const ready = installed(def, view.schema);
  const value = valueOf(view, def.key);
  const busy = pending !== null;
  const mine = status && status.field === def.key ? status : null;
  return (
    <div data-setting={def.key} className="space-y-1 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <p id={labelId} className="text-[13px] font-semibold text-ink">
            {def.label}
          </p>
          <p id={helpId} className="text-[12px] leading-relaxed text-muted">
            {def.help}
          </p>
          {!ready && (
            <p data-not-installed className="mt-1 text-[12px] font-medium text-amber-800">
              {SETTINGS_COPY.notInstalled}
            </p>
          )}
          {ready && def.key === "voiceEnabled" && !voiceCanBuild(view) && (
            <p data-voice-needs className="mt-1 text-[12px] font-medium text-amber-800">
              {SETTINGS_COPY.voiceNeeds}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!isTop ? (
            <span data-readonly-value className="text-[13px] font-semibold tabular-nums text-slate-700">
              {ready ? settingValueText(def, value) : "—"}
            </span>
          ) : def.kind === "boolean" ? (
            <Switch buttonRef={switchRef} on={ready && value === true} labelledBy={labelId} disabled={!ready || busy || confirm !== null} onClick={onToggle} />
          ) : (
            <>
              <input
                type="number"
                inputMode={def.kind === "money" ? "decimal" : "numeric"}
                aria-labelledby={labelId}
                aria-describedby={helpId}
                aria-invalid={error ? true : undefined}
                min={def.min}
                max={def.max}
                step={def.kind === "money" ? 0.01 : 1}
                value={ready ? (draft ?? (typeof value === "number" ? String(value) : "")) : ""}
                disabled={!ready || busy}
                onChange={(e) => onDraft(e.currentTarget.value)}
                className="w-28 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-right text-[13px] tabular-nums text-ink focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-muted"
              />
              <button type="button" onClick={onSave} disabled={!ready || busy || draft === undefined} className={SMALL_BUTTON}>
                {pending === def.key ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
      {isTop && error && (
        <p role="alert" className="text-[12px] text-rose-700">
          {error}
        </p>
      )}
      {isTop && def.key === DDTEXT_KEY && confirm && (
        <DdtextConfirm
          turningOn={confirm.turningOn}
          retentionDays={view.settings.retentionDaysDdtext}
          checked={confirm.checked}
          pending={pending === def.key}
          onCheck={onConfirmCheck}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
      <p aria-live="polite" role="status" className={cn("text-[12px]", mine?.tone === "error" ? "text-rose-700" : "text-emerald-700")}>
        {mine?.text ?? ""}
      </p>
    </div>
  );
}

export function SettingsForm({
  view: initialView,
  initialConfirm = null
}: {
  view: SettingsView;
  /** Opens the DD text confirmation on first render (static renders: tests and screenshots). The page never passes it. */
  initialConfirm?: "on" | "off" | null;
}) {
  const isTop = useIsTopWindow();
  const [view, setView] = useState<SettingsView>(initialView);
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [pending, setPending] = useState<FieldKey | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [confirm, setConfirm] = useState<Confirm>(initialConfirm ? { turningOn: initialConfirm === "on", checked: false } : null);

  async function save(def: SettingsFieldDef, value: boolean | number, confirmNotice?: "ddtext_notice") {
    if (pending !== null) return;
    const check = validateSettingsField(def, value);
    if (!check.ok) {
      setErrors((e) => ({ ...e, [def.key]: sentence(check.detail) }));
      return;
    }
    setErrors((e) => ({ ...e, [def.key]: undefined }));
    setPending(def.key);
    setStatus(null);
    const result = await patchSettings({ patch: { [def.key]: value } as SettingsPatch, expectedVersion: view.version, confirm: confirmNotice });
    setPending(null);
    if (result.kind === "saved") {
      setView(result.view);
      setDrafts((d) => ({ ...d, [def.key]: undefined }));
      setConfirm(null);
      setStatus({ field: def.key, tone: "ok", text: result.message });
      return;
    }
    if (result.kind === "conflict") {
      if (result.view) setView(result.view);
      setDrafts({});
      setConfirm(null);
      setStatus({ field: def.key, tone: "error", text: result.message });
      return;
    }
    setStatus({ field: def.key, tone: "error", text: result.message });
  }

  return (
    <div data-settings-form className="min-w-0">
      {!isTop && (
        <p data-framed-note className="mb-1 rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-muted">
          {SETTINGS_COPY.framed}
        </p>
      )}
      {GROUPS.map((group) => {
        const fields = SETTINGS_FIELDS.filter(group.test);
        if (fields.length === 0) return null;
        return (
          <section key={group.title} className="border-b border-slate-100 last:border-b-0">
            <h3 className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.title}</h3>
            <div className="divide-y divide-slate-100">
              {fields.map((def) => (
                <FieldRow
                  key={def.key}
                  def={def}
                  view={view}
                  isTop={isTop}
                  pending={pending}
                  status={status}
                  draft={drafts[def.key]}
                  error={errors[def.key]}
                  confirm={def.key === DDTEXT_KEY ? confirm : null}
                  onToggle={() => {
                    const on = valueOf(view, def.key) === true;
                    if (def.key === DDTEXT_KEY) setConfirm({ turningOn: !on, checked: false });
                    else void save(def, !on);
                  }}
                  onDraft={(v) => setDrafts((d) => ({ ...d, [def.key]: v }))}
                  onSave={() => {
                    const raw = (drafts[def.key] ?? "").trim();
                    void save(def, raw === "" ? Number.NaN : Number(raw));
                  }}
                  onConfirmCheck={(checked) => setConfirm((c) => (c ? { ...c, checked } : c))}
                  onConfirm={() => {
                    if (!confirm) return;
                    void save(def, confirm.turningOn, confirm.turningOn ? "ddtext_notice" : undefined);
                  }}
                  onCancel={() => setConfirm(null)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
