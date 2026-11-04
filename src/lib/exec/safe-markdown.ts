import type { AllowElement, Options, UrlTransform } from "react-markdown";
import { appOrigin, isAllowedLinkUrl } from "@/lib/exec/refs";

// How the exec UI renders model output and any text an outsider wrote (plan
// §8): no images, and links only to the allowlist. Everything else in the text
// still shows, as plain text. The policy sits here, apart from
// components/exec/SafeMarkdown.tsx, so tests check it directly and later
// renderers (the P5 chat) use the same one.
//
// Each layer holds on its own:
//   1. skipHtml. Raw HTML is removed before render. A <img>, <iframe> or
//      <script> in the text never becomes an element and isn't shown as text.
//   2. Elements. A markdown image is a request to whatever server its URL
//      names, with whatever the model put in that URL, the moment the page
//      paints. img is removed, along with the task-list checkbox, which
//      takes input. Anything else outside the plain-prose allowlist is
//      unwrapped: the element goes and its text stays.
//   3. URLs. An href survives only as an allowlisted link (refs.ts: https to
//      DD, Outlook or Slack) or a DD path. Every other URL attribute (src,
//      cite, poster, ...) is dropped outright. A link that loses its href
//      renders as plain text.

/** react-markdown removes these whole (the only non-prose elements remark-gfm emits). */
export const SAFE_MARKDOWN_DISALLOWED: readonly string[] = ["img", "input"];

// The plain prose remark-gfm produces. Footnote <section>/<sup> and anything a
// future plugin adds are unwrapped to their text.
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "p", "br", "hr", "a", "strong", "em", "del", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td"
]);

/** rel on every rendered markdown link. */
export const SAFE_MARKDOWN_LINK_REL = "noopener noreferrer nofollow";

// Generous for Graph webLinks, which run a few hundred characters (refs.ts
// uses the same cap).
const MAX_HREF = 4_096;

// A DD path has one leading "/" ("//host" is another site) and no character a
// URL parser rewrites. Parsers drop tabs and newlines and read "\" as "/", so
// "/\evil.example" or "/<tab>/evil.example" would leave DD as
// "//evil.example". Whitespace and control characters are refused outright.
const UNSAFE_PATH_CHARS = /[\u0000-\u0020\u007f\\]/;
// Paths are resolved against a reserved, never-resolving origin (RFC 2606):
// what comes out has to stay on that origin, which proves the path can't
// leave whatever DD host the browser resolves it against.
const PATH_BASE = "https://dd.invalid";

// The path written into href must itself start with exactly one "/". Dot
// segments collapse when a URL is parsed, so "/..//evil.example" and the
// allowlisted "https://operations.scaledai.org//evil.example" both come out
// with the pathname "//evil.example", which a browser reads as another host.
function pathOf(url: URL): string | null {
  return url.pathname.startsWith("//") ? null : `${url.pathname}${url.search}${url.hash}`;
}

function appPath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.startsWith("//") || UNSAFE_PATH_CHARS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PATH_BASE);
  } catch {
    // Not parseable as a path at all: there's no link to keep.
    return null;
  }
  return url.origin === PATH_BASE ? pathOf(url) : null;
}

function ownOrigin(): string | null {
  try {
    return new URL(appOrigin()).origin;
  } catch {
    // A malformed NEXT_PUBLIC_APP_URL: no link counts as same-origin, and
    // allowlisted ones stay absolute (they still open, in a new tab).
    return null;
  }
}

/** A link that may be rendered: what to put in href, and whether it leaves DD (new tab). */
export interface SafeLink {
  href: string;
  external: boolean;
}

/**
 * The link to render for `raw`, or null when it must stay plain text.
 *   - A DD path ("/tasks/42") stays a path.
 *   - An absolute URL must pass isAllowedLinkUrl (refs.ts). One on the app's
 *     own origin comes back as a path, so it opens on whichever DD host he
 *     is signed in on (the session cookie is per host). If its path couldn't
 *     be written as one (it collapses to "//..."), it stays absolute.
 *   - Everything else is refused: javascript:, data:, mailto:, http:,
 *     "//host", "#anchor", bare relative paths, other hosts.
 */
export function safeLink(raw: string | null | undefined): SafeLink | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_HREF) return null;
  if (raw.startsWith("/")) {
    const path = appPath(raw);
    return path === null ? null : { href: path, external: false };
  }
  if (!isAllowedLinkUrl(raw)) return null;
  const url = new URL(raw);
  const path = url.origin === ownOrigin() ? pathOf(url) : null;
  return path === null ? { href: url.href, external: true } : { href: path, external: false };
}

/** react-markdown's urlTransform: a safe href, and no other URL attribute at all. */
export const safeUrlTransform: UrlTransform = (url, key) => (key === "href" ? safeLink(url)?.href : undefined);

const allowElement: AllowElement = (element) => ALLOWED_ELEMENTS.has(element.tagName);

/** The policy half of react-markdown's props. SafeMarkdown adds remark-gfm and the styled components. */
export const SAFE_MARKDOWN_OPTIONS: Readonly<
  Required<Pick<Options, "skipHtml" | "disallowedElements" | "unwrapDisallowed" | "allowElement" | "urlTransform">>
> = Object.freeze({
  skipHtml: true,
  disallowedElements: SAFE_MARKDOWN_DISALLOWED,
  unwrapDisallowed: true,
  allowElement,
  urlTransform: safeUrlTransform
});
