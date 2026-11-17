import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));

import { slackReadingView } from "@/lib/exec/__tests__/p5a-ui-fixtures";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import {
  P10_NOTICES,
  SlackP10Controls,
  noticeBody,
  p10Disabled,
  p10Rows,
  readAllOpensLines,
  readAllStatusText,
  saveP10Setting,
  sendConnectionText,
  voiceStateText
} from "@/components/exec/settings/SlackP10Controls";
import { DmNudges, SlackReadingSection } from "@/components/exec/settings/SlackReadingSection";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { SlackP10ReadingPart, SlackReadingView } from "@/lib/exec/slack-types";
import type { SettingsSaveResult } from "@/lib/exec/ui/settings-api";

// P10 §5.13 RU14, §5.1 RA13, §5.12 ST10 and C9 (contract §3.7.5; Area B): the P10 Settings controls, rendered with
// renderToStaticMarkup (client islands render their first paint on the server). Invented names only.

const S = SLACK_P10_COPY.settings;
const NOW = "2026-11-10T15:00:00.000Z";
const TZ = "America/New_York";
const VERSION = "2026-11-10T14:00:00.123456+00:00";
const part = (over: Partial<SlackP10ReadingPart> = {}): SlackP10ReadingPart => ({
  schemaReady: true, readAll: false, leadCounts: false, replies: false, replySend: false, replyAuto: false, replyCapUsd: 1.5, voice: true, financeWatched: 0,
  leadCoverage: null, leadRun: null, retentionDaysSlack: 90, readAllPending: false,
  readAllOpens: { labels: ["#acme-payroll", "#zenith-house-finance", "#zenith-house-ops"], more: 0 }, voiceState: { state: "none" }, tokenHealth: null,
  readingPaused: false, ...over
});
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const controls = (p: SlackP10ReadingPart, kind: "readAll" | "rest" = "rest", extra: Record<string, unknown> = {}) =>
  html(createElement(SlackP10Controls, { part: kind, p10: p, version: VERSION, tz: TZ, now: NOW, ...extra }));

beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
});

