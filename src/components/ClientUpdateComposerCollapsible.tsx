"use client";

import { useState } from "react";
import { Send, X } from "lucide-react";
import { ClientUpdateComposer } from "@/components/ClientUpdateComposer";

// Collapsed-by-default wrapper for the Client Update composer on the client
// detail page. Mirrors ContentPlanComposerCollapsible: a one-line CTA that
// reads as "another section" until clicked, then reveals the full composer
// (date-range picker + generate + editable preview + submit-for-approval).
// Kept separate from the composer so the composer keeps its own styling.

interface LockedClient {
  id: string;
  name: string;
  contactEmails: string[];
}

export function ClientUpdateComposerCollapsible({ lockedClient }: { lockedClient: LockedClient }) {
  const [open, setOpen] = useState(false);

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
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-white/90 border border-slate-200 hover:bg-slate-50 text-ink/65 hover:text-ink grid place-items-center transition-colors"
        title="Collapse"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <ClientUpdateComposer lockedClient={lockedClient} />
    </div>
  );
}
