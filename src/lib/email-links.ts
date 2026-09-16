// Link rules for the email composer: which addresses a user may link to, and
// how what they typed becomes an absolute href. Pure (no DOM) — shared by the
// editor (TipTap's isAllowedUri hook, the link dialog) and the HTML serializer.
//
// Only web, email and phone links are allowed. Everything else — javascript:,
// data:, relative paths, other schemes — is refused, so it can't end up in
// outgoing mail or in the editor's own DOM.

// Characters a browser ignores while reading a URL scheme ("java\tscript:").
const INVISIBLE = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u205f\u3000\ufeff]/;

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"']+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

export function looksLikeEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

function isWebUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

// A host we'd prefix with https:// — "example.com", "www.x.co/path",
// "localhost:3000". Must start like a hostname and contain a dot (or be
// localhost), which rules out relative paths and bare words.
function looksLikeHost(s: string): boolean {
  const host = s.split(/[/?#]/)[0];
  if (!/^[a-z0-9]/i.test(host)) return false;
  return /^localhost(:\d+)?$/i.test(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(host);
}

// The absolute href for a user-supplied link, or null if it isn't a link we
// allow. Scheme-less web addresses get https://, bare emails get mailto:.
export function toSafeAbsoluteHref(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw || INVISIBLE.test(raw)) return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1].toLowerCase();

  if (scheme === "mailto") {
    const address = raw.slice("mailto:".length).split("?")[0];
    return looksLikeEmail(decodeURIComponentSafe(address)) ? raw : null;
  }
  if (scheme === "tel") {
    return /^\+?[0-9().-]{3,}$/.test(raw.slice("tel:".length)) ? raw : null;
  }
  if (scheme === "http" || scheme === "https") {
    return isWebUrl(raw) ? raw : null;
  }
  if (raw.startsWith("//")) {
    return isWebUrl(`https:${raw}`) ? `https:${raw}` : null;
  }
  // "example.com:8080" parses as scheme "example.com"; a real scheme is
  // anything else before a colon, and it isn't one we allow.
  if (scheme && !looksLikeHost(raw)) return null;

  if (looksLikeEmail(raw)) return `mailto:${raw}`;
  if (looksLikeHost(raw) && isWebUrl(`https://${raw}`)) return `https://${raw}`;
  return null;
}

// TipTap's isAllowedUri hook. Autolink and paste rules call it with the raw
// typed text ("www.google.com"), so scheme-less input must pass.
export function isAllowedEditorUri(url: string): boolean {
  return toSafeAbsoluteHref(url) !== null;
}

export type LinkKind = "web" | "email" | "phone";

export type NormalizedLink =
  | { ok: true; href: string; kind: LinkKind }
  | { ok: false; reason: "empty" | "unsupported" | "invalid-email" | "invalid" };

// Link dialog input → href, with a reason the dialog can show when it fails.
export function normalizeLinkInput(input: string): NormalizedLink {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "empty" };
  const href = toSafeAbsoluteHref(raw);
  if (href) return { ok: true, href, kind: linkKind(href) };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1].toLowerCase();
  if (scheme && !["http", "https", "mailto", "tel"].includes(scheme) && !looksLikeHost(raw)) {
    return { ok: false, reason: "unsupported" };
  }
  if (raw.includes("@") && !raw.includes("/")) return { ok: false, reason: "invalid-email" };
  return { ok: false, reason: "invalid" };
}

export function linkKind(href: string): LinkKind {
  if (/^mailto:/i.test(href)) return "email";
  if (/^tel:/i.test(href)) return "phone";
  return "web";
}

// What to show a person for an href: the address without its mailto:/tel:.
export function displayHref(href: string): string {
  return href.replace(/^(mailto|tel):/i, "");
}

export function truncateMiddle(s: string, max = 48): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
