import { beforeEach, describe, expect, it, vi } from "vitest";

// The DD producer over a mocked sources/dd.ts: fixtures for every rule, the
// reads it makes (windows, signal, fail closed), and the identity of what it
// produces (fingerprints and state hashes stable across runs).

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/sources/dd")>();
  return {
    ...actual,
    getPendingApprovals: vi.fn(),
    listActivitySince: vi.fn(),
    listClients: vi.fn(),
    listDepartments: vi.fn(),
    listIncidentLogsSince: vi.fn(),
    listOpenTasks: vi.fn(),
    listSiteHealthAlertsSince: vi.fn(),
    listStatusChangeEntries: vi.fn(),
    listTaskExtensionsSince: vi.fn(),
    listTaskMessagesSince: vi.fn(),
    listTaskNotificationsForUser: vi.fn(),
    listTasksByIds: vi.fn(),
    listTasksCompletedBetween: vi.fn(),
    listUsers: vi.fn()
  };
});

import { normalizeCandidate, reconcile } from "@/lib/exec/attention";
import type { AttentionCandidate } from "@/lib/exec/attention-types";
import { principalFromRows } from "@/lib/exec/principal";
import { scorePriority } from "@/lib/exec/priority";
import { DD_ATTENTION_KINDS, produceDdAttention } from "@/lib/exec/producers/dd";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import * as dd from "@/lib/exec/sources/dd";
import type {
  ApprovalBucket,
  ApprovalMechanism,
  DdActivity,
  DdClient,
  DdDepartment,
  DdIncidentLog,
  DdSiteHealthAlert,
  DdTask,
  DdTaskExtension,
  DdTaskNotification,
  DdUser
} from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";

const NOW = new Date("2026-11-04T17:00:00.000Z"); // 12:00 EST
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * HOUR).toISOString();

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

function user(id: string, name: string): DdUser {
  return { id, name, email: `${id}@scaledai.org`, role: "worker", isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: [] };
}

const USERS: DdUser[] = [
  { ...user("u_owner", "Mitchell"), role: "leader" },
  user("u_sam", "Sam Lee"),
  user("u_ana", "Ana Ruiz"),
  user("u_bob", "Bob Ng"),
  user("u_dana", "Dana Kim")
];

const DEPARTMENTS: DdDepartment[] = [
  { id: "dep_seo", name: "SEO", headUserId: "u_dana" },
  { id: "dep_web", name: "Website", headUserId: null },
  { id: "dep_mkt", name: "Marketing", headUserId: "u_owner" }
];

function client(id: string, name: string): DdClient {
  return {
    id,
    name,
    status: "active",
    healthScore: null,
    healthLabel: null,
    healthSampleSize: null,
    healthComputedAt: null,
    healthOverrideLabel: null,
    healthOverrideBy: null,
    healthOverrideAt: null,
    touchpointOverrideLabel: null,
    touchpointOverrideBy: null,
    touchpointOverrideAt: null,
    lastOutboundEmailAtExternal: null,
    touchpointSyncedAt: null
  };
}

const CLIENTS: DdClient[] = [client("cl_acme", "Acme")];

function task(id: string, over: Partial<DdTask> = {}): DdTask {
  return {
    id,
    title: `Task ${id}`,
    status: "in_progress",
    priority: "medium",
    tags: [],
    departmentId: null,
    assigneeId: null,
    creatorId: "u_owner",
    projectId: null,
    stageId: null,
    clientName: null,
    dueDate: null,
    createdAt: ago(30),
    completedAt: null,
    lastActivityAt: ago(1),
    archivedAt: null,
    archivedBy: null,
    isDraft: false,
    deletedAt: null,
    estimatedHours: 2,
    ...over
  };
}

const MECHANISMS: ApprovalMechanism[] = ["draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews", "checkins"];

function approvals(counts: Partial<Record<ApprovalMechanism, [number, string | null]>> = {}): ApprovalBucket[] {
  return MECHANISMS.map((mechanism) => {
    const [count, oldestAt] = counts[mechanism] ?? [0, null];
    return { mechanism, count, oldestAt };
  });
}

function note(id: string, taskId: string, createdAt: string, over: Partial<DdTaskNotification> = {}): DdTaskNotification {
  return { id, userId: "u_owner", taskId, kind: "mention", actorId: "u_sam", createdAt, ...over };
}

function alert(id: string, createdAt: string, over: Partial<DdSiteHealthAlert> = {}): DdSiteHealthAlert {
  return {
    id,
    website: "https://www.example.com/",
    domain: "example.com",
    score: 42,
    threshold: 70,
    priority: "high",
    taskId: null,
    skippedReason: null,
    createdAt,
    ...over
  };
}

function extension(id: string, taskId: string, userId: string, createdAt: string, over: Partial<DdTaskExtension> = {}): DdTaskExtension {
  return { id, taskId, userId, previousDueDate: ago(20), newDueDate: ago(-5), createdAt, ...over };
}

function incidentLog(id: string, createdAt: string, over: Partial<DdIncidentLog> = {}): DdIncidentLog {
  return { id, issueType: "site down", affectedUrl: "https://www.acme.com/contact/", createdAt, ...over };
}

const url = (path: string) => `https://operations.scaledai.org${path}`;
const taskUrl = (id: string) => url(`/tasks/${id}`);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  vi.mocked(dd.listOpenTasks).mockResolvedValue([]);
  vi.mocked(dd.listUsers).mockResolvedValue(USERS);
  vi.mocked(dd.listDepartments).mockResolvedValue(DEPARTMENTS);
  vi.mocked(dd.listClients).mockResolvedValue(CLIENTS);
  vi.mocked(dd.getPendingApprovals).mockResolvedValue(approvals());
  vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([]);
  vi.mocked(dd.listTaskNotificationsForUser).mockResolvedValue([]);
  vi.mocked(dd.listTaskExtensionsSince).mockResolvedValue([]);
  vi.mocked(dd.listIncidentLogsSince).mockResolvedValue([]);
  vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([]);
  vi.mocked(dd.listStatusChangeEntries).mockResolvedValue([]);
  vi.mocked(dd.listTasksByIds).mockResolvedValue([]);
  vi.mocked(dd.listActivitySince).mockResolvedValue([]);
  vi.mocked(dd.listTaskMessagesSince).mockResolvedValue([]);
});

// ICU builds before 74 put a narrow no-break space before AM/PM. attention.ts
// stores it as a plain space (clipExcerpt), so compare in that form.
const NNBSP = new RegExp(String.fromCharCode(0x202f), "g");
const plainSpaces = (all: AttentionCandidate[]): AttentionCandidate[] => JSON.parse(JSON.stringify(all).replace(NNBSP, " "));

const run = (now: Date = NOW) => produceDdAttention(principal, now).then(plainSpaces);

async function kind(k: string, now: Date = NOW): Promise<Map<string, AttentionCandidate>> {
  const all = await run(now);
  return new Map(all.filter((c) => c.kind === k).map((c) => [c.fingerprint, c]));
}

function get(map: Map<string, AttentionCandidate>, fingerprint: string): AttentionCandidate {
  const c = map.get(fingerprint);
  if (!c) throw new Error(`no candidate ${fingerprint}; have ${[...map.keys()].join(", ")}`);
  return c;
}

// ---------------------------------------------------------------------------
// A fixture with every rule firing, for the checks that span all of them.
// ---------------------------------------------------------------------------

function seedEverything(): void {
  vi.mocked(dd.listOpenTasks).mockResolvedValue([
    task("t_s1", { assigneeId: "u_sam", dueDate: ago(10), priority: "high", clientName: "Acme", lastActivityAt: ago(8) }),
    task("t_s2", { assigneeId: "u_sam", dueDate: ago(2) }),
    task("t_crit", { assigneeId: "u_ana", dueDate: ago(3), priority: "critical" }),
    task("t_pool", { departmentId: "dep_seo", tags: ["auto-team"], dueDate: ago(4) }),
    task("t_orphan", { dueDate: ago(20), archivedAt: ago(9) }),
    task("t_i1", { assigneeId: "u_ana", lastActivityAt: ago(9) }),
    task("t_i2", { assigneeId: "u_ana", lastActivityAt: ago(12) }),
    task("t_w1", { status: "waiting_on_client", clientName: "Acme", assigneeId: "u_sam", lastActivityAt: ago(9) }),
    task("t_inc_1", { tags: ["urgent", "incident"], priority: "critical", status: "urgent", createdAt: ago(1), dueDate: ago(1) }),
    task("t_site", { assigneeId: "u_bob", tags: ["site-health-alert"], dueDate: ago(-1) }),
    task("t_ext", { assigneeId: "u_sam", dueDate: ago(-3) })
  ]);
  vi.mocked(dd.getPendingApprovals).mockResolvedValue(approvals({ draft_tasks: [4, ago(3)], checkins: [1, ago(0, 4)] }));
  vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([
    task("t_l1", { status: "done", assigneeId: "u_bob", dueDate: ago(4), completedAt: ago(3) }),
    task("t_l2", { status: "done", assigneeId: "u_bob", dueDate: ago(6), completedAt: ago(1) })
  ]);
  vi.mocked(dd.listTaskNotificationsForUser).mockResolvedValue([note("n_1", "t_m1", ago(2))]);
  vi.mocked(dd.listTaskExtensionsSince).mockResolvedValue([
    extension("ext_1", "t_ext", "u_sam", ago(20)),
    extension("ext_2", "t_ext", "u_sam", ago(10)),
    extension("ext_3", "t_other", "u_sam", ago(5))
  ]);
  vi.mocked(dd.listIncidentLogsSince).mockResolvedValue([incidentLog("i_1", ago(20)), incidentLog("i_2", ago(10)), incidentLog("i_3", ago(2))]);
  vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([
    alert("a_1", ago(25)),
    alert("a_2", ago(12)),
    alert("a_3", ago(0, 6), { taskId: "t_site" })
  ]);
  vi.mocked(dd.listTasksByIds).mockResolvedValue([
    task("t_m1", { title: "Pricing page", assigneeId: "u_sam" }),
    task("t_ext", { assigneeId: "u_sam", dueDate: ago(-3) }),
    task("t_other", { assigneeId: "u_sam", status: "done", completedAt: ago(1) })
  ]);
}

