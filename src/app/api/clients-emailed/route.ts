import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import {
  resolveWindow,
  listClientsEmailedInWindow,
  type ClientEmailedRow,
  type EmailWindowKind
} from "@/lib/clients-emailed";

// /home "Clients emailed" card data. Which clients we emailed today, or this
// week (Mon 00:00 NY → now). Leader/admin only — this is a workspace-wide
// client-contact view, the same audience as the client-health surfaces. Sam &
// Mitchell are leaders, so they pass.

export const dynamic = "force-dynamic";

// Short in-process memo so a leader toggling Today/This-week doesn't re-walk
// the SENT folder on every click. Keyed by window kind; a single 60s TTL is
// plenty for a "what did we send" glance and keeps the clone calls cheap.
const TTL_MS = 60_000;
const cache = new Map<EmailWindowKind, { at: number; rows: ClientEmailedRow[] }>();

async function loadWindow(kind: EmailWindowKind): Promise<ClientEmailedRow[]> {
  const hit = cache.get(kind);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = await listClientsEmailedInWindow(resolveWindow(kind));
  cache.set(kind, { at: Date.now(), rows });
  return rows;
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
    if (!isLeader(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const param = req.nextUrl.searchParams.get("window");
    const window: EmailWindowKind = param === "week" ? "week" : "today";
    const clients = await loadWindow(window);
    return NextResponse.json({ window, clients, count: clients.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
