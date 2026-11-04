import "server-only";

import { CANONICAL_ORIGIN } from "@/lib/canonical-origin";
import { isDdHost } from "@/lib/exec/refs";

// The document the email frame shows (contract L15, §3.14, v3.1 A7, round-4
// coherence-22): one received email's HTML, turned into a srcdoc that can't
// run anything, can't load anything he didn't ask for, and can never make his
// browser send a request to DD.
//
// The frame (components/exec/email/EmailFrame.tsx) is sandboxed without
// allow-scripts but WITH allow-same-origin (it has to read its own height).
// That combination makes the srcdoc document DD's origin: a request it sends
// to a DD host carries his session cookies. So this builder doesn't lean on
// one lock. Four independent ones hold:
//   1. A Content-Security-Policy <meta>, the first thing in <head>:
//      default-src 'none'; images only from data: (plus, once he clicks
//      "Show images", https: on exactly the hosts the allow-list kept, so an
//      allowed image that redirects to DD is blocked by the browser);
//      inline styles; data: fonts; no base URL; no forms.
//   2. A rewrite of the HTML itself, below. Nothing is copied through: the
//      input is tokenized the way a browser tokenizes it and every tag is
//      rebuilt from its parsed name and attributes, every attribute value is
//      re-encoded, every "<" in text is escaped. So the browser parsing the
//      output sees exactly the tokens this code decided on, whatever tricks
//      the input used (comments that end early, raw-text elements, foreign
//      content, entity-encoded URLs).
//   3. An allow-list for everything that can fetch. Elements that load or
//      navigate (meta, link, base, iframe, frame, frameset, object, embed,
//      applet, form, ...) are renamed to inert ones; script, title, noembed
//      and noframes go with their content; on* attributes go; URL attributes
//      survive only where they are needed (img src/srcset, a/area href). An
//      image URL survives only as an absolute https: URL whose host isn't
//      DD's site; a link only as an absolute http(s), mailto or tel URL. CSS
//      gets the same treatment token by token, in style attributes and in
//      <style>: every url(), src(), image-set() and friends that isn't allowed
//      becomes `none`, and @import goes.
//   4. Remote images aren't even in the default document: their URLs are
//      removed, not just blocked. "Show images" swaps in a second document
//      built with showRemoteImages, so the default one has nothing a CSP
//      slip could load.
// Inline (cid:) images become a text placeholder: P3 has no attachment proxy.
//
// Pure: string in, string out. No DOM, no network, no logging (an email's
// content must never reach a log line).

/** Bodies longer than this are cut (the message says so); the same ceiling as triage's. */
export const MAX_EMAIL_HTML_CHARS = 1_000_000;

export interface EmailSrcdocOptions {
  /** Keep remote images (absolute https: URLs off DD's site). Only after his explicit click. */
  showRemoteImages: boolean;
}

export interface EmailSrcdoc {
  /** The whole document for the frame's srcdoc. */
  srcdoc: string;
  /**
   * Remote images the "Show images" toggle would load: <img> elements and
   * CSS image references with at least one allowed URL. 0 when they are shown.
   */
  remoteImages: number;
  /** Inline (cid:) images replaced by a text placeholder. */
  inlineImages: number;
  /** The HTML was longer than MAX_EMAIL_HTML_CHARS and was cut. */
  truncated: boolean;
}

// A host the CSP may name: lowercase ASCII labels (the URL parser's punycode),
// an optional port. Nothing that could end a source list or a directive.
const CSP_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;

/**
 * The frame's Content-Security-Policy. Fetch directives fall back to
 * default-src 'none'; base-uri and form-action don't, so they are set too.
 * `imageHosts` are the hosts (host[:port]) remote images may load from, and
 * only over https: the ones the allow-list kept in a "Show images" document,
 * none in the default one. Listing them, rather than allowing all of https:,
 * means a redirect from an allowed image to anywhere else (DD included) is
 * refused by the browser. A host that isn't a plain host name is left out.
 */
