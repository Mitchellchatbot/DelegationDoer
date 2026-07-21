// Resolve a Scaled Operations user → Slack user_id, preferring (in order):
//   1) users.slack_user_id  — cached result from a previous lookup, so
//      we skip the rate-limited users.lookupByEmail call entirely
//   2) users.slack_email    — manual override the leader set on /admin/slack
//      (used when the user's Slack workspace email is different from
//      the email DD stores for them — e.g. work alias vs. personal gmail)
//   3) users.email          — fall back to the DD email and hope it matches
//
// On every successful lookup we cache the slack_user_id back to the
// users row so the next call short-circuits to the (1) path.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { lookupUserByEmail } from "@/lib/slack";

interface UserLike {
  id?: string;
  email?: string | null;
  slack_email?: string | null;
  slack_user_id?: string | null;
}

export class SlackResolveError extends Error {
  constructor(message: string, public reason: "no_email" | "lookup_failed" | "db_error", public cause?: unknown) {
    super(message);
  }
}

// Take a user row (or just an email) and return the Slack user_id.
// If `user.id` is provided AND a fresh lookup happened, the new
// slack_user_id is persisted to the users row. Pure lookups
// (no id provided) skip the cache write.
export async function resolveSlackId(user: UserLike): Promise<string> {
  if (user.slack_user_id) return user.slack_user_id;

  const email = user.slack_email || user.email;
  if (!email) {
    throw new SlackResolveError("no email on user record", "no_email");
  }

  let slackId: string;
  try {
    slackId = await lookupUserByEmail(email);
  } catch (err) {
    throw new SlackResolveError(
      err instanceof Error ? err.message : "slack lookup failed",
      "lookup_failed",
      err
    );
  }

  // Cache the result so the next DM round-trip is free.
  if (user.id) {
    try {
      const supabase = getSupabaseAdmin();
      await supabase
        .from("users")
        .update({ slack_user_id: slackId })
        .eq("id", user.id);
    } catch {
      /* non-fatal — we still have the slackId for this request */
    }
  }
  return slackId;
}
