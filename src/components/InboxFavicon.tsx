"use client";

import { useEffect, useState } from "react";
import { cn, initials } from "@/lib/utils";

// Per-inbox favicon avatar for the inbox sidebar.
//
// We derive the domain from the inbox's email address (support@acme.com →
// acme.com) and pull its favicon from Google's S2 favicon service — a fast,
// CDN-cached endpoint that needs no API key and no server round-trip, so
// retrieval + rendering stay entirely in the frontend.
//
// Behaviour:
//   • The colored initials tile renders immediately and sits *behind* the
//     image, so the row never shows a blank box and never shifts layout —
//     the favicon fades in over it once decoded (no flicker).
//   • If the domain has no real favicon (Google answers 404), or the image
//     otherwise fails to load, we keep the initials tile (graceful fallback).
//   • Verdicts (ok / bad) are memoised in-process and persisted to
//     localStorage, so a known-bad domain skips the network on later mounts
//     and a known-good one shows instantly without re-flickering.

type Verdict = "ok" | "bad";

// In-memory verdict cache, shared across every avatar this session. Empty on
// both server and first client render, so reading it for initial state is
// hydration-safe; localStorage (which would mismatch) is applied in an effect.
const verdicts = new Map<string, Verdict>();

const LS_KEY = "inbox-favicon-verdicts:v1";
let lsHydrated = false;

function hydrateFromStorage() {
  if (lsHydrated || typeof window === "undefined") return;
  lsHydrated = true;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, Verdict>;
    for (const [domain, v] of Object.entries(parsed)) {
      if (!verdicts.has(domain)) verdicts.set(domain, v);
    }
  } catch {
    /* localStorage blocked / corrupt — fall back to live probing */
  }
}

function rememberVerdict(domain: string, v: Verdict) {
  verdicts.set(domain, v);
  if (typeof window === "undefined") return;
  try {
    const obj: Record<string, Verdict> = {};
    for (const [k, val] of verdicts) obj[k] = val;
    window.localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch {
    /* ignore quota / disabled storage */
  }
}

// support@acme.com → "acme.com". Returns null for blanks or addresses with
// no dotted domain (so we don't probe garbage).
export function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  const domain = (at >= 0 ? email.slice(at + 1) : email).trim().toLowerCase();
  return domain.includes(".") ? domain : null;
}

function faviconUrl(domain: string): string {
  // Google's S2 favicon service: fast, CDN-cached, no API key. It returns a
  // real favicon (HTTP 200) when the domain has one, and HTTP 404 when it
  // doesn't — so a missing favicon trips the <img> onError handler and we
  // fall back to initials. No dimension/heuristic guessing required.
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function InboxFavicon({
  email,
  label,
  fallbackClass,
  size = 18,
  className
}: {
  email: string | null;
  // Used for the initials fallback, the alt text, and the hover title.
  label: string;
  // Tailwind background class for the initials tile (e.g. "bg-blue-500"),
  // so the fallback keeps the row's existing color identity.
  fallbackClass: string;
  size?: number;
  className?: string;
}) {
  const domain = domainFromEmail(email);
  // Start from the in-memory cache only (hydration-safe). The effect below
  // layers in any persisted verdict once we're on the client.
  const [failed, setFailed] = useState<boolean>(() => verdicts.get(domain ?? "") === "bad");
  const [loaded, setLoaded] = useState<boolean>(() => verdicts.get(domain ?? "") === "ok");

  useEffect(() => {
    if (!domain) return;
    hydrateFromStorage();
    const v = verdicts.get(domain);
    if (v === "bad") setFailed(true);
    else if (v === "ok") setLoaded(true);
  }, [domain]);

  const showImg = !!domain && !failed;
  const showInitials = !showImg || !loaded;

  return (
    <span
      className={cn(
        "relative grid place-items-center shrink-0 overflow-hidden rounded-md",
        // Favicons are authored for a light surface — a neutral white tile
        // keeps them legible regardless of the surrounding theme.
        showImg && loaded ? "bg-white ring-1 ring-black/5" : cn("text-white", fallbackClass),
        className
      )}
      style={{ width: size, height: size }}
      title={label}
    >
      {showInitials && (
        <span className="text-[9px] font-semibold leading-none uppercase">
          {initials(label) || "@"}
        </span>
      )}
      {showImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={faviconUrl(domain)}
          alt=""
          aria-hidden
          width={size}
          height={size}
          loading="lazy"
          className={cn(
            "absolute inset-0 h-full w-full object-contain transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onLoad={() => {
            rememberVerdict(domain, "ok");
            setLoaded(true);
          }}
          onError={() => {
            // 404 (no favicon for this domain) or a network/blocked load —
            // keep the initials fallback.
            rememberVerdict(domain, "bad");
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}
