// Email-notification pull-mode poller.
//
// Replaces the missiveclone → Scaled Operations webhook fan-out path.
// Instead of relying on missiveclone to push us notifications (fragile:
// env drift, signature mismatches, URL typos that fail silently), this
// runs on DD's cron, polls missiveclone's REST API for new inbound
// messages on every account that has at least one opted-in user, and
// writes email_notifications rows itself.
//
// One pass per minute is plenty: workers see real-time email in the
// inbox UI via the existing SSE stream, and the home/widget pings can
// live with ~60s latency.
//
// Strategy per account:
//   1. Pull the most recent N threads via listThreads(mailboxId=acc).
//   2. Determine a floor timestamp — the max received_at we've already
//      seen for that account, or `now - GRACE` for fresh accounts.
//   3. For each thread newer than the floor, fetch full messages,
//      filter to inbound messages newer than the floor, and write
//      notification rows per opted-in user (dedup by message_id).

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getThread, listThreads, type MissiveMessage } from "@/lib/missive-client";

// Absolute cap on how far back we'll go on first-run for any account
// (24h). Above this is "ancient", and the user opted in long enough
// ago that we shouldn't drown them in backlog even if we have nothing
// else to anchor against.
const FIRST_RUN_HARD_CAP_MS = 24 * 60 * 60 * 1000;

// How many threads to scan per account per pass. Threads come back
// newest-first; 30 is enough headroom that a quiet account doesn't
// miss anything if the cron is delayed by a couple minutes.
const THREADS_PER_ACCOUNT = 30;

export interface PollResult {
  accountsScanned: number;
  threadsExamined: number;
  rowsWritten: number;
  errors: Array<{ accountId: string; message: string }>;
}

function splitAddress(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() || null };
  if (raw.includes("@")) return { name: null, email: raw.trim() };
  return { name: raw.trim(), email: null };
}

