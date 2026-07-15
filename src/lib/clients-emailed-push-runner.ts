// Day-end Slack push of "which clients did we email", DM'd to Sam & Mitchell.
// Runs EVERY day at 7pm NY with that day's numbers; on Friday the week's
// roll-up rides along in the same DM rather than arriving as a second message
// (Sam & Mitchell asked for the week summary at day-end Friday, and two DMs
// landing back-to-back reads as noise).
//
// Shares the exact idempotency shape as eod-recap-runner so it's safe to run at
// any cadence (Vercel fires it at 23:00 + 00:00 UTC to straddle DST; the
// in-process loop ticks hourly):
//   1. 7pm NY-hour guard    — no-op unless the current America/New_York hour is 19
//   2. last_clients_emailed_push_at — same-UTC-day dedupe so two ticks inside
//      the 7pm hour can't double-DM. One DM per day means the single stamp is
//      still exactly right: 7pm NY is 23:00 UTC in EDT and 00:00 UTC (next day)
//      in EST, so each daily run lands on its own UTC date either way.
// opts.force bypasses guard 1 and the dedupe; opts.includeWeek forces the week
// section on so the Friday shape is testable on any weekday.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { openDm, postMessage } from "@/lib/slack";
import { resolveSlackId } from "@/lib/slack-resolve";
import { DEFAULT_TZ, nowInTz } from "@/lib/shift";
import {
  resolveWindow,
  listClientsEmailedInWindow,
  type ClientEmailedRow
} from "@/lib/clients-emailed";

// Who the summary is DM'd to. Kept explicit (not role-derived) because this is a
// specific ask from these two — mirrors how named-user behaviour is targeted
// elsewhere in the app.
const RECIPIENT_EMAILS = ["sam@scaledai.org", "mitchell@scaledai.org"];

export type ClientsEmailedPushOutcome =
  | { ok: true; skipped: string; nyHour?: number }
  | {
      ok: true;
      posted: number;
      clients: number;
      weekClients: number | null;
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

// Today's lines only need a clock time; the week's span multiple days, so those
// carry a weekday too.
function sentLabel(iso: string, withWeekday: boolean): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone: DEFAULT_TZ
  };
  if (withWeekday) opts.weekday = "short";
  return new Date(iso).toLocaleString("en-US", opts);
}

// "7 clients, 10 emails". NOTE: `count` is per outbound THREAD (see
// clients-emailed.ts) — a client emailed three times in one thread contributes 1,
// not 3. Same basis the /home card's badge and the previous weekly DM already
// used, so the two surfaces agree.
function countLabel(clients: ClientEmailedRow[]): string {
  const emails = clients.reduce((n, c) => n + c.count, 0);
  const n = clients.length;
  return `${n} client${n === 1 ? "" : "s"}, ${emails} email${emails === 1 ? "" : "s"}`;
}

// Slack caps a section at 3000 chars and a message at 50 blocks; chunk the client
// lines into sections well under that (same defensive posture as eod-recap-runner).
// Two chunked sections on Friday is ~10 blocks, comfortably clear of the cap.
const MAX_CLIENTS = 60;
const LINES_PER_SECTION = 20;

