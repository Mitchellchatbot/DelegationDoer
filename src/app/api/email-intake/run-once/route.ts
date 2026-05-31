import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getThread } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { runEmailIntake } from "@/lib/email-intake";
import { extractEmail, missiveThreadUrl, threadBodyFromMessages } from "@/lib/email-intake-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/email-intake/run-once
//   body: { accountId: string, threadId: string }
//
// Runs the same shared intake pipeline on one specific thread. Used by
// the "Create task from this thread" button on the inbox thread view —
// useful when auto-intake is off, or to convert a thread that pre-dates
// the toggle being flipped on.
//
// Bypasses the email_intake_log dedupe (source: "manual") so users can
// re-trigger intake on a thread that the cron already processed once.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const body = await req.json();
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!accountId || !threadId) {
      return NextResponse.json({ error: "accountId + threadId required" }, { status: 400 });
    }

    // Reuse the same access check the inbox pages use — only people who
    // can see the inbox can convert from it.
    const visibleIds = await visibleAccountIdsFor(me);
    if (visibleIds !== null && !visibleIds.has(accountId)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const detail = await getThread(threadId);
    const inbound = detail.messages.find((m) => m.direction === "inbound") ?? detail.messages[0];
    const fromEmail = inbound ? extractEmail(inbound.from_addr) : null;

    const outcome = await runEmailIntake({
      accountId,
      threadId,
      threadSubject: detail.thread.subject,
      threadBody: threadBodyFromMessages(detail.messages),
      fromEmail,
      missiveThreadUrl: missiveThreadUrl(threadId),
      source: "manual"
    });

    if (outcome.skipped === "no-candidates") {
      return NextResponse.json(
        { error: "couldn't pick an assignee — no users have matching skills or capacity", classified: outcome.classified },
        { status: 422 }
      );
    }

    // Override creator_id so the created-by attribution reflects the
    // actual person who clicked the button, not the auto-routed assignee.
    if (outcome.taskId) {
      await getSupabaseAdmin()
        .from("tasks")
        .update({ creator_id: userId })
        .eq("id", outcome.taskId);
    }

    return NextResponse.json({
      ok: true,
      taskId: outcome.taskId,
      routedToUserId: outcome.routedToUserId,
      reason: outcome.reason,
      classified: outcome.classified
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

