import type { ReactNode } from "react";
import { BookOpen, ListChecks, TriangleAlert } from "lucide-react";
import { MISSING, formatCount, formatInZone } from "@/lib/exec/format";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import type { SlackReadingView } from "@/lib/exec/slack-types";
import { cn } from "@/lib/utils";
import { SlackChannelPicker } from "./SlackChannelPicker";
import { SlackReadingControls } from "./SlackReadingControls";

// The Slack section's reading half (P7a contract §3.16, N4, N11, N12, N20,
// C29, C47; Area E). Server and presentational, like SlackSection: everything
// comes from the SlackReadingView getSlackSettingsView read; the actions are
// client islands (SlackReadingControls, SlackChannelPicker), frame-guarded.
// Every string is SLACK_READ_COPY's; values are counts, times and codes.
//
//   not_installed      readingNotInstalled
//   bot_not_connected  nothing (P6's Connect controls carry the page)
//   not_consented      readingIntro, readingWhat, readingNotice ({days}), Allow
//   discovering        discovering + discoveringCount ({n} sorted so far);
//                      Stop reading (withdrawal never waits for discovery)
//   paused             paused; the checklist (checklistTitle + the five items);
//                      the switch (its confirm attests to the checklist), the
//                      budget, the retention, Stop reading; the picker
//   on                 the status rows (last event, last sweep, waiting, open,
//                      today's spend); the switch, budget, retention, Stop; the
//                      picker
//   revoked            revoked ({date}, {reason}); stopRevokeFailed when the
//                      permission couldn't be cancelled in Slack (C47); Allow
//   error              error ({code}); Allow (re-consent); Stop reading
//   (a failed read)    readFailed, never "Slack rejected"; Stop reading only
//
// Pure: no server-only import, so the page, tests and the static screenshot
// harness render it the same way.

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), template);

const usd = (n: number | null): string => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : MISSING);

/** statusSpend with today's Slack spend and the cap that applies; "—" (and no "$") when the spend couldn't be read. */
export function readingSpendText(view: Pick<SlackReadingView, "spentTodayUsd" | "effectiveCapUsd">): string {
  const template = view.spentTodayUsd === null ? SLACK_READ_COPY.statusSpend.split("${spent}").join(MISSING) : SLACK_READ_COPY.statusSpend;
  return fill(template, { spent: usd(view.spentTodayUsd), cap: usd(view.effectiveCapUsd) });
}

/** revoked with the date in his zone and the reason's label. */
export function readingRevokedText(view: Pick<SlackReadingView, "revokedAt" | "revokeReason">, tz: string, now: string): string {
  const reasons = SLACK_READ_COPY.revokeReasons as Readonly<Record<string, string>>;
  const reason = view.revokeReason !== null && Object.prototype.hasOwnProperty.call(reasons, view.revokeReason) ? reasons[view.revokeReason] : MISSING;
  return fill(SLACK_READ_COPY.revoked, { date: formatInZone(view.revokedAt, tz, "date", now), reason });
}

/** The status rows of the "on" state, as words (time in his zone; "None yet" when nothing happened). */
export function readingStatusLines(view: SlackReadingView, tz: string, now: string): { key: string; text: string }[] {
  const when = (iso: string | null) => (iso ? formatInZone(iso, tz, "datetime", now) : SLACK_READ_COPY.none);
  return [
    { key: "event", text: fill(SLACK_READ_COPY.statusLastEvent, { time: when(view.lastEventAt) }) },
    { key: "sweep", text: fill(SLACK_READ_COPY.statusLastSweep, { time: when(view.lastSweepAt) }) },
    { key: "pending", text: fill(SLACK_READ_COPY.statusPending, { n: formatCount(view.pendingTriage) }) },
    { key: "open", text: fill(SLACK_READ_COPY.statusOpen, { n: formatCount(view.openItems) }) },
    { key: "spend", text: readingSpendText(view) }
  ];
}

const Note = ({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "body" }) => (
  <p className={cn("text-[12.5px] leading-relaxed", tone === "muted" ? "text-muted" : "text-slate-700")}>{children}</p>
);

