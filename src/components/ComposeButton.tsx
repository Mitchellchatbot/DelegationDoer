"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { PenSquare, Send, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// "Compose" affordance — pill button on the inbox header that opens a
// Gmail-style modal. State is local; submit hits /api/inboxes/compose.
// Form fields: to (chip-style), cc (chip-style), subject, body.

export function ComposeButton({
  accountId, accountEmail
}: {
  accountId: string;
  accountEmail: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [showCc, setShowCc] = useState(false);

  function reset() {
    setTo("");
    setCc("");
    setSubject("");
    setBodyText("");
    setShowCc(false);
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
    if (!bodyText.trim()) {
      toast.error("Write something before sending");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/inboxes/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          to: toList,
          cc: ccList,
          subject: subject.trim(),
          bodyText: bodyText
        })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't send");
        return;
      }
      toast.success("Sent ✉️");
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
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
          style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
        >
          <PenSquare className="w-3.5 h-3.5" />
          Compose
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
            <Dialog.Content asChild>
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[640px] max-w-[92vw] rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)] overflow-hidden"
              >
                <header
                  className="px-5 py-3 flex items-center justify-between border-b border-slate-100"
                  style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
                >
                  <div className="flex items-center gap-2">
                    <PenSquare className="w-4 h-4 text-accent" />
                    <Dialog.Title className="text-sm font-semibold">New message</Dialog.Title>
                    <span className="text-[11px] text-ink/55 truncate max-w-[260px]">
                      from {accountEmail}
                    </span>
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
                      placeholder="What's this about?"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </FieldRow>

                  <textarea
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    placeholder="Write your message…"
                    rows={9}
                    className="w-full text-sm bg-white/60 border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-none transition-all"
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
                    {busy ? "Sending…" : "Send"}
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
