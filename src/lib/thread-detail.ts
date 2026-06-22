import "server-only";
import { getThread, listAccounts } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { getUserById } from "@/lib/server-data";
import { rawEmail } from "@/lib/email-format";
import type { ThreadDetailData } from "@/components/ThreadConversation";

type AppUser = NonNullable<Awaited<ReturnType<typeof getUserById>>>;

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

  let detail;
  try {
    detail = await getThread(threadId);
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

  const { thread, messages } = detail;

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
  const missiveThreadUrl = missiveAppUrl
    ? `${missiveAppUrl}/?thread=${encodeURIComponent(threadId)}`
    : null;

  // The connected accounts this user may send FROM (access-scoped), surfaced so
  // the reply composer can offer a "From" selector. We already have `visibleIds`
  // above, so reuse one listAccounts() call for both this and `ownEmail`.
  const allAccounts = await listAccounts().catch(() => []);
  const fromAccounts = (visibleIds === null
    ? allAccounts
    : allAccounts.filter((a) => visibleIds.has(a.id))
  ).map((a) => ({ id: a.id, email: a.email, display_name: a.display_name }));

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
