import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { SLACK_LIMITS } from "@/lib/exec/slack-types";

// P6 Slack request signature check (contract §3.4, C21; Area B; server-only).
// Assistant-only: the legacy DD Slack routes keep their own copies. Pure apart
// from node:crypto. Nothing here logs: a result is one of five reason codes,
// never a header value, a digest or a byte of the body.

export type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "missing_headers" | "bad_timestamp" | "stale" | "bad_signature" };

const TIMESTAMP = /^[0-9]{1,12}$/;
const SIGNATURE = /^v0=[0-9a-f]{64}$/;
const DIGEST_BYTES = 32;

/** Slack v0 (PLAT §4 Signing): basestring = "v0:" + timestamp + ":" + raw body bytes; expected = "v0=" + hex(HMAC-SHA256(secret, basestring)).
 *  - secret null or "" → no_secret
 *  - either header missing → missing_headers (headers read case-insensitively through Request.headers)
 *  - timestamp not /^[0-9]{1,12}$/ → bad_timestamp; |nowSec − ts| > 300 → stale
 *  - signature not /^v0=[0-9a-f]{64}$/ → bad_signature; then timingSafeEqual of the two 32-byte digests (never string ===)
 *  Pure apart from node:crypto. */
export function verifySlackSignature(input: { secret: string | null; timestampHeader: string | null; signatureHeader: string | null; rawBody: Buffer }, nowMs: number): SlackVerifyResult {
  const secret = input.secret;
  if (typeof secret !== "string" || secret.length === 0) return { ok: false, reason: "no_secret" };
  const timestamp = input.timestampHeader;
  const signature = input.signatureHeader;
  if (typeof timestamp !== "string" || timestamp.length === 0 || typeof signature !== "string" || signature.length === 0) {
    return { ok: false, reason: "missing_headers" };
  }
  if (!TIMESTAMP.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  // Seconds as a float on our side, as Slack's own reference check does (abs(time.time() - ts) > 60 * 5).
  if (!Number.isFinite(nowMs) || Math.abs(nowMs / 1000 - Number(timestamp)) > SLACK_LIMITS.signatureWindowSec) {
    return { ok: false, reason: "stale" };
  }
  // Upper-case hex, a v1= prefix or a wrong length fail here, before any digest is compared.
  if (!SIGNATURE.test(signature)) return { ok: false, reason: "bad_signature" };

  const body = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.alloc(0);
  // The raw bytes as Slack sent them: never a re-serialized or decoded copy of the body.
  const expected = createHmac("sha256", secret).update(`v0:${timestamp}:`, "utf8").update(body).digest();
  const given = Buffer.from(signature.slice(3), "hex");
  // Both are 32 bytes by construction (64 hex checked above); timingSafeEqual is never reached with unequal lengths.
  if (expected.length !== DIGEST_BYTES || given.length !== DIGEST_BYTES) return { ok: false, reason: "bad_signature" };
  return timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Reads the body as bytes with a capped stream reader (security-10), never req.arrayBuffer() / text() / json():
 *  1. a Content-Length header over maxBytes → too_large without reading;
 *  2. const r = req.body?.getReader() (no body → an empty Buffer); add up each chunk's byteLength; as soon as the total
 *     exceeds maxBytes, await r.cancel() and return too_large (at most maxBytes + one chunk is ever held);
 *  3. below the cap, Buffer.concat the chunks.
 *  The events and interactions routes are session-free and share the process with every exec job loop, so a chunked
 *  body without Content-Length must never be buffered whole. A stream that errors mid-read rejects (the route answers it). */
export async function readRawBody(req: Request, maxBytes: number): Promise<{ ok: true; body: Buffer } | { ok: false; reason: "too_large" }> {
  const cap = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : 0;
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const trimmed = declared.trim();
    if (/^[0-9]+$/.test(trimmed) && Number(trimmed) > cap) return { ok: false, reason: "too_large" };
  }

  const stream = req.body;
  if (!stream) return { ok: true, body: Buffer.alloc(0) };
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk: Uint8Array = value;
      total += chunk.byteLength;
      if (total > cap) {
        // Stop pulling at once: at most cap + this one chunk was ever held.
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the stream is gone: nothing left to free.
    }
  }
  return { ok: true, body: Buffer.concat(chunks, total) };
}
