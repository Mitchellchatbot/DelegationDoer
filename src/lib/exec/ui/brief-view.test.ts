import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// Areas A, B and C at their module boundary (their own suites cover them); P7b's state and P2b's users likewise.
vi.mock("@/lib/exec/brief-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/brief-store")>()),
  briefSchemaReady: vi.fn(),
  getBriefByDate: vi.fn(),
  getLatestBrief: vi.fn(),
  listCheckinsForBrief: vi.fn(),
  checkinCounts: vi.fn()
}));
vi.mock("@/lib/exec/brief-screen", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/brief-screen")>();
  return { ...actual, screenBriefContent: vi.fn(), withholdAllEmail: vi.fn(actual.withholdAllEmail) };
});
vi.mock("@/lib/exec/brief-ownership-load", () => ({ loadBriefOwnership: vi.fn(), checkinApprovalSource: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUsers: vi.fn() }));

import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { NO_SCREEN, screenBriefContent, withholdAllEmail, type BriefScreen } from "@/lib/exec/brief-screen";
import { briefSchemaReady, checkinCounts, getBriefByDate, getLatestBrief, listCheckinsForBrief } from "@/lib/exec/brief-store";
import type { BriefPageOnlyReason, BriefStatus } from "@/lib/exec/brief-types";
import {
  briefChannel,
  briefContentView,
  briefPillOf,
  briefStatusLine,
  canRegenerateBrief,
  checkinStatusLine,
  getBriefCardView,
  getBriefHeaderView,
  getBriefHomeLine,
  getBriefPageView,
  getBriefPill,
  getBriefSystemView
} from "@/lib/exec/brief-view";
import { loadSettings } from "@/lib/exec/principal";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { listUsers } from "@/lib/exec/sources/dd";
import type { DdUser } from "@/lib/exec/sources/dd-types";
import { BRIEF_TEXT_SENTINELS, assertNoBriefText, captureConsole } from "../__tests__/brief-assert";
import {
  BRIEF_ID,
  DD_TASK_URL,
  NOW,
  SCHEDULED_AT,
  TODAY,
  TZ,
  YESTERDAY,
  briefRow,
  briefSettings,
  checkinRow,
  content,
  mintPrincipal,
  principal
} from "../__tests__/brief-ui-fixtures";

// P8 contract §5.16 (Area E), the view half: brief-view.ts over mocked Areas A-C. UI02 / UI04 / UI07 / UI23 / UI25-UI27 /
// UI29 / UI30, BS08 (C's request: the page and the card each screen once), OP04 (B's request: the System row), the page
// halves of SW08 / SW10 (D's request), C41's card rule and the App Home line (UI21's view half).

const SETTINGS = briefSettings();
const screen = (over: Partial<BriefScreen> = {}): BriefScreen => ({ ...NO_SCREEN, ...over });
let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  out = captureConsole();
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(briefSchemaReady).mockResolvedValue(true);
  vi.mocked(getBriefByDate).mockResolvedValue(briefRow());
  vi.mocked(getLatestBrief).mockResolvedValue(briefRow());
  vi.mocked(listCheckinsForBrief).mockResolvedValue([]);
  vi.mocked(checkinCounts).mockResolvedValue({ proposed: 0, sending: 0, sent: 0, unknown: 0, failed: 0, expired: 0 });
  vi.mocked(screenBriefContent).mockResolvedValue({ ok: true, screen: NO_SCREEN });
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(listUsers).mockResolvedValue([{ id: "u_1", name: "Dana Park" }, { id: "u_2", name: "Sam Lee" }] as unknown as DdUser[]);
});

afterEach(() => {
  // §0.3 rule 4: whatever the view logs carries ids and codes only.
  assertNoBriefText(out.calls(), { label: "console" });
});

