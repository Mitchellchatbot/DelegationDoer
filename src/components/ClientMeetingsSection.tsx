"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Video, CalendarClock, Users, ExternalLink, ChevronDown, ChevronRight,
  Gavel, ListChecks, MessageSquareQuote, AlertTriangle, ArrowRightCircle,
  CheckCircle2
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MeetingBrief } from "@/lib/meeting-brief";

export interface ClientMeetingView {
  id: string;
  title: string;
  source: string;
  sourceUrl: string | null;
  meetingDate: string;
  participants: string[];
  summary: string | null;
  brief: MeetingBrief;
  transcript: string | null;
  // Resolved on the server from the meeting's task_ids so each row can
  // deep-link to the tasks the meeting spawned.
  linkedTasks: { id: string; title: string; status: string }[];
}

// Knowledge-base timeline of processed meetings (tl;dv) for a client.
// Each entry shows that a meeting summary was received + processed, the
// generated team brief, the tasks it spawned, a link to the recording,
// and an expandable full transcript. The list_client_meetings Ask-AI
// tool reads the same underlying records so the assistant can draw on
// what was said in the room.
export function ClientMeetingsSection({ meetings }: { meetings: ClientMeetingView[] }) {
  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-blue-50/60 to-white p-4 space-y-3">
      <header className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-blue-500" />
        <div className="text-sm font-semibold inline-flex items-center gap-1.5">
          <Video className="w-4 h-4" /> Meetings &amp; briefs
        </div>
        <span className="text-xs text-muted">· {meetings.length}</span>
      </header>

      {meetings.length === 0 ? (
        <div className="text-xs text-muted italic px-1">
          No meetings processed yet. tl;dv meeting summaries are attached here
          automatically once a transcript is received.
        </div>
      ) : (
        <div className="space-y-2.5">
          {meetings.map((m, i) => (
            <MeetingCard key={m.id} meeting={m} defaultExpanded={i === 0} />
          ))}
        </div>
      )}
    </section>
  );
}

function MeetingCard({ meeting: m, defaultExpanded = false }: {
  meeting: ClientMeetingView;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showTranscript, setShowTranscript] = useState(false);

  return (
    <div className="rounded-xl bg-white/80 border border-white/70 p-3.5 space-y-2.5">
      {/* Header — clickable to expand/collapse. Title + date/source live in the
          toggle button; the Recording link stays a sibling so it isn't nested
          inside the button (invalid HTML) and can be clicked independently. */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="min-w-0 flex items-start gap-1.5 text-left group"
        >
          <span className="shrink-0 mt-0.5 text-ink/45 group-hover:text-ink/70 transition-colors">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{m.title}</span>
            <span className="flex items-center gap-2 flex-wrap mt-0.5 text-[11px] text-ink/55">
              <span className="inline-flex items-center gap-1 tabular-nums">
                <CalendarClock className="w-3 h-3" />
                {new Date(m.meetingDate).toLocaleDateString(undefined, {
                  year: "numeric", month: "short", day: "numeric"
                })}
              </span>
              <span className="uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/60 border border-slate-200/70">
                {m.source}
              </span>
            </span>
          </span>
        </button>
        {m.sourceUrl && (
          <a
            href={m.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 text-[11px] text-accent hover:underline underline-offset-2"
          >
            <ExternalLink className="w-3 h-3" /> Recording
          </a>
        )}
      </div>

      {expanded && (
      <>
      {/* Participants. */}
      {m.participants.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-ink/65">
          <Users className="w-3 h-3 shrink-0" />
          {m.participants.map((p) => (
            <span
              key={p}
              className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100"
            >
              {p}
            </span>
          ))}
        </div>
      )}

      {/* Summary. */}
      {m.summary && (
        <p className="text-[13px] text-ink/80 leading-snug whitespace-pre-wrap">{m.summary}</p>
      )}

      {/* Team brief. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
        <BriefList
          label="Key decisions"
          icon={<Gavel className="w-3 h-3" />}
          tone="text-emerald-700"
          items={m.brief.keyDecisions}
        />
        <BriefList
          label="Action items"
          icon={<ListChecks className="w-3 h-3" />}
          tone="text-blue-700"
          items={m.brief.actionItems}
        />
        <BriefList
          label="Client requests"
          icon={<MessageSquareQuote className="w-3 h-3" />}
          tone="text-violet-700"
          items={m.brief.clientRequests}
        />
        <BriefList
          label="Risks / blockers"
          icon={<AlertTriangle className="w-3 h-3" />}
          tone="text-amber-700"
          items={m.brief.risks}
        />
        <BriefList
          label="Next steps"
          icon={<ArrowRightCircle className="w-3 h-3" />}
          tone="text-sky-700"
          items={m.brief.nextSteps}
        />
      </div>

      {/* Tasks spawned from the meeting. */}
      {m.linkedTasks.length > 0 && (
        <div className="space-y-1 pt-0.5">
          <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold">
            Tasks created · {m.linkedTasks.length}
          </div>
          <div className="space-y-1">
            {m.linkedTasks.map((t) => (
              <Link
                key={t.id}
                href={`/tasks/${t.id}`}
                className="group flex items-center gap-1.5 text-[12px] text-ink/75 hover:text-accent"
              >
                <CheckCircle2
                  className={cn(
                    "w-3 h-3 shrink-0",
                    t.status === "done" ? "text-emerald-600" : "text-slate-400"
                  )}
                />
                <span className="truncate group-hover:underline underline-offset-2">{t.title}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Full transcript (collapsed by default — it's long). */}
      {m.transcript && (
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-ink/60 hover:text-accent"
          >
            {showTranscript ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            {showTranscript ? "Hide transcript" : "View full transcript"}
          </button>
          {showTranscript && (
            <div className="mt-1.5 max-h-72 overflow-y-auto rounded-lg bg-slate-50 border border-slate-200/70 p-2.5 text-[12px] text-ink/75 whitespace-pre-wrap leading-relaxed">
              {m.transcript}
            </div>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

function BriefList({
  label, icon, tone, items
}: {
  label: string;
  icon: React.ReactNode;
  tone: string;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className={cn("text-[10px] uppercase tracking-wide font-semibold inline-flex items-center gap-1", tone)}>
        {icon} {label}
      </div>
      <ul className="mt-1 space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="text-[12px] text-ink/75 leading-snug flex gap-1.5">
            <span className="text-ink/30 shrink-0">•</span>
            <span className="min-w-0">{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
