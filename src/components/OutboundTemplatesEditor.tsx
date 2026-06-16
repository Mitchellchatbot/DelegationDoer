"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save, Loader2, Check, AlertCircle, Code, Sparkles } from "lucide-react";
import {
  FLOW_DEFINITIONS, BUILT_IN_PLACEHOLDERS,
  type FlowStepDefinition
} from "@/lib/outbound-sms-templates";
import { cn } from "@/lib/utils";

// Editor surface for /outbound-dashboard/templates. Shows every step in
// every flow, each with a textarea bound to its body in
// outbound_message_templates. Clicking "Save" POSTs the new body to
// /api/outbound/templates and triggers a router.refresh() so the
// "edited X ago" timestamp updates.
//
// A "Variables" sidebar lists the always-available placeholders
// (BUILT_IN_PLACEHOLDERS) plus any dynamic Typeform refs surfaced from
// the most recent lead. Operators can click a chip to copy the
// placeholder into the focused editor.

export interface EditableTemplate {
  kind: string;
  sequenceIndex: number;
  body: string;
  updatedAt: string | null;
}

interface Props {
  initial: EditableTemplate[];
  // Dynamic Typeform refs seen on actual leads (sampled from the most
  // recent N typeform_answers maps). The page server-fetches these so
  // the editor knows what {ref} placeholders the form supplies.
  dynamicVars: string[];
}

