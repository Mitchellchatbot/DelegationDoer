"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type {
  CollectField,
  OnboardingForm,
  Shot as ShotT,
  Step
} from "@/lib/client-onboarding-forms";

// The client onboarding walkthrough.
//
// Ported from the meta-ads dashboard (awfmp src/components/onboarding/
// OnboardingFlow.tsx), which is the version the team asked us to model this on.
// The reasoning below is theirs and still holds; what changed here is the
// plumbing (server actions became /api routes), the palette, and a file field
// their onboarding never needed.
//
// The shape of the problem: a client answering thirty questions about their own
// business is doing unpaid homework, at whatever hour they finally sit down to
// it, in a form nobody is standing next to them to explain. Every decision here
// follows from that:
//
//   ONE STEP FILLS THE SCREEN. The first version of this showed the why, the
//   instructions and the questions all at once and read as a wall. A person
//   doing a nine-part form needs to believe each part is small. Everything past
//   the current step is deliberately out of sight.
//
//   THE SECONDARY MATERIAL IS FOLDED AWAY. "Who can do this", "how you'll know
//   it worked", and the ways people get it wrong all matter enormously — and
//   only to the person who is stuck. Open by default they make a working path
//   look like a minefield.
//
//   NOTHING IS EVER LOST. Answers save when a field loses focus, and again when
//   the step's finish button is pressed, so the line someone was still typing
//   goes with it. Progress is kept locally as well as on the server, so
//   reopening the link lands you where you stopped.
//
//   THE WAY OUT IS AT THE TOP. A client who hits a question they cannot answer
//   used to have two options: guess, or close the tab. The note-and-skip panel
//   sits above the questions, where somebody who is stuck sees it before they
//   give up scrolling.

type AnswerState = Record<string, Record<string, { value: string; isSecret: boolean }>>;

interface UploadedFile {
  id: string;
  stepId: string;
  fieldKey: string;
  fileName: string;
  url: string;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
}

/**
 * Preview mode, for Sam and Mujtaba walking the form themselves.
 *
 * A context rather than a prop threaded through six components: the flag is
 * read at four scattered call sites (answers, note, upload, step-done) and
 * nowhere else, and passing it down by hand would mean every component in
 * between carrying a prop it does not use.
 *
 * What it guarantees: nothing is written and nobody is notified. Each of those
 * four calls returns a simulated success instead of going to the server, so the
 * walkthrough behaves exactly as a client would see it -- ticks, saved states
 * and all -- against nothing at all.
 */
const PreviewCtx = createContext(false);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DONE_KEY = (t: string) => `dd-onboarding:${t}:done`;
const NOTES_KEY = (t: string) => `dd-onboarding:${t}:notes`;

/** The primary action, everywhere. Matches the New client dialog so the form
 *  looks like it came from the same place the rest of DD did. */
const PRIMARY = "linear-gradient(135deg, #0a4099 0%, #063270 100%)";

// ---------------------------------------------------------------------------
// Local persistence
// ---------------------------------------------------------------------------

/** Notes are kept locally only. They are a scratchpad — "which email did I
 *  use", "why I couldn't finish this" — and the half of one that matters to us
 *  is the half the client chooses to send. */
function useNotes(token: string, preview: boolean) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  useEffect(() => {
    // Preview keeps nothing. A preview that reopens where the last person
    // stopped is a preview of the wrong thing.
    if (preview) return;
    try {
      const raw = localStorage.getItem(NOTES_KEY(token));
      if (raw) setNotes(JSON.parse(raw) as Record<string, string>);
    } catch {
      /* private mode, or a corrupt value — start clean */
    }
  }, [token, preview]);
  const set = (id: string, text: string) =>
    setNotes((prev) => {
      const next = { ...prev, [id]: text };
      try {
        if (!preview) localStorage.setItem(NOTES_KEY(token), JSON.stringify(next));
      } catch {
        /* nothing to do */
      }
      return next;
    });
  return { notes, set };
}

/** Done-state, seeded from the server and mirrored locally.
 *
 *  Both, deliberately. The server copy is what the team sees on the client page
 *  and is the one that decides whether the form is finished; the local copy is
 *  what makes reopening the link instant, and what keeps the ticks right if a
 *  save is in flight when someone closes the tab. */
