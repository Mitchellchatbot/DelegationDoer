// Shared runner for the 7pm America/New_York daily recap so the
// /api/cron/eod-recap route AND the in-process scheduler (cron-bootstrap)
// drive identical logic.
//
// Two layers of idempotency keep this safe to run at any cadence (Vercel
// fires it at 23:00 + 00:00 UTC to straddle DST; the in-process loop ticks
// hourly):
//   1. NY-hour guard — does nothing unless the *current* America/New_York
//      hour is 19, so any off-window tick just no-ops.
//   2. last_eod_recap_at — if a recap already posted in the same UTC day we
//      skip, so two ticks inside the 7pm hour can't double-post.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { postMessage } from "@/lib/slack";

// Discriminated outcome so the route can echo the same JSON it always has
// and the scheduler can log a one-line summary. A hard failure (Slack post,
// etc.) is thrown — the route maps that to a 500, matching prior behaviour.
export type EodRecapOutcome =
  | { ok: true; skipped: string; nyHour?: number }
  | { ok: true; posted: number }
  | { ok: false; reason: string };

export async function runEodRecap(): Promise<EodRecapOutcome> {
  // DST guard: the handler refuses to do anything unless the current NY hour
  // is 19, so a wrong-side fire just no-ops.
  const nyHour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "America/New_York"
    }).format(new Date())
  );
  if (nyHour !== 19) {
    return { ok: true, skipped: "not-7pm-ny", nyHour };
  }

  const supabase = getSupabaseAdmin();
  const { data: settings } = await supabase
    .from("workspace_settings")
    .select("scaled_team_channel_id, eod_recap_channel_id, last_eod_recap_at")
    .eq("id", "workspace")
    .maybeSingle();
  const recapChannel =
    (settings?.eod_recap_channel_id as string | null) ||
    (settings?.scaled_team_channel_id as string | null);
  if (!recapChannel) {
    return { ok: false, reason: "no recap channel configured" };
  }

  // De-dupe: if the last successful recap landed in the same UTC day, bail.
  const last = settings?.last_eod_recap_at as string | null;
  if (last) {
    const lastDay = new Date(last).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (lastDay === today) {
      return { ok: true, skipped: "already-sent-today" };
    }
  }

  // ---- Client-based recap ----
  // For each client worked on today: the tasks completed (attributed to
  // whoever closed them) + the EOD client-work reports (attributed to who
  // logged them). "Today" is the America/New_York calendar day, since the
  // recap fires at 7pm NY and EOD work is filed against the worker's local
  // date.
  const now = new Date();
  const nyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }); // -> YYYY-MM-DD
  const nyDateStr = nyFmt.format(now);
  // Wide completed_at lower bound (30h), then narrowed to NY-today below so
  // we don't depend on TZ-midnight arithmetic.
  const sinceIso = new Date(now.getTime() - 30 * 3_600_000).toISOString();

  const [taskRes, workRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, client_name, assignee_id, completed_at, is_draft")
      .eq("status", "done")
      .gte("completed_at", sinceIso)
      .order("completed_at", { ascending: true })
      .limit(3000),
    supabase
      .from("eod_client_work")
      .select("client_name, user_id, worked_on, results, created_at")
      .eq("note_date", nyDateStr)
      .order("created_at", { ascending: true })
      .limit(3000)
  ]);

  interface TaskRow { id: string; title: string; client_name: string | null; assignee_id: string | null; completed_at: string | null; is_draft: boolean | null }
  interface WorkRow { client_name: string; user_id: string; worked_on: string; results: string | null }
  const tasks = ((taskRes.data ?? []) as TaskRow[])
    .filter((t) => !t.is_draft && t.completed_at && nyFmt.format(new Date(t.completed_at)) === nyDateStr);
  const work = (workRes.data ?? []) as WorkRow[];

  if (tasks.length === 0 && work.length === 0) {
    // Quiet day — don't post an empty recap. Leave last_eod_recap_at
    // untouched so we re-check on the next tick within the 7pm hour.
    return { ok: true, skipped: "no-client-activity" };
  }

  // Resolve contributor names (assignees + EOD authors) in one round-trip.
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

  // Group by client. Tasks with no client_name fall into a trailing
  // "Internal" bucket so output isn't lost.
  const tasksByClient = new Map<string, TaskRow[]>();
  const internalTasks: TaskRow[] = [];
  for (const t of tasks) {
    if (t.client_name) {
      const arr = tasksByClient.get(t.client_name) ?? []; arr.push(t); tasksByClient.set(t.client_name, arr);
    } else internalTasks.push(t);
  }
  const workByClient = new Map<string, WorkRow[]>();
  for (const w of work) {
    const arr = workByClient.get(w.client_name) ?? []; arr.push(w); workByClient.set(w.client_name, arr);
  }
  const clientNames = Array.from(new Set([...tasksByClient.keys(), ...workByClient.keys()]))
    .sort((a, b) => a.localeCompare(b));

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York"
  });
  const headerBlocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `📒 Daily Recap · ${today}`, emoji: true } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "*7pm EST roll-up* — today's work by client, with who did what." }]
    },
    { type: "divider" }
  ];

  // Slack caps section text at 3000 chars and a message at 50 blocks; one
  // section per client keeps it readable, with per-section + per-list caps
  // as a backstop on a very busy day.
  const clamp = (s: string) => (s.length > 2990 ? s.slice(0, 2987) + "…" : s);
  const MAX_CLIENTS = 40;
  const PER_LIST = 15;
  // Slack rejects the whole message past 50 blocks, so the "Show full list"
  // buttons below only get appended while there's room (the "+N more" text
  // in the section remains as the fallback when there isn't).
  const MAX_BLOCKS = 50;
  const clientBlocks: unknown[] = [];
  const summaryLines: string[] = [];

  // "Show full list" button for a client whose lists got truncated. Handled
  // by /api/slack/interactions (action_id eod_recap_show_more), which
  // re-queries this client + date without the PER_LIST cap and opens a modal.
  const showMoreBlock = (client: string) => ({
    type: "actions",
    block_id: `eod_more_${client}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Show full list", emoji: true },
        action_id: "eod_recap_show_more",
        value: JSON.stringify({ client, date: nyDateStr })
      }
    ]
  });

  for (const name of clientNames.slice(0, MAX_CLIENTS)) {
    const ts = tasksByClient.get(name) ?? [];
    const ws = workByClient.get(name) ?? [];
    const lines: string[] = [`*${name}*`];
    if (ts.length > 0) {
      lines.push("✅ *Completed:*");
      for (const t of ts.slice(0, PER_LIST)) lines.push(`   • ${t.title}  _— ${who(t.assignee_id)}_`);
      if (ts.length > PER_LIST) lines.push(`   • _+${ts.length - PER_LIST} more_`);
    }
    if (ws.length > 0) {
      lines.push("📝 *EOD reports:*");
      for (const w of ws.slice(0, PER_LIST)) {
        const res = w.results ? `  (results: ${w.results})` : "";
        lines.push(`   • ${w.worked_on}${res}  _— ${who(w.user_id)}_`);
      }
      if (ws.length > PER_LIST) lines.push(`   • _+${ws.length - PER_LIST} more_`);
    }
    clientBlocks.push({ type: "section", text: { type: "mrkdwn", text: clamp(lines.join("\n")) } });
    const truncated = ts.length > PER_LIST || ws.length > PER_LIST;
    // Reserve 4 blocks: the "+N more clients" context plus the internal
    // bucket's divider + section + button.
    if (truncated && headerBlocks.length + clientBlocks.length < MAX_BLOCKS - 4) {
      clientBlocks.push(showMoreBlock(name));
    }
    summaryLines.push(`${name}: ${ts.length}✅ ${ws.length}📝`);
  }
  if (clientNames.length > MAX_CLIENTS) {
    clientBlocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_+${clientNames.length - MAX_CLIENTS} more clients with activity today_` }]
    });
  }
  if (internalTasks.length > 0) {
    const lines = ["*Internal (no client)*", "✅ *Completed:*"];
    for (const t of internalTasks.slice(0, PER_LIST)) lines.push(`   • ${t.title}  _— ${who(t.assignee_id)}_`);
    if (internalTasks.length > PER_LIST) lines.push(`   • _+${internalTasks.length - PER_LIST} more_`);
    clientBlocks.push({ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: clamp(lines.join("\n")) } });
    if (internalTasks.length > PER_LIST && headerBlocks.length + clientBlocks.length < MAX_BLOCKS) {
      clientBlocks.push(showMoreBlock("__internal__"));
    }
  }

  // Thrown failures bubble to the caller (route → 500). The dedupe write only
  // happens after a successful post, so a failed post is retried next tick.
  await postMessage(
    recapChannel,
    `Daily Recap · ${today}\n` + summaryLines.join(" · "),
    [...headerBlocks, ...clientBlocks]
  );
  await supabase
    .from("workspace_settings")
    .update({ last_eod_recap_at: new Date().toISOString() })
    .eq("id", "workspace");
  return { ok: true, posted: clientNames.length };
}
