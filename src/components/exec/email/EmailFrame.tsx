"use client";

import { useEffect, useRef, useState } from "react";

// One email body, in a sandboxed frame (contract L15, §3.14).
//
// The document comes from the server, already rebuilt by email-srcdoc.ts
// (its CSP, the tag and URL allow-lists). This island adds the browser-side
// locks around it:
//   - the sandbox, exactly as DD's EmailBody has it, and never allow-scripts:
//     allow-same-origin is there only so the frame's height can be read, and
//     together with allow-scripts it would undo the sandbox;
//   - the srcdoc is set after mount, so the server's HTML never carries the
//     email in an attribute (and a JS-less render shows an empty frame, not
//     the email unsandboxed);
//   - after each load every link is forced to open in a new tab with
//     rel="noopener noreferrer" (the builder already wrote that; this is the
//     second lock);
//   - "Show images (N)" swaps in the second document the server built with
//     remote images allowed. It is per message and per page view: nothing
//     remembers the choice.
// The frame grows to the email's height (polled while late styles settle,
// then a ResizeObserver), up to MAX_HEIGHT_PX; past that it scrolls.

export const EMAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox allow-same-origin";

const INITIAL_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 6_000;
const POLL_INTERVAL_MS = 150;
const POLL_DURATION_MS = 3_000;

/** Every link in the frame opens in a new tab, with no opener and no referrer. */
export function hardenFrameLinks(doc: Document): number {
  let n = 0;
  doc.querySelectorAll("a, area").forEach((el) => {
    el.setAttribute("rel", "noopener noreferrer");
    el.setAttribute("target", "_blank");
    n += 1;
  });
  return n;
}

export function EmailFrame({
  srcdoc,
  imagesSrcdoc,
  remoteImages,
  title
}: {
  /** The default document: remote images withheld. */
  srcdoc: string;
  /** The document with remote images allowed, or null when there are none. */
  imagesSrcdoc: string | null;
  /** How many remote images the second document would load. */
  remoteImages: number;
  /** The frame's accessible name (who sent it, when). */
  title: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [showImages, setShowImages] = useState(false);
  const [height, setHeight] = useState(INITIAL_HEIGHT_PX);
  const doc = showImages && imagesSrcdoc !== null ? imagesSrcdoc : srcdoc;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      const d = frame.contentDocument;
      if (!d) return;
      const h = Math.max(
        d.documentElement?.scrollHeight ?? 0,
        d.documentElement?.offsetHeight ?? 0,
        d.body?.scrollHeight ?? 0,
        d.body?.offsetHeight ?? 0,
        INITIAL_HEIGHT_PX
      );
      setHeight(Math.min(h + 4, MAX_HEIGHT_PX));
    };

    // Runs for every document the frame loads (the blank one before the
    // srcdoc, the srcdoc, the images document): each load replaces the last
    // one's poll and observer.
    const onLoad = () => {
      const d = frame.contentDocument;
      if (d) hardenFrameLinks(d);
      measure();
      if (poll) clearInterval(poll);
      const stopAt = Date.now() + POLL_DURATION_MS;
      const id = setInterval(() => {
        measure();
        if (Date.now() > stopAt) {
          clearInterval(id);
          if (poll === id) poll = null;
        }
      }, POLL_INTERVAL_MS);
      poll = id;
      observer?.disconnect();
      observer = null;
      if (d?.body && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(measure);
        observer.observe(d.body);
      }
    };

    // Measured heights can only grow within one document (the frame's own
    // height is the floor), so a new document starts again from the minimum:
    // the images document may well be shorter than the placeholders were.
    setHeight(INITIAL_HEIGHT_PX);
    frame.addEventListener("load", onLoad);
    frame.srcdoc = doc;
    return () => {
      frame.removeEventListener("load", onLoad);
      if (poll) clearInterval(poll);
      observer?.disconnect();
    };
  }, [doc]);

  const canShow = remoteImages > 0 && imagesSrcdoc !== null;
  return (
    <div className="min-w-0">
      {canShow && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
          {showImages ? (
            <>
              <span>Remote images are shown for this message.</span>
              <button
                type="button"
                onClick={() => setShowImages(false)}
                className="font-semibold text-indigo-700 underline-offset-2 hover:underline"
              >
                Hide images
              </button>
            </>
          ) : (
            <>
              <span>Remote images are hidden. Loading them tells the sender you opened this and shows them your IP address.</span>
              <button
                type="button"
                onClick={() => setShowImages(true)}
                className="font-semibold text-indigo-700 underline-offset-2 hover:underline"
              >
                {`Show images (${remoteImages})`}
              </button>
            </>
          )}
        </div>
      )}
      <iframe
        ref={ref}
        title={title}
        sandbox={EMAIL_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="block w-full rounded-lg border border-slate-100 bg-white"
        style={{ height }}
      />
    </div>
  );
}
