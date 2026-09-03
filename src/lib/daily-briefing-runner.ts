// Daily 8 AM founder briefing, DM'd privately to Mitchell.
//
// Every morning at 8am America/New_York this:
//   1. pulls all in-flight work across the team,
//   2. pulls the latest threads from Mitchell's Missive inbox (fail-soft —
//      an expired MISSIVE token just yields an empty inbox section),
//   3. asks Claude (Sonnet) to write, as strict JSON:
//        - a daily update briefing (state of work + what he should note as
//          the owner + inbox items worth his attention),
//        - one "move the needle" action for the day,
//        - five short private check-in messages to specific teammates, in
//          Mitchell's voice, to keep them engaged,
//   4. stores the day's row in `daily_briefings`,
//   5. DMs Mitchell the briefing on Slack with a "Send" button under each of
//      the five messages. NOTHING is sent to a teammate automatically — the
//      button (handled in src/app/api/slack/interactions/route.ts) sends it
//      AS Mitchell only when he taps it.
//
// Idempotency mirrors eod-recap / clients-emailed-push exactly:
//   - target-hour guard: no-op until the current America/New_York hour reaches
//     TARGET_HOUR (delivers at the first tick from then on, once per day).
//   - same-day dedupe: a `daily_briefings` row for today's ET date with
//     delivered_at set means we already ran; skip.
// opts.force bypasses both (for manual /api/cron/daily-briefing?force=1 runs);
// opts.dryRun renders + returns the payload without storing or DMing.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getAllUsersLight } from "@/lib/server-data";
import { listAccounts, listThreads } from "@/lib/missive-client";
import { getAnthropic, resetAnthropic, MODELS } from "@/lib/anthropic-client";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";
import { DEFAULT_TZ, nowInTz, ymdInTz } from "@/lib/shift";
import type { Task, User } from "@/lib/types";

const OWNER_EMAIL = "mitchell@scaledai.org";
const TARGET_HOUR = 8; // 8am America/New_York
const TARGET_MESSAGES = 6; // teammates checked in with per day
// Rotation window: teammates checked in within this many days are deprioritized
// so coverage cycles across the whole team instead of hitting the same people.
const RECENCY_WINDOW_DAYS = 5;

// In-flight = on someone's plate right now (excludes done + rejected).
const IN_FLIGHT: Task["status"][] = ["pending", "in_progress", "urgent", "waiting_on_client"];

export interface BriefingMessage {
  id: string;
  userId: string;
  name: string;
  slackId: string | null;
  text: string;
  status: "pending" | "sent" | "failed";
  sentAt?: string | null;
  error?: string | null;
}

export interface DailyBriefingRow {
  id: string;
  brief_date: string;
  created_at?: string;
  delivered_at?: string | null;
  slack_channel?: string | null;
  slack_ts?: string | null;
  update_text: string;
  needle_mover: string | null;
  messages: BriefingMessage[];
  meta: { activeTasks?: number; inboxThreads?: number; prettyDate?: string };
}

export type DailyBriefingOutcome =
  | { ok: true; skipped: string; nyHour?: number }
  | { ok: true; dryRun: true; row: DailyBriefingRow; blocks: unknown[]; text: string }
  | { ok: true; delivered: true; briefId: string; messages: number; activeTasks: number; inboxThreads: number }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

function prettyDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: DEFAULT_TZ
  });
}

// Compact per-task line for the model. Keeps token cost bounded.
function taskLine(t: Task, nameById: Map<string, string>): string {
  const who = t.assigneeId ? (nameById.get(t.assigneeId) ?? "Someone") : "UNASSIGNED";
  const client = t.clientName ? ` · client: ${t.clientName}` : "";
  const due = t.dueDate ? ` · due ${t.dueDate.slice(0, 10)}` : "";
  const tags = t.tags && t.tags.length ? ` · #${t.tags.slice(0, 4).join(" #")}` : "";
  return `- [${t.status}/${t.priority}] "${t.title}" — ${who}${client}${due}${tags}`;
}

interface InboxItem { from: string; subject: string; snippet: string; at: string }

