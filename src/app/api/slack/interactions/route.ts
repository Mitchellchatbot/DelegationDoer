import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { openView, openDmAsUser, postMessageAsUser } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";
import { buildBriefingBlocks, rewriteEngagementText, type DailyBriefingRow, type BriefingMessage } from "@/lib/daily-briefing-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // crypto needs Node runtime, not Edge

// Slack Interactivity endpoint (api.slack.com/apps → Interactivity &
// Shortcuts → Request URL). Currently handles one action:
//
//   eod_recap_show_more — the "Show full list" button under a truncated
//   client in the Daily Recap (see eod-recap-runner.ts). Re-queries that
//   client + NY date with no PER_LIST cap and opens the full list in a
//   modal. views.open must be called within 3s of the click — trigger_id
//   expires — so everything here stays lean (three Supabase round-trips).
//
// Unlike the Events API, interactivity payloads arrive form-encoded with a
// `payload` field of JSON. Same v0 HMAC signature scheme over the raw body.
// Every handled path returns 200 so Slack doesn't retry.

function verifySignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  // Slack signature spec: v0=HMAC-SHA256(secret, "v0:" + timestamp + ":" + raw_body)
  const sig = crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const expected = `v0=${sig}`;
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

interface BlockAction {
  action_id?: string;
  value?: string;
}
interface InteractionPayload {
  type?: string;
  trigger_id?: string;
  response_url?: string;
  actions?: BlockAction[];
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  // Replay protection — reject anything older than 5 minutes.
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 5) {
    return NextResponse.json({ error: "stale or missing timestamp" }, { status: 401 });
  }

  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "SLACK_SIGNING_SECRET not configured on this deploy" },
      { status: 500 }
    );
  }

  if (!verifySignature(rawBody, timestamp, signature, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: InteractionPayload;
  try {
    const form = new URLSearchParams(rawBody);
    payload = JSON.parse(form.get("payload") ?? "{}") as InteractionPayload;
  } catch {
    // Malformed body — ack anyway; retrying won't make it parseable.
    return NextResponse.json({});
  }

  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || !action?.action_id) {
    return NextResponse.json({});
  }

  // Dispatch by action_id. Each handler is wrapped: a retry from Slack can't
  // help (trigger_ids expire, response_urls are one-shot-ish), so we log + ack.
  try {
    if (action.action_id === "eod_recap_show_more" && payload.trigger_id) {
      const { client, date } = JSON.parse(action.value ?? "{}") as { client?: string; date?: string };
      if (client && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        await openFullListModal(payload.trigger_id, client, date);
      }
    } else if (action.action_id === "daily_brief_send" && payload.response_url) {
      const { b, m } = JSON.parse(action.value ?? "{}") as { b?: string; m?: string };
      if (b && m) await sendBriefingMessage(b, m, payload.response_url);
    } else if (action.action_id === "daily_brief_rewrite" && payload.response_url) {
      const { b, m } = JSON.parse(action.value ?? "{}") as { b?: string; m?: string };
      if (b && m) await rewriteBriefingMessage(b, m, payload.response_url);
    }
  } catch (err) {
    console.error(`[slack/interactions] ${action.action_id} failed:`, err);
  }
  return NextResponse.json({});
}

