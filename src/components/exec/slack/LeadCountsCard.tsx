import type { ReactNode } from "react";
import { ExternalLink, Users } from "lucide-react";
import { formatCount, formatInZone } from "@/lib/exec/format";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { leadCountsLine } from "@/lib/exec/slack-leads";
import { SLACK_P10_COPY, fillP10 } from "@/lib/exec/slack-p10-copy";
import type { LeadCountsView, LeadKind, LeadTriple } from "@/lib/exec/slack-p10-types";
import type { Section } from "@/lib/exec/view-types";
import { SectionCard } from "../SectionCard";

// The Slack tab's lead counts (P10 contract §3.9.2, C33, C56, C62, Appendix C; Area B): a server component rendered from the
// page's LeadCountsView only (no reads, no clock). Counts only: integers, DD client labels and the names typed on the FB
// onboarding cards; no Slack channel name anywhere, and a lead channel id only inside an "Open in Slack" link's href (the
// app_redirect form isAllowedLinkUrl passes, LP06).
//
//   * Full width, right after the counts strip (id="leads", the brief links here).
//   * The countsOnly line; the table (caption, column and row header scopes; the All clients row first, then each client,
//     then the unlinked group) with each cell a leadCountsLine over that client's kinds; per client the Zapier chip by day.
//     Below sm each row stacks into one block with its column names.
//   * The Calendly note (Appendix C) under the table whenever a row shows the Calendly kind.
//   * The coverage lines, each only when its number is above 0, with the fix lists (unlinked, ambiguous: "Open in Slack"
//     links, ≤ 50 each, then "+N more"); after them, as plain information (Appendix C: no amber, no link), the listed lead
//     channels he isn't a member of, grouped by client with the names as typed on the card.
//   * Every other state shows its sentence; first_run included; no_channels keeps the not-a-member lines.

const C = SLACK_P10_COPY.leads;
const COLUMNS = ["today", "yesterday", "last7"] as const;

function cell(t: LeadTriple, kinds: readonly LeadKind[]): string {
  const line = leadCountsLine({ ...t, kinds: [...kinds] });
  return line.length > 0 ? line : "0";
}

/** The unlinked group has no kinds field: the kinds it counted in the last 7 days. */
function unlinkedKinds(u: NonNullable<LeadCountsView["unlinked"]>): LeadKind[] {
  return (["vob", "nonvob", "calendly"] as const).filter((k) => u.last7[k] > 0 || u.today[k] > 0 || u.yesterday[k] > 0);
}

function ZapChips({ today, yesterday }: { today: number; yesterday: number }) {
  if (today <= 0 && yesterday <= 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {today > 0 && (
        <span data-lead-zap="today" className="inline-flex items-center rounded bg-rose-50 px-1.5 py-px text-[10.5px] font-semibold text-rose-800">
          {today === 1 ? C.zapTodayOne : fillP10(C.zapToday, { n: formatCount(today) })}
        </span>
      )}
      {yesterday > 0 && (
        <span data-lead-zap="yesterday" className="inline-flex items-center rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-semibold text-slate-700">
          {yesterday === 1 ? C.zapYesterdayOne : fillP10(C.zapYesterday, { n: formatCount(yesterday) })}
        </span>
      )}
    </span>
  );
}

function Row({ label, kinds, today, yesterday, last7, zapToday, zapYesterday, total, rowKey }: {
  label: string; kinds: readonly LeadKind[]; today: LeadTriple; yesterday: LeadTriple; last7: LeadTriple; zapToday: number; zapYesterday: number;
  total?: boolean; rowKey: string;
}) {
  const values = { today, yesterday, last7 };
  return (
    <tr data-lead-row={rowKey} className="block border-b border-slate-100 px-4 py-2.5 last:border-b-0 sm:table-row sm:px-0 sm:py-0">
      <th scope="row" className={`block text-left align-top text-[13px] sm:table-cell sm:px-4 sm:py-2.5 ${total ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`}>
        <span className="break-words">{label}</span>
        <ZapChips today={zapToday} yesterday={zapYesterday} />
      </th>
      {COLUMNS.map((col) => (
        <td key={col} data-lead-cell={col} className="block text-[12.5px] text-slate-700 sm:table-cell sm:px-4 sm:py-2.5 sm:align-top">
          <span className="font-medium text-slate-500 sm:hidden">{C.columns[col]}: </span>
          {cell(values[col], kinds)}
        </td>
      ))}
    </tr>
  );
}

