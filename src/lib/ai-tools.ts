import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getAllUsersLight, getUserById, getDepartments } from "@/lib/server-data";
import { userCapacity } from "@/lib/capacity";
import { listUserEvents } from "@/lib/google-calendar";
import { embedQuery } from "@/lib/sop-ingest";
import type { Task, User } from "@/lib/types";

// AI tool definitions + dispatchers. The Ask AI route hands these
// to Anthropic's tool-use API; the model picks which to call based
// on the user's question. Every handler runs server-side with the
// actor passed in, so access scoping (workers can't see leader
// tasks, etc.) is enforced by us, not the model.

export interface ToolContext {
  actor: User;
}

// Anthropic tool schema. Kept verbose-on-purpose: the description
// is the entire contract the model sees, so any nuance about "what
// counts as a match" / "default values" lives in there.
export const AI_TOOLS = [
  {
    name: "who_am_i",
    description:
      "Return the calling user's profile: id, name, email, role (leader / department_head / worker), and the departments they're in. Use this when the question depends on who's asking (e.g. 'what are my tasks').",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "search_tasks",
    description:
      "Search every task the caller is allowed to see. Filters are AND-ed. " +
      "`query` matches title + description (case-insensitive substring). " +
      "`status` is one of pending/in_progress/urgent/waiting_on_client/done. " +
      "`assigneeName` fuzzy-matches a person; resolve full names if you can. " +
      "`dueBeforeISO` is an ISO timestamp — returns tasks due strictly before that. " +
      "`projectId` and `departmentId` are exact ids. " +
      "`limit` caps results (default 20, max 50). " +
      "Workers and dept heads don't see tasks owned by leaders here — that filter is server-enforced.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "urgent", "waiting_on_client", "done"]
        },
        assigneeName: { type: "string" },
        assigneeId: { type: "string" },
        dueBeforeISO: { type: "string" },
        projectId: { type: "string" },
        departmentId: { type: "string" },
        includeDone: { type: "boolean", description: "default false" },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "get_task",
    description:
      "Fetch one task by id with the full set of fields: title, description, status, priority, hours, dates, client, project, assignee + creator names, last activity, and the most recent activity log entries.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "list_people",
    description:
      "List people in the org. Filter by role (leader / department_head / worker) or departmentId. Each result has id, name, email, role, departments.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["leader", "department_head", "worker"] },
        departmentId: { type: "string" },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "find_user_by_name",
    description:
      "Fuzzy lookup of a person by name. Returns the single best match (or null) with their id, name, role, and department ids. Use this before search_tasks if the user mentions someone by name and you need their id.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"]
    }
  },
  {
    name: "list_departments",
    description:
      "Return every department with id, name, and the ids of its members + heads.",
    input_schema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "list_clients",
    description:
      "Return every client with id, name, website (domain), priority, and the count of currently-open tasks linked to them.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: []
    }
  },
  {
    name: "get_client",
    description:
      "Detail for one client: name, website, priority, notes, plus open tasks, completed tasks (recent), and the count of related email threads visible to the caller.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "list_client_completed_tasks",
    description:
      "Build a historical knowledge base of work this agency has shipped for a client. Returns completed tasks newest first, each with title + description (the actual record of what was done) + tags + who completed it. Use this when the user asks 'what have we done for X?', 'what work has been completed for X in the last year?', or 'summarize our history with X'. Resolve a client by `clientName` (fuzzy match against clients.name) or `clientId` (exact id). Optional: `sinceDays` (omit or pass 0 for the default 365-day window), `limit` (default 50, max 200).",
    input_schema: {
      type: "object",
      properties: {
        clientName: { type: "string" },
        clientId: { type: "string" },
        sinceDays: { type: "number" },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "list_projects",
    description:
      "List projects. Optional departmentId filter. Each result has id, name, description, departmentId, stage count, and the active stage's name.",
    input_schema: {
      type: "object",
      properties: {
        departmentId: { type: "string" },
        query: { type: "string" }
      },
      required: []
    }
  },
  {
    name: "get_project",
    description:
      "Detail for one project: stages with their status (locked/active/done), the tasks in each stage, and overall progress.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "get_capacity",
    description:
      "Compute someone's capacity: used hours today, backlog hours, available hours, daily capacity, and over-buffer flag. Defaults to the caller if userId is omitted. Helpful when ranking who to assign work to.",
    input_schema: {
      type: "object",
      properties: { userId: { type: "string" } },
      required: []
    }
  },
  {
    name: "get_my_calendar",
    description:
      "Return the caller's upcoming Google Calendar events from now to +days (default 7, max 30). Returns null when the caller hasn't connected Google in Settings.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number" } },
      required: []
    }
  },
  {
    name: "list_recent_kudos",
    description:
      "Recent kudos messages with from/to names + the emoji + the message body. Limit defaults to 20.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number" }, limit: { type: "number" } },
      required: []
    }
  },
  {
    name: "list_recent_incidents",
    description: "Recent incident reports — what blew up and who owned the fix.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number" } },
      required: []
    }
  },
  {
    name: "list_recent_eod_notes",
    description:
      "End-of-day notes people wrote in the last N days (default 7). Returns who, when, and the note text.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number" } },
      required: []
    }
  },
  {
    name: "list_recommendations",
    description:
      "Employee-of-the-Month recommendations (movies, albums, games, etc.) newest first.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } },
      required: []
    }
  },
  {
    name: "search_sops",
    description:
      "Semantic search across the company's uploaded SOPs (Standard Operating Procedures). " +
      "Use this whenever the user is asking how to do something procedural — onboarding steps, " +
      "where to find a tool, how to handle a recurring scenario, etc. Returns the top matching " +
      "chunks, each with the SOP's title, the chunk text, and (when the chunk came from a " +
      "captioned image) an image URL you can cite back to the user. If results don't look " +
      "relevant to the question, say so honestly instead of stretching a poor match into an answer.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's how-do-I question, rephrased as a search query." },
        limit: { type: "number", description: "How many chunks to return (default 5, max 10)." }
      },
      required: ["query"]
    }
  },
  {
    name: "create_task",
    description:
      "Create a new task and assign it. Use this when the user says something like 'make a task for X to do Y' or 'add a task'. " +
      "Required: title + assigneeId (resolve names to ids with find_user_by_name first). " +
      "Optional: description (Markdown is fine), priority (low/medium/high/critical, default medium), departmentId, estimatedHours (default 2), dueDateISO, tags, clientName. " +
      "Returns { taskId, url }. " +
      "Permissions: leaders/admins can assign to anyone; department heads can assign to anyone in their departments; workers can only create tasks for themselves. Trying to assign outside scope returns an error.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        assigneeId: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        departmentId: { type: "string" },
        estimatedHours: { type: "number" },
        dueDateISO: { type: "string", description: "ISO datetime; omit for auto-computed" },
        tags: { type: "array", items: { type: "string" } },
        clientName: { type: "string" }
      },
      required: ["title", "assigneeId"]
    }
  }
] as const;

