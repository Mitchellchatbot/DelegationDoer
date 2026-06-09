"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles, ArrowRight, ArrowLeft, Check, Loader2, X, Clipboard, Plus, Trash2, Building2
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Typeform-style end-of-day flow. One question per screen, animated
// transitions, autosaves each answer on advance via PUT /api/eod/notes so
// progress survives a refresh. Last step fires /api/eod/submit which DMs
// leadership + the worker's dept head(s).
//
// Three flow shapes:
//   - "client"   (SEO + Website teams): the day is logged CLIENT BY
//                CLIENT — pick a client, say what you worked on + results,
//                "another client?" loop until done — then a short wrap-up
//                (plan for tomorrow / blockers). Each client entry POSTs to
//                /api/eod/client-work and is the source the client-update
//                emails are drafted from.
//   - "marketing" (Talha Ali): five marketing-shaped questions.
//   - "default"  (everyone else): the generic four structured questions.
//
// Trigger lives on the EOD page: auto-opens within ~60min of the worker's
// weeklySchedule end_time, or manually via "Simulate shift end".

interface ClientOption { id: string; name: string; contactEmails: string[] }

interface PriorState {
  workedOn: string | null;
  accomplished: string | null;
  planTomorrow: string | null;
  blockers: string | null;
  // Marketing-style flow extras (Talha Ali). Stay null for everyone
  // else — the standard flows ignore them entirely.
  leadsMessaged: string | null;
  linkedinComments: string | null;
}

// One logged "what I did for this client today" entry (persisted to
// eod_client_work). localId mirrors the server id once saved.
interface ClientWorkEntry {
  id: string;
  clientId: string | null;
  clientName: string;
  workedOn: string;
  results: string;
}

interface Props {
  open: boolean;
  today: string;
  // SEO + Website teams get the client-by-client flow. (Leaders/admins
  // are folded into this set upstream for oversight.)
  isWebsiteTeam: boolean;
  // Talha's EOD asks five marketing-flavoured questions instead of the
  // generic four. Takes precedence over the client flow.
  isMarketingTalha: boolean;
  prior: PriorState;
  onClose: () => void;
  onComplete: () => void;
}

type FlowKind = "client" | "marketing" | "default";

type StructuredStep = {
  key: keyof PriorState;
  title: string;
  subtitle: string;
  required: boolean;
};

const DEFAULT_STRUCTURED_STEPS: StructuredStep[] = [
  { key: "workedOn", title: "What did you work on today?", subtitle: "Tasks, deep-work, meetings — the activity, not the outcomes.", required: true },
  { key: "accomplished", title: "What did you accomplish?", subtitle: "What's shipped, closed, fixed, or decided. Outcomes only.", required: true },
  { key: "planTomorrow", title: "Plan for tomorrow", subtitle: "Top 1–3 things you'll push on tomorrow morning.", required: true },
  { key: "blockers", title: "Any questions or blockers?", subtitle: "Stuck? Need a decision? Drop it here so leads see it tonight.", required: false }
];

// Marketing flow (Talha): accomplishments + the two funnel numbers, then
// plan/help wrap-up. Storage: accomplished → workedOn, then
// leads_messaged + linkedin_comments, plan_tomorrow, blockers.
const TALHA_STRUCTURED_STEPS: StructuredStep[] = [
  { key: "workedOn", title: "What was accomplished today?", subtitle: "The wins — shipped, closed, decided, learned.", required: true },
  { key: "leadsMessaged", title: "How many leads did you message?", subtitle: "Outbound DMs / cold emails sent today. A number is fine; add context if useful.", required: true },
  { key: "linkedinComments", title: "How many comments did you post on LinkedIn?", subtitle: "Engagement comments on prospects' posts. Number + a quick note on the best ones.", required: true },
  { key: "planTomorrow", title: "Game plan for tomorrow", subtitle: "Top 1–3 things you'll push on tomorrow morning.", required: true },
  { key: "blockers", title: "Anything I can help with?", subtitle: "Questions, blockers, or anything you'd like leadership to weigh in on tonight.", required: false }
];