// ---------------------------------------------------------------------------

describe("DD_ATTENTION_KINDS", () => {
  it("lists every DD kind once, frozen, and each one scores", () => {
    expect(DD_ATTENTION_KINDS).toEqual([
      "overdue_tasks",
      "missed_deadlines",
      "stalled_tasks",
      "pending_approval",
      "waiting_on_client",
      "open_incident",
      "site_alert",
      "unanswered_mention",
      "recurring_issue"
    ]);
    expect(Object.isFrozen(DD_ATTENTION_KINDS)).toBe(true);
    for (const k of DD_ATTENTION_KINDS) expect(() => scorePriority({ kind: k })).not.toThrow();
  });
});

describe("the candidates as a batch", () => {
  it("covers every kind, all from DD, in stored form and accepted by reconcile", async () => {
    seedEverything();
    const all = await run();
    expect(new Set(all.map((c) => c.kind))).toEqual(new Set(DD_ATTENTION_KINDS));
    expect(new Set(all.map((c) => c.fingerprint)).size).toBe(all.length);
    for (const c of all) {
      expect(c.source).toBe("dd");
      expect(c.fingerprint.startsWith("dd:")).toBe(true);
      expect(c.stateHash).toMatch(/^[0-9a-f]{16}$/);
      expect(c.recommendedNext).toEqual(expect.any(String));
      // Already what attention.ts stores: nothing clipped, dropped or rewritten.
      expect(normalizeCandidate(c)).toEqual(c);
      for (const f of c.facts) {
        expect(["record", "derived"]).toContain(f.basis);
        for (const ref of f.refs) expect(ref.url === null || isAllowedLinkUrl(ref.url)).toBe(true);
      }
      for (const ref of c.refs) {
        expect(ref).toMatchObject({ system: "dd", class: "internal" });
        expect(ref.url === null || isAllowedLinkUrl(ref.url)).toBe(true);
      }
    }
    const plan = reconcile([], all, { source: "dd", kinds: DD_ATTENTION_KINDS }, NOW);
    expect(plan.inserts).toHaveLength(all.length);
  });

  it("comes out in kind order, the same on every run", async () => {
    seedEverything();
    const first = await run();
    const order = first.map((c) => DD_ATTENTION_KINDS.indexOf(c.kind as (typeof DD_ATTENTION_KINDS)[number]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    await expect(run()).resolves.toEqual(first);
  });

  it("suggests without blaming: every recommendation is an option, never a verdict on a person", async () => {
    seedEverything();
    for (const c of await run()) {
      expect(c.recommendedNext).not.toMatch(/\b(fail|failing|fault|blame|lazy|slacking|negligen|underperform|must)\b/i);
      expect(c.whyItMatters).not.toMatch(/\b(fail|failing|fault|blame|lazy|negligen|blocked by)\b/i);
    }
  });

  it("never says one thing blocks another: DD has no dependency model", async () => {
    seedEverything();
    for (const c of await run()) {
      const text = [c.title, c.whatHappened, c.whyItMatters, c.recommendedNext, ...c.facts.map((f) => f.text)].join(" ");
      expect(text).not.toMatch(/\bblock(ed|s|ing)?\b/i);
    }
  });
});

// ---------------------------------------------------------------------------

describe("reads", () => {
  it("reads through sources/dd with the principal, the windows and the signal", async () => {
    seedEverything();
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_w1", { status: "waiting_on_client", clientName: "Acme", assigneeId: "u_sam", lastActivityAt: ago(9) })
    ]);
    const signal = new AbortController().signal;
    await produceDdAttention(principal, NOW, { signal });
    const opts = { signal };

    expect(dd.listOpenTasks).toHaveBeenCalledWith(principal, opts);
    expect(dd.listUsers).toHaveBeenCalledWith(principal, opts);
    expect(dd.listDepartments).toHaveBeenCalledWith(principal, opts);
    expect(dd.listClients).toHaveBeenCalledWith(principal, opts);
    expect(dd.getPendingApprovals).toHaveBeenCalledWith(principal, NOW, opts);
    expect(dd.listTasksCompletedBetween).toHaveBeenCalledWith(principal, ago(7), NOW.toISOString(), opts);
    expect(dd.listTaskNotificationsForUser).toHaveBeenCalledWith(principal, "u_owner", ago(14), ["mention", "notified"], opts);
    expect(dd.listTaskExtensionsSince).toHaveBeenCalledWith(principal, ago(90), opts);
    expect(dd.listIncidentLogsSince).toHaveBeenCalledWith(principal, ago(90), opts);
    expect(dd.listSiteHealthAlertsSince).toHaveBeenCalledWith(principal, ago(90), opts);
    expect(dd.listStatusChangeEntries).toHaveBeenCalledWith(principal, ["t_w1"], "waiting_on_client", opts);
    // Mentioned tasks and extended tasks, in any state, in one read.
    expect(dd.listTasksByIds).toHaveBeenCalledWith(principal, ["t_m1", "t_ext", "t_other"], opts);
    // His own activity on the mentioned tasks, from the first notification on.
    expect(dd.listActivitySince).toHaveBeenCalledWith(principal, ago(2), { taskIds: ["t_m1"], userId: "u_owner" }, opts);
    expect(dd.listTaskMessagesSince).toHaveBeenCalledWith(principal, ago(2), { taskIds: ["t_m1"], userId: "u_owner" }, opts);
    // The proof actions on the late completions, from the oldest one's creation.
    expect(dd.listActivitySince).toHaveBeenCalledWith(
      principal,
      ago(30),
      { taskIds: ["t_l1", "t_l2"], actions: ["submitted_for_approval", "proof_sent_back"] },
      opts
    );
    expect(dd.listActivitySince).toHaveBeenCalledTimes(2);
  });

  it("reads only the tasks it can show: mentioned ones and those in a repeated-extension group", async () => {
    vi.mocked(dd.listTaskNotificationsForUser).mockResolvedValue([note("n_1", "t_m1", ago(2))]);
    vi.mocked(dd.listTaskExtensionsSince).mockResolvedValue([extension("ext_1", "t_once", "u_ana", ago(3))]);
    await run();
    expect(dd.listTasksByIds).toHaveBeenCalledWith(principal, ["t_m1"], expect.objectContaining({}));
  });

  it("skips the follow-up reads nothing needs", async () => {
    await expect(run()).resolves.toEqual([]);
    expect(dd.listStatusChangeEntries).not.toHaveBeenCalled();
    expect(dd.listTasksByIds).not.toHaveBeenCalled();
    expect(dd.listActivitySince).not.toHaveBeenCalled();
    expect(dd.listTaskMessagesSince).not.toHaveBeenCalled();
  });

  // syncAttention resolves whatever a sync leaves out: a partial list would
  // tell him problems had gone away.
  it.each([
    "listOpenTasks",
    "listUsers",
    "listDepartments",
    "listClients",
    "getPendingApprovals",
    "listTasksCompletedBetween",
    "listTaskNotificationsForUser",
    "listTaskExtensionsSince",
    "listIncidentLogsSince",
    "listSiteHealthAlertsSince",
    "listStatusChangeEntries",
    "listTasksByIds",
    "listActivitySince",
    "listTaskMessagesSince"
  ] as const)("fails the whole run when %s fails, with no partial list", async (name) => {
    seedEverything();
    vi.mocked(dd.listOpenTasks).mockResolvedValue([task("t_w1", { status: "waiting_on_client", lastActivityAt: ago(9) })]);
    const failure = new dd.DdReadError("x", "statement timeout");
    vi.mocked(dd[name]).mockRejectedValue(failure);
    await expect(run()).rejects.toBe(failure);
  });

  it("refuses an invalid now before reading anything", async () => {
    await expect(produceDdAttention(principal, new Date(Number.NaN))).rejects.toThrow(TypeError);
    await expect(produceDdAttention(principal, "2026-11-04" as unknown as Date)).rejects.toThrow(TypeError);
    expect(dd.listOpenTasks).not.toHaveBeenCalled();
  });

  it("stops between rounds once its signal aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    vi.mocked(dd.listClients).mockImplementation(async () => {
      controller.abort(reason);
      return CLIENTS;
    });
    await expect(produceDdAttention(principal, NOW, { signal: controller.signal })).rejects.toBe(reason);
    expect(dd.getPendingApprovals).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("overdue_tasks", () => {
  beforeEach(() => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_s1", { assigneeId: "u_sam", dueDate: ago(10), priority: "high", clientName: "Acme", lastActivityAt: ago(8), title: "Fix the homepage" }),
      task("t_s2", { assigneeId: "u_sam", dueDate: ago(2), status: "waiting_on_client", title: "Send the audit" }),
      task("t_crit", { assigneeId: "u_ana", dueDate: ago(3), priority: "critical", title: "Restore checkout" }),
      task("t_mine", { assigneeId: "u_owner", dueDate: ago(1), title: "Sign the contract" }),
      task("t_pool", { departmentId: "dep_seo", tags: ["auto-team"], dueDate: ago(4), title: "Monthly SEO report" }),
      task("t_pool_web", { departmentId: "dep_web", tags: ["auto-team"], dueDate: ago(5) }),
      task("t_pool_mkt", { departmentId: "dep_mkt", tags: ["auto-team"], dueDate: ago(5) }),
      task("t_orphan", { dueDate: ago(20), archivedAt: ago(9), archivedBy: null, title: "Old migration" }),
      task("t_inc_1", { assigneeId: "u_sam", tags: ["urgent", "incident"], priority: "critical", status: "urgent", dueDate: ago(1) }),
      task("t_later", { assigneeId: "u_sam", dueDate: ago(-2) }),
      task("t_nodue", { assigneeId: "u_sam" }),
      // Not open (sources never return these; the predicate holds anyway).
      task("t_shelved", { assigneeId: "u_sam", dueDate: ago(30), archivedAt: ago(5), archivedBy: "u_sam" }),
      task("t_draft", { assigneeId: "u_sam", dueDate: ago(30), isDraft: true })
    ]);
  });

  it("makes one item per assignee, department pool, the unowned, and each critical task", async () => {
    const items = await kind("overdue_tasks");
    expect([...items.keys()].sort()).toEqual([
      "dd:overdue:assignee:u_owner",
      "dd:overdue:assignee:u_sam",
      "dd:overdue:task:t_crit",
      "dd:overdue:team:dep_mkt",
      "dd:overdue:team:dep_seo",
      "dd:overdue:team:dep_web",
      "dd:overdue:unassigned"
    ]);
    // The critical task isn't counted again under Ana, and the incident is left to open_incident.
    expect([...items.values()].flatMap((c) => c.refs.map((r) => r.id))).not.toContain("t_inc_1");
  });

  it("groups an assignee's overdue work, most overdue first, with the facts that explain it", async () => {
    const sam = get(await kind("overdue_tasks"), "dd:overdue:assignee:u_sam");
    expect(sam).toMatchObject({
      category: "delegated",
      title: "2 overdue tasks for Sam Lee",
      whatHappened:
        '2 open tasks are past their due date. The oldest, "Fix the homepage", was due Oct 25 (10 days ago). ' +
        "They're assigned to Sam Lee.",
      recommendedNext: "Ask Sam Lee for a new date, or decide whether to reassign.",
      occurredAt: ago(10)
    });
    expect(sam.facts).toEqual([
      { text: "2 tasks past due; the oldest by 10 days.", basis: "derived", refs: [] },
      { text: "1 of them has had no activity for 7+ days.", basis: "derived", refs: [] },
      { text: "1 of them is waiting on the client.", basis: "derived", refs: [] },
      {
        text: '"Fix the homepage": due Oct 25, in progress.',
        basis: "record",
        refs: [{ system: "dd", id: "t_s1", url: taskUrl("t_s1"), label: "Fix the homepage", class: "internal" }]
      },
      {
        text: '"Send the audit": due Nov 2, waiting on the client.',
        basis: "record",
        refs: [{ system: "dd", id: "t_s2", url: taskUrl("t_s2"), label: "Send the audit", class: "internal" }]
      }
    ]);
    expect(sam.refs.map((r) => r.url)).toEqual([taskUrl("t_s1"), taskUrl("t_s2")]);
    expect(sam.priority).toEqual({
      score: 68,
      band: "high",
      reasons: ["Overdue tasks (base 25)", "Overdue 10 days (+20)", "High task priority (+12)", "Client-facing (+8)", "2 items (+3)"]
    });
  });

  it("is his own action, and about him, when the tasks are his", async () => {
    const mine = get(await kind("overdue_tasks"), "dd:overdue:assignee:u_owner");
    expect(mine).toMatchObject({
      category: "my_action",
      title: "Your task is overdue: Sign the contract",
      whatHappened: `"Sign the contract" was due Nov 3 (1 day ago) and is in progress. It's assigned to you.`,
      recommendedNext: "Set a new due date, or hand it off."
    });
    expect(mine.priority.reasons).toContain("Involves you (+10)");
  });

  it("gives each critical task its own item", async () => {
    const crit = get(await kind("overdue_tasks"), "dd:overdue:task:t_crit");
    expect(crit).toMatchObject({
      category: "delegated",
      title: "Critical task overdue: Restore checkout",
      whatHappened: `"Restore checkout" is marked critical and was due Nov 1 (3 days ago). It is in progress. It's assigned to Ana Ruiz.`,
      recommendedNext: "Check with Ana Ruiz on what it needs to finish, or reassign it.",
      refs: [expect.objectContaining({ id: "t_crit" })]
    });
    expect(crit.priority).toEqual({
      score: 56,
      band: "high",
      reasons: ["Overdue tasks (base 25)", "Critical task priority (+25)", "Overdue 3 days (+6)"]
    });
  });

  it("sends a department pool to its head, or to the team when there is no head or he is it", async () => {
    const items = await kind("overdue_tasks");
    expect(get(items, "dd:overdue:team:dep_seo")).toMatchObject({
      category: "delegated",
      title: "Overdue in the SEO team pool: Monthly SEO report",
      whatHappened: `"Monthly SEO report" was due Oct 31 (4 days ago) and is in progress. It's in the SEO team pool and nobody has claimed it.`,
      recommendedNext: "Ask Dana Kim (SEO head) to get it claimed, or assign it directly."
    });
    expect(get(items, "dd:overdue:team:dep_web").recommendedNext).toBe("Ask the Website team to claim it, or assign it directly.");
    expect(get(items, "dd:overdue:team:dep_mkt").recommendedNext).toBe("Ask the Marketing team to claim it, or assign it directly.");
  });

  it("asks him to step in on work nobody owns, auto-archived included", async () => {
    const orphan = get(await kind("overdue_tasks"), "dd:overdue:unassigned");
    expect(orphan).toMatchObject({
      category: "intervene",
      title: "Overdue with no owner: Old migration",
      recommendedNext: "Pick an owner for it, or close it if it's no longer needed."
    });
    expect(orphan.whatHappened).toContain("It has no assignee.");
    expect(orphan.facts.map((f) => f.text)).toContain("DD's overdue sweep archived it, but it isn't done.");
  });

  it("words a group of several the same way for every owner", async () => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_a", { assigneeId: "u_owner", dueDate: ago(3) }),
      task("t_b", { assigneeId: "u_owner", dueDate: ago(2) }),
      task("t_c", { departmentId: "dep_seo", tags: ["auto-team"], dueDate: ago(3) }),
      task("t_d", { departmentId: "dep_seo", tags: ["auto-team"], dueDate: ago(2), archivedAt: ago(1) }),
      task("t_e", { dueDate: ago(3) }),
      task("t_f", { dueDate: ago(2) })
    ]);
    const items = await kind("overdue_tasks");
    expect(get(items, "dd:overdue:assignee:u_owner")).toMatchObject({
      title: "You have 2 overdue tasks",
      recommendedNext: "Set new due dates, or hand some of these off."
    });
    const pool = get(items, "dd:overdue:team:dep_seo");
    expect(pool.title).toBe("2 overdue tasks in the SEO team pool");
    expect(pool.whatHappened).toContain("They're in the SEO team pool and nobody has claimed them.");
    expect(pool.recommendedNext).toBe("Ask Dana Kim (SEO head) to get them claimed, or assign them directly.");
    expect(pool.facts[1]).toEqual({ text: "1 of them was archived by DD's overdue sweep but isn't done.", basis: "derived", refs: [] });
    const none = get(items, "dd:overdue:unassigned");
    expect(none.title).toBe("2 overdue tasks with no owner");
    expect(none.whatHappened).toContain("None of them has an assignee.");
    expect(none.recommendedNext).toBe("Pick owners for these, or close the ones that are no longer needed.");
  });

  it("leaves a task waiting for its proof review to the approvals item: it's handed in, and only the reviewer can move it", async () => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_x", { assigneeId: "u_ana", dueDate: ago(2), title: "Fix the pixel" }),
      task("t_fbw", { assigneeId: "u_ana", dueDate: ago(1), status: "pending_approval" }),
      task("t_fbc", { assigneeId: "u_ana", dueDate: ago(3), status: "pending_approval", priority: "critical" })
    ]);
    const items = await kind("overdue_tasks");
    expect([...items.keys()]).toEqual(["dd:overdue:assignee:u_ana"]);
    const ana = get(items, "dd:overdue:assignee:u_ana");
    expect(ana.title).toBe("Overdue: Fix the pixel (Ana Ruiz)");
    expect(ana.refs.map((r) => r.id)).toEqual(["t_x"]);
  });

  it("keeps at most 8 task lines and 20 links on a big group", async () => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => task(`t_${String(i).padStart(2, "0")}`, { assigneeId: "u_sam", dueDate: ago(31 - i) }))
    );
    const sam = get(await kind("overdue_tasks"), "dd:overdue:assignee:u_sam");
    expect(sam.title).toBe("30 overdue tasks for Sam Lee");
    expect(sam.facts.filter((f) => f.basis === "record")).toHaveLength(8);
    expect(sam.refs).toHaveLength(20);
    expect(sam.refs[0].id).toBe("t_00");
    expect(sam.priority.reasons).toContain("30 items (+15)");
  });
});

