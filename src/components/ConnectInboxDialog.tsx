"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plug, X, ChevronRight } from "lucide-react";

// "Connect inbox" dialog — Microsoft OAuth only. Per Mitchell's
// directive we no longer offer Gmail or Custom IMAP since 99% of the
// team is on Microsoft 365 and the basic-auth IMAP path was a
// foot-gun (M365 disables IMAP by default and the form looked
// intimidating). One button, one redirect, one happy path.

export function ConnectInboxDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>

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
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="pointer-events-auto w-[460px] max-w-[92vw] rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)]"
              >
                <header
                  className="px-5 py-3 flex items-center justify-between border-b border-slate-100"
                  style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 100%)" }}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-xl bg-white/70 border border-white/80 grid place-items-center">
                      <Plug className="w-4 h-4 text-accent" />
                    </div>
                    <div>
                      <Dialog.Title className="text-sm font-semibold">Connect inbox</Dialog.Title>
                      <div className="text-[11px] text-ink/55">
                        Sign in with Microsoft to link your Outlook / 365 mailbox
                      </div>
                    </div>
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

                <div className="p-5 space-y-4">
                  <a
                    href="/api/inboxes/oauth/microsoft/redirect"
                    className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-slate-200 bg-white hover:border-accent/50 hover:bg-blue-50/40 hover:shadow-sm transition-all group"
                  >
                    <span className="w-10 h-10 rounded-xl bg-[#0078D4]/10 grid place-items-center shrink-0">
                      {/* Microsoft 4-square mark. */}
                      <svg viewBox="0 0 21 21" className="w-5 h-5" aria-hidden>
                        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">Continue with Microsoft</div>
                      <div className="text-[11px] text-ink/55 mt-0.5">
                        Outlook / Microsoft 365 — your tenant&apos;s sign-in window opens next
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-ink/40 group-hover:text-accent transition-colors shrink-0" />
                  </a>

                  <p className="text-[11px] text-ink/50 leading-relaxed px-1">
                    You&apos;ll be redirected to Microsoft to authorize DelegationDoer.
                    We only request mailbox read + send scopes; you can disconnect
                    anytime from the Your Inboxes section.
                  </p>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
