import { CANONICAL_ORIGIN, LEGACY_HOST } from "@/lib/canonical-origin";
import type { SourceRef } from "@/lib/exec/types";

// SourceRefs: the citation behind every fact the assistant shows, and the
// only way a link reaches its output. A ref's url is either an allowlisted
// link (host and, on Slack and Outlook, the shape of the path) or null. A
// model, or a hostile email or Slack message, can't push a link to an
// arbitrary site or action through a citation.
//
// No "server-only" here on purpose. The browser needs isAllowedLinkUrl too
// (SafeMarkdown renders off-allowlist links as plain text), and this module is
// pure: NEXT_PUBLIC_APP_URL is inlined into client bundles at build time.

/** The DD origin links point at: NEXT_PUBLIC_APP_URL without a trailing slash, else the canonical host. */
export function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  return configured || CANONICAL_ORIGIN;
}

const DD_HOSTS: readonly string[] = ["operations.scaledai.org", LEGACY_HOST];

// Outlook on the web serves Graph's message webLink from one of these.
const OUTLOOK_HOSTS: readonly string[] = ["outlook.office.com", "outlook.office365.com", "outlook.live.com"];

// Any subdomain of slack.com with well-formed labels (workspace permalinks,
// app.slack.com). "slack.com.evil.io", "evilslack.com", ".slack.com" and a
// trailing-dot "x.slack.com." all fail.
const SLACK_SUBDOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+slack\.com$/;

// The host alone isn't enough on Slack and Outlook. slack.com also serves
// OAuth consent screens and Web API calls (a token and the text to post can
// ride in the query string), and Outlook opens a compose window filled from
// the URL. A link that a model or a hostile message wrote could be one click
// from granting an attacker's app access or from sending a private summary
// out. So on those hosts only the shapes our own refs use pass, and anything
// else is left as text:
//   Slack: a message or channel (/archives/…, with the thread_ts and cid
//     that chat.getPermalink adds to a reply), a file (/files/…,
//     /files-pri/…), the web client (/client/…), and app_redirect to a
//     channel (with app= it opens an app's page, one step from installing it).
//   Outlook: Graph's webLink to one item (/owa/?ItemID=…, for a message or a
//     calendar event), and the mailbox or one message in it under /mail/ with
//     no query string. Compose deep links (/mail/deeplink/…,
//     /owa/?path=/mail/action/compose) and settings pages fail.
// A link with a fragment fails on both, because the web clients route on the
// fragment too. DD's own hosts take any path: a link there stays inside the
// app the user is signed in to.

// Slack sections, each with the query parameters it may carry.
const SLACK_SECTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["archives", new Set(["thread_ts", "cid"])],
  ["files", new Set<string>()],
  ["files-pri", new Set<string>()],
  ["client", new Set<string>()],
  ["app_redirect", new Set(["channel", "team"])]
]);

// Query parameters of Graph's webLink, by lowercased name, with the values
// that keep it a view of one item.
const OWA_ITEM_PARAMS: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ["itemid", (v: string) => v.length > 0],
  ["exvsurl", () => true],
  ["ispopout", () => true],
  ["viewmodel", (v: string) => v.toLowerCase() === "readmessageitem"],
  ["path", (v: string) => v.toLowerCase() === "/calendar/item"]
]);

// Generous for Graph webLinks (an encoded ItemID runs a few hundred chars) and
// small enough that a pasted blob isn't treated as a link.
const MAX_URL = 4_096;

// The WHATWG parser quietly drops tabs and newlines, trims spaces and control
// characters, and reads "\" as "/". A string like that gets refused outright,
// so the string that was checked is always the string a renderer would use.
const UNSAFE_URL_CHARS = /[\u0000- \u007f\\]/;

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    // A malformed NEXT_PUBLIC_APP_URL just contributes no host. The fixed
    // list still covers the real DD hosts, and DD links built from a broken
    // origin fail the check, so they come out as null rather than unsafe.
    return null;
  }
}

function isAllowedSlackLink(url: URL): boolean {
  if (url.hash !== "") return false;
  // pathname is already normalized: "/archives/../api/x" arrives as "/api/x".
  const section = url.pathname.split("/")[1]?.toLowerCase() ?? "";
  const params = SLACK_SECTIONS.get(section);
  if (!params) return false;
  const keys = [...url.searchParams.keys()];
  if (!keys.every((k) => params.has(k))) return false;
  return section !== "app_redirect" || keys.includes("channel");
}

/** Graph's webLink: /owa/?ItemID=… with only the parameters that keep it a view of that item. */
function isOwaItemLink(url: URL): boolean {
  if (url.pathname !== "/owa/" && url.pathname !== "/owa") return false;
  let hasItem = false;
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    const accepts = OWA_ITEM_PARAMS.get(name);
    if (!accepts || !accepts(value)) return false;
    if (name === "itemid") hasItem = true;
  }
  return hasItem;
}

/** The mailbox (/mail, /mail/0/) or one message in it (/mail/[0/][inbox/]id/<id>), with no query string. */
function isOutlookReadView(url: URL): boolean {
  if (url.search !== "") return false;
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  if (segments[0] !== "mail") return false;
  const rest = /^\d+$/.test(segments[1] ?? "") ? segments.slice(2) : segments.slice(1);
  if (rest.length === 0) return true;
  const item = rest.length === 2 ? rest : rest.length === 3 && rest[0] !== "deeplink" ? rest.slice(1) : null;
  return item !== null && item[0] === "id";
}

