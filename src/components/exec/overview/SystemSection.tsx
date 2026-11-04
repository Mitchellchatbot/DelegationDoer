import { ServerCog } from "lucide-react";
import { formatCount } from "@/lib/exec/format";
import type { JobKindHealth, OverviewSection, OverviewSystem } from "@/lib/exec/overview";
import { cn } from "@/lib/utils";
import { SectionCard } from "../SectionCard";
import { ago } from "./labels";

// The assistant's background work, from exec_jobs: when each kind last
// succeeded, what died, and whether the queue is keeping up. A tracked kind
// with no recent success is shown as such, which is how a stopped scheduler
// becomes visible.

const JOB_LABELS: Readonly<Record<string, string>> = {
  "exec.dd-attention": "Needs Attention refresh",
  "exec.purge": "Retention cleanup"
};

function KindRow({ job, lookbackHours, now }: { job: JobKindHealth; lookbackHours: number; now: string }) {
  // A kind with no label (a later phase's) shows its id, which is what the logs use.
  const label = JOB_LABELS[job.kind] ?? job.kind;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="break-words text-[13px] font-medium text-ink">{label}</div>
        <div className="text-[11.5px]">
          {job.lastSuccessAt ? (
            <span className="text-muted">
              Last success <time dateTime={job.lastSuccessAt}>{ago(job.lastSuccessAt, now)}</time>
            </span>
          ) : (
            <span className="font-medium text-amber-700">{`No success in the last ${lookbackHours} h`}</span>
          )}
        </div>
      </div>
      {job.dead24h > 0 && (
        <span className="badge shrink-0 border-rose-200 bg-rose-50 text-rose-700" title="Ran out of retries in the last 24 hours">
          {`${formatCount(job.dead24h)} failed`}
        </span>
      )}
    </li>
  );
}

function Figure({ label, value, title, alarm = false }: { label: string; value: string; title?: string; alarm?: boolean }) {
  return (
    <div title={title} className="min-w-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[15px] font-semibold tabular-nums", alarm ? "text-rose-700" : "text-ink")}>{value}</dd>
    </div>
  );
}

export function SystemSection({ system, now }: { system: OverviewSection<OverviewSystem>; now: string }) {
  if (!system.ok) return <SectionCard title="System" icon={ServerCog} error />;
  const { kinds, successLookbackHours, dead24h, queued, due, oldestDueAt } = system.data;
  return (
    <SectionCard title="System" icon={ServerCog} basis="record" subtitle="The assistant's background jobs" padded={false}>
      <ul className="divide-y divide-slate-100">
        {kinds.map((job) => (
          <KindRow key={job.kind} job={job} lookbackHours={successLookbackHours} now={now} />
        ))}
      </ul>
      <dl className="grid grid-cols-3 gap-2 border-t border-slate-100 px-4 py-3">
        <Figure
          label="Queued"
          value={queued > due ? `${formatCount(queued)} (${formatCount(due)} due)` : formatCount(queued)}
          title="Jobs waiting to run; the ones not yet due wait for a retry or a later slot"
        />
        <Figure label="Oldest due" value={oldestDueAt ? ago(oldestDueAt, now) : "None"} title="How long the longest-waiting due job has waited" />
        <Figure label="Failed, 24 h" value={formatCount(dead24h)} title="Jobs that ran out of retries in the last 24 hours" alarm={dead24h > 0} />
      </dl>
    </SectionCard>
  );
}
