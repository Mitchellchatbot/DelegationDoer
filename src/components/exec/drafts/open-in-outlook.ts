// "Open in Outlook" (P4 contract §3.13.3, C69; security-7). The link is never
// an <a href>: a middle-click, a ctrl-click, "open in new tab", a drag or
// "copy link" would all skip the stamp DD needs (T41: opened_in_outlook_at,
// the review cleared, the follow-up checks scheduled). So one click handler
// does it in this order, inside the one user gesture:
//
//   1. w = open("about:blank", "_blank")   (synchronous: still a gesture)
//   2. w.opener = null                       (the Outlook tab can't reach DD)
//   3. POST .../outlook-opened               (the stamp)
//   4. on success  w.location.replace(webLink)
//      on failure  w.close(), "failed"
//
// A blocked popup (w === null) still gets the POST; when the stamp landed the
// outcome is "blocked": the panel shows "Open it now", a second button whose own
// click opens the link with noopener,noreferrer. An unrecorded stamp is "failed"
// whether or not the popup opened. The browser calls are injected so this runs in node.

export interface OpenedWindow {
  opener: unknown;
  location: { replace(url: string): void };
  close(): void;
}

export interface OpenInOutlookDeps {
  open: (url: string, target: string, features?: string) => OpenedWindow | null;
  /** The outlook-opened POST; resolves true when the stamp was recorded. */
  post: () => Promise<boolean>;
  webLink: string;
}

export type OpenInOutlookOutcome = "opened" | "blocked" | "failed";

export async function openInOutlookFlow(deps: OpenInOutlookDeps): Promise<OpenInOutlookOutcome> {
  let w: OpenedWindow | null = null;
  try {
    w = deps.open("about:blank", "_blank");
  } catch {
    w = null;
  }
  if (w !== null) {
    try {
      w.opener = null;
    } catch {
      // Some browsers expose opener read-only on a blank window; the link below never gets a referrer either way.
    }
  }
  let stamped = false;
  try {
    stamped = await deps.post();
  } catch {
    stamped = false;
  }
  // The stamp decides first (security-3): an unrecorded open is "failed" even
  // when the popup was blocked, so "Open it now" is only ever offered after T41
  // landed (the review cleared, the follow-up checks scheduled).
  if (!stamped) {
    try {
      w?.close();
    } catch {
      // Already closed by the browser.
    }
    return "failed";
  }
  if (w === null) return "blocked";
  w.location.replace(deps.webLink);
  return "opened";
}

/** The second button's click (a blocked popup): its own gesture, no opener, no referrer. */
export function openNow(open: (url: string, target: string, features?: string) => unknown, webLink: string): void {
  open(webLink, "_blank", "noopener,noreferrer");
}
