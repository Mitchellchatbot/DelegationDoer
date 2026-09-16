// Cleans HTML before it enters the email editor — a restored draft or a paste
// from Gmail, Outlook, Google Docs or Word. The editor's schema already drops
// anything it doesn't model (scripts, handlers, unknown tags); this handles
// what the schema would otherwise get wrong.
//
// Parses with DOMParser (inert: no handlers run, no images load).
// Browser-only.

import {
  canonicalBackgroundColor,
  canonicalTextColor,
  cssLengthPx,
  INDENT_STEP_PX,
  isNearWhite,
  legacyFontSizePx
} from "./email-style";

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

  // Gmail and the clone's composer write fonts, sizes and colors as <font>,
  // alignment as align="…", and indent as a border-less blockquote. Turn them
  // into the inline styles the editor's schema reads.
  body.querySelectorAll("font").forEach((font) => {
    const span = doc.createElement("span");
    const styles: string[] = [];
    const face = font.getAttribute("face");
    if (face) styles.push(`font-family:${face}`);
    const size = legacyFontSizePx(font.getAttribute("size"));
    if (size) styles.push(`font-size:${size}px`);
    const color = font.getAttribute("color");
    if (color) styles.push(`color:${color}`);
    const own = font.getAttribute("style");
    if (own) styles.push(own);
    if (styles.length) span.setAttribute("style", styles.join(";"));
    span.append(...Array.from(font.childNodes));
    font.replaceWith(span);
  });
  body.querySelectorAll("center").forEach((center) => {
    const div = doc.createElement("div");
    div.style.textAlign = "center";
    div.append(...Array.from(center.childNodes));
    center.replaceWith(div);
  });
  body.querySelectorAll("[align]").forEach((el) => {
    const align = (el.getAttribute("align") || "").toLowerCase();
    if (["left", "center", "right"].includes(align) && el instanceof HTMLElement && !el.style.textAlign) {
      el.style.textAlign = align;
    }
    el.removeAttribute("align");
  });
  // The editor aligns lines, not containers: hand a container's alignment to
  // the lines inside it.
  body.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    if (!el.style.textAlign || !hasBlockChild(el)) return;
    lineTargets(el).forEach((line) => {
      if (!line.style.textAlign) line.style.textAlign = el.style.textAlign;
    });
  });
  // Deepest first, so nested indents add up. Outlook/Word quote bars are also
  // written "border:none;border-left:solid …" — those stay quotes.
  Array.from(body.querySelectorAll<HTMLElement>("blockquote"))
    .reverse()
    .forEach((quote) => {
      const borderless = /border:none/i.test((quote.getAttribute("style") || "").replace(/\s+/g, ""));
      const leftBar = quote.style.borderLeftStyle && quote.style.borderLeftStyle !== "none";
      if ((!borderless || leftBar) && !/webkit-indent-blockquote/.test(quote.getAttribute("class") || "")) return;
      unwrapIndent(doc, quote);
    });
  // A list item's alignment/indent is saved on the <li> (email-doc.ts), but the
  // editor keeps it on the line inside: move it onto a <div> around the text.
  body.querySelectorAll<HTMLElement>("li").forEach((li) => {
    const { textAlign, marginLeft } = li.style;
    if (!textAlign && !marginLeft) return;
    const line = doc.createElement("div");
    line.style.textAlign = textAlign;
    line.style.marginLeft = marginLeft;
    while (li.firstChild && !(li.firstChild instanceof HTMLElement && BLOCK_CHILD.test(li.firstChild.tagName))) {
      line.append(li.firstChild);
    }
    li.style.removeProperty("text-align");
    li.style.removeProperty("margin-left");
    li.prepend(line);
  });

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
    // White-on-white text would be invisible in the composer but still sent
    // (e.g. hidden text a page adds to what's copied). Keep light text only
    // where something gives it a background.
    body.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
      const color = canonicalTextColor(el.style.color);
      if (color && isNearWhite(color) && !hasBackground(el, body)) el.style.removeProperty("color");
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

// Replace an indent blockquote with its content shifted one step right: each
// line inside gets +40px margin-left; runs of loose inline content are wrapped
// in a shifted <div>.
function unwrapIndent(doc: Document, quote: Element) {
  const out: Node[] = [];
  let inline: Node[] = [];
  const flushInline = () => {
    if (inline.some((n) => n.nodeType !== Node.TEXT_NODE || (n.nodeValue || "").trim())) {
      const div = doc.createElement("div");
      div.append(...inline);
      shiftRight(div);
      out.push(div);
    }
    inline = [];
  };
  for (const child of Array.from(quote.childNodes)) {
    if (child instanceof HTMLElement && BLOCK_CHILD.test(child.tagName)) {
      flushInline();
      lineTargets(child).forEach(shiftRight);
      out.push(child);
    } else {
      inline.push(child);
    }
  }
  flushInline();
  quote.replaceWith(...out);
}

function shiftRight(el: HTMLElement) {
  el.style.marginLeft = `${(cssLengthPx(el.style.marginLeft) ?? 0) + INDENT_STEP_PX}px`;
}

// Mirrors the editor's line rule (extensions.ts EmailParagraph): an element
// containing any of these is a container, not a line.
const BLOCK_CHILD = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|CENTER|DIV|DL|FIELDSET|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|UL)$/;
const LINE_TAGS = /^(DIV|P|LI|H[1-6]|PRE)$/;

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((c) => BLOCK_CHILD.test(c.tagName));
}

// The lines an element's alignment or indent applies to: itself if it is a
// line, otherwise the lines inside it.
function lineTargets(el: HTMLElement): HTMLElement[] {
  if (LINE_TAGS.test(el.tagName) && !hasBlockChild(el)) return [el];
  return Array.from(el.querySelectorAll<HTMLElement>("div, p, li, h1, h2, h3, h4, h5, h6, pre")).filter(
    (d) => !hasBlockChild(d)
  );
}

function hasBackground(el: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node && node !== root; node = node.parentElement) {
    if (canonicalBackgroundColor(node.style.backgroundColor)) return true;
  }
  return false;
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
