import type { ReactNode } from "react";
import Link from "next/link";
import { CalendarClock, CircleSlash, Hammer, Newspaper, Sparkles, TriangleAlert, Wallet } from "lucide-react";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import type { BriefSectionKey } from "@/lib/exec/brief-types";
import type { BriefContentView, BriefPageView } from "@/lib/exec/brief-view";
import { formatCount, formatInZone } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import { cn } from "@/lib/utils";
import { BasisLabel } from "../BasisLabel";
import { PriorityBandBadge } from "../PriorityBandBadge";
import { CheckinList } from "./CheckinList";

// /executive/brief's body (P8 contract §3.17.3, M3-M5, C31): rendered from a BriefPageView and nothing else (no reads, no
// clock: every time is the view's), so the server's HTML is the whole page and a fixture renders it exactly.
//
// By state: not_installed, off (with a Settings link), none (when it's due), building, then ready / failed: the status
// line, the mode line, the headline, "Your top 3", each section in BRIEF_SECTION_KEYS order (its title, its counters, its
// lines with their basis label and the Suggested tag, their source links, the still-pending lines, the unchanged and
// more-in-DD counts, or the section's state line), the restricted-sender count, the finance line with its one link (M5),
// then the check-ins. Every model or DD string renders as React text (never raw HTML, P3's route-files
// rule). Withheld lines were already replaced by brief-view.ts (C31); here they only look muted and carry no link.

/** The named counters a section's context line shows, in this order (C's stats; anything else, and "more", is never shown). */
const STAT_LABELS: Readonly<Partial<Record<BriefSectionKey, readonly (readonly [key: string, one: string, many: string])[]>>> = {
  emails: [
    ["reply", "to reply", "to reply"], ["urgent", "urgent", "urgent"], ["important", "important", "important"],
    ["waiting", "waiting on others", "waiting on others"], ["decisionAsks", "decision asked of you", "decisions asked of you"]
  ],
  // AM-P8-28: Slack commitments are only ones others made to him.
  slack: [["requests", "request", "requests"], ["decisions", "decision", "decisions"], ["commitments", "owed to you", "owed to you"], ["notAssessed", "not assessed", "not assessed"]],
  progress: [
    ["completedToday", "completed today", "completed today"], ["createdToday", "created today", "created today"],
    ["activePeople", "person active", "people active"], ["eodSubmitted", "EOD submitted", "EODs submitted"], ["hoursLogged", "hour logged", "hours logged"]
  ],
  work: [["completedYesterday", "completed yesterday", "completed yesterday"], ["openOverdue", "open past due", "open past due"]],
  delayed: [["offTrack", "off track", "off track"], ["atRisk", "at risk", "at risk"]],
  approvals: [
    ["draft_tasks", "AI-drafted task", "AI-drafted tasks"], ["fb_proofs", "Facebook proof", "Facebook proofs"], ["email_drafts", "email draft", "email drafts"],
    ["unrouted_mail", "intake email to route", "intake emails to route"], ["eod_reviews", "EOD report", "EOD reports"]
  ],
  commitments: [["emailOverdue", "overdue email commitment", "overdue email commitments"]]
};

