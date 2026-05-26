import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sodSignalFor } from "@/lib/shift";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";

export const dynamic = "force-dynamic";

// POST /api/sod/submit
//   body: { date?, topPriority?, tasksPlanned?, blockers? }
//
// Finalises the user's SOD: upserts any inline field updates, stamps
// submitted_at, then DMs every leader + admin + Mujtaba (matched by
// name substring, mirroring email-approvers.ts) with a short snapshot.

interface UserSlim {
  id: string;
  name: string | null;
  email: string | null;
  slack_email: string | null;
  slack_user_id: string | null;
  role: "leader" | "department_head" | "worker";
  is_admin: boolean | null;
}


export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "no user" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      date?: string;
      topPriority?: string | null;
      tasksPlanned?: string | null;
      blockers?: string | null;
    };
    const signal = sodSignalFor(me);
    const shiftDate =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : "shiftDate" in signal
        ? signal.shiftDate
        : new Date().toISOString().slice(0, 10);

    const TEXT = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const t = v.replace(/\r\n/g, "\n");
      return t.length > 0 ? t : null;
    };

    const id = `sod_${userId}_${shiftDate}`;
    const now = new Date().toISOString();
    const upsertRow: Record<string, unknown> = {
      id,
      user_id: userId,
      note_date: shiftDate,
      updated_at: now,
      submitted_at: now
    };
    if ("topPriority" in body) upsertRow.top_priority = TEXT(body.topPriority);
    if ("tasksPlanned" in body) upsertRow.tasks_planned = TEXT(body.tasksPlanned);
    if ("blockers" in body) upsertRow.blockers = TEXT(body.blockers);

    const { data: row, error: upErr } = await supabase
      .from("sod_notes")
      .upsert(upsertRow, { onConflict: "user_id,note_date" })
      .select("top_priority, tasks_planned, blockers, submitted_at")
      .maybeSingle();
    if (upErr) {
      return NextResponse.json(
        { error: `Couldn't save SOD: ${upErr.message}` },
        { status: 500 }
      );
    }

    const topPriority = (row?.top_priority as string | null) ?? null;
    const tasksPlanned = (row?.tasks_planned as string | null) ?? null;
    const blockers = (row?.blockers as string | null) ?? null;

    if (!topPriority && !tasksPlanned && !blockers) {
      return NextResponse.json(
        { error: "Fill out at least one SOD field before submitting." },
        { status: 400 }
      );
    }

    // Recipients = every leader + every department_head who's a member
    // of the submitter's department(s). So when a worker in dep_web
    // submits, every leader + every dep_web head gets a DM; their
    // dep_seo head does NOT (out of scope). Author is always excluded.
    const myDeptIds = me.departmentIds ?? [];

    // Step 1: dept heads who are members of the submitter's departments.
    let deptHeadIds: string[] = [];
    if (myDeptIds.length > 0) {
      const { data: deptHeadRows } = await supabase
        .from("department_members")
        .select("user_id, users!inner(role)")
        .in("department_id", myDeptIds);
      type Row = { user_id: string; users: { role: string } | { role: string }[] | null };
      deptHeadIds = ((deptHeadRows ?? []) as Row[])
        .filter((r) => {
          const u = Array.isArray(r.users) ? r.users[0] : r.users;
          return u?.role === "department_head";
        })
        .map((r) => r.user_id);
    }

    // Step 2: fetch leaders + the dept-head IDs above in one round-trip.
    const orParts: string[] = ["role.eq.leader"];
    if (deptHeadIds.length > 0) {
      orParts.push(`id.in.(${deptHeadIds.join(",")})`);
    }
    const { data: candidates } = await supabase
      .from("users")
      .select("id, name, email, slack_email, slack_user_id, role, is_admin")
      .or(orParts.join(","));

    const recipients = new Map<string, UserSlim>();
    for (const u of (candidates ?? []) as UserSlim[]) {
      if (u.id === userId) continue;
      recipients.set(u.id, u);
    }

    // Short DM body — header, top priority quote, one-line task+blocker
    // summary, link button. Spec'd with Hamza in the chat preview.
    const taskCount = tasksPlanned
      ? tasksPlanned.split("\n").map((s) => s.trim()).filter(Boolean).length
      : 0;
    const tz = me.workTimezone || "America/New_York";
    const startTimeStr = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date());

    const summaryBits: string[] = [];
    if (taskCount > 0) summaryBits.push(`${taskCount} task${taskCount === 1 ? "" : "s"} on the plate`);
    if (blockers) summaryBits.push("⚠️ Blockers reported");
    else summaryBits.push("no blockers reported");

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "";
    const link = baseUrl ? `${baseUrl}/sod` : null;

    const quoteLines = (s: string) =>
      s.split("\n").map((line) => `> ${line}`).join("\n");

    const text = `🌅 ${me.name ?? "Someone"} started their day · ${startTimeStr}`;
    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🌅  *${me.name ?? "Someone"}* started their day · _${startTimeStr}_`
        }
      }
    ];
    if (topPriority) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Top priority today*\n${quoteLines(topPriority)}`
        }
      });
    }
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: summaryBits.join(" · ") }]
    });
    if (link) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View full SOD →" },
            url: link
          }
        ]
      });
    }

    // Fan out the DMs. Per-recipient failure is recorded but doesn't
    // fail the request — author shouldn't see a 500 just because one
    // reviewer hasn't connected Slack.
    const deliveries: Array<{ userId: string; name: string | null; delivered: boolean; reason?: string }> = [];
    if (process.env.SLACK_BOT_TOKEN) {
      for (const u of recipients.values()) {
        try {
          const slackUserId = await resolveSlackId({
            id: u.id,
            email: u.email,
            slack_email: u.slack_email,
            slack_user_id: u.slack_user_id
          });
          const dm = await openDm(slackUserId);
          await postMessage(dm, text, blocks);
          deliveries.push({ userId: u.id, name: u.name, delivered: true });
        } catch (err) {
          deliveries.push({
            userId: u.id,
            name: u.name,
            delivered: false,
            reason: err instanceof Error ? err.message : "slack failed"
          });
        }
      }
    } else {
      for (const u of recipients.values()) {
        deliveries.push({
          userId: u.id,
          name: u.name,
          delivered: false,
          reason: "SLACK_BOT_TOKEN missing"
        });
      }
    }

    return NextResponse.json({
      ok: true,
      date: shiftDate,
      recipients: deliveries.length,
      delivered: deliveries.filter((d) => d.delivered).length,
      deliveries
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
