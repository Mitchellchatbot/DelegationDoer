// Guards src/lib/public-origin-rules.ts — the boundary that decides which host
// a sign-in link may point at.
//
// The repo has no test runner, so this is a plain Node script:
//   node scripts/check-public-origin.mjs      (exits 0 on pass, 1 on failure)
//
// Unlike scripts/check-archive.mjs, this does NOT mirror the logic it checks.
// Node strips the types and imports the shipping module, so there is nothing to
// keep in sync. That is also why public-origin-rules.ts has zero imports —
// public-origin.ts pulls in `next/headers`, which bare Node cannot resolve.
//
// Why it exists: x-forwarded-host is attacker-controllable on any request, and
// resolveOrigin's output goes into emailed and Slack-DM'd sign-in links. Google
// and Slack reject an unregistered redirect_uri, but the invite, magic-link and
// signin-claim paths have no such backstop.

import assert from "node:assert/strict";
import { resolveOrigin, CONFIGURED_ORIGIN } from "../src/lib/public-origin-rules.ts";

const OPS = "https://operations.scaledai.org";
const RAIL = "https://delegationdoer-production.up.railway.app";
let checks = 0;
const is = (actual, expected, what) => { checks++; assert.equal(actual, expected, what); };

// --- the hosts we serve -----------------------------------------------------
is(resolveOrigin("operations.scaledai.org", "https"), OPS, "operations host");
is(resolveOrigin("delegationdoer-production.up.railway.app", "https"), RAIL, "railway host");

// Case and proxy-list handling: real proxies send lists and mixed case.
is(resolveOrigin("Operations.ScaledAI.org", "https"), OPS, "host is case-insensitive");
is(resolveOrigin("operations.scaledai.org, evil.test", "https, http"), OPS,
   "only the first hop of a comma-joined header counts");

// --- the security boundary --------------------------------------------------
is(resolveOrigin("evil.test", "https"), CONFIGURED_ORIGIN,
   "a forged host must fall back, never be trusted");
is(resolveOrigin("operations.scaledai.org.evil.test", "https"), CONFIGURED_ORIGIN,
   "suffix-glued lookalike must not match (exact host, not startsWith)");
// These two are the ones that catch an `endsWith` allowlist check, which the
// assertion above does NOT — it fails closed for the wrong reason. Found by
// planting exactly that bug and watching the suite still pass.
is(resolveOrigin("notoperations.scaledai.org", "https"), CONFIGURED_ORIGIN,
   "prefix-glued lookalike must not match (exact host, not endsWith)");
is(resolveOrigin("evil.operations.scaledai.org", "https"), CONFIGURED_ORIGIN,
   "an unlisted subdomain is not the listed host");
is(resolveOrigin("evil.test, operations.scaledai.org", "https"), CONFIGURED_ORIGIN,
   "a forged FIRST hop must not be rescued by a real host later in the list");
is(resolveOrigin(null, "https"), CONFIGURED_ORIGIN, "missing host falls back");
is(resolveOrigin("", "https"), CONFIGURED_ORIGIN, "empty host falls back");
is(resolveOrigin("   ", "https"), CONFIGURED_ORIGIN, "whitespace host falls back");

// --- loopback is dev-only ---------------------------------------------------
// NODE_ENV is undefined when this script runs by hand, i.e. "not production".
is(resolveOrigin("localhost:3000", null), "http://localhost:3000",
   "localhost allowed outside production, and defaults to http");
is(resolveOrigin("127.0.0.1:3000", null), "http://127.0.0.1:3000", "127.0.0.1 likewise");

// --- scheme -----------------------------------------------------------------
is(resolveOrigin("operations.scaledai.org", null), OPS,
   "a non-loopback host with no x-forwarded-proto defaults to https, not http");

// --- and NOT in production --------------------------------------------------
// isAllowed reads process.env.NODE_ENV at call time, so this block genuinely
// exercises the production branch. Without it, the dev-only guard on loopback
// was untested: deleting it left the suite green.
process.env.NODE_ENV = "production";
is(resolveOrigin("localhost:3000", null), CONFIGURED_ORIGIN,
   "in production a loopback host means the proxy header was lost or forged");
is(resolveOrigin("127.0.0.1:3000", null), CONFIGURED_ORIGIN, "127.0.0.1 likewise");
is(resolveOrigin("operations.scaledai.org", "https"), OPS,
   "a real host still resolves in production");

console.log(`PASS  ${checks} assertions — public-origin rules`);