export type ToolName = (typeof AI_TOOLS)[number]["name"];

// Dispatcher — narrow per name, run the right handler. Wrapped in
// try/catch so a tool exception becomes a tool_result error string
// rather than crashing the whole turn.
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  try {
    switch (name) {
      case "who_am_i": return whoAmI(ctx);
      case "search_tasks": return searchTasks(input, ctx);
      case "get_task": return getTask(input, ctx);
      case "list_people": return listPeople(input, ctx);
      case "find_user_by_name": return findUserByName(input, ctx);
      case "list_departments": return listDepartments();
      case "list_clients": return listClients(input);
      case "get_client": return getClient(input, ctx);
      case "list_client_completed_tasks": return listClientCompletedTasks(input);
      case "list_projects": return listProjects(input);
      case "get_project": return getProject(input);
      case "get_capacity": return getCapacity(input, ctx);
      case "get_my_calendar": return getMyCalendar(input, ctx);
      case "list_recent_kudos": return listRecentKudos(input);
      case "list_recent_incidents": return listRecentIncidents(input);
      case "list_recent_eod_notes": return listRecentEodNotes(input);
      case "list_recommendations": return listRecommendations(input);
      case "search_sops": return searchSops(input);
      case "create_task": return createTask(input, ctx);
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ----- handlers -----

function whoAmI(ctx: ToolContext) {
  return {
    id: ctx.actor.id,
    name: ctx.actor.name,
    email: ctx.actor.email,
    role: ctx.actor.role,
    departmentIds: ctx.actor.departmentIds
  };
}

// Cache of leader ids so worker filtering doesn't fan out to a query
// per task call within one turn.
async function leaderIdSet(): Promise<Set<string>> {
  const { data } = await getSupabaseAdmin()
    .from("users")
    .select("id")
    .eq("role", "leader");
  return new Set((data ?? []).map((u: { id: string }) => u.id as string));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

async function searchTasks(input: Record<string, unknown>, ctx: ToolContext) {
  const tasks = await getAllTasks();
  const users = await getAllUsersLight();
  const userById = new Map(users.map((u) => [u.id, u]));
  const userByName = new Map<string, User>();
  for (const u of users) userByName.set(norm(u.name), u);

  const limit = clampNumber(input.limit, 1, 50, 20);

  // Resolve assigneeName → id if needed.
  let assigneeId = typeof input.assigneeId === "string" ? input.assigneeId : null;
  if (!assigneeId && typeof input.assigneeName === "string") {
    const q = norm(input.assigneeName);
    let best: User | null = null;
    let bestScore = 0;
    for (const [n, u] of userByName) {
      let score = 0;
      if (n === q) score = 100;
      else if (n.includes(q) || q.includes(n)) score = 60;
      else {
        const overlap = q.split(" ").filter((w) => w && n.includes(w)).length;
        if (overlap > 0) score = 40;
      }
      if (score > bestScore) { bestScore = score; best = u; }
    }
    if (best && bestScore >= 40) assigneeId = best.id;
  }

  const status = typeof input.status === "string" ? input.status : null;
  const projectId = typeof input.projectId === "string" ? input.projectId : null;
  const departmentId = typeof input.departmentId === "string" ? input.departmentId : null;
  const includeDone = !!input.includeDone;
  const queryStr = typeof input.query === "string" ? norm(input.query) : null;
  const dueBeforeMs = typeof input.dueBeforeISO === "string"
    ? new Date(input.dueBeforeISO).getTime()
    : null;

  // Access filter (mirrors /api/tasks GET):
  //   leader sees everything; everyone else sees tasks that aren't
  //   created/assigned by a leader, plus their own assignments.
  const actorIsLeader = ctx.actor.role === "leader" || ctx.actor.isAdmin === true;
  const leaderIds = actorIsLeader ? new Set<string>() : await leaderIdSet();

  const filtered = tasks.filter((t) => {
    if (!actorIsLeader) {
      if (t.assigneeId === ctx.actor.id || t.creatorId === ctx.actor.id) {
        // own work — always visible
      } else if (t.assigneeId && leaderIds.has(t.assigneeId)) return false;
      else if (t.creatorId && leaderIds.has(t.creatorId)) return false;
    }
    if (!includeDone && t.status === "done") return false;
    if (status && t.status !== status) return false;
    if (assigneeId && t.assigneeId !== assigneeId) return false;
    if (projectId && t.projectId !== projectId) return false;
    if (departmentId && t.departmentId !== departmentId) return false;
    if (queryStr) {
      const hay = norm(`${t.title} ${t.description ?? ""}`);
      if (!hay.includes(queryStr)) return false;
    }
    if (dueBeforeMs != null) {
      if (!t.dueDate || new Date(t.dueDate).getTime() >= dueBeforeMs) return false;
    }
    return true;
  });

  // Light projection — no need to send every column.
  return filtered.slice(0, limit).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    estimatedHours: t.estimatedHours,
    dueDate: t.dueDate,
    assigneeId: t.assigneeId,
    assigneeName: t.assigneeId ? (userById.get(t.assigneeId)?.name ?? null) : null,
    creatorId: t.creatorId,
    creatorName: userById.get(t.creatorId)?.name ?? null,
    departmentId: t.departmentId,
    projectId: t.projectId,
    clientName: t.clientName,
    inactiveFlag: t.inactiveFlag,
    lastActivityAt: t.lastActivityAt
  }));
}

