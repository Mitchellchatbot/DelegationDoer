import Link from "next/link";
import { FilePen, FileX, MailPlus, ShieldAlert, TriangleAlert } from "lucide-react";
import type { DraftAttention, DraftListItem, ExecDraftStatus } from "@/lib/exec/drafts-types";
import { draftPageHref } from "@/lib/exec/drafts-links";
import { formatCount } from "@/lib/exec/format";
import { BasisLabel } from "../BasisLabel";
import { EmptyState } from "../EmptyState";
import { Ago, Chip, type ChipTone } from "../email/parts";
import { ATTENTION_REASON, COPY, STATUS_CHIP } from "./copy";

// The Email tab's Drafts view (P4 contract §3.13.5, L16, C46): his assistant
// drafts that are still open, then the ones sent in the last 7 days. Rows
// that need him come first, each with a short reason. A restricted row shows
// only that it exists: no subject, no recipients (C11). The section stands on
// its own: a failed read, drafts switched off, or the feature not set up
// each get their own sentence, never an empty list. Server component, text
// only; every link is a DD page.

export type DraftsBucketState = "ok" | "unavailable" | "off" | "not_installed";

// C46's attention order; rows without a reason keep the order they came in.
const ATTENTION_ORDER: readonly DraftAttention[] = ["unknown", "sent_mismatch", "gone_unconfirmed", "outlook_changed", "generation_failed", "restricted", "stale_link"];
const rank = (a: DraftAttention | null): number => (a === null ? ATTENTION_ORDER.length : Math.max(0, ATTENTION_ORDER.indexOf(a)));

/** Attention rows first (C46 order), the rest as given. Stable. */
export function orderDraftItems(items: readonly DraftListItem[]): DraftListItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.attention) - rank(b.item.attention) || a.i - b.i)
    .map(({ item }) => item);
}

const STATUS_TONE: Readonly<Record<ExecDraftStatus, ChipTone>> = {
  generating: "indigo",
  generation_failed: "rose",
  draft: "slate",
  saving: "indigo",
  saved: "sky",
  sending: "indigo",
  sent_pending: "emerald",
  unknown: "rose",
  sent: "emerald",
  sent_external: "emerald",
  gone: "amber",
  discarding: "slate",
  discarded: "slate"
};

function DraftRow({ item, tz, nowIso }: { item: DraftListItem; tz: string; nowIso: string }) {
  const href = draftPageHref(item.id);
  const at = item.sentAt ?? item.updatedAt;
  if (item.restricted) {
    return (
      <li data-draft-row={item.id} data-restricted="true" className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <Link href={href} prefetch={false} className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-slate-700 hover:text-indigo-700">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
            {COPY.restrictedRow}
          </Link>
          <Ago iso={at} now={nowIso} tz={tz} className="shrink-0 pt-0.5 text-[11.5px] tabular-nums text-muted" />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Chip tone={STATUS_TONE[item.status] ?? "slate"}>{STATUS_CHIP[item.status] ?? item.status}</Chip>
          {item.attention && item.attention !== "restricted" && <Chip tone="rose">{ATTENTION_REASON[item.attention]}</Chip>}
        </div>
      </li>
    );
  }
  const label = item.label && item.label.trim() !== "" ? item.label : "(no subject)";
  return (
    <li data-draft-row={item.id} className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <Link href={href} prefetch={false} className="min-w-0 break-words text-[13.5px] font-semibold text-ink hover:text-indigo-700">
          {label}
        </Link>
        <Ago iso={at} now={nowIso} tz={tz} className="shrink-0 pt-0.5 text-[11.5px] tabular-nums text-muted" />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-slate-600">
        <Chip tone={STATUS_TONE[item.status] ?? "slate"}>{STATUS_CHIP[item.status] ?? item.status}</Chip>
        {item.attention && (
          <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-rose-700">
            <TriangleAlert className="h-3 w-3" aria-hidden />
            {ATTENTION_REASON[item.attention] ?? item.attention}
          </span>
        )}
        <span className="min-w-0 break-all">{item.toSummary ? `To ${item.toSummary}` : "No recipients yet"}</span>
        <span className="text-muted">{item.kind === "new" ? "New email" : "Reply"}</span>
      </div>
    </li>
  );
}

export function DraftsBucket({
  state,
  items,
  tz,
  nowIso,
  newEmailHref,
  draftsOn
}: {
  state: DraftsBucketState;
  items: DraftListItem[];
  tz: string;
  nowIso: string;
  newEmailHref: string;
  draftsOn: boolean;
}) {
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-[11.5px] text-muted">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <BasisLabel basis="record" />
        <span className="min-w-0 break-words">Open drafts first, then the ones sent in the last 7 days.</span>
      </span>
      {state === "ok" && draftsOn && (
        <Link
          href={newEmailHref}
          prefetch={false}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink"
        >
          <MailPlus className="h-3.5 w-3.5" aria-hidden />
          New email
        </Link>
      )}
    </div>
  );

  if (state === "unavailable") {
    return (
      <div data-drafts-bucket="unavailable" className="min-w-0">
        {header}
        <p role="status" className="m-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{COPY.bucketUnavailable}</span>
        </p>
      </div>
    );
  }
  if (state === "off" || state === "not_installed") {
    return (
      <div data-drafts-bucket={state} className="min-w-0">
        {header}
        <EmptyState icon={FileX} message={state === "off" ? COPY.bucketOff : COPY.bucketNotInstalled} />
      </div>
    );
  }

  const rows = orderDraftItems(items);
  const attention = rows.filter((r) => r.attention !== null).length;
  return (
    <div data-drafts-bucket="ok" className="min-w-0">
      {header}
      {rows.length === 0 ? (
        <EmptyState icon={FilePen} message={COPY.bucketEmpty} />
      ) : (
        <>
          {attention > 0 && (
            <p className="border-b border-slate-100 px-4 py-2 text-[11.5px] font-medium text-rose-700">
              {`${formatCount(attention)} ${attention === 1 ? "draft needs" : "drafts need"} you`}
            </p>
          )}
          <ul className="divide-y divide-slate-100">
            {rows.map((item) => (
              <DraftRow key={item.id} item={item} tz={tz} nowIso={nowIso} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
