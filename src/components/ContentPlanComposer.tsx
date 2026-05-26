"use client";

import { useEffect, useState } from "react";
import { Sparkles, Loader2, ArrowRight, Send, RefreshCw, Calendar } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// Content Plan composer for SEO team. Worker picks a client, types raw
// topic bullets, hits Generate → AI returns a Bella-template-shaped
// email (subject + body), worker reviews/edits, hits Submit to send it
// to the approval queue (kind='content_plan'). Approvers per spec:
// Sam, Mitchell, Tabrez, Farez, Bismah, Mujtaba (any one approves).
//
// Two modes:
//   - No props: full self-contained composer (used on /updates/seo).
//   - { lockedClient } prop set: client is pre-picked and the dropdown
//     becomes a static label. Used as a per-client section on
//     /clients/[id].

interface ClientOption { id: string; name: string; contactEmails: string[] }

interface LockedClient {
  id: string;
  name: string;
  contactEmails: string[];
}

export function ContentPlanComposer({ lockedClient }: { lockedClient?: LockedClient } = {}) {
  const [clients, setClients] = useState<ClientOption[]>(
    lockedClient ? [{ id: lockedClient.id, name: lockedClient.name, contactEmails: lockedClient.contactEmails }] : []
  );
  const [clientId, setClientId] = useState(lockedClient?.id ?? "");
  const [topics, setTopics] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [angle, setAngle] = useState("");
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftTo, setDraftTo] = useState("");
  // Default send date: next Monday at 9am — typical monthly-plan timing.
  const [scheduledFor, setScheduledFor] = useState(defaultScheduledFor);
  const [attachments, setAttachments] = useState<TaskMedia[]>([]);
  const [step, setStep] = useState<"compose" | "preview">("compose");

  useEffect(() => {
    if (lockedClient) return; // no need to fetch the full roster
    let cancelled = false;
    fetch("/api/clients", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const list = ((d.clients ?? []) as Array<{ id: string; name: string; contactEmails?: string[] }>)
          .map((c) => ({ id: c.id, name: c.name, contactEmails: c.contactEmails ?? [] }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setClients(list);
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [lockedClient]);

  const selectedClient = clients.find((c) => c.id === clientId);

  async function generate() {
    if (!clientId) return toast.error("Pick a client first");
    if (!topics.trim()) return toast.error("Add topics / cluster bullets");
    setGenerating(true);
    try {
      const res = await fetch("/api/content-plan/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          clientName: selectedClient?.name ?? "Client",
          topics: topics.trim(),
          targetAudience: targetAudience.trim() || undefined,
          angle: angle.trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setDraftSubject(data.subject ?? "");
      setDraftBody(data.body ?? "");
      setDraftTo((selectedClient?.contactEmails ?? data.suggestedTo ?? []).join(", "));
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
          clientId,
          clientName: selectedClient?.name ?? "Client",
          to: toArr,
          subject: draftSubject.trim(),
          bodyText: draftBody.trim(),
          kind: "content_plan",
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
          mediaUrls: attachments
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
      // Reset for the next plan.
      setStep("compose");
      setTopics("");
      setTargetAudience("");
      setAngle("");
      setDraftSubject("");
      setDraftBody("");
      setDraftTo("");
      setAttachments([]);
      setScheduledFor(defaultScheduledFor());
      // Keep clientId pinned when the composer is locked to a client.
      if (!lockedClient) setClientId("");
    } catch (err) {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-violet-200/60 bg-gradient-to-br from-violet-50/50 to-white shadow-soft overflow-hidden">
      <header className="px-5 py-3 border-b border-violet-200/40 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-violet-500 text-white grid place-items-center shadow-sm">
          <Sparkles className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">Monthly Content Plan composer</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            Drop in topics → AI drafts the email in our standard format → routes to Sam / Mitch / Tabrez / Farez / Bismah / Mujtaba for approval.
          </div>
        </div>
      </header>

      {step === "compose" ? (
        <div className="p-4 space-y-3">
          <Field label="Client">
            {lockedClient ? (
              <span className="flex-1 text-[13px] font-medium text-ink truncate">
                {lockedClient.name}
              </span>
            ) : (
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={generating}
                className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0"
              >
                <option value="">Pick a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Audience">
            <input
              type="text"
              value={targetAudience}
              onChange={(e) => setTargetAudience(e.target.value)}
              placeholder="(optional) — e.g. mid-career job seekers, families researching recovery, etc."
              className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35"
            />
          </Field>

          <Field label="Angle">
            <input
              type="text"
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              placeholder="(optional) — positioning angle / search-intent strategy"
              className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35"
            />
          </Field>

          <div>
            <label className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 block mb-1">
              Topics / cluster bullets
            </label>
            <textarea
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              rows={8}
              placeholder={`Raw bullets are fine. Example:
- Cluster: Entry-level transitions
  • What to expect in first 90 days
  • Resume formats that survive ATS
- Cluster: Mid-career pivots
  • Bridging gaps
  • Network signaling`}
              className="w-full text-[13px] bg-white border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-violet-200/40 focus:border-violet-400/50 resize-y"
            />
          </div>

          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={generate}
              disabled={generating || !clientId || !topics.trim()}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                (generating || !clientId || !topics.trim()) && "opacity-50 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {generating ? "Drafting…" : "Generate draft"}
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-violet-700/85 bg-violet-50 border border-violet-200/60 rounded-lg px-2.5 py-1.5">
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
            className="w-full text-[13px] bg-white border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-violet-200/40 focus:border-violet-400/50 resize-y leading-relaxed"
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
              ← Back to topics
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-violet-700 bg-white border border-violet-200/70 hover:bg-violet-50 transition-colors"
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

// Next Monday 9am, formatted for <input type="datetime-local">. Most
// monthly content plans go out on Monday mornings — defaulting to it
// saves a click but leaves the user free to override.
function defaultScheduledFor(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(9, 0, 0, 0);
  const dow = d.getDay();
  const daysUntilMon = ((1 - dow) + 7) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMon);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
