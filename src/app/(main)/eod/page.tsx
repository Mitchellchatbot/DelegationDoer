"use client";

// End-of-day reports. Each visible department gets its own panel
// listing today's completers + hours logged per person + a notes
// textarea (editable only by yourself). Leader + department heads can
// click "Send to Slack" on a panel to dispatch the digest to the
// department's configured channel.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Send, Loader2, Hash, AlertTriangle, CheckCircle2, Sparkles, History } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { EodTypeform } from "@/components/EodTypeform";
import { UpdateFeedback, type ReactionSummary, type ReplyEntry } from "@/components/UpdateFeedback";
import { useCurrentUser } from "@/lib/user-context";

interface PersonSummary {
  userId: string;
  name: string;
  avatarUrl: string | null;
  completedTasks: { id: string; title: string; priority: string }[];
  hoursLogged: number;
  note: string | null;
  workedOn: string | null;
  accomplished: string | null;
  planTomorrow: string | null;
  blockers: string | null;
  // Marketing-style flow extras (Talha Ali). Null for everyone else.
  leadsMessaged: string | null;
  linkedinComments: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string | null } | null;
}

interface DepartmentSummary {
  departmentId: string;
  departmentName: string;
  slackChannelId: string | null;
  date: string;
  totalCompleted: number;
  totalHoursLogged: number;
  people: PersonSummary[];
}