async function getTask(input: Record<string, unknown>, ctx: ToolContext) {
  const id = String(input.id ?? "");
  if (!id) return { error: "id required" };
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { error: "not found" };
  // Access gate for non-leaders.
  if (ctx.actor.role !== "leader" && !ctx.actor.isAdmin) {
    const leaderIds = await leaderIdSet();
    if (
      row.assignee_id !== ctx.actor.id &&
      row.creator_id !== ctx.actor.id &&
      ((row.assignee_id && leaderIds.has(row.assignee_id as string)) ||
       (row.creator_id && leaderIds.has(row.creator_id as string)))
    ) {
      return { error: "access denied" };
    }
  }
  const [{ data: assignee }, { data: creator }, { data: log }] = await Promise.all([
    row.assignee_id
      ? supabase.from("users").select("id, name, email").eq("id", row.assignee_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("users").select("id, name, email").eq("id", row.creator_id).maybeSingle(),
    supabase
      .from("activity_logs")
      .select("action, detail, created_at, user_id")
      .eq("task_id", id)
      .order("created_at", { ascending: false })
      .limit(10)
  ]);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estimatedHours: row.estimated_hours,
    actualHours: row.actual_hours,
    dueDate: row.due_date,
    tags: row.tags,
    clientName: row.client_name,
    departmentId: row.department_id,
    projectId: row.project_id,
    assignee: assignee ?? null,
    creator: creator ?? null,
    activity: log ?? []
  };
}

