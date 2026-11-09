import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";

import { sealSecret } from "@/lib/exec/crypto";
import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import type { SlackMethod, SlackMessageParts } from "@/lib/exec/slack-types";
import type { ExecJobRow, ExecPrincipal, ExecSettings, JobContext } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

import { createFakeSlackDb, type FakeSlackDb, type FakeSlackDbCall, type FakeSlackDbSeed, type Row } from "./fake-slack-db";
import { installFakeSlack, SLACK_RECORDED, type FakeSlackCall, type FakeSlackHandler } from "./fake-slack-api";
import { ROUTING_INSTALLATION as RI, SENTINELS } from "./slack-assert";

// P6 Area D test support: the job tests run the REAL slack-dm.ts, slack-install.ts
// (over fake-slack-db.ts), sources/slack.ts (over fake-slack-api.ts's fetch stub)
// and slack-ui.ts; the test files vi.mock P5b's turn, P4's drafts, P5a's reads,
// the audit and the settings read. Each test file must vi.mock
// "@/lib/supabase-admin" ({ getSupabaseAdmin: vi.fn() }) for useSlackDb to bind.
//
// One shared `order` log records, in order, every Slack method call ("slack:<method>"),
// every database request ("db:<kind>:<target>", reply steps as "rpc:reply_step:<to>")
// and whatever the test's mocks push, so call-order tests read one list.

export const KEY = Buffer.alloc(32, 0xa1).toString("base64");
export const hex32 = (n: number): string => n.toString(16).padStart(32, "0");
export const INST = `esi_${hex32(1)}`;
export const MSG = (n: number): string => `ecm_${hex32(n)}`;
export const CONV = (n: number): string => `ecv_${hex32(n)}`;
export const TURN = (n: number): string => `ect_${hex32(n)}`;
export const DRAFT = (n: number): string => `ed_${hex32(n)}`;
export const PROPOSAL = (n: number): string => `etp_${hex32(n)}`;
export const EVENT_ID = "Ev0SLACKREPLY1";
export const PID = "ep_1";
const context = (pid: string) => `exec_slack_installations.bot_token:${pid}`;

/** Mitchell, with the email sentinel (no log, payload or result may carry it). */
export const PRINCIPAL = Object.freeze({
  id: PID, userId: "u_1", email: SENTINELS.email, name: "Mitchell", timezone: "America/New_York",
  mailAccountIds: [], slackTeamId: null, slackUserId: null
}) as unknown as ExecPrincipal;

export const SETTINGS: ExecSettings = { ...DEFAULT_SETTINGS, principalId: PID, chatEnabled: true, chatSchemaReady: true, retentionDaysChat: 90 };

export interface Harness {
  db: FakeSlackDb;
  order: string[];
}

let current: Harness | null = null;
export const order = (): string[] => current?.order ?? [];

/** An installation row as the migration stores it, its bot token (the token sentinel) sealed for its principal. */
export function installationRow(over: Row = {}): Row {
  const principalId = (over.principal_id as string | undefined) ?? PID;
  const sealed = sealSecret(SENTINELS.token, context(principalId));
  return {
    id: INST, principal_id: principalId, team_id: RI.teamId, app_id: RI.appId, bot_user_id: RI.botUserId, bot_id: RI.botId,
    bot_token_enc: sealed, key_id: sealed.split(".")[1], bot_scopes: ["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"],
    user_id: RI.userId, user_token_enc: null, user_scopes: [], slack_dm_channel_id: RI.dmChannelId, installed_at: RI.installedAt,
    updated_at: RI.installedAt, revoked_at: null, revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null,
    ...over
  };
}

/** A reply event row as RPC 1 leaves it (decision reply, reply_state queued). */
export function replyEventRow(over: Row = {}): Row {
  const nowIso = new Date().toISOString();
  return {
    event_id: EVENT_ID, team_id: RI.teamId, api_app_id: RI.appId, event_type: "message", decision: "reply", drop_reason: null,
    installation_id: INST, principal_id: PID, channel_id: RI.dmChannelId, message_ts: "1793977201.000100", thread_ts: null,
    slack_user_id: RI.userId, event_time: nowIso, retry_num: 0, job_id: null, reply_state: "queued", placeholder_ts: null,
    conversation_id: null, assistant_message_id: null, received_at: nowIso, updated_at: nowIso,
    ...over
  };
}

const describeCall = (call: FakeSlackDbCall): string => {
  if (call.kind === "rpc" && call.target === "exec_slack_reply_step") return `rpc:reply_step:${String((call.payload as Row)?.p_to)}`;
  return `db:${call.kind}:${call.target}`;
};

