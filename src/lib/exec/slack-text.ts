// P6: his DM text → the chat question (contract §3.6.1; Area B; pure, no
// imports). Slack sends a message's text in its wire format: the user's own
// "&", "<" and ">" arrive as entities, and every raw "<…>" is a control
// sequence (a mention, a channel, a special mention, a date or a link). The
// question the model reads is plain text, and none of it can come back out
// as a live mention: slack-ui.ts escapes whatever is rendered (TX05).

/** One control sequence's inner text (between "<" and ">") → plain text. */
function controlToPlain(inner: string): string {
  const bar = inner.indexOf("|");
  const target = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? null : inner.slice(bar + 1);
  const named = label !== null && label.length > 0 ? label : null;

  if (target.startsWith("@")) {
    // <@U123> / <@U123|name>
    return named !== null ? `@${named.replace(/^@+/, "")}` : target;
  }
  if (target.startsWith("#")) {
    // <#C123|name> / <#C123>
    return named !== null ? `#${named.replace(/^#+/, "")}` : target;
  }
  if (target.startsWith("!")) {
    const special = target.slice(1);
    if (special === "here" || special === "channel" || special === "everyone") return `@${special}`;
    if (special.startsWith("subteam^")) return named ?? `@${special.slice("subteam^".length)}`;
    if (special.startsWith("date^")) return named ?? "";
    return named ?? special;
  }
  // A link: <url|label> → "label (url)"; <url> → "url".
  if (named === null || named === target) return target;
  return `${named} (${target})`;
}

/** Slack's wire format → plain text for the chat question:
 *  <@U123> / <@U123|name> → "@name" when a name is given, else "@U123"; <#C123|name> → "#name"; <#C123> → "#C123";
 *  <!here> <!channel> <!everyone> → "@here" "@channel" "@everyone"; <!subteam^S1|@team> → "@team"; <!date^…|fallback> → fallback;
 *  <url|label> → "label (url)"; <url> → "url"; then &lt; &gt; &amp; decoded (in that order, &amp; last).
 *  CRLF/CR → LF; trimmed. Pure; no length cap (the job checks SLACK_LIMITS.questionChars). */
export function slackTextToPlain(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const plain = text
    .replace(/\r\n?/g, "\n")
    .replace(/<([^<>]*)>/g, (_whole, inner: string) => controlToPlain(inner))
    // One level only: "&amp;lt;" (the user typed "&lt;") becomes "&lt;", never "<".
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return plain.trim();
}
