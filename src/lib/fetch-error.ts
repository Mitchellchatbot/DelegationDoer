// What a failed `fetch` actually said.
//
// undici answers every connection failure with the same opaque
// TypeError("fetch failed") and puts the real reason on `.cause`. On a
// dual-stack host that reason is an AggregateError holding one error per
// address family, and Node copies only the FIRST family's code onto it — the
// rest live in `.errors`, and on some Node majors no code is hoisted at all.
// Reading one level of `.cause` therefore degrades to the bare "fetch failed"
// on exactly the failures that are hardest to diagnose.
//
// This lives on its own because both cross-service integrations hit it:
// facebook-revenue.ts (the Finance app) and outbound-summary.ts (the ads
// dashboard) each call a secret-gated JSON route on another Railway service,
// and each used to render a connection failure as an unactionable
// "Network error: fetch failed".

export interface ErrorFacts {
  /** Distinct error codes across the whole cause/AggregateError tree, outermost first. */
  codes: string[];
  /** The first message that says more than "fetch failed"; "" if there is none. */
  detail: string;
}

/** Walk an error's `.cause` chain and any `AggregateError.errors`, once. */
export function errorFacts(err: unknown): ErrorFacts {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let detail = "";

  const walk = (e: unknown, depth: number): void => {
    // Depth-bounded and cycle-guarded: these come off the network, and a
    // self-referencing cause must not hang the page that is rendering them.
    if (depth > 5 || !e || typeof e !== "object" || seen.has(e)) return;
    seen.add(e);
    const node = e as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown };
    if (typeof node.code === "string" && node.code && !codes.includes(node.code)) codes.push(node.code);
    if (!detail && typeof node.message === "string" && node.message && node.message !== "fetch failed") {
      detail = node.message;
    }
    if (Array.isArray(node.errors)) for (const sub of node.errors) walk(sub, depth + 1);
    walk(node.cause, depth + 1);
  };
  walk(err, 0);

  return { codes, detail };
}

/**
 * One line naming why a connection never completed.
 *
 * Never returns a bare "fetch failed" — that string is what made this class of
 * outage undiagnosable from the UI in the first place.
 */
export function describeNetworkError(err: unknown): string {
  const { codes, detail } = errorFacts(err);
  // More than one code means the address families disagreed — show them all;
  // the per-family sentences would be noise next to that.
  if (codes.length > 1) return codes.join(" + ");
  if (codes.length === 1) {
    // Node's own sentence usually embeds the code ("getaddrinfo ENOTFOUND x"),
    // so don't say it twice.
    return detail ? (detail.includes(codes[0]) ? detail : `${codes[0]} — ${detail}`) : codes[0];
  }
  return detail || "connection failed with no reported cause";
}

// Worth one more try: a socket that died under us. The commonest benign cause
// of a "fetch failed" against an upstream that is demonstrably healthy is a
// pooled keep-alive connection the far end had already closed — undici only
// discovers that on the next request, and a second attempt gets a fresh socket.
// Deliberately absent: ENOTFOUND (DNS won't change in 10ms), ECONNREFUSED
// (nothing is listening), certificate errors, and connect timeouts — those fail
// again just as surely, and each retry is time a reader spends looking at
// nothing.
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/** True when re-sending the same request immediately could plausibly succeed. */
export function isRetryableNetworkError(err: unknown): boolean {
  return errorFacts(err).codes.some((c) => RETRYABLE_CODES.has(c));
}
