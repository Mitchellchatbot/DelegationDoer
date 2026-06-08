import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";
import { buildEodDigestsForUser } from "@/lib/eod-digest";

export const dynamic = "force-dynamic";

// POST /api/eod/submit
//   body: { date?: "YYYY-MM-DD" }
//   Marks the caller's EOD note for the given date as submitted (server
//   timestamp), then fans out a Slack DM to every leadership user + the
//   dept head(s) for each department the caller belongs to.
//
//   Routing model (per Mitchell's "Reports To" directive):
//     - DM the author's manager_user_id (their direct line manager)
//     - Also DM secondary_manager_user_id when set (dual-report)
//     - Always DM every leader (Mitch sees everything)
//     - Author themselves is excluded — never DM yourself.
//   So when Mujtaba (dept head) submits his EOD, only his manager
//   (Mitch) gets it. When a worker submits, their direct lead gets
//   it AND Mitch. Stealth admins are NOT auto-included anymore —
//   admin status is orthogonal to who reviews EOD content.

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

    const body = await req.json().catch(() => ({}));
    const dateStr =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date().toISOString().slice(0, 10);

    // Fields can be passed in-line so the typeform doesn't depend on
    // autosave landing first — if the user clicks Submit before the
    // PUT /api/eod/notes round-trip finishes (or it errored on a
    // missing column), we still capture their answers from the body.
    const STRING_OR_EMPTY = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const t = v.trim();
      return t.length > 0 ? t : null;
    };
    const inlineFields = {
      worked_on:         STRING_OR_EMPTY(body.workedOn),
      accomplished:      STRING_OR_EMPTY(body.accomplished),
      plan_tomorrow:     STRING_OR_EMPTY(body.planTomorrow),
      blockers:          STRING_OR_EMPTY(body.blockers),
      leads_messaged:    STRING_OR_EMPTY(body.leadsMessaged),
      linkedin_comments: STRING_OR_EMPTY(body.linkedinComments)
    };
    const hasInline = Object.values(inlineFields).some((v) => v !== null);

    // Fetch the worker, their EOD row, and their reporting line in
    // parallel. Reporting line = manager_user_id + secondary_manager_user_id;
    // those become the primary EOD recipients alongside every leader.
    const [{ data: meRow }, noteRes] = await Promise.all([
      supabase
        .from("users")
        .select("id, name, email, role, is_admin, manager_user_id, secondary_manager_user_id")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("eod_notes")
        .select("id, worked_on, accomplished, plan_tomorrow, blockers, leads_messaged, linkedin_comments, note, submitted_at")
        .eq("user_id", userId)
        .eq("note_date", dateStr)
        .maybeSingle()
    ]);

    if (!meRow) return NextResponse.json({ error: "user not found" }, { status: 404 });
    if (noteRes.error) {
      // Surface the actual DB error — most commonly the structured
      // columns don't exist yet (migration 20260601 not applied).
      return NextResponse.json({
        error: `EOD lookup failed: ${noteRes.error.message}. Apply the 20260601 migration if you haven't yet.`
      }, { status: 500 });
    }

    const now = new Date().toISOString();
    let noteRow = noteRes.data;

    // No row yet OR inline payload differs from DB — upsert before
    // checking hasAny so the submit captures the user's latest state.
    if (!noteRow || hasInline) {
      const id = noteRow?.id ?? `eod_${userId}_${dateStr}`;
      const upsertRow: Record<string, unknown> = {
        id,
        user_id: userId,
        note_date: dateStr,
        updated_at: now,
        submitted_at: now
      };
      // Only overwrite columns the caller actually sent so a partial
      // body doesn't blow away other autosaved fields.
      for (const k of ["worked_on", "accomplished", "plan_tomorrow", "blockers", "leads_messaged", "linkedin_comments"] as const) {
        if (inlineFields[k] !== null) upsertRow[k] = inlineFields[k];
      }
      const { data: upserted, error: upsertErr } = await supabase
        .from("eod_notes")
        .upsert(upsertRow, { onConflict: "user_id,note_date" })
        .select("id, worked_on, accomplished, plan_tomorrow, blockers, leads_messaged, linkedin_comments, note, submitted_at")
        .maybeSingle();
      if (upsertErr) {
        return NextResponse.json({
          error: `Couldn't save EOD: ${upsertErr.message}. Apply the 20260601 migration if you haven't yet.`
        }, { status: 500 });
      }
      noteRow = upserted ?? null;
    } else {
      // Existing row but no inline payload — just flip submitted_at.
      const { error: updateErr } = await supabase
        .from("eod_notes")
        .update({ submitted_at: now })
        .eq("id", noteRow.id);
      if (updateErr) {
        return NextResponse.json({ error: updateErr.message }, { status: 500 });
      }
    }

    if (!noteRow) {
      return NextResponse.json({ error: "EOD row missing after upsert (unexpected)" }, { status: 500 });
    }

    const noteRowExt = noteRow as typeof noteRow & {
      leads_messaged: string | null;
      linkedin_comments: string | null;
    };
    const hasAny = !!(
      noteRow.worked_on
      || noteRow.accomplished
      || noteRow.plan_tomorrow
      || noteRow.blockers
      || noteRowExt.leads_messaged
      || noteRowExt.linkedin_comments
      || noteRow.note
    );
    if (!hasAny) {
      return NextResponse.json({ error: "Fill out at least one EOD field before submitting." }, { status: 400 });
    }

    // Build recipient set from the reporting line (primary +
    // secondary manager) and every leader. Author always excluded.
    const managerIds: string[] = [];
    const primaryMgr = (meRow as { manager_user_id?: string | null }).manager_user_id ?? null;
    const secondaryMgr = (meRow as { secondary_manager_user_id?: string | null }).secondary_manager_user_id ?? null;
    if (primaryMgr) managerIds.push(primaryMgr);
    if (secondaryMgr && secondaryMgr !== primaryMgr) managerIds.push(secondaryMgr);

    const recipients = new Map<string, UserSlim>();

    // Direct managers.
    if (managerIds.length > 0) {
      const { data: managers } = await supabase
        .from("users")
        .select("id, name, email, slack_email, slack_user_id, role, is_admin")
        .in("id", managerIds);
      for (const u of (managers ?? []) as UserSlim[]) {
        if (u.id !== userId) recipients.set(u.id, u);
      }
    }

    // Every leader — Mitch always sees, even if he's not the worker's
    // direct manager. Drops admin auto-inclusion (was confusing for
    // stealth admins who didn't expect to be in the loop).
    const { data: leaders } = await supabase
      .from("users")
      .select("id, name, email, slack_email, slack_user_id, role, is_admin")
      .eq("role", "leader");
    for (const u of (leaders ?? []) as UserSlim[]) {
      if (u.id !== userId) recipients.set(u.id, u);
    }

    // Format the Slack message — the worker's name in the header,
    // each filled field as its own block. Keeps the digest tight even
    // when several fields are filled.
    const quote = (s: string) =>
      s.split("\n").map((line) => `> ${line}`).join("\n");
    const sections: string[] = [];
    if (noteRow.worked_on) sections.push(`*Worked on:*\n${quote(noteRow.worked_on)}`);
    if (noteRow.accomplished) sections.push(`*Accomplished:*\n${quote(noteRow.accomplished)}`);
    if (noteRowExt.leads_messaged) sections.push(`*Leads messaged:*\n${quote(noteRowExt.leads_messaged)}`);
    if (noteRowExt.linkedin_comments) sections.push(`*LinkedIn comments:*\n${quote(noteRowExt.linkedin_comments)}`);
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
        try {
          const slackUserId = await resolveSlackId({
            id: u.id,
            email: u.email,
            slack_email: u.slack_email,
            slack_user_id: u.slack_user_id
          });
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

    // Fire the per-client digest builder in the background. For every
    // client the caller did work for today, we update or create a
    // pending eod_digest draft in the approvals queue. Approver
    // edits / sends the email; the approve route stamps each linked
    // task's reported_to_client_at so future digests skip them.
    // Fire-and-forget so the EOD submit response stays snappy — the
    // Anthropic call inside can take a few seconds.
    void buildEodDigestsForUser(userId, dateStr)
      .then((r) => {
        if (r.clientsTouched > 0 || r.errors.length > 0) {
          console.log("[eod-submit] digest build", r);
        }
      })
      .catch((err) => {
        console.error("[eod-submit] digest build failed", err);
      });

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
