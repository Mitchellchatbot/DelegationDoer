// Thin wrapper around Slack's Web API. Server-only — uses SLACK_BOT_TOKEN.
// Three operations we need today: lookup user by email, open a DM channel
// with that user, post a message into it.

import { viewerTzAbbrev } from "./work-hours";

const SLACK_API = "https://slack.com/api";

// The team is split between Pakistan and US Eastern, so due times are shown in
// both zones. Karachi has no DST (PKT year-round); Eastern's abbreviation
// (EDT/EST) is derived so it stays correct across daylight saving.
const PKT_TZ = "Asia/Karachi";
const ET_TZ = "America/New_York";

// Render a stored (UTC) due timestamp in both team zones. When both zones fall
// on the same calendar day the date is shown once, e.g.
//   "Tue, Jul 7 · 9:30 PM PKT · 12:30 PM EDT"
// When a late-night deadline rolls the date over in one zone but not the other,
// each zone carries its own date so neither is mislabeled, e.g.
//   "Wed, Jul 8, 3:00 AM PKT · Tue, Jul 7, 6:00 PM EDT"
export function formatDueBothZones(dueIso: string): string {
  const d = new Date(dueIso);
  const dateInTz = (tz: string) =>
    d.toLocaleDateString("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric"
    });
  const timeInTz = (tz: string) =>
    d.toLocaleTimeString("en-US", {
      timeZone: tz, hour: "numeric", minute: "2-digit"
    });

  const pktDate = dateInTz(PKT_TZ);
  const etDate = dateInTz(ET_TZ);
  const pkt = `${timeInTz(PKT_TZ)} PKT`;
  const et = `${timeInTz(ET_TZ)} ${viewerTzAbbrev(ET_TZ, d)}`;

  return pktDate === etDate
    ? `${pktDate} · ${pkt} · ${et}`
    : `${pktDate}, ${pkt} · ${etDate}, ${et}`;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// Map a DelegationDoer presence state to the Slack status equivalent.
// `null` (Available) clears the status entirely.
export const PRESENCE_TO_SLACK: Record<string, { text: string; emoji: string }> = {
  focus:     { text: "In focus",   emoji: ":brain:"          },
  eating:    { text: "Eating",     emoji: ":hamburger:"       },
  away:      { text: "Away",       emoji: ":crescent_moon:"   },
  available: { text: "",           emoji: ""                  }
};

// Slack's status_emoji field is keyed on shortcodes (":fire:") — raw
// glyphs ("🔥") are silently accepted but never render. The widget
// stores the user's pick as a glyph, so we translate at the boundary.
// Covers the preset palette in TeamCarousel.PRESET_EMOJIS. Anything
// outside the table falls back to empty string so we don't push
// garbage Slack will silently swallow.
const GLYPH_TO_SHORTCODE: Record<string, string> = {
  "🔥": ":fire:",
  "⚡": ":zap:", "⚡️": ":zap:",
  "🚀": ":rocket:",
  "🎯": ":dart:",
  "💪": ":muscle:",
  "🧠": ":brain:",
  "☕": ":coffee:", "☕️": ":coffee:",
  "🍕": ":pizza:",
  "🥗": ":green_salad:",
  "🌮": ":taco:",
  "💻": ":computer:",
  "📞": ":telephone_receiver:",
  "📝": ":memo:",
  "🎧": ":headphones:",
  "🎨": ":art:",
  "😎": ":sunglasses:",
  "😴": ":sleeping:",
  "🤝": ":handshake:",
  "🎉": ":tada:",
  "✨": ":sparkles:",
  "🛠": ":hammer_and_wrench:", "🛠️": ":hammer_and_wrench:",
  "🐛": ":bug:",
  "📊": ":bar_chart:",
  "📈": ":chart_with_upwards_trend:",
  "🍔": ":hamburger:",
  "🌙": ":crescent_moon:"
};

export function toSlackEmojiShortcode(input: string): string {
  if (!input) return "";
  // Already a shortcode? Pass through.
  if (input.startsWith(":") && input.endsWith(":")) return input;
  const direct = GLYPH_TO_SHORTCODE[input];
  if (direct) return direct;
  // Try stripping the variation selector (U+FE0F) some glyphs carry.
  const stripped = input.replace(/️/g, "");
  return GLYPH_TO_SHORTCODE[stripped] ?? "";
}

