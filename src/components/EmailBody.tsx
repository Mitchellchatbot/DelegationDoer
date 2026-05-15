"use client";

import { useEffect, useRef, useState } from "react";

// Render an email's HTML body inside a sandboxed iframe so the email's
// inline <style> + font-family rules can't cascade into the rest of
// the app. Auto-resizes to its content so there's no internal scroll
// for normal-length emails. Past MAX_HEIGHT_PX the iframe gets its own
// scroll instead of pushing the thread view off-screen.
//
// Sizing pattern: srcdoc 'load' alone is unreliable for late-loading
// images + remote CSS, so we POLL the iframe document height every
// 150ms for the first ~3s after each html change, then back off to a
// ResizeObserver. Belt-and-suspenders against the "iframe stays at
// 200px even though the email is 1500px" race.

const INITIAL_HEIGHT_PX = 200;
const MAX_HEIGHT_PX = 720;
const POLL_INTERVAL_MS = 150;
const POLL_DURATION_MS = 3000;

export function EmailBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(INITIAL_HEIGHT_PX);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    // Baseline CSS uses !important so an email's `body { font-family }`
    // declaration can't override ours after we've already rendered it.
    const baselineCss = `
      html, body {
        margin: 0 !important;
        padding: 12px 0 !important;
        background: transparent !important;
        color: #101828;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 14px;
        line-height: 1.55;
        word-wrap: break-word;
        overflow-wrap: anywhere;
        height: auto !important;
        min-height: 0 !important;
      }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; }
      a { color: #1e63ff; }
      blockquote {
        border-left: 3px solid #e5e7eb;
        margin: 8px 0;
        padding: 4px 0 4px 12px;
        color: #475467;
      }
      pre, code {
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        background: #f3f4f6;
        border-radius: 4px;
      }
      pre { padding: 8px; overflow-x: auto; }
      code { padding: 1px 4px; }
    `;
    const doc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <base target="_blank" />
  <style>${baselineCss}</style>
</head>
<body>${html}</body>
</html>`;

    iframe.srcdoc = doc;

    function measure(): number {
      const d = iframe!.contentDocument;
      if (!d) return INITIAL_HEIGHT_PX;
      const candidates = [
        d.documentElement?.scrollHeight ?? 0,
        d.documentElement?.offsetHeight ?? 0,
        d.body?.scrollHeight ?? 0,
        d.body?.offsetHeight ?? 0
      ];
      return Math.max(...candidates, INITIAL_HEIGHT_PX);
    }

    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPollAt = Date.now() + POLL_DURATION_MS;
    let ro: ResizeObserver | null = null;

    function update() {
      setHeight(measure() + 8);
    }

    function onLoad() {
      update();
      // Poll for late-loading images + remote CSS.
      poll = setInterval(() => {
        update();
        if (Date.now() > stopPollAt) {
          if (poll) clearInterval(poll);
          poll = null;
        }
      }, POLL_INTERVAL_MS);

      const d = iframe!.contentDocument;
      if (d?.body) {
        ro = new ResizeObserver(update);
        ro.observe(d.body);
        if (d.documentElement) ro.observe(d.documentElement);
      }
    }
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      if (poll) clearInterval(poll);
      if (ro) ro.disconnect();
    };
  }, [html]);

  const clampedHeight = Math.min(height, MAX_HEIGHT_PX);
  const overflowed = height > MAX_HEIGHT_PX;

  return (
    <iframe
      ref={ref}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      title="email-body"
      // scrolling="no" deprecated but the only universally-honored knob
      // for hiding the inner scrollbar on short emails. When the email
      // exceeds MAX_HEIGHT_PX we let it scroll so layout stays sane.
      scrolling={overflowed ? "yes" : "no"}
      style={{
        width: "100%",
        height: clampedHeight,
        border: "none",
        background: "transparent",
        display: "block"
      }}
    />
  );
}