describe("getBriefPageView: the states (UI02, UI27)", () => {
  it("not installed: the P8 tables are missing; nothing past the probe is read", async () => {
    vi.mocked(briefSchemaReady).mockResolvedValue(false);
    const v = await getBriefPageView(principal, NOW);
    expect(v.state).toBe("not_installed");
    expect(getBriefByDate).not.toHaveBeenCalled();
    expect(v.brief).toBeNull();
  });

  it("off: no row and the brief off; none: no row and the brief on, with today's due time", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(null);
    vi.mocked(loadSettings).mockResolvedValue(briefSettings({ briefEnabled: false }));
    expect((await getBriefPageView(principal, NOW)).state).toBe("off");
    vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
    const none = await getBriefPageView(principal, NOW);
    expect(none.state).toBe("none");
    expect(none.dueAt).toBe(SCHEDULED_AT);
    expect(getBriefByDate).toHaveBeenLastCalledWith(principal, TODAY);
  });

  it("UI27: the brief time and the zone move the next due time (brief zone, not the server's)", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(null);
    vi.mocked(loadSettings).mockResolvedValue(briefSettings({ briefLocalTime: "07:30" }));
    expect((await getBriefPageView(principal, NOW)).dueAt).toBe("2026-11-09T12:30:00.000Z");
    const chicago = mintPrincipal("America/Chicago");
    const v = await getBriefPageView(chicago, NOW);
    expect(v.dueAt).toBe("2026-11-09T13:30:00.000Z");
    expect(v.tz).toBe("America/Chicago");
    expect(v.settings).toEqual({ enabled: true, time: "07:30", tz: "America/Chicago", supersede: false, checkinsEnabled: true });
  });

  it("building: no content read, no screen; failed: the row's status line; ready: the screened content", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "building", content: null, builtAt: null }));
    const building = await getBriefPageView(principal, NOW);
    expect(building.state).toBe("building");
    expect(screenBriefContent).not.toHaveBeenCalled();
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "failed", statusReason: "pre_model", content: null }));
    const failed = await getBriefPageView(principal, NOW);
    expect(failed.state).toBe("failed");
    expect(failed.brief?.statusLine).toBe(BRIEF_COPY.status.failed);
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow());
    const ready = await getBriefPageView(principal, NOW);
    expect(ready.state).toBe("ready");
    expect(ready.brief?.content?.sections.map((s) => s.key)).toEqual([
      "emails", "slack", "client_requests", "progress", "work", "delayed", "blockers", "approvals", "decisions", "commitments"
    ]);
    expect(ready.brief?.content?.sections.map((s) => s.title)).toEqual(Object.values(BRIEF_COPY.sectionTitle));
  });

  it("ready: lines with basis, kind, band and their links; pending lines; unchanged and more; the stats without the dropped count", async () => {
    const v = await getBriefPageView(principal, NOW);
    const work = v.brief?.content?.sections.find((s) => s.key === "work");
    expect(work?.lines.map((l) => [l.id, l.kind, l.basis, l.band])).toEqual([["b3", "fact", "record", "normal"], ["b4", "recommendation", "ai", "critical"]]);
    expect(work?.lines[0].refs).toEqual([{ label: "Task t_42", href: DD_TASK_URL }]);
    expect(work?.pending).toEqual([{ title: "Approve the Q4 plan", withheld: false }]);
    expect(work?.unchanged).toBe(3);
    const emails = v.brief?.content?.sections.find((s) => s.key === "emails");
    expect(emails?.more).toBe(2);
    expect(emails?.stats).toEqual({ reply: 4, urgent: 1, important: 3, waiting: 2, decisionAsks: 0 });
    expect(v.brief?.content?.sections.find((s) => s.key === "blockers")?.stateLine).toBe(BRIEF_COPY.state.ddtext_off);
    expect(v.brief?.content?.sections.find((s) => s.key === "delayed")?.stateLine).toBe(BRIEF_COPY.state.unavailable);
    expect(v.brief?.content?.sections.find((s) => s.key === "decisions")?.stateLine).toBe(BRIEF_COPY.nothingNew);
    expect(v.brief?.content?.restrictedEmail).toBe(2);
    expect(v.brief?.content?.financeHref).toBe("/finance");
    expect(v.brief?.content?.modeLine).toBe(BRIEF_COPY.modeAi);
    expect(v.brief?.channel).toBe("exec_bot");
  });

  it("a deterministic brief names why in its mode line", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ mode: "deterministic", modeReason: "budget", content: content({ mode: "deterministic", modeReason: "budget" }) }));
    const v = await getBriefPageView(principal, NOW);
    expect(v.brief?.content?.modeLine).toBe(fillBrief(BRIEF_COPY.modeDeterministic, { reason: BRIEF_COPY.modeReason.budget }));
  });

  it("a settings or row read failure throws (the page's error, the route's 503)", async () => {
    vi.mocked(getBriefByDate).mockRejectedValue(new Error("exec_briefs read failed"));
    await expect(getBriefPageView(principal, NOW)).rejects.toThrow();
    vi.mocked(loadSettings).mockRejectedValue(new Error("settings"));
    await expect(getBriefPageView(principal, NOW)).rejects.toThrow();
  });
});

