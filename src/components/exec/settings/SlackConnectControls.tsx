"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2Off, RefreshCw, Unplug } from "lucide-react";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import { disconnectSlack } from "@/lib/exec/ui/settings-api";
import { useIsTopWindow } from "../drafts/frame-guard";

// The Slack section's actions (P6 contract §3.13, K15, C45, C48; Area E). A
// client island inside the server SlackSection: top-level only (P4's
// useIsTopWindow). Framed, or on the server before mount, it offers nothing
// to click and says why (settingsFramed).
//
//   * Connect / Reconnect: a plain <a> to the start route, a same-origin
//     navigation. Never next/link: a prefetch would GET the start route and
//     issue an OAuth state. Off the canonical host the link is replaced by
//     settingsWrongHost (start would answer wrong_host anyway, C45).
//   * Disconnect ("manage" mode): a confirm in place (title, body,
//     Disconnect / Cancel; Escape closes it, and focus returns to the
//     Disconnect button), then POST /api/exec/slack/disconnect. Success drops
//     ?slack= / ?who= from the address bar and refreshes the page, which
//     re-reads the section on the server.
//   * P7a (contract §3.10.8, C47): Disconnect also stops reading first. A 200
//     with warning "revoke_failed" (disconnected, the reading permission maybe
//     still live in Slack) shows disconnectRevokeFailed and offers nothing
//     more instead of refreshing (a refresh would replace this island and drop
//     the words); a 503 slack_unavailable whose answer carries the view
//     (reading already stopped and deleted, the bot revoke failed) shows
//     disconnectHalf and refreshes, so the reading half shows it stopped.
//
// Imports only client-safe modules (boundary rule B-P6-8 / P5a rule 16):
// slack-copy, the pure settings-api, the frame guard. No server module, not
// even transitively.

export const SLACK_START_PATH = "/api/integrations/exec-slack/start";

/**
 * The confirmed Disconnect: POST it; on success refresh the page (the server re-reads the section) and return null,
 * otherwise return the words to show (disconnectSlackDown for 503 slack_unavailable, else disconnectFailed).
 * P7a (C47): see disconnectOutcome.
 */
export async function disconnectThenRefresh(
  installationId: string,
  refresh: () => void,
  disconnect: typeof disconnectSlack = disconnectSlack
): Promise<string | null> {
  return (await disconnectOutcome(installationId, refresh, disconnect)).message;
}

/**
 * The confirmed Disconnect's outcome. done = Slack is disconnected (nothing more to offer here). A plain success
 * refreshes and has no words; a success with the reading warning (disconnectRevokeFailed) keeps the page as it is so
 * the words stay; a failure that already stopped reading (disconnectHalf) refreshes and keeps its words; any other
 * failure only has its words.
 */
export async function disconnectOutcome(
  installationId: string,
  refresh: () => void,
  disconnect: typeof disconnectSlack = disconnectSlack
): Promise<{ message: string | null; done: boolean }> {
  const result = await disconnect(installationId);
  if (result.kind === "disconnected") {
    if (typeof result.message === "string") return { message: result.message, done: true };
    refresh();
    return { message: null, done: true };
  }
  if (result.readingStopped === true) refresh();
  return { message: result.message, done: false };
}

/** The page's URL without the OAuth result params (?slack=, ?who=), or null when it has neither. The banner they name
 *  reported an earlier step (a "connected" banner must not survive a Disconnect); the section hides a stale one anyway. */
export function urlWithoutSlackResult(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.searchParams.has("slack") && !url.searchParams.has("who")) return null;
  url.searchParams.delete("slack");
  url.searchParams.delete("who");
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

/** What a key press inside the open confirm does: Escape closes it (unless the Disconnect is in flight). */
export function confirmKeyAction(key: string, pending: boolean): "close" | null {
  return key === "Escape" && !pending ? "close" : null;
}

/** Drop ?slack= / ?who= from the address bar (null state, so Next's router follows the new URL), then refresh. Exported (P7a
 *  fixer ui-4) so every reading action (enable, save, stop, the picker's mode) drops a banner that reported an earlier step. */
export function refreshWithoutResult(refresh: () => void): void {
  try {
    const next = urlWithoutSlackResult(window.location.href);
    if (next !== null) window.history.replaceState(null, "", next);
  } catch {
    // The address bar keeps its query; the section still hides a banner that disagrees with its state.
  }
  refresh();
}

