import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/slack-gate-cache", () => ({ v2MissingWithSchemaAt: vi.fn(() => null) }));
vi.mock("@/lib/exec/audit", () => ({ auditEvent: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { auditEvent } from "@/lib/exec/audit";
import { currentKeyIds, openSecret, SecretUnavailableError, sealSecret } from "@/lib/exec/crypto";
import {
  botTokenContext,
  listActiveInstallationsForSystem,
  listSealedTokensForReseal,
  openActiveInstallation,
  openReadingInstallation,
  resealTokenCas,
  SLACK_BOT_TOKEN_CONTEXT,
  SLACK_USER_TOKEN_CONTEXT,
  slackTokenKeyIds,
  userTokenContext
} from "@/lib/exec/slack-install";
import { resealSlackTokens } from "@/lib/exec/slack-token-reseal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P9 F13 (contract §1 F13; Area C): EXEC_TOKEN_KEY rotation. resealSlackTokens (slack-token-reseal.ts) over slack-install.ts's
// sealed-blob read and CAS, against fake-slack-read-db (the bot and the user half of exec_slack_installations): seal under A;
// KEY=B, PREVIOUS=A; re-seal; unset PREVIOUS; both tokens still open. A concurrent reinstall wins the CAS; a blob under an
// unknown key is counted and left alone; the audit rows and the result carry ids and key ids only.

const KEY_A = Buffer.alloc(32, 0xa1).toString("base64");
const KEY_B = Buffer.alloc(32, 0xb2).toString("base64");
const KEY_C = Buffer.alloc(32, 0xc3).toString("base64");
const kid = (key: string) => createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 8);
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const INST = `esi_${hex32(1)}`;
const INST_2 = `esi_${hex32(2)}`;
const BOT = "xoxb-reseal-test-bot-0001";
const USER = "xoxp-reseal-test-user-0001";
const P1 = Object.freeze({ id: "ep_1", userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "UTC", mailAccountIds: [],
  slackTeamId: null, slackUserId: null }) as unknown as ExecPrincipal;

function setKeys(current: string | undefined, previous?: string) {
  vi.stubEnv("EXEC_TOKEN_KEY", current);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", previous);
}

/** An active installation with a bot and (reading) a user half, both sealed under the CURRENT key at call time. */
function inst(over: Row = {}, reading = true): Row {
  const pid = (over.principal_id as string | undefined) ?? "ep_1";
  const bot = sealSecret(BOT, botTokenContext(pid));
  const user = reading ? sealSecret(USER, userTokenContext(pid)) : null;
  return {
    id: INST, principal_id: pid, team_id: "T0SCALED", app_id: "A0EXEC", bot_user_id: "U0BOT", bot_id: "B0BOT", bot_token_enc: bot, key_id: bot.split(".")[1],
    bot_scopes: ["chat:write"], user_id: "U0MITCH", user_token_enc: user, user_key_id: user ? user.split(".")[1] : null,
    user_scopes: reading ? ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read"] : [],
    slack_dm_channel_id: "D0MITCH", installed_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", revoked_at: null,
    revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null, user_installed_at: reading ? "2026-11-01T00:00:00.000Z" : null,
    user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_state: reading ? "ready" : "none",
    discovered_at: reading ? "2026-11-01T01:00:00.000Z" : null, reading_purged_at: null, ...over
  };
}

let db: FakeSlackReadDb;
function useDb(rows: Row[], seed: Partial<FakeSlackReadDbSeed> = {}): FakeSlackReadDb {
  db = createFakeSlackReadDb({ ...seed, slack: { ...(seed.slack ?? {}), tables: { exec_slack_installations: rows } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const row = (id = INST) => db.tables.exec_slack_installations.find((r) => r.id === id)!;
const blobKid = (blob: unknown) => String(blob).split(".")[1];

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  setKeys(KEY_A);
  vi.mocked(auditEvent).mockReset().mockResolvedValue(undefined);
  logs = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {})];
});
afterEach(() => {
  // Never a token, a blob or key material in a log line, an audit row or a result.
  const seen = JSON.stringify([logs.map((l) => l.mock.calls), vi.mocked(auditEvent).mock.calls]);
  for (const secret of [BOT, USER, KEY_A, KEY_B, KEY_C, "v1."]) expect(seen).not.toContain(secret);
  for (const l of logs) l.mockRestore();
  vi.unstubAllEnvs();
});

describe("RS01 an EXEC_TOKEN_KEY rotation finishes (F13)", () => {
  it("RS01 seal under A; KEY=B, PREVIOUS=A; the re-seal moves the bot and the user token (blobs, key_id, user_key_id) to kid(B); unset PREVIOUS → both still open", async () => {
    useDb([inst()]);
    setKeys(KEY_B, KEY_A);
    expect(currentKeyIds()).toEqual({ current: kid(KEY_B), previous: kid(KEY_A) });
    const r = await resealSlackTokens();
    expect(r).toEqual({ checked: 2, resealed: 2, unknownKey: 0, lost: 0, failed: 0 });
    expect([row().key_id, row().user_key_id, blobKid(row().bot_token_enc), blobKid(row().user_token_enc)]).toEqual([kid(KEY_B), kid(KEY_B), kid(KEY_B), kid(KEY_B)]);
    // Only the blob and its key id are written, and only by CAS on the old blob of an active row.
    const updates = db.calls.filter((c) => c.kind === "update" && c.target === "exec_slack_installations");
    expect(updates.map((u) => Object.keys(u.payload as Row).sort())).toEqual([["bot_token_enc", "key_id"], ["user_key_id", "user_token_enc"]]);
    expect(updates.map((u) => u.filters.map((x) => ("column" in x ? x.column : "")))).toEqual([["id", "bot_token_enc", "revoked_at"], ["id", "user_token_enc", "revoked_at"]]);
    // The previous key goes: both tokens still open, unchanged.
    setKeys(KEY_B);
    const opened = await openActiveInstallation(P1);
    expect(opened?.target.token).toBe(BOT);
    const reading = await openReadingInstallation(P1);
    expect(reading?.target.userToken).toBe(USER);
    // A second pass finds nothing to move.
    expect(await resealSlackTokens()).toEqual({ checked: 2, resealed: 0, unknownKey: 0, lost: 0, failed: 0 });
  });

  it("RS01 one audit row per re-seal, slack.token_resealed by the system: the installation id, the column and the two key ids, nothing else", async () => {
    useDb([inst()]);
    setKeys(KEY_B, KEY_A);
    await resealSlackTokens();
    expect(vi.mocked(auditEvent).mock.calls).toEqual([
      [null, { actor: "system", action: "slack.token_resealed", target: `exec_slack_installations:${INST}`,
        input: { installationId: INST, column: "bot", fromKid: kid(KEY_A), toKid: kid(KEY_B) } }],
      [null, { actor: "system", action: "slack.token_resealed", target: `exec_slack_installations:${INST}`,
        input: { installationId: INST, column: "user", fromKid: kid(KEY_A), toKid: kid(KEY_B) } }]
    ]);
  });
});

describe("RS02-RS04 what the re-seal never does", () => {
  it("RS02 a concurrent reinstall wins the CAS: lost, nothing overwritten (the reinstall's blob stays)", async () => {
    let fresh = "";
    useDb([inst({}, false)], {
      // The reinstall lands between the read and the write.
      before: (call, fdb) => {
        if (call.kind === "update" && call.target === "exec_slack_installations") {
          Object.assign(fdb.tables.exec_slack_installations[0], { bot_token_enc: fresh, key_id: kid(KEY_B) });
        }
      }
    });
    setKeys(KEY_B, KEY_A);
    fresh = sealSecret("xoxb-reinstalled-bot", botTokenContext("ep_1"));
    expect(await resealSlackTokens()).toEqual({ checked: 1, resealed: 0, unknownKey: 0, lost: 1, failed: 0 });
    expect(row().bot_token_enc).toBe(fresh);
    expect(auditEvent).not.toHaveBeenCalled();
    expect(openSecret(String(row().bot_token_enc), botTokenContext("ep_1"))).toBe("xoxb-reinstalled-bot");
  });

  it("RS03 a blob under a key neither EXEC_TOKEN_KEY nor _PREVIOUS has is counted (unknownKey) and left exactly as it was", async () => {
    setKeys(KEY_C);
    useDb([inst({}, false)]);
    const before = row().bot_token_enc;
    setKeys(KEY_B, KEY_A);
    expect(await resealSlackTokens()).toEqual({ checked: 1, resealed: 0, unknownKey: 1, lost: 0, failed: 0 });
    expect(row().bot_token_enc).toBe(before);
    expect(db.calls.filter((c) => c.kind === "update")).toEqual([]);
  });

  it("RS04 a blob that doesn't open (copied to another principal's row: the context differs) → failed, untouched; a revoked installation isn't read", async () => {
    const other = inst({ id: INST_2, principal_id: "ep_2", team_id: "T0OTHER", slack_dm_channel_id: "D0OTHER" }, false);
    useDb([inst({}, false), { ...other, bot_token_enc: inst({}, false).bot_token_enc }, inst({ id: `esi_${hex32(3)}`, principal_id: "ep_3", team_id: "T0THIRD", slack_dm_channel_id: "D0THIRD", revoked_at: "2026-11-02T00:00:00.000Z" }, false)]);
    setKeys(KEY_B, KEY_A);
    const r = await resealSlackTokens();
    expect(r).toEqual({ checked: 2, resealed: 1, unknownKey: 0, lost: 0, failed: 1 });
    expect(blobKid(row(INST_2).bot_token_enc)).toBe(kid(KEY_A));
    expect(logs[0].mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([`[exec-slack] reseal skipped (installation ${INST_2}, bot): auth_failed`]);
    expect((await listSealedTokensForReseal(10)).map((x) => x.installationId)).toEqual([INST, INST_2]);
  });

  it("RS05 no active installation → zeros, the keys never read (EXEC_TOKEN_KEY unset is fine); keys unset with an installation → it throws (the purge step fails alone)", async () => {
    useDb([]);
    setKeys(undefined);
    expect(await resealSlackTokens()).toEqual({ checked: 0, resealed: 0, unknownKey: 0, lost: 0, failed: 0 });
    setKeys(KEY_A);
    useDb([inst({}, false)]);
    setKeys(undefined);
    await expect(resealSlackTokens()).rejects.toBeInstanceOf(SecretUnavailableError);
  });
});

describe("RS06 the token contexts and the store's new reads (AM-P9-20)", () => {
  it("RS06 slack-oauth.ts seals with exactly the contexts slack-install.ts exports (a seal with OAuth's literal opens with the export)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "lib", "exec", "slack-oauth.ts"), "utf8");
    const literal = (name: string) => new RegExp(`const ${name} = "([^"]+)";`).exec(src)?.[1];
    expect(literal("BOT_TOKEN_CONTEXT")).toBe(SLACK_BOT_TOKEN_CONTEXT);
    expect(literal("USER_TOKEN_CONTEXT")).toBe(SLACK_USER_TOKEN_CONTEXT);
    // Every sealed-token context slack-oauth.ts names (its two constants and any inline literal) is one of the two exported prefixes.
    expect(new Set([...src.matchAll(/exec_slack_installations\.[a-z_]+:/g)].map((m) => m[0]))).toEqual(new Set([SLACK_BOT_TOKEN_CONTEXT, SLACK_USER_TOKEN_CONTEXT]));
    const sealed = sealSecret(BOT, `${literal("BOT_TOKEN_CONTEXT")}ep_9`);
    expect(openSecret(sealed, botTokenContext("ep_9"))).toBe(BOT);
    const sealedUser = sealSecret(USER, `${literal("USER_TOKEN_CONTEXT")}ep_9`);
    expect(openSecret(sealedUser, userTokenContext("ep_9"))).toBe(USER);
  });

  it("RS06 resealTokenCas refuses malformed arguments with no call; slackTokenKeyIds reads key ids only (null without an active row); listActiveInstallationsForSystem lists every active row, any principal", async () => {
    useDb([inst(), inst({ id: INST_2, principal_id: "ep_2", team_id: "T0OTHER", slack_dm_channel_id: "D0OTHER" }, false),
      inst({ id: `esi_${hex32(3)}`, principal_id: "ep_3", team_id: "T0THIRD", slack_dm_channel_id: "D0THIRD", revoked_at: "2026-11-02T00:00:00.000Z" })]);
    const good = String(row().bot_token_enc);
    expect(await resealTokenCas("bad", "bot", good, good, kid(KEY_A))).toBe(false);
    expect(await resealTokenCas(INST, "bot", "not-a-blob", good, kid(KEY_A))).toBe(false);
    expect(await resealTokenCas(INST, "bot", good, good, "zzzzzzzz")).toBe(false);
    expect(await resealTokenCas(INST, "bot", good, good, kid(KEY_B))).toBe(false);   // the key id must be the new blob's own
    expect(db.calls.filter((c) => c.kind === "update")).toEqual([]);
    expect(await slackTokenKeyIds(P1)).toEqual({ bot: kid(KEY_A), user: kid(KEY_A) });
    expect(await slackTokenKeyIds({ ...P1, id: "ep_2" } as ExecPrincipal)).toEqual({ bot: kid(KEY_A), user: null });
    expect(await slackTokenKeyIds({ ...P1, id: "ep_3" } as ExecPrincipal)).toBeNull();
    expect(await listActiveInstallationsForSystem(10)).toEqual([{ id: INST, principalId: "ep_1" }, { id: INST_2, principalId: "ep_2" }]);
    useDb([], { missing: ["exec_slack_installations"] });
    expect(await listActiveInstallationsForSystem(10)).toEqual([]);
    expect(await listSealedTokensForReseal(10)).toEqual([]);
    expect(await slackTokenKeyIds(P1)).toBeNull();
  });
});
