// Slack ping in #email-notifs whenever a known client emails one of our
// inboxes.
//
// Requested by Bismah: "It would be great if we can get notification on our
// slack channel whenever any client email us so we can reply him on time."
//
// WHY THIS ISN'T PART OF fanOutInboxEvent
// ---------------------------------------
// email-notifications.ts looks like the natural home — same trigger, same
// enrichment — but it bails at the top when nobody has opted into that inbox
// (user_email_notification_prefs), and its poller is driven entirely by that
// same prefs table. A Slack post hung off it would silently never fire for
// any inbox without a subscriber, which is exactly the inbox most likely to
// have mail nobody noticed. This runs independently of who's opted in.
//
// WHY THE CLAIM TABLE
// -------------------
// A new message reaches DD by three paths (HMAC webhook, socket.io bridge,
// safety-net poll) and prod runs more than one app instance. The 30s dedupe
// in missive-socket.ts is per-process, so it cannot stop two instances from
// both posting. Every path INSERTs into slack_client_email_posts before
// calling Slack; the primary key on message_id is the real lock and the
// loser backs off on 23505.
//
// EVERY GATE IS A SKIP, NOT A THROW. The caller is a fire-and-forget
// subscriber — a client email failing to reach Slack must never take down
// the inbox event bus.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  getThread,
  listAccounts,
  listThreads,
  type MissiveMessage,
  type MissiveThreadDetail
} from "@/lib/missive-client";
import { postMessage } from "@/lib/slack";
import { loadClientMatcher } from "@/lib/client-thread-match";
import { looksUnreplyable } from "@/lib/email-intake-filters";
import { getRestrictedSenderRules, messagesMatch } from "@/lib/restricted-senders";
import { getPrivateInboxOwners } from "@/lib/inbox-access";
import { splitAddress, bodyPreview } from "@/lib/email-format";
import type { InboxEvent } from "@/lib/inbox-event-bus";

// How far back the safety-net poll will reach on a cold start. Without this
// a fresh deploy (empty claim table) would treat every thread in the INBOX
// as unnotified and dump the backlog into the channel.
const FIRST_RUN_HARD_CAP_MS = 60 * 60 * 1000;

// Threads inspected per poll pass, newest-first. The poll only exists to
// cover a window where BOTH real-time paths were down, so it doesn't need
// to be exhaustive.
const POLL_THREAD_LIMIT = 60;

// thread_id -> the last_message_at we last evaluated for it. The poll uses a
// fixed lookback window, so without this every non-client thread in the
// window would be re-fetched from the clone on every pass (12x/hour each).
// Process-local and deliberately not persisted: losing it on restart just
// means one extra pass of re-examination, and the claim table still stops
// any double-post.
const examinedThreads = new Map<string, string>();

function rememberExamined(threadId: string, lastMessageAt: string): void {
  // Cheap bound. The map only ever holds threads active inside the lookback
  // window, but a pathological burst shouldn't grow it without limit.
  if (examinedThreads.size > 2_000) examinedThreads.clear();
  examinedThreads.set(threadId, lastMessageAt);
}

// Slack's own limits: header plain_text 150, section text 3000.
const HEADER_MAX = 150;
const SECTION_MAX = 2900;

export type SkipReason =
  | "not-message-new"
  | "no-message-id"
  | "no-slack-token"
  | "no-channel"
  | "thread-fetch-failed"
  | "message-not-found"
  | "outbound"
  | "spam-folder"
  | "automated-sender"
  | "restricted-sender"
  | "private-inbox"
  | "not-a-client"
  | "already-posted";

export interface NotifyOutcome {
  status: "posted" | "skipped" | "dry-run" | "error";
  reason?: SkipReason | string;
  threadId: string;
  messageId: string | null;
  accountId: string;
  clientName?: string | null;
  fromEmail?: string | null;
  subject?: string | null;
  /** Rendered payload, returned on dry runs so the debug route can show it. */
  preview?: { text: string; blocks: unknown[] };
}

function skip(
  event: { thread_id: string; message_id?: string | null; account_id: string },
  reason: SkipReason | string
): NotifyOutcome {
  return {
    status: "skipped",
    reason,
    threadId: event.thread_id,
    messageId: event.message_id ?? null,
    accountId: event.account_id
  };
}

// Slack mrkdwn reserves these three. Everything else (including *, _, `)
// is left alone — a subject with an asterisk rendering as bold is
// cosmetic, whereas an unescaped < swallows the rest of the line.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Only complain about a broken channel lookup once per process. The usual
// cause is the code being deployed ahead of its migration, and this runs on
// every inbound message — logging per-email would bury whatever real error
// someone is actually reading the logs for.
let channelLookupErrorLogged = false;

