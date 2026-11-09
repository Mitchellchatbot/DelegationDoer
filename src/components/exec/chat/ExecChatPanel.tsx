"use client";

import { createPortal } from "react-dom";
import { CHAT_CLIENT_STARTERS, CHAT_CLIENT_STARTERS_NO_EMAIL, CHAT_STARTERS, DRAWER_SUBTITLE, DRAWER_SUBTITLE_NO_EMAIL } from "@/lib/exec/chat/copy";
import { ExecChat } from "./ExecChat";

// The Ask AI drawer's body when the owner routes it through the assistant
// (P5b contract §3.19.10, B10, C32). The drawer imports this file only
// through one next/dynamic import with ssr off, and only when the server's
// routing signal is true, so no other browser downloads it, and everything
// that names the assistant lives here, not in the shared drawer file.
//
// Opened on a client page, the conversation starts with that client as its
// context (the label shows only in the chip, never in his question text) and
// the starters name no client (b-security-12): the context ref carries who
// it is. No times are shown here (tz null). The drawer's header keeps its
// title; this panel writes its subtitle into the slot the header leaves.

export interface ExecChatPanelProps {
  client?: { id: string; name: string; iconUrl?: string | null } | null;
  /** The drawer header's subtitle element, when it has rendered. */
  subtitleSlot?: HTMLElement | null;
  /** ui-10: whether a tool can read his mailbox; when false the subtitle and starters don't claim it. Omitted: true. */
  emailOn?: boolean;
}

const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

export default function ExecChatPanel({ client = null, subtitleSlot = null, emailOn = true }: ExecChatPanelProps) {
  const scoped = client !== null && typeof client.id === "string" && CLIENT_ID.test(client.id) ? client : null;
  const clientStarters = emailOn ? CHAT_CLIENT_STARTERS : CHAT_CLIENT_STARTERS_NO_EMAIL;
  return (
    <>
      {subtitleSlot ? createPortal(emailOn ? DRAWER_SUBTITLE : DRAWER_SUBTITLE_NO_EMAIL, subtitleSlot) : null}
      <ExecChat
        variant="drawer"
        initialConversation={null}
        initialMessages={[]}
        initialContext={scoped ? { kind: "client", id: scoped.id, label: scoped.name } : null}
        starters={scoped ? clientStarters : CHAT_STARTERS}
        tz={null}
        nowIso={null}
        emailOn={emailOn}
      />
    </>
  );
}
