import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), openInstallationById: vi.fn() }));
vi.mock("@/lib/exec/slack-reply-send", () => ({ sendSlackReply: vi.fn(), sentNotRecorded: (o: { reason?: string }) => o.reason === "not_recorded" }));
vi.mock("@/lib/exec/slack-reply-view", () => ({ rerenderReplyCards: vi.fn() }));

import { replyButtonValue, SecretUnavailableError } from "@/lib/exec/crypto";
import { slackRdraftSendJobHandler } from "@/lib/exec/handlers/slack-rdraft-send";
import { openInstallationById } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS, type SendOutcome } from "@/lib/exec/slack-p10-types";
import { sendSlackReply } from "@/lib/exec/slack-reply-send";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { NonRetryableError } from "@/lib/exec/types";
import { assertNoReplyText } from "../__tests__/p10-assert";
import { CH, DM, INST, NOW, P, TOKEN_KEY, jobCtx, openInstallation } from "../__tests__/reply-d-harness";

// P10 §5.9 RK07 and RK12 (Area D): the DM card's Send job. The payload's shape, the value naming this draft and version, the
// installation and its DM, then sendSlackReply on the DM path from Slack (the literals "dm" and "slack", B-P10-14 (c)) and the
// card re-rendered with the outcome (dd_only / needs_ack: "Check and send in DD" with the reasons, prefixed). The send itself
// is mocked at its module boundary (slack-reply-send.test.ts tests it). Invented names only.

