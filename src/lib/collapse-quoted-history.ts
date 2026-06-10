// Gmail-style quote collapsing for email bodies. Email clients append the
// entire prior thread to every reply (Gmail blockquotes, Outlook "From:/Sent:"
// header blocks, Apple cites, etc). Rendering that verbatim makes a thread
// repeat itself and look jumbled. Like Gmail, we keep the full body but detect
// where the quoted history begins and wrap it in a native <details> disclosure
// so each message shows only its new content by default, behind a "•••" toggle.
//
// This is a direct TypeScript port of missiveclone's proven implementation
// (frontend/src/components/ThreadView.jsx). It runs client-side only — callers
// must be in a browser/client component, since it relies on DOMParser. Any
// parse failure falls back to the input untouched so an edge case can never
// blank out a message. The <details> element toggles natively, which matters
// because email bodies render in an iframe sandboxed WITHOUT allow-scripts.

const QUOTE_TEXT_RE =
  /^\s*(On .+ wrote:|From:\s.+Sent:\s.+|-{2,}\s*Original Message\s*-{2,})/is;

export function collapseQuotedHistory(safeHtml: string): {
  html: string;
  hasQuote: boolean;
} {
  try {
    const doc = new DOMParser().parseFromString(safeHtml, "text/html");
    const body = doc.body;
    if (!body) return { html: safeHtml, hasQuote: false };

    // Find the earliest boundary node in document order, preferring structural
    // markers (reliable) over text heuristics (last resort).
    let boundary: Element | null =
      doc.querySelector("blockquote.gmail_quote, div.gmail_quote") ||
      doc.querySelector('blockquote[type="cite"]') ||
      doc.querySelector("#divRplyFwdMsg, #appendonsend");

    // Outlook divider: a border-top div whose own/next text holds a "From:" block.
    if (!boundary) {
      for (const div of Array.from(
        doc.querySelectorAll('div[style*="border-top"]')
      )) {
        const next = div.nextElementSibling;
        if (
          /From:/i.test(div.textContent || "") ||
          /From:/i.test(next?.textContent || "")
        ) {
          boundary = div;
          break;
        }
      }
    }

    // Generic top-level blockquote (Apple Mail and others).
    if (!boundary) boundary = body.querySelector(":scope > blockquote");

    // Text fallback: first block-level child whose text opens a quoted header.
    if (!boundary) {
      for (const el of Array.from(body.children)) {
        if (QUOTE_TEXT_RE.test(el.textContent || "")) {
          boundary = el;
          break;
        }
      }
    }

    if (!boundary) return { html: safeHtml, hasQuote: false };

    // Walk up to the boundary's body-level ancestor so we collapse it together
    // with all following siblings (the rest of the quoted thread).
    let top: Element = boundary;
    while (top.parentElement && top.parentElement !== body) {
      top = top.parentElement;
    }
    if (top.parentElement !== body) return { html: safeHtml, hasQuote: false };

    // False-positive guard: only collapse if there is real content BEFORE the
    // boundary. A genuine reply always has new text above the quote; if the
    // quote is the very first content, the "quote" is the whole message (e.g. a
    // bare forward or an over-eager text match) — show it all rather than hiding
    // an entire legitimate email behind a tiny toggle.
    let hasPreceding = false;
    for (let n: Node | null = top.previousSibling; n; n = n.previousSibling) {
      if (
        n.nodeType === 1 ||
        (n.nodeType === 3 && (n.textContent || "").trim() !== "")
      ) {
        hasPreceding = true;
        break;
      }
    }
    if (!hasPreceding) return { html: safeHtml, hasQuote: false };

    // Wrap the boundary + everything after it in a native <details> disclosure.
    // Closed by default → only the "•••" summary shows.
    const details = doc.createElement("details");
    details.className = "dd-quote";
    const summary = doc.createElement("summary");
    summary.className = "dd-quote-toggle";
    summary.textContent = "•••";
    details.appendChild(summary);
    body.insertBefore(details, top);
    while (details.nextSibling) details.appendChild(details.nextSibling);

    // Preserve any stylesheets the email shipped in its <head>. body_html is
    // often a full <html> document; we return only body.innerHTML, so without
    // this the email's <head> <style>/<link> would be dropped and a styled
    // message (e.g. a corporate reply) would render unstyled. They apply fine
    // inside the iframe <body>. For fragment bodies <head> is empty, so this is
    // "" and the output equals body.innerHTML exactly as before.
    const headStyles = doc.head
      ? Array.from(doc.head.querySelectorAll("style, link[rel='stylesheet']"))
          .map((el) => el.outerHTML)
          .join("")
      : "";

    return { html: headStyles + body.innerHTML, hasQuote: true };
  } catch {
    return { html: safeHtml, hasQuote: false };
  }
}
