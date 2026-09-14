"use client";

import { useState } from "react";
import { Sparkles, RefreshCw } from "lucide-react";

// Compact, reusable "Moves to scale" panel — the brain's current strategic
// recommendations. Used in the Scale Room and the Inbox cockpit so "what to do
// to scale" sits next to what needs answering.

export interface Move { title: string; why: string; priority: "high" | "medium"; }

export function MovesPanel({
  initialMoves,
  initialHeadline,
  initialGeneratedAt
}: {
  initialMoves: Move[];
  initialHeadline: string | null;
  initialGeneratedAt: string | null;
}) {
  const [moves, setMoves] = useState(initialMoves);
  const [headline, setHeadline] = useState(initialHeadline);
  const [generatedAt, setGeneratedAt] = useState(initialGeneratedAt);
  const [generating, setGenerating] = useState(false);

  async function generate() {
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

  return (
    <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50/60 to-white p-4 shadow-soft">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="text-[13px] font-semibold text-ink flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-indigo-500" /> What to do to scale
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="flex items-center gap-1.5 text-[12px] font-medium text-white bg-indigo-600 rounded-lg px-3 py-1.5 hover:bg-indigo-700 disabled:opacity-60"
        >
          <RefreshCw className={"w-3.5 h-3.5 " + (generating ? "animate-spin" : "")} />
          {generating ? "Thinking…" : moves.length ? "Refresh" : "Ask the brain"}
        </button>
      </div>
      {headline && <div className="text-[13px] font-medium text-indigo-900 mb-3">{headline}</div>}
      {moves.length === 0 ? (
        <div className="text-[12px] text-muted py-1">
          Click “Ask the brain” — it reads your MRR, costs, clients, work, and priorities, then tells you the highest-leverage moves right now.
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
  );
}
