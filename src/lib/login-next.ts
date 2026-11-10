// Where the login page goes after a sign-in (P9 fixer security-2). Client-safe and pure.
//
// /login?next= is public: anyone can hand him a link, so the value is only a hint. Before P9 the page navigated to it as
// is, so "javascript:..." ran on DD's origin with the session he had just opened, and "https://elsewhere" turned the
// redirect into a phishing step. Since P9 that session is the one his authenticator code raised to the assistant's level,
// so the target is resolved at navigation time and only a path on this same origin is kept; anything else goes to "/".
// The middleware only ever writes a pathname here (src/middleware.ts), and those always pass.

/** "/" for anything that isn't a same-origin path; else the path with its query and fragment. Never throws. */
export function safeNextPath(raw: string | null | undefined, origin: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    // Control characters, the space and DEL, and the backslash: URL parsers drop tabs and newlines and read a backslash as
    // "/", so "/" + TAB + "/evil.example" or "/" + backslash + "evil.example" would leave DD as "//evil.example".
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return "/";
  }
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(raw, base);
  } catch {
    return "/";
  }
  if (url.origin !== base.origin) return "/";
  // Dot segments collapse when the path is parsed: "/..//evil.example" comes out as the pathname "//evil.example", which a
  // browser reads as another host.
  if (url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
