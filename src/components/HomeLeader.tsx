"use client";

import Link from "next/link";
import {
  ClipboardCheck, Mail, FileText, Flame, CheckCircle2, ArrowRight,
  Users, AlertTriangle, Crown
} from "lucide-react";
import { PersonAvatar } from "@/components/PersonAvatar";
import { Countdown } from "@/components/Countdown";
import { PriorityBadge } from "@/components/Badges";
import { cn } from "@/lib/utils";
import type { HomeTask, HomeTeammate, NeedsYouCounts } from "@/lib/home-data";

// /home rendering for leaders and heads. Three strips:
//   1. "Needs you" — approvals + inbox + EOD pending counters
//   2. Team status — compressed grid of teammates with state dots
//   3. Today's deliverables — cross-team ship list
//
// Heads pass `scopeLabel="<dept name>"` so the header makes it obvious
// they're looking at a slice, not the whole org.

interface DeliverableRow extends HomeTask {
  assigneeId: string | null;
  assigneeName: string | null;
}

interface Props {
  meName: string;
  needsYou: NeedsYouCounts;
  team: HomeTeammate[];
  deliverables: DeliverableRow[];
  scopeLabel?: string;  // "Software" for heads; undefined for leaders
}

export function HomeLeader({ meName, needsYou, team, deliverables, scopeLabel }: Props) {
  const firstName = meName.split(" ")[0];
  return (
    <div className="space-y-3 max-w-5xl">
      <Header firstName={firstName} scopeLabel={scopeLabel} />
      <NeedsYouStrip counts={needsYou} />
      <TeamStripCard team={team} />
      <DeliverablesCard rows={deliverables} />
    </div>
  );
}

function Header({ firstName, scopeLabel }: { firstName: string; scopeLabel?: string }) {
  return (
    <header className="rounded-2xl border border-indigo-200/60 shadow-soft p-4 bg-gradient-to-r from-indigo-50 via-white to-indigo-50/60">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/80 grid place-items-center text-indigo-600 shrink-0 shadow-sm">
          {scopeLabel ? <Users className="w-5 h-5" /> : <Crown className="w-5 h-5" />}
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-indigo-700">
            {scopeLabel ? `${scopeLabel} · today` : "Today"}
          </div>
          <h1 className="text-[20px] font-bold text-ink leading-tight">
            Good to see you, {firstName}
          </h1>
        </div>
      </div>
    </header>
  );
}

// Three-pill row at the top — approvals waiting, unread inboxes, EOD
// forms not yet submitted after 5pm. If all three are zero we render a
// single "all clear" line instead so the leader doesn't see three
// gray-zero pills competing for attention.
function NeedsYouStrip({ counts }: { counts: NeedsYouCounts }) {
  const total = counts.approvalsPending + counts.inboxesUnread + counts.peopleEodPending;
  if (total === 0) {
    return (
      <div className="rounded-2xl border border-emerald-200/60 bg-emerald-50/50 px-4 py-3 flex items-center gap-2.5">
        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
        <div className="text-[13px] text-emerald-900 font-medium">All clear today. Nothing is waiting on you.</div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
      <NeedsYouPill
        count={counts.approvalsPending}
        label="Awaiting your approval"
        href="/approvals"
        icon={<ClipboardCheck className="w-4 h-4" />}
        tone="rose"
      />
      <NeedsYouPill
        count={counts.inboxesUnread}
        label="Unread in your inboxes"
        href="/inboxes"
        icon={<Mail className="w-4 h-4" />}
        tone="indigo"
      />
      <NeedsYouPill
        count={counts.peopleEodPending}
        label="EOD forms pending"
        href="/people"
        icon={<FileText className="w-4 h-4" />}
        tone="amber"
      />
    </div>
  );
}

function NeedsYouPill({
  count, label, href, icon, tone
}: {
  count: number; label: string; href: string;
  icon: React.ReactNode; tone: "rose" | "indigo" | "amber";
}) {
  const isQuiet = count === 0;
  const toneCls = {
    rose:    "from-rose-50 to-white border-rose-200/60 text-rose-700",
    indigo:  "from-indigo-50 to-white border-indigo-200/60 text-indigo-700",
    amber:   "from-amber-50 to-white border-amber-200/60 text-amber-700"
  }[tone];
  return (
    <Link
      href={href}
      className={cn(
        "rounded-2xl border bg-gradient-to-br p-3 flex items-center gap-3 hover:shadow-soft transition-shadow",
        isQuiet ? "opacity-60 from-slate-50 to-white border-slate-200/60 text-ink/60" : toneCls
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
  );
}

function TeamStripCard({ team }: { team: HomeTeammate[] }) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Users className="w-4 h-4 text-indigo-500" />
          Team today
          <span className="text-[11px] text-ink/55 font-normal tabular-nums">· {team.length}</span>
        </div>
        <Link
          href="/people"
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          People <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      {team.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-ink/55">No teammates in scope.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {team.map((t) => (
            <li key={t.userId} className="flex items-center gap-3 px-4 py-2">
              <PersonAvatar
                userId={t.userId}
                name={t.name}
                imageUrl={t.avatarUrl ?? undefined}
                size={28}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink truncate">{t.name}</div>
                <div className="flex items-center gap-2 text-[10px] text-ink/55 mt-0.5">
                  <StatusDot ok={t.clockedIn} label={t.clockedIn ? "clocked in" : "clocked out"} />
                  <StatusDot ok={t.eodSubmitted} label={t.eodSubmitted ? "EOD ✓" : "no EOD yet"} />
                  {t.overdueCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-rose-700">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {t.overdueCount} overdue
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("w-1.5 h-1.5 rounded-full", ok ? "bg-emerald-500" : "bg-slate-300")} />
      <span className={cn(ok ? "text-emerald-700" : "text-ink/55")}>{label}</span>
    </span>
  );
}

function DeliverablesCard({ rows }: { rows: DeliverableRow[] }) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Flame className="w-4 h-4 text-rose-500" />
          Due today
          <span className="text-[11px] text-ink/55 font-normal tabular-nums">· {rows.length}</span>
        </div>
        <Link
          href="/tasks/board"
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          Board <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          Nothing due today.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/tasks/${r.id}`}
                className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink truncate">{r.title}</div>
                  <div className="flex items-center gap-2 text-[11px] text-ink/55 mt-0.5">
                    {r.assigneeName && <span>{r.assigneeName}</span>}
                    <PriorityBadge priority={r.priority} />
                    {r.dueDate && <span>· <Countdown iso={r.dueDate} /></span>}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
