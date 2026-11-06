import "server-only";

import {
  deriveProjectClient,
  derivedBlockers,
  mergeTaskReads,
  projectUpdateEvents,
  stageBatches,
  stuckBatchSignals
} from "@/lib/exec/analysis/project-detail";
import { projectHealth, projectsHealth, type ProjectHealth } from "@/lib/exec/analysis/projects";
import { isAutoArchived, isOpen, isOverdue, overdueDays, STAGE_CLOSE_GUARD_ACTIONS } from "@/lib/exec/analysis/tasks";
import { listLiveDdtextSignals } from "@/lib/exec/ddtext-store";
import type { DdtextKind } from "@/lib/exec/ddtext-types";
import { DDTEXT_LIVE_DAYS } from "@/lib/exec/ddtext-types";
import { listBucketRows } from "@/lib/exec/email-store";
import { loadIntakeScreeningPolicy, restrictedIntakeTaskIds } from "@/lib/exec/intake-screen";
import { loadSettings } from "@/lib/exec/principal";
import { isLiveDdtextSignal } from "@/lib/exec/producers/ddtext";
import { ddClientRef, ddProjectRef, ddTaskRef, execEmailThreadRef } from "@/lib/exec/refs";
import {
  listActivitySince,
  listClients,
  listDepartments,
  listOpenTasks,
  listProjects,
  listProjectStages,
  listProjectTasksAllStates,
  listStatusChangeEntries,
  listStatusTransitions,
  listTaskExtensionsForTasks,
  listTaskMessagesSince,
  listTasksCompletedBetween,
  listUsers
} from "@/lib/exec/sources/dd";
import { listMeetingBriefRisks } from "@/lib/exec/sources/dd-text";
import type { DdClient, DdDepartment, DdProjectStage, DdProjectTask, DdTask, DdUser } from "@/lib/exec/sources/dd-types";
import { isPinnedAccount, loadScreeningPolicy, pinnedAccounts, screenStoredRow } from "@/lib/exec/sources/mail";
import { startOfLocalDayUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import type {
  AiBlocker,
  Cell,
  ConversationRow,
  ExtensionRow,
  MeetingRiskRow,
  OverdueTaskRow,
  ProjectDetailView,
  ProjectListRow,
  ProjectsFilter,
  ProjectsListView,
  Section,
  StageView,
  StuckSignal
} from "@/lib/exec/view-types";
import { isTeamTask } from "@/lib/task-team";

// The Projects tab's services (P5a contract §3.10, A4, C16, K25, K26). Status
// is P2b's projectsHealth on the Overview's inputs (open tasks plus the
// completions of the last 30 local days), so the two surfaces agree; stuck
// batches are separate derived badges. The one DD text read here is
// listMeetingBriefRisks from sources/dd-text.ts (boundary rule 10, K3): stored
// AI text about the derived client's meetings, shown labelled AI-assessed and
// never stored. One 15 s deadline, combined with the caller's signal, over
// every read; each section fails soft.

const READ_TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** The Overview's completions window: the last 30 local days, today included. */
const COMPLETION_DAYS = 30;
const UPDATE_DAYS = 30;
const MEETING_RISK_DAYS = 60;
const MEETING_RISK_LIMIT = 5;
const MAX_CONVERSATIONS = 10;
const SUBJECT_CHARS = 120;
const MAX_AI_BLOCKERS = 20;
const AI_BLOCKER_KINDS: readonly DdtextKind[] = ["blocker", "waiting", "decision"];
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const UNAVAILABLE = { ok: false, error: "unavailable" } as const;
type Settled<T> = Cell<T>;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deadlineSignal(caller: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(READ_TIMEOUT_MS);
  if (!caller) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, deadline]);
  const controller = new AbortController();
  const abort = (from: AbortSignal) => () => controller.abort(from.reason);
  if (caller.aborted) controller.abort(caller.reason);
  else {
    caller.addEventListener("abort", abort(caller), { once: true });
    deadline.addEventListener("abort", abort(deadline), { once: true });
  }
  return controller.signal;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function settle<T>(what: string, signal: AbortSignal, run: (opts: { signal: AbortSignal }) => Promise<T>): Promise<Settled<T>> {
  return untilAborted(Promise.resolve().then(() => run({ signal })), signal).then(
    (value): Settled<T> => ({ ok: true, value }),
    (err): Settled<T> => {
      console.error(`[exec-projects] ${what} read failed: ${errMessage(err)}`);
      return { ok: false };
    }
  );
}

