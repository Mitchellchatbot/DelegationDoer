import type { ReactNode } from "react";
import Link from "next/link";
import { Building2, Info, UserX, Users } from "lucide-react";
import { formatInZone, pluralize } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import type { TeamView } from "@/lib/exec/view-types";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { SectionCard } from "../SectionCard";
import { TeamTable } from "./TeamTable";

// /executive/team (P5a contract §3.13.2, A3, C15, C27, C30): workload and
// flow per department and per person, read from DD's records. Rendered from a
// TeamView and nothing else (no reads, no clock: every date comes from
// view.generatedAt in his zone). It says plainly what it is and isn't, and
// "How these are measured" spells out every definition and window, so no
// figure is read as more than it is.

export const TEAM_INTRO = "Workload and flow from DD's records. Not a performance score: nothing here ranks people.";

function Definition({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <dt className="font-semibold text-slate-700">{term}</dt>
      <dd className="text-slate-600">{children}</dd>
    </div>
  );
}

function HowMeasured({ view }: { view: TeamView }) {
  const tz = view.timezone;
  const now = view.generatedAt;
  const date = (iso: string) => formatInZone(iso, tz, "date", now);
  const w = view.windows;
  return (
    <details data-how-measured className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[12.5px] leading-relaxed shadow-soft">
      <summary className="cursor-pointer font-semibold text-ink">How these are measured</summary>
      <dl className="mt-3 space-y-2.5">
        <Definition term="Who is listed">
          Everyone with a department, open work assigned to them, or a completion in the last 30 days.
        </Definition>
        <Definition term="Windows">
          {`This week runs from Monday 00:00 in your time zone (${date(w.thisWeekStart)}) to now; last week is the 7 days before it (from ${date(w.lastWeekStart)}). `}
          {`On time, cycle time and extensions cover the last 30 days (from ${date(w.indicatorsFrom)}). `}
          {`EOD covers the 30 ET days ending yesterday (${formatInZone(w.eodFromYmd, tz, "date", now)} to ${formatInZone(w.eodToYmd, tz, "date", now)}), because today's report may not be due yet.`}
        </Definition>
        <Definition term="Open, in progress">Open tasks assigned to the person, and those in progress, as DD records them.</Definition>
        <Definition term="Overdue">
          Open, past due, not an incident and not waiting for a proof review. A past-due proof waits on the reviewer, not the person, so it shows under
          “Awaiting approval” instead. Auto-archived overdue tasks are counted and noted.
        </Definition>
        <Definition term="Stalled">
          No activity for 7 days, not counting overdue work, incidents, or tasks waiting on the client or on a proof review (the same rule as Needs
          Attention).
        </Definition>
        <Definition term="Completed">
          Counted by when the task was completed. Tasks marked done by a manual stage close aren’t credited to anyone; they are noted as “closed with their
          stage”.
        </Definition>
        <Definition term="Capacity today">
          Hours of open work against today’s scheduled hours, by DD’s own capacity rules. Auto-archived open tasks are left out. “Off today” means the
          person’s schedule has no hours today.
        </Definition>
        <Definition term="EOD rate">
          EOD reports submitted out of the ET weekdays a report was expected. Expected follows DD’s ritual rule (required, or not a leader with daily
          prompts on). Expected days skip the days off in a person’s explicit weekly schedule. Leave and holidays aren’t recorded in DD, so they count as
          expected. Reports on other days are noted beside the rate.
        </Definition>
        <Definition term="On time">
          Of tasks completed with a due date, the share finished by it, judged by when the proof was handed in when there was one. Proof hand-ins from
          before the window count too. Project-stage tasks and incidents are left out.
        </Definition>
        <Definition term="Median cycle time">
          From the task’s creation to its proof hand-in, or to completion when there was no proof. An approved email or tl;dv intake task starts when its
          draft was created, so its cycle time includes the time it waited for approval. Project-stage tasks and incidents are left out.
        </Definition>
        <Definition term="Extended">
          Of tasks with a due date that are open now or were completed in the window, the share extended at least once, counted against the task’s
          assignee. A first deadline set through Extend isn’t an extension.
        </Definition>
        <Definition term="Too few">Any rate or median with fewer than 5 cases shows “—, too few”.</Definition>
        <Definition term="Day boundary">
          EOD days are ET days. Someone working Pakistan hours (PKT) can submit after midnight ET, so a report can land on the neighbouring ET day.
        </Definition>
      </dl>
    </details>
  );
}

function UnownedSection({ view }: { view: TeamView }) {
  const unowned = view.unowned;
  if (!unowned.ok) return <SectionCard title="Unowned work" icon={UserX} error />;
  const u = unowned.data;
  const none = u.undispatchedPlaceholders === 0 && u.orphans === 0;
  return (
    <SectionCard title="Unowned work" icon={UserX} basis="derived" empty={none ? "Every open task has an owner or a team queue." : undefined}>
      <ul className="space-y-1.5 text-[12.5px] text-slate-700">
        {u.orphans > 0 && <li>{`${pluralize(u.orphans, "open task")} with no assignee and no team queue.`}</li>}
        {u.undispatchedPlaceholders > 0 && (
          <li>{`${pluralize(u.undispatchedPlaceholders, "project stage placeholder")} not yet handed out by the project flow.`}</li>
        )}
      </ul>
      {u.orphanSamples.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {u.orphanSamples.map((s) => {
            const link = s.ref.url ? safeLink(s.ref.url) : null;
            const cls = "inline-flex max-w-[18rem] items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600";
            return (
              <li key={s.taskId} className="min-w-0">
                {link && !link.external ? (
                  <Link href={link.href} prefetch={false} className={`${cls} hover:border-slate-300 hover:text-ink`} title={s.title}>
                    <span className="truncate">{s.title}</span>
                  </Link>
                ) : (
                  <span className={cls} title={s.title}>
                    <span className="truncate">{s.title}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

export function TeamPageView({ view }: { view: TeamView }) {
  const now = view.generatedAt;
  const tz = view.timezone;
  const departmentNames: Record<string, string> = {};
  if (view.departments.ok) {
    for (const d of view.departments.data) if (d.departmentId) departmentNames[d.departmentId] = d.name;
  }
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="team" tabs={EXEC_TABS} />} />
      <div className="space-y-3">
        <p className="flex items-start gap-2 text-[13px] text-slate-700">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
          <span>{TEAM_INTRO}</span>
        </p>
        <HowMeasured view={view} />
      </div>
      {view.departments.ok ? (
        <SectionCard
          title="Departments"
          icon={Building2}
          action={pluralize(view.departments.data.length, "department")}
          empty={view.departments.data.length === 0 ? "No departments to show." : undefined}
          padded={false}
        >
          <TeamTable rows={view.departments.data} variant="departments" departmentNames={departmentNames} />
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-muted">
            Each person counts once, under their primary department.
          </p>
        </SectionCard>
      ) : (
        <SectionCard title="Departments" icon={Building2} error />
      )}
      {view.people.ok ? (
        <SectionCard
          title="People"
          icon={Users}
          action={pluralize(view.people.data.length, "person", "people")}
          empty={view.people.data.length === 0 ? "No one to list yet." : undefined}
          padded={false}
        >
          <TeamTable rows={view.people.data} variant="people" departmentNames={departmentNames} />
        </SectionCard>
      ) : (
        <SectionCard title="People" icon={Users} error />
      )}
      <UnownedSection view={view} />
    </div>
  );
}
