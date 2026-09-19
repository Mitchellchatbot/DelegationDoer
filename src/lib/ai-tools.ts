import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllTasks, getAllUsersLight, getUserById, getDepartments, getLeaderIds } from "@/lib/server-data";
import { canViewTaskScopedToDepartment, isOwner } from "@/lib/access";
import { getStripeRevenue } from "@/lib/stripe";
import { addMemory, forgetMemory } from "@/lib/brain-memory";
import type { ParsedPnl } from "@/lib/pnl-parse";
import { TEAM_TAG, stripTeamTag } from "@/lib/task-team";
import { userCapacity } from "@/lib/capacity";
import { listUserEvents } from "@/lib/google-calendar";
import { embedQuery } from "@/lib/sop-ingest";
import { coerceMeetingBrief } from "@/lib/meeting-brief";
import { listLabels, listThreads, getThread, listAccounts } from "@/lib/missive-client";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { rankCandidates, buildLoadSignals } from "@/lib/skill-rank";
import { getOutboundBoard } from "@/lib/outbound-board";
import { getOutboundMeta, metaDays } from "@/lib/outbound-meta";
import { getScaleSources } from "@/lib/scale-sources";
import type { Task, User } from "@/lib/types";

// AI tool definitions + dispatchers. The Ask AI route hands these
// to Anthropic's tool-use API; the model picks which to call based
// on the user's question. Every handler runs server-side with the
// actor passed in, so access scoping (workers can't see leader
// tasks, etc.) is enforced by us, not the model.

// Structured "action card" the assistant can emit alongside its text
// answer. The chat route bundles every ProposedAction into the response
// so the drawer can render inline buttons (Create task, Open thread,
// etc.) under the relevant assistant turn. Tools push onto
// `ctx.proposals` instead of mutating anything — the user is always
// the one who commits the action.
export type ProposedAction =
  | {
      kind: "create_task";
      id: string;
      title: string;
      description: string;
      priority?: "low" | "medium" | "high" | "critical";
      clientName?: string | null;
      sourceLabel?: string | null;       // e.g. "From: Allocation Assist email"
      sourceUrl?: string | null;         // deep-link to the source thread, if any
      suggestedAssignees: {
        userId: string;
        name: string;
        score: number;
        topReasons: string[];            // ranker factor labels (top 2)
        capacityPct: number;
      }[];
    }
  | {
      // Owner-only: a drafted NEW email staged for one-click send. Nothing
      // sends until Mitchell clicks Send on the card.
      kind: "send_email";
      id: string;
      to: string;
      subject: string;
      body: string;
      purpose?: string | null; // one-line why, shown on the card
    };

