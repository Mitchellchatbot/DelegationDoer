import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeOutbound } from "@/lib/auth";
import { deleteForm } from "@/lib/outbound-typeform-forms";

export const dynamic = "force-dynamic";

// DELETE /api/outbound/typeform-forms/[id] — remove a Typeform from
// the catalog. The Lead rows that came from it stay intact; they'll
// surface under the "Unknown forms" block on the leads page until
// you re-register the form.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me || !canSeeOutbound(me)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    await deleteForm(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "delete failed" },
      { status: 500 }
    );
  }
}
