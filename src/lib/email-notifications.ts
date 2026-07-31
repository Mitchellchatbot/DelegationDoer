// Server-side helpers for email notifications.
//
// fanOutInboxEvent — given a freshly-landed inbox event from missiveclone,
// look up every user opted into that account, enrich with subject + from
// + preview by fetching the thread once, and insert one row per user
// into email_notifications. Best-effort: a missive fetch failure still
// writes minimal rows so the user sees *something* in the card.
//
// Called from /api/missive-webhook so notifications appear within ~1s of
// missiveclone receiving the email. Also re-publishes nothing extra to
// the inbox bus — we lean on the existing inbox-event SSE for the live
// ping, and use these persisted rows to populate the home card on load.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getThread } from "@/lib/missive-client";
import { getMuteMatcher } from "@/lib/inbox-mute";
import type { InboxEvent } from "@/lib/inbox-event-bus";

interface EnrichedMessage {
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  preview: string | null;
  receivedAt: string | null;
}

// Pull out a "Name <email@x>" address pair. Missive returns from_addr
// like that in most cases; some senders just give the bare email.
function splitAddress(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() || null };
  // Bare address (no display name).
  if (raw.includes("@")) return { name: null, email: raw.trim() };
  return { name: raw.trim(), email: null };
}

// One-line preview from the email body. Strip HTML tags + collapse
// whitespace, cap at 220 chars so the card row stays compact.
function previewFrom(message: { body_text: string | null; body_html: string | null }): string | null {
  const raw = message.body_text ?? message.body_html;
  if (!raw) return null;
  const text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > 220 ? text.slice(0, 220) + "…" : text;
}

// Fetch the thread + locate the specific message by id. If we can't
// resolve the message (deleted? id mismatch?), fall back to the most
// recent inbound message in the thread, which is usually the same one
// the webhook is about.
async function enrich(event: InboxEvent): Promise<EnrichedMessage> {
  try {
    const detail = await getThread(event.thread_id);
    const messages = detail.messages ?? [];
    const target =
      messages.find((m) => m.id === event.message_id) ??
      messages.filter((m) => m.direction === "inbound").slice(-1)[0] ??
      messages.slice(-1)[0];
    if (!target) return { subject: null, fromName: null, fromEmail: null, preview: null, receivedAt: null };
    const { name, email } = splitAddress(target.from_addr);
    return {
      subject: target.subject ?? detail.thread.subject ?? null,
      fromName: name,
      fromEmail: email,
      preview: previewFrom(target),
      receivedAt: target.sent_at ?? null
    };
  } catch {
    return { subject: null, fromName: null, fromEmail: null, preview: null, receivedAt: null };
  }
}

// Insert one notification row per user who's opted into the account.
// Returns the number of rows written so the webhook can log it.
export async function fanOutInboxEvent(event: InboxEvent): Promise<number> {
  // We only fire for fresh inbound messages — outbound replies the user
  // sent themselves shouldn't ping them, and "thread:updated" is too
  // noisy (e.g. status changes from the missive UI).
  if (event.event !== "message:new") return 0;

  const supabase = getSupabaseAdmin();
  const { data: prefRows } = await supabase
    .from("user_email_notification_prefs")
    .select("user_id")
    .eq("missive_account_id", event.account_id)
    .eq("enabled", true);
  const userIds = ((prefRows ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (userIds.length === 0) return 0;

  const enriched = await enrich(event);

  // Muted senders don't ping. Checked after enrichment because that's where
  // the sender + subject come from, and before the insert so no row is ever
  // written for noise. Enrichment failure leaves both fields null, which
  // matches nothing — an unidentifiable message still pings, which is the
  // right way to fail for a notification.
  const muted = (await getMuteMatcher()).match({
    from: enriched.fromEmail,
    subject: enriched.subject
  });
  if (muted) return 0;

  // Only ping for inbound messages. If enrichment failed (no message
  // body), default to "treat as inbound" so the user still gets the
  // ping for what's most likely an inbound webhook.
  // The bus event itself doesn't carry direction, so this is our gate.
  // (We checked event.event === "message:new" above; the missiveclone
  // webhook only fires that for inbound.)

  const receivedAt = enriched.receivedAt ?? new Date(event.ts ?? Date.now()).toISOString();

  // Skip users who already have a row for this message — handles the
  // case where missiveclone retries the webhook after we ACKed slow.
  // The webhook-level dedup (isDuplicateMessage in missive-socket)
  // catches near-simultaneous retries; this catches the longer tail.
  let existingUserIds = new Set<string>();
  if (event.message_id) {
    const { data: existing } = await supabase
      .from("email_notifications")
      .select("user_id")
      .eq("message_id", event.message_id)
      .in("user_id", userIds);
    existingUserIds = new Set(((existing ?? []) as { user_id: string }[]).map((r) => r.user_id));
  }

  const rows = userIds
    .filter((uid) => !existingUserIds.has(uid))
    .map((userId) => ({
      user_id: userId,
      missive_account_id: event.account_id,
      thread_id: event.thread_id,
      message_id: event.message_id ?? null,
      subject: enriched.subject,
      from_name: enriched.fromName,
      from_email: enriched.fromEmail,
      preview: enriched.preview,
      received_at: receivedAt
    }));
  if (rows.length === 0) return 0;

  // Plain insert — earlier code used upsert with onConflict on a
  // partial unique index, which Postgres can't resolve without the
  // WHERE clause and the Supabase JS client doesn't forward. The
  // upsert was failing silently and no rows ever landed.
  const { error } = await supabase.from("email_notifications").insert(rows);
  if (error) {
    console.error("[email-notif] fanOut insert", error);
    return 0;
  }
  return rows.length;
}
