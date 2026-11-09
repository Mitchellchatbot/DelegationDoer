import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
// Area B's exec-side source (M14, C46) at its module boundary.
vi.mock("@/lib/exec/brief-ownership-load", () => ({ checkinApprovalSource: vi.fn(), loadBriefOwnership: vi.fn() }));
// The producer half reads through sources/dd; each read passes through to the real one unless a test answers it.
vi.mock("@/lib/exec/sources/dd", async (orig) => {
  const actual = await orig<typeof import("@/lib/exec/sources/dd")>();
  return {
    ...actual,
    getPendingApprovals: vi.fn(actual.getPendingApprovals),
    listOpenTasks: vi.fn(),
    listUsers: vi.fn(),
    listDepartments: vi.fn(),
    listClients: vi.fn(),
    listTasksCompletedBetween: vi.fn(),
    listTaskNotificationsForUser: vi.fn(),
    listTaskExtensionsSince: vi.fn(),
    listIncidentLogsSince: vi.fn(),
    listSiteHealthAlertsSince: vi.fn(),
    listStatusChangeEntries: vi.fn(),
    listTasksByIds: vi.fn(),
    listActivitySince: vi.fn(),
    listTaskMessagesSince: vi.fn()
  };
});

import type { AttentionCandidate } from "@/lib/exec/attention-types";
import { createFakeBriefDb } from "@/lib/exec/__tests__/fake-brief-db";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { countPendingCheckins } from "@/lib/exec/brief-store";
import { checkinApprovalSource } from "@/lib/exec/brief-ownership-load";
import { produceDdAttention } from "@/lib/exec/producers/dd";
import * as dd from "@/lib/exec/sources/dd";
import type { ApprovalBucket } from "@/lib/exec/sources/dd-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { principal } from "./__tests__/brief-ui-fixtures";

// P8 contract §5.16 UI17 / UI18 (M14, C46; Area E): the approvals' check-ins bucket follows the brief's owner. While the
// assistant's brief owns today (checkinApprovalSource "exec") it counts that brief's proposed check-ins, with source "exec"
// and the brief's copy; otherwise the legacy daily brief's pending messages, with P2b's shape and copy. One fingerprint
// either way (dd:approval:checkins): switching sources changes the item's state, never its identity. A failed source read
// throws (no silent zero).

const NOW = new Date("2026-11-09T14:00:00.000Z");
const ACTUAL_PENDING = vi.mocked(dd.getPendingApprovals).getMockImplementation();

/** A PostgREST stand-in that answers every query with no rows (each P2b bucket counts zero). */
function emptyClient(): SupabaseClient {
  const answer = { data: [], error: null, count: 0, status: 200, statusText: "OK" };
  const builder: unknown = new Proxy(function () {} as unknown as object, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(answer);
      return () => builder;
    },
    apply() {
      return builder;
    }
  });
  return { from: () => builder, rpc: () => builder } as unknown as SupabaseClient;
}

const bucketsOf = (counts: Partial<Record<ApprovalBucket["mechanism"], number>>, checkins: Partial<ApprovalBucket> = {}): ApprovalBucket[] =>
  (["draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews"] as const)
    .map((m): ApprovalBucket => ({ mechanism: m, count: counts[m] ?? 0, oldestAt: null }))
    .concat([{ mechanism: "checkins", count: counts.checkins ?? 0, oldestAt: "2026-11-09T13:01:00.000Z", ...checkins }]);

