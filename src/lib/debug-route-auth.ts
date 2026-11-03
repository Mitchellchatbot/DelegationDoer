import "server-only";

import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/access";

// Gate for /api/debug/* — leaders (and stealth admins) only.
//
// These routes seed fake data, overwrite avatars, delete tasks and DM
// workspace members. They used to sit under a public middleware prefix with no
// check at all. Now middleware verifies the session (the prefix is no longer
// public) and this adds the role check on top.
//
// Anything that writes is POST-only (see `postRequired`): a GET can be fired by
// a link or a crawler, and SameSite=Lax cookies ride along on top-level GET
// navigations, so a GET that deletes is one click away from a CSRF.

export async function debugRouteAuthError(): Promise<NextResponse | null> {
  let userId: string;
  try {
    userId = await requireCurrentUserId();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const me = await getUserById(userId);
  if (!isLeader(me)) {
    return NextResponse.json({ error: "leader only" }, { status: 403 });
  }
  return null;
}

export function postRequired(hint: string): NextResponse {
  return NextResponse.json(
    { error: "this action writes data, so it is POST-only", hint },
    { status: 405, headers: { Allow: "POST" } }
  );
}
