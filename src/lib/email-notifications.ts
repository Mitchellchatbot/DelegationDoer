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
import { viewerIdsForAddresses } from "@/lib/restricted-senders";
import { splitAddress, bodyPreview } from "@/lib/email-format";
import type { InboxEvent } from "@/lib/inbox-event-bus";

interface EnrichedMessage {
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  preview: string | null;
  receivedAt: string | null;
  // Every correspondent on the thread (from/to/cc across all messages), used
  // to apply sender-scoped privacy to the fan-out. Collected here because
  // enrich() already has the thread in hand — no extra clone round-trip.
  addresses: string[];
}

// splitAddress + bodyPreview live in @/lib/email-format — the Slack
// #email-notifs poster and the pull-mode poller render the same fields, and
// three private copies had already started to drift.

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
    const addresses = messages.flatMap((m) => [
      m.from_addr,
      ...(m.to_addrs ?? []),
      ...(m.cc_addrs ?? [])
    ]);
    if (!target) {
      return { subject: null, fromName: null, fromEmail: null, preview: null, receivedAt: null, addresses };
    }
    const { name, email } = splitAddress(target.from_addr);
    return {
      subject: target.subject ?? detail.thread.subject ?? null,
      fromName: name,
      fromEmail: email,
      preview: bodyPreview(target),
      receivedAt: target.sent_at ?? null,
      addresses
    };
  } catch {
    return { subject: null, fromName: null, fromEmail: null, preview: null, receivedAt: null, addresses: [] };
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
  let userIds = ((prefRows ?? []) as { user_id: string }[]).map((r) => r.user_id);
  if (userIds.length === 0) return 0;

  const enriched = await enrich(event);

  // Sender-scoped privacy (see src/lib/restricted-senders.ts). Filter the USER
  // LIST, not the row: a viewer on the rule still gets their ping, everyone
  // else silently drops out — and nobody's notification pref row is touched,
  // so their subscription to the rest of that inbox is unaffected.
  const allowedViewers = await viewerIdsForAddresses(enriched.addresses);
  if (allowedViewers) {
    userIds = userIds.filter((uid) => allowedViewers.has(uid));
    if (userIds.length === 0) return 0;
  }

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
