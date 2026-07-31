// Workspace mute rules — the noise filter for inbox lists and pings.
//
// Category tabs only narrow a view; they never remove anything from the
// default list, and neither notification writer consults them. Mute rules are
// the thing that actually takes plugin/vendor mail out of "All inboxes" and
// stops it pinging. See the migration for the rule semantics.
//
// Everything here is server-side. Lists filter muted threads out in the API /
// SSR layer, so the client never needs the rules or the matcher.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { MissiveThread } from "@/lib/missive-client";
import {
  compileMuteRules,
  normalizeRuleValue,
  MUTE_MATCH_TYPES,
  type MuteMatchType,
  type MuteRule,
  type MuteCandidate,
  type MuteMatcher
} from "@/lib/inbox-mute-shared";

// Re-exported so server callers can import rules + helpers from one place.
export { MUTE_MATCH_TYPES, normalizeRuleValue, compileMuteRules };
export {
  addressOf, splitAddress, describeRule, matchTypeLabel, suggestRules
} from "@/lib/inbox-mute-shared";
export type { MuteMatchType, MuteRule, MuteCandidate, MuteMatcher };

interface RuleRow {
  id: string;
  match_type: string;
  value: string;
  note: string | null;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
}

function rowToRule(r: RuleRow): MuteRule {
  return {
    id: r.id,
    matchType: r.match_type as MuteMatchType,
    value: r.value,
    note: r.note,
    enabled: r.enabled,
    createdBy: r.created_by,
    createdAt: r.created_at
  };
}

// (compileMuteRules lives in inbox-mute-shared — it's pure, and keeping it
// there lets the client and the tests use it without pulling in Supabase.)

// Load + compile in one call. Degrades to "nothing is muted" when the
// migration hasn't been applied, rather than breaking the inbox (same posture
// as the read-state and deletion helpers).
export async function getMuteMatcher(): Promise<MuteMatcher> {
  return compileMuteRules(await listMuteRules());
}

export async function listMuteRules(): Promise<MuteRule[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_mute_rules")
    .select("id, match_type, value, note, enabled, created_by, created_at")
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map((r) => rowToRule(r as RuleRow));
}

// A thread is judged on its newest message — the sender and subject the list
// row actually shows. A long-running conversation that a person later replies
// into keeps matching if the newest message still comes from the muted sender;
// muting is about who keeps mailing you, not about burying a thread forever.
export function threadCandidate(t: MissiveThread): MuteCandidate {
  return {
    from: t.last_from ?? t.participants?.[0] ?? null,
    subject: t.subject ?? null
  };
}

// Split a page of threads into the ones that pass and the ones a rule caught.
// Callers keep whichever side their view wants — the normal lists take `live`,
// the Muted view takes `muted`.
export function partitionMuted(
  threads: MissiveThread[],
  matcher: MuteMatcher
): { live: MissiveThread[]; muted: Array<{ thread: MissiveThread; rule: MuteRule }> } {
  if (matcher.isEmpty) return { live: threads, muted: [] };
  const live: MissiveThread[] = [];
  const muted: Array<{ thread: MissiveThread; rule: MuteRule }> = [];
  for (const t of threads) {
    const rule = matcher.match(threadCandidate(t));
    if (rule) muted.push({ thread: t, rule });
    else live.push(t);
  }
  return { live, muted };
}

// Convenience wrapper for the SSR'd list pages: load the rules and keep only
// the threads no rule caught.
export async function filterMutedThreads(threads: MissiveThread[]): Promise<MissiveThread[]> {
  if (threads.length === 0) return threads;
  return partitionMuted(threads, await getMuteMatcher()).live;
}

export async function createMuteRule(input: {
  matchType: MuteMatchType;
  value: string;
  note?: string | null;
  userId: string;
}): Promise<MuteRule> {
  const value = normalizeRuleValue(input.matchType, input.value);
  if (!value) throw new Error("value required");
  const supabase = getSupabaseAdmin();
  // Deterministic-ish id in the style the rest of the schema uses. The unique
  // (match_type, value) constraint is what actually makes re-muting a no-op.
  const id = `mute_${input.matchType}_${value}`.replace(/[^a-z0-9_]+/g, "_").slice(0, 120);
  const { data, error } = await supabase
    .from("inbox_mute_rules")
    .upsert(
      {
        id,
        match_type: input.matchType,
        value,
        note: input.note ?? null,
        enabled: true,
        created_by: input.userId
      },
      { onConflict: "match_type,value" }
    )
    .select("id, match_type, value, note, enabled, created_by, created_at")
    .single();
  if (error) throw new Error(error.message);
  return rowToRule(data as RuleRow);
}

export async function deleteMuteRule(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("inbox_mute_rules")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}

// How many of the recent notifications a candidate rule would have caught.
// Surfaced in the rule editor so an over-broad domain rule ("*@clientsite.com")
// is visibly about to swallow real mail BEFORE it's saved, rather than after
// someone notices they stopped hearing from a client.
export async function countRecentMatches(
  matchType: MuteMatchType,
  rawValue: string,
  sampleSize = 500
): Promise<{ matched: number; sampled: number }> {
  const value = normalizeRuleValue(matchType, rawValue);
  if (!value) return { matched: 0, sampled: 0 };
  const { data, error } = await getSupabaseAdmin()
    .from("email_notifications")
    .select("from_email, subject")
    .order("received_at", { ascending: false })
    .limit(sampleSize);
  if (error) return { matched: 0, sampled: 0 };
  const rows = (data ?? []) as { from_email: string | null; subject: string | null }[];
  const matcher = compileMuteRules([{
    id: "preview", matchType, value, note: null, enabled: true,
    createdBy: null, createdAt: ""
  }]);
  let matched = 0;
  for (const r of rows) {
    if (matcher.match({ from: r.from_email, subject: r.subject })) matched += 1;
  }
  return { matched, sampled: rows.length };
}