async function listPeople(input: Record<string, unknown>, _ctx: ToolContext) {
  const role = typeof input.role === "string" ? input.role : null;
  const departmentId = typeof input.departmentId === "string" ? input.departmentId : null;
  const limit = clampNumber(input.limit, 1, 100, 50);
  const supabase = getSupabaseAdmin();
  const { data: users } = await supabase
    .from("users")
    .select("id, name, email, role, presence, status_emoji");
  const { data: members } = await supabase
    .from("department_members")
    .select("user_id, department_id");
  const deptsByUser = new Map<string, string[]>();
  for (const m of (members ?? []) as { user_id: string; department_id: string }[]) {
    const arr = deptsByUser.get(m.user_id) ?? [];
    arr.push(m.department_id);
    deptsByUser.set(m.user_id, arr);
  }
  const out = (users ?? [])
    .map((u) => ({
      id: u.id as string,
      name: u.name as string,
      email: u.email as string,
      role: u.role as string,
      presence: u.presence as string | null,
      statusEmoji: u.status_emoji as string | null,
      departmentIds: deptsByUser.get(u.id as string) ?? []
    }))
    .filter((u) => !role || u.role === role)
    .filter((u) => !departmentId || u.departmentIds.includes(departmentId))
    .slice(0, limit);
  return out;
}

async function findUserByName(input: Record<string, unknown>, ctx: ToolContext) {
  const name = String(input.name ?? "").trim();
  if (!name) return { error: "name required" };
  const all = await getAllUsersLight();
  const q = norm(name);
  let best: User | null = null;
  let bestScore = 0;
  for (const u of all) {
    const n = norm(u.name);
    let score = 0;
    if (n === q) score = 100;
    else if (n.includes(q) || q.includes(n)) score = 70;
    else {
      const overlap = q.split(" ").filter((w) => w && n.includes(w)).length;
      if (overlap > 0) score = 40 + overlap * 10;
    }
    if (score > bestScore) { bestScore = score; best = u; }
  }
  if (!best || bestScore < 40) return null;
  return {
    id: best.id,
    name: best.name,
    email: best.email,
    role: best.role,
    departmentIds: best.departmentIds,
    matchScore: bestScore
  };
  void ctx;
}

async function listDepartments() {
  const depts = await getDepartments();
  const supabase = getSupabaseAdmin();
  const { data: members } = await supabase
    .from("department_members")
    .select("user_id, department_id");
  const usersByDept = new Map<string, string[]>();
  for (const m of (members ?? []) as { user_id: string; department_id: string }[]) {
    const arr = usersByDept.get(m.department_id) ?? [];
    arr.push(m.user_id);
    usersByDept.set(m.department_id, arr);
  }
  return depts.map((d) => ({
    id: d.id,
    name: d.name,
    memberIds: usersByDept.get(d.id) ?? []
  }));
}

