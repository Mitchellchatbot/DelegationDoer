"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Reply, Send, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Inline reply panel that sits at the bottom of a thread detail. Folded
// into a "Reply" pill by default; expands into a Gmail-style composer
// on click. Submitting hits /api/inboxes/threads/[threadId]/reply and
// refreshes the thread so the new message appears in the list.

export function ReplyComposer({
  threadId, accountId, defaultTo, defaultSubject
}: {
  threadId: string;
  accountId: string;
  // Best-guess "to" — the last inbound sender. The server fills this
  // in automatically when omitted; we pre-fill the field so the user
  // can adjust it before sending.
  defaultTo: string | null;
  // Original thread subject; we prepend "Re: " if it's not already there.
  defaultSubject: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(defaultTo ?? "");
  const [subject, setSubject] = useState(prefixRe(defaultSubject ?? ""));
  const [bodyText, setBodyText] = useState("");

  async function send() {
    const toList = to.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (toList.length === 0) {
      toast.error("Add a recipient");
      return;
    }
    if (!bodyText.trim()) {
      toast.error("Write something before sending");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/inboxes/threads/${encodeURIComponent(threadId)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, to: toList, subject: subject.trim() || undefined, bodyText })
      });
      // Read as text first so HTML error pages (auth redirect, Next 500,
      // Railway 502 during deploy) don't crash JSON.parse — surface them
      // with a meaningful status code instead.
      const raw = await res.text();
      let data: { error?: string; ok?: boolean } = {};
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { /* leave data empty; we'll fall through to the status hint */ }
      if (!res.ok) {
        const hint = res.status === 401
          ? "Session expired — refresh the page"
          : res.status === 502 || res.status === 503
          ? "Missive backend unavailable — redeploy in progress?"
          : raw.startsWith("<")
          ? `Server returned HTML (status ${res.status}) — check the dev server logs`
          : data.error ?? `Send failed (status ${res.status})`;
        toast.error(hint);
        return;
      }
      toast.success("Reply sent ✉️");
      setBodyText("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <AnimatePresence mode="wait" initial={false}>
        {!open ? (
          <motion.button
            key="trigger"
            type="button"
            onClick={() => setOpen(true)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
            className="w-full text-left flex items-center gap-2 px-4 py-3 rounded-2xl border border-slate-200/70 bg-white hover:bg-slate-50/70 hover:border-accent/30 transition-all group shadow-soft"
          >
            <div
              className="w-8 h-8 rounded-full grid place-items-center text-white shrink-0 shadow-sm transition-transform group-hover:scale-105"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
            >
              <Reply className="w-4 h-4" />
            </div>
            <span className="text-sm text-ink/65 flex-1 group-hover:text-ink transition-colors">
              Write a reply…
            </span>
            <span className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold">
              Click to compose
            </span>
          </motion.button>
        ) : (
          <motion.div
            key="composer"
            initial={{ opacity: 0, y: 12, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.99 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="rounded-2xl border border-slate-200/70 bg-white shadow-lift overflow-hidden"
          >
            <header className="px-4 py-2.5 flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-blue-50/60 to-indigo-50/40">
              <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                <Reply className="w-3.5 h-3.5 text-accent" /> Reply
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Discard"
                className="p-1 rounded-lg text-ink/55 hover:text-ink hover:bg-white transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </header>

            <div className="p-3 space-y-2.5">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                  To
                </span>
                <input
                  type="text"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                  placeholder="recipient@example.com"
                  autoFocus
                />
              </div>

              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                  Subject
                </span>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                  placeholder="Re: …"
                />
              </div>

              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder="Write your reply…"
                rows={7}
                className="w-full text-sm bg-white/60 border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-none transition-all"
              />
            </div>

            <footer className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">
              <button
                type="button"
                onClick={() => { setOpen(false); setBodyText(""); }}
                className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={send}
                disabled={busy}
                className={cn(
                  "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95",
                  busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
                )}
                style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {busy ? "Sending…" : "Send"}
              </button>
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function prefixRe(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  return /^re:\s*/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