function useDone(token: string, initial: string[], preview: boolean) {
  const [done, setDone] = useState<Set<string>>(() => new Set(initial));
  useEffect(() => {
    if (preview) return;
    try {
      const raw = localStorage.getItem(DONE_KEY(token));
      if (raw) {
        const local = JSON.parse(raw) as string[];
        // Union, never replace: the server knows about steps finished on
        // another device, the browser knows about ones whose save has not
        // landed yet, and losing either would un-tick work the client did.
        setDone((prev) => new Set([...prev, ...local]));
      }
    } catch {
      /* start from the server's view */
    }
  }, [token, preview]);

  const mark = (id: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        if (!preview) localStorage.setItem(DONE_KEY(token), JSON.stringify([...next]));
      } catch {
        /* nothing to do */
      }
      return next;
    });

  return { done, mark };
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const inputClass =
  "mt-2 w-full rounded-xl border border-border bg-white px-3.5 py-2.5 text-[14px] text-ink "
  + "outline-none transition-colors focus:border-accent/40 focus:ring-2 focus:ring-accent/15";

function FieldLabel({ field, htmlFor }: { field: CollectField; htmlFor: string }) {
  return (
    <>
      <label htmlFor={htmlFor} className="text-[14px] font-semibold text-ink leading-snug block">
        {field.label}
      </label>
      {field.hint && (
        <p className="text-[11.5px] text-ink/55 leading-snug pt-1 whitespace-pre-line">{field.hint}</p>
      )}
    </>
  );
}

/** Single-choice, as buttons rather than a select.
 *
 *  Three options that are all visible cost one glance; a dropdown costs a click
 *  to find out what the question even offers. */
