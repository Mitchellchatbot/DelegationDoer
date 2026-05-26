import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";
import { getApproversForDraft, isApprover, type EmailDraftKind } from "@/lib/email-approvers";
import { recordDraftEvent } from "@/lib/draft-events";
import { sanitizeMediaUrls } from "@/lib/media";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/email-drafts — create a new draft in 'pending' status.
//   body: {
//     accountId?: string,        // sending mailbox (missiveclone account id)
//     clientId?: string | null,
//     clientName: string,
//     to: string[],              // required
//     cc?: string[],
//     bcc?: string[],
//     subject: string,
//     bodyText: string,
//     bodyHtml?: string,
//     kind?: 'client_update' | 'content_plan' | 'custom'  (default 'client_update')
//   }
//   Fans out a Slack DM to every approver for the given kind so the
//   queue gets eyes on it immediately.
//
// GET /api/email-drafts?status=pending&kind=...&mine=1
//   Lists drafts visible to the caller. Approvers see every pending
//   draft of any kind they can approve; authors see their own drafts
//   in any status; everyone else sees nothing.

interface DraftRow {
  id: string;
  author_id: string;
  account_id: string | null;
  client_id: string | null;
  client_name: string;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  body_text: string;
  body_html: string | null;
  kind: EmailDraftKind;
  status: "pending" | "needs_revision" | "approved" | "rejected" | "sent" | "failed";
  approver_id: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_note: string | null;
  missive_thread_id: string | null;
  missive_message_id: string | null;
  sent_at: string | null;
  send_error: string | null;
  scheduled_for: string | null;
  revision_count: number | null;
  media_urls: Array<{ url: string; name?: string; contentType?: string; size?: number }> | null;
  created_at: string;
  updated_at: string;
}