async function resolveChannel(): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("workspace_settings")
    .select("client_email_channel_id")
    .eq("id", "workspace")
    .maybeSingle();
  if (error) {
    // Missing column = migration hasn't landed yet. Never throw: the feature
    // is simply off until it does, and the caller is a fire-and-forget bus
    // subscriber shared with the live inbox.
    if (!channelLookupErrorLogged) {
      channelLookupErrorLogged = true;
      console.error("[client-email-slack] channel lookup failed", error.message);
    }
    return null;
  }
  return (data as { client_email_channel_id: string | null } | null)?.client_email_channel_id ?? null;
}

// account_id -> display label for the "Inbox" field. Falls back to the raw
// id so a newly-connected account still renders something meaningful.
async function accountLabel(accountId: string): Promise<string> {
  try {
    const accounts = await listAccounts();
    const hit = accounts.find((a) => a.id === accountId);
    return hit?.email ?? accountId;
  } catch {
    return accountId;
  }
}

function newestInbound(messages: MissiveMessage[]): MissiveMessage | null {
  const inbound = messages.filter((m) => m.direction === "inbound");
  if (inbound.length === 0) return null;
  // Don't trust list order — sort explicitly.
  return inbound.reduce((a, b) => (b.sent_at > a.sent_at ? b : a));
}

function buildPost(args: {
  clientName: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  inbox: string;
  preview: string | null;
  sentAt: string | null;
  threadId: string;
  accountId: string;
}): { text: string; blocks: unknown[] } {
  const subject = args.subject?.trim() || "(no subject)";
  const from = args.fromName
    ? `${args.fromName} <${args.fromEmail ?? "?"}>`
    : (args.fromEmail ?? "unknown sender");

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: clamp(`📬 New client email — ${args.clientName}`, HEADER_MAX),
        emoji: true
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: clamp(`*From*\n${esc(from)}`, SECTION_MAX) },
        { type: "mrkdwn", text: clamp(`*Inbox*\n${esc(args.inbox)}`, SECTION_MAX) }
      ]
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: clamp(`*Subject*\n${esc(subject)}`, SECTION_MAX) }
    }
  ];

  if (args.preview) {
    blocks.push({
      type: "section",
      // Blockquote so the email body is visually distinct from our own
      // metadata lines.
      text: { type: "mrkdwn", text: clamp(`>${esc(args.preview)}`, SECTION_MAX) }
    });
  }

  // Only render the button when we can build an absolute URL — Slack
  // rejects the whole message on a malformed button url, which would turn
  // a missing env var into zero notifications instead of link-less ones.
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  if (base) {
    const acct = encodeURIComponent(args.accountId);
    const url = `${base}/inboxes/${acct}?thread=${encodeURIComponent(args.threadId)}&acct=${acct}`;
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in DD", emoji: true },
          url,
          style: "primary"
        }
      ]
    });
  }

  if (args.sentAt) {
    const epoch = Math.floor(new Date(args.sentAt).getTime() / 1000);
    if (Number.isFinite(epoch) && epoch > 0) {
      blocks.push({
        type: "context",
        // Slack renders <!date> in each viewer's own timezone, which the
        // Karachi/Eastern split makes worth the extra syntax.
        elements: [
          {
            type: "mrkdwn",
            text: `<!date^${epoch}^Received {date_short_pretty} at {time}|${esc(args.sentAt)}>`
          }
        ]
      });
    }
  }

  // Plain-text fallback drives the notification popup + any client that
  // can't render blocks, so it has to carry the same information.
  const text = `📬 New client email — ${args.clientName}: ${subject} (from ${from}, to ${args.inbox})`;
  return { text, blocks };
}

/**
 * Evaluate one inbound message and, if it's mail from a known client, post it
 * to the #email-notifs channel. Safe to call concurrently for the same
 * message from any number of processes — exactly one post wins.
 */
