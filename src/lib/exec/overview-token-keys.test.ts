import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", () => {
  const none = () => vi.fn(async () => []);
  return {
    getPendingApprovals: none(), listActivitySince: none(), listDepartments: none(), listEodNotesForDate: none(), listOpenTasks: none(), listProjects: none(),
    listProjectStages: none(), listStatusChangeEntries: none(), listTasksByIds: none(), listTasksCompletedBetween: none(), listTasksCreatedBetween: none(),
    listTimeEntriesBetween: none(), listUsers: none()
  };
});
vi.mock("@/lib/exec/attention", () => ({ lastAttentionRefresh: vi.fn(async () => null), syncAttention: vi.fn() }));
vi.mock("@/lib/exec/attention-read", () => ({
  listScreenedAttention: vi.fn(async () => ({ items: [], nextCursor: null, hiddenEmail: 0, emailScreen: "none" }))
}));
vi.mock("@/lib/exec/ddtext-store", () => ({ ddtextLastRunAt: vi.fn(async () => null) }));
vi.mock("@/lib/exec/email-view", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/email-view")>()), loadEmailGate: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), slackSystemSummary: vi.fn(),
  slackTokenKeyIds: vi.fn() }));

import { loadEmailGate } from "@/lib/exec/email-view";
import { getOverview, type OverviewSystem } from "@/lib/exec/overview";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { SlackStoreError, slackSystemSummary, slackTokenKeyIds } from "@/lib/exec/slack-install";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P9 F13 (seed S3's producer; Area C): getOverview's System section carries tokenKeys = { previousKey, unknownKey }: how many of
// his active installation's stored Slack token blobs are sealed under EXEC_TOKEN_KEY_PREVIOUS's key id, or under a key id neither
// key has, compared by the key ids slackTokenKeyIds reads out of the blobs (never decrypted). Absent while chat isn't installed
// or there is no active installation; null when a read or the keys fail. Area A renders the row.

const NOW = new Date("2026-11-09T15:00:00.000Z");
const KEY_A = Buffer.alloc(32, 0xa1).toString("base64");
const KEY_B = Buffer.alloc(32, 0xb2).toString("base64");
const kid = (key: string) => createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);
const P: ExecPrincipal = principalFromRows(
  { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({ principalId: P.id, ...DEFAULT_SETTINGS, ...over });

/** exec_jobs and anything else: every chain ends in an empty page. */
function emptyDb(): unknown {
  const builder: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok, bad);
      return () => builder;
    }
  });
  return { from: () => builder, rpc: () => builder };
}
async function system(): Promise<OverviewSystem> {
  const s = (await getOverview(P, NOW)).sections.system;
  if (!s.ok) throw new Error("expected the System section to load");
  return s.data;
}

let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReturnValue(emptyDb() as SupabaseClient);
  vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: settings({ chatSchemaReady: true }) });
  vi.mocked(slackSystemSummary).mockReset().mockResolvedValue({ state: "connected", lastDmAt: null, lastErrorCode: null, revokedAt: null });
  vi.mocked(slackTokenKeyIds).mockReset();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("EXEC_TOKEN_KEY", KEY_B);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", KEY_A);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});
afterEach(() => {
  errors.mockRestore();
  vi.unstubAllEnvs();
});

describe("getOverview: the System card's tokenKeys (P9 F13, seed S3)", () => {
  it("OK-1 counts the blobs on the previous key and on an unknown key; the current key counts nowhere", async () => {
    vi.mocked(slackTokenKeyIds).mockResolvedValue({ bot: kid(KEY_A), user: kid(KEY_B) });
    expect((await system()).tokenKeys).toEqual({ previousKey: 1, unknownKey: 0 });
    vi.mocked(slackTokenKeyIds).mockResolvedValue({ bot: kid(KEY_A), user: kid(KEY_A) });
    expect((await system()).tokenKeys).toEqual({ previousKey: 2, unknownKey: 0 });
    vi.mocked(slackTokenKeyIds).mockResolvedValue({ bot: "0badc0de", user: null });
    expect((await system()).tokenKeys).toEqual({ previousKey: 0, unknownKey: 1 });
    vi.mocked(slackTokenKeyIds).mockResolvedValue({ bot: kid(KEY_B), user: kid(KEY_B) });
    expect((await system()).tokenKeys).toEqual({ previousKey: 0, unknownKey: 0 });
    // Without EXEC_TOKEN_KEY_PREVIOUS, a blob on A is on an unknown key (it no longer opens).
    vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
    vi.mocked(slackTokenKeyIds).mockResolvedValue({ bot: kid(KEY_A), user: null });
    expect((await system()).tokenKeys).toEqual({ previousKey: 0, unknownKey: 1 });
    expect(slackTokenKeyIds).toHaveBeenCalledWith(P, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(errors).not.toHaveBeenCalled();
  });

  it("OK-2 absent before P5b's chat schema (nothing read) and with no active installation; null when the read, the settings or the keys fail (logged without values)", async () => {
    vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: settings({ chatSchemaReady: false }) });
    expect("tokenKeys" in (await system())).toBe(false);
    expect(slackTokenKeyIds).not.toHaveBeenCalled();
    vi.mocked(loadEmailGate).mockResolvedValue({ kind: "off", settings: settings({ chatSchemaReady: true }) });
    vi.mocked(slackTokenKeyIds).mockResolvedValue(null);
    expect("tokenKeys" in (await system())).toBe(false);
    vi.mocked(slackTokenKeyIds).mockRejectedValue(new SlackStoreError("slackTokenKeyIds", "XX000"));
    const failed = await system();
    expect(failed.tokenKeys).toBeNull();
    expect(failed.kinds.length).toBeGreaterThan(0);
    expect(errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("token key"))).toEqual([
      "[exec-overview] token key ids read failed: exec slack store: slackTokenKeyIds failed (XX000)"
    ]);
    vi.mocked(slackTokenKeyIds).mockResolvedValue({ bot: kid(KEY_A), user: null });
    vi.stubEnv("EXEC_TOKEN_KEY", "");
    expect((await system()).tokenKeys).toBeNull();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(KEY_A);
    vi.stubEnv("EXEC_TOKEN_KEY", KEY_B);
    vi.mocked(loadEmailGate).mockRejectedValue(new Error("settings down"));
    expect((await system()).tokenKeys).toBeNull();
  });
});
