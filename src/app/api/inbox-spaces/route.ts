import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

const VALID_COLORS = new Set([
  "blue","indigo","violet","fuchsia","pink","amber","emerald","teal","rose","sky"
]);

// GET /api/inbox-spaces
//   Returns every space + its account ids + member ids. Used by the
//   inbox sidebar (to group accounts) and the manage page (to edit
//   membership). All authenticated users can read; visibility-side
//   filtering happens in the sidebar component.
export async function GET() {
  try {
    await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const [spacesRes, acctsRes, membersRes] = await Promise.all([
      supabase
        .from("inbox_spaces")
        .select("id, name, color, position, created_at, created_by")
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase.from("inbox_space_accounts").select("space_id, account_id"),
      supabase.from("inbox_space_members").select("space_id, user_id")
    ]);

    const accountsBySpace = new Map<string, string[]>();
    for (const r of (acctsRes.data ?? []) as { space_id: string; account_id: string }[]) {
      const arr = accountsBySpace.get(r.space_id) ?? [];
      arr.push(r.account_id);
      accountsBySpace.set(r.space_id, arr);
    }
    const membersBySpace = new Map<string, string[]>();
    for (const r of (membersRes.data ?? []) as { space_id: string; user_id: string }[]) {
      const arr = membersBySpace.get(r.space_id) ?? [];
      arr.push(r.user_id);
      membersBySpace.set(r.space_id, arr);
    }

    return NextResponse.json({
      spaces: (spacesRes.data ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        createdAt: s.created_at,
        createdBy: s.created_by,
        accountIds: accountsBySpace.get(s.id as string) ?? [],
        memberIds: membersBySpace.get(s.id as string) ?? []
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/inbox-spaces
//   body: { name: string, color?: string, accountIds?: string[], memberIds?: string[] }
//   Leader-only. Atomic create with optional starting accounts +
//   members so the leader can spin up "Tech Hub" with a few clicks.
export async function POST(req: NextRequest) {
  try {
    const actorId = await requireCurrentUserId();
    const actor = await getUserById(actorId);
    if (!isLeader(actor)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const color = typeof body.color === "string" && VALID_COLORS.has(body.color)
      ? body.color
      : "blue";
    const accountIds: string[] = Array.isArray(body.accountIds)
      ? body.accountIds.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const memberIds: string[] = Array.isArray(body.memberIds)
      ? body.memberIds.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const id = `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const supabase = getSupabaseAdmin();
    const { error: insErr } = await supabase
      .from("inbox_spaces")
      .insert({ id, name, color, created_by: actorId });
    if (insErr) {
      return NextResponse.json({ error: `create: ${insErr.message}` }, { status: 500 });
    }
    if (accountIds.length > 0) {
      await supabase
        .from("inbox_space_accounts")
        .insert(accountIds.map((a) => ({ space_id: id, account_id: a })));
    }
    if (memberIds.length > 0) {
      await supabase
        .from("inbox_space_members")
        .insert(memberIds.map((u) => ({ space_id: id, user_id: u })));
    }
    return NextResponse.json({
      space: { id, name, color, accountIds, memberIds }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