export function emailFrameCsp(imageHosts: readonly string[] = []): string {
  const hosts = [...new Set(imageHosts.filter((h) => typeof h === "string" && CSP_HOST.test(h)))].sort();
  return [
    "default-src 'none'",
    "script-src 'none'",
    ["img-src data:", ...hosts.map((h) => `https://${h}`)].join(" "),
    "style-src 'unsafe-inline'",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}

// Readable defaults; the email's own styles come after and win.
const BASELINE_CSS = [
  "html,body{margin:0;padding:0;background:#fff;color:#0f172a}",
  "html{overflow-y:hidden}",
  'body{padding:14px 16px;font:14px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere;word-break:break-word}',
  // DD's EmailBody rule: no height:auto, which would turn an email's sized
  // spacer images (a 1x1 GIF at width=600 height=1) into big blank squares.
  "img{max-width:100%}",
  "table{max-width:100%}",
  "pre{white-space:pre-wrap}",
  "blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:3px solid #e2e8f0;color:#475569}",
  "a{color:#4f46e5}",
  ".dd-inline-image{display:inline-block;margin:2px 0;padding:2px 8px;border:1px dashed #cbd5e1;border-radius:6px;color:#64748b;font-size:12px}"
].join("");

/**
 * The srcdoc for one email body. Never throws for any input string; a
 * non-string is an empty email.
 */
export function buildEmailSrcdoc(html: string, opts: EmailSrcdocOptions): EmailSrcdoc {
  const raw = typeof html === "string" ? html : "";
  const truncated = raw.length > MAX_EMAIL_HTML_CHARS;
  const input = (truncated ? raw.slice(0, MAX_EMAIL_HTML_CHARS) : raw).replace(/\u0000/g, "");
  // The hosts the rewrite keeps are collected here and become the CSP's image
  // sources, so a kept image that redirects anywhere else is refused.
  const hosts = new Set<string>();
  const ctx: SanitizeContext = { showRemote: opts.showRemoteImages === true, remote: 0, inline: 0, hosts };
  const body = sanitizeEmailHtml(input, ctx);
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(emailFrameCsp(ctx.showRemote ? [...hosts] : []))}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<meta charset="utf-8">' +
    '<meta name="color-scheme" content="light">' +
    '<base target="_blank">' +
    `<style>${BASELINE_CSS}</style>`;
  return {
    srcdoc: `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`,
    remoteImages: ctx.showRemote ? 0 : ctx.remote,
    inlineImages: ctx.inline,
    truncated
  };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

// Relative references are resolved against this, never against a DD URL, so a
// reference that would land on DD's page (a path, "https:evil.com", which is
// relative to an https base) shows up as this host and is refused.
const SENTINEL_BASE = "https://email-frame.invalid/base/";
const SENTINEL_HOST = "email-frame.invalid";

// DD's own site: the hosts it is served on, and the registrable domain of its
// canonical host. Session cookies there are host-only, but every
// *.scaledai.org app is same-site with DD, so an image request to one of
// them goes out with that app's cookies. An email image never needs them.
const OWN_SITE = (() => {
  try {
    return new URL(CANONICAL_ORIGIN).hostname.toLowerCase().split(".").slice(-2).join(".");
  } catch {
    return "scaledai.org";
  }
})();

function isOwnSiteHost(host: string): boolean {
  if (isDdHost(host)) return true;
  const h = host.toLowerCase().replace(/\.+$/, "");
  return h === OWN_SITE || h.endsWith(`.${OWN_SITE}`);
}

/**
 * What the URL parser does first: drop tabs and newlines anywhere, trim C0
 * controls and spaces at both ends. The trim is a loop, not a regex: a value
 * is sender-controlled, and "[\0- ]+$" backtracks quadratically on a long
 * run of spaces in the middle.
 */
function cleanUrl(raw: string): string {
  const s = raw.replace(/[\t\n\r]/g, "");
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end -= 1;
  return s.slice(start, end);
}

function parseAgainstSentinel(value: string): URL | null {
  try {
    return new URL(value, SENTINEL_BASE);
  } catch {
    return null;
  }
}

/**
 * A remote image URL that may load once he asks for images: written as an
 * absolute https: URL (so neither relative nor protocol-relative), no
 * credentials, and a host that isn't DD's site. Returns the URL in its
 * canonical form, the exact string the output carries, or null.
 */
export function allowedRemoteImageUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const value = cleanUrl(raw);
  if (!/^https:/i.test(value)) return null;
  const url = parseAgainstSentinel(value);
  if (!url || url.protocol !== "https:") return null;
  if (url.hostname === SENTINEL_HOST || url.username !== "" || url.password !== "") return null;
  // A host the frame's CSP can name exactly (see emailFrameCsp); anything
  // else (an IPv6 literal, a host with ";" or ",") is simply not loaded.
  if (!CSP_HOST.test(url.host)) return null;
  if (isOwnSiteHost(url.hostname)) return null;
  return url.href;
}

/** An embedded (data:) image: no request at all. */
function isDataImageUrl(raw: string): boolean {
  return /^data:image\//i.test(cleanUrl(raw));
}

function isDataUrl(raw: string): boolean {
  return /^data:/i.test(cleanUrl(raw));
}

function isCidUrl(raw: string): boolean {
  return /^cid:/i.test(cleanUrl(raw));
}

/**
 * A link target: an absolute http(s) URL (canonical form) or a mailto:/tel:
 * address. Everything else (javascript:, data:, relative paths that would
 * open a DD page, protocol-relative URLs) is dropped.
 */
