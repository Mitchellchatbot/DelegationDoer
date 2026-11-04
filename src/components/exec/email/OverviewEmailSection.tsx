import Link from "next/link";
import { Mail } from "lucide-react";
import type { EmailBucket } from "@/lib/exec/email-types";
import { formatCount, pluralize } from "@/lib/exec/format";
import type { OverviewEmail, OverviewSection } from "@/lib/exec/overview";
import { BasisLabel } from "../BasisLabel";
import { SectionCard } from "../SectionCard";
import { CommitmentList } from "./CommitmentList";
import { BUCKET_META, BUCKET_ORDER } from "./labels";
import { Unavailable } from "./parts";

// Email on the Overview: the Email tab's bucket counts, the open commitments
// due within a week, and how many threads the restricted-sender rules hide.
// Off and "no mailbox pinned" say so in one line; a part that couldn't be
// read says so in its place, never as a zero. Before the first sync the
// counts and the commitments are unknowns, not zeros: the card says it
// hasn't synced yet (ui-5).

const SHORT_LABEL: Readonly<Record<EmailBucket, string>> = {
  reply: "Needs reply",
  urgent: "Urgent",
  important: "Important",
  waiting: "Waiting on others",
  filtered: "Not assessed"
};

const tabHref = (bucket: EmailBucket) => `/executive/email?bucket=${bucket}`;

export function OverviewEmailSection({ email, tz, now }: { email: OverviewSection<OverviewEmail>; tz: string; now: string }) {
  const open = (
    <Link href="/executive/email" prefetch={false} className="font-medium text-accent underline-offset-2 hover:underline">
      Open Email
    </Link>
  );
  if (!email.ok) return <SectionCard title="Email" icon={Mail} error />;
  const e = email.data;
  const counts = e.state === "on" && e.counts.ok ? e.counts.data : null;
  if (e.state === "off") {
    return <SectionCard title="Email" icon={Mail} empty="Email intelligence is off — the team turns it on." />;
  }
  if (e.state === "no_pin") {
    return <SectionCard title="Email" icon={Mail} empty="No mailbox is pinned yet." />;
  }
  const notSynced = e.mail.ok && e.mail.data.checkedAt === null;
  return (
    <SectionCard title="Email" icon={Mail} action={open} padded={false}>
      <div className="space-y-3 p-4">
        {notSynced ? (
          <p role="status" className="text-[12.5px] text-amber-800">
            Not synced yet. The first sync runs within about 5 minutes of email being turned on; until then there is nothing to count.
          </p>
        ) : e.counts.ok ? (
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Your mail</span>
              <BasisLabel basis="ai" />
            </div>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {BUCKET_ORDER.map((b) => (
                <div key={b} className="min-w-0">
                  <dt className="truncate text-[11px] text-muted" title={BUCKET_META[b].rule}>
                    {SHORT_LABEL[b]}
                  </dt>
                  <dd className="text-[16px] font-semibold tabular-nums text-ink">
                    <Link href={tabHref(b)} prefetch={false} className="hover:text-indigo-700">
                      {formatCount(counts ? counts[b] : null)}
                    </Link>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <Unavailable>Couldn&apos;t load your email counts.</Unavailable>
        )}
        {e.restricted.ok ? (
          e.restricted.data > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
              <BasisLabel basis="derived" />
              {`${pluralize(e.restricted.data, "thread")} hidden by the restricted-sender rules.`}
            </p>
          )
        ) : (
          <Unavailable>Couldn&apos;t check how many threads are hidden.</Unavailable>
        )}
      </div>
      <div className="border-t border-slate-100">
        <div className="px-4 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
          {`Commitments due within ${e.commitments.ok ? e.commitments.data.days : 7} days`}
        </div>
        {e.commitments.ok ? (
          e.commitments.data.total === 0 ? (
            <p className="px-4 pb-3 text-[12.5px] text-muted">{notSynced ? "None found yet: your mail hasn't been read." : "Nothing due this week."}</p>
          ) : (
            <>
              <CommitmentList items={e.commitments.data.items} tz={tz} now={now} />
              {e.commitments.data.total > e.commitments.data.items.length && (
                <p className="px-4 pb-3 text-[11.5px] text-muted">{`Showing ${formatCount(e.commitments.data.items.length)} of ${formatCount(e.commitments.data.total)}.`}</p>
              )}
            </>
          )
        ) : (
          <div className="px-4 pb-3">
            <Unavailable>Couldn&apos;t load your commitments.</Unavailable>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
