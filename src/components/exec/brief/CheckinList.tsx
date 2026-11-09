import { MessagesSquare } from "lucide-react";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import type { CheckinPageRow } from "@/lib/exec/brief-view";
import { cn } from "@/lib/utils";
import { SectionCard } from "../SectionCard";

// The brief's check-ins on the page (P8 contract §3.17.3, M6, C11): read-only. Sending and rewriting happen only in the
// assistant's Slack DM, where the buttons carry their MAC (UI23: no button value or MAC ever reaches the page). Each row:
// who it is for, the note, and its status in the Slack message's words. checkinsNotPosted when the check-ins message
// never reached Slack (exec_briefs.checkins_ts null, UI25). A server component: every string renders as React text.

const STATUS_TONE: Readonly<Record<CheckinPageRow["status"], string>> = {
  proposed: "text-muted",
  sending: "text-indigo-700",
  sent: "text-emerald-700",
  unknown: "font-medium text-amber-700",
  failed: "font-medium text-rose-700",
  expired: "text-muted"
};

export function CheckinList({ rows, posted }: { rows: readonly CheckinPageRow[]; posted: boolean }) {
  if (rows.length === 0) return null;
  return (
    <SectionCard title={BRIEF_COPY.checkinsPageTitle} icon={MessagesSquare} basis="ai" subtitle={BRIEF_COPY.checkinsFooter} padded={false}>
      <ul data-brief-checkins className="divide-y divide-slate-100">
        {rows.map((row) => (
          <li key={row.id} data-checkin-status={row.status} className="space-y-1 px-4 py-3">
            <p className="text-[12px] font-semibold text-ink">{row.firstName.length > 0 ? row.firstName : "—"}</p>
            <p className="whitespace-pre-line break-words text-[13px] leading-relaxed text-slate-700">{row.text}</p>
            {row.statusLine.length > 0 && <p className={cn("text-[11.5px]", STATUS_TONE[row.status] ?? "text-muted")}>{row.statusLine}</p>}
          </li>
        ))}
      </ul>
      <div className="space-y-1 border-t border-slate-100 px-4 py-2.5 text-[11.5px]">
        {/* P8 fixer ui-3: "Send or rewrite them … in your assistant's Slack DM" only when that message exists. */}
        {posted
          ? <p className="text-muted">{BRIEF_COPY.checkinsPageNote}</p>
          : <p data-checkins-not-posted className="font-medium text-amber-700">{BRIEF_COPY.checkinsNotPosted}</p>}
      </div>
    </SectionCard>
  );
}