export function OutboundTemplatesEditor({ initial, dynamicVars }: Props) {
  // Local state for every template, keyed by `${kind}#${idx}`. Edits
  // stay in memory until Save; the row's `dirty` flag drives button
  // enablement and the unsaved-changes indicator.
  const [edits, setEdits] = useState<Record<string, EditableTemplate & { dirty: boolean; saving: boolean; error: string | null; savedAt: number | null }>>(() => {
    const init: Record<string, EditableTemplate & { dirty: boolean; saving: boolean; error: string | null; savedAt: number | null }> = {};
    for (const t of initial) {
      init[`${t.kind}#${t.sequenceIndex}`] = { ...t, dirty: false, saving: false, error: null, savedAt: null };
    }
    return init;
  });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const router = useRouter();
  const [, startTransition] = useTransition();

  function update(key: string, body: string) {
    setEdits((prev) => ({
      ...prev,
      [key]: { ...prev[key], body, dirty: body !== initial.find((t) => `${t.kind}#${t.sequenceIndex}` === key)?.body, error: null }
    }));
  }

  async function save(key: string) {
    const row = edits[key];
    if (!row || !row.dirty || row.saving) return;
    setEdits((prev) => ({ ...prev, [key]: { ...prev[key], saving: true, error: null } }));
    try {
      const res = await fetch("/api/outbound/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: row.kind,
          sequenceIndex: row.sequenceIndex,
          body: row.body
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEdits((prev) => ({
          ...prev,
          [key]: { ...prev[key], saving: false, error: data?.error ?? `HTTP ${res.status}` }
        }));
        return;
      }
      setEdits((prev) => ({
        ...prev,
        [key]: { ...prev[key], saving: false, dirty: false, savedAt: Date.now() }
      }));
      startTransition(() => router.refresh());
    } catch (err) {
      setEdits((prev) => ({
        ...prev,
        [key]: { ...prev[key], saving: false, error: err instanceof Error ? err.message : String(err) }
      }));
    }
  }

  // Insert a {placeholder} at the cursor position of whichever textarea
  // is currently focused. If nothing's focused, append to the most
  // recently edited row.
  function insertVariable(varName: string) {
    if (!focusedKey) return;
    const key = focusedKey;
    const textarea = document.querySelector<HTMLTextAreaElement>(`textarea[data-tpl-key="${key}"]`);
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const placeholder = `{${varName}}`;
    const current = edits[key].body;
    const next = current.slice(0, start) + placeholder + current.slice(end);
    update(key, next);
    // Restore focus + selection just after the inserted placeholder.
    requestAnimationFrame(() => {
      textarea.focus();
      const caret = start + placeholder.length;
      textarea.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
      <div className="space-y-6">
        {FLOW_DEFINITIONS.map((flow) => (
          <section key={flow.key}>
            <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-accent">
              Flow · {flow.key}
            </div>
            <h2 className="text-[20px] font-semibold text-ink mt-1">{flow.label}</h2>
            <p className="text-[13px] text-ink/60 mt-0.5 max-w-2xl">{flow.description}</p>
            <div className="mt-3 space-y-3">
              {flow.steps.map((step) => {
                const key = `${step.kind}#${step.sequenceIndex}`;
                const row = edits[key];
                if (!row) return null;
                return (
                  <StepEditor
                    key={key}
                    step={step}
                    row={row}
                    onChange={(v) => update(key, v)}
                    onFocus={() => setFocusedKey(key)}
                    onSave={() => save(key)}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <VariablesPanel
        dynamic={dynamicVars}
        onPick={insertVariable}
        canInsert={focusedKey != null}
      />
    </div>
  );
}

function StepEditor({
  step, row, onChange, onFocus, onSave
}: {
  step: FlowStepDefinition;
  row: EditableTemplate & { dirty: boolean; saving: boolean; error: string | null; savedAt: number | null };
  onChange: (body: string) => void;
  onFocus: () => void;
  onSave: () => void;
}) {
  const justSaved = row.savedAt != null && Date.now() - row.savedAt < 4000;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.16em] font-semibold text-ink/55">
            Step {step.sequenceIndex}
          </div>
          <div className="text-[15px] font-semibold text-ink mt-0.5">{step.label}</div>
          <div className="text-[11px] text-ink/55 mt-0.5">{step.timing}</div>
        </div>
        <div className="flex items-center gap-2">
          {row.updatedAt && !row.dirty && !justSaved && (
            <span className="text-[11px] text-ink/45">
              edited {new Date(row.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          {justSaved && (
            <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700">
              <Check className="w-3.5 h-3.5" /> saved
            </span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!row.dirty || row.saving}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-semibold border transition-colors",
              row.dirty
                ? "bg-accent text-white border-accent hover:bg-accent/90"
                : "bg-slate-100 text-ink/40 border-slate-200 cursor-not-allowed"
            )}
          >
            {row.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {row.saving ? "Saving" : "Save"}
          </button>
        </div>
      </div>
      <div className="p-4">
        <textarea
          data-tpl-key={`${step.kind}#${step.sequenceIndex}`}
          value={row.body}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          rows={Math.max(3, row.body.split("\n").length)}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-[13.5px] text-ink leading-relaxed font-mono focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20 resize-y"
          spellCheck
        />
        {row.error && (
          <div className="mt-2 inline-flex items-start gap-1.5 text-[12px] text-rose-700">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{row.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function VariablesPanel({
  dynamic, onPick, canInsert
}: {
  dynamic: string[];
  onPick: (varName: string) => void;
  canInsert: boolean;
}) {
  return (
    <aside className="lg:sticky lg:top-3 lg:self-start space-y-3">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
            Variables
          </div>
          <h2 className="text-[15px] font-semibold text-ink mt-0.5">
            <Code className="w-4 h-4 inline-block mr-1.5 text-ink/55" />
            Click to insert
          </h2>
          <p className="text-[11.5px] text-ink/55 mt-1">
            {canInsert
              ? "Click a chip to drop the placeholder at your cursor."
              : "Click into a template editor first, then click a chip."}
          </p>
        </div>
        <div className="p-3">
          <div className="text-[10.5px] uppercase tracking-wide font-semibold text-ink/55 mb-1.5">
            Built-in
          </div>
          <div className="flex flex-wrap gap-1.5">
            {BUILT_IN_PLACEHOLDERS.map((v) => (
              <VarChip key={v} name={v} onClick={() => onPick(v)} disabled={!canInsert} tone="indigo" />
            ))}
          </div>
        </div>
        {dynamic.length > 0 && (
          <div className="px-3 pb-3">
            <div className="text-[10.5px] uppercase tracking-wide font-semibold text-ink/55 mb-1.5 mt-2 inline-flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> From Typeform
            </div>
            <div className="flex flex-wrap gap-1.5">
              {dynamic.map((v) => (
                <VarChip key={v} name={v} onClick={() => onPick(v)} disabled={!canInsert} tone="fuchsia" />
              ))}
            </div>
            <p className="text-[11px] text-ink/45 mt-2">
              Sourced from recent Typeform submissions. Set a <code className="bg-slate-100 px-1 rounded">ref</code> on each question in Typeform → Logic panel → that ref becomes the variable name here.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}

function VarChip({
  name, onClick, disabled, tone
}: {
  name: string;
  onClick: () => void;
  disabled: boolean;
  tone: "indigo" | "fuchsia";
}) {
  const cls = tone === "indigo"
    ? "bg-indigo-50 text-indigo-700 border-indigo-200/60 hover:bg-indigo-100"
    : "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/60 hover:bg-fuchsia-100";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center px-2 py-1 rounded-md border text-[11.5px] font-mono transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        cls
      )}
      title={`Insert {${name}}`}
    >
      {`{${name}}`}
    </button>
  );
}
