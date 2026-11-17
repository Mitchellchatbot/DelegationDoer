import { createHash } from "node:crypto";

import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import { P10_LIMITS } from "@/lib/exec/slack-p10-types";
import type { ReplyDraftRow } from "@/lib/exec/slack-p10-types";
import * as store from "@/lib/exec/slack-reply-store";
import type { InstallationRow, OpenInstallation } from "@/lib/exec/slack-types";
import type { ExecJobRow, ExecPrincipal, ExecSettings, JobContext } from "@/lib/exec/types";
import { createFakeReplyDb, type FakeReplyDb, type FakeReplyDbSeed } from "./fake-reply-db";
import type { Row } from "./fake-slack-db";

// P10 Area D test harness (contract §5.8, §5.9, §5.11, §5.13): one invented workspace for the send, the card, the handlers,
// the sweep and the routes, over Area A's fake reply database (its RPC bodies mirror the SQL) plus a users table for his DD
// token. Every file that uses it mocks @/lib/supabase-admin itself and hands `client()` to getSupabaseAdmin. Invented names
// only (zenith-house-*, Acme Recovery); fake tokens are built from parts.

export const NOW = new Date("2026-11-10T15:00:00.000Z");
export const P = Object.freeze({
  id: "ep_1", userId: "user-mitchell", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York",
  briefTimezone: "America/New_York", workTimezone: "America/New_York"
}) as unknown as ExecPrincipal;
export const INST = `esi_${"a".repeat(32)}`;
export const DM = "D0MITCH";
/** His DD user token and the assistant's bot token (fakes, built from parts: never a real token's shape). */
export const OWNER_TOKEN = ["xoxp", "fake", "owner", "d"].join("-");
export const BOT_TOKEN = ["xoxb", "fake", "bot", "d"].join("-");
export const READ_TOKEN = ["xoxp", "fake", "reader", "d"].join("-");
export const TOKEN_KEY = Buffer.alloc(32, 0x5a).toString("base64");
export const TOKEN_KEY_PREVIOUS = Buffer.alloc(32, 0x3c).toString("base64");
export const TOKEN_KEY_OTHER = Buffer.alloc(32, 0x77).toString("base64");

/** ts values on 2026-11-10 shortly before NOW (2026-11-10T14:13:20Z + n s), strictly increasing by n. */
export const T = (n: number, f = 100): string => `${1794320000 + n}.${String(f).padStart(6, "0")}`;
export const hex32 = (n: number): string => n.toString(16).padStart(32, "0");
export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
export const inDays = (n: number): Date => new Date(Date.now() + n * 86_400_000);

/** The conversations the workspace holds. */
export const CH = Object.freeze({
  ops: "C0ZENOPS1",          // #zenith-house-ops, a standard channel
  priv: "G0ZENPRIV",         // #zenith-house-leadership (private)
  im: "D0JANE",              // his DM with Jane
  mpim: "G0ZENMPIM",         // a group DM
  fin: "C0ZENFIN1",          // #zenith-house-finance (finance class)
  ext: "C0ACMEEXT",          // #acme-recovery-shared (Slack Connect)
  left: "C0ZENLEFT"          // a channel he left
});

export const installationRow = (over: Partial<InstallationRow> = {}): InstallationRow => ({
  id: INST, principalId: "ep_1", teamId: "T0SCALED", appId: "A0EXEC", botUserId: "U0BOT", botId: "B0BOT", keyId: null,
  botScopes: [], userId: "U0MITCH", dmChannelId: DM, installedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  revokedAt: null, revokeReason: null, lastDmAt: null, lastErrorCode: null, lastErrorAt: null, purgedAt: null, hasToken: true, ...over
});
export const openInstallation = (over: Partial<InstallationRow> = {}): OpenInstallation => ({
  row: installationRow(over), target: Object.freeze({ token: BOT_TOKEN, dmChannelId: DM })
});
/** P7a's opened reader (slack-read's openReader), with the reading token. */
export const readingInstallation = () => ({
  row: installationRow(),
  reading: { state: "ready", scopes: [], installedAt: null, revokedAt: null, revokeReason: null, discoveredAt: "2026-11-01T00:00:00.000Z",
    purgedAt: null, lastErrorCode: null, lastErrorAt: null, hasToken: true },
  target: Object.freeze({ userToken: READ_TOKEN, teamId: "T0SCALED", userId: "U0MITCH" })
});

