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

// Ceiling on how many bytes one print/save may embed. Six PDFs is fine; a thread
// carrying a 200 MB video is not — base64 inflates by ~33% and the whole
// document is held in memory as a string before it is written out. Files that
// don't fit are reported to the caller so it can tell the user, instead of
// silently producing a printout that looks complete.
export const MAX_EMBED_BYTES = 40 * 1024 * 1024;

const MAX_CONCURRENT = 4;

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
// per-file failure. Files are taken largest-budget-first in the order given, and
// anything that would push the running total past MAX_EMBED_BYTES is skipped
// rather than truncated.
export async function loadAttachments(
  attachments: MissiveMessageAttachment[],
  accountId: string,
  threadId: string
): Promise<AttachmentBytesResult> {
  const bytes = new Map<string, ArrayBuffer>();
  const skipped: AttachmentBytesResult["skipped"] = [];

  // Reserve against the declared size before fetching, so an oversized file is
  // never pulled over the wire just to be thrown away.
  const queue: MissiveMessageAttachment[] = [];
  let budget = MAX_EMBED_BYTES;
  for (const a of attachments) {
    const declared = a.size_bytes > 0 ? a.size_bytes : 0;
    if (declared > budget) {
      skipped.push({ filename: a.filename, reason: "too-large" });
      continue;
    }
    budget -= declared;
    queue.push(a);
  }

  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < queue.length) {
      const a = queue[idx++];
      try {
        bytes.set(a.id, await fetchAttachmentBytes(a.id, accountId, threadId));
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
