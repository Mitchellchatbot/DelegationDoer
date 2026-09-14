import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner, OWNER_EMAIL } from "@/lib/access";
import { listAccounts, listThreads } from "@/lib/missive-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

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

// GET /api/brain/inbox — Mitchell's open inbox threads (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  try {
    const accounts = await listAccounts();
    const acct = accounts.find((a) => (a.email ?? "").toLowerCase() === OWNER_EMAIL);
    if (!acct) return NextResponse.json({ threads: [], note: `No Missive inbox found for ${OWNER_EMAIL}.` });
    const threads = await listThreads({ mailboxId: acct.id, folder: "INBOX", status: "open", limit: 25 });
    const items = threads.map((t) => ({
      id: t.id,
      subject: t.subject || "(no subject)",
      from: t.last_from ?? (t.participants?.[0] ?? "unknown"),
      snippet: t.last_snippet ?? "",
      lastAt: t.last_message_at
    }));
    return NextResponse.json({ threads: items, note: null });
  } catch (err) {
    return NextResponse.json({ threads: [], note: err instanceof Error ? err.message : "inbox unavailable" });
  }
}
