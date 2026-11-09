import type { ReactNode } from "react";
import { BrainCircuit } from "lucide-react";
import type { BriefPillView } from "@/lib/exec/brief-view";
import { formatInZone } from "@/lib/exec/format";
import { BriefPill } from "./brief/BriefPill";

// The page header (the Scale Room's, scale/page.tsx). Each exec page renders
// it itself, after its gate, never the segment layout: the layout's output
// reaches the browser before the page can answer a non-owner with a 404.
// P8 (contract §3.17.3, C42): an optional `brief` pill next to "Private"; a
// page that doesn't pass it renders exactly as before.
export function ExecHeader({
  updatedAt,
  tz,
  trailing,
  brief
}: {
  /** When the data on the page was read (ISO). */
  updatedAt: string;
  /** The principal's zone. */
  tz: string;
  /** Right side: the tabs, and Regenerate where the page offers it. */
  trailing?: ReactNode;
  /** P8 (C42): the brief pill (brief-view.ts getBriefPill / getBriefHeaderView). */
  brief?: BriefPillView;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-white">
          <BrainCircuit className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold leading-tight text-slate-900">Executive AI Assistant</h1>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
              Private
            </span>
            {brief && <BriefPill pill={brief} />}
          </div>
          <p className="mt-0.5 text-[12px] text-muted">
            Updated <time dateTime={updatedAt}>{formatInZone(updatedAt, tz, "datetime")}</time>
          </p>
        </div>
      </div>
      {trailing && <div className="flex min-w-0 flex-wrap items-center gap-2">{trailing}</div>}
    </header>
  );
}