/** A section's counters as one line ("4 to reply · 1 urgent"), or null when it has none to show. */
export function briefStatsLine(key: BriefSectionKey, stats: Readonly<Record<string, number>>): string | null {
  const parts = (STAT_LABELS[key] ?? [])
    .filter(([k]) => typeof stats[k] === "number" && Number.isFinite(stats[k]))
    .map(([k, one, many]) => `${formatCount(stats[k])} ${stats[k] === 1 ? one : many}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The restricted-sender line, or null for none (or unknown). */
export function restrictedLine(n: number | null): string | null {
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return n === 1 ? BRIEF_COPY.restrictedOne : fillBrief(BRIEF_COPY.restricted, { n: formatCount(n) });
}

function RefLink({ label, href }: { label: string; href: string | null }) {
  const link = safeLink(href);
  const chip = "inline-flex max-w-[18rem] items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600";
  if (!link) return <span className={cn(chip, "text-slate-500")} title={label}><span className="truncate">{label}</span></span>;
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={cn(chip, "hover:border-slate-300 hover:text-ink")} title={label}>
        <span className="truncate">{label}</span>
      </a>
    );
  }
  return (
    <Link href={link.href} prefetch={false} className={cn(chip, "hover:border-slate-300 hover:text-ink")} title={label}>
      <span className="truncate">{label}</span>
    </Link>
  );
}

function Notice({ icon: Icon, children, tone = "muted" }: { icon: typeof Newspaper; children: ReactNode; tone?: "muted" | "amber" }) {
  return (
    <div
      data-brief-notice
      className={cn(
        "flex items-start gap-3 rounded-2xl border px-4 py-4 text-[13.5px] shadow-soft",
        tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200/70 bg-white text-slate-700"
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone === "amber" ? "text-amber-600" : "text-indigo-500")} aria-hidden />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function Top3({ top3 }: { top3: BriefContentView["top3"] }) {
  if (top3.length === 0) return null;
  return (
    <div data-brief-top3 className="mt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{BRIEF_COPY.top3Title}</h3>
      <ol className="mt-2 space-y-2.5">
        {top3.map((t, i) => {
          const link = t.withheld ? null : safeLink(t.href);
          const title = <span className={cn("font-medium", t.withheld ? "italic text-slate-400" : "text-slate-100")}>{t.title}</span>;
          return (
            <li key={i} data-brief-top={t.withheld ? "withheld" : "shown"} className="flex items-baseline gap-2.5 text-[14px] leading-relaxed">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/10 text-[11px] font-semibold tabular-nums text-slate-200">{i + 1}</span>
              <span className="min-w-0 break-words">
                {link ? (
                  link.external ? (
                    <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline decoration-white/30 underline-offset-2 hover:decoration-white">
                      {title}
                    </a>
                  ) : (
                    <Link href={link.href} prefetch={false} className="underline decoration-white/30 underline-offset-2 hover:decoration-white">
                      {title}
                    </Link>
                  )
                ) : (
                  title
                )}
                {/* P8 fixer ui-6: the model's recommendation is tagged, as the DM's "_Suggested:_" is. */}
                {t.next !== null && (
                  <span data-brief-next className="block text-[12.5px] text-slate-300">
                    <span className="font-semibold text-indigo-200">{BRIEF_COPY.suggested}: </span>
                    {t.next}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Section({ section }: { section: BriefContentView["sections"][number] }) {
  const stats = briefStatsLine(section.key, section.stats);
  return (
    <section data-brief-section={section.key} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-soft">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-[13px] font-semibold text-ink">{section.title}</h3>
        {stats !== null && <p data-brief-stats className="mt-0.5 text-[11.5px] text-muted">{stats}</p>}
      </header>
      <div className="space-y-2.5 px-4 py-3">
        {section.lines.length > 0 && (
          <ul className="space-y-3">
            {section.lines.map((line) => (
              <li key={line.id} data-brief-line={line.id} data-withheld={line.withheld ?? undefined} className="space-y-1.5">
                {line.withheld === null && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {line.band !== "normal" && <PriorityBandBadge band={line.band} />}
                    <BasisLabel basis={line.basis} />
                    {line.kind === "recommendation" && (
                      <span data-brief-suggested className="inline-flex items-center rounded bg-indigo-50 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-indigo-700">
                        {BRIEF_COPY.suggested}
                      </span>
                    )}
                  </div>
                )}
                <p className={cn("break-words text-[13px] leading-relaxed", line.withheld === null ? "text-slate-800" : "italic text-slate-400")}>{line.text}</p>
                {line.refs.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {line.refs.map((r, i) => (
                      <RefLink key={i} label={r.label} href={r.href} />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {section.pending.length > 0 && (
          <ul data-brief-pending className="space-y-1 border-t border-slate-100 pt-2.5">
            {section.pending.map((p, i) => (
              <li key={i} className={cn("break-words text-[12.5px]", p.withheld ? "italic text-slate-400" : "text-slate-600")}>
                {BRIEF_COPY.pendingPrefix}
                {p.title}
              </li>
            ))}
          </ul>
        )}
        {section.stateLine !== null && <p data-brief-state className="text-[12.5px] text-muted">{section.stateLine}</p>}
        {(section.unchanged > 0 || section.more > 0) && (
          <p className="text-[11.5px] text-muted">
            {[section.unchanged > 0 ? fillBrief(BRIEF_COPY.unchanged, { n: formatCount(section.unchanged) }) : null, section.more > 0 ? fillBrief(BRIEF_COPY.more, { n: formatCount(section.more) }) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    </section>
  );
}

function Ready({ view }: { view: BriefPageView }) {
  const brief = view.brief;
  if (brief === null) return null;
  const content = brief.content;
  const restricted = content ? restrictedLine(content.restrictedEmail) : null;
  return (
    <div className="space-y-5">
      <section aria-labelledby="exec-brief-title" data-brief-summary={brief.status} className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h2 id="exec-brief-title" className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            {BRIEF_COPY.pageTitle} · {formatInZone(brief.localDate, view.tz, "date", view.generatedAt)}
          </h2>
          {content && (
            <span data-brief-mode={brief.mode ?? "none"} className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
              {brief.mode === "ai" ? <Sparkles className="h-3.5 w-3.5" aria-hidden /> : <CircleSlash className="h-3.5 w-3.5" aria-hidden />}
              {content.modeLine}
            </span>
          )}
        </div>
        <p data-brief-status className={cn("mt-2 break-words text-[12.5px]", view.state === "failed" ? "font-medium text-rose-300" : "text-slate-300")}>
          {brief.statusLine}
        </p>
        {content?.headline != null && (
          <p data-brief-headline className="mt-3 break-words text-[17px] font-semibold leading-snug text-white sm:text-[19px]">
            {content.headline}
          </p>
        )}
        {content && <Top3 top3={content.top3} />}
      </section>
      {content && (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          {content.sections.map((s) => (
            <Section key={s.key} section={s} />
          ))}
        </div>
      )}
      {content && (
        <div className="flex flex-col gap-2 rounded-2xl border border-slate-200/70 bg-white px-4 py-3 text-[12.5px] text-slate-700 shadow-soft sm:flex-row sm:items-center sm:justify-between">
          {restricted !== null && <p data-brief-restricted className="font-medium text-amber-800">{restricted}</p>}
          <p data-brief-finance className="inline-flex flex-wrap items-center gap-2 text-muted">
            <Wallet className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            {BRIEF_COPY.financeLine}
            <Link href={content.financeHref} prefetch={false} className="font-semibold text-indigo-700 hover:text-indigo-900">
              {BRIEF_COPY.financeLink}
            </Link>
          </p>
        </div>
      )}
      <CheckinList rows={view.checkins} posted={view.checkinsPosted} />
    </div>
  );
}

export function BriefView({ view }: { view: BriefPageView }) {
  switch (view.state) {
    case "not_installed":
      return (
        <Notice icon={Newspaper}>
          <p data-brief-state-copy="not_installed">{BRIEF_COPY.notInstalled}</p>
        </Notice>
      );
    case "off":
      return (
        <Notice icon={Newspaper}>
          <p data-brief-state-copy="off">{BRIEF_COPY.off}</p>
          <Link href="/executive/settings" prefetch={false} className="mt-1 inline-block text-[12.5px] font-semibold text-indigo-700 hover:text-indigo-900">
            {BRIEF_COPY.settings.title}
          </Link>
        </Notice>
      );
    case "none":
      return (
        <Notice icon={CalendarClock}>
          <p data-brief-state-copy="none">{fillBrief(BRIEF_COPY.none, { time: formatInZone(view.dueAt, view.tz, "time") })}</p>
        </Notice>
      );
    case "building":
      return (
        <Notice icon={Hammer}>
          {/* P8 fixer ui-5: the status line, so a watchdog backup already sent for a never-built day says so. */}
          <p data-brief-state-copy="building">{view.brief?.statusLine ?? BRIEF_COPY.status.building}</p>
        </Notice>
      );
    case "failed":
      return view.brief?.content ? (
        <Ready view={view} />
      ) : (
        <div className="space-y-5">
          <Notice icon={TriangleAlert} tone="amber">
            <p data-brief-state-copy="failed">{view.brief?.statusLine ?? BRIEF_COPY.status.failed}</p>
          </Notice>
          <CheckinList rows={view.checkins} posted={view.checkinsPosted} />
        </div>
      );
    default:
      return <Ready view={view} />;
  }
}