export default function EodPage() {
  const me = useCurrentUser();
  const [loading, setLoading] = useState(true);
  const [canSend, setCanSend] = useState(false);
  const [summaries, setSummaries] = useState<DepartmentSummary[]>([]);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  // Feedback (reactions + replies) keyed by EOD-note id. EOD note ids
  // are deterministic — `eod_${userId}_${noteDate}` — so the rows can
  // be looked up without an extra round-trip to fetch them.
  const [reactionsById, setReactionsById] = useState<Record<string, ReactionSummary[]>>({});
  const [repliesById, setRepliesById] = useState<Record<string, ReplyEntry[]>>({});

  // Today's date in YYYY-MM-DD (used as the upper bound on the picker
  // — viewing future dates makes no sense, and is when newly-submitted
  // rows would otherwise land if the clock drifts).
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  // Currently-viewed date. Defaults to today; the picker can rewind
  // to any past day. The page is read-only when not viewing today —
  // we don't let people back-date EOD submissions.
  const [viewDate, setViewDate] = useState<string>(todayIso);
  const today = viewDate; // alias preserved so save/submit/review callsites stay readable
  const isToday = viewDate === todayIso;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/eod?date=${viewDate}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const sums = (data.summaries ?? []) as DepartmentSummary[];
      setSummaries(sums);
      setCanSend(!!data.canSend);

      // Bulk-fetch feedback for every submitted EOD on this date.
      // Unsubmitted rows can't be reacted to, so we don't pre-load them.
      const submittedNoteIds: string[] = [];
      for (const d of sums) {
        for (const p of d.people) {
          if (p.submittedAt) submittedNoteIds.push(`eod_${p.userId}_${viewDate}`);
        }
      }
      if (submittedNoteIds.length > 0) {
        try {
          const fb = await fetch(
            `/api/updates/feedback?targetType=eod&targetIds=${encodeURIComponent(submittedNoteIds.join(","))}`,
            { cache: "no-store" }
          );
          if (fb.ok) {
            const fbData = await fb.json();
            setReactionsById((fbData.reactions ?? {}) as Record<string, ReactionSummary[]>);
            setRepliesById((fbData.replies ?? {}) as Record<string, ReplyEntry[]>);
          }
        } catch { /* non-fatal — feedback is best-effort */ }
      } else {
        setReactionsById({});
        setRepliesById({});
      }
    } catch (err) {
      toast.error(`Couldn't load EOD: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, [viewDate]);

  useEffect(() => { load(); }, [load]);

  // ---------- Typeform-mode trigger ----------
  // Auto-opens the typeform-style EOD flow when the worker is within
  // 60 minutes of their scheduled workday end (and they haven't
  // already submitted today). Also exposes a manual "Simulate shift
  // end" button so it can be tested anytime — useful for QA + for
  // leaders who want to file their EOD early.
  const [typeformOpen, setTypeformOpen] = useState(false);

  // Has *the caller* already submitted today? Pull from their own row
  // in summaries (it appears in whichever dept they belong to).
  const mySubmittedToday = useMemo(() => {
    for (const d of summaries) {
      const me_ = d.people.find((p) => p.userId === me.id);
      if (me_) return !!me_.submittedAt;
    }
    return false;
  }, [summaries, me.id]);

  // Get *today's* answers for the caller so the typeform can prefill.
  const myPrior = useMemo(() => {
    for (const d of summaries) {
      const me_ = d.people.find((p) => p.userId === me.id);
      if (me_) return {
        workedOn: me_.workedOn,
        accomplished: me_.accomplished,
        planTomorrow: me_.planTomorrow,
        blockers: me_.blockers,
        leadsMessaged: me_.leadsMessaged,
        linkedinComments: me_.linkedinComments
      };
    }
    return {
      workedOn: null,
      accomplished: null,
      planTomorrow: null,
      blockers: null,
      leadsMessaged: null,
      linkedinComments: null
    };
  }, [summaries, me.id]);

  // Auto-open: only on today's date, only if not submitted, only when
  // the wall clock crosses into the 15-min-before-shift-end window.
  // Polled every minute (cheap). Fires AT MOST ONCE per local day —
  // once the user has dismissed (or it auto-opened and they walked
  // away), we don't re-trigger that day. They can still use the
  // "Simulate shift end" button to force-open.
  useEffect(() => {
    if (!isToday || mySubmittedToday) return;
    function check() {
      const tz = me.workTimezone || "UTC";
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false
      });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
      const dayKey = (parts.weekday ?? "Mon").toLowerCase().slice(0, 3);
      const sched = (me.weeklySchedule ?? {})[dayKey as "mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun"];
      if (!sched?.end) return;
      const [eh, em] = sched.end.split(":").map(Number);
      if (Number.isNaN(eh) || Number.isNaN(em)) return;
      const nowMin = parseInt(parts.hour ?? "0", 10) * 60 + parseInt(parts.minute ?? "0", 10);
      const endMin = eh * 60 + em;
      // Window: 15 min before shift end → 2 hours past. Narrow enough
      // that a stale tab won't reopen at 6am tomorrow; wide enough
      // that late workers still catch it.
      const inWindow = nowMin >= endMin - 15 && nowMin <= endMin + 120;
      if (!inWindow) return;
      // Once-per-day flag keyed by the worker's local calendar date.
      // Dismissing the typeform doesn't unset it — they can still
      // reopen with the Simulate button.
      const localDate = `${parts.year}-${parts.month}-${parts.day}`;
      const flagKey = `eod-auto-opened:${me.id}:${localDate}`;
      try {
        if (window.localStorage.getItem(flagKey) === "1") return;
        window.localStorage.setItem(flagKey, "1");
      } catch { /* localStorage blocked — just open this once and let
                   the natural mySubmittedToday flip handle quieting */ }
      setTypeformOpen(true);
    }
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [isToday, mySubmittedToday, me.workTimezone, me.weeklySchedule]);

  // Structured EOD field keys + their on-disk + UI labels. Centralized
  // here so the save/optimistic-update logic stays simple.
  type EodFieldKey =
  | "workedOn"
  | "accomplished"
  | "planTomorrow"
  | "blockers"
  | "leadsMessaged"
  | "linkedinComments";

  async function saveField(deptId: string, key: EodFieldKey, value: string) {
    // Optimistic — paint the textarea immediately.
    setSummaries((cur) =>
      cur.map((d) =>
        d.departmentId !== deptId
          ? d
          : {
              ...d,
              people: d.people.map((p) =>
                p.userId === me.id ? { ...p, [key]: value || null } : p
              )
            }
      )
    );
    try {
      const res = await fetch("/api/eod/notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: today, [key]: value })
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      toast.error(`Couldn't save EOD field: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  // Submit the caller's own EOD for today — flips submitted_at server-
  // side, which triggers Slack DMs to leaders + the worker's dept
  // heads. Optimistic UI: paint submittedAt locally so the row
  // immediately flips into the submitted state without a refetch.
  const [submitting, setSubmitting] = useState(false);
  async function submitMyEod() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/eod/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: today })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setSummaries((cur) =>
        cur.map((d) => ({
          ...d,
          people: d.people.map((p) =>
            p.userId === me.id ? { ...p, submittedAt: data.submittedAt } : p
          )
        }))
      );
      const recipients = (data.recipients ?? []) as Array<{ name: string; delivered: boolean; reason?: string }>;
      const delivered = recipients.filter((r) => r.delivered);
      const failed = recipients.filter((r) => !r.delivered);
      if (recipients.length === 0) {
        toast.message("EOD saved — no leadership recipients configured yet.");
      } else if (delivered.length > 0) {
        toast.success(`EOD DM'd to: ${delivered.map((r) => r.name).join(", ")}`);
      }
      if (failed.length > 0) {
        toast.warning(
          `Couldn't DM ${failed.length}: ${failed.map((r) => `${r.name} (${r.reason ?? "unknown"})`).join("; ")}`,
          { duration: 8000 }
        );
      }
    } catch (err) {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  // Toggle review state on someone else's EOD row. Only callable on a
  // submitted row (the button is hidden otherwise).
  async function toggleReview(userId: string, currentlyReviewed: boolean) {
    setSummaries((cur) =>
      cur.map((d) => ({
        ...d,
        people: d.people.map((p) =>
          p.userId === userId
            ? {
                ...p,
                reviewedAt: currentlyReviewed ? null : new Date().toISOString(),
                reviewedBy: currentlyReviewed ? null : { id: me.id, name: me.name }
              }
            : p
        )
      }))
    );
    try {
      const res = await fetch("/api/eod/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, date: today, undo: currentlyReviewed })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `status ${res.status}`);
      }
    } catch (err) {
      toast.error(`Review toggle failed: ${err instanceof Error ? err.message : "unknown"}`);
      // Re-fetch on failure so UI converges with server truth.
      void load();
    }
  }

  async function send(deptId: string, deptName: string) {
    setSending((s) => ({ ...s, [deptId]: true }));
    try {
      const res = await fetch("/api/eod/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: deptId, date: today })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      const r = (data.results ?? [])[0];
      if (!r) {
        toast.error("Send returned no result");
      } else if (r.delivery === "sent") {
        toast.success(`Sent ${deptName} EOD to Slack`);
      } else if (r.delivery === "skipped_no_channel") {
        toast.message(`${deptName} has no Slack channel set yet`);
      } else if (r.delivery === "skipped_empty") {
        toast.message(`${deptName}: nothing to report today`);
      } else if (r.delivery === "failed") {
        toast.error(`${deptName} send failed: ${r.error ?? "unknown"}`);
      }
    } catch (err) {
      toast.error(`Send failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSending((s) => ({ ...s, [deptId]: false }));
    }
  }

  // Website team gets a mandatory "Client updates" section at the top
  // of their EOD — each entry posts to the workspace's Slack channel
  // on send. Leaders see it too so they can log touches and so the
  // surface is visible in their account for oversight. Other depts
  // don't see this; their EOD is just notes + completer aggregation.
  // Website + SEO teams share the same EOD shape — both work
  // client-by-client and need the per-client check-in branch (7
  // questions including which clients they touched). Leaders + stealth
  // admins see it for oversight; other depts get the generic 4-q
  // notes-only variant.
  const isWebsiteTeam =
    me.role === "leader"
    || me.isAdmin === true
    || (me.departmentIds ?? []).includes("dep_web")
    || (me.departmentIds ?? []).includes("dep_seo");

  // Talha runs marketing and his EOD asks five marketing-shaped
  // questions instead of the generic four. Matched by name (the seed
  // migration anchors his role the same way). If he ever gets renamed,
  // flip this to a stable user id.
  const isMarketingTalha = me.name === "Talha Ali";

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHero
        eyebrow="End of day"
        headline={["What got ", { accent: "done today" }]}
        subtitle="Auto-aggregated by department. Add your notes, then ship the digest to your team's Slack channel."
        icon={<Sparkles />}
        iconTone="fuchsia"
      />

      {/* Date picker — defaults to today; rewind to view any past day's
          submissions (read-only when not viewing today, since we don't
          allow back-dating EODs). */}
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] uppercase tracking-wide font-semibold text-ink/55">
          Viewing
        </label>
        <input
          type="date"
          value={viewDate}
          max={todayIso}
          onChange={(e) => setViewDate(e.target.value || todayIso)}
          className="text-xs rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20"
        />
        {!isToday && (
          <>
            <button
              type="button"
              onClick={() => setViewDate(todayIso)}
              className="text-[11px] font-medium text-accent hover:underline"
            >
              Jump to today
            </button>
            <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200/60 rounded-full px-2 py-0.5">
              Read-only — viewing a past date
            </span>
          </>
        )}
        <Link
          href="/eod/history"
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium text-ink/70 bg-white border border-slate-200 hover:text-ink hover:border-accent/40 transition-colors"
          title="Browse the team's past EOD submissions"
        >
          <History className="w-3 h-3" /> View history
        </Link>
        {isToday && (
          <button
            type="button"
            onClick={() => setTypeformOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm hover:-translate-y-0.5 active:scale-95 transition-all"
            style={{ background: "linear-gradient(135deg, #ec4899 0%, #7c3aed 100%)" }}
            title="Force-open the end-of-day typeform flow (normally auto-opens within 60 min of your scheduled shift end)"
          >
            <Sparkles className="w-3 h-3" /> Simulate shift end
          </button>
        )}
      </div>

      <EodTypeform
        open={typeformOpen}
        today={todayIso}
        isWebsiteTeam={isWebsiteTeam}
        isMarketingTalha={isMarketingTalha}
        prior={myPrior}
        onClose={() => setTypeformOpen(false)}
        onComplete={() => { void load(); }}
      />

      {loading ? (
        <div className="card p-8 text-center text-sm text-muted">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Loading today's EOD…
        </div>
      ) : summaries.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          You're not in any departments yet — ask a Leader to add you to one.
        </div>
      ) : (
        summaries.map((d) => (
          <DepartmentPanel
            key={d.departmentId}
            summary={d}
            meId={me.id}
            viewDate={viewDate}
            reactionsById={reactionsById}
            repliesById={repliesById}
            canSend={canSend && isToday}
            canReview={
              me.role === "leader" ||
              me.isAdmin === true ||
              (me.role === "department_head" && (me.departmentIds ?? []).includes(d.departmentId))
            }
            readOnly={!isToday}
            sending={!!sending[d.departmentId]}
            submitting={submitting}
            onSaveField={(key, v) => saveField(d.departmentId, key, v)}
            onSubmit={submitMyEod}
            onToggleReview={toggleReview}
            onSend={() => send(d.departmentId, d.departmentName)}
          />
        ))
      )}
    </div>
  );
}

type EodFieldKey =
  | "workedOn"
  | "accomplished"
  | "planTomorrow"
  | "blockers"
  | "leadsMessaged"
  | "linkedinComments";

function hasAnyEod(p: PersonSummary): boolean {
  return !!(
    p.note
    || p.workedOn
    || p.accomplished
    || p.planTomorrow
    || p.blockers
    || p.leadsMessaged
    || p.linkedinComments
  );
}

// Talha's EOD is shaped around marketing/LinkedIn activity, so his row
// shows a different field set than the generic team-mates'. Matched by
// name (mirrors the seed migration that anchors his department-head
// role); flip to a stable user id if he ever gets renamed.
function isMarketingPerson(p: { name: string }): boolean {
  return p.name === "Talha Ali";
}

function DepartmentPanel({
  summary, meId, viewDate, reactionsById, repliesById, canSend, canReview, readOnly, sending, submitting, onSaveField, onSubmit, onToggleReview, onSend
}: {
  summary: DepartmentSummary;
  meId: string;
  viewDate: string;
  reactionsById: Record<string, ReactionSummary[]>;
  repliesById: Record<string, ReplyEntry[]>;
  canSend: boolean;
  canReview: boolean;
  // True when the page is showing a date other than today — we hide
  // edit affordances + the Submit button so historical rows can't be
  // back-dated or mutated.
  readOnly: boolean;
  sending: boolean;
  submitting: boolean;
  onSaveField: (key: EodFieldKey, value: string) => void;
  onSubmit: () => void;
  onToggleReview: (userId: string, currentlyReviewed: boolean) => void;
  onSend: () => void;
}) {
  // Show every member (so a worker can write their note even if they
  // had a quiet day). Active members on top, then everyone else.
  const sorted = [...summary.people].sort((a, b) => {
    const aActive = a.completedTasks.length > 0 || a.hoursLogged > 0 || hasAnyEod(a);
    const bActive = b.completedTasks.length > 0 || b.hoursLogged > 0 || hasAnyEod(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (b.completedTasks.length !== a.completedTasks.length)
      return b.completedTasks.length - a.completedTasks.length;
    return a.name.localeCompare(b.name);
  });

  return (
    <section className="card p-5 space-y-3">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-base font-semibold">{summary.departmentName}</div>
          <div className="text-xs text-muted">
            {summary.totalCompleted} done · {summary.totalHoursLogged.toFixed(1)}h logged
          </div>
        </div>
        <div className="flex items-center gap-2">
          {summary.slackChannelId ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[11px] text-ink/65">
              <Hash className="w-3 h-3" />
              <span className="font-mono">{summary.slackChannelId}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/70 text-[11px]">
              <AlertTriangle className="w-3 h-3" />
              No channel set
            </span>
          )}
          {canSend && (
            <button
              type="button"
              onClick={onSend}
              disabled={sending}
              className={
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95 " +
                (sending ? "opacity-60 cursor-not-allowed" : "")
              }
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
              title={summary.slackChannelId ? "Post the EOD digest to this channel" : "Set a channel first in Settings or the Leader Console"}
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {sending ? "Sending…" : "Send to Slack"}
            </button>
          )}
        </div>
      </header>

      <div className="divide-y divide-border/40">
        {sorted.length === 0 ? (
          <div className="text-xs text-muted italic py-3">
            No members in this department yet.
          </div>
        ) : (
          sorted.map((p) => {
            const noteId = `eod_${p.userId}_${viewDate}`;
            return (
              <PersonRow
                key={p.userId}
                person={p}
                isMe={p.userId === meId}
                canReview={canReview}
                readOnly={readOnly}
                submitting={submitting}
                noteId={noteId}
                initialReactions={reactionsById[noteId] ?? []}
                initialReplies={repliesById[noteId] ?? []}
                onSaveField={onSaveField}
                onSubmit={onSubmit}
                onToggleReview={onToggleReview}
              />
            );
          })
        )}
      </div>
    </section>
  );
}

// Field definitions per the v2 spec (Section 2 base fields). Order +
// labels are surfaced here so the spec stays the source of truth.
type EodFieldDef = {
  key: EodFieldKey;
  label: string;
  placeholder: string;
  required: boolean;
};

const DEFAULT_EOD_FIELDS: ReadonlyArray<EodFieldDef> = [
  {
    key: "workedOn",
    label: "What did you work on today?",
    placeholder: "Tasks, deep-work blocks, meetings, anything that ate your time.",
    required: true
  },
  {
    key: "accomplished",
    label: "What did you accomplish?",
    placeholder: "Shipped, closed, fixed, agreed-upon — the outcomes, not the activity.",
    required: true
  },
  {
    key: "planTomorrow",
    label: "Plan for tomorrow",
    placeholder: "Top 1–3 things you'll push on tomorrow.",
    required: true
  },
  {
    key: "blockers",
    label: "Any questions or blockers?",
    placeholder: "Stuck on something? Need a decision? Drop it here so leads see it tonight.",
    required: false
  }
];

// Talha's variant — five marketing-shaped prompts, persisted to the
// same underlying columns (worked_on / leads_messaged / linkedin_comments
// / plan_tomorrow / blockers). The "accomplished" column is unused here
// so it doesn't appear on the row.
const MARKETING_EOD_FIELDS: ReadonlyArray<EodFieldDef> = [
  {
    key: "workedOn",
    label: "What was accomplished today?",
    placeholder: "The wins — shipped, closed, decided, learned.",
    required: true
  },
  {
    key: "leadsMessaged",
    label: "How many leads did you message?",
    placeholder: "Outbound DMs / cold emails sent today.",
    required: true
  },
  {
    key: "linkedinComments",
    label: "How many comments did you post on LinkedIn?",
    placeholder: "Engagement comments on prospects' posts.",
    required: true
  },
  {
    key: "planTomorrow",
    label: "Game plan for tomorrow",
    placeholder: "Top 1–3 things you'll push on tomorrow.",
    required: true
  },
  {
    key: "blockers",
    label: "Anything I can help with?",
    placeholder: "Questions, blockers, or anything for leadership to weigh in on tonight.",
    required: false
  }
];

function PersonRow({
  person, isMe, canReview, readOnly, submitting, noteId, initialReactions, initialReplies, onSaveField, onSubmit, onToggleReview
}: {
  person: PersonSummary;
  isMe: boolean;
  canReview: boolean;
  readOnly: boolean;
  submitting: boolean;
  noteId: string;
  initialReactions: ReactionSummary[];
  initialReplies: ReplyEntry[];
  onSaveField: (key: EodFieldKey, value: string) => void;
  onSubmit: () => void;
  onToggleReview: (userId: string, currentlyReviewed: boolean) => void;
}) {
  const tone = (p: string) =>
    p === "critical"
      ? "bg-rose-500"
      : p === "high"
      ? "bg-amber-500"
      : p === "medium"
      ? "bg-blue-500"
      : "bg-slate-300";

  return (
    <div className="py-3 flex items-start gap-3">
      <PersonAvatar
        userId={person.userId}
        name={person.name}
        imageUrl={person.avatarUrl ?? undefined}
        size={36}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="text-sm font-medium">{person.name}</div>
          <div className="text-xs text-muted">
            {person.completedTasks.length} done · {person.hoursLogged.toFixed(1)}h logged
          </div>
          {/* Submission state pill — visible to everyone so leadership
              can see at a glance who's filed today and who hasn't. */}
          {person.submittedAt ? (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200/60 text-[10px] font-medium"
              title={`Submitted ${new Date(person.submittedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            >
              <CheckCircle2 className="w-3 h-3" /> Submitted
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200/60 text-[10px] font-medium">
              Not submitted
            </span>
          )}
          {person.reviewedAt && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200/60 text-[10px] font-medium"
              title={`Reviewed by ${person.reviewedBy?.name ?? "someone"} at ${new Date(person.reviewedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            >
              ✓ Reviewed by {person.reviewedBy?.name ?? "—"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {isMe && !readOnly && (
              <button
                type="button"
                onClick={onSubmit}
                disabled={submitting || !!person.submittedAt}
                className={
                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all hover:-translate-y-0.5 active:scale-95 " +
                  (person.submittedAt
                    ? "bg-emerald-100 text-emerald-700 border border-emerald-200/70 cursor-default hover:translate-y-0"
                    : submitting
                    ? "opacity-60 cursor-not-allowed text-white"
                    : "text-white shadow-sm")
                }
                style={
                  person.submittedAt
                    ? undefined
                    : { background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }
                }
                title={
                  person.submittedAt
                    ? `Submitted at ${new Date(person.submittedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : "Send your EOD to leadership + your dept head"
                }
              >
                {submitting
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : person.submittedAt
                  ? <><CheckCircle2 className="w-3 h-3" /> Submitted</>
                  : <><Send className="w-3 h-3" /> Submit EOD</>
                }
              </button>
            )}
            {!isMe && canReview && person.submittedAt && (
              <button
                type="button"
                onClick={() => onToggleReview(person.userId, !!person.reviewedAt)}
                className={
                  "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors " +
                  (person.reviewedAt
                    ? "bg-violet-100 text-violet-700 border border-violet-200/70 hover:bg-violet-200/70"
                    : "bg-white text-ink/70 border border-slate-200 hover:bg-slate-50 hover:border-violet-300")
                }
                title={person.reviewedAt ? "Click to un-mark reviewed" : "Mark this EOD as reviewed"}
              >
                {person.reviewedAt ? "✓ Reviewed" : "Mark reviewed"}
              </button>
            )}
          </div>
        </div>

        {person.completedTasks.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {person.completedTasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[13px]">
                <span className={"inline-block w-1.5 h-1.5 rounded-full shrink-0 " + tone(t.priority)} />
                <span className="truncate">{t.title}</span>
                <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0 ml-auto" />
              </li>
            ))}
          </ul>
        )}

        {/* Structured EOD fields. Editor renders for `isMe` on today;
            everyone else (and the same user when looking at a past
            date) sees a read-only stack of whatever they filed. Talha
            sees a marketing-shaped 5-field set; everyone else sees the
            generic 4-field set. */}
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(isMarketingPerson(person) ? MARKETING_EOD_FIELDS : DEFAULT_EOD_FIELDS).map((f) => (
            <EodFieldCell
              key={f.key}
              field={f}
              value={person[f.key]}
              isMe={isMe && !readOnly}
              onSave={(v) => onSaveField(f.key, v)}
            />
          ))}
        </div>

        {/* Legacy free-form note — only render when it's the only
            content the user has (older rows pre-dating the structured
            split). New writes go to the structured fields above. */}
        {!isMe && person.note && !hasAnyEod({ ...person, note: null }) && (
          <div className="mt-2 text-[13px] bg-slate-50/70 border border-slate-200/60 rounded-lg px-3 py-2 whitespace-pre-wrap">
            {person.note}
          </div>
        )}

        {/* Recognition surface — reactions + replies + quick kudos
            presets. Only shown once the worker has actually submitted
            their EOD; otherwise teammates would be cheering an empty
            draft. Author can see + reply but can't recognize themselves
            (UpdateFeedback hides the kudos buttons when isSelf=true). */}
        {person.submittedAt && (
          <UpdateFeedback
            targetType="eod"
            targetId={noteId}
            isSelf={isMe}
            initialReactions={initialReactions}
            initialReplies={initialReplies}
          />
        )}
      </div>
    </div>
  );
}

