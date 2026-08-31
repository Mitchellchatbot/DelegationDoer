"use client";

import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Crown, Smile, X, Plus, Sparkles, Hash, RefreshCw } from "lucide-react";
import { useSlackCustomEmojis } from "@/lib/slack-emoji-cache";
import { toast } from "sonner";
import { ROLE_LABELS } from "@/lib/auth";
import { initials, cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/user-context";
import { usePresence } from "@/lib/presence-context";
import { ProfileDialog } from "./ProfileDialog";
import { SendKudosDialog } from "./SendKudosDialog";
import type { User, Department } from "@/lib/types";

type Presence = "available" | "focus" | "eating" | "away" | null;

interface LivePresence {
  presence: Presence;
  emoji: string | null;
}

const PRESET_EMOJIS = [
  "🔥", "⚡️", "🚀", "🎯", "💪", "🧠",
  "☕️", "🍕", "🥗", "🌮",
  "💻", "📞", "📝", "🎧", "🎨",
  "😎", "😴", "🤝", "🎉", "✨",
  "🛠", "🐛", "📊", "📈"
];

const PRESENCE_DOT: Record<NonNullable<Presence>, string> = {
  available: "bg-emerald-500",
  focus:     "bg-violet-500",
  eating:    "bg-amber-500",
  away:      "bg-slate-400"
};

const PRESENCE_LABEL: Record<NonNullable<Presence>, string> = {
  available: "Available",
  focus:     "In focus",
  eating:    "Eating",
  away:      "Away"
};

// 3D coverflow carousel for /team. Center card is full color and forward;
// the two side cards on each flank tilt back into space, desaturate, and
// fade. Click any side card to bring it forward. Arrow buttons, dot rail,
// keyboard ←/→, and touch-swipe all supported.
//
// CSS-only transforms for the card movement (cheaper than framer-motion
// for this many simultaneous transitions). The cubic-bezier easing
// matches Apple's classic Cover Flow timing.

interface Props {
  users: User[];
  departments?: Department[];
}

const ROLE_TONE: Record<User["role"], string> = {
  leader: "from-amber-100 to-amber-50 text-amber-700",
  department_head: "from-indigo-100 to-indigo-50 text-indigo-700",
  worker: "from-blue-100 to-blue-50 text-blue-700"
};

export function TeamCarousel({ users, departments }: Props) {
  const me = useCurrentUser();

  // Filter state. "all" shows everyone; otherwise it's a department id.
  // The segmented control at the top toggles between these.
  const [filter, setFilter] = useState<string>("all");

  // When the carousel is narrowed to one department, label people by their role
  // IN THAT DEPARTMENT. users.role is global -- whoever leads Website carries
  // role='department_head' inside every department they belong to -- so without
  // this the carousel captions three people "Department Head" under a Facebook
  // filter while the roster directly below it calls them Members, on the same
  // screen. Unfiltered this is a whole-org view, so the global role is right.
  const activeDept =
    filter === "all" ? null : (departments ?? []).find((d) => d.id === filter) ?? null;
  const roleLabelFor = (u: User) =>
    activeDept ? (activeDept.headUserId === u.id ? "Department Head" : "Member") : ROLE_LABELS[u.role];

  // Live presence + emoji per user, fetched + polled. We keep this
  // separate from the static `users` prop (which only carries layout data
  // like role, dept, avatar) so optimistic updates can land here without
  // the caller having to round-trip new props.
  const [live, setLive] = useState<Map<string, LivePresence>>(new Map());
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  async function loadLive() {
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const next = new Map<string, LivePresence>();
      for (const u of (data.users ?? []) as { id: string; presence: Presence; statusEmoji: string | null }[]) {
        next.set(u.id, { presence: u.presence, emoji: u.statusEmoji });
      }
      setLive(next);
    } catch { /* ignore */ }
  }
  useEffect(() => {
    loadLive();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") loadLive();
    }, 15_000);
    const onVis = () => { if (document.visibilityState === "visible") loadLive(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Refs to each card's emoji-slot so the flying-emoji animation can
  // target the right destination (especially as cards move around in the
  // carousel).
  const emojiRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Optimistic emoji update for the current user. Snapshots the previous
  // value so a network failure can roll back cleanly.
  async function setMyEmoji(next: string | null) {
    const prev = live.get(me.id)?.emoji ?? null;
    setLive((cur) => {
      const m = new Map(cur);
      m.set(me.id, { ...(m.get(me.id) ?? { presence: null, emoji: null }), emoji: next });
      return m;
    });
    try {
      const res = await fetch("/api/users/me/emoji", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji: next })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
    } catch (e) {
      setLive((cur) => {
        const m = new Map(cur);
        m.set(me.id, { ...(m.get(me.id) ?? { presence: null, emoji: null }), emoji: prev });
        return m;
      });
      toast.error(`Couldn't set emoji: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  // Flying-emoji animation overlay state. id changes per pick so the
  // motion.div remounts and replays.
  interface Flight { id: number; emoji: string; fromX: number; fromY: number; toX: number; toY: number; }
  const [flight, setFlight] = useState<Flight | null>(null);

  function pickEmoji(emoji: string | null, sourceEl?: HTMLElement) {
    if (emoji && sourceEl) {
      const dst = emojiRefs.current.get(me.id);
      if (dst) {
        const src = sourceEl.getBoundingClientRect();
        const dstRect = dst.getBoundingClientRect();
        setFlight({
          id: Date.now(),
          emoji,
          fromX: src.left + src.width / 2 - 14,
          fromY: src.top + src.height / 2 - 14,
          toX: dstRect.left + dstRect.width / 2 - 14,
          toY: dstRect.top + dstRect.height / 2 - 14
        });
      }
    }
    void setMyEmoji(emoji);
  }

  const ordered = useMemo(() => {
    const ROLE_RANK: Record<User["role"], number> = { leader: 0, department_head: 1, worker: 2 };
    let list = [...users];
    if (filter !== "all") {
      list = list.filter((u) => u.departmentIds.includes(filter));
    }
    list.sort((a, b) => {
      const r = ROLE_RANK[a.role] - ROLE_RANK[b.role];
      return r !== 0 ? r : a.name.localeCompare(b.name);
    });
    return list;
  }, [users, filter]);
  const n = ordered.length;

  const [index, setIndex] = useState(0);
  const touchStart = useRef<number | null>(null);

  // When the filter shrinks the list past the current index (or the
  // selected user disappears), snap back to the first card.
  useEffect(() => {
    if (index >= n) setIndex(0);
  }, [n, index]);

  function go(next: number) {
    if (n === 0) return;
    setIndex(((next % n) + n) % n);
  }

  // Global keyboard nav. Doesn't fight inputs since arrow keys aren't
  // handled here when an editable element is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") go(index - 1);
      if (e.key === "ArrowRight") go(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, n]);

  // Build the segmented control's options. Always leads with "Everyone";
  // the rest are departments in their canonical order.
  const segments: { id: string; label: string }[] = [
    { id: "all", label: "Everyone" },
    ...(departments ?? []).map((d) => ({ id: d.id, label: d.name }))
  ];

  const current: User | null = n > 0 ? ordered[Math.min(index, n - 1)] : null;

  // Department names this user is in — used as a subtitle under their
  // name. Falls back to the role label when no departments resolved.
  const deptNames = current && departments
    ? current.departmentIds
        .map((id) => departments.find((d) => d.id === id)?.name)
        .filter(Boolean)
        .join(" · ")
    : "";

  // Signed shortest-path delta around the ring. Lets the layout stay
  // symmetric for tiny filtered sets (n=2, 3) where the modulo version
  // would push every non-center card to the right.
  function offsetClass(i: number) {
    if (n === 1) return i === index ? "center" : "hidden";
    let delta = i - index;
    if (delta > n / 2) delta -= n;
    else if (delta < -n / 2) delta += n;
    if (delta === 0) return "center";
    if (delta === 1) return "right-1";
    if (delta === 2) return "right-2";
    if (delta === -1) return "left-1";
    if (delta === -2) return "left-2";
    return "hidden";
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStart.current = e.changedTouches[0].screenX;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStart.current == null) return;
    const diff = touchStart.current - e.changedTouches[0].screenX;
    touchStart.current = null;
    if (Math.abs(diff) > 50) go(diff > 0 ? index + 1 : index - 1);
  }

  return (
    <section
      className="relative overflow-hidden rounded-3xl border border-slate-200/70 bg-white pt-7 pb-12 px-6 -mx-2 shadow-soft"
      aria-roledescription="carousel"
      aria-label="Team members"
    >
      {/* iOS-style liquid-glass segmented control. Frosted backdrop, soft
          inner highlight + outer shadow give it the floating-pill feel.
          The active "blob" slides between segments via a shared layoutId. */}
      <div className="relative z-20 flex justify-center">
        <div
          className="inline-flex items-center gap-0.5 p-1 rounded-full border border-white/70 bg-white/45 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.7),0_8px_24px_-12px_rgba(15,23,42,0.18),0_2px_6px_-2px_rgba(15,23,42,0.06)]"
          role="tablist"
        >
          {segments.map((s) => {
            const active = filter === s.id;
            return (
              <button
                key={s.id}
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setFilter(s.id);
                  setIndex(0);
                }}
                className={cn(
                  "relative px-4 py-1.5 rounded-full text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 z-10",
                  active ? "text-white" : "text-ink/65 hover:text-ink"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="team-filter-blob"
                    transition={{ type: "spring", stiffness: 480, damping: 36 }}
                    className="absolute inset-0 -z-10 rounded-full bg-accent shadow-[0_4px_14px_-4px_rgba(6,50,112,0.55),inset_0_1px_0_0_rgba(255,255,255,0.35)] ring-1 ring-accent/40"
                  />
                )}
                <span className="relative">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Big translucent watermark behind everything. Gradient-clipped to
          fade into nothing so it doesn't fight the cards. */}
      <div
        aria-hidden
        className="absolute top-20 left-1/2 -translate-x-1/2 select-none pointer-events-none whitespace-nowrap font-black uppercase tracking-tighter z-0"
        style={{
          fontSize: "clamp(72px, 14vw, 220px)",
          lineHeight: 0.9,
          fontFamily: '"Arial Black", "Arial Bold", Arial, sans-serif',
          background:
            "linear-gradient(to bottom, rgba(6,50,112,0.16) 25%, rgba(255,255,255,0) 78%)",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent"
        }}
      >
        OUR TEAM
      </div>

      {/* Empty filtered set — no one in this department. */}
      {n === 0 && (
        <div className="relative z-10 mt-12 mx-auto max-w-md text-center text-sm text-muted">
          Nobody's in {segments.find((s) => s.id === filter)?.label ?? "this department"} yet.
        </div>
      )}

      {/* Carousel stage */}
      <div
        className={cn(
          "relative h-[480px] flex items-center justify-center",
          n === 0 && "hidden"
        )}
        style={{ perspective: 1200 }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {/* Arrows */}
        <button
          type="button"
          aria-label="Previous"
          onClick={() => go(index - 1)}
          className="absolute left-4 md:left-8 top-1/2 -translate-y-1/2 z-30 w-11 h-11 rounded-full bg-accent/85 hover:bg-accent text-white grid place-items-center shadow-lift transition-all hover:scale-110"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button
          type="button"
          aria-label="Next"
          onClick={() => go(index + 1)}
          className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 z-30 w-11 h-11 rounded-full bg-accent/85 hover:bg-accent text-white grid place-items-center shadow-lift transition-all hover:scale-110"
        >
          <ChevronRight className="w-5 h-5" />
        </button>

        {/* 3D track */}
        <div
          className="relative w-full h-full"
          style={{ transformStyle: "preserve-3d" }}
        >
          {ordered.map((u, i) => {
            const cls = offsetClass(i);
            const style = STYLE_FOR[cls];
            const presence = live.get(u.id)?.presence ?? null;
            const emoji = live.get(u.id)?.emoji ?? null;
            const isMe = u.id === me.id;
            return (
              <div
                key={u.id}
                role="button"
                tabIndex={cls === "hidden" ? -1 : 0}
                onClick={() => go(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(i); }
                }}
                aria-label={`Show ${u.name}`}
                aria-current={cls === "center" ? "true" : undefined}
                className={cn(
                  "absolute left-1/2 top-1/2 w-[280px] h-[400px] -ml-[140px] -mt-[200px] rounded-3xl overflow-hidden cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  cls === "hidden" && "pointer-events-none"
                )}
                style={{
                  ...style,
                  transition:
                    "transform 0.7s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.7s cubic-bezier(0.25,0.46,0.45,0.94), filter 0.7s ease",
                  boxShadow: cls === "center"
                    ? "0 30px 60px -20px rgba(15,23,42,0.30), 0 18px 36px -18px rgba(6,50,112,0.25)"
                    : "0 20px 40px -16px rgba(15,23,42,0.18)"
                }}
              >
                <CardFace user={u} isCenter={cls === "center"} roleLabel={roleLabelFor(u)} />

                {/* Presence pill — top-left. Lives outside the grayscale-able
                    card content so the dot stays vivid even on side cards. */}
                {presence && (
                  <div className="absolute top-3 left-3 z-10 inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/90 backdrop-blur-sm border border-white shadow-sm">
                    <span className={cn("w-2 h-2 rounded-full", PRESENCE_DOT[presence])} />
                    <span className="text-[10px] font-semibold text-ink/75">
                      {PRESENCE_LABEL[presence]}
                    </span>
                  </div>
                )}

                {/* Emoji bubble — top-right. The current user's bubble
                    doubles as a picker trigger. */}
                <div
                  ref={(el) => {
                    if (el) emojiRefs.current.set(u.id, el);
                    else emojiRefs.current.delete(u.id);
                  }}
                  className="absolute top-3 right-3 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  {isMe ? (
                    <EmojiPickerTrigger
                      currentEmoji={emoji}
                      onPick={pickEmoji}
                      onClear={() => pickEmoji(null)}
                    />
                  ) : emoji ? (
                    <AnimatePresence>
                      <motion.span
                        key={emoji}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 600, damping: 22 }}
                        className="w-9 h-9 grid place-items-center rounded-full bg-white border border-slate-200 shadow-sm text-lg leading-none"
                      >
                        {emoji}
                      </motion.span>
                    </AnimatePresence>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Member info — fade-swap on index change via key */}
      {current && (
        <div className="relative z-10 text-center mt-6">
          <div key={current.id} className="anim-fade-in-up">
            <h3 className="inline-block relative text-3xl md:text-4xl font-bold text-accent tracking-tight">
              <span className="absolute top-1/2 -translate-y-1/2 -left-32 w-24 h-0.5 bg-accent/70" aria-hidden />
              {current.name}
              {current.role === "leader" && (
                <Crown className="inline-block w-5 h-5 ml-2 mb-1 text-amber-500" />
              )}
              <span className="absolute top-1/2 -translate-y-1/2 -right-32 w-24 h-0.5 bg-accent/70" aria-hidden />
            </h3>
            <p className="mt-2 text-sm md:text-base text-muted uppercase tracking-[0.2em] font-medium">
              {roleLabelFor(current)}{deptNames ? ` · ${deptNames}` : ""}
            </p>
            <div className="mt-4 inline-flex items-center gap-3">
              <ProfileDialog
                userId={current.id}
                trigger={
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline font-medium"
                  >
                    View profile →
                  </button>
                }
              />
              <SendKudosDialog
                recipientId={current.id}
                recipientName={current.name}
                recipientAvatarUrl={current.avatarUrl}
                trigger={
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-medium bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-sm hover:shadow-lift hover:-translate-y-0.5 transition-all"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {current.id === me.id ? "Send yourself a kudos" : "Send kudos"}
                  </button>
                }
              />
            </div>
          </div>
        </div>
      )}

      {/* Dot rail */}
      {n > 1 && (
        <div className="relative z-10 flex justify-center gap-2 mt-6">
          {ordered.map((u, i) => (
            <button
              key={u.id}
              type="button"
              aria-label={`Go to ${u.name}`}
              onClick={() => go(i)}
              className={cn(
                "rounded-full transition-all",
                i === index
                  ? "w-6 h-2.5 bg-accent"
                  : "w-2.5 h-2.5 bg-accent/25 hover:bg-accent/50"
              )}
            />
          ))}
        </div>
      )}

      {/* Flying-emoji animation. Portal'd to <body> so it can fly across
          popover/card boundaries without being clipped. */}
      {mounted && flight && createPortal(
        <motion.div
          key={flight.id}
          initial={{ x: flight.fromX, y: flight.fromY, scale: 1, opacity: 1 }}
          animate={{
            x: [flight.fromX, (flight.fromX + flight.toX) / 2, flight.toX],
            y: [
              flight.fromY,
              Math.min(flight.fromY, flight.toY) - 30,
              flight.toY
            ],
            scale: [1, 1.6, 1, 0.6],
            opacity: [1, 1, 1, 0]
          }}
          transition={{
            duration: 0.55,
            times: [0, 0.45, 0.85, 1],
            ease: [0.2, 0.6, 0.4, 1]
          }}
          onAnimationComplete={() => setFlight(null)}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: 28,
            height: 28,
            display: "grid",
            placeItems: "center",
            fontSize: 22,
            lineHeight: 1,
            pointerEvents: "none",
            zIndex: 9999,
            filter: "drop-shadow(0 6px 12px rgba(15,23,42,0.25))"
          }}
        >
          {flight.emoji}
        </motion.div>,
        document.body
      )}
    </section>
  );
}

/* ====================== EMOJI PICKER TRIGGER ====================== */

function EmojiPickerTrigger({
  currentEmoji, onPick, onClear
}: {
  currentEmoji: string | null;
  onPick: (emoji: string, sourceEl: HTMLElement) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="relative w-9 h-9 grid place-items-center rounded-full bg-white border border-slate-200 shadow-sm hover:border-accent/40 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={currentEmoji ? "Change status emoji" : "Set status emoji"}
        >
          {currentEmoji ? (
            <AnimatePresence mode="popLayout">
              <motion.span
                key={currentEmoji}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 600, damping: 22 }}
                className="text-lg leading-none"
              >
                {currentEmoji}
              </motion.span>
            </AnimatePresence>
          ) : (
            <Plus className="w-4 h-4 text-accent" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="end"
          className="z-50 w-[280px] rounded-2xl border border-slate-200/70 bg-white p-3 shadow-lift outline-none anim-fade-in-up"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
              <Smile className="w-3.5 h-3.5 text-accent" />
              Set status emoji
            </div>
            {currentEmoji && (
              <button
                type="button"
                onClick={() => { setOpen(false); onClear(); }}
                className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-urgent transition-colors"
              >
                <X className="w-3 h-3" />
                Clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-8 gap-1">
            {PRESET_EMOJIS.map((e) => {
              const active = currentEmoji === e;
              return (
                <button
                  key={e}
                  type="button"
                  onClick={(ev) => {
                    setOpen(false);
                    onPick(e, ev.currentTarget);
                  }}
                  className={cn(
                    "w-8 h-8 grid place-items-center rounded-lg text-lg transition-all",
                    active
                      ? "bg-accent/10 ring-1 ring-accent/40"
                      : "hover:bg-slate-100"
                  )}
                >
                  {e}
                </button>
              );
            })}
          </div>
          <SlackCustomEmojiPalette
            activeValue={currentEmoji}
            onPick={(shortcode, ev) => {
              setOpen(false);
              onPick(shortcode, ev.currentTarget);
            }}
          />
          <Popover.Arrow className="fill-white" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Twin of the palette in TeamPresenceRow — kept inline here rather than
// extracted because the two pickers have slightly different click /
// dismiss semantics (this one needs setOpen(false) before the flying-
// emoji animation can read source rect from currentTarget).
function SlackCustomEmojiPalette({
  activeValue, onPick
}: {
  activeValue: string | null;
  onPick: (shortcode: string, ev: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { map, refresh, refreshing } = useSlackCustomEmojis();
  const entries = Object.entries(map);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const visible = entries.slice(0, 64);

  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] font-semibold text-ink/70 inline-flex items-center gap-1.5">
          <Hash className="w-3 h-3 text-accent" />
          Slack custom emojis
          <span className="text-[10px] text-muted font-normal">
            {entries.length === 0
              ? "none yet"
              : entries.length > visible.length
                ? `${visible.length} of ${entries.length}`
                : `${entries.length}`}
          </span>
        </div>
        <button
          type="button"
          onClick={() => { void refresh(); }}
          disabled={refreshing}
          title="Pull the latest emoji list from Slack (use after uploading a new one)"
          className="inline-flex items-center gap-1 text-[10px] text-ink/55 hover:text-accent disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
          {refreshing ? "Syncing" : "Refresh"}
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="text-[11px] text-muted italic px-1">
          Upload a custom emoji in Slack, then hit Refresh.
        </div>
      ) : (
        <div className="grid grid-cols-8 gap-1 max-h-[180px] overflow-y-auto">
          {visible.map(([name, url]) => {
            const value = `:${name}:`;
            const active = activeValue === value;
            return (
              <button
                key={name}
                type="button"
                title={value}
                onClick={(ev) => onPick(value, ev)}
                className={cn(
                  "w-8 h-8 grid place-items-center rounded-lg overflow-hidden transition-all",
                  active ? "bg-accent/10 ring-1 ring-accent/40" : "hover:bg-slate-100"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={name} className="w-5 h-5 object-cover" draggable={false} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================ CARD FACE ============================ */

function CardFace({ user, isCenter, roleLabel }: { user: User; isCenter: boolean; roleLabel: string }) {
  // The mock-data User passed in here may not have the latest
  // avatarUrl — settings uploads land in the DB, which the
  // PresenceProvider hydrates. Fall through to the live cache when the
  // prop is empty so newly-uploaded avatars surface here.
  const live = usePresence(user.id);
  const avatarUrl = user.avatarUrl ?? live?.avatarUrl ?? null;

  if (avatarUrl) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl}
          alt={user.name}
          draggable={false}
          className={cn(
            "w-full h-full object-cover transition-[filter] duration-700",
            !isCenter && "grayscale"
          )}
        />
        <div
          className="absolute inset-x-0 bottom-0 px-4 py-3 text-white"
          style={{
            background:
              "linear-gradient(to top, rgba(15,23,42,0.85), rgba(15,23,42,0.0))"
          }}
        >
          <div className="text-[15px] font-semibold leading-tight truncate">
            {user.name}
          </div>
          <div className="text-[11px] uppercase tracking-wide opacity-80 truncate">
            {roleLabel}
          </div>
        </div>
      </>
    );
  }

  // Initials placeholder
  const tone = ROLE_TONE[user.role];
  return (
    <div className={cn(
      "w-full h-full flex flex-col items-center justify-center bg-gradient-to-br p-6 transition-[filter] duration-700",
      tone,
      !isCenter && "grayscale"
    )}>
      <div className="w-32 h-32 rounded-full bg-white/80 ring-4 ring-white shadow-lg grid place-items-center mb-6">
        <span className="text-5xl font-bold tracking-tight text-ink/85">
          {initials(user.name)}
        </span>
      </div>
      <div className="text-xl font-bold text-ink/90 text-center leading-tight">
        {user.name}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-ink/55 mt-2">
        {roleLabel}
      </div>
    </div>
  );
}

/* ============================ STYLE LUT ============================ */

const STYLE_FOR: Record<string, React.CSSProperties> = {
  center: {
    transform: "scale(1.08) translateZ(0)",
    zIndex: 10,
    opacity: 1,
    filter: "none"
  },
  "right-1": {
    transform: "translateX(220px) scale(0.9) translateZ(-100px)",
    zIndex: 5,
    opacity: 0.92
  },
  "right-2": {
    transform: "translateX(420px) scale(0.78) translateZ(-300px)",
    zIndex: 1,
    opacity: 0.55
  },
  "left-1": {
    transform: "translateX(-220px) scale(0.9) translateZ(-100px)",
    zIndex: 5,
    opacity: 0.92
  },
  "left-2": {
    transform: "translateX(-420px) scale(0.78) translateZ(-300px)",
    zIndex: 1,
    opacity: 0.55
  },
  hidden: {
    opacity: 0,
    transform: "scale(0.7) translateZ(-500px)",
    zIndex: 0
  }
};
