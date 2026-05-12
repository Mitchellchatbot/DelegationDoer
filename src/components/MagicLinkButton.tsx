"use client";

// Per-user "Magic link" affordance for the Leader Console's People
// tab. Click → calls /api/users/[id]/magic-link → opens a small
// popover with the freshly-minted link + a Copy button + a status
// note about whether the Slack DM landed.

import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { Link2, Copy, Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";

export function MagicLinkButton({
  userId, userName, userEmail
}: {
  userId: string;
  userName: string;
  userEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    magicLink: string;
    slackDm: "sent" | "skipped" | "failed";
  } | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (busy || result) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}/magic-link`, {
        method: "POST"
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? "couldn't generate link");
        setOpen(false);
        return;
      }
      setResult({
        magicLink: data.magicLink,
        slackDm: data.slackDm ?? "skipped"
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result?.magicLink) return;
    try {
      await navigator.clipboard.writeText(result.magicLink);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Clipboard unavailable — select and copy manually");
    }
  }

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (v && !result && !busy) generate();
    if (!v) {
      // Reset state so the next click generates a *fresh* link.
      setResult(null);
      setCopied(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border border-blue-200 bg-blue-50/60 text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition-colors active:scale-95"
          title={`Generate a fresh sign-in link for ${userName}`}
        >
          <Link2 className="w-2.5 h-2.5" />
          Magic link
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="left"
          align="center"
          sideOffset={8}
          className="z-50 w-[400px] rounded-2xl border border-slate-200/70 bg-white shadow-[0_20px_50px_-15px_rgba(15,23,42,0.35)] p-3 outline-none"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold inline-flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-blue-600" />
                Sign-in link for {userName}
              </div>
              <div className="text-[11px] text-ink/55 truncate mt-0.5">{userEmail}</div>
            </div>
            <Popover.Close asChild>
              <button className="p-0.5 rounded text-ink/50 hover:text-ink hover:bg-slate-100">
                <X className="w-3.5 h-3.5" />
              </button>
            </Popover.Close>
          </div>

          {busy ? (
            <div className="py-3 text-center text-[12px] text-ink/55 inline-flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Generating…
            </div>
          ) : result ? (
            <>
              <div className="text-[11px] mb-1.5">
                {result.slackDm === "sent" && (
                  <span className="text-emerald-700">✓ Slack-DMed them</span>
                )}
                {result.slackDm === "failed" && (
                  <span className="text-amber-700">Slack DM failed — share below</span>
                )}
                {result.slackDm === "skipped" && (
                  <span className="text-ink/55">Slack DM not configured — share below</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={result.magicLink}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-[11px] font-mono outline-none focus:ring-2 focus:ring-blue-300/50"
                />
                <button
                  type="button"
                  onClick={copy}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-colors active:scale-95"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="text-[10px] text-ink/50 mt-2 leading-snug">
                One-time use, expires in about an hour. Close and click again to mint a new one.
              </div>
            </>
          ) : (
            <div className="text-[12px] text-ink/55">No link yet.</div>
          )}
          <Popover.Arrow className="fill-white" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
