"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { RevenueSummary } from "@/lib/stripe";
import { AddToMrr } from "@/components/AddToMrr";

// Compact companion to the manual MRR sheet: shows ONLY the Stripe-paying
// clients that aren't in the sheet yet, so Mitchell can input what he's missing
// with one click. No full Stripe dashboard — the manual sheet is the section.

const GENERIC = new Set([
  "recovery", "treatment", "center", "centers", "the", "llc", "inc", "wellness",
  "health", "behavioral", "detox", "addiction", "seo", "and", "for", "services",
  "service", "solutions", "group", "new", "jersey", "hosting", "pool", "pools"
]);
function keyTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !GENERIC.has(t)));
}
function inSheet(name: string, tokenSets: Set<string>[], norms: Set<string>): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norms.has(n)) return true;
  const toks = keyTokens(name);
  if (!toks.size) return false;
  for (const set of tokenSets) for (const t of toks) if (set.has(t)) return true;
  return false;
}
function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function StripeMissing({
  rev,
  sheetNames
}: {
  rev: RevenueSummary | null | undefined;
  sheetNames: string[];
}) {
  const [open, setOpen] = useState(false);
  if (!rev) return null;
  const tokenSets = sheetNames.map(keyTokens);
  const norms = new Set(sheetNames.map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const missing = rev.clients.filter((c) => !inSheet(c.name, tokenSets, norms));
  const missingMrr = missing.reduce((s, c) => s + c.mrr, 0);

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-0.5 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[13px] font-semibold text-ink flex items-center gap-2">
              In Stripe, not in your sheet
              <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-600 bg-indigo-100 rounded px-1.5 py-0.5">from Stripe</span>
            </div>
            <div className="text-[11px] text-muted mt-0.5">Missing from your MRR sheet · tap to {open ? "collapse" : "expand"}</div>
          </div>
        </button>
        <div className="text-[11px] text-muted tabular-nums">
          {missing.length === 0 ? "all accounted for" : `${missing.length} missing · ${money(missingMrr)}/mo`}
        </div>
      </div>

      {open && (<div className="mt-2">
      {missing.length === 0 ? (
        <div className="text-[12px] text-muted">Every active Stripe client is already in your sheet. 🎉</div>
      ) : (
        <div className="space-y-1">
          {missing.map((c) => (
            <div key={c.key} className="flex items-baseline justify-between gap-2 text-[12px] py-0.5 border-b border-indigo-100/60 last:border-0">
              <span className="text-ink truncate min-w-0 flex-1">
                {c.name}
                {c.subCount > 1 && <span className="text-[10px] text-muted ml-1">({c.subCount} subs)</span>}
                {c.paused && <span className="text-[9px] uppercase tracking-wide text-amber-600 bg-amber-100 rounded px-1 py-0.5 ml-1.5 align-middle">paused</span>}
              </span>
              <span className="text-muted tabular-nums shrink-0">{money(c.mrr)}/mo</span>
              <AddToMrr company={c.name} mrr={Math.round(c.mrr)} />
            </div>
          ))}
        </div>
      )}
      </div>)}
    </div>
  );
}