/** The settings every P10 path reads: P10 installed, replies, sending and reading on. */
export function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return {
    ...(DEFAULT_SETTINGS as ExecSettings), principalId: "ep_1", slackP10SchemaReady: true, slackRepliesEnabled: true, slackReplySendEnabled: true,
    slackReadingSchemaReady: true, slackReadingEnabled: true, ...over
  } as ExecSettings;
}

const chan = (id: string, over: Row = {}): Row => ({
  principal_id: "ep_1", channel_id: id, installation_id: INST, conv_type: "channel", class: "standard", is_member: true, left_at: null,
  finance_name: false, is_ext_shared: false, ext_ever: false, name: null, watch_state: "watched", ...over
});
const msg = (channel: string, ts: string, over: Row = {}): Row => ({
  principal_id: "ep_1", channel_id: channel, ts, thread_ts: null, role: "item", author_user_id: "U0JANE", author_external: false, edited_ts: null,
  responded_at: null, ...over
});

/** The messages the drafts reply to (one per conversation, plus a thread reply in #ops). */
export const MSG = Object.freeze({
  ops: T(1), opsReply: T(2), opsRoot: T(1), priv: T(10), im: T(20), mpim: T(30), fin: T(40), ext: T(50), left: T(60), ops2: T(3), ops3: T(4)
});

export function seedTables(extra: FakeReplyDbSeed["tables"] = {}): FakeReplyDbSeed["tables"] {
  return {
    exec_slack_installations: [{
      id: INST, principal_id: "ep_1", team_id: "T0SCALED", app_id: "A0EXEC", user_id: "U0MITCH", slack_dm_channel_id: DM, revoked_at: null,
      user_token_enc: "v1.0123abcd.AA.BB.CC", reading_state: "ready"
    }],
    exec_settings: [{ principal_id: "ep_1", slack_reading_enabled: true }],
    exec_slack_channels: [
      chan(CH.ops, { name: "zenith-house-ops" }), chan(CH.priv, { conv_type: "group", name: "zenith-house-leadership", is_private: true }),
      chan(CH.im, { conv_type: "im" }), chan(CH.mpim, { conv_type: "mpim" }),
      chan(CH.fin, { class: "finance", finance_name: true, name: "zenith-house-finance" }),
      chan(CH.ext, { class: "external", is_ext_shared: true, ext_ever: true, name: "acme-recovery-shared" }),
      chan(CH.left, { left_at: "2026-11-09T00:00:00.000Z", name: "zenith-house-old" })
    ],
    exec_slack_messages: [
      msg(CH.ops, MSG.ops), msg(CH.ops, MSG.opsReply, { thread_ts: MSG.opsRoot, author_user_id: "U0BOB" }), msg(CH.ops, MSG.ops2), msg(CH.ops, MSG.ops3),
      msg(CH.priv, MSG.priv), msg(CH.im, MSG.im), msg(CH.mpim, MSG.mpim), msg(CH.fin, MSG.fin),
      msg(CH.ext, MSG.ext, { author_user_id: "W0ACMEX", author_external: true }), msg(CH.left, MSG.left)
    ],
    exec_slack_items: [
      { id: `esl_${hex32(1)}`, principal_id: "ep_1", channel_id: CH.ops, ts: MSG.ops, urgency: "high", responded_at: null },
      { id: `esl_${hex32(2)}`, principal_id: "ep_1", channel_id: CH.im, ts: MSG.im, urgency: "normal", responded_at: null }
    ],
    exec_slack_author_optouts: [],
    ...extra
  } as FakeReplyDbSeed["tables"];
}

