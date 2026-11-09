import type { ReactNode } from "react";
import { ChevronDown, MessagesSquare } from "lucide-react";
import type { FactBasis } from "@/lib/exec/attention-types";
import { formatCount, formatInZone } from "@/lib/exec/format";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import type { ProjectSlackSection as ProjectSlackModel, SlackProjectRow } from "@/lib/exec/slack-projects";
import type { Section } from "@/lib/exec/view-types";
import { BasisLabel } from "../BasisLabel";
import { SectionCard } from "../SectionCard";
import { OpenInSlack, fill, kindLabel } from "./parts";
import { SlackPrivacyChip } from "./SlackPrivacyChip";
import { slackStateText } from "./SlackStateNotice";

// The Projects tab's Slack card (P7b contract §3.12.3, C19, P7-4, PJ01–PJ08), after P5a's Conversations card. Server.
// Three groups, newest first inside each:
//   "Linked to this project's work"  Record       message links to its tasks or to it, their thread replies, its tags
//   "In <client>'s channels"         Derived      only with a derived client; P5a's "Derived from N of M tasks" line
//   "Mentions"                       AI-assessed  in a <details>, closed by default
// A row shows the privacy chip, the kind, the conversation's label, the time, the AI summary (labelled AI-assessed: it is
// a model's summary whatever the group's basis), and "Open in Slack" for an allowed permalink. Never the excerpt, never an
// author (C29). A state other than "ok" shows its sentence; a failed read is this card's "Couldn't load"; a view without
// the section (a build before P7b's) renders nothing, so P5a's page is unchanged.

const TITLE = SLACK_INTEL_COPY.projectSection;

function Row({ row, tz, now }: { row: SlackProjectRow; tz: string; now: string }) {
  return (
    <li data-project-slack-row={row.itemId ?? row.digestId ?? ""} data-via={row.via} className="space-y-1 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
        <SlackPrivacyChip privacy={row.privacy} />
        <span className="font-semibold text-slate-700">{kindLabel(row.kind)}</span>
        <span className="min-w-0 break-all">{row.channelLabel}</span>
        <time dateTime={row.at} className="tabular-nums">
          {formatInZone(row.at, tz, row.kind === "digest" ? "date" : "datetime", now)}
        </time>
      </div>
      <p className="flex flex-wrap items-start gap-2 text-[12.5px] leading-relaxed text-ink">
        <span data-project-slack-summary className="min-w-0 flex-1 basis-48 break-words">
          {row.summary}
        </span>
        <BasisLabel basis="ai" />
      </p>
      <OpenInSlack permalink={row.permalink} />
    </li>
  );
}

function Group({ name, title, basis, note, rows, tz, now }: { name: string; title: string; basis: FactBasis; note?: ReactNode; rows: SlackProjectRow[]; tz: string; now: string }) {
  return (
    <div data-project-slack-group={name} className="border-t border-slate-100 first:border-t-0">
      <div className="space-y-0.5 px-4 pt-3">
        <p className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-ink">
          <span className="min-w-0 break-words">{title}</span>
          <BasisLabel basis={basis} />
        </p>
        {note}
      </div>
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <Row key={`${r.via}:${r.itemId ?? r.digestId}`} row={r} tz={tz} now={now} />
        ))}
      </ul>
    </div>
  );
}

export function ProjectSlackSection({
  section,
  derivedNote = null,
  tz,
  now
}: {
  section: Section<ProjectSlackModel> | undefined;
  /** P5a's "Derived from N of M tasks that name a client" line (PROJECT_COPY.derivedFrom), shown under the client group. */
  derivedNote?: string | null;
  tz: string;
  now: string;
}) {
  if (section === undefined) return null;
  if (!section.ok) return <SectionCard title={TITLE} icon={MessagesSquare} error />;
  const s = section.data;
  const stateText = slackStateText(s.state);
  if (stateText !== null) {
    return (
      <SectionCard title={TITLE} icon={MessagesSquare}>
        <p data-project-slack-state={s.state} className="text-[12.5px] leading-relaxed text-slate-600">
          {stateText}
        </p>
      </SectionCard>
    );
  }
  const clientName = s.derivedClientName;
  const showClient = clientName !== null && s.clientChannels.length > 0;
  if (s.linked.length === 0 && !showClient && s.mentions.length === 0) {
    return <SectionCard title={TITLE} icon={MessagesSquare} empty={SLACK_INTEL_COPY.projectEmpty} />;
  }
  const derivedLine =
    typeof derivedNote === "string" && derivedNote.length > 0 ? (
      <p data-project-slack-derived className="text-[11.5px] text-muted">
        {derivedNote}
      </p>
    ) : null;
  return (
    <SectionCard title={TITLE} icon={MessagesSquare} padded={false}>
      <div data-project-slack>
        {s.linked.length > 0 && <Group name="linked" title={SLACK_INTEL_COPY.projectLinked} basis="record" rows={s.linked} tz={tz} now={now} />}
        {showClient && (
          <Group
            name="client"
            title={fill(SLACK_INTEL_COPY.projectClient, { client: clientName as string })}
            basis="derived"
            note={derivedLine}
            rows={s.clientChannels}
            tz={tz}
            now={now}
          />
        )}
        {s.mentions.length > 0 && (
          <details data-project-slack-group="mentions" className="group border-t border-slate-100 first:border-t-0">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-[12.5px] font-semibold text-ink">
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
              <span>{SLACK_INTEL_COPY.projectMentions}</span>
              <span className="tabular-nums text-muted">{formatCount(s.mentions.length)}</span>
              <BasisLabel basis="ai" />
            </summary>
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {s.mentions.map((r) => (
                <Row key={`mention:${r.itemId}`} row={r} tz={tz} now={now} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </SectionCard>
  );
}
