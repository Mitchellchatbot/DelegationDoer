import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/brief-ownership-load", () => ({ loadBriefOwnership: vi.fn(), checkinApprovalSource: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  openInstallationById: vi.fn(), recordSlackError: vi.fn(), enqueueRevokeCheck: vi.fn(), clearSlackError: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUsers: vi.fn(), listDepartments: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), putSyncState: vi.fn() }));
vi.mock("@/lib/exec/brief-checkins", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-checkins")>()), rewriteCheckinText: vi.fn() }));

import { assertNoBriefText, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { checkinId, NOW, PRINCIPAL, settle } from "@/lib/exec/__tests__/brief-d-harness";
import { checkinRow, clickCtx, clickPayload, messageText, postsAsHim, sendButtons, setupClickWorld, valueOf, type ClickWorld } from "@/lib/exec/__tests__/checkin-click-harness";
import { auditEvent } from "@/lib/exec/audit";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import { rewriteCheckinText } from "@/lib/exec/brief-checkins";
import { CHECKIN_REWRITE_JOB_KIND, checkinRewriteJobHandler } from "@/lib/exec/handlers/checkin-rewrite";
import { CHECKIN_SEND_JOB_KIND, checkinSendJobHandler, type CheckinResult } from "@/lib/exec/handlers/checkin-send";
import { notifyOps } from "@/lib/exec/ops";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";

// P8 §5.11 CI10, CI24, CI25, CI31 (Area D): exec.checkin-rewrite, one Rewrite click (M6, C10; intel-17). The model's rewrite
// (brief-checkins.ts rewriteCheckinText, tested in brief-checkins.test.ts) is mocked here; the store, the MAC and the
// re-rendered check-ins message are real.

let w: ClickWorld;
let out: ReturnType<typeof captureConsole>;
const ID1 = checkinId(1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  w = setupClickWorld();
  vi.mocked(rewriteCheckinText).mockReset();
  vi.mocked(rewriteCheckinText).mockResolvedValue("Jane, anything I can take off your plate this week?");
});
afterEach(() => {
  assertNoBriefText(out.calls(), { label: "console" });
  assertNoBriefText(vi.mocked(notifyOps), { label: "notifyOps" });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const rewrite = (value = valueOf(w.db, ID1)) => settle(checkinRewriteJobHandler.run(clickCtx(CHECKIN_REWRITE_JOB_KIND, clickPayload(ID1, value))) as Promise<CheckinResult>);

describe("CI24 the rewrite", () => {
  it("proposed only; one model call; rev + 1 by CAS; auditEvent with ids only; the new button carries rev 2 and a new MAC", async () => {
    const before = valueOf(w.db, ID1);
    expect(await rewrite()).toEqual({ status: "proposed", reason: "rewritten" });
    expect(rewriteCheckinText).toHaveBeenCalledTimes(1);
    const [p, row, candidate] = vi.mocked(rewriteCheckinText).mock.calls[0];
    expect(p).toBe(PRINCIPAL);
    expect(row).toMatchObject({ id: ID1, rev: 1 });
    expect(candidate).toEqual({ firstName: "Person1", departments: ["Operations"], role: "worker" });
    expect(checkinRow(w.db, ID1)).toMatchObject({ rev: 2, text: "Jane, anything I can take off your plate this week?", status: "proposed" });
    expect(vi.mocked(auditEvent).mock.calls).toEqual([[PRINCIPAL, { actor: "slack", action: "brief.checkin.rewrite", target: `exec_brief_checkins:${ID1}`, input: { checkinId: ID1, rev: 1 } }]]);
    const after = valueOf(w.db, ID1);
    expect(after).not.toBe(before);
    expect(after.split(".")[2]).toBe("2");
    expect(sendButtons(w.ws)).toContain(after);
    expect(sendButtons(w.ws)).not.toContain(before);
  });

  it("CI10 the rev-1 button after the rewrite answers stale; nothing posted", async () => {
    const before = valueOf(w.db, ID1);
    await rewrite();
    const r = await settle(checkinSendJobHandler.run(clickCtx(CHECKIN_SEND_JOB_KIND, clickPayload(ID1, before))) as Promise<CheckinResult>);
    expect(r).toEqual({ status: "proposed", reason: "stale" });
    expect(postsAsHim(w.ws)).toEqual([]);
  });

  it("a concurrent send (the row now sending) → the rewrite's CAS fails and nothing changes", async () => {
    vi.mocked(rewriteCheckinText).mockImplementationOnce(async () => {
      Object.assign(checkinRow(w.db, ID1), { status: "sending", sending_at: NOW.toISOString(), audit_id: 9 });
      return "A new note.";
    });
    expect(await rewrite()).toEqual({ status: "proposed", reason: "lost_race" });
    expect(checkinRow(w.db, ID1)).toMatchObject({ rev: 1, status: "sending" });
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("a sending row only re-renders (its text can't change under a send)", async () => {
    Object.assign(checkinRow(w.db, ID1), { status: "sending", sending_at: NOW.toISOString(), audit_id: 9 });
    expect(await rewrite()).toEqual({ status: "sending", reason: "in_flight" });
    expect(rewriteCheckinText).not.toHaveBeenCalled();
  });
});

describe("CI25, CI31 failures leave a live button", () => {
  it("CI25 a model failure → the busy note, the row unchanged", async () => {
    vi.mocked(rewriteCheckinText).mockResolvedValueOnce(null);
    expect(await rewrite()).toEqual({ status: "proposed", reason: "model_failed" });
    expect(checkinRow(w.db, ID1)).toMatchObject({ rev: 1 });
    expect(messageText(w.ws)).toContain(escapeMrkdwn(BRIEF_COPY.checkinsPaused.busy));
  });

  it("CI31 after a failed rewrite a second Rewrite click runs a new job and rewrites; two racing clicks → one rev + 1, the other re-renders", async () => {
    vi.mocked(rewriteCheckinText).mockResolvedValueOnce(null);
    await rewrite();
    expect(await rewrite()).toEqual({ status: "proposed", reason: "rewritten" });
    expect(checkinRow(w.db, ID1).rev).toBe(2);
    const value = valueOf(w.db, ID1);
    const results = await settle(Promise.all([
      checkinRewriteJobHandler.run(clickCtx(CHECKIN_REWRITE_JOB_KIND, clickPayload(ID1, value))),
      checkinRewriteJobHandler.run(clickCtx(CHECKIN_REWRITE_JOB_KIND, clickPayload(ID1, value)))
    ]) as Promise<CheckinResult[]>);
    expect(checkinRow(w.db, ID1).rev).toBe(3);
    expect(results.map((r) => (r as { reason: string }).reason).sort()).toEqual(["lost_race", "rewritten"]);
  });

  it("results carry codes only; the handler is interactive, 60 s", async () => {
    assertNoBriefText(await rewrite());
    expect(checkinRewriteJobHandler).toMatchObject({ kind: "exec.checkin-rewrite", lane: "interactive", timeoutMs: 60_000 });
  });
});
