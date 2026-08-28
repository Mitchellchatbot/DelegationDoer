"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Copy, Link2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// "New onboarding link" — the button Sam and Mujtaba actually came for.
//
// Type the business name, pick the form, get a link to send. The client row is
// created at the same moment, so a client we have started onboarding shows up on
// /clients immediately rather than only once they finish answering.
//
// The link is shown once, here, with a copy button — and never rendered into the
// clients list. A screen-share of this page should not put every client's form
// link on somebody's recording.

interface Props {
  /** Only the forms this user is allowed to send. A department head sees one
   *  option and no menu; a leader sees both. */
  forms: { key: string; label: string }[];
}

export function NewOnboardingLinkButton({ forms }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [formKey, setFormKey] = useState(forms[0]?.key ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!forms.length) return null;

  function reset() {
    setName("");
    setFormKey(forms[0]?.key ?? "");
    setUrl(null);
    setCopied(false);
  }

  function close() {
    setOpen(false);
    reset();
    // Only when a link was actually made — the new client needs to appear in
    // the list behind this dialog.
    if (url) router.refresh();
  }

  async function submit() {
    if (!name.trim() || !formKey || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/clients/onboarding-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formKey, name: name.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "failed");
      setUrl(data.url as string);
      toast.success(`${data.link.clientName} created — send them the link`);
    } catch (err) {
      toast.error(`Couldn't create that: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — select the link and copy it by hand.");
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-slate-200 text-ink/75 hover:text-accent hover:border-accent/40 transition-colors"
      >
        <Link2 className="w-3.5 h-3.5" />
        New onboarding link
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 lg:pl-[264px] bg-black/30 backdrop-blur-sm"
          onClick={close}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-lift border border-border w-full max-w-md overflow-hidden animate-rise"
          >
            <header className="flex items-center justify-between px-5 pt-5 pb-3">
              <h2 className="text-base font-semibold">New onboarding link</h2>
              <button onClick={close} className="text-muted hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </header>

            {url ? (
              // The link, once. Shown rather than emailed because who sends it,
              // and how, is the head's call — some go by email, some get pasted
              // into a WhatsApp thread the client already replies in.
              <div className="px-5 pb-5 space-y-3">
                <p className="text-[12.5px] text-ink/65 leading-relaxed">
                  Send this to your client. It needs no login and saves as they go, so they can stop
                  and come back to it.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="input flex-1 text-[12px] font-mono"
                  />
                  <button
                    onClick={copy}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium shrink-0 transition-colors",
                      copied
                        ? "bg-ok/10 text-ok border border-ok/30"
                        : "bg-white border border-border text-ink/70 hover:text-ink"
                    )}
                  >
                    {copied ? <ClipboardCheck className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="flex justify-end pt-1">
                  <button onClick={close} className="btn">Done</button>
                </div>
              </div>
            ) : (
              <>
                <div className="px-5 pb-1 space-y-4">
                  <label className="block">
                    <span className="text-xs text-muted">Client / business name</span>
                    <input
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                      placeholder="e.g. Acme Recovery"
                      className="input mt-1"
                    />
                    <span className="text-[11px] text-ink/45 mt-1 block">
                      Creates the client too — their answers fill in the rest of the record when they
                      finish.
                    </span>
                  </label>

                  {forms.length > 1 ? (
                    <div>
                      <span className="text-xs text-muted">Which form?</span>
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        {forms.map((f) => {
                          const on = formKey === f.key;
                          return (
                            <button
                              key={f.key}
                              type="button"
                              onClick={() => setFormKey(f.key)}
                              aria-pressed={on}
                              className={cn(
                                "text-[12.5px] font-medium px-3.5 py-1.5 rounded-full border transition-all",
                                on
                                  ? "text-white border-transparent shadow-sm"
                                  : "bg-white text-ink/70 border-border hover:text-ink hover:border-accent/30"
                              )}
                              style={on ? { background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" } : undefined}
                            >
                              {f.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="text-[12px] text-ink/60">
                      Sending the <span className="font-medium text-ink">{forms[0].label}</span> form.
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-2 px-5 py-4 border-t border-border mt-4">
                  <button onClick={close} className="btn">Cancel</button>
                  <button
                    onClick={submit}
                    disabled={submitting || !name.trim()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-sm font-medium text-white shadow-sm disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
                  >
                    {submitting ? "Creating…" : "Create + get link"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
