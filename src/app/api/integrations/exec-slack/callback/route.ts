import { finishSlackInstall } from "@/lib/exec/slack-oauth";

// GET /api/integrations/exec-slack/callback: Slack's OAuth redirect back to DD
// (P6 contract §3.10.4, K5, C1, C25, C44). Not public: the strong session is
// required again, and the state must have been issued to this very session.
// Every step lives in slack-oauth.ts; nothing is stored unless every check
// passes, and the answer is a 303 to Settings with ?slack=<code>.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return finishSlackInstall(req);
}