export async function notifyClientEmailToSlack(
  event: InboxEvent,
  opts: { dryRun?: boolean; detail?: MissiveThreadDetail; channel?: string } = {}
): Promise<NotifyOutcome> {
  const dryRun = opts.dryRun === true;

  if (event.event !== "message:new") return skip(event, "not-message-new");
  // Without a message id there's no dedupe key, and posting unguarded would
  // mean a duplicate every time a second path delivers the same mail.
  if (!event.message_id) return skip(event, "no-message-id");
  if (!process.env.SLACK_BOT_TOKEN) return skip(event, "no-slack-token");

  const channel = opts.channel ?? (await resolveChannel());
  if (!channel) return skip(event, "no-channel");

  let detail: MissiveThreadDetail;
  try {
    detail = opts.detail ?? (await getThread(event.thread_id));
  } catch (err) {
    console.error("[client-email-slack] thread fetch failed", event.thread_id, err);
    return skip(event, "thread-fetch-failed");
  }

  const message =
    detail.messages.find((m) => m.id === event.message_id) ?? null;
  if (!message) return skip(event, "message-not-found");

  // The bus carries our own sends too — compose.js and threads.js both fire
  // `message:new` on the way out. This is the gate that keeps the channel to
  // mail we RECEIVED.
  if (message.direction !== "inbound") return skip(event, "outbound");

  // Spam/Junk. missiveclone suppresses the HMAC webhook for these, but it
  // emits the socket.io event BEFORE that check (imap.js emits at ~:408, the
  // isSpamFolder guard is at ~:417), so junk still reaches the bus via the
  // bridge. Same regex the clone uses.
  if (/spam|junk/i.test(message.folder || "")) return skip(event, "spam-folder");

  const { name: fromName, email: fromEmail } = splitAddress(message.from_addr);
  const subject = message.subject || detail.thread.subject || null;

  // The clone excludes spam/junk on the webhook path only; the socket path
  // has no such filter, so screen here regardless of how the event arrived.
  // Deliberately the NARROW filter (bounces, bot mailboxes, out-of-office),
  // not the intake cron's aggressive one — see looksUnreplyable's header for
  // why the client-match gate changes the calculus.
  if (looksUnreplyable(fromEmail, subject).filtered) {
    return skip(event, "automated-sender");
  }

  // Privacy: a shared channel can't honour per-viewer scoping, so anything
  // scoped drops out entirely rather than leaking to the channel.
  try {
    const rules = await getRestrictedSenderRules();
    if (messagesMatch(detail.messages, rules)) {
      return skip(event, "restricted-sender");
    }
  } catch (err) {
    // getRestrictedSenderRules fails open by design (see its header), but a
    // throw here would mean posting mail we couldn't screen. Skip instead.
    console.error("[client-email-slack] restricted-sender check failed", err);
    return skip(event, "restricted-sender");
  }

  try {
    const privateOwners = await getPrivateInboxOwners();
    if (privateOwners.has(event.account_id)) return skip(event, "private-inbox");
  } catch (err) {
    console.error("[client-email-slack] private-inbox check failed", err);
    return skip(event, "private-inbox");
  }

  // The whole point of the feature: only mail from someone we recognise as
  // a client. `match` (first hit) not `matchAll` — one post per email even
  // when several clients share a contact address.
  const matcher = await loadClientMatcher();
  const client = matcher.match(fromEmail);
  if (!client) return skip(event, "not-a-client");

  const inbox = await accountLabel(event.account_id);
  const post = buildPost({
    clientName: client.name,
    fromName,
    fromEmail,
    subject,
    inbox,
    preview: bodyPreview(message, 200),
    sentAt: message.sent_at ?? null,
    threadId: event.thread_id,
    accountId: event.account_id
  });

  if (dryRun) {
    return {
      status: "dry-run",
      threadId: event.thread_id,
      messageId: event.message_id,
      accountId: event.account_id,
      clientName: client.name,
      fromEmail,
      subject,
      preview: post
    };
  }

  const supabase = getSupabaseAdmin();

  // Claim before posting. Whoever inserts the row owns the Slack call.
  const { error: claimErr } = await supabase.from("slack_client_email_posts").insert({
    message_id: event.message_id,
    thread_id: event.thread_id,
    account_id: event.account_id,
    client_id: client.id,
    client_name: client.name,
    from_email: fromEmail,
    subject,
    slack_channel: channel
  });
  if (claimErr) {
    // 23505 = another path/instance got here first. Not an error.
    if (claimErr.code === "23505") return skip(event, "already-posted");
    console.error("[client-email-slack] claim insert failed", claimErr);
    return {
      status: "error",
      reason: claimErr.message,
      threadId: event.thread_id,
      messageId: event.message_id,
      accountId: event.account_id
    };
  }

  try {
    const { ts } = await postMessage(channel, post.text, post.blocks);
    await supabase
      .from("slack_client_email_posts")
      .update({ slack_ts: ts })
      .eq("message_id", event.message_id);
    return {
      status: "posted",
      threadId: event.thread_id,
      messageId: event.message_id,
      accountId: event.account_id,
      clientName: client.name,
      fromEmail,
      subject
    };
  } catch (err) {
    // Release the claim so the safety-net poll can retry. A transient Slack
    // blip (rate limit, brief outage) must not permanently swallow the
    // notification — but note this only helps while the message is still
    // inside the poll's lookback window.
    await supabase
      .from("slack_client_email_posts")
      .delete()
      .eq("message_id", event.message_id);
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[client-email-slack] postMessage failed", { channel, reason });
    return {
      status: "error",
      reason,
      threadId: event.thread_id,
      messageId: event.message_id,
      accountId: event.account_id,
      clientName: client.name
    };
  }
}