// Thrown by need() when an input failed; that read already logged its error.
const INPUT_FAILED = Symbol("projects input failed");

function need<T>(read: Settled<T>): T {
  if (!read.ok) throw INPUT_FAILED;
  return read.value;
}

function inputFailed(): never {
  throw INPUT_FAILED;
}

async function build<T>(what: string, compute: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await compute() };
  } catch (err) {
    if (err !== INPUT_FAILED) console.error(`[exec-projects] ${what} failed: ${errMessage(err)}`);
    return UNAVAILABLE;
  }
}

/** [from, to) of the Overview's completions window: local midnight 29 days back to tomorrow's midnight. */
function completionsWindow(now: Date, tz: string): { fromIso: string; toIso: string } {
  const today = startOfLocalDayUtc(now, tz);
  const tomorrow = startOfLocalDayUtc(new Date(today.getTime() + 26 * HOUR_MS), tz);
  let first = today;
  for (let back = 1; back < COMPLETION_DAYS; back += 1) first = startOfLocalDayUtc(new Date(first.getTime() - 1), tz);
  return { fromIso: first.toISOString(), toIso: tomorrow.toISOString() };
}

/** Trimmed client name → id; a name two clients share derives nothing. */
function clientIdsByName(clients: readonly DdClient[]): Map<string, string> {
  const out = new Map<string, string>();
  const shared = new Set<string>();
  for (const c of clients) {
    const name = c.name.trim();
    if (name === "") continue;
    if (out.has(name)) shared.add(name);
    else out.set(name, c.id);
  }
  for (const name of shared) out.delete(name);
  return out;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function activeStageOf(stages: readonly DdProjectStage[]): DdProjectStage | null {
  return [...stages].filter((s) => s.status === "active").sort((a, b) => a.position - b.position)[0] ?? null;
}

function stuckOf(stages: readonly DdProjectStage[], tasks: readonly DdProjectTask[]): StuckSignal[] {
  const byStage = groupBy(tasks, (t) => t.stageId);
  return [...stages]
    .sort((a, b) => a.position - b.position)
    .flatMap((s) => stuckBatchSignals(s, byStage.get(s.id) ?? []).signals);
}

function departmentHeadName(dept: DdDepartment | undefined, users: ReadonlyMap<string, DdUser>): string | null {
  if (!dept || dept.headUserId === null) return null;
  return users.get(dept.headUserId)?.name ?? null;
}

function matchesFilter(filter: ProjectsFilter, health: ProjectHealth, stuck: readonly StuckSignal[]): boolean {
  if (filter === "all") return true;
  if (filter === "open") return health.openTasks > 0;
  return health.status === "off_track" || health.status === "at_risk" || stuck.length > 0;
}

/**
 * Every project (A4) with its health (projectsHealth on the Overview's
 * inputs), department and head, active stage, stuck-batch signals and
 * derived client. `filter`: "all"; "open" = with open work (the Overview's
 * population); "problems" = off track, at risk, or with a stuck batch.
 * Worst first, as projectsHealth sorts.
 */
export async function getProjectsListView(
  principal: ExecPrincipal,
  filter: ProjectsFilter,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<ProjectsListView> {
  const now = opts.now ?? new Date();
  const tz = principal.timezone;
  const signal = deadlineSignal(opts.signal);
  const read = <T>(what: string, run: (o: { signal: AbortSignal }) => Promise<T>) => settle(what, signal, run);
  const window = completionsWindow(now, tz);

  const projects = read("projects", (o) => listProjects(principal, o));
  const stages = read("project stages", (o) => listProjectStages(principal, undefined, o));
  const openTasks = read("open tasks", (o) => listOpenTasks(principal, o));
  const completed = read("completed tasks", (o) => listTasksCompletedBetween(principal, window.fromIso, window.toIso, o));
  const departments = read("departments", (o) => listDepartments(principal, o));
  const users = read("users", (o) => listUsers(principal, o));
  const clients = read("clients", (o) => listClients(principal, o));
  const allStates = projects.then((p) =>
    p.ok ? read("project tasks", (o) => listProjectTasksAllStates(principal, p.value.map((x) => x.id), o)) : ({ ok: false } as const)
  );
  const waitingEntries = openTasks.then((o) => {
    if (!o.ok) return { ok: false } as const;
    const waiting = o.value.filter((t) => t.status === "waiting_on_client" && t.projectId !== null).map((t) => t.id);
    return read("waiting entries", (r) => listStatusChangeEntries(principal, waiting, "waiting_on_client", r));
  });

  const rows = build("project rows", async (): Promise<ProjectListRow[]> => {
    const list = need(await projects);
    const open = need(await openTasks);
    const recent = need(await completed);
    const entries = need(await waitingEntries);
    const stageRows = need(await stages);
    const tasks = need(await allStates);
    const depts = new Map(need(await departments).map((d) => [d.id, d]));
    const people = new Map(need(await users).map((u) => [u.id, u]));
    const clientIds = clientIdsByName(need(await clients));

    const health = projectsHealth(list, stageRows, mergeTaskReads(open, recent), now, {
      waitingSince: new Map(entries.map((e) => [e.taskId, e.enteredAt]))
    });
    const projectById = new Map(list.map((p) => [p.id, p]));
    const stagesByProject = groupBy(stageRows, (s) => s.projectId);
    const tasksByProject = groupBy(tasks, (t) => t.projectId);
    const out: ProjectListRow[] = [];
    for (const h of health) {
      const project = projectById.get(h.projectId);
      if (!project) continue;
      const ownStages = stagesByProject.get(project.id) ?? [];
      const ownTasks = tasksByProject.get(project.id) ?? [];
      const stuck = stuckOf(ownStages, ownTasks);
      if (!matchesFilter(filter, h, stuck)) continue;
      const dept = project.departmentId === null ? undefined : depts.get(project.departmentId);
      const active = activeStageOf(ownStages);
      out.push({
        health: h,
        departmentName: dept?.name ?? null,
        departmentHeadName: departmentHeadName(dept, people),
        activeStage: active === null ? null : { id: active.id, name: active.name, position: active.position, updatedAt: active.updatedAt },
        stuck,
        derivedClient: deriveProjectClient(ownTasks, clientIds),
        ref: ddProjectRef(project)
      });
    }
    return out;
  });
  const total = build("project count", async () => need(await projects).length);

  const [rowsSection, totalSection] = await Promise.all([rows, total]);
  opts.signal?.throwIfAborted();
  return { generatedAt: now.toISOString(), timezone: tz, filter, rows: rowsSection, totalProjects: totalSection };
}

function clipSubject(subject: string | null | undefined): string {
  const s = typeof subject === "string" ? subject.replace(/\s+/g, " ").trim() : "";
  if (s === "") return "(no subject)";
  return s.length > SUBJECT_CHARS ? `${s.slice(0, SUBJECT_CHARS - 1)}…` : s;
}

function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The project's stages in order, each with its work and, for the active one, its current batch. */
function stageViews(
  stages: readonly DdProjectStage[],
  tasks: readonly DdProjectTask[],
  users: ReadonlyMap<string, DdUser>,
  departments: ReadonlyMap<string, DdDepartment>
): StageView[] {
  const byStage = groupBy(tasks, (t) => t.stageId);
  return [...stages]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const own = byStage.get(s.id) ?? [];
      const live = own.filter((t) => !t.isDraft && t.deletedAt == null && t.status !== "rejected");
      const stuck = stuckBatchSignals(s, own);
      let currentBatch: StageView["currentBatch"] = null;
      if (s.status === "active") {
        const { groups, current } = stageBatches(own);
        if (current >= 0) {
          currentBatch = {
            group: stuck.currentGroup,
            tasks: groups[current].map((t) => ({
              taskId: t.id,
              title: t.title,
              status: t.status,
              assigneeName: t.assigneeId === null ? null : (users.get(t.assigneeId)?.name ?? null),
              teamQueueName:
                t.assigneeId === null && isTeamTask(t) && t.departmentId !== null ? (departments.get(t.departmentId)?.name ?? null) : null,
              deleted: t.deletedAt != null,
              ref: ddTaskRef(t)
            }))
          };
        }
      }
      return {
        id: s.id,
        name: s.name,
        position: s.position,
        status: s.status,
        updatedAt: s.updatedAt,
        work: { done: live.filter((t) => t.status === "done").length, total: live.length },
        currentBatch,
        queuedBehind: stuck.queuedBehind
      };
    });
}

