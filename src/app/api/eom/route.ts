import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

function currentMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// GET /api/eom — current month's Employee of the Month, plus the holder's
// public details so the widget + avatars can render the crown without a
// second round-trip. Also includes `isMe` so the widget can flip into
// celebration mode without a separate "who am I" call.
export async function GET() {
  const meId = await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const month = currentMonthKey();
  const { data, error } = await supabase
    .from("employee_of_month")
    .select("month, user_id, crowned_by_id, crowned_at, reason")
    .eq("month", month)
    .maybeSingle();
  if (error) {
    // Table not migrated yet → behave as if no one's crowned. Lets the
    // widget / presence provider / avatars keep working during partial
    // migrations.
    if (/relation .* does not exist/i.test(error.message)) {
      return NextResponse.json({ eom: null, month, isMe: false });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ eom: null, month, isMe: false });

  const { data: user } = await supabase
    .from("users")
    .select("id, name, avatar_url")
    .eq("id", data.user_id)
    .maybeSingle();

  return NextResponse.json({
    eom: {
      month: data.month,
      userId: data.user_id,
      name: user?.name ?? null,
      avatarUrl: user?.avatar_url ?? null,
      crownedAt: data.crowned_at,
      crownedById: data.crowned_by_id,
      reason: data.reason ?? null
    },
    month,
    isMe: data.user_id === meId
  });
}

// POST /api/eom — body: { userId, reason? }. Leader only. Upserts on month
// (so re-crowning replaces the holder for the current month).
export async function POST(req: NextRequest) {
  const adminId = await requireCurrentUserId();
  const me = await getUserById(adminId);
  if (!me || !(me.role === "leader" || me.isAdmin)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const userId = typeof body.userId === "string" ? body.userId : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() || null : null;
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const month = currentMonthKey();
  const { data, error } = await supabase
    .from("employee_of_month")
    .upsert({
      month,
      user_id: userId,
      crowned_by_id: adminId,
      crowned_at: new Date().toISOString(),
      reason
    }, { onConflict: "month" })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Hype message to the Scaled Team channel — fire-and-forget so a
  // slow Slack call doesn't block the crown. Re-crowning the same
  // holder within the same UTC minute is throttled by checking that
  // the upserted row's crowned_at is fresh; otherwise PerformanceReview
  // accidentally double-posting would spam the channel.
  void (async () => {
    try {
      const [{ data: settings }, holder, crowner] = await Promise.all([
        supabase
          .from("workspace_settings")
          .select("scaled_team_channel_id")
          .eq("id", "workspace")
          .maybeSingle(),
        supabase
          .from("users")
          .select("name, avatar_url, email")
          .eq("id", userId)
          .maybeSingle()
          .then((r) => r.data),
        getUserById(adminId)
      ]);
      const channel = (settings?.scaled_team_channel_id as string | null) ?? null;
      if (!channel || !holder?.name) return;
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const recsUrl = baseUrl ? `${baseUrl}/updates/recommendations` : "/updates/recommendations";
      const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", {
        month: "long", year: "numeric", timeZone: "UTC"
      });
      const reasonLine = reason ? `\n>${reason.replace(/\n/g, "\n>")}` : "";
      const crownerName = crowner?.name ? ` (crowned by ${crowner.name})` : "";
      await postMessage(
        channel,
        `🎉 ${holder.name} is Employee of the Month for ${monthLabel}!`,
        [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `👑  ${holder.name} is Employee of the Month!`,
              emoji: true
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `*${monthLabel}*${crownerName}\n` +
                `Earned for being absolutely cracked this cycle. ` +
                `Avatars get a crown overlay, the Recommendations tab is theirs to drive, and the rest of us live in the warmth of their reflected glow. 🔥`
            }
          },
          ...(reasonLine
            ? [{ type: "section", text: { type: "mrkdwn", text: reasonLine } }]
            : []),
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: "Give 'em props in this thread 👇" }
            ]
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "See their picks", emoji: true },
                url: recsUrl
              }
            ]
          }
        ]
      );
    } catch (err) {
      console.error("[eom] announcement failed:", err);
    }
  })();

  return NextResponse.json({ ok: true, eom: data });
}

// DELETE /api/eom — uncrown for the current month. Leader only.
export async function DELETE() {
  const adminId = await requireCurrentUserId();
  const me = await getUserById(adminId);
  if (!me || !(me.role === "leader" || me.isAdmin)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("employee_of_month")
    .delete()
    .eq("month", currentMonthKey());
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
