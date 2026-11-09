import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));

import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import { SettingsForm, ddtextConfirmText, settingValueText } from "@/components/exec/settings/SettingsForm";
import { SETTINGS_PAGE_COPY, SettingsPageView, feedbackKindLabel } from "@/components/exec/settings/SettingsPageView";
import { VoiceResetButton } from "@/components/exec/settings/VoiceResetButton";
import { SETTINGS_FIELDS } from "@/lib/exec/settings-fields";
import { SETTINGS_COPY, patchSettings, resetVoice, settingsMessageFor, voiceCanBuild, voiceResetDoneText } from "@/lib/exec/ui/settings-api";
import type { DdtextSourceType } from "@/lib/exec/ddtext-types";
import type { SettingsView } from "@/lib/exec/view-types";
import { useRouter } from "next/navigation";
import { settings, settingsView, textOf } from "../__tests__/p5a-ui-fixtures";

// P5a contract §5.5 test 75 (A6, C14, C20, S2, a-build-2, a-build-6): the
// Settings page, its form and the voice reset, top-level and framed, plus the
// client module graph (rule 16).

const form = (view: SettingsView = settingsView(), initialConfirm: "on" | "off" | null = null) => renderToStaticMarkup(createElement(SettingsForm, { view, initialConfirm }));
const page = (view: SettingsView = settingsView()) => renderToStaticMarkup(createElement(SettingsPageView, { view }));
const fieldOf = (html: string, key: string) => {
  const at = html.indexOf(`data-setting="${key}"`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<div", at);
  const next = html.indexOf("data-setting=", at + 10);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf("<div", next));
};

beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
  vi.mocked(useRouter).mockReturnValue({ refresh: vi.fn() } as unknown as ReturnType<typeof useRouter>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsForm, top-level (test 75)", () => {
  it("every registry field renders with its label and a control", () => {
    // P5b (contract §3.19.12): the chat fields render in their own section, and only once
    // P5b's migration is applied (before it, the section is one sentence with no control).
    const chatInstalled = settingsView({ schema: { email: true, drafts: true, ddtext: true, chat: true, slack: false }, settings: settings({ chatSchemaReady: true, chatEnabled: true }) });
    // P7a (§3.16, §3.20.2, SU12): the three section "slack" fields render in the Slack section's reading controls instead.
    const formFields = SETTINGS_FIELDS.filter((d) => d.section !== "slack");
    for (const [view, fields] of [
      [settingsView(), formFields.filter((d) => d.group !== "chat")],
      [chatInstalled, formFields]
    ] as const) {
      const html = form(view);
      for (const def of fields) {
        const f = fieldOf(html, def.key);
        expect(f, def.key).not.toBe("");
        expect(textOf(f)).toContain(def.label);
        expect(f).toMatch(def.kind === "boolean" ? /role="switch"/ : /<input type="number"/);
      }
      expect(textOf(html)).toContain("Applies to records written from now on.");
    }
  });

  it("a field whose migration isn't applied is disabled, with the copy", () => {
    const html = form(settingsView({ schema: { email: true, drafts: false, ddtext: false, chat: false, slack: false } }));
    for (const key of ["ddtextEnabled", "retentionDaysDdtext", "voiceEnabled"]) {
      const f = fieldOf(html, key);
      expect(textOf(f), key).toContain("Not available yet: the team needs to apply the database update.");
      expect(f, key).toMatch(/<(button|input)[^>]*disabled=""/);
    }
    for (const key of ["retentionDaysEmail", "retentionDaysChat", "dailyCostCapUsd"]) {
      const f = fieldOf(html, key);
      expect(textOf(f), key).not.toContain("Not available yet");
      expect(f, key).not.toMatch(/<input[^>]*disabled=""/);
    }
  });

  it("the switches show the saved values", () => {
    const html = form(settingsView({ settings: settings({ ddtextEnabled: false, voiceEnabled: true }) }));
    expect(fieldOf(html, "ddtextEnabled")).toContain('aria-checked="false"');
    expect(fieldOf(html, "voiceEnabled")).toContain('aria-checked="true"');
    expect(fieldOf(html, "retentionDaysEmail")).toContain('value="180"');
    expect(fieldOf(html, "dailyCostCapUsd")).toContain('value="15"');
  });

  it("the DD text confirm, turning it on: the notice, the retention, the checkbox, Turn on / Cancel", () => {
    const html = form(settingsView({ settings: settings({ retentionDaysDdtext: 45 }) }), "on");
    const text = textOf(html);
    expect(text).toContain("Turn on DD text triage?");
    expect(text).toContain(
      "Every 10 minutes Claude Haiku reads new task comments (including the notes on status changes), handoff notes, extension reasons and submitted EOD/SOD blocker notes, with up to five earlier comments and the task's title and client for context, and stores short AI summaries (up to 200 characters) for 45 days. Turning it off deletes them within 10 minutes. Confirm first that the team has been told and that Anthropic's data terms cover employee text."
    );
    expect(text).toContain("I've confirmed both");
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/data-confirm-ddtext[^>]*disabled=""[^>]*>Turn on</);
    expect(text).toContain("Cancel");
  });

  it("the DD text consent and its field help name every source the job sends to the model (ui-2)", () => {
    // One phrase per DdtextSourceType; the type map makes a new source type fail to compile here.
    const phrase: Record<DdtextSourceType, string> = {
      comment: "task comments",
      status_comment: "status changes",
      handoff_note: "handoff notes",
      extension_reason: "extension reasons",
      eod_note: "EOD/SOD blocker notes",
      sod_note: "EOD/SOD blocker notes"
    };
    const help = SETTINGS_FIELDS.find((f) => f.key === "ddtextEnabled")?.help ?? "";
    const consent = ddtextConfirmText(true, 90).body;
    for (const [type, words] of Object.entries(phrase)) {
      expect(help, type).toContain(words);
      expect(consent, type).toContain(words);
    }
    for (const text of [help, consent]) expect(text).toContain("earlier comments and the task's title and client for context");
  });

  it("the DD text confirm takes focus as it opens: a focusable question that labels the group, the notice as its description (ui-7)", () => {
    for (const mode of ["on", "off"] as const) {
      const html = form(settingsView({ settings: settings({ ddtextEnabled: mode === "off" }) }), mode);
      const q = /<p[^>]*data-confirm-question[^>]*>/.exec(html)?.[0] ?? "";
      expect(q, mode).toContain('tabindex="-1"');
      const qid = /id="([^"]+)"/.exec(q)?.[1];
      expect(qid, mode).toBeTruthy();
      const group = /<div[^>]*data-ddtext-confirm[^>]*>/.exec(html)?.[0] ?? "";
      expect(group, mode).toContain(`aria-labelledby="${qid}"`);
      const bid = /aria-describedby="([^"]+)"/.exec(group)?.[1];
      expect(html, mode).toContain(`id="${bid}"`);
    }
  });

  it("the DD text confirm, turning it off: what it deletes", () => {
    const html = form(settingsView({ settings: settings({ ddtextEnabled: true }) }), "off");
    const text = textOf(html);
    expect(text).toContain("Turn off DD text triage? Its stored summaries and items are deleted within 10 minutes.");
    expect(html).not.toContain('type="checkbox"');
    expect(text).toContain("Turn off");
    expect(ddtextConfirmText(false, 90).body).toBe("Its stored summaries and items are deleted within 10 minutes.");
  });
});

describe("Framed (test 75, S2, a-build-2)", () => {
  beforeEach(() => {
    vi.mocked(useIsTopWindow).mockReturnValue(false);
  });

  it("SettingsForm: every value read-only, no <button>, no checkbox, no input, and the framed line", () => {
    for (const confirm of [null, "on", "off"] as const) {
      const html = form(settingsView(), confirm);
      expect(html).not.toContain("<button");
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("<input");
      expect(textOf(html)).toContain("Changes are off in an embedded view.");
      expect(textOf(html)).not.toContain("Turn on DD text triage?");
    }
    const html = form();
    expect(textOf(fieldOf(html, "ddtextEnabled"))).toContain("Off");
    expect(textOf(fieldOf(html, "voiceEnabled"))).toContain("On");
    expect(textOf(fieldOf(html, "retentionDaysEmail"))).toContain("180 days");
    expect(textOf(fieldOf(html, "dailyCostCapUsd"))).toContain("$15.00");
  });

  it("VoiceResetButton renders nothing", () => {
    expect(renderToStaticMarkup(createElement(VoiceResetButton, { installed: true, hasProfile: true }))).toBe("");
    expect(renderToStaticMarkup(createElement(VoiceResetButton, { installed: true, hasProfile: true, initialConfirm: true }))).toBe("");
  });

  it("the whole page has no button and no checkbox", () => {
    const html = page();
    expect(html).not.toContain("<button");
    expect(html).not.toContain('type="checkbox"');
  });
});

