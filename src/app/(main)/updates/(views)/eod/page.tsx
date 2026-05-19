"use client";

// End-of-day reports. Each visible department gets its own panel
// listing today's completers + hours logged per person + a notes
// textarea (editable only by yourself). Leader + department heads can
// click "Send to Slack" on a panel to dispatch the digest to the
// department's configured channel.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Send, Loader2, Hash, AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { PageHero } from "@/components/PageHero";
import { PersonAvatar } from "@/components/PersonAvatar";
import { ClientUpdatesSection } from "@/components/ClientUpdatesSection";
import { ClientCheckInSection } from "@/components/ClientCheckInSection";
import { useCurrentUser } from "@/lib/user-context";

interface PersonSummary {
  userId: string;
  name: string;
  avatarUrl: string | null;
  completedTasks: { id: string; title: string; priority: string }[];
  hoursLogged: number;
  note: string | null;
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

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/eod?date=${today}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setSummaries((data.summaries ?? []) as DepartmentSummary[]);
      setCanSend(!!data.canSend);
    } catch (err) {
      toast.error(`Couldn't load EOD: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => { load(); }, [load]);

  async function saveNote(deptId: string, value: string) {
    // Optimistic — paint the textarea immediately.
    setSummaries((cur) =>
      cur.map((d) =>
        d.departmentId !== deptId
          ? d
          : {
              ...d,
              people: d.people.map((p) =>
                p.userId === me.id ? { ...p, note: value || null } : p
              )
            }
      )
    );
    try {
      const res = await fetch("/api/eod/notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: today, note: value })
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      toast.error(`Couldn't save note: ${err instanceof Error ? err.message : "unknown"}`);
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
  const isWebsiteTeam =
    me.role === "leader"
    || me.isAdmin === true
    || (me.departmentIds ?? []).includes("dep_web");

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHero
        eyebrow="End of day"
        headline={["What got ", { accent: "done today" }]}
        subtitle="Auto-aggregated by department. Add your notes, then ship the digest to your team's Slack channel."
        icon={<Sparkles />}
        iconTone="fuchsia"
      />

      {isWebsiteTeam && (
        <>
          <ClientCheckInSection today={today} />
          <ClientUpdatesSection today={today} />
        </>
      )}

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
            canSend={canSend}
            sending={!!sending[d.departmentId]}
            onSaveNote={(v) => saveNote(d.departmentId, v)}
            onSend={() => send(d.departmentId, d.departmentName)}
          />
        ))
      )}
    </div>
  );
}

function DepartmentPanel({
  summary, meId, canSend, sending, onSaveNote, onSend
}: {
  summary: DepartmentSummary;
  meId: string;
  canSend: boolean;
  sending: boolean;
  onSaveNote: (value: string) => void;
  onSend: () => void;
}) {
  // Show every member (so a worker can write their note even if they
  // had a quiet day). Active members on top, then everyone else.
  const sorted = [...summary.people].sort((a, b) => {
    const aActive = a.completedTasks.length > 0 || a.hoursLogged > 0 || !!a.note;
    const bActive = b.completedTasks.length > 0 || b.hoursLogged > 0 || !!b.note;
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
          sorted.map((p) => (
            <PersonRow
              key={p.userId}
              person={p}
              isMe={p.userId === meId}
              onSaveNote={onSaveNote}
            />
          ))
        )}
      </div>
    </section>
  );
}

function PersonRow({
  person, isMe, onSaveNote
}: {
  person: PersonSummary;
  isMe: boolean;
  onSaveNote: (value: string) => void;
}) {
  const [draft, setDraft] = useState(person.note ?? "");
  // Resync the textarea if the server-side note changes (e.g. another
  // tab updated it). Skip if we're the editor and have a non-empty
  // unsaved draft we don't want to clobber.
  useEffect(() => {
    if (!isMe) return;
    setDraft(person.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person.note]);

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

        <div className="mt-2">
          <label className="block text-[10px] uppercase tracking-wide text-ink/45 mb-1">
            Notes {isMe ? "(yours — autosaves on blur)" : ""}
          </label>
          {isMe ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if ((draft ?? "") !== (person.note ?? "")) onSaveNote(draft);
              }}
              placeholder="What did you work on today? Any blockers? Anything to brag about?"
              rows={2}
              className="w-full text-xs bg-white border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-y transition-all"
            />
          ) : person.note ? (
            <div className="text-[13px] bg-slate-50/70 border border-slate-200/60 rounded-lg px-3 py-2 whitespace-pre-wrap">
              {person.note}
            </div>
          ) : (
            <div className="text-[11px] text-muted italic">
              No notes yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
