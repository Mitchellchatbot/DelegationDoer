import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { principalFromRows } from "@/lib/exec/principal";
import { CloneHttpError, MailScopeError, searchPrincipalThreads } from "@/lib/exec/sources/mail";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { installFakeClone, json, type FakeClone } from "../__tests__/fake-clone";

// P5b contract §3.9 and test 28's q string: the chat's live search, the one place it can live (P3 rule 7).

function mint(accounts: string[]): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint(["acc_a", "acc_b"]);
const SINCE = Date.parse("2026-10-05T03:00:00.000Z");
const base = { query: "", from: "", sinceMs: SINCE, folders: ["INBOX", "SENT"] as const, limit: 10, usable: ["acc_a"] };

let clone: FakeClone;
beforeEach(() => {
  clone = installFakeClone(() => json(200, { threads: [], limit: 10, offset: 0, hasMore: false }), vi.stubGlobal);
});
afterEach(() => vi.unstubAllGlobals());

const params = (i: number) => Object.fromEntries(clone.requests[i].url.searchParams);

describe("searchPrincipalThreads", () => {
  it("one call per (account, folder), scoped to the mailbox, explicit folders, no status, no snoozed, offset 0", async () => {
    await searchPrincipalThreads(principal, { ...base, usable: ["acc_a", "acc_b"] });
    expect(clone.requests.map((r) => [r.url.searchParams.get("mailbox_id"), r.url.searchParams.get("folder")])).toEqual([
      ["acc_a", "INBOX"],
      ["acc_a", "SENT"],
      ["acc_b", "INBOX"],
      ["acc_b", "SENT"]
    ]);
    for (let i = 0; i < 4; i += 1) {
      expect(clone.requests[i].url.searchParams.has("status")).toBe(false);
      expect(clone.requests[i].url.searchParams.has("snoozed")).toBe(false);
      expect(params(i).limit).toBe("10");
    }
  });

  it("q: free text quoted with operator words defused, from:\"…\" quoted with quotes stripped, empty terms omitted, after: a UTC date", async () => {
    await searchPrincipalThreads(principal, { ...base, folders: ["INBOX"], query: 'invoice from: evil is:snoozed "q"', from: 'Carol "C" Client' });
    expect(params(0).q).toBe('"invoice from evil is snoozed q" from:"Carol C Client" after:"2026-10-05"');
    await searchPrincipalThreads(principal, { ...base, folders: ["INBOX"] });
    expect(params(1).q).toBe('after:"2026-10-05"');
    await searchPrincipalThreads(principal, { ...base, folders: ["INBOX"], query: "   ", from: "\n\t" });
    expect(params(2).q).toBe('after:"2026-10-05"');
  });

  it("returns ids and times only, deduped by thread keeping the newest, newest first", async () => {
    clone.setHandler((req) =>
      json(200, {
        threads:
          req.url.searchParams.get("folder") === "INBOX"
            ? [
                { id: "t1", subject: "SECRET", last_from: "SECRET", last_snippet: "SECRET", last_message_at: "1762250000000" },
                { id: "t2", last_message_at: "1762260000000" }
              ]
            : [{ id: "t1", last_message_at: "1762270000000" }, { id: "", last_message_at: "1" }],
        limit: 10,
        offset: 0,
        hasMore: false
      })
    );
    const hits = await searchPrincipalThreads(principal, base);
    expect(hits).toEqual([
      { threadId: "t1", accountId: "acc_a", folder: "SENT", lastMessageAtMs: 1762270000000 },
      { threadId: "t2", accountId: "acc_a", folder: "INBOX", lastMessageAtMs: 1762260000000 }
    ]);
    expect(JSON.stringify(hits)).not.toContain("SECRET");
  });

  it("refuses an unpinned account, bad folders and limits before any request; a clone error is a CloneHttpError", async () => {
    await expect(searchPrincipalThreads(principal, { ...base, usable: ["acc_x"] })).rejects.toBeInstanceOf(MailScopeError);
    await expect(searchPrincipalThreads(principal, { ...base, folders: [] })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(searchPrincipalThreads(principal, { ...base, folders: ["SPAM" as never] })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(searchPrincipalThreads(principal, { ...base, limit: 26 })).rejects.toBeInstanceOf(NonRetryableError);
    await expect(searchPrincipalThreads(principal, { ...base, sinceMs: Number.NaN })).rejects.toBeInstanceOf(NonRetryableError);
    expect(clone.requests).toHaveLength(0);
    clone.setHandler(() => json(502, { error: "bad gateway" }));
    await expect(searchPrincipalThreads(principal, base)).rejects.toBeInstanceOf(CloneHttpError);
  });
});
