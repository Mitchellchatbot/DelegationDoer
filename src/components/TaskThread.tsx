"use client";

import { useEffect, useRef, useState } from "react";
import { PersonAvatar } from "./PersonAvatar";
import { Send } from "lucide-react";
import { toast } from "sonner";
import type { User } from "@/lib/types";

interface Message {
  id: string;
  task_id: string;
  user_id: string | null;
  body: string;
  image_url: string | null;
  created_at: string;
}

// Per-task chat thread. Lives separate from activity_logs so noisy
// status_change events don't bury the conversation. Polls every 8s while
// mounted so two people on the same task see each other's replies.
export function TaskThread({
  taskId, users, currentUserId
}: {
  taskId: string;
  users: User[];
  currentUserId: string;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages ?? []);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft("");
    try {
      const res = await fetch(`/api/tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error ?? `failed (${res.status})`);
      }
      await load();
    } catch (e) {
      toast.error(`Send failed: ${e instanceof Error ? e.message : "network error"}`);
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  const userOf = (id: string | null) => (id ? users.find((u) => u.id === id) ?? null : null);

  return (
    <div className="space-y-3">
      <div
        ref={scrollerRef}
        className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1"
      >
        {messages === null && (
          <div className="text-xs text-muted">Loading thread…</div>
        )}
        {messages !== null && messages.length === 0 && (
          <div className="text-xs text-muted italic">
            No messages yet — start the conversation.
          </div>
        )}
        {(messages ?? []).map((m) => {
          const u = userOf(m.user_id);
          const mine = m.user_id === currentUserId;
          return (
            <div
              key={m.id}
              className={`flex items-start gap-2 ${mine ? "flex-row-reverse" : ""}`}
            >
              {u && <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={26} />}
              <div className={`max-w-[80%] ${mine ? "items-end text-right" : ""} flex flex-col`}>
                <div className="text-[10px] text-muted">
                  <span className="font-medium text-ink/70">{u?.name ?? "—"}</span>
                  <span className="ml-1.5">{relTime(m.created_at)}</span>
                </div>
                <div
                  className={`mt-0.5 inline-block rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap text-left ${
                    mine
                      ? "bg-gradient-to-br from-blue-500 to-indigo-500 text-white"
                      : "bg-white/70 border border-white/70 text-ink"
                  }`}
                >
                  {m.body}
                </div>
                {m.image_url && (
                  <a href={m.image_url} target="_blank" rel="noreferrer" className="mt-1.5 block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={m.image_url}
                      alt="attachment"
                      className="rounded-xl border border-white/60 max-h-40"
                    />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Send a message…"
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="btn-primary"
        >
          <Send className="w-3.5 h-3.5" />
          {sending ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
