"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Sparkles, Send, X } from "lucide-react";
import { useState } from "react";
import { currentUser, tickets } from "@/lib/mock-data";
import { RaiseLink } from "./RaiseLink";

interface Message { role: "user" | "assistant"; content: string }

const SUGGESTED = [
  "What do I have today?",
  "Who should I assign a schema markup audit to?",
  "What's blocking the Acme refresh?",
  "Summarise this week's progress"
];

export function AIAssistantDrawer({
  open, onOpenChange
}: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const next: Message[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, { role: "assistant", content: `⚠ couldn't reach Claude — ${data?.error ?? res.statusText}` }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.reply ?? "(no reply)" }]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setMessages((m) => [...m, { role: "assistant", content: `⚠ couldn't reach Claude — ${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed right-0 top-0 bottom-0 z-50 w-[420px] bg-bg border-l border-border flex flex-col">
          <div className="h-14 border-b border-border px-4 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent" />
            <div className="text-sm">AI assistant</div>
            <div className="text-xs text-muted ml-2">claude-sonnet-4-6</div>
            <Dialog.Close className="ml-auto btn p-1.5"><X className="w-3.5 h-3.5" /></Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div>
                <div className="text-xs text-muted mb-2">Suggested</div>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTED.map((s) => (
                    <button key={s} onClick={() => send(s)} className="text-left text-sm px-3 py-2 rounded-xl border border-border bg-surface hover:bg-surface2">
                      {s}
                    </button>
                  ))}
                </div>
                <div className="mt-4 p-3 rounded-xl border border-border bg-surface2 text-[11px] text-muted">
                  Context loaded: {currentUser.name}, {tickets.filter((t) => t.assigneeId === currentUser.id && t.status !== "done").length} open tickets, {tickets.filter((t) => t.inactiveFlag).length} stalled.
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "ml-8" : "mr-8"}>
                <div className={"text-[11px] text-muted mb-1 " + (m.role === "user" ? "text-right" : "")}>{m.role === "user" ? "You" : "Claude"}</div>
                <div className={"text-sm p-3 rounded-2xl border whitespace-pre-wrap " + (m.role === "user" ? "bg-accent/10 border-accent/30 text-ink" : "bg-surface border-border")}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="mr-8">
                <div className="text-[11px] text-muted mb-1">Claude</div>
                <div className="text-sm p-3 rounded-2xl border bg-surface border-border text-muted animate-pulse">
                  thinking…
                </div>
              </div>
            )}
          </div>

          <div className="p-3 border-t border-border">
            <div className="flex items-center gap-2">
              <input className="input" placeholder={loading ? "Claude is thinking…" : "Ask anything…"} value={input}
                disabled={loading}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !loading && send()} />
              <button className="btn-primary disabled:opacity-50" disabled={loading || !input.trim()} onClick={() => send()}>
                <Send className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-2"><RaiseLink /></div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
