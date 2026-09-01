"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { AIAssistantDrawer } from "./AIAssistantDrawer";

// Global bottom-right launcher for the AI assistant. Mounted once in
// (main)/layout.tsx so it's available on every page — the founder can ask
// operational questions ("what's overdue for Villa?", "who has capacity for a
// design task?", "draft a task for X") from anywhere.
//
// Reuses the existing AIAssistantDrawer + /api/ai/chat (tool-using) rather
// than a second chatbot. The drawer is controlled, so this owns its own open
// state — mirroring the other per-surface mounts (ClientAskAiButton, /sops).
// ⌘K still toggles the sidebar's instance; this is the always-visible tap
// target. The drawer's overlay is z-50 and covers this z-40 button when open,
// so there's no need to hide it manually.
export function AIAssistantFab() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask AI — operational assistant"
        title="Ask AI"
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full pl-4 pr-5 py-3 text-white text-sm font-semibold shadow-[0_10px_30px_-8px_rgba(10,64,153,0.6)] transition-all hover:-translate-y-0.5 hover:shadow-[0_16px_40px_-8px_rgba(10,64,153,0.7)] active:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
        style={{ background: "linear-gradient(135deg,#0a4099 0%,#063270 100%)" }}
      >
        <Sparkles className="w-4 h-4" />
        <span className="hidden sm:inline">Ask AI</span>
      </button>
      <AIAssistantDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}
