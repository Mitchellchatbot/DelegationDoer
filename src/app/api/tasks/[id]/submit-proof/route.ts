import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";

export const dynamic = "force-dynamic";
const FB_DEPT = "dep_facebook";
// The Facebook "dream team" channel (#dream-team-, the active private one) —
// submissions are announced here for a manager to pick up and proof.
const DREAM_TEAM_CHANNEL = "C0ARTB0UD6V";

// Who to @-mention on the announcement.
//
// This mirrors isFbProofer on the task detail page — the people who can
// actually hit Approve: the Facebook department head(s) plus leaders. The
// point is the mention itself: a plain channel post raises no notification,
// so the first submissions sat in the channel unseen for hours while
// everyone assumed the integration was broken. It wasn't; nobody was pinged.
//
// Stealth admins are deliberately NOT included, matching the same decision
// made for the EOD fan-out: admin status is orthogonal to who reviews work.
// The submitter is never mentioned — they already know they submitted.
async function prooferMentions(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  submitterId: string
): Promise<string[]> {
  const [{ data: dept }, { data: members }] = await Promise.all([
    supabase.from("departments").select("head_user_id").eq("id", FB_DEPT).maybeSingle(),
    supabase.from("department_members").select("user_id").eq("department_id", FB_DEPT)
  ]);
  const headId = (dept?.head_user_id as string | null) ?? null;
  const fbMemberIds = new Set<string>((members ?? []).map((m) => m.user_id as string));

  const { data: users } = await supabase
    .from("users")
    .select("id, role, email, slack_email, slack_user_id")
    .or("role.eq.leader,role.eq.department_head");

  const targets = (users ?? []).filter((u) => {
    const id = u.id as string;
    if (id === submitterId) return false;
    if (u.role === "leader") return true;
    // A department_head only counts if they actually head Facebook.
    return id === headId || fbMemberIds.has(id);
  });

  // Per-user best-effort: resolveSlackId throws when a DD user has no
  // matching Slack account (users_not_found is common here — several DD
  // emails don't match their Slack login). One unresolvable person must
  // not cost everyone else their ping.
  const resolved = await Promise.all(
    targets.map(async (u) => {
      try {
        return await resolveSlackId(u);
      } catch {
        return null;
      }
    })
  );
  return Array.from(new Set(resolved.filter((x): x is string => !!x)));
}

// POST { photoUrl, workDone, testDone } — a Facebook-team member submits a
// completed FB task for manager approval. Requires a photo of the finished work
// and a note of what was done; records whether a test was run. Moves the task to
// 'pending_approval' (NOT done) until a manager proofs it.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;
  if (access.task.departmentId !== FB_DEPT) {
    return NextResponse.json({ error: "not a Facebook task" }, { status: 400 });
  }
  const isFbMember = (access.viewer?.departmentIds ?? []).includes(FB_DEPT);
  if (!isFbMember) {
    return NextResponse.json({ error: "Only the Facebook team submits proof" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const photoUrl = typeof body.photoUrl === "string" ? body.photoUrl.trim() : "";
  const workDone = typeof body.workDone === "string" ? body.workDone.trim() : "";
  const testDone = body.testDone === true;
  if (!photoUrl) return NextResponse.json({ error: "A photo of the completed work is required" }, { status: 400 });
  if (!workDone) return NextResponse.json({ error: "Describe what you did" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { error: pErr } = await supabase.from("fb_proof").upsert({
    task_id: params.id,
    photo_url: photoUrl,
    work_done: workDone,
    test_done: testDone,
    submitted_by: access.viewerId,
    submitted_at: now,
    review_status: "pending",
    reviewed_by: null,
    review_notes: null,
    reviewed_at: null,
    updated_at: now
  }, { onConflict: "task_id" });
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

  const { error: tErr } = await supabase
    .from("tasks")
    .update({ status: "pending_approval", last_activity_at: now })
    .eq("id", params.id);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  // Keep the proof photo in the task's media gallery + timeline too.
  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: params.id,
    user_id: access.viewerId,
    action: "submitted_for_approval",
    detail: testDone ? "Submitted for approval · test done" : "Submitted for approval · no test",
    image_url: photoUrl
  }).select("id").maybeSingle();

  // Announce in the #dream-team channel so a manager can pick it up and proof it.
  // Best-effort — a Slack hiccup must not fail the submission — but the outcome
  // is logged either way: the silent catch this replaced made "did it post?"
  // unanswerable from the logs, which cost hours of guesswork.
  try {
    const { data: t } = await supabase.from("tasks").select("title").eq("id", params.id).maybeSingle();
    const title = (t?.title as string | null) ?? "a task";
    const who = access.viewer?.name ?? "Someone";
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const taskUrl = `${base}/tasks/${params.id}`;
    const mentions = await prooferMentions(supabase, access.viewerId);
    const mentionLine = mentions.map((id) => `<@${id}>`).join(" ");

    const { ts } = await postMessage(
      DREAM_TEAM_CHANNEL,
      `🔵 ${who} submitted "${title}" for approval`,
      [
        { type: "section", text: { type: "mrkdwn", text: `🔵 *${who}* submitted *<${taskUrl}|${title}>* for approval` } },
        { type: "section", text: { type: "mrkdwn", text: `*What was done:* ${workDone}\n*Test done:* ${testDone ? "Yes ✅" : "No"}` } },
        ...(photoUrl ? [{ type: "image", image_url: photoUrl, alt_text: "Proof of completed work" }] : []),
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Review & approve" }, url: taskUrl }] },
        ...(mentionLine
          ? [{ type: "section", text: { type: "mrkdwn", text: `Needs approval from ${mentionLine}` } }]
          : [])
      ]
    );
    console.log(
      `[fb-proof] announced task=${params.id} channel=${DREAM_TEAM_CHANNEL} ts=${ts} mentions=${mentions.length}`
    );
    if (mentions.length === 0) {
      console.warn("[fb-proof] no proofer could be resolved to a Slack account — posted without a mention");
    }
  } catch (err) {
    console.error("[fb-proof] slack announce failed:", err);
  }

  return NextResponse.json({ ok: true });
}