async function listClients(input: Record<string, unknown>) {
  const q = typeof input.query === "string" ? norm(input.query) : null;
  const supabase = getSupabaseAdmin();
  const [{ data: clients }, { data: tasks }] = await Promise.all([
    supabase.from("clients").select("id, name, website, priority, notes"),
    supabase
      .from("tasks")
      .select("client_name, status")
      .not("client_name", "is", null)
  ]);
  const openByClientName = new Map<string, number>();
  for (const t of (tasks ?? []) as { client_name: string; status: string }[]) {
    if (t.status === "done") continue;
    openByClientName.set(t.client_name, (openByClientName.get(t.client_name) ?? 0) + 1);
  }
  return (clients ?? [])
    .filter((c) => !q || norm(`${c.name} ${c.website ?? ""}`).includes(q))
    .map((c) => ({
      id: c.id,
      name: c.name,
      website: c.website,
      priority: c.priority,
      notes: c.notes,
      openTaskCount: openByClientName.get(c.name as string) ?? 0
    }));
}

async function getClient(input: Record<string, unknown>, _ctx: ToolContext) {
  const id = String(input.id ?? "");
  if (!id) return { error: "id required" };
  const supabase = getSupabaseAdmin();
  const { data: client } = await supabase
    .from("clients").select("*").eq("id", id).maybeSingle();
  if (!client) return { error: "not found" };
  const [{ data: openTasks }, { data: doneTasks }] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .eq("client_name", client.name)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .limit(15),
    supabase
      .from("tasks")
      .select("id, title, last_activity_at")
      .eq("client_name", client.name)
      .eq("status", "done")
      .order("last_activity_at", { ascending: false })
      .limit(10)
  ]);
  return {
    id: client.id,
    name: client.name,
    website: client.website,
    priority: client.priority,
    notes: client.notes,
    openTasks: openTasks ?? [],
    recentlyCompletedTasks: doneTasks ?? []
  };
}

// Knowledge-base lookup over a client's completed tasks. Same source as
// the page-rendered "Knowledge base · completed work" section, but
// pre-filtered by date and shaped for AI consumption (descriptions are
// included, completedBy is joined in). Caller is expected to resolve
// the client by name or id; ambiguous names return an error so the AI
// can disambiguate with the user instead of guessing.
async function listClientCompletedTasks(input: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  let clientName: string | null = typeof input.clientName === "string" ? input.clientName : null;
  let clientId: string | null = typeof input.clientId === "string" ? input.clientId : null;

  // Resolve clientId → name (tasks table joins by client_name, not id).
  if (!clientName && clientId) {
    const { data: c } = await supabase
      .from("clients").select("name").eq("id", clientId).maybeSingle();
    if (!c) return { error: "client not found" };
    clientName = c.name as string;
  }

  // Resolve a fuzzy name → exact name. ilike on clients.name so common
  // variants resolve. Multiple matches surface as candidates so the AI
  // can disambiguate with the user rather than guess.
  if (clientName) {
    const { data: matches } = await supabase
      .from("clients").select("id, name").ilike("name", `%${clientName}%`).limit(5);
    const rows = (matches ?? []) as { id: string; name: string }[];
    if (rows.length === 0) return { error: `no client matches "${clientName}"` };
    if (rows.length > 1) {
      const exact = rows.find((r) => r.name.toLowerCase() === clientName!.toLowerCase());
      if (exact) {
        clientName = exact.name;
        clientId = exact.id;
      } else {
        return {
          error: `ambiguous client "${clientName}"`,
          candidates: rows.map((r) => ({ id: r.id, name: r.name }))
        };
      }
    } else {
      clientName = rows[0].name;
      clientId = rows[0].id;
    }
  }

  if (!clientName) return { error: "clientName or clientId required" };

  const rawLimit = typeof input.limit === "number" ? input.limit : 50;
  const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)));
  // sinceDays = 0 or omitted → default 365-day window. Pass a number
  // > 0 to override; pass a very large value (e.g. 36500) when the
  // user explicitly wants the whole history.
  const rawSince = typeof input.sinceDays === "number" ? input.sinceDays : 365;
  const sinceDays = rawSince > 0 ? Math.floor(rawSince) : 365;
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, description, priority, last_activity_at, tags, assignee_id")
    .eq("client_name", clientName)
    .eq("status", "done")
    .gte("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: false })
    .limit(limit);
  const rows = (tasks ?? []) as Array<{
    id: string; title: string; description: string | null;
    priority: string | null; last_activity_at: string;
    tags: string[] | null; assignee_id: string | null;
  }>;

  // Join assignee names once so the AI can attribute work without
  // a second round-trip per task.
  const assigneeIds = Array.from(new Set(rows.map((r) => r.assignee_id).filter((id): id is string => !!id)));
  let nameById = new Map<string, string>();
  if (assigneeIds.length > 0) {
    const { data: users } = await supabase
      .from("users").select("id, name").in("id", assigneeIds);
    nameById = new Map(((users ?? []) as { id: string; name: string }[]).map((u) => [u.id, u.name]));
  }

  return {
    clientId,
    clientName,
    sinceDays,
    count: rows.length,
    tasks: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      completedAt: r.last_activity_at,
      completedBy: r.assignee_id ? (nameById.get(r.assignee_id) ?? null) : null,
      tags: r.tags ?? []
    }))
  };
}

