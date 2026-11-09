import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// P8 contract §5.15 NA05-NA09, NA11 (M13, C20): the in-process sighting hook and the exec.access-alert job. The access-log
// read is the real access.ts listWebAccessSince over a fake exec_access_log; Slack, the job queue and the ops channel are
// mocked at their module boundary (renderNetworkAlertDm is Area D's renderer).

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/jobs")>();
  return { ...actual, enqueueJob: vi.fn() };
});
vi.mock("@/lib/exec/slack-install", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-install")>();
  return { ...actual, openActiveInstallation: vi.fn() };
});
vi.mock("@/lib/exec/slack-dm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/slack-dm")>();
  return { ...actual, dmPost: vi.fn() };
});
vi.mock("@/lib/exec/brief-slack-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/brief-slack-ui")>();
  return { ...actual, renderNetworkAlertDm: vi.fn() };
});

import { assertNoBriefText } from "@/lib/exec/__tests__/brief-assert";
import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";
import { createFakeJobsRead, type ReadRow } from "@/lib/exec/__tests__/fake-jobs-read";
import { listWebAccessSince } from "@/lib/exec/access";
import { BRIEF_COPY, BRIEF_OPS } from "@/lib/exec/brief-copy";
import { renderNetworkAlertDm } from "@/lib/exec/brief-slack-ui";
import {
  ACCESS_ALERT_JOB_KIND,
  __resetAccessAlertSightingsForTests,
  accessAlertJobHandler,
  noteStrongWebAccess
} from "@/lib/exec/handlers/access-alert";
import { enqueueJob } from "@/lib/exec/jobs";
import { networkKeyHash } from "@/lib/exec/network";
import { notifyOps } from "@/lib/exec/ops";
import { principalFromRows } from "@/lib/exec/principal";
import { dmPost } from "@/lib/exec/slack-dm";
import { openActiveInstallation } from "@/lib/exec/slack-install";
import type { OpenInstallation, SlackMessageParts } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const P: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const AT = "2026-11-06T15:00:00.000Z";
const AT_MS = Date.parse(AT);
const MIN = 60_000;
const DAY = 86_400_000;
const INST = { row: { id: "esi_" + "1".repeat(32), dmChannelId: "D0OWNER01" }, target: { token: "SENTINEL_TOKEN_xoxp_FAKE", dmChannelId: "D0OWNER01" } } as unknown as OpenInstallation;
const PARTS: SlackMessageParts = { text: BRIEF_COPY.networkFallbackText, blocks: [] };

/** n web rows from the known office network and browser, spread over the last 30 days (none in the last 10 minutes). */
function history(n: number, o: Partial<ReadRow> = {}): ReadRow[] {
  return Array.from({ length: n }, (_, i) => ({
    principal_id: "ep_1", surface: "web", ip: `198.51.100.${(i % 200) + 1}`, user_agent: CHROME_MAC,
    created_at: new Date(AT_MS - (i + 1) * DAY + 3_600_000).toISOString(), ...o
  }));
}

