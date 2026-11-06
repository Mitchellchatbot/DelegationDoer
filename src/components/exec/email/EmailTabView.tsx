import Link from "next/link";
import { EyeOff, FileClock, FilePen, Handshake, Inbox, MailX, PlugZap } from "lucide-react";
import type { EmailBucket } from "@/lib/exec/email-types";
import type { EmailBucketsView, EmailFreshness, EmailTabView as EmailTabData } from "@/lib/exec/email-view";
import { formatCount, pluralize } from "@/lib/exec/format";
import { NEW_EMAIL_HREF } from "@/lib/exec/drafts-links";
import { BasisLabel } from "../BasisLabel";
import { DraftsBucket } from "../drafts/DraftsBucket";
import { EmptyState } from "../EmptyState";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { SectionCard } from "../SectionCard";
import { BucketTabs } from "./BucketTabs";
import { CommitmentList } from "./CommitmentList";
import { EmailRowItem } from "./EmailRowItem";
import { EmailStatusPanel } from "./EmailStatusPanel";
import { BUCKET_META, BUCKET_ORDER, EMPTY_STATUS_UNKNOWN, EMPTY_WHILE_CATCHING_UP } from "./labels";

// /executive/email, rendered from an EmailTabView and nothing else: no reads,
// no clock (every age is measured from view.generatedAt), so the server's
// HTML is the page and a fixture renders it exactly.
//
// Off and "no mailbox pinned" are whole-page states. When on, the mail
// status sits on top, the buckets (one switcher, every list server-rendered)
// on the left, and commitments, drafts and the restricted count on the right.
// Each card stands alone: a read that failed says "couldn't load" in its card
// and nowhere else, never a zero. An empty list is stated as a fact only once
// the assistant has read his mail; before that it says so.

/**
 * Whether an empty bucket is a fact (ui-5): "complete" once his mailboxes
 * were checked and nothing is being caught up on; "incomplete" before the
 * first sync or while the backfill and the queue catch up; "unknown" when the
 * mail status couldn't be read.
 */
export type MailCoverage = "complete" | "incomplete" | "unknown";

export function mailCoverage(freshness: EmailFreshness): MailCoverage {
  const { accounts, sync } = freshness;
  if (!accounts.ok || !sync.ok) return "unknown";
  return accounts.data.checkedAt === null || sync.data.catchingUp ? "incomplete" : "complete";
}

const EMPTY_COPY: Readonly<Record<Exclude<MailCoverage, "complete">, string>> = {
  incomplete: EMPTY_WHILE_CATCHING_UP,
  unknown: EMPTY_STATUS_UNKNOWN
};

function BucketPanel({ bucket, data, tz, now, coverage }: { bucket: EmailBucket; data: EmailBucketsView; tz: string; now: string; coverage: MailCoverage }) {
  const meta = BUCKET_META[bucket];
  const rows = data.lists[bucket];
  const total = data.counts[bucket];
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-[11.5px] text-muted">
        <BasisLabel basis={meta.basis} />
        <span className="min-w-0 break-words">
          <span className="font-semibold text-slate-700">{`${meta.label}. `}</span>
          {meta.rule}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState message={coverage === "complete" ? meta.empty : EMPTY_COPY[coverage]} />
      ) : (
        <>
          <ul className="divide-y divide-slate-100">
            {rows.map((row) => (
              <EmailRowItem key={row.threadId} row={row} tz={tz} now={now} />
            ))}
          </ul>
          {total > rows.length && (
            <p className="border-t border-slate-100 px-4 py-2 text-[11.5px] text-muted">{`Showing the newest ${formatCount(rows.length)} of ${formatCount(total)}.`}</p>
          )}
        </>
      )}
    </div>
  );
}

function WholePage({ icon, message, detail }: { icon: typeof Inbox; message: string; detail: string }) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft">
      <EmptyState icon={icon} message={message} detail={detail} className="py-14" />
    </section>
  );
}

/** "N (M need attention)", or "couldn't load" for a count that wasn't read (never a zero). */
export function execDraftCountLabel(active: number | null, attention: number | null): string {
  if (active === null) return "couldn't load";
  if (attention === null) return `${formatCount(active)} (attention couldn't load)`;
  return attention > 0 ? `${formatCount(active)} (${formatCount(attention)} need attention)` : formatCount(active);
}

const LINK_PILL =
  "inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink";

