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
//   1. the user can see the inbox (visibleAccountIdsFor), and
//   2. the thread actually belongs to that inbox (per-message account_ids) —
//      otherwise inbox A's owner could read any thread by guessing its id.
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

  const threadAccountIds = new Set(detail.messages.map((m) => m.account_id));
  if (!threadAccountIds.has(accountId)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  const { thread, messages } = detail;

  const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
  const missiveThreadUrl = missiveAppUrl
    ? `${missiveAppUrl}/?thread=${encodeURIComponent(threadId)}`
    : null;

  // Reply-all recipient sets, derived from the last inbound message. Drop the
  // current inbox's own address so replying-all doesn't loop back to yourself.
  const ownEmail =
    (await listAccounts().catch(() => [])).find((a) => a.id === accountId)?.email ?? "";
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
      missiveThreadUrl
    }
  };
}
