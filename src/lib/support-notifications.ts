import "server-only";
// Server-side fan-out for customer-support widget notifications.
//
// fanOutSupportMessage — given a freshly-ingested inbound support message that
// landed in the Customer Support tab (category customer_support or uncertain),
// write one support_notifications row per support-visible user so their widget
// pings on the next poll. Mirrors fanOutInboxEvent in email-notifications.ts,
// but the audience is role-derived (canSeeCustomerSupport) rather than opt-in.
//
// Called from support-intake.ts's ingestInboundMessage. Best-effort: it
// swallows and logs its own errors and never throws, so a notification failure
// can't break message intake (same contract as notifyFormSubmitted).

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllUsersLight } from "@/lib/server-data";
import { canSeeCustomerSupport } from "@/lib/auth";
import type { SupportCategory } from "@/lib/support-classifier";

export interface SupportFanOutInput {
  conversationId: string;
  messageId: string; // blooio_message_id — the dedup key
  contactName: string | null;
  phone: string | null;
  body: string;
  sentAt: string; // ISO timestamp
  category: SupportCategory;
}

// One-line preview from the SMS body. Cap at 200 chars to match the
// conversation-activity preview in support-intake's touchConversationActivity.
function previewFrom(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  return text.length > 200 ? text.slice(0, 200) : text;
}

export async function fanOutSupportMessage(input: SupportFanOutInput): Promise<number> {
  try {
    const supabase = getSupabaseAdmin();

    // Recipients = everyone who can see the Customer Support inbox. This is the
    // single source of truth for CS visibility (Mujtaba + stealth admins) —
    // reuse it rather than re-encoding the name/email rule.
    const users = await getAllUsersLight();
    const recipients = users.filter(canSeeCustomerSupport);
    const userIds = recipients.map((u) => u.id);
    if (userIds.length === 0) return 0;

    // Skip users who already have a row for this message — handles the webhook
    // and poll-cron both ingesting the same inbound (the unique index on
    // (user_id, message_id) is the hard backstop; this avoids the noisy insert).
    const { data: existing } = await supabase
      .from("support_notifications")
      .select("user_id")
      .eq("message_id", input.messageId)
      .in("user_id", userIds);
    const existingUserIds = new Set(
      ((existing ?? []) as { user_id: string }[]).map((r) => r.user_id)
    );

    const preview = previewFrom(input.body);
    const rows = userIds
      .filter((uid) => !existingUserIds.has(uid))
      .map((userId) => ({
        user_id: userId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        contact_name: input.contactName,
        phone: input.phone,
        preview,
        category: input.category,
        received_at: input.sentAt
      }));
    if (rows.length === 0) return 0;

    const { error } = await supabase.from("support_notifications").insert(rows);
    if (error) {
      console.error("[support-notif] fanOut insert", error);
      return 0;
    }
    return rows.length;
  } catch (err) {
    console.error("[support-notif] fanOut failed", {
      messageId: input.messageId,
      error: err instanceof Error ? err.message : err
    });
    return 0;
  }
}
