import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));
vi.mock("@/lib/exec/attention-feedback", () => ({ feedbackTotals: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn() }));
vi.mock("@/lib/exec/agent/budget", () => ({ effectiveChatCapUsd: vi.fn(() => 9) }));
// Areas A and B at their module boundary: the day's row and the fresh ownership read; the job queue.
vi.mock("@/lib/exec/brief-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-store")>()), getBriefByDate: vi.fn() }));
vi.mock("@/lib/exec/brief-ownership-load", () => ({ loadBriefOwnership: vi.fn(), checkinApprovalSource: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));

import { BRIEF_ZONE_OPTIONS, BRIEF_TIME_OPTIONS, BriefSettingsForm, briefSettingsPatch, briefTimeLabel } from "@/components/exec/settings/BriefSettingsForm";
import { BriefSettingsSection } from "@/components/exec/settings/BriefSettingsSection";
import { SettingsPageView } from "@/components/exec/settings/SettingsPageView";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { createFakeDraftsDb, type FakeDraftsDb, type Row } from "@/lib/exec/__tests__/fake-drafts-db";
import { feedbackTotals } from "@/lib/exec/attention-feedback";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { BRIEF_TIMEZONES, updateBriefSettings, validateBriefSettingsPatch, type BriefSettingsView } from "@/lib/exec/brief-settings";
import { getBriefByDate } from "@/lib/exec/brief-store";
import { enqueueJob } from "@/lib/exec/jobs";
import { isValidTimeZone } from "@/lib/exec/principal";
import { briefSettingsViewOf, getSettingsView, updateBriefSettingsColumns } from "@/lib/exec/settings";
import { getSyncState } from "@/lib/exec/sync-state";
import { updateBriefSettings as patchBriefSettings } from "@/lib/exec/ui/settings-api";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { assertNoBriefText, captureConsole } from "./__tests__/brief-assert";
import { BRIEF_ID, TODAY, briefRow, mintPrincipal, principal } from "./__tests__/brief-ui-fixtures";
import { settingsView, textOf } from "./__tests__/p5a-ui-fixtures";

// P8 contract §5.16 (Area E): the brief settings. validateBriefSettingsPatch and the CAS writer (UI13's store half), the
// same-day delivery after turning supersede on (UI14), SettingsView.brief (UI16), the Settings Brief section and its
// confirm (UI15), and the browser's call.

const V1 = "2026-11-09T09:00:00.123456+00:00";
const TZ_NY = "America/New_York";
const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);

function settingsDbRow(over: Row = {}): Row {
  return {
    principal_id: principal.id, brief_enabled: true, brief_local_time: "08:00", brief_timezone: null, supersede_legacy_brief: false, checkins_enabled: true,
    restricted_policy: "hidden", watch_mode: "active_public", muted_channel_ids: [], retention_days_slack: 90, retention_days_email: 180,
    retention_days_chat: 90, daily_cost_cap_usd: "15.00", updated_at: V1, email_enabled: true, drafts_enabled: true, send_enabled: false,
    voice_enabled: true, ddtext_enabled: false, retention_days_ddtext: 90, chat_enabled: false, ask_ai_uses_exec: false, chat_daily_cap_usd: "9.00",
    slack_reading_enabled: false, slack_daily_cap_usd: "2.00",
    ...over
  };
}

