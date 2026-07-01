import "server-only";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canSeeCustomerSupport } from "@/lib/auth";
import type { User } from "@/lib/types";

// Per-handler access gate for the /api/support/* routes. The middleware already
// requires a Supabase session, but every handler re-checks authorization here —
// DD never trusts the middleware gate alone for permission-scoped surfaces.
// Returns the user when allowed, or null (→ caller responds 403).
export async function getSupportUser(): Promise<User | null> {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !canSeeCustomerSupport(me)) return null;
    return me;
  } catch {
    return null;
  }
}