// ---------------------------------------------------------------------------

describe("missed_deadlines", () => {
  beforeEach(() => {
    vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([
      task("t_l1", { status: "done", assigneeId: "u_sam", dueDate: ago(4), completedAt: ago(3), title: "Write the brief" }),
      task("t_l2", { status: "done", assigneeId: "u_sam", dueDate: ago(6), completedAt: ago(1), title: "Ship the update", clientName: "Acme" }),
      task("t_l3", { status: "done", assigneeId: "u_sam", dueDate: ago(1), completedAt: ago(2) }),
      task("t_l4", { status: "done", assigneeId: "u_ana", dueDate: ago(5), completedAt: ago(4) }),
      task("t_inc_2", { status: "done", assigneeId: "u_ana", tags: ["incident"], dueDate: ago(3), completedAt: ago(2) }),
      task("t_l5", { status: "done", dueDate: ago(5), completedAt: ago(4) }),
      task("t_l6", { status: "done", dueDate: ago(5), completedAt: ago(4) }),
      task("t_l7", { status: "done", assigneeId: "u_owner", dueDate: ago(5), completedAt: ago(4) }),
      task("t_l8", { status: "done", assigneeId: "u_owner", dueDate: ago(5), completedAt: ago(3) })
    ]);
  });

  it("notes two or more late finishes per assignee as an FYI", async () => {
    const items = await kind("missed_deadlines");
    // Ana's second late finish is an incident (born overdue); the unassigned ones have no one to note.
    expect([...items.keys()].sort()).toEqual(["dd:late:assignee:u_owner", "dd:late:assignee:u_sam"]);
    const sam = get(items, "dd:late:assignee:u_sam");
    expect(sam).toMatchObject({
      category: "fyi",
      title: "Sam Lee finished 2 tasks late in the last 7 days",
      whatHappened:
        'Sam Lee completed 2 tasks after their due dates in the last 7 days. The latest, "Ship the update", was due Oct 29 and done Nov 3.',
      recommendedNext: "Check in with Sam Lee on workload and whether the deadlines are realistic.",
      occurredAt: ago(1)
    });
    expect(sam.refs.map((r) => r.id)).toEqual(["t_l2", "t_l1"]);
    expect(sam.facts[0]).toEqual({ text: "2 late completions in the last 7 days.", basis: "derived", refs: [] });
    expect(sam.priority.score).toBe(8 + 3 + 8);
  });

  it("talks to him about his own", async () => {
    const mine = get(await kind("missed_deadlines"), "dd:late:assignee:u_owner");
    expect(mine.title).toBe("You finished 2 tasks late in the last 7 days");
    expect(mine.recommendedNext).toBe("Look at whether your deadlines or your workload need adjusting.");
    expect(mine.priority.reasons).toContain("Involves you (+10)");
  });

  // Approving a Facebook proof stamps completed_at with the reviewer's click,
  // so the review's time must not count as the assignee's.
  describe("a task that went through a proof review", () => {
    const proof = (id: string, taskId: string, action: string, createdAt: string): DdActivity => ({ id, taskId, userId: "u_ana", action, createdAt });
    const withProofEvents = (rows: DdActivity[]) =>
      vi.mocked(dd.listActivitySince).mockImplementation(async (_p, _since, filter) =>
        filter.actions === undefined ? [] : rows.filter((r) => filter.actions?.includes(r.action) && filter.taskIds?.includes(r.taskId))
      );

    it("is judged by when its proof was submitted, not when it was approved", async () => {
      vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([
        task("t_fb1", { status: "done", assigneeId: "u_ana", dueDate: ago(4), completedAt: ago(3) }),
        task("t_fb2", { status: "done", assigneeId: "u_ana", dueDate: ago(6), completedAt: ago(1) })
      ]);
      // Both handed in before their due dates; the reviews came after.
      withProofEvents([proof("a_1", "t_fb1", "submitted_for_approval", ago(4, 2)), proof("a_2", "t_fb2", "submitted_for_approval", ago(6, 1))]);
      expect([...(await kind("missed_deadlines")).keys()]).toEqual([]);
      // Only the proof actions of the late tasks (never detail text), from the oldest one's creation.
      expect(dd.listActivitySince).toHaveBeenCalledWith(
        principal,
        ago(30),
        { taskIds: ["t_fb1", "t_fb2"], actions: ["submitted_for_approval", "proof_sent_back"] },
        expect.objectContaining({})
      );
    });

    it("still counts one handed in after its due date, worded as the record shows", async () => {
      vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([
        task("t_fb3", { status: "done", assigneeId: "u_ana", title: "Launch the ad set", dueDate: ago(5), completedAt: ago(2) }),
        task("t_l9", { status: "done", assigneeId: "u_ana", title: "Write the copy", dueDate: ago(5), completedAt: ago(3) })
      ]);
      withProofEvents([proof("a_3", "t_fb3", "submitted_for_approval", ago(4))]);
      const ana = get(await kind("missed_deadlines"), "dd:late:assignee:u_ana");
      expect(ana).toMatchObject({
        title: "2 of Ana Ruiz's tasks were marked done after their due dates in the last 7 days",
        whatHappened:
          "2 of Ana Ruiz's tasks were marked done after their due dates in the last 7 days. " +
          "1 went through a proof review, and its proof was submitted after the due date. " +
          'The latest, "Launch the ad set", was due Oct 30; its proof was submitted Oct 31 and approved Nov 2.',
        recommendedNext: "Check in with Ana Ruiz on workload and whether the deadlines are realistic."
      });
      expect(ana.facts.map((f) => [f.text, f.basis])).toEqual([
        ["2 late completions in the last 7 days.", "derived"],
        ["A proof-reviewed task is judged by when its proof was submitted, not when it was approved.", "derived"],
        ['"Launch the ad set": due Oct 30, proof submitted Oct 31, approved Nov 2.', "record"],
        ['"Write the copy": due Oct 30, completed Nov 1.', "record"]
      ]);
    });

    it("is judged by its completion when the proof was sent back after its last submission", async () => {
      vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([
        task("t_fb4", { status: "done", assigneeId: "u_ana", dueDate: ago(5), completedAt: ago(2) }),
        task("t_l9", { status: "done", assigneeId: "u_ana", dueDate: ago(5), completedAt: ago(3) })
      ]);
      // Handed in on time, sent back after the due date, then marked done from the board.
      withProofEvents([proof("a_4", "t_fb4", "submitted_for_approval", ago(6)), proof("a_5", "t_fb4", "proof_sent_back", ago(4))]);
      const ana = get(await kind("missed_deadlines"), "dd:late:assignee:u_ana");
      expect(ana.title).toBe("Ana Ruiz finished 2 tasks late in the last 7 days");
      expect(ana.refs.map((r) => r.id)).toEqual(["t_fb4", "t_l9"]);
    });

    it("talks to him about his own in the same words", async () => {
      vi.mocked(dd.listTasksCompletedBetween).mockResolvedValue([
        task("t_fb5", { status: "done", assigneeId: "u_owner", dueDate: ago(5), completedAt: ago(2) }),
        task("t_l10", { status: "done", assigneeId: "u_owner", dueDate: ago(5), completedAt: ago(3) })
      ]);
      withProofEvents([proof("a_6", "t_fb5", "submitted_for_approval", ago(4))]);
      const mine = get(await kind("missed_deadlines"), "dd:late:assignee:u_owner");
      expect(mine.title).toBe("2 of your tasks were marked done after their due dates in the last 7 days");
    });
  });
});

