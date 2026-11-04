import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipalForPage: vi.fn() }));
vi.mock("@/lib/exec/overview", () => ({ getOverview: vi.fn() }));

import * as pageModule from "@/app/(main)/executive/page";
import { requireExecPrincipalForPage } from "@/lib/exec/access";
import { getOverview, type ExecOverview } from "@/lib/exec/overview";
import { principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";

// The /executive page: the owner gate runs before anything is read or
// rendered, a denied gate reads nothing, and the page renders the Overview
// in the principal's zone.

const Page = pageModule.default;
const NNBSP = String.fromCharCode(0x202f);

function mint(tz: string): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: tz },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const FAILED = { ok: false, error: "unavailable" } as const;

function overview(timezone: string): ExecOverview {
  return {
    generatedAt: "2026-11-04T15:00:00.000Z",
    timezone,
    sections: { tiles: FAILED, attention: FAILED, approvals: FAILED, deadlines: FAILED, projects: FAILED, system: FAILED }
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/executive page", () => {
  it("checks the principal first, then reads the overview, then renders it in his zone", async () => {
    const principal = mint("Asia/Karachi");
    vi.mocked(requireExecPrincipalForPage).mockResolvedValue(principal);
    vi.mocked(getOverview).mockResolvedValue(overview("Asia/Karachi"));

    const out = renderToStaticMarkup(await Page()).split(NNBSP).join(" ");

    expect(requireExecPrincipalForPage).toHaveBeenCalledWith("GET /executive");
    expect(getOverview).toHaveBeenCalledWith(principal);
    expect(vi.mocked(requireExecPrincipalForPage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(getOverview).mock.invocationCallOrder[0]);
    expect(out).toContain("Executive AI Assistant");
    // 15:00Z is 8 PM in Karachi.
    expect(out).toContain("Nov 4, 8:00 PM GMT+5");
  });

  it("reads nothing when the gate refuses", async () => {
    const notFound = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
    vi.mocked(requireExecPrincipalForPage).mockRejectedValue(notFound);
    await expect(Page()).rejects.toBe(notFound);
    expect(getOverview).not.toHaveBeenCalled();
  });

  it("renders per request and names nothing in the document head", () => {
    expect(pageModule.dynamic).toBe("force-dynamic");
    expect("metadata" in pageModule).toBe(false);
    expect("generateMetadata" in pageModule).toBe(false);
  });
});
