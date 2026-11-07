import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/agent/budget", () => ({ effectiveChatCapUsd: vi.fn(() => 9) }));
vi.mock("@/lib/exec/http", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/http")>()),
  rateLimit: vi.fn(async () => ({ ok: true })),
  runAudited: vi.fn(async (_p: unknown, _e: unknown, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }))
}));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/settings")>()),
  getSettingsView: vi.fn(async () => ({ marker: "view" })),
  updateSettings: vi.fn()
}));

import * as settingsRoute from "@/app/api/exec/settings/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { rateLimit } from "@/lib/exec/http";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { updateSettings } from "@/lib/exec/settings";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// T70's route half: P5a's PATCH /api/exec/settings takes P5b's three fields
// from the registry with no route change (contract §3.2): its body schema
// checks their bounds, and a chat field before the P5b migration is 409
// not_installed with nothing written.

const PRINCIPAL: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();
const V1 = "2026-11-07T09:00:00.123456+00:00";
const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  principalId: "ep_1", ...DEFAULT_SETTINGS, emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: true, chatSchemaReady: true, ...over
});
const patch = (body: unknown) =>
  settingsRoute.PATCH(
    new Request("https://ops.test/api/exec/settings", {
      method: "PATCH",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  );

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(requireExecPrincipal).mockReset().mockResolvedValue({ ok: true, principal: PRINCIPAL });
  vi.mocked(loadSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(updateSettings).mockReset().mockResolvedValue({ outcome: "updated", snapshot: { settings: settings({ chatEnabled: true }), version: V1 } });
});

describe("PATCH /api/exec/settings with P5b's fields (T70)", () => {
  it("installed: each chat field passes the body schema and reaches updateSettings", async () => {
    for (const p of [{ chatEnabled: true }, { askAiUsesExec: true }, { chatDailyCapUsd: 0 }, { chatDailyCapUsd: 100 }, { chatDailyCapUsd: 12.34 }]) {
      const res = await patch({ patch: p, expectedVersion: V1 });
      expect(res.status, JSON.stringify(p)).toBe(200);
      expect(vi.mocked(updateSettings).mock.calls.at(-1)?.[1]).toEqual(p);
    }
  });

  it("out of bounds or the wrong type: 400 invalid naming the field, before the settings read", async () => {
    for (const [p, detail] of [
      [{ chatDailyCapUsd: 100.01 }, "patch.chatDailyCapUsd"],
      [{ chatDailyCapUsd: -1 }, "patch.chatDailyCapUsd"],
      [{ chatDailyCapUsd: 1.005 }, "patch.chatDailyCapUsd"],
      [{ chatDailyCapUsd: "9" }, "patch.chatDailyCapUsd"],
      [{ chatEnabled: "true" }, "patch.chatEnabled"],
      [{ askAiUsesExec: 1 }, "patch.askAiUsesExec"]
    ] as const) {
      const res = await patch({ patch: p, expectedVersion: V1 });
      expect(res.status, JSON.stringify(p)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid", detail });
    }
    expect(loadSettings).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("not installed (chatSchemaReady false): 409 not_installed with the field; no rate slot used, nothing written", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ chatSchemaReady: false }));
    for (const field of ["chatEnabled", "askAiUsesExec", "chatDailyCapUsd"] as const) {
      const res = await patch({ patch: { [field]: field === "chatDailyCapUsd" ? 5 : true }, expectedVersion: V1 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "not_installed", field });
    }
    // A base field still saves without the P5b migration.
    expect((await patch({ patch: { retentionDaysChat: 30 }, expectedVersion: V1 })).status).toBe(200);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});
