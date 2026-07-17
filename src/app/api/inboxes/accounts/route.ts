import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { createAccount } from "@/lib/missive-client";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inboxes/accounts — any signed-in user can connect their own
// inbox. The created account is auto-assigned to the creator via
// inbox_assignments so they can see it without a separate provisioning
// step. Leaders + admins still bypass any per-user gating downstream
// because visibleAccountIdsFor returns null for them.
//
// Body shape — every field is optional except `email`:
//   {
//     email: string,
//     displayName?: string,
//     provider?: "gmail" | "outlook" | "imap",
//     imapHost, imapPort, imapUser, imapPassword,
//     smtpHost, smtpPort, smtpUser, smtpPassword
//   }
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }

    const imapPort = typeof body.imapPort === "number" ? body.imapPort : undefined;
    const smtpPort = typeof body.smtpPort === "number" ? body.smtpPort : undefined;
    // Derive TLS flags from the well-known port. Callers can override
    // by sending body.imapSecure / body.smtpSecure explicitly.
    //   IMAP 993 = implicit TLS, 143 = STARTTLS → secure=false.
    //   SMTP 465 = implicit TLS, 587 = STARTTLS → secure=false.
    const imapSecure = typeof body.imapSecure === "boolean"
      ? body.imapSecure
      : imapPort === 993;
    const smtpSecure = typeof body.smtpSecure === "boolean"
      ? body.smtpSecure
      : smtpPort === 465;

    const account = await createAccount({
      email,
      display_name: typeof body.displayName === "string" ? body.displayName.trim() : undefined,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      imap_host: typeof body.imapHost === "string" ? body.imapHost : undefined,
      imap_port: imapPort,
      imap_secure: imapSecure,
      imap_user: typeof body.imapUser === "string" ? body.imapUser : undefined,
      // Clone wants `imap_pass`, not `imap_password`. We accept either
      // from the body so a stray older client doesn't 400 silently.
      imap_pass:
        typeof body.imapPassword === "string" ? body.imapPassword :
        typeof body.imapPass === "string" ? body.imapPass : undefined,
      smtp_host: typeof body.smtpHost === "string" ? body.smtpHost : undefined,
      smtp_port: smtpPort,
      smtp_secure: smtpSecure,
      smtp_user: typeof body.smtpUser === "string" ? body.smtpUser : undefined,
      smtp_pass:
        typeof body.smtpPassword === "string" ? body.smtpPassword :
        typeof body.smtpPass === "string" ? body.smtpPass : undefined
    });

    // Auto-link the new account to the creator so the inbox is
    // immediately visible on their /inboxes page. Leaders/admins
    // already see everything, but the row is harmless and makes the
    // ownership explicit if they ever lose admin.
    if (account?.id) {
      const supabase = getSupabaseAdmin();
      try {
        await supabase
          .from("inbox_assignments")
          .upsert(
            {
              id: `ia_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
              user_id: userId,
              missive_account_id: account.id,
              inbox_email: account.email ?? email,
              inbox_label: (account.display_name as string | undefined) ?? null,
              assigned_by: userId
            },
            { onConflict: "user_id,missive_account_id", ignoreDuplicates: true }
          );
      } catch (err) {
        // Don't fail the response — the account exists in Missive.
        // Worst case the user has to ask a leader to assign it.
        console.warn("[inboxes/accounts] auto-assignment failed:", err);
      }
    }

    // A new connected account changes the workspace account list — bust the
    // cross-request cache so it shows up on the inbox views immediately
    // instead of waiting out listAccountsCached's TTL.
    revalidateTag("missive-accounts");

    return NextResponse.json({ ok: true, account });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