function lineSections(
  clients: ClientEmailedRow[],
  withWeekday: boolean,
  moreLabel: string
): unknown[] {
  const lines = clients.slice(0, MAX_CLIENTS).map((c) => {
    const times = c.count > 1 ? `${c.count} emails` : "1 email";
    const subj = c.latestSubject ? ` — _${c.latestSubject}_` : "";
    return `• *${c.clientName}*  (${times}, last ${sentLabel(c.latestSentAt, withWeekday)})${subj}`;
  });

  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_SECTION) {
    const text = lines.slice(i, i + LINES_PER_SECTION).join("\n");
    out.push({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2990) } });
  }
  if (clients.length > MAX_CLIENTS) {
    out.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_+${clients.length - MAX_CLIENTS} more ${moreLabel}_` }]
    });
  }
  return out;
}

const DISCLAIMER = "real human email only (automated blasts excluded)";

function buildBlocks(args: {
  today: ClientEmailedRow[];
  week: ClientEmailedRow[] | null;
  todayLabel: string;
  weekRangeLabel: string | null;
}): unknown[] {
  const { today, week, todayLabel, weekRangeLabel } = args;

  // Any day but Friday: headline the day's numbers, then the clients.
  if (!week) {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📧 Clients emailed today · ${countLabel(today)}`.slice(0, 150),
          emoji: true
        }
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `*${todayLabel}* — ${DISCLAIMER}.` }]
      },
      { type: "divider" },
      ...lineSections(today, false, "clients emailed today")
    ];
  }

  // Friday: today + the week, in one DM.
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📧 Clients emailed — ${todayLabel}`.slice(0, 150),
        emoji: true
      }
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Day-end summary — ${DISCLAIMER}.` }]
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*TODAY* · ${countLabel(today)}` } }
  ];

  // A quiet Friday still ships the week section, so say so rather than showing a gap.
  if (today.length === 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "_No client email went out today._" }]
    });
  } else {
    blocks.push(...lineSections(today, false, "clients emailed today"));
  }

  blocks.push(
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*THIS WEEK* · ${countLabel(week)}\n_${weekRangeLabel}_` }
    },
    ...lineSections(week, true, "clients emailed this week")
  );
  return blocks;
}

export async function runClientsEmailedPush(
  opts: { force?: boolean; includeWeek?: boolean } = {}
): Promise<ClientsEmailedPushOutcome> {
  const now = nowInTz(DEFAULT_TZ);

  if (!opts.force && now.hh !== 19) {
    return { ok: true, skipped: "not-7pm-ny", nyHour: now.hh };
  }

  // Friday drives CONTENT now, not gating. Still derived from nowInTz(...).dayKey,
  // NOT eod-digest's isReportDay('weekly') which tests getUTCDay()===5 — at 7pm NY
  // in EST that instant is already Saturday 00:00 UTC (getUTCDay()===6), so it
  // would misfire across DST.
  const includeWeek = opts.includeWeek ?? now.dayKey === "fri";

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

  const todayClients = await listClientsEmailedInWindow(resolveWindow("today"));
  // The week aggregate is per-client across the whole week, so today's slice
  // can't be derived from it — Friday genuinely needs both walks.
  const weekWin = includeWeek ? resolveWindow("week") : null;
  const weekClients = weekWin ? await listClientsEmailedInWindow(weekWin) : null;

  // Nothing to say at all — don't DM an empty summary, and leave the stamp
  // untouched so we re-check on the next tick within the 7pm hour. A quiet
  // Friday with a busy week still sends.
  if (todayClients.length === 0 && (!weekClients || weekClients.length === 0)) {
    return { ok: true, skipped: "no-clients-emailed" };
  }

  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: DEFAULT_TZ
  });
  // Human range: Monday NY → today NY. startNyDate is a bare calendar date, so
  // read it back at UTC noon to keep it off a DST/midnight boundary.
  const weekRangeLabel = weekWin
    ? `${new Date(`${weekWin.startNyDate}T12:00:00Z`).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "UTC"
      })} – ${todayLabel}`
    : null;

  const blocks = buildBlocks({ today: todayClients, week: weekClients, todayLabel, weekRangeLabel });

  const names = (rows: ClientEmailedRow[]) =>
    rows.slice(0, MAX_CLIENTS).map((c) => `${c.clientName} (${c.count})`).join(" · ");
  const fallbackText = [
    `Clients emailed today · ${countLabel(todayClients)} — ${todayLabel}`,
    names(todayClients),
    ...(weekClients
      ? [`This week · ${countLabel(weekClients)} — ${weekRangeLabel}`, names(weekClients)]
      : [])
  ]
    .filter(Boolean)
    .join("\n");

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

  return {
    ok: true,
    posted: recipients.filter((r) => r.delivered).length,
    clients: todayClients.length,
    weekClients: weekClients?.length ?? null,
    recipients
  };
}