beforeEach(() => {
  vi.stubEnv("EXEC_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  vi.mocked(getSupabaseAdmin).mockReturnValue(emptyClient());
  vi.mocked(checkinApprovalSource).mockReset().mockResolvedValue({ source: "exec", count: 2, oldestAt: "2026-11-09T13:01:00.000Z" });
  if (ACTUAL_PENDING) vi.mocked(dd.getPendingApprovals).mockImplementation(ACTUAL_PENDING);
  for (const fn of [
    dd.listOpenTasks, dd.listUsers, dd.listDepartments, dd.listClients, dd.listTasksCompletedBetween, dd.listTaskNotificationsForUser,
    dd.listTaskExtensionsSince, dd.listIncidentLogsSince, dd.listSiteHealthAlertsSince, dd.listStatusChangeEntries, dd.listTasksByIds,
    dd.listActivitySince, dd.listTaskMessagesSince
  ]) {
    vi.mocked(fn as (...a: unknown[]) => Promise<unknown>).mockResolvedValue([]);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("UI17 (source): the check-ins bucket follows the brief's owner", () => {
  it("verdict exec → the exec count of today's proposed check-ins, source exec", async () => {
    const buckets = await dd.getPendingApprovals(principal, NOW);
    expect(buckets.map((b) => b.mechanism)).toEqual(["draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews", "checkins"]);
    expect(buckets[5]).toEqual({ mechanism: "checkins", count: 2, oldestAt: "2026-11-09T13:01:00.000Z", source: "exec" });
    expect(checkinApprovalSource).toHaveBeenCalledWith(principal, NOW, { signal: undefined });
    expect(await dd.listPendingApprovalItems(principal, "checkins", NOW)).toEqual({ mechanism: "checkins", mode: "count_only", items: [], total: 2, truncated: false });
  });

  it("verdict legacy → the legacy count from today's daily brief, exactly P2b's shape (no source key)", async () => {
    vi.mocked(checkinApprovalSource).mockResolvedValue({ source: "legacy" });
    const buckets = await dd.getPendingApprovals(principal, NOW);
    expect(buckets[5]).toEqual({ mechanism: "checkins", count: 0, oldestAt: null });
  });

  it("EXEC_ENABLED off → legacy without asking the brief (M1 row 1)", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    const buckets = await dd.getPendingApprovals(principal, NOW);
    expect(buckets[5]).toEqual({ mechanism: "checkins", count: 0, oldestAt: null });
    expect(checkinApprovalSource).not.toHaveBeenCalled();
  });
});

describe("UI18: a failed source read throws (no silent zero)", () => {
  it("checkinApprovalSource throws → getPendingApprovals and the count-only list throw it", async () => {
    const boom = new Error("exec_briefs read failed");
    vi.mocked(checkinApprovalSource).mockRejectedValue(boom);
    await expect(dd.getPendingApprovals(principal, NOW)).rejects.toBe(boom);
    await expect(dd.listPendingApprovalItems(principal, "checkins", NOW)).rejects.toBe(boom);
  });
});

describe("UI17 (producer): the item's copy per source, one fingerprint", () => {
  const item = async (buckets: ApprovalBucket[]): Promise<AttentionCandidate> => {
    vi.mocked(dd.getPendingApprovals).mockResolvedValue(buckets);
    const all = await produceDdAttention(principal, NOW);
    const c = all.find((x) => x.fingerprint === "dd:approval:checkins");
    if (!c) throw new Error("no check-ins item");
    return c;
  };

  it("exec: the brief's title, what and next; the legacy: P2b's; the same fingerprint; the state differs", async () => {
    const exec = await item(bucketsOf({ checkins: 2 }, { source: "exec" }));
    expect(exec.title).toBe(fillBrief(BRIEF_COPY.approvalsCheckins.title, { n: 2 }));
    expect(exec.whatHappened.startsWith(fillBrief(BRIEF_COPY.approvalsCheckins.what, { n: 2 }))).toBe(true);
    expect(exec.recommendedNext).toBe(BRIEF_COPY.approvalsCheckins.next);
    const legacy = await item(bucketsOf({ checkins: 2 }));
    expect(legacy.title).toBe("2 check-ins from today's brief not sent yet");
    expect(legacy.whatHappened.startsWith("2 check-in messages on today's daily brief haven't been sent.")).toBe(true);
    expect(legacy.recommendedNext).toBe("Send or rewrite them from today's daily brief in Slack.");
    expect([exec.fingerprint, legacy.fingerprint]).toEqual(["dd:approval:checkins", "dd:approval:checkins"]);
    expect(exec.stateHash).not.toBe(legacy.stateHash);
    expect([exec.kind, exec.category, legacy.kind, legacy.category]).toEqual(["pending_approval", "approval", "pending_approval", "approval"]);
  });

  it("one exec check-in reads in the singular; a count change moves the state", async () => {
    const one = await item(bucketsOf({ checkins: 1 }, { source: "exec" }));
    expect(one.title).toBe(BRIEF_COPY.approvalsCheckins.titleOne);
    expect(one.whatHappened.startsWith(BRIEF_COPY.approvalsCheckins.whatOne)).toBe(true);
    const three = await item(bucketsOf({ checkins: 3 }, { source: "exec" }));
    expect(three.stateHash).not.toBe(one.stateHash);
    vi.mocked(dd.getPendingApprovals).mockResolvedValue(bucketsOf({ checkins: 0 }, { source: "exec" }));
    expect((await produceDdAttention(principal, NOW)).some((c) => c.fingerprint === "dd:approval:checkins")).toBe(false);
  });
});
describe("UI17 (store): the exec count is the day's live proposed check-ins only (M14)", () => {
  it("sent, sending, unknown, failed and expired rows, another day's and a lapsed proposal are not pending", async () => {
    // Integrator (M42): checkinApprovalSource (mocked above) counts through brief-store's countPendingCheckins; this runs that
    // count for real over the standalone fake, so a count that took sent check-ins in would be caught here.
    const id = (n: number) => `ebc_${String(n).repeat(32).slice(0, 32)}`;
    const live = "2026-11-10T14:00:00.000Z";
    const row = (n: number, status: string, over: Record<string, unknown> = {}) => ({
      id: id(n), brief_id: `eb_${"a".repeat(32)}`, principal_id: principal.id, local_date: "2026-11-09", status, expires_at: live,
      created_at: `2026-11-09T13:0${n}:00.000Z`, ...over
    });
    const fake = createFakeBriefDb({
      now: () => NOW,
      tables: {
        exec_brief_checkins: [
          row(1, "proposed"), row(2, "proposed"), row(3, "sent"), row(4, "sending"), row(5, "unknown"), row(6, "failed"), row(7, "expired"),
          row(8, "proposed", { local_date: "2026-11-08" }), row(9, "proposed", { expires_at: "2026-11-09T13:59:00.000Z" })
        ]
      }
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(fake.client as SupabaseClient);
    expect(await countPendingCheckins(principal, "2026-11-09", NOW)).toEqual({ count: 2, oldestAt: "2026-11-09T13:01:00.000Z" });
  });
});
