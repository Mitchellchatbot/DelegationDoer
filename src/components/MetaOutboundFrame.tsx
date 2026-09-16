"use client";

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { META_OUTBOUND_APP, frameAllow, isSameSite } from "@/components/multitask/multitask-apps";

// The Scale Room's Outbound tab: the Meta ads dashboard's own Outbound page,
// framed whole. That is the rep chips, the Texts board, the stage Board and
// Table, and — for finance staff there — the Ads view with every month of our
// ad account's spend, its campaign split, cost per lead and cost per booked.
//
// Framed, not rebuilt. That page is where the pipeline is WORKED (stages move,
// texts get marked, Calendly syncs), and every figure on it comes from one
// engine in that app (awfmp lib/outbound-summary.ts). A copy here would be a
// read-only second pipeline free to drift from it; the summary card on /scale
// already reads that same engine's numbers.
//
// The URL, the allow grant and the framing notes (no CSP or X-Frame-Options
// there, sign-in redirects that survive a frame) live on META_OUTBOUND_APP,
// shared with the multitask bubble. No `sandbox`, for the reasons given on the
// bubble's iframe in MultitaskBubbles.tsx.
export function MetaOutboundFrame() {
  const app = META_OUTBOUND_APP;
  // The dashboard's session cookie is SameSite=Lax, so it only rides into the
  // frame when this page is same-site with it (operations.scaledai.org). From
  // the Railway alias signing in inside the frame would hang, so say so.
  // Decided after mount: the server can't know which host the browser used.
  const [crossSite, setCrossSite] = useState(false);
  useEffect(() => {
    setCrossSite(!isSameSite(app.url, window.location.hostname));
  }, [app.url]);

  return (
    <div className="flex h-[calc(100vh-13rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
      {crossSite && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <p className="text-[11px] leading-relaxed text-amber-900">
            This page isn&apos;t on a scaledai.org address, so the browser keeps the Meta ads
            dashboard&apos;s sign-in out of the frame. Use operations.scaledai.org, or open{" "}
            <a href={app.url} target="_blank" rel="noreferrer" className="underline">
              the board in its own tab
            </a>
            .
          </p>
        </div>
      )}
      <iframe
        src={app.url}
        title="Outbound · Meta ads dashboard"
        allow={frameAllow(app)}
        className="w-full flex-1 border-0 bg-white"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}
