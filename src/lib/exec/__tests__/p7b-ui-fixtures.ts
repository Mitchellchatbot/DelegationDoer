import channelsJson from "./fixtures/slack-intel/channels.json";
import { INTEL_SENTINELS } from "./slack-intel-assert";
import type { ChannelRow, SlackChannelLink, SlackDigestRow, SlackItemRow } from "@/lib/exec/slack-intel-types";
import type { CatchUpRow, DigestCardView, SlackPageView } from "@/lib/exec/slack-page";
import type { ProjectSlackSection, SlackProjectRow } from "@/lib/exec/slack-projects";
import type { ExecPrincipal } from "@/lib/exec/types";

// Area F's UI fixtures (P7b contract §5.13): typed builders over the lead's frozen fixtures (channels.json, the
// INTEL_SENTINELS). Test support only; nothing here is run as a test.

export const NOW_ISO = channelsJson.now; // 2026-11-08T15:00:00.000Z, a Sunday 10:00 EST
export const NOW = new Date(NOW_ISO);
export const TZ = channelsJson.tz; // America/New_York

export type ChannelKey = keyof typeof channelsJson.rows;
export const channel = (key: ChannelKey, over: Partial<ChannelRow> = {}): ChannelRow => ({ ...(channelsJson.rows[key] as unknown as ChannelRow), ...over });
export const CHANNEL_KEYS = Object.keys(channelsJson.rows) as ChannelKey[];

export const principal = Object.freeze({
  id: "ep_owner",
  userId: "u_owner",
  email: "owner@scaledai.org",
  name: "Mitchell",
  timezone: TZ
}) as unknown as ExecPrincipal;

const SLACK_ARCHIVE = "https://scaledai.slack.com/archives";
export const permalinkFor = (channelId: string, ts: string) => `${SLACK_ARCHIVE}/${channelId}/p${ts.replace(".", "")}`;

let seq = 0;
const hex = (n: number) => n.toString(16).padStart(32, "0");

/** One stored P7a item: an assessed request to him in #acme-dental-seo, an hour before NOW, with an excerpt. */
export function slackItem(over: Partial<SlackItemRow> = {}): SlackItemRow {
  seq += 1;
  const ts = over.ts ?? `${Math.floor(NOW.getTime() / 1000) - 3600 - seq}.000100`;
  const channelId = over.channelId ?? "C0ACMESEO";
  return {
    id: `esi_${hex(seq)}`,
    channelId,
    ts,
    kind: "request",
    threadTs: null,
    authorUserId: "U0ALICE",
    authorLabel: INTEL_SENTINELS.authorName,
    authorExternal: false,
    assessed: true,
    addressedToYou: true,
    needsResponse: true,
    bypassMute: false,
    urgency: "normal",
    summary: "Asks you to approve the October SEO report.",
    excerpt: "can you sign off on the october report today?",
    dueText: null,
    dueAt: null,
    commitmentDirection: null,
    sourceClass: "public",
    permalink: permalinkFor(channelId, ts),
    respondedTs: null,
    respondedAt: null,
    acknowledgedAt: null,
    expiresAt: "2027-02-06T15:00:00.000Z",
    createdAt: new Date(NOW.getTime() - 3_000_000).toISOString(),
    ...over
  };
}

export function catchUpRow(over: Partial<CatchUpRow> = {}): CatchUpRow {
  return {
    itemId: "esi_00000000000000000000000000000001",
    kind: "request",
    channelLabel: "#acme-dental-seo",
    privacy: "public",
    at: "2026-11-08T14:00:00.000Z",
    summary: "Asks you to approve the October SEO report.",
    quote: "can you sign off on the october report today?",
    assessed: true,
    permalink: permalinkFor("C0ACMESEO", "1794146400.000100"),
    ageLabel: "1 h ago",
    ...over
  };
}

