import Link from "next/link";
import { AlarmClock, ArrowLeft, CalendarClock, History, Layers, Mail, MessageSquareWarning, ShieldAlert, TriangleAlert } from "lucide-react";
import { ASK_ABOUT_PROJECT_LINK } from "@/lib/exec/chat/copy";
import { MISSING, formatCount, formatInZone, pluralize } from "@/lib/exec/format";
import type { ConversationRow, ProjectDetailView, ProjectUpdateEvent, StageView } from "@/lib/exec/view-types";
import { cn } from "@/lib/utils";
import { BasisLabel } from "../BasisLabel";
import { EmptyState } from "../EmptyState";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { ago } from "../overview/labels";
import { SectionCard } from "../SectionCard";
import { SourceLinks } from "../SourceLinks";
import { ProjectSlackSection } from "../slack/ProjectSlackSection";
import { NEUTRAL_BADGE, ProjectStatusBadge, RefLink, STAGE_STATUS_LABEL, TASK_STATUS_LABEL, stuckText } from "./labels";

// /executive/projects/[id] (P5a contract §3.13.2, A4, C16, K25, K26): one
// project's stages, delays, blockers, updates, meeting-brief risks and
// relevant conversations, rendered from a ProjectDetailView only. Each
// section fails soft on its own. Honesty labels: the status, stuck signals,
// the derived client and the active stage's age are Derived; blockers from DD
// text and meeting-brief risks are AI-assessed; DD has no dependency model, so
// nothing here says "blocked by" as a fact.

export const PROJECT_COPY = {
  activeFor: (days: number) => `Active for at least ${pluralize(days, "day")} (DD doesn't store when a stage started)`,
  derivedFrom: (n: number, m: number) => `Derived from ${formatCount(n)} of ${formatCount(m)} tasks that name a client`,
  noUpdates: "No updates in the last 30 days.",
  meetingNote: "From the derived client's meeting briefs · Derived client · AI-assessed",
  meetingNoClient: "No client linked, so no meeting briefs to check.",
  meetingEmpty: "No risks in this client's meeting briefs from the last 60 days.",
  aiOff: "DD text triage is off",
  aiNotInstalled: "Not available yet",
  convOff: "Email intelligence is off, or your mailbox isn't linked to the assistant",
  convNotInstalled: "Email intelligence isn't set up yet",
  convNoClient: "No client linked: fewer than 3 of this project's tasks name a client, or no client holds 60% of them",
  convScreen: "Couldn't check restricted senders",
  convEmpty: "No recent email threads with this client."
} as const;

const SUBJECT_MAX = 120;
const DAY_MS = 86_400_000;

/** A subject as the page may show it: at most 120 characters (a-correct, C16). */
export function clipSubject(s: string): string {
  const chars = [...(s ?? "")];
  return chars.length <= SUBJECT_MAX ? chars.join("") : `${chars.slice(0, SUBJECT_MAX - 1).join("")}…`;
}

/** Whole days from `fromIso` to `now`, never negative. */
export function wholeDaysSince(fromIso: string, now: string): number {
  const ms = Date.parse(now) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / DAY_MS) : 0;
}

const AI_KIND_LABEL: Readonly<Record<"blocker" | "waiting" | "decision", string>> = {
  blocker: "Possible blocker",
  waiting: "Possibly waiting",
  decision: "Possible decision needed"
};

const ANSWERED_LABEL: Readonly<Record<string, string>> = { awaiting_reply: "Awaiting your reply", answered: "Answered", no_inbound: "Nothing from them yet" };
const CONFIDENCE_LABEL: Readonly<Record<string, string>> = { high: "High-confidence match", medium: "Medium-confidence match", low: "Low-confidence match" };

