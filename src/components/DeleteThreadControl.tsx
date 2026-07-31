"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Gmail-style delete affordance for a thread row.
//
// The wrinkle this app has and Gmail doesn't: one conversation can live in
// several connected inboxes at once (the same message sent to support@ AND
// billing@). Deleting is therefore per-inbox, and the control adapts:
//
//   * thread is in ONE in-scope inbox (or we're inside a single inbox's view)
//     → click deletes, no questions asked.
//   * thread is in SEVERAL → click opens a checkbox popover listing each inbox
//     plus an "All inboxes" master toggle, so the user says exactly where it
//     should go. Every box is pre-ticked, so the fast path (delete everywhere)
//     stays one extra click.
//
// The delete itself is soft — see lib/thread-deletions — and the caller's
// onDeleted handler pairs with an Undo toast.
//
// The popover is PORTALLED to <body> and fixed-positioned rather than absolutely
// positioned inside the row. Two ancestors would otherwise eat it: ThreadList's
// card is `overflow-hidden` (rounded corners), and InboxSplit's list column is
// `overflow-y-auto` — so an in-flow dropdown got clipped at the card edge and
// scroll-trapped inside the column. Portalling also lifts it out of the row's
// hover-reveal wrapper, which carries an opacity transition the dropdown was
// inheriting and visibly flickering with.

export interface DeleteInboxOption {
  id: string;
  label: string;
}

// Panel geometry. POPOVER_MAX_H is the flip threshold, not a hard cap — it
// matches the panel's own max height (header + list cap + footer) closely
// enough to decide whether "below" actually fits.
const POPOVER_W = 248;
const POPOVER_MAX_H = 300;
const GUTTER = 8;

interface Props {
  options: DeleteInboxOption[];
  // Called with the chosen inbox ids once the user commits. The parent owns the
  // request + optimistic removal so it can also undo it.
  onDelete: (accountIds: string[]) => void | Promise<void>;
  // Compact styling for dense list rows vs. the roomier reading pane.
  size?: "sm" | "md";
  // Lets the parent keep a hover-revealed control pinned visible while the
  // popover is open — otherwise moving the cursor to the checkboxes (which sit
  // outside the row) would hide the thing you're interacting with.
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function DeleteThreadControl({
  options, onDelete, size = "sm", onOpenChange, className
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // Viewport coordinates for the portalled panel. Null until measured, so the
  // panel never paints at 0,0 for a frame before being placed.
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const multi = options.length > 1;
  const allIds = useMemo(() => options.map((o) => o.id), [options]);

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  // Anchor the panel to the trigger, right-aligned, flipping above when the
  // bottom of the viewport is closer than the panel is tall. Clamped to the
  // viewport on both axes so a row near an edge can't push it off screen.
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

  // Keep it pinned to the row while the list scrolls under it. Capture phase so
  // the scrolling ancestor (InboxSplit's column) is caught, not just the window.
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
      // Drop the measurement on close, so reopening after the row has moved
      // can't paint one frame at the old coordinates before re-placing.
      setPos(null);
    };
  }, [open, place]);

  // Every inbox pre-ticked whenever the popover opens: "delete this everywhere"
  // is the common intent, and un-ticking is easier than hunting for the right
  // box. Re-seeded on each open so a cancelled popover doesn't leak state.
  useEffect(() => {
    if (open) setChecked(new Set(allIds));
  }, [open, allIds]);

  // Close on outside click + Escape (same pattern as SidebarMoreMenu).
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      // The panel is portalled to <body>, so it is NOT inside wrapRef — both
      // have to be checked or clicking a checkbox would dismiss the popover.
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

  async function commit(ids: string[]) {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      await onDelete(ids);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  // The row is a <Link>; the button sits inside it, so every handler has to
  // stop the click from opening the thread in the reading pane.
  function onTriggerClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (multi) setOpen((v) => !v);
    else void commit(allIds);
  }

  const allChecked = checked.size === options.length;
  const iconSize = size === "md" ? "w-4 h-4" : "w-3.5 h-3.5";

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={onTriggerClick}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        disabled={busy}
        aria-haspopup={multi ? "dialog" : undefined}
        aria-expanded={multi ? open : undefined}
        title={multi ? "Delete — choose inboxes" : "Delete"}
        aria-label={multi ? "Delete — choose inboxes" : "Delete"}
        className={cn(
          "inline-flex items-center justify-center rounded-lg border transition-colors",
          size === "md" ? "w-8 h-8" : "w-7 h-7",
          open
            ? "bg-urgent/10 border-urgent/40 text-urgent"
            : "bg-white border-slate-200 text-ink/55 hover:text-urgent hover:border-urgent/40 hover:bg-urgent/5",
          busy && "opacity-60"
        )}
      >
        {busy ? <Loader2 className={cn(iconSize, "animate-spin")} /> : <Trash2 className={iconSize} />}
      </button>

      {multi && open && pos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="Delete from which inboxes"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            width: POPOVER_W,
            // Flipping above anchors the panel's BOTTOM edge to the trigger, so
            // it grows upward instead of off the top of the screen.
            transform: pos.above ? "translateY(-100%)" : undefined
          }}
          className="z-[60] rounded-xl border border-slate-200 bg-white shadow-lg p-2"
        >
          <div className="px-1.5 pt-0.5 pb-1.5 text-[11px] font-medium text-ink/55">
            This conversation is in {options.length} inboxes
          </div>

          {/* Master toggle. Indeterminate when only some boxes are ticked, so
              the header reflects the list instead of lying about it. */}
          <label className="flex items-center gap-2 px-1.5 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer">
            <input
              type="checkbox"
              className="accent-urgent w-3.5 h-3.5"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = checked.size > 0 && !allChecked;
              }}
              onChange={() =>
                setChecked(allChecked ? new Set() : new Set(allIds))
              }
            />
            <span className="text-[12px] font-semibold text-ink">All inboxes</span>
          </label>

          <div className="my-1 h-px bg-slate-100" />

          <div className="max-h-48 overflow-y-auto">
            {options.map((o) => (
              <label
                key={o.id}
                className="flex items-center gap-2 px-1.5 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="accent-urgent w-3.5 h-3.5"
                  checked={checked.has(o.id)}
                  onChange={() =>
                    setChecked((prev) => {
                      const next = new Set(prev);
                      if (next.has(o.id)) next.delete(o.id);
                      else next.add(o.id);
                      return next;
                    })
                  }
                />
                <span className="text-[12px] text-ink/75 truncate" title={o.label}>
                  {o.label}
                </span>
              </label>
            ))}
          </div>

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
              disabled={checked.size === 0 || busy}
              onClick={() => { void commit([...checked]); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-medium bg-urgent text-white disabled:opacity-40 enabled:hover:brightness-110"
            >
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}
              Delete
              {checked.size > 0 && checked.size < options.length && ` (${checked.size})`}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