export function allowedLinkUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const value = cleanUrl(raw);
  if (/^(?:mailto|tel):/i.test(value)) return value;
  if (!/^https?:/i.test(value)) return null;
  const url = parseAgainstSentinel(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  if (url.hostname === SENTINEL_HOST || url.username !== "" || url.password !== "") return null;
  return url.href;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** What one build counts while it rewrites. */
export interface SanitizeContext {
  showRemote: boolean;
  /** Remote images withheld. */
  remote: number;
  /** cid: images replaced. */
  inline: number;
  /** With showRemote: the hosts (host[:port]) of every remote image URL kept, for the CSP. */
  hosts?: Set<string>;
}

/** Note the host of a remote image URL the output keeps (it is already canonical). */
function keepHost(ctx: SanitizeContext, href: string): void {
  if (!ctx.hosts) return;
  try {
    ctx.hosts.add(new URL(href).host);
  } catch {
    // allowedRemoteImageUrl only returns parsed URLs; nothing to note otherwise.
  }
}

interface Doc {
  html: string;
  /** html with A-Z lowercased and nothing else, so its indexes are html's. Built once per document. */
  lower: string;
}

interface Attr {
  name: string;
  /** Decoded, as the browser would hand it to the element. */
  value: string;
}

interface Tag {
  name: string;
  attrs: Attr[];
  /** Index just past the tag's ">". */
  end: number;
}

// Elements that fetch, navigate or submit: kept in the document under an
// inert name (an unknown element does nothing) with no attributes at all.
const RENAME_INERT: ReadonlySet<string> = new Set([
  "meta",
  "link",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "portal",
  "fencedframe",
  "bgsound",
  "isindex",
  "keygen",
  // Raw text to a browser (xmp) or to the end of the document (plaintext);
  // renamed so what follows still reads as the email.
  "xmp",
  "plaintext"
]);

// Void elements: no content and no end tag (the renamed ones are closed on the spot).
const VOID: ReadonlySet<string> = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

// Gone with everything inside them: never shown, or only code.
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set(["script", "title", "noembed", "noframes"]);

// Tags dropped while their content stays: wrappers this document supplies
// itself (html, head); form controls, which can never submit here (the form
// is renamed, the sandbox has no allow-forms, the CSP has form-action
// 'none') and would only leave a "confirm your password" box on screen; and
// the ones that fetch with no way to make them safe: video and audio (their
// sources are gone, so only an empty player with the browser's controls would
// be left; the fallback text shows instead), picture/video/audio sources and
// tracks, SVG references to other documents (use, feImage, tref, cursor,
// font-face-uri, color-profile) and SVG animation, which can rewrite an href
// after this code has checked it.
const DROP_TAG: ReadonlySet<string> = new Set([
  "html",
  "head",
  "input",
  "button",
  "select",
  "option",
  "optgroup",
  "datalist",
  "textarea",
  "output",
  "video",
  "audio",
  "source",
  "track",
  "param",
  "use",
  "feimage",
  "tref",
  "cursor",
  "font-face-uri",
  "color-profile",
  "animate",
  "animatemotion",
  "animatetransform",
  "animatecolor",
  "set",
  "discard",
  "mpath",
  "handler",
  "listener"
]);

// Attributes that name something to fetch, submit to or ping, removed from
// every element (img keeps src/srcset and a/area keep href, under the rules
// below). referrerpolicy goes too: on an element it would override the
// document's no-referrer.
const URL_ATTRS: ReadonlySet<string> = new Set([
  "src",
  "srcset",
  "href",
  "xlink:href",
  "xml:base",
  "background",
  "poster",
  "lowsrc",
  "dynsrc",
  "data",
  "codebase",
  "archive",
  "classid",
  "manifest",
  "ping",
  "formaction",
  "action",
  "icon",
  "longdesc",
  "profile",
  "srcdoc",
  "referrerpolicy",
  "integrity",
  "crossorigin",
  "nonce"
]);

// Declarative behaviour with no place in a read-only email.
const BEHAVIOUR_ATTRS: ReadonlySet<string> = new Set([
  "autofocus",
  "shadowroot",
  "shadowrootmode",
  "shadowrootdelegatesfocus",
  "shadowrootclonable",
  "shadowrootserializable",
  "popover",
  "popovertarget",
  "popovertargetaction",
  "http-equiv"
]);

// Attributes whose value the browser parses as CSS: the style attribute and
// the SVG presentation attributes that take a url() (an external filter,
// mask, clip path, marker, paint server or cursor). Their values go through
// the CSS filter; no other attribute is ever read as CSS.
const CSS_VALUE_ATTRS: ReadonlySet<string> = new Set([
  "style",
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "cursor",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "color-profile"
]);

const ATTR_NAME = /^[a-z_:][a-z0-9_:.-]*$/;
const TAG_NAME = /^[a-z][a-z0-9-]*$/;

const isWs = (c: number) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isAsciiAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

function escapeText(s: string): string {
  return s.replace(/</g, "&lt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One tag from just after "<" (start tag) or "</" (end tag), read the way
 * the browser's tokenizer reads it: the name runs to whitespace, "/" or ">";
 * attribute names to whitespace, "/", ">" or "="; values quoted or unquoted;
 * a repeated attribute keeps its first value. null when the input ends
 * inside the tag (the browser drops such a tag too).
 */
function readTag(html: string, from: number): Tag | null {
  const n = html.length;
  let i = from;
  while (i < n) {
    const c = html.charCodeAt(i);
    if (isWs(c) || c === 0x2f || c === 0x3e) break;
    i += 1;
  }
  const name = asciiLower(html.slice(from, i));
  const attrs: Attr[] = [];
  const seen = new Set<string>();
  for (;;) {
    while (i < n && (isWs(html.charCodeAt(i)) || html.charCodeAt(i) === 0x2f)) i += 1;
    if (i >= n) return null;
    if (html.charCodeAt(i) === 0x3e) return { name, attrs, end: i + 1 };
    const nameStart = i;
    i += 1; // the first character is part of the name, even "="
    while (i < n) {
      const c = html.charCodeAt(i);
      if (isWs(c) || c === 0x2f || c === 0x3e || c === 0x3d) break;
      i += 1;
    }
    const attrName = asciiLower(html.slice(nameStart, i));
    while (i < n && isWs(html.charCodeAt(i))) i += 1;
    let value = "";
    if (i < n && html.charCodeAt(i) === 0x3d) {
      i += 1;
      while (i < n && isWs(html.charCodeAt(i))) i += 1;
      if (i >= n) return null;
      const q = html.charCodeAt(i);
      if (q === 0x22 || q === 0x27) {
        const close = html.indexOf(q === 0x22 ? '"' : "'", i + 1);
        if (close === -1) return null;
        value = decodeAttributeValue(html.slice(i + 1, close));
        i = close + 1;
      } else if (q !== 0x3e) {
        const start = i;
        while (i < n && !isWs(html.charCodeAt(i)) && html.charCodeAt(i) !== 0x3e) i += 1;
        if (i >= n) return null;
        value = decodeAttributeValue(html.slice(start, i));
      }
    }
    if (!seen.has(attrName)) {
      seen.add(attrName);
      attrs.push({ name: attrName, value });
    }
  }
}

/** Index just past the next ">" at or after `from`, or the end. */
function skipPast(html: string, from: number, ch: string): number {
  const at = html.indexOf(ch, from);
  return at === -1 ? html.length : at + 1;
}

/**
 * Past a "<!…": a comment, ended where the browser ends one ("<!-->",
 * "<!--->", "-->" or "--!>"), or a bogus comment (doctype, CDATA, …) to the
 * next ">". One forward scan per comment, so many comments stay linear.
 */
function skipMarkupDeclaration(html: string, lt: number): number {
  if (html.startsWith("<!--", lt)) {
    const j = lt + 4;
    if (html.charCodeAt(j) === 0x3e) return j + 1; // <!-->
    if (html.startsWith("->", j)) return j + 2; // <!--->
    for (let k = html.indexOf("--", j); k !== -1; k = html.indexOf("--", k + 1)) {
      if (html.charCodeAt(k + 2) === 0x3e) return k + 3;
      if (html.charCodeAt(k + 2) === 0x21 && html.charCodeAt(k + 3) === 0x3e) return k + 4;
    }
    return html.length;
  }
  return skipPast(html, lt + 2, ">");
}

/**
 * Where a raw-text element (script, style, title, …) ends: just past its end
 * tag, matched the way the browser matches it ("</name" in any case, then
 * whitespace, "/" or ">"), and where its text ends. Without an end tag both
 * are the end of the input.
 */
function rawTextEnd(doc: Doc, from: number, name: string): { textEnd: number; next: number } {
  const needle = `</${name}`;
  let at = doc.lower.indexOf(needle, from);
  while (at !== -1) {
    const after = doc.html.charCodeAt(at + needle.length);
    if (isWs(after) || after === 0x2f || after === 0x3e) return { textEnd: at, next: skipPast(doc.html, at + needle.length, ">") };
    at = doc.lower.indexOf(needle, at + 1);
  }
  return { textEnd: doc.html.length, next: doc.html.length };
}

/**
 * The email's HTML, rebuilt. Exported for tests; buildEmailSrcdoc wraps it.
 */
export function sanitizeEmailHtml(html: string, ctx: SanitizeContext = { showRemote: false, remote: 0, inline: 0 }): string {
  const doc: Doc = { html, lower: html.replace(/[A-Z]+/g, (m) => m.toLowerCase()) };
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(escapeText(html.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(html.slice(i, lt)));
    i = lt;
    const next = html.charCodeAt(i + 1);
    if (isAsciiAlpha(next)) {
      const tag = readTag(html, i + 1);
      if (tag === null) break;
      i = startTag(tag, doc, out, ctx);
      continue;
    }
    if (next === 0x2f) {
      const after = html.charCodeAt(i + 2);
      if (isAsciiAlpha(after)) {
        const tag = readTag(html, i + 2);
        if (tag === null) break;
        endTag(tag.name, out);
        i = tag.end;
      } else if (after === 0x3e) {
        i += 3; // "</>" is ignored
      } else if (Number.isNaN(after)) {
        out.push("&lt;/");
        i += 2;
      } else {
        i = skipPast(html, i + 2, ">"); // "</ x>" and the like: a bogus comment
      }
      continue;
    }
    if (next === 0x21) {
      i = skipMarkupDeclaration(html, i);
      continue;
    }
    if (next === 0x3f) {
      i = skipPast(html, i + 2, ">");
      continue;
    }
    out.push("&lt;");
    i += 1;
  }
  return out.join("");
}

/** Emits a start tag (or what replaces it) and returns where reading continues. */
function startTag(tag: Tag, doc: Doc, out: string[], ctx: SanitizeContext): number {
  let name = tag.name;
  if (!TAG_NAME.test(name)) return tag.end; // a name no real element has: the tag goes, its content stays

  if (DROP_WITH_CONTENT.has(name)) return rawTextEnd(doc, tag.end, name).next;
  if (name === "style") {
    const { textEnd, next } = rawTextEnd(doc, tag.end, "style");
    const css = filterCss(doc.html.slice(tag.end, textEnd), ctx);
    if (css.trim() !== "") out.push(`<style>${css}</style>`);
    return next;
  }
  if (DROP_TAG.has(name)) return tag.end;
  if (RENAME_INERT.has(name)) {
    out.push(`<dd-blocked-${name}>`);
    if (VOID.has(name)) out.push(`</dd-blocked-${name}>`);
    return tag.end;
  }
  if (name === "image") name = "img"; // the parser turns <image> into <img>; so does this
  if (name === "img") {
    out.push(imageTag(tag.attrs, ctx));
    return tag.end;
  }

  let attrs = tag.attrs.flatMap((a) => cleanAttr(a, ctx));
  if (name === "a" || name === "area") attrs = linkAttrs(tag.attrs, attrs);
  if (name === "body") {
    // His email's <body> becomes a block in this document's body, so its
    // look (background, padding) survives without touching the frame's own.
    name = "div";
    attrs = bodyAttrs(tag.attrs, attrs);
  }
  out.push(`<${name}${attrs.map(serializeAttr).join("")}>`);
  return tag.end;
}

function endTag(rawName: string, out: string[]): void {
  let name = rawName;
  if (!TAG_NAME.test(name) || DROP_WITH_CONTENT.has(name) || DROP_TAG.has(name) || name === "style") return;
  if (name === "image") name = "img";
  if (VOID.has(name) && name !== "br") return;
  if (RENAME_INERT.has(name)) {
    if (!VOID.has(name)) out.push(`</dd-blocked-${name}>`);
    return;
  }
  if (name === "body") name = "div";
  out.push(`</${name}>`);
}

function attrValue(attrs: readonly Attr[], name: string): string {
  return attrs.find((a) => a.name === name)?.value ?? "";
}

function serializeAttr(a: Attr): string {
  return ` ${a.name}="${escapeAttr(a.value)}"`;
}

/**
 * One attribute of an ordinary element, or nothing: event handlers, URL
 * attributes, behaviour switches and malformed names go; a CSS-valued
 * attribute (style, SVG presentation) goes through the CSS filter; target and
 * rel are left to linkAttrs.
 */
function cleanAttr(a: Attr, ctx: SanitizeContext): Attr[] {
  const { name } = a;
  if (!ATTR_NAME.test(name)) return [];
  if (name.startsWith("on")) return [];
  if (URL_ATTRS.has(name) || BEHAVIOUR_ATTRS.has(name)) return [];
  if (name === "target" || name === "rel") return [];
  if (CSS_VALUE_ATTRS.has(name)) {
    const css = filterCss(a.value, ctx).trim();
    return css === "" ? [] : [{ name, value: css }];
  }
  return [a];
}

/** a/area: the href when it is a real link, and always a new tab without an opener or a referrer. */
function linkAttrs(raw: readonly Attr[], cleaned: Attr[]): Attr[] {
  const out = [...cleaned];
  const href = allowedLinkUrl(attrValue(raw, "href"));
  if (href !== null && raw.some((a) => a.name === "href")) {
    out.push({ name: "href", value: href });
    out.push({ name: "target", value: "_blank" });
    out.push({ name: "rel", value: "noopener noreferrer" });
  }
  return out;
}

const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,30})$/i;

function bodyAttrs(raw: readonly Attr[], cleaned: Attr[]): Attr[] {
  const out = cleaned.filter((a) => a.name !== "class" && a.name !== "bgcolor");
  const bg = attrValue(raw, "bgcolor").trim();
  if (SAFE_COLOR.test(bg)) {
    const style = out.find((a) => a.name === "style");
    const decl = `background-color:${bg}`;
    if (style) style.value = `${decl};${style.value}`;
    else out.push({ name: "style", value: decl });
  }
  out.push({ name: "class", value: "dd-email-body" });
  return out;
}

/**
 * <img>: a cid: image becomes a placeholder; a data: image stays; a remote
 * one keeps its allowed URLs only when images are shown, and is counted
 * (and loses its URLs) when they aren't. Everything else about the element
 * goes through cleanAttr.
 */
function imageTag(attrs: readonly Attr[], ctx: SanitizeContext): string {
  const src = attrs.some((a) => a.name === "src") ? attrValue(attrs, "src") : null;
  const srcset = attrs.some((a) => a.name === "srcset") ? attrValue(attrs, "srcset") : null;
  if (src !== null && isCidUrl(src)) {
    ctx.inline += 1;
    const alt = attrValue(attrs, "alt").replace(/\s+/g, " ").trim().slice(0, 120);
    return `<span class="dd-inline-image">${escapeText(alt ? `[Inline image: ${alt}]` : "[Inline image]").replace(/>/g, "&gt;")}</span>`;
  }
  const kept = attrs.flatMap((a) => cleanAttr(a, ctx));
  if (src !== null && isDataImageUrl(src)) {
    kept.push({ name: "src", value: cleanUrl(src) });
    return `<img${kept.map(serializeAttr).join("")}>`;
  }
  const remoteSrc = src === null ? null : allowedRemoteImageUrl(src);
  const remoteSet = srcset === null ? [] : allowedSrcset(srcset);
  if (remoteSrc === null && remoteSet.length === 0) return `<img${kept.map(serializeAttr).join("")}>`;
  if (!ctx.showRemote) {
    ctx.remote += 1;
    return `<img${kept.map(serializeAttr).join("")}>`;
  }
  if (remoteSrc !== null) {
    kept.push({ name: "src", value: remoteSrc });
    keepHost(ctx, remoteSrc);
  }
  if (remoteSet.length > 0) {
    kept.push({ name: "srcset", value: remoteSet.join(", ") });
    for (const candidate of remoteSet) keepHost(ctx, candidate.split(" ")[0]);
  }
  return `<img${kept.map(serializeAttr).join("")}>`;
}

const DESCRIPTOR = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[wx]|h)$/i;