describe("The voice card and its reset (test 75, C20)", () => {
  it("top-level: Reset shown when installed with a profile; the confirm copy", () => {
    expect(textOf(renderToStaticMarkup(createElement(VoiceResetButton, { installed: true, hasProfile: true })))).toContain("Reset voice profile");
    const confirm = textOf(renderToStaticMarkup(createElement(VoiceResetButton, { installed: true, hasProfile: true, initialConfirm: true })));
    expect(confirm).toContain("Delete the learned writing style? Drafts use a neutral voice until the weekly rebuild.");
    expect(confirm).toContain("Reset");
    expect(confirm).toContain("Cancel");
  });

  it("'Learn my writing style' says what it needs while drafts, email or a mailbox is missing; the reset line says whether it rebuilds (ui-6)", () => {
    const needs = (over: Parameters<typeof settings>[0], pinned = true) =>
      form(settingsView({ settings: settings(over), ...(pinned ? {} : { pinnedMailbox: { ok: true, data: { accountIds: [], emails: [] } } }) }));
    const line = "Needs email intelligence and assistant drafts on, and a linked mailbox, to build.";
    expect(textOf(needs({}))).not.toContain(line);
    for (const [why, html] of [
      ["drafts off", needs({ draftsEnabled: false })],
      ["email off", needs({ emailEnabled: false })],
      ["email not installed", needs({ emailSchemaReady: false, emailEnabled: false })],
      ["no mailbox", needs({}, false)]
    ] as const) {
      expect(textOf(html.slice(html.indexOf('data-setting="voiceEnabled"'))), why).toContain(line);
    }
    // Not installed: the not-installed line, not this one.
    const notInstalled = settingsView({ settings: settings({ draftsSchemaReady: false, draftsEnabled: false }) });
    expect(textOf(form({ ...notInstalled, schema: { ...notInstalled.schema, drafts: false } }))).not.toContain(line);
    // An unreadable mailbox read doesn't claim it can't build.
    expect(voiceCanBuild(settingsView({ pinnedMailbox: { ok: false, error: "unavailable" } }))).toBe(true);
    expect(voiceResetDoneText(true)).toBe("Reset. It rebuilds next week.");
    expect(voiceResetDoneText(false)).toBe("Reset. It rebuilds once Learn my writing style, drafts and email are on.");
  });

  it("disabled with 'No profile yet.' without a profile; hidden when not installed", () => {
    const none = renderToStaticMarkup(createElement(VoiceResetButton, { installed: true, hasProfile: false }));
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*>.*Reset voice profile/);
    expect(textOf(none)).toContain("No profile yet.");
    expect(renderToStaticMarkup(createElement(VoiceResetButton, { installed: false, hasProfile: true }))).toBe("");
  });

  it("the card: the profile's status, enums, sign-off and build time; not installed; none yet", () => {
    const text = textOf(page());
    for (const s of ["Writing style", "Ready", "Casual", "Short", "Hi <first name>", "Short paragraphs", "Sometimes", "Never", "Thanks, Mitchell", "Nov 2, 4:00 AM EST from 32 emails", "Reset voice profile"]) {
      expect(text).toContain(s);
    }
    const notInstalled = textOf(page(settingsView({ voice: { ok: true, data: { installed: false, profile: null } } })));
    expect(notInstalled).toContain(SETTINGS_PAGE_COPY.voiceNotInstalled);
    expect(notInstalled).not.toContain("Reset voice profile");
    const none = textOf(page(settingsView({ voice: { ok: true, data: { installed: true, profile: null } } })));
    expect(none).toContain("No profile yet. It builds once a week from your sent email.");
    expect(none).toContain("No profile yet.");
  });
});

