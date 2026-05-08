"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Pencil, X, Check, GripVertical } from "lucide-react";
import { toast } from "sonner";
import type { CustomField, CustomFieldOption, CustomFieldType } from "@/lib/types";

const TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  number: "Number",
  url: "URL",
  date: "Date",
  checkbox: "Checkbox",
  select: "Select (single)",
  multiselect: "Multi-select"
};

// Settings → Custom task fields. Manager-only (CEO + dept_head; the API
// enforces this server-side, the UI just hides the controls for workers).
export function CustomFieldsSection({ canManage }: { canManage: boolean }) {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/custom-fields", { cache: "no-store" });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      const data = await res.json();
      setFields(data.fields ?? []);
    } catch (e) {
      toast.error(`Couldn't load custom fields: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold inline-flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-accent" />
          Custom task fields
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn-primary text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            Add field
          </button>
        )}
      </div>

      <p className="text-xs text-ink/60 mb-3">
        Org-wide fields that show up on every task — like Notion properties.
        Add a field, pick its type, and it'll appear on the new-task popdown
        and on every task's detail page automatically.
      </p>

      {loading ? (
        <div className="text-xs text-muted">Loading…</div>
      ) : fields.length === 0 && !adding ? (
        <div className="text-xs text-muted italic py-4 text-center">
          No custom fields yet. {canManage ? "Click \"Add field\" to define one." : "Ask a manager to add one."}
        </div>
      ) : (
        <ul className="space-y-2">
          {fields.map((f) => (
            <FieldRow key={f.id} field={f} canManage={canManage} onChanged={load} />
          ))}
        </ul>
      )}

      {adding && canManage && (
        <FieldEditor
          mode="create"
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); }}
        />
      )}
    </section>
  );
}

/* ============================ ROW ============================ */

function FieldRow({
  field, canManage, onChanged
}: {
  field: CustomField;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);

  async function del() {
    if (!confirm(`Delete custom field "${field.name}"? Existing values on tasks will become inaccessible.`)) return;
    try {
      const res = await fetch(`/api/custom-fields/${field.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      toast.success(`Deleted "${field.name}"`);
      onChanged();
    } catch (e) {
      toast.error(`Delete failed: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  if (editing && canManage) {
    return (
      <FieldEditor
        mode="edit"
        existing={field}
        onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); onChanged(); }}
      />
    );
  }

  return (
    <li className="flex items-center gap-3 rounded-xl border border-slate-200/70 bg-slate-50/40 px-3 py-2">
      <GripVertical className="w-3.5 h-3.5 text-muted/60 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{field.name}</div>
        <div className="text-[11px] text-muted">
          {TYPE_LABELS[field.type]}
          {field.options && field.options.length > 0 && (
            <> · {field.options.length} option{field.options.length === 1 ? "" : "s"}</>
          )}
        </div>
      </div>
      {canManage && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-surface2"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={del}
            className="w-7 h-7 grid place-items-center rounded-lg text-urgent hover:bg-urgent/10"
            title="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}

/* ============================ EDITOR ============================ */

function FieldEditor({
  mode, existing, onClose, onSaved
}: {
  mode: "create" | "edit";
  existing?: CustomField;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [type, setType] = useState<CustomFieldType>(existing?.type ?? "text");
  const [options, setOptions] = useState<CustomFieldOption[]>(existing?.options ?? []);
  const [optionDraft, setOptionDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const needsOptions = type === "select" || type === "multiselect";

  async function save() {
    if (saving) return;
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (needsOptions && options.length === 0) {
      toast.error("Add at least one option.");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        type,
        options: needsOptions ? options : null
      };
      const res = await fetch(
        mode === "create" ? "/api/custom-fields" : `/api/custom-fields/${existing!.id}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          // Type isn't editable in PATCH (see API), so omit it on edit.
          body: JSON.stringify(mode === "create" ? body : { name: body.name, options: body.options })
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      toast.success(mode === "create" ? "Field added." : "Field updated.");
      onSaved();
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSaving(false);
    }
  }

  function addOption() {
    const v = optionDraft.trim();
    if (!v) return;
    if (options.some((o) => o.value === v)) {
      toast.error("Option already exists.");
      return;
    }
    setOptions((cur) => [...cur, { value: v, label: v }]);
    setOptionDraft("");
  }

  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-white/85 backdrop-blur-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">
          {mode === "create" ? "New custom field" : `Edit "${existing?.name}"`}
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 grid place-items-center rounded-lg text-muted hover:text-ink hover:bg-surface2"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hosting tier"
          />
        </div>
        <div>
          <label className="label">Type</label>
          <select
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value as CustomFieldType)}
            disabled={mode === "edit"}
          >
            {Object.entries(TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          {mode === "edit" && (
            <div className="text-[10px] text-muted mt-1">
              Type can't change after creation.
            </div>
          )}
        </div>
      </div>

      {needsOptions && (
        <div>
          <label className="label">Options</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {options.map((o) => (
              <span
                key={o.value}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/10 text-accent text-xs border border-accent/30"
              >
                {o.label}
                <button
                  type="button"
                  onClick={() => setOptions((cur) => cur.filter((x) => x.value !== o.value))}
                  className="hover:text-urgent"
                  title="Remove"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              value={optionDraft}
              onChange={(e) => setOptionDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); addOption(); }
              }}
              placeholder="Type an option and press Enter"
            />
            <button
              type="button"
              onClick={addOption}
              className="btn"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} disabled={saving} className="btn">Cancel</button>
        <button onClick={save} disabled={saving} className="btn-primary">
          <Check className="w-3.5 h-3.5" />
          {saving ? "Saving…" : mode === "create" ? "Create field" : "Save"}
        </button>
      </div>
    </div>
  );
}