async function listProjects(input: Record<string, unknown>) {
  const departmentId = typeof input.departmentId === "string" ? input.departmentId : null;
  const q = typeof input.query === "string" ? norm(input.query) : null;
  const supabase = getSupabaseAdmin();
  const [{ data: projects }, { data: stages }] = await Promise.all([
    supabase.from("projects").select("id, name, description, department_id"),
    supabase.from("project_stages").select("project_id, name, status, position")
  ]);
  const stagesByProject = new Map<string, { name: string; status: string; position: number }[]>();
  for (const s of (stages ?? []) as { project_id: string; name: string; status: string; position: number }[]) {
    const arr = stagesByProject.get(s.project_id) ?? [];
    arr.push({ name: s.name, status: s.status, position: s.position });
    stagesByProject.set(s.project_id, arr);
  }
  return (projects ?? [])
    .filter((p) => !departmentId || p.department_id === departmentId)
    .filter((p) => !q || norm(`${p.name} ${p.description ?? ""}`).includes(q))
    .map((p) => {
      const sList = (stagesByProject.get(p.id as string) ?? []).sort((a, b) => a.position - b.position);
      const active = sList.find((s) => s.status === "active");
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        departmentId: p.department_id,
        stageCount: sList.length,
        activeStage: active?.name ?? null
      };
    });
}

async function getProject(input: Record<string, unknown>) {
  const id = String(input.id ?? "");
  if (!id) return { error: "id required" };
  const supabase = getSupabaseAdmin();
  const [{ data: project }, { data: stages }, { data: tasks }] = await Promise.all([
    supabase.from("projects").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("project_stages")
      .select("id, name, status, position, kind")
      .eq("project_id", id)
      .order("position"),
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date, stage_id, assignee_id")
      .eq("project_id", id)
  ]);
  if (!project) return { error: "not found" };
  const tasksByStage = new Map<string, unknown[]>();
  for (const t of tasks ?? []) {
    const sid = (t.stage_id as string) ?? "unstaged";
    const arr = tasksByStage.get(sid) ?? [];
    arr.push(t);
    tasksByStage.set(sid, arr);
  }
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    departmentId: project.department_id,
    stages: (stages ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      position: s.position,
      tasks: tasksByStage.get(s.id as string) ?? []
    })),
    unstagedTasks: tasksByStage.get("unstaged") ?? []
  };
}

async function getCapacity(input: Record<string, unknown>, ctx: ToolContext) {
  const userId = typeof input.userId === "string" && input.userId ? input.userId : ctx.actor.id;
  const user = await getUserById(userId);
  if (!user) return { error: "user not found" };
  const tasks = await getAllTasks();
  const open = tasks.filter((t: Task) => t.assigneeId === userId && t.status !== "done");
  const cap = userCapacity(user, open);
  return {
    userId,
    userName: user.name,
    dailyCapacityHours: user.dailyCapacity,
    usedHours: cap.usedHours,
    backlogHours: cap.backlogHours,
    availableHours: cap.available,
    pctUsed: Math.round(cap.pct * 100),
    overBuffer: cap.overBuffer,
    openTaskCount: open.length
  };
}