/**
 * One project's page (A4, C16, K25, K26): the summary (health on the
 * Overview's inputs, derived client, stuck batches), stages, delays (overdue
 * and extensions), blockers (derived, and AI-assessed ones from DD text when
 * triage is on), the honest updates feed, the derived client's meeting-brief
 * risks (AI-assessed, read live) and his conversations with that client
 * (screened, private, subject only). null when the project doesn't exist.
 */
export async function getProjectDetail(
  principal: ExecPrincipal,
  projectId: string,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<ProjectDetailView | null> {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return null;
  const now = opts.now ?? new Date();
  const tz = principal.timezone;
  const signal = deadlineSignal(opts.signal);
  const read = <T>(what: string, run: (o: { signal: AbortSignal }) => Promise<T>) => settle(what, signal, run);

  // The project itself fails closed: without it there is no page.
  const project = (await untilAborted(listProjects(principal, { signal }), signal)).find((p) => p.id === projectId) ?? null;
  if (project === null) return null;

  const window = completionsWindow(now, tz);
  const stages = read("project stages", (o) => listProjectStages(principal, [project.id], o));
  const tasks = read("project tasks", (o) => listProjectTasksAllStates(principal, [project.id], o));
  const users = read("users", (o) => listUsers(principal, o));
  const departments = read("departments", (o) => listDepartments(principal, o));
  const clients = read("clients", (o) => listClients(principal, o));
  const settings = read("settings", () => loadSettings(principal.id));

  const liveTasks = tasks.then((t) => (t.ok ? t.value.filter((x) => !x.isDraft && x.deletedAt == null && x.status !== "rejected") : null));
  const waitingEntries = tasks.then((t) => {
    if (!t.ok) return { ok: false } as const;
    const waiting = t.value.filter((x) => isOpen(x) && x.status === "waiting_on_client").map((x) => x.id);
    return read("waiting entries", (o) => listStatusChangeEntries(principal, waiting, "waiting_on_client", o));
  });
  const extensions = liveTasks.then((live) =>
    live === null ? ({ ok: false } as const) : read("task extensions", (o) => listTaskExtensionsForTasks(principal, live.map((t) => t.id), o))
  );
  const transitions = liveTasks.then((live) =>
    live === null
      ? ({ ok: false } as const)
      : read("status transitions", (o) => listStatusTransitions(principal, live.map((t) => t.id), project.createdAt, o))
  );
  const approvals = liveTasks.then((live) =>
    live === null
      ? ({ ok: false } as const)
      : read("stage approvals", (o) =>
          listActivitySince(principal, project.createdAt, { taskIds: live.map((t) => t.id), actions: STAGE_CLOSE_GUARD_ACTIONS }, o)
        )
  );

  // The Overview's inputs for this project: its open tasks and its completions in the window.
  const health = (async (): Promise<ProjectHealth> => {
    const all = need(await tasks);
    const open = all.filter(isOpen);
    const from = Date.parse(window.fromIso);
    const to = Date.parse(window.toIso);
    const recent = all.filter((t) => {
      const at = t.completedAt === null ? Number.NaN : Date.parse(t.completedAt);
      return t.status === "done" && !t.isDraft && t.deletedAt == null && at >= from && at < to;
    });
    const entries = need(await waitingEntries);
    return projectHealth(project, need(await stages), mergeTaskReads(open, recent), now, {
      waitingSince: new Map(entries.map((e) => [e.taskId, e.enteredAt]))
    });
  })();
  health.catch(() => undefined);
  const derived = (async () => deriveProjectClient(need(await tasks), clientIdsByName(need(await clients))))();
  derived.catch(() => undefined);
  const stuck = (async () => stuckOf(need(await stages), need(await tasks)))();
  stuck.catch(() => undefined);

  const summary = build("summary", async () => ({ health: await health, derivedClient: await derived, stuck: await stuck }));

  const stagesSection = build("stages", async () => {
    const people = new Map(need(await users).map((u) => [u.id, u]));
    const depts = new Map(need(await departments).map((d) => [d.id, d]));
    return stageViews(need(await stages), need(await tasks), people, depts);
  });

  const delays = build("delays", async () => {
    const live = (await liveTasks) ?? inputFailed();
    const people = new Map(need(await users).map((u) => [u.id, u]));
    const overdue: OverdueTaskRow[] = live
      .filter((t) => isOverdue(t, now))
      .sort((a, b) => overdueDays(b, now) - overdueDays(a, now) || (a.id < b.id ? -1 : 1))
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        assigneeName: t.assigneeId === null ? null : (people.get(t.assigneeId)?.name ?? null),
        overdueDays: overdueDays(t, now),
        autoArchived: isAutoArchived(t),
        ref: ddTaskRef(t)
      }));
    const byTask = groupBy(need(await extensions), (e) => e.taskId);
    const liveById = new Map(live.map((t) => [t.id, t]));
    const rows: ExtensionRow[] = [];
    for (const [taskId, list] of byTask) {
      const task = liveById.get(taskId);
      // A first deadline set through "Extend" (no previous due date) isn't an extension (a-correct-13).
      const real = list.filter((e) => e.previousDueDate !== null).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (!task || real.length === 0) continue;
      const latest = real[real.length - 1];
      rows.push({
        taskId,
        title: task.title,
        assigneeName: task.assigneeId === null ? null : (people.get(task.assigneeId)?.name ?? null),
        count: real.length,
        latestAt: latest.createdAt,
        latestNewDue: latest.newDueDate,
        reDatedAfterDeadline: real.some((e) => Date.parse(e.createdAt) > Date.parse(e.previousDueDate as string)),
        ref: ddTaskRef(task)
      });
    }
    rows.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt) || (a.taskId < b.taskId ? -1 : 1));
    return { overdue, extensions: rows };
  });

  const blockers = build("blockers", async () => {
    const h = await health;
    const all = need(await tasks);
    const entries = new Map(need(await waitingEntries).map((e) => [e.taskId, e.enteredAt]));
    const waiting = all
      .filter((t) => isOpen(t) && t.status === "waiting_on_client")
      .map((t) => ({ task: t as DdTask, since: entries.get(t.id) ?? t.lastActivityAt, lowerBound: !entries.has(t.id) }));
    const derivedList = derivedBlockers(h, await stuck, waiting, now);
    const s = need(await settings);
    if (!s.ddtextSchemaReady) return { derived: derivedList, ai: [], aiState: "not_installed" as const };
    if (!s.ddtextEnabled) return { derived: derivedList, ai: [], aiState: "off" as const };
    const live = (await liveTasks) ?? inputFailed();
    const ai = await aiBlockers(principal, live, need(await users), now, signal);
    return { derived: derivedList, ai, aiState: "ok" as const };
  });

  const updates = build("updates", async () => {
    const userNames = new Map(need(await users).map((u) => [u.id, u.name]));
    return projectUpdateEvents({
      project,
      stages: need(await stages),
      tasks: need(await tasks),
      transitions: need(await transitions),
      approvals: need(await approvals),
      userNames,
      sinceIso: new Date(now.getTime() - UPDATE_DAYS * DAY_MS).toISOString(),
      now
    });
  });

  const meetingRisks = build("meeting risks", async () => {
    const client = await derived;
    if (client === null) return { state: "no_client" as const, rows: [] };
    const all = need(await tasks);
    const found = await untilAborted(
      listMeetingBriefRisks(
        principal,
        {
          clientId: client.clientId,
          taskIds: all.map((t) => t.id),
          sinceIso: new Date(now.getTime() - MEETING_RISK_DAYS * DAY_MS).toISOString(),
          limit: MEETING_RISK_LIMIT
        },
        { signal }
      ),
      signal
    );
    const rows: MeetingRiskRow[] = found.map((m) => ({
      meetingId: m.meetingId,
      title: m.title,
      meetingAt: m.meetingAt,
      risks: m.risks,
      matchedBy: m.matchedBy,
      basis: "ai",
      ref: ddClientRef({ id: m.clientId, name: m.clientId === client.clientId ? client.clientName : null })
    }));
    return { state: "ok" as const, rows };
  });

  const conversations = build("conversations", async () => {
    const s: ExecSettings = need(await settings);
    if (!s.emailSchemaReady) return { state: "not_installed" as const, rows: [], hiddenRestricted: 0 };
    if (!s.emailEnabled) return { state: "off" as const, rows: [], hiddenRestricted: 0 };
    // P3's gate (email-view loadEmailGate, L1): with no pinned mailbox email
    // intelligence doesn't run for him and every email surface shows nothing.
    if (pinnedAccounts(principal).length === 0) return { state: "off" as const, rows: [], hiddenRestricted: 0 };
    const client = await derived;
    if (client === null) return { state: "no_client" as const, rows: [], hiddenRestricted: 0 };
    let policy: { rules: Parameters<typeof screenStoredRow>[1]; hash: string };
    try {
      policy = await untilAborted(loadScreeningPolicy(principal, { signal }), signal);
    } catch (err) {
      console.error(`[exec-projects] screening policy unreadable for ${principal.id}: ${err instanceof Error ? err.name : "error"}`);
      return { state: "screen_unavailable" as const, rows: [], hiddenRestricted: 0 };
    }
    // Only rows of the mailboxes pinned to him now (P3's pinnedRows, ui-3): a
    // row of an unpinned mailbox is neither listed nor counted (its thread page 404s).
    const candidates = (await untilAborted(listBucketRows(principal, now, { signal }), signal)).filter(
      (r) => isPinnedAccount(principal, r.accountId) && r.clientId === client.clientId && (r.matchConfidence === "high" || r.matchConfidence === "medium")
    );
    const kept = candidates.filter((r) => screenStoredRow(r, policy.rules, policy.hash).verdict !== "restricted");
    const rows: ConversationRow[] = kept
      .map((r) => ({ r, last: laterIso(r.lastInboundAt, r.lastOutboundAt) }))
      .sort((a, b) => (b.last === null ? 0 : Date.parse(b.last)) - (a.last === null ? 0 : Date.parse(a.last)) || (a.r.threadId < b.r.threadId ? -1 : 1))
      .slice(0, MAX_CONVERSATIONS)
      .map(({ r, last }) => ({
        threadId: r.threadId,
        subject: clipSubject(r.subject),
        lastActivityAt: last,
        answered: r.answeredState,
        confidence: r.matchConfidence as ConversationRow["confidence"],
        ref: execEmailThreadRef(r.threadId)
      }));
    return { state: "ok" as const, rows, hiddenRestricted: candidates.length - kept.length };
  });

  const departmentName = (async () => {
    const d = await departments;
    if (!d.ok || project.departmentId === null) return null;
    return d.value.find((x) => x.id === project.departmentId)?.name ?? null;
  })();

  const [summaryS, stagesS, delaysS, blockersS, updatesS, risksS, conversationsS, deptName] = await Promise.all([
    summary,
    stagesSection,
    delays,
    blockers,
    updates,
    meetingRisks,
    conversations,
    departmentName
  ]);
  opts.signal?.throwIfAborted();
  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    project: { id: project.id, name: project.name, departmentName: deptName, createdAt: project.createdAt, ref: ddProjectRef(project) },
    summary: summaryS,
    stages: stagesS,
    delays: delaysS,
    blockers: blockersS,
    updates: updatesS,
    meetingRisks: risksS,
    conversations: conversationsS
  };
}

