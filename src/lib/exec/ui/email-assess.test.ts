import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ withAudit: vi.fn() }));
vi.mock("@/lib/exec/email-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-store")>()),
  getEmailThread: vi.fn()
}));
vi.mock("@/lib/exec/email-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/email-view")>()),
  loadEmailGate: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sources/mail")>()),
  loadScreeningPolicy: vi.fn()
}));
vi.mock("@/lib/exec/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/jobs")>()),
  enqueueJob: vi.fn()
}));
vi.mock("@/lib/exec/sync-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn()
}));

import * as routeModule from "@/app/api/exec/email/threads/[threadId]/assess/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { withAudit } from "@/lib/exec/audit";
import { ASSESS_ACTION, ASSESS_LIMIT, ASSESS_ROUTE, assessThread, isSameOriginRequest } from "@/lib/exec/email-assess";
import { getEmailThread } from "@/lib/exec/email-store";
import type { ExecEmailThread } from "@/lib/exec/email-types";
import { loadEmailGate } from "@/lib/exec/email-view";
import { enqueueJob, EMAIL_TRIAGE_JOB_KIND, EMAIL_TRIAGE_MAX_ATTEMPTS } from "@/lib/exec/jobs";
import { principalFromRows, DEFAULT_SETTINGS } from "@/lib/exec/principal";
import { loadScreeningPolicy, restrictedPolicyHash, screenHashesFor } from "@/lib/exec/sources/mail";
import { getSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { AuditUnavailableError, type ExecPrincipal, type ExecSettings } from "@/lib/exec/types";
import { ruleFromRow } from "@/lib/restricted-senders";

// POST /api/exec/email/threads/:id/assess (contract §3.14, coherence-21,
// §5 F "every status"): the owner gate with the step-up, same origin, the id
// shape, email on, a stored row he may see in an assessable state, the rate
// limit, then the audit row and one forced, deduped triage job.

const NOW = new Date("2026-11-04T15:00:30Z");
const MINUTE = Math.floor(NOW.getTime() / 60_000);

function mint(): ExecPrincipal {
  const p = principalFromRows(
    { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const principal = mint();
const settings: ExecSettings = { principalId: "ep_owner", ...DEFAULT_SETTINGS, mutedChannelIds: [], emailEnabled: true, emailSchemaReady: true };

const RULE = ruleFromRow({ id: "r1", pattern: "restricted.example", match_kind: "domain", label: "R" }, new Set());
const H = restrictedPolicyHash("hidden", [RULE]);
const CLEAN = screenHashesFor({ all: [{ from: "jane@acme.com", to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes;
const RESTRICTED = screenHashesFor({ all: [{ from: "x@restricted.example", to: [], cc: [] }], participants: [] }).hashes;

const row = (over: Partial<ExecEmailThread> = {}) =>
  ({ threadId: "t1", accountId: "acc_his", state: "filtered", screenHashes: CLEAN, screenTruncated: false, screenedPolicyHash: H, ...over }) as ExecEmailThread;

interface CountQuery {
  table: string;
  filters: [string, string, unknown][];
  options: unknown;
}
let countQueries: CountQuery[];
let countResult: { count: number | null; error: { message: string } | null };

function fakeAdmin() {
  return {
    from(table: string) {
      const q: CountQuery = { table, filters: [], options: null };
      countQueries.push(q);
      const b = {
        select: (_cols: string, options: unknown) => ((q.options = options), b),
        eq: (c: string, v: unknown) => (q.filters.push(["eq", c, v]), b),
        gte: (c: string, v: unknown) => (q.filters.push(["gte", c, v]), b),
        then: <A, B>(ok?: (v: unknown) => A, bad?: (e: unknown) => B) => Promise.resolve(countResult).then(ok, bad)
      };
      return b;
    }
  };
}

const request = (headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
  new Request("https://operations.scaledai.org/api/exec/email/threads/t1/assess", { method: "POST", headers });

beforeEach(() => {
  countQueries = [];
  countResult = { count: 3, error: null };
  vi.mocked(getSupabaseAdmin).mockReturnValue(fakeAdmin() as unknown as SupabaseClient);
  vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: true, principal });
  vi.mocked(loadEmailGate).mockResolvedValue({ kind: "on", settings, pinned: ["acc_his"] });
  vi.mocked(getEmailThread).mockResolvedValue(row());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [RULE], hash: H });
  vi.mocked(withAudit).mockImplementation(async (_p, _entry, fn) => fn());
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 42 });
  // mail/accounts: no reconcile yet, so nothing is a problem account.
  vi.mocked(getSyncState).mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const accountsState = (problems: { accountId: string; reason: string }[]) => ({
  value: { checkedAt: NOW.toISOString(), accounts: [{ id: "acc_his", email: "mitchell@scaledai.org", lastSyncedAt: NOW.toISOString(), lastSyncError: null, lastSyncErrorAt: null }], problems },
  rev: 2
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function status(res: Promise<NextResponse>): Promise<[number, unknown]> {
  const r = await res;
  return [r.status, await r.json()];
}

describe("assess: refusals", () => {
  it("passes the gate's own answer through (404, 401, 503), with the step-up asked for", async () => {
    for (const code of [404, 401, 503] as const) {
      vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status: code }) });
      expect((await assessThread(request(), "t1", NOW)).status).toBe(code);
    }
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), ASSESS_ROUTE, { requireStrongSignIn: true });
    expect(ASSESS_ROUTE).toBe("POST /api/exec/email/threads/:id/assess");
    expect(loadEmailGate).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("refuses another site (403) before reading anything", async () => {
    const headerSets: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
      {},
      { origin: "https://evil.example", host: "operations.scaledai.org" },
      { origin: "null", host: "x" }
    ];
    for (const headers of headerSets) {
      expect(await status(assessThread(request(headers), "t1", NOW))).toEqual([403, { error: "cross_origin" }]);
    }
    expect(loadEmailGate).not.toHaveBeenCalled();
  });

  it("refuses a malformed thread id (400)", async () => {
    for (const id of ["", "../x", "a/b", "t 1", "x".repeat(201)]) {
      expect(await status(assessThread(request(), id, NOW))).toEqual([400, { error: "bad_thread_id" }]);
    }
  });

  it("404s while email is off, not installed or unpinned", async () => {
    for (const kind of ["off", "no_pin"] as const) {
      vi.mocked(loadEmailGate).mockResolvedValue({ kind, settings });
      expect(await status(assessThread(request(), "t1", NOW))).toEqual([404, { error: "email_off" }]);
    }
    expect(getEmailThread).not.toHaveBeenCalled();
  });

  it("404s for no row, a tombstone, a gone row, or a row the screen now catches", async () => {
    for (const r of [null, row({ state: "restricted_hidden" }), row({ state: "gone" }), row({ screenHashes: RESTRICTED }), row({ screenTruncated: true, screenedPolicyHash: "0".repeat(64) })]) {
      vi.mocked(getEmailThread).mockResolvedValue(r);
      expect(await status(assessThread(request(), "t1", NOW))).toEqual([404, { error: "not_found" }]);
    }
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("409s for a thread that was assessed already", async () => {
    vi.mocked(getEmailThread).mockResolvedValue(row({ state: "triaged" }));
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([409, { error: "not_assessable", state: "triaged" }]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("409s, queuing nothing, for a thread on a mailbox triage won't read: a problem account, or one no longer pinned (ui-2)", async () => {
    vi.mocked(getSyncState).mockResolvedValue(accountsState([{ accountId: "acc_his", reason: "not_found" }]) as never);
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([409, { error: "account_unusable" }]);
    expect(getSyncState).toHaveBeenCalledWith(principal, "mail", "accounts", expect.any(Function));
    vi.mocked(getSyncState).mockResolvedValue(null);
    vi.mocked(getEmailThread).mockResolvedValue(row({ accountId: "acc_old" }));
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([409, { error: "account_unusable" }]);
    expect(withAudit).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
    // A problem on some other account doesn't stop it.
    vi.mocked(getEmailThread).mockResolvedValue(row());
    vi.mocked(getSyncState).mockResolvedValue(accountsState([{ accountId: "acc_two", reason: "not_found" }]) as never);
    expect((await assessThread(request(), "t1", NOW)).status).toBe(202);
  });

  it("429s past 20 in 10 minutes, counted from his audit rows", async () => {
    countResult = { count: ASSESS_LIMIT, error: null };
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([429, { error: "rate_limited" }]);
    expect(countQueries).toEqual([
      {
        table: "exec_audit_log",
        options: { count: "exact", head: true },
        filters: [
          ["eq", "principal_id", "ep_owner"],
          ["eq", "action", ASSESS_ACTION],
          ["gte", "created_at", "2026-11-04T14:50:30.000Z"]
        ]
      }
    ]);
    expect(withAudit).not.toHaveBeenCalled();
  });

  it("503s, queuing nothing, when the mailbox state can't be read (it can't tell whether triage would run)", async () => {
    vi.mocked(getSyncState).mockRejectedValue(new Error("exec_sync_state read failed"));
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([503, { error: "unavailable" }]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("503s, queuing nothing, when the count, the rules, the row or the settings can't be read", async () => {
    const breakers = [
      () => (countResult = { count: null, error: { message: "timeout" } }),
      () => vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("rules unavailable")),
      () => vi.mocked(getEmailThread).mockRejectedValue(new Error("read failed")),
      () => vi.mocked(loadEmailGate).mockRejectedValue(new Error("settings read failed"))
    ];
    for (const breakIt of breakers) {
      breakIt();
      expect(await status(assessThread(request(), "t1", NOW))).toEqual([503, { error: "unavailable" }]);
    }
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("503s and queues nothing when the audit row can't be written", async () => {
    vi.mocked(withAudit).mockRejectedValue(new AuditUnavailableError("audit log unavailable"));
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([503, { error: "audit_unavailable" }]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("503s when the enqueue fails", async () => {
    vi.mocked(enqueueJob).mockRejectedValue(new Error("exec_jobs enqueue failed"));
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([503, { error: "unavailable" }]);
  });
});

describe("assess: accepted", () => {
  it("audits first, then queues one forced interactive triage keyed to the minute (202)", async () => {
    for (const state of ["filtered", "triage_failed", "deferred_budget"] as const) {
      vi.mocked(getEmailThread).mockResolvedValue(row({ state }));
      expect(await status(assessThread(request(), "t1", NOW))).toEqual([202, { queued: true, duplicate: false }]);
    }
    expect(withAudit).toHaveBeenCalledWith(principal, { actor: "owner", action: "email.assess", target: "exec_email_threads:t1", input: { threadId: "t1" } }, expect.any(Function));
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: EMAIL_TRIAGE_JOB_KIND,
      lane: "interactive",
      principalId: "ep_owner",
      payload: { threadId: "t1", reason: "assess", accountId: "acc_his", force: true },
      dedupeKey: `retriage:ep_owner:t1:assess:m${MINUTE}`,
      maxAttempts: EMAIL_TRIAGE_MAX_ATTEMPTS
    });
    expect(vi.mocked(withAudit).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(enqueueJob).mock.invocationCallOrder[0]);
  });

  it("says a double click within the minute queued nothing new", async () => {
    vi.mocked(enqueueJob).mockResolvedValue({ enqueued: false, id: null });
    expect(await status(assessThread(request(), "t1", NOW))).toEqual([202, { queued: true, duplicate: true }]);
  });

  it("accepts the Origin check behind a proxy when Sec-Fetch-Site is absent", async () => {
    expect((await assessThread(request({ origin: "https://operations.scaledai.org", host: "operations.scaledai.org" }), "t1", NOW)).status).toBe(202);
    expect((await assessThread(request({ origin: "https://operations.scaledai.org", host: "internal:8080", "x-forwarded-host": "operations.scaledai.org" }), "t1", NOW)).status).toBe(202);
  });
});

describe("assess: the route file", () => {
  it("exports POST (other methods get Next's 405) and nothing but route fields", async () => {
    expect(Object.keys(routeModule).sort()).toEqual(["POST", "dynamic"]);
    expect(routeModule.dynamic).toBe("force-dynamic");
    const res = await routeModule.POST(request(), { params: { threadId: "t1" } });
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("isSameOriginRequest", () => {
  const r = (headers: Record<string, string>) => new Request("https://x/", { method: "POST", headers });
  it("trusts Sec-Fetch-Site when the browser sends it", () => {
    expect(isSameOriginRequest(r({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(r({ "sec-fetch-site": "same-origin", origin: "https://evil.example" }))).toBe(true);
    expect(isSameOriginRequest(r({ "sec-fetch-site": "cross-site", origin: "https://x", host: "x" }))).toBe(false);
  });
  it("otherwise needs an Origin whose host is this request's", () => {
    expect(isSameOriginRequest(r({ origin: "https://Operations.ScaledAI.org", host: "operations.scaledai.org" }))).toBe(true);
    expect(isSameOriginRequest(r({ origin: "https://operations.scaledai.org.evil.example", host: "operations.scaledai.org" }))).toBe(false);
    expect(isSameOriginRequest(r({ host: "operations.scaledai.org" }))).toBe(false);
    expect(isSameOriginRequest(r({ origin: "not a url", host: "x" }))).toBe(false);
  });
});
