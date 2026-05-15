import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { loadClientMatcher } from "@/lib/client-thread-match";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/clients/rescan
//
// Backfills tasks.client_name on any task that has a known sender email
// (client_email) but no client_name yet. Uses the same matcher the
// email-intake pipeline uses at create time, so a one-shot rescan
// catches everything that pre-dates the auto-attribution wiring.
//
// Leader / admin only — this rewrites historical task rows.
export async function POST() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !(me.role === "leader" || me.isAdmin)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const matcher = await loadClientMatcher();
    if (matcher.clientsLoaded === 0) {
      return NextResponse.json({ ok: true, scanned: 0, updated: 0, reason: "no clients on file" });
    }

    const supabase = getSupabaseAdmin();
    // Only consider tasks that have an inbound email on them but no
    // client yet. Tasks the user manually filed under a client stay
    // put — we never overwrite a non-null client_name.
    const { data: rows, error } = await supabase
      .from("tasks")
      .select("id, client_email")
      .is("client_name", null)
      .not("client_email", "is", null);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const updates: { id: string; name: string }[] = [];
    for (const r of rows ?? []) {
      const email = (r.client_email as string | null) ?? null;
      const hit = matcher.match(email);
      if (hit) updates.push({ id: r.id as string, name: hit.name });
    }

    // Apply updates one at a time. Each match is independent so a
    // failure on one row doesn't poison the rest of the rescan.
    let updated = 0;
    const failures: string[] = [];
    for (const u of updates) {
      const { error: upErr } = await supabase
        .from("tasks")
        .update({ client_name: u.name })
        .eq("id", u.id)
        .is("client_name", null); // race-safe: another writer may have filed it.
      if (upErr) failures.push(`${u.id}: ${upErr.message}`);
      else updated++;
    }

    return NextResponse.json({
      ok: true,
      scanned: rows?.length ?? 0,
      candidates: updates.length,
      updated,
      failures: failures.length
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
