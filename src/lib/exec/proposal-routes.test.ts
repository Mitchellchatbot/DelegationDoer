import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/proposals", () => ({ confirmProposal: vi.fn(), dismissProposal: vi.fn(), newTaskId: vi.fn() }));

import * as confirmRoute from "@/app/api/exec/tasks/proposals/[id]/confirm/route";
import * as dismissRoute from "@/app/api/exec/tasks/proposals/[id]/dismiss/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import type { ProposalView } from "@/lib/exec/chat/view-types";
import { jsonError, rateLimit } from "@/lib/exec/http";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { confirmProposal, dismissProposal, type ConfirmOutcome } from "@/lib/exec/proposals";
import { AuditUnavailableError, type ExecSettings } from "@/lib/exec/types";

// POST /api/exec/tasks/proposals/:id/confirm and /dismiss (P5b contract §3.16.3; tests 85's route half, 86, 87):
// the gate order, same-origin, the id and the confirm body, the chat setting, the "proposal" bucket, the audit
// row (ids only), and every outcome's exact answer. proposals.ts itself is tested in proposals.test.ts.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const PID = `etp_${"1".repeat(32)}`;
const HASH = "a".repeat(64);
const BASE = "https://operations.scaledai.org/api/exec/tasks/proposals";
const SAME = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({ ...DEFAULT_SETTINGS, principalId: principal.id, chatSchemaReady: true, chatEnabled: true, ...over });
const VIEW: ProposalView = {
  id: PID, status: "confirming", title: "[Removed]", description: "", assigneeName: "Ann Lee", departmentName: "Website", dueOn: "2026-11-10",
  clientName: "Acme Dental", priority: "high", taskHref: "/tasks/t_1", expiresAt: "2026-11-14T14:00:00.000Z", contentHash: "b".repeat(64),
  privacyNotice: true, redacted: true
};

const confirmReq = (body: unknown, headers: Record<string, string> = SAME) =>
  new Request(`${BASE}/${PID}/confirm`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const doConfirm = (body: unknown = { contentHash: HASH }, id = PID, headers: Record<string, string> = SAME) => confirmRoute.POST(confirmReq(body, headers), { params: { id } });
const doDismiss = (id = PID, headers: Record<string, string> = SAME, body?: string) =>
  dismissRoute.POST(new Request(`${BASE}/${id}/dismiss`, { method: "POST", headers, body }), { params: { id } });
const answer = async (res: Response | Promise<Response>) => {
  const r = await res;
  return [r.status, await r.json()] as const;
};
const order = (...fns: unknown[]) => fns.map((f) => (f as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

beforeEach(() => {
  vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: true, principal });
  vi.mocked(rateLimit).mockResolvedValue({ ok: true });
  vi.mocked(auditStart).mockResolvedValue(55);
  vi.mocked(auditFinish).mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(confirmProposal).mockResolvedValue({ kind: "confirmed", taskId: "t_mhmh1234_abcde" });
  vi.mocked(dismissProposal).mockResolvedValue({ kind: "dismissed" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the route files", () => {
  it("export only their handler and the route config", () => {
    for (const m of [confirmRoute, dismissRoute]) {
      expect(Object.keys(m).sort()).toEqual(["POST", "dynamic", "runtime"]);
      expect(m.dynamic).toBe("force-dynamic");
      expect(m.runtime).toBe("nodejs");
    }
  });
});

describe.each([
  ["confirm", () => doConfirm(), "POST /api/exec/tasks/proposals/:id/confirm", () => confirmProposal],
  ["dismiss", () => doDismiss(), "POST /api/exec/tasks/proposals/:id/dismiss", () => dismissProposal]
] as const)("%s: gate order (test 87)", (name, call, route, act) => {
  const later = () => [loadSettings, rateLimit, auditStart, act()];

  it("the gate with the step-up first; its own answer, nothing else runs", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) });
    expect((await call()).status).toBe(404);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), route, { requireStrongSignIn: true });
    for (const f of later()) expect(f).not.toHaveBeenCalled();
  });

  it("same-origin → 403 forbidden before the id, settings or anything else", async () => {
    const res = name === "confirm" ? await doConfirm({ contentHash: HASH }, PID, { "sec-fetch-site": "cross-site" }) : await doDismiss(PID, { "sec-fetch-site": "same-site" });
    expect([res.status, await res.json()]).toEqual([403, { error: "forbidden" }]);
    for (const f of later()) expect(f).not.toHaveBeenCalled();
  });

  it.each(["etp_123", `ecm_${"1".repeat(32)}`, `etp_${"A".repeat(32)}`])("400 bad_request for the id %s", async (id) => {
    const res = name === "confirm" ? await doConfirm({ contentHash: HASH }, id) : await doDismiss(id);
    expect([res.status, await res.json()]).toEqual([400, { error: "bad_request" }]);
    for (const f of later()) expect(f).not.toHaveBeenCalled();
  });

  it("chat off (not installed, or off) → 403 chat_off before the rate limit; a settings failure → 503", async () => {
    for (const over of [{ chatSchemaReady: false, chatEnabled: false }, { chatEnabled: false }]) {
      vi.mocked(loadSettings).mockResolvedValue(settings(over));
      expect(await answer(call())).toEqual([403, { error: "chat_off" }]);
    }
    vi.mocked(loadSettings).mockRejectedValue(new Error("SECRET"));
    expect(await answer(call())).toEqual([503, { error: "unavailable" }]);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("the proposal bucket: 30 per 10 minutes; its 429 and 503 pass through before the audit row", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 31 }) });
    const res = await call();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("31");
    expect(rateLimit).toHaveBeenCalledWith(principal, "proposal", 30, 600_000, { now: expect.any(Date) });
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(503, "unavailable") });
    expect(await answer(call())).toEqual([503, { error: "unavailable" }]);
    expect(auditStart).not.toHaveBeenCalled();
    expect(act()).not.toHaveBeenCalled();
  });

  it("audit unavailable → 503 audit_unavailable, and nothing acts", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("down"));
    expect(await answer(call())).toEqual([503, { error: "audit_unavailable" }]);
    expect(act()).not.toHaveBeenCalled();
  });

  it("all passing: gate → settings → rate → audit → act; the audit row carries the id only", async () => {
    await call();
    const [g, s, r, a, x] = order(requireExecPrincipal, loadSettings, rateLimit, auditStart, act());
    expect(g < s && s < r && r < a && a < x).toBe(true);
    expect(auditStart).toHaveBeenCalledWith(principal, {
      actor: "owner", action: `chat.proposal.${name}`, target: `exec_task_proposals:${PID}`, input: { proposalId: PID }
    });
  });

  it("an act that throws → 503 unavailable, the audit row finished ok: false, the error never echoed", async () => {
    vi.mocked(act()).mockRejectedValue(new Error("exec proposals: SECRET failed"));
    expect(await answer(call())).toEqual([503, { error: "unavailable" }]);
    expect(auditFinish).toHaveBeenCalledWith(55, { ok: false, result: { outcome: "unavailable" } });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });
});