export interface ClientEmailSlackPollResult {
  channelConfigured: boolean;
  threadsExamined: number;
  posted: number;
  skipped: number;
  errors: number;
  outcomes: NotifyOutcome[];
}

/**
 * Safety net for a window where BOTH the socket bridge and the HMAC webhook
 * were down. Scans recent INBOX threads, takes each one's newest inbound
 * message, and runs anything unclaimed through notifyClientEmailToSlack.
 */
export async function pollClientEmailSlack(
  opts: { dryRun?: boolean } = {}
): Promise<ClientEmailSlackPollResult> {
  const result: ClientEmailSlackPollResult = {
    channelConfigured: false,
    threadsExamined: 0,
    posted: 0,
    skipped: 0,
    errors: 0,
    outcomes: []
  };

  const channel = await resolveChannel();
  result.channelConfigured = !!channel;
  if (!channel || !process.env.SLACK_BOT_TOKEN) return result;

  const supabase = getSupabaseAdmin();

  // Fixed lookback window, NOT "everything since the last post". A
  // high-water mark would be advanced by every message the real-time path
  // handles, which would push the floor past exactly the message that got
  // missed while the paths were down — the one case this poll exists for.
  // Re-examining the whole window each pass is safe because the claim table
  // is what prevents double-posting; the window only bounds how far back a
  // cold start reaches.
  const floor = new Date(Date.now() - FIRST_RUN_HARD_CAP_MS);

  let threads;
  try {
    threads = await listThreads({ folder: "INBOX", limit: POLL_THREAD_LIMIT });
  } catch (err) {
    console.error("[client-email-slack] poll listThreads failed", err);
    result.errors += 1;
    return result;
  }

  const fresh = threads.filter((t) => new Date(t.last_message_at) > floor);
  if (fresh.length === 0) return result;

  for (const t of fresh) {
    // Unchanged since we last looked at it — nothing new to post, and
    // fetching it again would just burn a clone round-trip. A dry run skips
    // the memo so it always renders the current window.
    if (!opts.dryRun && examinedThreads.get(t.id) === t.last_message_at) continue;

    result.threadsExamined += 1;
    let detail: MissiveThreadDetail;
    try {
      detail = await getThread(t.id);
    } catch {
      result.errors += 1;
      continue;
    }
    const msg = newestInbound(detail.messages);
    if (!msg || new Date(msg.sent_at) <= floor) {
      rememberExamined(t.id, t.last_message_at);
      continue;
    }

    // Check the claim up front rather than letting the insert fail. Saves a
    // round-trip on the common "already handled in real time" case, and
    // keeps dry runs honest — dryRun returns before the claim, so without
    // this a dry run would re-render everything already in the channel.
    const { data: claimed } = await supabase
      .from("slack_client_email_posts")
      .select("message_id")
      .eq("message_id", msg.id)
      .maybeSingle();
    if (claimed) {
      rememberExamined(t.id, t.last_message_at);
      continue;
    }

    const outcome = await notifyClientEmailToSlack(
      {
        event: "message:new",
        account_id: msg.account_id,
        thread_id: t.id,
        message_id: msg.id,
        ts: new Date(msg.sent_at).getTime()
      },
      { dryRun: opts.dryRun, detail, channel }
    );

    // Remember the thread only when the verdict is final. An "error"
    // outcome released its claim, so the next pass must look again.
    if (outcome.status !== "error") rememberExamined(t.id, t.last_message_at);

    // Only the interesting outcomes are worth returning — "not-a-client"
    // is the overwhelming majority and would bury everything else.
    if (outcome.status === "posted") result.posted += 1;
    else if (outcome.status === "error") result.errors += 1;
    else result.skipped += 1;
    if (outcome.status !== "skipped" || outcome.reason === "already-posted") {
      result.outcomes.push(outcome);
    }
  }

  return result;
}