const LINK_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500";
const LINK_SECONDARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500";

export function SlackConnectControls({
  mode,
  installationId = null,
  onCanonicalHost = true,
  initialConfirm = false,
  readingLive = false
}: {
  /** connect: the Connect link (not connected, revoked). manage: Reconnect + Disconnect (connected, error). */
  mode: "connect" | "manage";
  /** The active installation Disconnect names (manage mode). Without one, no Disconnect is offered. */
  installationId?: string | null;
  /** C45: false replaces the Connect / Reconnect link with settingsWrongHost. Disconnect stays. */
  onCanonicalHost?: boolean;
  /** Opens the Disconnect confirm on first render (static renders: tests and screenshots). The page never passes it. */
  initialConfirm?: boolean;
  /** P7a (fixer ui-10): a reading half is set up, so the confirm also says Disconnect stops reading and deletes its data. */
  readingLive?: boolean;
}) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const [confirming, setConfirming] = useState(initialConfirm);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(confirming);
  const titleId = useId();
  const bodyId = useId();

  // The confirm takes focus as it opens, so a keyboard or screen-reader user lands on the question; when it closes
  // (Cancel, Escape, a failed Disconnect) focus goes back to the Disconnect button it replaced, never to <body>.
  useEffect(() => {
    if (confirming && !initialConfirm) titleRef.current?.focus();
    else if (!confirming && wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming, initialConfirm]);

  if (!isTop) {
    return (
      <p data-slack-framed className="text-[12px] text-muted">
        {SLACK_COPY.settingsFramed}
      </p>
    );
  }

  const canDisconnect = !done && mode === "manage" && typeof installationId === "string" && installationId.length > 0;
  // The confirm only exists while there is an installation to disconnect.
  const open = confirming && canDisconnect;

  async function disconnect() {
    if (pending || !canDisconnect) return;
    setPending(true);
    setMessage(null);
    const outcome = await disconnectOutcome(installationId as string, () => refreshWithoutResult(() => router.refresh()));
    setPending(false);
    setConfirming(false);
    setMessage(outcome.message);
    if (outcome.done) setDone(true);
  }

  const link = onCanonicalHost ? (
    mode === "connect" ? (
      <a data-slack-connect href={SLACK_START_PATH} className={LINK_PRIMARY}>
        {SLACK_COPY.settingsConnect}
      </a>
    ) : (
      <a data-slack-reconnect href={SLACK_START_PATH} className={LINK_SECONDARY}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        {SLACK_COPY.settingsReconnect}
      </a>
    )
  ) : (
    <p data-slack-wrong-host className="flex items-start gap-1.5 text-[12px] font-medium text-amber-800">
      <Link2Off className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{SLACK_COPY.settingsWrongHost}</span>
    </p>
  );

  return (
    <div data-slack-controls={mode} className="space-y-2">
      {!open && !done && (
        <div className="flex flex-wrap items-center gap-2">
          {link}
          {canDisconnect && (
            <button
              ref={triggerRef}
              type="button"
              data-slack-disconnect
              onClick={() => {
                setMessage(null);
                setConfirming(true);
              }}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Unplug className="h-3.5 w-3.5" aria-hidden />
              {SLACK_COPY.settingsDisconnect}
            </button>
          )}
        </div>
      )}
      {open && (
        <div
          role="group"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          data-slack-confirm
          onKeyDown={(e) => {
            if (confirmKeyAction(e.key, pending) !== "close") return;
            e.preventDefault();
            e.stopPropagation();
            setConfirming(false);
          }}
          className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3"
        >
          <p id={titleId} ref={titleRef} tabIndex={-1} className="text-[13px] font-semibold text-rose-950 outline-none">
            {SLACK_COPY.disconnectConfirmTitle}
          </p>
          <p id={bodyId} className="text-[12.5px] leading-relaxed text-rose-950">
            {SLACK_COPY.disconnectConfirmBody}
            {readingLive && <span data-slack-confirm-reading>{` ${SLACK_READ_COPY.disconnectAlsoStops}`}</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-slack-confirm-disconnect
              onClick={() => void disconnect()}
              disabled={pending}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Disconnecting…" : SLACK_COPY.settingsDisconnect}
            </button>
            <button
              type="button"
              data-slack-confirm-cancel
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p aria-live="polite" role="status" data-slack-message className="text-[12px] text-rose-700">
        {message ?? ""}
      </p>
    </div>
  );
}