/**
 * The allowed candidates of a srcset, each as "<canonical URL>[ descriptor]".
 * Split the way the browser splits one: a URL runs to whitespace (trailing
 * commas end the candidate), descriptors run to the next comma outside
 * parentheses. A candidate with an odd descriptor is dropped.
 */
function allowedSrcset(srcset: string): string[] {
  const out: string[] = [];
  const s = srcset;
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isWs(s.charCodeAt(i)) || s.charCodeAt(i) === 0x2c)) i += 1;
    if (i >= n) break;
    const start = i;
    while (i < n && !isWs(s.charCodeAt(i))) i += 1;
    let url = s.slice(start, i);
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const dStart = i;
      let depth = 0;
      while (i < n) {
        const c = s.charCodeAt(i);
        if (c === 0x28) depth += 1;
        else if (c === 0x29) depth = Math.max(0, depth - 1);
        else if (c === 0x2c && depth === 0) break;
        i += 1;
      }
      descriptors = s.slice(dStart, i).trim();
      i += 1;
    }
    const href = allowedRemoteImageUrl(url);
    const parts = descriptors === "" ? [] : descriptors.split(/\s+/);
    if (href === null || parts.length > 1 || (parts.length === 1 && !DESCRIPTOR.test(parts[0]))) continue;
    out.push(parts.length === 1 ? `${href} ${parts[0]}` : href);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Character references in attribute values
