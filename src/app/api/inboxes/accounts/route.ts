import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { createAccount } from "@/lib/missive-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/inboxes/accounts — Leader-only. Proxies to the Missive clone's
// account-creation endpoint. The clone owns the SMTP/IMAP wiring; we
// just take the form payload and forward it. Errors from the clone bubble
// up verbatim so the UI can show the underlying reason (bad credentials,
// unsupported provider, missing migration on the clone, etc.).
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
    if (me.role !== "leader") {
      return NextResponse.json({ error: "Leader only" }, { status: 403 });
    }

    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }

    const account = await createAccount({
      email,
      display_name: typeof body.displayName === "string" ? body.displayName.trim() : undefined,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      imap_host: typeof body.imapHost === "string" ? body.imapHost : undefined,
      imap_port: typeof body.imapPort === "number" ? body.imapPort : undefined,
      imap_user: typeof body.imapUser === "string" ? body.imapUser : undefined,
      imap_password: typeof body.imapPassword === "string" ? body.imapPassword : undefined,
      smtp_host: typeof body.smtpHost === "string" ? body.smtpHost : undefined,
      smtp_port: typeof body.smtpPort === "number" ? body.smtpPort : undefined,
      smtp_user: typeof body.smtpUser === "string" ? body.smtpUser : undefined,
      smtp_password: typeof body.smtpPassword === "string" ? body.smtpPassword : undefined
    });

    return NextResponse.json({ ok: true, account });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
