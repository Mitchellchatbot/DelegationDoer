"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { MessageSquarePlus, X, Loader2, Send } from "lucide-react";
import type { Conversation } from "./CustomerSupportInbox";

// "New message" affordance on the customer-support inbox. Opens a small modal to
// start a thread with a number that hasn't texted us — until this existed, every
// thread had to begin with an inbound text.
//
// Submit hits POST /api/support/conversations. Failures stay in the modal (an
// inline strip, not a toast) so a mistyped number can be fixed without retyping
// the message; success closes and hands the result to the parent, which owns the
// list/selection and therefore the toast. The parent is client-state, so there's
// deliberately no router.refresh() here — it would silently do nothing.
//
// Phone validation is the route's job (normalizeE164). Duplicating it here would
// give us two rules to keep in sync and a second place to be wrong.

export interface ComposeResult {
  // null when the text sent but couldn't be persisted — see the route's
  // `degraded` branch. There's no thread to open in that case.
  conversationId: string | null;
  conversation: Conversation | null;
  isNew: boolean;
  // The thread existed and was closed; the send re-opened it.
  reopened: boolean;
  degraded?: boolean;
}

export function ComposeSmsButton({ onSent }: { onSent: (r: ComposeResult) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = phone.trim().length > 0 && text.trim().length > 0 && !busy;

  function reset() {
    setPhone("");
    setName("");
    setText("");
    setError(null);
  }

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/support/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: phone.trim(),
          contactName: name.trim() || undefined,
          text: text.trim()
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setOpen(false);
      reset();
      // Deliberately not awaited: the modal closes immediately and the parent
      // owns the refresh (and catches its own errors). Awaiting here would hold
      // the dialog open on a spinner for work the operator doesn't need to watch.
      void onSent({
        conversationId: data.conversationId ?? null,
        conversation: data.conversation ?? null,
        isNew: Boolean(data.isNew),
        reopened: Boolean(data.reopened),
        degraded: Boolean(data.degraded)
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <Dialog.Trigger asChild>
        <button
          className="text-ink/40 hover:text-teal-700 transition-colors"
          title="New message"
          aria-label="New message"
        >
          <MessageSquarePlus className="w-4 h-4" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white shadow-soft focus:outline-none">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
            <Dialog.Title className="text-[16px] font-semibold text-ink">New message</Dialog.Title>
            <Dialog.Close asChild>
              <button className="text-ink/45 hover:text-ink/80 transition-colors" aria-label="Close">
                <X className="w-4.5 h-4.5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-3.5">
            <label className="block">
              <span className="text-[12px] font-medium text-ink/65">Phone</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 512 555 0100"
                inputMode="tel"
                autoFocus
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-ink placeholder:text-ink/35 focus:border-teal-300 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-[12px] font-medium text-ink/65">Name (optional)</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-ink placeholder:text-ink/35 focus:border-teal-300 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-[12px] font-medium text-ink/65">Message</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter sends — same shortcut as the thread's ReplyBox.
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Type a message…  (⌘/Ctrl+Enter to send)"
                rows={4}
                className="mt-1 w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-[14px] text-ink placeholder:text-ink/35 focus:border-teal-300 focus:outline-none"
              />
            </label>

            {error && (
              <div className="rounded-xl border border-rose-200/60 bg-rose-50/60 px-3 py-2 text-[12.5px] text-rose-900">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100">
            <Dialog.Close asChild>
              <button className="px-3.5 py-2 rounded-xl text-[13.5px] font-medium text-ink/65 hover:bg-slate-100 transition-colors">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13.5px] font-medium bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
