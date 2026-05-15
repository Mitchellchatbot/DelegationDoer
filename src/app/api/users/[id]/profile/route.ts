import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/users/[id]/profile — public-safe view of someone's
// profile. Returns name + role + work email + the always-public
// extras (job title, location, bio, pronouns). Personal email +
// phone come back only when the viewer is the user themselves
// OR the viewer is a leader.
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const viewerId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const [{ data: target }, { data: viewer }] = await Promise.all([
      supabase
        .from("users")
        .select("id, name, email, avatar_url, role, personal_email, phone, job_title, location, bio, pronouns, birthday, work_hours_start, work_hours_end, work_timezone")
        .eq("id", params.id)
        .maybeSingle(),
      supabase
        .from("users")
        .select("role, is_admin")
        .eq("id", viewerId)
        .maybeSingle()
    ]);
    if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

    const isSelf = viewerId === params.id;
    const viewerIsLeader = viewer?.role === "leader" || viewer?.is_admin === true;
    const canSeePrivate = isSelf || viewerIsLeader;

    return NextResponse.json({
      profile: {
        id: target.id,
        name: target.name,
        email: target.email, // work email — public to anyone signed in
        avatarUrl: (target.avatar_url as string | null) ?? null,
        role: target.role,
        jobTitle: (target.job_title as string | null) ?? null,
        location: (target.location as string | null) ?? null,
        bio: (target.bio as string | null) ?? null,
        pronouns: (target.pronouns as string | null) ?? null,
        // Birthday's month + day are public on the day-of (handled
        // elsewhere); the full date stays private to self.
        birthday: isSelf ? ((target.birthday as string | null) ?? null) : null,
        personalEmail: canSeePrivate ? ((target.personal_email as string | null) ?? null) : null,
        phone: canSeePrivate ? ((target.phone as string | null) ?? null) : null,
        // Work hours are workspace-public — teammates need to know
        // when you're around. Stored in your own tz; viewer converts.
        workHoursStart: (target.work_hours_start as string | null) ?? null,
        workHoursEnd: (target.work_hours_end as string | null) ?? null,
        workTimezone: (target.work_timezone as string | null) ?? null
      },
      viewer: {
        isSelf,
        isLeader: viewerIsLeader
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
