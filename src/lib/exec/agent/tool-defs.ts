import type { ToolName } from "@/lib/exec/agent/types";
import type { ExecToolDef } from "@/lib/exec/llm/request";

// The 16 strict chat tool definitions (P5b contract §3.10; Area B; pure):
// constants built at module load from literals only, in request order (the
// cached prefix, PLAN:188; never reorder). Imports types only (test 5), so
// TOOLS_VERSION's sha256 is computed by a small local implementation rather
// than node:crypto.
//
// Every schema is { type: "object", properties, required: [every property],
// additionalProperties: false } on a strict tool. Allowed keywords: type,
// enum, description, properties, required, additionalProperties. Sentinels
// ('' for none/any, an any/active member, a boolean) replace optional
// parameters; numeric bounds are enums of integers; no enum value is data.

export interface ExecChatTool {
  name: ToolName;
  def: ExecToolDef;            // { name, description, input_schema, strict: true }
  label: string;               // progress label (§3.11.5)
  kind: "read" | "staged";
  usesEmail: boolean;
  timeoutMs: number;
}

const READ_MS = 25_000;
const SLOW_MS = 40_000;

type Props = Record<string, Record<string, unknown>>;

function tool(name: ToolName, label: string, kind: "read" | "staged", usesEmail: boolean, timeoutMs: number, description: string, properties: Props): ExecChatTool {
  return {
    name,
    label,
    kind,
    usesEmail,
    timeoutMs,
    def: {
      name,
      description,
      input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
      strict: true
    }
  };
}