const ID = `esr_${"b".repeat(32)}`;
let value: string;
const payload = (over: Record<string, unknown> = {}) => ({
  installation_id: INST, action: "send", draft_id: ID, version: 2, value, channel_id: DM, message_ts: "1794321000.000100", ...over
});
const run = (p: Record<string, unknown>) => slackRdraftSendJobHandler.run(jobCtx(P10_JOB_KINDS.replySend, p));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  value = replyButtonValue({ draftId: ID, version: 2, channelId: CH.ops, replyThreadTs: "1794320001.000100", text: "Sure." });
  vi.mocked(openInstallationById).mockReset().mockResolvedValue(openInstallation());
  vi.mocked(sendSlackReply).mockReset().mockResolvedValue({ kind: "sent", postedTs: "1794321100.000100", permalink: null });
  vi.mocked(rerenderReplyCards).mockReset().mockResolvedValue(1);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("RK07 the send job", () => {
  it("registration: interactive, 45 s, P10_JOB_KINDS.replySend (created only by SQL v3)", () => {
    expect(slackRdraftSendJobHandler).toMatchObject({ kind: P10_JOB_KINDS.replySend, lane: "interactive", timeoutMs: P10_LIMITS.replySendJobTimeoutMs });
  });

  it("a good click → sendSlackReply on the DM path from Slack with the value's MAC and the card it came from", async () => {
    expect(await run(payload())).toEqual({ draftId: ID, outcome: "sent", reason: null });
    expect(vi.mocked(sendSlackReply).mock.calls).toEqual([[P, {
      id: ID, path: "dm", version: 2, mac: value.split(".")[3], clickMessageTs: "1794321000.000100", actor: "slack", now: expect.any(Date), signal: expect.any(AbortSignal)
    }]]);
    // After `sent` the send's own follow-ups re-rendered the card already.
    expect(rerenderReplyCards).not.toHaveBeenCalled();
  });

  it("payload checks: a malformed payload is a non-retryable error; a value for another draft or version → bad_value; another DM → installation", async () => {
    for (const bad of [{ installation_id: "esi_x" }, { draft_id: "esr_x" }, { version: 0 }, { version: 10_000 }, { value: "x".repeat(201) }, { channel_id: "C0ZENOPS1" },
      { message_ts: "nope" }, { action: "rewrite" }]) {
      await expect(run(payload(bad))).rejects.toBeInstanceOf(NonRetryableError);
    }
    expect(await run(payload({ value: `r1.esr_${"c".repeat(32)}.2.${"d".repeat(32)}` }))).toEqual({ skipped: "bad_value" });
    expect(await run(payload({ version: 3 }))).toEqual({ skipped: "bad_value" });
    expect(await run(payload({ value: "garbage" }))).toEqual({ skipped: "bad_value" });
    vi.mocked(openInstallationById).mockResolvedValueOnce(openInstallation({ dmChannelId: "D0OTHER" }));
    expect(await run(payload())).toEqual({ skipped: "installation" });
    vi.mocked(openInstallationById).mockResolvedValueOnce(null);
    expect(await run(payload())).toEqual({ skipped: "installation" });
    vi.mocked(openInstallationById).mockRejectedValueOnce(new SecretUnavailableError("auth_failed", "x"));
    expect(await run(payload())).toEqual({ skipped: "token_unavailable" });
    expect(sendSlackReply).not.toHaveBeenCalled();
    expect(await slackRdraftSendJobHandler.run(jobCtx(P10_JOB_KINDS.replySend, payload(), { principal: null }))).toEqual({ skipped: "no_principal" });
  });

  it("the card is re-rendered per outcome: dd_only / needs_ack with the click's reasons; a refusal, unknown or back to draft plain", async () => {
    const cases: [SendOutcome, Record<string, unknown> | undefined][] = [
      [{ kind: "dd_only", blockers: ["newer_messages"] }, { clickOutcome: "dd_only", blockers: ["newer_messages"] }],
      [{ kind: "needs_ack", blockers: ["external"] }, { clickOutcome: "needs_ack", blockers: ["external"] }],
      [{ kind: "refused", reason: "stale", status: "draft" }, undefined],
      [{ kind: "unknown", reason: "timeout" }, undefined],
      [{ kind: "back_to_draft", reason: "not_in_channel", version: 3 }, undefined],
      [{ kind: "in_flight" }, undefined]
    ];
    for (const [out, opts] of cases) {
      vi.mocked(rerenderReplyCards).mockClear();
      vi.mocked(sendSlackReply).mockResolvedValueOnce(out);
      const r = await run(payload());
      expect(r).toMatchObject({ draftId: ID, outcome: out.kind });
      expect(vi.mocked(rerenderReplyCards).mock.calls[0][2]).toEqual(opts === undefined ? { now: expect.any(Date) } : { now: expect.any(Date), ...opts });
    }
    vi.mocked(sendSlackReply).mockResolvedValueOnce({ kind: "sent", postedTs: "1.000001", permalink: null, reason: "not_recorded" } as SendOutcome);
    expect(await run(payload())).toEqual({ draftId: ID, outcome: "sent", reason: "not_recorded" });
  });

  it("RK12 a click after Stop reading (the row cascaded away) → refused not_found and the card re-rendered (it renders cardRemoved)", async () => {
    vi.mocked(sendSlackReply).mockResolvedValueOnce({ kind: "refused", reason: "not_found" });
    expect(await run(payload())).toEqual({ draftId: ID, outcome: "refused", reason: "not_found" });
    expect(rerenderReplyCards).toHaveBeenCalledTimes(1);
  });

  it("B-P10-6: the result carries ids and codes only; B-P10-14 (c): the call passes the literals", async () => {
    vi.mocked(sendSlackReply).mockResolvedValueOnce({ kind: "back_to_draft", reason: "missing_scope", version: 3 });
    const r = await run(payload());
    assertNoReplyText(r, ["Sure.", value, value.split(".")[3]]);
    const src = readFileSync(fileURLToPath(new URL("./slack-rdraft-send.ts", import.meta.url)), "utf8");
    const calls = src.match(/sendSlackReply\(principal, \{[^}]*\}/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).toContain('path: "dm"');
      expect(c).toContain('actor: "slack"');
    }
    expect(src).not.toContain("exec.slack-rdraft-send");
  });
});