let db: FakeDraftsDb;
let out: ReturnType<typeof captureConsole>;
function useDb(row: Row | null = settingsDbRow(), now = new Date("2026-11-09T14:00:00.000Z")): FakeDraftsDb {
  db = createFakeDraftsDb({ now: () => now, tables: { exec_settings: row ? [row] : [] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const settingsWrites = () => db.requests.filter((r) => r.target === "exec_settings" && r.kind !== "select");
const stored = () => (db.tables.exec_settings ?? [])[0];

beforeEach(() => {
  out = captureConsole();
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  vi.mocked(getBriefByDate).mockReset().mockResolvedValue(briefRow({ status: "page_only", statusReason: "not_superseding", deliveredAt: null, owner: "exec_page_only", ownerReason: "not_superseding" }));
  vi.mocked(loadBriefOwnership).mockReset().mockResolvedValue({ verdict: { owner: "exec", reason: "owns" } } as never);
  vi.mocked(enqueueJob).mockReset().mockResolvedValue({ enqueued: true, id: 1 });
});

afterEach(() => {
  assertNoBriefText(out.calls(), { label: "console" });
  vi.unstubAllGlobals();
});

describe("validateBriefSettingsPatch (pure)", () => {
  it("accepts the five keys in their shapes and drops undefined ones", () => {
    expect(validateBriefSettingsPatch({ briefEnabled: true, briefLocalTime: "07:45", briefTimezone: "Asia/Karachi", checkinsEnabled: false, supersedeLegacyBrief: true, x: undefined })).toEqual({
      ok: true,
      patch: { briefEnabled: true, briefLocalTime: "07:45", briefTimezone: "Asia/Karachi", checkinsEnabled: false, supersedeLegacyBrief: true }
    });
    expect(validateBriefSettingsPatch({ briefTimezone: null })).toEqual({ ok: true, patch: { briefTimezone: null } });
    for (const t of ["00:00", "08:15", "12:30", "23:45"]) expect(validateBriefSettingsPatch({ briefLocalTime: t }).ok, t).toBe(true);
  });

  it("refuses the rest, naming the field", () => {
    const field = (p: unknown) => (validateBriefSettingsPatch(p) as { field: string }).field;
    expect(field(null)).toBe("patch");
    expect(field([])).toBe("patch");
    expect(field({})).toBe("patch");
    expect(field({ retentionDaysChat: 30 })).toBe("patch");
    for (const t of ["8:00", "08:10", "24:00", "08:00:00", 800]) expect(field({ briefLocalTime: t }), String(t)).toBe("briefLocalTime");
    for (const z of ["Europe/Berlin", "Mars/Olympus", "", 5]) expect(field({ briefTimezone: z }), String(z)).toBe("briefTimezone");
    for (const k of ["briefEnabled", "checkinsEnabled", "supersedeLegacyBrief"]) expect(field({ [k]: "true" }), k).toBe(k);
  });

  it("the twelve zones, all accepted by this runtime; the form offers the same list; 96 quarter hours", () => {
    expect(BRIEF_TIMEZONES).toHaveLength(12);
    for (const z of BRIEF_TIMEZONES) expect(isValidTimeZone(z), z).toBe(true);
    expect([...BRIEF_ZONE_OPTIONS]).toEqual([...BRIEF_TIMEZONES]);
    expect(BRIEF_TIME_OPTIONS).toHaveLength(96);
    expect(BRIEF_TIME_OPTIONS.every((t) => validateBriefSettingsPatch({ briefLocalTime: t }).ok)).toBe(true);
    expect([briefTimeLabel("00:00"), briefTimeLabel("08:15"), briefTimeLabel("12:00"), briefTimeLabel("23:45")]).toEqual(["12:00 AM", "8:15 AM", "12:00 PM", "11:45 PM"]);
  });
});

describe("updateBriefSettingsColumns: P5a's CAS on updated_at (UI13, store half)", () => {
  it("writes only the brief columns given and updated_at, where the version matches; returns the selected row", async () => {
    useDb();
    const r = await updateBriefSettingsColumns(principal, { brief_local_time: "07:30", checkins_enabled: false }, { expectedVersion: V1 });
    expect(r.outcome).toBe("updated");
    expect(r.snapshot.settings).toMatchObject({ briefLocalTime: "07:30", checkinsEnabled: false, briefEnabled: true });
    expect(settingsWrites()).toHaveLength(1);
    expect(Object.keys(settingsWrites()[0].payload as Row).sort()).toEqual(["brief_local_time", "checkins_enabled", "updated_at"]);
    expect(stored().brief_local_time).toBe("07:30");
  });

  it("a stale version → conflict with the current snapshot, nothing written; no row and version null → an insert", async () => {
    useDb();
    const r = await updateBriefSettingsColumns(principal, { brief_enabled: false }, { expectedVersion: "2026-11-01T09:00:00+00:00" });
    expect(r.outcome).toBe("conflict");
    expect(r.snapshot.version).toBe(V1);
    expect(stored().brief_enabled).toBe(true);
    // version null while a row exists: someone wrote first.
    expect((await updateBriefSettingsColumns(principal, { brief_enabled: false }, { expectedVersion: null })).outcome).toBe("conflict");
    expect(settingsWrites()).toHaveLength(1);
    // No row and version null → an insert that never overwrites (on conflict do nothing). The fake fills no column defaults,
    // so its strict projection of the returned row fails; the request itself is what this checks.
    useDb(null);
    await updateBriefSettingsColumns(principal, { brief_enabled: true }, { expectedVersion: null }).catch(() => undefined);
    expect(settingsWrites().map((r) => [r.kind, r.options])).toEqual([["upsert", expect.objectContaining({ onConflict: "principal_id", ignoreDuplicates: true })]]);
    expect(stored()).toMatchObject({ principal_id: principal.id, brief_enabled: true });
  });

  it("refuses any other column, before anything is read", async () => {
    useDb();
    await expect(updateBriefSettingsColumns(principal, { daily_cost_cap_usd: 99 } as never, { expectedVersion: V1 })).rejects.toThrow(TypeError);
    await expect(updateBriefSettingsColumns(principal, {}, { expectedVersion: V1 })).rejects.toThrow(TypeError);
    expect(db.requests).toEqual([]);
  });
});

describe("updateBriefSettings (UI13)", () => {
  it("an invalid patch reads nothing; supersede false → true without the confirm → confirmation_required, nothing written", async () => {
    useDb();
    expect(await updateBriefSettings(principal, { briefLocalTime: "8:00" }, { expectedVersion: V1 })).toEqual({ outcome: "invalid", field: "briefLocalTime", detail: expect.any(String) });
    expect(db.requests).toEqual([]);
    expect(await updateBriefSettings(principal, { supersedeLegacyBrief: true }, { expectedVersion: V1 })).toEqual({ outcome: "confirmation_required" });
    expect(settingsWrites()).toEqual([]);
  });

  it("with the confirm → updated; turning it off, or keeping it on, needs none", async () => {
    useDb();
    const on = await updateBriefSettings(principal, { supersedeLegacyBrief: true }, { expectedVersion: V1, confirm: "supersede_legacy_brief", now: new Date("2026-11-09T14:00:00.000Z") });
    expect(on.outcome).toBe("updated");
    expect(stored().supersede_legacy_brief).toBe(true);
    const version = stored().updated_at as string;
    const off = await updateBriefSettings(principal, { supersedeLegacyBrief: false }, { expectedVersion: version });
    expect(off.outcome).toBe("updated");
    expect(stored().supersede_legacy_brief).toBe(false);
  });

  it("a CAS conflict → conflict with the current snapshot", async () => {
    useDb();
    const r = await updateBriefSettings(principal, { briefEnabled: false }, { expectedVersion: "2026-11-01T09:00:00+00:00" });
    expect(r.outcome).toBe("conflict");
  });
});

describe("UI14: same-day delivery after turning supersede on (M2, C22)", () => {
  const turnOn = (now: string) =>
    updateBriefSettings(principal, { supersedeLegacyBrief: true }, { expectedVersion: V1, confirm: "supersede_legacy_brief", now: new Date(now) });

  it("at 09:00, today's row page_only not_superseding and a fresh verdict exec → one exec.brief-deliver same_day job", async () => {
    useDb();
    const r = await turnOn("2026-11-09T14:00:00.000Z");
    expect(r).toMatchObject({ outcome: "updated", sameDayDelivery: true });
    expect(getBriefByDate).toHaveBeenCalledWith(principal, TODAY);
    expect(vi.mocked(loadBriefOwnership).mock.calls[0][2]).toBe(TODAY);
    expect(vi.mocked(loadBriefOwnership).mock.calls[0][1]).toMatchObject({ supersedeLegacyBrief: true, briefEnabled: true });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toEqual({
      kind: "exec.brief-deliver", lane: "interactive", principalId: principal.id, maxAttempts: 1,
      payload: { brief_id: BRIEF_ID, local_date: TODAY, rev: 1, mode: "same_day" },
      dedupeKey: `exec.brief-deliver:${principal.id}:${TODAY}:1:same_day`
    });
  });

  it("no_installation counts too; at 12:30 (past the 12:00 cutoff) → none", async () => {
    useDb();
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "page_only", statusReason: "no_installation", deliveredAt: null }));
    expect((await turnOn("2026-11-09T14:00:00.000Z")).outcome).toBe("updated");
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    useDb();
    vi.mocked(enqueueJob).mockClear();
    const late = await turnOn("2026-11-09T17:30:00.000Z");
    expect(late).toMatchObject({ outcome: "updated", sameDayDelivery: false });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("with legacy_delivered (the DD brief went out today) → none; a verdict that isn't exec → none", async () => {
    useDb();
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "page_only", statusReason: "legacy_delivered", deliveredAt: null }));
    expect(await turnOn("2026-11-09T14:00:00.000Z")).toMatchObject({ sameDayDelivery: false });
    useDb();
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "page_only", statusReason: "not_superseding", deliveredAt: null }));
    vi.mocked(loadBriefOwnership).mockResolvedValue({ verdict: { owner: "exec_page_only", reason: "legacy_delivered" } } as never);
    expect(await turnOn("2026-11-09T14:00:00.000Z")).toMatchObject({ sameDayDelivery: false });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("a delivered row, no row, a zone change in the same save, or a failing read → none, and the save still stands", async () => {
    useDb();
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow());
    expect(await turnOn("2026-11-09T14:00:00.000Z")).toMatchObject({ outcome: "updated", sameDayDelivery: false });
    useDb();
    vi.mocked(getBriefByDate).mockResolvedValue(null);
    expect(await turnOn("2026-11-09T14:00:00.000Z")).toMatchObject({ sameDayDelivery: false });
    useDb();
    vi.mocked(getBriefByDate).mockResolvedValue(briefRow({ status: "page_only", statusReason: "not_superseding", deliveredAt: null }));
    const zone = await updateBriefSettings(principal, { supersedeLegacyBrief: true, briefTimezone: "America/Chicago" }, { expectedVersion: V1, confirm: "supersede_legacy_brief", now: new Date("2026-11-09T14:00:00.000Z") });
    expect(zone).toMatchObject({ outcome: "updated", sameDayDelivery: false });
    useDb();
    vi.mocked(loadBriefOwnership).mockRejectedValue(new Error("ownership"));
    expect(await turnOn("2026-11-09T14:00:00.000Z")).toMatchObject({ outcome: "updated", sameDayDelivery: false });
    expect(stored().supersede_legacy_brief).toBe(true);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

describe("UI16: SettingsView.brief from the snapshot", () => {
  it("getSettingsView carries the Brief section from the same read; P5a's sections are unchanged", async () => {
    useDb(settingsDbRow({ brief_timezone: "Asia/Karachi", supersede_legacy_brief: true }));
    vi.mocked(feedbackTotals).mockResolvedValue(null);
    vi.mocked(getSyncState).mockResolvedValue(null);
    const view = await getSettingsView(principal, new Date("2026-11-09T14:00:00.000Z"));
    expect(view.brief).toEqual({
      enabled: true, time: "08:00", timezone: "Asia/Karachi", effectiveTz: "Asia/Karachi", workTz: "America/New_York", checkinsEnabled: true, supersede: true, version: V1
    });
    expect(view.version).toBe(V1);
    expect(view.settings.briefEnabled).toBe(true);
  });

  it("no zone stored: the effective zone is his work zone", () => {
    const p = mintPrincipal("America/Denver");
    const v = briefSettingsViewOf(p, { settings: { ...settingsView().settings, briefTimezone: null }, version: null });
    expect([v.timezone, v.effectiveTz, v.workTz, v.version]).toEqual([null, "America/Denver", "America/Denver", null]);
  });
});

describe("UI15: the Settings Brief section", () => {
  const VIEW: BriefSettingsView = { enabled: true, time: "08:00", timezone: null, effectiveTz: TZ_NY, workTz: TZ_NY, checkinsEnabled: true, supersede: false, version: V1 };

  it("five controls with their labels and help; the 15-minute time select; the zone select (work zone first) and its note", () => {
    const out = html(createElement(BriefSettingsSection, { view: VIEW }));
    const text = textOf(out);
    expect([...out.matchAll(/data-brief-setting="([a-z]+)"/g)].map((m) => m[1])).toEqual(["enabled", "time", "timezone", "checkins", "supersede"]);
    const s = BRIEF_COPY.settings;
    for (const words of [s.title, s.enabled, s.enabledHelp, s.time, s.timezone, s.checkins, s.checkinsHelp, s.supersede, s.supersedeHelp, s.timeZoneNote, s.save]) {
      expect(text, words).toContain(words);
    }
    expect(out.match(/role="switch"/g)).toHaveLength(3);
    const time = /<select[^>]*data-brief-setting="time"[^>]*>([^]*?)<\/select>/.exec(out)?.[1] ?? "";
    expect(time.match(/<option/g)).toHaveLength(96);
    expect(time).toMatch(/<option value="08:00" selected="">8:00 AM<\/option>/);
    const zones = [...(/<select[^>]*data-brief-setting="timezone"[^>]*>([^]*?)<\/select>/.exec(out)?.[1] ?? "").matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)];
    expect(zones[0].slice(1)).toEqual(["", fillBrief(s.timezoneDefault, { tz: TZ_NY })]);
    expect(zones.slice(1).map((m) => m[1])).toEqual([...BRIEF_TIMEZONES]);
    expect(out).not.toContain("data-supersede-confirm");
  });
  it("UI15b (fixer ui-10) a stored zone outside the twelve listed is its own selected option, never shown as the work-zone default", () => {
    const zonesOf = (out: string) => [...(/<select[^>]*data-brief-setting="timezone"[^>]*>([^]*?)<\/select>/.exec(out)?.[1] ?? "").matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)</g)];
    // P2a's brief_timezone is free text: any valid zone can be stored, and the brief runs in it.
    const odd = zonesOf(html(createElement(BriefSettingsForm, { view: { ...VIEW, timezone: "America/Toronto", effectiveTz: "America/Toronto" } })));
    expect(odd.filter((m) => m[2].includes("selected")).map((m) => m[1])).toEqual(["America/Toronto"]);
    expect(odd.map((m) => m[1])).toEqual(["", "America/Toronto", ...BRIEF_TIMEZONES]);
    // A listed zone (or the default) adds no option.
    const listed = zonesOf(html(createElement(BriefSettingsForm, { view: { ...VIEW, timezone: "Asia/Manila" } })));
    expect(listed.map((m) => m[1])).toEqual(["", ...BRIEF_TIMEZONES]);
    expect(listed.filter((m) => m[2].includes("selected")).map((m) => m[1])).toEqual(["Asia/Manila"]);
    expect(zonesOf(html(createElement(BriefSettingsForm, { view: VIEW }))).filter((m) => m[2].includes("selected")).map((m) => m[1])).toEqual([""]);
  });

  it("turning supersede on: the confirm lists exactly what he loses, with its title, body and foot, Replace it / Cancel", () => {
    const out = html(createElement(BriefSettingsForm, { view: VIEW, initialConfirm: true }));
    const dialog = /<div role="alertdialog"[^>]*data-supersede-confirm[^>]*>([^]*?)<\/div><\/div>/.exec(out)?.[0] ?? "";
    expect(dialog).not.toBe("");
    const s = BRIEF_COPY.settings;
    expect(textOf(dialog)).toBe(textOf([s.supersedeConfirmTitle, s.supersedeConfirmBody, ...BRIEF_COPY.supersedeLose, s.supersedeConfirmFoot, s.supersedeConfirm, s.cancel].join(" ")));
    const bullets = [...(/<ul data-supersede-lose[^>]*>([^]*?)<\/ul>/.exec(out)?.[1] ?? "").matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    expect(bullets).toEqual([...BRIEF_COPY.supersedeLose]);
    expect(bullets).toHaveLength(5);
  });

  it("framed → read-only: the values as text, nothing to click", () => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    const out = html(createElement(BriefSettingsSection, { view: { ...VIEW, timezone: "Asia/Manila", supersede: true } }));
    expect(out).toContain("data-brief-settings-readonly");
    expect(out).not.toMatch(/<button|<select|<input/);
    const text = textOf(out);
    expect(text).toContain(`${BRIEF_COPY.settings.time} 8:00 AM`);
    expect(text).toContain(`${BRIEF_COPY.settings.timezone} Asia/Manila`);
    expect(text).toContain(`${BRIEF_COPY.settings.supersede} On`);
  });

  it("SettingsPageView shows the section when the view carries it; the stale 'Not set up yet' row is gone", () => {
    const page = html(createElement(SettingsPageView, { view: { ...settingsView(), brief: VIEW } }));
    expect(page).toContain("data-brief-settings");
    expect(textOf(page)).not.toContain("Morning brief Not set up yet");
    expect(html(createElement(SettingsPageView, { view: settingsView() }))).not.toContain("data-brief-settings");
  });

  it("the patch holds only what changed", () => {
    const saved = { enabled: true, time: "08:00", timezone: null, checkinsEnabled: true, supersede: false };
    expect(briefSettingsPatch(saved, saved)).toEqual({});
    expect(briefSettingsPatch(saved, { ...saved, time: "07:45", timezone: "Europe/London", supersede: true })).toEqual({
      briefLocalTime: "07:45", briefTimezone: "Europe/London", supersedeLegacyBrief: true
    });
  });
});