async function getMyCalendar(input: Record<string, unknown>, ctx: ToolContext) {
  const days = clampNumber(input.days, 1, 30, 7);
  try {
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
    const events = await listUserEvents({
      userId: ctx.actor.id,
      timeMin,
      timeMax,
      maxResults: 50
    });
    return events.map((e) => ({
      id: e.id,
      summary: e.summary,
      startISO: e.start.dateTime ?? e.start.date,
      endISO: e.end.dateTime ?? e.end.date,
      location: e.location,
      attendees: e.attendees.map((a) => a.email)
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not connected")) {
      return { connected: false, note: "Caller hasn't connected Google in Settings." };
    }
    return { error: msg };
  }
}

async function listRecentKudos(input: Record<string, unknown>) {
  const days = clampNumber(input.days, 1, 90, 30);
  const limit = clampNumber(input.limit, 1, 50, 20);
  const sinceISO = new Date(Date.now() - days * 86_400_000).toISOString();
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("kudos")
    .select("id, message, emoji, created_at, from_user_id, to_user_id")
    .gte("created_at", sinceISO)
    .order("created_at", { ascending: false })
    .limit(limit);
  const userIds = Array.from(new Set(
    (data ?? []).flatMap((k) => [k.from_user_id, k.to_user_id] as string[]).filter(Boolean)
  ));
  const { data: users } = await supabase
    .from("users")
    .select("id, name")
    .in("id", userIds.length ? userIds : ["_none_"]);
  const nameById = new Map(((users ?? []) as { id: string; name: string }[]).map((u) => [u.id, u.name]));
  return (data ?? []).map((k) => ({
    id: k.id,
    message: k.message,
    emoji: k.emoji,
    createdAt: k.created_at,
    fromName: nameById.get(k.from_user_id as string) ?? null,
    toName: nameById.get(k.to_user_id as string) ?? null
  }));
}

async function listRecentIncidents(input: Record<string, unknown>) {
  const days = clampNumber(input.days, 1, 90, 30);
  const sinceISO = new Date(Date.now() - days * 86_400_000).toISOString();
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("incidents")
    .select("id, kind, url, owner_id, status, created_at, resolved_at")
    .gte("created_at", sinceISO)
    .order("created_at", { ascending: false })
    .limit(20);
  return data ?? [];
}

async function listRecentEodNotes(input: Record<string, unknown>) {
  const days = clampNumber(input.days, 1, 30, 7);
  const sinceISO = new Date(Date.now() - days * 86_400_000).toISOString();
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("eod_notes")
    .select("id, user_id, body, created_at")
    .gte("created_at", sinceISO)
    .order("created_at", { ascending: false })
    .limit(40);
  const userIds = Array.from(new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id)));
  const { data: users } = await supabase
    .from("users")
    .select("id, name")
    .in("id", userIds.length ? userIds : ["_none_"]);
  const nameById = new Map(((users ?? []) as { id: string; name: string }[]).map((u) => [u.id, u.name]));
  return (data ?? []).map((n) => ({
    id: n.id,
    userName: nameById.get(n.user_id as string) ?? null,
    body: n.body,
    createdAt: n.created_at
  }));
}

async function listRecommendations(input: Record<string, unknown>) {
  const limit = clampNumber(input.limit, 1, 30, 10);
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("eom_recommendations")
    .select("id, user_id, kind, title, subtitle, body, external_url, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  const userIds = Array.from(new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id)));
  const { data: users } = await supabase
    .from("users")
    .select("id, name")
    .in("id", userIds.length ? userIds : ["_none_"]);
  const nameById = new Map(((users ?? []) as { id: string; name: string }[]).map((u) => [u.id, u.name]));
  return (data ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    subtitle: r.subtitle,
    body: r.body,
    externalUrl: r.external_url,
    byName: nameById.get(r.user_id as string) ?? null,
    createdAt: r.created_at
  }));
}

