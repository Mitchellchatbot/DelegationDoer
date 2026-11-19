// The chat page's ?ask= prefill (the guided tour's "Ask the assistant about this"): a question handed over in the URL is
// put in the composer as plain text and NEVER sent. He reads it, edits it if he likes, and presses Send himself, so a
// reload, a shared link or a back button can't spend a model call nobody asked for. Pure and import-free (B4: this
// directory stays client-safe).
//
// The page reads the param on the server and passes the cleaned text to ExecChat, which puts it in the textarea (React
// text, never markup) and drops the param from the address bar so a reload doesn't put it back.

/** The longest question ?ask= can carry. The tour's own questions are far shorter; anything longer is cut, not refused. */
export const ASK_PREFILL_MAX = 300;

const ch = (code: number) => String.fromCharCode(code);
const range = (from: number, to: number) => `${ch(from)}-${ch(to)}`;

// Characters dropped from a prefill, built from code points so this file holds none of them itself:
//   - C0 controls other than tab (0x09) and newline (0x0A), DEL, and the C1 block, so a pasted link can't smuggle
//     terminal or layout codes in;
//   - bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069), which make text read differently from what
//     it is (the boundary scan refuses them in source for the same reason).
const DROPPED = new RegExp(
  `[${range(0x00, 0x08)}${ch(0x0b)}${ch(0x0c)}${range(0x0e, 0x1f)}${range(0x7f, 0x9f)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`,
  "g"
);

/**
 * The text to pre-fill from a raw ?ask= value, or null for none: anything but one string (absent, repeated), or a value
 * that is empty once cleaned. CRLF becomes LF, control and bidi characters go, the ends are trimmed, and the result is
 * cut to ASK_PREFILL_MAX characters (never mid surrogate pair).
 */
export function askPrefillFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/\r\n?/g, "\n").replace(DROPPED, "").trim();
  if (text.length > ASK_PREFILL_MAX) {
    text = text.slice(0, ASK_PREFILL_MAX);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text === "" ? null : text;
}

/** The address with ?ask= removed and every other param, and the hash, kept: what the page replaces its URL with. */
export function withoutAskParam(pathname: string, search: string, hash = ""): string {
  const params = new URLSearchParams(search);
  params.delete("ask");
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}

/** The chat page with a question for its composer (capped here too, so the URL itself stays short). */
export function chatAskHref(chatPath: string, question: string): string {
  const text = askPrefillFrom(question);
  return text === null ? chatPath : `${chatPath}?ask=${encodeURIComponent(text)}`;
}
