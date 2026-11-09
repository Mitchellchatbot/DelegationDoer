import { startSlackInstall } from "@/lib/exec/slack-oauth";

// GET /api/integrations/exec-slack/start: begins the Executive Assistant's
// bot-only Slack install (P6 contract §3.10.3, K5, C24, C45). Not public: the
// middleware requires a session and startSlackInstall the strong one
// (requireExecSession). Every step lives in slack-oauth.ts; the answer is a
// 303 to Settings with ?slack=<code>, or the 302 to Slack's authorize URL.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  return startSlackInstall(req);
}
