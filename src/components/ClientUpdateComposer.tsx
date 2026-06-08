"use client";

import { useState } from "react";
import { Sparkles, Loader2, ArrowRight, Send, RefreshCw, Calendar } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// Client Update composer, rendered as a per-client section on /clients/[id].
// The operator picks a date range, hits Generate -> the AI summarizes the
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

type RangeKey = "7" | "30" | "custom";

// Day boundaries for a preset window, as ISO strings. `from` is the start of
// the day N days ago; `to` is "now" so today's completed work is included.
function presetWindow(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

// yyyy-mm-dd for <input type="date">.
function dateInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ClientUpdateComposer({
  lockedClient,
  presetDays
}: {
  lockedClient: LockedClient;
  presetDays?: number;
}) {
  // Deep-link from /approvals can preselect a range. Map 7 → preset 7,
  // 30 → preset 30, anything else (1, 14, etc.) → custom with that
  // many days back. Defaults to "7" when no preset is given.
  const initialRange: RangeKey =
    presetDays === 7 ? "7" :
    presetDays === 30 ? "30" :
    (presetDays && presetDays > 0) ? "custom" : "7";
  const [range, setRange] = useState<RangeKey>(initialRange);
  // Custom-range date inputs (yyyy-mm-dd). Default to a 7-day span so the
  // pickers aren't empty when the user first switches to Custom. When
  // presetDays is non-standard (e.g. 14), seed the custom-from to that
  // many days back so Generate works without re-picking.
  const customSeedDays = presetDays && presetDays !== 7 && presetDays !== 30 ? presetDays : 7;
  const seedAgo = new Date();
  seedAgo.setDate(seedAgo.getDate() - customSeedDays);
  const [customFrom, setCustomFrom] = useState(dateInputValue(seedAgo));
  const [customTo, setCustomTo] = useState(dateInputValue(new Date()));

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

  // Resolve the selected window to ISO {from,to} for the draft request.
  function resolveWindow(): { from: string; to: string } | null {
    if (range === "7") return presetWindow(7);
    if (range === "30") return presetWindow(30);
    if (!customFrom || !customTo) {
      toast.error("Pick both a start and end date");
      return null;
    }
    const from = new Date(`${customFrom}T00:00:00`);
    const to = new Date(`${customTo}T23:59:59`);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      toast.error("Invalid custom dates");
      return null;
    }
    if (from > to) {
      toast.error("Start date must be before end date");
      return null;
    }
    return { from: from.toISOString(), to: to.toISOString() };
  }

  async function generate() {
    const window = resolveWindow();
    if (!window) return;
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
      setScheduledFor("");
      setRange("7");
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
            AI summarizes completed work for {lockedClient.name} over the period you pick, then routes the draft to approval.
          </div>
        </div>
      </header>

      {step === "compose" ? (
        <div className="p-4 space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 block mb-1.5">
              Date range
            </label>
            <div className="inline-flex items-center gap-1">
              {([
                ["7", "Last 7 days"],
                ["30", "Last 30 days"],
                ["custom", "Custom"]
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRange(key)}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                    range === key
                      ? "bg-sky-100 text-sky-700 border-sky-200"
                      : "bg-white text-ink/65 border-slate-200 hover:text-ink hover:border-sky-200"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {range === "custom" && (
            <div className="flex items-center gap-2 flex-wrap">
              <Field label="From">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
              <Field label="To">
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0"
                />
              </Field>
            </div>
          )}

          <p className="text-[11px] text-ink/55 px-1">
            Pulls completed tasks for this client in the selected window (the same data shown in the Knowledge base below), plus any work in progress.
          </p>

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
              ← Back to range
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
