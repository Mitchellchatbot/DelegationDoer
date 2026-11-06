import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/producers/dd", async () => (await import("../__tests__/ddtext-mocks")).producersDd);
vi.mock("@/lib/exec/analysis/tasks", async () => (await import("../__tests__/ddtext-mocks")).analysisTasks);

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { normalizeCandidate, syncAttention } from "@/lib/exec/attention";
import type { AttentionStatus } from "@/lib/exec/attention-types";
import { DDTEXT_ATTENTION_KINDS, type DdtextSignalRow } from "@/lib/exec/ddtext-types";
import { scorePriority } from "@/lib/exec/priority";
import {
  buildDdtextCandidates,
  ddtextFingerprint,
  ddtextStateHash,
  heldFingerprints,
  isLiveDdtextSignal,
  parseDdtextFingerprint,
  type DdtextAttentionInput
} from "@/lib/exec/producers/ddtext";
import type { DdUser } from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { createFakeAttentionDb } from "../__tests__/fake-attention-db";
import { ddTask, keyPart } from "../__tests__/ddtext-mocks";

// P5a contract §3.12.5 (test 58) and §3.12.7 (test 63).

const NOW = new Date("2026-11-05T15:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const principal = { id: "ep_1", userId: "u_mitchell", name: "Mitchell Price", timezone: "America/New_York" } as unknown as ExecPrincipal;
const SUMMARY = "SECRET-SUMMARY hosting access is missing.";

const user = (id: string, name: string): DdUser => ({ id, name, email: `${id}@x.test`, role: "worker", isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: [] });

function signal(over: Partial<DdtextSignalRow> = {}): DdtextSignalRow {
  return {
    sourceType: "comment",
    sourceId: "a_1",
    kind: "blocker",
    summary: over.kind === "mention" ? null : SUMMARY,
    confidence: over.kind === "mention" ? "deterministic" : "high",
    taskId: "t_1",
    authorUserId: "u_ann",
    sourceCreatedAt: ago(1),
    createdAt: ago(1),
    ...over
  };
}

function input(signals: DdtextSignalRow[], over: Partial<DdtextAttentionInput> = {}): DdtextAttentionInput {
  return {
    principal,
    now: NOW,
    signals,
    itemHashes: new Map(signals.map((s) => [`${s.sourceType}:${s.sourceId}`, "h".repeat(64)])),
    tasksById: new Map([
      ["t_1", ddTask({ id: "t_1", title: "Launch page", priority: "high", status: "pending", dueDate: "2026-11-10T17:00:00.000Z" })],
      ["t_2", ddTask({ id: "t_2", title: "Waiting task", status: "waiting_on_client" })],
      ["t_done", ddTask({ id: "t_done", title: "Done task", status: "done" })]
    ]),
    usersById: new Map([["u_ann", user("u_ann", "Ann")]]),
    principalActivityByTask: new Map(),
    repliesByNote: new Map(),
    liveP2bMentionTaskIds: new Set(),
    withheldTaskIds: new Set(),
    ...over
  };
}

describe("buildDdtextCandidates (test 58)", () => {
  it("fingerprints dd:ddtext:<kind>:<source_type>:<key> pass normalizeCandidate; kinds, categories and bases", () => {
    const sigs = [
      signal({ kind: "blocker" }),
      signal({ kind: "waiting", sourceId: "a_2" }),
      signal({ kind: "decision", sourceId: "a_3", sourceType: "status_comment" }),
      signal({ kind: "mention", sourceId: "a_4" }),
      signal({ kind: "blocker", sourceType: "eod_note", sourceId: "Eod Note/1", taskId: null, sourceCreatedAt: ago(1) })
    ];
    const out = buildDdtextCandidates(input(sigs));
    expect(out).toHaveLength(5);
    for (const c of out) {
      expect(() => normalizeCandidate(c)).not.toThrow();
      expect(c.source).toBe("dd");
      expect(c.fingerprint.startsWith("dd:ddtext:")).toBe(true);
      expect(c.occurredAt).toBe(ago(1));
    }
    const by = new Map(out.map((c) => [c.kind, c]));
    expect(by.get("ddtext_mention")?.fingerprint).toBe("dd:ddtext:mention:comment:a_4");
    expect(out.find((c) => c.fingerprint.includes("eod_note"))?.fingerprint).toBe(`dd:ddtext:blocker:eod_note:${keyPart("Eod Note/1")}`);
    expect([...by.entries()].map(([k, c]) => [k, c.category]).sort()).toEqual([
      ["ddtext_blocker", "intervene"],
      ["ddtext_decision", "approval"],
      ["ddtext_mention", "my_action"],
      ["ddtext_waiting", "delegated"]
    ]);
    // Base + task priority (high +12); +10 for a mention; a note has no task priority.
    expect(out.find((c) => c.fingerprint === "dd:ddtext:blocker:comment:a_1")?.priority.score).toBe(72);
    expect(by.get("ddtext_waiting")?.priority.score).toBe(57);
    expect(by.get("ddtext_decision")?.priority.score).toBe(67);
    expect(by.get("ddtext_mention")?.priority.score).toBe(72);
    expect(out.find((c) => c.fingerprint.includes("eod_note"))?.priority.score).toBe(60);
    expect(parseDdtextFingerprint(ddtextFingerprint("waiting", "handoff_note", "A B"))).toEqual({ kind: "waiting", sourceType: "handoff_note", key: keyPart("A B") });
    expect(parseDdtextFingerprint("dd:mention:task:t_1")).toBeNull();
  });

  it("the AI summary appears only in one ai fact, never in the title or whatHappened (M24)", () => {
    for (const c of buildDdtextCandidates(input([signal(), signal({ kind: "decision", sourceType: "sod_note", sourceId: "s_1", taskId: null })]))) {
      expect(c.title).not.toContain("SECRET-SUMMARY");
      expect(c.whatHappened).not.toContain("SECRET-SUMMARY");
      expect(c.recommendedNext ?? "").not.toContain("SECRET-SUMMARY");
      const ai = c.facts.filter((f) => f.basis === "ai");
      expect(ai).toHaveLength(1);
      expect(ai[0].text).toBe(SUMMARY);
      expect(c.facts.filter((f) => f.text.includes("SECRET-SUMMARY"))).toHaveLength(1);
    }
    const [m] = buildDdtextCandidates(input([signal({ kind: "mention" })]));
    expect(m.facts.some((f) => f.basis === "ai")).toBe(false);
    expect(m.facts.map((f) => [f.basis, f.text])).toContainEqual(["derived", "No DD notification was sent to you for this mention"]);
  });

  it("titles: AI kinds are hedged and name whose text the model read; mentions stay factual (a-correct-11)", () => {
    const out = buildDdtextCandidates(
      input([
        signal({ kind: "blocker" }),
        signal({ kind: "waiting", sourceId: "a_2", sourceType: "handoff_note" }),
        signal({ kind: "decision", sourceId: "a_3", sourceType: "extension_reason" }),
        signal({ kind: "blocker", sourceType: "eod_note", sourceId: "e_1", taskId: null }),
        signal({ kind: "waiting", sourceType: "sod_note", sourceId: "s_1", taskId: null }),
        signal({ kind: "decision", sourceType: "eod_note", sourceId: "e_2", taskId: null }),
        signal({ kind: "mention", sourceId: "a_4", sourceType: "status_comment" })
      ])
    );
    const titles = out.map((c) => [c.kind, c.title]);
    for (const [kind, title] of titles) {
      expect(title).not.toMatch(/reported|asked for/i);
      if (kind !== "ddtext_mention") expect(title.startsWith("Possible ") || title.includes("may be waiting")).toBe(true);
    }
    expect(titles).toEqual(
      expect.arrayContaining([
        ["ddtext_blocker", `Possible blocker on "Launch page" (AI reading of Ann's comment)`],
        ["ddtext_waiting", `"Launch page" may be waiting on someone (AI reading of Ann's handoff note)`],
        ["ddtext_decision", `Possible decision request on "Launch page" (AI reading of Ann's extension reason)`],
        ["ddtext_blocker", "Possible blocker in Ann's EOD"],
        ["ddtext_waiting", "Possible wait in Ann's SOD"],
        ["ddtext_decision", "Possible decision request in Ann's EOD"],
        ["ddtext_mention", `Ann mentioned you on "Launch page"`]
      ])
    );
    const mention = out.find((c) => c.kind === "ddtext_mention");
    expect(mention?.whatHappened).toContain(`Ann wrote "@Mitchell Price" in a status note on`);
    expect(mention?.whatHappened).toContain("DD didn't notify you");
    const task = out.find((c) => c.fingerprint === "dd:ddtext:blocker:comment:a_1");
    expect(task?.facts.map((f) => [f.basis, f.text])).toContainEqual(["record", "Task is pending, due Nov 10"]);
    expect(task?.recommendedNext).toBe("Open the task and check whether Ann still needs help.");
  });

  it("liveness: task closed, >14 days, waiting on client, answered by his later activity, live P2b mention, withheld; notes >3 days or replied", () => {
    const live = (s: DdtextSignalRow, over: Partial<DdtextAttentionInput> = {}) => isLiveDdtextSignal(s, input([s], over));
    expect(live(signal())).toBe(true);
    expect(live(signal({ taskId: "t_done" }))).toBe(false);
    expect(live(signal({ taskId: "t_missing" }))).toBe(false);
    expect(live(signal({ sourceCreatedAt: ago(15) }))).toBe(false);
    expect(live(signal({ sourceCreatedAt: ago(13.9) }))).toBe(true);
    expect(live(signal({ kind: "waiting", taskId: "t_2" }))).toBe(false);
    expect(live(signal({ kind: "blocker", taskId: "t_2" }))).toBe(true);
    const acted = new Map([["t_1", NOW.getTime() - DAY / 2]]);
    expect(live(signal({ kind: "decision" }), { principalActivityByTask: acted })).toBe(false);
    expect(live(signal({ kind: "mention" }), { principalActivityByTask: acted })).toBe(false);
    expect(live(signal({ kind: "blocker" }), { principalActivityByTask: acted })).toBe(true);
    expect(live(signal({ kind: "decision" }), { principalActivityByTask: new Map([["t_1", NOW.getTime() - 2 * DAY]]) })).toBe(true);
    expect(live(signal({ kind: "mention" }), { liveP2bMentionTaskIds: new Set(["t_1"]) })).toBe(false);
    expect(live(signal({ kind: "blocker" }), { withheldTaskIds: new Set(["t_1"]) })).toBe(false);
    const note = signal({ sourceType: "eod_note", sourceId: "e_1", taskId: null, kind: "decision" });
    expect(live(note)).toBe(true);
    expect(live({ ...note, sourceCreatedAt: ago(4) })).toBe(false);
    expect(live(note, { repliesByNote: new Map([["e_1", NOW.getTime() - DAY / 4]]) })).toBe(false);
    expect(live(note, { repliesByNote: new Map([["e_1", NOW.getTime() - 3 * DAY]]) })).toBe(true);
    expect(buildDdtextCandidates(input([signal({ taskId: "t_done" })]))).toEqual([]);
  });

  it("the state hash ignores the task's status and moves with the source's content hash (M28)", () => {
    const pending = buildDdtextCandidates(input([signal()]))[0];
    const moved = buildDdtextCandidates(
      input([signal()], { tasksById: new Map([["t_1", ddTask({ id: "t_1", title: "Launch page", priority: "high", status: "in_progress" })]]) })
    )[0];
    expect(moved.stateHash).toBe(pending.stateHash);
    expect(pending.stateHash).toBe(ddtextStateHash("blocker", "comment", "a_1", "h".repeat(64)));
    expect(buildDdtextCandidates(input([signal()]))[0]).toEqual(pending);
    const resubmitted = buildDdtextCandidates(input([signal()], { itemHashes: new Map([["comment:a_1", "z".repeat(64)]]) }))[0];
    expect(resubmitted.stateHash).not.toBe(pending.stateHash);
  });
});

describe("through syncAttention on the fake attention DB (test 58, a-correct-10)", () => {
  let db: ReturnType<typeof createFakeAttentionDb>;
  beforeEach(() => {
    db = createFakeAttentionDb({ now: () => NOW.toISOString() });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  const scope = { source: "dd" as const, kinds: DDTEXT_ATTENTION_KINDS };
  const ownerResolve = () => {
    db.rows = db.rows.map((r) => ({ ...r, status: "resolved", resolution: "owner", resolved_at: NOW.toISOString() }));
  };

  it("an owner-resolved blocker stays resolved when its task moves on; only its Task fact updates", async () => {
    await syncAttention(principal, scope, buildDdtextCandidates(input([signal()])), NOW);
    ownerResolve();
    const inProgress = input([signal()], { tasksById: new Map([["t_1", ddTask({ id: "t_1", title: "Launch page", priority: "high", status: "in_progress", dueDate: "2026-11-10T17:00:00.000Z" })]]) });
    const r = await syncAttention(principal, scope, buildDdtextCandidates(inProgress), NOW);
    expect(r).toMatchObject({ reopened: 0, updated: 1 });
    const [row] = db.read();
    expect(row.status).toBe("resolved");
    expect((row.facts as { text: string }[]).map((f) => f.text)).toContain("Task is in progress, due Nov 10");
  });

  it("a status move there and back keeps his seen / dismiss / snooze on a row whose signal fails only a status check (data-1)", async () => {
    const task = (status: "pending" | "waiting_on_client" | "done") =>
      new Map([["t_1", ddTask({ id: "t_1", title: "Launch page", priority: "high", status, dueDate: "2026-11-10T17:00:00.000Z" })]]);
    const statusOf = () => new Map(db.read().map((r) => [r.fingerprint as string, r.status as AttentionStatus]));
    const runWith = async (signals: DdtextSignalRow[], over: Partial<DdtextAttentionInput>) => {
      const base = input(signals, over);
      return syncAttention(principal, scope, buildDdtextCandidates({ ...base, ownerStatusByFingerprint: statusOf() }), NOW);
    };
    const wait = signal({ kind: "waiting", sourceId: "a_w" });
    const mention = signal({ kind: "mention", sourceId: "a_m" });
    const blocker = signal({ kind: "blocker", sourceId: "a_b" });
    const all = [wait, mention, blocker];
    const fp = (s: DdtextSignalRow) => ddtextFingerprint(s.kind, s.sourceType, s.sourceId);
    for (const [setTo, waitKept, mentionKept, closedKept] of [
      ["seen", true, false, false],
      ["dismissed", true, true, true],
      ["snoozed", true, true, false],
      ["open", false, false, false]
    ] as const) {
      db.rows = [];
      await runWith(all, { tasksById: task("pending") });
      db.rows = db.rows.map((r) => ({ ...r, status: setTo, snooze_until: setTo === "snoozed" ? new Date(NOW.getTime() + 7 * DAY).toISOString() : null }));
      // The wait is covered while the task waits on the client; the mention while P2b's own mention row is live.
      expect(heldFingerprints(input(all, { tasksById: task("waiting_on_client"), liveP2bMentionTaskIds: new Set(["t_1"]) }))).toEqual([fp(mention), fp(wait)].sort());
      await runWith(all, { tasksById: task("waiting_on_client"), liveP2bMentionTaskIds: new Set(["t_1"]) });
      expect(statusOf().get(fp(wait)), `${setTo}: wait while waiting on the client`).toBe(waitKept ? setTo : "resolved");
      expect(statusOf().get(fp(mention)), `${setTo}: mention while P2b's is live`).toBe(mentionKept ? setTo : "resolved");
      // Back to pending: a held row is where he put it; one that wasn't held reopens (P2b's rule, unchanged).
      await runWith(all, { tasksById: task("pending") });
      expect(statusOf().get(fp(wait)), `${setTo}: wait after the move back`).toBe(waitKept ? setTo : "open");
      expect(statusOf().get(fp(mention)), `${setTo}: mention after the move back`).toBe(mentionKept ? setTo : "open");
      // The same round trip through a closed task.
      db.rows = db.rows.map((r) => ({ ...r, status: setTo, snooze_until: setTo === "snoozed" ? new Date(NOW.getTime() + 7 * DAY).toISOString() : null }));
      await runWith(all, { tasksById: task("done") });
      expect(statusOf().get(fp(blocker)), `${setTo}: blocker on a closed task`).toBe(closedKept ? setTo : "resolved");
      await runWith(all, { tasksById: task("pending") });
      expect(statusOf().get(fp(blocker)), `${setTo}: blocker after the task reopened`).toBe(closedKept ? setTo : "open");
    }
    // No row, or an owner-resolved one, is never held: nothing to keep.
    expect(buildDdtextCandidates(input([wait], { tasksById: task("waiting_on_client") }))).toEqual([]);
    expect(
      buildDdtextCandidates({ ...input([wait], { tasksById: task("waiting_on_client") }), ownerStatusByFingerprint: new Map([[fp(wait), "resolved" as AttentionStatus]]) })
    ).toEqual([]);
  });

  it("a resubmitted note with new blocker text changes the hash and reopens it", async () => {
    const note = signal({ sourceType: "eod_note", sourceId: "e_1", taskId: null });
    await syncAttention(principal, scope, buildDdtextCandidates(input([note])), NOW);
    ownerResolve();
    const r = await syncAttention(principal, scope, buildDdtextCandidates(input([note], { itemHashes: new Map([["eod_note:e_1", "n".repeat(64)]]) })), NOW);
    expect(r.reopened).toBe(1);
    expect(db.read()[0].status).toBe("open");
  });
});

describe("priority for the ddtext kinds (test 63)", () => {
  it("scores base + task priority (+10 for a mention); no age points; old kinds unchanged", () => {
    expect(scorePriority({ kind: "ddtext_blocker" })).toEqual({ score: 60, band: "high", reasons: ["Blocker in DD text (AI-assessed) (base 60)"] });
    expect(scorePriority({ kind: "ddtext_waiting", taskPriority: "critical" })).toEqual({
      score: 70,
      band: "high",
      reasons: ["Waiting in DD text (AI-assessed) (base 45)", "Critical task priority (+25)"]
    });
    expect(scorePriority({ kind: "ddtext_decision", taskPriority: "low" }).score).toBe(50);
    expect(scorePriority({ kind: "ddtext_mention", taskPriority: "high", aboutPrincipal: true })).toEqual({
      score: 72,
      band: "high",
      reasons: ["Mention of you in a comment (base 50)", "High task priority (+12)", "Involves you (+10)"]
    });
    expect(scorePriority({ kind: "ddtext_blocker", ageDays: 30 }).score).toBe(60);
    expect(scorePriority({ kind: "ddtext_mention", ageDays: 30 }).score).toBe(50);
    expect(scorePriority({ kind: "unanswered_mention", ageDays: 3 }).score).toBe(46);
    expect(scorePriority({ kind: "open_incident" }).score).toBe(45);
    expect(scorePriority({ kind: "client_escalation" }).score).toBe(45);
  });
});
