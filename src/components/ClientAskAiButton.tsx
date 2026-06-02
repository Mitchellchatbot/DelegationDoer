"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { AIAssistantDrawer } from "./AIAssistantDrawer";

// Per-client entry point for the Ask AI drawer, rendered in a client's
// detail-page header. Opens the same drawer the sidebar uses, but passes
// a client context so the drawer is branded to this client and each turn
// scopes the assistant's answers + tool calls to it (see /api/ai/chat).
// Permissions are unchanged — the API still enforces server-side scoping.
export function ClientAskAiButton({
  clientId, clientName, iconUrl
}: {
  clientId: string;
  clientName: string;
  iconUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-medium border border-white/70 bg-white/80 text-ink hover:bg-white transition-colors shadow-sm"
      >
        <Sparkles className="w-3.5 h-3.5 text-fuchsia-500" />
        Ask AI
      </button>
      <AIAssistantDrawer
        open={open}
        onOpenChange={setOpen}
        client={{ id: clientId, name: clientName, iconUrl }}
      />
    </>
  );
}
