import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canAddDepartments } from "@/lib/auth";
import { getSupabaseAdmin, isMissingColumnError } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// head_user_id ships in 20260901000100, and migrations in this project are
// applied BY HAND — merging a PR runs nothing. So this route has to survive a
// build that is live against a database which hasn't had that migration yet.
//
// It cannot just 500 on the way through: /api/departments is read by useTeam(),
// which does `r.ok ? r.json() : null` and degrades to an EMPTY department list.
// A hard failure here would silently blank the board's department chips, the
// New-task department picker (which then blocks task creation for non-leaders),
// the Leader Console Departments tab, Settings and the EOD page — quietly, with
// no error anywhere. Hence the fallback column list, same progressive-select
// convention /api/users uses for its optional columns.
const DEPT_COLS_BASE = "id, name, description, task_types, slack_channel_id, task_channel_id";
const DEPT_COLS = `${DEPT_COLS_BASE}, head_user_id`;

type DepartmentRow = {
  id: string;
  name: string;
  description: string | null;
  task_types: string[] | null;
  slack_channel_id: string | null;
  task_channel_id: string | null;
  // Absent entirely on the pre-migration fallback path.
  head_user_id?: string | null;
};

function toDepartment(d: DepartmentRow) {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? "",
    taskTypes: d.task_types ?? [],
    slackChannelId: d.slack_channel_id ?? null,
    taskChannelId: d.task_channel_id ?? null,
    headUserId: d.head_user_id ?? null
  };
}

// The id convention the Leader Console's create form has always implied:
// "dep_" + slugified name ("Facebook" -> "dep_facebook"). Derived server-side
// so the client never invents an id the DB then disagrees with. Edge
// underscores are trimmed so "Facebook Ads " doesn't become "dep_facebook_ads_".
function departmentIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 24)
    .replace(/^_+|_+$/g, "");
  return slug ? `dep_${slug}` : "";
}

// GET /api/departments — every department with the fields the settings, EOD
// and Leader Console pages care about. Auth-gated only; everyone signed in
// can read this. description + task_types are included because the Leader
// Console's Departments tab renders both.
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();

  const full = await supabase.from("departments").select(DEPT_COLS).order("name");
  // Retry without head_user_id ONLY when that column genuinely doesn't exist
  // yet. Any other error is a real failure and must surface — degrading to an
  // empty department list on a transient blip would be worse than a 500,
  // because callers treat it as "there are no departments".
  const res = isMissingColumnError(full.error)
    ? await supabase.from("departments").select(DEPT_COLS_BASE).order("name")
    : full;

  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  return NextResponse.json({
    departments: (res.data ?? []).map((d) => toDepartment(d as DepartmentRow))
  });
}

// POST /api/departments — { name, description? }. Leader/admin only, matching
// the gates on PUT [id]/slack and [id]/task-channel.
//
// task_types is intentionally not settable here: the create form only collects
// a name and a description, and the column defaults to '{}'. A department that
// needs real task types (they feed the AI routing prompts) gets them from a
// migration or a later edit.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !canAddDepartments(me)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const id = departmentIdFromName(name);
    if (!id) {
      return NextResponse.json(
        { error: "name must contain at least one letter or number" },
        { status: 400 }
      );
    }
    const description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : null;

    const supabase = getSupabaseAdmin();
    const inserted = await supabase
      .from("departments")
      .insert({ id, name, description })
      .select(DEPT_COLS)
      .single();
    // Same pre-migration fallback as GET, but it has to REDO the insert, not
    // just re-read: PostgREST compiles this to INSERT ... RETURNING <cols>, so
    // an unknown column in the select list fails the whole statement and no row
    // is written. Retrying is safe precisely because the first attempt was
    // atomic — there is nothing to duplicate.
    const { data, error } = isMissingColumnError(inserted.error)
      ? await supabase
          .from("departments")
          .insert({ id, name, description })
          .select(DEPT_COLS_BASE)
          .single()
      : inserted;

    // departments.name is UNIQUE and id is the PK, so either can collide.
    // Surface that as a readable 409 instead of a raw Postgres 500.
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: `A department named "${name}" already exists.` },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ department: toDepartment(data as DepartmentRow) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
