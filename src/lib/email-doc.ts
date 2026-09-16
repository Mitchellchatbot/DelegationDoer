// The email composer's document (TipTap/ProseMirror JSON) → the HTML and
// plain text that actually get sent. Pure (no DOM), so what goes out is
// decided here, not by the editor's own DOM rendering.
//
// Outgoing HTML uses Gmail's dialect: a <div dir="ltr"> wrapper, one <div>
// per line (<div><br></div> for a blank line), <b>/<i>/<u>/<strike>, and
// inline styles only — no classes, which mail clients drop. The wrapper also
// keeps user content out of the "top-level <blockquote> starts quoted
// history" rule in collapse-quoted-history.ts.

import { displayHref, toSafeAbsoluteHref } from "./email-links";

export interface EmailDocMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface EmailDocNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: EmailDocNode[];
  text?: string;
  marks?: EmailDocMark[];
}

export interface EmailBody {
  doc: EmailDocNode | null;
  html: string; // "" when empty
  text: string; // plain-text alternative
  isEmpty: boolean;
  // Nothing but lines of unformatted text — sendable as text only, exactly
  // like the old textarea.
  isPlain: boolean;
}

export const EMPTY_EMAIL_BODY: EmailBody = { doc: null, html: "", text: "", isEmpty: true, isPlain: true };

// Outlook's Word engine gives lists huge default margins; pin them.
const LIST_STYLE = "margin:0 0 0 25px;padding:0";

// Outermost first, so one link can span runs that toggle bold etc.
const MARK_ORDER = ["link", "bold", "italic", "underline", "strike"];

const MARK_TAGS: Record<string, string> = { bold: "b", italic: "i", underline: "u", strike: "strike" };

export function bodyFromDoc(doc: EmailDocNode): EmailBody {
  // Nothing typed (e.g. only an empty list left behind) sends and saves as an
  // empty text body, not a stray "- " or empty markup.
  if (isDocEmpty(doc)) return { ...EMPTY_EMAIL_BODY, doc };
  return { doc, html: docToEmailHtml(doc), text: docToPlainText(doc), isEmpty: false, isPlain: isDocPlain(doc) };
}

// Request fields for a body: a formatted body sends its HTML plus the text
// alternative; a plain one sends text only, exactly like the old textarea
// (so Graph keeps sending it as a text email).
export function emailBodyFields(body: EmailBody): { bodyText: string; bodyHtml?: string } {
  return body.isPlain ? { bodyText: body.text } : { bodyText: body.text, bodyHtml: body.html };
}

export function plainTextToDoc(text: string): EmailDocNode {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return {
    type: "doc",
    content: lines.map((line) =>
      line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" }
    )
  };
}

export function isDocEmpty(doc: EmailDocNode): boolean {
  let empty = true;
  walk(doc, (node) => {
    if (node.type === "text" && (node.text ?? "").trim()) empty = false;
  });
  return empty;
}

export function isDocPlain(doc: EmailDocNode): boolean {
  return (doc.content ?? []).every(
    (block) =>
      block.type === "paragraph" &&
      (block.content ?? []).every(
        (n) => n.type === "hardBreak" || (n.type === "text" && !(n.marks ?? []).length)
      )
  );
}

// ---------------------------------------------------------------- HTML

export function docToEmailHtml(doc: EmailDocNode): string {
  const blocks = trimTrailingEmptyParagraphs(doc.content ?? []);
  if (blocks.length === 0) return "";
  return `<div dir="ltr">${blocks.map(blockHtml).join("")}</div>`;
}

function blockHtml(node: EmailDocNode): string {
  switch (node.type) {
    case "paragraph":
      return `<div>${lineHtml(node.content ?? [])}</div>`;
    case "bulletList":
      return `<ul style="${LIST_STYLE}">${(node.content ?? []).map(listItemHtml).join("")}</ul>`;
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      const startAttr = Number.isInteger(start) && start !== 1 ? ` start="${start}"` : "";
      return `<ol style="${LIST_STYLE}"${startAttr}>${(node.content ?? []).map(listItemHtml).join("")}</ol>`;
    }
    default:
      return (node.content ?? []).map(blockHtml).join("");
  }
}

// An <li>'s first paragraph goes in directly — <li><div> gets paragraph
// spacing in classic Outlook.
function listItemHtml(item: EmailDocNode): string {
  const [first, ...rest] = item.content ?? [];
  const head = first?.type === "paragraph" ? lineHtml(first.content ?? []) : first ? blockHtml(first) : "<br>";
  return `<li>${head}${rest.map(blockHtml).join("")}</li>`;
}