// Daily-brief "Send" button: send one drafted team check-in AS Mitchell, mark
// it sent in the daily_briefings row, and re-render the DM so that button flips
// to "✅ Sent". Idempotent — a second click on an already-sent message just
// re-renders. Sends via Mitchell's user token (so it lands as a personal DM
// from him); falls back to the bot if no user token is available.
async function sendBriefingMessage(briefId: string, msgId: string, responseUrl: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("daily_briefings")
    .select("id, brief_date, update_text, needle_mover, messages, meta")
    .eq("id", briefId)
    .maybeSingle();
  if (!data) return;

  const row = data as unknown as DailyBriefingRow;
  const messages: BriefingMessage[] = Array.isArray(row.messages) ? row.messages : [];
  const idx = messages.findIndex((x) => x.id === msgId);
  if (idx === -1) return;
  const msg = messages[idx];

  // Already sent → just re-render (covers a double-click / Slack retry).
  if (msg.status !== "sent") {
    try {
      // Always send AS Mitchell (his personal Slack user token) so the teammate
      // gets a genuine founder→you DM. No bot fallback by design — if the token
      // is missing we fail visibly rather than sending from the workspace bot.
      const { data: owner } = await supabase
        .from("users")
        .select("slack_user_token")
        .eq("email", "mitchell@scaledai.org")
        .maybeSingle();
      const userToken =
        (owner?.slack_user_token as string | null) || process.env.SLACK_USER_TOKEN || null;
      if (!userToken) {
        throw new Error("No personal Slack token on file — reconnect Slack to send as yourself.");
      }

      // Resolve the teammate's Slack id. msg.slackId is often null when draft-
      // time resolution got rate-limited, so fall back to their real user row
      // (email + any cached slack fields) — resolveSlackId caches the result
      // back to users.slack_user_id for next time.
      let slackId = msg.slackId;
      if (!slackId) {
        const { data: teammate } = await supabase
          .from("users")
          .select("id, email, slack_user_id, slack_email")
          .eq("id", msg.userId)
          .maybeSingle();
        slackId = await resolveSlackId(
          teammate
            ? { id: teammate.id, email: teammate.email, slack_user_id: teammate.slack_user_id, slack_email: teammate.slack_email }
            : { id: msg.userId }
        );
      }

      const dm = await openDmAsUser(userToken, slackId);
      await postMessageAsUser({ userToken, channel: dm, text: msg.text });
      messages[idx] = { ...msg, status: "sent", sentAt: new Date().toISOString(), error: null };
    } catch (err) {
      messages[idx] = { ...msg, status: "failed", error: err instanceof Error ? err.message.slice(0, 140) : "send failed" };
    }
    await supabase.from("daily_briefings").update({ messages }).eq("id", briefId);
  }

  // Re-render the original DM in place via the interaction's response_url.
  const { blocks, text } = buildBriefingBlocks({ ...row, messages });
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text, blocks })
  }).catch((err) => console.error("[slack/interactions] response_url update failed:", err));
}

// Daily-brief "Rewrite" button: regenerate one pending check-in in a fresh
// phrasing (AI) and re-render the DM so Mitchell can cycle to a version he
// likes before sending. A sent message is left as-is.
async function rewriteBriefingMessage(briefId: string, msgId: string, responseUrl: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("daily_briefings")
    .select("id, brief_date, update_text, needle_mover, messages, meta")
    .eq("id", briefId)
    .maybeSingle();
  if (!data) return;

  const row = data as unknown as DailyBriefingRow;
  const messages: BriefingMessage[] = Array.isArray(row.messages) ? row.messages : [];
  const idx = messages.findIndex((x) => x.id === msgId);
  if (idx === -1) return;
  const msg = messages[idx];
  if (msg.status === "sent") return; // don't rewrite something already sent

  try {
    const fresh = await rewriteEngagementText(msg.name, msg.text);
    messages[idx] = { ...msg, text: fresh };
    await supabase.from("daily_briefings").update({ messages }).eq("id", briefId);
  } catch (err) {
    console.error("[slack/interactions] rewrite failed:", err);
    // fall through and re-render the unchanged message
  }

  const { blocks, text } = buildBriefingBlocks({ ...row, messages });
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replace_original: true, text, blocks })
  }).catch((err) => console.error("[slack/interactions] response_url update failed:", err));
}

