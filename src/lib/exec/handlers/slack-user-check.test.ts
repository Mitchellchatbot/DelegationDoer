import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), openReadingForSystem: vi.fn(), clearUserTokenError: vi.fn(),
  getInstallationReading: vi.fn() }));
vi.mock("@/lib/exec/slack-read-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-read-store")>()), userRevoke: vi.fn() }));
vi.mock("@/lib/exec/audit", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/audit")>()), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { installFakeSlack, SLACK_RECORDED, slackReadError } from "@/lib/exec/__tests__/fake-slack-api";
import { SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { INST, jobCtx, readingInstallation } from "@/lib/exec/__tests__/slack-read-jobs";
import { auditEvent } from "@/lib/exec/audit";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { slackUserCheckJobHandler } from "@/lib/exec/handlers/slack-user-check";
import { notifyOps } from "@/lib/exec/ops";
import { clearUserTokenError, getInstallationReading, openReadingForSystem } from "@/lib/exec/slack-install";
import { userRevoke } from "@/lib/exec/slack-read-store";

// P7a contract §3.11.8, §5.16 UC01-UC06 (Area D): exec.slack-user-check (a system job), the store and slack-install mocked,
// auth.test through fake-slack-api.

const INSTALLED_SEC = Date.parse("2026-11-01T00:00:00.000Z") / 1000;
const run = (payload: Record<string, unknown> = { installation_id: INST, event_time: INSTALLED_SEC + 60 }) =>
  slackUserCheckJobHandler.run(jobCtx("exec.slack-user-check", payload, { principal: null }));
const whoAmI = (team = "T0SCALED", user = "U0MITCH") => ({ ...SLACK_RECORDED.authTest(), team_id: team, user_id: user, bot_id: undefined });
let out: ReturnType<typeof captureConsole>;

beforeEach(() => {
  out = captureConsole();
  vi.mocked(openReadingForSystem).mockResolvedValue(readingInstallation());
  vi.mocked(getInstallationReading).mockImplementation(async () => {
    const ri = readingInstallation();
    return { row: ri.row, reading: ri.reading };
  });
  vi.mocked(userRevoke).mockResolvedValue({ revoked: true, purge: { channels: 3, messages: 5, items: 2, attention: 1 } });
  vi.mocked(notifyOps).mockResolvedValue(true);
});
afterEach(() => {
  out.assertClean();
  assertNoSlackText([vi.mocked(auditEvent).mock.calls, vi.mocked(notifyOps).mock.calls], { label: "audit and ops" });
});

describe("exec.slack-user-check", () => {
  it("UC01 the token still answers for him → the recorded error is cleared, nothing revoked", async () => {
    const s = installFakeSlack({ "auth.test": () => whoAmI() });
    expect(await run()).toEqual({ stillValid: true });
    expect(s.calls[0].headers.authorization).toBe(`Bearer ${S.userToken}`);
    expect(clearUserTokenError).toHaveBeenCalledWith(INST);
    expect(userRevoke).not.toHaveBeenCalled();
  });

  it("UC02 an event dated before the reading half was (re)installed is stale: no Slack call", async () => {
    const s = installFakeSlack({});
    expect(await run({ installation_id: INST, event_time: INSTALLED_SEC - 60 })).toEqual({ skipped: "stale" });
    expect(s.calls).toEqual([]);
  });

  it("UC03 each revoking code → userRevoke(tokens_revoked), the system audit row and the ops alert (ids and counts only)", async () => {
    for (const code of ["invalid_auth", "token_revoked", "account_inactive", "not_authed"]) {
      vi.mocked(auditEvent).mockClear();
      vi.mocked(notifyOps).mockClear();
      const s = installFakeSlack({ "auth.test": () => slackReadError(code) });
      expect(await run()).toEqual({ revoked: true, purged: { channels: 3, messages: 5, items: 2, attention: 1 } });
      expect(userRevoke).toHaveBeenLastCalledWith(INST, "tokens_revoked");
      expect(auditEvent).toHaveBeenCalledWith(null, { actor: "system", action: "slack.read_revoked", target: `exec_slack_installations:${INST}`,
        input: { reason: "tokens_revoked", channels: 3, messages: 5, items: 2, attention: 1 } });
      expect(notifyOps).toHaveBeenCalledWith({ key: "exec-slack-read-revoked", title: "Executive Assistant stopped reading Slack",
        detail: `installation ${INST}: the reading token was revoked; reading data purged` });
      s.restore();
    }
  });

  it("UC03b (fixer correctness-10): he re-consents while auth.test runs (the stored half's consent time moved) → stale, nothing revoked", async () => {
    vi.mocked(getInstallationReading).mockImplementation(async () => {
      const ri = readingInstallation({ reading: { installedAt: "2026-11-08T14:59:00.000Z" } });
      return { row: ri.row, reading: ri.reading };
    });
    const s = installFakeSlack({ "auth.test": () => slackReadError("token_revoked") });
    expect(await run()).toEqual({ skipped: "stale" });
    expect(userRevoke).not.toHaveBeenCalled();
    expect(auditEvent).not.toHaveBeenCalled();
    s.restore();
    // The half was already stopped meanwhile (revoked): nothing to revoke either.
    vi.mocked(getInstallationReading).mockImplementation(async () => {
      const ri = readingInstallation({ reading: { state: "revoked", hasToken: false } });
      return { row: ri.row, reading: ri.reading };
    });
    installFakeSlack({ "auth.test": () => whoAmI("T0OTHER") });
    expect(await run()).toEqual({ skipped: "stale" });
    expect(userRevoke).not.toHaveBeenCalled();
  });

  it("UC04 an answer for another team or user is treated as revoked", async () => {
    installFakeSlack({ "auth.test": () => whoAmI("T0OTHER") });
    expect(await run()).toMatchObject({ revoked: true });
  });

  it("UC05 a retryable failure is rethrown (the runner retries); another fatal code ends the check without revoking", async () => {
    let s = installFakeSlack({ "auth.test": () => slackReadError("internal_error") });
    await expect(run()).rejects.toMatchObject({ name: "SlackApiError", errorClass: "retryable" });
    s.restore();
    s = installFakeSlack({ "auth.test": () => slackReadError("missing_scope") });
    await expect(run()).rejects.toMatchObject({ name: "SlackApiError" });
    expect(userRevoke).not.toHaveBeenCalled();
    s.restore();
  });

  it("UC06 no live reading half → skipped; our key can't open the token → non-retryable auth, nothing revoked; a bad payload is dead", async () => {
    vi.mocked(openReadingForSystem).mockResolvedValueOnce(null);
    expect(await run()).toEqual({ skipped: "not_reading" });
    vi.mocked(openReadingForSystem).mockRejectedValueOnce(new SecretUnavailableError("not_configured", "no key"));
    await expect(run()).rejects.toMatchObject({ name: "NonRetryableError", errorClass: "auth" });
    await expect(run({ installation_id: "esi_nope" })).rejects.toMatchObject({ name: "NonRetryableError" });
    expect(userRevoke).not.toHaveBeenCalled();
  });
});
