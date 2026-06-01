"use client";

import Link from "next/link";
import {
  ClipboardCheck, Mail, FileText, CheckCircle2,
  Crown, Users
} from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/utils";
import type { NeedsYouCounts } from "@/lib/home-data";

// Slim hero + needs-you strip for the leader / head landing surface.
// Replaces the old HomeLeader which also rendered Client health, Team
// today, and Due today — those moved into HomePulseCard (the
// notification feed) so they don't duplicate the same signal twice.

export function HomeLeaderHero({
  meName, needsYou, scopeLabel
}: {
  meName: string;
  needsYou: NeedsYouCounts;
  scopeLabel?: string;
}) {
  const firstName = meName.split(" ")[0];
  return (
    <div className="space-y-4">
      <PageHero
        eyebrow={scopeLabel ? `${scopeLabel} · today` : "Today"}
        headline={["Good to see you, ", { accent: firstName }]}
        subtitle="Quick read on what's open, who's stuck, and which clients need a nudge."
        icon={scopeLabel ? <Users /> : <Crown />}
        iconTone={scopeLabel ? "emerald" : "indigo"}
      />
      <NeedsYouStrip counts={needsYou} />
    </div>
  );
}

function NeedsYouStrip({ counts }: { counts: NeedsYouCounts }) {
  const total = counts.approvalsPending + counts.inboxesUnread + counts.peopleEodPending;
  if (total === 0) {
    return (
      <div className="rounded-2xl border border-emerald-200/60 bg-emerald-50/50 px-4 py-3 flex items-center gap-2.5">
        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
        <div className="text-[13px] text-emerald-900 font-medium">
          All clear today. Nothing is waiting on you.
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
      <Pill
        count={counts.approvalsPending}
        label="Awaiting your approval"
        href="/approvals"
        icon={<ClipboardCheck className="w-4 h-4" />}
        tone="rose"
        tooltip="Outbound emails + AI-routed tasks waiting for your eye."
      />
      <Pill
        count={counts.inboxesUnread}
        label="Unread in your inboxes"
        href="/inboxes"
        icon={<Mail className="w-4 h-4" />}
        tone="indigo"
        tooltip="Total unread threads across every inbox you have access to."
      />
      <Pill
        count={counts.peopleEodPending}
        label="EOD forms pending"
        href="/people"
        icon={<FileText className="w-4 h-4" />}
        tone="amber"
        tooltip="Team members who haven't submitted today's EOD note yet (after 5pm local)."
      />
    </div>
  );
}

function Pill({
  count, label, href, icon, tone, tooltip
}: {
  count: number;
  label: string;
  href: string;
  icon: React.ReactNode;
  tone: "rose" | "indigo" | "amber";
  tooltip?: string;
}) {
  const isQuiet = count === 0;
  const toneCls = {
    rose:   "from-rose-50 to-white border-rose-200/60 text-rose-700",
    indigo: "from-indigo-50 to-white border-indigo-200/60 text-indigo-700",
    amber:  "from-amber-50 to-white border-amber-200/60 text-amber-700"
  }[tone];
  return (
    <Tooltip label={tooltip}>
      <Link
        href={href}
        className={cn(
          "w-full rounded-2xl border bg-gradient-to-br p-3 flex items-center gap-3 hover:shadow-soft transition-shadow",
          isQuiet
            ? "opacity-60 from-slate-50 to-white border-slate-200/60 text-ink/60"
            : toneCls
        )}
      >
        <div className="w-8 h-8 rounded-lg bg-white/80 grid place-items-center shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-[20px] font-bold tabular-nums leading-tight">{count}</div>
          <div className="text-[11px] opacity-80 truncate">{label}</div>
        </div>
      </Link>
    </Tooltip>
  );
}