function ChoiceField({
  field, value, onChange
}: { field: CollectField; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 pt-2.5">
      {(field.choices ?? []).map((c) => {
        const on = value === c;
        return (
          <button
            key={c}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? "" : c)}
            className={cn(
              "text-[13px] font-medium px-3.5 py-1.5 rounded-full border transition-all",
              on
                ? "text-white border-transparent shadow-sm"
                : "bg-white text-ink/70 border-border hover:text-ink hover:border-accent/30"
            )}
            style={on ? { background: PRIMARY } : undefined}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

/** Multi-select. Stored as a comma-separated string so the answer reads the
 *  same in the database, in Slack and on the client page as it does here. */
function MultiField({
  field, value, onChange
}: { field: CollectField; value: string; onChange: (v: string) => void }) {
  const selected = useMemo(
    () => new Set(value.split(",").map((s) => s.trim()).filter(Boolean)),
    [value]
  );
  const toggle = (c: string) => {
    const next = new Set(selected);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    // Emitted in the order the options are declared, not the order they were
    // clicked, so the same set of answers always reads identically.
    onChange((field.choices ?? []).filter((x) => next.has(x)).join(", "));
  };
  return (
    <div className="flex flex-wrap gap-2 pt-2.5">
      {(field.choices ?? []).map((c) => {
        const on = selected.has(c);
        return (
          <button
            key={c}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(c)}
            className={cn(
              "text-[12.5px] font-medium px-3 py-1.5 rounded-full border transition-all text-left",
              on
                ? "bg-accent/10 text-accent border-accent/40"
                : "bg-white text-ink/70 border-border hover:text-ink hover:border-accent/30"
            )}
          >
            {on ? "✓ " : ""}
            {c}
          </button>
        );
      })}
    </div>
  );
}

/** The one field with no counterpart in the dashboard this was ported from.
 *
 *  Uploads go straight up as they are picked rather than waiting for the step's
 *  finish button: a client attaching four photographs on a phone should see
 *  them land one by one, and a single "save" that silently uploads 60 MB is the
 *  kind of thing that appears to hang. */
function FileField({
  field, stepId, token, files, onUploaded
}: {
  field: CollectField;
  stepId: string;
  token: string;
  files: UploadedFile[];
  onUploaded: (f: UploadedFile) => void;
}) {
  const preview = useContext(PreviewCtx);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = async (list: FileList | null) => {
    if (!list || !list.length) return;
    if (preview) {
      toast.info("Preview — files aren't uploaded here.");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    for (const file of Array.from(list)) {
      const body = new FormData();
      body.append("file", file);
      body.append("stepId", stepId);
      body.append("fieldKey", field.key);
      try {
        const res = await fetch(`/api/onboarding/${encodeURIComponent(token)}/upload`, {
          method: "POST",
          body
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "upload failed");
        onUploaded(data.file as UploadedFile);
      } catch (err) {
        toast.error(
          `${file.name}: ${err instanceof Error ? err.message : "couldn't upload that"}`
        );
      }
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const mine = files.filter((f) => f.stepId === stepId && f.fieldKey === field.key);

  return (
    <div className="pt-3">
      <input
        ref={inputRef}
        id={`${stepId}-${field.key}`}
        type="file"
        multiple
        accept="image/*,application/pdf,.zip,.ai,.eps"
        disabled={busy}
        onChange={(e) => void send(e.target.files)}
        className="block w-full text-[12.5px] text-ink/70 file:mr-3 file:rounded-full file:border-0
          file:px-4 file:py-2 file:text-[12.5px] file:font-semibold file:text-white
          file:cursor-pointer disabled:opacity-50"
        style={{ colorScheme: "light" }}
      />
      {busy && <div className="text-[11.5px] text-ink/55 pt-2">Uploading…</div>}

      {mine.length > 0 && (
        <ul className="pt-3 space-y-1.5">
          {mine.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-[12.5px]">
              <span className="text-ok">✓</span>
              <a
                href={f.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline truncate"
              >
                {f.fileName}
              </a>
              {f.sizeBytes != null && (
                <span className="text-ink/45 tabular-nums shrink-0">
                  {Math.max(1, Math.round(f.sizeBytes / 1024))} KB
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A screenshot of the real screen, inline.
 *
 * Inline and not behind a "view screenshot" link, because the entire reason it
 * helps is that the eye can flick between the picture and the actual browser
 * window -- and a click to open one breaks exactly that. Height-capped so a tall
 * shot cannot bury the instruction it belongs to, and clicking opens the full
 * image for anyone who wants a closer look.
 */
function Shot({ shot }: { shot: ShotT }) {
  return (
    <span className="block pt-2.5">
      <a
        href={shot.src}
        target="_blank"
        rel="noreferrer"
        className="block rounded-xl border border-border overflow-hidden bg-white transition-shadow hover:shadow-soft"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={shot.src}
          alt={shot.alt}
          loading="lazy"
          className="w-full h-auto max-h-[280px] object-contain object-left-top"
        />
      </a>
      {shot.caption && (
        <span className="block text-[11.5px] text-ink/60 leading-snug pt-1.5">{shot.caption}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The questions on a step
// ---------------------------------------------------------------------------

/**
 * A step's questions, inline and prominent.
 *
 * No Save button. A save button on a question somebody answers in one line is a
 * second action for one intent, and the thing everyone forgets to press — so it
 * saves itself when a field loses focus, and again when the step's finish
 * button flushes whatever is still being typed.
 *
 * `registerSave` is how that flush reaches this component: the parent holds the
 * current step's saver and calls it before announcing.
 */
function CollectForm({
  step, token, saved, files, onSaved, onUploaded, registerSave
}: {
  step: Step;
  token: string;
  saved: Record<string, { value: string; isSecret: boolean }>;
  files: UploadedFile[];
  onSaved: (stepId: string, values: Record<string, string>) => void;
  onUploaded: (f: UploadedFile) => void;
  registerSave: (fn: (() => Promise<void>) | null) => void;
}) {
  const preview = useContext(PreviewCtx);
  const fields = step.collect ?? [];
  const [vals, setVals] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<{ key: string; label: string; reason: string }[]>([]);
  const valsRef = useRef<Record<string, string>>({});
  valsRef.current = vals;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Seed from what is already on file. Secrets are seeded as "" on purpose —
  // what comes back for one is a mask, and putting •••• into the box would mean
  // a client who tabbed through the step re-saved the mask over their password.
  useEffect(() => {
    const seeded: Record<string, string> = {};
    for (const f of fields) {
      const hit = saved[f.key];
      if (hit && !hit.isSecret) seeded[f.key] = hit.value;
    }
    setVals(seeded);
    setState("idle");
    setError(null);
    setRefusals([]);
    // Re-seeded per step, which is what the step id in the deps is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);

  const persist = useCallback(async () => {
    const values = fields
      .filter((f) => f.kind !== "files")
      .map((f) => ({ key: f.key, value: valsRef.current[f.key] ?? "" }))
      .filter((v) => v.value.trim());
    if (!values.length) return;

    if (preview) {
      // Behaves exactly as a real save does, so the walkthrough being previewed
      // is the walkthrough clients get -- it just never leaves the browser.
      if (mounted.current) setState("saved");
      onSaved(step.id, Object.fromEntries(values.map((v) => [v.key, v.value])));
      return;
    }

    if (mounted.current) setState("saving");
    try {
      const res = await fetch(`/api/onboarding/${encodeURIComponent(token)}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: step.id, values })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "couldn't save");
      if (!mounted.current) return;
      setState("saved");
      setRefusals(data.refused ?? []);
      onSaved(step.id, Object.fromEntries(values.map((v) => [v.key, v.value])));
    } catch (err) {
      if (!mounted.current) return;
      setState("failed");
      setError(err instanceof Error ? err.message : "unknown");
    }
  }, [fields, step.id, token, onSaved, preview]);

  // Re-registered each render so the parent always holds a saver bound to the
  // step actually on screen; cleared on unmount so it cannot flush a step the
  // client has already left.
  useEffect(() => {
    registerSave(() => persist());
    return () => registerSave(null);
  });

  if (!fields.length) return null;

  return (
    <div className="mt-8 pt-7 border-t border-border">
      <h3 className="text-[17px] font-semibold tracking-tight text-ink">
        {step.gate ? "About you" : "A few things we need from you"}
      </h3>

      <div className="mt-5 space-y-5">
        {fields.map((f) => {
          const id = `${step.id}-${f.key}`;
          const savedHit = saved[f.key];
          const placeholder =
            savedHit && !savedHit.isSecret && savedHit.value
              ? undefined
              : f.placeholder;

          return (
            <div key={f.key}>
              <FieldLabel field={f} htmlFor={id} />

              {f.kind === "files" ? (
                <FileField
                  field={f}
                  stepId={step.id}
                  token={token}
                  files={files}
                  onUploaded={onUploaded}
                />
              ) : f.kind === "choice" ? (
                <ChoiceField
                  field={f}
                  value={vals[f.key] ?? ""}
                  onChange={(v) => {
                    setVals((p) => ({ ...p, [f.key]: v }));
                    // Chips have no blur to hang a save on, so they save on
                    // click. Waiting for the finish button would lose the pick
                    // of anyone who closed the tab straight after making it.
                    //
                    // The timeout is load-bearing, not a shrug: persist() reads
                    // valsRef, which is assigned during render, so calling it
                    // inline would post the value from BEFORE this click. A
                    // macrotask runs after React has flushed the update.
                    setTimeout(() => void persist(), 0);
                  }}
                />
              ) : f.kind === "multi" ? (
                <MultiField
                  field={f}
                  value={vals[f.key] ?? ""}
                  onChange={(v) => {
                    setVals((p) => ({ ...p, [f.key]: v }));
                    setTimeout(() => void persist(), 0);
                  }}
                />
              ) : f.kind === "long" ? (
                <textarea
                  id={id}
                  rows={3}
                  value={vals[f.key] ?? ""}
                  onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))}
                  onBlur={() => void persist()}
                  placeholder={placeholder}
                  className={cn(inputClass, "min-h-[92px] resize-y leading-relaxed")}
                />
              ) : (
                <input
                  id={id}
                  type={
                    f.kind === "email" ? "email"
                      : f.kind === "phone" ? "tel"
                      : f.kind === "date" ? "date"
                      : f.kind === "url" ? "url"
                      : "text"
                  }
                  autoComplete={f.kind === "email" ? "email" : "off"}
                  value={vals[f.key] ?? ""}
                  onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))}
                  onBlur={() => void persist()}
                  placeholder={placeholder}
                  className={inputClass}
                />
              )}

              {f.secret && (
                <p className="text-[11px] text-ink/45 pt-1.5">
                  🔒 Encrypted the moment you send it.
                  {savedHit?.isSecret && <> Something is already saved here ({savedHit.value}).</>}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="pt-3 min-h-[18px] text-[11.5px]">
        {state === "saving" && <span className="text-ink/45">Saving…</span>}
        {state === "saved" && <span className="text-ok">✓ Saved</span>}
        {state === "failed" && (
          <span className="text-urgent">Couldn&apos;t save — {error}. It&apos;ll retry when you move on.</span>
        )}
      </div>

      {refusals.length > 0 && (
        <div className="mt-2 rounded-xl border border-warn/30 bg-warn/5 px-3.5 py-3">
          {refusals.map((r) => (
            <p key={r.key} className="text-[12px] text-ink/75 leading-snug">
              <span className="font-semibold">{r.label}:</span> {r.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Note / skip
// ---------------------------------------------------------------------------

/**
 * The way past a step, at the top of it.
 *
 * Two jobs in one control: leave a note for the team, and move on without
 * finishing. Skipping is the important half — a step somebody cannot do should
 * not trap them on it, and a note attached to the skip tells us why instead of
 * leaving us to infer it from a gap.
 */
function StepNote({
  step, token, note, onNote, onSkip
}: {
  step: Step;
  token: string;
  note: string;
  onNote: (t: string) => void;
  onSkip: () => void;
}) {
  const preview = useContext(PreviewCtx);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  const send = async (message: string): Promise<boolean> => {
    if (preview) { setState("sent"); return true; }
    setState("sending");
    try {
      const res = await fetch(`/api/onboarding/${encodeURIComponent(token)}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: step.id, note: message })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "couldn't send");
      setState("sent");
      return true;
    } catch (err) {
      setState("idle");
      toast.error(err instanceof Error ? err.message : "couldn't send that");
      return false;
    }
  };

  const skip = async () => {
    const message = note.trim();
    if (message) {
      const ok = await send(message);
      if (!ok) return;
    }
    onSkip();
  };

  return (
    <div className="mt-6 rounded-2xl border border-border bg-white px-4 py-3 sm:px-5 sm:py-3.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">Stuck, or not sure?</div>
          <p className="text-[12px] text-ink/60 leading-snug pt-0.5 max-w-[54ch]">
            Leave a note and we&apos;ll get back to you within a day — or skip this for now and come
            back to it.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-[12.5px] font-medium px-3.5 py-1.5 rounded-full border border-border text-ink/70 hover:text-ink transition-colors"
            >
              Leave a note
            </button>
          )}
          <button
            type="button"
            onClick={skip}
            disabled={state === "sending"}
            className="text-[12.5px] font-medium px-3.5 py-1.5 rounded-full text-accent hover:bg-surface2 transition-colors disabled:opacity-40"
          >
            {state === "sending" ? "Sending…" : "Skip for now →"}
          </button>
        </div>
      </div>

      {open && (
        <div className="pt-3">
          {state === "sent" ? (
            <p className="text-[12.5px] text-ok leading-relaxed">
              Sent — we&apos;ll be in touch. Keep going, or skip this step for now.
            </p>
          ) : (
            <>
              <textarea
                value={note}
                onChange={(e) => onNote(e.target.value)}
                rows={3}
                placeholder="e.g. I'm not sure who manages our domain — can someone help me find out?"
                className={cn(inputClass, "mt-0 resize-y leading-relaxed text-[12.5px]")}
              />
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { if (note.trim()) void send(note.trim()); }}
                  disabled={state === "sending" || !note.trim()}
                  className="text-[12.5px] font-semibold px-3.5 py-1.5 rounded-full text-white disabled:opacity-40 transition-all active:scale-[0.98]"
                  style={{ background: PRIMARY }}
                >
                  {state === "sending" ? "Sending…" : "Send to our team"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="text-[12px] font-medium text-ink/55 hover:text-ink transition-colors"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A step
// ---------------------------------------------------------------------------

function StepCard({
  step, form, token, isDone, saved, files, note, onNote, onSkip, onSaved, onUploaded, registerSave
}: {
  step: Step;
  form: OnboardingForm;
  token: string;
  isDone: boolean;
  saved: Record<string, { value: string; isSecret: boolean }>;
  files: UploadedFile[];
  note: string;
  onNote: (t: string) => void;
  onSkip: () => void;
  onSaved: (stepId: string, values: Record<string, string>) => void;
  onUploaded: (f: UploadedFile) => void;
  registerSave: (fn: (() => Promise<void>) | null) => void;
}) {
  // One list, from the three things that used to sit inline: why it matters,
  // who is allowed to do it, and the ways people get each instruction wrong.
  // Phrased as questions, because that is how somebody scans for the one that
  // is theirs.
  const faq: { q: string; a: string }[] = [
    ...(step.why ? [{ q: "Why does this matter?", a: step.why }] : []),
    ...(step.whoCanDo ? [{ q: "Who needs to do this?", a: step.whoCanDo }] : []),
    ...(step.verify ? [{ q: "How will I know it worked?", a: step.verify }] : []),
    ...(step.substeps ?? [])
      .filter((s) => s.warn)
      .map((s) => ({ q: s.text, a: s.warn as string })),
    ...(step.troubleshoot ?? []).map((t) => ({ q: t.problem, a: t.fix }))
  ];

  return (
    <div className="max-w-[860px] mx-auto px-5 sm:px-8 py-8 sm:py-12">
      <div className="flex items-start gap-4 sm:gap-5">
        <div
          className={cn(
            "shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-2xl grid place-items-center text-[20px] sm:text-[24px] font-bold",
            isDone ? "bg-ok/12 text-ok" : "text-white shadow-lift"
          )}
          style={isDone ? undefined : { background: PRIMARY }}
        >
          {isDone ? "✓" : step.n}
        </div>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-[26px] sm:text-[32px] font-semibold tracking-tight text-ink leading-[1.15]">
            {step.title}
          </h2>
          {step.minutes > 0 && (
            <div className="pt-2">
              <span className="text-[11.5px] font-medium px-2.5 py-1 rounded-full bg-surface2 text-ink/60">
                about {step.minutes} {step.minutes === 1 ? "minute" : "minutes"}
              </span>
            </div>
          )}
        </div>
      </div>

      <StepNote step={step} token={token} note={note} onNote={onNote} onSkip={onSkip} />

      {(step.substeps ?? []).length > 0 && (
        <ol className="mt-8">
          {(step.substeps ?? []).map((sub, i) => (
            <li
              key={i}
              className={cn("flex gap-4 py-3.5", i > 0 && "border-t border-border/70")}
            >
              <span className="shrink-0 w-7 h-7 rounded-full grid place-items-center text-[12px] font-bold mt-px bg-accent/10 text-accent">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 text-[15px] text-ink leading-relaxed">
                {sub.text}
                {sub.click && (
                  <span className="ml-1.5 inline-block text-[12px] font-medium px-2 py-0.5 rounded-md bg-surface2 text-ink/70 align-middle">
                    {sub.click}
                  </span>
                )}
                {sub.shot && <Shot shot={sub.shot} />}
              </span>
            </li>
          ))}
        </ol>
      )}

      <CollectForm
        step={step}
        token={token}
        saved={saved}
        files={files}
        onSaved={onSaved}
        onUploaded={onUploaded}
        registerSave={registerSave}
      />

      {faq.length > 0 && (
        <details className="mt-8 group rounded-2xl border border-border bg-white">
          <summary className="px-4 py-3 text-[13px] font-medium text-ink/65 group-open:text-ink cursor-pointer list-none flex items-center gap-2 transition-colors">
            <span className="text-[11px] text-ink/40 transition-transform group-open:rotate-90" aria-hidden>
              ▶
            </span>
            Questions and things people get wrong
            <span className="text-[11px] font-normal text-ink/40">({faq.length})</span>
          </summary>
          <div className="px-4 pb-3 space-y-3">
            {faq.map((f) => (
              <div key={f.q} className="pt-1">
                <div className="text-[12.5px] font-semibold text-ink leading-snug">{f.q}</div>
                <p className="text-[12.5px] text-ink/65 leading-relaxed pt-1">{f.a}</p>
              </div>
            ))}
          </div>
        </details>
      )}

      <p className="sr-only">{form.label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The opening screen
// ---------------------------------------------------------------------------

/**
 * The contact step, given the whole screen.
 *
 * It is the only thing on the form we cannot recover later. Every other answer
 * has a second home — the team can ask about services on a call — but an
 * address we never collected means the client finishes, and nobody can tell
 * them what happens next. So it is asked first, on its own, with nothing else
 * competing for attention, and Continue stays disabled until there is a
 * plausible email in the box.
 */
function Gate({
  step, form, clientName, token, saved, onSaved, onContinue, registerSave
}: {
  step: Step;
  form: OnboardingForm;
  clientName: string;
  token: string;
  saved: Record<string, { value: string; isSecret: boolean }>;
  onSaved: (stepId: string, values: Record<string, string>) => void;
  onContinue: () => void;
  registerSave: (fn: (() => Promise<void>) | null) => void;
}) {
  const [email, setEmail] = useState(saved.email?.value ?? "");
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const hold = useCallback((fn: (() => Promise<void>) | null) => {
    saveRef.current = fn;
    registerSave(fn);
  }, [registerSave]);

  const ready = EMAIL_RE.test(email.trim());

  return (
    <div className="min-h-[70vh] flex items-center px-5 sm:px-8 py-10">
      <div className="max-w-[620px] mx-auto w-full">
        <div className="text-[12px] font-semibold text-ink/45">Setting up {clientName}</div>
        <h1 className="text-[30px] sm:text-[40px] font-semibold tracking-tight text-ink leading-[1.1] pt-4">
          {step.title}
        </h1>
        <p className="text-[15px] text-ink/65 leading-relaxed pt-3 max-w-[54ch]">{form.intro}</p>

        <div
          onChangeCapture={(e) => {
            // Mirrors the email box into the Continue gate without making this
            // component own every field's state.
            //
            // On change, NOT on blur. Clicking a disabled button does not
            // reliably move focus, so a blur-driven gate deadlocks: the button
            // stays disabled because the user never leaves the field, and the
            // only way out is to click some other part of the page first.
            const t = e.target as HTMLInputElement;
            if (t.id === `${step.id}-email`) setEmail(t.value);
          }}
        >
          <CollectForm
            step={step}
            token={token}
            saved={saved}
            files={[]}
            onSaved={onSaved}
            onUploaded={() => undefined}
            registerSave={hold}
          />
        </div>

        <div className="pt-7">
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              void (async () => {
                try {
                  await saveRef.current?.();
                } catch {
                  /* saved on blur already, most likely */
                }
                onContinue();
              })();
            }}
            className="text-[13px] font-semibold px-5 py-2.5 rounded-full text-white transition-all active:scale-[0.98] inline-flex items-center gap-2 disabled:opacity-40 shadow-lift"
            style={{ background: PRIMARY }}
          >
            Continue <span style={{ opacity: 0.7 }}>→</span>
          </button>
          {!ready && (
            <p className="text-[11.5px] text-ink/45 pt-2.5">
              We just need a name and an email address to start.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The end. Not a step — a receipt. */
function Finish({ clientName, form }: { clientName: string; form: OnboardingForm }) {
  return (
    <div className="min-h-[70vh] flex items-center px-5 sm:px-8 py-10">
      <div className="max-w-[560px] mx-auto w-full text-center">
        <div
          className="w-[76px] h-[76px] rounded-full grid place-items-center mx-auto text-white text-[34px]"
          style={{ background: "#16A34A", boxShadow: "0 14px 34px -12px rgba(22,163,74,0.9)" }}
        >
          ✓
        </div>
        <h2 className="text-[30px] sm:text-[38px] font-semibold tracking-tight text-ink leading-[1.1] pt-7">
          {clientName} is all set.
        </h2>
        <p className="text-[15px] text-ink/65 leading-relaxed pt-3.5 max-w-[46ch] mx-auto">
          Thank you — that&apos;s everything we needed. Our team has your answers and will be in touch
          with what happens next.
        </p>
        <p className="text-[12px] text-ink/40 pt-6">{form.label}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Says plainly that this is not real, and stays on screen. A preview that
 *  looked identical to the live form is one somebody eventually mistakes for
 *  it -- and then wonders why the client never appeared in DD. */
function PreviewBanner() {
  return (
    <div className="sticky top-0 z-40 bg-amber-50 border-b border-amber-200 px-5 py-2">
      <div className="max-w-[860px] mx-auto text-[12.5px] text-amber-900 flex items-center gap-2 flex-wrap">
        <span className="font-semibold">Preview</span>
        <span className="text-amber-800">
          This is what a client sees. Nothing you type is saved, no files upload, and nobody is
          notified. Reload to start over.
        </span>
      </div>
    </div>
  );
}

export function OnboardingFlow({
  token, clientName, form, initialAnswers, initialDoneSteps, initialFiles, alreadyCompleted,
  preview = false
}: {
  token: string;
  clientName: string;
  form: OnboardingForm;
  initialAnswers: AnswerState;
  initialDoneSteps: string[];
  initialFiles: UploadedFile[];
  alreadyCompleted: boolean;
  /** Walk the form without writing anything or notifying anyone. See PreviewCtx. */
  preview?: boolean;
}) {
  const steps = form.steps;
  const { done, mark } = useDone(token, initialDoneSteps, preview);
  const { notes, set: setNote } = useNotes(token, preview);
  const [answers, setAnswers] = useState<AnswerState>(initialAnswers);
  const [files, setFiles] = useState<UploadedFile[]>(initialFiles);
  const [finished, setFinished] = useState(alreadyCompleted);

  // Open on the first step they have not finished, so returning to a
  // half-done form carries on rather than restarting.
  const [at, setAt] = useState(() => {
    const doneSet = new Set(initialDoneSteps);
    const next = steps.findIndex((s) => !s.final && !doneSet.has(s.id));
    return next === -1 ? 0 : next;
  });

  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const registerSave = useCallback((fn: (() => Promise<void>) | null) => {
    saveRef.current = fn;
  }, []);

  const step = steps[at];
  const working = useMemo(() => steps.filter((s) => !s.final), [steps]);

  const go = useCallback((to: number) => {
    if (to < 0 || to >= steps.length) return;
    setAt(to);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "auto" });
  }, [steps.length]);

  const onSaved = useCallback((stepId: string, values: Record<string, string>) => {
    setAnswers((prev) => ({
      ...prev,
      [stepId]: {
        ...(prev[stepId] ?? {}),
        ...Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, { value: v, isSecret: false }])
        )
      }
    }));
  }, []);

  const onUploaded = useCallback((f: UploadedFile) => setFiles((prev) => [...prev, f]), []);

  /** Finish the step on screen: tick it, flush anything still being typed, tell
   *  the team, then move on.
   *
   *  The navigation does not wait on the network. The step is already ticked
   *  locally by the time this runs, so a slow or failed announce must never make
   *  the press feel like it did not land. */
  const finishStep = useCallback(() => {
    mark(step.id);
    const flush = saveRef.current;
    void (async () => {
      try {
        await flush?.();
      } catch {
        /* saved on blur already, most likely */
      }
      if (preview) return;
      try {
        const res = await fetch(`/api/onboarding/${encodeURIComponent(token)}/step-done`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stepId: step.id })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.finished) setFinished(true);
      } catch {
        /* the tick stands locally; the client is not blocked on us */
      }
    })();

    const next = at + 1;
    if (next < steps.length && !steps[next].final) go(next);
    else setFinished(true);
  }, [at, go, mark, preview, step, steps, token]);

  if (finished) {
    return (
      <PreviewCtx.Provider value={preview}>
        {preview && <PreviewBanner />}
        <Finish clientName={clientName} form={form} />
      </PreviewCtx.Provider>
    );
  }

  if (step.gate) {
    return (
      <PreviewCtx.Provider value={preview}>
        {preview && <PreviewBanner />}
      <Gate
        step={step}
        form={form}
        clientName={clientName}
        token={token}
        saved={answers[step.id] ?? {}}
        onSaved={onSaved}
        onContinue={() => {
          mark(step.id);
          if (!preview) void finishStepQuietly(token, step.id);
          go(at + 1);
        }}
        registerSave={registerSave}
      />
      </PreviewCtx.Provider>
    );
  }

  const doneCount = working.filter((s) => done.has(s.id)).length;

  return (
    <PreviewCtx.Provider value={preview}>
    {preview && <PreviewBanner />}
    <div className="min-h-screen">
      {/* The progress rail. One segment per step, filled for what is done — a
          count of nine that visibly shortens is most of what keeps somebody
          going through a long form. */}
      <div className="sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-border/60">
        <div className="max-w-[860px] mx-auto px-5 sm:px-8 py-3">
          <div className="flex items-center gap-1.5">
            {working.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => go(steps.findIndex((x) => x.id === s.id))}
                title={s.short}
                aria-label={s.short}
                aria-current={s.id === step.id ? "step" : undefined}
                className="flex-1 py-2 group"
              >
                <span
                  className={cn(
                    "block h-[3px] rounded-full transition-colors",
                    done.has(s.id)
                      ? "bg-ok"
                      : s.id === step.id
                        ? "bg-accent"
                        : "bg-border group-hover:bg-ink/20"
                  )}
                />
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between text-[11px] text-ink/50 pt-0.5">
            <span className="font-medium text-ink/70">{clientName}</span>
            <span className="tabular-nums">
              {doneCount} of {working.length} done
            </span>
          </div>
        </div>
      </div>

      <StepCard
        step={step}
        form={form}
        token={token}
        isDone={done.has(step.id)}
        saved={answers[step.id] ?? {}}
        files={files}
        note={notes[step.id] ?? ""}
        onNote={(t) => setNote(step.id, t)}
        onSkip={() => go(at + 1)}
        onSaved={onSaved}
        onUploaded={onUploaded}
        registerSave={registerSave}
      />

      <div className="border-t border-border px-5 sm:px-8 py-4">
        <div className="max-w-[860px] mx-auto flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => go(at - 1)}
            disabled={at === 0}
            className="text-[13px] font-medium px-3.5 py-1.5 rounded-full text-ink/60 hover:text-ink disabled:opacity-0 transition-all"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={finishStep}
            className="text-[13px] font-semibold px-5 py-2 rounded-full text-white transition-all active:scale-[0.98] inline-flex items-center gap-2 shadow-lift"
            style={{ background: PRIMARY }}
          >
            {done.has(step.id) && <span style={{ opacity: 0.85 }}>✓</span>}
            {step.doneLabel}
            <span style={{ opacity: 0.7 }}>→</span>
          </button>
        </div>
      </div>
    </div>
    </PreviewCtx.Provider>
  );
}

/** The gate's own step-done ping. Separate from finishStep because the gate
 *  renders before the rail exists and has no announce of its own to make — the
 *  team does not need a Slack post saying somebody typed their name. */
async function finishStepQuietly(token: string, stepId: string): Promise<void> {
  try {
    await fetch(`/api/onboarding/${encodeURIComponent(token)}/step-done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepId })
    });
  } catch {
    /* best effort */
  }
}
