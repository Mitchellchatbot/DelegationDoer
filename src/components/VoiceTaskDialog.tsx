"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic, MicOff, X, Loader2, Sparkles, Trash2, Check, ChevronLeft, Wand2
} from "lucide-react";
import { toast } from "sonner";
import { useDictation } from "./useDictation";
import { cn } from "@/lib/utils";

type Priority = "low" | "medium" | "high" | "critical";

interface SuggestedAssignee {
  userId: string;
  name: string;
  score: number;
  reason: string;
  capacityPct: number;
}
interface Draft {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  clientName: string | null;
  dueDate: string | null;
  tags: string[];
  suggestedAssignees: SuggestedAssignee[];
}
interface Person { id: string; name: string; departmentIds: string[] }
interface Dept { id: string; name: string }

// A draft plus the founder's editable delegation choices.
interface EditableDraft extends Draft {
  assigneeId: string;
  departmentId: string | null;
}

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" }
];

// Speak a brain-dump → Claude drafts structured, delegatable tasks →
// founder edits/approves → each approved task is created + delegated via
// the audited POST /api/tasks path (assign + Slack DM + calendar sync).
export function VoiceTaskDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [transcript, setTranscript] = useState("");
  const [phase, setPhase] = useState<"capture" | "review">("capture");
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<EditableDraft[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [departments, setDepartments] = useState<Dept[]>([]);

  const { supported, listening, transcribing, toggle } = useDictation({
    onTranscript: setTranscript,
    baselineValue: transcript
  });

  function reset() {
    setTranscript("");
    setPhase("capture");
    setDrafting(false);
    setCreating(false);
    setDrafts([]);
    setPeople([]);
    setDepartments([]);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Defer so the close animation isn't interrupted by a state wipe.
      setTimeout(reset, 200);
    }
  }

  const peopleById = new Map(people.map((p) => [p.id, p]));

  async function draftTasks() {
    const text = transcript.trim();
    if (!text) {
      toast.error("Say or type something first.");
      return;
    }
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/voice-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(`Drafting failed: ${typeof data?.error === "string" ? data.error : `HTTP ${res.status}`}`);
        return;
      }
      const rawDrafts: Draft[] = Array.isArray(data.drafts) ? data.drafts : [];
      if (rawDrafts.length === 0) {
        toast.message(typeof data.note === "string" ? data.note : "No tasks found in that recording.");
        return;
      }
      setPeople(Array.isArray(data.people) ? data.people : []);
      setDepartments(Array.isArray(data.departments) ? data.departments : []);
      const pplById = new Map<string, Person>(
        (Array.isArray(data.people) ? data.people : []).map((p: Person) => [p.id, p])
      );
      setDrafts(
        rawDrafts.map((d) => {
          const topId = d.suggestedAssignees[0]?.userId ?? "";
          const dept = pplById.get(topId)?.departmentIds?.[0] ?? null;
          return { ...d, assigneeId: topId, departmentId: dept };
        })
      );
      setPhase("review");
    } catch (err) {
      toast.error(`Network error: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setDrafting(false);
    }
  }

  function patchDraft(id: string, patch: Partial<EditableDraft>) {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }
  function removeDraft(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }
  function chooseAssignee(id: string, assigneeId: string) {
    const dept = peopleById.get(assigneeId)?.departmentIds?.[0] ?? null;
    patchDraft(id, { assigneeId, departmentId: dept });
  }

  async function approveAll() {
    const ready = drafts.filter((d) => d.title.trim());
    if (ready.length === 0) {
      toast.error("Nothing to create.");
      return;
    }
    setCreating(true);
    let created = 0;
    const failures: string[] = [];
    // Sequential so Slack DMs / activity logs land in a predictable order and
    // one bad row doesn't abort the rest.
    for (const d of ready) {
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: d.title.trim(),
            description: d.description.trim() || undefined,
            priority: d.priority,
            assigneeId: d.assigneeId || undefined,
            departmentId: d.departmentId || undefined,
            dueDate: d.dueDate || undefined,
            clientName: d.clientName || undefined,
            tags: d.tags
          })
        });
        if (res.ok) {
          created += 1;
        } else {
          const data = await res.json().catch(() => ({}));
          failures.push(`"${d.title.slice(0, 30)}": ${typeof data?.error === "string" ? data.error : `HTTP ${res.status}`}`);
        }
      } catch (err) {
        failures.push(`"${d.title.slice(0, 30)}": ${err instanceof Error ? err.message : "network error"}`);
      }
    }
    setCreating(false);

    if (created > 0) {
      toast.success(`${created} task${created === 1 ? "" : "s"} created and delegated.`);
      router.refresh();
    }
    if (failures.length > 0) {
      toast.error(`${failures.length} failed — ${failures[0]}`);
    }
    if (failures.length === 0) {
      onOpenChange(false);
    }
  }

  const readyCount = drafts.filter((d) => d.title.trim()).length;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          title="Create tasks by voice"
          aria-label="Create tasks by voice"
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-[14px] font-medium text-accent bg-white/70 border border-accent/30 hover:bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift whitespace-nowrap shrink-0"
        >
          <Mic className="w-4 h-4" />
          <span className="hidden md:inline">Voice</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 anim-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 outline-none pointer-events-none flex items-start justify-center pt-20 px-4 lg:pl-[264px]"
        >
          <div className="pointer-events-auto w-full max-w-[720px] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-3xl border border-white/60 bg-gradient-to-br from-blue-50/90 via-white/95 to-indigo-50/85 backdrop-blur-md shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] anim-fade-in-up">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/60 sticky top-0 bg-white/70 backdrop-blur-sm z-10">
              <div className="flex items-center gap-2">
                {phase === "review" && (
                  <button
                    onClick={() => setPhase("capture")}
                    className="w-7 h-7 -ml-1 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-white/70 transition-colors"
                    aria-label="Back"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                )}
                <div>
                  <Dialog.Title className="text-base font-semibold flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-accent" />
                    {phase === "capture" ? "Voice tasks" : "Review & delegate"}
                  </Dialog.Title>
                  <Dialog.Description className="text-xs text-muted mt-0.5">
                    {phase === "capture"
                      ? "Speak your to-dos — AI drafts the tasks, you approve."
                      : `${readyCount} task${readyCount === 1 ? "" : "s"} drafted. Edit anything, then delegate.`}
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  className="w-8 h-8 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-white/70 transition-colors"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="p-6">
              {phase === "capture" ? (
                <CaptureView
                  supported={supported}
                  listening={listening}
                  transcribing={transcribing}
                  toggle={toggle}
                  transcript={transcript}
                  setTranscript={setTranscript}
                  drafting={drafting}
                  onDraft={draftTasks}
                />
              ) : (
                <div className="space-y-4">
                  <AnimatePresence initial={false}>
                    {drafts.map((d) => (
                      <motion.div
                        key={d.id}
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.15 } }}
                      >
                        <DraftCard
                          draft={d}
                          people={people}
                          departments={departments}
                          onPatch={(patch) => patchDraft(d.id, patch)}
                          onChooseAssignee={(uid) => chooseAssignee(d.id, uid)}
                          onRemove={() => removeDraft(d.id)}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>

                  {drafts.length === 0 && (
                    <div className="text-center text-sm text-muted py-8">
                      All drafts dismissed.{" "}
                      <button onClick={() => setPhase("capture")} className="text-accent underline">
                        Record again
                      </button>
                    </div>
                  )}

                  {drafts.length > 0 && (
                    <div className="flex items-center justify-between gap-3 pt-1">
                      <button
                        onClick={() => setPhase("capture")}
                        className="text-sm text-muted hover:text-ink transition-colors"
                      >
                        ← Edit transcript
                      </button>
                      <button
                        onClick={approveAll}
                        disabled={creating || readyCount === 0}
                        className={cn(
                          "inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-sm transition-all",
                          creating || readyCount === 0
                            ? "bg-slate-300 cursor-not-allowed"
                            : "bg-accent hover:bg-accent/90 hover:-translate-y-0.5 hover:shadow-lift"
                        )}
                      >
                        {creating ? (
                          <><Loader2 className="w-4 h-4 animate-spin" /> Delegating…</>
                        ) : (
                          <><Check className="w-4 h-4" /> Approve &amp; delegate {readyCount}</>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CaptureView({
  supported, listening, transcribing, toggle,
  transcript, setTranscript, drafting, onDraft
}: {
  supported: boolean;
  listening: boolean;
  transcribing: boolean;
  toggle: () => void;
  transcript: string;
  setTranscript: (v: string) => void;
  drafting: boolean;
  onDraft: () => void;
}) {
  const status = transcribing
    ? "Transcribing…"
    : listening
      ? "Listening — tap to stop"
      : transcript
        ? "Tap the mic to add more, or draft tasks"
        : "Tap the mic and start talking";

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-3 py-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!supported || transcribing}
          className={cn(
            "relative w-20 h-20 rounded-full grid place-items-center text-white shadow-lg transition-all",
            !supported
              ? "bg-slate-300 cursor-not-allowed"
              : listening
                ? "bg-rose-500 hover:bg-rose-600"
                : "bg-accent hover:bg-accent/90 hover:-translate-y-0.5"
          )}
          aria-label={listening ? "Stop recording" : "Start recording"}
        >
          {listening && (
            <motion.span
              className="absolute inset-0 rounded-full bg-rose-400/50"
              animate={{ scale: [1, 1.35, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          {transcribing ? (
            <Loader2 className="w-8 h-8 animate-spin relative" />
          ) : listening ? (
            <MicOff className="w-8 h-8 relative" />
          ) : (
            <Mic className="w-8 h-8 relative" />
          )}
        </button>
        <div className="text-xs text-muted h-4">{supported ? status : "Mic not supported in this browser — type below."}</div>
      </div>

      <div>
        <label className="label mb-1 block">Transcript</label>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={5}
          placeholder="e.g. “Get the new hero design done for ACME by Friday, it's urgent. Also someone needs to write three blog posts for the SEO push and set up the analytics tracking on the pricing page.”"
          className="input w-full resize-y"
        />
      </div>

      <div className="flex justify-end">
        <button
          onClick={onDraft}
          disabled={drafting || !transcript.trim()}
          className={cn(
            "inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-sm transition-all",
            drafting || !transcript.trim()
              ? "bg-slate-300 cursor-not-allowed"
              : "bg-accent hover:bg-accent/90 hover:-translate-y-0.5 hover:shadow-lift"
          )}
        >
          {drafting ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Drafting tasks…</>
          ) : (
            <><Wand2 className="w-4 h-4" /> Draft tasks</>
          )}
        </button>
      </div>
    </div>
  );
}

function DraftCard({
  draft, people, departments, onPatch, onChooseAssignee, onRemove
}: {
  draft: EditableDraft;
  people: Person[];
  departments: Dept[];
  onPatch: (patch: Partial<EditableDraft>) => void;
  onChooseAssignee: (userId: string) => void;
  onRemove: () => void;
}) {
  const selectedSuggestion = draft.suggestedAssignees.find((s) => s.userId === draft.assigneeId);

  return (
    <div className="rounded-2xl border border-white/70 bg-white/80 backdrop-blur-sm shadow-sm p-4 space-y-3">
      <div className="flex items-start gap-2">
        <input
          value={draft.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder="Task title"
          className="input flex-1 font-semibold"
        />
        <button
          onClick={onRemove}
          className="w-9 h-9 shrink-0 rounded-lg grid place-items-center text-muted hover:text-rose-600 hover:bg-rose-50 transition-colors"
          aria-label="Dismiss this task"
          title="Dismiss"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <textarea
        value={draft.description}
        onChange={(e) => onPatch({ description: e.target.value })}
        rows={2}
        placeholder="Description"
        className="input w-full resize-y text-sm"
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label mb-1 block">Priority</label>
          <select
            value={draft.priority}
            onChange={(e) => onPatch({ priority: e.target.value as Priority })}
            className="input w-full"
          >
            {PRIORITY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label mb-1 block">Due date</label>
          <input
            type="date"
            value={draft.dueDate ?? ""}
            onChange={(e) => onPatch({ dueDate: e.target.value || null })}
            className="input w-full"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label mb-1 block">Client</label>
          <input
            value={draft.clientName ?? ""}
            onChange={(e) => onPatch({ clientName: e.target.value || null })}
            placeholder="Optional"
            className="input w-full"
          />
        </div>
        <div>
          <label className="label mb-1 block">Department</label>
          <select
            value={draft.departmentId ?? ""}
            onChange={(e) => onPatch({ departmentId: e.target.value || null })}
            className="input w-full"
          >
            <option value="">Unassigned</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="label mb-1 block">Delegate to</label>
        <select
          value={draft.assigneeId}
          onChange={(e) => onChooseAssignee(e.target.value)}
          className="input w-full"
        >
          <option value="">Unassigned (routing review)</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {selectedSuggestion ? (
          <div className="mt-1.5 text-[11px] text-emerald-700 flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            AI pick · {selectedSuggestion.reason} · {selectedSuggestion.capacityPct}% capacity used
          </div>
        ) : draft.suggestedAssignees.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">
            <span>Suggested:</span>
            {draft.suggestedAssignees.map((s) => (
              <button
                key={s.userId}
                onClick={() => onChooseAssignee(s.userId)}
                className="px-1.5 py-0.5 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                title={`${s.reason} · ${s.capacityPct}% capacity used`}
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
