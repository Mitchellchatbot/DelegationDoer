"use client";

import { useState } from "react";
import Link from "next/link";
import { Moon, Sunrise, ExternalLink } from "lucide-react";
import { EodHistoryView } from "@/components/EodHistoryView";
import { SodHistoryView } from "@/components/SodHistoryView";
import type { Department } from "@/lib/types";
import { cn } from "@/lib/utils";

type Kind = "eod" | "sod";

// Leader-console "Day reports" tab. Mounts the existing team EOD/SOD
// history views (embedded — no page hero / back links) behind a small
// EOD|SOD toggle. Visibility is enforced server-side by the history
// APIs; leaders + stealth admins see the whole org. `departments` powers
// the per-view department chip filter.
export function DayReportsTab({ departments }: { departments: Department[] }) {
  const [kind, setKind] = useState<Kind>("eod");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        {/* EOD | SOD segmented toggle */}
        <div className="inline-flex items-center gap-0.5 rounded-full border border-slate-200/70 bg-white p-0.5">
          <ToggleButton active={kind === "eod"} onClick={() => setKind("eod")}>
            <Moon className="w-3.5 h-3.5" /> End of day
          </ToggleButton>
          <ToggleButton active={kind === "sod"} onClick={() => setKind("sod")}>
            <Sunrise className="w-3.5 h-3.5" /> Start of day
          </ToggleButton>
        </div>

        {/* Live daily board lives on /eod (the heavy interactive view we
            don't re-implement here). */}
        {kind === "eod" && (
          <Link
            href="/eod"
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/70 hover:text-ink hover:border-accent/40 transition-colors"
          >
            View today&apos;s live board <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        )}
      </div>

      {kind === "eod"
        ? <EodHistoryView embedded departments={departments} />
        : <SodHistoryView embedded departments={departments} />}
    </div>
  );
}

function ToggleButton({
  active, onClick, children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors",
        active ? "bg-accent text-white shadow-sm" : "text-muted hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}
