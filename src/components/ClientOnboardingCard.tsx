"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Copy, Eye, FileText, Link2, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// What a client has been sent, how far they have got, and what they said.
//
// The three questions this answers, in the order the team asks them:
//   have they opened it · how far are they · what did they tell us
//
// Progress comes from the server rather than the client's browser, so "they
// stopped at the Google accounts step" is answerable here without asking them.

export interface OnboardingLinkView {
  id: string;
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

export interface OnboardingAnswerView {
  id: string;
  linkId: string;
  stepTitle: string;
  label: string;
  hint: string;
  isSecret: boolean;
}

export interface OnboardingFileView {
  id: string;
  linkId: string;
  fileName: string;
  url: string;
  sizeBytes: number | null;
}

interface Props {
  links: OnboardingLinkView[];
  answers: OnboardingAnswerView[];
  files: OnboardingFileView[];
  /** Leader/admin. Gates the reveal control only — everything else on this card
   *  is visible to anyone who can see the client. */
  canReveal: boolean;
}

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric"
  });
}

function statusOf(l: OnboardingLinkView): { label: string; tone: string } {
  if (l.revokedAt) return { label: "Revoked", tone: "bg-slate-100 text-slate-600 border-slate-200" };
  if (l.completedAt) return { label: "Completed", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  if (l.doneCount > 0) return { label: "In progress", tone: "bg-amber-50 text-amber-700 border-amber-200" };
  if (l.firstOpenedAt) return { label: "Opened", tone: "bg-sky-50 text-sky-700 border-sky-200" };
  return { label: "Not opened yet", tone: "bg-slate-100 text-slate-600 border-slate-200" };
}

/** One stored credential, revealed on request.
 *
 *  Deliberately a button and not a render: reading a client's password should
 *  be something somebody chose to do, not something that happened because they
 *  had the page open. */
function Secret({ answerId, mask, canReveal }: { answerId: string; mask: string; canReveal: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!canReveal) {
    return <span className="font-mono text-ink/50">{mask} · encrypted</span>;
  }
  if (value) {
    return <span className="font-mono text-ink break-all">{value}</span>;
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(
            `/api/clients/onboarding-answers/${encodeURIComponent(answerId)}/reveal`,
            { method: "POST" }
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error ?? "couldn't reveal");
          setValue(data.value as string);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "couldn't reveal that");
        } finally {
          setBusy(false);
        }
      }}
      className="inline-flex items-center gap-1.5 font-mono text-ink/50 hover:text-accent transition-colors"
    >
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
      {mask} · reveal
    </button>
  );
}

export function ClientOnboardingCard({ links, answers, files, canReveal }: Props) {
  const router = useRouter();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(
    // Open the most recent one by default — on almost every client there is
    // exactly one, and making them click to see it is a click for nothing.
    links[0]?.id ?? null
  );

  if (!links.length) return null;

  async function copy(l: OnboardingLinkView) {
    if (!l.url) return;
    try {
      await navigator.clipboard.writeText(l.url);
      setCopiedId(l.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      toast.error("Couldn't copy — open the link and copy it from the address bar.");
    }
  }

  async function revoke(l: OnboardingLinkView) {
    if (!confirm("Turn this link off? Anything they've already answered is kept.")) return;
    try {
      const res = await fetch(
        `/api/clients/onboarding-links/${encodeURIComponent(l.id)}/revoke`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "failed");
      toast.success("Link turned off");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "couldn't revoke that");
    }
  }

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-violet-50/50 to-white p-4 space-y-3">
      <header className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-violet-600" />
        <div className="text-sm font-semibold">Onboarding</div>
        <span className="text-[10px] text-ink/50 hidden sm:inline">
          — what they were sent, and what they told us
        </span>
      </header>

      {links.map((l) => {
        const status = statusOf(l);
        const mine = answers.filter((a) => a.linkId === l.id);
        const myFiles = files.filter((f) => f.linkId === l.id);
        const isOpen = openId === l.id;

        // Answers arrive already ordered by the step they belong to; grouping
        // preserves that so the card reads in the same order the client
        // answered, not alphabetically.
        const groups: { title: string; rows: OnboardingAnswerView[] }[] = [];
        for (const a of mine) {
          const last = groups[groups.length - 1];
          if (last && last.title === a.stepTitle) last.rows.push(a);
          else groups.push({ title: a.stepTitle, rows: [a] });
        }

        return (
          <div key={l.id} className="rounded-xl bg-white/85 border border-white/70 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12.5px] font-medium text-ink">{l.formLabel}</span>
              <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-md border", status.tone)}>
                {status.label}
              </span>
              <span className="text-[10.5px] text-ink/50 tabular-nums">
                {l.doneCount}/{l.total} steps · sent {when(l.createdAt)}
              </span>

              <div className="ml-auto flex items-center gap-1.5">
                {l.url && !l.revokedAt && (
                  <button
                    onClick={() => copy(l)}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition-colors",
                      copiedId === l.id
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-white text-ink/65 border-border hover:text-accent hover:border-accent/40"
                    )}
                  >
                    {copiedId === l.id ? <ClipboardCheck className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
                    {copiedId === l.id ? "Copied" : "Copy link"}
                  </button>
                )}
                {l.canManage && !l.revokedAt && (
                  <button
                    onClick={() => revoke(l)}
                    className="text-[11px] text-ink/45 hover:text-urgent transition-colors px-1.5 py-1"
                  >
                    Turn off
                  </button>
                )}
              </div>
            </div>

            {/* The bar is the fastest read on the card: how much of this is
                actually done. */}
            <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all", l.completedAt ? "bg-emerald-500" : "bg-accent")}
                style={{ width: `${Math.round((l.doneCount / Math.max(1, l.total)) * 100)}%` }}
              />
            </div>

            {(mine.length > 0 || myFiles.length > 0) && (
              <button
                onClick={() => setOpenId(isOpen ? null : l.id)}
                className="text-[11px] text-accent/80 hover:text-accent font-medium pt-2"
              >
                {isOpen ? "Hide answers" : `Show ${mine.length} answer${mine.length === 1 ? "" : "s"}`}
              </button>
            )}

            {isOpen && (
              <div className="pt-2 space-y-3">
                {groups.map((g) => (
                  <div key={g.title}>
                    <div className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold mb-1">
                      {g.title}
                    </div>
                    <dl className="space-y-1.5">
                      {g.rows.map((a) => (
                        <div key={a.id} className="text-[12px] leading-snug">
                          <dt className="text-ink/55">{a.label}</dt>
                          <dd className="text-ink/90 whitespace-pre-wrap break-words">
                            {a.isSecret ? (
                              <Secret answerId={a.id} mask={a.hint} canReveal={canReveal} />
                            ) : (
                              a.hint || <span className="text-ink/40 italic">blank</span>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}

                {myFiles.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold mb-1">
                      Files · {myFiles.length}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {myFiles.map((f) => (
                        <a
                          key={f.id}
                          href={f.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-violet-200/70 text-[11.5px] text-ink hover:text-accent hover:border-accent/40 transition-colors"
                        >
                          <Paperclip className="w-3 h-3 text-violet-600" />
                          {f.fileName}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
