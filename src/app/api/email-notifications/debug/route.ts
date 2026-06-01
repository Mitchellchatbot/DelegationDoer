import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccounts } from "@/lib/missive-client";

export const dynamic = "force-dynamic";

// GET /api/email-notifications/debug
//   Returns the current state of the caller's email-notification wiring
//   so we can tell *which* link in the chain is broken when an email
//   doesn't show up. Returns:
//     - onboarded flag on the user row
//     - their prefs rows (per-account opt-ins)
//     - count + most-recent rows of email_notifications written for them
//     - what listAccounts() returned (or its error)
//     - whether MISSIVE_WEBHOOK_SECRET is configured on the deploy
//
// Auth: just requires a session — we only ever return the caller's own
// data, no admin-only fields here.

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();

    let missiveError: string | null = null;
    const [visible, accounts, prefsRes, notifRes, countRes] = await Promise.all([
      visibleAccountIdsFor(me),
      listAccounts().catch((err) => {
        missiveError = err instanceof Error ? err.message : "missive fetch failed";
        return [];
      }),
      supabase
        .from("user_email_notification_prefs")
        .select("missive_account_id, enabled, created_at, updated_at")
        .eq("user_id", userId),
      supabase
        .from("email_notifications")
        .select("id, missive_account_id, thread_id, message_id, subject, from_email, received_at, seen_at, created_at")
        .eq("user_id", userId)
        .order("received_at", { ascending: false })
        .limit(5),
      supabase
        .from("email_notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
    ]);

    return NextResponse.json({
      user: {
        id: me.id,
        name: me.name,
        email: me.email,
        role: me.role,
        isAdmin: me.isAdmin === true,
        emailNotificationsOnboarded: me.emailNotificationsOnboarded === true
      },
      visibility: {
        // null means "all" (leader/admin); array is the explicit set.
        visibleAccountIds: visible === null ? null : Array.from(visible)
      },
      missive: {
        url: process.env.MISSIVE_API_URL ? "set" : "unset",
        tokenSet: !!process.env.MISSIVE_API_TOKEN,
        listAccountsError: missiveError,
        connectedAccountCount: accounts.length,
        // Trim to id+email so the response stays compact.
        accounts: accounts.map((a) => ({
          id: a.id,
          email: a.email,
          display_name: a.display_name
        }))
      },
      webhook: {
        // Don't leak the secret value — just whether the deploy has one
        // configured at all. An unset secret means every webhook returns
        // 401 and silently drops on the floor.
        secretConfigured: !!process.env.MISSIVE_WEBHOOK_SECRET
      },
      prefs: (prefsRes.data ?? []) as Array<{
        missive_account_id: string;
        enabled: boolean;
        created_at: string;
        updated_at: string;
      }>,
      notifications: {
        totalCount: countRes.count ?? 0,
        recent: notifRes.data ?? []
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
