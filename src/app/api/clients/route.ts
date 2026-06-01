import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/clients — the canonical client roster. Used by NewTaskForm's
// dropdown and any other surface that needs the master list. Ordered
// by display_order so the Leader-tuned ranking is the default sort;
// callers that want raw rank can read priority_rank.
export async function GET() {
  try {
    await requireCurrentUserId();
    const { data, error } = await getSupabaseAdmin()
      .from("clients")
      .select(
        "id, name, website, contact_name, contact_emails, priority, priority_rank, display_order, status, start_date, subscription_date, did_build_website, tawk_installed, google_profile_automation, domain_location, hosting_location, notes"
      )
      .order("display_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const clients = (data ?? []).map((c) => ({
      id: c.id as string,
      name: c.name as string,
      website: (c.website as string | null) ?? null,
      contactName: (c.contact_name as string | null) ?? null,
      contactEmails: (c.contact_emails as string[] | null) ?? [],
      priority: (c.priority as string) ?? "medium",
      priorityRank: (c.priority_rank as number | null) ?? null,
      displayOrder: Number(c.display_order ?? 0),
      status: (c.status as string) ?? "active",
      startDate: (c.start_date as string | null) ?? null,
      subscriptionDate: (c.subscription_date as string | null) ?? null,
      didBuildWebsite: (c.did_build_website as boolean | null) ?? null,
      tawkInstalled: (c.tawk_installed as boolean | null) ?? null,
      googleProfileAutomation: (c.google_profile_automation as boolean | null) ?? null,
      domainLocation: (c.domain_location as string | null) ?? null,
      hostingLocation: (c.hosting_location as string | null) ?? null,
      notes: (c.notes as string | null) ?? null
    }));
    return NextResponse.json({ clients });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/clients — create a new client folder.
// Body: { name, website?, priority? ('low'|'medium'|'high'), notes? }
export async function POST(req: NextRequest) {
  try {
    await requireCurrentUserId();
    const body = await req.json();
    const name = (body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

    const id = `cl_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32)}_${Math.random().toString(36).slice(2, 6)}`;
    const priority = ["low", "medium", "high"].includes(body.priority) ? body.priority : "medium";

    const { data, error } = await getSupabaseAdmin()
      .from("clients")
      .insert({
        id,
        name,
        website: typeof body.website === "string" && body.website.trim() ? body.website.trim() : null,
        priority,
        notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Fire-and-forget Firecrawl icon fetch when a website was provided.
    // Runs in the background — the create response returns immediately.
    // If it succeeds, the icon shows up on the next page render; if it
    // fails, the briefcase fallback keeps rendering.
    if (data && typeof data.website === "string" && data.website.trim()) {
      const { autoFetchAndStoreClientIcon } = await import("@/lib/client-icon-auto");
      autoFetchAndStoreClientIcon(data.id, data.website).catch((e) => {
        console.warn(`[auto-icon] fire-and-forget for ${data.id} failed:`, e);
      });
    }

    return NextResponse.json({ client: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