// Read the current Slack profile (status text/emoji/expiration) for
// the given user token. Used by the debug endpoint so the UI can show
// what Slack itself reports, not just what we tried to push.
export async function getSlackUserProfile(userToken: string): Promise<{
  status_text: string;
  status_emoji: string;
  status_expiration: number;
}> {
  const res = await fetch(`${SLACK_API}/users.profile.get`, {
    method: "GET",
    headers: { Authorization: `Bearer ${userToken}` }
  });
  const data = (await res.json()) as SlackResponse & {
    profile?: {
      status_text?: string;
      status_emoji?: string;
      status_expiration?: number;
    };
  };
  if (!data.ok) {
    throw new Error(`slack:users.profile.get → ${data.error ?? "unknown"}`);
  }
  return {
    status_text: data.profile?.status_text ?? "",
    status_emoji: data.profile?.status_emoji ?? "",
    status_expiration: data.profile?.status_expiration ?? 0
  };
}

// users.profile.set with a user (xoxp-) token. Bots can't write
// another user's profile so each employee has to OAuth their own
// token first.
//
// Slack's profile endpoints are legacy form-encoded — they reject
// our normal JSON path with `invalid_form_data`. We have to send
// `profile` as a JSON *string* inside an x-www-form-urlencoded body.
export async function setSlackUserStatus(args: {
  userToken: string;
  statusText: string;
  statusEmoji: string;
  // Optional expiry (epoch seconds). 0 = never.
  expirationEpoch?: number;
}): Promise<void> {
  const profile = JSON.stringify({
    status_text: args.statusText,
    status_emoji: args.statusEmoji,
    status_expiration: args.expirationEpoch ?? 0
  });
  const form = new URLSearchParams();
  form.set("profile", profile);

  const res = await fetch(`${SLACK_API}/users.profile.set`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.userToken}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
    },
    body: form.toString()
  });
  const data = (await res.json()) as SlackResponse;
  if (!data.ok) {
    console.error("[slack] users.profile.set failed:", JSON.stringify(data));
    throw new Error(`slack:users.profile.set → ${data.error ?? "unknown"}`);
  }
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

// Custom emojis the workspace has uploaded. Returns a {name → url} map
// for non-alias entries (Slack's emoji.list mixes uploaded images with
// "alias:other_name" pointers; we only want the source images, the
// caller can fan out aliases if needed).
//
// Requires emojis:read scope on the bot token.
export async function listCustomEmojis(): Promise<Record<string, string>> {
  const data = await slackGet<{ ok: true; emoji: Record<string, string> }>(
    "emoji.list",
    {}
  );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(data.emoji ?? {})) {
    if (typeof value === "string" && !value.startsWith("alias:")) {
      out[name] = value;
    }
  }
  return out;
}

// Cache for users.list — it returns the entire workspace roster which
// is heavy. 5-minute TTL is plenty for kudos lookups; if a user
// just joined Slack and we miss them, the next minute's call refreshes.
interface SlackMember {
  id: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
  deleted?: boolean;
  is_bot?: boolean;
}
let cachedRoster: { at: number; members: SlackMember[] } | null = null;
async function getRoster(): Promise<SlackMember[]> {
  const now = Date.now();
  if (cachedRoster && now - cachedRoster.at < 5 * 60_000) {
    return cachedRoster.members;
  }
  const data = await slackGet<{ ok: true; members: SlackMember[] }>(
    "users.list",
    {}
  );
  const members = (data.members ?? []).filter((m) => !m.deleted && !m.is_bot);
  cachedRoster = { at: now, members };
  return members;
}

