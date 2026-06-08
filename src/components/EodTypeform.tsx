"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

interface ClientOption { id: string; name: string; contactEmails: string[] }

interface PriorState {
  workedOn: string | null;
  accomplished: string | null;
  planTomorrow: string | null;
  blockers: string | null;
  // Marketing-style flow extras (Talha Ali). Stay null for everyone
  // else — the standard 4-question flow ignores them entirely.
  leadsMessaged: string | null;
  linkedinComments: string | null;
}

interface EmailDraft {
  localId: string;
  clientId: string;
  to: string;          // free-text comma-separated To input
  subject: string;
  body: string;
  // 'drafting' = editable, 'skipped' = user opted out for this client,
  // 'sending'  = in-flight, 'sent' = queued for approval, 'error' = retry.
  status: "drafting" | "skipped" | "sending" | "sent" | "error";
  error?: string;
}

interface Props {
  open: boolean;
  today: string;
  isWebsiteTeam: boolean;
  // Talha's EOD asks five marketing-flavoured questions instead of the
  // generic four (accomplished today / leads messaged / LinkedIn comments
  // posted / plan for tomorrow / anything I can help with). When true,
  // the website-email branch is also suppressed since it doesn't apply.
  isMarketingTalha: boolean;
  prior: PriorState;
  onClose: () => void;
  onComplete: () => void;
}

// Step definitions for the four base questions. Driving them off a
// constant lets the typeform engine stay generic — adding/removing a
// step is a one-line change.
type StructuredStep = {
  key: keyof PriorState;
  title: string;
  subtitle: string;
  required: boolean;
};

const DEFAULT_STRUCTURED_STEPS: StructuredStep[] = [
  {
    key: "workedOn",
    title: "What did you work on today?",
    subtitle: "Tasks, deep-work, meetings — the activity, not the outcomes.",
    required: true
  },
  {
    key: "accomplished",
    title: "What did you accomplish?",
    subtitle: "What's shipped, closed, fixed, or decided. Outcomes only.",
    required: true
  },
  {
    key: "planTomorrow",
    title: "Plan for tomorrow",
    subtitle: "Top 1–3 things you'll push on tomorrow morning.",
    required: true
  },
  {
    key: "blockers",
    title: "Any questions or blockers?",
    subtitle: "Stuck? Need a decision? Drop it here so leads see it tonight.",
    required: false
  }
];

// Talha runs the marketing dept and his EOD is shaped around outbound
// LinkedIn activity — we ask for accomplishments + the two numbers that
// drive the funnel (leads messaged, comments posted) before the
// plan/help wrap-up. Underlying storage: accomplished → workedOn (the
// "what got done" recap), then leads_messaged + linkedin_comments
// (new columns), plan_tomorrow, blockers ("anything I can help with").
const TALHA_STRUCTURED_STEPS: StructuredStep[] = [
  {
    key: "workedOn",
    title: "What was accomplished today?",
    subtitle: "The wins — shipped, closed, decided, learned.",
    required: true
  },
  {
    key: "leadsMessaged",
    title: "How many leads did you message?",
    subtitle: "Outbound DMs / cold emails sent today. A number is fine; add context if useful.",
    required: true
  },
  {
    key: "linkedinComments",
    title: "How many comments did you post on LinkedIn?",
    subtitle: "Engagement comments on prospects' posts. Number + a quick note on the best ones.",
    required: true
  },
  {
    key: "planTomorrow",
    title: "Game plan for tomorrow",
    subtitle: "Top 1–3 things you'll push on tomorrow morning.",
    required: true
  },
  {
    key: "blockers",
    title: "Anything I can help with?",
    subtitle: "Questions, blockers, or anything you'd like leadership to weigh in on tonight.",
    required: false
  }
];

