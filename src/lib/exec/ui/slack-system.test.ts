import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => {
  const none = () => vi.fn(async () => []);
  return {
    getPendingApprovals: none(),
    listActivitySince: none(),
    listDepartments: none(),
    listEodNotesForDate: none(),
    listOpenTasks: none(),
    listProjects: none(),
    listProjectStages: none(),
    listStatusChangeEntries: none(),
    listTasksByIds: none(),
    listTasksCompletedBetween: none(),
    listTasksCreatedBetween: none(),
    listTimeEntriesBetween: none(),
    listUsers: none()
  };
});
vi.mock("@/lib/exec/attention", () => ({ lastAttentionRefresh: vi.fn(async () => null), syncAttention: vi.fn() }));
vi.mock("@/lib/exec/attention-read", () => ({
  listScreenedAttention: vi.fn(async () => ({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" }))
}));
vi.mock("@/lib/exec/ddtext-store", () => ({ ddtextLastRunAt: vi.fn(async () => null) }));
vi.mock("@/lib/exec/email-view", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/email-view")>()), loadEmailGate: vi.fn() }));
// Area A's summary, at its module boundary (slack-install.test.ts covers it).
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), slackSystemSummary: vi.fn() }));

import { SystemSection } from "@/components/exec/overview/SystemSection";
import { loadEmailGate } from "@/lib/exec/email-view";
import { getOverview, type OverviewSection, type OverviewSystem } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { SlackStoreError, slackSystemSummary } from "@/lib/exec/slack-install";
import type { SlackSystemSummary } from "@/lib/exec/slack-types";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { textOf } from "../__tests__/p5a-ui-fixtures";
import { findSentinel } from "../__tests__/slack-assert";

// P6 contract §3.15.3 (Area E; SE10's data side, bindings AM12): getOverview's System section carries
// `slack?: SlackSystemSummary | null` like P4's `drafts?`: absent while P5b's chat schema (which P6's migration
// requires) isn't installed or the P6 tables aren't there, the summary when read, null when a read failed.

const NOW = new Date("2026-11-06T15:00:00.000Z");
const P: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({ principalId: P.id, ...DEFAULT_SETTINGS, ...over });

/** exec_jobs and anything else: every chain ends in an empty page (the job health the System card needs to load). */
function emptyDb(): unknown {
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok, bad);
        return () => builder;
      }
    }
  );
  return { from: () => builder, rpc: () => builder };
}

function system(o: Awaited<ReturnType<typeof getOverview>>): OverviewSystem {
  const s = o.sections.system;
  if (!s.ok) throw new Error("expected the System section to load");
  return s.data;
}

let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReturnValue(emptyDb() as SupabaseClient);
  vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: settings({ chatSchemaReady: true }) });
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getOverview: the System card's slack field (§3.15.3)", () => {
  it("chat installed: the summary, as read, for every state", async () => {
    const states: SlackSystemSummary[] = [
      { state: "connected", lastDmAt: "2026-11-06T14:00:00.000Z", lastErrorCode: null, revokedAt: null },
      { state: "error", lastDmAt: null, lastErrorCode: "invalid_auth", revokedAt: null },
      { state: "revoked", lastDmAt: null, lastErrorCode: null, revokedAt: "2026-11-05T18:00:00.000Z" },
      { state: "not_connected", lastDmAt: null, lastErrorCode: null, revokedAt: null }
    ];
    for (const s of states) {
      vi.mocked(slackSystemSummary).mockResolvedValueOnce(s);
      expect(system(await getOverview(P, NOW)).slack, s.state).toEqual(s);
    }
    expect(slackSystemSummary).toHaveBeenCalledWith(P);
    expect(errors).not.toHaveBeenCalled();
  });

  it("before P5b's chat schema: no slack key and nothing read; the P6 tables missing (summary null): no key either", async () => {
    vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: settings({ chatSchemaReady: false }) });
    const before = system(await getOverview(P, NOW));
    expect("slack" in before).toBe(false);
    expect(slackSystemSummary).not.toHaveBeenCalled();
    vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: settings({ chatSchemaReady: true }) });
    vi.mocked(slackSystemSummary).mockResolvedValue(null);
    const missing = system(await getOverview(P, NOW));
    expect("slack" in missing).toBe(false);
    expect(slackSystemSummary).toHaveBeenCalledTimes(1);
  });

  it("a failed read: slack null (the card says couldn't load), logged once without values; the rest of the card loads", async () => {
    vi.mocked(slackSystemSummary).mockRejectedValue(new SlackStoreError("getActiveInstallation", "XX000"));
    const s = system(await getOverview(P, NOW));
    expect(s.slack).toBeNull();
    expect(s.kinds.length).toBeGreaterThan(0);
    const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("slack"));
    expect(lines).toEqual(["[exec-overview] slack status read failed: exec slack store: getActiveInstallation failed (XX000)"]);
    expect(findSentinel(errors.mock.calls)).toBeNull();
    // The settings read failing: like the drafts rows, "couldn't load".
    vi.mocked(loadEmailGate).mockRejectedValue(new Error("settings down"));
    expect(system(await getOverview(P, NOW)).slack).toBeNull();
  });

  it("the card renders the row from the section, and none without it", async () => {
    vi.mocked(slackSystemSummary).mockResolvedValueOnce({ state: "error", lastDmAt: null, lastErrorCode: "token_revoked", revokedAt: null });
    const o = await getOverview(P, NOW);
    const html = renderToStaticMarkup(createElement(SystemSection, { system: o.sections.system as OverviewSection<OverviewSystem>, now: o.generatedAt, tz: o.timezone }));
    expect(textOf(/<ul data-slack-system[^]*?<\/ul>/.exec(html)?.[0] ?? "")).toBe("Slack Needs attention: Slack rejected a request (token_revoked)");
    vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: settings() });
    const off = await getOverview(P, NOW);
    expect(renderToStaticMarkup(createElement(SystemSection, { system: off.sections.system, now: off.generatedAt, tz: off.timezone }))).not.toContain("data-slack-system");
  });
});
