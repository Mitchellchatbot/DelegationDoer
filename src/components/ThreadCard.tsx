import Link from "next/link";
import { ArrowRight, AtSign, SendHorizontal, ExternalLink } from "lucide-react";
import type { MissiveThread } from "@/lib/missive-client";

// Threads are stored as `participants = "from"; "to1, to2, ..."` joined.
// First slot is the sender; the rest are recipients (per Missive's IMAP
// ingest pattern). We expose helpers to split + display them as pills.

export function senderAndRecipients(participants: string[]): { from: string | null; to: string[] } {
  if (participants.length === 0) return { from: null, to: [] };
  const [from, ...rest] = participants;
  const to = rest.flatMap((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
  return { from, to };
}

function shortAddress(addr: string): string {
  const m = addr.match(/^"?([^<"]+?)"?\s*<([^>]+)>$/);
  if (m) return m[1].trim();
  const at = addr.indexOf("@");
  return at > 0 ? addr.slice(0, at) : addr;
}

export function ThreadCard({
  thread, href, animationDelay, missiveUrl
}: {
  thread: MissiveThread;
  href: string;
  animationDelay?: number;
  // When set, an "Open in Missive" chip is rendered as a sibling of the
  // main Link so we don't end up with nested <a> tags. Built from
  // MISSIVE_API_URL on the server: `${url}/?thread=${threadId}`.
  missiveUrl?: string;
}) {
  const { from, to } = senderAndRecipients(thread.participants);
  return (
    <div
      className="relative group animate-rise"
      style={{ animationDelay: animationDelay ? `${animationDelay}s` : undefined }}
    >
      <Link
        href={href}
        className="block relative overflow-hidden rounded-2xl border border-white/60 bg-white/85 backdrop-blur-sm p-4 shadow-soft hover:shadow-lift hover:-translate-y-0.5 transition-all"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0 flex-1 pr-20">
            <div className="text-sm font-semibold text-ink truncate group-hover:text-accent transition-colors">
              {thread.subject || "(no subject)"}
            </div>
            <div className="text-[11px] text-muted mt-0.5 tabular-nums">
              {thread.last_message_at
                ? new Date(thread.last_message_at).toLocaleString(undefined, {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
                  })
                : "—"}
            </div>
          </div>
          <StatusPill status={thread.status} />
        </div>

        <div className="flex flex-wrap gap-1.5 items-center">
          {from && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-blue-100 text-blue-700 border border-blue-200/60">
              <AtSign className="w-3 h-3" />
              <span className="truncate max-w-[160px]">{shortAddress(from)}</span>
            </span>
          )}
          {to.length > 0 && <ArrowRight className="w-3 h-3 text-muted shrink-0" />}
          {to.slice(0, 2).map((r, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-violet-100 text-violet-700 border border-violet-200/60"
            >
              <SendHorizontal className="w-3 h-3" />
              <span className="truncate max-w-[140px]">{shortAddress(r)}</span>
            </span>
          ))}
          {to.length > 2 && (
            <span className="text-[10px] text-muted">+{to.length - 2}</span>
          )}
        </div>

        <div
          aria-hidden
          className="absolute -bottom-8 -right-8 w-28 h-28 rounded-full pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: "radial-gradient(circle, rgba(139,92,246,0.18), transparent 70%)" }}
        />
      </Link>

      {/* Sibling, not child, of the Link to keep HTML valid. Positioned
          over the card's top-right corner. */}
      {missiveUrl && (
        <a
          href={missiveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute top-3 right-20 z-10 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-white/80 border border-border/60 text-ink/70 hover:text-accent hover:border-accent/30 transition-colors shadow-sm"
          title="Open in Missive"
        >
          <ExternalLink className="w-3 h-3" />
          Missive
        </a>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: MissiveThread["status"] }) {
  const tone =
    status === "open" ? "bg-blue-100 text-blue-700 border-blue-200/60"
    : status === "pending" ? "bg-violet-100 text-violet-700 border-violet-200/60"
    : "bg-slate-100 text-slate-600 border-slate-200/60";
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${tone}`}>
      {status}
    </span>
  );
}
