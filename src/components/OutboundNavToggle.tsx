"use client";

import { Menu } from "lucide-react";
import { useNavDrawer } from "./NavDrawerProvider";

// Mobile-only hamburger for the (outbound) shell, which has no Topbar to host
// one. Opens the OutboundSidebar drawer. Hidden on md+ where the sidebar is a
// static rail. Rendered inline at the top of the content column.
export function OutboundNavToggle() {
  const { toggle } = useNavDrawer();
  return (
    <div className="md:hidden mb-2">
      <button
        type="button"
        onClick={toggle}
        aria-label="Open navigation menu"
        className="w-10 h-10 grid place-items-center rounded-xl border border-slate-200 bg-white shadow-soft text-ink/70 hover:text-ink transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>
    </div>
  );
}
