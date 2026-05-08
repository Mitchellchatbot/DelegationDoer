"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Mail, FolderOpen, Server, Link as LinkIcon, KeyRound, MessageSquare,
  Pencil, Check, X
} from "lucide-react";
import { toast } from "sonner";
import type { CustomField, Task } from "@/lib/types";

// Inline-editable Notion-style field surface. Used in the task detail
// sidebar. Each field renders as a "label · value · pencil" row that
// flips to a tiny input on click. Submits via PATCH /api/tasks/[id]
// and refreshes the route so the server-rendered fields stay accurate.

const BUILTIN_FIELDS: {
  key: keyof Task;
  body: string;        // body key sent to the API
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  type: "text" | "email" | "url";
}[] = [
  { key: "clientEmail",       body: "clientEmail",       label: "Client email",   icon: Mail,         type: "email" },
  { key: "clientFolderUrl",   body: "clientFolderUrl",   label: "Client folder",  icon: FolderOpen,   type: "url" },
  { key: "stagingServer",     body: "stagingServer",     label: "Staging server", icon: Server,       type: "text" },
  { key: "markupLink",        body: "markupLink",        label: "Markup link",    icon: LinkIcon,     type: "url" },
  { key: "hostingAccess",     body: "hostingAccess",     label: "Hosting/access", icon: KeyRound,     type: "text" },
  { key: "missiveThreadUrl",  body: "missiveThreadUrl",  label: "Missive thread", icon: MessageSquare, type: "url" }
];

