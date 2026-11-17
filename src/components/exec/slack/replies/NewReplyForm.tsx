"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { useIsTopWindow } from "../../drafts/frame-guard";
import { createRefusalText, REPLY_UI_COPY } from "./reply-logic";

// The new-reply form (P10 contract §3.5.13, C45, C51; Area D). Client island: his optional instruction (his words, sent as
// typed), then "Draft reply" → POST /api/exec/slack/replies { channelId, ts, itemId: "", instruction, fromDraftId: "" } and,
// on 201 / 200, the draft's page. The message's channel and ts come from the page's own URL (the route re-checks both); no
// field names a destination. No GET creates anything: only this button does. Nothing in a framed page.

const COPY = SLACK_P10_COPY.replies;

export function NewReplyForm({ channelId, ts }: { channelId: string; ts: string }) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/exec/slack/replies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, ts, itemId: "", instruction, fromDraftId: "" })
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if ((res.status === 201 || res.status === 200) && typeof body.href === "string") {
        router.push(body.href);
        return;
      }
      const code = typeof body.error === "string" ? body.error : "other";
      setError(res.status === 429 ? createRefusalText("rate_limited") : createRefusalText(code));
    } catch {
      setError(REPLY_UI_COPY.failed);
    } finally {
      setBusy(false);
    }
  };

  if (!isTop) return <p data-reply-framed className="text-[12px] text-slate-600">{COPY.framed}</p>;
  return (
    <form
      data-reply-new
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label htmlFor="reply-instruction" className="block text-[12.5px] font-semibold text-slate-800">
        {COPY.instructionLabel}
      </label>
      <textarea
        id="reply-instruction"
        data-reply-instruction
        value={instruction}
        maxLength={2000}
        rows={3}
        onChange={(e) => setInstruction(e.target.value)}
        aria-describedby="reply-instruction-help"
        className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
      />
      <p id="reply-instruction-help" className="text-[12px] text-slate-600">{COPY.instructionHelp}</p>
      <p role="alert" data-reply-new-error className={error !== null ? "rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-[12.5px] text-rose-800" : "sr-only"}>
        {error ?? ""}
      </p>
      <button
        type="submit"
        data-reply-create
        disabled={busy}
        className="inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 sm:min-h-0"
      >
        {busy ? COPY.generating : COPY.create}
      </button>
    </form>
  );
}