export interface ToolContext {
  actor: User;
  // Tools push onto this when they want to surface a structured UI
  // action under the assistant's reply. Initialized fresh per request
  // by /api/ai/chat — never persisted, never global.
  proposals: ProposedAction[];
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
      "Visibility is server-enforced and cannot be bypassed: leaders/admins see everything; workers and dept heads see only their own work plus tasks in their own department(s), and never tasks owned by leaders. Counts/aggregations you build from this are therefore already scoped to the caller's team — don't claim org-wide totals for a non-leader.",
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
      "Fetch one task by id with the full set of fields: title, description, status, priority, hours, dates, client, project, assignee + creator names, last activity, and the most recent activity log entries. Returns 'access denied' if the caller isn't allowed to see this task (a non-leader can only open their own work or tasks in their own department).",
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
      "Detail for one client: name, website, priority, notes, plus open tasks and recent completed tasks. The task lists are scoped server-side to the caller's department(s) (leaders see all), so a non-leader only sees their own team's work on this client — don't present them as the client's complete task list for a non-leader.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "list_client_completed_tasks",
    description:
      "Build a historical knowledge base of work this agency has shipped for a client. Returns completed tasks newest first, each with title + description (the actual record of what was done) + tags + who completed it. Use this when the user asks 'what have we done for X?', 'what work has been completed for X in the last year?', or 'summarize our history with X'. Resolve a client by `clientName` (fuzzy match against clients.name) or `clientId` (exact id). Optional: `sinceDays` (omit or pass 0 for the default 365-day window), `limit` (default 50, max 200). Results are department-scoped server-side: a non-leader only sees completed work owned by their own team(s), so this is their team's history with the client, not necessarily the agency's full history.",
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
    name: "list_client_recent_emails",
    description:
      "Latest email threads in/out with a specific client, with the actual message text (truncated) so you can answer 'what's the latest update with X', 'what did X say about Y', 'how are we doing with X'. Resolves the client by `clientName` (fuzzy match) or `clientId`. Returns the top `limit` (default 5, max 20) threads newest-first; each thread has subject, lastAt, direction, participants, a body snippet from the most recent message, and the satisfaction score (0-100) + reason if one has been computed. When the user asks about communication with a client, prefer this tool over guessing. " +
      "Results are scoped server-side to the inboxes the caller is allowed to see — exactly the inboxes they'd see in the UI. If the result has `accessDenied: true`, the client's email lives only in inboxes outside the caller's permissions: tell them you can't access those emails, do NOT speculate about the contents.",
    input_schema: {
      type: "object",
      properties: {
        clientName: { type: "string" },
        clientId: { type: "string" },
        limit: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "list_client_eod_updates",
    description:
      "Per-client check-ins workers file in their daily EOD form for a specific client (e.g. \"emailed Acme about the homepage copy\", \"called them re: the invoice\"). These are the touches shown under 'Client updates' on the client's page and posted to the team Slack channel — the human log of recent work + communication on a client, complementary to list_client_completed_tasks (shipped tasks) and list_client_recent_emails (raw email). Use it for 'what's the latest on X?', 'what have we done for X this week?', or 'who touched X recently?'. Resolve the client by `clientName` (fuzzy match against clients.name) or `clientId` (exact id). Optional: `sinceDays` (omit or 0 for the full history), `limit` (default 20, max 100). Returns updates newest-first, each with who filed it, the message, the date, and whether it posted to Slack.",
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
    name: "list_client_meetings",
    description:
      "Meeting intelligence for a client: processed tl;dv meeting recordings, each with the meeting date, participants, a one-paragraph summary, the generated TEAM BRIEF (key decisions, action items, client requests, risks/blockers, next steps), a link to the recording, and the tasks the meeting spawned. " +
      "This is the record of what was actually said and agreed with the client in meetings — use it to answer 'what did we decide with X in the last meeting?', 'what did X ask for?', 'any blockers from the call?', AND as source material when DRAFTING AN EMAIL to the client, writing a status brief, or proposing follow-up tasks. Resolve the client by `clientName` (fuzzy match against clients.name) or `clientId` (exact id). Optional: `sinceDays` (omit or 0 for the full history), `limit` (default 10, max 50). Returns meetings newest-first. " +
      "When no meetings come back, say there are no processed meetings for this client rather than guessing at what was discussed.",
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
    name: "propose_task",
    description:
      "Propose CREATING A TASK in Scaled Operations from something in the conversation — most often an email that needs follow-up. Does NOT create the task itself; instead it stages a button the user clicks to confirm. ALWAYS use this when:\n  • you spot a clear action item in an email a tool returned (\"can you send me a quote\", \"follow up with X by Friday\", \"please update the homepage\")\n  • the user says \"turn this into a task\" / \"make a task\" / \"who should do this?\"\n  • you're summarizing a thread and the obvious next step is human work\nThe tool runs the existing assignee ranker (skill match + capacity + client familiarity + workload) and returns the top 3 picks — surface the top pick in your text reply with one-line reasoning. Required: `title`, `description`. Optional: `clientName` (boosts client-familiarity), `priority` (low/medium/high/critical, default medium), `sourceLabel` (\"From: <subject>\" line to show on the card), `sourceUrl` (deep link to a DD thread page like `/inboxes/<accountId>/threads/<threadId>`).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        clientName: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        sourceLabel: { type: "string" },
        sourceUrl: { type: "string" }
      },
      required: ["title", "description"]
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
      "Required: title, plus EITHER assigneeId (resolve names to ids with find_user_by_name first) OR assignToDepartment:true with a departmentId. " +
      "Use assignToDepartment when the user names a team rather than a person — 'make a task for the software team', 'the Facebook team should handle this', 'let the team divide it up'. The task goes into that department's pool with nobody assigned and any member can claim it. Only leaders and department heads can do this. " +
      "Optional: description (Markdown is fine), priority (low/medium/high/critical, default medium), departmentId, estimatedHours (default 2), dueDateISO, tags, clientName. " +
      "Returns { taskId, url }. " +
      "Permissions: leaders/admins can assign to anyone; department heads can assign to anyone in their departments; workers can only create tasks for themselves. Trying to assign outside scope returns an error.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        assigneeId: { type: "string" },
        assignToDepartment: {
          type: "boolean",
          description:
            "Hand the task to a whole department instead of a person. Requires departmentId and no assigneeId."
        },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        departmentId: { type: "string" },
        estimatedHours: { type: "number" },
        dueDateISO: { type: "string", description: "ISO datetime; omit for auto-computed" },
        tags: { type: "array", items: { type: "string" } },
        clientName: { type: "string" }
      },
      required: ["title"]
    }
  },
  {
    name: "propose_email",
    description:
      "OWNER-ONLY. Draft a NEW outgoing email and stage a 'Send email' card under your reply for Mitchell to review, edit, and send with one click. Use this whenever Mitchell asks you to email/draft/reach out to someone (e.g. 'email Deel asking if they raised my payroll'). YOU write the full body in his voice (warm, direct, no em-dashes) and a clear subject. NEVER sends automatically — Mitchell clicks Send. If you don't know the recipient's exact address, put your best guess or a [placeholder] in `to` and say so in your reply. Returns { staged: true }. Non-owner callers get access-denied.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address (or a [placeholder] if unknown)." },
        subject: { type: "string" },
        body: { type: "string", description: "Full email body, ready to send, in Mitchell's voice." },
        purpose: { type: "string", description: "One-line reason for the email, shown on the card." }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "remember",
    description:
      "OWNER-ONLY. Save a durable fact the brain should carry across every future chat and the daily brief. Call this whenever Mitchell states a standing priority ('getting more clients is the top priority'), a decision ('we're cutting LinkedIn ads'), a company fact ('Talha owns outbound'), or a preference ('keep team messages casual'). Don't save one-off questions, transient status, or anything already obvious from the data. Pick the closest category. Returns the saved memory. Non-owner callers get access-denied — never save memory for them.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact to remember, phrased so it stands on its own later." },
        category: { type: "string", enum: ["priority", "decision", "fact", "preference"] }
      },
      required: ["content"]
    }
  },
  {
    name: "forget",
    description:
      "OWNER-ONLY. Deactivate a memory that is no longer true or relevant. Pass the memory id (the [mem_...] shown in the 'What you know' context block). Use when Mitchell says a priority changed, a decision was reversed, or a fact is stale.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The mem_... id from the memory context block." } },
      required: ["id"]
    }
  },
  {
    name: "get_finances",
    description:
      "OWNER-ONLY. Returns the full financial picture: manual MRR (the owner's source-of-truth sheet), live Stripe revenue (MRR, new/churned/past-due), and the P&L (monthly revenue/expenses/net/margin) with a full expense breakdown down to individual line items / vendors (per-month values included). Use this for ANY money question — 'what's my MRR', 'what should I cut', 'what's my burn', 'biggest expense', 'what's rising', 'margin', 'who's my biggest client'. Returns { error } for any non-owner caller — if that happens, tell the user finance data is private to the owner and do not answer the finance question from memory.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_outbound_pipeline",
    description:
      "OWNER-ONLY. LIVE outbound sales pipeline — the treatment centers WE are prospecting as potential new clients (not existing clients), from the Meta ads dashboard's Outbound board that the reps work every day (the same board as the Scale Room's Outbound tab and Live board). Returns stage counts (New, Contacted, No response, Call booked, Proposal, Won, Lost), booked vs not booked, today's texting queues per rep vs their daily cap plus the backlog, how stale the un-reached leads are, leads → bookings by source, new-lead velocity, month-by-month ad spend / ad-form prospects / booked / cost per lead / cost per booked, and the matching leads (facility, contact, role, location, stage, rep, source, budget, follow-up flag, next action, last contacted, age). Filter with stage / source / owner / followUp / search; leads are newest first. Use for ANY question about outbound, prospects, leads we're chasing, booked calls, proposals, the texting backlog, reps' queues, or 'how is the pipeline'. Returns { error } for non-owners, when the Outbound source is switched off, or when its switch can't be read.",
    input_schema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: ["new", "contacted", "no_response", "booked", "proposal", "won", "lost", "booked_or_beyond", "not_booked"], description: "Only leads at this stage. booked_or_beyond = Call booked, Proposal or Won; not_booked = New, Contacted or No response." },
        source: { type: "string", description: "Only leads whose source contains this text, e.g. 'Typeform', 'Inbound form', 'Treatment center list'." },
        owner: { type: "string", description: "Only leads dealt to this rep today (e.g. Mujtaba, Mitch, Joe)." },
        followUp: { type: "string", enum: ["needs", "longterm"], description: "Only leads flagged Needs follow-up or Long-term." },
        search: { type: "string", description: "Case-insensitive match on facility, contact, location or next action." },
        limit: { type: "number", description: "Max leads returned (default 25, max 100). Counts and breakdowns always cover the whole pipeline; narrow with the filters rather than raising this." }
      }
    }
  },
  {
    name: "get_meta_ads",
    description:
      "OWNER-ONLY. LIVE performance of OUR OWN Meta (Facebook/Instagram) ad account — the ads that feed the outbound pipeline, not client accounts — read straight from Meta by the Meta ads dashboard. For the last N full days (ending yesterday) vs the N days before: spend, impressions, clicks, link clicks, Meta leads, reach, frequency, CTR, CPC, CPM, CPL; the day-by-day series (only with includeDaily: true); every campaign, ad set and ad with status, spend, clicks, CTR, CPC, leads and CPL; plus the ad-form prospects created in the window and how many are now booked (cost per booking). Use for ANY question about our ads, ad spend, cost per lead, which campaign/ad is working, CTR, frequency/fatigue. Returns { error } for non-owners, when the Outbound source is switched off, or when its switch can't be read.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", enum: [7, 14, 30, 90], description: "Window length in full days ending yesterday (default 7)." },
        includeDaily: { type: "boolean", description: "Also return the day-by-day series (default false). Only pass true when the question is about a specific day or a trend within the window — a 90-day series is long and crowds out the answer." }
      }
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
      case "list_people": return listPeople(input);
      case "find_user_by_name": return findUserByName(input, ctx);
      case "list_departments": return listDepartments();
      case "list_clients": return listClients(input);
      case "get_client": return getClient(input, ctx);
      case "list_client_completed_tasks": return listClientCompletedTasks(input, ctx);
      case "list_client_recent_emails": return listClientRecentEmails(input, ctx);
      case "list_client_eod_updates": return listClientEodUpdates(input);
      case "list_client_meetings": return listClientMeetings(input);
      case "propose_task": return proposeTask(input, ctx);
      case "list_projects": return listProjects(input);
      case "get_project": return getProject(input, ctx);
      case "get_capacity": return getCapacity(input, ctx);
      case "get_my_calendar": return getMyCalendar(input, ctx);
      case "list_recent_kudos": return listRecentKudos(input);
      case "list_recent_incidents": return listRecentIncidents(input);
      case "list_recent_eod_notes": return listRecentEodNotes(input);
      case "list_recommendations": return listRecommendations(input);
      case "search_sops": return searchSops(input);
      case "create_task": return createTask(input, ctx);
      case "get_finances": return getFinances(ctx);
      case "get_outbound_pipeline": return getOutboundPipelineTool(input, ctx);
      case "get_meta_ads": return getMetaAdsTool(input, ctx);
      case "propose_email": return proposeEmail(input, ctx);
      case "remember": return rememberFact(input, ctx);
      case "forget": return forgetFact(input, ctx);
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

  // Access filter: leader-privacy + DEPARTMENT SCOPING. Leaders/admins
  // see everything; everyone else is limited to their own work plus
  // tasks in their own department(s). Same gate as get_task and the
  // client task tools so cross-team work can't leak through any path.
  const leaderIds = await getLeaderIds();

  const filtered = tasks.filter((t) => {
    if (!canViewTaskScopedToDepartment(ctx.actor, t, leaderIds)) return false;
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
  // Access gate: leader-privacy + department scoping (same helper as
  // search_tasks). Non-leaders can't open a task outside their
  // department(s) unless it's their own assigned/created work.
  const leaderIds = await getLeaderIds();
  const visible = canViewTaskScopedToDepartment(
    ctx.actor,
    {
      assigneeId: (row.assignee_id as string | null) ?? null,
      creatorId: (row.creator_id as string) ?? "",
      departmentId: (row.department_id as string | null) ?? null,
      tags: (row.tags as string[] | null) ?? []
    },
    leaderIds
  );
  if (!visible) return { error: "access denied" };
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

async function listPeople(input: Record<string, unknown>) {
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

async function getClient(input: Record<string, unknown>, ctx: ToolContext) {
  const id = String(input.id ?? "");
  if (!id) return { error: "id required" };
  const supabase = getSupabaseAdmin();
  const { data: client } = await supabase
    .from("clients").select("*").eq("id", id).maybeSingle();
  if (!client) return { error: "not found" };
  // Pull the ownership/department columns too so the department scoping
  // gate (canViewTaskScopedToDepartment) can run — a worker shouldn't see
  // another team's tasks just because they share a client.
  const [{ data: openTasks }, { data: doneTasks }, leaderIds] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date, assignee_id, creator_id, department_id, tags")
      .eq("client_name", client.name)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .limit(15),
    supabase
      .from("tasks")
      .select("id, title, last_activity_at, assignee_id, creator_id, department_id, tags")
      .eq("client_name", client.name)
      .eq("status", "done")
      .order("last_activity_at", { ascending: false })
      .limit(10),
    getLeaderIds()
  ]);
  const canSee = (r: {
    assignee_id: unknown;
    creator_id: unknown;
    department_id: unknown;
    tags: unknown;
  }) =>
    canViewTaskScopedToDepartment(
      ctx.actor,
      {
        assigneeId: (r.assignee_id as string | null) ?? null,
        creatorId: (r.creator_id as string) ?? "",
        departmentId: (r.department_id as string | null) ?? null,
        tags: (r.tags as string[] | null) ?? []
      },
      leaderIds
    );
  return {
    id: client.id,
    name: client.name,
    website: client.website,
    priority: client.priority,
    notes: client.notes,
    openTasks: (openTasks ?? [])
      .filter(canSee)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date })),
    recentlyCompletedTasks: (doneTasks ?? [])
      .filter(canSee)
      .map((t) => ({ id: t.id, title: t.title, last_activity_at: t.last_activity_at }))
  };
}

