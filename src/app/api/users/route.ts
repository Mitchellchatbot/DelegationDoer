import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar_url?: string | null;
  presence?: string | null;
  presence_updated_at?: string | null;
  status_emoji?: string | null;
}

// GET /api/users — lightweight list of every user with whatever
// presence + emoji data the schema currently has. Resilient to partial
// migrations: if `status_emoji` (or presence columns) haven't been added
// yet, we fall back to a smaller select rather than 500ing.
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();

  // First try: full shape including presence + emoji.
  let rows: UserRow[] | null = null;
  let lastError: string | null = null;

  const tries = [
    "id, name, email, role, avatar_url, presence, presence_updated_at, status_emoji, clock_enabled, is_admin, daily_capacity, work_timezone, weekly_schedule, manager_user_id",
    "id, name, email, role, avatar_url, presence, presence_updated_at, status_emoji, clock_enabled, is_admin, daily_capacity, work_timezone, weekly_schedule",
    "id, name, email, role, avatar_url, presence, presence_updated_at, status_emoji, clock_enabled, is_admin",
    "id, name, email, role, avatar_url, presence, presence_updated_at, status_emoji, clock_enabled",
    "id, name, email, role, avatar_url, presence, presence_updated_at, status_emoji",
    "id, name, email, role, avatar_url, presence, presence_updated_at",
    "id, name, email, role, avatar_url"
  ];

  for (const cols of tries) {
    const { data, error } = await supabase.from("users").select(cols).order("name");
    if (!error) {
      rows = (data ?? []) as unknown as UserRow[];
      break;
    }
    lastError = error.message;
    // Only fall through on "column does not exist". Anything else is a
    // real failure and shouldn't be papered over.
    if (!/column .* does not exist/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  if (!rows) {
    return NextResponse.json(
      { error: lastError ?? "users query failed" },
      { status: 500 }
    );
  }

  // Department memberships join — used by the notify-teammates picker
  // and any other surface that wants to group people by team. Failures
  // here degrade to empty arrays rather than 500ing.
  const departmentsByUser = new Map<string, string[]>();
  const { data: memberRows } = await supabase
    .from("department_members")
    .select("user_id, department_id");
  for (const r of memberRows ?? []) {
    const arr = departmentsByUser.get(r.user_id as string) ?? [];
    arr.push(r.department_id as string);
    departmentsByUser.set(r.user_id as string, arr);
  }

  return NextResponse.json({
    users: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      avatarUrl: u.avatar_url ?? null,
      presence: (u.presence as "available" | "focus" | "eating" | "away" | null | undefined) ?? null,
      presenceUpdatedAt: u.presence_updated_at ?? null,
      statusEmoji: u.status_emoji ?? null,
      // Default to true so callers that didn't pull this column (older
      // partial-migration fallback) keep the existing behavior.
      clockEnabled: (u as unknown as { clock_enabled?: boolean }).clock_enabled ?? true,
      isAdmin: (u as unknown as { is_admin?: boolean }).is_admin === true,
      dailyCapacity: Number((u as unknown as { daily_capacity?: number }).daily_capacity ?? 8),
      workTimezone:
        (u as unknown as { work_timezone?: string | null }).work_timezone ?? null,
      weeklySchedule:
        (u as unknown as { weekly_schedule?: Record<string, unknown> }).weekly_schedule ?? {},
      // null when the column hasn't migrated yet (older fallback select)
      // or the user has no explicit manager.
      managerId:
        (u as unknown as { manager_user_id?: string | null }).manager_user_id ?? null,
      departmentIds: departmentsByUser.get(u.id) ?? []
    }))
  });
}
