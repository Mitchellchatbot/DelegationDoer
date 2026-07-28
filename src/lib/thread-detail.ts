import "server-only";
import { getThread, listAccountsCached } from "@/lib/missive-client";
import type { MissiveMessage } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { isReauthFailure } from "@/lib/missive-reauth";
import { getUserById } from "@/lib/server-data";
import { rawEmail } from "@/lib/email-format";
import type { ThreadDetailData } from "@/components/ThreadConversation";

type AppUser = NonNullable<Awaited<ReturnType<typeof getUserById>>>;

// The clone keeps one message row per (RFC Message-ID × inbox × direction), so
// an email delivered to several connected inboxes returns two or three
// identical copies. Collapse to one row per (Message-ID, direction), keeping
// the earliest copy (messages arrive sorted ASC).
//
// Direction is part of the key on purpose: a self-sent email legitimately has
// BOTH an inbound (INBOX) and an outbound (Sent) row under the same Message-ID,
// and those should still render as two messages (and keep the last-inbound
// reply-all derivation intact) — only the cross-inbox copies (same direction,
// different inbox) are duplicates. Rows with no Message-ID can't be matched, so
// they key on their own id and are never merged. The thread's account_emails
// still records every inbox the conversation touches, so the multi-inbox
// association is preserved.
function dedupeByMessageId(messages: MissiveMessage[]): MissiveMessage[] {
  const seen = new Set<string>();
  const out: MissiveMessage[] = [];
  for (const m of messages) {
    const key = m.message_id ? `mid:${m.message_id}:${m.direction}` : `row:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

export type LoadThreadOutcome =
  | { ok: true; data: ThreadDetailData }
  | { ok: false; status: number; error: string };

// Loads a single thread for the reading pane (and the legacy full page).
// Centralises the access control + reply-all derivation that used to live
// inline in the thread page, so the page redirect, the GET API route, and any
// future caller all enforce the SAME checks:
//   1. the user can see the inbox they opened it through (visibleAccountIdsFor), and
//   2. the thread touches at least one inbox the user can see (per-message
//      account_ids) — otherwise inbox A's owner could read any thread by
//      guessing its id.
export async function loadThreadDetail(
  me: AppUser,
  accountId: string,
  threadId: string
): Promise<LoadThreadOutcome> {
  const visibleIds = await visibleAccountIdsFor(me);
  if (visibleIds !== null && !visibleIds.has(accountId)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  // getThread and the account list are independent clone round-trips, so fire
  // them together instead of back-to-back — this drops one full RTT off the
  // critical path. listAccountsCached is cross-request cached (see
  // missive-client), so on a warm cache it resolves without a clone round-trip
  // at all and getThread is the only real latency here.
  let detail;
  let allAccounts;
  try {
    [detail, allAccounts] = await Promise.all([
      // deferBodies: the reading pane renders only the latest message on open
      // and fetches older bodies on expand — so ship just the latest body + a
      // snippet per message. This is the ONLY caller that opts in.
      getThread(threadId, { deferBodies: true }),
      listAccountsCached().catch(() => [])
    ]);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "unknown error"
    };
  }

  // A thread is identified by its messages' account_ids (the clone tags
  // messages, not threads). Authorize on the real visibility model: the user
  // may read this thread if it touches AT LEAST ONE inbox they can see — not
  // only the exact `accountId` they happened to open it through (a reply draft
  // can be opened via its "send FROM" account, which may differ from the inbox
  // the thread lives in). Anti-guessing is preserved: the thread must still
  // touch one of YOUR visible inboxes.
  const threadAccountIds = new Set(detail.messages.map((m) => m.account_id));
  const touchesVisible =
    visibleIds === null ||
    [...threadAccountIds].some((id) => visibleIds.has(id));
  if (!touchesVisible) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  // The account treated as "this user's address in this thread" for reply-all
  // dedup. Prefer the opened `accountId` when it's actually a thread account;
  // else pick a thread account the user can see.
  const viewAccountId = threadAccountIds.has(accountId)
    ? accountId
    : [...threadAccountIds].find((id) => visibleIds === null || visibleIds.has(id)) ?? accountId;

  const { thread } = detail;
  // Collapse the per-inbox copies of each email so a thread visible across
  // multiple inboxes doesn't render the same message two or three times.
  const messages = dedupeByMessageId(detail.messages);

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
  const missiveThreadUrl = missiveAppUrl
    ? `${missiveAppUrl}/?thread=${encodeURIComponent(threadId)}`
    : null;

  // The connected accounts this user may send FROM (access-scoped), surfaced so
  // the reply composer can offer a "From" selector. `allAccounts` was fetched in
  // parallel with the thread above; reuse it for both this and `ownEmail`.
  const fromAccounts = (visibleIds === null
    ? allAccounts
    : allAccounts.filter((a) => visibleIds.has(a.id))
    // `needsReauth` rides along so the From picker can warn BEFORE the user
    // writes a reply, instead of only blowing up on Send.
  ).map((a) => ({
    id: a.id,
    email: a.email,
    display_name: a.display_name,
    needsReauth: isReauthFailure(a.last_sync_error)
  }));

  // Reply-all recipient sets, derived from the last inbound message. Drop the
  // current inbox's own address so replying-all doesn't loop back to yourself.
  const ownEmail = allAccounts.find((a) => a.id === viewAccountId)?.email ?? "";
  const ownEmailLower = ownEmail.toLowerCase();
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  const dedupe = (addrs: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of addrs) {
      const e = rawEmail(a).trim();
      if (!e) continue;
      const lower = e.toLowerCase();
      if (lower === ownEmailLower || seen.has(lower)) continue;
      seen.add(lower);
      out.push(e);
    }
    return out;
  };
  const replyAllTo = lastInbound
    ? dedupe([lastInbound.from_addr, ...lastInbound.to_addrs])
    : [];
  const replyAllToLower = new Set(replyAllTo.map((e) => e.toLowerCase()));
  const replyAllCc = lastInbound
    ? dedupe(lastInbound.cc_addrs).filter((e) => !replyAllToLower.has(e.toLowerCase()))
    : [];

  return {
    ok: true,
    data: {
      thread,
      messages,
      replyAllTo: replyAllTo.join(", "),
      replyAllCc: replyAllCc.join(", "),
      defaultTo: lastInbound ? rawEmail(lastInbound.from_addr) : null,
      missiveThreadUrl,
      fromAccounts
    }
  };
}
