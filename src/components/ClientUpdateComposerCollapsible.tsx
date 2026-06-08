"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Send, X } from "lucide-react";
import { ClientUpdateComposer } from "@/components/ClientUpdateComposer";

// Collapsed-by-default wrapper for the Client Update composer on the client
// detail page. Mirrors ContentPlanComposerCollapsible: a one-line CTA that
// reads as "another section" until clicked, then reveals the full composer
// (date-range picker + generate + editable preview + submit-for-approval).
// Kept separate from the composer so the composer keeps its own styling.
//
// Auto-opens (and scrolls into view) when `?openComposer=1` is present in
// the URL. Used by the /approvals "Who needs an email" card to deep-link
// straight into the composer with a pre-selected date window.

interface LockedClient {
  id: string;
  name: string;
  contactEmails: string[];
}

export function ClientUpdateComposerCollapsible({ lockedClient }: { lockedClient: LockedClient }) {
  const params = useSearchParams();
  const autoOpen = params?.get("openComposer") === "1";
  const presetDays = params?.get("days") ?? null;
  const [open, setOpen] = useState(autoOpen);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // When deep-linked from /approvals, scroll the composer into view on
  // mount so the user lands on it instead of the top of the page.
  // Runs once — re-toggling the panel manually shouldn't fight a later
  // re-scroll.
  useEffect(() => {
    if (!autoOpen) return;
    const t = window.setTimeout(() => {
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [autoOpen]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-2xl border border-sky-200/60 bg-gradient-to-br from-sky-50/50 to-white shadow-soft p-3.5 flex items-center gap-3 hover:from-sky-50 hover:border-sky-300 transition-colors text-left"
      >
        <div className="w-9 h-9 rounded-xl bg-sky-500 text-white grid place-items-center shadow-sm shrink-0">
          <Send className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink">Generate Client Update Email</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            AI drafts a weekly update from completed work, routes to approval. Click to open.
          </div>
        </div>
        <span className="text-[11px] font-medium text-sky-700">Open →</span>
      </button>
    );
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-white/90 border border-slate-200 hover:bg-slate-50 text-ink/65 hover:text-ink grid place-items-center transition-colors"
        title="Collapse"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <ClientUpdateComposer
        lockedClient={lockedClient}
        presetDays={presetDays ? Number(presetDays) : undefined}
      />
    </div>
  );
}
