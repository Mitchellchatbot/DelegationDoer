"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Inbox, MessageSquare, ExternalLink, BellOff } from "lucide-react";
import { cn, initials as nameInitials } from "@/lib/utils";
import { useInboxSplit } from "@/components/InboxSplit";
import { prefetchThread, prefetchThreadChain } from "@/lib/thread-cache";
import type { MissiveThread } from "@/lib/missive-client";
import { InboxFavicon } from "./InboxFavicon";
import { DeleteThreadControl, type DeleteInboxOption } from "./DeleteThreadControl";
import { MuteSenderControl } from "./MuteSenderControl";
import { describeRule, type MuteMatchType } from "@/lib/inbox-mute-shared";

// Email-row visualization for an inbox thread. Lays out like Gmail /
// Front / Mail.app:
//   ● [avatar]  Sender Name        Subject — preview              12:34
//                                  3 participants · 5 messages    [open]
//
// Unread rows: bold sender + subject, accent-blue dot on the left, soft
// blue wash background. Read rows: lighter weight, no dot, plain white.

export interface ThreadRowProps {
  thread: MissiveThread;
  href: string;
  unread: boolean;
  index: number;
  // Inbox + thread ids used to open the reading pane via ?thread=&acct=.
  accountId: string;
  threadId: string;
  // Optional "Open in Missive" deep-link rendered as a sibling chip.
  missiveUrl?: string;
  // Inboxes this thread can be deleted from, within the current view's scope.
  // One option → the hover trash button deletes straight away; several → it
  // opens the per-inbox checkbox popover. Omitted/empty hides the control.
  deleteOptions?: DeleteInboxOption[];
  onDelete?: (accountIds: string[]) => void | Promise<void>;
  // Mute wiring. When supplied, the row gets a "mute this sender" action
  // alongside delete — the fast path for the plugin/vendor noise that would
  // otherwise keep filling the list and pinging.
  onMute?: (
    rule: { id: string | null; matchType: MuteMatchType; value: string }
  ) => void | Promise<void>;
  // In the Muted view, the rule that caught this thread.
  mutedBy?: { id: string; matchType: MuteMatchType; value: string };
}

// Tone palette indexed by hash of the address, so a given sender always
// gets the same avatar color across the inbox.
const AVATAR_TONES = [
  "from-blue-200 to-blue-100 text-blue-700",
  "from-indigo-200 to-indigo-100 text-indigo-700",
  "from-violet-200 to-violet-100 text-violet-700",
  "from-fuchsia-200 to-fuchsia-100 text-fuchsia-700",
  "from-pink-200 to-pink-100 text-pink-700",
  "from-amber-200 to-amber-100 text-amber-700",
  "from-emerald-200 to-emerald-100 text-emerald-700",
  "from-teal-200 to-teal-100 text-teal-700"
];

function hashStringToIndex(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

function shortAddress(addr: string | undefined | null): string {
  if (!addr) return "(unknown)";
  const m = addr.match(/^"?([^<"]+?)"?\s*<([^>]+)>$/);
  if (m) return m[1].trim();
  const at = addr.indexOf("@");
  return at > 0 ? addr.slice(0, at) : addr;
}

// Pull the bare email out of a participant string — handles both
// `"Name" <addr@host>` and a plain `addr@host`. Used to derive the
// sender's domain favicon. Returns null when there's no address.
function addressEmail(addr: string | undefined | null): string | null {
  if (!addr) return null;
  const angle = addr.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : addr).trim();
  return raw.includes("@") ? raw : null;
}

function relativeMail(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "2-digit" }
  );
}

