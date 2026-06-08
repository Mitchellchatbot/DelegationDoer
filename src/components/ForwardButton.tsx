"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Forward, Send, X, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// Per-message "Forward" affordance. Opens a Gmail-style modal pre-filled
// with the "Fwd:" subject; the user picks recipients and optionally writes
// a note above the quoted original. Submit hits
// /api/inboxes/threads/[threadId]/forward, which rebuilds the quoted body
// + re-attaches the original files server-side and sends through the same
// mailbox via the missive clone's compose engine (so it lands in Sent).
//
// The original body + attachments are included by the server — we surface a
// read-only summary here so the user knows what's being forwarded without
// dumping raw HTML into an editable textarea (which would lose formatting).
export function ForwardButton({
  accountId,
  threadId,
  messageId,
  sourceSubject,
  sourceFrom,
  sourceDate,
  attachmentCount
}: {
  accountId: string;
  threadId: string;
  messageId: string;
  sourceSubject: string;
  sourceFrom: string;
  sourceDate: string;
  attachmentCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(fwdSubject(sourceSubject));
  const [note, setNote] = useState("");
  const [includeAttachments, setIncludeAttachments] = useState(true);
  // Extra files the user adds on top of the original attachments. Same wire
  // shape as compose/reply; the route fetches each URL and forwards it.
  const [attachments, setAttachments] = useState<TaskMedia[]>([]);

  function reset() {
    setTo("");
    setCc("");
    setShowCc(false);
    setSubject(fwdSubject(sourceSubject));
    setNote("");
    setIncludeAttachments(true);
    setAttachments([]);
  }

  async function submit() {
    const toList = to.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const ccList = cc.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (toList.length === 0) {
      toast.error("Add at least one recipient");
      return;
    }
    if (!subject.trim()) {
      toast.error("Add a subject");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(
        `/api/inboxes/threads/${encodeURIComponent(threadId)}/forward`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId,
            messageId,
            to: toList,
            cc: ccList,
            subject: subject.trim(),
            note,
            includeAttachments,
            attachmentUrls: attachments
          })
        }
      );
      const raw = await res.text();
      let data: { error?: string } = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { /* fall through */ }
      if (!res.ok) {
        toast.error(data.error ?? `Forward failed (status ${res.status})`);
        return;
      }
      toast.success("Forwarded ✉️");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white/70 border border-border/60 text-ink/70 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm"
          title="Forward this email"
        >
          <Forward className="w-3 h-3" /> Forward
        </button>
      </Dialog.Trigger>

      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-sm"
              />
            </Dialog.Overlay>
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
            >
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="pointer-events-auto w-[640px] max-w-full rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden"
              >
                <header
                  className="px-5 py-3 flex items-center justify-between border-b border-slate-100"
                  style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
                >
                  <div className="flex items-center gap-2">
                    <Forward className="w-4 h-4 text-accent" />
                    <Dialog.Title className="text-sm font-semibold">Forward message</Dialog.Title>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      aria-label="Close"
                      className="p-1 rounded-lg text-ink/60 hover:text-ink hover:bg-white/60 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </Dialog.Close>
                </header>

                <div className="p-4 space-y-2.5">
                  <FieldRow label="To">
                    <input
                      autoFocus
                      type="text"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      placeholder="someone@example.com, another@example.com"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                    {!showCc && (
                      <button
                        type="button"
                        onClick={() => setShowCc(true)}
                        className="text-[11px] text-ink/55 hover:text-accent transition-colors px-1.5 py-0.5 rounded"
                      >
                        Cc
                      </button>
                    )}
                  </FieldRow>

                  <AnimatePresence>
                    {showCc && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                      >
                        <FieldRow label="Cc">
                          <input
                            type="text"
                            value={cc}
                            onChange={(e) => setCc(e.target.value)}
                            placeholder="optional cc list"
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                          />
                        </FieldRow>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <FieldRow label="Subject">
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Fwd: …"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </FieldRow>

                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Add a message (optional) — it appears above the forwarded email…"
                    rows={5}
                    className="w-full text-sm bg-white/60 border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-none transition-all"
                  />

                  {/* Read-only summary of what's being forwarded. The original
                      body + attachments are attached server-side so HTML
                      formatting is preserved (a textarea would flatten it). */}
                  <div className="rounded-xl border border-slate-200/70 bg-slate-50/70 px-3 py-2.5 text-[11px] text-ink/65 space-y-1">
                    <div className="uppercase tracking-wide font-semibold text-ink/45">
                      Forwarded message
                    </div>
                    <div className="truncate"><span className="text-ink/45">From</span> {sourceFrom}</div>
                    {sourceDate && <div className="truncate"><span className="text-ink/45">Date</span> {sourceDate}</div>}
                    <div className="truncate"><span className="text-ink/45">Subject</span> {sourceSubject || "(no subject)"}</div>
                    {attachmentCount > 0 && (
                      <label className="flex items-center gap-1.5 pt-1 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={includeAttachments}
                          onChange={(e) => setIncludeAttachments(e.target.checked)}
                          className="accent-accent"
                        />
                        <Paperclip className="w-3 h-3" />
                        Include {attachmentCount} original attachment{attachmentCount === 1 ? "" : "s"}
                      </label>
                    )}
                  </div>

                  <MediaPicker
                    value={attachments}
                    onChange={setAttachments}
                    label="Attach more files"
                    compact
                  />
                </div>

                <footer className="px-4 py-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors"
                    >
                      Discard
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={busy}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95",
                      busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
                    )}
                    style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    {busy ? "Forwarding…" : "Forward"}
                  </button>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
      <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-12 shrink-0">
        {label}
      </span>
      {children}
    </div>
  );
}

function fwdSubject(s: string): string {
  const t = (s || "").trim();
  if (!t) return "Fwd:";
  return /^fwd:\s*/i.test(t) ? t : `Fwd: ${t}`;
}
