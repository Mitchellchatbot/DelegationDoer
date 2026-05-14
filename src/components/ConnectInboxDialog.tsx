"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Plug, X, Loader2, ChevronDown, Mail } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// "Connect inbox" dialog — Leader-only affordance that proxies a new
// account create request through to the Missive clone. Two preset
// providers (Gmail / Outlook) handle the common case; "Custom IMAP"
// reveals the full host/port/credentials fieldset for everything else.

type Provider = "gmail" | "outlook" | "imap";

const PRESETS: Record<Provider, { imap: { host: string; port: number }; smtp: { host: string; port: number } } | null> = {
  gmail:   { imap: { host: "imap.gmail.com",   port: 993 }, smtp: { host: "smtp.gmail.com",   port: 465 } },
  outlook: { imap: { host: "outlook.office365.com", port: 993 }, smtp: { host: "smtp.office365.com", port: 587 } },
  imap:    null
};

export function ConnectInboxDialog({ trigger }: { trigger: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<Provider>("gmail");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState<number>(993);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState<number>(465);
  const [password, setPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);

  function reset() {
    setEmail("");
    setDisplayName("");
    setProvider("gmail");
    setImapHost("");
    setImapPort(993);
    setSmtpHost("");
    setSmtpPort(465);
    setPassword("");
    setAdvanced(false);
  }

  async function submit() {
    if (!email.trim()) {
      toast.error("Email required");
      return;
    }
    if (!password.trim()) {
      toast.error("Password required");
      return;
    }
    const preset = PRESETS[provider];
    const effImapHost = preset?.imap.host ?? imapHost.trim();
    const effImapPort = preset?.imap.port ?? imapPort;
    const effSmtpHost = preset?.smtp.host ?? smtpHost.trim();
    const effSmtpPort = preset?.smtp.port ?? smtpPort;
    if (!effImapHost || !effSmtpHost) {
      toast.error("Custom provider requires IMAP + SMTP host");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/inboxes/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          displayName: displayName.trim() || email.trim(),
          provider,
          imapHost: effImapHost,
          imapPort: effImapPort,
          imapUser: email.trim(),
          imapPassword: password,
          smtpHost: effSmtpHost,
          smtpPort: effSmtpPort,
          smtpUser: email.trim(),
          smtpPassword: password
        })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't connect inbox");
        return;
      }
      toast.success(
        <div className="text-sm">
          <div className="font-medium">Inbox connected 🎉</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            {data.account?.email ?? email} is syncing
          </div>
        </div>
      );
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
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
              {/* lg:pl-[264px] = 12px outer p-3 + 240px sidebar + 12px gap.
                  Centers the card over the main content panel so it doesn't
                  sit half-under the sidebar on lg+ screens. Same trick as
                  the New Task dialog. */}
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
                className="pointer-events-auto w-[560px] max-w-[92vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200/70 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.35)]"
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
                        Link a mailbox so the team can read + reply from DelegationDoer
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

                <div className="p-4 space-y-3">
                  {/* Microsoft OAuth (preferred for Microsoft 365 / Outlook
                      tenants — basic-auth IMAP is disabled on most tenants
                      now). Full top-level redirect: server-side route
                      asks Missive for the authorize URL and 302s the
                      browser to Microsoft. */}
                  <a
                    href="/api/inboxes/oauth/microsoft/redirect"
                    className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white hover:border-accent/40 hover:bg-blue-50/30 transition-colors group"
                  >
                    <span className="w-8 h-8 rounded-lg bg-[#0078D4]/10 grid place-items-center shrink-0">
                      {/* Microsoft logo, simple 4-square mark. */}
                      <svg viewBox="0 0 21 21" className="w-4 h-4" aria-hidden>
                        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">Continue with Microsoft</div>
                      <div className="text-[11px] text-ink/55">
                        Outlook / Microsoft 365 — recommended
                      </div>
                    </div>
                    <ChevronDown className="w-4 h-4 -rotate-90 text-ink/40 group-hover:text-accent transition-colors shrink-0" />
                  </a>

                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-slate-200/70" />
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-ink/40">
                      or with password
                    </span>
                    <div className="flex-1 h-px bg-slate-200/70" />
                  </div>

                  {/* Provider segmented control. */}
                  <div>
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45 px-1 mb-1.5">
                      Provider
                    </div>
                    <div className="inline-flex w-full rounded-xl bg-slate-100 p-1">
                      {(["gmail", "outlook", "imap"] as Provider[]).map((p) => {
                        const active = provider === p;
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setProvider(p)}
                            className={cn(
                              "flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                              active ? "bg-white shadow-sm text-ink" : "text-ink/55 hover:text-ink"
                            )}
                          >
                            {p === "gmail" ? "Gmail" : p === "outlook" ? "Outlook" : "Custom IMAP"}
                          </button>
                        );
                      })}
                    </div>
                    {provider === "gmail" && (
                      <p className="text-[11px] text-ink/55 mt-1.5 px-1">
                        Gmail requires an <strong>App Password</strong> (not your regular password).
                        Generate one at <code className="text-[10px] bg-slate-100 px-1 rounded">myaccount.google.com/apppasswords</code>.
                      </p>
                    )}
                  </div>

                  <Field label="Email">
                    <input
                      autoFocus
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="support@yourcompany.com"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </Field>

                  <Field label="Label">
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Display name (optional)"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </Field>

                  <Field label="Password">
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={provider === "gmail" ? "16-char app password" : "Mailbox password"}
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    />
                  </Field>

                  {provider === "imap" && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-2 pt-1"
                    >
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="IMAP host">
                          <input
                            type="text"
                            value={imapHost}
                            onChange={(e) => setImapHost(e.target.value)}
                            placeholder="imap.example.com"
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                          />
                        </Field>
                        <Field label="Port">
                          <input
                            type="number"
                            value={imapPort}
                            onChange={(e) => setImapPort(Number(e.target.value) || 993)}
                            className="flex-1 bg-transparent text-sm outline-none tabular-nums"
                          />
                        </Field>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="SMTP host">
                          <input
                            type="text"
                            value={smtpHost}
                            onChange={(e) => setSmtpHost(e.target.value)}
                            placeholder="smtp.example.com"
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                          />
                        </Field>
                        <Field label="Port">
                          <input
                            type="number"
                            value={smtpPort}
                            onChange={(e) => setSmtpPort(Number(e.target.value) || 465)}
                            className="flex-1 bg-transparent text-sm outline-none tabular-nums"
                          />
                        </Field>
                      </div>
                    </motion.div>
                  )}

                  {provider !== "imap" && (
                    <button
                      type="button"
                      onClick={() => setAdvanced((v) => !v)}
                      className="text-[11px] text-ink/55 hover:text-ink inline-flex items-center gap-1 transition-colors"
                    >
                      <ChevronDown className={cn("w-3 h-3 transition-transform", advanced && "rotate-180")} />
                      Advanced server settings
                    </button>
                  )}
                </div>

                <footer className="px-4 py-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/60">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors"
                    >
                      Cancel
                    </button>
                  </Dialog.Close>
                  <button
                    type="button"
                    onClick={submit}
                    disabled={busy}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95",
                      busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
                    )}
                    style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
                    {busy ? "Connecting…" : "Connect"}
                  </button>
                </footer>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/45 px-1 mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
        {children}
      </div>
    </div>
  );
}
