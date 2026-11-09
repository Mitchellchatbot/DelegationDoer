import type { NextResponse } from "next/server";

import { requireExecPrincipal } from "@/lib/exec/access";
import { getBriefPageView } from "@/lib/exec/brief-view";
import { jsonAnswer, jsonError } from "@/lib/exec/http";

// GET /api/exec/briefs/latest (P8 contract §3.17.4): today's brief as the page shows it (getBriefPageView: screened at
// render, C31; never a check-in MAC or button value, UI23). The strong gate first (a session opened by a one-time sign-in
// link gets the gate's 404). Every answer is Cache-Control: private, no-store. Logs carry the route, the principal id and
// an error name only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "GET /api/exec/briefs/latest";

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

/** §3.17.4: every response of the brief routes is private, no-store. */
function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

export async function GET(req: Request): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  try {
    const view = await getBriefPageView(gate.principal, new Date());
    return privateNoStore(jsonAnswer(200, { ...view }));
  } catch (err) {
    console.error(`[exec-brief] ${ROUTE} unavailable for ${gate.principal.id} (${errName(err)})`);
    return privateNoStore(jsonError(503, "unavailable"));
  }
}