// A line's inline content. Empty → <br> so the line keeps its height; a
// trailing hard break needs a second <br> to render at all.
function lineHtml(inline: EmailDocNode[]): string {
  if (inline.length === 0) return "<br>";
  const html = inlineHtml(inline);
  return inline[inline.length - 1].type === "hardBreak" ? `${html}<br>` : html;
}

function inlineHtml(nodes: EmailDocNode[]): string {
  let out = "";
  let open: EmailDocMark[] = [];
  let lineStart = true;
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out += "<br>";
      lineStart = true;
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const marks = sortedMarks(node.marks);
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep], marks[keep])) keep++;
    for (let j = open.length - 1; j >= keep; j--) out += closeTag(open[j]);
    for (let j = keep; j < marks.length; j++) out += openTag(marks[j]);
    open = marks;
    out += textHtml(node.text, lineStart);
    lineStart = false;
  }
  for (let j = open.length - 1; j >= 0; j--) out += closeTag(open[j]);
  return out;
}

function sortedMarks(marks: EmailDocMark[] | undefined): EmailDocMark[] {
  return (marks ?? [])
    .filter((m) => MARK_ORDER.includes(m.type) && (m.type !== "link" || toSafeAbsoluteHref(hrefOf(m))))
    .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
}

function sameMark(a: EmailDocMark, b: EmailDocMark): boolean {
  return a.type === b.type && (a.type !== "link" || hrefOf(a) === hrefOf(b));
}

function hrefOf(mark: EmailDocMark): string {
  return typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
}

function openTag(mark: EmailDocMark): string {
  if (mark.type === "link") return `<a href="${escapeAttr(toSafeAbsoluteHref(hrefOf(mark)) ?? "")}">`;
  return `<${MARK_TAGS[mark.type]}>`;
}

function closeTag(mark: EmailDocMark): string {
  return mark.type === "link" ? "</a>" : `</${MARK_TAGS[mark.type]}>`;
}

// HTML collapses runs of spaces; keep what the user typed.
function textHtml(text: string, startsLine: boolean): string {
  let html = escapeText(text).replace(/\u00a0/g, "&nbsp;").replace(/ (?= )/g, "&nbsp;");
  if (startsLine) html = html.replace(/^ /, "&nbsp;");
  return html;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------- text

// Plain-text alternative: one line per line, "- " / "N. " list items,
// links as "text <url>". For a plain doc this is exactly what the old
// textarea held.
export function docToPlainText(doc: EmailDocNode): string {
  const lines = blocksToLines(trimTrailingEmptyParagraphs(doc.content ?? []));
  return lines.join("\n").replace(/\u00a0/g, " ");
}

function blocksToLines(blocks: EmailDocNode[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      lines.push(...inlineText(block.content ?? []).split("\n"));
    } else if (block.type === "bulletList" || block.type === "orderedList") {
      let n = Number(block.attrs?.start ?? 1) || 1;
      for (const item of block.content ?? []) {
        const itemLines = blocksToLines(item.content ?? []);
        // An empty item (e.g. the fresh line after the last one) isn't a bullet.
        if (itemLines.every((l) => !l.trim())) continue;
        const marker = block.type === "orderedList" ? `${n++}. ` : "- ";
        const indent = " ".repeat(marker.length);
        lines.push(marker + (itemLines[0] ?? ""), ...itemLines.slice(1).map((l) => (l ? indent + l : "")));
      }
    } else {
      lines.push(...blocksToLines(block.content ?? []));
    }
  }
  return lines;
}

function inlineText(nodes: EmailDocNode[]): string {
  let out = "";
  let linkHref: string | null = null;
  let linkText = "";
  const endLink = () => {
    if (linkHref === null) return;
    const shown = displayHref(linkHref);
    if (shown !== linkText.trim()) out += ` <${shown}>`;
    linkHref = null;
    linkText = "";
  };
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      endLink();
      out += "\n";
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const link = (node.marks ?? []).find((m) => m.type === "link");
    const href = link ? toSafeAbsoluteHref(hrefOf(link)) : null;
    if (href !== linkHref) endLink();
    if (href) {
      linkHref = href;
      linkText += node.text;
    }
    out += node.text;
  }
  endLink();
  return out;
}

// ---------------------------------------------------------------- shared

function trimTrailingEmptyParagraphs(blocks: EmailDocNode[]): EmailDocNode[] {
  let end = blocks.length;
  while (end > 0 && blocks[end - 1].type === "paragraph" && !(blocks[end - 1].content ?? []).length) end--;
  return blocks.slice(0, end);
}

function walk(node: EmailDocNode, visit: (n: EmailDocNode) => void) {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}