// Normalize for fuzzy compare: lowercase, strip punctuation/diacritics,
// collapse whitespace. Lets "Shaheer Khosa" match "shaheer.khosa" /
// "Shaheer Khosa 🔥" / "SHAHEER".
function norm(s: string): string {
  // Strip combining diacritics (U+0300–U+036F) after NFD-decomposing so
  // "Léon" matches "leon", lowercase, then squash anything non-alnum.
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Score a candidate Slack member against the target name. Higher = better.
//   exact match on any name field    → 100
//   target name is a substring (or vice versa) → 60
//   word overlap                     → up to 50
function scoreMember(target: string, m: SlackMember): number {
  const t = norm(target);
  if (!t) return 0;
  const candidates = [
    m.real_name,
    m.profile?.real_name,
    m.profile?.display_name
  ].filter(Boolean).map((s) => norm(s as string));
  if (candidates.length === 0) return 0;
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (c === t) best = Math.max(best, 100);
    else if (c.includes(t) || t.includes(c)) best = Math.max(best, 60);
    const targetWords = new Set(t.split(" ").filter(Boolean));
    const candWords = c.split(" ").filter(Boolean);
    const overlap = candWords.filter((w) => targetWords.has(w)).length;
    if (overlap > 0) {
      const overlapScore = (overlap / Math.max(targetWords.size, 1)) * 50;
      best = Math.max(best, overlapScore);
    }
  }
  return best;
}

// Find a Slack user by name (fuzzy match against the workspace
// roster). Returns null if nothing scored above the threshold —
// callers fall back to email lookup or skip the DM entirely.
export async function findSlackUserByName(name: string): Promise<string | null> {
  if (!name?.trim()) return null;
  try {
    const members = await getRoster();
    let bestId: string | null = null;
    let bestScore = 0;
    for (const m of members) {
      const s = scoreMember(name, m);
      if (s > bestScore) {
        bestScore = s;
        bestId = m.id;
      }
    }
    return bestScore >= 40 ? bestId : null;
  } catch (err) {
    console.warn("[slack] findSlackUserByName failed:", err);
    return null;
  }
}

// Best-effort: try email first (exact, fast), fall back to fuzzy
// name search. Used by kudos / assignment paths so a missing email
// (or a workspace where Slack email ≠ DD email) doesn't prevent
// the notification.
export async function findSlackUser(args: {
  email?: string | null;
  name?: string | null;
}): Promise<string | null> {
  if (args.email) {
    try {
      return await lookupUserByEmail(args.email);
    } catch {
      // fall through to name lookup
    }
  }
  if (args.name) {
    return findSlackUserByName(args.name);
  }
  return null;
}

export async function openDm(slackUserId: string): Promise<string> {
  const data = await slackCall<{ ok: true; channel: { id: string } }>(
    "conversations.open",
    { users: slackUserId }
  );
  return data.channel.id;
}

// Open a DM channel between the user-token holder and another user.
// Returns the channel id you can post into.
export async function openDmAsUser(
  userToken: string,
  recipientSlackId: string
): Promise<string> {
  const data = await slackCall<{ ok: true; channel: { id: string } }>(
    "conversations.open",
    { users: recipientSlackId },
    userToken
  );
  return data.channel.id;
}

// Post a message AS the user — uses their xoxp- user token instead
// of the bot. The recipient sees the DM come from the user directly
// (so it shows up in their normal Slack inbox between them and that
// person), not from the workspace bot. Requires the user to have
// granted chat:write + im:write in OAuth.
export async function postMessageAsUser(args: {
  userToken: string;
  channel: string;
  text: string;
  blocks?: unknown[];
}): Promise<{ ts: string }> {
  const data = await slackCall<{ ok: true; ts: string }>(
    "chat.postMessage",
    {
      channel: args.channel,
      text: args.text,
      blocks: args.blocks,
      // as_user is implied when posting with a user token; explicit
      // for clarity / older API versions.
      as_user: true,
      unfurl_links: false,
      unfurl_media: false
    },
    args.userToken
  );
  return { ts: data.ts };
}

export async function postMessage(
  channel: string,
  text: string,
  blocks?: unknown[]
): Promise<{ ts: string }> {
  // Propagate failures so callers can surface a specific reason
  // (not_in_channel, channel_not_found, missing_scope, etc.) instead of
  // a silently-swallowed "sent ok" lie. Callers that want best-effort
  // can wrap this in their own try/catch.
  const data = await slackCall<{ ok: true; ts: string }>("chat.postMessage", {
    channel,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false
  });
  return { ts: data.ts };
}

