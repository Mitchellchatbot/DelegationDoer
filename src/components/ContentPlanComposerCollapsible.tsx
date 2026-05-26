"use client";

import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import { ContentPlanComposer } from "@/components/ContentPlanComposer";

// Collapsed-by-default wrapper for the Content Plan composer on the
// client detail page. The full composer is a tall card (topics
// textarea + audience + angle + generate button + preview state +
// scheduling) — useful when you're authoring a plan, but pure
// clutter on every other visit. This thin shell defaults to a one-
// line CTA; click it to reveal the real thing.
//
// Lives next to the composer rather than inside it so the composer
// can keep its own header/border styling unchanged. The collapsed
// state mirrors the visual weight of the other section cards on the
// page (Meeting links, Documents, Client updates) so the row reads
// as "another section" until you choose to engage with it.

interface LockedClient {
  id: string;
  name: string;
  contactEmails: string[];
}

export function ContentPlanComposerCollapsible({ lockedClient }: { lockedClient: LockedClient }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-2xl border border-violet-200/60 bg-gradient-to-br from-violet-50/50 to-white shadow-soft p-3.5 flex items-center gap-3 hover:from-violet-50 hover:border-violet-300 transition-colors text-left"
      >
        <div className="w-9 h-9 rounded-xl bg-violet-500 text-white grid place-items-center shadow-sm shrink-0">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink">Compose a monthly content plan</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            AI drafts the email, routes to approval. Click to open.
          </div>
        </div>
        <span className="text-[11px] font-medium text-violet-700">Open →</span>
      </button>
    );
  }

  return (
    <div className="relative">
      {/* Close affordance for when the composer's expanded but the user
          wants to collapse it again without scrolling away. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-white/90 border border-slate-200 hover:bg-slate-50 text-ink/65 hover:text-ink grid place-items-center transition-colors"
        title="Collapse"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <ContentPlanComposer lockedClient={lockedClient} />
    </div>
  );
}
