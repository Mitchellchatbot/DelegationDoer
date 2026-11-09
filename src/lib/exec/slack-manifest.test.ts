import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SLACK_REDIRECT_URI } from "@/lib/exec/slack-config";
import { SLACK_BOT_SCOPES } from "@/lib/exec/slack-types";

// docs/exec-slack-manifest.json, the Slack app manifest the team pastes in at
// api.slack.com (P6 contract §3.16, K1, K2, K3, C20, C44; Area C): MF01-MF03.
// Every value is pinned; the app is bot-only, reads no channels and never asks
// for a user or search scope.

const MANIFEST_URL = new URL("../../../docs/exec-slack-manifest.json", import.meta.url);
const raw = readFileSync(MANIFEST_URL, "utf8");
const manifest = JSON.parse(raw) as Record<string, unknown>;

const EXPECTED = {
  _metadata: { major_version: 2, minor_version: 1 },
  display_information: {
    name: "ScaledAI Executive Assistant",
    description: "Private assistant for the CEO. Answers his questions in a direct message from DD and his email. Never posts as him.",
    long_description:
      "The ScaledAI Executive Assistant is a private, owner-only assistant connected to DelegationDoer (DD). Only the CEO can use it: it answers his questions in its direct message with him, using DD records and his email, and shows a short summary on its Home tab. It reads no channels and no conversations between other people, never posts in channels, and never posts as anyone. Other people who open it see that it is private. Conversations are kept in DD for a limited time and the bot deletes its own old messages. Support: the ScaledAI operations team."
  },
  features: {
    app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "exec-assistant", always_online: false }
  },
  oauth_config: {
    redirect_urls: ["https://operations.scaledai.org/api/integrations/exec-slack/callback"],
    scopes: { bot: ["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"] }
  },
  settings: {
    event_subscriptions: {
      request_url: "https://operations.scaledai.org/api/integrations/exec-slack/events",
      bot_events: ["message.im", "app_home_opened", "app_uninstalled", "tokens_revoked"]
    },
    interactivity: { is_enabled: true, request_url: "https://operations.scaledai.org/api/integrations/exec-slack/interactions" },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false
  }
};

describe("docs/exec-slack-manifest.json", () => {
  it("MF01 parses and every value equals §3.16 exactly (no other key anywhere)", () => {
    expect(manifest).toEqual(EXPECTED);
  });

  it("MF01 agrees with the code: the six bot scopes and the redirect URI the callback exchanges with", () => {
    const oauth = manifest.oauth_config as { redirect_urls: string[]; scopes: { bot: string[] } };
    expect(oauth.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
    expect(oauth.redirect_urls).toEqual([SLACK_REDIRECT_URI]);
  });

  it("MF02 long_description is 174-4,000 characters; the display name is in Slack's charset (a-z 0-9 - _ .)", () => {
    const d = (manifest.display_information as { long_description: string }).long_description;
    expect(d.length).toBeGreaterThanOrEqual(174);
    expect(d.length).toBeLessThanOrEqual(4000);
    expect((manifest.features as { bot_user: { display_name: string } }).bot_user.display_name).toMatch(/^[a-z0-9._-]{1,80}$/);
  });

  it("MF03 no user or user_optional scopes, no user_events, no search: scope, no member_joined_channel, no distribution", () => {
    const scopes = (manifest.oauth_config as { scopes: Record<string, unknown> }).scopes;
    expect(Object.keys(scopes)).toEqual(["bot"]);
    expect(scopes).not.toHaveProperty("user");
    expect(scopes).not.toHaveProperty("user_optional");
    const events = (manifest.settings as { event_subscriptions: Record<string, unknown> }).event_subscriptions;
    expect(events).not.toHaveProperty("user_events");
    expect(raw).not.toMatch(/search:/);
    expect(raw).not.toContain("member_joined_channel");
    expect(raw).not.toMatch(/distribut/i);
    expect(raw).not.toMatch(/channels:|groups:|mpim:|files:|reactions:/);
  });
});