function Summary({ view }: { view: ProjectDetailView }) {
  const s = view.summary;
  if (!s.ok) return <SectionCard title="Summary" error />;
  const { health: h, derivedClient, stuck } = s.data;
  return (
    <SectionCard title="Summary" basis="derived">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectStatusBadge status={h.status} />
          <span className="text-[12px] tabular-nums text-muted">
            {[
              pluralize(h.openTasks, "open task"),
              h.overdueTasks > 0 ? `${formatCount(h.overdueTasks)} overdue` : null,
              h.stalledTasks > 0 ? `${formatCount(h.stalledTasks)} idle 7+ days` : null,
              h.waitingOnClient > 0 ? `${formatCount(h.waitingOnClient)} waiting on the client` : null,
              h.stageProgress.total > 0 ? `${formatCount(h.stageProgress.done)} of ${pluralize(h.stageProgress.total, "stage")} done` : null
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {h.reasons.length > 0 && (
          <ul className="space-y-0.5 text-[12.5px] leading-relaxed text-slate-700">
            {h.reasons.map((r, i) => (
              <li key={i} className="flex gap-1.5">
                <span aria-hidden className="text-slate-300">
                  •
                </span>
                <span className="min-w-0 break-words">{r}</span>
              </li>
            ))}
          </ul>
        )}
        <p data-derived-client className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-slate-700">
          <span className="font-semibold">Client:</span>
          {derivedClient ? (
            <>
              <span>{`${derivedClient.clientName} · ${PROJECT_COPY.derivedFrom(derivedClient.taskCount, derivedClient.namedTaskCount)}`}</span>
              <BasisLabel basis="derived" />
            </>
          ) : (
            <span className="text-muted">none derived from the tasks</span>
          )}
        </p>
        {stuck.length > 0 && (
          <ul className="space-y-1">
            {stuck.map((signal, i) => (
              <li key={i} data-stuck={signal.kind} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-900">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
                <span className="min-w-0 break-words">{stuckText(signal)}</span>
                <BasisLabel basis="derived" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}

function StageItem({ stage, now }: { stage: StageView; now: string }) {
  const active = stage.status === "active";
  return (
    <li data-stage={stage.id} className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* DD's stage positions start at 0; its own UI shows position + 1 (review ui-1). */}
        <span data-stage-number className="text-[11px] tabular-nums text-muted">{formatCount(stage.position + 1)}.</span>
        <span className="min-w-0 break-words text-[13px] font-semibold text-ink">{stage.name}</span>
        <span className={cn("badge", active ? "border-indigo-200 bg-indigo-50 text-indigo-700" : NEUTRAL_BADGE)}>{STAGE_STATUS_LABEL[stage.status] ?? stage.status}</span>
        <span className="text-[11.5px] tabular-nums text-muted">{`${formatCount(stage.work.done)} of ${pluralize(stage.work.total, "task")} done`}</span>
      </div>
      {active && (
        <p data-active-for className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-slate-600">
          <span>{PROJECT_COPY.activeFor(wholeDaysSince(stage.updatedAt, now))}</span>
          <BasisLabel basis="derived" />
        </p>
      )}
      {stage.currentBatch && stage.currentBatch.tasks.length > 0 && (
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            {stage.currentBatch.group === null ? "Current batch" : `Current batch (group ${formatCount(stage.currentBatch.group)})`}
          </div>
          <ul className="mt-1 space-y-2.5 sm:space-y-1">
            {stage.currentBatch.tasks.map((t) => (
              <li key={t.taskId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                <RefLink url={t.ref.url} className={cn("min-w-0 break-words font-medium text-ink", t.deleted && "line-through decoration-slate-400")}>
                  {t.title}
                </RefLink>
                <span className="text-muted">{TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                <span className="text-muted">{t.assigneeName ?? (t.teamQueueName ? `Team: ${t.teamQueueName}` : "Unassigned")}</span>
                {t.deleted && <span className="badge border-rose-200 bg-rose-50 text-rose-700">Deleted</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {stage.queuedBehind > 0 && <p className="text-[11.5px] text-muted">{`${pluralize(stage.queuedBehind, "more task")} queued after this batch`}</p>}
    </li>
  );
}

function Stages({ view }: { view: ProjectDetailView }) {
  const s = view.stages;
  if (!s.ok) return <SectionCard title="Stages" icon={Layers} error />;
  return (
    <SectionCard title="Stages" icon={Layers} empty={s.data.length === 0 ? "This project has no stages." : undefined} padded={false}>
      <ol className="divide-y divide-slate-100">
        {s.data.map((stage) => (
          <StageItem key={stage.id} stage={stage} now={view.generatedAt} />
        ))}
      </ol>
    </SectionCard>
  );
}

function Delays({ view }: { view: ProjectDetailView }) {
  const d = view.delays;
  if (!d.ok) return <SectionCard title="Delays" icon={AlarmClock} error />;
  const { overdue, extensions } = d.data;
  const tz = view.timezone;
  const now = view.generatedAt;
  return (
    <SectionCard title="Delays" icon={AlarmClock} basis="derived" empty={overdue.length === 0 && extensions.length === 0 ? "No overdue tasks or extensions." : undefined}>
      <div className="space-y-3">
        {overdue.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Overdue</h3>
            <ul className="mt-1 space-y-2.5 sm:space-y-1">
              {overdue.map((o) => (
                <li key={o.taskId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
                  <RefLink url={o.ref.url} className="min-w-0 break-words font-medium text-ink">
                    {o.title}
                  </RefLink>
                  <span className="text-muted">{o.assigneeName ?? "Unassigned"}</span>
                  <span className="font-medium text-rose-700">{`${pluralize(o.overdueDays, "day")} overdue`}</span>
                  {o.autoArchived && <span className={cn("badge", NEUTRAL_BADGE)}>Auto-archived</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {extensions.length > 0 && (
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Extensions</h3>
            <ul className="mt-1 space-y-2.5 sm:space-y-1">
              {extensions.map((e) => (
                <li key={e.taskId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
                  <RefLink url={e.ref.url} className="min-w-0 break-words font-medium text-ink">
                    {e.title}
                  </RefLink>
                  <span className="text-muted">{e.assigneeName ?? "Unassigned"}</span>
                  <span className="text-slate-600">
                    {`Extended ${e.count === 1 ? "once" : `${formatCount(e.count)} times`}; latest ${formatInZone(e.latestAt, tz, "date", now)}, now due ${formatInZone(e.latestNewDue, tz, "date", now)}`}
                  </span>
                  {e.reDatedAfterDeadline && <span className="text-[11.5px] text-amber-800">re-dated after the deadline had passed</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function Blockers({ view }: { view: ProjectDetailView }) {
  const b = view.blockers;
  if (!b.ok) return <SectionCard title="Blockers" icon={ShieldAlert} error />;
  const { derived, ai, aiState } = b.data;
  const now = view.generatedAt;
  return (
    <SectionCard title="Blockers" icon={ShieldAlert}>
      <div className="space-y-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            From DD’s records <BasisLabel basis="derived" />
          </h3>
          {derived.length === 0 ? (
            <p className="mt-1 text-[12.5px] text-muted">None found.</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {derived.map((d, i) => (
                <li key={i} className="space-y-1 text-[12.5px] text-slate-700">
                  <p className="break-words">{d.text}</p>
                  <SourceLinks refs={d.refs} max={4} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            From task comments and EOD/SOD notes <BasisLabel basis="ai" />
          </h3>
          {aiState === "off" ? (
            <p data-ai-state="off" className="mt-1 text-[12.5px] text-muted">
              {PROJECT_COPY.aiOff}
            </p>
          ) : aiState === "not_installed" ? (
            <p data-ai-state="not_installed" className="mt-1 text-[12.5px] text-muted">
              {PROJECT_COPY.aiNotInstalled}
            </p>
          ) : ai.length === 0 ? (
            <p className="mt-1 text-[12.5px] text-muted">None flagged in the last 14 days.</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {ai.map((a, i) => (
                <li key={i} data-ai-blocker={a.kind} className="space-y-0.5 text-[12.5px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-ink">{AI_KIND_LABEL[a.kind] ?? a.kind}</span>
                    <BasisLabel basis="ai" />
                    <span className="text-[11px] text-muted">
                      {[a.authorName, ago(a.at, now)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <p className="break-words text-slate-700">{a.summary}</p>
                  <SourceLinks refs={[a.ref]} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function updateLine(e: ProjectUpdateEvent): string {
  if (e.kind === "project_created") return e.detail ? `Project created · ${e.detail}` : "Project created";
  return e.detail ? `${e.title} · ${e.detail}` : e.title;
}

function Updates({ view }: { view: ProjectDetailView }) {
  const u = view.updates;
  if (!u.ok) return <SectionCard title="Updates" icon={History} error />;
  const tz = view.timezone;
  const now = view.generatedAt;
  return (
    <SectionCard title="Updates" icon={History} subtitle="The last 30 days, newest first" empty={u.data.length === 0 ? PROJECT_COPY.noUpdates : undefined} padded={false}>
      <ol className="divide-y divide-slate-100">
        {u.data.map((e, i) => (
          <li key={`${e.kind}:${e.at}:${i}`} data-update={e.kind} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2 text-[12.5px]">
            <time dateTime={e.at} title={formatInZone(e.at, tz, "datetime", now)} className="w-16 shrink-0 text-[11px] tabular-nums text-muted">
              {ago(e.at, now)}
            </time>
            <span className="min-w-0 flex-1 basis-40 break-words text-slate-700">
              {e.ref ? (
                <RefLink url={e.ref.url} className="text-slate-700">
                  {updateLine(e)}
                </RefLink>
              ) : (
                updateLine(e)
              )}
            </span>
            {e.actorName && <span className="text-[11.5px] text-muted">{e.actorName}</span>}
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

function MeetingRisks({ view }: { view: ProjectDetailView }) {
  const m = view.meetingRisks;
  if (!m.ok) return <SectionCard title="Meeting risks" icon={CalendarClock} error />;
  const tz = view.timezone;
  const now = view.generatedAt;
  const { state, rows } = m.data;
  const empty = state === "no_client" ? PROJECT_COPY.meetingNoClient : rows.length === 0 ? PROJECT_COPY.meetingEmpty : undefined;
  return (
    <SectionCard title="Meeting risks" icon={CalendarClock} basis="ai" subtitle={PROJECT_COPY.meetingNote} empty={empty}>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.meetingId} data-meeting={r.meetingId} className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
              <RefLink url={r.ref.url} className="min-w-0 break-words font-semibold text-ink">
                {r.title}
              </RefLink>
              <span className="text-[11.5px] text-muted">{formatInZone(r.meetingAt, tz, "date", now)}</span>
              <span className="text-[11.5px] text-muted">{r.matchedBy === "client" ? "Client meeting" : "Linked to this project's tasks"}</span>
              <BasisLabel basis="ai" />
            </div>
            <ul className="space-y-0.5 pl-1 text-[12.5px] text-slate-700">
              {r.risks.map((risk, i) => (
                <li key={i} className="flex gap-1.5">
                  <span aria-hidden className="text-slate-300">
                    •
                  </span>
                  <span className="min-w-0 break-words">{risk}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function ConversationItem({ row, now }: { row: ConversationRow; now: string }) {
  return (
    <li data-conversation={row.threadId} className="space-y-0.5 px-4 py-2 text-[12.5px]">
      {/* The subject takes its own line: beside the metadata it collapsed to a sliver on a phone. */}
      <RefLink url={row.ref.url} className="block break-words font-medium text-ink">
        {clipSubject(row.subject) || "(no subject)"}
      </RefLink>
      <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
        <span>{row.answered ? ANSWERED_LABEL[row.answered] ?? row.answered : MISSING}</span>
        <span>{CONFIDENCE_LABEL[row.confidence] ?? row.confidence}</span>
        <span className="tabular-nums">{row.lastActivityAt ? ago(row.lastActivityAt, now) : MISSING}</span>
      </p>
    </li>
  );
}

function Conversations({ view }: { view: ProjectDetailView }) {
  const c = view.conversations;
  if (!c.ok) return <SectionCard title="Conversations" icon={Mail} error />;
  const { state, rows, hiddenRestricted } = c.data;
  const stateText =
    state === "off"
      ? PROJECT_COPY.convOff
      : state === "not_installed"
        ? PROJECT_COPY.convNotInstalled
        : state === "no_client"
          ? PROJECT_COPY.convNoClient
          : state === "screen_unavailable"
            ? PROJECT_COPY.convScreen
            : null;
  return (
    <SectionCard title="Conversations" icon={Mail} subtitle="Email threads with the derived client · private" padded={false}>
      {stateText ? (
        <EmptyState icon={state === "screen_unavailable" ? TriangleAlert : Mail} message={stateText} />
      ) : (
        <>
          {rows.length === 0 ? (
            <EmptyState icon={Mail} message={PROJECT_COPY.convEmpty} />
          ) : (
            <ul className="divide-y divide-slate-100">
              {rows.map((r) => (
                <ConversationItem key={r.threadId} row={r} now={view.generatedAt} />
              ))}
            </ul>
          )}
          {hiddenRestricted > 0 && (
            <p data-hidden-restricted className="border-t border-slate-100 px-4 py-2 text-[12px] text-slate-600">
              {`${formatCount(hiddenRestricted)} hidden: restricted sender`}
            </p>
          )}
        </>
      )}
    </SectionCard>
  );
}

/** P7b: P5a's derived-client line for the Slack card's client group, when the summary has a derived client. */
function derivedNote(view: ProjectDetailView): string | null {
  const d = view.summary.ok ? view.summary.data.derivedClient : null;
  return d === null ? null : PROJECT_COPY.derivedFrom(d.taskCount, d.namedTaskCount);
}

export function ProjectDetailPageView({
  view,
  askHref = null
}: {
  view: ProjectDetailView;
  /** P5b (§3.19.11): "/executive/chat?context=project:<id>" while chat is on; null shows no link. */
  askHref?: string | null;
}) {
  const now = view.generatedAt;
  const tz = view.timezone;
  const p = view.project;
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="projects" tabs={EXEC_TABS} />} />
      <div className="space-y-1">
        <Link href="/executive/projects" prefetch={false} className="inline-flex items-center gap-1 text-[12px] font-semibold text-indigo-700 hover:text-indigo-900">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All projects
        </Link>
        <h2 className="break-words text-xl font-bold text-ink">{p.name}</h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
          {p.departmentName && <span>{p.departmentName}</span>}
          <span>Created {formatInZone(p.createdAt, tz, "date", now)}</span>
          <RefLink url={p.ref.url} className="font-semibold text-indigo-700">
            Open in DD
          </RefLink>
          {askHref && (
            <Link href={askHref} prefetch={false} data-ask-about="project" className="font-semibold text-indigo-700 hover:text-indigo-900">
              {ASK_ABOUT_PROJECT_LINK}
            </Link>
          )}
        </p>
      </div>
      <Summary view={view} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Stages view={view} />
          <Updates view={view} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Delays view={view} />
          <Blockers view={view} />
          <MeetingRisks view={view} />
          <Conversations view={view} />
          {/* P7b (§3.12.3, C19): the Slack card after Conversations; absent from a view without the section. */}
          <ProjectSlackSection section={view.slack} derivedNote={derivedNote(view)} tz={tz} now={now} />
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-[11px] text-muted">
        <MessageSquareWarning className="h-3.5 w-3.5" aria-hidden />
        DD doesn’t record dependencies between tasks, so nothing here says what blocks what.
      </p>
    </div>
  );
}
