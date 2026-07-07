"use client";

import { PanelLeftOpen } from "lucide-react";
import { useInboxTreeDrawer } from "./InboxTreeDrawerProvider";

// Mobile-only opener for the inbox folder/account drawer (InboxTree). Hidden on
// md+ where the tree is a static rail. Rendered at the top of the inbox content
// column so it's available on every /inboxes/* page.
export function InboxTreeToggle() {
  const { toggle } = useInboxTreeDrawer();
  return (
    <div className="md:hidden mb-3">
      <button
        type="button"
        onClick={toggle}
        aria-label="Open inboxes"
        className="inline-flex items-center gap-2 h-9 px-3 rounded-xl bg-white border border-slate-200 shadow-soft text-sm font-medium text-ink/75 hover:text-ink transition-colors"
      >
        <PanelLeftOpen className="w-4 h-4" />
        Inboxes
      </button>
    </div>
  );
}
