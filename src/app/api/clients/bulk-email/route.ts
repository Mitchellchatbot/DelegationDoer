import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isApprover } from "@/lib/email-approvers";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { composeNewThread } from "@/lib/missive-client";
import { sanitizeMediaUrls, fetchMediaAsAttachments } from "@/lib/media";
import { getBulkRoster, renderTemplate, mapWithConcurrency } from "@/lib/bulk-email";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
// Bulk send loops over every included client (one Missive thread each), so
// allow well beyond the single-send route's 60s. Concurrency is bounded
// below so this is a generous ceiling, not an expected runtime.
export const maxDuration = 300;

// How many sends to keep in flight at once. Low enough not to hammer the
// missiveclone SMTP/Graph path, high enough to clear a few hundred clients
// in well under the maxDuration ceiling.
const SEND_CONCURRENCY = 4;

// GET /api/clients/bulk-email
//   → { clients: BulkRecipientClient[] } — the roster + shared-recipient
//     flags the exclusion UI renders. Approver-only.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
      return NextResponse.json({ error: "approver only" }, { status: 403 });
    }
    const { clients } = await getBulkRoster();
    return NextResponse.json({ clients });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

interface SendResult {
  clientId: string;
  name: string;
  to: string[];
  ok: boolean;
  error?: string;
  threadId?: string;
  messageId?: string;
}

// POST /api/clients/bulk-email
//   body: {
//     fromAccountId: string,
//     subject: string,            // may contain {{client_name}} etc.
//     bodyText: string,           // may contain placeholders
//     bodyHtml?: string,
//     excludedClientIds?: string[],
//     sendAt?: string,            // ISO; >= now + 30s for a scheduled blast
//     attachmentUrls?: MediaItem[]
//   }
//
// Sends the same (placeholder-rendered) email to every client that has a
// contact email and isn't excluded — one outbound Missive thread per
// client. Partial-failure tolerant: one bad send is recorded and the batch
// continues. The only DB write is an EXCLUSION log of the thread ids it
// created (bulk_email_threads): these blasts must stay OUT of touchpoint
// health, and touchpoint-sync skips any thread id recorded there. This is a
// clone-independent backstop to the per-message `automated` flag — see
// lib/touchpoint-sync.ts and lib/client-touchpoint.ts.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
      return NextResponse.json({ error: "approver only" }, { status: 403 });
    }

    const body = await req.json();
    const fromAccountId = typeof body.fromAccountId === "string" ? body.fromAccountId : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const bodyText = typeof body.bodyText === "string" ? body.bodyText.trim() : "";
    const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml : undefined;
    const excludedClientIds = new Set<string>(
      Array.isArray(body.excludedClientIds)
        ? body.excludedClientIds.filter((s: unknown): s is string => typeof s === "string")
        : []
    );

    if (!fromAccountId || !subject || !bodyText) {
      return NextResponse.json(
        { error: "fromAccountId + subject + bodyText required" },
        { status: 400 }
      );
    }

    // Same from-account authorization as the single-send compose route — a
    // user can only blast from an inbox they're allowed to see.
    const visible = await visibleAccountIdsFor(me);
    if (visible !== null && !visible.has(fromAccountId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Optional scheduled blast. Each client gets its own scheduled message
    // on the clone (composeNewThread forwards sendAtMs). Mirrors compose.
    const sendAt = typeof body.sendAt === "string" ? body.sendAt : null;
    let sendAtMs: number | undefined;
    if (sendAt) {
      const ms = new Date(sendAt).getTime();
      if (Number.isNaN(ms)) {
        return NextResponse.json({ error: "sendAt is not a valid date" }, { status: 400 });
      }
      if (ms <= Date.now() + 30_000) {
        return NextResponse.json(
          { error: "sendAt must be at least 30s in the future" },
          { status: 400 }
        );
      }
      sendAtMs = ms;
    }

    // Resolve attachments ONCE; the same buffers are reused for every send.
    const attachmentItems = sanitizeMediaUrls(body.attachmentUrls);
    const attachments = attachmentItems.length > 0
      ? await fetchMediaAsAttachments(attachmentItems)
      : undefined;

    // Server re-derives the eligible roster so the client can't inject
    // arbitrary recipients — it only gets to EXCLUDE from this set. canEmail
    // is required so a client with no contact address is never sent to (an
    // empty `to`), regardless of what the UI submitted.
    const { clients } = await getBulkRoster();
    const recipients = clients.filter((c) => c.canEmail && !excludedClientIds.has(c.clientId));

    if (recipients.length === 0) {
      return NextResponse.json({ error: "no clients selected to send to" }, { status: 400 });
    }

    const results = await mapWithConcurrency<typeof recipients[number], SendResult>(
      recipients,
      SEND_CONCURRENCY,
      async (c) => {
        try {
          const out = await composeNewThread({
            fromAccountId,
            to: c.contactEmails,
            subject: renderTemplate(subject, c),
            bodyText: renderTemplate(bodyText, c),
            bodyHtml: bodyHtml ? renderTemplate(bodyHtml, c) : undefined,
            sendAtMs,
            attachments,
            // Mark every blast so it's excluded from client touchpoint health
            // regardless of the (worker-authored) subject.
            automated: true
          });
          return {
            clientId: c.clientId,
            name: c.name,
            to: c.contactEmails,
            ok: true,
            threadId: out.threadId,
            messageId: out.messageId
          };
        } catch (err) {
          return {
            clientId: c.clientId,
            name: c.name,
            to: c.contactEmails,
            ok: false,
            error: err instanceof Error ? err.message : "send failed"
          };
        }
      }
    );

    // Record every thread we just created so touchpoint-sync excludes it from
    // client health (a mass send must not reset "last contacted"). Immediate
    // sends return a thread id; scheduled sends return an empty threadId (no
    // thread exists yet) so they're naturally skipped here and rely on the
    // per-message `automated` flag instead. Best-effort: a logging failure must
    // never fail the send the user already triggered.
    const sentThreads = results
      .filter((r) => r.ok && r.threadId)
      .map((r) => ({
        thread_id: r.threadId as string,
        client_id: r.clientId,
        subject,
        sent_by: me.id
      }));
    if (sentThreads.length > 0) {
      try {
        await getSupabaseAdmin()
          .from("bulk_email_threads")
          .upsert(sentThreads, { onConflict: "thread_id" });
      } catch {
        // Swallow — the emails went out; the worst case is a re-sync briefly
        // counting this blast until the row lands or the `automated` flag covers it.
      }
    }

    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;

    return NextResponse.json({
      ok: failed === 0,
      scheduled: !!sendAtMs,
      sendAt: sendAtMs ? new Date(sendAtMs).toISOString() : null,
      total: results.length,
      sent,
      failed,
      results
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
