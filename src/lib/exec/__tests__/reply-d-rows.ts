import type { ChannelRow, SlackItemRow } from "@/lib/exec/slack-read-types";

// P10 Area D test rows: P7a's ChannelRow and SlackItemRow as slack-read-store returns them (camelCase), for tests that mock
// getChannel / listItemsForMessage / getSlackItemsByIds at P7a's module boundary. Invented names only.

export function channelRow(channelId: string, over: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channelId, installationId: `esi_${"a".repeat(32)}`, convType: "channel", class: "standard", denyReason: null, hubKind: null, financeName: false,
    watchState: "watched", muteSource: null, watchSetByOwnerAt: null, name: "zenith-house-ops", imUserId: null, isMember: true, isPrivate: false,
    isExtShared: false, extEver: false, isArchived: false, histWatermarkTs: null, deepSweptAt: null, sweptAt: null, lastEventTs: null,
    lastActivityTs: null, activity30d: null, probedAt: null, classifiedAt: null, leftAt: null, updatedAt: "2026-11-10T00:00:00.000Z", ...over
  };
}

export function itemRow(channelId: string, ts: string, over: Partial<SlackItemRow> = {}): SlackItemRow {
  return {
    id: `esl_${"1".padStart(32, "0")}`, channelId, ts, kind: "question", threadTs: null, authorUserId: "U0JANE", authorLabel: "Jane",
    authorExternal: false, assessed: true, addressedToYou: true, needsResponse: true, bypassMute: false, urgency: "high",
    summary: "Jane asks whether Friday works for the Zenith House review.", excerpt: null, dueText: null, dueAt: null, commitmentDirection: null,
    sourceClass: "public", permalink: `https://scaledai.slack.com/archives/${channelId}/p${ts.replace(".", "")}`, respondedTs: null, respondedAt: null,
    acknowledgedAt: null, expiresAt: "2026-12-10T00:00:00.000Z", createdAt: "2026-11-10T14:00:00.000Z", ...over
  };
}
