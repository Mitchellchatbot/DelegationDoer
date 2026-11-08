import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { principalFromRows } from "@/lib/exec/principal";
import { getSyncState, parseEaTokenState, parseSendTokenState, putSyncState, type EaTokenState, type SendTokenState } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { createFakePostgrest } from "./__tests__/fake-postgrest";

// X3 (contract §3.14, §2.3; PX06): the clone-ea source and the two verdict parsers.

function mint(id: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint("ep_owner");

const EA_STATE: EaTokenState = {
  ok: false,
  reason: "wrong_scopes",
  checkedAt: "2026-11-05T12:00:00.000Z",
  cl2Ready: true,
  cl2Send: "some",
  sendEnabled: null,
  expiresAt: "2027-11-05T12:00:00.000Z",
  tokenFp: "0123456789ab"
};
const SEND_STATE: SendTokenState = { ok: true, reason: null, checkedAt: "2026-11-05T12:00:00.000Z", expiresAt: null, tokenFp: "abcdef012345" };

beforeEach(() => {
  const db = createFakePostgrest({ tables: { exec_sync_state: [] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
});

describe("PX06 clone-ea is a source", () => {
  it("put and get accept it, and the parsers round-trip the stored value", async () => {
    await putSyncState(principal, "clone-ea", "ea-token", EA_STATE);
    const ea = await getSyncState(principal, "clone-ea", "ea-token", parseEaTokenState);
    expect(ea).toEqual({ value: EA_STATE, rev: 1 });
    await putSyncState(principal, "clone-ea", "send-token", SEND_STATE);
    const send = await getSyncState(principal, "clone-ea", "send-token", parseSendTokenState);
    expect(send).toEqual({ value: SEND_STATE, rev: 1 });
    await putSyncState(principal, "clone-ea", "ea-token", { ...EA_STATE, ok: true, reason: null, sendEnabled: true });
    expect((await getSyncState(principal, "clone-ea", "ea-token", parseEaTokenState))?.rev).toBe(2);
  });

  it("an unknown source is still refused", async () => {
    await expect(getSyncState(principal, "bogus" as "mail", "k", parseEaTokenState)).rejects.toBeInstanceOf(NonRetryableError);
    await expect(putSyncState(principal, "clone-ea-x" as "mail", "k", EA_STATE)).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("parseEaTokenState", () => {
  it("accepts the shape with every nullable field null, ignoring rev and unknown keys", () => {
    expect(parseEaTokenState({ ok: true, reason: null, checkedAt: "2026-11-05T12:00:00Z", rev: 3, extra: 1 })).toEqual({
      ok: true,
      reason: null,
      checkedAt: "2026-11-05T12:00:00Z",
      cl2Ready: null,
      cl2Send: null,
      sendEnabled: null,
      expiresAt: null,
      tokenFp: null
    });
    expect(parseEaTokenState({ ...EA_STATE, rev: 7 })).toEqual(EA_STATE);
  });

  it.each([
    ["not an object", "x"],
    ["an array", [EA_STATE]],
    ["a missing ok", { ...EA_STATE, ok: undefined }],
    ["a non-boolean ok", { ...EA_STATE, ok: "yes" }],
    ["a missing checkedAt", { ...EA_STATE, checkedAt: undefined }],
    ["a malformed checkedAt", { ...EA_STATE, checkedAt: "yesterday" }],
    ["an unknown reason", { ...EA_STATE, reason: "mystery" }],
    ["a reason from the send vocabulary", { ...EA_STATE, reason: "malformed" }],
    ["a bad cl2Send", { ...EA_STATE, cl2Send: "maybe" }],
    ["a bad cl2Ready", { ...EA_STATE, cl2Ready: 1 }],
    ["a bad sendEnabled", { ...EA_STATE, sendEnabled: "true" }],
    ["a malformed expiresAt", { ...EA_STATE, expiresAt: 12345 }],
    ["a tokenFp that isn't 12 hex", { ...EA_STATE, tokenFp: "abc" }],
    ["a tokenFp that looks like a token", { ...EA_STATE, tokenFp: "eyJhbGciOiJI" }]
  ])("%s is null", (_what, raw) => {
    expect(parseEaTokenState(raw)).toBeNull();
  });

  it("every readiness reason parses", () => {
    for (const reason of ["no_pin", "multiple_principals", "token_missing", "base_url_missing", "clone_unreachable", "cl2_missing", "cl2_not_ready", "me_failed", "me_no_auth", "not_scoped", "wrong_scopes", "wrong_accounts", "token_expired"]) {
      expect(parseEaTokenState({ ...EA_STATE, reason })?.reason).toBe(reason);
    }
  });
});

describe("parseSendTokenState", () => {
  it("round-trips and rejects the malformed", () => {
    expect(parseSendTokenState({ ...SEND_STATE, rev: 2 })).toEqual(SEND_STATE);
    expect(parseSendTokenState({ ok: false, reason: "token_expired", checkedAt: "2026-11-05T12:00:00Z", expiresAt: "2026-01-01T00:00:00Z", tokenFp: "0123456789ab" })).toEqual({
      ok: false,
      reason: "token_expired",
      checkedAt: "2026-11-05T12:00:00Z",
      expiresAt: "2026-01-01T00:00:00Z",
      tokenFp: "0123456789ab"
    });
    for (const reason of ["token_missing", "malformed", "not_scoped", "wrong_scopes", "wrong_accounts", "token_expired"]) {
      expect(parseSendTokenState({ ...SEND_STATE, reason })?.reason).toBe(reason);
    }
    expect(parseSendTokenState({ ...SEND_STATE, reason: "no_pin" })).toBeNull();
    expect(parseSendTokenState({ ...SEND_STATE, checkedAt: null })).toBeNull();
    expect(parseSendTokenState({ ...SEND_STATE, ok: null })).toBeNull();
    expect(parseSendTokenState({ ...SEND_STATE, tokenFp: "x" })).toBeNull();
    expect(parseSendTokenState(null)).toBeNull();
  });
});
