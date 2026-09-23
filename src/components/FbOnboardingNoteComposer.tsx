"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// One-line note box on an onboarding list card, so a quick note doesn't need
// the side panel. Posts to the task's conversation — the same thread the
// panel, the workspace and the task page show. @-mentions live in the panel;
// this is deliberately just text.
export function FbOnboardingNoteComposer({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      setText("");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't post the note");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        placeholder="Add a note…"
        disabled={sending}
        className="input py-1.5 text-xs"
      />
      <button
        type="button"
        onClick={send}
        disabled={sending || !text.trim()}
        title="Post note"
        className={cn(
          "shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-xl transition-colors",
          text.trim() ? "bg-accent text-white hover:bg-accent/90" : "bg-surface2 text-muted"
        )}
      >
        {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
