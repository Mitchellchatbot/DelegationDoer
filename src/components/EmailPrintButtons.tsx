"use client";

import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Printer, Download, FileCode, ChevronDown, Loader2 } from "lucide-react";
import type { MissiveMessage } from "@/lib/missive-client";
import {
  printEmails,
  downloadEmails,
  downloadEml,
  downloadThreadEml,
  type EmailPrintContext
} from "@/lib/email-print";

// Print / Save actions for one email or a whole thread. Reused on each message
// card (single message) and on the thread header (all messages). Bodies are
// resolved lazily inside the helpers, so a brief spinner covers the case where a
// deferred body still has to be fetched.
//
//   Print   — browser print dialog (Save-as-PDF from there)
//   Save ▾  — dropdown: "Save as HTML" (self-contained .html, one message or the
//             whole thread) and "Save as EML" (RFC-5322 message that re-opens in
//             a mail client; one message → plain .eml, a thread → multipart/digest).
//
// The menu is portalled (Radix) so it isn't clipped by the message card's
// overflow-hidden. Kept to two buttons — Print + Save — so the action row stays
// on one line in the narrow reading pane.

type Busy = null | "print" | "html" | "eml";

export function EmailPrintButtons({
  messages,
  context,
  size = "sm"
}: {
  messages: MissiveMessage[];
  context: EmailPrintContext;
  // "sm" matches the tiny per-message pills; "md" the thread-header pills.
  size?: "sm" | "md";
}) {
  const [busy, setBusy] = useState<Busy>(null);

  const run = async (kind: Exclude<Busy, null>) => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === "print") await printEmails(messages, context);
      else if (kind === "html") await downloadEmails(messages, context);
      else if (kind === "eml") {
        if (messages.length === 1) await downloadEml(messages[0], context);
        else await downloadThreadEml(messages, context);
      }
    } catch {
      /* best-effort; nothing to surface for a print/download */
    } finally {
      setBusy(null);
    }
  };

  const pill =
    size === "sm"
      ? "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-white/70 border border-border/60 text-ink/70 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm disabled:opacity-50 disabled:pointer-events-none"
      : "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-border text-ink/80 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm disabled:opacity-50 disabled:pointer-events-none";
  const icon = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";
  const spin = icon + " animate-spin";
  const saving = busy === "html" || busy === "eml";

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); run("print"); }}
        disabled={busy !== null}
        className={pill}
        title="Print"
      >
        {busy === "print" ? <Loader2 className={spin} /> : <Printer className={icon} />}
        Print
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            disabled={busy !== null}
            className={pill}
            title="Save this email"
          >
            {saving ? <Loader2 className={spin} /> : <Download className={icon} />}
            Save
            <ChevronDown className={size === "sm" ? "w-2.5 h-2.5 -ml-0.5" : "w-3 h-3 -ml-0.5"} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            onClick={(e) => e.stopPropagation()}
            className="z-50 min-w-[168px] rounded-xl border border-border bg-white p-1 shadow-lift"
          >
            <DropdownMenu.Item
              onSelect={() => run("html")}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-ink/80 outline-none cursor-pointer data-[highlighted]:bg-accent/10 data-[highlighted]:text-accent"
            >
              <Download className="w-3.5 h-3.5" /> Save as HTML
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => run("eml")}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-ink/80 outline-none cursor-pointer data-[highlighted]:bg-accent/10 data-[highlighted]:text-accent"
            >
              <FileCode className="w-3.5 h-3.5" /> Save as EML
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
