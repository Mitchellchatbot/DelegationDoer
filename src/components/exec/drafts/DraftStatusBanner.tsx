import type { Ref } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import type { DraftView } from "@/lib/exec/drafts-types";
import { cn } from "@/lib/utils";
import { SafeMarkdown } from "../SafeMarkdown";
import { canRecheckReadiness, draftAdvisories, lastErrorNotice, statusBanner, unavailableNotice, type BannerTone } from "./banner";
import { COPY } from "./copy";
import { pollErrorCopy } from "./poll";

// The draft's state as words (P4 contract §3.13.4): the poll-error line, the
// "drafts unavailable" line, a last-error sentence the row doesn't name, the
// headline, then the row's extra lines (the assistant's note through
// SafeMarkdown, the facts and output-flag banners, the UTC note). Props only,
// server-renderable; every string is React text.

const TONE: Readonly<Record<BannerTone, string>> = {
  info: "border-slate-200 bg-slate-50 text-slate-800",
  progress: "border-indigo-200 bg-indigo-50 text-indigo-900",
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-900",
  muted: "border-slate-200 bg-white text-slate-600"
};

function Notice({ children, tone = "warn" }: { children: string; tone?: "warn" | "danger" }) {
  return (
    <p role="status" className={cn("flex items-start gap-2 rounded-xl border px-3.5 py-2 text-[12.5px]", TONE[tone])}>
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function DraftStatusBanner({
  view,
  tz,
  nowIso,
  pollFailures = 0,
  clientName = null,
  onRecheck,
  rechecking = false,
  headlineRef
}: {
  view: DraftView;
  tz: string;
  nowIso: string;
  /** Polls that failed in a row (C42): 1+ shows "Couldn't refresh. Retrying…", 3+ "Reload the page." */
  pollFailures?: number;
  /** The facts client's name, for the "No client status used" reason (DD data). */
  clientName?: string | null;
  /** ui-2 (additive): re-prove the drafts readiness from the "drafts unavailable" notice. */
  onRecheck?: () => void;
  rechecking?: boolean;
  /** P9 F27: the headline, for DraftPanel to move focus to (a tabIndex -1 status line). */
  headlineRef?: Ref<HTMLParagraphElement>;
}) {
  const banner = statusBanner(view, nowIso, tz);
  const poll = pollErrorCopy(pollFailures);
  const unavailable = unavailableNotice(view);
  const notice = lastErrorNotice(view);
  const advisories = draftAdvisories(view, clientName);
  const showNote = !view.restricted && (view.status === "draft" || view.status === "saved") && typeof view.noteForMitchell === "string" && view.noteForMitchell.trim() !== "";
  return (
    <div data-banner={view.status} className="space-y-2">
      {poll && <Notice tone={pollFailures >= 3 ? "danger" : "warn"}>{poll}</Notice>}
      {unavailable && <Notice>{unavailable}</Notice>}
      {unavailable && onRecheck && canRecheckReadiness(view) && (
        <button
          type="button"
          data-action="recheck_readiness"
          disabled={rechecking}
          onClick={() => onRecheck()}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-slate-50 disabled:opacity-60"
        >
          {rechecking ? COPY.recheckingReadiness : COPY.recheckReadiness}
        </button>
      )}
      {notice && <Notice>{notice}</Notice>}
      <div className={cn("rounded-xl border px-4 py-3", TONE[banner.tone])}>
        {/* P9 F27: one persistent status region whose text changes with the draft's state (save, send, discard are
            announced), and the place focus goes when the pressed button is gone (DraftPanel). */}
        <p ref={headlineRef} tabIndex={-1} role="status" aria-live="polite" data-banner-headline className="text-[13.5px] font-semibold leading-snug outline-none">
          {banner.headline}
        </p>
        {banner.notes.map((line) => (
          <p key={line} className="mt-1 text-[12px] opacity-90">
            {line}
          </p>
        ))}
      </div>
      {showNote && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Note from the assistant</div>
          <SafeMarkdown content={view.noteForMitchell ?? ""} className="mt-1 text-[12.5px]" />
        </div>
      )}
      {advisories.map((line) => (
        <Notice key={line}>{line}</Notice>
      ))}
      {!view.restricted && view.injectionSuspected && (
        <p className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-[12.5px] text-rose-800">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{COPY.injectionWarning}</span>
        </p>
      )}
    </div>
  );
}