export function digestCard(over: Partial<DigestCardView> = {}): DigestCardView {
  return {
    digestId: "esd_00000000000000000000000000000001",
    channelId: "C0ACMESEO",
    channelLabel: "#acme-dental-seo",
    privacy: "public",
    date: "2026-11-07",
    status: "built",
    summary: "The team finished the October report and asked when the next audit starts.",
    highlights: [{ text: "October report finished.", permalink: null }],
    decisions: [{ text: "Audit moves to Tuesday.", permalink: null }],
    openQuestions: [{ text: "Who reviews the backlinks?", permalink: null }],
    counts: { human: 5, bot: 2, ddPost: 1, external: 1, threads: 1 },
    partial: false,
    canBuild: false,
    clientName: null,
    ...over
  };
}

export function slackPageView(over: Partial<SlackPageView> = {}): SlackPageView {
  return {
    generatedAt: NOW_ISO,
    timezone: TZ,
    state: "ok",
    date: {
      selected: "yesterday",
      label: "Yesterday",
      options: [
        { value: "today", label: "Today" },
        { value: "yesterday", label: "Yesterday" },
        { value: "2026-11-06", label: "Fri, Nov 6" },
        { value: "2026-11-05", label: "Thu, Nov 5" },
        { value: "2026-11-04", label: "Wed, Nov 4" },
        { value: "2026-11-03", label: "Tue, Nov 3" },
        { value: "2026-11-02", label: "Mon, Nov 2" }
      ]
    },
    catchUp: { ok: true, data: { rows: [catchUpRow()], total: 1, hiddenMuted: 0 } },
    digests: { ok: true, data: { cards: [digestCard()], channelsWithoutDigest: 0 } },
    counts: { ok: true, data: { unanswered: 3, decisionsPending: 1, notAssessed: 2 } },
    ...over
  };
}

export function link(over: Partial<SlackChannelLink> = {}): SlackChannelLink {
  return {
    channelId: "C0ACMESEO",
    tagClientId: null,
    tagClientName: null,
    tagProjectIds: [],
    taggedAt: null,
    clientId: null,
    clientName: null,
    clientMatchVia: null,
    matchConfidence: null,
    clientCandidates: 0,
    ...over
  };
}

export function digestRow(over: Partial<SlackDigestRow> = {}): SlackDigestRow {
  return {
    id: "esd_00000000000000000000000000000001",
    channelId: "C0ACMESEO",
    localDate: "2026-11-07",
    tz: TZ,
    fromTs: "1794027600.000000",
    toTs: "1794114000.000000",
    status: "built",
    summary: "A built digest.",
    highlights: [],
    decisions: [],
    openQuestions: [],
    sourceTs: [],
    counts: { human: 1, bot: 0, ddPost: 0, external: 0, threads: 0 },
    privacy: "public",
    partial: false,
    fullDay: true,
    injectionSuspected: false,
    rebuilds: 0,
    model: "claude-haiku-5-5",
    costUsd: 0.001,
    requestedAt: "2026-11-08T05:30:00.000Z",
    builtAt: "2026-11-08T05:31:00.000Z",
    expiresAt: "2027-02-06T05:31:00.000Z",
    ...over
  };
}

export function projectRow(over: Partial<SlackProjectRow> = {}): SlackProjectRow {
  return {
    itemId: "esi_00000000000000000000000000000002",
    digestId: null,
    kind: "request",
    channelLabel: "#acme-dental-seo",
    privacy: "public",
    at: "2026-11-08T13:00:00.000Z",
    summary: "Asks for the launch checklist.",
    basis: "record",
    via: "link",
    permalink: permalinkFor("C0ACMESEO", "1794142800.000100"),
    ...over
  };
}

export function projectSlack(over: Partial<ProjectSlackSection> = {}): ProjectSlackSection {
  return {
    state: "ok",
    linked: [projectRow()],
    clientChannels: [projectRow({ itemId: "esi_00000000000000000000000000000003", basis: "derived", via: "client_channel", summary: "Client asks about the DNS change." })],
    mentions: [projectRow({ itemId: "esi_00000000000000000000000000000004", basis: "ai", via: "mention", summary: "Mentions the Acme site rebuild timeline." })],
    derivedClientName: "Acme",
    ...over
  };
}
