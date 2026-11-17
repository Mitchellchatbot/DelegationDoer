import type { ReactNode } from "react";
import { BookOpen, ListChecks, TriangleAlert } from "lucide-react";
import { MISSING, formatCount, formatInZone } from "@/lib/exec/format";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import type { SlackPickerTags } from "@/lib/exec/slack-page";
import type { SlackReadingView } from "@/lib/exec/slack-types";
import { cn } from "@/lib/utils";
import { SlackChannelPicker } from "./SlackChannelPicker";
import { SlackP10Controls, type P10Notice } from "./SlackP10Controls";
import { SLACK_READ_START_PATH, SlackReadingControls } from "./SlackReadingControls";

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
//
// P7b fixer (ui-3): with P7b the same switch also sends every watched
// conversation's messages from people to Anthropic for a daily digest and lets
// chat read conversations live, so SLACK_INTEL_COPY.readingIntelNotice ({days})
// is shown wherever the reading notice or the switch is (not_consented, paused,
// on) and inside the enable confirm.
//
// P10 (contract §3.7.5, C9, v1.1 product-14): for the paused and on states, the DM nudges (when the read consent lacks the DM
// or group-DM scopes: dmNudge / groupDmNudge with "Allow reading again", the start route's purpose=read, which replaces the
// scopes), the P10 controls above the picker's rows, and the read-all switch directly under the picker's "Which conversations
// to read" radio group; the Stop-reading dialog also says stopAlso while P10 is installed.

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
  initialFinanceConfirm = null,
  tags = null,
  initialP10Dialog = null,
  initialP10Checked = false
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
  /** P7b (§3.12.4, AM-P7b-6): the picker's per-row client and project tags (getSlackPickerTags); null shows none. */
  tags?: SlackPickerTags | null;
  /** Static renders only (tests, screenshots): a P10 confirm open on first render. The page never passes them. */
  initialP10Dialog?: P10Notice | null;
  initialP10Checked?: boolean;
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
        <IntelNotice days={view.retentionDaysSlack} />
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
        <IntelNotice days={view.retentionDaysSlack} />
        <ReadingChecklist />
      </>
    );
  } else if (state === "on") {
    body = (
      <>
        <ul data-reading-status className="divide-y divide-slate-100 rounded-xl border border-slate-100 text-[12.5px]">
          {readingStatusLines(view, tz, now).map((l) => (
            <li key={l.key} data-reading-status-row={l.key} className="break-words px-3 py-1.5 text-slate-700">
              {l.text}
            </li>
          ))}
        </ul>
        <IntelNotice days={view.retentionDaysSlack} />
      </>
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
  const p10 = picker ? view.p10 ?? null : null;
  const p10Dialog = (part: "readAll" | "rest"): P10Notice | null =>
    initialP10Dialog === null ? null : (initialP10Dialog === "readAll") === (part === "readAll") ? initialP10Dialog : null;
  return (
    <div data-slack-reading data-reading-state={state} data-reading-read-failed={view.readFailed === true ? "" : undefined} className="space-y-3 border-t border-slate-100 pt-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
        <BookOpen className="h-3.5 w-3.5 text-slate-500" aria-hidden />
        {SLACK_READ_COPY.readingHeading}
      </h3>
      {body}
      {state !== "not_installed" && (
        <SlackReadingControls
          view={view}
          onCanonicalHost={onCanonicalHost}
          initialDialog={initialDialog}
          initialChecked={initialChecked}
          enableConfirmExtra={intelNoticeText(view.retentionDaysSlack)}
          stopConfirmExtra={view.p10?.schemaReady === true ? SLACK_P10_COPY.settings.stopAlso : null}
        />
      )}
      {picker && <DmNudges view={view} onCanonicalHost={onCanonicalHost} />}
      {p10 !== null && (
        <div data-p10-section className="space-y-2 border-t border-slate-100 pt-3">
          <h4 className="text-[12.5px] font-semibold text-ink">{SLACK_P10_COPY.settings.heading}</h4>
          <SlackP10Controls part="rest" p10={p10} version={view.settingsVersion} tz={tz} now={now} initialDialog={p10Dialog("rest")}
            initialChecked={initialP10Checked} />
        </div>
      )}
      {picker && (
        <div className="border-t border-slate-100 pt-3">
          <SlackChannelPicker
            view={view}
            initialFinanceConfirm={initialFinanceConfirm}
            tags={tags}
            afterWatchMode={p10 !== null && p10.schemaReady ? (
              <SlackP10Controls part="readAll" p10={p10} version={view.settingsVersion} tz={tz} now={now} initialDialog={p10Dialog("readAll")}
                initialChecked={initialP10Checked} />
            ) : null}
          />
        </div>
      )}
    </div>
  );
}

/** P10 (C9): the DM and group-DM nudges, when the read consent lacks their scopes (the start route's purpose=read replaces the
 *  scopes; off the canonical host there is no link, as P7a's Allow). */
export function DmNudges({ view, onCanonicalHost }: { view: Pick<SlackReadingView, "dmsGranted" | "groupDmsGranted">; onCanonicalHost: boolean }) {
  const lines = [
    ...(view.dmsGranted ? [] : [{ key: "dm", text: SLACK_P10_COPY.settings.dmNudge }]),
    ...(view.groupDmsGranted ? [] : [{ key: "group", text: SLACK_P10_COPY.settings.groupDmNudge }])
  ];
  if (lines.length === 0) return null;
  return (
    <div data-p10-dm-nudge className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5">
      {lines.map((l) => (
        <p key={l.key} data-p10-dm-nudge-line={l.key} className="text-[12.5px] leading-relaxed text-slate-700">{l.text}</p>
      ))}
      {onCanonicalHost && (
        <a data-p10-allow-again href={SLACK_READ_START_PATH} className="inline-flex min-h-10 items-center text-[12.5px] font-semibold text-indigo-700 hover:text-indigo-900 sm:min-h-0">
          {SLACK_P10_COPY.settings.allowAgain}
        </a>
      )}
    </div>
  );
}

/** P7b fixer (ui-3): what P7b adds to the switch, with the Slack retention. */
export function intelNoticeText(days: number): string {
  return fill(SLACK_INTEL_COPY.readingIntelNotice, { days: String(days) });
}

function IntelNotice({ days }: { days: number }) {
  return (
    <p data-reading-intel-notice className="text-[12.5px] leading-relaxed text-muted">
      {intelNoticeText(days)}
    </p>
  );
}

/** discoveringCount's {n}: every conversation sorted so far (the never-read ones as counts). */
function sortedCount(view: SlackReadingView): number {
  const c = view.counts;
  return c.watched + c.muted + c.unwatched + c.never + c.hubs + c.dms.total + c.groupDms.total;
}
