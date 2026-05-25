"use client";

import { useEffect, useRef, useState } from "react";
import { Play, Pause, AlertTriangle, CheckCircle2, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Progress {
  runId: string;
  status: "running" | "completed" | "failed" | "paused";
  totalThreads: number;
  processedThreads: number;
  totalMessages: number;
  scoredMessages: number;
  skippedMessages: number;
  erroredMessages: number;
  startedAt: string;
  finishedAt: string | null;
  scopeFrom: string | null;
  scopeTo: string | null;
  lastError: string | null;
  done: boolean;
}

// Admin-only scanner UI. Each click of "Run a chunk" hits
// POST /api/admin/scan-mail-satisfaction with the current runId; the
// API replies after ~45s of real work with progress. "Auto-run" loops
// the call until the run completes or the operator pauses.
export function MailSatisfactionScanner() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const autoRef = useRef(false);

  // Hydrate the latest in-flight run on mount so a reload doesn't
  // visually reset to "no run yet".
  useEffect(() => {
    fetch("/api/admin/scan-mail-satisfaction", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (d.progress) setProgress(d.progress); })
      .catch(() => {});
  }, []);

  // Auto-run loop. Kicks a chunk whenever the previous one resolves;
  // we use a ref to read the latest flag inside the recursion without
  // re-binding the effect dependencies on every progress tick.
  useEffect(() => {
    autoRef.current = autoRun;
    if (!autoRun) return;
    let cancelled = false;
    (async function loop() {
      while (!cancelled && autoRef.current) {
        const p = await runChunk(progress?.runId ?? null).catch(() => null);
        if (!p) break;
        if (p.done || p.status === "failed") {
          autoRef.current = false;
          setAutoRun(false);
          break;
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  async function runChunk(runId: string | null): Promise<Progress | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/scan-mail-satisfaction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runId ? { runId } : {})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setProgress(data.progress);
      return data.progress as Progress;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "chunk failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const pct = progress && progress.totalThreads > 0
    ? Math.round((progress.processedThreads / Math.max(1, progress.totalThreads)) * 100)
    : null;

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-4 space-y-3">
        <header className="flex items-center gap-2">
          <Mail className="w-4 h-4 text-fuchsia-600" />
          <div className="text-sm font-semibold">Backfill scan</div>
          {progress && (
            <span className={cn(
              "ml-2 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full",
              progress.status === "running" && "bg-blue-100 text-blue-700",
              progress.status === "completed" && "bg-emerald-100 text-emerald-700",
              progress.status === "failed" && "bg-rose-100 text-rose-700",
              progress.status === "paused" && "bg-amber-100 text-amber-700"
            )}>
              {progress.status}
            </span>
          )}
        </header>

        <p className="text-[12px] text-ink/65 leading-relaxed">
          Scans every client thread in the missiveclone going back 3 months. Each message
          (inbound + outbound) is graded 0-100 by Claude Haiku; per-message rows persist in{" "}
          <code className="text-[11px] bg-slate-100 px-1 rounded">email_satisfaction_scores</code>.
          One chunk runs for about 45 seconds — click "Run a chunk" until the bar fills,
          or toggle Auto-run.
        </p>

        {progress ? (
          <div className="space-y-2">
            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className={cn(
                  "h-full transition-all duration-500",
                  progress.status === "completed" ? "bg-emerald-500" :
                  progress.status === "failed" ? "bg-rose-500" :
                  "bg-fuchsia-500"
                )}
                style={{ width: `${pct ?? (progress.scoredMessages > 0 ? 5 : 0)}%` }}
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <Stat label="Threads"   value={`${progress.processedThreads} / ${progress.totalThreads}`} />
              <Stat label="Scored"    value={String(progress.scoredMessages)} tone="emerald" />
              <Stat label="Skipped"   value={String(progress.skippedMessages)} tone="slate" />
              <Stat label="Errored"   value={String(progress.erroredMessages)} tone={progress.erroredMessages > 0 ? "rose" : "slate"} />
            </div>
            {progress.scopeFrom && (
              <div className="text-[10px] text-ink/55">
                Scope · {new Date(progress.scopeFrom).toLocaleDateString()} →{" "}
                {progress.scopeTo ? new Date(progress.scopeTo).toLocaleDateString() : "now"}
              </div>
            )}
            {progress.lastError && (
              <div className="text-[11px] rounded-lg bg-rose-50 border border-rose-200 text-rose-700 p-2 inline-flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span className="whitespace-pre-wrap">{progress.lastError}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[12px] text-ink/55 italic">No scan started yet.</div>
        )}

        <div className="flex items-center gap-2 flex-wrap pt-2">
          <button
            type="button"
            onClick={() => runChunk(progress?.runId ?? null)}
            disabled={busy || autoRun || progress?.status === "completed"}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
              (busy || autoRun || progress?.status === "completed") && "opacity-60 cursor-not-allowed hover:translate-y-0"
            )}
            style={{ background: "linear-gradient(135deg, #c026d3 0%, #a21caf 100%)" }}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {progress ? "Run a chunk" : "Start scan"}
          </button>
          <button
            type="button"
            onClick={() => setAutoRun((v) => !v)}
            disabled={progress?.status === "completed" || progress?.status === "failed"}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border",
              autoRun
                ? "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200"
                : "bg-white text-ink/70 border-slate-200 hover:border-ink/40",
              (progress?.status === "completed" || progress?.status === "failed") && "opacity-50 cursor-not-allowed"
            )}
          >
            {autoRun
              ? <><Pause className="w-3.5 h-3.5" /> Stop auto-run</>
              : <><Play className="w-3.5 h-3.5" /> Auto-run</>}
          </button>
          {progress?.status === "completed" && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" /> Scan complete.
            </span>
          )}
        </div>
      </div>

      <div className="text-[11px] text-ink/55 italic px-1">
        Tip: Auto-run keeps the browser tab awake — you can leave it open and the scan
        will finish on its own. The same Claude scoring runs daily on new mail, so this
        is a one-and-done.
      </div>
    </section>
  );
}

function Stat({
  label, value, tone = "slate"
}: {
  label: string;
  value: string;
  tone?: "slate" | "emerald" | "rose";
}) {
  const tones = {
    slate: "bg-slate-50 text-ink/75 border-slate-200/60",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200/60",
    rose: "bg-rose-50 text-rose-700 border-rose-200/60"
  } as const;
  return (
    <div className={cn("rounded-lg border px-2 py-1.5", tones[tone])}>
      <div className="text-[9px] uppercase tracking-wide opacity-70 font-semibold">{label}</div>
      <div className="text-[13px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}