function looksLikeEmail(s: unknown): s is string {
  return typeof s === "string" && /.+@.+\..+/.test(s.trim());
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const body = await req.json().catch(() => ({}));

    const kind: EmailDraftKind = (
      body.kind === "content_plan" || body.kind === "custom"
        ? body.kind
        : "client_update"
    );
    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const bodyText = typeof body.bodyText === "string" ? body.bodyText.trim() : "";
    const to = Array.isArray(body.to)
      ? body.to.filter(looksLikeEmail).map((s: string) => s.trim())
      : [];
    const cc = Array.isArray(body.cc)
      ? body.cc.filter(looksLikeEmail).map((s: string) => s.trim())
      : [];
    const bcc = Array.isArray(body.bcc)
      ? body.bcc.filter(looksLikeEmail).map((s: string) => s.trim())
      : [];

    if (!clientName) return NextResponse.json({ error: "clientName required" }, { status: 400 });
    if (to.length === 0) return NextResponse.json({ error: "to (at least one) required" }, { status: 400 });
    if (!subject) return NextResponse.json({ error: "subject required" }, { status: 400 });
    if (!bodyText) return NextResponse.json({ error: "bodyText required" }, { status: 400 });

    const id = `ed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const accountId = typeof body.accountId === "string" && body.accountId ? body.accountId : null;
    const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml : null;

    // Optional future-dated send. When set, the approve route stops at
    // status='approved' and the scheduled-emails cron picks up the
    // outbound dispatch once scheduled_for is past.
    let scheduledFor: string | null = null;
    if (typeof body.scheduledFor === "string" && body.scheduledFor.trim()) {
      const d = new Date(body.scheduledFor);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: "scheduledFor must be a valid ISO timestamp" }, { status: 400 });
      }
      scheduledFor = d.toISOString();
    }

    const mediaUrls = sanitizeMediaUrls(body.mediaUrls);

    const buildInsert = (includeScheduledFor: boolean, includeMedia: boolean) => {
      const row: Record<string, unknown> = {
        id,
        author_id: userId,
        account_id: accountId,
        client_id: clientId,
        client_name: clientName.slice(0, 200),
        to_emails: to,
        cc_emails: cc,
        bcc_emails: bcc,
        subject: subject.slice(0, 300),
        body_text: bodyText.slice(0, 20_000),
        body_html: bodyHtml,
        kind
      };
      if (includeScheduledFor) row.scheduled_for = scheduledFor;
      if (includeMedia) row.media_urls = mediaUrls;
      return row;
    };
    let { error: insertErr } = await supabase.from("email_drafts").insert(buildInsert(true, true));
    // If the migration adding scheduled_for / media_urls hasn't been
    // applied yet, retry with each opt-out so drafts can still be
    // created. The missing field is just silently dropped until the
    // migration runs.
    if (insertErr && /media_urls/.test(insertErr.message)) {
      ({ error: insertErr } = await supabase.from("email_drafts").insert(buildInsert(true, false)));
    }
    if (insertErr && /scheduled_for/.test(insertErr.message)) {
      ({ error: insertErr } = await supabase.from("email_drafts").insert(buildInsert(false, true)));
    }
    if (insertErr && /scheduled_for|media_urls/.test(insertErr.message)) {
      ({ error: insertErr } = await supabase.from("email_drafts").insert(buildInsert(false, false)));
    }
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    // Open the timeline with a "submitted" event so the approvals UI
    // has a baseline entry before any comments arrive.
    await recordDraftEvent({
      draftId: id,
      actorId: userId,
      type: "submitted"
    });

    // Fire Slack DMs to approvers — best-effort, per-recipient failures
    // shouldn't fail the request. Author + the recipient address up
    // top so approvers can triage at a glance.
    const [{ data: ws }, { data: authorRow }] = await Promise.all([
      supabase.from("workspace_settings").select("app_base_url").eq("id", "workspace").maybeSingle(),
      supabase.from("users").select("name, email").eq("id", userId).maybeSingle()
    ]);
    const baseUrl = (ws?.app_base_url as string | null) ?? "";
    const authorName = (authorRow?.name as string | undefined) ?? "Someone";

    const deliveries: Array<{ userId: string; name: string; delivered: boolean; reason?: string }> = [];
    if (process.env.SLACK_BOT_TOKEN) {
      const approvers = await getApproversForDraft({ author_id: userId, kind });
      const kindLabel =
        kind === "content_plan" ? "Content Plan" :
        kind === "custom" ? "Custom email" :
        "Client email";
      const link = baseUrl ? `<${baseUrl}/approvals|Open approvals queue>` : "the /approvals page";
      const text = `📨 ${authorName} sent a ${kindLabel} draft for *${clientName}* — needs your approval.`;
      const blocks = [
        {
          type: "header",
          text: { type: "plain_text", text: `📨 New ${kindLabel} awaiting approval` }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*From:*\n${authorName}` },
            { type: "mrkdwn", text: `*Client:*\n${clientName}` },
            { type: "mrkdwn", text: `*To:*\n${to.slice(0, 3).join(", ")}${to.length > 3 ? ` +${to.length - 3}` : ""}` },
            { type: "mrkdwn", text: `*Subject:*\n${subject}` }
          ]
        },
        { type: "context", elements: [{ type: "mrkdwn", text: link }] }
      ];

      for (const u of approvers) {
        if (u.id === userId) continue; // don't ping the author
        try {
          const slackId = await resolveSlackId({
            id: u.id,
            email: u.email,
            slack_email: u.slack_email,
            slack_user_id: u.slack_user_id
          });
          const dm = await openDm(slackId);
          await postMessage(dm, text, blocks);
          deliveries.push({ userId: u.id, name: u.name, delivered: true });
        } catch (err) {
          deliveries.push({
            userId: u.id, name: u.name, delivered: false,
            reason: err instanceof Error ? err.message : "slack failed"
          });
        }
      }
    }

    return NextResponse.json({ ok: true, id, kind, slackDeliveries: deliveries });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const supabase = getSupabaseAdmin();

    const sp = req.nextUrl.searchParams;
    const statusParam = sp.get("status");
    const kindParam = sp.get("kind");
    const mineOnly = sp.get("mine") === "1";
    const clientIdParam = sp.get("clientId");
    const limit = Math.min(100, Math.max(1, parseInt(sp.get("limit") ?? "50", 10) || 50));

    let q = supabase
      .from("email_drafts")
      .select("id, author_id, account_id, client_id, client_name, to_emails, cc_emails, bcc_emails, subject, body_text, body_html, kind, status, approver_id, approved_at, rejected_at, rejection_note, missive_thread_id, missive_message_id, sent_at, send_error, scheduled_for, revision_count, media_urls, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (statusParam) q = q.eq("status", statusParam);
    if (kindParam) q = q.eq("kind", kindParam);
    if (clientIdParam) q = q.eq("client_id", clientIdParam);
    if (mineOnly) {
      q = q.eq("author_id", userId);
    } else {
      // Non-mineOnly: leaders/admins see everything. Others see their
      // own drafts + any pending draft of a kind they can approve.
      // Implement by fetching everything they MIGHT see and filtering
      // client-side — small table, cheap.
    }

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const allRows = (data ?? []) as DraftRow[];

    let visible = allRows;
    if (!mineOnly) {
      // v3 approvers (leader + Sam/Mujtaba/Farez) see every draft.
      // Everyone else sees only their own.
      if (!isApprover({ name: me.name, role: me.role, isAdmin: me.isAdmin })) {
        visible = allRows.filter((r) => r.author_id === userId);
      }
    }

    // Resolve author + approver names in one round-trip.
    const userIds = Array.from(new Set([
      ...visible.map((r) => r.author_id),
      ...visible.map((r) => r.approver_id).filter((v): v is string => !!v)
    ]));
    const namesById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: us } = await supabase
        .from("users")
        .select("id, name")
        .in("id", userIds);
      for (const u of (us ?? []) as { id: string; name: string | null }[]) {
        namesById.set(u.id, u.name ?? "—");
      }
    }

    return NextResponse.json({
      drafts: visible.map((r) => ({
        id: r.id,
        authorId: r.author_id,
        authorName: namesById.get(r.author_id) ?? "—",
        accountId: r.account_id,
        clientId: r.client_id,
        clientName: r.client_name,
        to: r.to_emails,
        cc: r.cc_emails,
        bcc: r.bcc_emails,
        subject: r.subject,
        bodyText: r.body_text,
        bodyHtml: r.body_html,
        kind: r.kind,
        status: r.status,
        approverId: r.approver_id,
        approverName: r.approver_id ? namesById.get(r.approver_id) ?? null : null,
        approvedAt: r.approved_at,
        rejectedAt: r.rejected_at,
        rejectionNote: r.rejection_note,
        missiveThreadId: r.missive_thread_id,
        missiveMessageId: r.missive_message_id,
        sentAt: r.sent_at,
        sendError: r.send_error,
        scheduledFor: r.scheduled_for,
        revisionCount: Number(r.revision_count ?? 0),
        mediaUrls: Array.isArray(r.media_urls) ? r.media_urls : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
