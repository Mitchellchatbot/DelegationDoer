import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { formatCount } from "@/lib/exec/format";
import type { OverviewApprovals, OverviewSection } from "@/lib/exec/overview";
import type { ApprovalBucket, ApprovalMechanism } from "@/lib/exec/sources/dd-types";
import { cn } from "@/lib/utils";
import { SectionCard } from "../SectionCard";
import { ago } from "./labels";

// Everything waiting on an approval, one row per mechanism (the six of
// p2b-schema §5), each with where in DD it is handled. While anything waits,
// every mechanism stays listed, zeros included: a zero here is a count that
// was read, so "none" is the fact.

interface Place {
  label: string;
  href: string;
}

const MECHANISMS: Readonly<Record<ApprovalMechanism, { label: string; places: readonly Place[]; note?: string }>> = {
  // Email-intake drafts are reviewed on the Routing tab, meeting (tl;dv) drafts on Meetings.
  draft_tasks: {
    label: "Draft tasks",
    places: [
      { label: "Routing", href: "/approvals?tab=routing" },
      { label: "Meetings", href: "/approvals?tab=meetings" }
    ]
  },
  // The board narrowed to its one waiting-for-approval column (the same deep
  // link the Leader Console uses).
  fb_proofs: { label: "Facebook proofs", places: [{ label: "Board", href: "/tasks/board?status=pending_approval&groupBy=status" }] },
  email_drafts: { label: "Email drafts", places: [{ label: "Emails", href: "/approvals?tab=emails" }] },
  unrouted_mail: { label: "Unrouted mail", places: [{ label: "Routing", href: "/approvals?tab=routing" }] },
  // The queue covers the last 7 ET days; EOD history is where earlier days are marked reviewed.
  eod_reviews: { label: "EOD reviews", places: [{ label: "EOD history", href: "/eod/history" }] },
  // The daily brief's Send buttons live in Slack; DD has no page for them.
  checkins: { label: "Check-ins", places: [], note: "In your Slack brief" }
};

function waitingFor(bucket: ApprovalBucket, now: string): string {
  if (bucket.count === 0) return "None waiting";
  return bucket.oldestAt === null ? "Oldest: age unknown" : `Oldest ${ago(bucket.oldestAt, now)}`;
}

function ApprovalRow({ bucket, now }: { bucket: ApprovalBucket; now: string }) {
  // A mechanism this build doesn't know is named as stored, with no link.
  const meta = MECHANISMS[bucket.mechanism] ?? { label: String(bucket.mechanism), places: [] };
  const waiting = bucket.count > 0;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={cn("text-[13px] font-medium", waiting ? "text-ink" : "text-slate-500")}>{meta.label}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
          <span>{waitingFor(bucket, now)}</span>
          {meta.places.map((place) => (
            <Link key={place.href} href={place.href} prefetch={false} className="font-medium text-accent underline-offset-2 hover:underline">
              {place.label}
            </Link>
          ))}
          {meta.note && <span>{meta.note}</span>}
        </div>
      </div>
      <span className={cn("shrink-0 text-[16px] font-semibold tabular-nums", waiting ? "text-ink" : "text-slate-400")}>
        {formatCount(bucket.count)}
      </span>
    </li>
  );
}

export function ApprovalsSection({ approvals, now }: { approvals: OverviewSection<OverviewApprovals>; now: string }) {
  if (!approvals.ok) return <SectionCard title="Pending approvals" icon={ClipboardCheck} error />;
  const { buckets, total } = approvals.data;
  return (
    <SectionCard
      title="Pending approvals"
      icon={ClipboardCheck}
      basis="record"
      action={`${formatCount(total)} waiting`}
      empty={total === 0 ? "Nothing is waiting on an approval." : undefined}
      padded={false}
    >
      <ul className="divide-y divide-slate-100">
        {buckets.map((bucket) => (
          <ApprovalRow key={bucket.mechanism} bucket={bucket} now={now} />
        ))}
      </ul>
    </SectionCard>
  );
}
