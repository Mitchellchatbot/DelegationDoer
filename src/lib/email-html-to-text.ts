// Email HTML → plain text, for the text/plain MIME part and body_text.
//
// Parses with DOMParser, whose document has scripting disabled and no browsing
// context: inline handlers (<img onerror>) never run and nothing is fetched.
// Assigning the same HTML to innerHTML of an element in the live document is
// NOT inert — and outgoing replies embed the inbound message's raw HTML in the
// quote, so that would run a stranger's markup in DD's origin.
//
// It also emits line breaks explicitly. innerText on a detached element returns
// textContent, which drops every <br> and block boundary.
//
// Browser-only (DOMParser). Callers are click handlers, never SSR.

const SKIP_TAGS = new Set(["HEAD", "STYLE", "SCRIPT", "TITLE", "TEMPLATE", "NOSCRIPT", "IMG"]);

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "CENTER", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
  "H5", "H6", "HEADER", "HR", "MAIN", "NAV", "P", "PRE", "SECTION", "SUMMARY",
  "TABLE", "TR"
]);

// Accumulates rendered lines. A <br> always ends the current line (so
// <div><br></div> is one empty line), while a block boundary only ends a line
// that has content (so <div>a<br></div><div>b</div> is two lines, not three).
class LineBuffer {
  private lines: string[] = [];
  private cur = "";
  private gap = false; // a <p> margin wants a blank line before the next content

  text(t: string) {
    this.cur += t;
  }

  br() {
    this.push(this.cur.trim());
    this.cur = "";
  }

  block() {
    const t = this.cur.trim();
    this.cur = "";
    if (t) this.push(t);
  }

  paragraphGap() {
    this.block();
    this.gap = true;
  }

  append(lines: string[]) {
    this.block();
    for (const l of lines) this.push(l);
  }

  done(): string[] {
    this.block();
    const out: string[] = [];
    for (const l of this.lines) {
      if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
      out.push(l);
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
  }

  private push(line: string) {
    if (this.gap && this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.lines.push("");
    }
    this.gap = false;
    this.lines.push(line);
  }
}

function walkChildren(el: Element, buf: LineBuffer, pre: boolean) {
  for (const child of Array.from(el.childNodes)) walk(child, buf, pre);
}

function linesOf(el: Element, pre: boolean): string[] {
  const buf = new LineBuffer();
  walkChildren(el, buf, pre);
  return buf.done();
}

function walk(node: Node, buf: LineBuffer, pre: boolean) {
  if (node.nodeType === Node.TEXT_NODE) {
    const data = (node.nodeValue || "").replace(/\u00a0/g, " ");
    if (!pre) {
      buf.text(data.replace(/[\t\n\r\f ]+/g, " "));
      return;
    }
    data.split("\n").forEach((part, i) => {
      if (i > 0) buf.br();
      buf.text(part);
    });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return;

  switch (tag) {
    case "BR":
      buf.br();
      return;
    case "BLOCKQUOTE":
      buf.append(linesOf(el, pre).map((l) => (l ? `> ${l}` : ">")));
      return;
    case "UL":
    case "OL": {
      const out: string[] = [];
      let n = Number.parseInt(el.getAttribute("start") || "1", 10) || 1;
      for (const child of Array.from(el.children)) {
        const itemLines = linesOf(child, pre);
        if (itemLines.length === 0) continue;
        const marker = child.tagName !== "LI" ? "  " : tag === "OL" ? `${n++}. ` : "- ";
        const indent = " ".repeat(marker.length);
        out.push(marker + itemLines[0], ...itemLines.slice(1).map((l) => (l ? indent + l : "")));
      }
      buf.append(out);
      return;
    }
    case "A": {
      walkChildren(el, buf, pre);
      const href = (el.getAttribute("href") || "").trim();
      const label = (el.textContent || "").trim();
      if (label && /^(https?:|mailto:)/i.test(href)) {
        const shown = href.replace(/^mailto:/i, "");
        if (shown !== label && href !== label) buf.text(` <${shown}>`);
      }
      return;
    }
    case "TD":
    case "TH":
      walkChildren(el, buf, pre);
      buf.text(" ");
      return;
  }

  if (tag === "P") {
    buf.paragraphGap();
    walkChildren(el, buf, pre);
    buf.paragraphGap();
    return;
  }
  if (BLOCK_TAGS.has(tag)) {
    buf.block();
    walkChildren(el, buf, pre || tag === "PRE");
    buf.block();
    return;
  }
  walkChildren(el, buf, pre);
}

export function emailHtmlToText(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  const buf = new LineBuffer();
  walkChildren(doc.body, buf, false);
  return buf.done().join("\n");
}
