"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BellOff, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { suggestRules, describeRule, type MuteMatchType, type MuteSuggestion } from "@/lib/inbox-mute-shared";

// "Mute this" affordance for a thread row.
//
// Muting is workspace-wide, so the risk isn't the click — it's picking a rule
// broader than you meant and quietly losing a client's real mail. This popover
// exists to make that visible before it happens:
//
//   * it offers only rules that actually match this message, safest first, with
//     the right one pre-selected (a wordpress@ sender suggests wordpress@*, not
//     the client's whole domain);
//   * it shows how many of the last 500 notifications each rule would have
//     caught, fetched on selection, so an over-broad domain rule reads as
//     "would have muted 214 messages" rather than looking identical to a safe one.
//
// Portalled + fixed-positioned for the same reasons as DeleteThreadControl:
// the list card clips, and the split column scrolls.

const POPOVER_W = 288;
const POPOVER_MAX_H = 340;
const GUTTER = 8;

interface Props {
  from: string | null;
  subject: string | null;
  // Called after a rule is saved so the list can drop the thread optimistically.
  onMuted: (rule: { matchType: MuteMatchType; value: string }) => void | Promise<void>;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

interface Preview {
  matched: number;
  sampled: number;
}

export function MuteSenderControl({ from, subject, onMuted, onOpenChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const suggestions = useMemo(() => suggestRules({ from, subject }), [from, subject]);
  const [picked, setPicked] = useState(0);

  const keyOf = (s: MuteSuggestion) => `${s.matchType}:${s.value}`;

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  // Pre-select whichever option the shared suggester marked recommended.
  useEffect(() => {
    if (!open) return;
    const idx = suggestions.findIndex((s) => s.recommended);
    setPicked(idx === -1 ? 0 : idx);
    setError(null);
  }, [open, suggestions]);

  const place = useCallback(() => {
    const btn = wrapRef.current?.getBoundingClientRect();
    if (!btn) return;
    const room = window.innerHeight - btn.bottom;
    const above = room < POPOVER_MAX_H && btn.top > room;
    setPos({
      left: Math.max(
        GUTTER,
        Math.min(btn.right - POPOVER_W, window.innerWidth - POPOVER_W - GUTTER)
      ),
      top: above ? btn.top - 6 : btn.bottom + 6,
      above
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    let frame = 0;
    const onMove = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; place(); });
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      setPos(null);
    };
  }, [open, place]);

  // Fetch the "would have caught N" count for the selected option. One request
  // per option, cached for the life of the component — moving between options
  // shouldn't re-hit the server.
  const current = suggestions[picked];
  useEffect(() => {
    if (!open || !current) return;
    const key = keyOf(current);
    if (previews[key]) return;
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({
          preview: "1",
          matchType: current.matchType,
          value: current.value
        });
        const res = await fetch(`/api/inboxes/mute-rules?${params}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setPreviews((p) => ({ ...p, [key]: { matched: data.matched ?? 0, sampled: data.sampled ?? 0 } }));
        }
      } catch { /* preview is advisory — silence is fine */ }
    })();
    return () => { cancelled = true; };
  }, [open, current, previews]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function commit() {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inboxes/mute-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchType: current.matchType, value: current.value })
      });
      if (res.status === 403) {
        setError("Only leaders and admins can mute — ask one of them to add this rule.");
        return;
      }
      if (!res.ok) throw new Error();
      setOpen(false);
      await onMuted({ matchType: current.matchType, value: current.value });
    } catch {
      setError("Couldn't save that rule. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // No resolvable sender — nothing sensible to offer, so don't render a control
  // that can only disappoint.
  if (suggestions.length === 0) return null;

  const preview = current ? previews[keyOf(current)] : undefined;

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Mute this sender"
        aria-label="Mute this sender"
        className={cn(
          "inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-colors",
          open
            ? "bg-warn/10 border-warn/40 text-warn"
            : "bg-white border-slate-200 text-ink/55 hover:text-warn hover:border-warn/40 hover:bg-warn/5"
        )}
      >
        <BellOff className="w-3.5 h-3.5" />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Mute this sender"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            width: POPOVER_W,
            transform: pos.above ? "translateY(-100%)" : undefined
          }}
          className="z-[60] rounded-xl border border-slate-200 bg-white shadow-lg p-2"
        >
          <div className="px-1.5 pt-0.5 pb-1.5 text-[11px] text-ink/55 leading-relaxed">
            Stop this pinging and keep it out of the inbox. It stays readable
            under <span className="font-semibold text-ink">Muted</span>.
          </div>

          <div className="max-h-56 overflow-y-auto">
            {suggestions.map((s, i) => {
              const p = previews[keyOf(s)];
              return (
                <label
                  key={keyOf(s)}
                  className={cn(
                    "flex items-start gap-2 px-1.5 py-1.5 rounded-lg cursor-pointer",
                    i === picked ? "bg-accent/5" : "hover:bg-slate-50"
                  )}
                >
                  <input
                    type="radio"
                    name="mute-rule"
                    className="accent-accent w-3.5 h-3.5 mt-0.5"
                    checked={i === picked}
                    onChange={() => setPicked(i)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-ink truncate">
                      {describeRule(s.matchType, s.value)}
                    </span>
                    <span className="block text-[10.5px] text-ink/50 leading-snug mt-0.5">
                      {s.hint}
                    </span>
                    {/* The guardrail: a broad rule that would have caught a lot
                        of recent mail says so, in place, before it's saved. */}
                    {p && p.sampled > 0 && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 mt-1 text-[10px] tabular-nums",
                          s.broad && p.matched > 0 ? "text-warn font-medium" : "text-ink/45"
                        )}
                      >
                        {s.broad && p.matched > 0 && <AlertTriangle className="w-2.5 h-2.5" />}
                        Would have muted {p.matched} of the last {p.sampled}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          {error && (
            <div className="mt-1 px-1.5 py-1.5 rounded-lg bg-urgent/5 text-[11px] text-urgent">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-1.5 pt-2 mt-1 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-2.5 py-1 rounded-lg text-[12px] text-ink/60 hover:text-ink hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !current}
              onClick={() => { void commit(); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-medium bg-accent text-white disabled:opacity-40 enabled:hover:brightness-110"
            >
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}
              Mute
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
