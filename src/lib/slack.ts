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
    // Surface the full payload so we can see block-kit validation errors etc.
    console.error(`[slack] ${method} failed:`, JSON.stringify(data));
    throw new Error(`slack:${method} → ${data.error ?? "unknown"}`);
  }
  return data;
}

// GET variant for the methods that don't accept JSON-encoded bodies.
// users.lookupByEmail is the one we hit — Slack returns invalid_arguments
// on POST application/json for it, even though chat.postMessage and
// conversations.open are happy with JSON.
async function slackGet<T extends SlackResponse>(
  method: string,
  params: Record<string, string>,
  token: string = process.env.SLACK_BOT_TOKEN ?? ""
): Promise<T> {
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN missing");
  }
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = (await res.json()) as T;
  if (!data.ok) {
    console.error(`[slack] ${method} failed:`, JSON.stringify(data));
    throw new Error(`slack:${method} → ${data.error ?? "unknown"}`);
  }
  return data;
}

export async function lookupUserByEmail(email: string): Promise<string> {
  const data = await slackGet<{ ok: true; user: { id: string } }>(
    "users.lookupByEmail",
    { email }
  );
  return data.user.id;
}

export async function openDm(slackUserId: string): Promise<string> {
  const data = await slackCall<{ ok: true; channel: { id: string } }>(
    "conversations.open",
    { users: slackUserId }
  );
  return data.channel.id;
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

export interface NotifyResult {
  ok: boolean;
  error?: string;
}

// One-shot: given an email, build the assignment block kit payload and DM
// them. Returns ok=true on success, or ok=false with the specific reason.
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
}): Promise<NotifyResult> {
  if (!process.env.SLACK_BOT_TOKEN) return { ok: false, error: "SLACK_BOT_TOKEN missing" };

  let slackUserId: string;
  try {
    slackUserId = await lookupUserByEmail(args.assigneeEmail);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let channel: string;
  try {
    channel = await openDm(slackUserId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

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

  // Inline the postMessage with explicit error capture so we don't lose the
  // Slack response shape (which is the only thing that tells us why a Block
  // Kit payload is being rejected).
  try {
    await slackCall<{ ok: true; ts: string }>("chat.postMessage", {
      channel,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
