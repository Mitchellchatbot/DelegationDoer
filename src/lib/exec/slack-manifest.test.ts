import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SLACK_REDIRECT_URI } from "@/lib/exec/slack-config";
import { SLACK_USER_SCOPES_OPTIONAL, SLACK_USER_SCOPES_REQUIRED } from "@/lib/exec/slack-read-types";
import { SLACK_BOT_SCOPES } from "@/lib/exec/slack-types";

// docs/exec-slack-manifest.json, the Slack app manifest the team pastes in at
// api.slack.com (P6 contract §3.16, K1, K2, K3, C20, C44; Area C): MF01-MF03.
// Every value is pinned; the bot half is unchanged and never asks for a search
// scope.
//
// P7a (contract §3.18, N21, P7-1; Area C): MF04-MF06. The manifest gains the
// user half: the nine user scopes (the last four in user_optional, so the DMs
// stay his choice on Slack's consent screen), the four message events and the
// channel lifecycle events for the user token; the long description says what
// reading does and never does. MF01 / MF03 changed their expectations with it
// (counts unchanged): MF01 pins the whole new manifest, MF03 keeps the bans
// that still hold.

const MANIFEST_URL = new URL("../../../docs/exec-slack-manifest.json", import.meta.url);
const raw = readFileSync(MANIFEST_URL, "utf8");
const manifest = JSON.parse(raw) as Record<string, unknown>;

const EXPECTED = {
  _metadata: { major_version: 2, minor_version: 1 },
  display_information: {
    name: "ScaledAI Executive Assistant",
    description: "Private assistant for the CEO. Answers his questions in a direct message from DD and his email. Never posts as him.",
    long_description:
      "The ScaledAI Executive Assistant is a private, owner-only assistant connected to DelegationDoer (DD). Only the CEO can use it: it answers his questions in its direct message with him, using DD records, his email and, once he allows it, the Slack conversations he can see. It never reads lead or patient-intake channels, DMs with bots, or conversations he isn't part of except public channels he chooses. It never posts in channels and never posts as anyone. Other people who open it see that it is private. Data is kept in DD for a limited time and deleted when reading stops or the app is removed. Support: the ScaledAI operations team."
  },
  features: {
    app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "exec-assistant", always_online: false }
  },
  oauth_config: {
    redirect_urls: ["https://operations.scaledai.org/api/integrations/exec-slack/callback"],
    scopes: {
      bot: ["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"],
      user: ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"],
      user_optional: ["im:history", "im:read", "mpim:history", "mpim:read"]
    }
  },
  settings: {
    event_subscriptions: {
      request_url: "https://operations.scaledai.org/api/integrations/exec-slack/events",
      bot_events: ["message.im", "app_home_opened", "app_uninstalled", "tokens_revoked"],
      user_events: [
        "message.channels", "message.groups", "message.im", "message.mpim",
        "channel_created", "channel_shared", "channel_unshared", "channel_id_changed", "channel_archive", "channel_unarchive",
        "channel_deleted", "channel_rename", "channel_left",
        "group_archive", "group_unarchive", "group_deleted", "group_rename", "group_left"
      ]
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

  it("MF03 the bot half keeps P6's six scopes and four events; no search: scope, no member_joined_channel, no distribution, no files: or reactions:", () => {
    const scopes = (manifest.oauth_config as { scopes: Record<string, unknown> }).scopes;
    // P7a §3.18 adds the user half (MF04); the keys are exactly these three.
    expect(Object.keys(scopes)).toEqual(["bot", "user", "user_optional"]);
    expect(scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
    const events = (manifest.settings as { event_subscriptions: Record<string, unknown> }).event_subscriptions;
    expect(events.bot_events).toEqual(["message.im", "app_home_opened", "app_uninstalled", "tokens_revoked"]);
    expect(raw).not.toMatch(/search:/);
    expect(raw).not.toContain("member_joined_channel");
    expect(raw).not.toMatch(/distribut/i);
    expect(raw).not.toMatch(/files:|reactions:/);
  });
});

describe("docs/exec-slack-manifest.json: the P7a user half (§3.18)", () => {
  const scopes = (manifest.oauth_config as { scopes: Record<string, string[]> }).scopes;
  const events = (manifest.settings as { event_subscriptions: Record<string, string[]> }).event_subscriptions;

  it("MF04 user = the nine P7-1 scopes, user_optional = the four DM scopes, user_events = exactly §3.18's eighteen, in order", () => {
    expect(scopes.user).toEqual(["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"]);
    expect(scopes.user_optional).toEqual(["im:history", "im:read", "mpim:history", "mpim:read"]);
    expect(events.user_events).toEqual([
      "message.channels", "message.groups", "message.im", "message.mpim", "channel_created", "channel_shared", "channel_unshared",
      "channel_id_changed", "channel_archive", "channel_unarchive", "channel_deleted", "channel_rename", "channel_left", "group_archive",
      "group_unarchive", "group_deleted", "group_rename", "group_left"
    ]);
    // The code asks for the same: the start route's user_scope is required then optional (slack-read-types.ts).
    expect(scopes.user).toEqual([...SLACK_USER_SCOPES_REQUIRED, ...SLACK_USER_SCOPES_OPTIONAL]);
    expect(scopes.user_optional).toEqual([...SLACK_USER_SCOPES_OPTIONAL]);
    expect(scopes.user_optional.every((s) => scopes.user.includes(s))).toBe(true);
    expect(new Set(events.user_events).size).toBe(events.user_events.length);
  });

  it("MF05 no search:*, reactions:read, member_joined_channel, huddle, user_change, profile or team events; no write scope for the user token", () => {
    const all = [...scopes.user, ...scopes.user_optional, ...events.user_events, ...events.bot_events];
    for (const v of all) {
      expect(v).not.toMatch(/^search:/);
      expect(v).not.toMatch(/^reactions:/);
      expect(v).not.toMatch(/huddle/);
      expect(v).not.toMatch(/^(member_joined_channel|member_left_channel|user_change|user_profile_changed|team_join|reaction_added|reaction_removed)$/);
    }
    // §0.3 rule 8: reading is read-only; no user scope writes or administers anything.
    for (const s of [...scopes.user, ...scopes.user_optional]) expect(s).toMatch(/:(history|read)$/);
    expect(raw).not.toMatch(/search:|reactions:|member_joined_channel|user_change|huddle/);
  });

  it("MF06 long_description is §3.18's text (174-4,000 characters); bot scopes and bot events unchanged from P6", () => {
    const d = (manifest.display_information as { long_description: string }).long_description;
    expect(d.length).toBeGreaterThanOrEqual(174);
    expect(d.length).toBeLessThanOrEqual(4000);
    expect(d).toContain("once he allows it, the Slack conversations he can see");
    expect(d).toContain("It never reads lead or patient-intake channels, DMs with bots, or conversations he isn't part of except public channels he chooses.");
    expect(d).toContain("deleted when reading stops or the app is removed");
    expect(scopes.bot).toEqual(["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"]);
    expect(events.bot_events).toEqual(["message.im", "app_home_opened", "app_uninstalled", "tokens_revoked"]);
    const settings = manifest.settings as Record<string, unknown>;
    expect([settings.org_deploy_enabled, settings.socket_mode_enabled, settings.token_rotation_enabled]).toEqual([false, false, false]);
  });
});
