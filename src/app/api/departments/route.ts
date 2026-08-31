import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canAddDepartments } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

const DEPT_COLS = "id, name, description, task_types, slack_channel_id, task_channel_id, head_user_id";

type DepartmentRow = {
  id: string;
  name: string;
  description: string | null;
  task_types: string[] | null;
  slack_channel_id: string | null;
  task_channel_id: string | null;
  head_user_id: string | null;
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
  const { data, error } = await getSupabaseAdmin()
    .from("departments")
    .select(DEPT_COLS)
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    departments: (data ?? []).map((d) => toDepartment(d as DepartmentRow))
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

    const { data, error } = await getSupabaseAdmin()
      .from("departments")
      .insert({ id, name, description })
      .select(DEPT_COLS)
      .single();

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
