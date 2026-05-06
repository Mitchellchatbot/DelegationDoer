"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Check, Clock, Minus, X, AlertTriangle, Plus, Bell, ArrowLeft, Image as ImageIcon } from "lucide-react";
import { Countdown } from "@/components/Countdown";

interface WidgetTask {
  id: string;
  title: string;
  description?: string | null;
  priority: "low" | "medium" | "high" | "critical";
  status: string;
  dueDate: string | null;
  estimatedHours: number;
  inactiveFlag: boolean;
  needsAck: boolean;
}

type WidgetState = "bubble" | "alert" | "panel";

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Two-tone alarm via the Web Audio API. No asset file needed; works inside
// Electron's renderer without microphone-style permissions.
function playAlertSound() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, when: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + when);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + duration);
    };
    tone(880, 0,    0.22);
    tone(660, 0.16, 0.22);
    tone(880, 0.32, 0.22);
    setTimeout(() => ctx.close(), 800);
  } catch { /* renderer doesn't support audio context */ }
}

export default function WidgetPage() {
  const [state, setState] = useState<WidgetState>("bubble");
  const [tasks, setTasks] = useState<WidgetTask[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const lastFetchedRef = useRef<number>(0);

  // Make the BrowserWindow's transparent flag actually show through, and
  // lock document scroll — the window is exactly the size of its content.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }, []);

  // Push the renderer's logical state to the main process so it resizes the
  // BrowserWindow accordingly.
  useEffect(() => {
    (window as any).widgetAPI?.setState?.(state);
  }, [state]);

  // Tray menu can still drive expansion remotely.
  useEffect(() => {
    (window as any).widgetAPI?.onSetExpanded?.((v: boolean) => {
      setState(v ? "panel" : "bubble");
    });
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/widget/my-tasks", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const next: WidgetTask[] = data.tasks ?? [];
      const unackedNow = next.filter((t) => t.needsAck);

      // New unacked id → play the alarm.
      const fresh = unackedNow.filter((t) => !seenIdsRef.current.has(t.id));
      if (fresh.length > 0) playAlertSound();
      seenIdsRef.current = new Set(unackedNow.map((t) => t.id));

      setTasks(next);
      lastFetchedRef.current = Date.now();

      // Auto state transitions based on unacked count.
      setState((prev) => {
        if (prev === "panel") return "panel"; // user is already looking
        return unackedNow.length > 0 ? "alert" : "bubble";
      });
    } catch { /* ignore network blips */ }
  }, []);

  // Initial fetch + 15s polling. (Tighter than the old 60s so the alarm
  // feels live; cheap because it's a single Postgres query each time.)
  useEffect(() => {
    fetchTasks();
    const id = setInterval(fetchTasks, 15_000);
    return () => clearInterval(id);
  }, [fetchTasks]);

  // While in alert state, replay the alarm every 25s until acked. Annoying-
  // by-design — that was the brief.
  useEffect(() => {
    if (state !== "alert") return;
    const id = setInterval(playAlertSound, 25_000);
    return () => clearInterval(id);
  }, [state]);

  const unacked = tasks.filter((t) => t.needsAck);

  async function acknowledge(taskId: string) {
    // Optimistic
    setTasks((cur) => cur.map((t) => t.id === taskId ? { ...t, needsAck: false } : t));
    seenIdsRef.current.delete(taskId);
    try {
      await fetch("/api/widget/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId })
      });
    } catch { /* surfaced via next poll if it actually failed */ }
    // After acking the last one, drop back to bubble (unless user opened panel).
    setState((prev) => {
      if (prev === "panel") return "panel";
      const remaining = tasks.filter((t) => t.needsAck && t.id !== taskId);
      return remaining.length > 0 ? "alert" : "bubble";
    });
  }

  function expandToPanel() { setState("panel"); }
  function collapseToBubble() {
    // From the panel, going back to bubble or alert depending on unacked count.
    setState(unacked.length > 0 ? "alert" : "bubble");
  }

  if (state === "panel") return <Panel tasks={tasks} unacked={unacked} onAck={acknowledge} onCollapse={collapseToBubble} onUpdated={fetchTasks} />;
  if (state === "alert") return <Alert task={unacked[0]} unackedCount={unacked.length} onAck={acknowledge} onExpand={expandToPanel} />;
  return <Bubble onExpand={expandToPanel} unackedCount={unacked.length} />;
}

/* ============================ ICON ============================ */
// Shared bubble icon used in both `bubble` and `alert` states. Putting the
// drop-shadow filter on the <img> (not the <button>) so the shadow follows
// the icon's circular alpha mask rather than the rectangular button box —
// otherwise the bubble reads as a squircle even though the icon is round.