// Knowledge-base lookup over a client's completed tasks. Same source as
// the page-rendered "Knowledge base · completed work" section, but
// pre-filtered by date and shaped for AI consumption (descriptions are
// included, completedBy is joined in). Caller is expected to resolve
// the client by name or id; ambiguous names return an error so the AI
// can disambiguate with the user instead of guessing.
export async function listClientCompletedTasks(input: Record<string, unknown>, ctx: ToolContext) {
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
    .select("id, title, description, priority, last_activity_at, tags, assignee_id, creator_id, department_id")
    .eq("client_name", clientName)
    .eq("status", "done")
    .gte("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: false })
    .limit(limit);
  // Department scoping: a worker asking for a client's completed-work
  // history only sees work owned by their own team(s). Same gate as
  // search_tasks / get_task.
  const leaderIds = await getLeaderIds();
  const rows = ((tasks ?? []) as Array<{
    id: string; title: string; description: string | null;
    priority: string | null; last_activity_at: string;
    tags: string[] | null; assignee_id: string | null;
    creator_id: string | null; department_id: string | null;
  }>).filter((r) =>
    canViewTaskScopedToDepartment(
      ctx.actor,
      {
        assigneeId: r.assignee_id,
        creatorId: r.creator_id ?? "",
        departmentId: r.department_id,
        tags: r.tags ?? []
      },
      leaderIds
    )
  );

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

// Per-client EOD check-ins — the "Client updates" a worker files in
// their daily EOD form ("emailed Acme about the new homepage"), which
// also post to the team Slack channel. Resolves the client by name
// (fuzzy) or id, then returns the updates newest-first.
//
// No department gate: eod_client_updates carries no department_id, and
// the client detail page shows every update for a client to anyone who
// can open the page (see clients/[id]/page.tsx). This tool mirrors that
// surface rather than the stricter task/email scoping.
export async function listClientEodUpdates(input: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  let clientName: string | null = typeof input.clientName === "string" ? input.clientName : null;
  let clientId: string | null = typeof input.clientId === "string" ? input.clientId : null;

  // Resolve to a single canonical (id, name) — same disambiguation the
  // other client tools use: clientId → fetch name; clientName → fuzzy
  // ilike, settling ties on an exact name match.
  if (!clientName && clientId) {
    const { data: c } = await supabase
      .from("clients").select("id, name").eq("id", clientId).maybeSingle();
    if (!c) return { error: "client not found" };
    clientName = c.name as string;
    clientId = c.id as string;
  }
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
  if (!clientName || !clientId) return { error: "clientName or clientId required" };

  const rawLimit = typeof input.limit === "number" ? input.limit : 20;
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));

  // Apply the optional date window as a filter BEFORE order/limit so the
  // supabase-js builder stays a filter builder (gte isn't available after
  // a transform method like .order()).
  let filter = supabase
    .from("eod_client_updates")
    .select("id, user_id, message, note_date, slack_ts, sent_at, created_at")
    .eq("client_id", clientId);
  const rawSince = typeof input.sinceDays === "number" ? input.sinceDays : 0;
  if (rawSince > 0) {
    const cutoff = new Date(Date.now() - Math.floor(rawSince) * 86_400_000).toISOString();
    filter = filter.gte("created_at", cutoff);
  }
  const { data, error } = await filter
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { clientId, clientName, count: 0, updates: [] };

  const rows = (data ?? []) as Array<{
    id: string; user_id: string; message: string; note_date: string;
    slack_ts: string | null; sent_at: string | null; created_at: string;
  }>;

  // Join author names once so the AI can attribute each touch.
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const { data: users } = await supabase
    .from("users").select("id, name").in("id", userIds.length ? userIds : ["_none_"]);
  const nameById = new Map(((users ?? []) as { id: string; name: string }[]).map((u) => [u.id, u.name]));

  return {
    clientId,
    clientName,
    count: rows.length,
    updates: rows.map((r) => ({
      id: r.id,
      filedBy: nameById.get(r.user_id) ?? null,
      message: r.message,
      noteDate: r.note_date,
      postedToSlack: !!r.slack_ts,
      createdAt: r.created_at
    }))
  };
}

