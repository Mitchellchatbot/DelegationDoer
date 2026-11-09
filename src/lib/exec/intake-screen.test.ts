import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/sources/dd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/dd")>();
  return { ...actual, listTaskThreadLinks: vi.fn(), listPendingApprovalItems: vi.fn() };
});
vi.mock("@/lib/exec/email-store", () => ({ listThreadScreenRows: vi.fn() }));
vi.mock("@/lib/exec/sources/mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/mail")>();
  return { ...actual, loadScreeningPolicy: vi.fn() };
});

import { listThreadScreenRows } from "@/lib/exec/email-store";
import { listScreenedApprovalItems, loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import { principalFromRows } from "@/lib/exec/principal";
import { DdReadError, listPendingApprovalItems, listTaskThreadLinks } from "@/lib/exec/sources/dd";
import type { ApprovalItem, ApprovalItemList, DdTaskThreadLink } from "@/lib/exec/sources/dd-types";
import { loadScreeningPolicy, screenHashesFor } from "@/lib/exec/sources/mail";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// P5a contract §3.8.1, tests 47 (screened approval items) and 47b
// (restrictedIntakeTaskIds, C25): one verdict on whether a task's DD text or
// a mail-derived title may go anywhere. Ids and enum reasons only.

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const NOW = new Date("2026-11-04T17:00:00.000Z");
const ADDRESS = "payroll@deel.com";
const rule = (id: string, pattern: string, matchKind: "domain" | "exact"): RestrictedSenderRule => ({
  id,
  pattern,
  matchKind,
  label: id,
  viewerUserIds: new Set()
});
const POLICY = { rules: [rule("r_deel", "deel.com", "domain")], hash: "H1" };

const link = (taskId: string, threadIds: string[], clientEmail: string | null = null): DdTaskThreadLink => ({ taskId, threadIds, clientEmail });

function storeRow(threadId: string, from: string, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow {
  return {
    threadId,
    accountId: "acc_1",
    state: "triaged",
    screenHashes: screenHashesFor({ all: [{ from, to: ["mitchell@scaledai.org"], cc: [] }], participants: [] }).hashes,
    screenTruncated: false,
    screenedPolicyHash: "H1",
    ...over
  } as ThreadScreenRow;
}

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(listTaskThreadLinks).mockResolvedValue([]);
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [...POLICY.rules], hash: POLICY.hash });
});
afterEach(() => {
  // Ids and enums only: no address in any log line.
  for (const line of logs) expect(line).not.toContain("deel");
});

describe("restrictedIntakeTaskIds (test 47b, C25)", () => {
  it("withholds an old intake task whose recorded sender is restricted, with P3's email schema absent", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_old", ["th_old"], ADDRESS)]);
    // No P3 table: the store reads as empty.
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
    const out = await restrictedIntakeTaskIds(principal, ["t_old", "t_clean"], POLICY);
    expect([...out]).toEqual([["t_old", "restricted_sender"]]);
  });

  it("withholds an untagged 'Create task from thread' task whose thread is tombstoned in his store", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_manual", ["th_1"], "someone@client.com")]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([["th_1", storeRow("th_1", "someone@client.com", { state: "restricted_hidden" })]]));
    expect([...(await restrictedIntakeTaskIds(principal, ["t_manual"], POLICY))]).toEqual([["t_manual", "restricted_thread"]]);
  });

  it("screens a task linked only through email_intake_log the same way (a stored rule match)", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_log", ["th_log"])]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([["th_log", storeRow("th_log", `Payroll <${ADDRESS}>`)]]));
    expect([...(await restrictedIntakeTaskIds(principal, ["t_log"], POLICY))]).toEqual([["t_log", "restricted_thread"]]);
    expect(listThreadScreenRows).toHaveBeenCalledWith(principal, ["th_log"], expect.objectContaining({}));
  });

  it("gives no verdict for a thread outside his store with a clean sender (the documented gap)", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_team", ["th_team"], "client@acme.com")]);
    expect((await restrictedIntakeTaskIds(principal, ["t_team"], POLICY)).size).toBe(0);
  });

  it("reports a gone row as thread_gone, and a clean stored row as nothing", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_gone", ["th_g"]), link("t_ok", ["th_ok"])]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(
      new Map([
        ["th_g", storeRow("th_g", "client@acme.com", { state: "gone" })],
        ["th_ok", storeRow("th_ok", "client@acme.com")]
      ])
    );
    expect([...(await restrictedIntakeTaskIds(principal, ["t_gone", "t_ok"], POLICY))]).toEqual([["t_gone", "thread_gone"]]);
  });

  it("withholds every linked task as unscreened when the rules can't be read, and passes unlinked ones", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_a", ["th_a"]), link("t_b", [], "x@y.com")]);
    const out = await restrictedIntakeTaskIds(principal, ["t_a", "t_b", "t_plain"], null);
    expect([...out]).toEqual([
      ["t_a", "unscreened"],
      ["t_b", "unscreened"]
    ]);
    expect(listThreadScreenRows).not.toHaveBeenCalled();
  });

  it("withholds every requested task as unscreened when the links can't be read", async () => {
    vi.mocked(listTaskThreadLinks).mockRejectedValue(new DdReadError("email_intake_log", `boom near ${ADDRESS}`));
    const out = await restrictedIntakeTaskIds(principal, ["t_a", "t_b"], POLICY);
    expect([...out]).toEqual([
      ["t_a", "unscreened"],
      ["t_b", "unscreened"]
    ]);
    expect(logs.join("\n")).toContain("dd_read:email_intake_log");
  });

  it("withholds the thread-linked tasks as unscreened when the store rows can't be read, keeping a sender verdict", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_th", ["th_1"]), link("t_both", ["th_2"], ADDRESS), link("t_mail", [], "c@acme.com")]);
    vi.mocked(listThreadScreenRows).mockRejectedValue(new Error(`exec email store failed for ${ADDRESS}`));
    const out = await restrictedIntakeTaskIds(principal, ["t_th", "t_both", "t_mail"], POLICY);
    expect([...out].sort()).toEqual([
      ["t_both", "restricted_sender"],
      ["t_th", "unscreened"]
    ]);
  });

  it("reports the strongest reason when several apply", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([
      link("t_all", ["th_tomb", "th_gone"], ADDRESS),
      link("t_two", ["th_tomb", "th_gone"]),
      link("t_gone", ["th_gone", "th_none"])
    ]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(
      new Map([
        ["th_tomb", storeRow("th_tomb", "a@acme.com", { state: "restricted_hidden" })],
        ["th_gone", storeRow("th_gone", "a@acme.com", { state: "gone" })]
      ])
    );
    const out = await restrictedIntakeTaskIds(principal, ["t_all", "t_two", "t_gone"], POLICY);
    expect(Object.fromEntries(out)).toEqual({ t_all: "restricted_sender", t_two: "restricted_thread", t_gone: "thread_gone" });
  });

  it("holds ids and enums only, reads nothing for no tasks, and throws on an aborted signal", async () => {
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_old", [], ADDRESS)]);
    const out = await restrictedIntakeTaskIds(principal, ["t_old"], POLICY);
    expect(JSON.stringify([...out])).not.toContain("deel");
    expect((await restrictedIntakeTaskIds(principal, [], POLICY)).size).toBe(0);

    const controller = new AbortController();
    controller.abort(new Error("aborted"));
    vi.mocked(listTaskThreadLinks).mockRejectedValue(new Error("aborted read"));
    await expect(restrictedIntakeTaskIds(principal, ["t_x"], POLICY, { signal: controller.signal })).rejects.toThrow("aborted");
  });
});

