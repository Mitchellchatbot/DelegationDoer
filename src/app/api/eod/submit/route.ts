import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { lookupUserByEmail, openDm, postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/eod/submit
//   body: { date?: "YYYY-MM-DD" }
//   Marks the caller's EOD note for the given date as submitted (server
//   timestamp), then fans out a Slack DM to every leadership user + the
//   dept head(s) for each department the caller belongs to.
//
//   Per the v2 spec (Section 2): "All of them go to mitch, the software
//   ones go to hasan the website ones to mujtaba and then SEO to sam.
//   Mitch gets a notif for the form contents of the employee, and then
//   the department heads actually do the reviewing."
//
//   Leadership delivery = role='leader' OR is_admin=true (catches Mitch
//   plus any stealth admin). Dept-head delivery = role='department_head'
//   member of the worker's home department(s). The same human only gets
//   one DM even if they qualify on multiple paths.

interface UserSlim {
  id: string;
  name: string | null;
  email: string | null;
  role: "leader" | "department_head" | "worker";
  is_admin: boolean | null;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const body = await req.json().catch(() => ({}));
    const dateStr =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date().toISOString().slice(0, 10);

    // Fetch the worker, their EOD row, and their departments in parallel.
    const [{ data: meRow }, { data: noteRow }, { data: deptMemberships }] = await Promise.all([
      supabase.from("users").select("id, name, email, role, is_admin").eq("id", userId).maybeSingle(),
      supabase
        .from("eod_notes")
        .select("id, worked_on, accomplished, plan_tomorrow, blockers, note, submitted_at")
        .eq("user_id", userId)
        .eq("note_date", dateStr)
        .maybeSingle(),
      supabase.from("department_members").select("department_id").eq("user_id", userId)
    ]);

    if (!meRow) return NextResponse.json({ error: "user not found" }, { status: 404 });
    if (!noteRow) {
      return NextResponse.json({ error: "Fill out at least one EOD field before submitting." }, { status: 400 });
    }

    const hasAny = !!(noteRow.worked_on || noteRow.accomplished || noteRow.plan_tomorrow || noteRow.blockers || noteRow.note);
    if (!hasAny) {
      return NextResponse.json({ error: "Fill out at least one EOD field before submitting." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("eod_notes")
      .update({ submitted_at: now })
      .eq("id", noteRow.id);
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // Compute the recipient set: every leader + admin, plus dept heads
    // of the worker's home depts. De-dupe so a person who's both a
    // leader and a dept head only gets one ping.
    const deptIds = (deptMemberships ?? []).map((r) => r.department_id as string);
    const [{ data: leadership }, { data: deptHeads }] = await Promise.all([
      supabase
        .from("users")
        .select("id, name, email, role, is_admin")
        .or("role.eq.leader,is_admin.eq.true"),
      deptIds.length > 0
        ? supabase
            .from("department_members")
            .select("user_id, users:users(id, name, email, role, is_admin)")
            .in("department_id", deptIds)
        : Promise.resolve({ data: [] })
    ]);

    const recipients = new Map<string, UserSlim>();
    for (const u of (leadership ?? []) as UserSlim[]) {
      if (u.id !== userId) recipients.set(u.id, u);
    }
    for (const row of (deptHeads ?? []) as Array<{ user_id: string; users: UserSlim | UserSlim[] | null }>) {
      const u = Array.isArray(row.users) ? row.users[0] : row.users;
      if (!u) continue;
      if (u.role !== "department_head") continue;
      if (u.id === userId) continue;
      recipients.set(u.id, u);
    }

    // Format the Slack message — the worker's name in the header,
    // each filled field as its own block. Keeps the digest tight even
    // when several fields are filled.
    const quote = (s: string) =>
      s.split("\n").map((line) => `> ${line}`).join("\n");
    const sections: string[] = [];
    if (noteRow.worked_on) sections.push(`*Worked on:*\n${quote(noteRow.worked_on)}`);
    if (noteRow.accomplished) sections.push(`*Accomplished:*\n${quote(noteRow.accomplished)}`);
    if (noteRow.plan_tomorrow) sections.push(`*Plan for tomorrow:*\n${quote(noteRow.plan_tomorrow)}`);
    if (noteRow.blockers) sections.push(`*Blockers / questions:*\n${quote(noteRow.blockers)}`);
    if (sections.length === 0 && noteRow.note) {
      sections.push(`_Notes:_\n${quote(noteRow.note)}`);
    }

    const friendlyDate = new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", {
      weekday: "long", month: "short", day: "numeric", timeZone: "UTC"
    });
    const text = `📝 ${meRow.name ?? "Someone"} submitted their EOD for ${friendlyDate}`;
    const blocks: unknown[] = [
      {
        type: "header",
        text: { type: "plain_text", text: `📝 EOD · ${meRow.name ?? "Someone"} · ${friendlyDate}` }
      }
    ];
    if (sections.length > 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: sections.join("\n\n") }
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "_(No structured content — submission was empty.)_" }
      });
    }

    // Fan out the DMs. Per-recipient failure (no Slack account, lookup
    // miss, scope rejection) is recorded but doesn't fail the whole
    // request — the worker shouldn't see a 500 just because one
    // reviewer hasn't connected Slack yet.
    const deliveries: Array<{ userId: string; name: string | null; delivered: boolean; reason?: string }> = [];
    if (process.env.SLACK_BOT_TOKEN) {
      for (const u of recipients.values()) {
        if (!u.email) {
          deliveries.push({ userId: u.id, name: u.name, delivered: false, reason: "no email on user record" });
          continue;
        }
        try {
          const slackUserId = await lookupUserByEmail(u.email);
          const dmChannel = await openDm(slackUserId);
          await postMessage(dmChannel, text, blocks);
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
      // No bot token configured — mark every intended recipient as a
      // miss so the UI can surface the config gap.
      for (const u of recipients.values()) {
        deliveries.push({ userId: u.id, name: u.name, delivered: false, reason: "SLACK_BOT_TOKEN missing" });
      }
    }

    return NextResponse.json({
      ok: true,
      date: dateStr,
      submittedAt: now,
      recipients: deliveries
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
