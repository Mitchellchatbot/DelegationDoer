"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";

// This segment's error boundary. The words are generic on purpose: during an
// outage anyone signed in can land here before the page knows who they are,
// so it must not say what the page is. error.message never reaches the
// screen either (Next strips server messages in production, and a client
// error can carry details). The digest is an opaque id that matches the
// server log line, which is what someone debugging needs.
export default function SegmentError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  // reset() on its own re-renders the payload that already failed. refresh()
  // asks the server to render the segment again, so a passing outage clears.
  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div role="alert" className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-soft">
      <p className="text-[15px] font-semibold text-ink">This page couldn&apos;t load.</p>
      <p className="mt-1 text-[13px] text-muted">Something went wrong on our side. Try again in a moment.</p>
      <button type="button" onClick={retry} className="btn-primary mt-4">
        Try again
      </button>
      {error.digest && <p className="mt-3 font-mono text-[11px] text-slate-400">Reference {error.digest}</p>}
    </div>
  );
}
