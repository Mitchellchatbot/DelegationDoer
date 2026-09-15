"use client";

import { useState } from "react";
import { RefreshCw, Target, ShieldAlert, Rocket } from "lucide-react";

// The CEO screen: the soul question + #1 growth constraint up top, then two
// columns — PROTECT (defend the business) and GROW (Scale Opportunities).

export interface GrowthConstraint { title: string; why: string; evidence: string; impact: string; solution: string; owner: string; }
export interface ProtectItem { type: string; title: string; detail: string; severity: "high" | "medium"; }
export interface GrowItem { type: string; title: string; detail: string; estValue?: string; action: string; owner?: string; confidence?: "high" | "medium" | "low"; }
export interface GrowthBrief { constraint: GrowthConstraint | null; protect: ProtectItem[]; grow: GrowItem[]; generatedAt: string; }

const PROTECT_ICON: Record<string, string> = {
  "clients-at-risk": "🔥", performance: "⚠️", "missed-commitment": "⏰", bottleneck: "🚧", "margin-leak": "💰", capacity: "👥"
};
const GROW_ICON: Record<string, string> = {
  expansion: "📈", upsell: "💵", "sales-push": "🎯", "replicate-win": "🔁", automation: "🤖", delegation: "👤", hiring: "🧑‍💼", experiment: "💡"
};

export function GrowthBoard({ initial }: { initial: GrowthBrief | null }) {
  const [brief, setBrief] = useState<GrowthBrief | null>(initial);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      const res = await fetch("/api/brain/growth", { method: "POST" });
      const j = await res.json();
      if (j.brief) setBrief(j.brief);
    } finally {
      setLoading(false);
    }
  }

  const c = brief?.constraint ?? null;

  return (
    <div className="space-y-4">
      {/* The soul question + #1 constraint */}
      <div className="rounded-2xl border border-indigo-300 bg-gradient-to-br from-indigo-600 to-indigo-800 text-white p-5 shadow-soft">
        <div className="flex items-start justify-between gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-200 flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5" /> What&apos;s stopping us from growing faster?
          </div>
          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="flex items-center gap-1.5 text-[12px] font-medium bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 disabled:opacity-60 shrink-0"
          >
            <RefreshCw className={"w-3.5 h-3.5 " + (loading ? "animate-spin" : "")} />
            {loading ? "Thinking…" : brief ? "Re-run" : "Ask the brain"}
          </button>
        </div>
        {c ? (
          <div className="mt-2">
            <div className="text-lg font-bold leading-snug">{c.title}</div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 mt-3 text-[12.5px] text-indigo-50">
              {c.why && <div><span className="text-indigo-300 font-medium">Why: </span>{c.why}</div>}
              {c.evidence && <div><span className="text-indigo-300 font-medium">Evidence: </span>{c.evidence}</div>}
              {c.impact && <div><span className="text-indigo-300 font-medium">Impact: </span>{c.impact}</div>}
              {c.solution && <div><span className="text-indigo-300 font-medium">Fix: </span>{c.solution}</div>}
            </div>
            {c.owner && <div className="mt-2 text-[11px] text-indigo-200">Owner: {c.owner}</div>}
          </div>
        ) : (
          <div className="mt-2 text-[13px] text-indigo-100">
            {loading ? "Reading the whole business…" : "Run the brain — it reads revenue, clients, costs, capacity, and wins, then names the one constraint holding growth back plus what to protect and where to grow."}
          </div>
        )}
      </div>

      {/* PROTECT / GROW columns */}
      {brief && (brief.protect.length > 0 || brief.grow.length > 0) && (
        <div className="grid md:grid-cols-2 gap-3">
          {/* PROTECT */}
          <div className="rounded-2xl border border-rose-200 bg-white p-4 shadow-soft">
            <div className="flex items-center gap-1.5 mb-3 text-[13px] font-semibold text-rose-700">
              <ShieldAlert className="w-4 h-4" /> Protect
            </div>
            <div className="space-y-2.5">
              {brief.protect.length === 0 && <div className="text-[12px] text-muted">Nothing flagged.</div>}
              {brief.protect.map((p, i) => (
                <div key={i} className="border-b border-slate-100 last:border-0 pb-2.5 last:pb-0">
                  <div className="flex items-start gap-2">
                    <span className="text-[15px] leading-none mt-0.5">{PROTECT_ICON[p.type] ?? "⚠️"}</span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-ink flex items-center gap-1.5">
                        {p.title}
                        {p.severity === "high" && <span className="text-[9px] uppercase tracking-wide text-rose-600 bg-rose-100 rounded px-1 py-0.5">high</span>}
                      </div>
                      <div className="text-[12px] text-muted mt-0.5">{p.detail}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* GROW */}
          <div className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-soft">
            <div className="flex items-center gap-1.5 mb-3 text-[13px] font-semibold text-emerald-700">
              <Rocket className="w-4 h-4" /> Grow · Scale Opportunities
            </div>
            <div className="space-y-2.5">
              {brief.grow.length === 0 && <div className="text-[12px] text-muted">Nothing surfaced.</div>}
              {brief.grow.map((g, i) => (
                <div key={i} className="border-b border-slate-100 last:border-0 pb-2.5 last:pb-0">
                  <div className="flex items-start gap-2">
                    <span className="text-[15px] leading-none mt-0.5">{GROW_ICON[g.type] ?? "🚀"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink flex items-center gap-1.5 flex-wrap">
                        {g.title}
                        {g.estValue && <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 rounded px-1.5 py-0.5">{g.estValue}</span>}
                      </div>
                      <div className="text-[12px] text-muted mt-0.5">{g.detail}</div>
                      <div className="text-[12px] text-emerald-800 mt-1">→ {g.action}</div>
                      <div className="text-[10px] text-muted mt-0.5">
                        {g.owner ? `Owner: ${g.owner}` : ""}{g.owner && g.confidence ? " · " : ""}{g.confidence ? `Confidence: ${g.confidence}` : ""}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {brief?.generatedAt && <div className="text-[10px] text-muted">Generated {new Date(brief.generatedAt).toLocaleString()}</div>}
    </div>
  );
}
