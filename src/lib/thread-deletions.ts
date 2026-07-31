// Soft-delete helpers for inbox threads. Wraps inbox_thread_deletions so
// callers (server pages, API routes) can ask "which inboxes is this thread
// deleted from?" with one batched query instead of fanning out N lookups.
//
// Deletion is per (thread, account), not per user — these are shared team
// inboxes, so a delete out of support@ hides the thread from that inbox for
// everyone who can see it. See the migration for the full rationale.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { MissiveThread } from "@/lib/missive-client";

// Display-only copy of a thread, kept on the deletion row so the Trash list
// renders without a per-thread round-trip back to the clone.
export interface ThreadSnapshot {
  subject: string | null;
  from: string | null;
  snippet: string | null;
  last_message_at: string | null;
  account_emails: string[];
}

export interface DeletedThread {
  threadId: string;
  accountId: string;
  deletedAt: string;
  deletedBy: string | null;
  snapshot: ThreadSnapshot | null;
}

// Cap on any single snapshot string. The snapshot is the only part of a delete
// the client supplies, so it's clamped rather than trusted wholesale.
const SNAPSHOT_FIELD_MAX = 500;

function clamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, SNAPSHOT_FIELD_MAX) : null;
}

// Narrow arbitrary client JSON to the snapshot shape. Unknown keys are dropped
// and every string is length-capped, so a hand-rolled request can't stuff the
// table with junk.
export function sanitizeSnapshot(input: unknown): ThreadSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const emails = Array.isArray(o.account_emails)
    ? o.account_emails
        .map((e) => clamp(e))
        .filter((e): e is string => Boolean(e))
        .slice(0, 25)
    : [];
  return {
    subject: clamp(o.subject),
    from: clamp(o.from),
    snippet: clamp(o.snippet),
    last_message_at: clamp(o.last_message_at),
    account_emails: emails
  };
}

// Build a snapshot from a server-side thread — used when the caller has the
// real thread on hand and shouldn't be taking the client's word for it.
export function snapshotFromThread(t: MissiveThread): ThreadSnapshot {
  return {
    subject: clamp(t.subject),
    from: clamp(t.last_from ?? t.participants?.[0] ?? null),
    snippet: clamp(t.last_snippet),
    last_message_at: clamp(t.last_message_at),
    account_emails: (t.account_emails ?? []).map((a) => a.email)
  };
}

// Returns Map<threadId, Set<accountId>> — the inboxes each thread has been
// deleted from. Threads with no row aren't deleted anywhere.
//
// Degrades to "nothing is deleted" if the migration hasn't been applied yet,
// rather than 500ing the inbox page (same posture as readStateForThreads).
export async function deletionsForThreads(
  threadIds: string[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (threadIds.length === 0) return out;
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_thread_deletions")
    .select("thread_id, account_id")
    .in("thread_id", threadIds);
  if (error) return out;
  for (const r of (data ?? []) as { thread_id: string; account_id: string }[]) {
    const set = out.get(r.thread_id) ?? new Set<string>();
    set.add(r.account_id);
    out.set(r.thread_id, set);
  }
  return out;
}

// Resolve which connected accounts a thread belongs to, from the account_emails
// fan-out the clone computes per thread. Returns account ids.
export function threadAccountIds(
  thread: Pick<MissiveThread, "account_emails">,
  accountIdByEmail: Map<string, string>
): string[] {
  const ids = new Set<string>();
  for (const ae of thread.account_emails ?? []) {
    const id = accountIdByEmail.get(ae.email.toLowerCase());
    if (id) ids.add(id);
  }
  return [...ids];
}

// True when the thread should be hidden from a list whose scope is `scopeIds`
// (null = every account, i.e. the leader "all inboxes" view).
//
// The rule is "deleted from every in-scope inbox it's in": a thread that landed
// in support@ and billing@ and was deleted from support@ only still shows in
// the combined view (it's live mail in billing@) and in billing@'s own view,
// but is gone from support@'s.
export function isThreadDeletedInScope(
  thread: Pick<MissiveThread, "account_emails">,
  accountIdByEmail: Map<string, string>,
  scopeIds: Set<string> | null,
  deletedFrom: Set<string> | undefined
): boolean {
  if (!deletedFrom || deletedFrom.size === 0) return false;
  const ids = threadAccountIds(thread, accountIdByEmail)
    .filter((id) => scopeIds === null || scopeIds.has(id));
  // Couldn't resolve any account for the thread (older clone that omits
  // account_emails). A deletion row exists and the user expects it gone, so
  // honor the delete rather than resurrect mail they binned.
  if (ids.length === 0) return true;
  return ids.every((id) => deletedFrom.has(id));
}

// Convenience wrapper for the SSR'd list pages: one batched deletions lookup,
// then drop the threads that are deleted from every in-scope inbox. `scopeIds`
// is null for the leader "every inbox" view.
export async function filterDeletedThreads<
  T extends Pick<MissiveThread, "id" | "account_emails">
>(
  threads: T[],
  accounts: { id: string; email: string }[],
  scopeIds: Set<string> | null
): Promise<T[]> {
  if (threads.length === 0) return threads;
  const deletions = await deletionsForThreads(threads.map((t) => t.id));
  if (deletions.size === 0) return threads;
  const emailToAccountId = new Map(
    accounts.map((a) => [a.email.toLowerCase(), a.id])
  );
  return threads.filter(
    (t) => !isThreadDeletedInScope(t, emailToAccountId, scopeIds, deletions.get(t.id))
  );
}

// Soft-delete a thread out of the given inboxes. Idempotent: re-deleting an
// already-deleted (thread, account) just refreshes the row.
export async function deleteThreadFromAccounts(
  threadId: string,
  accountIds: string[],
  userId: string,
  snapshot: ThreadSnapshot | null
): Promise<void> {
  if (accountIds.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("inbox_thread_deletions")
    .upsert(
      accountIds.map((accountId) => ({
        thread_id: threadId,
        account_id: accountId,
        deleted_at: now,
        deleted_by: userId,
        thread_snapshot: snapshot
      })),
      { onConflict: "thread_id,account_id" }
    );
  if (error) throw new Error(error.message);
}

// Restore a thread into the given inboxes (undo / Trash → Restore). Omitting
// accountIds restores it everywhere it was deleted from.
export async function restoreThread(
  threadId: string,
  accountIds?: string[]
): Promise<void> {
  let query = getSupabaseAdmin()
    .from("inbox_thread_deletions")
    .delete()
    .eq("thread_id", threadId);
  if (accountIds && accountIds.length > 0) {
    query = query.in("account_id", accountIds);
  }
  const { error } = await query;
  if (error) throw new Error(error.message);
}

// Trash contents for a set of inboxes, newest deletion first. One row per
// (thread, account); the UI groups by thread so a delete-from-all reads as a
// single trashed conversation.
export async function listDeletedThreads(
  accountIds: string[],
  limit = 100
): Promise<DeletedThread[]> {
  if (accountIds.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_thread_deletions")
    .select("thread_id, account_id, deleted_at, deleted_by, thread_snapshot")
    .in("account_id", accountIds)
    .order("deleted_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((r) => ({
    threadId: r.thread_id as string,
    accountId: r.account_id as string,
    deletedAt: r.deleted_at as string,
    deletedBy: (r.deleted_by as string | null) ?? null,
    snapshot: (r.thread_snapshot as ThreadSnapshot | null) ?? null
  }));
}