const TOOLS: ExecChatTool[] = [
  tool(
    "get_overview",
    "Checking the company overview",
    "read",
    false,
    READ_MS,
    "Company snapshot for a time window. Returns what changed in the window (tasks finished and created, new Needs Attention items) and what stands now (open overdue work, approvals waiting, projects in trouble, email buckets when email is on, today's activity). Use it first for broad questions such as 'catch me up', 'what is happening across the company' or 'what did I miss yesterday'.",
    {
      since: {
        type: "string",
        enum: ["today", "yesterday", "last_24h", "last_7_days"],
        description: "The window for what changed. today = since his local midnight; yesterday = his local yesterday; last_7_days includes today."
      }
    }
  ),
  tool(
    "list_attention",
    "Reading Needs Attention",
    "read",
    false,
    READ_MS,
    "The Needs Attention feed, already screened: situations flagged for him, highest priority first, each with what happened, why it matters, a labelled suggested next step, its sources and its age. Filter by status, category, priority band and source. Use it for 'what needs my attention', for decisions waiting on him (category approval or my_action) and for email items (source email).",
    {
      status: { type: "string", enum: ["active", "open", "seen", "snoozed", "dismissed", "resolved"], description: "active = open and seen, what the feed shows." },
      category: { type: "string", enum: ["any", "my_action", "approval", "delegated", "intervene", "fyi", "on_track"] },
      band: { type: "string", enum: ["any", "critical", "high", "normal"] },
      source: { type: "string", enum: ["any", "dd", "email", "slack"] },
      limit: { type: "integer", enum: [10, 25, 50] }
    }
  ),
  tool(
    "team_progress",
    "Checking team progress",
    "read",
    false,
    READ_MS,
    "Workload and flow per person or per department from DD records. view=progress: open, in progress, overdue (including auto-archived), stalled, waiting on client, pending approval, the tasks finished in the window (listed for departments, and for people when a department is given), and indicators with their sample size and their own 30-day window (on-time rate, typical turnaround, extension rate, EOD reports filed). view=working_now: tasks in progress, who is clocked in and on what, and today's submitted start-of-day priorities in their own words. It never ranks or scores people.",
    {
      view: { type: "string", enum: ["progress", "working_now"] },
      window: {
        type: "string",
        enum: ["this_week", "last_week", "last_7_days", "last_30_days"],
        description:
          "The finished-work window for view=progress: this_week and last_week start Monday in his timezone; last_7_days and last_30_days end now. Indicators always cover the last 30 days. Ignored for working_now."
      },
      group_by: { type: "string", enum: ["person", "department"] },
      department: { type: "string", description: "'' for every department, or a department id or name." }
    }
  ),
  tool(
    "search_tasks",
    "Searching tasks",
    "read",
    false,
    READ_MS,
    "Find DD tasks by words in the title, assignee, client, status and due date. Returns the total number of matches and up to limit of them, most recent activity first. Open tasks include overdue ones that were auto-archived (flagged). include_done adds tasks finished in the last 90 days. Use get_task for one task's description and comments.",
    {
      query: { type: "string", description: "Words that must all appear in the title; '' for none." },
      assignee: { type: "string", description: "'' for anyone, 'me', 'unassigned', or a person's id or name." },
      client: { type: "string", description: "'' for any, or a client id or name." },
      status: { type: "string", enum: ["any", "pending", "in_progress", "urgent", "waiting_on_client", "pending_approval", "overdue", "stalled"] },
      due: { type: "string", enum: ["any", "overdue", "today", "next_7_days", "no_due_date"] },
      include_done: { type: "boolean", description: "Also match tasks finished in the last 90 days (only with status any)." },
      limit: { type: "integer", enum: [10, 25, 50] }
    }
  ),
  tool(
    "get_task",
    "Opening a task",
    "read",
    false,
    READ_MS,
    "One DD task in full: status, people, client, project and stage, dates and flags, its description, and its timeline newest first: comments, status changes, handoffs with their notes, deadline extensions with their reasons, and legacy messages. People's own words come back inside untrusted blocks, clipped.",
    {
      task_id: { type: "string", description: "The DD task id, from a search result or an earlier answer." }
    }
  ),
  tool(
    "project_health",
    "Checking project health",
    "read",
    false,
    SLOW_MS,
    "DD project health. project_id '' lists every project with its derived status (on track, at risk, off track, no data), the reasons, stage progress and active stage; only_problems keeps the at-risk and off-track ones. A project id or name returns the detail: stages, stuck-stage signals, overdue work and extensions, blockers (derived, and AI-assessed from comments and notes), recent updates, meeting-brief risks and related email threads. DD has no dependency links: blockers are signals.",
    {
      project_id: { type: "string", description: "'' for every project, or a project id or name." },
      only_problems: { type: "boolean", description: "List view only: keep at-risk and off-track projects." }
    }
  ),
  tool(
    "pending_approvals",
    "Checking approvals",
    "read",
    false,
    READ_MS,
    "Work waiting for approval in DD, per mechanism: AI-drafted tasks, Facebook proofs, client email drafts, intake emails needing routing, EOD reports to review, and check-ins from today's brief not sent yet. Counts and the oldest waiting item for every mechanism, and the items themselves (title, requester, waiting since, who must approve) where DD can list them.",
    {
      mechanism: { type: "string", enum: ["any", "draft_tasks", "fb_proofs", "email_drafts", "unrouted_mail", "eod_reviews", "checkins"] }
    }
  ),
  tool(
    "recurring_issues",
    "Looking for recurring problems",
    "read",
    false,
    READ_MS,
    "Recurring operational problems: incidents that repeat for the same issue and site, sites with repeated low health scores, tasks extended again and again, and people filing many extensions. Each group has its counts over 30 and 90 days.",
    {
      window_days: { type: "integer", enum: [30, 90] }
    }
  ),
  tool(
    "client_overview",
    "Looking up a client",
    "read",
    false,
    SLOW_MS,
    "One client: status, health and touchpoint labels with when they were computed, open and recently finished tasks, work waiting on the client, related projects, open Needs Attention items, recent meetings with their AI-assessed risks, and, when email is on, his recent threads with the client and open commitments. Pass a client id or exact name; an ambiguous or partial name returns the matches to choose from.",
    {
      client: { type: "string", description: "A client id or name." }
    }
  ),
  tool(
    "search_email",
    "Searching your email",
    "read",
    true,
    SLOW_MS,
    "Search his own mailbox (inbox and sent). Combines threads already triaged (with their AI summary and bucket) with a live search. Only subjects and participants are searchable, never message bodies. Threads from restricted senders are never returned, only counted. Use get_email_thread to read one.",
    {
      query: { type: "string", description: "Words matched against subjects and participants; '' for none." },
      bucket: {
        type: "string",
        enum: ["any", "reply", "urgent", "important", "waiting", "filtered"],
        description: "Triaged threads only: reply = needs his reply, waiting = waiting on others."
      },
      from: { type: "string", description: "'' or a sender's name, address or domain." },
      since_days: { type: "integer", enum: [7, 30, 90, 365] },
      limit: { type: "integer", enum: [10, 25] }
    }
  ),
  tool(
    "get_email_thread",
    "Reading an email thread",
    "read",
    true,
    SLOW_MS,
    "Read one of his email threads: his copies only, newest messages first, quoted history cut, text clipped and returned inside untrusted blocks, plus the stored triage (summary, urgency, decision question) and its commitments. A restricted or unavailable thread returns nothing.",
    {
      thread_id: { type: "string", description: "A thread id from search_email, an attention item or an earlier answer." }
    }
  ),
  tool(
    "list_commitments",
    "Checking email commitments",
    "read",
    true,
    READ_MS,
    "Commitments found in his email: what he promised others (mitchell_owes) and what others promised him (owed_to_mitchell), with due dates and status. Commitments made in Slack aren't available yet.",
    {
      direction: { type: "string", enum: ["any", "mitchell_owes", "owed_to_mitchell"] },
      status: { type: "string", enum: ["open", "followed_up", "expired", "any"] }
    }
  ),
  tool(
    "get_eod_reports",
    "Reading EOD reports",
    "read",
    false,
    READ_MS,
    "Submitted end-of-day reports for one ET calendar day: what each person worked on, finished, plans next and is blocked by (their own words, inside untrusted blocks, clipped), when it was submitted and whether it was reviewed, and who was expected to file and hasn't. Unsubmitted drafts, and reports edited after they were submitted, are never shown.",
    {
      date: { type: "string", description: "'today', 'yesterday', or an ET calendar date as YYYY-MM-DD." },
      person: { type: "string", description: "'' for everyone, or a person's id or name." }
    }
  ),
  tool(
    "propose_task",
    "Drafting a task for you to confirm",
    "staged",
    false,
    READ_MS,
    "Stage a new DD task for him to confirm, only when his newest message asks for one. Nothing is created until he clicks Confirm on the card, so say you've drafted it for his confirmation. The assignee and client are resolved by id or exact name; an ambiguous or partial name returns the matches instead of a card. At most 5 per question.",
    {
      title: { type: "string", description: "A short title, at most 200 characters." },
      description: { type: "string", description: "What needs doing and why, at most 4000 characters; '' for none." },
      assignee: { type: "string", description: "'' for unassigned, 'me', or a person's id or name." },
      due_date: { type: "string", description: "'' for none, or YYYY-MM-DD in his timezone (due at 5 PM that day)." },
      client: { type: "string", description: "'' for none, or a client id or name." },
      priority: { type: "string", enum: ["low", "medium", "high", "critical"] }
    }
  ),
  tool(
    "create_draft",
    "Starting an email draft",
    "staged",
    true,
    SLOW_MS,
    "Start a reply draft on one of his email threads, only when his newest message asks for one, written by the drafting assistant from your instruction. It is never sent: he reviews, edits and sends it from DD. Returns a link to the draft; if the thread already has an open draft, returns that one. At most 3 per question.",
    {
      thread_id: { type: "string" },
      instruction: { type: "string", description: "What the reply should say, at most 2000 characters." }
    }
  ),
  tool(
    "get_source",
    "Re-checking a source",
    "read",
    false,
    SLOW_MS,
    "Re-check one cited item by its ref (such as r12) from this conversation: re-reads the task, client, project, email thread, attention item, report or approval it points to, with the same screening as the tool that first returned it.",
    {
      ref: { type: "string", description: "A ref from this conversation, such as r12." }
    }
  )
];

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