// ---------------------------------------------------------------------------

// The named references emails actually use, plus the ones that spell URL
// syntax (colon, sol, Tab, NewLine, …). A name not listed stays as written:
// the output re-encodes "&", so the browser then sees it literally too, which
// keeps what this code checked and what the browser uses the same.
const NAMED: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  iexcl: "¡",
  iquest: "¿",
  shy: "­",
  zwj: "‍",
  zwnj: "‌",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  hearts: "♥",
  check: "✓",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
  szlig: "ß",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  // URL syntax, the usual way to hide a scheme or a path from a naive check.
  colon: ":",
  sol: "/",
  bsol: "\\",
  period: ".",
  comma: ",",
  semi: ";",
  excl: "!",
  quest: "?",
  num: "#",
  percnt: "%",
  commat: "@",
  equals: "=",
  plus: "+",
  lpar: "(",
  rpar: ")",
  lsqb: "[",
  rsqb: "]",
  lcub: "{",
  rcub: "}",
  lowbar: "_",
  dollar: "$",
  ast: "*",
  grave: "`",
  Hat: "^",
  verbar: "|",
  Tab: "\t",
  NewLine: "\n"
});

// The few names browsers also decode without a ";" (the legacy set), when no
// "=" or letter/digit follows (the attribute-value rule).
const LEGACY_NO_SEMICOLON: ReadonlySet<string> = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"]);