export function TaskFields({ task }: { task: Task }) {
  const router = useRouter();
  const [fields, setFields] = useState<CustomField[] | null>(null);

  // Lazy-load custom field definitions. Server-rendered detail page
  // doesn't pre-fetch them so we keep this component dropable into
  // any page without coupling.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/custom-fields", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { fields: [] }))
      .then((d) => { if (!cancelled) setFields(d.fields ?? []); })
      .catch(() => { if (!cancelled) setFields([]); });
    return () => { cancelled = true; };
  }, []);

  async function patchTask(body: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      router.refresh();
      return true;
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : "network error"}`);
      return false;
    }
  }

  return (
    <div className="space-y-3">
      <SectionLabel>Project links</SectionLabel>
      {BUILTIN_FIELDS.map((f) => {
        const Icon = f.icon;
        const value = (task[f.key] as string | null | undefined) ?? null;
        return (
          <BuiltinRow
            key={f.body}
            icon={<Icon className="w-3.5 h-3.5 text-accent/80" />}
            label={f.label}
            value={value}
            type={f.type}
            onSave={(v) => patchTask({ [f.body]: v })}
          />
        );
      })}

      {fields && fields.length > 0 && (
        <>
          <SectionLabel>Custom</SectionLabel>
          {fields.map((field) => (
            <CustomRow
              key={field.id}
              field={field}
              value={(task.custom ?? {})[field.id]}
              onSave={(v) =>
                patchTask({
                  custom: { [field.id]: v === undefined ? null : v }
                })
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-muted/80 font-semibold mt-3 first:mt-0">
      {children}
    </div>
  );
}

/* ============================ BUILTIN ROW ============================ */

function BuiltinRow({
  icon, label, value, type, onSave
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  type: "text" | "email" | "url";
  onSave: (v: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  // Resync draft when the server-rendered value changes (e.g. router.refresh()).
  useEffect(() => { setDraft(value ?? ""); }, [value]);

  async function commit() {
    if (saving) return;
    const next = draft.trim();
    const same = (next || null) === (value ?? null);
    if (same) { setEditing(false); return; }
    setSaving(true);
    const ok = await onSave(next || null);
    setSaving(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted/80 inline-flex items-center gap-1">
          {icon} {label}
        </div>
        <div className="flex items-center gap-1">
          <input
            autoFocus
            type={type}
            className="input py-1 text-sm flex-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(value ?? ""); setEditing(false); }
            }}
            disabled={saving}
          />
          <button
            type="button"
            onClick={commit}
            disabled={saving}
            title="Save"
            className="w-7 h-7 grid place-items-center rounded-lg text-accent hover:bg-accent/10"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { setDraft(value ?? ""); setEditing(false); }}
            disabled={saving}
            title="Cancel"
            className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:bg-surface2"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const isLink = type === "url" && value && /^https?:\/\//i.test(value);
  return (
    <div className="group flex items-center gap-2">
      <div className="text-[10px] uppercase tracking-wide text-muted/80 w-28 shrink-0 inline-flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-sm flex-1 min-w-0 truncate">
        {value ? (
          isLink ? (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {value}
            </a>
          ) : type === "email" ? (
            <a href={`mailto:${value}`} className="text-accent hover:underline">{value}</a>
          ) : (
            value
          )
        ) : (
          <span className="text-muted/70 italic">empty</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-surface2"
        title="Edit"
      >
        <Pencil className="w-3 h-3" />
      </button>
    </div>
  );
}

/* ============================ CUSTOM ROW ============================ */

function CustomRow({
  field, value, onSave
}: {
  field: CustomField;
  value: unknown;
  onSave: (v: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<unknown>(value);

  useEffect(() => { setDraft(value); }, [value]);

  async function commit(next: unknown) {
    if (saving) return;
    setSaving(true);
    const ok = await onSave(next);
    setSaving(false);
    if (ok) setEditing(false);
  }

  // Checkbox: no edit-mode, click-to-toggle.
  if (field.type === "checkbox") {
    const checked = Boolean(value);
    return (
      <div className="flex items-center gap-2">
        <div className="text-[10px] uppercase tracking-wide text-muted/80 w-28 shrink-0">
          {field.name}
        </div>
        <input
          type="checkbox"
          checked={checked}
          disabled={saving}
          onChange={(e) => commit(e.target.checked)}
          className="w-4 h-4 accent-accent"
        />
      </div>
    );
  }

  if (editing) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted/80">{field.name}</div>
        <CustomInput
          field={field}
          draft={draft}
          onChange={setDraft}
          autoFocus
        />
        <div className="flex justify-end gap-1">
          <button
            onClick={() => commit(draft)}
            disabled={saving}
            className="text-[11px] px-2 py-0.5 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={() => { setDraft(value); setEditing(false); }}
            disabled={saving}
            className="text-[11px] px-2 py-0.5 rounded-md text-muted hover:bg-surface2"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <div className="text-[10px] uppercase tracking-wide text-muted/80 w-28 shrink-0">
        {field.name}
      </div>
      <div className="text-sm flex-1 min-w-0 truncate">
        {renderCustomDisplay(field, value)}
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-surface2"
        title="Edit"
      >
        <Pencil className="w-3 h-3" />
      </button>
    </div>
  );
}

function renderCustomDisplay(field: CustomField, value: unknown) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted/70 italic">empty</span>;
  }
  if (field.type === "url" && typeof value === "string" && /^https?:\/\//i.test(value)) {
    return <a href={value} target="_blank" rel="noreferrer" className="text-accent hover:underline">{value}</a>;
  }
  if (field.type === "select" && typeof value === "string") {
    const opt = field.options?.find((o) => o.value === value);
    const label = opt?.label ?? value;
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
        style={{
          background: opt?.color ? `${opt.color}22` : "rgba(30,99,255,0.1)",
          color: opt?.color ?? "rgb(30,99,255)"
        }}
      >
        {label}
      </span>
    );
  }
  if (field.type === "multiselect" && Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {(value as string[]).map((v) => {
          const opt = field.options?.find((o) => o.value === v);
          return (
            <span
              key={v}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
              style={{
                background: opt?.color ? `${opt.color}22` : "rgba(30,99,255,0.1)",
                color: opt?.color ?? "rgb(30,99,255)"
              }}
            >
              {opt?.label ?? v}
            </span>
          );
        })}
      </span>
    );
  }
  if (field.type === "date" && typeof value === "string") {
    return new Date(value).toLocaleDateString();
  }
  return String(value);
}

function CustomInput({
  field, draft, onChange, autoFocus
}: {
  field: CustomField;
  draft: unknown;
  onChange: (v: unknown) => void;
  autoFocus?: boolean;
}) {
  switch (field.type) {
    case "text":
    case "url":
      return (
        <input
          type={field.type === "url" ? "url" : "text"}
          autoFocus={autoFocus}
          className="input py-1 text-sm w-full"
          value={(draft as string) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "number":
      return (
        <input
          type="number"
          autoFocus={autoFocus}
          className="input py-1 text-sm w-full"
          value={(draft as number) ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <input
          type="date"
          autoFocus={autoFocus}
          className="input py-1 text-sm w-full"
          value={(draft as string) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "select":
      return (
        <select
          autoFocus={autoFocus}
          className="input py-1 text-sm w-full"
          value={(draft as string) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">— none —</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case "multiselect": {
      const arr = Array.isArray(draft) ? (draft as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options?.map((o) => {
            const on = arr.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() =>
                  onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])
                }
                className={
                  "text-[11px] px-2 py-0.5 rounded-full border transition-colors " +
                  (on
                    ? "bg-accent text-white border-accent"
                    : "bg-white border-border text-ink hover:border-accent/40")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "checkbox":
      return null;
  }
}
