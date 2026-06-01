import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { listAccounts } from "@/lib/missive-client";

export const dynamic = "force-dynamic";

// GET  /api/me/email-notification-prefs
//   Returns every inbox the caller can see, with the current opt-in
//   state ({ accountId, email, label, enabled }). Used by the onboarding
//   modal so the picker can render even for users who've never set a
//   pref before.
//
// PATCH /api/me/email-notification-prefs
//   body: { selections: { accountId: string; enabled: boolean }[] }
//   Upserts one row per (user_id, accountId). Also flips the user's
//   email_notifications_onboarded flag to true so the home card knows
//   to drop the CTA. Idempotent.

interface PrefRow {
  missive_account_id: string;
  enabled: boolean;
}

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    // Capture the listAccounts error so the modal can distinguish:
    //   (a) Missive is unreachable / token misconfigured (reason = "missive_error")
    //   (b) Missive has zero accounts at all                (reason = "no_accounts")
    //   (c) accounts exist but none are visible to this user (reason = "no_assignments")
    // Without this, all three collapsed into "no inboxes assigned" which
    // misdirected admins to ask themselves for access.
    let missiveError: string | null = null;
    const [visible, accounts, prefsRes] = await Promise.all([
      visibleAccountIdsFor(me),
      listAccounts().catch((err) => {
        missiveError = err instanceof Error ? err.message : "missive fetch failed";
        return [];
      }),
      supabase
        .from("user_email_notification_prefs")
        .select("missive_account_id, enabled")
        .eq("user_id", userId)
    ]);

    const prefMap = new Map<string, boolean>();
    for (const r of ((prefsRes.data ?? []) as PrefRow[])) {
      prefMap.set(r.missive_account_id, r.enabled);
    }

    // Filter Missive accounts to ones the user can see.
    const allowed = accounts.filter((a) => visible === null || visible.has(a.id));

    const inboxes = allowed.map((a) => ({
      accountId: a.id,
      email: a.email,
      label: a.display_name ?? null,
      // Default to true ("not yet decided" reads as opted-in once they
      // finish onboarding). The modal Save persists explicit choices.
      enabled: prefMap.get(a.id) ?? false
    }));

    const emptyReason: "missive_error" | "no_accounts" | "no_assignments" | null =
      inboxes.length > 0
        ? null
        : missiveError
          ? "missive_error"
          : accounts.length === 0
            ? "no_accounts"
            : "no_assignments";

    return NextResponse.json({
      onboarded: me.emailNotificationsOnboarded === true,
      inboxes,
      totalConnectedAccounts: accounts.length,
      missiveError,
      emptyReason
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

interface PatchBody {
  selections?: Array<{ accountId?: unknown; enabled?: unknown }>;
}

export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as PatchBody;
    if (!Array.isArray(body.selections)) {
      return NextResponse.json({ error: "selections must be an array" }, { status: 400 });
    }

    // Gate: a user can only set prefs for accounts they're allowed to
    // see. Silently drop selections outside that set so a stale picker
    // doesn't create rows for inboxes the user lost access to.
    const visible = await visibleAccountIdsFor(me);
    const cleaned = body.selections
      .filter((s): s is { accountId: string; enabled: boolean } =>
        typeof s.accountId === "string" && typeof s.enabled === "boolean"
      )
      .filter((s) => visible === null || visible.has(s.accountId));

    if (cleaned.length === 0) {
      // Still mark onboarded — they consciously picked nothing. Means
      // the card will show "notifications off" rather than the CTA.
      await getSupabaseAdmin()
        .from("users")
        .update({ email_notifications_onboarded: true })
        .eq("id", userId);
      return NextResponse.json({ ok: true, updated: 0 });
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const rows = cleaned.map((s) => ({
      user_id: userId,
      missive_account_id: s.accountId,
      enabled: s.enabled,
      updated_at: now
    }));
    const { error } = await supabase
      .from("user_email_notification_prefs")
      .upsert(rows, { onConflict: "user_id,missive_account_id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await supabase
      .from("users")
      .update({ email_notifications_onboarded: true })
      .eq("id", userId);

    return NextResponse.json({ ok: true, updated: rows.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