// ---------------------------------------------------------------------------

describe("stalled_tasks", () => {
  beforeEach(() => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_i1", { assigneeId: "u_ana", lastActivityAt: ago(9), title: "Draft the proposal" }),
      task("t_i2", { assigneeId: "u_ana", lastActivityAt: ago(12), status: "pending", title: "Plan the launch" }),
      // Each of these has an item of its own, or is outside the rule.
      task("t_i3", { assigneeId: "u_ana", lastActivityAt: ago(10), dueDate: ago(1) }),
      task("t_i4", { assigneeId: "u_ana", lastActivityAt: ago(10), status: "waiting_on_client" }),
      task("t_i5", { assigneeId: "u_ana", lastActivityAt: ago(10), status: "pending_approval" }),
      task("t_inc_3", { assigneeId: "u_ana", lastActivityAt: ago(10), tags: ["incident"], dueDate: ago(-1) }),
      task("t_i6", { assigneeId: "u_ana", lastActivityAt: ago(5) }),
      task("t_b1", { assigneeId: "u_bob", lastActivityAt: ago(8) }),
      task("t_u1", { lastActivityAt: ago(20) }),
      task("t_u2", { lastActivityAt: ago(20) }),
      task("t_o1", { assigneeId: "u_owner", lastActivityAt: ago(8) }),
      task("t_o2", { assigneeId: "u_owner", lastActivityAt: ago(9) })
    ]);
  });

  it("flags an assignee with two or more idle live tasks, quietest first", async () => {
    const items = await kind("stalled_tasks");
    expect([...items.keys()].sort()).toEqual(["dd:stalled:assignee:u_ana", "dd:stalled:assignee:u_owner"]);
    const ana = get(items, "dd:stalled:assignee:u_ana");
    expect(ana).toMatchObject({
      category: "delegated",
      title: "Ana Ruiz has 2 tasks with no activity for 7+ days",
      whatHappened:
        'Ana Ruiz has 2 open tasks with no recorded activity in over 7 days. The quietest, "Plan the launch", was last touched Oct 23 (12 days ago).',
      recommendedNext: "Ask Ana Ruiz whether these are still on track, or decide whether to reassign or close them.",
      occurredAt: ago(12)
    });
    expect(ana.refs.map((r) => r.id)).toEqual(["t_i2", "t_i1"]);
    expect(ana.facts.map((f) => f.text)).toEqual([
      "2 tasks idle for 7+ days; the quietest for 12 days.",
      '"Plan the launch": last activity Oct 23, pending.',
      '"Draft the proposal": last activity Oct 26, in progress.'
    ]);
    expect(ana.priority.score).toBe(12 + 3);
  });

  it("makes his own idle work his action", async () => {
    const mine = get(await kind("stalled_tasks"), "dd:stalled:assignee:u_owner");
    expect(mine).toMatchObject({
      category: "my_action",
      title: "2 of your tasks have had no activity for 7+ days",
      recommendedNext: "Decide which of these to move forward, hand off or close."
    });
  });
});

// ---------------------------------------------------------------------------

