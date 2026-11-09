"use client";

import { useState } from "react";
import { SLACK_INTEL_COPY } from "@/lib/exec/slack-intel-copy";
import { useIsTopWindow } from "../drafts/frame-guard";

// "Build today's digest" on a digest card (P7b contract §3.12.1, §3.10.2, C15, UI05). A client island: rendered only in a
// top-level window (P4's useIsTopWindow: framed, and on the server's first render, there is nothing to click) and only
// when the card says a build can start (canBuild: today, not archived, the digest policy allows it, nothing fresh or
// building). POST /api/exec/slack/digests { channelId }: 202 queued / 200 fresh; anything else is the error line and the
// button comes back. The answer carries no Slack text, and this shows none.
//
// Imports only client-safe modules (B-P7b-8 / P5a rule 16): the copy and the frame guard.

export type BuildState = "idle" | "pending" | "queued" | "fresh" | "error";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DIGEST_BUILD_PATH = "/api/exec/slack/digests";
const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;

/** The route's answer as a state: 202 { status: "queued" } → queued; 200 { status: "fresh" } → fresh; else error. */
export function buildOutcome(status: number, body: unknown): "queued" | "fresh" | "error" {
  const s = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).status : undefined;
  if (status === 202 && s === "queued") return "queued";
  if (status === 200 && s === "fresh") return "fresh";
  return "error";
}

/** POST the build request (same-origin, JSON). Never throws: a network failure is "error". */
export async function requestDigestBuild(channelId: string, fetchImpl?: FetchLike): Promise<"queued" | "fresh" | "error"> {
  if (typeof channelId !== "string" || !CHANNEL_RE.test(channelId)) return "error";
  const f: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  try {
    const res = await f(DIGEST_BUILD_PATH, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ channelId })
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return buildOutcome(res.status, body);
  } catch {
    return "error";
  }
}

/** The line under the button for a state (null: none). */
export function buildMessage(state: BuildState): string | null {
  if (state === "queued") return SLACK_INTEL_COPY.buildQueued;
  if (state === "fresh") return SLACK_INTEL_COPY.buildFresh;
  if (state === "error") return SLACK_INTEL_COPY.buildError;
  return null;
}

export function BuildDigestButton({
  channelId,
  canBuild,
  initialState = "idle"
}: {
  channelId: string;
  canBuild: boolean;
  /** Static renders only (tests, screenshots): the state shown first. The page never passes it. */
  initialState?: BuildState;
}) {
  const isTop = useIsTopWindow();
  const [state, setState] = useState<BuildState>(initialState);
  if (!isTop || !canBuild) return null;
  const done = state === "queued" || state === "fresh";
  const message = buildMessage(state);
  return (
    <div data-build-digest={channelId} data-build-state={state} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {!done && (
        <button
          type="button"
          data-build-digest-button
          disabled={state === "pending"}
          onClick={async () => {
            if (state === "pending") return;
            setState("pending");
            setState(await requestDigestBuild(channelId));
          }}
          className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === "pending" ? SLACK_INTEL_COPY.digestBuilding : SLACK_INTEL_COPY.buildToday}
        </button>
      )}
      <p aria-live="polite" role="status" data-build-message className={state === "error" ? "text-[12px] text-rose-700" : "text-[12px] text-slate-600"}>
        {message ?? ""}
      </p>
    </div>
  );
}