/** A fresh fake database bound to getSupabaseAdmin, logging into the shared order. */
export function useSlackDb(seed: FakeSlackDbSeed = {}): Harness {
  const log: string[] = [];
  const db = createFakeSlackDb({
    ...seed,
    tables: { exec_slack_installations: [installationRow()], ...(seed.tables ?? {}) },
    before: async (call, d) => {
      log.push(describeCall(call));
      await seed.before?.(call, d);
    }
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  current = { db, order: log };
  return current;
}

let tsSeq = 0;
/** A fresh bot message ts, after his message's. */
export const nextTs = (): string => `1793977300.${String(++tsSeq).padStart(6, "0")}`;

export type SlackHandlers = Partial<Record<SlackMethod, FakeSlackHandler>>;

/** The fake Slack with the defaults a reply needs; every call is logged into the shared order. */
export function useSlack(handlers: SlackHandlers = {}, message: Row | null = { ts: "1793977201.000100", user: RI.userId, text: SENTINELS.text, type: "message" }): { calls: FakeSlackCall[]; restore(): void } {
  const defaults: SlackHandlers = {
    "conversations.history": () => ({ ok: true, messages: message ? [message] : [], has_more: false }),
    "conversations.replies": () => ({ ok: true, messages: message ? [message] : [], has_more: false }),
    "chat.postMessage": () => SLACK_RECORDED.postMessage(nextTs()),
    "chat.update": (body) => SLACK_RECORDED.update(String(body.ts)),
    "chat.delete": (body) => SLACK_RECORDED.delete(String(body.ts)),
    "views.publish": () => SLACK_RECORDED.viewsPublish(),
    "auth.test": () => SLACK_RECORDED.authTest()
  };
  const merged: SlackHandlers = { ...defaults, ...handlers };
  const logged: SlackHandlers = {};
  for (const [method, handler] of Object.entries(merged) as [SlackMethod, FakeSlackHandler][]) {
    logged[method] = (body, headers) => {
      current?.order.push(`slack:${method}`);
      return handler(body, headers);
    };
  }
  return installFakeSlack(logged);
}

/** A Slack error answer, as Slack sends it (HTTP 200, ok:false). */
export const slackError = (code: string) => () => SLACK_RECORDED.error(code);
/** A 429 with Retry-After. */
export const slackRateLimited = () => () => new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "retry-after": "30", "content-type": "application/json" } });

let jobSeq = 9000;
/** A claimed job row and its context; signal defaults to a fresh, never-aborted one. */
export function jobCtx(kind: string, payload: Record<string, unknown>, over: { principal?: ExecPrincipal | null; signal?: AbortSignal; id?: number } = {}): JobContext {
  const id = over.id ?? ++jobSeq;
  const job: ExecJobRow = {
    id, kind, lane: "interactive", principal_id: over.principal === null ? null : PID, payload, dedupe_key: null, status: "running", attempts: 1,
    max_attempts: 1, run_after: new Date().toISOString(), locked_by: "worker-under-test", locked_until: null, heartbeat_at: null, last_error: null,
    result: null, created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null
  };
  return { job, principal: over.principal === undefined ? PRINCIPAL : over.principal, signal: over.signal ?? new AbortController().signal, workerId: "worker-under-test" };
}

/** Every mrkdwn text of a message, joined (what a person would read). */
export function textOf(parts: { blocks?: unknown } | Record<string, unknown> | undefined): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if ((o.type === "mrkdwn" || o.type === "plain_text") && typeof o.text === "string") {
        // Button labels are plain_text too: only what a person reads in the message body counts.
        if (o.type === "mrkdwn") out.push(o.text);
        return;
      }
      for (const val of Object.values(o)) walk(val);
    }
  };
  walk((parts as { blocks?: unknown })?.blocks);
  return out.join("\n");
}

/** The action ids of every button of a message. */
export function buttonsOf(parts: { blocks?: unknown } | Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const b of (((parts as { blocks?: unknown })?.blocks ?? []) as Record<string, unknown>[])) {
    if (b?.type === "actions" && Array.isArray(b.elements)) for (const e of b.elements as Record<string, unknown>[]) out.push(String(e.action_id));
  }
  return out;
}

/** The body Slack received as SlackMessageParts (for assertSlackParts). */
export const partsOfCall = (call: FakeSlackCall): SlackMessageParts => ({ blocks: call.body.blocks as SlackMessageParts["blocks"], text: String(call.body.text) });

/** The Slack calls of one method. */
export const callsOf = (calls: FakeSlackCall[], method: SlackMethod): FakeSlackCall[] => calls.filter((c) => c.method === method);

/** True when `expected` appears in `log` in this order (other entries may sit between). */
export function inOrder(log: readonly string[], expected: readonly string[]): boolean {
  let i = 0;
  for (const entry of log) if (i < expected.length && entry === expected[i]) i += 1;
  return i === expected.length;
}