// Pull the latest open threads from Mitchell's inbox. Fail-soft: any Missive
// error (e.g. an expired MISSIVE_API_TOKEN) returns an empty list plus a note,
// so the briefing still ships from task data alone.
async function pullInbox(limit = 30): Promise<{ items: InboxItem[]; note: string | null }> {
  try {
    const accounts = await listAccounts();
    const acct = accounts.find((a) => (a.email ?? "").toLowerCase() === OWNER_EMAIL);
    if (!acct) return { items: [], note: `No Missive inbox found for ${OWNER_EMAIL}.` };
    const threads = await listThreads({
      mailboxId: acct.id,
      folder: "INBOX",
      status: "open",
      limit
    });
    const items: InboxItem[] = threads
      .slice()
      .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""))
      .slice(0, limit)
      .map((t) => ({
        from: t.last_from ?? (t.participants?.[0] ?? "unknown"),
        subject: t.subject || "(no subject)",
        snippet: (t.last_snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
        at: t.last_message_at ?? ""
      }));
    return { items, note: null };
  } catch (err) {
    return {
      items: [],
      note: `Inbox unavailable (${err instanceof Error ? err.message : "error"}).`
    };
  }
}

// ---------------------------------------------------------------------------
// Claude drafting
// ---------------------------------------------------------------------------

interface DraftedContent {
  daily_update: string;
  needle_mover: string;
  engagement_messages: { userId: string; text: string }[];
}

function buildPrompts(args: {
  tasks: Task[];
  roster: User[];
  inbox: InboxItem[];
  inboxNote: string | null;
  nameById: Map<string, string>;
  // Teammates checked in with recently (name + how many days ago), so the model
  // rotates coverage instead of messaging the same people every day.
  recentlyMessaged: { name: string; daysAgo: number }[];
}): { system: string; user: string } {
  const { tasks, roster, inbox, inboxNote, nameById, recentlyMessaged } = args;

  // Teammates Mitchell can be prompted to check in on: everyone but him and
  // other leaders (the engagement DMs are founder→team).
  const teammates = roster.filter(
    (u) => u.role !== "leader" && (u.email ?? "").toLowerCase() !== OWNER_EMAIL
  );

  const rosterBlock = teammates
    .map((u) => `- ${u.name} (id: ${u.id}, role: ${u.role})`)
    .join("\n") || "(no teammates found)";

  // Group work by assignee so the model can see who's overloaded / stalled.
  const byAssignee = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.assigneeId ?? "__unassigned__";
    const arr = byAssignee.get(key) ?? [];
    arr.push(t);
    byAssignee.set(key, arr);
  }
  const workBlock = Array.from(byAssignee.entries())
    .map(([uid, ts]) => {
      const header = uid === "__unassigned__" ? "UNASSIGNED" : (nameById.get(uid) ?? uid);
      return `### ${header} (${ts.length})\n${ts.map((t) => taskLine(t, nameById)).join("\n")}`;
    })
    .join("\n\n") || "(no active tasks)";

  const inboxBlock = inbox.length
    ? inbox.map((m) => `- from ${m.from} — "${m.subject}" — ${m.snippet}`).join("\n")
    : (inboxNote ?? "(inbox empty)");

  const system = [
    "You are the chief of staff to Mitchell, founder of Scaled AI (a digital agency).",
    "Write his private morning daily brief. You have the full team's in-flight work and the latest threads in Mitchell's email inbox.",
    "",
    "Return STRICT JSON only (no code fences, no prose around it) with exactly this shape:",
    "{",
    '  "daily_update": string,        // a REPORT, written in clear labeled sections with short line breaks. Use these section headers, each on its own line, in this order (skip a section only if there is genuinely nothing for it): "SNAPSHOT:" (1-2 line headline of the day, e.g. counts + the single biggest thing), "NEEDS YOUR CALL:" (decisions/items only the owner can resolve, as bullet lines starting with "- "), "AT RISK:" (overdue/blocked/overloaded, bullet lines), "MOMENTUM:" (what is going well or just shipped, bullet lines), "INBOX:" (email items needing his attention, or a one-line note if unavailable). Reference real task titles, people, and clients. Be specific, skimmable, and honest.',
    `  "needle_mover": string,        // ONE specific, high-leverage action he can take today that moves the business forward. Concrete, not generic.`,
    `  "engagement_messages": [       // EXACTLY ${TARGET_MESSAGES} items, each to a DIFFERENT teammate`,
    '    { "userId": string,          // must be one of the teammate ids listed below',
    '      "text": string }           // a SHORT, casual Slack DM FROM Mitchell TO that teammate, like a quick personal text. Keep it SIMPLE and low-key: plain everyday words, one or two short sentences max. A quick "Hey <name>" opener, maybe mention what they are working on in passing, then ask how it is going or if they need anything. Do NOT gush, flatter, over-praise, or use motivational-speaker or corporate language. Sound like a normal person who cares, not a hype coach. Vary them so they do not all read the same. No emojis unless it is genuinely natural.',
    "  ]",
    "}",
    "",
    "Rules:",
    `- Pick ${TARGET_MESSAGES} teammates to check in on. ROTATE COVERAGE: strongly prefer teammates NOT in the "recently checked in" list below, so over a week everyone hears from Mitchell. Only repeat someone from that list if they genuinely need it today (blocked, overloaded, or a big win). All ${TARGET_MESSAGES} userIds must be distinct and from the roster.`,
    "- The check-ins are about people, not tasks: keep them relaxed and supportive even for someone who is behind (offer help, do not scold). Simple and genuine beats enthusiastic.",
    "- Never invent tasks, clients, or facts not present in the data.",
    "- Plain text only. Do not use em-dashes; use commas or periods.",
    "- These are DRAFTS Mitchell approves before anything sends. Write them ready-to-send."
  ].join("\n");

  const recentBlock = recentlyMessaged.length
    ? recentlyMessaged
        .sort((a, b) => a.daysAgo - b.daysAgo)
        .map((r) => `- ${r.name} (${r.daysAgo === 0 ? "today" : r.daysAgo === 1 ? "yesterday" : `${r.daysAgo} days ago`})`)
        .join("\n")
    : "(no one checked in with recently — you can pick anyone)";

  const user = [
    `Date: ${prettyDate()} (America/New_York).`,
    "",
    "## Teammates (choose engagement_messages recipients from these ids)",
    rosterBlock,
    "",
    `## Recently checked in — AVOID these unless they genuinely need it today (rotate to others)`,
    recentBlock,
    "",
    `## Active work across the team (${tasks.length} in-flight tasks)`,
    workBlock,
    "",
    "## Mitchell's inbox — latest threads",
    inboxBlock
  ].join("\n");

  return { system, user };
}