// Processed meetings (tl;dv) for a client — the structured records in
// client_meetings the intake pipeline writes (lib/tldv-intake.ts). Returns
// the summary + generated team brief + participants + recording link +
// the tasks each meeting spawned, so the assistant can answer questions,
// draft client emails, or propose follow-ups grounded in what was said.
//
// No department gate: client_meetings carries no department_id and the
// client detail page shows every meeting to anyone who can open it. This
// tool mirrors that surface (same posture as listClientEodUpdates), not
// the stricter task/email scoping.
export async function listClientMeetings(input: Record<string, unknown>) {
  const supabase = getSupabaseAdmin();
  let clientName: string | null = typeof input.clientName === "string" ? input.clientName : null;
  let clientId: string | null = typeof input.clientId === "string" ? input.clientId : null;

  // Resolve to a single canonical (id, name) — same disambiguation the
  // other client tools use.
  if (!clientName && clientId) {
    const { data: c } = await supabase
      .from("clients").select("id, name").eq("id", clientId).maybeSingle();
    if (!c) return { error: "client not found" };
    clientName = c.name as string;
    clientId = c.id as string;
  }
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
  if (!clientName || !clientId) return { error: "clientName or clientId required" };

  const rawLimit = typeof input.limit === "number" ? input.limit : 10;
  const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));

  let filter = supabase
    .from("client_meetings")
    .select("id, meeting_id, title, source, source_url, meeting_date, participants, summary, brief, task_ids")
    .eq("client_id", clientId);
  const rawSince = typeof input.sinceDays === "number" ? input.sinceDays : 0;
  if (rawSince > 0) {
    const cutoff = new Date(Date.now() - Math.floor(rawSince) * 86_400_000).toISOString();
    filter = filter.gte("meeting_date", cutoff);
  }
  const { data, error } = await filter
    .order("meeting_date", { ascending: false })
    .limit(limit);
  // A missing table (migration not applied) shouldn't read as "no
  // meetings" — surface it so the model doesn't assert there were none.
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) {
      return { clientId, clientName, count: 0, meetings: [], note: "Meeting storage not yet provisioned — no migration run." };
    }
    return { error: error.message };
  }

  const rows = (data ?? []) as Array<{
    id: string; meeting_id: string; title: string; source: string;
    source_url: string | null; meeting_date: string; participants: string[] | null;
    summary: string | null; brief: unknown; task_ids: string[] | null;
  }>;

  // Join the spawned tasks' titles + status once so the model can speak
  // to follow-up work without a second round-trip.
  const allTaskIds = Array.from(new Set(rows.flatMap((r) => r.task_ids ?? [])));
  const taskById = new Map<string, { title: string; status: string }>();
  if (allTaskIds.length > 0) {
    const { data: tasks } = await supabase
      .from("tasks").select("id, title, status").in("id", allTaskIds);
    for (const t of (tasks ?? []) as { id: string; title: string; status: string }[]) {
      taskById.set(t.id, { title: t.title, status: t.status });
    }
  }

  return {
    clientId,
    clientName,
    count: rows.length,
    meetings: rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      meetingDate: r.meeting_date,
      recordingUrl: r.source_url,
      participants: r.participants ?? [],
      summary: r.summary,
      brief: coerceMeetingBrief(r.brief),
      tasks: (r.task_ids ?? [])
        .map((id) => {
          const t = taskById.get(id);
          return t ? { id, title: t.title, status: t.status } : null;
        })
        .filter((t): t is { id: string; title: string; status: string } => t !== null)
    }))
  };
}

