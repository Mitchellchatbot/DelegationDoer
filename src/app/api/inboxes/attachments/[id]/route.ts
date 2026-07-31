import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { restrictionsFor } from "@/lib/restricted-senders";
import { getThread, fetchAttachment } from "@/lib/missive-client";
import type { MissiveMessageAttachment } from "@/lib/missive-client";
import { canRenderDoc, renderDocToHtml } from "@/lib/attachment-render";

export const dynamic = "force-dynamic";
// Node runtime: the document converters (mammoth / SheetJS) rely on Node
// built-ins and Buffer, which the edge runtime doesn't provide.
export const runtime = "nodejs";

// GET /api/inboxes/attachments/[id]?account=<accountId>&thread=<threadId>
//
// Streams an email attachment's bytes from the missive clone. The clone's
// own /api/attachments/:id requires the service token (which is
// workspace-wide), so we can't expose it to the browser directly. Instead
// we proxy: enforce the SAME per-user access the thread page applies
// (visibleAccountIdsFor + the attachment must belong to a thread the user
// can actually see), then pipe the upstream body straight through.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const accountId = req.nextUrl.searchParams.get("account") ?? "";
  const threadId = req.nextUrl.searchParams.get("thread") ?? "";
  if (!accountId || !threadId) {
    return NextResponse.json(
      { error: "account + thread query params required" },
      { status: 400 }
    );
  }

  // Inbox-level access — mirrors the thread detail page.
  const visible = await visibleAccountIdsFor(me);
  if (visible !== null && !visible.has(accountId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Bind the attachment to a thread the user is viewing: the thread must touch
  // an inbox the user can see AND the attachment id must belong to one of its
  // messages. Without this, a workspace-wide id could be fetched by guessing.
  // The visibility test mirrors loadThreadDetail — "touches at least one
  // visible inbox" rather than the exact opened account — so an attachment
  // stays reachable when a thread is opened via a visible-but-non-thread
  // account (e.g. a reply draft opened through its "send FROM" inbox).
  let touchesVisible = false;
  // Capture the attachment row itself (not just a boolean): its filename +
  // content-type drive the document-preview converter below.
  let attachment: MissiveMessageAttachment | null = null;
  // Sender-scoped privacy (see src/lib/restricted-senders.ts) — this is the
  // route that streams the actual file, so hiding the thread from the list
  // without guarding here would leave the bytes reachable by id.
  let restricted = false;
  try {
    const detail = await getThread(threadId);
    const threadAccountIds = new Set(detail.messages.map((m) => m.account_id));
    touchesVisible =
      visible === null || [...threadAccountIds].some((id) => visible.has(id));
    for (const m of detail.messages) {
      const found = (m.attachments ?? []).find((a) => a.id === params.id);
      if (found) { attachment = found; break; }
    }
    const restrict = await restrictionsFor(me);
    restricted =
      !!restrict &&
      (restrict.blocksMessages(detail.messages) || restrict.blocksThread(detail.thread));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "thread lookup failed" },
      { status: 502 }
    );
  }
  if (!touchesVisible || !attachment || restricted) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const upstream = await fetchAttachment(params.id);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `attachment fetch failed (${upstream.status})` },
      { status: upstream.status === 404 ? 404 : 502 }
    );
  }

  // Document preview: with ?render=html the modal asks us to convert a Word /
  // Excel / CSV / text file into self-contained HTML (see attachment-render).
  // The modal loads this into a FULLY sandboxed iframe (sandbox=""), so even
  // though we serve text/html it can't execute anything. On a conversion
  // failure we return a friendly HTML notice (status 200) so the iframe shows a
  // message rather than a broken page — the modal's Download button still works.
  if (
    req.nextUrl.searchParams.get("render") === "html" &&
    canRenderDoc(attachment.filename, attachment.content_type)
  ) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    const html = await renderDocToHtml(buf, attachment.filename, attachment.content_type);
    const doc =
      html ??
      `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#64748b">Couldn't render a preview for this file. Use Download to open it.</body>`;
    return new Response(doc, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, max-age=300"
      }
    });
  }

  // Pipe the binary through, preserving filename + content-type (the clone
  // sets Content-Disposition: attachment; filename=...), so the default stays a
  // download.
  const headers = new Headers();
  const upstreamType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const disposition = upstream.headers.get("content-disposition");

  // Preview mode: with ?inline=1 the reading pane asks us to serve the file
  // with Content-Disposition: inline so the browser renders it in place (the
  // attachment-preview modal) instead of downloading. This is STRICTLY
  // allowlisted to PDFs + raster images — never text/html or SVG — so inline
  // serving can't become an XSS vector. `mime` is a client hint (resolved from
  // the attachment's filename) that covers files the clone typed as
  // octet-stream; it's only honoured when it's itself on the allowlist.
  const PREVIEWABLE = new Set([
    "application/pdf",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"
  ]);
  const wantInline = req.nextUrl.searchParams.get("inline") === "1";
  const bareUpstream = upstreamType.toLowerCase().split(";")[0].trim();
  const mimeHint = (req.nextUrl.searchParams.get("mime") ?? "").toLowerCase();
  const previewType = wantInline
    ? (PREVIEWABLE.has(bareUpstream) ? bareUpstream : PREVIEWABLE.has(mimeHint) ? mimeHint : null)
    : null;

  if (previewType) {
    headers.set("Content-Type", previewType);
    headers.set("Content-Disposition", "inline");
  } else {
    headers.set("Content-Type", upstreamType);
    if (disposition) headers.set("Content-Disposition", disposition);
  }
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  headers.set("Cache-Control", "private, max-age=300");

  return new Response(upstream.body, { status: 200, headers });
}
