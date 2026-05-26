// Shared media-attachment helpers for tasks + email drafts. The wire
// shape is `{ url, name?, contentType?, size? }` — clients upload via
// /api/upload, then pass the returned URL (plus best-effort metadata)
// back to whatever endpoint persists the relation.

export interface MediaItem {
  url: string;
  name?: string;
  contentType?: string;
  size?: number;
}

// Coerce caller-supplied media into the storage shape. Anything that
// doesn't have a usable url is dropped. We don't verify the URL points
// at our bucket — that's the upload endpoint's job — but we do bound
// the array size to stop unbounded growth on the row.
export function sanitizeMediaUrls(raw: unknown): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const url = typeof obj.url === "string" ? obj.url.trim() : "";
    if (!url) continue;
    out.push({
      url,
      name: typeof obj.name === "string" ? obj.name : undefined,
      contentType: typeof obj.contentType === "string" ? obj.contentType : undefined,
      size: typeof obj.size === "number" ? obj.size : undefined
    });
    if (out.length >= 50) break; // hard cap
  }
  return out;
}

// Fetch each MediaItem URL and return a parallel array of Node-style
// attachments suitable for forwarding to the missiveclone backend (or
// any consumer that expects `{ filename, contentType, content }`). Used
// by the email send paths so a draft's stored URLs become real RFC
// attachments on the outbound message.
export async function fetchMediaAsAttachments(items: MediaItem[]): Promise<Array<{
  filename: string;
  contentType: string;
  content: Buffer;
}>> {
  const out: Array<{ filename: string; contentType: string; content: Buffer }> = [];
  for (const m of items) {
    try {
      const res = await fetch(m.url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      out.push({
        filename: m.name ?? m.url.split("/").pop() ?? "attachment",
        contentType: m.contentType ?? res.headers.get("content-type") ?? "application/octet-stream",
        content: buf
      });
    } catch {
      // Skip one bad URL; don't fail the entire send because a single
      // attachment 404'd. Caller can decide whether to surface that.
    }
  }
  return out;
}
