// Friday day-end Slack push of "which clients did we email this week", DM'd to
// Sam & Mitchell. Sam asked for the week summary to be "shared day end Friday".
//
// Shares the exact idempotency shape as eod-recap-runner so it's safe to run at
// any cadence (Vercel fires it at 23:00 UTC Fri + 00:00 UTC Sat to straddle
// DST; the in-process loop ticks hourly):
//   1. 7pm NY-hour guard    — no-op unless the current America/New_York hour is 19
//   2. Friday guard         — no-op unless the current NY weekday is Friday. We
//      derive it from nowInTz(...).dayKey, NOT eod-digest's isReportDay('weekly')
//      which tests getUTCDay()===5 — at 7pm NY in EST that instant is already
//      Saturday 00:00 UTC (getUTCDay()===6), so it would misfire across DST.
//   3. last_clients_emailed_push_at — same-UTC-day dedupe so two ticks inside
//      the 7pm hour can't double-DM.
// opts.force bypasses guards 1 & 2 for manual testing.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";
import { DEFAULT_TZ, nowInTz } from "@/lib/shift";
import {
  resolveWindow,
  listClientsEmailedInWindow,
  type ClientEmailedRow
} from "@/lib/clients-emailed";

// Who the weekly summary is DM'd to. Kept explicit (not role-derived) because
// this is a specific ask from these two — mirrors how named-user behaviour is
// targeted elsewhere in the app.
const RECIPIENT_EMAILS = ["sam@scaledai.org", "mitchell@scaledai.org"];

export type ClientsEmailedWeeklyOutcome =
  | { ok: true; skipped: string; nyHour?: number; nyDay?: string }
  | {
      ok: true;
      posted: number;
      clients: number;
      recipients: Array<{ email: string; delivered: boolean; reason?: string }>;
    }
  | { ok: false; reason: string };

interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  slack_email: string | null;
  slack_user_id: string | null;
}

function sentLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: DEFAULT_TZ
  });
}

// Slack caps a section at 3000 chars; chunk the client lines into sections
// well under that (same defensive posture as eod-recap-runner).
const MAX_CLIENTS = 60;
const LINES_PER_SECTION = 20;

function buildBlocks(clients: ClientEmailedRow[], rangeLabel: string): unknown[] {
  const header: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📧 Clients emailed this week · ${clients.length}`.slice(0, 150),
        emoji: true
      }
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${rangeLabel}* — every client we sent real email to this week (automated blasts excluded).`
        }
      ]
    },
    { type: "divider" }
  ];

  const shown = clients.slice(0, MAX_CLIENTS);
  const lines = shown.map((c) => {
    const times = c.count > 1 ? `${c.count} emails` : "1 email";
    const subj = c.latestSubject ? ` — _${c.latestSubject}_` : "";
    return `• *${c.clientName}*  (${times}, last ${sentLabel(c.latestSentAt)})${subj}`;
  });

  const sections: unknown[] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_SECTION) {
    const text = lines.slice(i, i + LINES_PER_SECTION).join("\n");
    sections.push({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2990) } });
  }
  if (clients.length > MAX_CLIENTS) {
    sections.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `_+${clients.length - MAX_CLIENTS} more clients emailed this week_` }
      ]
    });
  }
  return [...header, ...sections];
}

export async function runClientsEmailedWeekly(
  opts: { force?: boolean } = {}
): Promise<ClientsEmailedWeeklyOutcome> {
  const now = nowInTz(DEFAULT_TZ);

  if (!opts.force) {
    if (now.hh !== 19) return { ok: true, skipped: "not-7pm-ny", nyHour: now.hh };
    if (now.dayKey !== "fri") return { ok: true, skipped: "not-friday", nyDay: now.dayKey };
  }

  const supabase = getSupabaseAdmin();
  const { data: settings } = await supabase
    .from("workspace_settings")
    .select("last_clients_emailed_push_at")
    .eq("id", "workspace")
    .maybeSingle();

  // Same-UTC-day dedupe (skipped on force so tests can re-run).
  if (!opts.force) {
    const last = settings?.last_clients_emailed_push_at as string | null;
    if (last) {
      const lastDay = new Date(last).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      if (lastDay === today) return { ok: true, skipped: "already-sent-today" };
    }
  }

  if (!process.env.SLACK_BOT_TOKEN) {
    return { ok: false, reason: "SLACK_BOT_TOKEN missing" };
  }

  const win = resolveWindow("week");
  const clients = await listClientsEmailedInWindow(win);
  if (clients.length === 0) {
    // Quiet week — don't DM an empty summary, and leave the stamp untouched so
    // we re-check on the next tick within the 7pm hour.
    return { ok: true, skipped: "no-clients-emailed" };
  }

  // Human range: Monday NY → today NY.
  const startLabel = new Date(`${win.startNyDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC"
  });
  const endLabel = new Date().toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: DEFAULT_TZ
  });
  const rangeLabel = `${startLabel} – ${endLabel}`;

  const blocks = buildBlocks(clients, rangeLabel);
  const fallbackText =
    `Clients emailed this week (${clients.length}) · ${rangeLabel}\n` +
    clients.slice(0, MAX_CLIENTS).map((c) => `${c.clientName} (${c.count})`).join(" · ");

  // Resolve the recipient user rows (id/name/slack fields) in one trip.
  const { data: users } = await supabase
    .from("users")
    .select("id, name, email, slack_email, slack_user_id")
    .in("email", RECIPIENT_EMAILS);
  const rowByEmail = new Map<string, UserRow>();
  for (const u of (users ?? []) as UserRow[]) {
    if (u.email) rowByEmail.set(u.email.toLowerCase(), u);
  }

  // Fan out the DMs. Per-recipient failure is recorded, not fatal — same shape
  // as the EOD-submit fan-out.
  const recipients: Array<{ email: string; delivered: boolean; reason?: string }> = [];
  for (const email of RECIPIENT_EMAILS) {
    try {
      const row = rowByEmail.get(email.toLowerCase());
      const slackUserId = await resolveSlackId(
        row
          ? { id: row.id, email: row.email, slack_email: row.slack_email, slack_user_id: row.slack_user_id }
          : { email }
      );
      const dm = await openDm(slackUserId);
      await postMessage(dm, fallbackText, blocks);
      recipients.push({ email, delivered: true });
    } catch (err) {
      recipients.push({
        email,
        delivered: false,
        reason: err instanceof Error ? err.message : "slack failed"
      });
    }
  }

  const anyDelivered = recipients.some((r) => r.delivered);
  // Only stamp once at least one DM landed, so an all-fail run retries on the
  // next tick within the 7pm hour instead of being silently swallowed.
  if (anyDelivered) {
    await supabase
      .from("workspace_settings")
      .update({ last_clients_emailed_push_at: new Date().toISOString() })
      .eq("id", "workspace");
  }

  return { ok: true, posted: recipients.filter((r) => r.delivered).length, clients: clients.length, recipients };
}