describe("pending_approval", () => {
  beforeEach(() => {
    vi.mocked(dd.getPendingApprovals).mockResolvedValue(
      approvals({
        draft_tasks: [4, ago(3)],
        fb_proofs: [1, ago(0, 5)],
        unrouted_mail: [2, null],
        eod_reviews: [3, ago(2)],
        checkins: [2, ago(0, 4)]
      })
    );
  });

  it("makes one item per queue that isn't empty, linked to the page that works it", async () => {
    const items = await kind("pending_approval");
    expect([...items.keys()]).toEqual([
      "dd:approval:draft_tasks",
      "dd:approval:fb_proofs",
      "dd:approval:unrouted_mail",
      "dd:approval:eod_reviews",
      "dd:approval:checkins"
    ]);
    const links = (fp: string) => get(items, fp).refs.map((r) => [r.label, r.url]);
    expect(links("dd:approval:draft_tasks")).toEqual([
      ["Approvals: Routing", url("/approvals?tab=routing")],
      ["Approvals: Meetings", url("/approvals?tab=meetings")]
    ]);
    expect(links("dd:approval:fb_proofs")).toEqual([
      ["Task board: waiting for approval", url("/tasks/board?status=pending_approval&groupBy=status")]
    ]);
    expect(links("dd:approval:unrouted_mail")).toEqual([["Approvals: Routing", url("/approvals?tab=routing")]]);
    expect(links("dd:approval:eod_reviews")).toEqual([["EOD history", url("/eod/history")]]);
    // Check-ins are sent from the brief in Slack; DD has no page for them.
    expect(links("dd:approval:checkins")).toEqual([]);
    for (const c of items.values()) expect(c.category).toBe("approval");
  });

  it("links email drafts to the Emails tab", async () => {
    vi.mocked(dd.getPendingApprovals).mockResolvedValue(approvals({ email_drafts: [1, ago(1)] }));
    const drafts = get(await kind("pending_approval"), "dd:approval:email_drafts");
    expect(drafts.title).toBe("1 email draft waiting for approval");
    expect(drafts.refs.map((r) => r.url)).toEqual([url("/approvals?tab=emails")]);
  });

  it("ages the queue from its oldest item", async () => {
    const drafts = get(await kind("pending_approval"), "dd:approval:draft_tasks");
    expect(drafts).toMatchObject({
      title: "4 AI-drafted tasks waiting for approval",
      whatHappened:
        "4 AI-drafted tasks from email intake or meetings are waiting for approval. The oldest has waited 3 days (since Nov 1).",
      occurredAt: ago(3)
    });
    expect(drafts.facts).toEqual([
      { text: "4 AI-drafted tasks pending.", basis: "record", refs: [] },
      { text: "Oldest waiting 3 days (since Nov 1).", basis: "derived", refs: [] }
    ]);
    expect(drafts.priority).toEqual({
      score: 32,
      band: "normal",
      reasons: ["Pending approval (base 20)", "4 items (+9)", "Waiting 3 days for approval (+3)"]
    });
    const proofs = get(await kind("pending_approval"), "dd:approval:fb_proofs");
    expect(proofs.title).toBe("1 Facebook proof waiting for review");
    expect(proofs.whatHappened).toBe(
      "1 Facebook task is waiting for its proof to be reviewed. The oldest has waited less than a day (since Nov 4)."
    );
  });

  it("counts the waiting proofs whose tasks are past due, and scores the queue like the overdue work it holds", async () => {
    vi.mocked(dd.getPendingApprovals).mockResolvedValue(approvals({ fb_proofs: [3, ago(2)] }));
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_fb1", { assigneeId: "u_ana", status: "pending_approval", dueDate: ago(3), priority: "critical", clientName: "Acme" }),
      task("t_fb2", { assigneeId: "u_ana", status: "pending_approval", dueDate: ago(1) }),
      task("t_fb3", { assigneeId: "u_ana", status: "pending_approval", dueDate: ago(-2) })
    ]);
    const proofs = get(await kind("pending_approval"), "dd:approval:fb_proofs");
    expect(proofs.facts.map((f) => [f.text, f.basis])).toEqual([
      ["3 Facebook proofs pending.", "record"],
      ["Oldest waiting 2 days (since Nov 2).", "derived"],
      ["2 waiting proofs are for tasks past their due dates; the most overdue by 3 days.", "derived"]
    ]);
    expect(proofs.priority).toEqual({
      score: 67,
      band: "high",
      reasons: [
        "Pending approval (base 20)",
        "Critical task priority (+25)",
        "Client-facing (+8)",
        "Overdue 3 days (+6)",
        "3 items (+6)",
        "Waiting 2 days for approval (+2)"
      ]
    });

    // Another one passing its due date is a change worth seeing again.
    const before = proofs.stateHash;
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_fb1", { assigneeId: "u_ana", status: "pending_approval", dueDate: ago(3), priority: "critical", clientName: "Acme" }),
      task("t_fb2", { assigneeId: "u_ana", status: "pending_approval", dueDate: ago(1) }),
      task("t_fb3", { assigneeId: "u_ana", status: "pending_approval", dueDate: ago(0, 1) })
    ]);
    expect(get(await kind("pending_approval"), "dd:approval:fb_proofs").stateHash).not.toBe(before);
  });

  it("says nothing about age when the oldest item's time is unknown", async () => {
    const mail = get(await kind("pending_approval"), "dd:approval:unrouted_mail");
    expect(mail).toMatchObject({
      title: "2 intake emails need routing",
      whatHappened: "2 intake emails couldn't be routed automatically and are waiting for someone to route them.",
      occurredAt: null
    });
    expect(mail.facts).toHaveLength(1);
    expect(mail.priority.reasons).toEqual(["Pending approval (base 20)", "2 items (+3)"]);
  });

  it("counts check-ins as about him: they go out as him", async () => {
    const items = await kind("pending_approval");
    expect(get(items, "dd:approval:checkins")).toMatchObject({
      title: "2 check-ins from today's brief not sent yet",
      recommendedNext: "Send or rewrite them from today's daily brief in Slack."
    });
    expect(get(items, "dd:approval:checkins").priority.reasons).toContain("Involves you (+10)");
    expect(get(items, "dd:approval:eod_reviews").priority.reasons).not.toContain("Involves you (+10)");
  });
});

// ---------------------------------------------------------------------------

describe("waiting_on_client", () => {
  beforeEach(() => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_w1", { status: "waiting_on_client", clientName: "Acme", assigneeId: "u_sam", lastActivityAt: ago(3), title: "Homepage copy" }),
      task("t_w2", { status: "waiting_on_client", clientName: " Acme ", assigneeId: "u_ana", lastActivityAt: ago(9), title: "Logo files" }),
      task("t_w3", { status: "waiting_on_client", clientName: "Acme", assigneeId: "u_sam", lastActivityAt: ago(5) }),
      task("t_w4", { status: "waiting_on_client", assigneeId: "u_bob", lastActivityAt: ago(8), title: "Domain transfer" }),
      task("t_w5", { status: "waiting_on_client", clientName: "Beta Co", lastActivityAt: ago(7) })
    ]);
    vi.mocked(dd.listStatusChangeEntries).mockResolvedValue([
      { taskId: "t_w1", enteredAt: ago(12) },
      { taskId: "t_w3", enteredAt: ago(6) }
    ]);
  });

  it("asks for the entry time of every waiting task", async () => {
    await run();
    expect(dd.listStatusChangeEntries).toHaveBeenCalledWith(
      principal,
      ["t_w1", "t_w2", "t_w3", "t_w4", "t_w5"],
      "waiting_on_client",
      expect.objectContaining({})
    );
  });

  it("groups waits over 7 days per client, measured from the status change or, labeled, from the last activity", async () => {
    const items = await kind("waiting_on_client");
    expect([...items.keys()]).toHaveLength(2);
    const acme = [...items.values()].find((c) => c.fingerprint.startsWith("dd:waiting:client:acme-"));
    if (!acme) throw new Error("no Acme item");
    expect(acme.fingerprint).toMatch(/^dd:waiting:client:acme-[0-9a-f]{12}$/);
    expect(acme).toMatchObject({
      category: "delegated",
      title: "2 tasks waiting on Acme for over a week",
      whatHappened:
        "2 open tasks for Acme have been waiting on the client for more than 7 days, the longest for 12 days. " +
        "Where no status change was logged, the wait is counted from the task's last activity, so it's at least that long.",
      recommendedNext: "Ask Sam Lee and Ana Ruiz to follow up with Acme, or decide whether to pause the work.",
      occurredAt: ago(12)
    });
    expect(acme.refs.map((r) => [r.id, r.url])).toEqual([
      ["cl_acme", url("/clients/cl_acme")],
      ["t_w1", taskUrl("t_w1")],
      ["t_w2", taskUrl("t_w2")]
    ]);
    expect(acme.facts.map((f) => [f.text, f.basis])).toEqual([
      ["2 tasks waiting more than 7 days; the longest 12 days.", "derived"],
      ['"Homepage copy": waiting 12 days (since Oct 23).', "derived"],
      ['"Logo files": waiting at least 9 days (no status change logged; last activity Oct 26).', "derived"]
    ]);
    expect(acme.priority).toEqual({
      score: 26,
      band: "normal",
      reasons: [
        "Waiting on client (base 10)",
        "Client-facing (+8)",
        "Waiting on the client for 12 days (+5)",
        "2 items (+3)"
      ]
    });
  });

  it("puts tasks with no client in one group of their own", async () => {
    const none = get(await kind("waiting_on_client"), "dd:waiting:client:_none");
    expect(none).toMatchObject({
      title: "Waiting on the client for at least 8 days: Domain transfer",
      whatHappened: `"Domain transfer" has been waiting on the client for at least 8 days. It's assigned to Bob Ng.`,
      recommendedNext: "Ask Bob Ng to follow up with the client, or decide whether to pause the work."
    });
    expect(none.priority.reasons).not.toContain("Client-facing (+8)");
  });

  it("keeps clients whose names slug alike apart, and suggests by who owns the work", async () => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_x1", { status: "waiting_on_client", clientName: "Acme Inc", lastActivityAt: ago(9) }),
      task("t_x2", { status: "waiting_on_client", clientName: "Acme, Inc.", assigneeId: "u_owner", lastActivityAt: ago(9) }),
      task("t_x3", { status: "waiting_on_client", clientName: "_none", assigneeId: "u_sam", lastActivityAt: ago(9) })
    ]);
    vi.mocked(dd.listStatusChangeEntries).mockResolvedValue([]);
    const items = [...(await kind("waiting_on_client")).values()];
    const fingerprints = items.map((c) => c.fingerprint);
    expect(new Set(fingerprints).size).toBe(3);
    expect(fingerprints).not.toContain("dd:waiting:client:_none");
    for (const c of items) expect(normalizeCandidate(c)).toEqual(c);
    const about = (taskId: string) => items.find((c) => c.refs.some((r) => r.id === taskId));
    expect(about("t_x1")?.title).toBe("Waiting on Acme Inc for at least 9 days: Task t_x1");
    expect(about("t_x1")?.recommendedNext).toBe("Decide who should follow up with Acme Inc.");
    expect(about("t_x2")?.recommendedNext).toBe("Follow up with Acme, Inc., or decide whether to pause the work.");
    expect(about("t_x3")?.fingerprint).toMatch(/^dd:waiting:client:none-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------

describe("open_incident", () => {
  beforeEach(() => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_inc_1", {
        title: "[Incident] site down — https://acme.com",
        tags: ["urgent", "incident"],
        priority: "critical",
        status: "urgent",
        assigneeId: "u_sam",
        createdAt: ago(2),
        dueDate: ago(2),
        clientName: "Acme"
      }),
      task("t_inc_2", {
        title: "[Incident] form broken — no url",
        tags: ["incident"],
        priority: "critical",
        status: "urgent",
        createdAt: ago(0, 3),
        dueDate: ago(0, 3),
        archivedAt: ago(0, 1)
      })
    ]);
  });

  it("makes each open incident task an item to step in on", async () => {
    const items = await kind("open_incident");
    const inc = get(items, "dd:incident:task:t_inc_1");
    expect(inc).toMatchObject({
      category: "intervene",
      title: "Open incident: site down — https://acme.com",
      whatHappened: "An incident task was opened Nov 2 (2 days ago) and is still urgent. It's assigned to Sam Lee.",
      recommendedNext: "Check with Sam Lee on the fix, or reassign it if it's stuck.",
      occurredAt: ago(2)
    });
    expect(inc.facts.map((f) => [f.text, f.basis])).toEqual([
      ["Opened Nov 2, 12:00 PM EST.", "record"],
      ["Status: urgent; priority: critical.", "record"],
      ["Assigned to Sam Lee.", "record"]
    ]);
    // Days overdue are days open: the incident route sets due_date to the moment it opens.
    expect(inc.priority).toEqual({
      score: 82,
      band: "critical",
      reasons: ["Open incident (base 45)", "Critical task priority (+25)", "Client-facing (+8)", "Overdue 2 days (+4)"]
    });
  });

  it("asks for an owner when nobody has the incident, and notes an auto-archived one", async () => {
    const inc = get(await kind("open_incident"), "dd:incident:task:t_inc_2");
    expect(inc.whatHappened).toBe("An incident task was opened Nov 4 (less than a day ago) and is still urgent. It has no assignee.");
    expect(inc.recommendedNext).toBe("Assign someone to handle it.");
    expect(inc.facts.map((f) => f.text)).toEqual([
      "Opened Nov 4, 9:00 AM EST.",
      "Status: urgent; priority: critical.",
      "No assignee.",
      "DD's overdue sweep archived it, but it isn't done."
    ]);
  });

  it("puts his own incident in his hands", async () => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([
      task("t_inc_9", { tags: ["incident"], priority: "critical", status: "urgent", assigneeId: "u_owner", createdAt: ago(1) })
    ]);
    const inc = get(await kind("open_incident"), "dd:incident:task:t_inc_9");
    expect(inc.whatHappened).toContain("It's assigned to you.");
    expect(inc.recommendedNext).toBe("Update the task with where the fix stands, or hand it off.");
  });
});

