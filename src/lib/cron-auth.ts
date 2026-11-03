import "server-only";

import crypto from "crypto";
import { NextResponse } from "next/server";

// Shared gate for every /api/cron/* route.
//
// /api/cron is a PUBLIC prefix in middleware.ts (Vercel cron and the GitHub
// daily-briefing workflow call it without a session), so this check is the
// only thing standing between the internet and these routes. Several of them
// leak owner data (daily-briefing returns Mitchell's brief), spend model
// calls, post to Slack, or send email, so the gate:
//
//   - FAILS CLOSED: when CRON_SECRET is unset the route answers 503 instead
//     of running for anyone. The in-process schedulers (cron-bootstrap and the
//     *-bootstrap files) call the runner functions directly, never these
//     routes, so a missing secret only disables manual/external triggers.
//   - Accepts `Authorization: Bearer <CRON_SECRET>` (Vercel cron, GitHub
//     Actions, curl) and, for compatibility with the existing convention, the
//     `?secret=` query parameter. Prefer the header: query strings end up in
//     access logs and browser history.
//   - Compares SHA-256 digests with timingSafeEqual, so neither the secret's
//     length nor its prefix leaks through response timing.
//
// Usage, first line of the handler:
//   const denied = cronAuthError(req);
//   if (denied) return denied;

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function matches(presented: string, expected: Buffer): boolean {
  if (!presented) return false;
  return crypto.timingSafeEqual(digest(presented), expected);
}

export function cronAuthError(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || !secret.trim()) {
    return NextResponse.json(
      { error: "cron endpoint disabled: CRON_SECRET is not set" },
      { status: 503 }
    );
  }

  const expected = digest(secret);
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  let querySecret = "";
  try {
    querySecret = new URL(req.url).searchParams.get("secret") ?? "";
  } catch {
    querySecret = "";
  }

  // Evaluate both so the response time doesn't reveal which form was tried.
  const headerOk = matches(bearer, expected);
  const queryOk = matches(querySecret, expected);
  if (headerOk || queryOk) return null;

  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}
