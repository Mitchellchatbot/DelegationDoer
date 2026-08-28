"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Link2, Mail, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// "Who hasn't finished onboarding?" — one page, rather than opening clients one
// at a time.
//
// Ordered by who needs chasing, not by date. A link sent last week and never
// opened is today's job; a date sort buries it under everything sent since.

export interface BoardRow {
  id: string;
  clientId: string;
  clientName: string;
  formKey: string;
  formLabel: string;
  createdAt: string;
  firstOpenedAt: string | null;
  completedAt: string | null;
  revokedAt: string | null;
  doneCount: number;
  total: number;
  canManage: boolean;
  url: string | null;
}

interface Mailbox {
  id: string;
  email: string;
}

interface Props {
  rows: BoardRow[];
  /** Mailboxes the confirmation email could be sent from. */
  mailboxes: Mailbox[];
  /** Currently chosen, or null when nobody has picked one yet. */
  fromAccountId: string | null;
  /** Which forms this user may send — drives the preview links. */
  previewForms: { key: string; label: string }[];
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function status(r: BoardRow): { label: string; tone: string } {
  if (r.revokedAt) return { label: "Turned off", tone: "bg-slate-100 text-slate-600 border-slate-200" };
  if (r.completedAt) return { label: "Finished", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  if (!r.firstOpenedAt) return { label: "Not opened", tone: "bg-rose-50 text-rose-700 border-rose-200" };
  if (r.doneCount === 0) return { label: "Opened, not started", tone: "bg-amber-50 text-amber-800 border-amber-200" };
  return { label: "In progress", tone: "bg-sky-50 text-sky-700 border-sky-200" };
}

export function OnboardingBoard({ rows, mailboxes, fromAccountId, previewForms }: Props) {
  const router = useRouter();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savingMailbox, setSavingMailbox] = useState(false);

  async function copy(r: BoardRow) {
    if (!r.url) return;
    try {
      await navigator.clipboard.writeText(r.url);
      setCopiedId(r.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      toast.error("Couldn't copy — open the client and copy it from there.");
    }
  }

  async function setMailbox(accountId: string) {
    setSavingMailbox(true);
    try {
      const res = await fetch("/api/workspace/onboarding-mailbox", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "failed");
      toast.success("Confirmation emails will send from that mailbox");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't save that");
    } finally {
      setSavingMailbox(false);
    }
  }

  const needChasing = rows.filter((r) => !r.completedAt && !r.revokedAt).length;

  return (
    <div className="space-y-4">
      {/* Only while it is unset. Once a mailbox is chosen this disappears
          rather than becoming a permanent settings row on a page that is not
          a settings page. */}
      {!fromAccountId && mailboxes.length > 0 && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <header className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-amber-700" />
            <div className="text-sm font-semibold text-amber-900">
              Clients aren&apos;t getting a confirmation email
            </div>
          </header>
          <p className="text-[12.5px] text-amber-800 leading-relaxed pt-1.5 max-w-[70ch]">
            When someone finishes onboarding we can email them to confirm we have everything. Pick
            which mailbox that goes from — replies land back in that inbox.
          </p>
          <div className="flex flex-wrap gap-2 pt-3">
            {mailboxes.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={savingMailbox}
                onClick={() => setMailbox(m.id)}
                className="text-[12.5px] font-medium px-3 py-1.5 rounded-full bg-white border border-amber-300 text-amber-900 hover:border-amber-500 transition-colors disabled:opacity-50"
              >
                {m.email}
              </button>
            ))}
          </div>
        </section>
      )}

      {previewForms.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11.5px] text-ink/55">See what a client sees:</span>
          {previewForms.map((f) => (
            <Link
              key={f.key}
              href={`/clients/onboarding/preview/${f.key}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              Preview {f.label}
            </Link>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-white p-8 text-center">
          <p className="text-[13px] text-ink/60">
            No onboarding links sent yet. Create one from the Clients page.
          </p>
        </div>
      ) : (
        <>
          <div className="text-[11.5px] text-ink/55 px-1">
            {needChasing === 0
              ? "Everything sent has been finished."
              : `${needChasing} still open · the ones needing a nudge are at the top`}
          </div>

          <div className="rounded-2xl border border-border bg-white overflow-hidden">
            {rows.map((r, i) => {
              const s = status(r);
              const pct = Math.round((r.doneCount / Math.max(1, r.total)) * 100);
              return (
                <div
                  key={r.id}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 flex-wrap",
                    i > 0 && "border-t border-border/70"
                  )}
                >
                  <Link
                    href={`/clients/${encodeURIComponent(r.clientId)}`}
                    className="text-[13.5px] font-medium text-ink hover:text-accent transition-colors min-w-[160px]"
                  >
                    {r.clientName}
                  </Link>

                  <span className="text-[11.5px] text-ink/55 min-w-[150px]">{r.formLabel}</span>

                  <span className={cn("text-[10.5px] font-medium px-2 py-0.5 rounded-md border", s.tone)}>
                    {s.label}
                  </span>

                  <div className="flex items-center gap-2 min-w-[120px]">
                    <div className="h-1.5 w-16 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className={cn("h-full rounded-full", r.completedAt ? "bg-emerald-500" : "bg-accent")}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-ink/50 tabular-nums">
                      {r.doneCount}/{r.total}
                    </span>
                  </div>

                  <span className="text-[11px] text-ink/45 tabular-nums">
                    sent {ago(r.createdAt)}
                    {r.firstOpenedAt ? ` · opened ${ago(r.firstOpenedAt)}` : " · never opened"}
                  </span>

                  {r.url && !r.revokedAt && (
                    <button
                      onClick={() => copy(r)}
                      className={cn(
                        "ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                        copiedId === r.id
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-white text-ink/65 border-border hover:text-accent hover:border-accent/40"
                      )}
                    >
                      {copiedId === r.id ? <ClipboardCheck className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
                      {copiedId === r.id ? "Copied" : "Copy link"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
