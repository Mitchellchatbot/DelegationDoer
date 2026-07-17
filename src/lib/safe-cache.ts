// A runtime-safe stand-in for React's `cache()`.
//
// React's cache() only exists in the RSC / route-handler runtime. Several of
// our server-only libs (missive-client, server-data, session) are ALSO pulled
// in by the instrumentation hook — the cron/bootstrap loops registered in
// src/instrumentation.ts. Under `next dev --turbo` that layer gets a React
// build where `cache` is undefined, so calling it at module top-level throws a
// "cache is not a function" TypeError and the bootstrap dies (the app still
// runs; the background loops just don't start locally).
//
// Import `cache` from here instead of directly from "react": it uses the real
// cache() when available (RSC render, production webpack build) and falls back
// to a pass-through wrapper otherwise. Per-request memoization is irrelevant in
// the one-shot instrumentation/cron path, so correctness is unaffected either
// way — this only stops the module from throwing at load time.
import { cache as reactCache } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const passThrough = <T extends (...args: any[]) => any>(fn: T): T => fn;

export const cache: typeof reactCache =
  typeof reactCache === "function" ? reactCache : (passThrough as typeof reactCache);