describe("RU14 SlackP10Controls: the rows, the disabled states, the state lines", () => {
  it("the notice, then lead counts, replies, sending, automatic drafts and style learning in §3.7.2's order; the budget only while auto is on", () => {
    const h = controls(part());
    expect(text(h)).toContain(S.notice);
    const order = ["slackLeadCountsEnabled", "slackRepliesEnabled", "slackReplySendEnabled", "slackReplyAuto", "slackVoiceEnabled"].map((k) => h.indexOf(`data-p10-row="${k}"`));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expect(h).not.toContain('data-p10-row="slackReplyDailyCapUsd"');
    expect(h).not.toContain('data-p10-row="slackReadAll"');
    expect(controls(part({ replies: true, replyAuto: true }))).toContain('data-p10-row="slackReplyDailyCapUsd"');
    expect(p10Rows("rest", part({ replyAuto: true })).map((r) => r.key)).toEqual(["slackLeadCountsEnabled", "slackRepliesEnabled", "slackReplySendEnabled",
      "slackReplyAuto", "slackReplyDailyCapUsd", "slackVoiceEnabled"]);
  });
  it("sending, automatic drafts and style learning are greyed with needsReplies while replies are off (product-12)", () => {
    const h = controls(part());
    for (const k of ["slackReplySendEnabled", "slackReplyAuto", "slackVoiceEnabled"]) {
      expect(h, k).toContain(`data-p10-why="${k}"`);
      expect(h).toMatch(new RegExp(`data-p10-switch="${k}"[^>]*disabled=""`));
    }
    expect(text(h)).toContain(S.needsReplies.replace(/"/g, "\""));
    expect(p10Disabled(part({ replies: true }), "slackReplySendEnabled")).toBeNull();
    expect(p10Disabled(part(), "slackLeadCountsEnabled")).toBeNull();
    const on = controls(part({ replies: true }));
    expect(on).not.toContain('data-p10-why="slackReplySendEnabled"');
  });
  it("while reading is paused every switch says startsWhenReading (product-13)", () => {
    const h = controls(part({ readingPaused: true }));
    expect(h.split(S.startsWhenReading).length - 1).toBe(5);
    expect(controls(part())).not.toContain(S.startsWhenReading);
  });
  it("the send switch shows his DD Slack connection in P8's words (product-4); the style's state line (product-12)", () => {
    expect(sendConnectionText(part(), TZ, NOW)).toBe("Slack connection: Not checked yet");
    expect(sendConnectionText(part({ tokenHealth: { state: "mismatch", checkedAt: NOW } }), TZ, NOW)).toBe("Slack connection: Not yours: check-ins paused");
    expect(sendConnectionText(part({ tokenHealth: { state: "ok", checkedAt: NOW } }), TZ, NOW)).toMatch(/^Slack connection: Yours, checked /);
    expect(controls(part({ replies: true }))).toContain('data-p10-send-connection');
    expect(voiceStateText(part(), TZ, NOW)).toBe(S.voiceNone);
    expect(voiceStateText(part({ voiceState: { state: "ready", samples: 42, builtAt: "2026-11-08T09:40:00.000Z" } }), TZ, NOW)).toBe("Learned from 42 of your messages on Nov 8.");
    expect(voiceStateText(part({ voiceState: { state: "insufficient", fallback: "email" } }), TZ, NOW)).toBe(S.voiceInsufficientEmail);
    expect(voiceStateText(part({ voiceState: { state: "insufficient", fallback: "house" } }), TZ, NOW)).toBe(S.voiceInsufficientHouse);
    expect(voiceStateText(part({ voiceState: { state: "failed", reason: "budget", fallback: "house" } }), TZ, NOW)).toBe("Couldn't learn it (the daily AI budget was used up).");
    expect(voiceStateText(part({ voiceState: null }), TZ, NOW)).toBeNull();
  });
  it("framed: the values as text and no button; not installed: the one line", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    const h = controls(part());
    expect(h).toContain("data-p10-framed");
    expect(h).not.toContain("<button");
    vi.mocked(useIsTopWindow).mockReturnValue(true);
    expect(controls(part({ schemaReady: false }))).toContain(S.notInstalled.replace(/'/g, "&#x27;"));
    expect(controls(part({ schemaReady: false }), "readAll")).toBe("");
  });
});

describe("RA13 the read-all switch and its confirm (security-5, product-14)", () => {
  it("the switch with its label; readAllUpdating while pending, else the finance count while on; the off-help while on", () => {
    expect(text(controls(part(), "readAll"))).toContain(S.readAllLabel);
    expect(readAllStatusText(part({ readAllPending: true }))).toBe(S.readAllUpdating);
    expect(readAllStatusText(part({ readAll: true, financeWatched: 3 }))).toBe("3 finance, HR or legal channels you're in are read.");
    expect(readAllStatusText(part())).toBeNull();
    expect(controls(part({ readAll: true, readAllPending: true }), "readAll")).toContain(S.readAllUpdating);
    expect(controls(part({ readAll: true }), "readAll")).toContain("data-p10-read-all-off-help");
  });
  it("its confirm lists every channel it will open, +N more past 50, and Mute any channel first; nothing to open → none of the three", () => {
    const open = controls(part(), "readAll", { initialDialog: "readAll" });
    const t = text(open);
    expect(t).toContain(S.readAllConfirmTitle);
    expect(t).toContain("It will start reading these 3 channels:");
    for (const l of ["#acme-payroll", "#zenith-house-finance", "#zenith-house-ops"]) expect(open).toContain(`>${l}</li>`);
    expect(open.split("data-p10-read-all-open=").length - 1).toBe(3);
    expect(open).toContain(S.readAllConfirmMuteFirst);
    expect(open).not.toContain("data-p10-read-all-more");
    const many = readAllOpensLines({ readAllOpens: { labels: Array.from({ length: 50 }, (_, k) => `#c-${k}`), more: 12 } });
    expect(many).toMatchObject({ intro: "It will start reading these 62 channels:", more: "+12 more" });
    expect(readAllOpensLines({ readAllOpens: { labels: [], more: 0 } })).toBeNull();
    const nothing = controls(part({ readAllOpens: { labels: [], more: 0 } }), "readAll", { initialDialog: "readAll" });
    expect(nothing).not.toContain("data-p10-read-all-opens");
    expect(nothing).not.toContain(S.readAllConfirmMuteFirst);
    expect(nothing).toContain(S.readAllConfirmCheck.replace(/'/g, "&#x27;"));
  });
  it("P10 fixer security-2: when the list couldn't be read (readAllOpens null), the confirm says so and can't be confirmed, even ticked", () => {
    const failed = controls(part({ readAllOpens: null }), "readAll", { initialDialog: "readAll", initialChecked: true });
    expect(text(failed)).toContain(S.readAllConfirmUnknown.replace(/'/g, "'"));
    expect(failed).toContain("data-p10-read-all-unknown");
    expect(failed).toMatch(/data-p10-confirm-turn-on="readAll"[^>]*disabled=""/);
    expect(failed).not.toContain("data-p10-read-all-opens");
    // An empty list (nothing to open) is not unknown: no line, and the ticked confirm turns on.
    const empty = controls(part({ readAllOpens: { labels: [], more: 0 } }), "readAll", { initialDialog: "readAll", initialChecked: true });
    expect(empty).not.toContain("data-p10-read-all-unknown");
    expect(empty).not.toMatch(/data-p10-confirm-turn-on="readAll"[^>]*disabled=""/);
    // Only the read-all confirm cares: the other notices never show it.
    const leads = controls(part({ readAllOpens: null }), "rest", { initialDialog: "leads", initialChecked: true });
    expect(leads).not.toContain("data-p10-read-all-unknown");
    expect(leads).not.toMatch(/data-p10-confirm-turn-on="leads"[^>]*disabled=""/);
  });
  it("P10 fixer ui-10 / ui-9: one channel in the singular; the controls' words come from the copy", () => {
    expect(readAllStatusText(part({ readAll: true, financeWatched: 1 }))).toBe("1 finance, HR or legal channel you're in is read.");
    expect(readAllOpensLines({ readAllOpens: { labels: ["#acme-payroll"], more: 0 } })?.intro).toBe("It will start reading this channel:");
    expect(readAllOpensLines({ readAllOpens: { labels: [], more: 1 } })?.intro).toBe("It will start reading this channel:");
    const h = controls(part(), "readAll", { initialDialog: "readAll" });
    expect(text(h)).toContain(S.turnOn);
    expect(text(h)).toContain(S.cancel);
    const src = readFileSync(fileURLToPath(new URL("../../../components/exec/settings/SlackP10Controls.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/"Saving…"|"Turn on"|>\s*Cancel\s*<|"On"|"Off"/);
  });
  it("each notice switch's confirm: its title, body ({days} filled), checkbox and Turn on (disabled until checked)", () => {
    for (const notice of ["leads", "replies", "send"] as const) {
      const h = controls(part({ replies: notice === "send" }), "rest", { initialDialog: notice });
      expect(h, notice).toContain(`data-p10-confirm="${notice}"`);
      expect(text(h)).toContain(P10_NOTICES[notice].title.replace(/'/g, "'"));
      expect(h).toMatch(new RegExp(`data-p10-confirm-turn-on="${notice}"[^>]*disabled=""`));
      expect(controls(part({ replies: notice === "send" }), "rest", { initialDialog: notice, initialChecked: true })).not.toMatch(new RegExp(`data-p10-confirm-turn-on="${notice}"[^>]*disabled=""`));
    }
    expect(noticeBody("leads", part({ retentionDaysSlack: 30 }))).toContain("for 30 days");
  });
});

describe("saveP10Setting: the version follow-up (P8's rule)", () => {
  const saved = { kind: "saved", view: { version: "v2" }, message: "Saved." } as unknown as SettingsSaveResult;
  it("a 409 whose field still reads what this control showed is resent once on the new version; a real conflict is returned", async () => {
    const calls: unknown[] = [];
    const conflict = (value: unknown) => ({ kind: "conflict", view: { version: "v9", settings: { slackLeadCountsEnabled: value } }, message: "Changed." }) as unknown as SettingsSaveResult;
    const patch = vi.fn(async (b: unknown) => {
      calls.push(b);
      return calls.length === 1 ? conflict(false) : saved;
    });
    expect(await saveP10Setting("slackLeadCountsEnabled", true, "v1", false, "slack_lead_counts_notice", patch as never)).toBe(saved);
    expect(calls).toEqual([
      { patch: { slackLeadCountsEnabled: true }, expectedVersion: "v1", confirm: "slack_lead_counts_notice" },
      { patch: { slackLeadCountsEnabled: true }, expectedVersion: "v9", confirm: "slack_lead_counts_notice" }
    ]);
    const real = vi.fn(async () => conflict(true));
    expect((await saveP10Setting("slackLeadCountsEnabled", true, "v1", false, "slack_lead_counts_notice", real as never)).kind).toBe("conflict");
    expect(real).toHaveBeenCalledTimes(1);
    const bad = vi.fn();
    expect((await saveP10Setting("slackReplyDailyCapUsd", 25, "v1", 1.5, undefined, bad as never)).kind).toBe("failed");
    expect(bad).not.toHaveBeenCalled();
  });
});

const view = (over: Partial<SlackReadingView> = {}): SlackReadingView =>
  slackReadingView({ state: "on", switchOn: true, settingsVersion: VERSION, installationId: `esi_${"a".repeat(32)}`, dmsGranted: true, groupDmsGranted: true,
    p10: part(), ...over });

describe("RU14 placement and C9's nudge in SlackReadingSection", () => {
  it("the read-all switch directly under the radio group (inside the picker), the rest above the picker's rows", () => {
    const h = html(createElement(SlackReadingSection, { view: view(), tz: TZ, now: NOW }));
    const radio = h.indexOf('role="radiogroup"');
    const readAll = h.indexOf('data-p10-row="slackReadAll"');
    const rest = h.indexOf('data-p10-controls="rest"');
    const rows = h.indexOf("data-picker-rows");
    expect(radio).toBeGreaterThan(0);
    expect(readAll).toBeGreaterThan(radio);
    expect(readAll).toBeLessThan(h.indexOf("data-picker-summary"));
    expect(rest).toBeGreaterThan(0);
    expect(rest).toBeLessThan(rows);
    expect(h).toContain(S.heading);
  });
  it("not rendered for the other states; P7a's view without p10 still renders", () => {
    expect(html(createElement(SlackReadingSection, { view: view({ state: "discovering" }), tz: TZ, now: NOW }))).not.toContain("data-p10-controls");
    expect(html(createElement(SlackReadingSection, { view: view({ p10: undefined }), tz: TZ, now: NOW }))).not.toContain("data-p10-controls");
  });
  it("C9: the DM and group-DM nudges with Allow reading again (the read re-consent), only for the missing scopes", () => {
    const h = html(createElement(SlackReadingSection, { view: view({ dmsGranted: false, groupDmsGranted: false }), tz: TZ, now: NOW }));
    expect(text(h)).toContain(S.dmNudge);
    expect(text(h)).toContain(S.groupDmNudge);
    expect(h).toContain('href="/api/integrations/exec-slack/start?purpose=read"');
    expect(h).toContain(S.allowAgain);
    const one = html(createElement(DmNudges, { view: { dmsGranted: true, groupDmsGranted: false }, onCanonicalHost: true }));
    expect(text(one)).not.toContain(S.dmNudge);
    expect(text(one)).toContain(S.groupDmNudge);
    expect(html(createElement(DmNudges, { view: { dmsGranted: true, groupDmsGranted: true }, onCanonicalHost: true }))).toBe("");
    expect(html(createElement(DmNudges, { view: { dmsGranted: false, groupDmsGranted: true }, onCanonicalHost: false }))).not.toContain("href=");
  });
});

describe("ST10 the Stop-reading dialog says stopAlso while P10 is installed", () => {
  it("appended to the body when p10.schemaReady; absent otherwise", () => {
    const on = html(createElement(SlackReadingSection, { view: view(), tz: TZ, now: NOW, initialDialog: "stop" }));
    expect(on).toContain("data-reading-stop-also");
    expect(on).toContain(S.stopAlso);
    const off = html(createElement(SlackReadingSection, { view: view({ p10: part({ schemaReady: false }) }), tz: TZ, now: NOW, initialDialog: "stop" }));
    expect(off).not.toContain("data-reading-stop-also");
  });
});

describe("B-P10-13 SlackP10Controls is a client island with client-safe imports only", () => {
  it('"use client", and no server-only module among its imports', () => {
    const src = readFileSync(fileURLToPath(new URL("../../../components/exec/settings/SlackP10Controls.tsx", import.meta.url)), "utf8");
    expect(src.startsWith('"use client";')).toBe(true);
    const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const s of specs) expect(s, s).not.toMatch(/server-only|supabase|-store$|\/jobs$|\/principal$|slack-install|slack-leads-view|slack-reading-settings/);
  });
});
