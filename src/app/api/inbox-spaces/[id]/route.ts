import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

const VALID_COLORS = new Set([
  "blue","indigo","violet","fuchsia","pink","amber","emerald","teal","rose","sky"
]);

// PATCH /api/inbox-spaces/[id]
//   body: { name?, color?, accountIds?, memberIds? }
//   When accountIds or memberIds is provided, replace wholesale.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const actorId = await requireCurrentUserId();
    const actor = await getUserById(actorId);
    if (!isLeader(actor)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const supabase = getSupabaseAdmin();

    const update: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const n = body.name.trim().slice(0, 60);
      if (!n) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      update.name = n;
    }
    if (typeof body.color === "string" && VALID_COLORS.has(body.color)) {
      update.color = body.color;
    }
    if (Object.keys(update).length > 0) {
      const { error } = await supabase
        .from("inbox_spaces")
        .update(update)
        .eq("id", params.id);
      if (error) {
        return NextResponse.json({ error: `space update: ${error.message}` }, { status: 500 });
      }
    }

    if (Array.isArray(body.accountIds)) {
      const ids: string[] = body.accountIds.filter(
        (s: unknown): s is string => typeof s === "string"
      );
      await supabase.from("inbox_space_accounts").delete().eq("space_id", params.id);
      if (ids.length > 0) {
        await supabase
          .from("inbox_space_accounts")
          .insert(ids.map((a) => ({ space_id: params.id, account_id: a })));
      }
    }

    if (Array.isArray(body.memberIds)) {
      const ids: string[] = body.memberIds.filter(
        (s: unknown): s is string => typeof s === "string"
      );
      await supabase.from("inbox_space_members").delete().eq("space_id", params.id);
      if (ids.length > 0) {
        await supabase
          .from("inbox_space_members")
          .insert(ids.map((u) => ({ space_id: params.id, user_id: u })));
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const actorId = await requireCurrentUserId();
    const actor = await getUserById(actorId);
    if (!isLeader(actor)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }
    const { error } = await getSupabaseAdmin()
      .from("inbox_spaces")
      .delete()
      .eq("id", params.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
