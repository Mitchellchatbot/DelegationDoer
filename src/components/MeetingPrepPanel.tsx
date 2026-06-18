"use client";

// Right-rail "Meeting prep" panel for the Schedule tab. Sits directly below
// the Upcoming-meetings panel and shares its meetings fetch (lifted into
// SchedulePage). For the SOONEST client-matched meeting it auto-generates a
// brief on load; when there are several upcoming client meetings, a selector
// lets the user prep the others on demand (those don't auto-run, to bound
// the per-load LLM spend). Briefs are cached in-session; a Refresh re-runs.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles, Loader2, RefreshCw, CheckCircle2, CircleDot,
  AlertTriangle, MessageSquare, Lightbulb, type LucideIcon
} from "lucide-react";
import type { MeetingPrepBrief } from "@/lib/meeting-prep";

// Mirrors the Meeting shape returned by /api/calendar/meetings (defined
// locally, same as SchedulePage's MeetingsPanel).
interface Meeting {
  id: string;
  summary: string;
  startISO: string;
  htmlLink: string;
  hangoutLink: string | null;
  clientId: string | null;
  clientName: string | null;
  guest: string | null;
}

type BriefState =
  | { status: "loading" }
  | { status: "ready"; data: MeetingPrepBrief }
  | { status: "error"; message: string };

