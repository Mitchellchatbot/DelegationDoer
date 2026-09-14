"use client";

import { useState } from "react";
import { Plus, X, Target } from "lucide-react";

// "What we're optimizing for" — the brain's memory (priorities/decisions/facts),
// editable inline. These weight every recommendation and the daily brief.

export interface ScaleMemory { id: string; content: string; category: "priority" | "decision" | "fact" | "preference"; }

const CATS: ScaleMemory["category"][] = ["priority", "decision", "fact", "preference"];
const CAT_STYLE: Record<ScaleMemory["category"], string> = {
  priority: "bg-indigo-100 text-indigo-700",
  decision: "bg-emerald-100 text-emerald-700",
  fact: "bg-slate-200 text-slate-600",
  preference: "bg-amber-100 text-amber-700"
};

export function MemoryEditor({ initial }: { initial: ScaleMemory[] }) {
  const [memories, setMemories] = useState(initial);
  const [draft, setDraft] = useState("");
  const [draftCat, setDraftCat] = useState<ScaleMemory["category"]>("priority");

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    const res = await fetch("/api/brain/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, category: draftCat })
    });
    const j = await res.json();
    if (j.memory) setMemories((m) => [...m, j.memory]);
  }
  async function remove(id: string) {
    setMemories((m) => m.filter((x) => x.id !== id));
    await fetch(`/api/brain/memory/${id}`, { method: "DELETE" });
  }
  async function edit(id: string, content: string) {
    setMemories((m) => m.map((x) => (x.id === id ? { ...x, content } : x)));
    await fetch(`/api/brain/memory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-center gap-1.5 mb-1 text-[13px] font-semibold text-ink">
        <Target className="w-4 h-4 text-slate-400" /> What we&apos;re optimizing for
      </div>
      <div className="text-[11px] text-muted mb-3">The brain weighs every recommendation, draft, and daily brief toward these. Edit anytime.</div>

      <div className="space-y-1.5 mb-3">
        {memories.length === 0 && <div className="text-[12px] text-muted">Nothing yet. Add your first priority below.</div>}
        {memories.map((m) => (
          <div key={m.id} className="flex items-center gap-2 group">
            <span className={"text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 w-[72px] text-center " + CAT_STYLE[m.category]}>{m.category}</span>
            <input
              defaultValue={m.content}
              onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== m.content && edit(m.id, e.target.value.trim())}
              className="flex-1 bg-transparent text-[13px] text-ink rounded px-1.5 py-1 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none"
            />
            <button type="button" onClick={() => remove(m.id)} className="text-slate-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
        <select
          value={draftCat}
          onChange={(e) => setDraftCat(e.target.value as ScaleMemory["category"])}
          className="text-[11px] font-medium rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-ink focus:outline-none"
        >
          {CATS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a priority, decision, or fact the brain should always know…"
          className="flex-1 text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-indigo-300"
        />
        <button type="button" onClick={add} className="flex items-center gap-1 text-[12px] font-medium text-white bg-ink rounded-lg px-2.5 py-1.5 hover:opacity-90 shrink-0">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>
    </div>
  );
}
