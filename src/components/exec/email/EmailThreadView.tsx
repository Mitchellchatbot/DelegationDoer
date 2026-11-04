import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, BellRing, Building2, ExternalLink, Handshake, ListChecks, Mail, ShieldAlert, Sparkles } from "lucide-react";
import type { EmailThreadView as EmailThreadData } from "@/lib/exec/email-view";
import { formatCount, formatInZone, pluralize } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import { AttentionRow } from "../AttentionRow";
import { BasisLabel } from "../BasisLabel";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { SectionCard } from "../SectionCard";
import { AssessButton } from "./AssessButton";
import { CommitmentList } from "./CommitmentList";
import { notAssessedReason } from "./EmailRowItem";
import {
  CATEGORY_LABEL,
  CLIENT_SIGNAL_LABEL,
  CONFIDENCE_LABEL,
  EARLIER_ASSESSMENT,
  MATCH_VIA_LABEL,
  SUBJECT_FALLBACK,
  URGENCY_LABEL,
  answeredLabel,
  labelOf,
  personLabel
} from "./labels";
import { MessageCard } from "./MessageCard";
import { Ago, Chip, Unavailable, When } from "./parts";

// /executive/email/[threadId], rendered from an EmailThreadView only. The
// page has already checked the thread is his and passed both restricted-
// sender screens (stored and live) before this renders.
//
// The messages are his only (the copies in his pinned mailbox), newest
// first. When the mail service can't be reached, or his mailbox connection
// needs attention, the page shows what the assistant stored instead, and
// says so. The DD inbox link is offered with its catch: it opens only for
// someone whose DD inbox access covers his mailbox.

const HEALTH_LABEL: Readonly<Record<string, string>> = { thriving: "Thriving", steady: "Steady", shaky: "Shaky", at_risk: "At risk" };

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] text-ink">{children}</dd>
    </div>
  );
}

type ThreadRow = EmailThreadData["thread"];

/** The row carries AI fields: from this assessment, or (state not triaged) from an earlier one. */
const hasAiFields = (t: ThreadRow) =>
  Boolean(t.summary || t.reason || t.decisionQuestion || t.category || t.urgency || t.importance || t.needsReply !== null || t.clientSignal);

