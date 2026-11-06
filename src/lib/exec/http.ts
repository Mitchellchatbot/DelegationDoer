import "server-only";

import { NextResponse } from "next/server";
import type { DraftErrorCode } from "@/lib/exec/drafts-types";

// Small HTTP helpers for the P4 routes (P4 contract §3.12.1; Area D).
//
// isSameOriginRequest is P3's own export (email-assess.ts: Sec-Fetch-Site
// same-origin, else the Origin host equals Host / X-Forwarded-Host), re-exported
// here so every P4 route uses the one check (bindings AM3).
//
// readJsonBody reads the body as text, bounded (C56), then parses it; the shape
// check (zod) is the route's. jsonError answers `{ error: code, ...extra }`
// with no-store caching and, on a 429, a Retry-After header (C38: 60 s unless
// the route hands in `retryAfterSec`). Answers carry codes only.

export { isSameOriginRequest } from "@/lib/exec/email-assess";

const RETRY_AFTER_DEFAULT_SEC = 60;

/**
 * The body as UTF-8 text, read as a stream and abandoned as soon as it passes
 * `maxBytes` (an oversized body is never buffered whole); null on size, a read
 * error or invalid UTF-8.
 */
async function readBoundedText(req: Request, maxBytes: number): Promise<string | null> {
  const stream = req.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ArrayBuffer.isView(value)) return null;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** C56: text ≤ maxBytes, then JSON.parse; { ok: false } on size or syntax. */
export async function readJsonBody(req: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return { ok: false };
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared.trim());
    if (Number.isFinite(n) && n > maxBytes) return { ok: false };
  }
  const text = await readBoundedText(req, maxBytes);
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** A P4 success or mapped-outcome answer (additive): the body as given, never cached. */
export function jsonAnswer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** A P4 error answer: `{ error: code, ...extra }`, never cached; a 429 carries Retry-After. */
export function jsonError(status: number, code: DraftErrorCode, extra?: Record<string, unknown>): NextResponse {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (status === 429) {
    const sec = extra?.retryAfterSec;
    headers["retry-after"] = String(typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : RETRY_AFTER_DEFAULT_SEC);
  }
  return NextResponse.json({ error: code, ...(extra ?? {}) }, { status, headers });
}
