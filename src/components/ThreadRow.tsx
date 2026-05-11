"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useMemo } from "react";
import { Inbox, MessageSquare, ExternalLink } from "lucide-react";
import { cn, initials as nameInitials } from "@/lib/utils";
import type { MissiveThread } from "@/lib/missive-client";

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
  // Optional "Open in Missive" deep-link rendered as a sibling chip.
  missiveUrl?: string;
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

export function ThreadRow({ thread, href, unread, index, missiveUrl }: ThreadRowProps) {
  const senderRaw = thread.participants[0] ?? "";
  const sender = shortAddress(senderRaw);
  const recipientCount = Math.max(0, thread.participants.length - 1);
  const messageCount = thread.message_count ?? null;
  const time = relativeMail(thread.last_message_at);

  const avatarTone = useMemo(
    () => AVATAR_TONES[hashStringToIndex(senderRaw || "?", AVATAR_TONES.length)],
    [senderRaw]
  );
  const initials = useMemo(() => nameInitials(sender), [sender]);

  return (
    <motion.div
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
        className={cn(
          "relative flex items-center gap-3 px-3 py-2.5 border-b border-slate-100/80",
          "transition-colors duration-150",
          unread
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
            unread ? "bg-accent shadow-[0_0_8px_2px_rgba(30,99,255,0.45)]" : "bg-transparent"
          )}
        />

        {/* Avatar — initials-based, tone hashed off the sender so the
            same person always gets the same color. */}
        <div
          className={cn(
            "shrink-0 w-9 h-9 rounded-full grid place-items-center text-[12px] font-bold tracking-tight bg-gradient-to-br ring-1 ring-white shadow-sm",
            avatarTone
          )}
        >
          {initials || "?"}
        </div>

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
          </div>
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

      {missiveUrl && (
        <a
          href={missiveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-1/2 -translate-y-1/2 right-[88px] z-10 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-white border border-slate-200 text-ink/70 hover:text-accent hover:border-accent/30 shadow-sm"
          title="Open in Missive"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
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