async function draftContent(prompts: { system: string; user: string }): Promise<DraftedContent> {
  async function call() {
    const client = await getAnthropic();
    return client.messages.create({
      model: MODELS.chat,
      max_tokens: 3400,
      temperature: 0.6,
      system: prompts.system,
      messages: [{ role: "user", content: prompts.user }]
    });
  }

  let res;
  try {
    res = await call();
  } catch (err) {
    if ((err as { status?: number })?.status === 401) {
      resetAnthropic();
      res = await call();
    } else {
      throw err;
    }
  }

  const raw = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const jsonStr = raw.startsWith("{") ? raw : (raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  const parsed = JSON.parse(jsonStr) as Partial<DraftedContent>;

  return {
    daily_update: typeof parsed.daily_update === "string" ? parsed.daily_update.trim() : "",
    needle_mover: typeof parsed.needle_mover === "string" ? parsed.needle_mover.trim() : "",
    engagement_messages: Array.isArray(parsed.engagement_messages) ? parsed.engagement_messages : []
  };
}

// ---------------------------------------------------------------------------
// Slack blocks (shared with the interactions handler so re-renders match)
// ---------------------------------------------------------------------------

function chunk(text: string, size = 2900): string[] {
  if (!text) return [];
  const out: string[] = [];
  const paras = text.split(/\n{2,}/);
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > size) {
      if (cur) out.push(cur);
      cur = p.length > size ? p.slice(0, size) : p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

export function buildBriefingBlocks(row: DailyBriefingRow): { blocks: unknown[]; text: string } {
  const date = row.meta?.prettyDate ?? row.brief_date;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `☀️ Daily Brief — ${date}`.slice(0, 150), emoji: true } },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `${row.meta?.activeTasks ?? 0} active tasks · ${row.meta?.inboxThreads ?? 0} inbox threads · private to you`
      }]
    },
    { type: "divider" }
  ];

  for (const part of chunk(row.update_text)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: part } });
  }

  if (row.needle_mover) {
    blocks.push(
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `🎯 *Move the needle today*\n${row.needle_mover}`.slice(0, 2990) } }
    );
  }

  if (row.messages.length > 0) {
    blocks.push(
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "✉️ *Team check-ins* — review each and tap Send. Nothing goes out until you do." } }
    );
    for (const m of row.messages) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*To ${m.name}:*\n>${m.text.replace(/\n/g, "\n>")}`.slice(0, 2990) }
      });
      if (m.status === "sent") {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `✅ Sent to ${m.name}${m.sentAt ? ` at ${new Date(m.sentAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: DEFAULT_TZ })}` : ""}` }]
        });
      } else if (m.status === "failed") {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `⚠️ Couldn't send to ${m.name}${m.error ? `: ${m.error}` : ""}. Send manually.` }]
        });
      } else {
        blocks.push({
          type: "actions",
          elements: [{
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: `Send to ${firstName(m.name)}`, emoji: true },
            action_id: "daily_brief_send",
            value: JSON.stringify({ b: row.id, m: m.id })
          }]
        });
      }
    }
  }

  const text = `Your daily brief — ${date}`;
  return { blocks: blocks.slice(0, 50), text };
}