/** deep-frozen, in the order of CHAT_TOOL_NAMES */
export const CHAT_TOOLS: readonly ExecChatTool[] = deepFreeze(TOOLS);
/** CHAT_TOOLS.map(t => t.def), deep-frozen */
export const CHAT_TOOL_DEFS: readonly ExecToolDef[] = deepFreeze(TOOLS.map((t) => t.def));

// ---------------------------------------------------------------------------
// sha256 (FIPS 180-4), over the UTF-8 bytes of a string, as lowercase hex.
// Local so this module imports types only; tool-defs.test.ts checks it
// against node:crypto.
// ---------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0) ?? 0;
    // A lone surrogate encodes as U+FFFD, as TextEncoder and Buffer do.
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** Exported for the self-check in tool-defs.test.ts only. */
export function sha256Hex(s: string): string {
  const bytes = utf8(s);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLength / 0x100000000);
  const lo = bitLength >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t += 1) {
      const j = i + t * 4;
      w[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** sha256 hex (first 16) of JSON.stringify(CHAT_TOOL_DEFS) */
export const TOOLS_VERSION: string = sha256Hex(JSON.stringify(CHAT_TOOL_DEFS)).slice(0, 16);

// ---------------------------------------------------------------------------
// The strict budget (B2; skill structured-outputs: per request, across every
// strict schema, 20 tools, 24 optional parameters, 16 union-typed ones).
// ---------------------------------------------------------------------------

const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set(["type", "enum", "description", "properties", "required", "additionalProperties", "items"]);
const UNION_KEYWORDS: ReadonlySet<string> = new Set(["anyOf", "oneOf", "allOf"]);

export function strictBudget(defs: readonly ExecToolDef[]): { tools: number; optional: number; unions: number; forbidden: string[] } {
  let tools = 0;
  let optional = 0;
  let unions = 0;
  const forbidden: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.type) || Object.keys(n).some((k) => UNION_KEYWORDS.has(k))) unions += 1;
    for (const [k, v] of Object.entries(n)) {
      if (k === "minItems" && (typeof v !== "number" || v > 1)) forbidden.push(`${path}.${k}`);
      else if (k === "minItems") continue;
      else if (!ALLOWED_KEYWORDS.has(k)) forbidden.push(`${path}.${k}`);
      if (k === "type" && Array.isArray(v)) forbidden.push(`${path}.type[]`);
    }
    const props = n.properties;
    if (typeof props === "object" && props !== null && !Array.isArray(props)) {
      const required = new Set(Array.isArray(n.required) ? n.required.filter((x): x is string => typeof x === "string") : []);
      for (const [key, child] of Object.entries(props as Record<string, unknown>)) {
        if (!required.has(key)) optional += 1;
        visit(child, `${path}.properties.${key}`);
      }
    }
    if (n.items !== undefined) visit(n.items, `${path}.items`);
    for (const k of UNION_KEYWORDS) {
      const list = n[k];
      if (Array.isArray(list)) list.forEach((x, i) => visit(x, `${path}.${k}[${i}]`));
    }
  };
  for (const def of defs) {
    if (def.strict === true) tools += 1;
    visit(def.input_schema, def.name);
  }
  return { tools, optional, unions, forbidden };
}
