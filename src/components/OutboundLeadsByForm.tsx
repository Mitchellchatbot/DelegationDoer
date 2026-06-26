"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Inbox, HelpCircle } from "lucide-react";
import type { OutboundLead, ScheduledMessage, LeadStatus } from "@/lib/outbound-leads";
import type { OutboundTypeformForm } from "@/lib/outbound-typeform-forms";
import { OutboundLeadsTable } from "@/components/OutboundLeadsTable";
import { cn } from "@/lib/utils";

// Per-form sectioned view for /outbound-dashboard/leads. Each section is
// a collapsible block keyed by Typeform form_id. A catch-all "Unknown
// forms" block surfaces leads whose form_id isn't in the catalog yet so
// nothing slips out of sight.
//
// Collapse state is persisted to localStorage keyed by form_id so a busy
// rep can collapse the form they don't care about today and have it stay
// collapsed across page reloads.

interface Group {
  formId: string | null;        // null = legacy lead, no form_id stamped yet
  label: string;
  description: string | null;
  enrollInFlow: boolean;        // false = submissions skip the SMS sequence
  rows: Array<{
    lead: OutboundLead;
    nextMessage: ScheduledMessage | null;
  }>;
}

interface Props {
  groups: Group[];
  statusFilter: LeadStatus | null;
  forms: OutboundTypeformForm[];        // catalog — used only for header counters
}

const STORAGE_KEY = "outbound-leads-collapsed-forms";

function loadCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((s) => typeof s === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set])); }
  catch { /* quota or private mode — preference is best-effort */ }
}

export function OutboundLeadsByForm({ groups, statusFilter }: Props) {
  // Local hydration of collapse state. Server render starts everything
  // expanded; we read localStorage on mount.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setCollapsed(loadCollapsed());
    setHydrated(true);
  }, []);

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }

  const totalRows = useMemo(
    () => groups.reduce((sum, g) => sum + g.rows.length, 0),
    [groups]
  );

  if (totalRows === 0) {
    return null;  // parent renders the NoLeadsHint in this case
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const key = g.formId ?? "__unknown__";
        const isUnknown = g.formId === null;
        const isCollapsed = hydrated && collapsed.has(key);
        return (
          <section
            key={key}
            className={cn(
              "rounded-2xl border bg-white shadow-soft overflow-hidden",
              isUnknown ? "border-amber-200/70" : "border-slate-200"
            )}
          >
            <button
              type="button"
              onClick={() => toggle(key)}
              className={cn(
                "w-full px-5 py-3 flex items-center justify-between gap-3 transition-colors",
                isUnknown
                  ? "bg-amber-50/50 hover:bg-amber-50"
                  : "bg-slate-50/40 hover:bg-slate-50"
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                {isCollapsed
                  ? <ChevronRight className="w-4 h-4 text-ink/45 shrink-0" />
                  : <ChevronDown className="w-4 h-4 text-ink/45 shrink-0" />}
                {isUnknown
                  ? <HelpCircle className="w-4 h-4 text-amber-700 shrink-0" />
                  : <Inbox className="w-4 h-4 text-ink/55 shrink-0" />}
                <div className="min-w-0 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-ink truncate">
                      {g.label}
                    </span>
                    {!isUnknown && !g.enrollInFlow && (
                      <span
                        className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-slate-100 text-ink/55"
                        title="Submissions from this form create leads but skip the SMS sequence"
                      >
                        No flow
                      </span>
                    )}
                  </div>
                  {g.description && (
                    <div className="text-[11.5px] text-ink/55 truncate mt-0.5">
                      {g.description}
                    </div>
                  )}
                </div>
              </div>
              <div className="inline-flex items-center gap-2 shrink-0 text-[11.5px] text-ink/65">
                <span className="tabular-nums font-semibold text-ink">{g.rows.length}</span>
                <span>{g.rows.length === 1 ? "lead" : "leads"}</span>
              </div>
            </button>
            {!isCollapsed && (
              <div className="px-3 pt-2 pb-3">
                <OutboundLeadsTable
                  rows={g.rows}
                  totalCount={g.rows.length}
                  statusFilter={statusFilter}
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