// Whole-day difference between two YYYY-MM-DD strings (a is the later date).
function dayDiff(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.max(0, Math.round((da - db) / 86_400_000));
}

// Who Mitchell has already checked in with in the last RECENCY_WINDOW_DAYS, so
// the model rotates to fresh teammates. Reads past daily_briefings rows.
async function gatherRecentlyMessaged(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  todayYmd: string,
  nameById: Map<string, string>
): Promise<{ name: string; daysAgo: number }[]> {
  const since = ymdInTz(new Date(Date.now() - RECENCY_WINDOW_DAYS * 86_400_000), DEFAULT_TZ);
  const { data } = await supabase
    .from("daily_briefings")
    .select("brief_date, messages")
    .gte("brief_date", since)
    .neq("id", `brief_${todayYmd}`); // ignore today's own row on a re-run

  const lastByUser = new Map<string, string>(); // userId -> most recent brief_date
  for (const row of (data ?? []) as { brief_date: string; messages: unknown }[]) {
    const bd = row.brief_date;
    const msgs = Array.isArray(row.messages) ? row.messages : [];
    for (const m of msgs as { userId?: string }[]) {
      if (!m?.userId) continue;
      const prev = lastByUser.get(m.userId);
      if (!prev || bd > prev) lastByUser.set(m.userId, bd);
    }
  }

  const out: { name: string; daysAgo: number }[] = [];
  for (const [uid, bd] of lastByUser) {
    const name = nameById.get(uid);
    if (name) out.push({ name, daysAgo: dayDiff(todayYmd, bd) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runDailyBriefing(
  opts: { force?: boolean; dryRun?: boolean } = {}
): Promise<DailyBriefingOutcome> {
  const now = nowInTz(DEFAULT_TZ);
  // Deliver at the FIRST tick from the target hour onward (not only exactly at
  // it), so a missed/late tick or a deploy restart during the target hour
  // doesn't skip the whole day. The same-day dedupe below guarantees one send.
  // Skip only when it's still before the target hour that day.
  if (!opts.force && now.hh < TARGET_HOUR) {
    return { ok: true, skipped: "before-target-hour", nyHour: now.hh };
  }

  const briefId = `brief_${now.ymd}`;
  const supabase = getSupabaseAdmin();

  // Same-day dedupe: a delivered row for today means we already ran.
  if (!opts.force && !opts.dryRun) {
    const { data: existing } = await supabase
      .from("daily_briefings")
      .select("id, delivered_at")
      .eq("id", briefId)
      .maybeSingle();
    if (existing?.delivered_at) return { ok: true, skipped: "already-sent-today" };
  }

  if (!opts.dryRun && !process.env.SLACK_BOT_TOKEN) {
    return { ok: false, reason: "SLACK_BOT_TOKEN missing" };
  }

  // Gather in parallel.
  const [allTasks, roster, inbox] = await Promise.all([
    getAllTasks(),
    getAllUsersLight(),
    pullInbox()
  ]);
  const tasks = allTasks.filter((t) => IN_FLIGHT.includes(t.status));
  const nameById = new Map(roster.map((u) => [u.id, u.name]));

  // Cached Slack fields for the roster (getAllUsersLight omits them). Using the
  // cached slack_user_id lets resolveSlackId return instantly without a rate-
  // limited users.lookupByEmail call per teammate.
  const { data: slackRows } = await supabase
    .from("users")
    .select("id, slack_user_id, slack_email");
  const slackById = new Map(
    (slackRows ?? []).map((r) => [
      r.id as string,
      { slack_user_id: (r.slack_user_id as string | null) ?? null, slack_email: (r.slack_email as string | null) ?? null }
    ])
  );

  const recentlyMessaged = await gatherRecentlyMessaged(supabase, now.ymd, nameById);
  const prompts = buildPrompts({
    tasks, roster, inbox: inbox.items, inboxNote: inbox.note, nameById, recentlyMessaged
  });

  let drafted: DraftedContent;
  try {
    drafted = await draftContent(prompts);
  } catch (err) {
    return { ok: false, reason: `AI drafting failed: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!drafted.daily_update) {
    return { ok: false, reason: "AI returned an empty briefing" };
  }

  // Validate + resolve engagement messages against the real roster. Keep the
  // first message per distinct, non-leader teammate; cap at TARGET_MESSAGES.
  const userById = new Map(roster.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const messages: BriefingMessage[] = [];
  for (const em of drafted.engagement_messages) {
    if (messages.length >= TARGET_MESSAGES) break;
    const u = userById.get(em.userId);
    if (!u || u.role === "leader") continue;
    if ((u.email ?? "").toLowerCase() === OWNER_EMAIL) continue;
    if (seen.has(u.id)) continue;
    const text = typeof em.text === "string" ? em.text.trim() : "";
    if (!text) continue;
    seen.add(u.id);
    const cached = slackById.get(u.id);
    let slackId: string | null = null;
    try {
      slackId = await resolveSlackId({
        id: u.id,
        email: u.email,
        slack_user_id: cached?.slack_user_id ?? null,
        slack_email: cached?.slack_email ?? null
      });
    } catch { /* resolve again at send time */ }
    messages.push({
      id: `m${messages.length + 1}`,
      userId: u.id,
      name: u.name,
      slackId,
      text,
      status: "pending"
    });
  }

  const row: DailyBriefingRow = {
    id: briefId,
    brief_date: now.ymd,
    update_text: drafted.daily_update,
    needle_mover: drafted.needle_mover || null,
    messages,
    meta: { activeTasks: tasks.length, inboxThreads: inbox.items.length, prettyDate: prettyDate() }
  };

  const { blocks, text } = buildBriefingBlocks(row);

  if (opts.dryRun) {
    return { ok: true, dryRun: true, row, blocks, text };
  }

  // Persist BEFORE posting so the Send buttons' {b,m} references resolve the
  // moment the DM lands.
  const { error: upsertErr } = await supabase.from("daily_briefings").upsert({
    id: row.id,
    brief_date: row.brief_date,
    update_text: row.update_text,
    needle_mover: row.needle_mover,
    messages: row.messages,
    meta: row.meta
  });
  if (upsertErr) {
    return { ok: false, reason: `DB upsert failed: ${upsertErr.message}` };
  }

  // Deliver to Mitchell's Slack DM.
  let slackTs: string | null = null;
  let dmChannel: string | null = null;
  try {
    const slackUserId = await resolveSlackId({ email: OWNER_EMAIL });
    dmChannel = await openDm(slackUserId);
    const posted = await postMessage(dmChannel, text, blocks);
    slackTs = posted.ts;
  } catch (err) {
    return { ok: false, reason: `Slack delivery failed: ${err instanceof Error ? err.message : "unknown"}` };
  }

  // Stamp delivered only after a successful post, so a failed post retries on
  // the next tick.
  await supabase
    .from("daily_briefings")
    .update({ delivered_at: new Date().toISOString(), slack_channel: dmChannel, slack_ts: slackTs })
    .eq("id", row.id);

  return {
    ok: true,
    delivered: true,
    briefId: row.id,
    messages: messages.length,
    activeTasks: tasks.length,
    inboxThreads: inbox.items.length
  };
}