describe("confirm: the body (test 87)", () => {
  it.each([
    ["missing", {}],
    ["malformed", { contentHash: "xyz" }],
    ["upper-case hex", { contentHash: "A".repeat(64) }],
    ["63 characters", { contentHash: "a".repeat(63) }],
    ["not a string", { contentHash: 42 }],
    ["an unknown key", { contentHash: HASH, title: "Other title" }],
    ["an array", [HASH]],
    ["not JSON", "{nope"],
    ["empty", ""],
    ["over 1 KB", JSON.stringify({ contentHash: HASH, pad: "x".repeat(1100) })]
  ])("%s → 400 bad_request, nothing read", async (_name, body) => {
    expect(await answer(doConfirm(body))).toEqual([400, { error: "bad_request" }]);
    expect(loadSettings).not.toHaveBeenCalled();
    expect(confirmProposal).not.toHaveBeenCalled();
  });

  it("the hash reaches confirmProposal as sent, with the request's time and its own signal", async () => {
    await doConfirm();
    expect(confirmProposal).toHaveBeenCalledWith(principal, PID, expect.any(Date), { contentHash: HASH, signal: expect.any(AbortSignal) });
    expect(vi.mocked(confirmProposal).mock.calls[0][3].signal?.aborted).toBe(false);
  });
});

describe("confirm: outcomes (test 85's route half, 119)", () => {
  it.each([
    [{ kind: "confirmed", taskId: "t_mhmh1234_abcde" }, 200, { status: "confirmed", taskId: "t_mhmh1234_abcde", taskHref: "/tasks/t_mhmh1234_abcde" }],
    [{ kind: "not_found" }, 404, { error: "not_found" }],
    [{ kind: "changed", proposal: VIEW }, 409, { error: "changed", proposal: VIEW }],
    [{ kind: "not_pending", status: "dismissed" }, 409, { error: "not_pending", status: "dismissed" }],
    [{ kind: "not_pending", status: "withdrawn" }, 409, { error: "not_pending", status: "withdrawn" }],
    [{ kind: "in_progress" }, 409, { error: "in_progress" }],
    [{ kind: "expired" }, 410, { error: "expired" }],
    [{ kind: "assignee_unavailable" }, 409, { error: "assignee_unavailable" }]
  ] as [ConfirmOutcome, number, Record<string, unknown>][])("%o → %i", async (outcome, status, body) => {
    vi.mocked(confirmProposal).mockResolvedValue(outcome);
    const res = await doConfirm();
    expect([res.status, await res.json()]).toEqual([status, body]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const finished = vi.mocked(auditFinish).mock.calls[0][1];
    expect(finished.ok).toBe(outcome.kind === "confirmed");
    expect(finished.result).toEqual(outcome.kind === "confirmed" ? { outcome: "confirmed", taskId: "t_mhmh1234_abcde" } : { outcome: outcome.kind });
    // Never the title or description, in the audit row's input or result.
    expect(JSON.stringify([vi.mocked(auditStart).mock.calls, vi.mocked(auditFinish).mock.calls])).not.toMatch(/Removed|Acme|Ann Lee/);
  });
});

describe("dismiss: outcomes (test 86's route half)", () => {
  it.each([
    [{ kind: "dismissed" }, 200, { status: "dismissed" }],
    [{ kind: "not_found" }, 404, { error: "not_found" }],
    [{ kind: "not_pending", status: "confirmed" }, 409, { error: "not_pending", status: "confirmed" }],
    [{ kind: "not_pending", status: "confirmed", taskId: "t_mhmh1234_abcde" }, 409, { error: "not_pending", status: "confirmed", taskId: "t_mhmh1234_abcde" }]
  ] as const)("%o → %i", async (outcome, status, body) => {
    vi.mocked(dismissProposal).mockResolvedValue(outcome);
    const res = await doDismiss();
    expect([res.status, await res.json()]).toEqual([status, body]);
    expect(auditFinish).toHaveBeenCalledWith(55, { ok: outcome.kind === "dismissed", result: { outcome: outcome.kind } });
  });

  it("the body is ignored (any body, even not JSON)", async () => {
    expect((await doDismiss(PID, SAME, "{not json")).status).toBe(200);
    expect(dismissProposal).toHaveBeenCalledWith(principal, PID, expect.any(Date), { signal: expect.any(AbortSignal) });
  });
});
