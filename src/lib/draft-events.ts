// Shared helpers for the collaborative-approval workflow on email_drafts.
//   - recordDraftEvent: append to email_draft_events (the timeline).
//   - notifyAuthor / notifyApprovers: Slack DM the relevant side when
//     a comment is left, a revision is requested, or a draft is resubmitted.
//
// Every helper is best-effort on Slack delivery — the DB write is the
// source of truth, and we don't want a Slack outage to fail a comment.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getApproversForDraft, type EmailDraftKind } from "@/lib/email-approvers";
import { resolveSlackId } from "@/lib/slack-resolve";
import { openDm, postMessage } from "@/lib/slack";

export type DraftEventType =
  | "submitted"
  | "comment"
  | "revision_requested"
  | "resubmitted"
  | "edited"
  | "approved"
  | "rejected"
  | "sent"
  | "send_failed";

export interface DraftEventInput {
  draftId: string;
  actorId: string | null;
  type: DraftEventType;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

// Insert one row in email_draft_events. Best-effort — surfaces the
// error in the return value so callers can log but never throws.
export async function recordDraftEvent(input: DraftEventInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  const supabase = getSupabaseAdmin();
  const id = `ede_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const { error } = await supabase.from("email_draft_events").insert({
    id,
    draft_id: input.draftId,
    actor_id: input.actorId,
    type: input.type,
    body: input.body ?? null,
    metadata: input.metadata ?? {}
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, id };
}

interface DraftSummary {
  draftId: string;
  authorId: string;
  authorName: string | null;
  authorEmail: string | null;
  clientName: string;
  subject: string;
  kind: EmailDraftKind;
}

// DM the draft author. Used for feedback / revision-request /
// approve / reject events triggered by approvers.
export async function notifyAuthor(args: {
  draft: DraftSummary;
  actorName: string;
  headline: string;     // e.g. "💬 New feedback on your draft"
  bodyText: string;     // free-text — the comment / revision note
  baseUrl?: string | null;
}): Promise<{ delivered: boolean; reason?: string }> {
  if (!process.env.SLACK_BOT_TOKEN) {
    return { delivered: false, reason: "SLACK_BOT_TOKEN not set" };
  }
  if (!args.draft.authorEmail) {
    return { delivered: false, reason: "author has no email" };
  }
  try {
    const supabase = getSupabaseAdmin();
    const { data: userRow } = await supabase
      .from("users")
      .select("id, email, slack_email, slack_user_id")
      .eq("id", args.draft.authorId)
      .maybeSingle();
    const slackId = await resolveSlackId({
      id: args.draft.authorId,
      email: args.draft.authorEmail,
      slack_email: (userRow?.slack_email as string | null | undefined) ?? null,
      slack_user_id: (userRow?.slack_user_id as string | null | undefined) ?? null
    });
    const dm = await openDm(slackId);
    const link = args.baseUrl
      ? `<${args.baseUrl}/approvals|Open approvals queue>`
      : "the /approvals page";
    const blocks = [
      { type: "header", text: { type: "plain_text", text: args.headline } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Client:*\n${args.draft.clientName}` },
          { type: "mrkdwn", text: `*Subject:*\n${args.draft.subject}` },
          { type: "mrkdwn", text: `*From:*\n${args.actorName}` }
        ]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Note:*\n>${args.bodyText.split("\n").join("\n>")}` }
      },
      { type: "context", elements: [{ type: "mrkdwn", text: link }] }
    ];
    await postMessage(dm, `${args.headline} — ${args.draft.clientName}`, blocks);
    return { delivered: true };
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : "slack failed" };
  }
}

// Fan-out DM to every approver of the draft's kind. Used when a
// worker resubmits a revised draft so reviewers see the queue update.
export async function notifyApprovers(args: {
  draft: DraftSummary;
  excludeUserIds?: string[];
  headline: string;
  bodyText: string;
  baseUrl?: string | null;
}): Promise<Array<{ userId: string; name: string; delivered: boolean; reason?: string }>> {
  if (!process.env.SLACK_BOT_TOKEN) return [];
  const exclude = new Set(args.excludeUserIds ?? []);
  const approvers = await getApproversForDraft({
    author_id: args.draft.authorId,
    kind: args.draft.kind
  });
  const link = args.baseUrl
    ? `<${args.baseUrl}/approvals|Open approvals queue>`
    : "the /approvals page";
  const deliveries: Array<{ userId: string; name: string; delivered: boolean; reason?: string }> = [];
  for (const u of approvers) {
    if (exclude.has(u.id)) continue;
    try {
      const slackId = await resolveSlackId({
        id: u.id,
        email: u.email,
        slack_email: u.slack_email,
        slack_user_id: u.slack_user_id
      });
      const dm = await openDm(slackId);
      const blocks = [
        { type: "header", text: { type: "plain_text", text: args.headline } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Client:*\n${args.draft.clientName}` },
            { type: "mrkdwn", text: `*Subject:*\n${args.draft.subject}` },
            { type: "mrkdwn", text: `*From:*\n${args.draft.authorName ?? "—"}` }
          ]
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Note:*\n>${args.bodyText.split("\n").join("\n>")}` }
        },
        { type: "context", elements: [{ type: "mrkdwn", text: link }] }
      ];
      await postMessage(dm, `${args.headline} — ${args.draft.clientName}`, blocks);
      deliveries.push({ userId: u.id, name: u.name, delivered: true });
    } catch (err) {
      deliveries.push({
        userId: u.id,
        name: u.name,
        delivered: false,
        reason: err instanceof Error ? err.message : "slack failed"
      });
    }
  }
  return deliveries;
}

// Convenience: hydrate a DraftSummary from email_drafts in one query
// (used by every new endpoint so callers don't repeat the SELECT).
export async function loadDraftSummary(draftId: string): Promise<DraftSummary | null> {
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("email_drafts")
    .select("id, author_id, client_name, subject, kind")
    .eq("id", draftId)
    .maybeSingle();
  if (!row) return null;
  const { data: author } = await supabase
    .from("users")
    .select("name, email")
    .eq("id", row.author_id as string)
    .maybeSingle();
  return {
    draftId: row.id as string,
    authorId: row.author_id as string,
    authorName: (author?.name as string | null) ?? null,
    authorEmail: (author?.email as string | null) ?? null,
    clientName: row.client_name as string,
    subject: row.subject as string,
    kind: row.kind as EmailDraftKind
  };
}

// One-shot fetch for the workspace base URL used in Slack link
// blocks. Mirrors the pattern in /api/email-drafts/route.ts so we
// don't keep re-querying workspace_settings in every endpoint.
export async function getWorkspaceBaseUrl(): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data: ws } = await supabase
    .from("workspace_settings")
    .select("app_base_url")
    .eq("id", "workspace")
    .maybeSingle();
  return (ws?.app_base_url as string | null) ?? null;
}