// Open a modal in response to an interaction (button click etc.). The
// trigger_id Slack hands us expires after 3 seconds, so callers must invoke
// this promptly inside their interaction handler. Uses the bot token — no
// extra scope needed once Interactivity is enabled on the Slack app.
export async function openView(
  triggerId: string,
  view: Record<string, unknown>
): Promise<void> {
  await slackCall("views.open", { trigger_id: triggerId, view });
}

// Resolve a public permalink for a posted message (channel + ts). Used to
// give auto-created tasks a one-click back-link to the originating Slack
// alert. Best-effort — returns null on any error so callers can fall back
// to a plain "channel/ts" reference without failing the whole flow.
export async function getPermalink(
  channel: string,
  messageTs: string
): Promise<string | null> {
  if (!process.env.SLACK_BOT_TOKEN) return null;
  try {
    const data = await slackGet<{ ok: true; permalink: string }>(
      "chat.getPermalink",
      { channel, message_ts: messageTs }
    );
    return data.permalink ?? null;
  } catch (err) {
    console.warn("[slack] getPermalink failed:", err);
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

  const dueLabel = args.dueDate ? formatDueBothZones(args.dueDate) : "no deadline";

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

// Best-effort broadcast for new Moments photos.
// Caller passes the channel id (typically workspace_settings.scaled_team_channel_id).
// Failures are swallowed — a missing slack post must never block the
// underlying create from succeeding.
export async function broadcastNewMoment(args: {
  channel: string | null;
  authorName: string;
  authorEmail?: string | null;
  imageUrl: string;
  caption: string | null;
  momentsUrl: string;
}): Promise<NotifyResult> {
  if (!process.env.SLACK_BOT_TOKEN) return { ok: false, error: "SLACK_BOT_TOKEN missing" };
  const channel = args.channel;
  if (!channel) return { ok: false, error: "no scaled-team channel configured" };

  // @-mention the author when we can resolve their Slack id so it
  // shows up properly in their feed too.
  let mention = `*${args.authorName}*`;
  if (args.authorEmail) {
    try {
      const uid = await lookupUserByEmail(args.authorEmail);
      mention = `<@${uid}>`;
    } catch { /* leave plain text */ }
  }

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `📸 ${mention} just posted a new Moment${args.caption ? `\n> ${args.caption.slice(0, 280)}` : ""}`
      }
    },
    { type: "image", image_url: args.imageUrl, alt_text: args.caption ?? "moment" },
    {
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "View in DelegationDoer", emoji: true },
        url: args.momentsUrl
      }]
    }
  ];

  try {
    await slackCall<{ ok: true; ts: string }>("chat.postMessage", {
      channel,
      text: `📸 ${args.authorName} just posted a new Moment`,
      blocks,
      unfurl_links: false,
      unfurl_media: false
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Best-effort broadcast for new Recommendations (movie, album, tv, etc).
// Caller passes the channel id (typically workspace_settings.scaled_team_channel_id).
export async function broadcastNewRecommendation(args: {
  channel: string | null;
  authorName: string;
  authorEmail?: string | null;
  kind: string;
  title: string;
  subtitle?: string | null;
  body?: string | null;
  imageUrl?: string | null;
  externalUrl?: string | null;
  recsUrl: string;
}): Promise<NotifyResult> {
  if (!process.env.SLACK_BOT_TOKEN) return { ok: false, error: "SLACK_BOT_TOKEN missing" };
  const channel = args.channel;
  if (!channel) return { ok: false, error: "no scaled-team channel configured" };

  let mention = `*${args.authorName}*`;
  if (args.authorEmail) {
    try {
      const uid = await lookupUserByEmail(args.authorEmail);
      mention = `<@${uid}>`;
    } catch { /* leave plain text */ }
  }

  const emoji =
    args.kind === "movie" ? "🎬"
    : args.kind === "tv" ? "📺"
    : args.kind === "album" ? "🎵"
    : args.kind === "art" ? "🎨"
    : args.kind === "game" ? "🎮"
    : args.kind === "video" ? "📹"
    : "⭐";

  const titleLine = args.externalUrl
    ? `<${args.externalUrl}|${args.title}>`
    : args.title;

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} ${mention} just recommended *${titleLine}*${args.subtitle ? `\n_${args.subtitle}_` : ""}${args.body ? `\n${args.body.slice(0, 400)}` : ""}`
      },
      ...(args.imageUrl ? { accessory: { type: "image", image_url: args.imageUrl, alt_text: args.title } } : {})
    },
    {
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "See in DelegationDoer", emoji: true },
        url: args.recsUrl
      }]
    }
  ];

  try {
    await slackCall<{ ok: true; ts: string }>("chat.postMessage", {
      channel,
      text: `${emoji} ${args.authorName} just recommended ${args.title}`,
      blocks,
      unfurl_links: false,
      unfurl_media: false
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Mention / notify-teammates fan-out, but DM'd FROM the sender's
// own Slack account (xoxp- user token) instead of the workspace bot.
// Recipients see the message as a direct DM from a real person, which
// is what the team actually wants for "Henry pinged you on a task."
//
// Falls back to bot send (notifyTeamFyi) when:
//   - the sender hasn't connected Slack yet
//   - the sender's user token is missing the required scope
//
// Returns sent/failed/skipped tallies so callers can shape a toast.
export async function notifyTeamFyiAsUser(args: {
  senderUserToken: string;
  senderName: string;
  recipients: { email: string | null; name: string }[];
  headline: string;
  body: string;
  taskId: string;
  taskTitle: string;
}): Promise<{ sent: number; failed: number; skipped: number }> {
  if (args.recipients.length === 0) return { sent: 0, failed: 0, skipped: 0 };
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const taskUrl = `${baseUrl}/tasks/${args.taskId}`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${args.headline}*\n${args.body}` } },
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
  let sent = 0, failed = 0, skipped = 0;
  for (const r of args.recipients) {
    try {
      const recipientSlackId = await findSlackUser({
        email: r.email,
        name: r.name
      });
      if (!recipientSlackId) { skipped++; continue; }
      const channel = await openDmAsUser(args.senderUserToken, recipientSlackId);
      await postMessageAsUser({
        userToken: args.senderUserToken,
        channel,
        text: args.headline,
        blocks
      });
      sent++;
    } catch {
      failed++;
    }
  }
  return { sent, failed, skipped };
}