/**
 * Live AI-assessed blockers on the project's tasks (§3.12.5 liveness): the
 * stored signals of the last 14 days, kept while their task is open, its
 * mail isn't restricted (any withholding reason, an unscreenable one
 * included, hides it), a "waiting" task isn't waiting on the client now, and
 * a "decision" hasn't been answered by him on the task since. Only the
 * stored summary (≤200 characters) is shown, labelled AI-assessed. A failed
 * read throws (the section fails soft).
 */
async function aiBlockers(
  principal: ExecPrincipal,
  tasks: readonly DdProjectTask[],
  users: readonly DdUser[],
  now: Date,
  signal: AbortSignal
): Promise<AiBlocker[]> {
  if (tasks.length === 0) return [];
  const signals = await untilAborted(
    listLiveDdtextSignals(
      principal,
      { sinceIso: new Date(now.getTime() - DDTEXT_LIVE_DAYS * DAY_MS).toISOString(), taskIds: tasks.map((t) => t.id), kinds: AI_BLOCKER_KINDS },
      { signal }
    ),
    signal
  );
  const withSummary = signals.filter((s) => s.taskId !== null && typeof s.summary === "string" && s.summary !== "");
  if (withSummary.length === 0) return [];
  const taskIds = [...new Set(withSummary.map((s) => s.taskId as string))];
  const policy = await loadIntakeScreeningPolicy(principal, { signal });
  const withheld = await restrictedIntakeTaskIds(principal, taskIds, policy, { signal });

  let since = Number.POSITIVE_INFINITY;
  for (const s of withSummary) {
    const ms = Date.parse(s.sourceCreatedAt);
    if (ms < since) since = ms;
  }
  const activity = new Map<string, number>();
  if (Number.isFinite(since)) {
    const sinceIso = new Date(since).toISOString();
    const filter = { taskIds, userId: principal.userId };
    const [rows, messages] = await Promise.all([
      untilAborted(listActivitySince(principal, sinceIso, filter, { signal }), signal),
      untilAborted(listTaskMessagesSince(principal, sinceIso, filter, { signal }), signal)
    ]);
    for (const r of [...rows, ...messages]) {
      const ms = Date.parse(r.createdAt);
      if (!Number.isFinite(ms)) continue;
      const seen = activity.get(r.taskId);
      if (seen === undefined || ms > seen) activity.set(r.taskId, ms);
    }
  }
  const usersById = new Map(users.map((u) => [u.id, u]));
  const ctx = {
    principal: { userId: principal.userId, name: principal.name, timezone: principal.timezone },
    now,
    signals: withSummary,
    itemHashes: new Map<string, string>(),
    tasksById: new Map<string, DdTask>(tasks.map((t) => [t.id, t])),
    usersById,
    principalActivityByTask: activity,
    repliesByNote: new Map<string, number>(),
    liveP2bMentionTaskIds: new Set<string>(),
    withheldTaskIds: new Set(withheld.keys())
  };
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return withSummary
    .filter((s) => !withheld.has(s.taskId as string) && isLiveDdtextSignal(s, ctx))
    .sort((a, b) => Date.parse(b.sourceCreatedAt) - Date.parse(a.sourceCreatedAt))
    .slice(0, MAX_AI_BLOCKERS)
    .map((s) => {
      const task = taskById.get(s.taskId as string) as DdProjectTask;
      return {
        kind: s.kind as AiBlocker["kind"],
        summary: s.summary as string,
        authorName: usersById.get(s.authorUserId)?.name ?? null,
        at: s.sourceCreatedAt,
        basis: "ai" as const,
        ref: ddTaskRef(task)
      };
    });
}