describe("C31 / UI04 / BS08: the render-time screen", () => {
  it("BS08: the page and the card each call screenBriefContent once, with the settings and the stored content", async () => {
    await getBriefPageView(principal, NOW);
    expect(screenBriefContent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(screenBriefContent).mock.calls[0]).toEqual([principal, SETTINGS, briefRow().content, { now: NOW }]);
    vi.mocked(screenBriefContent).mockClear();
    await getBriefCardView(principal, NOW);
    expect(screenBriefContent).toHaveBeenCalledTimes(1);
  });

  it("UI04: an email line whose thread is now restricted reads removedRestricted, with no link and no store write; its top-3 entry and the headline go too", async () => {
    vi.mocked(screenBriefContent).mockResolvedValue({
      ok: true,
      screen: screen({ items: new Map([["b1", "restricted"]]), top3: new Set(["i1"]), withheldThreadIds: ["t_mail"], hideHeadline: true })
    });
    const v = await getBriefPageView(principal, NOW);
    const line = v.brief?.content?.sections.find((s) => s.key === "emails")?.lines[0];
    expect(line).toMatchObject({ id: "b1", text: BRIEF_COPY.removedRestricted, refs: [], withheld: "restricted" });
    expect(v.brief?.content?.top3[0]).toEqual({ title: BRIEF_COPY.removedRestricted, next: null, href: null, withheld: true });
    expect(v.brief?.content?.headline).toBeNull();
    expect(JSON.stringify(v)).not.toContain(BRIEF_TEXT_SENTINELS.emailSubject);
    // Nothing is persisted from a render: the view module reads only.
    expect(vi.mocked(listCheckinsForBrief)).toHaveBeenCalledTimes(1);
  });

  it("a screen read failure withholds every email-derived line (withholdAllEmail) and Slack's by slackIntelState", async () => {
    vi.mocked(screenBriefContent).mockResolvedValue({ ok: false, reason: "screen_unavailable" });
    vi.mocked(slackIntelState).mockResolvedValue("reading_off");
    const v = await getBriefPageView(principal, NOW);
    expect(withholdAllEmail).toHaveBeenCalledWith(briefRow().content, false);
    const c = v.brief?.content;
    expect(c?.sections.find((s) => s.key === "emails")?.lines[0].withheld).toBe("restricted");
    expect(c?.sections.find((s) => s.key === "slack")?.lines[0]).toMatchObject({ text: BRIEF_COPY.removedSlack, withheld: "slack" });
    expect(c?.sections.find((s) => s.key === "work")?.lines.every((l) => l.withheld === null)).toBe(true);
    expect(c?.top3.map((t) => t.withheld)).toEqual([true, false, true]);
    expect(c?.top3[2].title).toBe(BRIEF_COPY.removedSlack);
    expect(c?.headline).toBeNull();
  });

  it("SW10 (page half): a Slack-withholding screen hides the Slack line and its top-3 entry; DD lines stay", async () => {
    vi.mocked(screenBriefContent).mockResolvedValue({ ok: true, screen: screen({ items: new Map([["b2", "slack"]]), top3: new Set(["i3"]), hideHeadline: true }) });
    const c = (await getBriefPageView(principal, NOW)).brief?.content;
    expect(c?.sections.find((s) => s.key === "slack")?.lines[0]).toMatchObject({ text: BRIEF_COPY.removedSlack, refs: [], withheld: "slack" });
    expect(c?.top3[2]).toEqual({ title: BRIEF_COPY.removedSlack, next: null, href: null, withheld: true });
    expect(c?.top3[1].withheld).toBe(false);
  });

  it("SW08 / UI30 (page half): after a tombstone scrub the stored line shows its fixed text and no headline", async () => {
    const scrubbed = content({
      headline: null,
      headlineScrubbed: true,
      scrubbed: true,
      top3: content().top3.slice(1),
      sections: content().sections.map((s) =>
        s.key === "emails"
          ? { ...s, items: [{ ...s.items[0], text: BRIEF_COPY.removedRestricted, refs: [], threadIds: [], aliases: [], fps: [], scrubbed: true as const }] }
          : s
      )
    });
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ content: scrubbed }));
    vi.mocked(getLatestBrief).mockResolvedValue(briefRow({ content: scrubbed }));
    const page = await getBriefPageView(principal, NOW);
    expect(page.brief?.content?.headline).toBeNull();
    expect(page.brief?.content?.sections.find((s) => s.key === "emails")?.lines[0]).toMatchObject({ text: BRIEF_COPY.removedRestricted, withheld: "restricted", refs: [] });
    expect((await getBriefCardView(principal, NOW))?.headline).toBeNull();
  });

  it("UI30: a headline the stored content still has is hidden when a line is withheld only at render", () => {
    expect(briefContentView(content(), NO_SCREEN).headline).toContain("Acme renewal");
    expect(briefContentView(content(), screen({ items: new Map([["b2", "slack"]]), hideHeadline: true })).headline).toBeNull();
    expect(briefContentView(content({ headline: "x", headlineScrubbed: true }), NO_SCREEN).headline).toBeNull();
  });
});

