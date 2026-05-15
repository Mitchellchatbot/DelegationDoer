"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock, Loader2, Save, Globe } from "lucide-react";
import { toast } from "sonner";
import { detectTimezone, tzShortLabel } from "@/lib/work-hours";

// Per-day work schedule editor. Two modes:
//   - Same every weekday: one start/end + Mon–Fri toggle + weekend off.
//     Lives in the flat work_hours_start / work_hours_end columns.
//   - Custom by day: 7 rows, each with start/end + "off" toggle. Lives
//     in the weekly_schedule jsonb. When custom is active, the flat
//     columns mirror the first non-off day so existing readers keep
//     functioning.

type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const DAYS: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABEL: Record<Day, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun"
};

interface DayBlock { start: string; end: string }
type WeeklySchedule = Partial<Record<Day, DayBlock | null>>;

const COMMON_TIMEZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
  "America/Denver", "America/Chicago", "America/New_York",
  "America/Toronto", "America/Mexico_City", "America/Sao_Paulo",
  "Atlantic/Reykjavik", "Europe/London", "Europe/Lisbon", "Europe/Madrid",
  "Europe/Paris", "Europe/Berlin", "Europe/Amsterdam", "Europe/Stockholm",
  "Europe/Athens", "Africa/Cairo", "Africa/Johannesburg",
  "Europe/Istanbul", "Europe/Moscow", "Asia/Dubai", "Asia/Tehran",
  "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok",
  "Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo",
  "Asia/Seoul", "Australia/Perth", "Australia/Sydney",
  "Pacific/Auckland"
];

