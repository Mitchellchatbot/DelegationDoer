import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { restrictionsFor } from "@/lib/restricted-senders";
import {
  composeNewThread,
  getThread,
  fetchAttachment,
  type MissiveAttachment,
  type MissiveMessage
} from "@/lib/missive-client";
import { sanitizeMediaUrls, fetchMediaAsAttachments } from "@/lib/media";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inboxes/threads/[threadId]/forward
//   body: {
//     accountId: string,            // mailbox to forward FROM (the inbox in view)
//     messageId: string,            // which message in the thread to forward
//     to: string[],                 // forward recipients (required)
//     cc?: string[],
//     bcc?: string[],
//     note?: string,                // optional message above the quoted original
//     subject?: string,             // optional override; else derived "Fwd: …"
//     includeAttachments?: boolean, // default true
//     attachmentUrls?: MediaItem[]  // optional extra uploaded files
//   }
//
// Forwarding is a NEW outbound thread that quotes the original message and
// re-attaches its files. We deliberately reuse the missive clone's existing
// send engine (POST /api/compose, via composeNewThread) rather than adding a
// forward-specific send path — that endpoint already routes through the
// account's provider and lands the message in Sent. DD only builds the
// "Fwd:" body (same format missiveclone's own ThreadView uses) and pulls the
// original attachment bytes server-side with the service token.
export async function POST(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const messageId = typeof body.messageId === "string" ? body.messageId : "";
    const note = typeof body.note === "string" ? body.note : "";
    const explicitSubject =
      typeof body.subject === "string" && body.subject.trim().length > 0
        ? body.subject.trim()
        : undefined;
    const includeAttachments = body.includeAttachments !== false; // default true
    const to: string[] = Array.isArray(body.to)
      ? body.to.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const cc: string[] = Array.isArray(body.cc)
      ? body.cc.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const bcc: string[] = Array.isArray(body.bcc)
      ? body.bcc.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

    if (!accountId || !messageId || to.length === 0) {
      return NextResponse.json(
        { error: "accountId + messageId + at least one recipient required" },
        { status: 400 }
      );
    }

    // Same inbox-level access control the reply/compose routes apply.
    const visible = await visibleAccountIdsFor(me);
    if (visible !== null && !visible.has(accountId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Bind the message to the thread the user is acting on — prevents
    // forwarding an arbitrary message id, mirroring the attachment proxy.
    const detail = await getThread(params.threadId);
    const src = detail.messages.find((m) => m.id === messageId);
    if (!src) {
      return NextResponse.json(
        { error: "message not found in thread" },
        { status: 404 }
      );
    }

    // Sender-scoped privacy (see src/lib/restricted-senders.ts). The most
    // dangerous write on a restricted thread: forwarding re-sends the body
    // AND re-attaches the original files to an arbitrary recipient.
    const restrict = await restrictionsFor(me);
    if (
      restrict &&
      (restrict.blocksMessages(detail.messages) || restrict.blocksThread(detail.thread))
    ) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const subject = explicitSubject ?? fwdSubject(src.subject || detail.thread.subject || "");
    const { bodyHtml, bodyText } = buildForwardBodies(src, note);

    // Re-attach the original message's files. The bytes aren't inlined in
    // getThread; pull each one from the clone with the service token (the
    // browser proxy needs a cookie, so it can't be used server-side here).
    const attachments: MissiveAttachment[] = [];
    if (includeAttachments) {
      for (const a of src.attachments ?? []) {
        try {
          const upstream = await fetchAttachment(a.id);
          if (!upstream.ok) continue;
          attachments.push({
            filename: a.filename || "attachment",
            contentType: a.content_type || "application/octet-stream",
            content: Buffer.from(await upstream.arrayBuffer())
          });
        } catch {
          // Skip one bad attachment rather than failing the whole forward.
        }
      }
    }

    // Optional extra files the user attaches in the forward composer.
    const extraItems = sanitizeMediaUrls(body.attachmentUrls);
    if (extraItems.length > 0) {
      attachments.push(...(await fetchMediaAsAttachments(extraItems)));
    }

    const result = await composeNewThread({
      fromAccountId: accountId,
      to,
      cc,
      bcc,
      subject,
      bodyText,
      bodyHtml,
      attachments: attachments.length > 0 ? attachments : undefined
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// "Fwd: <subject>", collapsing an existing Fwd: prefix so repeated forwards
// don't stack "Fwd: Fwd: …". Matches missiveclone's ThreadView.forwardLast.
function fwdSubject(s: string): string {
  const t = (s || "").trim();
  if (!t) return "Fwd:";
  return /^fwd:\s*/i.test(t) ? t : `Fwd: ${t}`;
}

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripHtml(html: string): string {
  return (html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

// Build the forwarded HTML + plaintext bodies. The HTML quote header mirrors
// the format missiveclone's own ThreadView.forwardLast emits, so forwarded
// mail looks consistent whether it originates in DD or the clone UI.
function buildForwardBodies(
  src: MissiveMessage,
  note: string
): { bodyHtml: string; bodyText: string } {
  const sentDate = src.sent_at ? new Date(src.sent_at).toLocaleString() : "";
  const toLine = (src.to_addrs ?? []).join(", ");
  const ccLine = (src.cc_addrs ?? []).join(", ");

  const headerHtml =
    `---------- Forwarded message ----------<br/>` +
    `<b>From:</b> ${escapeHtml(src.from_addr || "")}<br/>` +
    `<b>Date:</b> ${escapeHtml(sentDate)}<br/>` +
    `<b>Subject:</b> ${escapeHtml(src.subject || "")}<br/>` +
    `<b>To:</b> ${escapeHtml(toLine)}<br/>` +
    (ccLine ? `<b>Cc:</b> ${escapeHtml(ccLine)}<br/>` : "") +
    `<br/>`;
  const originalHtml =
    src.body_html || escapeHtml(src.body_text || "").replace(/\n/g, "<br/>");
  const noteHtml = note.trim()
    ? `${escapeHtml(note.trim()).replace(/\n/g, "<br/>")}<br/><br/>`
    : "";
  const bodyHtml = `${noteHtml}${headerHtml}${originalHtml}`;

  const headerText =
    `---------- Forwarded message ----------\n` +
    `From: ${src.from_addr || ""}\n` +
    `Date: ${sentDate}\n` +
    `Subject: ${src.subject || ""}\n` +
    `To: ${toLine}\n` +
    (ccLine ? `Cc: ${ccLine}\n` : "") +
    `\n`;
  const originalText = src.body_text || stripHtml(src.body_html || "");
  const bodyText = `${note.trim() ? note.trim() + "\n\n" : ""}${headerText}${originalText}`;

  return { bodyHtml, bodyText };
}