describe("check-ins on the page (UI23, UI25)", () => {
  it("first names from DD, the Slack message's status words, never a button value or MAC; superseded rows give way", async () => {
    vi.mocked(listCheckinsForBrief).mockResolvedValue([
      checkinRow(1, { status: "expired", statusReason: "superseded" }),
      checkinRow(2, { status: "sent", sentAt: "2026-11-09T13:30:00.000Z", recipientUserId: "u_1" }),
      checkinRow(3, { status: "proposed", recipientUserId: "u_2" }),
      checkinRow(4, { status: "failed", statusReason: "recipient_changed", recipientUserId: "u_9" })
    ]);
    const v = await getBriefPageView(principal, NOW);
    expect(v.checkins.map((c) => [c.status, c.firstName, c.statusLine])).toEqual([
      ["sent", "Dana", "Sent to Dana at 8:30 AM EST."],
      ["proposed", "Sam", ""],
      ["failed", "", BRIEF_COPY.checkinStatus.recipient]
    ]);
    expect(Object.keys(v.checkins[0]).sort()).toEqual(["firstName", "id", "sentAt", "status", "statusLine", "text"]);
    expect(JSON.stringify(v)).not.toMatch(/"value"|c1\.ebc_|mac/i);
    expect(v.checkinsPosted).toBe(true);
  });

  it("UI25: check-ins whose message never reached Slack (checkins_ts null) → checkinsPosted false", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ checkinsTs: null }));
    vi.mocked(listCheckinsForBrief).mockResolvedValue([checkinRow(1)]);
    const v = await getBriefPageView(principal, NOW);
    expect(v.checkins).toHaveLength(1);
    expect(v.checkinsPosted).toBe(false);
  });

  it("a failed check-in read lists none (logged by id); a failed name read shows no names", async () => {
    vi.mocked(listCheckinsForBrief).mockRejectedValue(new Error(`boom ${BRIEF_TEXT_SENTINELS.checkinText}`));
    expect((await getBriefPageView(principal, NOW)).checkins).toEqual([]);
    vi.mocked(listCheckinsForBrief).mockResolvedValue([checkinRow(1, { status: "unknown", recipientUserId: "u_1" })]);
    vi.mocked(listUsers).mockRejectedValue(new Error("users"));
    const v = await getBriefPageView(principal, NOW);
    expect(v.checkins[0].statusLine).toBe(fillBrief(BRIEF_COPY.checkinStatus.unknown, { name: "—" }));
  });

  it("checkinStatusLine: every status's words", () => {
    const row = (status: string, statusReason: string | null = null) => ({ status, statusReason, sentAt: "2026-11-09T13:30:00.000Z" }) as Parameters<typeof checkinStatusLine>[0];
    expect(checkinStatusLine(row("proposed"), "Dana", TZ)).toBe("");
    expect(checkinStatusLine(row("sending"), "Dana", TZ)).toBe(BRIEF_COPY.checkinStatus.sending);
    expect(checkinStatusLine(row("expired"), "Dana", TZ)).toBe(BRIEF_COPY.checkinStatus.expired);
    expect(checkinStatusLine(row("expired", "superseded"), "Dana", TZ)).toBe(BRIEF_COPY.checkinStatus.replaced);
    expect(checkinStatusLine(row("failed"), "Dana", TZ)).toBe(BRIEF_COPY.checkinStatus.failed);
    expect(checkinStatusLine(row("unknown"), "Dana", TZ)).toBe(fillBrief(BRIEF_COPY.checkinStatus.unknown, { name: "Dana" }));
  });
});

