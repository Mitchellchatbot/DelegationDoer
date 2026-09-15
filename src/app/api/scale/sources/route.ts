import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { setScaleSources } from "@/lib/scale-sources";

export const dynamic = "force-dynamic";

async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

// PATCH — flip the Scale Room's outside sources (owner only).
// Body: { facebook?: boolean, outbound?: boolean } — at least one.
export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "expected a JSON object" }, { status: 400 });
  }
  const patch: { facebook?: boolean; outbound?: boolean } = {};
  for (const key of ["facebook", "outbound"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
    patch[key] = body[key] as boolean;
  }
  if (patch.facebook === undefined && patch.outbound === undefined) {
    return NextResponse.json({ error: "nothing to change — send facebook and/or outbound" }, { status: 400 });
  }

  try {
    return NextResponse.json({ sources: await setScaleSources(patch) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "save failed" }, { status: 500 });
  }
}