// Numeric references to 0x80-0x9F mean windows-1252, as in browsers.
const C1_REMAP: Readonly<Record<number, number>> = Object.freeze({
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178
});

function codePointFrom(n: number): string {
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return String.fromCodePoint(C1_REMAP[n] ?? n);
}

/** An attribute value as the browser decodes it (numeric references, and the named ones above). */
function decodeAttributeValue(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (match, hex, dec, name, semi, offset, whole) => {
    // Leading zeros don't count; anything still longer than 0x10FFFF can be is out of range.
    if (hex !== undefined) {
      const digits = (hex as string).replace(/^0+/, "");
      return codePointFrom(digits.length > 6 ? 0x110000 : parseInt(digits || "0", 16));
    }
    if (dec !== undefined) {
      const digits = (dec as string).replace(/^0+/, "");
      return codePointFrom(digits.length > 7 ? 0x110000 : parseInt(digits || "0", 10));
    }
    const value = Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : undefined;
    if (value === undefined) return match;
    if (semi === ";") return value;
    const following = (whole as string).charAt((offset as number) + match.length);
    if (LEGACY_NO_SEMICOLON.has(name) && !/[=A-Za-z0-9]/.test(following)) return value;
    return match;
  });
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------
//
// A tokenizer after CSS Syntax Level 3, enough to find every token that can
// fetch: url tokens (unquoted url(...)), functions that take a URL or an
// image (url("..."), src(), image-set(), image(), cross-fade(), element(),
// attr(), any vendor variant), and @import. Escapes are resolved first, as
// the browser resolves them ("\75 rl(" is url(). Everything else is copied
// through unchanged; an allowed reference is kept as written, a disallowed
// one becomes `none` (which leaves the declaration invalid, so the browser
// drops it), and @import becomes an empty comment. Then "<" and "&" are
// written as CSS escapes, so the text reads the same as raw text inside
// <style> and as markup text inside <svg><style>. Finally the result is
// scanned again; if anything disallowed is still there the CSS is dropped.

type CssMode = "rewrite" | "audit";

interface CssScan {
  out: string[];
  /** Audit: a disallowed reference was found. */
  bad: boolean;
}

function cssPreprocess(s: string): string {
  return s.replace(/\r\n|[\r\f]/g, "\n").replace(/\u0000/g, "�");
}

const isHex = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isNameStart = (c: number) => isAsciiAlpha(c) || c === 0x5f || c >= 0x80;
const isNameChar = (c: number) => isNameStart(c) || isDigit(c) || c === 0x2d;
const isCssWs = (c: number) => c === 0x0a || c === 0x09 || c === 0x20;

function validEscape(s: string, i: number): boolean {
  return s.charCodeAt(i) === 0x5c && s.charCodeAt(i + 1) !== 0x0a;
}

function startsIdent(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c === 0x2d) {
    const d = s.charCodeAt(i + 1);
    return isNameStart(d) || d === 0x2d || validEscape(s, i + 1);
  }
  if (isNameStart(c)) return true;
  return validEscape(s, i);
}

function startsNumber(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c === 0x2b || c === 0x2d) {
    const d = s.charCodeAt(i + 1);
    return isDigit(d) || (d === 0x2e && isDigit(s.charCodeAt(i + 2)));
  }
  if (c === 0x2e) return isDigit(s.charCodeAt(i + 1));
  return isDigit(c);
}

/** An escape from just after the "\": its code point and where the next character starts. */
function consumeEscape(s: string, i: number): { cp: string; next: number } {
  if (i >= s.length) return { cp: "�", next: i };
  if (isHex(s.charCodeAt(i))) {
    let j = i;
    while (j < s.length && j - i < 6 && isHex(s.charCodeAt(j))) j += 1;
    const cp = codePointFrom(parseInt(s.slice(i, j), 16));
    if (isCssWs(s.charCodeAt(j))) j += 1;
    return { cp, next: j };
  }
  const cp = String.fromCodePoint(s.codePointAt(i) ?? 0xfffd);
  return { cp, next: i + cp.length };
}

function consumeName(s: string, i: number): { name: string; next: number } {
  let name = "";
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isNameChar(c)) {
      const cp = String.fromCodePoint(s.codePointAt(j) ?? c);
      name += cp;
      j += cp.length;
    } else if (validEscape(s, j)) {
      const e = consumeEscape(s, j + 1);
      name += e.cp;
      j = e.next;
    } else break;
  }
  return { name, next: j };
}

function consumeString(s: string, i: number, quote: number): { value: string; next: number } {
  let value = "";
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === quote) return { value, next: j + 1 };
    if (c === 0x0a) return { value, next: j }; // a bad string ends before the newline
    if (c === 0x5c) {
      if (j + 1 >= s.length) return { value, next: j + 1 };
      if (s.charCodeAt(j + 1) === 0x0a) {
        j += 2;
        continue;
      }
      const e = consumeEscape(s, j + 1);
      value += e.cp;
      j = e.next;
      continue;
    }
    value += s[j];
    j += 1;
  }
  return { value, next: j };
}

