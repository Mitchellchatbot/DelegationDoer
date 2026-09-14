"use client";

import { useState } from "react";
import { Plus, Check } from "lucide-react";

// One-click "add this Stripe client to the manual MRR sheet" button, shown next
// to Stripe clients that aren't in the sheet yet.
export function AddToMrr({ company, mrr }: { company: string; mrr: number }) {
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  if (state === "done") {
    return (
      <span className="text-[10px] text-emerald-600 flex items-center gap-0.5 shrink-0">
        <Check className="w-3 h-3" /> added
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={state === "saving"}
      onClick={async () => {
        setState("saving");
        try {
          const r = await fetch("/api/finance/mrr", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ company, mrr, status: "active", note: "from Stripe" })
          });
          setState(r.ok ? "done" : "idle");
        } catch {
          setState("idle");
        }
      }}
      className="text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 rounded px-1.5 py-0.5 flex items-center gap-0.5 shrink-0 disabled:opacity-50"
      title="Add to your MRR sheet"
    >
      <Plus className="w-3 h-3" /> sheet
    </button>
  );
}