// Recent email threads for a client. Resolves the client by name (fuzzy
// match) or id, then asks missiveclone for the threads carrying the
// client's per-client label (created by the labels backfill / webhook).
// For each thread we fetch the full thread once and surface only the
// LATEST message's body as a snippet — enough for the AI to answer
// "what's the latest update with X?" without dumping a 30-message log
// into the context. Satisfaction score + reason are joined per-message
// when one has been computed by the daily client-health cron.
//
// INBOX SCOPING: email is the one place Ask AI reaches into shared
// inboxes, so it must obey the same per-user visibility the inbox pages
// do. We resolve the caller's accessible accounts via visibleAccountIdsFor
// (leader → all, dept head → their dept's inboxes, worker → own inboxes)
// and keep only threads that touch one of those accounts — mirroring
// /api/inboxes/threads. A worker asking about a client whose mail lives
// in an inbox they can't see gets an access-denied note, never the
// bodies. This is enforced here server-side, not via the prompt.
export async function listClientRecentEmails(input: Record<string, unknown>, ctx: ToolContext) {
  const supabase = getSupabaseAdmin();
  let clientName: string | null = typeof input.clientName === "string" ? input.clientName : null;
  let clientId: string | null = typeof input.clientId === "string" ? input.clientId : null;
  const limit = Math.min(20, Math.max(1, Number(input.limit) || 5));

  // Resolve clientId → name. Threads are labeled by client name, so we
  // need the canonical name to look up the missive label.
  if (!clientName && clientId) {
    const { data: c } = await supabase
      .from("clients").select("id, name").eq("id", clientId).maybeSingle();
    if (!c) return { error: "client not found" };
    clientName = c.name as string;
    clientId = c.id as string;
  }
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
  if (!clientName || !clientId) return { error: "clientName or clientId required" };

  // Resolve which inboxes the caller is allowed to read, and map those
  // account ids → emails so we can match against each thread's
  // account_emails fan-out (same join the inbox pages use). `null` =
  // leader/admin → no inbox restriction.
  let labels: Awaited<ReturnType<typeof listLabels>>;
  let accounts: Awaited<ReturnType<typeof listAccounts>>;
  let visibleIds: Set<string> | null;
  try {
    [labels, accounts, visibleIds] = await Promise.all([
      listLabels(),
      listAccounts(),
      visibleAccountIdsFor(ctx.actor)
    ]);
  } catch (err) {
    return {
      error: `missiveclone unreachable: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const label = labels.find(
    (l) => l.name.trim().toLowerCase() === clientName!.trim().toLowerCase()
  );
  if (!label) {
    return {
      clientId,
      clientName,
      threads: [],
      note: "No missive label found for this client yet — backfill or send/receive at least one email tagged to this client."
    };
  }

  // Set of email addresses for the inboxes the caller may read. null →
  // leader, no filtering. An empty set means the caller has no inbox
  // access at all (e.g. a worker with no assignments) → they see nothing.
  const visibleEmails = visibleIds === null
    ? null
    : new Set(
        accounts
          .filter((a) => visibleIds!.has(a.id))
          .map((a) => a.email.toLowerCase())
      );

  // Over-fetch a little so the post-visibility slice can still fill the
  // requested limit when some threads are out of scope, then filter.
  const fetchLimit = visibleEmails === null ? limit : Math.min(100, limit * 5);
  const allThreads = await listThreads({ labelId: label.id, limit: fetchLimit });
  if (allThreads.length === 0) {
    return { clientId, clientName, threads: [] };
  }

  const accessibleThreads = visibleEmails === null
    ? allThreads
    : allThreads.filter((t) =>
        (t.account_emails ?? []).some((ae) => visibleEmails.has(ae.email.toLowerCase()))
      );

  // The client HAS email, but none of it lives in an inbox the caller can
  // see → access denied (e.g. a Website-team worker asking about a client
  // whose mail sits in an SEO/owner inbox). Never leak that threads exist.
  if (accessibleThreads.length === 0) {
    return {
      clientId,
      clientName,
      threads: [],
      accessDenied: true,
      note: "You don't have access to any inbox containing this client's email. Tell the user you can't see emails for this client with their current inbox permissions."
    };
  }

  const threads = accessibleThreads.slice(0, limit);

  // Fetch each thread's messages + join satisfaction scores. Sequential
  // is fine here — limit caps at 20 so this is at most ~20 small calls.
  const enriched = [];
  for (const t of threads) {
    let detail: Awaited<ReturnType<typeof getThread>>;
    try {
      detail = await getThread(t.id);
    } catch {
      continue;
    }
    const msgs = detail.messages ?? [];
    if (msgs.length === 0) continue;
    const latest = msgs[msgs.length - 1];
    const earliestId = msgs[0]?.id;
    const messageIds = msgs.map((m) => m.id).filter(Boolean);

    type ScoreRow = {
      satisfaction_score: number;
      reason: string | null;
      direction: string;
      delivered_at: string | null;
    };
    let scoreRow: ScoreRow | null = null;
    if (messageIds.length > 0) {
      const { data: scores } = await supabase
        .from("email_satisfaction_scores")
        .select("satisfaction_score, reason, direction, delivered_at")
        .eq("client_id", clientId)
        .in("message_id", messageIds)
        .order("delivered_at", { ascending: false })
        .limit(1);
      const first = (scores as unknown as ScoreRow[] | null)?.[0];
      scoreRow = first ?? null;
    }

    enriched.push({
      threadId: t.id,
      subject: t.subject || "(no subject)",
      lastAt: t.last_message_at,
      status: t.status,
      participants: t.participants ?? [],
      messageCount: msgs.length,
      latestDirection: latest.direction,
      latestFrom: latest.from_addr,
      latestSentAt: latest.sent_at,
      // Strip quoted-reply chains + trim. Most email clients prefix
      // quoted text with "On <date>, <name> wrote:" — cutting at that
      // boundary keeps the snippet about the latest reply, not the
      // entire thread history.
      latestSnippet: snippetFor(latest.body_text, 800),
      satisfactionScore: scoreRow ? scoreRow.satisfaction_score : null,
      satisfactionReason: scoreRow ? scoreRow.reason : null,
      firstMessageId: earliestId ?? null
    });
  }

  return {
    clientId,
    clientName,
    labelId: label.id,
    threadCount: enriched.length,
    threads: enriched
  };
}

function snippetFor(body: string | null, max: number): string {
  if (!body) return "";
  // Cut at the first "On <date>, <name> wrote:" boundary or "----- Original
  // Message -----" header. Falls back to the full body when no boundary
  // is found — many automated emails have no quote chain.
  const cut = body.split(
    /\n\s*(?:On .{1,80}wrote:|-----\s*Original Message\s*-----|________________________________)/
  )[0];
  const clean = cut.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

// Stages a "Create task" card under the assistant's reply. Does NOT
// insert the task — that only happens when the user clicks the button
// the drawer renders from ctx.proposals. We run the same ranker the
// new-task form + email intake use, so the suggestions stay consistent
// across surfaces and a tweak to the ranker propagates here too.
async function proposeTask(input: Record<string, unknown>, ctx: ToolContext) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!title) return { error: "title required" };
  if (!description) return { error: "description required" };

  const PRIORITIES = new Set(["low", "medium", "high", "critical"]);
  const rawPriority = typeof input.priority === "string" ? input.priority.toLowerCase() : null;
  const priority = rawPriority && PRIORITIES.has(rawPriority)
    ? (rawPriority as "low" | "medium" | "high" | "critical")
    : undefined;
  const clientName = typeof input.clientName === "string" && input.clientName.trim()
    ? input.clientName.trim() : null;
  const sourceLabel = typeof input.sourceLabel === "string" && input.sourceLabel.trim()
    ? input.sourceLabel.trim() : null;
  const sourceUrl = typeof input.sourceUrl === "string" && input.sourceUrl.trim()
    ? input.sourceUrl.trim() : null;

  // Pull skills + tasks + users in parallel so ranking is one round-trip.
  const supabase = getSupabaseAdmin();
  const [users, allTasks, skillRowsRes] = await Promise.all([
    getAllUsersLight(),
    getAllTasks(),
    supabase.from("user_skills").select("user_id, tag, manual_level, auto_score")
  ]);

  type SkillRow = {
    user_id: string;
    tag: string;
    manual_level: number | string;
    auto_score: number | string;
  };
  const skillsByUser = new Map<
    string,
    { userId: string; tag: string; combinedScore: number }[]
  >();
  for (const r of (skillRowsRes.data ?? []) as SkillRow[]) {
    const arr = skillsByUser.get(r.user_id) ?? [];
    arr.push({
      userId: r.user_id,
      tag: r.tag,
      combinedScore: Number(r.manual_level) * 6 + Number(r.auto_score)
    });
    skillsByUser.set(r.user_id, arr);
  }

  const capacityByUser = new Map<string, number>();
  for (const u of users) capacityByUser.set(u.id, userCapacity(u, allTasks).pct);
  const { activeTasksByUser, clientHistoryByUser } = buildLoadSignals(allTasks, clientName);

  // Free-text keyword extraction from title + description → tags. The
  // ranker also extracts internally, but passing them as `tags` keeps
  // the contract symmetric with the email-intake call site.
  const text = `${title} ${description}`.toLowerCase();
  const tags = Array.from(
    new Set((text.match(/[a-z0-9]{4,}/g) ?? []).slice(0, 12))
  );

  const ranked = rankCandidates({
    task: {
      title,
      description,
      departmentId: null,
      tags
    },
    candidates: users,
    skillsByUser,
    capacityByUser,
    activeTasksByUser,
    clientHistoryByUser
  });

  const nameById = new Map(users.map((u) => [u.id, u.name]));
  const top = ranked.slice(0, 3).map((r) => ({
    userId: r.userId,
    name: nameById.get(r.userId) ?? r.userId,
    score: Math.round(r.score),
    topReasons: r.factors
      .filter((f) => Math.abs(f.points) >= 1)
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
      .slice(0, 2)
      .map((f) => f.label),
    capacityPct: Math.round(r.capacityPct)
  }));

  // Per-request unique id; only used as a React key on the action card.
  const proposalId = `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  ctx.proposals.push({
    kind: "create_task",
    id: proposalId,
    title,
    description,
    priority,
    clientName,
    sourceLabel,
    sourceUrl,
    suggestedAssignees: top
  });

  return {
    proposalId,
    suggestedAssignees: top,
    note: "Task is staged. The user sees a 'Create task' button under your reply — reference the top suggestion in your text answer."
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

async function getProject(input: Record<string, unknown>, ctx: ToolContext) {
  const id = String(input.id ?? "");
  if (!id) return { error: "id required" };
  const supabase = getSupabaseAdmin();
  const [{ data: project }, { data: stages }, { data: tasks }, leaderIds] = await Promise.all([
    supabase.from("projects").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("project_stages")
      .select("id, name, status, position, kind")
      .eq("project_id", id)
      .order("position"),
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date, stage_id, assignee_id, creator_id, department_id, tags")
      .eq("project_id", id),
    getLeaderIds()
  ]);
  if (!project) return { error: "not found" };
  // Department scoping. A task with no department_id inherits the
  // project's department, so the project's own team still sees its tasks
  // while members of other teams don't (same gate as search_tasks).
  const projectDeptId = (project.department_id as string | null) ?? null;
  const visibleTasks = (tasks ?? []).filter((t) =>
    canViewTaskScopedToDepartment(
      ctx.actor,
      {
        assigneeId: (t.assignee_id as string | null) ?? null,
        creatorId: (t.creator_id as string) ?? "",
        departmentId: (t.department_id as string | null) ?? projectDeptId,
        tags: (t.tags as string[] | null) ?? []
      },
      leaderIds
    )
  );
  const tasksByStage = new Map<string, unknown[]>();
  for (const t of visibleTasks) {
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

  const actor = ctx.actor;
  const actorIsLeader = actor.role === "leader" || actor.isAdmin === true;

  // Team task — "make a task for the software team". Mirrors the same gate
  // POST /api/tasks applies (canQueueTaskToTeam): leaders + department heads
  // only, department required, no assignee.
  const wantsTeam = input.assignToDepartment === true && !assigneeId;
  if (wantsTeam) {
    if (!actorIsLeader && actor.role !== "department_head") {
      return { error: "Only leaders and department heads can hand work to a whole team." };
    }
    const teamDeptId = typeof input.departmentId === "string" ? input.departmentId.trim() : "";
    if (!teamDeptId) {
      return { error: "departmentId is required when assigning to a whole team (use list_departments)." };
    }
    if (!actorIsLeader && !(actor.departmentIds ?? []).includes(teamDeptId)) {
      return { error: "Department heads can only queue work to their own departments." };
    }
    return createTeamTask({ ...input, title, departmentId: teamDeptId }, ctx);
  }

  if (!assigneeId) {
    return {
      error:
        "assigneeId required (use find_user_by_name first if you only have a name), or pass assignToDepartment:true with a departmentId to hand it to a whole team"
    };
  }

  const supabase = getSupabaseAdmin();

  // Permission gate. Pull the assignee + actor's scope; same model
  // as canCreateTasksForOthers + assignableTargets() use.
  const [assignee, allUsers] = await Promise.all([
    getUserById(assigneeId),
    getAllUsersLight()
  ]);
  if (!assignee) return { error: "assigneeId not found" };

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
  // stripTeamTag for the same reason the team branch below applies it: the
  // marker is server-owned, and this path has none of the canQueueTaskToTeam
  // gating. Without it a worker could ask the assistant to add an "auto-team"
  // tag to a task they self-assign, then release it into a department pool.
  const tags = stripTeamTag(input.tags);
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

// Team-task branch of create_task: department pool, nobody assigned. Split
// out rather than threaded through the person path because almost nothing is
// shared — no assignee to permission-check, no assignee schedule to derive a
// deadline from, and the marker tag has to be applied.
async function createTeamTask(
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const supabase = getSupabaseAdmin();
  const actor = ctx.actor;
  const title = input.title as string;
  const departmentId = input.departmentId as string;

  const { data: dept } = await supabase
    .from("departments")
    .select("id, name")
    .eq("id", departmentId)
    .maybeSingle();
  if (!dept) return { error: `No department with id ${departmentId} (use list_departments).` };

  const description = typeof input.description === "string" ? input.description : "";
  const priority = (() => {
    const p = typeof input.priority === "string" ? input.priority : "medium";
    return ["low", "medium", "high", "critical"].includes(p) ? p : "medium";
  })();
  const estimatedHours =
    typeof input.estimatedHours === "number" && input.estimatedHours > 0 ? input.estimatedHours : 2;
  const clientName = typeof input.clientName === "string" ? input.clientName.trim() || null : null;
  // stripTeamTag first so the model can't hand-roll the marker into `tags`
  // and bypass the gate above.
  const tags = [
    ...stripTeamTag(Array.isArray(input.tags) ? input.tags : []),
    TEAM_TAG
  ];

  // No assignee means no schedule to walk, so fall back to a standard 8h
  // weekday. A team task with no due date would never be overdue, never
  // surface on an overdue tile, and never age out — see NewTaskForm for the
  // same reasoning.
  const { deadlineFromEstimate } = await import("@/lib/capacity");
  const dueDate =
    typeof input.dueDateISO === "string" && input.dueDateISO
      ? new Date(input.dueDateISO).toISOString()
      : deadlineFromEstimate(estimatedHours, {
          dailyCapacity: 8,
          weeklySchedule: undefined,
          workTimezone: actor.workTimezone ?? null
        });

  const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const { error } = await supabase.from("tasks").insert({
    id,
    title,
    description: description.trim() || null,
    status: "pending",
    priority,
    estimated_hours: estimatedHours,
    actual_hours: 0,
    tags,
    department_id: departmentId,
    assignee_id: null,
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
    detail: `Created by Ask AI → queued for the ${dept.name as string} team`
  });

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return {
    taskId: id,
    url: baseUrl ? `${baseUrl}/tasks/${id}` : `/tasks/${id}`,
    queuedFor: `${dept.name as string} team`,
    note: "Nobody is assigned — any member of that department can claim it.",
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



// OWNER-ONLY financial snapshot for the Ask AI widget. Combines the manual MRR
// sheet, live Stripe revenue, and the P&L expense breakdown so the brain can
// answer money / cut questions grounded in real data. Every non-owner caller
// gets an access-denied object — the model is instructed not to answer from
// memory when it sees that.
async function getFinances(ctx: ToolContext) {
  if (!isOwner(ctx.actor)) {
    return { error: "access denied — financial data is private to the owner (Mitchell) only" };
  }
  const supabase = getSupabaseAdmin();

  // 1. Manual MRR sheet (source of truth).
  const { data: mrrRows } = await supabase
    .from("mrr_entries")
    .select("company, mrr, status, note")
    .order("mrr", { ascending: false });
  const rows = (mrrRows ?? []) as { company: string; mrr: number; status: string; note: string | null }[];
  const manualMrr = rows.filter((r) => r.status === "active" || r.status === "paused").reduce((s, r) => s + Number(r.mrr), 0);
  const manual = {
    totalMrr: Math.round(manualMrr),
    annualRunRate: Math.round(manualMrr * 12),
    activeClients: rows.filter((r) => r.status === "active" || r.status === "paused").length,
    churned: rows.filter((r) => r.status === "churned").length,
    pending: rows.filter((r) => r.status === "pending").map((r) => `${r.company} ${money(r.mrr)}`),
    clients: rows
      .filter((r) => r.status === "active" || r.status === "paused")
      .map((r) => ({ company: r.company, mrr: Math.round(Number(r.mrr)), status: r.status, note: r.note || undefined }))
  };

  // 1b. Software/Subscriptions vendor breakdown (the P&L's software lump,
  // itemized) — so the brain can name exact tools to cut.
  const { data: swRows } = await supabase
    .from("software_subscriptions")
    .select("vendor, month, amount");
  const swByVendor = new Map<string, Record<string, number>>();
  const swMonths = new Set<string>();
  for (const r of (swRows ?? []) as { vendor: string; month: string; amount: number }[]) {
    swMonths.add(r.month);
    const v = swByVendor.get(r.vendor) ?? {};
    v[r.month] = (v[r.month] ?? 0) + Number(r.amount);
    swByVendor.set(r.vendor, v);
  }
  const softwareByVendor = [...swByVendor.entries()]
    .map(([vendor, m]) => ({ vendor, monthly: m, latest: m["Aug"] ?? Math.max(0, ...Object.values(m)) }))
    .sort((a, b) => b.latest - a.latest)
    .map((v) => ({ vendor: v.vendor, monthly: v.monthly }));
  const software = softwareByVendor.length
    ? { note: "Software/Subscriptions itemized by vendor, per month. Biggest / rising ones are the cut candidates.", months: [...swMonths], byVendor: softwareByVendor }
    : "No software vendor breakdown uploaded";

  // 1c. Payroll / contractors by person (the Contractor Payments line).
  const { data: payRows } = await supabase
    .from("payroll_entries")
    .select("name, role, status, scale, rate");
  const payPeople = ((payRows ?? []) as { name: string; role: string | null; status: string; scale: string; rate: number }[])
    .map((p) => ({ ...p, monthly: p.scale === "annual" ? Number(p.rate) / 12 : Number(p.rate) }));
  const activePay = payPeople.filter((p) => p.status === "active");
  const payrollMonthly = activePay.reduce((s, p) => s + p.monthly, 0);
  const ownerDraw = payPeople.filter((p) => p.status === "owner-draw").reduce((s, p) => s + p.monthly, 0);
  const payroll = payPeople.length
    ? {
        note: "Operating payroll = active people at monthly-equivalent (the Contractor Payments + payroll line). Owner draw is Mitchell's own pay — a distribution of profit, NOT a business cost; exclude it from margin/cost analysis and treat it as coming out of net profit.",
        totalMonthly: Math.round(payrollMonthly),
        totalAnnual: Math.round(payrollMonthly * 12),
        activeCount: activePay.length,
        ownerDrawMonthly: Math.round(ownerDraw),
        people: activePay.sort((a, b) => b.monthly - a.monthly).map((p) => ({ name: p.name, role: p.role || "—", monthly: Math.round(p.monthly) }))
      }
    : "No payroll uploaded";

  // 2. Live Stripe revenue (fail-soft).
  const stripe = await getStripeRevenue().catch(() => null);
  const stripeSummary = stripe
    ? {
        mrr: Math.round(stripe.mrr),
        clients: stripe.clientCount,
        newThisMonth: stripe.newThisMonth.map((c) => `${c.name} ${money(c.mrr)}`),
        churnedThisMonth: stripe.churnedThisMonth.map((c) => `${c.name} ${money(c.mrr)}`),
        pastDue: stripe.pastDue.map((c) => `${c.name} (${c.email}) ${money(c.mrr)}`),
        note: "Stripe undercounts vs the manual sheet (manual invoices, bundled facilities). Prefer the manual MRR for the headline number."
      }
    : "Stripe unavailable";

  // 3. P&L + expense breakdown from the latest parsed upload.
  const { data: finDocs } = await supabase
    .from("finance_documents")
    .select("parsed, uploaded_at")
    .order("uploaded_at", { ascending: false })
    .limit(5);
  const parsed = ((finDocs ?? []) as { parsed: ParsedPnl | null }[]).find((d) => d.parsed)?.parsed ?? null;

  let pnl: unknown = "No P&L uploaded";
  if (parsed && parsed.periods.length) {
    const periods = parsed.periods;
    const hasTotal = periods[periods.length - 1]?.toLowerCase() === "total";
    const totalIdx = periods.length - 1;
    const months = hasTotal ? periods.slice(0, -1) : periods;
    const at = (arr: (number | null)[], i: number) => Math.round(arr[i] ?? 0);

    // Expense categories with leaf items (from parsed.rows).
    const startI = parsed.rows.findIndex((r) => r.account.toUpperCase() === "EXPENSES");
    const endI = parsed.rows.findIndex((r) => r.account.toLowerCase() === "total expenses");
    const categories: { category: string; total: number; monthly: number[]; items: { name: string; total: number }[] }[] = [];
    if (startI >= 0 && endI > startI) {
      for (let i = startI + 1; i < endI; i++) {
        const r = parsed.rows[i];
        if (r.level !== 1) continue;
        const items: { name: string; total: number }[] = [];
        let totalChild: number | null = null;
        let totalChildVals: (number | null)[] | null = null;
        let j = i + 1;
        for (; j < endI && parsed.rows[j].level > 1; j++) {
          const c = parsed.rows[j];
          if (c.account.toLowerCase() === `total ${r.account.toLowerCase()}`) {
            totalChild = c.values[totalIdx] ?? null;
            totalChildVals = c.values;
            continue;
          }
          items.push({ name: c.account, total: at(c.values, totalIdx) });
        }
        let total = r.values[totalIdx] ?? 0;
        if (!total && totalChild != null) total = totalChild;
        if (!total && items.length) total = items.reduce((s, x) => s + x.total, 0);
        const rowVals = months.some((_, mi) => (r.values[mi] ?? 0) !== 0) ? r.values : totalChildVals ?? r.values;
        categories.push({
          category: r.account,
          total: Math.round(total),
          monthly: months.map((_, mi) => at(rowVals, mi)),
          items: items.filter((x) => x.total).sort((a, b) => b.total - a.total)
        });
      }
    }
    categories.sort((a, b) => b.total - a.total);

    pnl = {
      months,
      revenueByMonth: months.map((_, i) => at(parsed.summary.income, i)),
      expensesByMonth: months.map((_, i) => at(parsed.summary.expenses, i)),
      netByMonth: months.map((_, i) => at(parsed.summary.net, i)),
      periodTotals: hasTotal
        ? { revenue: at(parsed.summary.income, totalIdx), expenses: at(parsed.summary.expenses, totalIdx), net: at(parsed.summary.net, totalIdx) }
        : undefined,
      expenseCategories: categories
    };
  }

  // Next-month budget: Mitchell's per-line estimates (the forward budget he
  // fills in on /finance). Their sum is his planned next-month spend.
  const { data: estRows } = await supabase.from("expense_estimates").select("account, amount");
  const estimates = (estRows ?? []) as { account: string; amount: number }[];
  const nextMonthBudget = estimates.length
    ? {
        note: "Mitchell's own estimate for next month, per expense line (his forward budget). Use this for 'what's my burn next month' / 'can I afford X'.",
        totalMonthly: Math.round(estimates.reduce((s, e) => s + Number(e.amount), 0)),
        byLine: estimates.map((e) => ({ line: e.account, estimate: Math.round(Number(e.amount)) })).sort((a, b) => b.estimate - a.estimate)
      }
    : "No next-month budget set yet";

  // Full monthly P&L history (Nov '25 onward) — the long trend the /finance
  // Learnings view uses. Covers months BEFORE the latest uploaded P&L, so use
  // this for any month-over-month or "back in January" question.
  const { data: histRows } = await supabase
    .from("pnl_monthly")
    .select("period, label, income, expenses, net, taxes, writeoffs, software, contractors, advertising")
    .order("period", { ascending: true });
  type HistRow = { period: string; label: string; income: number; expenses: number; net: number; taxes: number; writeoffs: number; software: number; contractors: number; advertising: number };
  const hist = (histRows ?? []) as HistRow[];
  const pnlHistory = hist.length
    ? {
        note: "Monthly P&L history — the source of truth for month-over-month and ANY month (incl. before the latest upload). normalizedNet = net + taxes + one-off write-offs (tax-only items added back).",
        months: hist.map((m) => ({
          month: m.label,
          revenue: Math.round(Number(m.income)),
          expenses: Math.round(Number(m.expenses)),
          net: Math.round(Number(m.net)),
          normalizedNet: Math.round(Number(m.net) + Number(m.taxes) + Number(m.writeoffs)),
          software: Math.round(Number(m.software)),
          contractors: Math.round(Number(m.contractors)),
          advertising: Math.round(Number(m.advertising))
        }))
      }
    : "No monthly history loaded";

  return {
    note: "Owner-only finances. Manual MRR is the source of truth; Stripe is a cross-check; pnlHistory has the full month-by-month P&L (use it for any month, incl. before the latest upload); the P&L expense breakdown is where to find cuts.",
    manualMrr: manual,
    stripe: stripeSummary,
    pnl,
    pnlHistory,
    software,
    payroll,
    nextMonthBudget
  };
}

// ---------------------------------------------------------------------------
// OWNER-ONLY outbound: the live pipeline and our own Meta ads, from the Meta ads
// dashboard (GET /api/outbound/board and /api/outbound/meta — the same reads
// as the Scale Room's Outbound tab and the Growth Brain). Every figure arrives
// computed by that app; the counts below only slice its rows. Honours the Scale
// Room's Outbound source switch: off means not fetched, for chat too.
// ---------------------------------------------------------------------------

const OUTBOUND_BOOKED = new Set(["booked", "proposal", "won"]);
const OUTBOUND_NOT_BOOKED = new Set(["new", "contacted", "no_response"]);
const DAY_MS = 86_400_000;

async function outboundGate(ctx: ToolContext): Promise<{ error: string } | null> {
  if (!isOwner(ctx.actor)) {
    return { error: "access denied — the outbound pipeline and our ad account are private to the owner (Mitchell) only" };
  }
  // Owner check above stays first so a non-owner never costs a settings read.
  // A failed read comes back as outbound:false with a readError — say that,
  // not "switched off", or the model tells Mitchell to flip a switch that's on.
  const sources = await getScaleSources();
  if (sources.readError) {
    return { error: `couldn't read the Scale Room's Outbound switch (${sources.readError}) — nothing was fetched; try again` };
  }
  if (!sources.outbound) {
    return { error: "the Outbound source is switched off in the Scale Room, so nothing is read from the Meta ads dashboard — switch it on from /scale to use this" };
  }
  return null;
}

export async function getOutboundPipelineTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await outboundGate(ctx);
  if (denied) return denied;
  const res = await getOutboundBoard(20_000);
  if (!res.ok) return { error: `live pipeline unavailable: ${res.error} (do not treat as an empty pipeline)` };
  const b = res.data;
  const now = Date.now();
  const ageDays = (iso: string | null) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS)) : null);
  const label = (k: string) => b.stages.find((s) => s.key === k)?.label ?? k;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);

  const stage = str(input.stage);
  const source = str(input.source);
  const owner = str(input.owner);
  const followUp = str(input.followUp);
  const search = str(input.search);
  // Small default: every lead row costs output-sized context, and a long list
  // left the chat answer cut off. Counts above always cover the whole board.
  const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 25), 1), 100);

  const matches = b.prospects.filter((p) => {
    if (stage === "booked_or_beyond" ? !OUTBOUND_BOOKED.has(p.stage) : stage === "not_booked" ? !OUTBOUND_NOT_BOOKED.has(p.stage) : stage && p.stage !== stage) return false;
    if (source && !(p.source ?? "").toLowerCase().includes(source)) return false;
    if (owner && (p.owner ?? "").toLowerCase() !== owner) return false;
    if (followUp && p.followUp !== followUp) return false;
    if (search && ![p.facility, p.name, p.location, p.nextAction].some((f) => (f ?? "").toLowerCase().includes(search))) return false;
    return true;
  });

  const bySource = new Map<string, { leads: number; bookedOrBeyond: number }>();
  for (const p of b.prospects) {
    const k = p.source || "(no source)";
    const e = bySource.get(k) ?? { leads: 0, bookedOrBeyond: 0 };
    e.leads++;
    if (OUTBOUND_BOOKED.has(p.stage)) e.bookedOrBeyond++;
    bySource.set(k, e);
  }
  const cold = b.prospects.filter((p) => p.stage === "new" || p.stage === "no_response");
  const coldAge = { upTo7d: 0, d8to14: 0, d15to30: 0, over30d: 0 };
  for (const p of cold) {
    const a = ageDays(p.createdAt);
    if (a == null) continue;
    if (a <= 7) coldAge.upTo7d++; else if (a <= 14) coldAge.d8to14++; else if (a <= 30) coldAge.d15to30++; else coldAge.over30d++;
  }
  const within = (d: number) => b.prospects.filter((p) => { const a = ageDays(p.createdAt); return a != null && a <= d; }).length;

  return {
    note: "LIVE from the Meta ads dashboard's Outbound board (the board the reps work). These are PROSPECTS we are trying to win, not existing clients. Counts and breakdowns cover the whole pipeline; `leads` is the filtered list.",
    generatedAt: b.generatedAt,
    pipeline: b.pipeline,
    stages: b.stages.map((s) => ({ stage: s.label, key: s.key, count: s.count })),
    texting: {
      reps: b.queues.reps.map((r) => ({ rep: r.owner, leftToTextToday: r.queued, dailyCap: r.dailyCap })),
      backlog: b.queues.backlog,
      notYetReached: cold.length,
      notYetReachedByAgeSinceTheyCameIn: coldAge
    },
    newLeads: { last7Days: within(7), last30Days: within(30) },
    bySource: [...bySource.entries()].sort((x, y) => y[1].leads - x[1].leads).map(([k, v]) => ({ source: k, ...v })),
    adMonths: b.ads.ok
      ? b.ads.months.slice(0, 6).map((m) => ({ month: m.period, spend: m.spend, estimate: m.isEstimate, adFormProspects: m.prospects, nowBooked: m.booked, costPerLead: m.costPerLead, costPerBooked: m.costPerBooked, topCampaigns: m.campaigns.slice(0, 3) }))
      : { error: b.ads.error },
    filter: { stage, source, owner, followUp, search },
    matchingLeads: matches.length,
    leads: matches.slice(0, limit).map((p) => ({
      facility: p.facility,
      contact: p.name,
      role: p.role,
      location: p.location,
      stage: label(p.stage),
      rep: p.owner,
      lastTextedBy: p.lastTextedBy,
      source: p.source,
      budgetPerMonth: p.value && p.value > 0 ? p.value : null,
      followUp: p.followUp,
      nextAction: p.nextAction,
      nextActionDue: p.nextActionAt,
      lastContacted: p.lastContactedAt,
      cameInDaysAgo: ageDays(p.createdAt),
      website: p.website
    })),
    truncated: matches.length > limit
  };
}