const isNonPrintable = (c: number) => c <= 0x08 || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;

/** An unquoted url token from just after "url(" and its whitespace; bad means the browser would make it a bad-url token. */
function consumeUrlToken(s: string, i: number): { value: string; next: number; bad: boolean } {
  let value = "";
  let j = i;
  while (j < s.length && isCssWs(s.charCodeAt(j))) j += 1;
  for (;;) {
    if (j >= s.length) return { value, next: j, bad: false };
    const c = s.charCodeAt(j);
    if (c === 0x29) return { value, next: j + 1, bad: false };
    if (isCssWs(c)) {
      while (j < s.length && isCssWs(s.charCodeAt(j))) j += 1;
      if (j >= s.length) return { value, next: j, bad: false };
      if (s.charCodeAt(j) === 0x29) return { value, next: j + 1, bad: false };
      return { value, next: badUrlRemnants(s, j), bad: true };
    }
    if (c === 0x22 || c === 0x27 || c === 0x28 || isNonPrintable(c)) return { value, next: badUrlRemnants(s, j), bad: true };
    if (c === 0x5c) {
      if (!validEscape(s, j)) return { value, next: badUrlRemnants(s, j), bad: true };
      const e = consumeEscape(s, j + 1);
      value += e.cp;
      j = e.next;
      continue;
    }
    value += s[j];
    j += 1;
  }
}

function badUrlRemnants(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 0x29) return j + 1;
    if (validEscape(s, j)) {
      j = consumeEscape(s, j + 1).next;
      continue;
    }
    j += 1;
  }
  return j;
}

/** A function whose arguments are, or can carry, a URL or an image. */
function isResourceFunction(lname: string): boolean {
  return lname === "src" || lname === "attr" || /url|image|fade|element/.test(lname);
}

/** A URL CSS may reference: data: always; remote images only when shown (and allowed). */
function cssUrlAllowed(value: string, ctx: SanitizeContext, mode: CssMode): boolean {
  if (isDataUrl(value)) return true;
  const remote = allowedRemoteImageUrl(value);
  if (remote === null) return false;
  if (ctx.showRemote) return true;
  if (mode === "rewrite") ctx.remote += 1;
  return false;
}

/** The hosts of the remote URLs a kept CSS reference loads, for the CSP. */
function keepCssHosts(ctx: SanitizeContext, mode: CssMode, urls: readonly string[]): void {
  if (mode !== "rewrite" || !ctx.showRemote) return;
  for (const u of urls) {
    const remote = allowedRemoteImageUrl(u);
    if (remote !== null) keepHost(ctx, remote);
  }
}

/**
 * The tokens of a resource function's arguments, from just after its "("
 * to just past its matching ")" (or the end). Every string and url token in
 * it is a URL; a nested function other than url()/src() makes it unknowable
 * (var() could substitute anything), and so does finding no URL at all.
 */
function scanResourceArgs(s: string, i: number): { next: number; urls: string[]; opaque: boolean } {
  const urls: string[] = [];
  let opaque = false;
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 0x2f && s.charCodeAt(j + 1) === 0x2a) {
      const close = s.indexOf("*/", j + 2);
      j = close === -1 ? s.length : close + 2;
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      const str = consumeString(s, j + 1, c);
      urls.push(str.value);
      j = str.next;
      continue;
    }
    if (c === 0x29) {
      if (depth === 0) return { next: j + 1, urls, opaque };
      depth -= 1;
      j += 1;
      continue;
    }
    if (c === 0x28) {
      depth += 1;
      j += 1;
      continue;
    }
    if (startsNumber(s, j)) {
      j = consumeNumeric(s, j);
      continue;
    }
    if (startsIdent(s, j)) {
      const { name, next } = consumeName(s, j);
      const lname = asciiLower(name);
      if (s.charCodeAt(next) === 0x28) {
        if (lname === "url") {
          const u = urlAfterParen(s, next + 1);
          if (u.kind === "token") {
            if (u.bad) opaque = true;
            urls.push(u.value);
            j = u.next;
            continue;
          }
        } else if (lname !== "src") {
          opaque = true;
        }
        depth += 1;
        j = next + 1;
        continue;
      }
      j = next;
      continue;
    }
    if (c === 0x5c) {
      // A lone backslash (not a valid escape) is a delim.
      j += 1;
      continue;
    }
    j += 1;
  }
  return { next: j, urls, opaque };
}

function consumeNumeric(s: string, i: number): number {
  let j = i;
  if (s.charCodeAt(j) === 0x2b || s.charCodeAt(j) === 0x2d) j += 1;
  while (isDigit(s.charCodeAt(j))) j += 1;
  if (s.charCodeAt(j) === 0x2e && isDigit(s.charCodeAt(j + 1))) {
    j += 1;
    while (isDigit(s.charCodeAt(j))) j += 1;
  }
  const e = s.charCodeAt(j);
  if (e === 0x45 || e === 0x65) {
    const d = s.charCodeAt(j + 1);
    if (isDigit(d)) j += 1;
    else if ((d === 0x2b || d === 0x2d) && isDigit(s.charCodeAt(j + 2))) j += 2;
    while (isDigit(s.charCodeAt(j))) j += 1;
  }
  if (startsIdent(s, j)) return consumeName(s, j).next;
  if (s.charCodeAt(j) === 0x25) return j + 1;
  return j;
}

/**
 * After "url(": per the spec, a quote (after at most one space) makes it a
 * url() FUNCTION whose argument is a string; anything else is a url TOKEN
 * running to ")".
 */
