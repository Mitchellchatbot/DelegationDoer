"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ClipboardCheck, Mail, FileText, Flame, CheckCircle2, ArrowRight,
  Users, AlertTriangle, Crown, Activity, X
} from "lucide-react";
import { PersonAvatar } from "@/components/PersonAvatar";
import { Countdown } from "@/components/Countdown";
import { PageHero } from "@/components/PageHero";
import { PriorityBadge } from "@/components/Badges";
import { Tooltip } from "@/components/Tooltip";
import { TOUCHPOINT_META } from "@/lib/client-touchpoint";
import { cn } from "@/lib/utils";
import type { HomeTask, HomeTeammate, NeedsYouCounts, ClientHealthRow } from "@/lib/home-data";

// localStorage key for the user's dashboard-hidden deliverable IDs.
// Pure UI hide — the underlying tasks stay live everywhere else
// (board, my-tasks, search). Only affects this user's browser; if
// we ever want a shared hide list, swap this for an API call.
const HIDDEN_DELIVERABLES_KEY = "home:hidden-deliverables:v1";

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
  clientHealth: ClientHealthRow[];
  scopeLabel?: string;  // "Software" for heads; undefined for leaders
}

export function HomeLeader({ meName, needsYou, team, deliverables, clientHealth, scopeLabel }: Props) {
  const firstName = meName.split(" ")[0];
  // One-stop dashboard layout. The page-level wrapper handles max-width
  // and centering (max-w-7xl mx-auto) so this component just runs the
  // grid. Two-col mid section on lg+ puts Client health and Team today
  // side-by-side instead of stacked, which roughly halves the scroll
  // distance on the most common screen sizes. Deliverables stays full
  // width below because a task title can be long.
  return (
    <div className="space-y-4">
      <Header firstName={firstName} scopeLabel={scopeLabel} />
      <NeedsYouStrip counts={needsYou} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ClientHealthCard rows={clientHealth} />
        <TeamStripCard team={team} />
      </div>
      <DeliverablesCard rows={deliverables} />
    </div>
  );
}

function Header({ firstName, scopeLabel }: { firstName: string; scopeLabel?: string }) {
  // Use the shared PageHero so the dashboard's header matches /clients,
  // /approvals, /tasks etc — same rounded card, eyebrow, big headline
  // with an accent word, optional subtitle. Earlier custom slim banner
  // looked out of place next to the rest of the app.
  return (
    <PageHero
      eyebrow={scopeLabel ? `${scopeLabel} · today` : "Today"}
      headline={["Good to see you, ", { accent: firstName }]}
      subtitle="Quick read on what's open, who's stuck, and which clients need a nudge."
      icon={scopeLabel ? <Users /> : <Crown />}
      iconTone={scopeLabel ? "emerald" : "indigo"}
    />
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
        tooltip="Outbound emails + AI-routed tasks waiting for your eye. Click to open Approvals."
      />
      <NeedsYouPill
        count={counts.inboxesUnread}
        label="Unread in your inboxes"
        href="/inboxes"
        icon={<Mail className="w-4 h-4" />}
        tone="indigo"
        tooltip="Total unread threads across every inbox you have access to."
      />
      <NeedsYouPill
        count={counts.peopleEodPending}
        label="EOD forms pending"
        href="/people"
        icon={<FileText className="w-4 h-4" />}
        tone="amber"
        tooltip="Team members who haven't submitted today's end-of-day note yet (after 5pm local)."
      />
    </div>
  );
}

