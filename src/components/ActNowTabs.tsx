"use client";

import { useState } from "react";
import { Mail, Flame, Phone, CalendarClock } from "lucide-react";
import { InboxCopilot, type InboxThread } from "@/components/InboxCopilot";
import { ReachOutList } from "@/components/ActNow";
import { FollowUpList } from "@/components/FollowUpList";
import type { ReachOutClient, FollowUps } from "@/lib/scale-actions";

// One "Act now" section instead of a long stack. Four tabs — Reply, Follow up,
// Reactivate, Reach out — with only the active list shown, so the page stays
// short and it's obvious what needs Mitchell. Each list keeps its own behavior.
type Tab = "reply" | "followup" | "reactivate" | "reachout";

export function ActNowTabs({
  inbox, inboxNote, reactivate, reachOut, followUps
}: {
  inbox: InboxThread[];
  inboxNote: string | null;
  reactivate: InboxThread[];
  reachOut: ReachOutClient[];
  followUps: FollowUps;
}) {
  const needReply = inbox.filter((t) => t.needsReply).length;
  const followCount = followUps.booked.length + followUps.noResponse.length;
  const tabs: { key: Tab; label: string; count: number; icon: typeof Mail; on: string; off: string }[] = [
    { key: "reply", label: "Reply", count: inbox.length, icon: Mail, on: "bg-indigo-600 text-white", off: "text-indigo-700 bg-indigo-50 hover:bg-indigo-100" },
    { key: "followup", label: "Follow up", count: followCount, icon: CalendarClock, on: "bg-sky-600 text-white", off: "text-sky-700 bg-sky-50 hover:bg-sky-100" },
    { key: "reactivate", label: "Reactivate", count: reactivate.length, icon: Flame, on: "bg-amber-500 text-white", off: "text-amber-700 bg-amber-50 hover:bg-amber-100" },
    { key: "reachout", label: "Reach out", count: reachOut.length, icon: Phone, on: "bg-emerald-600 text-white", off: "text-emerald-700 bg-emerald-50 hover:bg-emerald-100" }
  ];
  // Open on the tab that actually has something needing a reply, else Reply.
  const [tab, setTab] = useState<Tab>(needReply === 0 && inbox.length === 0 && reactivate.length > 0 ? "reactivate" : "reply");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={"flex items-center gap-1.5 text-[12.5px] font-semibold rounded-full px-3 py-1.5 transition-colors " + (active ? t.on : t.off)}>
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              <span className={"text-[11px] tabular-nums rounded-full px-1.5 " + (active ? "bg-white/25" : "bg-white/70")}>{t.count}</span>
            </button>
          );
        })}
        {tab === "reply" && needReply > 0 && (
          <span className="text-[11px] text-muted ml-auto">{needReply} need your response</span>
        )}
      </div>

      {tab === "reply" && <InboxCopilot flat threads={inbox} note={inboxNote} />}
      {tab === "followup" && <FollowUpList data={followUps} />}
      {tab === "reactivate" && (
        reactivate.length > 0
          ? <InboxCopilot flat threads={reactivate} note="No quiet pitches to reactivate right now." />
          : <Empty>No quiet pitches to reactivate right now.</Empty>
      )}
      {tab === "reachout" && (
        reachOut.length > 0
          ? <ReachOutList clients={reachOut} />
          : <Empty>No paying clients have gone quiet.</Empty>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-muted shadow-soft">{children}</div>;
}