// Escalation DM when email intake can't route a thread (no candidates
// or low classifier confidence). Fans out to every leader/CEO so they
// can pick up the unrouted thread in the routing-review dashboard.
// Best-effort per recipient — failures don't fail the whole call.
export async function notifyRoutingFallback(args: {
  leaderEmails: string[];
  subject: string;
  fromEmail: string | null;
  reason: string;
}): Promise<{ sent: number; failed: number }> {
  if (!process.env.SLACK_BOT_TOKEN || args.leaderEmails.length === 0) {
    return { sent: 0, failed: 0 };
  }
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const reviewUrl = `${baseUrl}/routing-review`;

  const humanReason =
    args.reason === "no-candidates"
      ? "no candidate assignee — every routing signal came back empty"
      : args.reason === "low-confidence"
        ? "the AI classifier wasn't confident enough to pick a department"
        : args.reason === "classifier-failed"
          ? "the AI classifier couldn't read the email (API error) — review it manually"
          : args.reason;

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "⚠️ Email needs routing review", emoji: true }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Subject*\n${args.subject || "(no subject)"}` },
        { type: "mrkdwn", text: `*From*\n${args.fromEmail ?? "(unknown)"}` },
        { type: "mrkdwn", text: `*Why*\n${humanReason}` }
      ]
    },
    {
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "Open routing review", emoji: true },
        url: reviewUrl,
        style: "primary"
      }]
    }
  ];

  const results = await Promise.allSettled(
    args.leaderEmails.map(async (email) => {
      const slackUserId = await lookupUserByEmail(email);
      const channel = await openDm(slackUserId);
      await slackCall("chat.postMessage", {
        channel,
        text: `Email needs routing review: ${args.subject}`,
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