describe("SettingsPageView (test 75)", () => {
  it("recent access: the columns and the IP note", () => {
    const html = page();
    const text = textOf(html);
    expect(text).toContain("When Route Surface IP (as reported) Device Session");
    expect(text).toContain("The IP is the first X-Forwarded-For entry and can be spoofed.");
    expect(text).toContain("203.0.113.7");
    expect(text).toContain("a1b2c3d4");
  });

  it("spend, read-only flags, feedback totals", () => {
    const text = textOf(page());
    expect(text).toContain("$0.42 of $15.00 today");
    expect(text).toContain("Email triage $0.31");
    expect(text).toContain("Pinned mailbox mitchell@scaledai.org");
    expect(text).toContain("Send from DD Off");
    // The brief doesn't exist in this build: never its stored values (ui-3). P6 replaced the read-only Slack row with the
    // Slack section (ui/slack-settings.test.ts covers its states); the old Slack check-in values are still never shown.
    expect(text).toContain("Morning brief Not set up yet");
    expect(text).not.toContain("arrives with the Slack app");
    expect(text).toContain("Slack Connect the Executive Assistant to Slack to ask questions in a direct message.");
    for (const stale of ["Morning brief On", "07:30", "Slack check-ins", "Slack watch mode", "Muted Slack channels", "Public channels"]) expect(text).not.toContain(stale);
    // P5b ships chat: the retention help no longer says it isn't available (bindings AM4).
    expect(SETTINGS_FIELDS.find((f) => f.key === "retentionDaysChat")?.help).toBe("Days, 7 to 730. Applies to records written from now on.");
    expect(text).toContain("12 useful votes · 3 not useful votes");
    expect(text).toContain("Overdue tasks 5 up · 1 down");
    expect(text).not.toContain("overdue_tasks");
    expect(text).toContain("Wrong priority: 2");
  });

  it("feedback kinds read as words; an unknown kind keeps its name, spaced", () => {
    expect(feedbackKindLabel("ddtext_blocker")).toBe("Possible blocker in DD text");
    expect(feedbackKindLabel("slack_request")).toBe("Slack message to you");   // P7a (integrator)
    expect(feedbackKindLabel("email_reply")).toBe("Email reply");
  });

  it("feedback: none yet, and not installed", () => {
    const none = page(settingsView({ feedback: { ok: true, data: { sinceIso: "2025-11-06T15:00:00.000Z", up: 0, down: 0, byKind: [], byReason: [] } } }));
    expect(textOf(none)).toContain("No feedback yet.");
    expect(textOf(page(settingsView({ feedback: { ok: true, data: null } })))).toContain("Not available yet");
  });

  it("each section fails soft", () => {
    const FAILED = { ok: false, error: "unavailable" } as const;
    const text = textOf(page(settingsView({ spend: FAILED, recentAccess: FAILED, feedback: FAILED, voice: FAILED, pinnedMailbox: FAILED })));
    expect(text.match(/Couldn't load this section right now/g)).toHaveLength(4);
    expect(text).toContain("Pinned mailbox —");
  });

  it("settingValueText", () => {
    const def = (key: string) => SETTINGS_FIELDS.find((d) => d.key === key)!;
    expect(settingValueText(def("ddtextEnabled"), true)).toBe("On");
    expect(settingValueText(def("dailyCostCapUsd"), 12.5)).toBe("$12.50");
    expect(settingValueText(def("retentionDaysChat"), 30)).toBe("30 days");
    expect(settingValueText(def("retentionDaysChat"), null)).toBe("—");
  });
});

describe("settings-api", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it("PATCHes one change with the version and the notice confirm", async () => {
    const view = settingsView();
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { settings: view }));
    expect(await patchSettings({ patch: { ddtextEnabled: true }, expectedVersion: view.version, confirm: "ddtext_notice" }, f)).toEqual({ kind: "saved", view, message: "Saved" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/exec/settings");
    expect(init).toMatchObject({ method: "PATCH", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({ patch: { ddtextEnabled: true }, expectedVersion: view.version, confirm: "ddtext_notice" });
  });

  it("maps conflict, not installed, 429 and failures to their words", async () => {
    const view = settingsView();
    expect(await patchSettings({ patch: { retentionDaysChat: 30 }, expectedVersion: "v" }, async () => json(409, { error: "conflict", settings: view }))).toEqual({
      kind: "conflict",
      view,
      message: SETTINGS_COPY.conflict
    });
    expect(settingsMessageFor(409, { error: "not_installed", field: "ddtextEnabled" }, null)).toBe("Not available yet: the team needs to apply the database update.");
    expect(settingsMessageFor(429, { error: "rate_limited", retryAfterSeconds: 12 }, null)).toBe("Too many changes at once. Try again in 12 s.");
    expect(settingsMessageFor(503, { error: "unavailable" }, null)).toBe("Couldn't save. Try again.");
    expect(await patchSettings({ patch: { retentionDaysChat: 30 }, expectedVersion: "v" }, async () => { throw new TypeError("fetch failed"); })).toMatchObject({ kind: "failed", status: 0 });
  });

  it("voice reset: POST with no body; 200, 409, 429 and other answers", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, { reset: true, hadProfile: true }));
    expect(await resetVoice(f)).toEqual({ kind: "reset", hadProfile: true, message: "Reset. It rebuilds next week." });
    expect(f.mock.calls[0][0]).toBe("/api/exec/settings/voice-reset");
    expect(f.mock.calls[0][1]?.body).toBeUndefined();
    expect(await resetVoice(async () => json(409, { error: "not_installed" }))).toMatchObject({ kind: "failed", message: "Not available yet." });
    expect(await resetVoice(async () => json(429, { error: "rate_limited", retryAfterSeconds: 9 }))).toMatchObject({ message: "Too many changes at once. Try again in 9 s." });
    expect(await resetVoice(async () => json(503, { error: "unavailable" }))).toMatchObject({ message: "Couldn't reset. Try again." });
  });
});

