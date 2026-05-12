import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// CRUD for missive_account_settings — currently only the
// `auto_intake_enabled` flag (off by default). The /inboxes/manage page
// hits this when the Leader toggles auto-intake on per-inbox.

async function requireCeo() {
  const id = await requireCurrentUserId();
  const u = await getUserById(id);
  return u && u.role === "leader" ? u : null;
}

// GET — list every settings row. Migration may not have run yet, so we
// degrade to an empty list rather than 500ing.
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("missive_account_settings")
    .select("account_id, auto_intake_enabled, last_polled_at");
  if (error) return NextResponse.json({ settings: [] });
  return NextResponse.json({ settings: data ?? [] });
}

// POST — upsert the `auto_intake_enabled` flag for one account.
// body: { accountId: string, autoIntakeEnabled: boolean }
export async function POST(req: NextRequest) {
  if (!(await requireCeo())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const autoIntakeEnabled = !!body.autoIntakeEnabled;
  if (!accountId) {
    return NextResponse.json({ error: "accountId required" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("missive_account_settings")
    .upsert(
      {
        account_id: accountId,
        auto_intake_enabled: autoIntakeEnabled,
        updated_at: now
      },
      { onConflict: "account_id" }
    )
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ setting: data });
}
