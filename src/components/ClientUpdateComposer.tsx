"use client";

import { useEffect, useState } from "react";
import { Sparkles, Loader2, ArrowRight, Send, RefreshCw, Calendar, CheckSquare, MessageSquare, Clock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// Client Update composer, rendered as a per-client section on /clients/[id].
// The window is fixed by `presetDays` (set upstream by the tab that opened
// it; defaults to 7). The operator hits Generate -> the AI summarizes the
// client's COMPLETED work (plus in-progress) for that window into a
// client-facing email, the operator reviews/edits, then Submit routes it to
// the existing approval queue (kind='client_update').
//
// Twin of ContentPlanComposer — same generate -> preview -> submit-for-approval
// flow and the same submit target (POST /api/email-drafts). The client is
// always locked (this only ever renders on a client page).

interface LockedClient {
  id: string;
  name: string;
  contactEmails: string[];
}

const DEFAULT_DAYS = 7;

// Day boundaries for a fixed N-day window, as ISO strings. `from` is the
// start of the day N days ago in UTC; `to` is "now" so today's completed
// work is included. UTC-aligned to match the /approvals recommendations
// endpoint (which uses the same UTC-midnight floor) so the per-row count
// there matches what the composer pulls in for the preview + draft.
function windowFor(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  from.setUTCHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function ClientUpdateComposer({
  lockedClient,
  presetDays,
  onSubmitted
}: {
  lockedClient: LockedClient;
  presetDays?: number;
  // Called after a successful submit-for-approval. Used by the
  // /approvals overlay modal to close itself + refresh the
  // recommendations list. On the client detail page this stays
  // undefined and the composer just resets to "compose" as before.
  onSubmitted?: () => void;
}) {
  // Window is fixed for the lifetime of this composer instance —
  // picked upstream (the /approvals tab the user is on; falls back
  // to DEFAULT_DAYS when rendered standalone on the client page).
  // The user already chose the window before opening this; we don't
  // re-ask here.
  const days = presetDays && presetDays > 0 ? presetDays : DEFAULT_DAYS;

  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftTo, setDraftTo] = useState("");
  // Tasks the AI drafted from. Forwarded to /api/email-drafts on
  // submit so the eventual approve+send can stamp them as reported
  // and the /approvals recommendations card stops surfacing them.
  const [draftTaskIds, setDraftTaskIds] = useState<string[]>([]);
  const [scheduledFor, setScheduledFor] = useState(""); // blank = send on approval
  const [attachments, setAttachments] = useState<TaskMedia[]>([]);
  const [step, setStep] = useState<"compose" | "preview">("compose");

  async function generate() {
    const window = windowFor(days);
    setGenerating(true);
    try {
      const res = await fetch("/api/client-update/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: lockedClient.id,
          clientName: lockedClient.name,
          from: window.from,
          to: window.to
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      // Graceful empty state — no completed work in the window. Stay on the
      // compose step and nudge toward a wider range instead of a hollow email.
      if (data.empty) {
        toast.message(data.message ?? "No completed work in this period.");
        return;
      }
      setDraftSubject(data.subject ?? "");
      setDraftBody(data.body ?? "");
      setDraftTo((data.suggestedTo ?? lockedClient.contactEmails ?? []).join(", "));
      setDraftTaskIds(Array.isArray(data.taskIds) ? data.taskIds : []);
      setStep("preview");
    } catch (err) {
      toast.error(`Couldn't draft: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setGenerating(false);
    }
  }

  async function submit() {
    if (!draftSubject.trim() || !draftBody.trim()) {
      return toast.error("Subject and body are required");
    }
    const toArr = draftTo.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (toArr.length === 0) {
      return toast.error("Add at least one recipient email");
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/email-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: lockedClient.id,
          clientName: lockedClient.name,
          to: toArr,
          subject: draftSubject.trim(),
          bodyText: draftBody.trim(),
          kind: "client_update",
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
          mediaUrls: attachments,
          taskIds: draftTaskIds
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const delivered = (data.slackDeliveries ?? []).filter((s: { delivered: boolean }) => s.delivered).length;
      toast.success(
        delivered > 0
          ? `Submitted — ${delivered} approver${delivered === 1 ? "" : "s"} pinged`
          : "Submitted for approval"
      );
      // Reset for the next update.
      setStep("compose");
      setDraftSubject("");
      setDraftBody("");
      setDraftTo("");
      setDraftTaskIds([]);
      setAttachments([]);
      onSubmitted?.();
      setScheduledFor("");
    } catch (err) {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-sky-200/60 bg-gradient-to-br from-sky-50/50 to-white shadow-soft overflow-hidden">
      <header className="px-5 py-3 border-b border-sky-200/40 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-sky-500 text-white grid place-items-center shadow-sm">
          <Send className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">Client update composer</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            AI summarizes the last {days} day{days === 1 ? "" : "s"} of work for {lockedClient.name} and routes the draft to approval.
          </div>
        </div>
      </header>

      {step === "compose" ? (
        <div className="p-4 space-y-3">
          <ComposerPreview clientName={lockedClient.name} days={days} />

          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={generate}
              disabled={generating}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                generating && "opacity-50 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)" }}
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {generating ? "Drafting…" : "Generate draft"}
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-sky-700/85 bg-sky-50 border border-sky-200/60 rounded-lg px-2.5 py-1.5">
            <Sparkles className="w-3 h-3" />
            AI drafted — edit anything before submitting for approval.
          </div>

          <Field label="To">
            <input
              type="text"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
              placeholder="recipient@client.com, second@client.com"
              className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35"
            />
          </Field>
          <Field label="Subject">
            <input
              type="text"
              value={draftSubject}
              onChange={(e) => setDraftSubject(e.target.value)}
              className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 font-medium"
            />
          </Field>

          <Field label="Send on">
            <Calendar className="w-3 h-3 text-ink/45" />
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0"
            />
            <span className="text-[10px] text-ink/45 shrink-0">
              {scheduledFor ? "queued until this date" : "sends immediately on approval"}
            </span>
          </Field>

          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={16}
            className="w-full text-[13px] bg-white border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-200/40 focus:border-sky-400/50 resize-y leading-relaxed"
          />

          <div>
            <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 mb-1.5">
              Attachments
            </div>
            <MediaPicker
              value={attachments}
              onChange={setAttachments}
              label="Attach files"
              compact
              hint={scheduledFor ? "Attachments are dropped on scheduled sends — clear the send date to keep them." : undefined}
            />
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setStep("compose")}
              className="inline-flex items-center gap-1.5 text-[12px] text-ink/65 hover:text-ink px-2 py-1"
            >
              ← Back to preview
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-sky-700 bg-white border border-sky-200/70 hover:bg-sky-50 transition-colors"
              >
                {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Re-draft
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className={cn(
                  "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                  submitting && "opacity-60 cursor-not-allowed hover:translate-y-0"
                )}
                style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
              >
                {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                {submitting ? "Submitting…" : "Submit for approval"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white">
      <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-16 shrink-0">{label}</span>
      {children}
    </div>
  );
}

interface PreviewData {
  tasks: Array<{
    id: string;
    title: string;
    completedAt: string | null;
    assigneeName: string | null;
    tags: string[];
  }>;
  tasksInProgress: Array<{
    id: string;
    title: string;
    status: string;
    assigneeName: string | null;
    tags: string[];
    lastActivityAt: string | null;
  }>;
  eodNotes: Array<{
    authorName: string;
    noteDate: string;
    workedOn: string | null;
    accomplished: string | null;
  }>;
}

// Live preview of what the AI will summarize: completed tasks in the
// window, work still in progress, + EOD notes from teammates who closed
// those tasks. Refetches whenever the window (days) changes so the user
// sees the input set before clicking Generate.
function ComposerPreview({
  clientName, days
}: {
  clientName: string;
  days: number;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Resolve the (from, to) ISO pair the same way the real Generate
    // path does, so the preview matches exactly what will feed the AI.
    const window = windowFor(days);
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({
      clientName,
      from: window.from,
      to: window.to
    });
    fetch(`/api/client-update/preview?${qs}`, { cache: "no-store" })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return;
        if (!ok) {
          setError(j?.error ?? "preview failed");
          setData(null);
        } else {
          setData({
            tasks: j.tasks ?? [],
            tasksInProgress: j.tasksInProgress ?? [],
            eodNotes: j.eodNotes ?? []
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "preview failed");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Re-run only when the window (days) or client changes.
  }, [clientName, days]);

  return (
    <div className="rounded-xl border border-slate-200/70 bg-white p-3 space-y-3">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
        What the AI will summarize
      </div>
      {loading ? (
        <div className="text-[11px] text-ink/55 inline-flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading context…
        </div>
      ) : error ? (
        <div className="text-[11px] text-rose-700">{error}</div>
      ) : !data || (data.tasks.length === 0 && data.tasksInProgress.length === 0 && data.eodNotes.length === 0) ? (
        <div className="text-[11px] text-ink/55 italic">
          Nothing completed, in progress, or noted by contributors in this window. Widen the range or pick a different period.
        </div>
      ) : (
        <div className="space-y-3">
          {data.tasks.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5 inline-flex items-center gap-1">
                <CheckSquare className="w-3 h-3" />
                Completed tasks · {data.tasks.length}
              </div>
              <ul className="space-y-1">
                {data.tasks.slice(0, 8).map((t) => (
                  <li key={t.id} className="text-[12px] text-ink/80">
                    <div className="font-medium truncate">{t.title}</div>
                    <div className="text-[10px] text-ink/50 flex items-center gap-1.5 flex-wrap">
                      {t.assigneeName && <span>{t.assigneeName}</span>}
                      {t.completedAt && (
                        <>
                          {t.assigneeName && <span>·</span>}
                          <span className="tabular-nums">{t.completedAt.slice(0, 10)}</span>
                        </>
                      )}
                      {t.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/65 text-[9px]">{tag}</span>
                      ))}
                    </div>
                  </li>
                ))}
                {data.tasks.length > 8 && (
                  <li className="text-[10px] text-ink/45 italic">
                    + {data.tasks.length - 8} more not shown above (all are included in the draft).
                  </li>
                )}
              </ul>
            </div>
          )}
          {data.tasksInProgress.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5 inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                In progress · {data.tasksInProgress.length}
              </div>
              <ul className="space-y-1">
                {data.tasksInProgress.slice(0, 8).map((t) => (
                  <li key={t.id} className="text-[12px] text-ink/80">
                    <div className="font-medium truncate">{t.title}</div>
                    <div className="text-[10px] text-ink/50 flex items-center gap-1.5 flex-wrap">
                      {t.status && (
                        <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px]">
                          {t.status.replace(/_/g, " ")}
                        </span>
                      )}
                      {t.assigneeName && <span>{t.assigneeName}</span>}
                      {t.lastActivityAt && (
                        <>
                          {t.assigneeName && <span>·</span>}
                          <span className="tabular-nums">{t.lastActivityAt.slice(0, 10)}</span>
                        </>
                      )}
                      {t.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/65 text-[9px]">{tag}</span>
                      ))}
                    </div>
                  </li>
                ))}
                {data.tasksInProgress.length > 8 && (
                  <li className="text-[10px] text-ink/45 italic">
                    + {data.tasksInProgress.length - 8} more not shown above (all are included in the draft).
                  </li>
                )}
              </ul>
            </div>
          )}
          {data.eodNotes.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5 inline-flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                EOD notes from contributors · {data.eodNotes.length}
              </div>
              <ul className="space-y-2">
                {data.eodNotes.slice(0, 5).map((n, idx) => (
                  <li key={`${n.authorName}-${n.noteDate}-${idx}`} className="text-[11.5px] text-ink/75 leading-relaxed">
                    <div className="text-[10px] text-ink/55 font-semibold mb-0.5">
                      {n.authorName} · <span className="tabular-nums">{n.noteDate}</span>
                    </div>
                    {n.workedOn && (
                      <div><span className="text-ink/55">Worked on: </span>{n.workedOn}</div>
                    )}
                    {n.accomplished && (
                      <div><span className="text-ink/55">Accomplished: </span>{n.accomplished}</div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
