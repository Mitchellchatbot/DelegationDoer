"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Sparkles, ArrowRight, ArrowLeft, Loader2, X, Check, Plus, ChevronDown, Sunrise
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SodSeoDashboard, type SeoDashboardData } from "./SodSeoDashboard";
import { SodWebsiteDashboard, type WebDashboardData } from "./SodWebsiteDashboard";

// Orchestrates the full SOD flow:
//   1. Welcome — "Welcome, {name}!" + a motivational line + Continue
//   2. Dashboard — SEO or Website personalised payload (skipped for
//      other departments)
//   3. Top priority — "What's the top thing you want to get done?"
//   4. Tasks — list-builder; each row has "Add as task" + "Pick existing"
//   5. Blockers — optional
//   6. Submit — fires /api/sod/submit; DMs leadership.
//
// Mounted from the (main) layout via a small gate effect, and from the
// /updates/sod page's Simulate button. In either case the flow is the
// same except simulate=1 bypasses the shift-window check on the API.

interface Props {
  open: boolean;
  simulate?: boolean;
  onClose: () => void;
  onComplete: () => void;
}

type Screen =
  | "loading"
  | "welcome"
  | "dashboard"
  | "form_priority"
  | "form_tasks"
  | "form_blockers"
  | "submitting"
  | "done";

interface TodayResp {
  eligible: boolean;
  alreadySubmitted: boolean;
  shiftDate: string;
  shiftStart: string | null;
  shiftEnd: string | null;
  departmentKey: "dep_seo" | "dep_web" | null;
  motivationalLine: string;
  userName: string | null;
  reason: string;
}

interface MyTaskOption {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "urgent" | "waiting_on_client";
}