function FixLinks({ title, entries }: { title: string; entries: { href: string; kind: LeadKind }[] }) {
  const shown = entries.filter((e) => isAllowedLinkUrl(e.href));
  if (shown.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="text-[12px] font-medium text-slate-700">{title}</p>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {shown.map((e, i) => (
          <li key={i} className="inline-flex items-center gap-1.5 text-[12px] text-slate-600">
            <a
              href={new URL(e.href).href}
              target="_blank"
              rel="noopener noreferrer"
              data-lead-fix-link
              className="inline-flex min-h-10 items-center gap-1 font-semibold text-indigo-700 hover:text-indigo-900 sm:min-h-0"
            >
              {C.openInSlack}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            <span>{e.kind === "other" ? "" : C.kinds[e.kind]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Appendix C: the listed lead channels he isn't in, as plain information after the fix lists (no warning tone, no link). */
function NotCounted({ groups }: { groups: { client: string; names: string[] }[] }) {
  if (groups.length === 0) return null;
  return (
    <ul data-lead-not-counted className="space-y-1">
      {groups.map((g, i) => (
        <li key={i} className="break-words text-[12px] text-slate-600">
          {fillP10(C.fixNotMember, { client: g.client, names: g.names.join(", ") })}
        </li>
      ))}
    </ul>
  );
}

/** P10 fixer ui-10: a count line in its singular for 1 (the *One copy), else the plural template with {n}. */
function countLine(n: number, many: string, one: string): string {
  return n === 1 ? one : fillP10(many, { n: formatCount(n) });
}

function Coverage({ view }: { view: LeadCountsView }) {
  const cov = view.coverage;
  const fix = view.fix;
  // P10 fixer correctness-3: also a channel with no whole count for a day of the window (the view's own flag: today not
  // counted yet, yesterday before its final pass, an unlinked channel), never only the rows' flags.
  const incomplete = view.incomplete === true || view.clients.some((c) => c.incomplete);
  const lines: { key: string; text: string; extra?: ReactNode }[] = [];
  if (cov !== null) {
    if (cov.unlinked > 0) lines.push({ key: "unlinked", text: countLine(cov.unlinked, C.unlinkedHelp, C.unlinkedHelpOne), extra: fix ? <FixLinks title={C.fixUnlinked} entries={fix.unlinked} /> : null });
    if (cov.ambiguous > 0) lines.push({ key: "ambiguous", text: countLine(cov.ambiguous, C.ambiguousHelp, C.ambiguousHelpOne), extra: fix ? <FixLinks title={C.fixAmbiguous} entries={fix.ambiguous} /> : null });
    if (cov.listedNotMember > 0) lines.push({ key: "not-member", text: countLine(cov.listedNotMember, C.listedNotMember, C.listedNotMemberOne) });
    if (cov.otherKind > 0) lines.push({ key: "other-kind", text: countLine(cov.otherKind, C.otherKind, C.otherKindOne) });
    if (cov.skippedToday > 0) lines.push({ key: "non-app", text: countLine(cov.skippedToday, C.nonAppPosts, C.nonAppPostsOne) });
  }
  if (incomplete) lines.push({ key: "incomplete", text: C.incomplete });
  const notMember = fix?.notMember ?? [];
  const more = fix?.more ?? 0;
  if (lines.length === 0 && notMember.length === 0 && more === 0) return null;
  return (
    <div data-lead-coverage className="space-y-2 border-t border-slate-100 px-4 py-3">
      {lines.map((l) => (
        <div key={l.key} data-lead-coverage-line={l.key}>
          <p className="text-[12px] text-slate-600">{l.text}</p>
          {l.extra}
        </div>
      ))}
      <NotCounted groups={notMember} />
      {more > 0 && <p data-lead-fix-more className="text-[12px] text-slate-500">{fillP10(C.fixMore, { n: formatCount(more) })}</p>}
    </div>
  );
}

function StateLine({ state }: { state: Exclude<LeadCountsView["state"], "ok"> }) {
  return (
    <p data-lead-state={state} role="status" className="px-4 py-4 text-[13px] text-slate-600">
      {C.states[state]}
    </p>
  );
}

/** The lead counts card. `section` is the page's own soft section (a failed read → the card's "Couldn't load"). */
export function LeadCountsCard({ section, tz, now }: { section: Section<LeadCountsView>; tz: string; now: string }) {
  if (!section.ok) {
    return (
      <div id="leads">
        <SectionCard title={C.title} icon={Users} error={C.states.unavailable} />
      </div>
    );
  }
  const view = section.data;
  const asOf = view.asOf !== null ? fillP10(C.asOf, { time: formatInZone(view.asOf, tz, "datetime", now) }) : null;
  const showsCalendly =
    view.clients.some((c) => c.kinds.includes("calendly")) || (view.totals?.kinds.includes("calendly") ?? false)
    || (view.unlinked !== null && unlinkedKinds(view.unlinked).includes("calendly"));
  const hasTable = view.state === "ok" && (view.totals !== null || view.clients.length > 0 || view.unlinked !== null);
  return (
    <div id="leads" data-lead-counts={view.state} className="scroll-mt-20">
      <SectionCard title={C.title} icon={Users} subtitle={asOf ?? undefined} padded={false}>
        <p data-lead-counts-only className="px-4 pt-3 text-[12px] text-slate-500">{C.countsOnly}</p>
        {view.state === "ok" ? (
          <>
            {hasTable ? (
              <div className="px-0 py-2 sm:px-0">
                <table data-lead-table className="block w-full text-left sm:table">
                  <caption className="sr-only">{C.tableCaption}</caption>
                  <thead className="hidden sm:table-header-group">
                    <tr className="border-b border-slate-100">
                      <th scope="col" className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                        <span className="sr-only">{C.tableCaption}</span>
                      </th>
                      {COLUMNS.map((col) => (
                        <th key={col} scope="col" className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                          {C.columns[col]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="block sm:table-row-group">
                    {view.totals !== null && (
                      <Row rowKey="all" total label={C.allClients} kinds={view.totals.kinds} today={view.totals.today} yesterday={view.totals.yesterday}
                        last7={view.totals.last7} zapToday={0} zapYesterday={0} />
                    )}
                    {view.clients.map((c, i) => (
                      <Row key={i} rowKey="client" label={c.label} kinds={c.kinds} today={c.today} yesterday={c.yesterday} last7={c.last7}
                        zapToday={c.zapToday} zapYesterday={c.zapYesterday} />
                    ))}
                    {view.unlinked !== null && (
                      <Row rowKey="unlinked" label={C.unlinked} kinds={unlinkedKinds(view.unlinked)} today={view.unlinked.today}
                        yesterday={view.unlinked.yesterday} last7={view.unlinked.last7} zapToday={0} zapYesterday={0} />
                    )}
                  </tbody>
                </table>
                {showsCalendly && <p data-lead-calendly-note className="px-4 pt-2 text-[12px] text-slate-500">{C.calendlyNote}</p>}
              </div>
            ) : null}
            <Coverage view={view} />
          </>
        ) : (
          <>
            <StateLine state={view.state} />
            {view.state === "no_channels" && <Coverage view={view} />}
          </>
        )}
      </SectionCard>
    </div>
  );
}