function NeedsYouPill({
  count, label, href, icon, tone, tooltip
}: {
  count: number; label: string; href: string;
  icon: React.ReactNode; tone: "rose" | "indigo" | "amber";
  tooltip?: string;
}) {
  const isQuiet = count === 0;
  const toneCls = {
    rose:    "from-rose-50 to-white border-rose-200/60 text-rose-700",
    indigo:  "from-indigo-50 to-white border-indigo-200/60 text-indigo-700",
    amber:   "from-amber-50 to-white border-amber-200/60 text-amber-700"
  }[tone];
  return (
    <Tooltip label={tooltip}>
      <Link
        href={href}
        className={cn(
          "w-full rounded-2xl border bg-gradient-to-br p-3 flex items-center gap-3 hover:shadow-soft transition-shadow",
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
    </Tooltip>
  );
}

function TeamStripCard({ team }: { team: HomeTeammate[] }) {
  // Track the local hour on the client so the "EOD pending" pill only
  // shows up when it's actually actionable (after 5pm). Before that
  // it's just visual noise on every row. State starts as -1 to mean
  // "not yet known"; useEffect resolves it after mount. Renders show
  // the pill conservatively if the hour hasn't loaded yet, so the
  // SSR markup and first client render agree.
  const [hour, setHour] = useState<number>(-1);
  useEffect(() => {
    setHour(new Date().getHours());
    // Re-check every 5 minutes so a long-open tab eventually flips
    // over the 5pm threshold without a page refresh.
    const id = setInterval(() => setHour(new Date().getHours()), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  // EOD becomes actionable at 5pm local. Treat "hour unknown" as
  // pre-5pm so we don't flash the pill on initial render.
  const eodActionable = hour >= 17;

  // Sort: people who need attention bubble up (not clocked in, no EOD,
  // overdue tasks). Then alphabetical. Makes the dashboard's first
  // impression "who's stuck" instead of "who's first alphabetically".
  // EOD-missing only counts toward the score once it's actually due.
  const sorted = [...team].sort((a, b) => {
    const score = (t: HomeTeammate) =>
      // clock_enabled=false users never punch in by design — don't
      // penalize them in the sort for being "off shift", they
      // wouldn't have a shift either way.
      ((!t.clockEnabled || t.clockedIn) ? 0 : 2)
      + ((eodActionable && !t.eodSubmitted) ? 1 : 0)
      + Math.min(t.overdueCount, 3);
    const sd = score(b) - score(a);
    return sd !== 0 ? sd : a.name.localeCompare(b.name);
  });
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
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
      {sorted.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-ink/55">No teammates in scope.</div>
      ) : (
        // Two-column grid inside the card so 22 people don't produce a
        // 22-row scroll. Hard-cap height with overflow so the card
        // pairs cleanly with Client health beside it.
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-1 divide-y sm:divide-y-0 divide-slate-100 max-h-[480px] overflow-y-auto">
          {sorted.map((t) => (
            <li key={t.userId}>
              <Link
                href={`/team/${encodeURIComponent(t.userId)}`}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 transition-colors"
                title={`Open ${t.name}'s profile`}
              >
                <PersonAvatar
                  userId={t.userId}
                  name={t.name}
                  imageUrl={t.avatarUrl ?? undefined}
                  size={26}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-ink truncate">{t.name}</div>
                  <div className="flex items-center gap-x-2 gap-y-0.5 text-[10px] text-ink/55 mt-0.5 flex-wrap">
                    {/* Shift pill — only shown for users with the
                        time-clock feature enabled. Heads/salaried/on-call
                        roles have clock_enabled=false and don't punch
                        in, so showing "off shift" for them all day is
                        misleading. Skip the pill entirely instead. */}
                    {t.clockEnabled && (
                      <Tooltip
                        label={t.clockedIn
                          ? "Currently clocked in on their time card."
                          : "Hasn't started their shift yet today."}
                      >
                        <StatusDot
                          ok={t.clockedIn}
                          label={t.clockedIn ? "on shift" : "off shift"}
                        />
                      </Tooltip>
                    )}
                    {/* EOD pill: only render once it's actionable (5pm+).
                        Also still render if they HAVE submitted, since
                        that's positive info, not noise. */}
                    {(eodActionable || t.eodSubmitted) && (
                      <Tooltip
                        label={t.eodSubmitted
                          ? "Submitted today's end-of-day note."
                          : "Hasn't filed today's EOD note yet."}
                      >
                        <StatusDot
                          ok={t.eodSubmitted}
                          label={t.eodSubmitted ? "EOD done" : "EOD pending"}
                        />
                      </Tooltip>
                    )}
                    {t.overdueCount > 0 && (
                      <Tooltip
                        label={`${t.overdueCount} task${t.overdueCount === 1 ? "" : "s"} past their due date.`}
                      >
                        <span className="inline-flex items-center gap-0.5 text-rose-700 whitespace-nowrap">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          {t.overdueCount} overdue
                        </span>
                      </Tooltip>
                    )}
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

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  // whitespace-nowrap keeps "on shift" / "EOD pending" from breaking
  // across two lines in the cramped 2-col team grid.
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className={cn("w-1.5 h-1.5 rounded-full", ok ? "bg-emerald-500" : "bg-slate-300")} />
      <span className={cn(ok ? "text-emerald-700" : "text-ink/55")}>{label}</span>
    </span>
  );
}

function ClientHealthCard({ rows }: { rows: ClientHealthRow[] }) {
  // Tally so the header gives a quick read on overall health.
  const redCount = rows.filter((r) => r.touchpoint === "red").length;
  const yellowCount = rows.filter((r) => r.touchpoint === "yellow").length;
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-500" />
          Client health
          {(redCount > 0 || yellowCount > 0) && (
            <span className="text-[11px] text-ink/55 font-normal">
              {redCount > 0 && <span className="text-rose-600 font-medium">{redCount} neglected</span>}
              {redCount > 0 && yellowCount > 0 && <span className="text-ink/40"> · </span>}
              {yellowCount > 0 && <span className="text-amber-600 font-medium">{yellowCount} stale</span>}
            </span>
          )}
        </div>
        <Link
          href="/clients"
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          All clients <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          No active clients yet.
        </div>
      ) : (
        // Cap height to match the team card's max-h on the right so the
        // two cards visually align on lg+ layouts. Scroll spills inside.
        <ul className="divide-y divide-slate-100 max-h-[480px] overflow-y-auto">
          {rows.map((r) => {
            const meta = TOUCHPOINT_META[r.touchpoint];
            return (
              <li key={r.id}>
                <Link
                  href={`/clients/${encodeURIComponent(r.id)}`}
                  className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-slate-50 transition-colors"
                  title={meta.description + (r.isOverride ? " · manual override" : "")}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span className={cn("w-2 h-2 rounded-full shrink-0", meta.dot)} />
                    <span className="text-[13px] font-medium text-ink truncate">{r.name}</span>
                    {r.contactName && (
                      <span className="text-[11px] text-ink/55 truncate hidden sm:inline">
                        · {r.contactName}
                      </span>
                    )}
                  </div>
                  {/* Just the days-since marker — the colored dot
                      already carries the urgency, the "Neglected /
                      Stale" pill was visual duplication that made
                      every row look like an alarm. Days-since is
                      muted-rose for never-emailed, neutral otherwise,
                      so the worst cases still pop visually. */}
                  <Tooltip
                    label={
                      r.daysSinceLastEmail === null
                        ? `${meta.description} No outbound email on record yet — go say hi.`
                        : `Last outbound email: ${r.daysSinceLastEmail} day${r.daysSinceLastEmail === 1 ? "" : "s"} ago. ${meta.description}`
                    }
                  >
                    <span
                      className={cn(
                        "text-[11px] tabular-nums shrink-0 whitespace-nowrap",
                        r.daysSinceLastEmail === null
                          ? "text-rose-600/80 font-medium"
                          : "text-ink/55"
                      )}
                    >
                      {lastEmailLabel(r.daysSinceLastEmail)}
                    </span>
                  </Tooltip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function lastEmailLabel(days: number | null): string {
  // Tighter labels — these are visually competing with client names
  // in a narrow column. "never" + the red dot says everything.
  if (days === null) return "never";
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function DeliverablesCard({ rows }: { rows: DeliverableRow[] }) {
  // Hydrate the hidden-IDs set from localStorage on mount. Starts empty
  // on SSR so the initial render matches and React doesn't bail on a
  // mismatch; the useEffect then trims the list. Result: a moment of
  // flash where hidden items appear, then disappear — acceptable for
  // a dashboard nicety.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_DELIVERABLES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setHidden(new Set(parsed.filter((s) => typeof s === "string")));
      }
    } catch { /* corrupt JSON or storage disabled — ignore, render full list */ }
  }, []);

  function hide(id: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(HIDDEN_DELIVERABLES_KEY, JSON.stringify(Array.from(next)));
      } catch { /* quota / private mode — state still updates in-memory for this session */ }
      return next;
    });
  }

  // Restore option — exposed via a tiny "show hidden" footer when the
  // user has dismissed anything. Without this, an accidental hide is
  // unrecoverable short of clearing site data.
  function restoreAll() {
    setHidden(new Set());
    try { localStorage.removeItem(HIDDEN_DELIVERABLES_KEY); } catch {}
  }

  const visible = rows.filter((r) => !hidden.has(r.id));
  const hiddenInRowsCount = rows.filter((r) => hidden.has(r.id)).length;

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Flame className="w-4 h-4 text-rose-500" />
          Due today
          <span className="text-[11px] text-ink/55 font-normal tabular-nums">· {visible.length}</span>
        </div>
        <Link
          href="/tasks/board"
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          Board <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      {visible.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          {rows.length === 0 ? "Nothing due today." : "All caught up here."}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {visible.map((r) => (
            <li key={r.id} className="group relative">
              <Link
                href={`/tasks/${r.id}`}
                className="flex items-center gap-3 px-4 py-2 pr-12 hover:bg-slate-50 transition-colors"
              >
                {/* Priority pill leads the row so the eye can skim
                    severity left-to-right without re-reading every
                    task title. Title sits in the middle, countdown
                    pinned to the right rail. */}
                <Tooltip label={`Priority: ${r.priority}`}>
                  <PriorityBadge priority={r.priority} />
                </Tooltip>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink truncate">{r.title}</div>
                  {r.assigneeName && (
                    <div className="text-[11px] text-ink/55 truncate">{r.assigneeName}</div>
                  )}
                </div>
                {r.dueDate && (
                  <Tooltip label={`Due ${new Date(r.dueDate).toLocaleString()}`}>
                    <span className="text-[11px] text-ink/55 tabular-nums shrink-0 whitespace-nowrap">
                      <Countdown iso={r.dueDate} />
                    </span>
                  </Tooltip>
                )}
              </Link>
              <Tooltip label="Hide this task from the dashboard list (stays in /tasks).">
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); hide(r.id); }}
                  aria-label={`Hide "${r.title}" from dashboard`}
                  className="absolute top-1/2 -translate-y-1/2 right-3 w-7 h-7 rounded-full grid place-items-center text-ink/35 hover:text-rose-600 hover:bg-rose-50 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {hiddenInRowsCount > 0 && (
        <footer className="px-4 py-2 border-t border-slate-100 bg-slate-50/40 flex items-center justify-between text-[11px]">
          <span className="text-ink/55">{hiddenInRowsCount} hidden</span>
          <button
            type="button"
            onClick={restoreAll}
            className="text-accent hover:underline font-medium"
          >
            Show all
          </button>
        </footer>
      )}
    </section>
  );
}
