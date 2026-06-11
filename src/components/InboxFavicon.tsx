"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Favicon avatar primitive. Given an email address it derives the domain
// (support@acme.com → acme.com) and pulls that domain's favicon from
// Google's S2 favicon service — fast, CDN-cached, no API key and no server
// round-trip, so retrieval + rendering stay entirely in the frontend.
//
// It is intentionally presentation-agnostic: the caller supplies the
// fallback content (e.g. initials) and the container styling for each state,
// so the same component backs both the sidebar inbox tiles and the sender
// avatars in the thread list.
//
// Behaviour:
//   • The caller's `fallback` renders immediately and sits *behind* the
//     image, so a row never shows a blank box or shifts layout — the favicon
//     fades in over it once decoded (no flicker).
//   • If the domain has no real favicon (Google answers 404) or the image
//     otherwise fails to load, we keep the fallback (graceful degradation).
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

// "support@acme.com" or `"Name" <support@acme.com>` → "acme.com". Returns null
// for blanks or values with no dotted domain (so we don't probe garbage).
export function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  // Tolerate display-name form: pull the address out of <...> if present.
  const angle = email.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : email).trim();
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const domain = addr
    .slice(at + 1)
    .replace(/[>\s]+$/, "")
    .trim()
    .toLowerCase();
  return domain.includes(".") ? domain : null;
}

function faviconUrl(domain: string): string {
  // Google's S2 favicon service: fast, CDN-cached, no API key. It returns a
  // real favicon (HTTP 200) when the domain has one, and HTTP 404 when it
  // doesn't — so a missing favicon trips the <img> onError handler and we
  // fall back to `fallback`. No dimension/heuristic guessing required.
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function InboxFavicon({
  email,
  fallback,
  size = 18,
  title,
  className,
  fallbackClassName,
  loadedClassName = "bg-white",
  imgClassName
}: {
  email: string | null;
  // Rendered until/unless the favicon loads (e.g. initials).
  fallback: React.ReactNode;
  size?: number;
  title?: string;
  // Container classes applied in every state (shape, ring, shadow…).
  className?: string;
  // Container classes applied while the fallback is showing (bg + text color).
  fallbackClassName?: string;
  // Container classes applied once the favicon is visible. Defaults to a
  // neutral white tile — favicons are authored for a light surface, so this
  // keeps them legible regardless of the surrounding row color.
  loadedClassName?: string;
  // Extra classes for the <img> itself — e.g. padding so a square logo
  // doesn't bleed into the corners of a circular tile.
  imgClassName?: string;
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
  const showFallback = !showImg || !loaded;

  return (
    <span
      className={cn(
        "relative grid place-items-center shrink-0 overflow-hidden",
        className,
        showFallback ? fallbackClassName : loadedClassName
      )}
      style={{ width: size, height: size }}
      title={title}
    >
      {showFallback && fallback}
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
            loaded ? "opacity-100" : "opacity-0",
            imgClassName
          )}
          onLoad={() => {
            rememberVerdict(domain, "ok");
            setLoaded(true);
          }}
          onError={() => {
            // 404 (no favicon for this domain) or a network/blocked load —
            // keep the fallback.
            rememberVerdict(domain, "bad");
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}
