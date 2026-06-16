"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X, Trophy, Skull, Loader2 } from "lucide-react";
import type { LeadStatus } from "@/lib/outbound-leads";
import { cn } from "@/lib/utils";

// Four manual-mark buttons rendered on the lead detail page. Each
// POSTs to the matching /api/outbound/leads/[id]/mark-* route and
// router.refresh()es the page so the new status + cascading side
// effects (canceled drips, scheduled engagement messages) show up.
//
// Buttons are disabled when the action is illegal from the current
// status (e.g. "Mark showed" from warm_lead) — keeps the UI honest
// about the underlying state machine.

interface Props {
  leadId: string;
  status: LeadStatus;
}

interface ActionDef {
  key: "showed" | "no-show" | "sold" | "lost";
  label: string;
  icon: typeof Check;
  // Statuses from which this action is legal. Matches
  // ALLOWED_TRANSITIONS in lib/outbound-leads.ts.
  validFrom: LeadStatus[];
  // Tailwind classes for the button body.
  cls: string;
  // Optional confirmation prompt — used for terminal actions (sold/lost).
  confirmPrompt?: string;
  // For mark-sold only — ask for notes.
  promptForNotes?: boolean;
}

const ACTIONS: ActionDef[] = [
  {
    key: "showed",
    label: "Mark showed",
    icon: Check,
    validFrom: ["booked"],
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200/60 hover:bg-emerald-100"
  },
  {
    key: "no-show",
    label: "Mark no-show",
    icon: X,
    validFrom: ["booked"],
    cls: "bg-rose-50 text-rose-700 border-rose-200/60 hover:bg-rose-100",
    confirmPrompt: "Mark this lead as a no-show? The engagement drip will start sending."
  },
  {
    key: "sold",
    label: "Mark sold",
    icon: Trophy,
    validFrom: ["booked", "showed", "no_show"],
    cls: "bg-violet-50 text-violet-700 border-violet-200/60 hover:bg-violet-100",
    promptForNotes: true
  },
  {
    key: "lost",
    label: "Mark lost",
    icon: Skull,
    validFrom: ["warm_lead", "booked", "showed", "no_show"],
    cls: "bg-slate-100 text-slate-700 border-slate-300/60 hover:bg-slate-200",
    confirmPrompt: "Mark this lead as lost? All pending messages will be canceled."
  }
];

export function OutboundLeadActionButtons({ leadId, status }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fire(action: ActionDef) {
    setError(null);
    let body: unknown = undefined;
    if (action.confirmPrompt && !window.confirm(action.confirmPrompt)) return;
    if (action.promptForNotes) {
      const notes = window.prompt("Sold notes (optional — e.g. plan, amount):", "") ?? "";
      body = { notes: notes.trim() || undefined };
    }
    setActiveKey(action.key);
    try {
      const res = await fetch(`/api/outbound/leads/${leadId}/mark-${action.key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Failed (HTTP ${res.status})`);
        setActiveKey(null);
        return;
      }
      // Refresh the page so the new status, event row, and any newly
      // scheduled messages render. The transition keeps the spinner
      // active until the refetch settles.
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // setActiveKey null after the transition completes — but if
      // router.refresh runs first the activeKey is already gone.
      window.setTimeout(() => setActiveKey(null), 600);
    }
  }

  // Terminal states have no actions — short-circuit the row.
  if (status === "success" || status === "lost") {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 text-[13px] text-ink/55">
        This lead is in a terminal state ({status}). No further actions available
        — re-open by editing the row in Supabase if needed.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100">
        <div className="text-[11px] uppercase tracking-[0.16em] font-semibold text-ink/55">
          Rep actions
        </div>
        <h2 className="text-[16px] font-semibold text-ink mt-0.5">Mark this lead</h2>
      </div>
      <div className="p-4 flex flex-wrap gap-2">
        {ACTIONS.map((a) => {
          const Icon = a.icon;
          const legal = a.validFrom.includes(status);
          const isBusy = activeKey === a.key || (pending && activeKey === a.key);
          return (
            <button
              key={a.key}
              disabled={!legal || !!activeKey}
              onClick={() => void fire(a)}
              className={cn(
                "inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13.5px] font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                a.cls
              )}
              title={legal ? undefined : `Illegal from ${status}`}
            >
              {isBusy
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Icon className="w-4 h-4" />}
              {a.label}
            </button>
          );
        })}
      </div>
      {error && (
        <div className="px-5 py-3 border-t border-rose-200/60 bg-rose-50/60 text-[12.5px] text-rose-900">
          {error}
        </div>
      )}
    </div>
  );
}
