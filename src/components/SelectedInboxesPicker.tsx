"use client";

import { useState } from "react";
import { Mail, Plus, X, ListChecks } from "lucide-react";

export interface PickerInbox {
  id: string;
  email: string;
  display_name: string | null;
}

// Cherry-pick UI for the Smart → "Selected inboxes" view. Shows the chosen
// inboxes as removable chips plus an "Add inbox" popover listing the rest of
// the inboxes the user can see. Stateless: it reports the next id array up via
// onChange; the parent owns persistence + the live thread scope. Visual idiom
// mirrors SpacesManager's account chips / add-popover.
export function SelectedInboxesPicker({
  candidates, selected, onChange
}: {
  candidates: PickerInbox[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const byId = new Map(candidates.map((a) => [a.id, a]));
  const selectedSet = new Set(selected);
  const unselected = candidates.filter((a) => !selectedSet.has(a.id));

  function add(id: string) {
    if (selectedSet.has(id)) return;
    onChange([...selected, id]);
  }
  function remove(id: string) {
    onChange(selected.filter((x) => x !== id));
  }

  return (
    <div className="rounded-xl border border-slate-200/70 bg-white/70 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink/55 font-semibold">
          <ListChecks className="w-3.5 h-3.5" />
          Inboxes in this view ({selected.length}{candidates.length ? ` / ${candidates.length}` : ""})
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          {candidates.length > 0 && selected.length < candidates.length && (
            <button
              type="button"
              onClick={() => onChange(candidates.map((a) => a.id))}
              className="text-accent hover:text-accent/80 font-medium"
            >
              Select all
            </button>
          )}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-ink/55 hover:text-rose-600 font-medium"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {selected.map((id) => {
          const a = byId.get(id);
          if (!a) return null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => remove(id)}
              title="Remove from this view"
              className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full text-[11px] font-medium border bg-indigo-50 text-indigo-800 border-indigo-200/70 hover:bg-indigo-100 transition-colors"
            >
              <Mail className="w-3 h-3 opacity-70" />
              <span className="truncate max-w-[160px]">{a.display_name || a.email}</span>
              <X className="w-2.5 h-2.5 opacity-60" />
            </button>
          );
        })}
        {candidates.length === 0 ? (
          <span className="text-[11px] text-ink/45 italic">No inboxes you can see yet.</span>
        ) : (
          <button
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed border-slate-300 text-ink/55 hover:text-accent hover:border-accent/50 transition-colors"
          >
            <Plus className="w-3 h-3" /> Add inbox
          </button>
        )}
      </div>

      {showPicker && candidates.length > 0 && (
        <div className="mt-1 rounded-xl border border-slate-200 bg-white p-2 grid grid-cols-1 sm:grid-cols-2 gap-1 shadow-sm">
          {unselected.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => add(a.id)}
              className="text-left px-2.5 py-2 rounded-lg text-[13px] hover:bg-slate-50 transition-colors flex items-center gap-2"
            >
              <Mail className="w-3.5 h-3.5 text-ink/45 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-ink truncate">{a.display_name || a.email}</div>
                {a.display_name && a.display_name !== a.email && (
                  <div className="text-[11px] text-ink/55 truncate">{a.email}</div>
                )}
              </div>
            </button>
          ))}
          {unselected.length === 0 && (
            <div className="text-[11px] text-ink/45 italic px-2 py-1 col-span-full">
              Every inbox you can see is already in this view.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