function EodFieldCell({
  field, value, isMe, onSave
}: {
  field: EodFieldDef;
  value: string | null;
  isMe: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    if (!isMe) return;
    setDraft(value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (!isMe) {
    return (
      <div className="rounded-lg border border-slate-200/60 bg-slate-50/60 px-3 py-2 min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold flex items-center gap-1">
          {field.label}
          {field.required && <span className="text-rose-400">*</span>}
        </div>
        {value ? (
          <div className="text-[12px] text-ink/80 whitespace-pre-wrap mt-1 leading-snug">{value}</div>
        ) : (
          <div className="text-[11px] text-muted italic mt-1">—</div>
        )}
      </div>
    );
  }

  const missing = field.required && !draft.trim();
  return (
    <div className={"rounded-lg border bg-white px-3 py-2 min-w-0 transition-colors " + (missing ? "border-amber-300/70" : "border-slate-200/70")}>
      <label className="text-[10px] uppercase tracking-wide font-semibold flex items-center gap-1 text-ink/55">
        {field.label}
        {field.required && <span className="text-rose-400">*</span>}
      </label>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if ((draft ?? "") !== (value ?? "")) onSave(draft);
        }}
        placeholder={field.placeholder}
        rows={2}
        className="mt-1 w-full text-xs bg-transparent border-none px-0 py-0 outline-none focus:ring-0 resize-y placeholder:text-ink/35"
      />
    </div>
  );
}
