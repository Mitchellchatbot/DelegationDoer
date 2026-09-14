"use client";

import { useState } from "react";
import { Plus, X, Sparkles, Target, RefreshCw } from "lucide-react";

// Owner-only "Scale Room": Mitchell + the brain working the growth problem
// together. Shows the numbers that matter, the priorities/decisions the brain
// optimizes for (editable), and the brain's live recommended moves.

export interface ScaleMemory { id: string; content: string; category: "priority" | "decision" | "fact" | "preference"; }
export interface ScaleMove { title: string; why: string; priority: "high" | "medium"; }
export interface ScaleSnapshot { mrr: number; netNew: number | null; margin: number | null; top3Share: number; burn: number | null; }

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

const CATS: ScaleMemory["category"][] = ["priority", "decision", "fact", "preference"];
const CAT_STYLE: Record<ScaleMemory["category"], string> = {
  priority: "bg-indigo-100 text-indigo-700",
  decision: "bg-emerald-100 text-emerald-700",
  fact: "bg-slate-200 text-slate-600",
  preference: "bg-amber-100 text-amber-700"
};

export function ScaleRoom({
  snapshot,
  initialMemories,
  initialMoves,
  initialHeadline,
  initialGeneratedAt
}: {
  snapshot: ScaleSnapshot;
  initialMemories: ScaleMemory[];
  initialMoves: ScaleMove[];
  initialHeadline: string | null;
  initialGeneratedAt: string | null;
}) {
  const [memories, setMemories] = useState(initialMemories);
  const [moves, setMoves] = useState(initialMoves);
  const [headline, setHeadline] = useState(initialHeadline);
  const [generatedAt, setGeneratedAt] = useState(initialGeneratedAt);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftCat, setDraftCat] = useState<ScaleMemory["category"]>("priority");

  async function addMemory() {
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
  async function removeMemory(id: string) {
    setMemories((m) => m.filter((x) => x.id !== id));
    await fetch(`/api/brain/memory/${id}`, { method: "DELETE" });
  }
  async function editMemory(id: string, content: string) {
    setMemories((m) => m.map((x) => (x.id === id ? { ...x, content } : x)));
    await fetch(`/api/brain/memory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
  }

  async function generateMoves() {
    setGenerating(true);
    try {
      const res = await fetch("/api/brain/moves", { method: "POST" });
      const j = await res.json();
      if (j.moves) {
        setMoves(j.moves);
        setHeadline(j.headline ?? null);
        setGeneratedAt(j.generatedAt ?? new Date().toISOString());
      }
    } finally {
      setGenerating(false);
    }
  }

  const stat = [
    { label: "MRR", value: money(snapshot.mrr), tone: "ink" },
    { label: "Net new · this mo", value: (snapshot.netNew ?? 0) >= 0 ? `+${money(snapshot.netNew)}` : money(snapshot.netNew), tone: (snapshot.netNew ?? 0) > 0 ? "emerald" : (snapshot.netNew ?? 0) < 0 ? "rose" : "ink" },
    { label: "Margin", value: snapshot.margin != null ? `${snapshot.margin}%` : "—", tone: "ink" },
    { label: "Top-3 concentration", value: `${snapshot.top3Share}%`, tone: snapshot.top3Share >= 50 ? "amber" : "ink" }
  ] as const;

  return (
    <div className="space-y-5">
      {/* Snapshot */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stat.map((c) => (
          <div key={c.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
            <div className="text-[11px] font-medium text-muted">{c.label}</div>
            <div className={"mt-1 text-2xl font-bold tabular-nums " + (c.tone === "emerald" ? "text-emerald-600" : c.tone === "rose" ? "text-rose-600" : c.tone === "amber" ? "text-amber-600" : "text-ink")}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      {/* Moves */}
      <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50/60 to-white p-4 shadow-soft">
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <div className="text-[13px] font-semibold text-ink flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-indigo-500" /> Moves to scale
          </div>
          <button
            type="button"
            onClick={generateMoves}
            disabled={generating}
            className="flex items-center gap-1.5 text-[12px] font-medium text-white bg-indigo-600 rounded-lg px-3 py-1.5 hover:bg-indigo-700 disabled:opacity-60"
          >
            <RefreshCw className={"w-3.5 h-3.5 " + (generating ? "animate-spin" : "")} />
            {generating ? "Thinking…" : moves.length ? "Refresh" : "Ask the brain"}
          </button>
        </div>
        {headline && <div className="text-[13px] font-medium text-indigo-900 mb-3">{headline}</div>}
        {moves.length === 0 ? (
          <div className="text-[12px] text-muted py-2">
            Click “Ask the brain” — it reads your MRR, costs, clients, work, and priorities, then tells you the highest-leverage moves to scale right now.
          </div>
        ) : (
          <ol className="space-y-2">
            {moves.map((mv, i) => (
              <li key={i} className="flex gap-2.5">
                <span className={"mt-0.5 shrink-0 w-5 h-5 rounded-full grid place-items-center text-[11px] font-bold " + (mv.priority === "high" ? "bg-indigo-600 text-white" : "bg-indigo-100 text-indigo-700")}>{i + 1}</span>
                <div>
                  <div className="text-[13px] font-medium text-ink">{mv.title}</div>
                  <div className="text-[12px] text-muted mt-0.5">{mv.why}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {generatedAt && <div className="mt-3 text-[10px] text-muted">Generated {new Date(generatedAt).toLocaleString()}</div>}
      </div>

      {/* Priorities & decisions (brain memory) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
        <div className="flex items-center gap-1.5 mb-1 text-[13px] font-semibold text-ink">
          <Target className="w-4 h-4 text-slate-400" /> What we're optimizing for
        </div>
        <div className="text-[11px] text-muted mb-3">The brain weighs every recommendation and daily brief toward these. Edit anytime.</div>

        <div className="space-y-1.5 mb-3">
          {memories.length === 0 && <div className="text-[12px] text-muted">Nothing yet. Add your first priority below.</div>}
          {memories.map((m) => (
            <div key={m.id} className="flex items-center gap-2 group">
              <span className={"text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 w-[72px] text-center " + CAT_STYLE[m.category]}>{m.category}</span>
              <input
                defaultValue={m.content}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== m.content && editMemory(m.id, e.target.value.trim())}
                className="flex-1 bg-transparent text-[13px] text-ink rounded px-1.5 py-1 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none"
              />
              <button type="button" onClick={() => removeMemory(m.id)} className="text-slate-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
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
            onKeyDown={(e) => e.key === "Enter" && addMemory()}
            placeholder="Add a priority, decision, or fact the brain should always know…"
            className="flex-1 text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-indigo-300"
          />
          <button type="button" onClick={addMemory} className="flex items-center gap-1 text-[12px] font-medium text-white bg-ink rounded-lg px-2.5 py-1.5 hover:opacity-90 shrink-0">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
