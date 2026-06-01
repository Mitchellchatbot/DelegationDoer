import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canManageAssignments } from "@/lib/inbox-access";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { autoFetchAndStoreClientIcon } from "@/lib/client-icon-auto";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — Firecrawl is the slow path

// POST /api/clients/auto-icons
//
// Backfill endpoint: walk every active client that has a website but
// no icon_url yet, scrape its favicon/og-image via Firecrawl, re-host
// in Supabase Storage, and persist. Designed to be triggered by a
// leader once after this feature ships; no UI button is wired in.
//
// Body (optional): { force?: boolean }
//   force=true re-scrapes EVERY client with a website, including ones
//   that already have an icon. Use after a bad first run.
//
// Sequential by design — Firecrawl rate-limits per second, and the
// route's own 5 min ceiling caps the total work. With ~50 clients
// and ~2s per scrape, well within the window.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (!canManageAssignments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const force = body?.force === true;

    const supabase = getSupabaseAdmin();
    let q = supabase
      .from("clients")
      .select("id, name, website, icon_url, status")
      .not("website", "is", null)
      .or("status.eq.active,status.is.null");
    if (!force) q = q.is("icon_url", null);
    const { data: rows, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    type Row = { id: string; name: string; website: string | null; icon_url: string | null; status: string | null };
    const targets = (rows ?? []) as Row[];

    const results: Array<{ id: string; name: string; ok: boolean; reason?: string }> = [];
    let ok = 0;
    let skip = 0;
    for (const t of targets) {
      if (!t.website) {
        skip += 1;
        results.push({ id: t.id, name: t.name, ok: false, reason: "no website" });
        continue;
      }
      const r = await autoFetchAndStoreClientIcon(t.id, t.website, { force });
      if (r.ok) ok += 1; else skip += 1;
      results.push({ id: t.id, name: t.name, ok: r.ok, reason: r.reason });
    }

    return NextResponse.json({
      scanned: targets.length,
      iconsApplied: ok,
      skipped: skip,
      // results capped server-side at the natural length of `targets`,
      // which is at most every client in the workspace — fine for
      // diagnostic output to a leader.
      results
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