export async function getMetaAdsTool(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await outboundGate(ctx);
  if (denied) return denied;
  const days = metaDays(input.days);
  const res = await getOutboundMeta(days, 30_000);
  if (!res.ok) return { error: `live Meta read unavailable: ${res.error} (do not treat as zero spend)` };
  const d = res.data;
  const costPerBooking = d.pipeline.booked > 0 ? Math.round((d.totals.spend / d.pipeline.booked) * 100) / 100 : null;
  const priorCostPerBooking = d.pipeline.priorBooked > 0 ? Math.round((d.priorTotals.spend / d.pipeline.priorBooked) * 100) / 100 : null;
  // The day-by-day series is opt-in: up to 90 rows the model rarely needs for
  // a totals/campaign question, and it pushed answers past the output limit.
  // Strictly `true` — a stray truthy string shouldn't pull the whole series.
  const includeDaily = input.includeDaily === true;
  return {
    note:
      "LIVE from Meta for OUR OWN ad account (not a client's). ctr is a percent; cpm is per 1,000 impressions; frequency over the whole window grows with the window, so compare like with like. Leads are Meta-reported." +
      (includeDaily ? "" : " The day-by-day series is omitted — call again with includeDaily: true if the question needs specific days or a trend within the window."),
    account: d.accountLabel,
    window: d.range,
    priorWindow: d.prior,
    totals: d.totals,
    priorTotals: d.priorTotals,
    adFormPipeline: { ...d.pipeline, costPerBooking, priorCostPerBooking },
    ...(includeDaily
      ? { daily: d.daily.map((x) => ({ date: x.date, spend: x.spend, leads: x.leads, clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, frequency: x.frequency })) }
      : {}),
    campaigns: d.campaigns,
    adsets: d.adsets.slice(0, 25),
    ads: d.ads.slice(0, 25).map(({ thumbnailUrl: _thumb, ...a }) => a),
    readAt: d.generatedAt
  };
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "$0";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// OWNER-ONLY memory writes. Reads are injected into the system prompt by the
// chat route / daily brief, so there's no read tool here.
async function rememberFact(input: Record<string, unknown>, ctx: ToolContext) {
  if (!isOwner(ctx.actor)) {
    return { error: "access denied — memory is owner-only" };
  }
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) return { error: "content required" };
  const mem = await addMemory(content, input.category, ctx.actor.id);
  return { saved: true, id: mem.id, category: mem.category, content: mem.content };
}

async function forgetFact(input: Record<string, unknown>, ctx: ToolContext) {
  if (!isOwner(ctx.actor)) {
    return { error: "access denied — memory is owner-only" };
  }
  const id = typeof input.id === "string" ? input.id : "";
  if (!id) return { error: "id required" };
  const ok = await forgetMemory(id);
  return ok ? { forgotten: true, id } : { error: "could not forget (bad id?)" };
}

// OWNER-ONLY: stage a drafted new email as a "Send email" action card. The
// send itself happens only when Mitchell clicks Send (see /api/brain/compose).
function proposeEmail(input: Record<string, unknown>, ctx: ToolContext) {
  if (!isOwner(ctx.actor)) {
    return { error: "access denied — sending email is owner-only" };
  }
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!to || !subject || !body) return { error: "to, subject, and body are required" };
  ctx.proposals.push({
    kind: "send_email",
    id: `email_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    to,
    subject,
    body,
    purpose: typeof input.purpose === "string" ? input.purpose : null
  });
  return { staged: true, to, subject };
}