// Client flow wrap-up — the per-client loop carries the "what got done"
// content, so all that's left is the forward look + blockers.
const CLIENT_WRAPUP_STEPS: StructuredStep[] = [
  { key: "planTomorrow", title: "Plan for tomorrow", subtitle: "Top 1–3 things you'll push on tomorrow morning.", required: true },
  { key: "blockers", title: "Any questions or blockers?", subtitle: "Stuck? Need a decision? Drop it here so leads see it tonight.", required: false }
];

export function EodTypeform({
  open, today, isWebsiteTeam, isMarketingTalha, prior, onClose, onComplete
}: Props) {
  const flow: FlowKind = isMarketingTalha ? "marketing" : isWebsiteTeam ? "client" : "default";

  const structuredSteps =
    flow === "marketing" ? TALHA_STRUCTURED_STEPS :
    flow === "client" ? CLIENT_WRAPUP_STEPS :
    DEFAULT_STRUCTURED_STEPS;

  // Client flow prepends the per-client loop as step 0.
  const hasClientLoop = flow === "client";
  const loopOffset = hasClientLoop ? 1 : 0;
  const baseStepCount = structuredSteps.length;
  const totalSteps = loopOffset + baseStepCount + 1; // +1 for the final review screen

  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState<PriorState>(prior);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [clientWork, setClientWork] = useState<ClientWorkEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [direction, setDirection] = useState<"forward" | "back">("forward");

  // Reset state every time the modal opens fresh.
  useEffect(() => {
    if (!open) return;
    setStepIdx(0);
    setAnswers(prior);
    setClientWork([]);
    setSubmitted(false);
    setSubmitting(false);
    setDirection("forward");
  }, [open, prior]);

  // Load clients + any already-logged client work for today — only for the
  // client flow.
  useEffect(() => {
    if (!open || !hasClientLoop) return;
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
      .catch(() => { /* picker falls back to manual entry */ });
    fetch(`/api/eod/client-work?date=${today}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const list = ((d.entries ?? []) as Array<{ id: string; clientId: string | null; clientName: string; workedOn: string; results: string | null }>)
          .map((e) => ({ id: e.id, clientId: e.clientId, clientName: e.clientName, workedOn: e.workedOn, results: e.results ?? "" }));
        setClientWork(list);
      })
      .catch(() => { /* resume is best-effort */ });
    return () => { cancelled = true; };
  }, [open, hasClientLoop, today]);

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

  async function submitEod() {
    setSubmitting(true);
    try {
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
      setTimeout(() => onClose(), 1600);
    } catch (err) {
      toast.error(`Submit failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  // Escape closes (progress survives — answers autosave / client work
  // persists per entry).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const progress = useMemo(() => Math.min(100, Math.round((stepIdx / (totalSteps - 1)) * 100)), [stepIdx, totalSteps]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  // Index math: [0..loopOffset) = client loop, then structured questions,
  // then the final review screen.
  const structuredIdx = stepIdx - loopOffset;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-gradient-to-br from-slate-50 via-white to-blue-50/40 overflow-hidden anim-fade-in"
      role="dialog"
      aria-modal="true"
    >
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
          {hasClientLoop && stepIdx === 0 && (
            <ClientWorkLoop
              today={today}
              clients={clients}
              entries={clientWork}
              onChange={setClientWork}
              onAdvance={advance}
            />
          )}

          {structuredIdx >= 0 && structuredIdx < baseStepCount && (
            <StructuredQuestion
              field={structuredSteps[structuredIdx]}
              value={answers[structuredSteps[structuredIdx].key] ?? ""}
              saving={savingField === structuredSteps[structuredIdx].key}
              onChange={(v) => setAnswers((cur) => ({ ...cur, [structuredSteps[structuredIdx].key]: v }))}
              onAdvance={() => {
                void saveField(structuredSteps[structuredIdx].key, answers[structuredSteps[structuredIdx].key] ?? "");
                advance();
              }}
            />
          )}

          {stepIdx === totalSteps - 1 && (
            <FinalStep
              flow={flow}
              submitting={submitting}
              submitted={submitted}
              answers={answers}
              clientWork={clientWork}
              onSubmit={submitEod}
              onClose={onClose}
            />
          )}
        </div>
      </div>

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
  useEffect(() => { ref.current?.focus(); }, []);

  const canAdvance = !field.required || value.trim().length > 0;

  return (
    <div className="space-y-5">
      <div className="text-[10px] uppercase tracking-wide font-bold text-fuchsia-500/85">
        Question {field.required ? "(required)" : "(optional)"}
      </div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">{field.title}</h1>
      <p className="text-sm text-ink/65">{field.subtitle}</p>

      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
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
          style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// The client-by-client loop. Three internal phases:
//   pick   — choose the client you worked on (searchable grid)
//   detail — what you worked on + any results, for the chosen client
//   after  — running list of what's logged; add another or continue
// Each saved entry POSTs to /api/eod/client-work (and DELETE on remove),
// so progress survives a refresh and the emails can read it later.
function ClientWorkLoop({
  today, clients, entries, onChange, onAdvance
}: {
  today: string;
  clients: ClientOption[];
  entries: ClientWorkEntry[];
  onChange: (entries: ClientWorkEntry[]) => void;
  onAdvance: () => void;
}) {
  const [phase, setPhase] = useState<"pick" | "detail" | "after">(entries.length > 0 ? "after" : "pick");
  const [current, setCurrent] = useState<{ clientId: string | null; clientName: string } | null>(null);
  const [workedOn, setWorkedOn] = useState("");
  const [results, setResults] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  // Once entries load in (async), surface the running list instead of an
  // empty picker — unless the user is mid-entry.
  useEffect(() => {
    if (entries.length > 0 && phase === "pick" && !current) setPhase("after");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length]);

  function pickClient(c: { id: string | null; name: string }) {
    setCurrent({ clientId: c.id, clientName: c.name });
    setWorkedOn("");
    setResults("");
    setPhase("detail");
  }

  async function saveEntry() {
    if (!current || !workedOn.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/eod/client-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: today,
          clientId: current.clientId,
          clientName: current.clientName,
          workedOn: workedOn.trim(),
          results: results.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const entry: ClientWorkEntry = data.entry
        ? { id: data.entry.id, clientId: data.entry.clientId, clientName: data.entry.clientName, workedOn: data.entry.workedOn, results: data.entry.results ?? "" }
        : { id: `tmp_${Date.now()}`, clientId: current.clientId, clientName: current.clientName, workedOn: workedOn.trim(), results: results.trim() };
      onChange([...entries, entry]);
      setCurrent(null);
      setWorkedOn("");
      setResults("");
      setPhase("after");
    } catch (err) {
      toast.error(`Couldn't save: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeEntry(id: string) {
    onChange(entries.filter((e) => e.id !== id));
    try {
      await fetch(`/api/eod/client-work?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch { /* list already updated optimistically */ }
  }

  // Clients not yet logged float to the top of the picker; already-logged
  // ones are still selectable (you can log a second entry for the same
  // client) but de-emphasized.
  const loggedNames = new Set(entries.map((e) => e.clientName));
  const filtered = clients.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  if (phase === "detail" && current) {
    return (
      <div className="space-y-5">
        <div className="text-[10px] uppercase tracking-wide font-bold text-violet-500/85 inline-flex items-center gap-1.5">
          <Building2 className="w-3 h-3" /> {current.clientName}
        </div>
        <h1 className="text-3xl font-semibold leading-tight text-ink">
          What did you work on for {current.clientName}?
        </h1>
        <p className="text-sm text-ink/65">
          This is what gets summarized into the client&apos;s update email. Be specific.
        </p>

        <textarea
          autoFocus
          value={workedOn}
          onChange={(e) => setWorkedOn(e.target.value)}
          placeholder="e.g. Converted 6 Instagram videos into blog posts, rebuilt the service-area page structure…"
          rows={4}
          className="w-full text-base bg-white border-2 border-slate-200 rounded-2xl px-5 py-4 outline-none focus:border-violet-400/70 focus:ring-4 focus:ring-violet-200/40 resize-none transition-all placeholder:text-ink/30 shadow-sm"
        />

        <div>
          <label className="text-[11px] uppercase tracking-wide font-semibold text-ink/55 mb-1.5 block">
            Any results or outcomes? <span className="text-ink/35 normal-case">(optional)</span>
          </label>
          <textarea
            value={results}
            onChange={(e) => setResults(e.target.value)}
            placeholder="e.g. 3 of the posts already ranking on page 2, bounce rate down on the rebuilt page…"
            rows={3}
            className="w-full text-base bg-white border-2 border-slate-200 rounded-2xl px-5 py-4 outline-none focus:border-violet-400/70 focus:ring-4 focus:ring-violet-200/40 resize-none transition-all placeholder:text-ink/30 shadow-sm"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => { setCurrent(null); setPhase(entries.length > 0 ? "after" : "pick"); }}
            className="text-sm font-medium text-ink/60 hover:text-ink"
          >
            ← Pick a different client
          </button>
          <button
            type="button"
            onClick={saveEntry}
            disabled={!workedOn.trim() || saving}
            className={cn(
              "inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95",
              (!workedOn.trim() || saving) && "opacity-40 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)" }}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {saving ? "Saving…" : "Save this client"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "after") {
    return (
      <div className="space-y-5">
        <div className="text-[10px] uppercase tracking-wide font-bold text-violet-500/85">
          Client work · {entries.length} logged
        </div>
        <h1 className="text-3xl font-semibold leading-tight text-ink">
          Did you work on any other clients?
        </h1>
        <p className="text-sm text-ink/65">
          Add an entry for each client you touched today. Each one feeds that client&apos;s update email.
        </p>

        <div className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
          {entries.map((e) => (
            <div key={e.id} className="rounded-xl border border-violet-200/60 bg-white px-4 py-3 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink inline-flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-violet-500" /> {e.clientName}
                  </div>
                  <div className="text-[13px] text-ink/75 mt-1 whitespace-pre-wrap">{e.workedOn}</div>
                  {e.results && (
                    <div className="text-[12px] text-ink/55 mt-1">
                      <span className="font-medium text-ink/65">Results: </span>{e.results}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeEntry(e.id)}
                  className="p-1 rounded text-ink/35 hover:text-rose-600 hover:bg-rose-50 shrink-0"
                  title="Remove this entry"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {entries.length === 0 && (
            <div className="text-sm text-ink/45 italic py-4 text-center">Nothing logged yet.</div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            type="button"
            onClick={() => { setQuery(""); setPhase("pick"); }}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full text-sm font-semibold text-violet-700 bg-violet-50 border border-violet-200 hover:bg-violet-100 transition-colors active:scale-95"
          >
            <Plus className="w-4 h-4" /> Add another client
          </button>
          <button
            type="button"
            onClick={onAdvance}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
            style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
          >
            {entries.length === 0 ? "No client work today" : "Done with clients"} <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  // phase === "pick"
  return (
    <div className="space-y-5">
      <div className="text-[10px] uppercase tracking-wide font-bold text-violet-500/85">
        Client work
      </div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">
        Which client did you work on?
      </h1>
      <p className="text-sm text-ink/65">
        Pick one. You&apos;ll say what you did, then you can add more clients.
      </p>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search clients…"
        className="w-full text-sm bg-white border-2 border-slate-200 rounded-xl px-4 py-2.5 outline-none focus:border-violet-400/70 focus:ring-4 focus:ring-violet-200/40 transition-all placeholder:text-ink/35"
      />

      <div className="max-h-[45vh] overflow-y-auto pr-1">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickClient({ id: c.id, name: c.name })}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-xl text-left text-[13px] border-2 transition-all active:scale-[0.98]",
                loggedNames.has(c.name)
                  ? "border-violet-200 bg-violet-50/40 text-violet-700"
                  : "border-slate-200 bg-white hover:border-violet-300 hover:bg-violet-50/30"
              )}
            >
              <Building2 className="w-3.5 h-3.5 shrink-0 text-violet-400" />
              <span className="truncate">{c.name}</span>
              {loggedNames.has(c.name) && <Check className="w-3 h-3 text-violet-500 ml-auto shrink-0" />}
            </button>
          ))}
        </div>
        {clients.length === 0 && (
          <div className="text-sm text-ink/55 italic py-6 text-center">No clients loaded yet — try refreshing the page.</div>
        )}
        {clients.length > 0 && filtered.length === 0 && (
          <div className="text-sm text-ink/55 italic py-6 text-center">No clients match “{query}”.</div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={() => (entries.length > 0 ? setPhase("after") : onAdvance())}
          className="text-sm font-medium text-ink/60 hover:text-ink"
        >
          {entries.length > 0 ? "← Back to logged work" : "Skip — no client work today"}
        </button>
      </div>
    </div>
  );
}

function FinalStep({
  flow, submitting, submitted, answers, clientWork, onSubmit, onClose
}: {
  flow: FlowKind;
  submitting: boolean;
  submitted: boolean;
  answers: PriorState;
  clientWork: ClientWorkEntry[];
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (submitted) {
    return (
      <div className="text-center space-y-5">
        <div className="w-16 h-16 rounded-full bg-emerald-100 mx-auto grid place-items-center">
          <Check className="w-8 h-8 text-emerald-600" />
        </div>
        <h1 className="text-3xl font-semibold leading-tight text-ink">EOD submitted</h1>
        <p className="text-sm text-ink/65 max-w-md mx-auto">
          Mitchell and your dept head have been DM&apos;d. Have a good night.
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
    flow === "marketing"
      ? !!answers.workedOn && !!answers.leadsMessaged && !!answers.linkedinComments && !!answers.planTomorrow
      : flow === "client"
      ? !!answers.planTomorrow
      : !!answers.workedOn && !!answers.accomplished && !!answers.planTomorrow;

  return (
    <div className="space-y-5">
      <div className="text-[10px] uppercase tracking-wide font-bold text-fuchsia-500/85">Review &amp; submit</div>
      <h1 className="text-3xl font-semibold leading-tight text-ink">One last look</h1>
      <p className="text-sm text-ink/65">
        We&apos;ll DM your EOD digest to leadership and your dept head when you submit.
      </p>

      <div className="space-y-2.5 max-h-[50vh] overflow-y-auto pr-1">
        {flow === "client" && (
          <div className="rounded-lg border border-violet-200/60 bg-violet-50/40 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wide font-semibold text-violet-700/85 mb-1.5">
              Client work · {clientWork.length}
            </div>
            {clientWork.length === 0 ? (
              <div className="text-[13px] text-ink/55 italic">No client work logged today.</div>
            ) : (
              <ul className="space-y-1.5">
                {clientWork.map((e) => (
                  <li key={e.id} className="text-[13px]">
                    <span className="font-semibold text-ink">{e.clientName}: </span>
                    <span className="text-ink/75">{e.workedOn}</span>
                    {e.results && <span className="text-ink/50"> — {e.results}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {flow === "marketing" ? (
          <>
            <SummaryRow label="What was accomplished today" value={answers.workedOn} required />
            <SummaryRow label="Leads messaged" value={answers.leadsMessaged} required />
            <SummaryRow label="LinkedIn comments posted" value={answers.linkedinComments} required />
            <SummaryRow label="Game plan for tomorrow" value={answers.planTomorrow} required />
            {answers.blockers && <SummaryRow label="Anything I can help with" value={answers.blockers} required={false} />}
          </>
        ) : flow === "client" ? (
          <>
            <SummaryRow label="Plan for tomorrow" value={answers.planTomorrow} required />
            {answers.blockers && <SummaryRow label="Blockers / questions" value={answers.blockers} required={false} />}
          </>
        ) : (
          <>
            <SummaryRow label="Worked on" value={answers.workedOn} required />
            <SummaryRow label="Accomplished" value={answers.accomplished} required />
            <SummaryRow label="Plan for tomorrow" value={answers.planTomorrow} required />
            {answers.blockers && <SummaryRow label="Blockers / questions" value={answers.blockers} required={false} />}
          </>
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
