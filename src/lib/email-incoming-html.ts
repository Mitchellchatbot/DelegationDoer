// Cleans HTML before it enters the email editor — a restored draft or a paste
// from Gmail, Outlook, Google Docs or Word. The editor's schema already drops
// anything it doesn't model (scripts, handlers, unknown tags); this handles
// what the schema would otherwise get wrong.
//
// Parses with DOMParser (inert: no handlers run, no images load).
// Browser-only.

export type IncomingHtmlSource = "load" | "paste";

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CENTER", "DD", "DIV", "DL", "DT",
  "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "MAIN",
  "NAV", "P", "PRE", "SECTION", "TD", "TH"
]);

export function normalizeIncomingHtml(
  html: string,
  { source }: { source: IncomingHtmlSource }
): { html: string; droppedImages: number } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;

  const images = body.querySelectorAll("img");
  const droppedImages = images.length;
  images.forEach((img) => img.remove());

  body.querySelectorAll("style, script, meta, link, title, template, noscript").forEach((el) => el.remove());
  body.querySelectorAll("*").forEach((el) => {
    // Word's "o:p" filler.
    if (el.tagName === "O:P") {
      el.remove();
      return;
    }
    // Word and Outlook write lists as paragraphs whose number or bullet is a
    // literal text span, not <ol>/<ul> — keep it as text so "1." survives.
    if (/mso-list:\s*ignore/i.test(el.getAttribute("style") || "")) {
      const marker = (el.textContent || "").replace(/\s+/g, " ").trim();
      const label = /^[a-z0-9]{1,4}[.)]$/i.test(marker) ? marker : "•";
      el.replaceWith(doc.createTextNode(marker ? `${label} ` : ""));
    }
  });
  removeComments(body);

  if (source === "paste") {
    // Spreadsheet ranges: one line per row, cells separated by " | " (the
    // schema has no tables, which would otherwise run every cell together; a
    // tab would collapse to a space, and empty cells would disappear).
    body.querySelectorAll("tr").forEach((tr) => {
      const line = doc.createElement("div");
      Array.from(tr.children).forEach((cell, i) => {
        if (i > 0) line.append(doc.createTextNode(" | "));
        line.append(...Array.from(cell.childNodes));
      });
      tr.replaceWith(line);
    });
    // Web pages and chat apps separate paragraphs with <p> margins, which the
    // editor's margin-less lines don't have — add the blank line explicitly.
    // Word and Google Docs zero those margins and write blank lines themselves.
    body.querySelectorAll("p").forEach((p) => {
      const next = p.nextElementSibling;
      if (next?.tagName !== "P" || isTightParagraph(p) || isTightParagraph(next)) return;
      const blank = doc.createElement("div");
      blank.append(doc.createElement("br"));
      p.after(blank);
    });
  }

  // Classes and ids mean nothing in an email and could pick up the app's own
  // CSS inside the editor.
  body.querySelectorAll("[class], [id]").forEach((el) => {
    if (source === "load" && /gmail_quote/.test(el.getAttribute("class") || "")) return;
    el.removeAttribute("class");
    el.removeAttribute("id");
  });

  if (source === "load") {
    // A draft never holds the reply quote (it lives outside the editor), but
    // an old one might — never pull someone else's email into the editor.
    body.querySelectorAll("div.gmail_quote, blockquote.gmail_quote").forEach((el) => el.remove());

    // A block's last <br> doesn't render: <div>a<br></div> is one line and
    // <div><br></div> is one blank line. The editor would keep it as a real
    // line break, so blank lines would double on every save/restore.
    // (Pasted HTML is exempt: ProseMirror's clipboard parser already drops it.)
    body.querySelectorAll("*").forEach((el) => {
      if (!BLOCK_TAGS.has(el.tagName)) return;
      const last = lastMeaningfulChild(el);
      if (last && last.nodeName === "BR") last.remove();
    });
  }

  return { html: body.innerHTML, droppedImages };
}

function isTightParagraph(el: Element): boolean {
  const style = el.getAttribute("style") || "";
  return /^Mso/.test(el.getAttribute("class") || "") || /margin(?:-top|-bottom)?\s*:\s*0/i.test(style);
}

function lastMeaningfulChild(el: Element): ChildNode | null {
  let node = el.lastChild;
  while (node && node.nodeType === Node.TEXT_NODE && !(node.nodeValue || "").trim()) node = node.previousSibling;
  return node;
}

function removeComments(root: Node) {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
}
