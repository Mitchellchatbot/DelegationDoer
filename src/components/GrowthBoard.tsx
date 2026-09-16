"use client";

import { useState } from "react";
import { RefreshCw, Target, ShieldAlert, Rocket, ChevronDown } from "lucide-react";
import { SCALE_SOURCE_LABELS, staleBriefSources, type ScaleSourceFlags } from "@/lib/scale-sources-types";

// The CEO screen: the soul question + #1 growth constraint up top, then two
// columns — PROTECT (defend the business) and GROW (Scale Opportunities).

export interface GrowthConstraint { title: string; why: string; evidence: string; impact: string; solution: string; owner: string; }
export interface ProtectItem { type: string; title: string; detail: string; severity: "high" | "medium"; source?: string; }
export interface GrowItem { type: string; title: string; detail: string; estValue?: string; action: string; owner?: string; confidence?: "high" | "medium" | "low"; source?: string; }
export interface GrowthBrief { constraint: GrowthConstraint | null; protect: ProtectItem[]; grow: GrowItem[]; generatedAt: string; sources?: ScaleSourceFlags; }

const PROTECT_ICON: Record<string, string> = {
  "clients-at-risk": "🔥", performance: "⚠️", "missed-commitment": "⏰", bottleneck: "🚧", "margin-leak": "💰", capacity: "👥"
};
const GROW_ICON: Record<string, string> = {
  expansion: "📈", upsell: "💵", "sales-push": "🎯", "replicate-win": "🔁", automation: "🤖", delegation: "👤", hiring: "🧑‍💼", experiment: "💡"
};