describe("loadIntakeScreeningPolicy", () => {
  it("returns P3's policy, or null (logged without detail) when the rules can't be read", async () => {
    expect(await loadIntakeScreeningPolicy(principal)).toEqual({ rules: POLICY.rules, hash: "H1" });
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error(`restricted_senders read failed: ${ADDRESS}`));
    expect(await loadIntakeScreeningPolicy(principal)).toBeNull();
    expect(logs.join("\n")).toContain("ep_1");
  });
});

describe("listScreenedApprovalItems (test 47, a-correct-2)", () => {
  const item = (id: string, mechanism: ApprovalItem["mechanism"], taskId: string | null): ApprovalItem => ({
    mechanism,
    id,
    title: `Item ${id}`,
    requesterId: "u_2",
    waitingSince: "2026-11-01T00:00:00.000Z",
    waitingSinceIsLowerBound: false,
    approver: { kind: "leaders_or_any_department_head" },
    taskId,
    clientName: null,
    departmentId: null
  });
  const list = (mechanism: ApprovalItem["mechanism"], items: ApprovalItem[], total = items.length): ApprovalItemList => ({
    mechanism,
    mode: "items",
    items,
    total,
    truncated: total > items.length
  });

  it("leaves a draft task from restricted mail out of items, counts it, and keeps the total", async () => {
    vi.mocked(listPendingApprovalItems).mockResolvedValue(list("draft_tasks", [item("t_1", "draft_tasks", "t_1"), item("t_2", "draft_tasks", "t_2")], 5));
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("t_1", [], ADDRESS)]);
    const out = await listScreenedApprovalItems(principal, "draft_tasks", NOW, { limit: 2 });
    expect(out.items.map((i) => i.id)).toEqual(["t_2"]);
    expect(out).toMatchObject({ total: 5, hiddenRestricted: 1, truncated: true, mode: "items" });
    expect(listPendingApprovalItems).toHaveBeenCalledWith(principal, "draft_tasks", NOW, { limit: 2 });
  });

  it("hides every mail-linked draft-task and FB-proof item during a rules outage", async () => {
    vi.mocked(loadScreeningPolicy).mockRejectedValue(new Error("rules down"));
    vi.mocked(listPendingApprovalItems).mockResolvedValue(list("fb_proofs", [item("p_1", "fb_proofs", "p_1"), item("p_2", "fb_proofs", "p_2")]));
    vi.mocked(listTaskThreadLinks).mockResolvedValue([link("p_1", ["th_9"])]);
    const out = await listScreenedApprovalItems(principal, "fb_proofs", NOW);
    expect(out.items.map((i) => i.id)).toEqual(["p_2"]);
    expect(out.hiddenRestricted).toBe(1);
  });

  it("passes the other mechanisms through without screening", async () => {
    for (const mechanism of ["email_drafts", "unrouted_mail", "eod_reviews"] as const) {
      vi.mocked(listPendingApprovalItems).mockResolvedValue(list(mechanism, [item("x", mechanism, null)]));
      expect(await listScreenedApprovalItems(principal, mechanism, NOW)).toMatchObject({ hiddenRestricted: 0, items: [{ id: "x" }] });
    }
    vi.mocked(listPendingApprovalItems).mockResolvedValue({ mechanism: "checkins", mode: "count_only", items: [], total: 3, truncated: false });
    expect(await listScreenedApprovalItems(principal, "checkins", NOW)).toEqual({
      mechanism: "checkins",
      mode: "count_only",
      items: [],
      total: 3,
      truncated: false,
      hiddenRestricted: 0
    });
    expect(listTaskThreadLinks).not.toHaveBeenCalled();
    expect(loadScreeningPolicy).not.toHaveBeenCalled();
  });
});
