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
  taskId: string;
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
  const taskUrl = `${baseUrl}/tasks/${args.taskId}`;

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
      text: { type: "mrkdwn", text: `*<${taskUrl}|${args.title}>*` }
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
          url: taskUrl,
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

// Build the celebratory "task completed" Block Kit payload and post it to
// the given Slack channel id (DM or team channel). Returns ok=true on
// success, or ok=false with a specific reason.
async function postCompletionBlocks(args: {
  channel: string;
  assigneeName: string;
  assigneeSlackId?: string | null;
  taskId: string;
  title: string;
  estimateHours: number;
  actualHours: number;
  clientName?: string | null;
}): Promise<NotifyResult> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const taskUrl = `${baseUrl}/tasks/${args.taskId}`;
  const text = `${args.assigneeName} completed: ${args.title}`;

  const mention = args.assigneeSlackId ? `<@${args.assigneeSlackId}>` : `*${args.assigneeName}*`;
  const variance =
    args.estimateHours > 0
      ? Math.round((args.actualHours / args.estimateHours) * 100) + "%"
      : "—";

  const fields: { type: "mrkdwn"; text: string }[] = [
    { type: "mrkdwn", text: `*Estimate*\n${args.estimateHours}h` },
    { type: "mrkdwn", text: `*Actual*\n${args.actualHours}h (${variance})` }
  ];
  if (args.clientName) {
    fields.push({ type: "mrkdwn", text: `*Client*\n${args.clientName}` });
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "✅ Task completed", emoji: true }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `${mention} just finished:` }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${taskUrl}|${args.title}>*` }
    },
    { type: "section", fields },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in DelegationDoer", emoji: true },
          url: taskUrl,
          style: "primary"
        }
      ]
    }
  ];

  try {
    await slackCall<{ ok: true; ts: string }>("chat.postMessage", {
      channel: args.channel,
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

export interface CompletionResult {
  creatorDm: NotifyResult | { ok: false; error: "skipped" };
  channelPost: NotifyResult | { ok: false; error: "skipped" };
}

// Two-target completion fan-out:
//   1) DM the creator (the person who delegated). Always.
//   2) Post to SLACK_COMPLETED_CHANNEL if set (env-gated).
// Both calls run in parallel; failures don't cascade.
export async function notifyCompletion(args: {
  creatorEmail: string | null;
  assigneeName: string;
  assigneeEmail?: string | null; // for @-mention in the channel post
  taskId: string;
  title: string;
  estimateHours: number;
  actualHours: number;
  clientName?: string | null;
}): Promise<CompletionResult> {
  if (!process.env.SLACK_BOT_TOKEN) {
    return {
      creatorDm: { ok: false, error: "SLACK_BOT_TOKEN missing" },
      channelPost: { ok: false, error: "SLACK_BOT_TOKEN missing" }
    };
  }

  // Resolve assignee's Slack id once, for nicer @-mention in both messages.
  let assigneeSlackId: string | null = null;
  if (args.assigneeEmail) {
    try { assigneeSlackId = await lookupUserByEmail(args.assigneeEmail); } catch { /* leave null */ }
  }

  const completedChannelId = process.env.SLACK_COMPLETED_CHANNEL ?? null;

  const dmTask: Promise<NotifyResult | { ok: false; error: "skipped" }> = (async () => {
    if (!args.creatorEmail) return { ok: false, error: "skipped" } as const;
    let dmChannel: string;
    try { dmChannel = await openDm(await lookupUserByEmail(args.creatorEmail)); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
    return postCompletionBlocks({ ...args, channel: dmChannel, assigneeSlackId });
  })();

  const channelTask: Promise<NotifyResult | { ok: false; error: "skipped" }> = (async () => {
    if (!completedChannelId) return { ok: false, error: "skipped" } as const;
    return postCompletionBlocks({ ...args, channel: completedChannelId, assigneeSlackId });
  })();

  const [creatorDm, channelPost] = await Promise.all([dmTask, channelTask]);
  return { creatorDm, channelPost };
}

// FYI fan-out used when a request is auto-routed to a department head and
// we want the rest of the team to know it's in flight (e.g. the SEO
// report-request flow). Best-effort per recipient — failures don't fail
// the whole call.
export async function notifyTeamFyi(args: {
  recipientEmails: string[];
  headline: string;
  body: string;
  taskId: string;
  taskTitle: string;
}): Promise<{ sent: number; failed: number }> {
  if (!process.env.SLACK_BOT_TOKEN || args.recipientEmails.length === 0) {
    return { sent: 0, failed: 0 };
  }
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const taskUrl = `${baseUrl}/tasks/${args.taskId}`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: args.headline, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: args.body } },
    { type: "section", text: { type: "mrkdwn", text: `*<${taskUrl}|${args.taskTitle}>*` } },
    {
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "Open in DelegationDoer", emoji: true },
        url: taskUrl
      }]
    }
  ];

  const results = await Promise.allSettled(
    args.recipientEmails.map(async (email) => {
      const slackUserId = await lookupUserByEmail(email);
      const channel = await openDm(slackUserId);
      await slackCall("chat.postMessage", {
        channel,
        text: args.headline,
        blocks,
        unfurl_links: false,
        unfurl_media: false
      });
    })
  );
  let sent = 0, failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") sent++; else failed++;
  }
  return { sent, failed };
}