function isAllowedOutlookLink(url: URL): boolean {
  if (url.hash !== "") return false;
  return isOwaItemLink(url) || isOutlookReadView(url);
}

function isAllowedLocation(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  // Third-party hosts first, so a misconfigured app origin can't widen them.
  if (host === "slack.com" || SLACK_SUBDOMAIN.test(host)) return isAllowedSlackLink(url);
  if (OUTLOOK_HOSTS.includes(host)) return isAllowedOutlookLink(url);
  return DD_HOSTS.includes(host) || host === hostOf(appOrigin());
}

/**
 * True only for an https link, with no userinfo, on the default port, to DD
 * (any page), Outlook on the web (the mailbox or one item) or Slack (a
 * message, file, channel or the web client). Everything else is false:
 * http:, javascript:, data:, other ports, lookalike hosts, and the action
 * endpoints on Slack and Outlook (OAuth, Web API, compose).
 */
export function isAllowedLinkUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL) return false;
  if (UNSAFE_URL_CHARS.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all. The answer is simply "not allowed".
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.port !== "" && parsed.port !== "443") return false;
  return isAllowedLocation(parsed);
}

/** The URL's canonical form when it's allowed, else null. That form is what browsers navigate to. */
function safeUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !isAllowedLinkUrl(url)) return null;
  return new URL(url).href;
}

const MAX_LABEL = 200;

function label(raw: string | null | undefined, fallback: string): string {
  return clipExcerpt(raw ?? "", MAX_LABEL) || clipExcerpt(fallback, MAX_LABEL);
}

// The DD detail routes: src/app/(main)/tasks/[id], clients/[id], projects/[id]
// ("(main)" is a route group, so it isn't part of the path).
function ddUrl(section: "tasks" | "clients" | "projects", id: string): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return safeUrl(`${appOrigin()}/${section}/${encodeURIComponent(id)}`);
}

export function ddTaskRef(task: { id: string; title?: string | null }): SourceRef {
  return { system: "dd", id: task.id, url: ddUrl("tasks", task.id), label: label(task.title, `Task ${task.id}`), class: "internal" };
}

export function ddClientRef(client: { id: string; name?: string | null }): SourceRef {
  return {
    system: "dd",
    id: client.id,
    url: ddUrl("clients", client.id),
    label: label(client.name, `Client ${client.id}`),
    class: "internal"
  };
}

export function ddProjectRef(project: { id: string; name?: string | null }): SourceRef {
  return {
    system: "dd",
    id: project.id,
    url: ddUrl("projects", project.id),
    label: label(project.name, `Project ${project.id}`),
    class: "internal"
  };
}

function ddPageUrl(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  const url = safeUrl(`${appOrigin()}${path}`);
  // Dot segments can still collapse the path to "//host" ("/..//evil.io"),
  // which reads as another host wherever the link is written back as a path.
  return url !== null && new URL(url).pathname.startsWith("//") ? null : url;
}

/**
 * A DD page that isn't one record, e.g. "/approvals?tab=emails". The path
 * must be DD-relative: "/" first and not "//", which a browser would read as
 * another host. Anything else gets no link, like a ref built from a broken
 * origin. The path is the ref's id.
 */
export function ddPageRef(path: string, pageLabel: string): SourceRef {
  return { system: "dd", id: path, url: ddPageUrl(path), label: label(pageLabel, path), class: "internal" };
}

/** An email in the principal's mailbox. Restricted-sender mail is tagged so it stays inside DD (decision R). */
export function outlookMessageRef(msg: {
  id: string;
  webLink?: string | null;
  subject?: string | null;
  restricted?: boolean;
}): SourceRef {
  return {
    system: "outlook",
    id: msg.id,
    url: safeUrl(msg.webLink),
    label: label(msg.subject, "(no subject)"),
    class: msg.restricted ? "restricted" : "public"
  };
}

/** A Slack message. Anything not explicitly public counts as private (private channel, DM, group DM). */
export function slackMessageRef(msg: {
  channelId: string;
  ts: string;
  permalink?: string | null;
  label?: string | null;
  isPrivate: boolean;
}): SourceRef {
  return {
    system: "slack",
    id: `${msg.channelId}:${msg.ts}`,
    url: safeUrl(msg.permalink),
    label: label(msg.label, "Slack message"),
    // Fail closed: a missing flag must not let DM text flow into a draft.
    class: msg.isPrivate === false ? "public" : "private"
  };
}

// Text that untrusted senders control can't carry bidi overrides
// (U+202A–U+202E, U+2066–U+2069). They reorder what the reader sees. C0
// control characters are dropped too, except \t \n \v \f \r, which the
// whitespace collapse turns into spaces. Postgres also refuses NUL and lone
// surrogates, which are replaced.
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/g;
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A one-line quote of at most `max` characters (including the "…"):
 * whitespace collapsed, control characters dropped, never cut through a
 * surrogate pair.
 */
export function clipExcerpt(s: string, max = 280): string {
  const limit = Math.floor(max);
  if (!(limit > 0)) return "";
  // Strip first, collapse last, so a removed character can't leave a double space.
  const text = (typeof s === "string" ? s : "")
    .replace(LONE_SURROGATE, "�")
    .replace(CONTROL, "")
    .replace(BIDI_CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  let end = limit - 1;
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}
