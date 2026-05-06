// Thin wrapper around Slack's Web API. Server-only — uses SLACK_BOT_TOKEN.
// Three operations we need today: lookup user by email, open a DM channel
// with that user, post a message into it.

const SLACK_API = "https://slack.com/api";

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function slackCall<T extends SlackResponse>(
  method: string,
  body: Record<string, unknown>,
  token: string = process.env.SLACK_BOT_TOKEN ?? ""
): Promise<T> {
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN missing");
  }
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  });
  const data = (await res.json()) as T;
  if (!data.ok) {
    throw new Error(`slack:${method} → ${data.error ?? "unknown"}`);
  }
  return data;
}

export async function lookupUserByEmail(email: string): Promise<string | null> {
  try {
    const data = await slackCall<{ ok: true; user: { id: string } }>(
      "users.lookupByEmail",
      { email }
    );
    return data.user.id;
  } catch (err) {
    // Common cases: users_not_found (the person isn't in the workspace),
    // missing_scope (permissions). We don't want a missing person to fail
    // the whole ticket-creation flow.
    return null;
  }
}

export async function openDm(slackUserId: string): Promise<string | null> {
  try {
    const data = await slackCall<{ ok: true; channel: { id: string } }>(
      "conversations.open",
      { users: slackUserId }
    );
    return data.channel.id;
  } catch {
    return null;
  }
}

export async function postMessage(
  channel: string,
  text: string,
  blocks?: unknown[]
): Promise<{ ts: string } | null> {
  try {
    const data = await slackCall<{ ok: true; ts: string }>("chat.postMessage", {
      channel,
      text, // fallback for notifications / older clients
      blocks,
      unfurl_links: false,
      unfurl_media: false
    });
    return { ts: data.ts };
  } catch {
    return null;
  }
}

// One-shot: given a Slack user id (or null), build the assignment block kit
// payload and DM them. Returns true if posted, false otherwise.
export async function notifyAssignment(args: {
  assigneeEmail: string;
  assignerName: string;
  ticketId: string;
  title: string;
  description?: string | null;
  priority: string;
  estimateHours: number;
  dueDate: string | null;
  clientName?: string | null;
}): Promise<boolean> {
  if (!process.env.SLACK_BOT_TOKEN) return false;

  const slackUserId = await lookupUserByEmail(args.assigneeEmail);
  if (!slackUserId) return false;

  const channel = await openDm(slackUserId);
  if (!channel) return false;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const ticketUrl = `${baseUrl}/tickets/${args.ticketId}`;

  const dueLabel = args.dueDate
    ? new Date(args.dueDate).toLocaleString(undefined, {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short"
      })
    : "no deadline";

  // Slack Block Kit. The `text` field is the plain-text fallback.
  const text = `${args.assignerName} assigned you a task: ${args.title}`;

  const fields: { type: "mrkdwn"; text: string }[] = [
    { type: "mrkdwn", text: `*Priority*\n${args.priority}` },
    { type: "mrkdwn", text: `*Estimate*\n${args.estimateHours}h` },
    { type: "mrkdwn", text: `*Due*\n${dueLabel}` }
  ];
  if (args.clientName) {
    fields.push({ type: "mrkdwn", text: `*Client*\n${args.clientName}` });
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "👋 New task assigned", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<@${slackUserId}> — *${args.assignerName}* assigned you a task.`
      }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${ticketUrl}|${args.title}>*` }
    },
    ...(args.description
      ? [{ type: "section", text: { type: "mrkdwn", text: args.description.slice(0, 2900) } }]
      : []),
    { type: "section", fields },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in DelegationDoer", emoji: true },
          url: ticketUrl,
          style: "primary"
        }
      ]
    }
  ];

  const result = await postMessage(channel, text, blocks);
  return !!result;
}
