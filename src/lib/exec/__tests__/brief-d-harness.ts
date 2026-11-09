import { vi } from "vitest";

import { BRIEF_TEXT_SENTINELS } from "@/lib/exec/__tests__/brief-assert";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import type { BriefOwnershipRead } from "@/lib/exec/brief-ownership-load";
import type { BriefContent, BriefOwnerReason, BriefOwner } from "@/lib/exec/brief-types";
import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import type { InstallationRow, OpenInstallation } from "@/lib/exec/slack-types";
import type { ExecPrincipal, ExecSettings, JobContext } from "@/lib/exec/types";
import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";

// P8 Area D test support: the principal, installation, settings, rows and content the delivery, watchdog, sweep and check-in
// tests share. Every Slack token here is a fake in Slack's format; every content string carries a brief-assert sentinel so a
// test can prove it never reaches a log, an ops alert, a job result or the wrong Slack surface.

export const NOW = new Date("2026-11-09T13:20:00.000Z");      // 08:20 in New York (EST)
export const LOCAL_DATE = "2026-11-09";
export const SCHEDULED_AT = "2026-11-09T13:00:00.000Z";       // 08:00 local
export const TZ = "America/New_York";
export const BOT_TOKEN = "xoxb-FAKE-exec-bot-token-0001";
export const DD_BOT_TOKEN = "xoxb-FAKE-dd-bot-token-0002";
export const USER_TOKEN = "xoxp-FAKE-mitchell-user-token-0003";
export const INSTALLATION_ID = `esi_${"1".padStart(32, "0")}`;
export const DM = "D0MITCH";
export const TEAM = "T0SCALED";
export const MITCH_SLACK = "U0MITCH";
export const BRIEF_ID = `eb_${"a".repeat(32)}`;
export const hex = (n: number): string => n.toString(16).padStart(32, "0");
export const checkinId = (n: number): string => `ebc_${hex(n)}`;

export const PRINCIPAL = Object.freeze({
  id: "ep_1", userId: "u_mitch", email: "mitchell@scaledai.org", name: "Mitchell Owner", timezone: TZ, briefTimezone: TZ, workTimezone: TZ,
  mailAccountIds: Object.freeze([]), slackTeamId: null, slackUserId: null
}) as unknown as ExecPrincipal;

export function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return { ...DEFAULT_SETTINGS, principalId: PRINCIPAL.id, briefEnabled: true, supersedeLegacyBrief: true, checkinsEnabled: true, retentionDaysChat: 30, ...over };
}

export function installation(over: Partial<InstallationRow> = {}): InstallationRow {
  return {
    id: INSTALLATION_ID, principalId: PRINCIPAL.id, teamId: TEAM, appId: "A0EXEC", botUserId: "U0BOT", botId: "B0BOT", keyId: "abcd0123",
    botScopes: [], userId: MITCH_SLACK, dmChannelId: DM, installedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    revokedAt: null, revokeReason: null, lastDmAt: null, lastErrorCode: null, lastErrorAt: null, purgedAt: null, hasToken: true, ...over
  };
}

/** An opened installation as slack-install.ts hands it over (tests only: B-P8-12 covers production code). */
export function openInstallation(over: Partial<InstallationRow> = {}): OpenInstallation {
  const row = installation(over);
  return { row, target: Object.freeze({ token: BOT_TOKEN, dmChannelId: row.dmChannelId }) };
}

export function ownership(owner: BriefOwner = "exec", reason: BriefOwnerReason = "owns", brief: BriefOwnershipRead["brief"] = null): BriefOwnershipRead {
  return {
    verdict: { owner, reason },
    facts: { execEnabled: true, tablesReady: true, briefEnabled: true, supersede: true, installationActive: true, execDeliveredToday: false, legacyDeliveredToday: false },
    localDate: LOCAL_DATE, brief, installation: installation()
  };
}

const ref = (id: string, url: string | null, system: "dd" | "outlook" | "slack" = "dd") => ({ system, id, url, label: "Open", class: "internal" as const });