export function GrowthBoard({ initial, currentSources }: { initial: GrowthBrief | null; currentSources?: ScaleSourceFlags }) {
  const [brief, setBrief] = useState<GrowthBrief | null>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Sources this brief was built from that are switched off now. Only a
  // notice — regenerating costs a model call, so it's the owner's click.
  const stale = brief && currentSources ? staleBriefSources(brief.sources, currentSources) : [];

  // A failed run used to vanish: the route's { error } was ignored and a
  // non-JSON reply (proxy timeout page, 504) threw inside the click handler,
  // so the spinner just stopped and the old brief sat there looking fresh.
  // Now any failure leaves a visible line; the next good run clears it.
  // Generation runs in the background now (1-3 min), so kick it off then poll
  // the latest brief until its timestamp advances. No more blocking POST / 502.
  async function generate() {
    setLoading(true);
    setError(null);
    const before = brief?.generatedAt ?? "";
    try {
      const res = await fetch("/api/brain/growth", { method: "POST" });
      const j: { error?: string } | null = await res.json().catch(() => null);
      if (!res.ok) {
        setError(j?.error || `Couldn't start the brief (HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      const started = Date.now();
      while (Date.now() - started < 240_000) {
        await new Promise((r) => setTimeout(r, 7000));
        const g: { brief?: GrowthBrief | null; generating?: boolean; error?: string } | null =
          await fetch("/api/brain/growth").then((r) => r.json()).catch(() => null);
        if (g?.brief?.generatedAt && g.brief.generatedAt !== before) {
          setBrief(g.brief);
          setError(null);
          setLoading(false);
          return;
        }
        if (g && g.generating === false && g.error) {
          setError(g.error);
          setLoading(false);
          return;
        }
      }
      setError("Still working — give it another moment, then refresh.");
      setLoading(false);
    } catch (err) {
      setError(`Couldn't generate the brief (${err instanceof Error ? err.message : "network error"})`);
      setLoading(false);
    }
  }

  const c = brief?.constraint ?? null;

  // Items collapse to a one-liner; click to expand the detail. Keyed by
  // section+index so Protect and Grow don't collide.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  // Whole-section dropdowns — collapsed by default so the board stays compact.
  const [showProtect, setShowProtect] = useState(false);
  const [showGrow, setShowGrow] = useState(false);

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
        {error && !loading && (
          <div role="alert" className="mt-2 rounded-lg bg-rose-100 text-rose-900 px-3 py-2 text-[12px]">
            {error}{brief ? " — the brief below is from the last successful run." : ""}
          </div>
        )}
        {stale.length > 0 && !loading && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-amber-100 text-amber-900 px-3 py-2 text-[12px]">
            <span>
              This brief {brief?.sources ? "used" : "may have used"} {stale.map((k) => SCALE_SOURCE_LABELS[k]).join(" and ")}, now switched off.
            </span>
            <button
              type="button"
              onClick={generate}
              className="font-semibold underline underline-offset-2 hover:text-amber-700"
            >
              Regenerate
            </button>
          </div>
        )}
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
            <button type="button" onClick={() => setShowProtect((v) => !v)} className="w-full flex items-center gap-1.5 text-[13px] font-semibold text-rose-700">
              <ShieldAlert className="w-4 h-4" /> Protect
              <span className="text-[11px] font-normal text-muted">({brief.protect.length})</span>
              <ChevronDown className={"w-4 h-4 ml-auto transition-transform " + (showProtect ? "rotate-180" : "")} />
            </button>
            <div className={"space-y-1 " + (showProtect ? "mt-3" : "hidden")}>
              {brief.protect.length === 0 && <div className="text-[12px] text-muted">Nothing flagged.</div>}
              {brief.protect.map((p, i) => {
                const k = `p${i}`; const isOpen = !!open[k];
                return (
                  <div key={k} className="border-b border-slate-100 last:border-0">
                    <button type="button" onClick={() => toggle(k)} className="w-full text-left flex items-start gap-2 py-2 hover:bg-slate-50 rounded-lg transition-colors">
                      <span className="text-[15px] leading-none mt-0.5">{PROTECT_ICON[p.type] ?? "⚠️"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-ink flex items-center gap-1.5">
                          <span className="flex-1">{p.title}</span>
                          {p.severity === "high" && <span className="text-[9px] uppercase tracking-wide text-rose-600 bg-rose-100 rounded px-1 py-0.5 shrink-0">high</span>}
                          <ChevronDown className={"w-3.5 h-3.5 text-muted shrink-0 transition-transform " + (isOpen ? "rotate-180" : "")} />
                        </div>
                        {p.source && <div className="text-[10px] text-slate-400 mt-0.5">from {p.source}</div>}
                      </div>
                    </button>
                    {isOpen && <div className="pl-7 pb-2.5 text-[12px] text-muted">{p.detail}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* GROW */}
          <div className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-soft">
            <button type="button" onClick={() => setShowGrow((v) => !v)} className="w-full flex items-center gap-1.5 text-[13px] font-semibold text-emerald-700">
              <Rocket className="w-4 h-4" /> Grow · Scale Opportunities
              <span className="text-[11px] font-normal text-muted">({brief.grow.length})</span>
              <ChevronDown className={"w-4 h-4 ml-auto transition-transform " + (showGrow ? "rotate-180" : "")} />
            </button>
            <div className={"space-y-1 " + (showGrow ? "mt-3" : "hidden")}>
              {brief.grow.length === 0 && <div className="text-[12px] text-muted">Nothing surfaced.</div>}
              {brief.grow.map((g, i) => {
                const k = `g${i}`; const isOpen = !!open[k];
                return (
                  <div key={k} className="border-b border-slate-100 last:border-0">
                    <button type="button" onClick={() => toggle(k)} className="w-full text-left flex items-start gap-2 py-2 hover:bg-slate-50 rounded-lg transition-colors">
                      <span className="text-[15px] leading-none mt-0.5">{GROW_ICON[g.type] ?? "🚀"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-ink flex items-center gap-1.5 flex-wrap">
                          <span className="flex-1 min-w-0">{g.title}</span>
                          {g.estValue && <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 rounded px-1.5 py-0.5 shrink-0">{g.estValue}</span>}
                          <ChevronDown className={"w-3.5 h-3.5 text-muted shrink-0 transition-transform " + (isOpen ? "rotate-180" : "")} />
                        </div>
                        {g.source && <div className="text-[10px] text-slate-400 mt-0.5">from {g.source}</div>}
                      </div>
                    </button>
                    {isOpen && (
                      <div className="pl-7 pb-2.5">
                        <div className="text-[12px] text-muted">{g.detail}</div>
                        <div className="text-[12px] text-emerald-800 mt-1">→ {g.action}</div>
                        <div className="text-[10px] text-muted mt-0.5">
                          {g.owner ? `Owner: ${g.owner}` : ""}{g.owner && g.confidence ? " · " : ""}{g.confidence ? `Confidence: ${g.confidence}` : ""}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {brief?.generatedAt && <div className="text-[10px] text-muted">Generated {new Date(brief.generatedAt).toLocaleString()}</div>}
    </div>
  );
}
