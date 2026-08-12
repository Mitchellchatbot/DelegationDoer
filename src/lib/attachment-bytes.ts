"use client";

// Client-side cache for attachment BYTES, fetched through the access-checked
// proxy at /api/inboxes/attachments/[id]. Mirrors message-body-cache.ts:
// resolved results live for the life of the page, and concurrent callers for the
// same attachment share ONE request.
//
// Why the bytes and not just the proxy URL: the print/save pipeline turns every
// attachment into a `data:` URI. A relative proxy URL works inside the print
// iframe (same origin, cookies present) but is dead in a downloaded .html opened
// from disk, and cannot be base64'd into an .eml at all. Fetching here — from
// the page, with the session cookie — keeps the route's authorization exactly as
// it is; this adds no new access surface.
//
// Everything is best-effort by design: a file that fails to download degrades to
// a manifest entry in the printout rather than aborting the whole print.

import type { MissiveMessageAttachment } from "@/lib/missive-client";
import { attachmentProxyUrl, effectiveMime } from "@/lib/attachment-kind";

const resolved = new Map<string, ArrayBuffer>();
const inFlight = new Map<string, Promise<ArrayBuffer>>();

// Ceiling on how many bytes one print/save may embed. Base64 inflates by ~33%,
// the whole document is assembled as a single string, and rasterized PDF pages
// land on top of that — so the real memory cost is several times this number.
// 12 MB of source comfortably covers the realistic case (a handful of PDFs or
// images) while staying survivable in a browser tab.
export const MAX_EMBED_BYTES = 12 * 1024 * 1024;

// Nothing bigger than this is worth pulling for a printout even if the budget
// has room — it's almost certainly a video or an archive, which we can't render
// anyway. Applies to the DECLARED size, so it's a cheap pre-filter.
const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;

const MAX_CONCURRENT = 4;

// Cap on what the module-level byte cache retains between operations. Without
// this, printing several threads in one session pins every attachment's bytes
// for the life of the tab — unlike message-body-cache, which this mirrors, the
// values here are megabytes of binary rather than short strings.
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
let cachedBytes = 0;

// Drop oldest-first until the cache is back under its ceiling. Map preserves
// insertion order, so its key order is already the eviction order.
function evictTo(limit: number): void {
  for (const [id, buf] of resolved) {
    if (cachedBytes <= limit) return;
    resolved.delete(id);
    cachedBytes -= buf.byteLength;
  }
}

export function getCachedAttachment(attachmentId: string): ArrayBuffer | undefined {
  return resolved.get(attachmentId);
}

export function fetchAttachmentBytes(
  attachmentId: string,
  accountId: string,
  threadId: string
): Promise<ArrayBuffer> {
  const cached = resolved.get(attachmentId);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(attachmentId);
  if (existing) return existing;

  const req = fetch(attachmentProxyUrl(attachmentId, accountId, threadId))
    .then(async (r) => {
      if (!r.ok) throw new Error(`attachment ${attachmentId} → ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      resolved.set(attachmentId, buf);
      cachedBytes += buf.byteLength;
      // Keep the newly-stored entry: evict down to the ceiling minus this
      // file, so we never immediately drop what we just fetched.
      if (cachedBytes > MAX_CACHE_BYTES) {
        resolved.delete(attachmentId);
        cachedBytes -= buf.byteLength;
        evictTo(Math.max(0, MAX_CACHE_BYTES - buf.byteLength));
        resolved.set(attachmentId, buf);
        cachedBytes += buf.byteLength;
      }
      return buf;
    })
    .finally(() => {
      inFlight.delete(attachmentId);
    });

  inFlight.set(attachmentId, req);
  return req;
}

export interface AttachmentBytesResult {
  // attachment id → bytes, for everything that downloaded and fit the budget.
  bytes: Map<string, ArrayBuffer>;
  // Filenames deliberately left out, with the reason — surfaced to the user so a
  // truncated printout never reads as a complete one.
  skipped: { filename: string; reason: "too-large" | "failed" }[];
}

// Download every attachment on `attachments`, concurrency-capped, tolerating
// per-file failure.
//
// The budget is charged against bytes we ACTUALLY received, not against the
// declared `size_bytes`. The clone reports 0 (or omits the field) often enough
// that a declared-size-only budget is no budget at all: every unknown-size file
// reserves nothing, so an arbitrarily large download proceeds and the cap is
// silently infinite. Declared size is still used as a cheap pre-filter, but it
// is never trusted as the accounting.
export async function loadAttachments(
  attachments: MissiveMessageAttachment[],
  accountId: string,
  threadId: string
): Promise<AttachmentBytesResult> {
  const bytes = new Map<string, ArrayBuffer>();
  const skipped: AttachmentBytesResult["skipped"] = [];

  const queue: MissiveMessageAttachment[] = [];
  for (const a of attachments) {
    // Pre-filter on the declared size only when it's present AND obviously too
    // big — saves pulling a 200 MB file over the wire to throw it away.
    if (a.size_bytes > MAX_SINGLE_FILE_BYTES) {
      skipped.push({ filename: a.filename, reason: "too-large" });
      continue;
    }
    queue.push(a);
  }

  // Shared across workers, so the running total reflects every completed
  // download regardless of which worker fetched it.
  let spent = 0;
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < queue.length) {
      const a = queue[idx++];
      // Re-check before each fetch: earlier downloads may have exhausted the
      // budget while this one was queued.
      if (spent >= MAX_EMBED_BYTES) {
        skipped.push({ filename: a.filename, reason: "too-large" });
        continue;
      }
      try {
        const buf = await fetchAttachmentBytes(a.id, accountId, threadId);
        // The authoritative check. A file whose real size overruns the budget
        // is dropped even though it's already in hand — embedding it is what
        // costs, not fetching it.
        if (buf.byteLength > MAX_SINGLE_FILE_BYTES || spent + buf.byteLength > MAX_EMBED_BYTES) {
          skipped.push({ filename: a.filename, reason: "too-large" });
          continue;
        }
        spent += buf.byteLength;
        bytes.set(a.id, buf);
      } catch {
        skipped.push({ filename: a.filename, reason: "failed" });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, worker)
  );

  return { bytes, skipped };
}

// --- base64 / data: URI ------------------------------------------------------

// Binary ArrayBuffer → base64. Chunked because String.fromCharCode(...bytes)
// blows the argument limit on anything more than a few hundred KB.
export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function dataUri(a: MissiveMessageAttachment, buf: ArrayBuffer): string {
  return `data:${effectiveMime(a)};base64,${bufferToBase64(buf)}`;
}
