import { afterEach, describe, expect, it, vi } from "vitest";
import { SENTINELS } from "@/lib/exec/__tests__/slack-assert";
import { SLACK_REDIRECT_URI, slackConfig, slackSigningSecret } from "@/lib/exec/slack-config";

// P6 contract §3.2 (K4): the only reader of EXEC_SLACK_*.

const FULL = {
  EXEC_SLACK_CLIENT_ID: "1234567890.1234567890",
  EXEC_SLACK_CLIENT_SECRET: SENTINELS.clientSecret,
  EXEC_SLACK_SIGNING_SECRET: SENTINELS.signingSecret,
  EXEC_SLACK_TEAM_ID: "T0SCALED",
  EXEC_SLACK_APP_ID: "A0EXEC"
} as const;

function setEnv(over: Partial<Record<keyof typeof FULL, string | undefined>> = {}) {
  for (const [k, v] of Object.entries({ ...FULL, ...over })) vi.stubEnv(k, v);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("slackConfig / slackSigningSecret (K4)", () => {
  it("all five set -> the config, trimmed; re-read on every call", () => {
    setEnv({ EXEC_SLACK_TEAM_ID: "  T0SCALED \n", EXEC_SLACK_CLIENT_ID: " 1234567890.1234567890 " });
    expect(slackConfig()).toEqual({
      clientId: "1234567890.1234567890", clientSecret: SENTINELS.clientSecret, signingSecret: SENTINELS.signingSecret, teamId: "T0SCALED", appId: "A0EXEC"
    });
    vi.stubEnv("EXEC_SLACK_APP_ID", "A0OTHER");
    expect(slackConfig()?.appId).toBe("A0OTHER");
  });

  it("null when any one is missing, blank, holds whitespace inside, or the team / app id has the wrong shape; never throws", () => {
    for (const key of Object.keys(FULL) as (keyof typeof FULL)[]) {
      setEnv({ [key]: undefined });
      expect(slackConfig(), `${key} unset`).toBeNull();
      setEnv({ [key]: "   " });
      expect(slackConfig(), `${key} blank`).toBeNull();
      setEnv({ [key]: "has space" });
      expect(slackConfig(), `${key} with a space`).toBeNull();
    }
    for (const [key, value] of [["EXEC_SLACK_TEAM_ID", "t0scaled"], ["EXEC_SLACK_TEAM_ID", "A0EXEC"], ["EXEC_SLACK_APP_ID", "T0SCALED"], ["EXEC_SLACK_APP_ID", "A0"]] as const) {
      setEnv({ [key]: value });
      expect(slackConfig(), `${key}=${value}`).toBeNull();
    }
  });

  it("slackSigningSecret reads the signing secret alone (url_verification needs nothing else)", () => {
    setEnv({ EXEC_SLACK_CLIENT_ID: undefined, EXEC_SLACK_TEAM_ID: undefined });
    expect(slackConfig()).toBeNull();
    expect(slackSigningSecret()).toBe(SENTINELS.signingSecret);
    vi.stubEnv("EXEC_SLACK_SIGNING_SECRET", " \t");
    expect(slackSigningSecret()).toBeNull();
    vi.stubEnv("EXEC_SLACK_SIGNING_SECRET", undefined);
    expect(slackSigningSecret()).toBeNull();
  });

  it("the redirect URI is the canonical host's callback, whatever NEXT_PUBLIC_APP_URL says (K3)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://delegationdoer-production.up.railway.app");
    expect(SLACK_REDIRECT_URI).toBe("https://operations.scaledai.org/api/integrations/exec-slack/callback");
  });
});
