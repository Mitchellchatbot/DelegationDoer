"use client";

import { useState } from "react";

// "Assess": asks the assistant to run the model on a thread it filtered, or
// couldn't assess (contract §3.14, L18). The one write on the email pages;
// the route checks everything again, audits it and queues one triage job.
// This only reports what the route said, in plain words: the result arrives
// on the page with the job, so he refreshes to see it.

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "queued" } | { kind: "error"; message: string };

/** The route's answer as words; `code` is its `error` field, when it sent one. Exported for tests. */
export function assessMessage(status: number, code: string | null = null): string {
  switch (status) {
    case 202:
      return "Queued. The assessment runs within a minute or so; refresh to see it.";
    case 409:
      if (code === "account_unusable") return "Its mailbox connection needs attention, so it can't be assessed until the team fixes it.";
      return "This thread can't be assessed now: it was assessed already, or its state changed. Refresh the page.";
    case 429:
      return "Too many assessments in the last few minutes. Try again shortly.";
    case 404:
      return "This thread isn't available any more.";
    default:
      return "Couldn't queue the assessment. Try again in a moment.";
  }
}

/** The `error` code of a refusal's JSON body, or null when there is none to read. */
export async function errorCode(res: Pick<Response, "json">): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const code = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export function assessPath(threadId: string): string {
  return `/api/exec/email/threads/${encodeURIComponent(threadId)}/assess`;
}

export function AssessButton({ threadId, size = "sm" }: { threadId: string; size?: "sm" | "md" }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function assess() {
    if (status.kind === "sending" || status.kind === "queued") return;
    setStatus({ kind: "sending" });
    try {
      const res = await fetch(assessPath(threadId), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      if (res.status === 202) {
        setStatus({ kind: "queued" });
        return;
      }
      setStatus({ kind: "error", message: assessMessage(res.status, await errorCode(res)) });
    } catch {
      setStatus({ kind: "error", message: assessMessage(0) });
    }
  }

  const button =
    size === "md"
      ? "rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
      : "rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11.5px] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-60";

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <button type="button" onClick={assess} disabled={status.kind === "sending" || status.kind === "queued"} className={button}>
        {status.kind === "sending" ? "Queuing…" : status.kind === "queued" ? "Queued" : "Assess"}
      </button>
      {/* P9 F27: the status line stays mounted (empty until there is something to say), so "Queued" is announced. */}
      <span role="status" aria-live="polite" data-assess-status className={status.kind === "queued" ? "text-[11.5px] text-emerald-700" : "sr-only"}>
        {status.kind === "queued" ? assessMessage(202) : ""}
      </span>
      {status.kind === "error" && (
        <span role="alert" className="text-[11.5px] text-rose-700">
          {status.message}
        </span>
      )}
    </span>
  );
}