describe("status lines and channels (UI26)", () => {
  const reasons = Object.keys(BRIEF_COPY.pageOnlyReason) as BriefPageOnlyReason[];
  for (const reason of reasons) {
    it(`page_only ${reason}`, () => {
      const line = briefStatusLine(briefRow({ status: "page_only", statusReason: reason, deliveredAt: null }), TZ);
      const expected = reason === "after_cutoff" ? fillBrief(BRIEF_COPY.pageOnlyReason.after_cutoff, { cutoff: "12:00 PM EST" }) : BRIEF_COPY.pageOnlyReason[reason];
      expect(line).toBe(`${BRIEF_COPY.status.page_only} ${expected}`);
    });
  }

  it("delivered names the send time; a backup adds its line; other statuses are their copy", () => {
    expect(briefStatusLine(briefRow(), TZ)).toBe("Sent to you in Slack at 8:02 AM EST.");
    const fallback = briefRow({ status: "page_only", statusReason: "after_fallback", deliveredAt: null, fallbackSentAt: "2026-11-09T13:45:00.000Z" });
    expect(briefStatusLine(fallback, TZ)).toBe(`${BRIEF_COPY.status.page_only} ${BRIEF_COPY.pageOnlyReason.after_fallback} The DD bot sent a short backup at 8:45 AM EST.`);
    for (const status of ["building", "built", "delivering", "failed", "delivery_unknown"] as BriefStatus[]) {
      expect(briefStatusLine(briefRow({ status, deliveredAt: null }), TZ)).toBe(BRIEF_COPY.status[status as keyof typeof BRIEF_COPY.status]);
    }
  });

  it("§3.17.1 channel", () => {
    const c = (status: BriefStatus, fallback = false) => briefChannel({ status, fallbackSlackTs: fallback ? "1.2" : null, fallbackSentAt: fallback ? "x" : null });
    expect([c("delivered"), c("delivered", true), c("page_only", true), c("page_only"), c("building"), c("built"), c("failed"), c("delivering"), c("delivery_unknown")]).toEqual([
      "exec_bot", "exec_bot", "dd_bot_fallback", "page_only", "none", "none", "none", "unknown", "unknown"
    ]);
  });
});

describe("UI29: canRegenerate (C48, intel-11)", () => {
  const at = (min: number) => new Date(Date.parse("2026-11-09T13:01:00.000Z") + min * 60_000);
  it("built: with a backup sent → yes; 11 minutes after it was built → yes; 2 minutes → no", () => {
    expect(canRegenerateBrief(briefRow({ status: "built", fallbackSentAt: "2026-11-09T13:45:00.000Z" }), SETTINGS, at(2))).toBe(true);
    expect(canRegenerateBrief(briefRow({ status: "built" }), SETTINGS, at(11))).toBe(true);
    expect(canRegenerateBrief(briefRow({ status: "built" }), SETTINGS, at(2))).toBe(false);
  });
  it("building / delivering → no; a live lock → no, a lapsed one → yes; the brief off → no", () => {
    expect(canRegenerateBrief(briefRow({ status: "building" }), SETTINGS, at(30))).toBe(false);
    expect(canRegenerateBrief(briefRow({ status: "delivering" }), SETTINGS, at(30))).toBe(false);
    expect(canRegenerateBrief(briefRow({ regenLockUntil: at(5).toISOString() }), SETTINGS, at(1))).toBe(false);
    expect(canRegenerateBrief(briefRow({ regenLockUntil: at(5).toISOString() }), SETTINGS, at(6))).toBe(true);
    expect(canRegenerateBrief(briefRow(), briefSettings({ briefEnabled: false }), at(30))).toBe(false);
    expect(canRegenerateBrief(briefRow({ status: "failed" }), SETTINGS, at(30))).toBe(true);
  });
  it("the page view carries it with the row's rev", async () => {
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ rev: 3 }));
    const v = await getBriefPageView(principal, NOW);
    expect([v.canRegenerate, v.expectedRev]).toEqual([true, 3]);
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "built", builtAt: "2026-11-09T13:58:00.000Z", deliveredAt: null }));
    expect((await getBriefPageView(principal, NOW)).canRegenerate).toBe(false);
  });
});