export function SodFlow({ open, simulate = false, onClose, onComplete }: Props) {
  const [mounted, setMounted] = useState(false);
  const [screen, setScreen] = useState<Screen>("loading");
  const [today, setToday] = useState<TodayResp | null>(null);
  const [dashboard, setDashboard] = useState<SeoDashboardData | WebDashboardData | null>(null);
  const [topPriority, setTopPriority] = useState("");
  // Each row tracks where it came from: `existingTaskId` is set when
  // the user picked from "Pick existing" — those rows shouldn't show
  // the "Add as task" affordance since the task already exists.
  const [taskItems, setTaskItems] = useState<Array<{ text: string; existingTaskId?: string }>>([]);
  const [newTaskDraft, setNewTaskDraft] = useState("");
  const [blockers, setBlockers] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [myTasks, setMyTasks] = useState<MyTaskOption[]>([]);
  const [direction, setDirection] = useState<"forward" | "back">("forward");

  useEffect(() => setMounted(true), []);

  // Boot: fetch eligibility + dashboard payload in parallel.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setScreen("loading");
    (async () => {
      try {
        const url = simulate ? "/api/sod/today?simulate=1" : "/api/sod/today";
        const r = await fetch(url, { cache: "no-store" });
        const t = (await r.json()) as TodayResp;
        if (cancelled) return;
        setToday(t);
        if (!t.eligible && !simulate) {
          onClose();
          return;
        }
        setScreen("welcome");
        if (t.departmentKey) {
          fetch("/api/sod/dashboard", { cache: "no-store" })
            .then((r) => r.json())
            .then((d) => { if (!cancelled) setDashboard(d.payload ?? null); })
            .catch(() => { /* silent — dashboard is best-effort */ });
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(`Couldn't start SOD: ${err instanceof Error ? err.message : "unknown"}`);
          onClose();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, simulate, onClose]);

  // Load my open tasks lazily when the picker is opened.
  useEffect(() => {
    if (!pickerOpen || myTasks.length > 0) return;
    let cancelled = false;
    fetch("/api/sod/my-tasks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setMyTasks((d.tasks ?? []) as MyTaskOption[]);
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [pickerOpen, myTasks.length]);

  const save = useCallback(
    async (patch: { topPriority?: string; tasksPlanned?: string; blockers?: string }) => {
      if (!today) return;
      try {
        await fetch("/api/sod/notes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: today.shiftDate, ...patch })
        });
      } catch { /* silent — submit will retry inline */ }
    },
    [today]
  );

  const advance = (next: Screen) => {
    setDirection("forward");
    setScreen(next);
  };
  const back = (prev: Screen) => {
    setDirection("back");
    setScreen(prev);
  };

  function addTaskLine() {
    const v = newTaskDraft.trim();
    if (!v) return;
    setTaskItems((cur) => {
      const next = [...cur, { text: v }];
      void save({ tasksPlanned: next.map((t) => t.text).join("\n") });
      return next;
    });
    setNewTaskDraft("");
  }
  function removeTaskLine(i: number) {
    setTaskItems((cur) => {
      const next = cur.filter((_, idx) => idx !== i);
      void save({ tasksPlanned: next.map((t) => t.text).join("\n") });
      return next;
    });
  }

  async function addAsTask(line: string) {
    try {
      // Use the SOD-specific endpoint — bypasses the clock-in gate and
      // pre-fills status=in_progress + assignee=self + the user's
      // primary department.
      const r = await fetch("/api/sod/create-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: line })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error ?? `status ${r.status}`);
      toast.success(`Created task: ${line}`);
      // Mark this row as linked to the freshly-created task so the
      // user can't accidentally create it twice — same UX as a row
      // that came from "Pick existing".
      setTaskItems((cur) =>
        cur.map((item) =>
          item.text === line && !item.existingTaskId
            ? { ...item, existingTaskId: d.id }
            : item
        )
      );
    } catch (err) {
      toast.error(`Couldn't create task: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  async function pickExisting(t: MyTaskOption) {
    setTaskItems((cur) => {
      const next = [...cur, { text: t.title, existingTaskId: t.id }];
      void save({ tasksPlanned: next.map((it) => it.text).join("\n") });
      return next;
    });
    setPickerOpen(false);
    // 'pending' (not started) and 'waiting_on_client' both indicate the
    // task isn't actively being worked yet — picking either into SOD
    // means "I'm starting on this today," so auto-flip to in_progress.
    if (t.status === "pending" || t.status === "waiting_on_client") {
      try {
        await fetch(`/api/tasks/${encodeURIComponent(t.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "in_progress" })
        });
        toast.message(`"${t.title}" → In progress`);
      } catch { /* silent */ }
    }
  }

  async function submit() {
    if (!today) return;
    advance("submitting");
    try {
      const r = await fetch("/api/sod/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: today.shiftDate,
          topPriority,
          tasksPlanned: taskItems.map((t) => t.text).join("\n"),
          blockers
        })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `status ${r.status}`);
      // Be specific about delivery results — the old "no Slack DMs
      // configured" message hid useful detail (e.g. SLACK_BOT_TOKEN
      // missing vs recipient unresolved vs nobody matched).
      const deliveries = (d.deliveries ?? []) as Array<{ name: string | null; delivered: boolean; reason?: string }>;
      if (d.recipients === 0) {
        toast.message("SOD saved — no Slack recipients matched.");
      } else if (d.delivered > 0) {
        const names = deliveries.filter((x) => x.delivered).map((x) => x.name ?? "—").join(", ");
        toast.success(`SOD DM'd to: ${names}`);
      } else {
        const reasons = deliveries
          .filter((x) => !x.delivered)
          .map((x) => `${x.name ?? "—"} (${x.reason ?? "unknown"})`)
          .join("; ");
        toast.warning(`SOD saved — Slack DM failed: ${reasons}`, { duration: 10000 });
      }
      advance("done");
      onComplete();
      setTimeout(() => onClose(), 1500);
    } catch (err) {
      toast.error(`Couldn't submit: ${err instanceof Error ? err.message : "unknown"}`);
      back("form_blockers");
    }
  }

  if (!mounted || !open) return null;

  const overlay = (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div
        className={cn(
          "relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] min-h-[460px] overflow-y-auto",
          "border border-white/60"
        )}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-ink/45 hover:text-ink p-1 rounded-lg hover:bg-slate-100"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        {screen === "loading" && (
          <div className="p-10 text-center text-ink/60 inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your day…
          </div>
        )}

        {screen === "welcome" && today && (
          <Welcome
            name={today.userName ?? "there"}
            line={today.motivationalLine}
            shiftStart={today.shiftStart}
            onContinue={() =>
              advance(today.departmentKey ? "dashboard" : "form_priority")
            }
          />
        )}

        {screen === "dashboard" && today && (
          <div className="p-8 space-y-5">
            <header className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4 text-violet-500" />
              <h2 className="text-lg font-semibold">Today at a glance</h2>
            </header>
            <p className="text-sm text-ink/65">
              Quick scan before you set today's priorities.
            </p>
            {dashboard?.kind === "seo" && <SodSeoDashboard data={dashboard} />}
            {dashboard?.kind === "web" && <SodWebsiteDashboard data={dashboard} />}
            {!dashboard && (
              <div className="text-sm text-ink/55 py-6 text-center">
                Loading dashboard…
              </div>
            )}
            <Footer
              onBack={() => back("welcome")}
              onNext={() => advance("form_priority")}
              nextLabel="Set today's plan"
            />
          </div>
        )}

        {screen === "form_priority" && (
          <FormStep
            title="What's your top priority today?"
            subtitle="One thing — the thing that would make today a win."
            value={topPriority}
            onChange={setTopPriority}
            onBlur={() => void save({ topPriority })}
            placeholder="Ship the SOD welcome modal"
            onBack={() => back(today?.departmentKey ? "dashboard" : "welcome")}
            onNext={() => {
              if (!topPriority.trim()) {
                toast.error("Pick one top priority before moving on.");
                return;
              }
              advance("form_tasks");
            }}
          />
        )}

        {screen === "form_tasks" && (
          <div className="p-8 space-y-5">
            <header>
              <h2 className="text-lg font-semibold">Tasks on your plate today</h2>
              <p className="text-sm text-ink/65 mt-1">
                Add each task as a line. You can also create real tasks or pull from your existing ones.
              </p>
            </header>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newTaskDraft}
                onChange={(e) => setNewTaskDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addTaskLine(); }
                }}
                placeholder="Type a task and press Enter…"
                className="flex-1 text-sm border border-slate-200/70 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40"
              />
              <button
                type="button"
                onClick={addTaskLine}
                disabled={!newTaskDraft.trim()}
                className={cn(
                  "inline-flex items-center gap-1 text-xs font-medium px-3 py-2 rounded-lg bg-white border border-slate-200/70 hover:border-accent/40 hover:text-accent",
                  !newTaskDraft.trim() && "opacity-40 cursor-not-allowed"
                )}
              >
                <Plus className="w-3 h-3" /> Add
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  className="inline-flex items-center gap-1 text-xs font-medium px-3 py-2 rounded-lg bg-white border border-slate-200/70 hover:border-accent/40 hover:text-accent"
                >
                  <ChevronDown className="w-3 h-3" /> Pick existing
                </button>
                {pickerOpen && (
                  <div className="absolute right-0 top-full mt-1 w-72 max-h-72 overflow-y-auto rounded-xl border border-slate-200/70 bg-white shadow-lg z-10 p-1">
                    {myTasks.length === 0 ? (
                      <div className="p-3 text-xs text-ink/55">No open tasks assigned to you.</div>
                    ) : (
                      myTasks.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => void pickExisting(t)}
                          className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-100 text-xs"
                        >
                          <div className="font-medium text-ink truncate">{t.title}</div>
                          <div className="text-[10px] text-ink/55">
                            {t.status === "pending" ? "Not started" :
                             t.status === "in_progress" ? "In progress" :
                             t.status === "urgent" ? "Urgent" :
                             "Waiting on client"}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>

            <ul className="space-y-1.5">
              {taskItems.length === 0 ? (
                <li className="text-sm text-ink/45 italic">No tasks yet — add one above.</li>
              ) : taskItems.map((item, i) => (
                <li
                  key={`${i}-${item.text}`}
                  className="group flex items-center gap-2 text-sm border border-slate-200/70 rounded-lg px-2.5 py-1.5"
                >
                  <span className="flex-1 truncate text-ink">{item.text}</span>
                  {item.existingTaskId ? (
                    <span
                      className="text-[10px] uppercase tracking-wide font-semibold text-violet-600 bg-violet-50 border border-violet-200/70 rounded-full px-1.5 py-0.5"
                      title="Linked to an existing task"
                    >
                      Existing
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void addAsTask(item.text)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-accent hover:underline"
                      title="Create a real task from this line"
                    >
                      Add as task
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeTaskLine(i)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-ink/45 hover:text-rose-600"
                    aria-label="Remove"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>

            <Footer
              onBack={() => back("form_priority")}
              onNext={() => advance("form_blockers")}
              nextLabel="Next"
            />
          </div>
        )}

        {screen === "form_blockers" && (
          <FormStep
            title="Anything blocking you?"
            subtitle="Optional — share if there's a decision, dependency, or context you need from someone."
            value={blockers}
            onChange={setBlockers}
            onBlur={() => void save({ blockers })}
            placeholder="(leave empty if none)"
            onBack={() => back("form_tasks")}
            onNext={() => void submit()}
            nextLabel="Submit SOD"
            multiline
          />
        )}

        {screen === "submitting" && (
          <div className="p-10 text-center text-ink/60 inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" /> Sending your SOD…
          </div>
        )}

        {screen === "done" && (
          <div className="p-10 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 grid place-items-center mx-auto">
              <Check className="w-6 h-6" />
            </div>
            <div className="text-base font-medium">SOD submitted — have a great day!</div>
            <div className="text-sm text-ink/55">DM'd to leadership.</div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

function Welcome({
  name, line, shiftStart, onContinue
}: {
  name: string;
  line: string;
  shiftStart: string | null;
  onContinue: () => void;
}) {
  // Three-row layout: empty top + centered content + button pinned to
  // bottom. flex-1 on the middle row pushes the button down while
  // perfectly centering the welcome message vertically + horizontally.
  return (
    <div className="flex flex-col items-center text-center min-h-[540px] p-10">
      <div className="flex-1 flex flex-col items-center justify-center gap-7 w-full">
        <div className="w-24 h-24 rounded-full bg-amber-100 text-amber-600 grid place-items-center shadow-sm">
          <Sunrise className="w-12 h-12" />
        </div>
        <h2 className="text-5xl font-semibold tracking-tight">
          Welcome, <span className="text-accent">{name?.split(" ")[0] || name}</span>!
        </h2>
        <p className="text-xl text-ink/75 max-w-xl leading-relaxed">{line}</p>
        {shiftStart && (
          <p className="text-xs text-ink/45 tabular-nums">
            shift starts at {shiftStart}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onContinue}
        className="inline-flex items-center gap-2 px-7 py-3 rounded-full text-base font-semibold text-white shadow-md transition-all hover:-translate-y-0.5 active:scale-95"
        style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
      >
        Continue <ArrowRight className="w-5 h-5" />
      </button>
    </div>
  );
}

function FormStep({
  title, subtitle, value, onChange, onBlur, placeholder, onBack, onNext,
  nextLabel = "Next", multiline = false
}: {
  title: string;
  subtitle: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  placeholder: string;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  multiline?: boolean;
}) {
  return (
    <div className="p-8 space-y-5">
      <header>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-sm text-ink/65 mt-1.5">{subtitle}</p>
      </header>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          rows={6}
          className="w-full text-base border border-slate-200/70 rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40 resize-y"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          className="w-full text-base border border-slate-200/70 rounded-lg px-4 py-3 outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent/40"
        />
      )}
      <Footer onBack={onBack} onNext={onNext} nextLabel={nextLabel} />
    </div>
  );
}

function Footer({
  onBack, onNext, nextLabel
}: {
  onBack: () => void;
  onNext: () => void;
  nextLabel: string;
}) {
  return (
    <div className="flex items-center justify-between pt-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs font-medium text-ink/55 hover:text-ink"
      >
        <ArrowLeft className="w-3 h-3" /> Back
      </button>
      <button
        type="button"
        onClick={onNext}
        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95"
        style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
      >
        {nextLabel} <ArrowRight className="w-3 h-3" />
      </button>
    </div>
  );
}
