import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { composeNewThread } from "@/lib/missive-client";
import { getOwnerAccount } from "@/lib/owner-inbox";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/brain/compose — send a NEW email AS Mitchell (owner only). Called
// only when Mitchell clicks Send on a staged draft. Body: { to, subject, body }.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const body = await req.json().catch(() => null);
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  const bodyText = typeof body?.bodyText === "string" ? body.bodyText.trim() : "";
  if (!to || !subject || !bodyText) return NextResponse.json({ error: "to, subject, and body are required" }, { status: 400 });
  // Guard against sending to an unfilled placeholder.
  if (!EMAIL_RE.test(to)) return NextResponse.json({ error: `"${to}" isn't a valid email address — fix the recipient before sending.` }, { status: 400 });

  const owner = await getOwnerAccount();
  if (!owner) return NextResponse.json({ error: "no Missive account found to send from" }, { status: 400 });

  try {
    const res = await composeNewThread({ fromAccountId: owner.id, to: [to], subject, bodyText });
    return NextResponse.json({ ok: true, to, messageId: (res as { messageId?: string }).messageId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "send failed" }, { status: 500 });
  }
}