describe("C41: the Overview card", () => {
  it("today's brief → the card, screened; its pill is today's", async () => {
    const card = await getBriefCardView(principal, NOW);
    expect(card?.localDate).toBe(TODAY);
    expect(card?.top3).toHaveLength(3);
    expect(card?.pill).toEqual({ state: "delivered", label: "Brief 8:02 AM EST · live" });
    expect(card?.statusLine).toBe("Sent to you in Slack at 8:02 AM EST.");
    expect(getLatestBrief).toHaveBeenCalledWith(principal, TODAY);
    // P8 fixer ui-6: the card carries the mode and its line, like the page.
    expect(card).toMatchObject({ mode: "ai", modeLine: BRIEF_COPY.modeAi });
  });

  it("yesterday's before today's brief time → the card (pill: not yet); after it → none", async () => {
    vi.mocked(getLatestBrief).mockResolvedValue(briefRow({ localDate: YESTERDAY }));
    const early = new Date("2026-11-09T12:00:00.000Z");
    const card = await getBriefCardView(principal, early);
    expect(card?.localDate).toBe(YESTERDAY);
    expect(card?.pill.state).toBe("none");
    expect(card?.pill.label).toBe("Brief 8:00 AM EST · not yet");
    expect(await getBriefCardView(principal, NOW)).toBeNull();
  });

  it("no card: brief off, not installed, no row, no content, still building, or older than yesterday", async () => {
    vi.mocked(loadSettings).mockResolvedValueOnce(briefSettings({ briefEnabled: false }));
    expect(await getBriefCardView(principal, NOW)).toBeNull();
    vi.mocked(briefSchemaReady).mockResolvedValueOnce(false);
    expect(await getBriefCardView(principal, NOW)).toBeNull();
    vi.mocked(getLatestBrief).mockResolvedValueOnce(null);
    expect(await getBriefCardView(principal, NOW)).toBeNull();
    vi.mocked(getLatestBrief).mockResolvedValueOnce(briefRow({ content: null }));
    expect(await getBriefCardView(principal, NOW)).toBeNull();
    vi.mocked(getLatestBrief).mockResolvedValueOnce(briefRow({ status: "building" }));
    expect(await getBriefCardView(principal, NOW)).toBeNull();
    vi.mocked(getLatestBrief).mockResolvedValueOnce(briefRow({ localDate: "2026-11-07" }));
    expect(await getBriefCardView(principal, new Date("2026-11-09T12:00:00.000Z"))).toBeNull();
  });
});

describe("UI07: the pill", () => {
  it("delivered: 'Brief 8:02 AM EST · live'; every other state its words at the brief time", async () => {
    expect(await getBriefPill(principal, SETTINGS, NOW)).toEqual({ state: "delivered", label: "Brief 8:02 AM EST · live" });
    const label = (state: keyof typeof BRIEF_COPY.pillState) => `Brief 8:00 AM EST · ${BRIEF_COPY.pillState[state]}`;
    for (const status of ["building", "built", "delivering", "page_only", "failed", "delivery_unknown"] as const) {
      vi.mocked(getBriefByDate).mockResolvedValueOnce(briefRow({ status, deliveredAt: null }));
      expect(await getBriefPill(principal, SETTINGS, NOW)).toEqual({ state: status, label: label(status) });
    }
    // P9 F31 (flip): NOW is 9:00 AM EST, an hour past the 8:00 AM brief time with no row: "late"; within 45 minutes, "none".
    vi.mocked(getBriefByDate).mockResolvedValueOnce(null);
    expect(await getBriefPill(principal, SETTINGS, NOW)).toEqual({ state: "late", label: label("late") });
    vi.mocked(getBriefByDate).mockResolvedValueOnce(null);
    expect(await getBriefPill(principal, SETTINGS, new Date("2026-11-09T13:30:00.000Z"))).toEqual({ state: "none", label: label("none") });
    expect(await getBriefPill(principal, briefSettings({ briefEnabled: false }), NOW)).toEqual({ state: "off", label: label("off") });
    vi.mocked(briefSchemaReady).mockResolvedValueOnce(false);
    expect(await getBriefPill(principal, SETTINGS, NOW)).toEqual({ state: "not_installed", label: label("not_installed") });
    expect(briefPillOf("none", null, TZ).label).toBe("Brief — · not yet");
  });

  it("the header view: the pill, Regenerate's state and the rev from one row read", async () => {
    expect(await getBriefHeaderView(principal, SETTINGS, NOW)).toEqual({ pill: { state: "delivered", label: "Brief 8:02 AM EST · live" }, canRegenerate: true, expectedRev: 1 });
    vi.mocked(getBriefByDate).mockResolvedValueOnce(null);
    expect((await getBriefHeaderView(principal, SETTINGS, NOW)).expectedRev).toBeNull();
    expect(getBriefByDate).toHaveBeenCalledTimes(2);
  });
});