function clampNumber(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ----- create_task tool -----
//
// Agentic affordance: the AI can actually file a task now. Mirrors the
// permission model of POST /api/tasks (leaders/admins → anyone; dept
// heads → their own departments; workers → self only). Reuses the
// same deadline-from-estimate helper so auto-due-dates match what the
// New Task form would produce.

async function createTask(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const assigneeId = typeof input.assigneeId === "string" ? input.assigneeId.trim() : "";
  if (!title) return { error: "title required" };
  if (!assigneeId) return { error: "assigneeId required (use find_user_by_name first if you only have a name)" };

  const supabase = getSupabaseAdmin();

  // Permission gate. Pull the assignee + actor's scope; same model
  // as canCreateTasksForOthers + assignableTargets() use.
  const [assignee, allUsers] = await Promise.all([
    getUserById(assigneeId),
    getAllUsersLight()
  ]);
  if (!assignee) return { error: "assigneeId not found" };

  const actor = ctx.actor;
  const actorIsLeader = actor.role === "leader" || actor.isAdmin === true;
  if (!actorIsLeader) {
    if (actor.role === "department_head") {
      const overlap = (assignee.departmentIds ?? []).some((d) =>
        (actor.departmentIds ?? []).includes(d)
      );
      const self = assignee.id === actor.id;
      if (!overlap && !self) {
        return { error: `Department heads can only assign within their own departments. ${assignee.name} isn't in any of yours.` };
      }
    } else {
      if (assignee.id !== actor.id) {
        return { error: "Workers can only create tasks for themselves." };
      }
    }
  }
  // Silence unused warnings — we may want to do a cross-user
  // departmentIds lookup later via allUsers.
  void allUsers;

  // Coerce/validate the rest.
  const description = typeof input.description === "string" ? input.description : "";
  const priority = (() => {
    const p = typeof input.priority === "string" ? input.priority : "medium";
    return ["low", "medium", "high", "critical"].includes(p) ? p : "medium";
  })();
  const estimatedHours =
    typeof input.estimatedHours === "number" && input.estimatedHours > 0
      ? input.estimatedHours
      : 2;
  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t: unknown): t is string => typeof t === "string")
    : [];
  const clientName = typeof input.clientName === "string" ? input.clientName.trim() || null : null;
  const departmentId =
    typeof input.departmentId === "string" && input.departmentId
      ? input.departmentId
      : assignee.departmentIds[0] ?? null;

  // Due date — caller-provided wins; otherwise compute from estimate
  // + assignee's schedule. Same helper the form uses.
  const { deadlineFromEstimate } = await import("@/lib/capacity");
  const dueDate =
    typeof input.dueDateISO === "string" && input.dueDateISO
      ? new Date(input.dueDateISO).toISOString()
      : deadlineFromEstimate(estimatedHours, assignee);

  const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("tasks")
    .insert({
      id,
      title,
      description: description.trim() || null,
      status: "pending",
      priority,
      estimated_hours: estimatedHours,
      actual_hours: 0,
      tags,
      department_id: departmentId,
      assignee_id: assignee.id,
      creator_id: actor.id,
      project_id: null,
      due_date: dueDate,
      inactive_flag: false,
      last_activity_at: now,
      created_at: now,
      blocks_task_ids: [],
      client_name: clientName,
      website: null,
      custom: {}
    });
  if (error) return { error: error.message };

  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: id,
    user_id: actor.id,
    action: "created",
    detail: `Created by Ask AI → assigned to ${assignee.name}`
  });

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return {
    taskId: id,
    url: baseUrl ? `${baseUrl}/tasks/${id}` : `/tasks/${id}`,
    assignedTo: assignee.name,
    dueDate
  };
}

// Vector-search the SOP library. Embeds the user's question, calls the
// search_sop_chunks pgvector RPC, and returns the top chunks ready for
// the model to cite. Distance is included so the model can decide when
// matches are too weak to trust.
async function searchSops(input: Record<string, unknown>) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { error: "query required" };
  const limit = Math.min(10, Math.max(1, Number(input.limit) || 5));

  let embedding: number[];
  try {
    embedding = await embedQuery(query);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "embed failed" };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("search_sop_chunks", {
    query_embedding: `[${embedding.join(",")}]`,
    match_limit: limit
  });
  if (error) {
    if (/function .* does not exist/i.test(error.message) || /relation .* does not exist/i.test(error.message)) {
      return { results: [], note: "SOP search not yet provisioned — no migration run." };
    }
    return { error: error.message };
  }

  const results = ((data ?? []) as Array<{
    chunk_id: string;
    sop_id: string;
    title: string;
    source_filename: string;
    chunk_position: number;
    content: string;
    image_url: string | null;
    file_url: string;
    distance: number;
  }>).map((r) => ({
    sopId: r.sop_id,
    title: r.title,
    sourceFilename: r.source_filename,
    chunkPosition: r.chunk_position,
    content: r.content,
    imageUrl: r.image_url,
    fileUrl: r.file_url,
    // 0 = identical, 2 = opposite. Anything past ~0.5 is "loose match
    // territory" with text-embedding-3-small; >0.8 is usually noise.
    distance: Number(r.distance.toFixed(4))
  }));

  return { results };
}