export function EmailTabView({ view, bucket }: { view: EmailTabData; bucket?: string }) {
  const now = view.generatedAt;
  const tz = view.timezone;
  const header = <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="email" tabs={EXEC_TABS} />} />;

  if (view.state === "off") {
    return (
      <div className="space-y-5">
        {header}
        <WholePage
          icon={MailX}
          message="Email intelligence is off — the team turns it on"
          detail="Once it is on and your mailbox is pinned, the assistant reads your new mail and sorts it here."
        />
      </div>
    );
  }
  if (view.state === "no_pin") {
    return (
      <div className="space-y-5">
        {header}
        <WholePage
          icon={PlugZap}
          message="No mailbox is pinned yet"
          detail="Email intelligence is on, but no mailbox is linked to you. The team pins yours, then mail starts showing here."
        />
      </div>
    );
  }

  const { buckets, restricted, drafts, commitments } = view;
  // P4: the Drafts view is its own section, picked by ?bucket=drafts (not an email bucket).
  const draftsBucket = view.draftsBucket;
  const showDrafts = bucket === "drafts";
  const coverage = mailCoverage(view.freshness);
  // Before the first sync there is nothing to count: a "0" there would be an unknown shown as a fact (ui-5).
  const notSynced = view.freshness.accounts.ok && view.freshness.accounts.data.checkedAt === null;
  const tabs = BUCKET_ORDER.map((b) => ({ key: b, label: BUCKET_META[b].tab, count: buckets.ok && !notSynced ? buckets.data.counts[b] : null }));
  const panels = buckets.ok
    ? Object.fromEntries(BUCKET_ORDER.map((b) => [b, <BucketPanel key={b} bucket={b} data={buckets.data} tz={tz} now={now} coverage={coverage} />]))
    : {};

  return (
    <div className="space-y-5">
      {header}
      <EmailStatusPanel freshness={view.freshness} now={now} tz={tz} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {showDrafts ? (
          <SectionCard
            title="Assistant drafts"
            icon={FilePen}
            subtitle="Replies and new emails the assistant drafted with you"
            action={
              <Link href="/executive/email" prefetch={false} className={LINK_PILL}>
                <Inbox className="h-3.5 w-3.5" aria-hidden />
                All email
              </Link>
            }
            padded={false}
          >
            <DraftsBucket
              state={draftsBucket?.state ?? "not_installed"}
              items={draftsBucket?.items ?? []}
              tz={tz}
              nowIso={now}
              newEmailHref={NEW_EMAIL_HREF}
              draftsOn={draftsBucket?.draftsOn ?? false}
            />
          </SectionCard>
        ) : buckets.ok ? (
          <SectionCard
            title="Email"
            icon={Inbox}
            subtitle="Your mail from the last 30 days, sorted by the assistant"
            action={
              draftsBucket ? (
                <Link href="/executive/email?bucket=drafts" prefetch={false} className={LINK_PILL}>
                  <FilePen className="h-3.5 w-3.5" aria-hidden />
                  Assistant drafts
                </Link>
              ) : undefined
            }
            padded={false}
          >
            <BucketTabs tabs={tabs} panels={panels} initial={bucket ?? "reply"} />
          </SectionCard>
        ) : (
          <SectionCard title="Email" icon={Inbox} error="Couldn't load your email right now. Reload the page to try again." />
        )}

        <div className="flex min-w-0 flex-col gap-5">
          {commitments.ok ? (
            <SectionCard
              title="Commitments"
              icon={Handshake}
              subtitle="Promises found in your mail, overdue first"
              action={commitments.data.total > 0 ? `${formatCount(commitments.data.total)} open` : undefined}
              empty={commitments.data.total === 0 ? (coverage === "complete" ? "No open commitments." : EMPTY_COPY[coverage]) : undefined}
              padded={false}
            >
              <CommitmentList items={commitments.data.items} tz={tz} now={now} />
              {commitments.data.total > commitments.data.items.length && (
                <p className="border-t border-slate-100 px-4 py-2 text-[11.5px] text-muted">
                  {`Showing ${formatCount(commitments.data.items.length)} of ${formatCount(commitments.data.total)}.`}
                </p>
              )}
            </SectionCard>
          ) : (
            <SectionCard title="Commitments" icon={Handshake} error />
          )}

          {drafts.ok ? (
            <SectionCard
              title="Drafts"
              icon={FileClock}
              basis="record"
              subtitle="Replies waiting in DD for your mailbox"
              action={
                draftsBucket && !showDrafts ? (
                  <Link href="/executive/email?bucket=drafts" prefetch={false} className="text-[12px] font-semibold text-indigo-700 hover:text-indigo-900">
                    Open drafts
                  </Link>
                ) : undefined
              }
            >
              {draftsBucket && (
                <div data-exec-drafts-count className="mb-3 border-b border-slate-100 pb-3">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Assistant drafts</div>
                  <div className="mt-0.5 text-[18px] font-semibold tabular-nums text-ink">
                    {execDraftCountLabel(drafts.data.execDraftsActive, drafts.data.execDraftsAttention)}
                  </div>
                </div>
              )}
              <dl className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Awaiting approval</dt>
                  <dd className="mt-0.5 text-[18px] font-semibold tabular-nums text-ink">{formatCount(drafts.data.draftsPending)}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Scheduled to send</dt>
                  <dd className="mt-0.5 text-[18px] font-semibold tabular-nums text-ink">{formatCount(drafts.data.scheduledReplies)}</dd>
                </div>
              </dl>
            </SectionCard>
          ) : (
            <SectionCard title="Drafts" icon={FileClock} error />
          )}

          {restricted.ok ? (
            <SectionCard title="Restricted senders" icon={EyeOff} basis="derived">
              <p className="text-[12.5px] text-slate-700">
                {restricted.data === 0
                  ? "No threads are hidden by the restricted-sender rules."
                  : `${pluralize(restricted.data, "thread")} hidden by the restricted-sender rules. Their content isn't shown or kept here.`}
              </p>
            </SectionCard>
          ) : (
            <SectionCard title="Restricted senders" icon={EyeOff} error />
          )}
        </div>
      </div>
    </div>
  );
}