/** users.slack_user_token by id (the one table slack-reply-post.ts reads), mutable by the test. */
export interface UsersTable { rows: Record<string, { slack_user_token: string | null }>; reads: number }

/** A Supabase-shaped client: the fake reply DB for every reply / P7a table and RPC, plus `users` for his token. */
export function compositeClient(db: FakeReplyDb, users: UsersTable): unknown {
  const inner = db.client as { from(t: string): unknown; rpc(fn: string, args?: unknown): unknown };
  return {
    from(table: string) {
      if (table !== "users") return inner.from(table);
      let id: unknown = null;
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          if (k === "id") id = v;
          return q;
        },
        limit: () => q,
        abortSignal: () => q,
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
          users.reads += 1;
          const row = typeof id === "string" ? users.rows[id] : undefined;
          return Promise.resolve({ data: row ? [row] : [], error: null }).then(res, rej);
        }
      };
      return q;
    },
    rpc: (fn: string, args?: unknown) => inner.rpc(fn, args)
  };
}

export function newWorld(seed: FakeReplyDbSeed = {}): { db: FakeReplyDb; users: UsersTable } {
  const db = createFakeReplyDb({ now: () => new Date(), ...seed, tables: seedTables(seed.tables ?? {}) });
  const users: UsersTable = { rows: { "user-mitchell": { slack_user_token: OWNER_TOKEN } }, reads: 0 };
  return { db, users };
}

/** A `draft` row (RPC 13 then RPC 15), written exactly as the generation job writes it. */
export async function makeDraft(channelId: string, ts: string, over: Partial<store.FinishInput> & { origin?: "web" | "chat" | "slack" | "auto"; itemId?: string | null } = {}):
  Promise<ReplyDraftRow> {
  const { origin = "web", itemId = null, ...finish } = over;
  const created = await store.createReplyDraftRow(P, {
    installationId: INST, channelId, ts, itemId, origin, instruction: null, fromDraftId: null, chatMessageId: null, expiresAt: inDays(7)
  });
  if (created.outcome !== "created") throw new Error(`makeDraft: ${created.outcome === "refused" ? created.reason : created.outcome}`);
  const out = await store.finishReplyDraft(P, created.id, created.generationSeq, {
    ok: true, text: "Sounds good, I'll take it from here.", note: "Kept it short.", placeholders: [], flags: [], injectionSuspected: false,
    voiceSource: "slack", model: "claude-opus-5-5", contextTs: [ts], contextAuthors: ["U0JANE"], contextLatestTs: ts, externalSeen: false,
    expiresAt: inDays(7), ...finish
  });
  if (out.outcome !== "written") throw new Error(`makeDraft finish: ${out.outcome}`);
  const row = await store.getReplyDraft(P, created.id);
  if (row === null) throw new Error("makeDraft: no row");
  return row;
}

/** The live draft row in the fake (snake_case), for direct assertions and mid-send mutations. */
export const rowOf = (db: FakeReplyDb, id: string): Row => db.tables.exec_slack_reply_drafts.find((d) => d.id === id) as Row;

/** C37: the three read-only checks' horizon, for the unknown tests. */
export const VERIFY_DELAYS = P10_LIMITS.replyVerifyDelaysMs;

let jobSeq = 7000;
/** A claimed job row and its context (the runner's shape); signal defaults to a fresh, never-aborted one. */
export function jobCtx(kind: string, payload: Record<string, unknown>, over: { principal?: ExecPrincipal | null; signal?: AbortSignal } = {}): JobContext {
  const job: ExecJobRow = {
    id: ++jobSeq, kind, lane: "interactive", principal_id: over.principal === null ? null : "ep_1", payload, dedupe_key: null, status: "running", attempts: 1,
    max_attempts: 1, run_after: new Date().toISOString(), locked_by: "worker-under-test", locked_until: null, heartbeat_at: null, last_error: null,
    result: null, created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null
  };
  return { job, principal: over.principal === undefined ? P : over.principal, signal: over.signal ?? new AbortController().signal, workerId: "worker-under-test" };
}