export function EodTypeform({
  open, today, isWebsiteTeam, isMarketingTalha, prior, onClose, onComplete
}: Props) {
  // Talha's flow swaps the standard 4 questions for a marketing-flavoured
  // 5-step set and skips the website-email branch entirely (he's not
  // doing client-update emails). Everyone else gets the default 4 +
  // optional website-email branch.
  const structuredSteps = isMarketingTalha
    ? TALHA_STRUCTURED_STEPS
    : DEFAULT_STRUCTURED_STEPS;
  const baseStepCount = structuredSteps.length;
  // Website branch is suppressed for Talha — his EOD doesn't surface
  // the client-email composer.
  // Per-client email drafting from the EOD flow was removed: the
  // /approvals "Who needs an email" surface now accumulates client
  // updates centrally so we don't ask every worker to draft their own
  // per-client emails on submit. Leaving the constant in place (rather
  // than ripping the entire branch out) so the related state/handlers
  // can stay as dead code until they're cleaned up properly — fewer
  // moving parts in this change.
  const showWebsiteBranch = false;
  void isWebsiteTeam;
  // step indices for the Website-team flow:
  //   0..n-1 — structured questions (4 default, 5 for Talha)
  //   n      — "Which clients did you work on today?" multi-picker
  //   n+1    — Per-client compose-or-skip stack (one card per picked
  //            client; user can edit + Send, or hit Skip on each)
  //   last   — Review & submit
  const totalSteps = baseStepCount + (showWebsiteBranch ? 2 : 0) + 1; // +1 for the final summary screen
  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState<PriorState>(prior);
  const [savingField, setSavingField] = useState<string | null>(null);
  // Multi-select of which clients the worker touched today; drives
  // step 5's per-client card list.
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
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
    setSelectedClientIds([]);
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
        const list = ((d.clients ?? []) as Array<{ id: string; name: string; contactEmails?: string[] }>)
          .map((c) => ({ id: c.id, name: c.name, contactEmails: c.contactEmails ?? [] }))
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

  function newDraft(clientId = ""): EmailDraft {
    const client = clients.find((c) => c.id === clientId);
    return {
      localId: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      clientId,
      // Prefill To with the client's stored contact emails so the
      // worker doesn't have to retype. Easy to edit if they want to
      // send to a different recipient.
      to: (client?.contactEmails ?? []).join(", "),
      subject: client ? `Update for ${client.name}` : "",
      body: "",
      status: "drafting"
    };
  }

  // Toggle a client in/out of the multi-select for step 4.
  function toggleClient(clientId: string) {
    setSelectedClientIds((cur) =>
      cur.includes(clientId)
        ? cur.filter((id) => id !== clientId)
        : [...cur, clientId]
    );
  }

  // When advancing from the picker (step 4) into the per-client step,
  // seed one EmailDraft per selected client. Existing drafts (e.g. if
  // the user navigated back) are preserved; clients that were
  // deselected get their drafts removed.
  function reconcileDraftsForSelection() {
    setEmails((cur) => {
      const byClient = new Map<string, EmailDraft>();
      for (const d of cur) if (d.clientId && !byClient.has(d.clientId)) byClient.set(d.clientId, d);
      return selectedClientIds.map((cid) => byClient.get(cid) ?? newDraft(cid));
    });
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
    const toRaw = draft.to.trim()
      ? draft.to.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
      : (client?.contactEmails ?? []);
    if (toRaw.length === 0) {
      return patchDraft(localId, { error: "Add at least one recipient email" });
    }
    patchDraft(localId, { status: "sending", error: undefined });
    try {
      // Route through the email-approval queue (kind=client_update).
      // Mitch / Mujtaba / Sam see it on /approvals and Approve & Send
      // fires the actual outbound email via missiveclone.
      const res = await fetch("/api/email-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: draft.clientId,
          clientName: client?.name ?? "Client",
          to: toRaw,
          subject: draft.subject.trim(),
          bodyText: draft.body.trim(),
          kind: "client_update"
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

  // "Skip this client" — locks the card without sending. Visually
  // de-emphasized so the user can still see what they passed on.
  function skipDraft(localId: string) {
    patchDraft(localId, { status: "skipped", error: undefined });
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
          blockers: answers.blockers ?? "",
          leadsMessaged: answers.leadsMessaged ?? "",
          linkedinComments: answers.linkedinComments ?? ""
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `status ${res.status}`);
      setSubmitted(true);
      // Detailed recipient + delivery breakdown so it's obvious who
      // actually got the DM (vs. a silent Slack lookup failure).
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
      onComplete();
      // Auto-dismiss the overlay so the worker isn't stuck on the
      // success screen — short pause so they read "EOD submitted"
      // before it fades. They can also still hit Close manually.
      setTimeout(() => onClose(), 1600);
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

  // Portal to document.body so the overlay escapes the main panel's
  // z-10 stacking context — without this, the Topbar (z-30 inside the
  // parent flex column) sits *above* the typeform and the search bar
  // stays interactable behind the form.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-gradient-to-br from-slate-50 via-white to-blue-50/40 overflow-hidden anim-fade-in"
      role="dialog"
      aria-modal="true"
    >
      {/* Bare close button in the top-right — the progress bar moved
          to the bottom so the user always sees how far they are
          without it competing with the question header. */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/80 border border-slate-200/70 text-ink/55 hover:text-ink hover:bg-white shadow-sm transition-colors"
        title="Close (you can finish later)"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="absolute inset-0 pt-10 pb-28 px-6 flex items-center justify-center">
        <div
          key={stepIdx}
          className={cn(
            "w-full max-w-2xl",
            direction === "forward" ? "anim-fade-in-up" : "anim-fade-in"
          )}
        >
          {stepIdx < baseStepCount && (
            <StructuredQuestion
              field={structuredSteps[stepIdx]}
              value={answers[structuredSteps[stepIdx].key] ?? ""}
              saving={savingField === structuredSteps[stepIdx].key}
              onChange={(v) => setAnswers((cur) => ({ ...cur, [structuredSteps[stepIdx].key]: v }))}
              onAdvance={() => {
                void saveField(structuredSteps[stepIdx].key, answers[structuredSteps[stepIdx].key] ?? "");
                advance();
              }}
            />
          )}

          {showWebsiteBranch && stepIdx === baseStepCount && (
            <ClientPicker
              clients={clients}
              selected={selectedClientIds}
              onToggle={toggleClient}
              onAdvance={() => {
                reconcileDraftsForSelection();
                advance();
              }}
            />
          )}

          {showWebsiteBranch && stepIdx === baseStepCount + 1 && (
            <PerClientComposers
              drafts={emails}
              clients={clients}
              onAddDraft={(clientId) => setEmails((cur) => [...cur, newDraft(clientId)])}
              onRemoveDraft={(id) => setEmails((cur) => cur.filter((d) => d.localId !== id))}
              onPatchDraft={patchDraft}
              onSendDraft={sendDraft}
              onSkipDraft={skipDraft}
              onAdvance={advance}
            />
          )}

          {stepIdx === totalSteps - 1 && (
            <FinalStep
              submitting={submitting}
              submitted={submitted}
              answers={answers}
              isMarketingTalha={isMarketingTalha}
              sentEmailCount={emails.filter((e) => e.status === "sent").length}
              skippedEmailCount={emails.filter((e) => e.status === "skipped").length}
              onSubmit={submitEod}
              onClose={onClose}
            />
          )}
        </div>
      </div>

      {/* Bottom dock: progress + step counter centered, Back arrow
          left, optional spacer right. Sticky to the bottom so it's
          always in view regardless of scroll on the question card. */}
      <div className="absolute bottom-0 inset-x-0 z-10 px-6 py-4 bg-gradient-to-t from-white via-white/95 to-transparent">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <button
            type="button"
            onClick={regress}
            disabled={stepIdx === 0}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink/65 disabled:opacity-40 hover:text-ink transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex-1 flex items-center gap-3">
            <div className="flex-1 h-1.5 rounded-full bg-slate-200/70 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-fuchsia-400 to-blue-500 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="text-[11px] uppercase tracking-wide text-ink/55 font-semibold tabular-nums shrink-0">
              {stepIdx + 1} / {totalSteps}
            </div>
          </div>
          <Sparkles className="w-4 h-4 text-fuchsia-400/70 shrink-0" />
        </div>
      </div>
    </div>,
    document.body
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

function ClientPicker({
  clients, selected, onToggle, onAdvance
}: {
  clients: ClientOption[];
  selected: string[];
  onToggle: (clientId: string) => void;
  onAdvance: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="text-[10px] uppercase tracking-wide font-bold text-violet-500/85">
        Client touches
      </div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">
        What clients did you work on today?
      </h1>
      <p className="text-sm text-ink/65">
        Pick everyone you touched. We&apos;ll line up a draft email per client on the next step so you can either send (with approval) or skip.
      </p>

      <div className="max-h-[55vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {clients.map((c) => {
            const isSelected = selected.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onToggle(c.id)}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-xl text-left text-[13px] border-2 transition-all active:scale-[0.98]",
                  isSelected
                    ? "border-violet-500/70 bg-violet-50/80 text-violet-800 shadow-sm"
                    : "border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/30"
                )}
              >
                <span
                  className={cn(
                    "w-4 h-4 rounded-md border-2 grid place-items-center shrink-0 transition-colors",
                    isSelected ? "border-violet-500 bg-violet-500" : "border-slate-300 bg-white"
                  )}
                >
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
                <span className="truncate">{c.name}</span>
              </button>
            );
          })}
        </div>
        {clients.length === 0 && (
          <div className="text-sm text-ink/55 italic py-6 text-center">
            No clients loaded yet — try refreshing the page.
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 pt-2">
        <div className="text-[11px] text-ink/55">
          {selected.length === 0
            ? "Pick zero if you didn't touch any clients — we'll skip the email step."
            : `${selected.length} selected`}
        </div>
        <button
          type="button"
          onClick={onAdvance}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
          style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
        >
          {selected.length === 0 ? "Skip email step" : `Draft ${selected.length} email${selected.length === 1 ? "" : "s"}`}
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function PerClientComposers({
  drafts, clients, onAddDraft, onRemoveDraft, onPatchDraft, onSendDraft, onSkipDraft, onAdvance
}: {
  drafts: EmailDraft[];
  clients: ClientOption[];
  onAddDraft: (clientId: string) => void;
  onRemoveDraft: (localId: string) => void;
  onPatchDraft: (localId: string, patch: Partial<EmailDraft>) => void;
  onSendDraft: (localId: string) => void;
  onSkipDraft: (localId: string) => void;
  onAdvance: () => void;
}) {
  if (drafts.length === 0) {
    // No clients picked — show a soft pass-through.
    return (
      <div className="text-center space-y-3 py-10">
        <Mail className="w-10 h-10 text-violet-300 mx-auto" />
        <div className="text-sm text-ink/55">No client emails to draft. You can continue.</div>
        <button
          type="button"
          onClick={onAdvance}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  const sentCount = drafts.filter((d) => d.status === "sent").length;
  const skippedCount = drafts.filter((d) => d.status === "skipped").length;
  const remaining = drafts.filter((d) => d.status === "drafting" || d.status === "error").length;

  return (
    <div className="space-y-4">
      <div className="text-[10px] uppercase tracking-wide font-bold text-violet-500/85">
        {sentCount} sent · {skippedCount} skipped · {remaining} remaining
      </div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">
        Draft email updates for these clients
      </h1>
      <p className="text-sm text-ink/65">
        Each one routes to Mitch / Mujtaba / Sam for approval before it actually sends. Hit Skip if you don&apos;t need to email this client today.
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
            onSkip={() => onSkipDraft(d.localId)}
          />
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onAdvance}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          {remaining > 0 ? "Continue (and skip the rest)" : "Continue"} <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function DraftCard({
  draft, clients, onPatch, onRemove, onSend, onSkip
}: {
  draft: EmailDraft;
  clients: ClientOption[];
  onPatch: (p: Partial<EmailDraft>) => void;
  onRemove: () => void;
  onSend: () => void;
  // Optional — only the per-client compose step passes this; the
  // legacy ad-hoc composer doesn't have a "skip" affordance.
  onSkip?: () => void;
}) {
  const client = clients.find((c) => c.id === draft.clientId);
  const clientName = client?.name ?? "";
  const isSent = draft.status === "sent";
  const isSkipped = draft.status === "skipped";
  const isSending = draft.status === "sending";
  const isLocked = isSent || isSkipped || isSending;
  const canSend = !!draft.clientId && draft.subject.trim() && draft.body.trim();

  return (
    <div className={cn(
      "rounded-xl border bg-white shadow-sm overflow-hidden transition-colors",
      isSent && "border-emerald-200/70 bg-emerald-50/30",
      isSkipped && "border-slate-200/70 bg-slate-50/40 opacity-70",
      !isSent && !isSkipped && "border-violet-200/60"
    )}>
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-50/70 border-b border-slate-200/60">
        <Mail className={cn(
          "w-4 h-4",
          isSent ? "text-emerald-600" : isSkipped ? "text-slate-400" : "text-violet-600"
        )} />
        <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
          {clientName && <span className="text-ink/85">{clientName}</span>}
          {clientName && " · "}
          {isSent ? "Sent for approval" : isSkipped ? "Skipped" : "Draft"}
        </span>
        {!isLocked && onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-ink/55 hover:text-ink px-2 py-0.5 rounded-md hover:bg-slate-200/70"
            title="Skip — don't send an email to this client today"
          >
            Skip
          </button>
        )}
        {!isLocked && !onSkip && (
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

      {!draft.clientId && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/50">
          <label className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14">Client</label>
          <select
            value={draft.clientId}
            onChange={(e) => onPatch({ clientId: e.target.value, error: undefined })}
            disabled={isLocked}
            className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 disabled:opacity-70"
          >
            <option value="">Pick a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/50">
        <label className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14">To</label>
        <input
          type="text"
          value={draft.to}
          onChange={(e) => onPatch({ to: e.target.value, error: undefined })}
          disabled={isLocked}
          placeholder={clientName ? `${clientName} contact email…` : "recipient@client.com"}
          className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35 disabled:opacity-70"
        />
      </div>

      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/50">
        <label className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-14">Subject</label>
        <input
          type="text"
          value={draft.subject}
          onChange={(e) => onPatch({ subject: e.target.value, error: undefined })}
          disabled={isLocked}
          placeholder={clientName ? `Update for ${clientName}` : "Email subject"}
          maxLength={300}
          className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35 disabled:opacity-70"
        />
      </div>

      <div className="relative">
        <textarea
          value={draft.body}
          onChange={(e) => onPatch({ body: e.target.value, error: undefined })}
          disabled={isLocked}
          placeholder={clientName
            ? `Write the email body for ${clientName}…`
            : "Body of the email"
          }
          rows={5}
          maxLength={4000}
          className="block w-full text-[13px] bg-white border-none px-3 py-2.5 outline-none focus:ring-0 resize-y placeholder:text-ink/35 disabled:opacity-70"
        />
        {/* AI autofill — pulls today's closed tasks + sent emails for
            this user×client from /api/eod/client-update/draft and
            stuffs the subject/body. User edits before sending for
            approval. Hidden when the row is locked (sent/skipped). */}
        {!isLocked && draft.clientId && (
          <FillWithAiButton
            clientId={draft.clientId}
            onDraft={(d) => onPatch({
              subject: draft.subject || d.subject,
              body: d.body,
              error: undefined
            })}
          />
        )}
      </div>

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
            <Check className="w-3.5 h-3.5" /> Sent for approval
          </span>
        ) : isSkipped ? (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold text-ink/55">
            Skipped
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
            {isSending ? "Sending…" : "Send for approval"}
          </button>
        )}
      </div>
    </div>
  );
}

function FinalStep({
  submitting, submitted, answers, isMarketingTalha, sentEmailCount, skippedEmailCount, onSubmit, onClose
}: {
  submitting: boolean;
  submitted: boolean;
  answers: PriorState;
  isMarketingTalha: boolean;
  sentEmailCount: number;
  skippedEmailCount: number;
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

  const requiredFilled = isMarketingTalha
    ? !!answers.workedOn
        && !!answers.leadsMessaged
        && !!answers.linkedinComments
        && !!answers.planTomorrow
    : !!answers.workedOn && !!answers.accomplished && !!answers.planTomorrow;

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
        {isMarketingTalha ? (
          <>
            <SummaryRow label="What was accomplished today" value={answers.workedOn} required />
            <SummaryRow label="Leads messaged" value={answers.leadsMessaged} required />
            <SummaryRow label="LinkedIn comments posted" value={answers.linkedinComments} required />
            <SummaryRow label="Game plan for tomorrow" value={answers.planTomorrow} required />
            {answers.blockers && (
              <SummaryRow label="Anything I can help with" value={answers.blockers} required={false} />
            )}
          </>
        ) : (
          <>
            <SummaryRow label="Worked on" value={answers.workedOn} required />
            <SummaryRow label="Accomplished" value={answers.accomplished} required />
            <SummaryRow label="Plan for tomorrow" value={answers.planTomorrow} required />
            {answers.blockers && (
              <SummaryRow label="Blockers / questions" value={answers.blockers} required={false} />
            )}
          </>
        )}
        {(sentEmailCount > 0 || skippedEmailCount > 0) && (
          <div className="rounded-lg bg-violet-50/60 border border-violet-200/60 px-3 py-2 text-[13px] inline-flex items-center gap-2 flex-wrap">
            <Mail className="w-3.5 h-3.5 text-violet-600" />
            {sentEmailCount > 0 && (
              <span>{sentEmailCount} client email{sentEmailCount === 1 ? "" : "s"} queued for approval</span>
            )}
            {sentEmailCount > 0 && skippedEmailCount > 0 && <span className="text-ink/45">·</span>}
            {skippedEmailCount > 0 && (
              <span className="text-ink/55">{skippedEmailCount} skipped</span>
            )}
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

// Tiny inline "Fill with AI" button. Floats in the bottom-right corner
// of the per-client body textarea. POSTs to /api/eod/client-update/draft
// with the client id; the API pulls today's closed tasks + sent emails
// for the caller×client and returns a Claude-drafted subject + body.
// Caller decides what to do with the draft via onDraft.
function FillWithAiButton({
  clientId, onDraft
}: {
  clientId: string;
  onDraft: (d: { subject: string; body: string }) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function fill() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/eod/client-update/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      onDraft({ subject: data.subject ?? "", body: data.body ?? "" });
      const signals = data.signals as { tasksCount?: number; emailsCount?: number } | undefined;
      const summary = signals
        ? `${signals.tasksCount ?? 0} task${signals.tasksCount === 1 ? "" : "s"} · ${signals.emailsCount ?? 0} email${signals.emailsCount === 1 ? "" : "s"}`
        : "from today's activity";
      toast.success(`Drafted from ${summary}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't draft");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={fill}
      disabled={busy}
      title="Draft this message from today's tasks + emails for this client"
      className={cn(
        "absolute right-2 bottom-2 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold border shadow-sm transition-all",
        "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white border-transparent hover:-translate-y-0.5 active:scale-95",
        busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
      )}
    >
      {busy
        ? <Loader2 className="w-3 h-3 animate-spin" />
        : <Sparkles className="w-3 h-3" />}
      {busy ? "Drafting…" : "Fill with AI"}
    </button>
  );
}
