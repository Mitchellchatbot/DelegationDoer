import { AttentionPageView } from "@/components/exec/feed/AttentionPageView";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { listScreenedAttention, parseAttentionFilters } from "@/lib/exec/attention-read";
import type { AttentionFilters, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { draftsOnFor, loadEmailGate } from "@/lib/exec/email-view";
import { getAttentionFreshness } from "@/lib/exec/overview";
import type { ReplyStatus } from "@/lib/exec/slack-p10-types";
import { parseSlackMsgFingerprint } from "@/lib/exec/slack-read-types";
import { replyBadgesFor } from "@/lib/exec/slack-reply-view";
import type { ExecPrincipal } from "@/lib/exec/types";

// /executive/attention: the full Needs Attention feed with its filters
// (P5a contract §3.13.1, A2, C8), reached from the Overview card.
//
// The gate comes first, before any read or any output: a non-owner (or a
// session opened by a one-time sign-in link) gets Next's not-found page and
// nothing is read for them. Then three reads, each failing on its own:
//   - the first page (50) through the one screened accessor (S3); a failed
//     read is the card's "couldn't load", never an empty list;
//   - the feed's freshness, computed as the Overview computes it (the DD
//     pass's own kinds and job, and the DD text line while that is on,
//     a-correct-16);
//   - the email gate, for P4's Draft reply (its G5b predicate, as the
//     Overview card has it), and whether the feedback table exists (its
//     settings row: ddtextSchemaReady, review ui-5).
// Query parameters other than the four filters are ignored; a bad value is
// dropped (the rest are kept) and the page says some filters were ignored.
//
// No metadata export: a page title would name the feature in the HTML head.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type ReplyBadges = Record<string, { id: string; status: ReplyStatus; sentAt: string | null }>;

/** P10 (§3.5.13, v1.1 product-16): one batched read of the shown Slack message rows' reply drafts (key "<channel>:<ts>");
 *  a failure leaves every row with the plain Draft reply link. */
async function slackReplyBadges(principal: ExecPrincipal, page: ScreenedAttentionPage | null): Promise<ReplyBadges> {
  const keys = (page?.items ?? []).filter((i) => i.source === "slack").map((i) => parseSlackMsgFingerprint(i.fingerprint))
    .filter((k): k is { channelId: string; ts: string } => k !== null);
  if (keys.length === 0) return {};
  try {
    return Object.fromEntries(await replyBadgesFor(principal, keys));
  } catch {
    return {};
  }
}
const FILTER_PARAMS = ["status", "category", "band", "source"] as const;

/** The four filters from the URL: a bad or repeated value is dropped, and `ignored` says one was. */
function filtersFrom(searchParams: Record<string, string | string[] | undefined> | undefined): { filters: AttentionFilters; ignored: boolean } {
  const input: Record<string, string | undefined> = {};
  let ignored = false;
  for (const name of FILTER_PARAMS) {
    const raw = searchParams?.[name];
    if (raw === undefined) continue;
    if (typeof raw === "string") input[name] = raw;
    else ignored = true;
  }
  for (let attempt = 0; attempt <= FILTER_PARAMS.length; attempt += 1) {
    const parsed = parseAttentionFilters(input);
    if (parsed.ok) return { filters: parsed.filters, ignored };
    ignored = true;
    if (!(parsed.detail in input)) break;
    delete input[parsed.detail];
  }
  return { filters: {}, ignored: true };
}

export default async function ExecutiveAttentionPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const principal = await requireExecPrincipalForPage("GET /executive/attention");
  const { filters, ignored } = filtersFrom(searchParams);
  const now = new Date();
  const [page, freshness, gate] = await Promise.all([
    listScreenedAttention(principal, { ...filters, limit: PAGE_SIZE }, { now }).catch((): ScreenedAttentionPage | null => null),
    getAttentionFreshness(principal, now).catch(() => ({ ok: false, error: "unavailable" }) as const),
    loadEmailGate(principal).catch(() => null)
  ]);
  const draftsAvailable = gate !== null && gate.kind === "on" && draftsOnFor(gate.settings);
  // Review ui-5: no feedback controls while exec_attention_feedback is missing (the P5a
  // migration not applied); an unreadable settings row leaves them on (the route answers).
  const feedbackAvailable = gate === null || gate.settings.ddtextSchemaReady;
  // P5b (C33): Ask AI on every row while chat is installed and on; an unreadable settings row leaves it off.
  const askAiEnabled = gate !== null && gate.settings.chatSchemaReady && gate.settings.chatEnabled;
  // P10 (§3.5.13): Slack message rows offer Draft reply while Slack reply drafts are installed and on.
  const slackRepliesAvailable = gate !== null && gate.settings.slackP10SchemaReady && gate.settings.slackRepliesEnabled;
  const replyBadges = slackRepliesAvailable ? await slackReplyBadges(principal, page) : {};
  return (
    <AttentionPageView
      page={page}
      filters={filters}
      now={now.toISOString()}
      tz={principal.timezone}
      checkedAt={freshness.ok ? freshness.data.checkedAt : null}
      ddtextCheckedAt={freshness.ok ? freshness.data.ddtextCheckedAt : null}
      draftsAvailable={draftsAvailable}
      ignoredParams={ignored}
      freshnessUnavailable={!freshness.ok}
      feedbackAvailable={feedbackAvailable}
      askAiEnabled={askAiEnabled}
      slackRepliesAvailable={slackRepliesAvailable}
      replyBadges={replyBadges}
    />
  );
}