export function MeetingPrepPanel({ meetings }: { meetings: Meeting[] | null }) {
  // Only client-matched meetings can be prepped (the route needs a clientId).
  const clientMeetings = useMemo(
    () => (meetings ?? []).filter((m) => m.clientId),
    [meetings]
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [briefs, setBriefs] = useState<Record<string, BriefState>>({});
  // Read latest cache inside effects without making them depend on it.
  const briefsRef = useRef(briefs);
  briefsRef.current = briefs;

  // Auto-select the soonest client meeting once the list arrives.
  useEffect(() => {
    if (selectedId && clientMeetings.some((m) => m.id === selectedId)) return;
    setSelectedId(clientMeetings.length > 0 ? clientMeetings[0].id : null);
  }, [clientMeetings, selectedId]);

  // Auto-generate the brief for the selected meeting if we don't have one.
  useEffect(() => {
    if (!selectedId) return;
    if (briefsRef.current[selectedId]) return; // already loading/ready/error
    const meeting = clientMeetings.find((m) => m.id === selectedId);
    if (meeting) void generate(meeting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, clientMeetings]);

  async function generate(meeting: Meeting, force = false) {
    if (!meeting.clientId) return;
    if (!force && briefsRef.current[meeting.id]?.status === "loading") return;
    setBriefs((prev) => ({ ...prev, [meeting.id]: { status: "loading" } }));
    try {
      const res = await fetch("/api/calendar/meetings/prep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: meeting.clientId,
          meetingId: meeting.id,
          meetingTitle: meeting.summary,
          meetingStartISO: meeting.startISO
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setBriefs((prev) => ({
        ...prev,
        [meeting.id]: { status: "ready", data: data as MeetingPrepBrief }
      }));
    } catch (err) {
      setBriefs((prev) => ({
        ...prev,
        [meeting.id]: {
          status: "error",
          message: err instanceof Error ? err.message : "couldn't prepare"
        }
      }));
    }
  }

  const selected = clientMeetings.find((m) => m.id === selectedId) ?? null;
  const state = selectedId ? briefs[selectedId] : undefined;

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink/55 inline-flex items-center gap-1.5">
        <Sparkles className="w-3.5 h-3.5" /> Meeting prep
      </div>

      <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-3">
        {meetings === null ? (
          <div className="text-sm text-ink/55 inline-flex items-center gap-2 px-1 py-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : clientMeetings.length === 0 ? (
          <div className="text-[12px] text-ink/55 px-1 py-2">
            Prep is available for client meetings. None of your upcoming meetings are matched to a client.
          </div>
        ) : (
          <div className="space-y-2.5">
            {/* Selector — only when there's more than one client meeting. */}
            {clientMeetings.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {clientMeetings.map((m) => {
                  const active = m.id === selectedId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSelectedId(m.id)}
                      className={
                        "px-2 py-1 rounded-full text-[10px] font-medium border transition-colors " +
                        (active
                          ? "bg-accent text-white border-accent"
                          : "bg-white text-ink/65 border-slate-200/70 hover:bg-slate-50")
                      }
                      title={m.summary}
                    >
                      {(m.clientName ?? m.summary)} · {fmtWhen(m.startISO)}
                    </button>
                  );
                })}
              </div>
            )}

            {selected && (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-ink truncate">
                    {selected.clientName ?? selected.summary}
                  </div>
                  <div className="text-[10px] text-ink/50">{fmtWhen(selected.startISO)}</div>
                </div>
                {state?.status === "ready" && (
                  <button
                    type="button"
                    onClick={() => generate(selected, true)}
                    className="shrink-0 inline-flex items-center gap-1 text-[10px] text-ink/55 hover:text-ink transition-colors"
                    title="Regenerate from the latest data"
                  >
                    <RefreshCw className="w-3 h-3" /> Refresh
                  </button>
                )}
              </div>
            )}

            {/* Body */}
            {!state || state.status === "loading" ? (
              <div className="text-[12px] text-ink/55 inline-flex items-center gap-2 px-0.5 py-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Preparing brief…
              </div>
            ) : state.status === "error" ? (
              <div className="text-[12px] text-rose-700 flex items-center gap-2">
                <span className="min-w-0 truncate">Couldn&apos;t prepare: {state.message}</span>
                {selected && (
                  <button
                    type="button"
                    onClick={() => generate(selected, true)}
                    className="shrink-0 underline hover:no-underline"
                  >
                    Retry
                  </button>
                )}
              </div>
            ) : (
              <BriefView brief={state.data} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BriefView({ brief }: { brief: MeetingPrepBrief }) {
  const s = brief.sources;
  const sourceBits = [
    s.completedTasks ? `${s.completedTasks} completed` : null,
    s.openTasks ? `${s.openTasks} open` : null,
    s.meetings ? `${s.meetings} meeting${s.meetings === 1 ? "" : "s"}` : null,
    s.eodUpdates ? `${s.eodUpdates} update${s.eodUpdates === 1 ? "" : "s"}` : null,
    s.emailThreads ? `${s.emailThreads} email${s.emailThreads === 1 ? "" : "s"}` : null
  ].filter(Boolean);

  const empty =
    brief.completedSinceLastMeeting.length === 0 &&
    brief.openItems.length === 0 &&
    brief.risksAndBlockers.length === 0 &&
    brief.clientRequests.length === 0 &&
    brief.suggestedDiscussionPoints.length === 0;

  return (
    <div className="space-y-2.5">
      {brief.headline && (
        <div className="text-[12px] font-medium text-ink leading-snug">{brief.headline}</div>
      )}

      {empty ? (
        <div className="text-[12px] text-ink/55">Nothing notable since the last meeting.</div>
      ) : (
        <>
          <PrepSection Icon={CheckCircle2} label="Completed since last meeting" items={brief.completedSinceLastMeeting} />
          <PrepSection Icon={CircleDot} label="Open items" items={brief.openItems} />
          <PrepSection Icon={AlertTriangle} label="Risks & blockers" items={brief.risksAndBlockers} />
          <PrepSection Icon={MessageSquare} label="Client requests" items={brief.clientRequests} />
          <PrepSection Icon={Lightbulb} label="Suggested discussion points" items={brief.suggestedDiscussionPoints} />
        </>
      )}

      {(sourceBits.length > 0 || brief.warnings.length > 0) && (
        <div className="pt-1.5 border-t border-slate-100 space-y-0.5">
          {sourceBits.length > 0 && (
            <div className="text-[10px] text-ink/45">Sources: {sourceBits.join(" · ")}</div>
          )}
          {brief.warnings.length > 0 && (
            <div className="text-[10px] text-amber-600/80">{brief.warnings.join("; ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

function PrepSection({ Icon, label, items }: { Icon: LucideIcon; label: string; items: string[] }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink/50 inline-flex items-center gap-1">
        <Icon className="w-3 h-3" /> {label}
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-ink/40 pl-4 mt-0.5">None</div>
      ) : (
        <ul className="mt-0.5 space-y-0.5 text-[12px] text-ink/80 leading-snug list-disc pl-4">
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Compact "Today · 3pm" / "Tmrw · 9:30am" / "Wed · 9am" — mirrors the helper
// in the schedule page so the prep rows read identically to the meeting list.
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  const day =
    dayDiff === 0 ? "Today" : dayDiff === 1 ? "Tmrw" : d.toLocaleDateString(undefined, { weekday: "short" });
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  const time = m === 0 ? `${display}${ampm}` : `${display}:${String(m).padStart(2, "0")}${ampm}`;
  return `${day} · ${time}`;
}
