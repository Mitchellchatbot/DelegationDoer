// Read-state helpers. Wraps thread_read_state so callers (server pages,
// API routes) can ask "is this thread read for this user?" with one
// batched query, instead of fanning out N lookups.
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export interface ReadRow {
  thread_id: string;
  account_id: string;
  last_read_at: string;
  read_through_at: string | null;
}

// Returns a Map<threadId, ReadRow> for the rows that exist. Threads
// without a matching row are unread by definition.
export async function readStateForThreads(
  userId: string,
  threadIds: string[]
): Promise<Map<string, ReadRow>> {
  if (threadIds.length === 0) return new Map();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("thread_read_state")
    .select("thread_id, account_id, last_read_at, read_through_at")
    .eq("user_id", userId)
    .in("thread_id", threadIds);
  // Migration may not yet be applied — degrade to "everything unread"
  // rather than 500ing the inbox page.
  if (error) return new Map();
  return new Map((data ?? []).map((r) => [r.thread_id as string, r as ReadRow]));
}

// True when the thread has a newer message than the user's last read
// watermark — or when no row exists at all.
export function isThreadUnread(
  lastMessageAt: string,
  readRow: ReadRow | undefined
): boolean {
  if (!readRow) return true;
  if (!readRow.read_through_at) return false;
  // Compare by parsed instant, never lexicographically. last_message_at is
  // produced by Date#toISOString() (e.g. "…789Z"), while read_through_at
  // round-trips through a Postgres timestamptz column and comes back with a
  // numeric offset ("…789+00:00"). For the *same* instant a string `>` then
  // sees "Z" (90) > "+" (43) and reports every read thread as unread — which
  // left opened mail permanently highlighted. Parsing both to epoch millis
  // makes identical instants compare equal.
  const last = Date.parse(lastMessageAt);
  const readThrough = Date.parse(readRow.read_through_at);
  // Unparseable input → fall back to "unread", matching the degrade-safe
  // posture in readStateForThreads (better a stray dot than hidden mail).
  if (Number.isNaN(last) || Number.isNaN(readThrough)) return true;
  return last > readThrough;
}
