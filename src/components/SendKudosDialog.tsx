"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Sparkles, X, Send } from "lucide-react";
import { toast } from "sonner";
import { PersonAvatar } from "./PersonAvatar";

const PRESET_MESSAGES = [
  "Amazing work!",
  "You're killing it 🔥",
  "MVP move",
  "Thanks for the help",
  "Saved my life",
  "Crushed it",
  "Lifesaver 🙏",
  "🚀 keep it going"
];

const PRESET_EMOJIS = ["👏", "🎉", "🔥", "🚀", "💯", "🏆", "⭐️", "🙌"];

export function SendKudosDialog({
  trigger, recipientId, recipientName, recipientAvatarUrl
}: {
  trigger: React.ReactNode;
  recipientId: string;
  recipientName: string;
  recipientAvatarUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [emoji, setEmoji] = useState("👏");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setMessage("");
    setEmoji("👏");
  }

  async function send() {
    if (submitting) return;
    const trimmed = message.trim();
    if (!trimmed) {
      toast.error("Write a message first.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/kudos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toUserId: recipientId, message: trimmed, emoji })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const firstName = recipientName.split(" ")[0];
      if (data.slackDm === "sent") {
        toast.success(`${emoji} Kudos sent to ${firstName} — also DM'd them on Slack`);
      } else if (data.slackNote) {
        // Sent OK but Slack DM didn't go through. Surface the reason
        // so the sender can connect Slack or check spelling.
        toast.success(`${emoji} Kudos sent to ${firstName}`, {
          description: data.slackNote
        });
      } else {
        toast.success(`${emoji} Kudos sent to ${firstName}!`);
      }
      setOpen(false);
      reset();
    } catch (e) {
      toast.error(`Couldn't send: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 anim-fade-in" />
        {/* Pointer-transparent flex shell so the inner card centers over
            the main content panel (sidebar reserved on lg+) without ever
            overflowing the viewport. */}
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
        >
          <div className="pointer-events-auto w-full max-w-[480px] max-h-[calc(100vh-3rem)] overflow-y-auto rounded-3xl border border-slate-200/70 bg-white shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] anim-fade-in-up">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 ring-1 ring-amber-200/70 grid place-items-center text-amber-600">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-semibold">Send kudos</Dialog.Title>
                <Dialog.Description className="text-xs text-muted">
                  Pops up on their desktop widget the next time they're online.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button className="w-8 h-8 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-slate-100 transition-colors" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="p-6 space-y-4">
            <div className="flex items-center gap-3 rounded-2xl bg-slate-50 border border-slate-200/70 px-4 py-3">
              <PersonAvatar userId={recipientId} name={recipientName} imageUrl={recipientAvatarUrl ?? undefined} size={36} />
              <div className="text-sm">
                <div className="text-muted text-[11px] uppercase tracking-wide">To</div>
                <div className="font-semibold text-ink">{recipientName}</div>
              </div>
            </div>

            <div>
              <label className="label">Message</label>
              <textarea
                autoFocus
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 280))}
                placeholder="Amazing work, you're killing it…"
                rows={3}
                className="input resize-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {PRESET_MESSAGES.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setMessage(preset)}
                    className="text-[12px] px-2.5 py-1 rounded-full bg-slate-50 border border-slate-200 hover:border-accent/40 hover:bg-accent/5 transition-colors"
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-muted mt-1.5 text-right">
                {message.length}/280
              </div>
            </div>

            <div>
              <label className="label">Emoji</label>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setEmoji(e)}
                    className={
                      "w-9 h-9 grid place-items-center rounded-xl text-xl transition-all " +
                      (emoji === e
                        ? "bg-accent/10 ring-1 ring-accent/40"
                        : "hover:bg-slate-100")
                    }
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <button className="btn">Cancel</button>
              </Dialog.Close>
              <button
                onClick={send}
                disabled={submitting || !message.trim()}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-3.5 h-3.5" />
                {submitting ? "Sending…" : "Send kudos"}
              </button>
            </div>
          </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
