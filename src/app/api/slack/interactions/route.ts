import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { openView } from "@/lib/slack";

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
  if (
    payload.type !== "block_actions" ||
    action?.action_id !== "eod_recap_show_more" ||
    !payload.trigger_id
  ) {
    return NextResponse.json({});
  }

  try {
    const { client, date } = JSON.parse(action.value ?? "{}") as { client?: string; date?: string };
    if (client && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await openFullListModal(payload.trigger_id, client, date);
    }
  } catch (err) {
    // Log and ack: a retry from Slack couldn't help (the trigger_id is
    // already spent/expired by the time it retried anyway).
    console.error("[slack/interactions] eod_recap_show_more failed:", err);
  }
  return NextResponse.json({});
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