describe("UI21 (view half): the App Home line", () => {
  it("each state, with the schedule's time and zone; delivered names the send time", async () => {
    expect(await getBriefHomeLine(principal, SETTINGS, NOW)).toEqual({ state: "delivered", time: "8:00 AM", tz: "EST", sentAt: "8:02 AM EST" });
    const state = async (status: BriefStatus) => {
      vi.mocked(getBriefByDate).mockResolvedValueOnce(briefRow({ status, deliveredAt: null }));
      return (await getBriefHomeLine(principal, SETTINGS, NOW)).state;
    };
    expect(await state("building")).toBe("building");
    expect(await state("built")).toBe("building");
    expect(await state("delivering")).toBe("building");
    expect(await state("page_only")).toBe("page_only");
    expect(await state("failed")).toBe("failed");
    expect(await state("delivery_unknown")).toBe("delivery_unknown");
    vi.mocked(getBriefByDate).mockResolvedValueOnce(null);
    expect((await getBriefHomeLine(principal, SETTINGS, NOW)).state).toBe("none");
    expect((await getBriefHomeLine(principal, briefSettings({ briefEnabled: false }), NOW)).state).toBe("off");
    vi.mocked(briefSchemaReady).mockResolvedValueOnce(false);
    expect((await getBriefHomeLine(principal, SETTINGS, NOW)).state).toBe("not_installed");
  });

  it("(fixer ui-9) off and not installed carry no schedule (no \"Daily at 8:00 AM\" for a brief that doesn't run)", async () => {
    expect(await getBriefHomeLine(principal, briefSettings({ briefEnabled: false }), NOW)).toEqual({ state: "off", time: "", tz: "", sentAt: null });
    vi.mocked(briefSchemaReady).mockResolvedValueOnce(false);
    expect(await getBriefHomeLine(principal, SETTINGS, NOW)).toEqual({ state: "not_installed", time: "", tz: "", sentAt: null });
  });
});

describe("(fixer ui-4) a regenerate after the DM went out", () => {
  it("delivered / delivery_unknown with content built after the send say Slack has the earlier version; a same-day send of a regenerated rev doesn't", () => {
    const later = content({ builtAt: "2026-11-09T15:30:00.000Z", rev: 2 });
    expect(briefStatusLine(briefRow({ rev: 2, content: later }), TZ)).toBe(`Sent to you in Slack at 8:02 AM EST. ${BRIEF_COPY.status.regeneratedAfterSend}`);
    expect(briefStatusLine(briefRow({ status: "delivery_unknown", deliveredAt: null, rev: 2, content: later }), TZ))
      .toBe(`${BRIEF_COPY.status.delivery_unknown} ${BRIEF_COPY.status.regeneratedAfterSend}`);
    // Regenerated at 07:50 on a page-only day, then sent the same day at 08:02: Slack has this version.
    expect(briefStatusLine(briefRow({ rev: 2, content: content({ builtAt: "2026-11-09T12:50:00.000Z", rev: 2 }) }), TZ)).toBe("Sent to you in Slack at 8:02 AM EST.");
    expect(briefStatusLine(briefRow({ rev: 2, content: null }), TZ)).toBe("Sent to you in Slack at 8:02 AM EST.");
    expect(briefStatusLine(briefRow({ status: "page_only", statusReason: "regenerated", deliveredAt: null, content: later }), TZ))
      .toBe(`${BRIEF_COPY.status.page_only} ${BRIEF_COPY.pageOnlyReason.regenerated}`);
  });
});