function BubbleIcon({ unackedCount }: { unackedCount: number }) {
  return (
    <div style={{ position: "relative", width: 64, height: 64 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/widget-icon.png"
        alt="DelegationDoer"
        draggable={false}
        style={{
          width: 64,
          height: 64,
          display: "block",
          userSelect: "none",
          pointerEvents: "none",
          filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.35))"
        }}
      />
      {unackedCount > 0 && (
        <span style={{
          position: "absolute", top: -2, right: -2,
          minWidth: 18, height: 18, padding: "0 5px",
          borderRadius: 999,
          background: "#DC2626",
          color: "white",
          fontSize: 11, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
          border: "2px solid white",
          boxShadow: "0 2px 4px rgba(0,0,0,0.25)"
        }}>{unackedCount}</span>
      )}
    </div>
  );
}

/* ============================ BUBBLE ============================ */

const DRAG_THRESHOLD = 4;

function Bubble({ onExpand, unackedCount }: { onExpand: () => void; unackedCount: number }) {
  const startRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  function api() { return (window as any).widgetAPI; }

  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.screenX, y: e.screenY, dragging: false };
  }
  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const s = startRef.current;
    if (!s) return;
    if (!s.dragging) {
      if (Math.hypot(e.screenX - s.x, e.screenY - s.y) > DRAG_THRESHOLD) {
        s.dragging = true;
        api()?.dragStart?.(e.screenX, e.screenY);
      } else return;
    }
    api()?.dragMove?.(e.screenX, e.screenY);
  }
  function onPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const s = startRef.current;
    startRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    if (!s) return;
    if (s.dragging) api()?.dragEnd?.();
    else onExpand();
  }
  function onPointerCancel() {
    if (startRef.current?.dragging) api()?.dragEnd?.();
    startRef.current = null;
  }

  return (
    <div style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}>
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        title="Click to open · drag to move"
        aria-label="Open DelegationDoer"
        className="wg-bubble-btn anim-scale-in"
        style={{
          padding: 0, margin: 0, border: "none",
          background: "transparent", display: "block",
          cursor: "grab"
        }}
      >
        <BubbleIcon unackedCount={unackedCount} />
      </button>
    </div>
  );
}

/* ============================ ALERT (speech bubble) ============================ */

function Alert({
  task, unackedCount, onAck, onExpand
}: {
  task: WidgetTask | undefined;
  unackedCount: number;
  onAck: (id: string) => void;
  onExpand: () => void;
}) {
  if (!task) return null;
  return (
    <div
      // Drag region on the speech bubble area so it can still be moved.
      // @ts-ignore — Electron-only
      style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: 8, gap: 8, background: "transparent", WebkitAppRegion: "drag" } as any}
    >
      {/* Speech bubble */}
      <div
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="relative flex-1 cursor-pointer anim-pop-bubble"
      >
        <div className="bg-white rounded-2xl border border-amber-300 shadow-[0_8px_24px_rgba(60,40,20,0.25)] px-3 py-2.5 pr-4">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-amber-700 font-semibold">
            <Bell className="w-3 h-3" />
            New {priorityLabel(task.priority)} task
            {unackedCount > 1 && <span className="ml-auto text-amber-700/70">+{unackedCount - 1} more</span>}
          </div>
          <div className="text-[13px] text-slate-900 font-medium leading-snug mt-0.5 line-clamp-2">
            {task.title}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] inline-flex items-center gap-1">
              <Clock className="w-3 h-3 text-slate-400" />
              <Countdown iso={task.dueDate} className="text-[10px]" />
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onAck(task.id); }}
              // @ts-ignore
              style={{ WebkitAppRegion: "no-drag" } as any}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-medium shadow-sm"
            >
              <Check className="w-3 h-3" /> Got it
            </button>
          </div>
        </div>

        {/* Tail pointing right toward the bubble */}
        <div
          className="absolute"
          style={{
            right: -7, top: "50%", transform: "translateY(-50%) rotate(45deg)",
            width: 14, height: 14,
            background: "white",
            borderRight: "1px solid #FCD34D",
            borderTop: "1px solid #FCD34D"
          }}
        />
      </div>

      {/* Bubble icon (right) — same component as the no-notif state so they
          look identical. */}
      <button
        onClick={onExpand}
        // @ts-ignore
        style={{ WebkitAppRegion: "no-drag", padding: 0, border: "none", background: "transparent" } as any}
        className="shrink-0 wg-bubble-btn anim-scale-in"
        aria-label="Open"
      >
        <BubbleIcon unackedCount={unackedCount} />
      </button>

    </div>
  );
}

