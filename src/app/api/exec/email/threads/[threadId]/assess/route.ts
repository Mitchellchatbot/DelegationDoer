import { assessThread } from "@/lib/exec/email-assess";

// POST /api/exec/email/threads/:id/assess: queue a forced assessment of one
// of his filtered, failed or deferred threads. Everything (the owner gate,
// same-origin, the checks, the audit, the rate limit) lives in
// lib/exec/email-assess.ts; any other method gets Next's 405.
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { threadId: string } }) {
  return assessThread(req, params.threadId);
}