// Full, uncapped version of one client's Daily Recap entry, shown in a
// modal. Mirrors the queries + line format of runEodRecap.
async function openFullListModal(triggerId: string, client: string, date: string): Promise<void> {
  const internal = client === "__internal__";
  const supabase = getSupabaseAdmin();

  // "date" is an America/New_York calendar day. Rather than doing TZ-offset
  // arithmetic (EST vs EDT), pull a UTC window that safely covers the whole
  // NY day and narrow with the same NY formatter the recap runner uses.
  const nyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }); // -> YYYY-MM-DD
  const dayStartUtc = new Date(`${date}T00:00:00Z`).getTime();
  const fromIso = new Date(dayStartUtc - 12 * 3_600_000).toISOString();
  const toIso = new Date(dayStartUtc + 36 * 3_600_000).toISOString();

  let taskQuery = supabase
    .from("tasks")
    .select("id, title, client_name, assignee_id, completed_at, is_draft")
    .eq("status", "done")
    .gte("completed_at", fromIso)
    .lte("completed_at", toIso)
    .order("completed_at", { ascending: true })
    .limit(3000);
  taskQuery = internal ? taskQuery.is("client_name", null) : taskQuery.eq("client_name", client);

  const [taskRes, workRes] = await Promise.all([
    taskQuery,
    internal
      ? Promise.resolve({ data: [] })
      : supabase
          .from("eod_client_work")
          .select("client_name, user_id, worked_on, results, created_at")
          .eq("client_name", client)
          .eq("note_date", date)
          .order("created_at", { ascending: true })
          .limit(3000)
  ]);

  interface TaskRow { id: string; title: string; client_name: string | null; assignee_id: string | null; completed_at: string | null; is_draft: boolean | null }
  interface WorkRow { client_name: string; user_id: string; worked_on: string; results: string | null }
  const tasks = ((taskRes.data ?? []) as TaskRow[])
    .filter((t) => !t.is_draft && t.completed_at && nyFmt.format(new Date(t.completed_at)) === date);
  const work = (workRes.data ?? []) as WorkRow[];

  const userIds = Array.from(new Set(
    [...tasks.map((t) => t.assignee_id), ...work.map((w) => w.user_id)]
      .filter((v): v is string => !!v)
  ));
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: us } = await supabase.from("users").select("id, name").in("id", userIds);
    for (const u of (us ?? []) as { id: string; name: string | null }[]) {
      nameById.set(u.id, u.name ?? "Someone");
    }
  }
  const who = (id: string | null) => (id ? (nameById.get(id) ?? "Someone") : "Unassigned");

  const lines: string[] = [];
  if (tasks.length > 0) {
    lines.push(`✅ *Completed (${tasks.length}):*`);
    for (const t of tasks) lines.push(`   • ${t.title}  _— ${who(t.assignee_id)}_`);
  }
  if (work.length > 0) {
    lines.push(`📝 *EOD reports (${work.length}):*`);
    for (const w of work) {
      const res = w.results ? `  (results: ${w.results})` : "";
      lines.push(`   • ${w.worked_on}${res}  _— ${who(w.user_id)}_`);
    }
  }
  if (lines.length === 0) lines.push("_Nothing found for this day._");

  // Sections cap at 3000 chars and a modal at 100 blocks — chunk ~15 lines
  // per section (flushing early near the char cap) and stop at 95 blocks.
  const MAX_MODAL_BLOCKS = 95;
  const LINES_PER_SECTION = 15;
  const SECTION_CHAR_BUDGET = 2800;
  const blocks: unknown[] = [];
  let chunk: string[] = [];
  let chunkChars = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk.join("\n") } });
    chunk = [];
    chunkChars = 0;
  };
  let dropped = 0;
  for (const line of lines) {
    if (blocks.length >= MAX_MODAL_BLOCKS) { dropped++; continue; }
    const l = line.length > 2800 ? line.slice(0, 2797) + "…" : line;
    if (chunk.length >= LINES_PER_SECTION || chunkChars + l.length + 1 > SECTION_CHAR_BUDGET) flush();
    chunk.push(l);
    chunkChars += l.length + 1;
  }
  if (blocks.length < MAX_MODAL_BLOCKS) flush();
  else dropped += chunk.length;
  if (dropped > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_+${dropped} more lines not shown_` }]
    });
  }

  // Modal titles are plain_text capped at 24 chars.
  const rawTitle = internal ? "Internal" : client;
  const title = rawTitle.length > 24 ? rawTitle.slice(0, 23) + "…" : rawTitle;

  await openView(triggerId, {
    type: "modal",
    title: { type: "plain_text", text: title, emoji: true },
    close: { type: "plain_text", text: "Close" },
    blocks
  });
}

// Slack only POSTs here, but a GET makes Railway's health checks happy and
// gives a quick "is this deployed?" smoke test.
export async function GET() {
  return NextResponse.json({ ok: true, route: "slack/interactions" });
}