export function WorkScheduleSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Same-every-day fields.
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [tz, setTz] = useState<string>(() => detectTimezone());

  // Custom schedule + the mode flag.
  const [custom, setCustom] = useState(false);
  const [schedule, setSchedule] = useState<Record<Day, DayBlock | null>>({
    mon: { start: "09:00", end: "17:00" },
    tue: { start: "09:00", end: "17:00" },
    wed: { start: "09:00", end: "17:00" },
    thu: { start: "09:00", end: "17:00" },
    fri: { start: "09:00", end: "17:00" },
    sat: null,
    sun: null
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/users/me", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const u = data.user as {
        workHoursStart: string | null;
        workHoursEnd: string | null;
        workTimezone: string | null;
        weeklySchedule: WeeklySchedule | null;
      };
      if (u.workHoursStart) setStart(u.workHoursStart);
      if (u.workHoursEnd) setEnd(u.workHoursEnd);
      if (u.workTimezone) setTz(u.workTimezone);
      const ws = u.weeklySchedule ?? {};
      // Has the user explicitly set a non-empty per-day schedule?
      const hasCustom = Object.keys(ws).length > 0;
      if (hasCustom) {
        setCustom(true);
        const next: Record<Day, DayBlock | null> = {
          mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null
        };
        for (const d of DAYS) {
          const v = ws[d];
          if (v && typeof v === "object") {
            next[d] = { start: v.start ?? "09:00", end: v.end ?? "17:00" };
          } else {
            next[d] = null;
          }
        }
        setSchedule(next);
      } else {
        // No per-day record — pre-fill the editor with Mon-Fri from the
        // flat fields so toggling Custom doesn't reset to defaults.
        const fallbackStart = u.workHoursStart ?? "09:00";
        const fallbackEnd = u.workHoursEnd ?? "17:00";
        setSchedule({
          mon: { start: fallbackStart, end: fallbackEnd },
          tue: { start: fallbackStart, end: fallbackEnd },
          wed: { start: fallbackStart, end: fallbackEnd },
          thu: { start: fallbackStart, end: fallbackEnd },
          fri: { start: fallbackStart, end: fallbackEnd },
          sat: null,
          sun: null
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't load schedule");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Make sure the auto-detected tz is selectable even if it isn't in the
  // common list (some obscure cities).
  const tzOptions = useMemo(() => (
    COMMON_TIMEZONES.includes(tz) ? COMMON_TIMEZONES : [tz, ...COMMON_TIMEZONES]
  ), [tz]);

  function setDayBlock(day: Day, patch: Partial<DayBlock>) {
    setSchedule((cur) => {
      const existing = cur[day] ?? { start: "09:00", end: "17:00" };
      return { ...cur, [day]: { ...existing, ...patch } };
    });
  }
  function toggleDayOff(day: Day, off: boolean) {
    setSchedule((cur) => ({
      ...cur,
      [day]: off ? null : (cur[day] ?? { start: "09:00", end: "17:00" })
    }));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      // Construct the PATCH body. When in "same every weekday" mode we
      // clear weekly_schedule (server stores {}) so future loads use the
      // flat fields. When custom, send the schedule + also mirror a flat
      // start/end into the legacy columns so anything that hasn't been
      // ported to weekly_schedule yet still has a sensible default.
      const body: Record<string, unknown> = { workTimezone: tz };
      if (!custom) {
        body.workHoursStart = start;
        body.workHoursEnd = end;
        body.weeklySchedule = null;
      } else {
        body.weeklySchedule = schedule;
        // Pick the first non-off day as the legacy mirror.
        const first = DAYS.map((d) => schedule[d]).find((v) => v !== null) ?? null;
        if (first) {
          body.workHoursStart = first.start;
          body.workHoursEnd = first.end;
        }
      }
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `status ${res.status}`);
      }
      toast.success("Schedule saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "couldn't save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
        <div className="text-sm text-muted inline-flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading schedule…
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <header className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-violet-500 text-white grid place-items-center shadow-sm">
            <Clock className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">Work schedule</div>
            <div className="text-xs text-muted mt-0.5">
              When you&apos;re generally around. Teammates in other timezones see
              this converted to their own clock.
            </div>
          </div>
        </div>
      </header>

      {/* Mode toggle */}
      <div className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 p-0.5 mb-4 text-xs">
        <ModeBtn active={!custom} onClick={() => setCustom(false)} label="Same every weekday" />
        <ModeBtn active={custom} onClick={() => setCustom(true)} label="Different per day" />
      </div>

      {!custom ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1">
                Start
              </label>
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1">
                End
              </label>
              <input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
              />
            </div>
          </div>
          <p className="text-[11px] text-ink/55">
            Used Monday through Friday. Weekends count as off. Need short days
            or a Saturday shift? Switch to <b>Different per day</b> above.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {DAYS.map((d) => {
            const block = schedule[d];
            const off = block === null;
            return (
              <div
                key={d}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60"
              >
                <div className="w-10 text-[11px] uppercase tracking-wide text-ink/65 font-semibold">
                  {DAY_LABEL[d]}
                </div>
                <label className="inline-flex items-center gap-1 text-[11px] text-ink/55 mr-2">
                  <input
                    type="checkbox"
                    checked={off}
                    onChange={(e) => toggleDayOff(d, e.target.checked)}
                    className="accent-accent"
                  />
                  off
                </label>
                <input
                  type="time"
                  value={block?.start ?? "09:00"}
                  onChange={(e) => setDayBlock(d, { start: e.target.value })}
                  disabled={off}
                  className="flex-1 px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30 disabled:opacity-40"
                />
                <span className="text-ink/35">–</span>
                <input
                  type="time"
                  value={block?.end ?? "17:00"}
                  onChange={(e) => setDayBlock(d, { end: e.target.value })}
                  disabled={off}
                  className="flex-1 px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30 disabled:opacity-40"
                />
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
        <div>
          <label className="block text-[10px] uppercase tracking-wide text-ink/55 font-semibold mb-1 inline-flex items-center gap-1">
            <Globe className="w-3 h-3" /> Timezone
          </label>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30"
          >
            {tzOptions.map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, " ")}</option>
            ))}
          </select>
          <div className="text-[10px] text-ink/45 mt-1">
            Showing as {tzShortLabel(tz)}
          </div>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95 disabled:opacity-60"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </div>
    </section>
  );
}

function ModeBtn({
  active, onClick, label
}: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-1 rounded-full transition-colors " +
        (active
          ? "bg-white shadow-sm text-ink font-semibold"
          : "text-ink/55 hover:text-ink")
      }
    >
      {label}
    </button>
  );
}