function previewFrom(m: { body_text: string | null; body_html: string | null }): string | null {
  const raw = m.body_text ?? m.body_html;
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

export async function pollEmailNotifications(): Promise<PollResult> {
  const supabase = getSupabaseAdmin();
  const result: PollResult = {
    accountsScanned: 0,
    threadsExamined: 0,
    rowsWritten: 0,
    errors: []
  };

  // Group opted-in users by account so we only call missiveclone once
  // per account per pass. Also track the EARLIEST opt-in time per
  // account — used as the first-run floor so we catch any messages
  // that landed between opt-in and the first poll firing.
  const { data: prefRows, error: prefErr } = await supabase
    .from("user_email_notification_prefs")
    .select("user_id, missive_account_id, updated_at")
    .eq("enabled", true);
  if (prefErr) {
    result.errors.push({ accountId: "*", message: `prefs query: ${prefErr.message}` });
    return result;
  }

  const usersByAccount = new Map<string, string[]>();
  const earliestOptInByAccount = new Map<string, Date>();
  for (const r of ((prefRows ?? []) as { user_id: string; missive_account_id: string; updated_at: string }[])) {
    const list = usersByAccount.get(r.missive_account_id) ?? [];
    list.push(r.user_id);
    usersByAccount.set(r.missive_account_id, list);
    const optedAt = new Date(r.updated_at);
    const cur = earliestOptInByAccount.get(r.missive_account_id);
    if (!cur || optedAt < cur) earliestOptInByAccount.set(r.missive_account_id, optedAt);
  }
  if (usersByAccount.size === 0) return result;

  // Floor lookup: for each account, the max received_at we've ever
  // notified anyone about. One query pulls the lot.
  const accountIds = Array.from(usersByAccount.keys());
  const { data: floorRows } = await supabase
    .from("email_notifications")
    .select("missive_account_id, received_at")
    .in("missive_account_id", accountIds)
    .order("received_at", { ascending: false });
  const floorByAccount = new Map<string, Date>();
  for (const r of ((floorRows ?? []) as { missive_account_id: string; received_at: string }[])) {
    if (!floorByAccount.has(r.missive_account_id)) {
      floorByAccount.set(r.missive_account_id, new Date(r.received_at));
    }
  }

  const hardFloor = new Date(Date.now() - FIRST_RUN_HARD_CAP_MS);

  for (const accountId of accountIds) {
    result.accountsScanned += 1;
    // Floor priority:
    //   1. Most recent notification row for this account — only consider
    //      newer messages, so we don't re-write rows we already have.
    //   2. Earliest opt-in time among opted-in users — catches anything
    //      that arrived between opt-in and the first poll.
    //   3. 24h ago — hard cap so we never drag in really old mail even
    //      when a user opted in years ago and somehow has no rows.
    const fromRows = floorByAccount.get(accountId);
    const fromOptIn = earliestOptInByAccount.get(accountId);
    let floor: Date;
    if (fromRows) {
      floor = fromRows;
    } else if (fromOptIn && fromOptIn > hardFloor) {
      floor = fromOptIn;
    } else {
      floor = hardFloor;
    }
    try {
      const threads = await listThreads({
        mailboxId: accountId,
        folder: "INBOX",
        limit: THREADS_PER_ACCOUNT
      });
      const candidateThreads = threads.filter(
        (t) => new Date(t.last_message_at).getTime() > floor.getTime()
      );
      if (candidateThreads.length === 0) continue;

      const userIds = usersByAccount.get(accountId) ?? [];
      if (userIds.length === 0) continue;

      // We'll batch-check existing message_ids per account at the end
      // so we don't fire one query per message.
      const inboundToWrite: Array<{
        msg: MissiveMessage;
        threadSubject: string | null;
      }> = [];

      for (const thread of candidateThreads) {
        result.threadsExamined += 1;
        const detail = await getThread(thread.id).catch(() => null);
        if (!detail) continue;
        for (const msg of detail.messages ?? []) {
          if (msg.direction !== "inbound") continue;
          if (new Date(msg.sent_at).getTime() <= floor.getTime()) continue;
          inboundToWrite.push({ msg, threadSubject: detail.thread.subject ?? null });
        }
      }
      if (inboundToWrite.length === 0) continue;

      // Dedup against existing rows so a re-run (or overlap with the
      // webhook path if it ever comes back) doesn't double-write.
      const messageIds = Array.from(new Set(
        inboundToWrite.map((x) => x.msg.id).filter((id): id is string => !!id)
      ));
      const { data: existingRows } = await supabase
        .from("email_notifications")
        .select("user_id, message_id")
        .in("message_id", messageIds);
      const existing = new Set(
        ((existingRows ?? []) as { user_id: string; message_id: string }[])
          .map((r) => `${r.user_id}::${r.message_id}`)
      );

      // Per-user opt-in floor: skip writing a row for a user whose
      // opt-in is newer than the message's sent_at, so a fresh user
      // doesn't see backlog from before they opted in.
      const perUserOptIn = new Map<string, Date>();
      for (const r of ((prefRows ?? []) as { user_id: string; missive_account_id: string; updated_at: string }[])) {
        if (r.missive_account_id !== accountId) continue;
        perUserOptIn.set(r.user_id, new Date(r.updated_at));
      }

      const rows: Array<Record<string, unknown>> = [];
      for (const { msg, threadSubject } of inboundToWrite) {
        const { name, email } = splitAddress(msg.from_addr);
        const subject = msg.subject ?? threadSubject ?? null;
        const preview = previewFrom(msg);
        const msgSentAt = new Date(msg.sent_at);
        for (const userId of userIds) {
          const optedAt = perUserOptIn.get(userId);
          if (optedAt && msgSentAt < optedAt) continue;
          const key = `${userId}::${msg.id}`;
          if (existing.has(key)) continue;
          rows.push({
            user_id: userId,
            missive_account_id: accountId,
            thread_id: msg.thread_id,
            message_id: msg.id,
            subject,
            from_name: name,
            from_email: email,
            preview,
            received_at: msg.sent_at
          });
        }
      }
      if (rows.length === 0) continue;

      const { error: insertErr } = await supabase
        .from("email_notifications")
        .insert(rows);
      if (insertErr) {
        result.errors.push({ accountId, message: `insert: ${insertErr.message}` });
        continue;
      }
      result.rowsWritten += rows.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      result.errors.push({ accountId, message });
    }
  }

  return result;
}
