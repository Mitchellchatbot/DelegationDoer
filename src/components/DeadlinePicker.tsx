"use client";

// Deadline picker: a datetime-local-style field that expands into a
// calendar + hour/minute/AM-PM dropdowns + draggable clock dial.
// Ported from a standalone HTML/JS mockup (deadline-picker-dropdowns.html)
// onto the app's Tailwind tokens (accent/ink/muted/border/surface2).
//
// Controlled like a normal input: `value` is a datetime-local string
// ("YYYY-MM-DDTHH:mm") or "", `onChange` receives the same shape.

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Clock, ChevronDown } from "lucide-react";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

// "End of day" shortcut — 3:00 am, matching the original picker design.
// (The form's separate, shift-aware "Default EOD" button is a different
// thing; this one is the fixed in-panel convenience the design shipped with.)
const EOD_HOUR = 3, EOD_MIN = 0;

const pad = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date | null, b: Date | null) =>
  !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function parseValue(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function formatValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultDate(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
  return d;
}
function setHour12(d: Date, h12: number) {
  const pm = d.getHours() >= 12;
  const h = h12 % 12;
  d.setHours(pm ? h + 12 : h);
}
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const HOUR_ITEMS = Array.from({ length: 12 }, (_, i) => ({ v: i + 1, label: pad(i + 1) }));
const MIN_ITEMS = Array.from({ length: 60 }, (_, i) => ({ v: i, label: pad(i) }));
const MER_ITEMS = [{ v: "am", label: "am" }, { v: "pm", label: "pm" }];

interface DDItem { v: string | number; label: string; }

function Dropdown({
  label, items, current, wide, open, onToggle, onPick,
}: {
  label: string; items: DDItem[]; current: string | number; wide?: boolean;
  open: boolean; onToggle: () => void; onPick: (v: string | number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const on = listRef.current.querySelector<HTMLElement>('[data-on="true"]');
    if (on) listRef.current.scrollTop = on.offsetTop - listRef.current.clientHeight / 2 + on.offsetHeight / 2;
  }, [open]);

  const currentLabel = items.find((it) => String(it.v) === String(current))?.label ?? "--";

  return (
    <div className={"relative " + (wide ? "flex-[1.1]" : "flex-1")}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className={
          "w-full flex items-center justify-between gap-1 rounded-lg border px-2.5 py-1.5 text-base font-normal tabular-nums transition-colors " +
          (open ? "border-accent bg-surface2" : "border-border bg-surface2 hover:bg-border/40")
        }
      >
        <span>{currentLabel}</span>
        <ChevronDown className={"w-3.5 h-3.5 text-muted transition-transform " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute z-20 top-[calc(100%+4px)] left-0 right-0 max-h-[150px] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lift"
        >
          {items.map((it) => {
            const on = String(it.v) === String(current);
            return (
              <button
                key={it.v}
                type="button"
                role="option"
                aria-selected={on}
                data-on={on}
                onClick={(e) => { e.stopPropagation(); onPick(it.v); }}
                className={
                  "block w-full rounded-md py-1.5 text-center text-[13px] tabular-nums transition-colors " +
                  (on ? "bg-accent text-white font-medium" : "text-ink hover:bg-surface2")
                }
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface DeadlinePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function DeadlinePicker({ value, onChange, placeholder = "Set a deadline" }: DeadlinePickerProps) {
  const propDate = useMemo(() => parseValue(value), [value]);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Date | null>(propDate);
  const [view, setView] = useState(() => startOfMonth(propDate ?? new Date()));
  const [mode, setMode] = useState<"hour" | "minute">("hour");
  const [openDD, setOpenDD] = useState<null | "hour" | "minute" | "mer">(null);
  const [dragging, setDragging] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const dialRef = useRef<SVGSVGElement>(null);
  const lastDegRef = useRef<number | null>(null);

  // Resync from the outside only while the panel is closed.
  useEffect(() => {
    if (!open) setDraft(propDate);
  }, [propDate, open]);

  useEffect(() => {
    if (!open) return;
    // Outside-click closes the whole panel. Must gate on rootRef.contains:
    // React synthetic stopPropagation() does NOT stop the native event from
    // reaching this document-level listener (React 17+ roots events at the
    // app container, not document), so an unguarded handler would fire on
    // every in-panel click and slam dropdowns/panel shut. Only one dropdown
    // is ever open at a time (openDD is a single enum), so opening one
    // already closes the others — no extra close-on-inside-click needed.
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setOpenDD(null);
      }
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") { setOpen(false); setOpenDD(null); } }
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDocClick); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const working = draft ?? defaultDate();

  function commit(d: Date | null) {
    const next = d ? new Date(d) : null;
    if (next) next.setSeconds(0, 0);
    setDraft(next);
    onChange(next ? formatValue(next) : "");
  }

  // ---------- calendar ----------
  const calDays = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const today = new Date();
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { d, out: d.getMonth() !== view.getMonth(), today: sameDay(d, today), sel: sameDay(d, working) };
    });
  }, [view, working]);

  function pickDay(d: Date) {
    const picked = new Date(d);
    picked.setHours(working.getHours(), working.getMinutes(), 0, 0);
    setView(startOfMonth(picked));
    commit(picked);
  }

  // ---------- dropdowns ----------
  let h12 = working.getHours() % 12; if (h12 === 0) h12 = 12;
  const minutes = working.getMinutes();
  const meridiem = working.getHours() >= 12 ? "pm" : "am";

  function pickHour(v: string | number) {
    const d = new Date(working); setHour12(d, Number(v)); setMode("hour"); commit(d); setOpenDD(null);
  }
  function pickMinute(v: string | number) {
    const d = new Date(working); d.setMinutes(Number(v)); setMode("minute"); commit(d); setOpenDD(null);
  }
  function pickMeridiem(v: string | number) {
    const d = new Date(working); const pm = d.getHours() >= 12;
    if (v === "pm" && !pm) d.setHours(d.getHours() + 12);
    if (v === "am" && pm) d.setHours(d.getHours() - 12);
    commit(d); setOpenDD(null);
  }

  // ---------- dial ----------
  const CX = 105, CY = 105, R_FACE = 96, R_NUM = 75, R_HOUR = 52, R_KNOB = 16;
  const pt = (deg: number, r: number): [number, number] => {
    const a = (deg - 90) * (Math.PI / 180);
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  };
  const [hx, hy] = pt((h12 % 12) * 30, R_HOUR);
  const [mx, my] = pt(minutes * 6, R_NUM);

  function polar(clientX: number, clientY: number) {
    const r = dialRef.current!.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 210 - CX;
    const y = ((clientY - r.top) / r.height) * 210 - CY;
    return { deg: (Math.atan2(y, x) * (180 / Math.PI) + 90 + 360) % 360, rad: Math.hypot(x, y) };
  }
  function pickHand(deg: number, rad: number): "hour" | "minute" {
    const gap = (a: number, b: number) => { const x = Math.abs(a - b) % 360; return x > 180 ? 360 - x : x; };
    const dh = gap(deg, (h12 % 12) * 30), dm = gap(deg, minutes * 6);
    if (Math.abs(dh - dm) < 15) return rad >= 63 ? "minute" : "hour";
    return dh < dm ? "hour" : "minute";
  }
  function applyDeg(deg: number, currentMode: "hour" | "minute") {
    const d = new Date(working);
    if (currentMode === "hour") {
      const h = Math.round(deg / 30) % 12;
      setHour12(d, h === 0 ? 12 : h);
    } else {
      d.setMinutes(Math.round(deg / 6) % 60);
    }
    d.setSeconds(0, 0);
    setDraft(d);
  }
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  useEffect(() => {
    if (!dragging) return;
    const activeMode = mode;
    // Reads/writes draftRef directly (not the `working` closure) so a fast
    // stream of pointermove events — possibly spanning multiple full
    // rotations — always sees the value the previous move just set, instead
    // of a copy frozen at drag start.
    function onMove(e: PointerEvent) {
      e.preventDefault();
      const p = polar(e.clientX, e.clientY);
      const d = new Date(draftRef.current ?? defaultDate());
      if (activeMode === "hour") {
        if (lastDegRef.current !== null) {
          if ((lastDegRef.current > 270 && p.deg < 90) || (lastDegRef.current < 90 && p.deg > 270)) {
            d.setHours(d.getHours() >= 12 ? d.getHours() - 12 : d.getHours() + 12);
          }
        }
        const h = Math.round(p.deg / 30) % 12;
        setHour12(d, h === 0 ? 12 : h);
      } else {
        d.setMinutes(Math.round(p.deg / 6) % 60);
      }
      d.setSeconds(0, 0);
      lastDegRef.current = p.deg;
      draftRef.current = d;
      setDraft(d);
    }
    function onUp() {
      setDragging(false);
      lastDegRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      commit(draftRef.current);
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  function onDialPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    e.preventDefault();
    setOpenDD(null);
    const p = polar(e.clientX, e.clientY);
    const m = pickHand(p.deg, p.rad);
    setMode(m);
    lastDegRef.current = p.deg;
    applyDeg(p.deg, m);
    setDragging(true);
  }
  function onDialWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    const d = new Date(working);
    if (mode === "hour") {
      let h = d.getHours() % 12; if (h === 0) h = 12;
      setHour12(d, ((h - 1 + dir) % 12 + 12) % 12 + 1);
    } else {
      d.setMinutes((d.getMinutes() + dir * (e.shiftKey ? 5 : 1) + 60) % 60);
    }
    commit(d);
  }
  function onDialKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    const step = e.shiftKey ? 5 : 1;
    const d = new Date(working);
    if (e.key === "ArrowUp" || e.key === "ArrowRight") { mode === "hour" ? d.setHours(d.getHours() + 1) : d.setMinutes(d.getMinutes() + step); }
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { mode === "hour" ? d.setHours(d.getHours() - 1) : d.setMinutes(d.getMinutes() - step); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setMode((m) => (m === "hour" ? "minute" : "hour")); return; }
    else return;
    e.preventDefault();
    commit(d);
  }

  // ---------- field display ----------
  const fieldLabel = useMemo(() => {
    if (!propDate) return null;
    let h = propDate.getHours() % 12; if (h === 0) h = 12;
    const p = propDate.getHours() >= 12 ? "pm" : "am";
    return `${SHORT_MONTHS[propDate.getMonth()]} ${propDate.getDate()}, ${propDate.getFullYear()}, ${h}:${pad(propDate.getMinutes())} ${p}`;
  }, [propDate]);

  function togglePanel(next: boolean) {
    setOpen(next);
    if (next) {
      setMode("hour");
      setView(startOfMonth(working));
      setDraft(propDate ?? draft ?? defaultDate());
    } else {
      setOpenDD(null);
    }
  }

  // EOD: set the time to 3:00 am on the working date, keeping the panel open
  // so the change is visible and adjustable. Closes only via Done / outside.
  function setEod() {
    const d = new Date(working);
    d.setHours(EOD_HOUR, EOD_MIN, 0, 0);
    setView(startOfMonth(d));
    commit(d);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => { e.stopPropagation(); togglePanel(!open); }}
        className={
          "input flex items-center gap-2.5 text-left " + (open ? "!border-accent" : "")
        }
      >
        <Calendar className="w-4 h-4 text-muted flex-none" />
        <span className={"flex-1 tabular-nums " + (fieldLabel ? "text-ink" : "text-muted")}>{fieldLabel ?? placeholder}</span>
        <ChevronDown className={"w-4 h-4 text-muted transition-transform duration-300 " + (open ? "rotate-180" : "")} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pick deadline date and time"
          onClick={(e) => e.stopPropagation()}
          className="absolute z-30 mt-1.5 w-full min-w-[272px] max-w-[320px] rounded-xl border border-border bg-surface p-2.5 shadow-lift"
        >
          <div className="flex items-center justify-between mb-1">
            <button type="button" aria-label="Previous month" onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
              className="w-7 h-7 grid place-items-center rounded-full text-ink hover:bg-surface2 transition-colors">
              <ChevronDown className="w-4 h-4 rotate-90" />
            </button>
            <div className="text-[13px] font-medium text-ink">{MONTHS[view.getMonth()]} {view.getFullYear()}</div>
            <button type="button" aria-label="Next month" onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
              className="w-7 h-7 grid place-items-center rounded-full text-ink hover:bg-surface2 transition-colors">
              <ChevronDown className="w-4 h-4 -rotate-90" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {DOW.map((d) => <div key={d} className="text-center text-[10px] text-muted py-0.5">{d}</div>)}
            {calDays.map(({ d, out, today, sel }) => (
              <button
                key={d.getTime()}
                type="button"
                aria-pressed={sel}
                aria-label={d.toDateString()}
                onClick={() => pickDay(d)}
                className={
                  "h-7 rounded-full text-[13px] tabular-nums transition-colors " +
                  (sel ? "bg-accent text-white" : out ? "text-muted/60 hover:bg-surface2" : "text-ink hover:bg-surface2") +
                  (today && !sel ? " ring-1 ring-inset ring-border" : "")
                }
              >
                {d.getDate()}
              </button>
            ))}
          </div>

          <div className="h-px bg-border my-2" />

          <div className="flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-muted flex-none" />
            <Dropdown label="Hour" items={HOUR_ITEMS} current={h12} open={openDD === "hour"}
              onToggle={() => setOpenDD((s) => (s === "hour" ? null : "hour"))} onPick={pickHour} />
            <span className="text-base text-muted -mx-0.5">:</span>
            <Dropdown label="Minutes" items={MIN_ITEMS} current={minutes} open={openDD === "minute"}
              onToggle={() => setOpenDD((s) => (s === "minute" ? null : "minute"))} onPick={pickMinute} />
            <Dropdown label="AM or PM" items={MER_ITEMS} current={meridiem} wide open={openDD === "mer"}
              onToggle={() => setOpenDD((s) => (s === "mer" ? null : "mer"))} onPick={pickMeridiem} />
          </div>

          <div className="grid place-items-center py-1.5">
            <svg
              ref={dialRef}
              viewBox="0 0 210 210"
              width={132}
              height={132}
              role="slider"
              tabIndex={0}
              aria-label="Clock — drag either hand to set the time"
              aria-valuemin={mode === "hour" ? 1 : 0}
              aria-valuemax={mode === "hour" ? 12 : 59}
              aria-valuenow={mode === "hour" ? h12 : minutes}
              aria-valuetext={`${h12}:${pad(minutes)} ${meridiem}`}
              className={"touch-none select-none outline-none " + (dragging ? "cursor-grabbing" : "")}
              onPointerDown={onDialPointerDown}
              onWheel={onDialWheel}
              onKeyDown={onDialKeyDown}
            >
              <circle cx={CX} cy={CY} r={R_FACE} className="fill-surface2" />
              {Array.from({ length: 12 }, (_, i) => {
                const [x, y] = pt(((i + 1) % 12) * 30, R_NUM);
                return (
                  <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="central"
                    className="fill-ink text-[14px] tabular-nums pointer-events-none">
                    {i + 1}
                  </text>
                );
              })}
              <line x1={CX} y1={CY} x2={mx} y2={my} className={"pointer-events-none " + (mode === "minute" ? "stroke-accent" : "stroke-accent/30")} strokeWidth={1.8} />
              {mode === "minute" && dragging && <circle cx={mx} cy={my} r={R_KNOB} className="fill-accent pointer-events-none" />}
              <line x1={CX} y1={CY} x2={hx} y2={hy} className={"pointer-events-none " + (mode === "hour" ? "stroke-accent" : "stroke-accent/30")} strokeWidth={2.4} />
              {mode === "hour" && dragging && <circle cx={hx} cy={hy} r={R_KNOB} className="fill-accent pointer-events-none" />}
              <circle cx={CX} cy={CY} r={3} className="fill-accent pointer-events-none" />
              <circle cx={CX} cy={CY} r={105} className="fill-transparent cursor-grab" />
            </svg>
          </div>

          <div className="flex items-center gap-1 mt-0.5">
            <button type="button" onClick={() => { commit(null); togglePanel(false); }}
              className="rounded-full px-2.5 py-1.5 text-[13px] font-medium text-muted hover:bg-surface2 hover:text-ink transition-colors">
              Clear
            </button>
            <span className="flex-1" />
            <button type="button" onClick={setEod} title="End of day — 3:00 am"
              className="rounded-full px-2.5 py-1.5 text-[13px] font-medium text-muted hover:bg-surface2 hover:text-ink transition-colors">
              EOD
            </button>
            <button type="button" onClick={() => { const d = new Date(working); const n = new Date(); d.setFullYear(n.getFullYear(), n.getMonth(), n.getDate()); setView(startOfMonth(n)); commit(d); }}
              className="rounded-full px-2.5 py-1.5 text-[13px] font-medium text-muted hover:bg-surface2 hover:text-ink transition-colors">
              Today
            </button>
            <button type="button" onClick={() => togglePanel(false)}
              className="rounded-full px-3 py-1.5 text-[13px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
