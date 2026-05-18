"use client";

import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Smile, X, Hash, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "./Avatar";
import { useCurrentUser } from "@/lib/user-context";
import { useSlackCustomEmojis } from "@/lib/slack-emoji-cache";

// Top-of-/team row of every employee as a bubble: avatar with presence
// dot, status emoji floating top-right, name underneath. The current
// user's bubble has a clickable emoji control that opens a small picker.

interface PresenceUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
  presence: "available" | "focus" | "eating" | "away" | null;
  presenceUpdatedAt: string | null;
  statusEmoji: string | null;
}

const PRESET_EMOJIS = [
  "🔥", "⚡️", "🚀", "🎯", "💪", "🧠",
  "☕️", "🍕", "🥗", "🌮",
  "💻", "📞", "📝", "🎧", "🎨",
  "😎", "😴", "🤝", "🎉", "✨",
  "🛠", "🐛", "📊", "📈"
];

const PRESENCE_LABEL: Record<string, string> = {
  available: "Available",
  focus: "Focus",
  eating: "Eating",
  away: "Away"
};

export function TeamPresenceRow() {
  const me = useCurrentUser();
  const [users, setUsers] = useState<PresenceUser[] | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setUsers(data.users ?? []);
    } catch { /* ignore */ }
  }

  // Initial fetch + 15s poll while the page is in the foreground. Pauses
  // on hidden tabs to keep request volume sane.
  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (users === null) {
    return (
      <div className="rounded-2xl border border-slate-200/70 bg-white p-4">
        <div className="text-xs text-muted">Loading the team…</div>
      </div>
    );
  }

  // Sort: current user first, then by presence (available > focus > eating
  // > away > unset), then alphabetical. Keeps the most-engaged people up
  // top so the row reads at a glance.
  const PRESENCE_RANK: Record<string, number> = {
    available: 0, focus: 1, eating: 2, away: 3
  };
  const sorted = [...users].sort((a, b) => {
    if (a.id === me.id) return -1;
    if (b.id === me.id) return 1;
    const pa = a.presence ? PRESENCE_RANK[a.presence] ?? 4 : 4;
    const pb = b.presence ? PRESENCE_RANK[b.presence] ?? 4 : 4;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white px-3 py-4 shadow-soft">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-accent">
          Who's around
        </div>
        <div className="text-[11px] text-muted">
          {users.filter((u) => u.presence === "available").length} available · {users.length} total
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {sorted.map((u) => (
          <Bubble
            key={u.id}
            user={u}
            isMe={u.id === me.id}
            onSetEmoji={async (next) => {
              // Optimistic: snapshot the current value so we can roll back,
              // patch local state, then PATCH the server. Closes the popover
              // and updates the bubble instantly — the network round-trip
              // happens behind the user.
              const prev = u.statusEmoji;
              setUsers((cur) =>
                cur ? cur.map((x) => x.id === u.id ? { ...x, statusEmoji: next } : x) : cur
              );
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
                // Roll back the optimistic update.
                setUsers((cur) =>
                  cur ? cur.map((x) => x.id === u.id ? { ...x, statusEmoji: prev } : x) : cur
                );
                toast.error(`Couldn't set emoji: ${e instanceof Error ? e.message : "network error"}`);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Bubble({
  user, isMe, onSetEmoji
}: {
  user: PresenceUser;
  isMe: boolean;
  onSetEmoji: (next: string | null) => Promise<void>;
}) {
  const presenceLabel = user.presence ? PRESENCE_LABEL[user.presence] : "—";
  const avatarRef = useRef<HTMLDivElement>(null);

  const card = (
    <div className="flex flex-col items-center gap-1.5 px-2 py-2 rounded-2xl hover:bg-slate-50 transition-colors w-[88px] shrink-0 cursor-pointer">
      <div ref={avatarRef} className="relative">
        <Avatar
          name={user.name}
          imageUrl={user.avatarUrl ?? undefined}
          size={56}
          presence={user.presence}
          className="ring-2 ring-white shadow-sm"
        />
        {/* AnimatePresence + a key on the emoji string makes the bubble
            scale-pop in when the value lands, scale-out when cleared. */}
        <AnimatePresence>
          {user.statusEmoji && (
            <motion.span
              key={user.statusEmoji}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 600, damping: 22 }}
              className="absolute -top-1 -right-1 w-7 h-7 grid place-items-center rounded-full bg-white border border-slate-200 shadow-sm text-base leading-none"
              aria-label="Status emoji"
            >
              {user.statusEmoji}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div className="text-[12px] font-semibold text-ink truncate max-w-full text-center">
        {user.name.split(" ")[0]}
      </div>
      <div className="text-[10px] text-muted leading-none">
        {presenceLabel}
      </div>
    </div>
  );

  // Non-me bubbles link to the profile. The current user's bubble opens
  // an emoji picker instead — that's the primary interaction here.
  if (!isMe) {
    return (
      <Link href={`/team/${user.id}`} className="rounded-2xl">
        {card}
      </Link>
    );
  }
  return (
    <MeBubble user={user} onSetEmoji={onSetEmoji} avatarRef={avatarRef}>
      {card}
    </MeBubble>
  );
}

interface Flight {
  id: number;
  emoji: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

function MeBubble({
  user, onSetEmoji, avatarRef, children
}: {
  user: PresenceUser;
  onSetEmoji: (next: string | null) => Promise<void>;
  avatarRef: React.RefObject<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [mounted, setMounted] = useState(false);
  // createPortal needs document — gate it until after first client render
  // so the SSR pass doesn't crash.
  useEffect(() => { setMounted(true); }, []);

  function pick(next: string | null, sourceEl?: HTMLElement) {
    setOpen(false);

    // Kick off the flight animation if we picked a real emoji and we know
    // both source (the picker button just clicked) and destination (the
    // avatar bubble's top-right corner).
    if (next && sourceEl && avatarRef.current) {
      const src = sourceEl.getBoundingClientRect();
      const dst = avatarRef.current.getBoundingClientRect();
      // Land at the actual emoji-bubble slot: top-right of the avatar,
      // slightly inside (matching the absolute -top-1 -right-1 + w-7 h-7
      // placement of the destination span).
      const dstX = dst.right - 14 - src.width / 2;
      const dstY = dst.top - 4 - src.height / 2;
      setFlight({
        id: Date.now(),
        emoji: next,
        fromX: src.left + src.width / 2 - 14,
        fromY: src.top + src.height / 2 - 14,
        toX: dstX + src.width / 2 - 14,
        toY: dstY + src.height / 2 - 14
      });
    }

    void onSetEmoji(next);
  }

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            {children}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={6}
            align="center"
            className="z-50 w-[280px] rounded-2xl border border-slate-200/70 bg-white p-3 shadow-lift outline-none anim-fade-in-up"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-[12px] font-semibold text-ink inline-flex items-center gap-1.5">
                <Smile className="w-3.5 h-3.5 text-accent" />
                Set status emoji
              </div>
              {user.statusEmoji && (
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-urgent transition-colors"
                >
                  <X className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>
            <div className="grid grid-cols-8 gap-1">
              {PRESET_EMOJIS.map((e) => {
                const active = user.statusEmoji === e;
                return (
                  <button
                    key={e}
                    type="button"
                    onClick={(ev) => pick(e, ev.currentTarget)}
                    className={
                      "w-8 h-8 grid place-items-center rounded-lg text-lg transition-all " +
                      (active
                        ? "bg-accent/10 ring-1 ring-accent/40"
                        : "hover:bg-slate-100")
                    }
                  >
                    {e}
                  </button>
                );
              })}
            </div>
            <SlackCustomEmojiPalette
              activeValue={user.statusEmoji}
              onPick={(shortcode, ev) => pick(shortcode, ev.currentTarget)}
            />
            <Popover.Arrow className="fill-white" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {/* Flying emoji overlay. Renders to <body> so it can fly across the
          popover/avatar boundary without being clipped. */}
      {mounted && flight && createPortal(
        <motion.div
          key={flight.id}
          initial={{ x: flight.fromX, y: flight.fromY, scale: 1, opacity: 1 }}
          animate={{
            x: [flight.fromX, (flight.fromX + flight.toX) / 2, flight.toX],
            // Arc upward at the midpoint for a tossed-throw feel.
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
    </>
  );
}

// Renders the workspace's custom Slack emojis as a clickable palette
// below the preset unicode grid. Hidden entirely when the workspace
// has no custom emojis (or the Slack token doesn't have emojis:read)
// so the picker doesn't show an empty section. Clicking a tile sets
// the user's status_emoji to ":name:" — DD's avatar overlay resolves
// that back to the image URL on render, and the syncToSlack call
// hands the same shortcode to Slack, which already knows the image.
function SlackCustomEmojiPalette({
  activeValue, onPick
}: {
  activeValue: string | null;
  onPick: (shortcode: string, ev: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const { map, refresh, refreshing } = useSlackCustomEmojis();
  const entries = Object.entries(map);
  // Sort alphabetically + cap rendered count at 64 to keep the
  // popover sane for workspaces with hundreds of emojis. A search
  // box would be the next step if anyone asks.
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const visible = entries.slice(0, 64);

  // We render the section even when empty so users have a refresh
  // button to hit after uploading a new emoji to Slack — otherwise
  // the section disappears entirely and there's no way to trigger
  // a refresh from the UI.
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
          <RefreshCw className={"w-3 h-3 " + (refreshing ? "animate-spin" : "")} />
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
                className={
                  "w-8 h-8 grid place-items-center rounded-lg overflow-hidden transition-all " +
                  (active ? "bg-accent/10 ring-1 ring-accent/40" : "hover:bg-slate-100")
                }
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
