"use client";

import { useEffect, useRef } from "react";

// The read-back of an Outlook draft, in P4's own isolated frame (P4 contract
// §3.13.1, C64). Not P3's EmailFrame: that one keeps allow-same-origin to read
// its height, and here nothing may share DD's origin.
//
//   - sandbox="" exactly: an opaque origin, no scripts, no popups, no forms, no
//     top navigation. A link in the document can't open (P3's <base target=
//     "_blank"> needs allow-popups) and no subresource can carry DD's cookies;
//   - referrerPolicy="no-referrer";
//   - the srcdoc is set after mount (never as markup), so the server's HTML
//     never carries the draft in an attribute;
//   - a fixed-height box (h-[min(60vh,560px)], full width) in which the
//     frame's own document scrolls: an opaque-origin frame can't be measured,
//     so there is no autosize, and there is no images toggle (C47).
//
// The document itself comes from drafts-view.ts's readBackSrcdoc: P4's CSP
// first, then P3's; this island is the second, independent lock.

export const READ_BACK_FRAME_SANDBOX = "";

export function ReadBackFrame({ srcdoc, title }: { srcdoc: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    frame.srcdoc = srcdoc;
  }, [srcdoc]);

  return (
    <div className="h-[min(60vh,560px)] w-full overflow-hidden rounded-xl border border-slate-200 bg-white">
      <iframe
        ref={ref}
        title={title}
        sandbox={READ_BACK_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}
