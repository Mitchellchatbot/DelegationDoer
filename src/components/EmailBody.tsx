"use client";

import { useEffect, useRef, useState } from "react";

// Render an email's HTML body inside a sandboxed iframe so the email's
// inline <style> blocks + font-family rules can't cascade into the rest
// of the app. The whole DD page was rendering in a serif font whenever
// a teammate opened a Claude / GoDaddy newsletter; this fixes that.
//
// Auto-resizes to its content so there's no internal scroll — feels
// like inline HTML, behaves like a sandbox. Links open in a new tab
// via injected <base target="_blank">. Scripts are disabled by the
// sandbox attribute.

export function EmailBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(160);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    // Build the document we'll inject. Wrap the email HTML in our own
    // baseline so a missing <body> tag in the source doesn't break
    // layout. <base target="_blank"> makes every link open externally.
    const doc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <base target="_blank" />
  <style>
    html, body {
      margin: 0;
      padding: 12px 0;
      background: transparent;
      color: #101828;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.55;
      word-wrap: break-word;
      overflow-wrap: anywhere;
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
  </style>
</head>
<body>${html}</body>
</html>`;

    iframe.srcdoc = doc;

    // After the iframe loads, measure its content height + push it up
    // to the host. ResizeObserver catches reflows from late-loading
    // images so the iframe re-fits.
    function onLoad() {
      const d = iframe!.contentDocument;
      if (!d) return;
      const measure = () => {
        const next = Math.max(
          d.documentElement.scrollHeight,
          d.body.scrollHeight,
          d.body.offsetHeight,
          d.documentElement.offsetHeight
        );
        // Add a few pixels so the bottom margin doesn't get clipped.
        setHeight(next + 8);
      };
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(d.body);
      // Images often load after the load event — re-measure when they do.
      d.querySelectorAll("img").forEach((img) => {
        if (!(img as HTMLImageElement).complete) {
          img.addEventListener("load", measure, { once: true });
          img.addEventListener("error", measure, { once: true });
        }
      });
    }
    iframe.addEventListener("load", onLoad);
    return () => iframe.removeEventListener("load", onLoad);
  }, [html]);

  return (
    <iframe
      ref={ref}
      // No scripts (sandbox without "allow-scripts"); links open in new
      // top-level tabs courtesy of allow-popups-to-escape-sandbox.
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      title="email-body"
      style={{
        width: "100%",
        height,
        border: "none",
        background: "transparent",
        display: "block"
      }}
    />
  );
}
