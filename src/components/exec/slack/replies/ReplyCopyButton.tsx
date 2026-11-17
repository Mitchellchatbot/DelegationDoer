"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { cn } from "@/lib/utils";

// Copy (P10 contract §3.5.13, C38, v1.1 product-15; Area D): navigator.clipboard.writeText of the text it is handed (the
// stored text, or the textarea's text while it differs from it: textToCopy). "Copied" for 2 s, announced by a polite status.
// The text is a prop passed to the click handler only, never written into the markup or an attribute.

const COPY = SLACK_P10_COPY.replies;

export function ReplyCopyButton({ text, disabled = false, className }: { text: string; disabled?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        data-reply-copy
        disabled={disabled || text.length === 0}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
        }}
        className={cn(
          "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-slate-50 disabled:opacity-60 sm:min-h-0",
          className
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied ? COPY.copied : COPY.copy}
      </button>
      <span role="status" className="sr-only">
        {copied ? COPY.copied : ""}
      </span>
    </>
  );
}