// ---------------------------------------------------------------------------
// Rule 16 (a-build-6): the client files' module graphs hold no server-only module
// ---------------------------------------------------------------------------

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** Runtime imports of a file (import-type declarations and all-type specifier lists skipped). */
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    if (m[4]) {
      out.push(m[4]);
      continue;
    }
    const clause = m[2].trim();
    if (/^type\s/.test(clause)) continue;
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces && braces[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[3]);
  }
  return out;
}

function serverOnlyIn(entry: string): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    if (/^\s*import\s+["']server-only["']/m.test(src)) bad.push(path.relative(SRC, file));
    for (const spec of runtimeImports(file)) {
      if (spec === "server-only") continue;
      const next = resolveImport(file, spec);
      if (next) stack.push(next);
    }
  }
  return bad;
}

describe("Rule 16: client module graphs (test 75, a-build-6)", () => {
  for (const rel of ["components/exec/settings/SettingsForm.tsx", "components/exec/settings/VoiceResetButton.tsx", "components/exec/feed/FeedList.tsx", "components/exec/team/TeamTable.tsx"]) {
    it(`${rel} starts with "use client" and reaches no server-only module`, () => {
      const file = path.join(SRC, rel);
      expect(readFileSync(file, "utf8").trimStart().startsWith('"use client";')).toBe(true);
      expect(serverOnlyIn(file)).toEqual([]);
    });
  }

  it("the walk does find a server-only module when one is reached (control)", () => {
    expect(serverOnlyIn(path.join(SRC, "lib/exec/settings.ts")).length).toBeGreaterThan(0);
  });

  it("the pure ui modules are client-safe", () => {
    for (const rel of ["lib/exec/ui/feed-state.ts", "lib/exec/ui/feed-api.ts", "lib/exec/ui/snooze-presets.ts", "lib/exec/ui/team-sort.ts", "lib/exec/ui/settings-api.ts"]) {
      expect(serverOnlyIn(path.join(SRC, rel)), rel).toEqual([]);
    }
  });
});
