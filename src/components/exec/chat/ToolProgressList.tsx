import { Check, CircleSlash, Loader2, TriangleAlert } from "lucide-react";
import { toolLineText } from "@/lib/exec/chat/copy";
import type { ToolLine } from "@/lib/exec/chat/reducer";
import { cn } from "@/lib/utils";

// The live turn's tool lines (P5b contract §3.19.5): one per tool call the
// server reported, in the order they started, with the registry's label and
// its state: "{label}…" with a spinner, "{label}" with a check,
// "{label}: couldn't finish", "{label}: skipped (tool budget)". Pure; the
// labels are the server's fixed registry labels, shown as text.

const ICON = {
  running: { Icon: Loader2, className: "animate-spin text-indigo-500" },
  done: { Icon: Check, className: "text-emerald-600" },
  error: { Icon: TriangleAlert, className: "text-amber-600" },
  skipped: { Icon: CircleSlash, className: "text-slate-400" }
} as const;

export function ToolProgressList({ tools, className }: { tools: readonly ToolLine[]; className?: string }) {
  if (tools.length === 0) return null;
  return (
    <ul data-tool-lines className={cn("space-y-1", className)}>
      {tools.map((t) => {
        const { Icon, className: iconClass } = ICON[t.state] ?? ICON.running;
        return (
          <li key={t.callId} data-tool-line={t.state} className="flex min-w-0 items-center gap-1.5 text-[12px] text-slate-600">
            <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClass)} aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">{toolLineText(t.label, t.state)}</span>
          </li>
        );
      })}
    </ul>
  );
}
