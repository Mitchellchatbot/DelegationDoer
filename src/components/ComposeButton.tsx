"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { PenSquare, Send, X, Loader2, Clock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// "Compose" affordance — pill button on the inbox header that opens a
// Gmail-style modal. State is local; submit hits /api/inboxes/compose.
// Form fields: to (chip-style), cc (chip-style), subject, body.

// `accounts` covers the All-Inboxes case where multiple connected
// mailboxes are eligible; the dialog renders a "from" picker. The
// single-inbox call site keeps passing accountId + accountEmail and
// gets the original flow.
export function ComposeButton({
  accountId, accountEmail, accounts
}: {
  accountId?: string;
  accountEmail?: string;
  accounts?: { id: string; email: string; display_name?: string | null }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // When `accounts` is supplied, this picks which mailbox to send FROM.
  // Defaults to the first; the picker only renders if there's >1 option.
  const initialFromId = accountId ?? accounts?.[0]?.id ?? "";
  const [fromAccountId, setFromAccountId] = useState<string>(initialFromId);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // <input type="datetime-local"> value: "YYYY-MM-DDTHH:mm" (no seconds,
  // no zone). We convert to ISO at submit time.
  const [sendAtLocal, setSendAtLocal] = useState("");
  // Forwarded to /api/inboxes/compose as attachmentUrls; the route
  // fetches each URL and re-forwards as multipart files[] to the missive
  // clone. Scheduled sends reject attachments at the backend, so we
  // block that combo in submit() with a friendly toast.
  const [attachments, setAttachments] = useState<TaskMedia[]>([]);

  const fromOptions = accounts ?? (accountId ? [{ id: accountId, email: accountEmail ?? "", display_name: null }] : []);
  const fromMeta = fromOptions.find((a) => a.id === fromAccountId) ?? fromOptions[0];
  const effectiveAccountId = fromMeta?.id ?? "";
  const effectiveFromLabel = fromMeta?.display_name || fromMeta?.email || "";

  function reset() {
    setTo("");
    setCc("");
    setSubject("");
    setBodyText("");
    setShowCc(false);
    setScheduleOpen(false);
    setSendAtLocal("");
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
    if (!bodyText.trim()) {
      toast.error("Write something before sending");
      return;
    }
    // Resolve schedule. datetime-local is interpreted in the user's
    // local timezone — we convert to a UTC ISO string before sending
    // so the backend's "is it in the future?" check is unambiguous.
    let sendAtISO: string | null = null;
    if (scheduleOpen && sendAtLocal) {
      const ms = new Date(sendAtLocal).getTime();
      if (Number.isNaN(ms)) {
        toast.error("Pick a valid date + time to schedule");
        return;
      }
      if (ms <= Date.now() + 30_000) {
        toast.error("Schedule a time at least a minute from now (or turn off scheduling)");
        return;
      }
      sendAtISO = new Date(ms).toISOString();
    }
    if (sendAtISO && attachments.length > 0) {
      toast.error("Attachments aren't supported on scheduled sends — remove them or send now.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/inboxes/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: effectiveAccountId,
          to: toList,
          cc: ccList,
          subject: subject.trim(),
          bodyText: bodyText,
          ...(sendAtISO ? { sendAt: sendAtISO } : { attachmentUrls: attachments })
        })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't send");
        return;
      }
      toast.success(sendAtISO ? `Scheduled for ${new Date(sendAtISO).toLocaleString()}` : "Sent ✉️");
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
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
            >
              {/* lg:pl-[264px] = 12px outer p-3 + 240px sidebar + 12px gap.
                  Centers the card over the main content panel instead of
                  the full viewport so it doesn't sit half under the
                  sidebar on lg+ screens. */}
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
                    <PenSquare className="w-4 h-4 text-accent" />
                    <Dialog.Title className="text-sm font-semibold">New message</Dialog.Title>
                    {fromOptions.length > 1 ? (
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-ink/55">
                        from
                        <select
                          value={fromAccountId}
                          onChange={(e) => setFromAccountId(e.target.value)}
                          className="text-[11px] bg-white/70 border border-slate-200 rounded-md px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 max-w-[260px]"
                        >
                          {fromOptions.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.display_name ? `${a.display_name} <${a.email}>` : a.email}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <span className="text-[11px] text-ink/55 truncate max-w-[260px]">
                        from {effectiveFromLabel}
                      </span>
                    )}
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

                  <MediaPicker
                    value={attachments}
                    onChange={setAttachments}
                    label="Attach files"
                    compact
                    hint={scheduleOpen ? "Attachments are not supported on scheduled sends." : undefined}
                  />
                </div>

                <footer className="px-4 py-3 border-t border-slate-100 flex items-center justify-between gap-2 bg-slate-50/60 flex-wrap">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setScheduleOpen((v) => !v)}
                      className={cn(
                        "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium border transition-colors",
                        scheduleOpen
                          ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                          : "bg-white text-ink/65 border-slate-200 hover:text-ink hover:border-slate-300"
                      )}
                      title="Schedule this email instead of sending now"
                    >
                      <Clock className="w-3 h-3" />
                      {scheduleOpen ? "Scheduled" : "Schedule send"}
                    </button>
                    {scheduleOpen && (
                      <input
                        type="datetime-local"
                        value={sendAtLocal}
                        onChange={(e) => setSendAtLocal(e.target.value)}
                        className="text-[11px] bg-white border border-slate-200 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
                        min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                      />
                    )}
                  </div>

                  <div className="flex items-center gap-2 ml-auto">
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
                      {busy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : scheduleOpen ? (
                        <Clock className="w-3.5 h-3.5" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      {busy
                        ? scheduleOpen ? "Scheduling…" : "Sending…"
                        : scheduleOpen ? "Schedule" : "Send"}
                    </button>
                  </div>
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