describe("OP04: the System card's brief row", () => {
  const own = (over: Record<string, unknown> = {}) => ({
    verdict: { owner: "exec", reason: "owns" },
    facts: { execEnabled: true, tablesReady: true, briefEnabled: true, supersede: true, installationActive: true, execDeliveredToday: true, legacyDeliveredToday: false },
    localDate: TODAY, brief: briefRow(), installation: null, ...over
  });

  it("a delivered day: owner, status, channel, mode, the DD brief's day and the check-in counts", async () => {
    vi.mocked(loadBriefOwnership).mockResolvedValue(own() as never);
    vi.mocked(checkinCounts).mockResolvedValue({ proposed: 1, sending: 0, sent: 2, unknown: 0, failed: 0, expired: 0 });
    expect(await getBriefSystemView(principal, SETTINGS, NOW)).toEqual({
      localDate: TODAY, owner: "exec", ownerReason: "owns", status: "delivered", statusReason: null, channel: "exec_bot", mode: "ai", modeReason: null,
      builtAt: "2026-11-09T13:01:00.000Z", deliveredAt: "2026-11-09T13:02:00.000Z", fallbackSentAt: null, fallbackErrorCode: null,
      legacyDeliveredToday: false, checkins: { proposed: 1, sending: 0, sent: 2, unknown: 0, failed: 0, expired: 0 }
    });
    expect(checkinCounts).toHaveBeenCalledWith(principal, TODAY);
  });

  it("a fallback day, a page-only day, no row yet", async () => {
    vi.mocked(loadBriefOwnership).mockResolvedValue(own({ brief: briefRow({ status: "page_only", statusReason: "after_fallback", deliveredAt: null, fallbackSentAt: "x", fallbackSlackTs: "1.2", fallbackErrorCode: null }) }) as never);
    expect(await getBriefSystemView(principal, SETTINGS, NOW)).toMatchObject({ status: "page_only", statusReason: "after_fallback", channel: "dd_bot_fallback" });
    vi.mocked(loadBriefOwnership).mockResolvedValue(own({ verdict: { owner: "exec_page_only", reason: "legacy_delivered" }, brief: null }) as never);
    expect(await getBriefSystemView(principal, SETTINGS, NOW)).toMatchObject({ owner: "exec_page_only", ownerReason: "legacy_delivered", status: "none", channel: "none", mode: null });
  });

  it("off or not installed → null; an ownership read failure → owner unknown from the row alone; a count failure throws", async () => {
    expect(await getBriefSystemView(principal, briefSettings({ briefEnabled: false }), NOW)).toBeNull();
    vi.mocked(briefSchemaReady).mockResolvedValueOnce(false);
    expect(await getBriefSystemView(principal, SETTINGS, NOW)).toBeNull();
    vi.mocked(loadBriefOwnership).mockRejectedValue(new Error("ownership"));
    const v = await getBriefSystemView(principal, SETTINGS, NOW);
    expect(v).toMatchObject({ owner: "unknown", ownerReason: null, legacyDeliveredToday: null, status: "delivered" });
    vi.mocked(checkinCounts).mockRejectedValue(new Error("counts"));
    await expect(getBriefSystemView(principal, SETTINGS, NOW)).rejects.toThrow();
  });
});

describe("the pure content view", () => {
  it("a content without a section leaves it out; a non-finite stat is dropped; top 3 keeps at most three", () => {
    const c = content({ sections: content().sections.filter((s) => s.key !== "progress") });
    const v = briefContentView(c, NO_SCREEN);
    expect(v.sections.map((s) => s.key)).not.toContain("progress");
    const odd = content();
    odd.sections[0].stats = { reply: Number.NaN, urgent: 1 };
    expect(briefContentView(odd, NO_SCREEN).sections[0].stats).toEqual({ urgent: 1 });
    expect(briefContentView(content({ top3: [...content().top3, ...content().top3] }), NO_SCREEN).top3).toHaveLength(3);
  });

  it("a withheld pending line reads its removed text; an unknown mode reason falls back", () => {
    const v = briefContentView(content(), screen({ pending: new Set(["dd:pending:1"]), hideHeadline: true }));
    expect(v.sections.find((s) => s.key === "work")?.pending).toEqual([{ title: BRIEF_COPY.removedRestricted, withheld: true }]);
    expect(briefContentView(content({ mode: "deterministic", modeReason: null }), NO_SCREEN).modeLine).toBe(
      fillBrief(BRIEF_COPY.modeDeterministic, { reason: BRIEF_COPY.modeReason.model_error })
    );
  });

  it("a link that isn't allow-listed is kept as a label with no href", () => {
    const c = content();
    c.sections[4].items[0].refs = [{ system: "web", label: "Elsewhere", url: "https://evil.example/x", class: "internal" } as never];
    expect(briefContentView(c, NO_SCREEN).sections.find((s) => s.key === "work")?.lines[0].refs).toEqual([{ label: "Elsewhere", href: null }]);
  });

  it("the row's id is the view's; the brief's id is never logged with text", async () => {
    const v = await getBriefPageView(principal, NOW);
    expect(v.brief?.id).toBe(BRIEF_ID);
  });
});