/** A built brief's content: one email line (thread t_1), one Slack line (channel C0SALES), one DD line, a pending line, a top 3. */
export function briefContent(over: Partial<BriefContent> = {}): BriefContent {
  const item = (id: string, text: string, extra: Record<string, unknown>) => ({
    id, text, kind: "fact", basis: "ai", band: "high", aliases: [`i${id.slice(1)}`], fps: [`fp:${id}`], refs: [], threadIds: [], slackKeys: [],
    slackChannels: [], ...extra
  });
  return {
    v: 1, localDate: LOCAL_DATE, tz: TZ, rev: 1, builtAt: "2026-11-09T13:01:00.000Z", trigger: "schedule", mode: "ai", modeReason: null,
    top3Fallback: false, headline: `Headline ${BRIEF_TEXT_SENTINELS.briefLine}`,
    sections: [
      { key: "emails", state: "ok", stateNote: null, unchanged: 1, more: 0, stats: {},
        items: [item("b1", `Reply to the lawyer ${BRIEF_TEXT_SENTINELS.emailSubject}`, { refs: [ref("t_1", "https://outlook.office.com/mail/x", "outlook")], threadIds: ["t_1"] })],
        pending: [] },
      { key: "slack", state: "ok", stateNote: null, unchanged: 0, more: 0, stats: {},
        items: [item("b2", `Sales asked about pricing ${BRIEF_TEXT_SENTINELS.digestSummary}`, {
          refs: [ref("C0SALES:1794000000.000100", "https://scaledai.slack.com/archives/C0SALES/p1794000000000100", "slack")],
          slackKeys: ["m:C0SALES:1794000000.000100"], slackChannels: ["C0SALES"] })],
        pending: [] },
      { key: "work", state: "ok", stateNote: null, unchanged: 0, more: 0, stats: {},
        items: [item("b3", "Ship the onboarding checklist", { kind: "recommendation", refs: [ref("task_1", "https://operations.scaledai.org/tasks/task_1")] })],
        pending: [{ fp: "dd:approval:email_drafts", title: "Approve 2 email drafts", band: "normal", since: null, refs: [], threadIds: [], slackKeys: [], slackChannels: [] }] }
    ],
    top3: [{ itemId: "b3", alias: "i3", fp: "fp:b3", title: "Ship the onboarding checklist", next: "Assign it today", refs: [ref("task_1", "https://operations.scaledai.org/tasks/task_1")],
      threadIds: [], slackKeys: [], slackChannels: [] }],
    novelty: {}, counts: { new: 2, changed: 1, escalated: 0, pending: 1, unchanged: 1, restrictedEmail: 2, slackUnanswered: 1 }, failures: [],
    ...over
  } as unknown as BriefContent;
}

/** A snake_case exec_briefs row for the fake (status fields consistent with the CHECKs). */
export function briefRowSeed(status: string, over: Row = {}): Row {
  const built = { mode: "ai", built_at: "2026-11-09T13:01:00.000Z", novelty_marked_at: "2026-11-09T13:01:00.000Z", build_started_at: "2026-11-09T13:00:05.000Z" };
  const base: Row = {
    id: BRIEF_ID, principal_id: PRINCIPAL.id, local_date: LOCAL_DATE, tz: TZ, scheduled_at: SCHEDULED_AT, rev: 1, status,
    owner: "exec", owner_reason: "owns", content: status === "building" || status === "failed" ? null : briefContent(),
    ...(status === "building" || status === "failed" ? {} : { ref_thread_ids: ["t_1"], ref_slack_keys: ["m:C0SALES:1794000000.000100"], ref_slack_channels: ["C0SALES"] }),
    content_expires_at: "2026-12-10T05:00:00.000Z", expires_at: "2027-05-09T05:00:00.000Z", created_at: "2026-11-09T13:00:01.000Z",
    updated_at: "2026-11-09T13:01:00.000Z"
  };
  const byStatus: Record<string, Row> = {
    building: { build_started_at: "2026-11-09T13:00:05.000Z" },
    failed: {},
    built: built,
    page_only: { ...built, status_reason: "not_superseding" },
    delivering: { ...built, delivery_started_at: "2026-11-09T13:02:00.000Z", post_attempts: 1 },
    delivery_unknown: { ...built, delivery_started_at: "2026-11-09T13:02:00.000Z", post_attempts: 2, status_reason: "ambiguous_twice" },
    delivered: { ...built, delivery_started_at: "2026-11-09T13:02:00.000Z", post_attempts: 1, delivered_at: "2026-11-09T13:02:01.000Z", slack_channel_id: DM,
      slack_ts: "1794000001.000100" }
  };
  return { ...base, ...byStatus[status], ...over };
}

export function checkinSeed(n: number, over: Row = {}): Row {
  return {
    id: checkinId(n), brief_id: BRIEF_ID, principal_id: PRINCIPAL.id, local_date: LOCAL_DATE, brief_rev: 1, rev: 1, recipient_user_id: `u_${n}`,
    recipient_slack_id: `U0P${n}`, text: `How are you doing this week? ${BRIEF_TEXT_SENTINELS.checkinText}`, status: "proposed",
    expires_at: "2026-11-11T13:01:00.000Z", purge_at: "2026-12-09T13:01:00.000Z", created_at: "2026-11-09T13:01:00.000Z", updated_at: "2026-11-09T13:01:00.000Z",
    ...over
  };
}

export function ctxFor(kind: string, payload: Record<string, unknown>, principal: ExecPrincipal | null = PRINCIPAL, signal?: AbortSignal): JobContext {
  return { job: jobRow({ kind, payload, principal_id: principal?.id ?? null }), principal, signal: signal ?? new AbortController().signal, workerId: "w-test" };
}

/** Runs p while advancing the fake timers in 500 ms steps until it settles (a 3 s recheck, a Retry-After, a hung call's 10 s). */
export async function settle<T>(p: Promise<T>, maxMs = 120_000): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let t = 0; t < maxMs && !done; t += 500) await vi.advanceTimersByTimeAsync(500);
  return p;
}