describe("the browser's call (settings-api updateBriefSettings)", () => {
  const VIEW: BriefSettingsView = { enabled: true, time: "07:45", timezone: null, effectiveTz: TZ_NY, workTz: TZ_NY, checkinsEnabled: true, supersede: true, version: "v2" };
  const answer = (fetchImpl: ReturnType<typeof vi.fn>, status: number, body: unknown) =>
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("PATCH same-origin with the confirm only as supersede_legacy_brief; saved (+ sameDay), conflict, confirm, rate limit, failed", async () => {
    const f = vi.fn();
    answer(f, 200, { settings: VIEW, sameDayDelivery: true });
    const saved = await patchBriefSettings({ patch: { supersedeLegacyBrief: true }, expectedVersion: V1, confirm: "supersede_legacy_brief" }, f);
    expect(saved).toEqual({ kind: "saved", settings: VIEW, sameDayDelivery: true, message: `${BRIEF_COPY.settings.saved} ${BRIEF_COPY.settings.sameDay}` });
    expect(f.mock.calls[0][0]).toBe("/api/exec/briefs/settings");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "PATCH", credentials: "same-origin" });
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ patch: { supersedeLegacyBrief: true }, expectedVersion: V1, confirm: "supersede_legacy_brief" });
    answer(f, 200, { settings: VIEW, sameDayDelivery: false });
    expect((await patchBriefSettings({ patch: { briefEnabled: true }, expectedVersion: V1, confirm: "other" as never }, f))).toMatchObject({ message: BRIEF_COPY.settings.saved });
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ patch: { briefEnabled: true }, expectedVersion: V1 });
    answer(f, 409, { error: "conflict", settings: VIEW });
    expect(await patchBriefSettings({ patch: { briefEnabled: true }, expectedVersion: V1 }, f)).toEqual({ kind: "conflict", settings: VIEW, message: BRIEF_COPY.settings.conflict });
    answer(f, 400, { error: "confirmation_required" });
    expect(await patchBriefSettings({ patch: { supersedeLegacyBrief: true }, expectedVersion: V1 }, f)).toEqual({ kind: "confirmation_required" });
    answer(f, 429, { error: "rate_limited", retryAfterSeconds: 30 });
    expect((await patchBriefSettings({ patch: { briefEnabled: true }, expectedVersion: V1 }, f)).kind).toBe("failed");
    answer(f, 503, { error: "unavailable" });
    expect(await patchBriefSettings({ patch: { briefEnabled: true }, expectedVersion: V1 }, f)).toEqual({ kind: "failed", status: 503, message: BRIEF_COPY.settings.failed });
  });
});