function AssessmentBody({ t }: { t: ThreadRow }) {
  return (
    <div className="space-y-3">
      {t.summary && <p className="break-words text-[13.5px] leading-relaxed text-slate-800">{t.summary}</p>}
      {t.reason && (
        <p className="break-words text-[12.5px] text-slate-600">
          <span className="font-semibold text-slate-700">Why it matters: </span>
          {t.reason}
        </p>
      )}
      {t.decisionQuestion && (
        <p className="break-words rounded-lg bg-indigo-50 px-3 py-2 text-[12.5px] text-indigo-900">
          <span className="font-semibold">Decision asked: </span>
          {t.decisionQuestion}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Fact label="Category">{labelOf(CATEGORY_LABEL, t.category) ?? "—"}</Fact>
        <Fact label="Urgency">{labelOf(URGENCY_LABEL, t.urgency) ?? "—"}</Fact>
        <Fact label="Importance">{t.importance ? `${t.importance[0].toUpperCase()}${t.importance.slice(1)}` : "—"}</Fact>
        <Fact label="Needs your reply">{t.needsReply === null ? "—" : t.needsReply ? "Yes" : "No"}</Fact>
        <Fact label="Client signal">{labelOf(CLIENT_SIGNAL_LABEL, t.clientSignal) ?? "—"}</Fact>
      </dl>
    </div>
  );
}

export function EmailThreadView({ view }: { view: EmailThreadData }) {
  const now = view.generatedAt;
  const tz = view.timezone;
  const t = view.thread;
  const subject = t.subject && t.subject.trim() !== "" ? t.subject : SUBJECT_FALLBACK;
  const who = personLabel(t.counterpartName, t.counterpartEmail);
  const outlook = safeLink(view.outlookUrl);
  const inbox = safeLink(view.ddInboxUrl);
  const answered = answeredLabel(t);
  const assessed = t.state === "triaged";

  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="email" tabs={EXEC_TABS} />} />
      <Link href="/executive/email" prefetch={false} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Email
      </Link>

      <section className="rounded-2xl border border-slate-200/70 bg-white px-5 py-4 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-[18px] font-bold leading-snug text-slate-900">{subject}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-slate-600">
              <BasisLabel basis="record" />
              <span className="min-w-0 break-all">
                {who}
                {t.counterpartName && t.counterpartEmail ? <span className="text-muted">{` <${t.counterpartEmail}>`}</span> : null}
              </span>
              <span className="text-muted">{pluralize(t.messageCount, "message")}</span>
              <span className="text-muted">
                Last activity <Ago iso={t.lastActivityAt} now={now} tz={tz} />
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {outlook && (
              <a
                href={outlook.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                Open in Outlook
              </a>
            )}
            {inbox && (
              <span className="inline-flex flex-col items-start">
                <a
                  href={inbox.href}
                  {...(inbox.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink"
                >
                  <Mail className="h-3.5 w-3.5" aria-hidden />
                  Open in DD inbox
                </a>
                <span className="mt-0.5 text-[10.5px] text-muted">needs DD inbox access</span>
              </span>
            )}
            {t.assessable && <AssessButton threadId={view.threadId} size="md" />}
          </div>
        </div>
      </section>

      {view.mode === "clone_unavailable" && (
        <Unavailable>Couldn&apos;t reach the mail service just now, so the messages aren&apos;t shown. What the assistant stored about this thread is below.</Unavailable>
      )}
      {view.mode === "account_problem" && (
        <Unavailable>
          Mailbox connection needs attention, so nothing is read from it until the team fixes it. What the assistant stored about this thread is below.
        </Unavailable>
      )}
      {view.bodiesFailed && <Unavailable>Some message text couldn&apos;t be loaded in time. Reload to try again.</Unavailable>}
      {view.partialThread && (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-[12.5px] text-slate-600">
          Part of this conversation isn&apos;t in your synced folders, so earlier messages may be missing.
        </p>
      )}
      {t.injectionSuspected && (
        <p className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-[12.5px] text-rose-800">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>This email seems to contain instructions aimed at the assistant. Its assessment may be off; read the messages yourself.</span>
        </p>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <SectionCard title="Assessment" icon={Sparkles} basis={assessed ? "ai" : "derived"} subtitle={assessed && t.triagedAt ? <>Assessed <Ago iso={t.triagedAt} now={now} tz={tz} /></> : undefined}>
            {assessed ? (
              <AssessmentBody t={t} />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-slate-700">
                  <span>{notAssessedReason(t)}</span>
                  {t.assessable && <AssessButton threadId={view.threadId} />}
                </div>
                {hasAiFields(t) && (
                  // Why it may still sit in an AI bucket: the last assessment's reading (ui-6).
                  <div className="space-y-2 border-t border-slate-100 pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11.5px] font-semibold text-slate-600">{EARLIER_ASSESSMENT}</span>
                      <BasisLabel basis="ai" />
                    </div>
                    <AssessmentBody t={t} />
                  </div>
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Status" basis="derived">
            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Reply">
                {answered ?? "—"}
                {view.answeredUnchecked && <span className="block text-[11px] text-amber-800">Outlook and DD drafts couldn&apos;t be checked</span>}
                {t.answered === "answered" && view.thread.answeredAt ? (
                  <span className="block text-[11px] text-muted">
                    <When iso={view.thread.answeredAt} now={now} tz={tz} />
                  </span>
                ) : null}
              </Fact>
              <Fact label="Client">
                {t.client ? (
                  <>
                    {t.client.name}
                    <span className="block text-[11px] text-muted">
                      {[labelOf(MATCH_VIA_LABEL, t.client.via), labelOf(CONFIDENCE_LABEL, t.client.confidence)].filter(Boolean).join(", ")}
                    </span>
                  </>
                ) : (
                  "No client matched"
                )}
              </Fact>
            </dl>
          </SectionCard>

          {view.messages !== null && (
            <section aria-label="Messages" className="flex min-w-0 flex-col gap-3">
              <h2 className="text-[13px] font-semibold text-ink">{`Messages (${formatCount(view.messages.length)})`}</h2>
              {view.messages.length === 0 ? (
                <p className="text-[12.5px] text-muted">No messages from your mailbox.</p>
              ) : (
                view.messages.map((m) => <MessageCard key={m.id} message={m} tz={tz} now={now} />)
              )}
            </section>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {view.commitments.ok ? (
            <SectionCard
              title="Commitments"
              icon={Handshake}
              empty={view.commitments.data.length === 0 ? "No commitments found in this thread." : undefined}
              padded={false}
            >
              <CommitmentList items={view.commitments.data} tz={tz} now={now} showThread={false} showEvidence />
            </SectionCard>
          ) : (
            <SectionCard title="Commitments" icon={Handshake} error />
          )}

          {view.attention.ok ? (
            <SectionCard
              title="Needs attention"
              icon={BellRing}
              empty={view.attention.data.length === 0 ? "No Needs Attention items about this thread." : undefined}
              padded={false}
            >
              <div className="divide-y divide-slate-100">
                {view.attention.data.map((item) => (
                  <AttentionRow key={item.id} item={item} now={now} tz={tz} />
                ))}
              </div>
            </SectionCard>
          ) : (
            <SectionCard title="Needs attention" icon={BellRing} error />
          )}

          {view.tasks.ok ? (
            <SectionCard
              title="Linked tasks"
              icon={ListChecks}
              basis="record"
              empty={view.tasks.data.length === 0 ? "No DD tasks came from this thread." : undefined}
              padded={false}
            >
              <ul className="divide-y divide-slate-100">
                {view.tasks.data.map((task) => (
                  <li key={task.id} className="px-4 py-2.5">
                    <Link href={task.href} prefetch={false} className="break-words text-[13px] font-medium text-ink hover:text-indigo-700">
                      {task.title || "Untitled task"}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-muted">
                      <span>{task.status.replace(/_/g, " ")}</span>
                      {task.isDraft && <span>draft</span>}
                      {task.dueDate && <span>{`due ${formatInZone(task.dueDate, tz, "date", now)}`}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : (
            <SectionCard title="Linked tasks" icon={ListChecks} error />
          )}

          {view.client.ok ? (
            view.client.data === null ? null : (
              <SectionCard title="Client" icon={Building2} basis="derived" subtitle={view.client.data.name}>
                <dl className="grid grid-cols-2 gap-3">
                  <Fact label="Matched by">
                    {[labelOf(MATCH_VIA_LABEL, view.client.data.via), labelOf(CONFIDENCE_LABEL, view.client.data.confidence)].filter(Boolean).join(", ") || "—"}
                    {view.client.data.candidates > 1 && (
                      <span className="block text-[11px] text-muted">{`${formatCount(view.client.data.candidates)} clients share this address`}</span>
                    )}
                  </Fact>
                  <Fact label="Health in DD">
                    {view.client.data.health ? (HEALTH_LABEL[view.client.data.health] ?? view.client.data.health) : "—"}
                    {view.client.data.healthOverridden && <span className="block text-[11px] text-muted">set by a leader</span>}
                  </Fact>
                </dl>
                {view.client.data.meetings.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Recent meetings</div>
                    <ul className="mt-1 space-y-1">
                      {view.client.data.meetings.map((m) => (
                        <li key={m.id} className="flex items-start justify-between gap-2 text-[12.5px]">
                          <span className="min-w-0 break-words text-slate-700">{m.title || "Meeting"}</span>
                          <When iso={m.meetingAt} now={now} tz={tz} mode="date" className="shrink-0 text-[11.5px] text-muted" />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {view.client.data.id && (
                  <Link
                    href={`/clients/${encodeURIComponent(view.client.data.id)}`}
                    prefetch={false}
                    className="mt-3 inline-block text-[12px] font-medium text-indigo-700 underline-offset-2 hover:underline"
                  >
                    Open the client in DD
                  </Link>
                )}
              </SectionCard>
            )
          ) : (
            <SectionCard title="Client" icon={Building2} error />
          )}
        </div>
      </div>
    </div>
  );
}