// ---------------------------------------------------------------------------

describe("site_alert", () => {
  it("makes one item per site with a low score in the last 48 hours, from its latest alert", async () => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([task("t_site", { assigneeId: "u_bob", title: "Investigate Low Site Score - example.com" })]);
    vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([
      alert("a_old", ago(3)),
      alert("a_1", ago(1), { score: 38, taskId: "t_gone" }),
      alert("a_2", ago(0, 6), { score: 55, priority: "medium", taskId: "t_site" })
    ]);
    const site = get(await kind("site_alert"), "dd:site:example.com");
    expect(site).toMatchObject({
      category: "intervene",
      title: "Low site score: example.com (55)",
      whatHappened:
        "example.com scored 55 against a threshold of 70 on Nov 4, 6:00 AM EST. That's 2 low-score alerts in the last 48 hours. " +
        "Its investigation task is open and assigned to Bob Ng.",
      recommendedNext: "Make sure Bob Ng has what they need to fix it.",
      occurredAt: ago(0, 6)
    });
    expect(site.facts.map((f) => f.text)).toEqual([
      "Scored 55 (threshold 70) on Nov 4, 6:00 AM EST.",
      "Scored 38 (threshold 70) on Nov 3, 12:00 PM EST."
    ]);
    expect(site.refs.map((r) => [r.id, r.label])).toEqual([
      ["t_site", "Investigate Low Site Score - example.com"],
      ["t_gone", "Task t_gone"]
    ]);
    expect(site.priority).toEqual({
      score: 36,
      band: "normal",
      reasons: ["Site alert (base 25)", "Medium severity (+8)", "2 items (+3)"]
    });
  });

  it("is an FYI when the latest score is above 70", async () => {
    vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([alert("a_1", ago(0, 2), { score: 74, threshold: 80, priority: null, taskId: "t_done" })]);
    const site = get(await kind("site_alert"), "dd:site:example.com");
    expect(site.category).toBe("fyi");
    expect(site.whyItMatters).toBe("The latest score is above 70, so it's less urgent, but the site is still below its alert threshold.");
    expect(site.whatHappened).toContain("Its investigation task is no longer open.");
    expect(site.recommendedNext).toBe("Check that the next scan confirms the fix.");
    expect(site.priority.reasons).toEqual(["Site alert (base 25)"]);
  });

  it("asks him to step in at a score of exactly 70, and the state changes when the category does", async () => {
    vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([alert("a_1", ago(0, 2), { score: 70, threshold: 80, priority: null })]);
    const atSeventy = get(await kind("site_alert"), "dd:site:example.com");
    expect(atSeventy.category).toBe("intervene");
    vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([alert("a_1", ago(0, 2), { score: 71, threshold: 80, priority: null })]);
    const above = get(await kind("site_alert"), "dd:site:example.com");
    expect(above.category).toBe("fyi");
    expect(above.stateHash).not.toBe(atSeventy.stateHash);
  });

  it("asks for an owner when no task could be opened, and keys a site without a domain by its website's host", async () => {
    vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([
      alert("a_1", ago(0, 2), { domain: null, website: "https://WWW.Beta-Shop.com:443/home?x=1", skippedReason: "no-assignee" }),
      alert("a_2", ago(0, 1), { domain: null, website: "", skippedReason: null })
    ]);
    const items = await kind("site_alert");
    // A row with neither a domain nor a website can't be told apart from another site.
    expect([...items.keys()]).toEqual(["dd:site:beta-shop.com"]);
    const site = get(items, "dd:site:beta-shop.com");
    expect(site.whatHappened).toContain("No task was opened because there was no one to assign it to.");
    expect(site.recommendedNext).toBe("Assign someone to investigate the site.");
    expect(site.facts[0].text).toBe("Scored 42 (threshold 70) on Nov 4, 10:00 AM EST; no task opened (no one to assign).");
  });

  it("names the right next step for an open task without an owner, his own, or no linked task", async () => {
    vi.mocked(dd.listOpenTasks).mockResolvedValue([task("t_a"), task("t_b", { assigneeId: "u_owner" })]);
    vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([
      alert("a_1", ago(0, 2), { domain: "a.com", taskId: "t_a" }),
      alert("a_2", ago(0, 2), { domain: "b.com", taskId: "t_b" }),
      alert("a_3", ago(0, 2), { domain: "c.com" })
    ]);
    const items = await kind("site_alert");
    expect(get(items, "dd:site:a.com").recommendedNext).toBe("Assign the investigation task to someone.");
    expect(get(items, "dd:site:b.com").whatHappened).toContain("Its investigation task is open and assigned to you.");
    expect(get(items, "dd:site:b.com").recommendedNext).toBe("Work the investigation task, or hand it off.");
    expect(get(items, "dd:site:c.com").whatHappened).toContain("No investigation task is linked to it.");
  });
});

// ---------------------------------------------------------------------------