function urlAfterParen(s: string, i: number): { kind: "function" } | { kind: "token"; value: string; next: number; bad: boolean } {
  let j = i;
  while (isCssWs(s.charCodeAt(j)) && isCssWs(s.charCodeAt(j + 1))) j += 1;
  const c = s.charCodeAt(j);
  const d = s.charCodeAt(j + 1);
  if (c === 0x22 || c === 0x27 || (isCssWs(c) && (d === 0x22 || d === 0x27))) return { kind: "function" };
  return { kind: "token", ...consumeUrlToken(s, j) };
}

/** Index of the end of an @import rule: just past its ";" at depth 0, or at a "}" closing its block, or the end. */
function importRuleEnd(s: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 0x2f && s.charCodeAt(j + 1) === 0x2a) {
      const close = s.indexOf("*/", j + 2);
      j = close === -1 ? s.length : close + 2;
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      j = consumeString(s, j + 1, c).next;
      continue;
    }
    if (validEscape(s, j)) {
      j = consumeEscape(s, j + 1).next;
      continue;
    }
    if (c === 0x28 || c === 0x5b || c === 0x7b) depth += 1;
    else if (c === 0x29 || c === 0x5d) depth = Math.max(0, depth - 1);
    else if (c === 0x7d) {
      if (depth === 0) return j;
      depth -= 1;
    } else if (c === 0x3b && depth === 0) return j + 1;
    j += 1;
  }
  return j;
}

function scanCss(s: string, ctx: SanitizeContext, mode: CssMode): CssScan {
  const scan: CssScan = { out: [], bad: false };
  const keep = (from: number, to: number) => {
    if (mode === "rewrite" && to > from) scan.out.push(s.slice(from, to));
  };
  const replace = (text: string) => {
    if (mode === "rewrite") scan.out.push(text);
    else scan.bad = true;
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    // Comments and strings are copied whole: nothing inside them is a token.
    if (c === 0x2f && s.charCodeAt(i + 1) === 0x2a) {
      const close = s.indexOf("*/", i + 2);
      const end = close === -1 ? s.length : close + 2;
      keep(i, end);
      i = end;
      continue;
    }
    if (c === 0x22 || c === 0x27) {
      const end = consumeString(s, i + 1, c).next;
      keep(i, end);
      i = end;
      continue;
    }
    if (c === 0x3c && s.startsWith("<!--", i)) {
      // CDO: ignored by the stylesheet parser; an empty comment keeps the tokens apart.
      if (mode === "rewrite") scan.out.push("/**/");
      i += 4;
      continue;
    }
    if (c === 0x2d && s.startsWith("-->", i)) {
      if (mode === "rewrite") scan.out.push("/**/");
      i += 3;
      continue;
    }
    if (c === 0x40 && startsIdent(s, i + 1)) {
      const { name, next } = consumeName(s, i + 1);
      if (asciiLower(name) === "import") {
        const end = importRuleEnd(s, next);
        replace("/**/");
        i = end;
        continue;
      }
      keep(i, next);
      i = next;
      continue;
    }
    if (c === 0x23 && (isNameChar(s.charCodeAt(i + 1)) || validEscape(s, i + 1))) {
      const next = consumeName(s, i + 1).next;
      keep(i, next);
      i = next;
      continue;
    }
    if (startsNumber(s, i)) {
      const next = consumeNumeric(s, i);
      keep(i, next);
      i = next;
      continue;
    }
    if (startsIdent(s, i)) {
      const { name, next } = consumeName(s, i);
      const lname = asciiLower(name);
      if (s.charCodeAt(next) !== 0x28) {
        keep(i, next);
        i = next;
        continue;
      }
      if (lname === "url") {
        const u = urlAfterParen(s, next + 1);
        if (u.kind === "token") {
          if (!u.bad && cssUrlAllowed(u.value, ctx, mode)) {
            keep(i, u.next);
            keepCssHosts(ctx, mode, [u.value]);
          } else replace("none");
          i = u.next;
          continue;
        }
      }
      if (lname === "url" || isResourceFunction(lname)) {
        const args = scanResourceArgs(s, next + 1);
        let allowed = !args.opaque && args.urls.length > 0;
        if (allowed) {
          // Every URL is judged (and counted) before deciding.
          const verdicts = args.urls.map((u) => cssUrlAllowed(u, ctx, mode));
          allowed = verdicts.every(Boolean);
        }
        if (allowed) {
          keep(i, args.next);
          keepCssHosts(ctx, mode, args.urls);
        } else replace("none");
        i = args.next;
        continue;
      }
      // Any other function: its name and "(" go through; its arguments are scanned as usual.
      keep(i, next + 1);
      i = next + 1;
      continue;
    }
    if (c === 0x5c) {
      // A backslash that doesn't start an escape is a delim.
      keep(i, i + 1);
      i += 1;
      continue;
    }
    const cp = String.fromCodePoint(s.codePointAt(i) ?? c);
    keep(i, i + cp.length);
    i += cp.length;
  }
  return scan;
}

/**
 * CSS with every disallowed fetch removed (see the section comment). An
 * input that still audits dirty after the rewrite (a bug) yields "".
 */
export function filterCss(css: string, ctx: SanitizeContext = { showRemote: false, remote: 0, inline: 0 }): string {
  const s = cssPreprocess(typeof css === "string" ? css : "");
  const rewritten = scanCss(s, ctx, "rewrite")
    .out.join("")
    .replace(/</g, "\\3C ")
    .replace(/&/g, "\\26 ");
  const audit = scanCss(rewritten, { ...ctx }, "audit");
  return audit.bad ? "" : rewritten;
}