function Alert({ children, name }: { children: ReactNode; name: string }) {
  return (
    <div data-reading-alert={name} className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** N20: the blocking checklist, shown above the switch (its confirm's checkbox attests to these five). */
export function ReadingChecklist() {
  return (
    <div data-reading-checklist className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        <ListChecks className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        {SLACK_READ_COPY.checklistTitle}
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-slate-700">
        {SLACK_READ_COPY.checklist.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </div>
  );
}

export function SlackReadingSection({
  view,
  tz,
  now,
  onCanonicalHost = true,
  initialDialog = null,
  initialChecked = false,
  initialFinanceConfirm = null
}: {
  view: SlackReadingView;
  /** His zone and the page's one "now", for the dates. */
  tz: string;
  now: string;
  /** C45: the page was requested on the canonical host (the Allow link needs it). */
  onCanonicalHost?: boolean;
  /** Static renders only (tests, screenshots): a confirm open on first render. The page never passes them. */
  initialDialog?: "enable" | "stop" | null;
  initialChecked?: boolean;
  initialFinanceConfirm?: string | null;
}) {
  const state = view.state;
  if (state === "bot_not_connected") return null;

  let body: ReactNode;
  if (state === "not_installed") body = <Note>{SLACK_READ_COPY.readingNotInstalled}</Note>;
  else if (state === "not_consented") {
    body = (
      <>
        <Note tone="body">{SLACK_READ_COPY.readingIntro}</Note>
        <ul data-reading-what className="list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-slate-700">
          {SLACK_READ_COPY.readingWhat.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Note>{fill(SLACK_READ_COPY.readingNotice, { days: String(view.retentionDaysSlack) })}</Note>
      </>
    );
  } else if (state === "discovering") {
    body = (
      <>
        <Note tone="body">{SLACK_READ_COPY.discovering}</Note>
        <Note>{fill(SLACK_READ_COPY.discoveringCount, { n: formatCount(sortedCount(view)) })}</Note>
      </>
    );
  } else if (state === "paused") {
    body = (
      <>
        <Note tone="body">{SLACK_READ_COPY.paused}</Note>
        <ReadingChecklist />
      </>
    );
  } else if (state === "on") {
    body = (
      <ul data-reading-status className="divide-y divide-slate-100 rounded-xl border border-slate-100 text-[12.5px]">
        {readingStatusLines(view, tz, now).map((l) => (
          <li key={l.key} data-reading-status-row={l.key} className="break-words px-3 py-1.5 text-slate-700">
            {l.text}
          </li>
        ))}
      </ul>
    );
  } else if (state === "revoked") {
    body = (
      <>
        <Note tone="body">{readingRevokedText(view, tz, now)}</Note>
        {view.lastErrorCode === "revoke_failed" && <Alert name="revoke_failed">{SLACK_READ_COPY.stopRevokeFailed}</Alert>}
      </>
    );
  } else if (view.readFailed === true) {
    // P7a fixer ui-3: DD couldn't read the view; Slack rejected nothing (no code, no Allow).
    body = <Note tone="body">{SLACK_READ_COPY.readFailed}</Note>;
  } else {
    body = <Alert name="error">{fill(SLACK_READ_COPY.error, { code: view.lastErrorCode ?? MISSING })}</Alert>;
  }

  const picker = state === "paused" || state === "on";
  return (
    <div data-slack-reading data-reading-state={state} data-reading-read-failed={view.readFailed === true ? "" : undefined} className="space-y-3 border-t border-slate-100 pt-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <BookOpen className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        {SLACK_READ_COPY.readingHeading}
      </h3>
      {body}
      {state !== "not_installed" && (
        <SlackReadingControls view={view} onCanonicalHost={onCanonicalHost} initialDialog={initialDialog} initialChecked={initialChecked} />
      )}
      {picker && (
        <div className="border-t border-slate-100 pt-3">
          <SlackChannelPicker view={view} initialFinanceConfirm={initialFinanceConfirm} />
        </div>
      )}
    </div>
  );
}

/** discoveringCount's {n}: every conversation sorted so far (the never-read ones as counts). */
function sortedCount(view: SlackReadingView): number {
  const c = view.counts;
  return c.watched + c.muted + c.unwatched + c.never + c.hubs + c.dms.total + c.groupDms.total;
}