describe("unanswered_mention", () => {
  beforeEach(() => {
    vi.mocked(dd.listTaskNotificationsForUser).mockResolvedValue([
      note("n_1", "t_m1", ago(2)),
      note("n_2", "t_m2", ago(3)),
      note("n_3", "t_m3", ago(1)),
      note("n_4", "t_m4", ago(4), { kind: "notified", actorId: null }),
      note("n_5", "t_m5", ago(1), { actorId: "u_owner" }),
      note("n_6", "t_m6", ago(1)),
      note("n_7", "t_m7", ago(5)),
      note("n_8", "t_m7", ago(2), { actorId: "u_ana" })
    ]);
    vi.mocked(dd.listTasksByIds).mockResolvedValue([
      task("t_m1", { title: "Pricing page" }),
      task("t_m2", { title: "Answered" }),
      task("t_m3", { title: "Replied by message" }),
      task("t_m4", { title: "Server move" }),
      task("t_m6", { title: "Deleted", deletedAt: ago(0, 2) }),
      task("t_m7", { title: "Launch plan", priority: "high", clientName: "Acme" })
    ]);
    vi.mocked(dd.listActivitySince).mockResolvedValue([
      { id: "a_1", taskId: "t_m2", userId: "u_owner", action: "comment", createdAt: ago(2) },
      // Before the notification: it doesn't answer it.
      { id: "a_2", taskId: "t_m1", userId: "u_owner", action: "status_change", createdAt: ago(3) }
    ]);
    vi.mocked(dd.listTaskMessagesSince).mockResolvedValue([{ id: "m_1", taskId: "t_m3", userId: "u_owner", createdAt: ago(0, 12) }]);
  });

  it("makes one item per task he was mentioned on and hasn't acted on since", async () => {
    const items = await kind("unanswered_mention");
    expect([...items.keys()].sort()).toEqual(["dd:mention:task:t_m1", "dd:mention:task:t_m4", "dd:mention:task:t_m7"]);
    // His own notifications aren't something he owes, so t_m5 isn't even read for answers.
    expect(dd.listActivitySince).toHaveBeenCalledWith(
      principal,
      ago(5),
      { taskIds: ["t_m1", "t_m2", "t_m3", "t_m4", "t_m6", "t_m7"], userId: "u_owner" },
      expect.objectContaining({})
    );
  });

  it("puts the mention in his hands, with how long it has waited", async () => {
    const m = get(await kind("unanswered_mention"), "dd:mention:task:t_m1");
    expect(m).toMatchObject({
      category: "my_action",
      title: 'Sam Lee mentioned you on "Pricing page"',
      whatHappened: "Sam Lee mentioned you 2 days ago (Nov 2, 12:00 PM EST). DD shows no comment, status change or other action from you on the task since.",
      recommendedNext: "Reply on the task, or tell Sam Lee who should handle it.",
      refs: [expect.objectContaining({ id: "t_m1", url: taskUrl("t_m1") })],
      occurredAt: ago(2)
    });
    expect(m.facts.map((f) => [f.text, f.basis])).toEqual([
      ["No comment, status change or other logged action from you on this task since Nov 2, 12:00 PM EST.", "derived"],
      ["Sam Lee mentioned you Nov 2, 12:00 PM EST.", "record"]
    ]);
    expect(m.priority).toEqual({
      score: 54,
      band: "high",
      reasons: ["Unanswered mention (base 40)", "Involves you (+10)", "Unanswered for 2 days (+4)"]
    });
  });

  it("folds several on one task into one item", async () => {
    const m = get(await kind("unanswered_mention"), "dd:mention:task:t_m7");
    expect(m.title).toBe('2 unanswered mentions on "Launch plan"');
    expect(m.whatHappened).toBe(
      "You were mentioned or notified 2 times on this task since Oct 30, most recently by Ana Ruiz 2 days ago. " +
        "DD shows no comment, status change or other action from you on the task since."
    );
    expect(m.recommendedNext).toBe("Reply on the task, or tell Ana Ruiz who should handle it.");
    expect(m.facts.map((f) => f.text).slice(1)).toEqual(["Ana Ruiz mentioned you Nov 2, 12:00 PM EST.", "Sam Lee mentioned you Oct 30, 1:00 PM EDT."]);
    expect(m.priority).toEqual({
      score: 83,
      band: "critical",
      reasons: [
        "Unanswered mention (base 40)",
        "High task priority (+12)",
        "Unanswered for 5 days (+10)",
        "Involves you (+10)",
        "Client-facing (+8)",
        "2 items (+3)"
      ]
    });
  });

  it("words a notification with no sender recorded", async () => {
    const m = get(await kind("unanswered_mention"), "dd:mention:task:t_m4");
    expect(m.title).toBe('You were notified about "Server move"');
    expect(m.whatHappened).toBe("Someone notified you 4 days ago (Oct 31, 1:00 PM EDT). DD shows no comment, status change or other action from you on the task since.");
    expect(m.recommendedNext).toBe("Reply on the task, or point it to whoever should handle it.");
    expect(m.facts[1].text).toBe("Notified Oct 31, 1:00 PM EDT (no sender recorded).");
  });

  it("claims only what it checked: logged actions, not edits the task form makes without a log", async () => {
    // A title, description, priority or due-date edit logs nothing, so the
    // item can't say he hasn't updated the task.
    for (const m of (await kind("unanswered_mention")).values()) {
      const text = [m.title, m.whatHappened, ...m.facts.map((f) => f.text)].join(" ");
      expect(text).not.toMatch(/\bupdated?\b/i);
      expect(m.whatHappened).toContain("DD shows no comment, status change or other action from you on the task since.");
      expect(m.facts[0]).toMatchObject({ basis: "derived", text: expect.stringMatching(/^No comment, status change or other logged action from you on this task since /) });
    }
  });

  it("counts only a later response as an answer, not one at the same instant", async () => {
    vi.mocked(dd.listTaskNotificationsForUser).mockResolvedValue([note("n_1", "t_m1", ago(2))]);
    vi.mocked(dd.listActivitySince).mockResolvedValue([{ id: "a_1", taskId: "t_m1", userId: "u_owner", action: "comment", createdAt: ago(2) }]);
    vi.mocked(dd.listTaskMessagesSince).mockResolvedValue([]);
    expect([...(await kind("unanswered_mention")).keys()]).toEqual(["dd:mention:task:t_m1"]);
  });

  it("reads nothing more when every notification is one he sent himself", async () => {
    vi.mocked(dd.listTaskNotificationsForUser).mockResolvedValue([note("n_5", "t_m5", ago(1), { actorId: "u_owner" })]);
    await expect(kind("unanswered_mention")).resolves.toEqual(new Map());
    expect(dd.listActivitySince).not.toHaveBeenCalled();
    expect(dd.listTaskMessagesSince).not.toHaveBeenCalled();
    expect(dd.listTasksByIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("recurring_issue", () => {
  it("flags the same incident on the same page three times in 30 days", async () => {
    vi.mocked(dd.listIncidentLogsSince).mockResolvedValue([
      incidentLog("i_1", ago(20)),
      incidentLog("i_2", ago(10), { affectedUrl: "acme.com/contact" }),
      incidentLog("i_3", ago(2)),
      incidentLog("i_4", ago(2), { issueType: "malware" })
    ]);
    const items = await kind("recurring_issue");
    expect([...items.keys()]).toHaveLength(1);
    const [inc] = [...items.values()];
    expect(inc.fingerprint).toMatch(/^dd:recurring:incident:site-down-acme-com-contact-[0-9a-f]{12}$/);
    expect(inc).toMatchObject({
      category: "intervene",
      title: "Recurring incident: site down on acme.com/contact",
      whatHappened: "3 reports in the last 30 days (3 in 90), the latest on Nov 2.",
      refs: [{ system: "dd", id: "/updates/incidents", url: url("/updates/incidents"), label: "Incident log", class: "internal" }],
      occurredAt: ago(2)
    });
    expect(inc.facts.map((f) => f.text)).toEqual([
      "3 in the last 30 days, 3 in the last 90.",
      "Reported Nov 2, 12:00 PM EST.",
      "Reported Oct 25, 1:00 PM EDT.",
      "Reported Oct 15, 1:00 PM EDT."
    ]);
    expect(inc.priority.reasons).toEqual(["Recurring issue (base 25)", "3 items (+6)"]);
  });

  it("doesn't call reports with no URL one recurring problem", async () => {
    vi.mocked(dd.listIncidentLogsSince).mockResolvedValue([
      incidentLog("i_1", ago(20), { issueType: "other", affectedUrl: null }),
      incidentLog("i_2", ago(10), { issueType: "other", affectedUrl: null }),
      incidentLog("i_3", ago(2), { issueType: "other", affectedUrl: null })
    ]);
    expect([...(await kind("recurring_issue")).keys()]).toEqual([]);
  });

  it("flags a site that keeps alerting, linking each alert's task", async () => {
    vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue([
      alert("a_1", ago(25), { taskId: "t_a1" }),
      alert("a_2", ago(12), { taskId: "t_a2" }),
      alert("a_3", ago(5), { score: 51 })
    ]);
    const site = get(await kind("recurring_issue"), "dd:recurring:site:example.com");
    expect(site).toMatchObject({
      title: "Recurring low site scores: example.com",
      whatHappened: "example.com had 3 low-score alerts in the last 30 days (3 in 90), the latest on Oct 30.",
      recommendedNext: "Ask the website team to look for one root cause across these alerts."
    });
    expect(site.refs.map((r) => r.id)).toEqual(["t_a2", "t_a1"]);
    expect(site.facts[1].text).toBe("Scored 51 on Oct 30, 1:00 PM EDT.");
  });

  it("flags an open task whose due date keeps moving, and the person who keeps moving them", async () => {
    vi.mocked(dd.listTaskExtensionsSince).mockResolvedValue([
      extension("ext_1", "t_ext", "u_sam", ago(20), { previousDueDate: null, newDueDate: ago(15) }),
      extension("ext_2", "t_ext", "u_sam", ago(10)),
      extension("ext_3", "t_done", "u_sam", ago(9)),
      extension("ext_4", "t_done", "u_sam", ago(8)),
      extension("ext_5", "t_gone", "u_sam", ago(7))
    ]);
    vi.mocked(dd.listTasksByIds).mockResolvedValue([
      task("t_ext", { assigneeId: "u_sam", title: "Rebuild the blog", dueDate: ago(-5) }),
      task("t_done", { assigneeId: "u_sam", status: "done", completedAt: ago(1), title: "Old report" }),
      task("t_gone", { deletedAt: ago(1) })
    ]);
    const items = await kind("recurring_issue");
    // t_done is finished: nothing left to fix on it. Its extensions still count for Sam.
    expect([...items.keys()].sort()).toEqual(["dd:recurring:task-extensions:t_ext", "dd:recurring:user-extensions:u_sam"]);

    const ext = get(items, "dd:recurring:task-extensions:t_ext");
    expect(ext).toMatchObject({
      title: "Due date pushed 2 times: Rebuild the blog",
      whatHappened: `The due date of "Rebuild the blog" was extended 2 times in the last 90 days, most recently on Oct 25. It's assigned to Sam Lee.`,
      recommendedNext: "Ask Sam Lee what has changed, and agree on a date that will hold."
    });
    expect(ext.facts.map((f) => f.text)).toEqual([
      "Due date moved from Oct 15 to Nov 9 on Oct 25 by Sam Lee.",
      "Due date set to Oct 20 on Oct 15 by Sam Lee."
    ]);

    const sam = get(items, "dd:recurring:user-extensions:u_sam");
    expect(sam).toMatchObject({
      title: "Sam Lee extended 5 due dates in the last 30 days",
      whatHappened: "Sam Lee filed 5 due-date extensions in the last 30 days (5 in 90), the latest on Oct 28.",
      recommendedNext: "Check in with Sam Lee on workload and how deadlines are being set."
    });
    // A deleted task gets no link; the line still counts it.
    expect(sam.facts.map((f) => [f.text, f.refs.map((r) => r.id)])).toEqual([
      ['"Task t_gone": due date moved from Oct 15 to Nov 9 on Oct 28.', []],
      ['"Old report": due date moved from Oct 15 to Nov 9 on Oct 27.', ["t_done"]],
      ['"Old report": due date moved from Oct 15 to Nov 9 on Oct 26.', ["t_done"]],
      ['"Rebuild the blog": due date moved from Oct 15 to Nov 9 on Oct 25.', ["t_ext"]],
      ['"Rebuild the blog": due date set to Oct 20 on Oct 15.', ["t_ext"]]
    ]);
    expect(sam.refs.map((r) => r.id)).toEqual(["t_done", "t_ext"]);
    expect(sam.priority.reasons).toEqual(["Recurring issue (base 25)", "5 items (+12)"]);
  });

  it("talks to him about his own extensions, and asks for an owner on an unassigned task", async () => {
    vi.mocked(dd.listTaskExtensionsSince).mockResolvedValue([
      extension("ext_1", "t_x", "u_owner", ago(3)),
      extension("ext_2", "t_x", "u_owner", ago(2)),
      extension("ext_3", "t_y", "u_owner", ago(1)),
      extension("ext_4", "t_y", "u_owner", ago(1, 1))
    ]);
    vi.mocked(dd.listTasksByIds).mockResolvedValue([task("t_x", { assigneeId: "u_owner" }), task("t_y")]);
    const items = await kind("recurring_issue");
    expect(get(items, "dd:recurring:task-extensions:t_x").recommendedNext).toBe("Settle on a date that will hold, or rescope the task.");
    expect(get(items, "dd:recurring:task-extensions:t_y").recommendedNext).toBe("Pick an owner, and agree on a date that will hold.");
    expect(get(items, "dd:recurring:task-extensions:t_y").whatHappened).toContain("It has no assignee.");
    const mine = get(items, "dd:recurring:user-extensions:u_owner");
    expect(mine.title).toBe("You extended 4 due dates in the last 30 days");
    expect(mine.recommendedNext).toBe("Look at whether your deadlines or your workload need adjusting.");
    expect(mine.priority.reasons).toContain("Involves you (+10)");
  });
});

// ---------------------------------------------------------------------------

describe("identity across runs", () => {
  const fingerprintsAndHashes = (all: AttentionCandidate[]) => all.map((c) => [c.fingerprint, c.stateHash]);

  it("keeps fingerprints and state hashes while nothing changes, later in the same day", async () => {
    seedEverything();
    const first = await run();
    const later = await run(new Date(NOW.getTime() + HOUR));
    expect(fingerprintsAndHashes(later)).toEqual(fingerprintsAndHashes(first));
  });

  it("moves the state hash, and only it, when the situation changes", async () => {
    const sam = (tasks: DdTask[], now = NOW) => {
      vi.mocked(dd.listOpenTasks).mockResolvedValue(tasks);
      return kind("overdue_tasks", now).then((m) => get(m, "dd:overdue:assignee:u_sam"));
    };
    const base = await sam([task("t_1", { assigneeId: "u_sam", dueDate: ago(2) })]);

    // Another task joins the group.
    const more = await sam([task("t_1", { assigneeId: "u_sam", dueDate: ago(2) }), task("t_2", { assigneeId: "u_sam", dueDate: ago(1) })]);
    // A task in it changes status.
    const status = await sam([task("t_1", { assigneeId: "u_sam", dueDate: ago(2), status: "waiting_on_client" })]);
    // The oldest crosses from the 0-2 day bucket into 3-6.
    const older = await sam([task("t_1", { assigneeId: "u_sam", dueDate: ago(2) })], new Date(NOW.getTime() + DAY));
    // Inside a bucket, a day passing changes nothing.
    const sameBucket = await sam([task("t_1", { assigneeId: "u_sam", dueDate: ago(3) })], new Date(NOW.getTime() + DAY));

    for (const changed of [more, status, older]) {
      expect(changed.fingerprint).toBe(base.fingerprint);
      expect(changed.stateHash).not.toBe(base.stateHash);
    }
    expect(older.stateHash).not.toBe(more.stateHash);
    const fourDays = await sam([task("t_1", { assigneeId: "u_sam", dueDate: ago(4) })]);
    expect(sameBucket.stateHash).toBe(fourDays.stateHash);
  });

  it("hashes ids as a set: the order the database returns them in doesn't matter", async () => {
    const a = task("t_1", { assigneeId: "u_sam", dueDate: ago(2) });
    const b = task("t_2", { assigneeId: "u_sam", dueDate: ago(2) });
    vi.mocked(dd.listOpenTasks).mockResolvedValue([a, b]);
    const one = get(await kind("overdue_tasks"), "dd:overdue:assignee:u_sam");
    vi.mocked(dd.listOpenTasks).mockResolvedValue([b, a]);
    const two = get(await kind("overdue_tasks"), "dd:overdue:assignee:u_sam");
    expect(two.stateHash).toBe(one.stateHash);
    expect(two).toEqual(one);
  });

  it("keeps a person's extension pattern's hash when an extension older than 30 days ages out of the 90-day read", async () => {
    // Sam's last 30 days: 2, 5 and 8 days ago, which is what qualifies the item.
    // One more, from 88 days ago, is still inside the 90-day read.
    const recent = [
      extension("ext_a", "t_a", "u_sam", ago(2)),
      extension("ext_b", "t_b", "u_sam", ago(5)),
      extension("ext_c", "t_c", "u_sam", ago(8))
    ];
    vi.mocked(dd.listTaskExtensionsSince).mockResolvedValue([...recent, extension("ext_old", "t_d", "u_sam", ago(88))]);
    const sam = async (now: Date) => get(await kind("recurring_issue", now), "dd:recurring:user-extensions:u_sam");
    const before = await sam(NOW);

    // Three days on, the old one is 91 days old and out of the window. The 30-day
    // rows are the same three, the oldest now 11 days old (still the 7-13 bucket).
    const after = await sam(new Date(NOW.getTime() + 3 * DAY));
    expect(after.stateHash).toBe(before.stateHash);
    // The text still follows the 90-day count; only the state is the 30-day pattern's.
    expect(before.whatHappened).toContain("(4 in 90)");
    expect(after.whatHappened).toContain("(3 in 90)");

    // A new extension inside the 30 days is a real change.
    vi.mocked(dd.listTaskExtensionsSince).mockResolvedValue([...recent, extension("ext_new", "t_e", "u_sam", ago(1))]);
    expect((await sam(NOW)).stateHash).not.toBe(before.stateHash);
  });

  // Rows are [id, days before NOW]; a later run reads the same rows at the same instants.
  describe.each<[string, (rows: [string, number][]) => void, string]>([
    [
      "incident",
      (rows) => vi.mocked(dd.listIncidentLogsSince).mockResolvedValue(rows.map(([id, d]) => incidentLog(id, ago(d)))),
      "dd:recurring:incident:"
    ],
    [
      "site",
      (rows) => vi.mocked(dd.listSiteHealthAlertsSince).mockResolvedValue(rows.map(([id, d]) => alert(id, ago(d)))),
      "dd:recurring:site:"
    ]
  ])("a recurring %s pattern", (_name, seed, prefix) => {
    const hash = async (now: Date) => {
      const items = [...(await kind("recurring_issue", now)).values()].filter((c) => c.fingerprint.startsWith(prefix));
      expect(items).toHaveLength(1);
      return items[0].stateHash;
    };
    const threeDaysOn = new Date(NOW.getTime() + 3 * DAY);
    const recent: [string, number][] = [
      ["r_2", 2],
      ["r_5", 5],
      ["r_8", 8]
    ];

    it("keeps its hash when a report older than 30 days ages out of the 90-day read", async () => {
      // 3 in the last 30 days is what makes it recurring; one more is 88 days old.
      seed([...recent, ["r_88", 88]]);
      const before = await hash(NOW);
      // Three days on, the old one is out of the read. The 30-day rows are the
      // same three, the oldest now 11 days old (still the 7-13 bucket).
      seed(recent);
      expect(await hash(threeDaysOn)).toBe(before);
    });

    it("keeps its hash while the 30 days hold, even as the 90 days drop from 5 to 4", async () => {
      seed([...recent, ["r_40", 40], ["r_88", 88]]);
      const before = await hash(NOW);
      seed([...recent, ["r_40", 40]]);
      expect(await hash(threeDaysOn)).toBe(before);
    });

    it("moves its hash with a new report inside the 30 days", async () => {
      seed([...recent, ["r_88", 88]]);
      const before = await hash(NOW);
      seed([["r_1", 1], ...recent, ["r_88", 88]]);
      expect(await hash(NOW)).not.toBe(before);
    });
  });

  it("moves an approval queue's hash with its count, not with time inside a bucket", async () => {
    const hash = async (count: number, oldestAt: string, now = NOW) => {
      vi.mocked(dd.getPendingApprovals).mockResolvedValue(approvals({ email_drafts: [count, oldestAt] }));
      return get(await kind("pending_approval", now), "dd:approval:email_drafts").stateHash;
    };
    const base = await hash(2, ago(4));
    expect(await hash(2, ago(4), new Date(NOW.getTime() + DAY))).toBe(base);
    expect(await hash(3, ago(4))).not.toBe(base);
    expect(await hash(2, ago(7))).not.toBe(base);
  });
});