export function ThreadRow({
  thread, href, unread, index, accountId, threadId, missiveUrl, deleteOptions, onDelete, onMute,
  mutedBy
}: ThreadRowProps) {
  const { select, isSelected } = useInboxSplit();
  const selected = isSelected(threadId);
  // Keeps the (hover-revealed) actions pinned while either popover is open, so
  // the cursor can travel to the panel without the row hiding what it's using.
  const [deleteMenuOpen, setDeleteMenuOpen] = useState(false);
  const [muteMenuOpen, setMuteMenuOpen] = useState(false);
  const menuOpen = deleteMenuOpen || muteMenuOpen;
  const hasDelete = !!onDelete && !!deleteOptions && deleteOptions.length > 0;
  const hasMute = !!onMute;

  // Show whoever sent the most recent message (the "last person who emailed"),
  // falling back to the thread originator when the backend doesn't supply it.
  const senderRaw = thread.last_from ?? thread.participants[0] ?? "";
  const sender = shortAddress(senderRaw);
  const recipientCount = Math.max(0, thread.participants.length - 1);
  const messageCount = thread.message_count ?? null;
  const time = relativeMail(thread.last_message_at);

  // Warm each thread as it scrolls into view, so by the time the user clicks it
  // the full thread is usually already loaded → the open is instant. A short
  // dwell skips rows blown past in a fast scroll; a 300px rootMargin fetches a
  // row just BEFORE it's reached. Concurrency is capped in thread-cache so this
  // never floods the backend, and the cache dedupes with hover/click. This
  // covers the initially-visible rows on mount too, so the top of the list is
  // warm within ~200ms of load.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let dwell: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            dwell = setTimeout(() => prefetchThread(threadId, accountId), 200);
          } else if (dwell) {
            clearTimeout(dwell);
            dwell = null;
          }
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (dwell) clearTimeout(dwell);
    };
  }, [threadId, accountId]);

  // Plain left-click opens the email in the reading pane via client-local state
  // (no navigation/SSR, so the list keeps its scroll + loaded pages). Modifier/
  // middle clicks fall through to the <Link> so "open in new tab" still works.
  function openInPane(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    // Hand the pane what we already know so it can paint a header instantly
    // (no bare spinner) while the full thread loads.
    select(accountId, threadId, {
      subject: thread.subject,
      from: senderRaw,
      snippet: thread.last_snippet,
      date: thread.last_message_at
    });
  }

  // Warm the thread cache before the click lands. Hover starts it early;
  // mousedown (a few ms ahead of the click) covers fast clickers; focus covers
  // keyboard nav. The cache dedupes, so calling this repeatedly is cheap.
  function warm() {
    prefetchThread(threadId, accountId);
  }

  // Also warm the FULL message chain (every collapsed body) so expanding any
  // message after opening is instant. Gated behind a short hover dwell so we
  // don't fan out body fetches for rows the cursor merely skims past; mousedown
  // and focus (committed intent) trigger it immediately.
  const chainDwellRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function warmChainSoon() {
    if (chainDwellRef.current) return;
    chainDwellRef.current = setTimeout(() => {
      chainDwellRef.current = null;
      prefetchThreadChain(threadId, accountId);
    }, 180);
  }
  function cancelChainWarm() {
    if (chainDwellRef.current) {
      clearTimeout(chainDwellRef.current);
      chainDwellRef.current = null;
    }
  }
  function warmChainNow() {
    cancelChainWarm();
    prefetchThreadChain(threadId, accountId);
  }
  useEffect(() => () => cancelChainWarm(), []);

  const avatarTone = useMemo(
    () => AVATAR_TONES[hashStringToIndex(senderRaw || "?", AVATAR_TONES.length)],
    [senderRaw]
  );
  const initials = useMemo(() => nameInitials(sender), [sender]);

  return (
    <motion.div
      ref={rowRef}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: Math.min(index * 0.025, 0.4),
        duration: 0.28,
        ease: [0.2, 0.8, 0.2, 1]
      }}
      className="relative group"
    >
      <Link
        href={href}
        onClick={openInPane}
        onMouseEnter={() => { warm(); warmChainSoon(); }}
        onMouseLeave={cancelChainWarm}
        onMouseDown={() => { warm(); warmChainNow(); }}
        onFocus={() => { warm(); warmChainNow(); }}
        onBlur={cancelChainWarm}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "relative flex items-center gap-3 px-3 py-2.5 border-b border-slate-100/80",
          "transition-colors duration-150",
          selected
            ? "bg-accent/10 hover:bg-accent/15"
            : unread
              ? "bg-blue-50/40 hover:bg-blue-50/70"
              : "bg-white hover:bg-slate-50/70"
        )}
      >
        {/* Left rail: unread dot. Reserves the width even when read so
            rows don't shift when state flips. */}
        <span
          aria-hidden
          className={cn(
            "shrink-0 w-2 h-2 rounded-full transition-colors",
            unread ? "bg-accent shadow-[0_0_8px_2px_rgba(6,50,112,0.45)]" : "bg-transparent"
          )}
        />

        {/* Avatar — the sender domain's favicon, falling back to the
            initials tile (tone hashed off the sender so the same person
            always gets the same color) when there's no favicon. */}
        <InboxFavicon
          email={addressEmail(senderRaw)}
          size={36}
          title={sender}
          className="rounded-full ring-1 ring-white shadow-sm"
          loadedClassName="bg-white ring-1 ring-slate-200/80 shadow-sm"
          fallbackClassName={cn("bg-gradient-to-br", avatarTone)}
          fallback={
            <span className="text-[12px] font-bold tracking-tight">
              {initials || "?"}
            </span>
          }
          // pad the square favicon so its corners don't clip on the circle
          imgClassName="p-1.5"
        />

        {/* Sender + subject */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                "text-[13px] truncate",
                unread ? "font-semibold text-ink" : "font-medium text-ink/80"
              )}
            >
              {sender}
            </span>
            {recipientCount > 0 && (
              <span className="text-[11px] text-ink/45 shrink-0 tabular-nums">
                +{recipientCount}
              </span>
            )}
          </div>
          <div
            className={cn(
              "text-[13px] truncate mt-0.5",
              unread ? "font-semibold text-ink" : "text-ink/65"
            )}
          >
            {thread.subject || "(no subject)"}
            {thread.last_snippet && (
              <span className="font-normal text-ink/45">{" — "}{thread.last_snippet}</span>
            )}
          </div>
          {/* Muted view only: name the rule doing the filtering, so "why is
              this hidden" is answerable from the row itself. */}
          {mutedBy && (
            <span
              className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded-full bg-warn/10 text-warn text-[10px] font-medium max-w-full truncate"
              title={`Muted by rule: ${describeRule(mutedBy.matchType, mutedBy.value)}`}
            >
              <BellOff className="w-2.5 h-2.5 shrink-0" />
              {describeRule(mutedBy.matchType, mutedBy.value)}
            </span>
          )}
        </div>

        {/* Right rail: time, then small meta below. Status only shows
            when non-open so the open inbox stays uncluttered. */}
        <div className="shrink-0 flex flex-col items-end gap-1.5 pl-2 min-w-[78px]">
          <span
            className={cn(
              "text-[11px] tabular-nums",
              unread ? "text-accent font-semibold" : "text-ink/55"
            )}
          >
            {time}
          </span>
          <div className="flex items-center gap-1.5">
            {messageCount && messageCount > 1 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-ink/50 tabular-nums">
                <MessageSquare className="w-2.5 h-2.5" /> {messageCount}
              </span>
            )}
            {thread.status !== "open" && <StatusDot status={thread.status} />}
          </div>
        </div>
      </Link>

      {/* Hover actions float just left of the time/meta rail (the idiom the
          "Open in Missive" chip already used), so they never cover the
          timestamp. One flex row rather than three hand-tuned offsets, so
          adding an action can't collide with the others. */}
      {(hasDelete || hasMute || missiveUrl) && (
        <div
          className={cn(
            "absolute top-1/2 -translate-y-1/2 right-[88px] z-20 flex items-center gap-1.5 transition-opacity",
            menuOpen
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
          )}
        >
          {missiveUrl && (
            <a
              href={missiveUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-white border border-slate-200 text-ink/70 hover:text-accent hover:border-accent/30 shadow-sm"
              title="Open in Missive"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {hasMute && (
            <MuteSenderControl
              from={senderRaw}
              subject={thread.subject}
              onMuted={onMute!}
              onOpenChange={setMuteMenuOpen}
            />
          )}
          {hasDelete && (
            <DeleteThreadControl
              options={deleteOptions!}
              onDelete={onDelete!}
              onOpenChange={setDeleteMenuOpen}
            />
          )}
        </div>
      )}
    </motion.div>
  );
}

function StatusDot({ status }: { status: MissiveThread["status"] }) {
  const tone =
    status === "pending" ? "bg-indigo-400"
    : status === "closed" ? "bg-slate-400"
    : "bg-blue-400";
  return (
    <span
      aria-label={status}
      title={status}
      className={cn("w-1.5 h-1.5 rounded-full", tone)}
    />
  );
}

// Empty-state for the list, kept here so the inbox page imports one file.
export function ThreadListEmpty({ message }: { message: string }) {
  return (
    <div className="card p-10 text-center">
      <div className="w-16 h-16 rounded-2xl bg-indigo-100 text-indigo-600 grid place-items-center mx-auto mb-3">
        <Inbox className="w-8 h-8" />
      </div>
      <div className="text-base font-medium">{message}</div>
    </div>
  );
}