function priorityLabel(p: WidgetTask["priority"]) {
  return p === "critical" ? "CRITICAL" : p;
}

/* ============================ PANEL ============================ */

function Panel({
  tasks, unacked, onAck, onCollapse, onUpdated
}: {
  tasks: WidgetTask[];
  unacked: WidgetTask[];
  onAck: (id: string) => void;
  onCollapse: () => void;
  onUpdated: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const acked = tasks.filter((t) => !t.needsAck).sort(
    (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  );

  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : null;
  if (selected) {
    return (
      <UpdateView
        task={selected}
        onClose={() => setSelectedId(null)}
        onUpdated={() => { onUpdated(); setSelectedId(null); }}
      />
    );
  }

  return (
    <div className="h-screen w-screen p-2 anim-fade-in">
      <div className="h-full w-full flex flex-col bg-white text-slate-900 rounded-[28px] overflow-hidden border border-slate-200 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.35),0_8px_24px_-12px_rgba(0,0,0,0.2)]">
        <div
          className="h-10 flex items-center justify-between px-4 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <div className="flex items-center gap-2 text-xs">
            <div className="w-5 h-5 rounded-full overflow-hidden bg-[#F5EFE3] border border-black/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/widget-icon.png" alt="" className="w-full h-full object-cover" draggable={false} />
            </div>
            <span className="font-medium">DelegationDoer</span>
          </div>
          <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as any}>
            <button title="Collapse" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors" onClick={onCollapse}>
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button title="Hide" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors" onClick={() => (window as any).widgetAPI?.hide?.()}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {unacked.length > 0 && (
            <div className="px-3 pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-2 inline-flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Action required · {unacked.length}
              </div>
              <div className="space-y-2">
                {unacked.map((t, i) => (
                  <div
                    key={t.id}
                    role="button"
                    onClick={() => setSelectedId(t.id)}
                    style={{ animationDelay: `${i * 35}ms` }}
                    className="wg-card anim-fade-in-up rounded-2xl bg-amber-50 border border-amber-300 p-3 cursor-pointer hover:bg-amber-100/60"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13px] font-medium leading-snug">{t.title}</div>
                      <span className="badge-pill">{t.priority}</span>
                    </div>
                    {t.description && <div className="text-[11px] text-slate-600 mt-1 line-clamp-2">{t.description}</div>}
                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                      <button
                        onClick={(e) => { e.stopPropagation(); onAck(t.id); }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-medium transition-all active:scale-90"
                      >
                        <Check className="w-3 h-3" /> Acknowledge
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {acked.length > 0 && (
            <div className="px-3 pt-4 pb-3">
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-2">Today's focus</div>
              <div className="space-y-2">
                {acked.map((t, i) => (
                  <div
                    key={t.id}
                    role="button"
                    onClick={() => setSelectedId(t.id)}
                    style={{ animationDelay: `${(unacked.length + i) * 35}ms` }}
                    className={"wg-card anim-fade-in-up rounded-2xl bg-white p-3 border cursor-pointer hover:border-slate-300 hover:shadow-sm " + (t.inactiveFlag ? "border-amber-300" : "border-slate-200")}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[13px] leading-snug font-medium">{t.title}</div>
                      <span className="badge-pill">{t.priority}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                      <span className="text-slate-400">est {t.estimatedHours}h</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unacked.length === 0 && acked.length === 0 && (
            <div className="text-xs text-slate-400 text-center py-10">All clear.</div>
          )}
        </div>

        <div className="border-t border-slate-100 px-4 py-2 flex items-center justify-between text-[11px] text-slate-500">
          <button onClick={() => (window as any).widgetAPI?.openMain?.()} className="hover:text-slate-900">Open full app →</button>
          <span>tap a card to update</span>
        </div>

        <style>{`
          .badge-pill {
            display: inline-flex; align-items: center; padding: 1px 8px;
            border-radius: 999px; font-size: 10px; font-weight: 500; border: 1px solid;
            background: #F1F5F9; color: #475569; border-color: #E2E8F0;
          }
        `}</style>
      </div>
    </div>
  );
}

/* ============================ UPDATE VIEW ============================ */

const STATUS_OPTIONS: { value: string; label: string; tone: string }[] = [
  { value: "pending",            label: "Pending",            tone: "border-slate-300 bg-slate-50 text-slate-700" },
  { value: "in_progress",        label: "In progress",        tone: "border-blue-300 bg-blue-50 text-blue-800" },
  { value: "urgent",             label: "Urgent",             tone: "border-rose-300 bg-rose-50 text-rose-700" },
  { value: "waiting_on_client",  label: "Waiting on client",  tone: "border-amber-300 bg-amber-50 text-amber-800" },
  { value: "done",               label: "Done",               tone: "border-emerald-300 bg-emerald-50 text-emerald-800" }
];

function UpdateView({
  task, onClose, onUpdated
}: {
  task: WidgetTask;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [status, setStatus] = useState<string>(task.status);
  const [comment, setComment] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImagePreview(URL.createObjectURL(file));
  }
  function clearImage() {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
  }

  const dirty = status !== task.status || comment.trim().length > 0 || imageFile !== null;

  async function save() {
    if (!dirty || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let imageUrl: string | null = null;
      if (imageFile) {
        const fd = new FormData();
        fd.append("file", imageFile);
        fd.append("taskId", task.id);
        const upRes = await fetch("/api/upload", { method: "POST", body: fd });
        const upData = await upRes.json();
        if (!upRes.ok) throw new Error(upData?.error ?? "upload failed");
        imageUrl = upData.url;
      }

      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, comment: comment.trim() || null, imageUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "save failed");

      onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="h-screen w-screen p-2 anim-slide-in-right">
      <div className="h-full w-full flex flex-col bg-white text-slate-900 rounded-[28px] overflow-hidden border border-slate-200 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.35),0_8px_24px_-12px_rgba(0,0,0,0.2)]">
        <div
          className="h-10 flex items-center justify-between px-2 border-b border-slate-100"
          // @ts-ignore — Electron-only
          style={{ WebkitAppRegion: "drag" }}
        >
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            // @ts-ignore
            style={{ WebkitAppRegion: "no-drag" } as any}
            title="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="text-xs font-medium text-slate-700 truncate flex-1 text-center px-2">Update task</div>
          <button
            onClick={() => (window as any).widgetAPI?.hide?.()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            // @ts-ignore
            style={{ WebkitAppRegion: "no-drag" } as any}
            title="Hide"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold leading-snug">{task.title}</div>
              <span className="badge-pill shrink-0">{task.priority}</span>
            </div>
            {task.description && (
              <div className="text-[11px] text-slate-600 mt-1 line-clamp-3 whitespace-pre-wrap">{task.description}</div>
            )}
            <div className="mt-1.5 text-[11px] text-slate-500 inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <Countdown iso={task.dueDate} className="text-[11px]" />
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">New status</div>
            <div className="grid grid-cols-2 gap-1.5">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStatus(s.value)}
                  className={
                    "text-left text-[11px] px-2.5 py-1.5 rounded-lg border transition-all duration-150 active:scale-[0.97] " +
                    (status === s.value
                      ? `${s.tone} font-medium ring-1 ring-inset ring-slate-400/20 scale-[1.01]`
                      : "border-slate-200 hover:border-slate-300 text-slate-700")
                  }
                >
                  {s.label}
                  {s.value === task.status && status !== s.value && <span className="text-[9px] ml-1 text-slate-400">(now)</span>}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Comment <span className="text-slate-400 normal-case">(optional)</span></div>
            <textarea
              className="w-full px-2.5 py-2 text-xs rounded-lg bg-white border border-slate-200 placeholder:text-slate-400 focus:outline-none focus:border-slate-400 min-h-[60px]"
              placeholder="What changed? Anything blocking?"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>

          <div>
            <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-1.5">Image <span className="text-slate-400 normal-case">(optional)</span></div>
            {imagePreview ? (
              <div className="relative inline-block anim-scale-in">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imagePreview} alt="upload preview" className="rounded-lg max-h-32 border border-slate-200" />
                <button
                  onClick={clearImage}
                  type="button"
                  className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white hover:bg-black/80"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-dashed border-slate-300 text-xs text-slate-500 hover:border-slate-400 cursor-pointer">
                <ImageIcon className="w-3.5 h-3.5" />
                Add image
                <input type="file" accept="image/*" className="hidden" onChange={pickImage} />
              </label>
            )}
          </div>
        </div>

        <div className="border-t border-slate-100 p-2 flex items-center gap-2">
          {error && <span className="text-[10px] text-rose-600 truncate flex-1">⚠ {error}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors active:scale-[0.97]"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!dirty || submitting}
              className="px-3 py-1.5 text-xs rounded-lg bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.97]"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <style>{`
          .badge-pill {
            display: inline-flex; align-items: center; padding: 1px 8px;
            border-radius: 999px; font-size: 10px; font-weight: 500; border: 1px solid;
            background: #F1F5F9; color: #475569; border-color: #E2E8F0;
          }
        `}</style>
      </div>
    </div>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
