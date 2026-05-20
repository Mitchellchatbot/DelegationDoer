"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles, ArrowRight, ArrowLeft, Check, Loader2, X, Mail, Plus, Send, Clipboard
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Typeform-style end-of-day flow. One question per screen, animated
// transitions, autosaves each answer on advance via PUT /api/eod/notes
// so progress survives a refresh. Last step fires /api/eod/submit
// which DMs leadership + the worker's dept head(s).
//
// The Website team gets an extra branch after the four structured
// questions — a "want to log a client email?" yes/no, and a loopable
// composer if yes. Each email POSTs to /api/eod/client-checkins.
//
// Trigger lives on the EOD page: auto-opens within ~60min of the
// worker's weeklySchedule end_time, or manually via a "Simulate shift
// end" button for testing.

interface ClientOption { id: string; name: string }

interface PriorState {
  workedOn: string | null;
  accomplished: string | null;
  planTomorrow: string | null;
  blockers: string | null;
}

interface EmailDraft {
  localId: string;
  clientId: string;
  subject: string;
  body: string;
  status: "drafting" | "sending" | "sent" | "error";
  error?: string;
}

interface Props {
  open: boolean;
  today: string;
  isWebsiteTeam: boolean;
  prior: PriorState;
  onClose: () => void;
  onComplete: () => void;
}

// Step definitions for the four base questions. Driving them off a
// constant lets the typeform engine stay generic — adding/removing a
// step is a one-line change.
const STRUCTURED_STEPS = [
  {
    key: "workedOn" as const,
    title: "What did you work on today?",
    subtitle: "Tasks, deep-work, meetings — the activity, not the outcomes.",
    required: true
  },
  {
    key: "accomplished" as const,
    title: "What did you accomplish?",
    subtitle: "What's shipped, closed, fixed, or decided. Outcomes only.",
    required: true
  },
  {
    key: "planTomorrow" as const,
    title: "Plan for tomorrow",
    subtitle: "Top 1–3 things you'll push on tomorrow morning.",
    required: true
  },
  {
    key: "blockers" as const,
    title: "Any questions or blockers?",
    subtitle: "Stuck? Need a decision? Drop it here so leads see it tonight.",
    required: false
  }
];

