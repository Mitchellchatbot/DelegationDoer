"use client";

import Link from "next/link";
import { useState } from "react";
import { Mail, Send, FileText, MailX } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClientEmailLog } from "@/components/ClientEmailLog";
import type { EmailDraftListItem } from "@/lib/email-drafts-data";

// One card that owns BOTH "Client emails" (outbound drafts authored
// in DD — content plans, EOD updates, custom) AND "Email history"
// (inbound + outbound threads from Missive). Used to be two separate
// sections on the client detail page, which left them visually far
// apart even though they describe the same relationship.
//
// Tabbed for clarity since the two lists have very different shapes
// (drafts carry status + author + send timing; threads carry
// participants + subject + recency). Counts on each tab so the
// section reads at a glance — you can tell there's 3 drafts +
// 18 threads without expanding either.

export interface ClientEmailsCombinedThread {
  id: string;
  subject: string;
  accountId: string;
  lastAt: string;
  participants: string[];
  status: string;
}

// Re-export the canonical draft type so callers can stay decoupled from
// the lib path. Whatever lives in email-drafts-data is the source of
// truth; we just forward.
export type ClientEmailsCombinedDraft = EmailDraftListItem;

type Tab = "history" | "drafts";

export function ClientEmailsCombined({
  threads, drafts, canMatchByEmail
}: {
  threads: ClientEmailsCombinedThread[];
  drafts: EmailDraftListItem[];
  canMatchByEmail: boolean;
}) {
  // Drafts is the smaller list and the "what's happening this week"
  // signal; history is the longer-tail context. Default to whichever
  // has rows — usually history.
  const [tab, setTab] = useState<Tab>(threads.length > 0 ? "history" : "drafts");

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-slate-50/60 to-white p-4 space-y-3">
      <header className="flex items-center gap-2 flex-wrap">
        <Mail className="w-4 h-4 text-blue-600" />
        <div className="text-sm font-semibold">Email</div>
        <span className="text-[10px] text-ink/50 ml-1">
          Inbox history + outbound drafts from DelegationDoer.
        </span>
        <div className="ml-auto inline-flex rounded-xl border border-slate-200/70 bg-white p-0.5">
          <TabButton
            active={tab === "history"}
            onClick={() => setTab("history")}
            icon={<Mail className="w-3 h-3" />}
            label="History"
            count={threads.length}
          />
          <TabButton
            active={tab === "drafts"}
            onClick={() => setTab("drafts")}
            icon={<Send className="w-3 h-3" />}
            label="Drafts"
            count={drafts.length}
          />
        </div>
      </header>

      {tab === "history" ? (
        threads.length === 0 ? (
          <EmptyRow
            icon={<MailX className="w-4 h-4 text-ink/40" />}
            text={
              canMatchByEmail
                ? "No threads from this client in any inbox you can see yet."
                : "Add a website or a contact email to this client to surface their email history here."
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {threads.map((t) => (
              <Link
                key={t.id}
                href={`/inboxes/${t.accountId}/threads/${t.id}`}
                className="group flex items-center gap-2 p-2.5 rounded-xl bg-white/80 border border-white/70 hover:border-blue-200 hover:bg-blue-50/40 transition-colors"
              >
                <Mail className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate group-hover:text-accent">
                    {t.subject || "(no subject)"}
                  </div>
                  <div className="text-[10px] text-ink/55 truncate">
                    {t.participants.slice(0, 2).join(", ")}
                    {t.participants.length > 2 ? ` +${t.participants.length - 2}` : ""}
                  </div>
                </div>
                <div className="text-[10px] text-ink/55 shrink-0 tabular-nums">
                  {new Date(t.lastAt).toLocaleDateString(undefined, {
                    month: "short", day: "numeric"
                  })}
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200/60 capitalize shrink-0">
                  {t.status}
                </span>
              </Link>
            ))}
          </div>
        )
      ) : drafts.length === 0 ? (
        <EmptyRow
          icon={<FileText className="w-4 h-4 text-ink/40" />}
          text="No outbound drafts for this client yet."
        />
      ) : (
        <ClientEmailLog rows={drafts} />
      )}
    </section>
  );
}

function TabButton({
  active, onClick, icon, label, count
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors inline-flex items-center gap-1",
        active ? "bg-accent/10 text-accent" : "text-ink/55 hover:text-ink"
      )}
    >
      {icon}
      {label}
      <span className="text-[10px] opacity-70 tabular-nums">{count}</span>
    </button>
  );
}

function EmptyRow({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="rounded-xl border border-slate-200/60 bg-white/60 p-4 text-[12px] text-ink/55 inline-flex items-center gap-2 w-full">
      {icon}
      {text}
    </div>
  );
}