function arm(rows: ReadRow[]) {
  const db = createFakeJobsRead({ exec_access_log: rows });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

const runJob = (payload: Record<string, unknown>, principal: ExecPrincipal | null = P) =>
  accessAlertJobHandler.run({ job: jobRow({ kind: ACCESS_ALERT_JOB_KIND, principal_id: principal?.id ?? null, payload }), principal, signal: new AbortController().signal, workerId: "w" });

beforeEach(() => {
  __resetAccessAlertSightingsForTests();
  vi.mocked(enqueueJob).mockReset();
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(notifyOps).mockReset();
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(openActiveInstallation).mockReset();
  vi.mocked(openActiveInstallation).mockResolvedValue(INST);
  vi.mocked(dmPost).mockReset();
  vi.mocked(dmPost).mockResolvedValue({ ts: "1793990000.000100" });
  vi.mocked(renderNetworkAlertDm).mockReset();
  vi.mocked(renderNetworkAlertDm).mockReturnValue(PARTS);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------------------------------------------------

describe("noteStrongWebAccess (the hook)", () => {
  const now = new Date(AT);

  it("the first sighting enqueues exec.access-alert: bulk, 2 attempts, keyed per network, family and UTC day", async () => {
    noteStrongWebAccess(P, { ip: "203.0.113.7", userAgent: SAFARI_IOS, now });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toEqual({
      kind: "exec.access-alert",
      lane: "bulk",
      principalId: "ep_1",
      payload: { net: "203.0.113.0/24", family: "safari-ios", at: AT },
      dedupeKey: `access-alert:ep_1:${networkKeyHash("203.0.113.0/24")}:safari-ios:2026-11-06`,
      maxAttempts: 2
    });
  });

  it("NA05 the same network and family twice in one process → one enqueue; another /24, family or day → another", () => {
    noteStrongWebAccess(P, { ip: "203.0.113.7", userAgent: SAFARI_IOS, now });
    noteStrongWebAccess(P, { ip: "203.0.113.99", userAgent: SAFARI_IOS, now: new Date(AT_MS + 3 * 3_600_000) });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    noteStrongWebAccess(P, { ip: "203.0.114.7", userAgent: SAFARI_IOS, now });
    noteStrongWebAccess(P, { ip: "203.0.113.7", userAgent: CHROME_MAC, now });
    expect(enqueueJob).toHaveBeenCalledTimes(3);
    noteStrongWebAccess(P, { ip: "203.0.113.7", userAgent: SAFARI_IOS, now: new Date("2026-11-07T00:00:01Z") });
    expect(enqueueJob).toHaveBeenCalledTimes(4);
    const keys = vi.mocked(enqueueJob).mock.calls.map(([i]) => i.dedupeKey);
    expect(keys[3]).toBe(`access-alert:ep_1:${networkKeyHash("203.0.113.0/24")}:safari-ios:2026-11-07`);
    expect(new Set(keys).size).toBe(4);
  });

  it("NA05 across processes the job key dedupes: a second process sends the identical key for the same network, family and UTC day", () => {
    noteStrongWebAccess(P, { ip: "203.0.113.7", userAgent: SAFARI_IOS, now });
    __resetAccessAlertSightingsForTests();   // another process: empty sightings
    noteStrongWebAccess(P, { ip: "203.0.113.200", userAgent: SAFARI_IOS, now: new Date(AT_MS + 60 * MIN) });
    const [a, b] = vi.mocked(enqueueJob).mock.calls.map(([i]) => i.dedupeKey);
    expect(a).toBe(b);
  });

  it("no usable address → nothing (there's no network to key on)", () => {
    noteStrongWebAccess(P, { ip: null, userAgent: SAFARI_IOS, now });
    noteStrongWebAccess(P, { ip: "garbage", userAgent: SAFARI_IOS, now });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("never throws: a failed enqueue is logged by principal id and error name, and the next sighting may try again", async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("exec_jobs enqueue failed (exec.access-alert): 203.0.113.7"));
    expect(() => noteStrongWebAccess(P, { ip: "203.0.113.7", userAgent: SAFARI_IOS, now })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(console.warn).toHaveBeenCalledWith("[exec-access-alert] principal ep_1: could not enqueue the new-network check (Error)");
    noteStrongWebAccess(P, { ip: "203.0.113.7", userAgent: SAFARI_IOS, now });
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    vi.mocked(enqueueJob).mockImplementationOnce(() => {
      throw new TypeError("sync");
    });
    __resetAccessAlertSightingsForTests();
    expect(() => noteStrongWebAccess(P, { ip: "203.0.113.8", userAgent: SAFARI_IOS, now })).not.toThrow();
    for (const call of vi.mocked(console.warn).mock.calls) expect(JSON.stringify(call)).not.toMatch(/203\.0\.113|Safari|Mozilla/);
  });

  it("NA11 the job payload holds only net, family and at: never the full IP or the user agent", () => {
    noteStrongWebAccess(P, { ip: "2001:db8:1234:5678::42", userAgent: SAFARI_IOS, now });
    const input = vi.mocked(enqueueJob).mock.calls[0][0];
    expect(Object.keys(input.payload ?? {}).sort()).toEqual(["at", "family", "net"]);
    expect(input.payload).toEqual({ net: "2001:db8:1234::/48", family: "safari-ios", at: AT });
    const json = JSON.stringify(input);
    expect(json).not.toContain("5678");
    expect(json).not.toContain("::42");
    expect(json).not.toContain("Mozilla");
    expect(json).not.toContain("iPhone");
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("exec.access-alert (§3.13.10)", () => {
  const NEW_NET = { net: "203.0.113.0/24", family: "chrome-mac", at: AT };

  it("is a bulk job with a 30 s ceiling", () => {
    expect(accessAlertJobHandler).toMatchObject({ kind: "exec.access-alert", lane: "bulk", timeoutMs: 30_000 });
  });

  it("NA06 fewer than 20 web rows in 30 days → learning, no alert", async () => {
    arm(history(19));
    await expect(runJob(NEW_NET)).resolves.toEqual({ skipped: "learning", rows: 19 });
    expect(notifyOps).not.toHaveBeenCalled();
    expect(dmPost).not.toHaveBeenCalled();
  });

  it("NA06 the network and the family both seen → known, no alert", async () => {
    arm([...history(25), ...history(1, { ip: "203.0.113.200", created_at: new Date(AT_MS - 3 * DAY).toISOString() })]);
    await expect(runJob(NEW_NET)).resolves.toEqual({ skipped: "known", rows: 26 });
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("NA06 a new /24 → the exec bot DMs him (ledger kind note) and ops are alerted", async () => {
    arm(history(25));
    await expect(runJob(NEW_NET)).resolves.toEqual({ outcome: "alerted", newNetwork: true, newFamily: false, dm: "posted", rows: 25 });
    expect(renderNetworkAlertDm).toHaveBeenCalledWith({ net: "203.0.113.0/24", family: "chrome-mac", at: AT, tz: "America/New_York" });
    expect(dmPost).toHaveBeenCalledTimes(1);
    const [p, inst, threadTs, parts, ledger, opts] = vi.mocked(dmPost).mock.calls[0];
    expect([p, inst, threadTs, parts, ledger]).toEqual([P, INST, null, PARTS, { kind: "note" }]);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(notifyOps).mock.calls.map(([a]) => a)).toEqual([
      { key: BRIEF_OPS.newNetwork.key("ep_1"), title: BRIEF_OPS.newNetwork.title, detail: "203.0.113.0/24 (chrome-mac)" }
    ]);
  });

  it("NA06 a new family on a known network → alert", async () => {
    arm([...history(25), ...history(1, { ip: "203.0.113.5" })]);
    await expect(runJob({ ...NEW_NET, family: "firefox-linux" })).resolves.toEqual({ outcome: "alerted", newNetwork: false, newFamily: true, dm: "posted", rows: 26 });
    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it("NA07 surface 'slack' rows are never read: the read filters surface = 'web', and a slack row with the new network changes nothing", async () => {
    const db = arm([...history(25), ...history(3, { surface: "slack", ip: "203.0.113.9", user_agent: null })]);
    await expect(runJob(NEW_NET)).resolves.toMatchObject({ outcome: "alerted", newNetwork: true, rows: 25 });
    expect(db.queries[0]).toMatchObject({
      table: "exec_access_log",
      columns: "ip,user_agent",
      filters: [
        { op: "eq", column: "principal_id", value: "ep_1" },
        { op: "eq", column: "surface", value: "web" },
        { op: "gte", column: "created_at", value: new Date(AT_MS - 30 * DAY).toISOString() },
        { op: "lt", column: "created_at", value: new Date(AT_MS - 10 * MIN).toISOString() }
      ],
      order: { column: "created_at", ascending: false },
      limit: 5_000
    });
  });

  it("NA07 listWebAccessSince itself: web rows of the principal in [from, to), ip and user agent only", async () => {
    arm([
      ...history(2),
      { principal_id: "ep_2", surface: "web", ip: "192.0.2.1", user_agent: CHROME_MAC, created_at: new Date(AT_MS - DAY).toISOString() },
      { principal_id: "ep_1", surface: "slack", ip: null, user_agent: null, created_at: new Date(AT_MS - DAY).toISOString() }
    ]);
    const rows = await listWebAccessSince("ep_1", new Date(AT_MS - 30 * DAY).toISOString(), AT, 100);
    expect(rows).toEqual([
      { ip: "198.51.100.1", userAgent: CHROME_MAC },
      { ip: "198.51.100.2", userAgent: CHROME_MAC }
    ]);
    const db = createFakeJobsRead({ exec_access_log: [] });
    db.failNext("exec_access_log", { message: "timeout" });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    await expect(listWebAccessSince("ep_1", AT, AT, 10)).rejects.toThrow("exec_access_log read failed");
    await expect(listWebAccessSince("", AT, AT, 10)).rejects.toThrow(TypeError);
  });

  it("NA08 no installation → the ops alert only", async () => {
    vi.mocked(openActiveInstallation).mockResolvedValue(null);
    arm(history(25));
    await expect(runJob(NEW_NET)).resolves.toMatchObject({ outcome: "alerted", dm: "none" });
    expect(dmPost).not.toHaveBeenCalled();
    expect(notifyOps).toHaveBeenCalledTimes(1);
  });

  it("a failed DM still alerts ops, logged by principal id and error name only", async () => {
    vi.mocked(dmPost).mockRejectedValue(Object.assign(new Error("channel_not_found SENTINEL_TOKEN_xoxp_FAKE"), { name: "SlackApiError" }));
    arm(history(25));
    await expect(runJob(NEW_NET)).resolves.toMatchObject({ outcome: "alerted", dm: "failed" });
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith("[exec-access-alert] principal ep_1: the new-network DM failed (SlackApiError)");
    vi.mocked(openActiveInstallation).mockRejectedValue(new Error("SecretUnavailableError"));
    await expect(runJob(NEW_NET)).resolves.toMatchObject({ outcome: "alerted", dm: "failed" });
  });

  it("NA09 the 10-minute exclusion: the triggering request's own row isn't counted as seen", async () => {
    arm([...history(25), ...history(1, { ip: "203.0.113.7", created_at: new Date(AT_MS - MIN).toISOString() })]);
    await expect(runJob(NEW_NET)).resolves.toMatchObject({ outcome: "alerted", newNetwork: true, rows: 25 });
    // A row of that network from 11 minutes before counts.
    arm([...history(25), ...history(1, { ip: "203.0.113.7", created_at: new Date(AT_MS - 11 * MIN).toISOString() })]);
    await expect(runJob(NEW_NET)).resolves.toEqual({ skipped: "known", rows: 26 });
  });

  it.each([
    [{ net: "203.0.113.7", family: "chrome-mac", at: AT }],
    [{ net: "203.0.113.0/24", family: "Chrome on Mac", at: AT }],
    [{ net: "203.0.113.0/24", family: "chrome-mac", at: "yesterday" }],
    [{ family: "chrome-mac", at: AT }]
  ])("a malformed payload is refused (NonRetryableError bad_payload): %j", async (payload) => {
    arm(history(25));
    await expect(runJob(payload)).rejects.toMatchObject({ name: "NonRetryableError", message: "bad_payload" });
  });

  it("a job without a principal is refused", async () => {
    await expect(runJob(NEW_NET, null)).rejects.toMatchObject({ message: "no_principal" });
  });

  it("results, alerts and logs carry no token, IP or user agent; the network prefix only in the ops alert's detail", async () => {
    arm(history(25));
    const r = await runJob(NEW_NET);
    assertNoBriefText(r);
    assertNoBriefText(notifyOps, { label: "notifyOps" });
    expect(JSON.stringify(r)).not.toMatch(/203\.0\.113|198\.51\.100|Mozilla/);
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls)).not.toMatch(/198\.51\.100|Mozilla/);
  });
});