export function EodTypeform({
  open, today, isWebsiteTeam, prior, onClose, onComplete
}: Props) {
  // step indices: 0..3 = the four structured questions, 4 = (web only)
  // "want to log a client email?" yes/no, 5 = compose-email loop, 6 =
  // final submitting/success. For non-website teams step 4 is skipped.
  const totalSteps = 4 + (isWebsiteTeam ? 2 : 0) + 1; // +1 for the final summary screen
  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState<PriorState>(prior);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [wantsEmail, setWantsEmail] = useState(false);
  const [emails, setEmails] = useState<EmailDraft[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [direction, setDirection] = useState<"forward" | "back">("forward");

  // Reset state every time the modal opens fresh (e.g. user closed it
  // without submitting and reopened later).
  useEffect(() => {
    if (!open) return;
    setStepIdx(0);
    setAnswers(prior);
    setWantsEmail(false);
    setEmails([]);
    setSubmitted(false);
    setSubmitting(false);
    setDirection("forward");
  }, [open, prior]);

  // Load clients lazily, only when the Website branch is in scope.
  useEffect(() => {
    if (!open || !isWebsiteTeam) return;
    let cancelled = false;
    fetch("/api/clients", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const list = ((d.clients ?? []) as Array<{ id: string; name: string }>)
          .map((c) => ({ id: c.id, name: c.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        setClients(list);
      })
      .catch(() => { /* silent — composer falls back to manual */ });
    return () => { cancelled = true; };
  }, [open, isWebsiteTeam]);

  const saveField = useCallback(
    async (key: keyof PriorState, value: string) => {
      setAnswers((cur) => ({ ...cur, [key]: value || null }));
      setSavingField(key);
      try {
        const res = await fetch("/api/eod/notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: today, [key]: value })
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
      } catch (err) {
        toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
      } finally {
        setSavingField(null);
      }
    },
    [today]
  );

  function advance() {
    setDirection("forward");
    setStepIdx((i) => Math.min(totalSteps - 1, i + 1));
  }
  function regress() {
    setDirection("back");
    setStepIdx((i) => Math.max(0, i - 1));
  }

  function newDraft(): EmailDraft {
    return {
      localId: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      clientId: "",
      subject: "",
      body: "",
      status: "drafting"
    };
  }

  function patchDraft(localId: string, patch: Partial<EmailDraft>) {
    setEmails((cur) => cur.map((d) => d.localId === localId ? { ...d, ...patch } : d));
  }

  async function sendDraft(localId: string) {
    const draft = emails.find((d) => d.localId === localId);
    if (!draft) return;
    if (!draft.clientId) return patchDraft(localId, { error: "Pick a client" });
    if (!draft.subject.trim()) return patchDraft(localId, { error: "Subject required" });
    if (!draft.body.trim()) return patchDraft(localId, { error: "Body required" });
    const client = clients.find((c) => c.id === draft.clientId);
    patchDraft(localId, { status: "sending", error: undefined });
    try {
      const res = await fetch("/api/eod/client-checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: today,
          clientId: draft.clientId,
          clientName: client?.name ?? "Client",
          subject: draft.subject.trim(),
          message: draft.body.trim()
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      patchDraft(localId, { status: "sent" });
    } catch (err) {
      patchDraft(localId, {
        status: "error",
        error: err instanceof Error ? err.message : "send failed"
      });
    }
  }

  async function submitEod() {
    setSubmitting(true);
    try {
      // Send the answers in the body so we don't depend on autosave
      // having landed (and even if it errored on a missing column,
      // the submit endpoint upserts directly).
      const res = await fetch("/api/eod/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: today,
          workedOn: answers.workedOn ?? "",
          accomplished: answers.accomplished ?? "",
          planTomorrow: answers.planTomorrow ?? "",
          blockers: answers.blockers ?? ""
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setSubmitted(true);
      const delivered = (data.recipients ?? []).filter((r: { delivered: boolean }) => r.delivered).length;
      toast.success(`EOD submitted — ${delivered} leader${delivered === 1 ? "" : "s"} notified`);
      onComplete();
    } catch (err) {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  // Keyboard shortcuts — Enter to advance from a question, Shift+Enter
  // for newline inside textareas (default browser behavior), Escape to
  // close. Arrow keys nudge back/forward when not focused in an input.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const progress = useMemo(() => Math.min(100, Math.round((stepIdx / (totalSteps - 1)) * 100)), [stepIdx, totalSteps]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-gradient-to-br from-slate-50 via-white to-blue-50/40 overflow-hidden anim-fade-in"
      role="dialog"
      aria-modal="true"
    >
      {/* Top bar with progress + close. Keeps the worker oriented and
          gives them an escape hatch if they need to bail. */}
      <div className="absolute top-0 inset-x-0 z-10 px-6 py-3 flex items-center gap-3 backdrop-blur-md bg-white/60 border-b border-slate-200/60">
        <Sparkles className="w-4 h-4 text-fuchsia-500" />
        <div className="text-xs uppercase tracking-wide font-semibold text-ink/65">End of day</div>
        <div className="flex-1 h-1 rounded-full bg-slate-200/70 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-fuchsia-400 to-blue-500 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-ink/55 hover:text-ink hover:bg-slate-100/70 transition-colors"
          title="Close (you can finish later)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="absolute inset-0 pt-20 pb-24 px-6 flex items-center justify-center">
        <div
          key={stepIdx}
          className={cn(
            "w-full max-w-2xl",
            direction === "forward" ? "anim-fade-in-up" : "anim-fade-in"
          )}
        >
          {stepIdx < 4 && (
            <StructuredQuestion
              field={STRUCTURED_STEPS[stepIdx]}
              value={answers[STRUCTURED_STEPS[stepIdx].key] ?? ""}
              saving={savingField === STRUCTURED_STEPS[stepIdx].key}
              onChange={(v) => setAnswers((cur) => ({ ...cur, [STRUCTURED_STEPS[stepIdx].key]: v }))}
              onAdvance={() => {
                void saveField(STRUCTURED_STEPS[stepIdx].key, answers[STRUCTURED_STEPS[stepIdx].key] ?? "");
                advance();
              }}
            />
          )}

          {isWebsiteTeam && stepIdx === 4 && (
            <EmailGate
              onYes={() => {
                setWantsEmail(true);
                if (emails.length === 0) setEmails([newDraft()]);
                advance();
              }}
              onNo={() => {
                setWantsEmail(false);
                advance();
              }}
            />
          )}

          {isWebsiteTeam && stepIdx === 5 && (
            <EmailComposer
              drafts={emails}
              clients={clients}
              wantsEmail={wantsEmail}
              onAddDraft={() => setEmails((cur) => [...cur, newDraft()])}
              onRemoveDraft={(id) => setEmails((cur) => cur.filter((d) => d.localId !== id))}
              onPatchDraft={patchDraft}
              onSendDraft={sendDraft}
              onAdvance={advance}
            />
          )}

          {stepIdx === totalSteps - 1 && (
            <FinalStep
              submitting={submitting}
              submitted={submitted}
              answers={answers}
              sentEmailCount={emails.filter((e) => e.status === "sent").length}
              onSubmit={submitEod}
              onClose={onClose}
            />
          )}
        </div>
      </div>

      {/* Footer nav: Back arrow, step counter, Next/Submit affordance.
          Sticky to the bottom so users always know where they are. */}
      <div className="absolute bottom-0 inset-x-0 z-10 px-6 py-4 flex items-center justify-between bg-gradient-to-t from-white via-white/95 to-transparent">
        <button
          type="button"
          onClick={regress}
          disabled={stepIdx === 0}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ink/65 disabled:opacity-40 hover:text-ink transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="text-[11px] uppercase tracking-wide text-ink/45 font-semibold">
          Step {stepIdx + 1} of {totalSteps}
        </div>
        <div className="w-[68px]" />
      </div>
    </div>
  );
}

function StructuredQuestion({
  field, value, saving, onChange, onAdvance
}: {
  field: { key: string; title: string; subtitle: string; required: boolean };
  value: string;
  saving: boolean;
  onChange: (v: string) => void;
  onAdvance: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    // Autofocus the textarea when the question lands.
    ref.current?.focus();
  }, []);

  const canAdvance = !field.required || value.trim().length > 0;

  return (
    <div className="space-y-5">
      <div className="text-[10px] uppercase tracking-wide font-bold text-fuchsia-500/85">
        Question {field.required ? "(required)" : "(optional)"}
      </div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">
        {field.title}
      </h1>
      <p className="text-sm text-ink/65">{field.subtitle}</p>

      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl + Enter advances; plain Enter just adds a newline
          // so paragraph answers work naturally.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canAdvance) {
            e.preventDefault();
            onAdvance();
          }
        }}
        placeholder="Type your answer here…"
        rows={4}
        className="w-full text-base bg-white border-2 border-slate-200 rounded-2xl px-5 py-4 outline-none focus:border-fuchsia-400/70 focus:ring-4 focus:ring-fuchsia-200/40 resize-none transition-all placeholder:text-ink/30 shadow-sm"
      />

      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-ink/45">
          {saving && (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Saving…
            </span>
          )}
          {!saving && value.trim() && (
            <span className="inline-flex items-center gap-1 text-emerald-600/85">
              <Check className="w-3 h-3" /> Auto-saved
            </span>
          )}
          <span className="ml-2 text-ink/35">⌘ + Enter to continue</span>
        </div>
        <button
          type="button"
          onClick={onAdvance}
          disabled={!canAdvance}
          className={cn(
            "inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95",
            !canAdvance && "opacity-40 cursor-not-allowed hover:translate-y-0"
          )}
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function EmailGate({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  return (
    <div className="space-y-6 text-center">
      <Mail className="w-10 h-10 text-violet-500 mx-auto" />
      <h1 className="text-3xl font-semibold leading-tight text-ink">
        Did you email any clients today?
      </h1>
      <p className="text-sm text-ink/65 max-w-md mx-auto">
        Log the To / Subject / Body so the team has a record. You can add as many as you like.
      </p>
      <div className="flex items-center justify-center gap-3 pt-2">
        <button
          type="button"
          onClick={onNo}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-ink/70 bg-white border-2 border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-all"
        >
          No, skip
        </button>
        <button
          type="button"
          onClick={onYes}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
          style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
        >
          <Mail className="w-4 h-4" /> Yes, log an email
        </button>
      </div>
    </div>
  );
}

function EmailComposer({
  drafts, clients, wantsEmail, onAddDraft, onRemoveDraft, onPatchDraft, onSendDraft, onAdvance
}: {
  drafts: EmailDraft[];
  clients: ClientOption[];
  wantsEmail: boolean;
  onAddDraft: () => void;
  onRemoveDraft: (localId: string) => void;
  onPatchDraft: (localId: string, patch: Partial<EmailDraft>) => void;
  onSendDraft: (localId: string) => void;
  onAdvance: () => void;
}) {
  if (!wantsEmail) {
    // User said no — bounce straight to the final step. Render a
    // soft prompt while the parent advances.
    return (
      <div className="text-center text-sm text-ink/55">
        Skipping email step…
      </div>
    );
  }

  const sentCount = drafts.filter((d) => d.status === "sent").length;

  return (
    <div className="space-y-4">
      <div className="text-[10px] uppercase tracking-wide font-bold text-violet-500/85">
        Client emails ({sentCount} logged)
      </div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">
        Log the email{drafts.length > 1 ? "s" : ""} you sent
      </h1>
      <p className="text-sm text-ink/65">
        To, Subject, Body. Each one posts to Slack so the team sees the touch.
      </p>

      <div className="space-y-3 max-h-[55vh] overflow-y-auto pr-1">
        {drafts.map((d) => (
          <DraftCard
            key={d.localId}
            draft={d}
            clients={clients}
            onPatch={(p) => onPatchDraft(d.localId, p)}
            onRemove={() => onRemoveDraft(d.localId)}
            onSend={() => onSendDraft(d.localId)}
          />
        ))}
        <button
          type="button"
          onClick={onAddDraft}
          className="w-full text-sm font-medium text-violet-700 hover:text-violet-900 py-2.5 rounded-xl border-2 border-dashed border-violet-200 hover:border-violet-400/60 hover:bg-violet-50/40 transition-colors inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Compose another
        </button>
      </div>

      <div className="flex items-center justify-end pt-2">
        <button
          type="button"
          onClick={onAdvance}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          Done with emails <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function DraftCard({
  draft, clients, onPatch, onRemove, onSend
}: {
  draft: EmailDraft;
  clients: ClientOption[];
  onPatch: (p: Partial<EmailDraft>) => void;
  onRemove: () => void;
  onSend: () => void;
}) {
  const clientName = clients.find((c) => c.id === draft.clientId)?.name ?? "";
  const isSent = draft.status === "sent";
  const isSending = draft.status === "sending";
  const canSend = !!draft.clientId && draft.subject.trim() && draft.body.trim();

  return (
    <div className={cn(
      "rounded-xl border bg-white shadow-sm overflow-hidden transition-colors",
      isSent ? "border-emerald-200/70 bg-emerald-50/30" : "border-violet-200/60"
    )}>
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50/70 border-b border-slate-200/60">
        <Mail className="w-4 h-4 text-violet-600" />
        <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
          {isSent ? "Email logged" : "New email"}
        </span>
        {!isSent && (
          <button
            type="button"
            onClick={onRemove}
            disabled={isSending}
            className="ml-auto p-1 rounded text-ink/40 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40"
            title="Discard"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/50">
        <label className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14">To</label>
        <select
          value={draft.clientId}
          onChange={(e) => onPatch({ clientId: e.target.value, error: undefined })}
          disabled={isSent || isSending}
          className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 disabled:opacity-70"
        >
          <option value="">Pick a client…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/50">
        <label className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14">Subject</label>
        <input
          type="text"
          value={draft.subject}
          onChange={(e) => onPatch({ subject: e.target.value, error: undefined })}
          disabled={isSent || isSending}
          placeholder={clientName ? `Re: ${clientName}` : "Email subject"}
          maxLength={300}
          className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35 disabled:opacity-70"
        />
      </div>

      <textarea
        value={draft.body}
        onChange={(e) => onPatch({ body: e.target.value, error: undefined })}
        disabled={isSent || isSending}
        placeholder={clientName
          ? `Body of the email you sent ${clientName}…`
          : "Body of the email"
        }
        rows={5}
        maxLength={4000}
        className="block w-full text-[13px] bg-white border-none px-3 py-2.5 outline-none focus:ring-0 resize-y placeholder:text-ink/35 disabled:opacity-70"
      />

      <div className="flex items-center justify-between px-3 py-2 border-t border-slate-200/50 bg-slate-50/40">
        {draft.error ? (
          <span className="text-[11px] text-rose-700">{draft.error}</span>
        ) : (
          <span className="text-[10px] text-ink/45 tabular-nums">
            {draft.body.length} / 4000
          </span>
        )}
        {isSent ? (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold text-emerald-700">
            <Check className="w-3.5 h-3.5" /> Logged
          </span>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend || isSending}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
              (!canSend || isSending) && "opacity-50 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
          >
            {isSending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {isSending ? "Sending…" : "Send"}
          </button>
        )}
      </div>
    </div>
  );
}

function FinalStep({
  submitting, submitted, answers, sentEmailCount, onSubmit, onClose
}: {
  submitting: boolean;
  submitted: boolean;
  answers: PriorState;
  sentEmailCount: number;
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (submitted) {
    return (
      <div className="text-center space-y-5">
        <div className="w-16 h-16 rounded-full bg-emerald-100 mx-auto grid place-items-center">
          <Check className="w-8 h-8 text-emerald-600" />
        </div>
        <h1 className="text-3xl font-semibold leading-tight text-ink">
          EOD submitted
        </h1>
        <p className="text-sm text-ink/65 max-w-md mx-auto">
          Mitchell and your dept head have been DM'd. Have a good night.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
          style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
        >
          Close
        </button>
      </div>
    );
  }

  const requiredFilled =
    !!answers.workedOn && !!answers.accomplished && !!answers.planTomorrow;

  return (
    <div className="space-y-5">
      <div className="text-[10px] uppercase tracking-wide font-bold text-fuchsia-500/85">
        Review &amp; submit
      </div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">
        One last look
      </h1>
      <p className="text-sm text-ink/65">
        We&apos;ll DM your EOD digest to leadership and your dept head when you submit.
      </p>

      <div className="space-y-2.5">
        <SummaryRow label="Worked on" value={answers.workedOn} required />
        <SummaryRow label="Accomplished" value={answers.accomplished} required />
        <SummaryRow label="Plan for tomorrow" value={answers.planTomorrow} required />
        {answers.blockers && (
          <SummaryRow label="Blockers / questions" value={answers.blockers} required={false} />
        )}
        {sentEmailCount > 0 && (
          <div className="rounded-lg bg-violet-50/60 border border-violet-200/60 px-3 py-2 text-[13px] inline-flex items-center gap-2">
            <Mail className="w-3.5 h-3.5 text-violet-600" />
            {sentEmailCount} client email{sentEmailCount === 1 ? "" : "s"} logged
          </div>
        )}
      </div>

      <div className="flex items-center justify-end pt-2 gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!requiredFilled || submitting}
          className={cn(
            "inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95",
            (!requiredFilled || submitting) && "opacity-50 cursor-not-allowed hover:translate-y-0"
          )}
          style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clipboard className="w-4 h-4" />}
          {submitting ? "Submitting…" : "Submit EOD"}
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, required }: { label: string; value: string | null; required: boolean }) {
  return (
    <div className={cn(
      "rounded-lg border bg-white px-3 py-2 text-[13px]",
      value ? "border-slate-200/70" : "border-amber-300/70 bg-amber-50/40"
    )}>
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
        {label} {required && <span className="text-rose-400">*</span>}
      </div>
      {value ? (
        <div className="text-ink/80 whitespace-pre-wrap mt-0.5">{value}</div>
      ) : (
        <div className="text-amber-700 italic mt-0.5">Not filled in</div>
      )}
    </div>
  );
}
