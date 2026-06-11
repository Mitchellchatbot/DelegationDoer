"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { FileText, Reply, PenSquare, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InboxDraft } from "@/lib/inbox-drafts";

// Renders the "Drafts" mailbox view — the caller's saved, unsent drafts.
// Reply drafts (threadId set) link back into their thread, where the
// ReplyComposer re-hydrates them; compose drafts (threadId null) re-open the
// new-message modal via onOpenCompose. Mirrors ThreadRow's row chrome.

interface Props {
  drafts: InboxDraft[];
  // Fallback inbox id for building a reply draft's thread href when the draft
  // didn't capture an account (e.g. composed before a from-mailbox existed).
  linkAccountId: string;
  // Open a compose draft back into the new-message modal (parent owns the
  // modal / query-param wiring).
  onOpenCompose: (draftId: string) => void;
  // Discard a draft (parent removes it from state + calls the DELETE route).
  onDiscard: (draft: InboxDraft) => void;
}

function relativeMail(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "2-digit" }
  );
}

function recipientLabel(d: InboxDraft): string {
  const first = d.to[0];
  if (!first) return d.threadId ? "(reply)" : "(no recipient)";
  const m = first.match(/^"?([^<"]+?)"?\s*<([^>]+)>$/);
  return m ? m[1].trim() : first;
}

function snippet(d: InboxDraft): string {
  const text = (d.bodyText || "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function DraftRow({
  draft, linkAccountId, onOpenCompose, onDiscard, index
}: {
  draft: InboxDraft;
  linkAccountId: string;
  onOpenCompose: (id: string) => void;
  onDiscard: (d: InboxDraft) => void;
  index: number;
}) {
  const isReply = typeof draft.threadId === "string" && draft.threadId.length > 0;
  const acct = draft.accountId || linkAccountId;
  const href = isReply
    ? `/inboxes/${encodeURIComponent(acct)}/threads/${encodeURIComponent(draft.threadId as string)}`
    : null;

  const body = (
    <>
      <div
        className="shrink-0 w-9 h-9 rounded-full grid place-items-center bg-gradient-to-br from-amber-200 to-amber-100 text-amber-700 ring-1 ring-white shadow-sm"
        aria-hidden
      >
        {isReply ? <Reply className="w-4 h-4" /> : <PenSquare className="w-4 h-4" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-ink/80 truncate">
            {recipientLabel(draft)}
          </span>
          <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-600 shrink-0">
            Draft
          </span>
        </div>
        <div className="text-[13px] text-ink/65 truncate mt-0.5">
          {draft.subject?.trim() || "(no subject)"}
          {snippet(draft) ? <span className="text-ink/40"> — {snippet(draft)}</span> : null}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2 pl-2">
        <span className="text-[11px] tabular-nums text-ink/55">
          {relativeMail(draft.updatedAt)}
        </span>
      </div>
    </>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.025, 0.4), duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
      className="relative group"
    >
      {href ? (
        <Link
          href={href}
          className="relative flex items-center gap-3 px-3 py-2.5 border-b border-slate-100/80 bg-white hover:bg-slate-50/70 transition-colors duration-150"
        >
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => onOpenCompose(draft.id)}
          className="w-full text-left relative flex items-center gap-3 px-3 py-2.5 border-b border-slate-100/80 bg-white hover:bg-slate-50/70 transition-colors duration-150"
        >
          {body}
        </button>
      )}

      <button
        type="button"
        onClick={() => onDiscard(draft)}
        aria-label="Discard draft"
        title="Discard draft"
        className="absolute top-1/2 -translate-y-1/2 right-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg bg-white border border-slate-200 text-ink/55 hover:text-rose-600 hover:border-rose-200 shadow-sm"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  );
}

export function DraftList({ drafts, linkAccountId, onOpenCompose, onDiscard }: Props) {
  if (drafts.length === 0) {
    return (
      <div className="card p-10 text-center">
        <div className="w-16 h-16 rounded-2xl bg-amber-100 text-amber-600 grid place-items-center mx-auto mb-3">
          <FileText className="w-8 h-8" />
        </div>
        <div className="text-base font-medium">No drafts</div>
        <div className="text-sm text-ink/55 mt-1">
          Start a reply or compose a message — it'll save here automatically.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white overflow-hidden shadow-soft">
      {drafts.map((d, i) => (
        <DraftRow
          key={d.id}
          draft={d}
          linkAccountId={linkAccountId}
          onOpenCompose={onOpenCompose}
          onDiscard={onDiscard}
          index={i}
        />
      ))}
    </div>
  );
}
