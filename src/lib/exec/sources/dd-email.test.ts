import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { principalFromRows } from "@/lib/exec/principal";
import {
  DdReadError,
  latestScoredInboundByClient,
  listClientMatchSignals,
  listClientMeetings,
  listSatisfactionSignals,
  listTasksForThread
} from "@/lib/exec/sources/dd";
import type { ExecPrincipal } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// P3's DD reads for email correlation and the email producers (contract
// §3.12, L13, L14): fail closed, paged in a stable order, explicit columns,
// and nothing about the mail beyond what the contract allows (the satisfaction
// read never selects the subject or the model's reason, and returns no sender
// or thread id).

// ---------------------------------------------------------------------------
// A PostgREST stand-in for these reads: select / eq / gte / in / not.is.null /
// like (PostgREST's "*" alias and LIKE's "\" escapes) / or (with quoted
// values) / order / range / limit. SQL semantics: NULL never compares true.
// Selecting a column the fixture row lacks fails the query, as PostgREST does.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Term = { column: string; op: string; value: string };
type Filter =
  | { kind: "eq" | "gte"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "notnull"; column: string }
  | { kind: "like"; column: string; pattern: string }
  | { kind: "or"; terms: Term[]; raw: string };

interface Recorded {
  table: string;
  columns: string;
  filters: Filter[];
  orders: { column: string; ascending: boolean }[];
  range: [number, number] | null;
  limit: number | null;
  signal: AbortSignal | null;
}

/** Split an or() list on commas outside double quotes, then each term on its first two dots. */
function parseOr(expr: string): Term[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of expr) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => {
    const m = /^([a-z_]+)\.([a-z]+)\.(.*)$/.exec(p);
    if (!m) throw new Error(`fake: bad or() term ${p}`);
    const value = m[3].startsWith('"') && m[3].endsWith('"') ? m[3].slice(1, -1) : m[3];
    if (!m[3].startsWith('"') && /[(),]/.test(m[3])) throw new Error(`fake: unquoted reserved character in ${p}`);
    return { column: m[1], op: m[2], value };
  });
}

/** PostgREST like: "*" is "%"; then SQL LIKE with "\" escaping the next character. */
function likeRegex(pattern: string): RegExp {
  let out = "^";
  const p = pattern.replace(/\*/g, "%");
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === "\\" && i + 1 < p.length) {
      out += p[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    } else if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

function cmp(a: unknown, b: unknown): number {
  const ta = typeof a === "string" ? Date.parse(a) : Number.NaN;
  const tb = typeof b === "string" ? Date.parse(b) : Number.NaN;
  if (typeof a === "string" && typeof b === "string" && /^\d{4}-/.test(a) && /^\d{4}-/.test(b) && Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matches(row: Row, f: Filter): boolean {
  const v = "column" in f ? row[f.column] : undefined;
  switch (f.kind) {
    case "eq":
      return v !== null && v !== undefined && cmp(v, f.value) === 0;
    case "gte":
      return v !== null && v !== undefined && cmp(v, f.value) >= 0;
    case "in":
      return v !== null && v !== undefined && f.values.some((x) => cmp(v, x) === 0);
    case "notnull":
      return v !== null && v !== undefined;
    case "like":
      return typeof v === "string" && likeRegex(f.pattern).test(v);
    case "or":
      return f.terms.some((t) => {
        const cell = row[t.column];
        if (t.op === "is") return t.value === "null" ? cell === null || cell === undefined : false;
        if (cell === null || cell === undefined) return false;
        if (t.op === "neq") return String(cell) !== t.value;
        if (t.op === "eq") return String(cell) === t.value;
        throw new Error(`fake: unsupported or() op ${t.op}`);
      });
  }
}

interface Fake {
  client: unknown;
  queries: Recorded[];
}

function fakeDb(tables: Record<string, Row[]>, fail?: (q: Recorded) => string | null): Fake {
  const fake: Fake = { client: null, queries: [] };
  const run = (q: Recorded) => {
    fake.queries.push(q);
    if (q.signal?.aborted) return { data: null, error: { message: "AbortError" } };
    const failed = fail?.(q);
    if (failed) return { data: null, error: { message: failed } };
    let rows = (tables[q.table] ?? []).filter((r) => q.filters.every((f) => matches(r, f)));
    rows = [...rows].sort((a, b) => {
      for (const o of q.orders) {
        const c = cmp(a[o.column], b[o.column]);
        if (c !== 0) return o.ascending ? c : -c;
      }
      return 0;
    });
    if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
    if (q.limit !== null) rows = rows.slice(0, q.limit);
    const columns = q.columns.split(",").map((c) => c.trim());
    const out: Row[] = [];
    for (const r of rows) {
      const o: Row = {};
      for (const c of columns) {
        if (!(c in r)) return { data: null, error: { message: `column ${q.table}.${c} does not exist` } };
        o[c] = r[c];
      }
      out.push(o);
    }
    return { data: out, error: null };
  };
  const builder = (q: Recorded) => {
    const b = {
      eq: (column: string, value: unknown) => (q.filters.push({ kind: "eq", column, value }), b),
      gte: (column: string, value: unknown) => (q.filters.push({ kind: "gte", column, value }), b),
      in: (column: string, values: unknown[]) => (q.filters.push({ kind: "in", column, values: [...values] }), b),
      not: (column: string, op: string, value: unknown) => {
        if (op !== "is" || value !== null) throw new Error("fake: only not.is.null");
        q.filters.push({ kind: "notnull", column });
        return b;
      },
      like: (column: string, pattern: string) => (q.filters.push({ kind: "like", column, pattern }), b),
      or: (raw: string) => (q.filters.push({ kind: "or", terms: parseOr(raw), raw }), b),
      order: (column: string, o?: { ascending?: boolean }) => (q.orders.push({ column, ascending: o?.ascending !== false }), b),
      range: (from: number, to: number) => ((q.range = [from, to]), b),
      limit: (n: number) => ((q.limit = n), b),
      abortSignal: (s: AbortSignal) => ((q.signal = s), b),
      then: <A, B>(ok?: (v: unknown) => A, ko?: (e: unknown) => B) => Promise.resolve().then(() => run(q)).then(ok, ko)
    };
    return b;
  };
  fake.client = {
    from: (table: string) => ({
      select: (columns: string) => builder({ table, columns, filters: [], orders: [], range: null, limit: null, signal: null })
    })
  };
  return fake;
}

let db: Fake;
function useDb(tables: Record<string, Row[]>, fail?: (q: Recorded) => string | null) {
  db = fakeDb(tables, fail);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
}

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: ["acct-1"], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const NOW = new Date("2026-11-04T13:00:00.000Z");

function rule(id: string, pattern: string, matchKind: "domain" | "exact"): RestrictedSenderRule {
  return { id, pattern, matchKind, label: id, viewerUserIds: new Set() };
}

beforeEach(() => {
  useDb({});
});

// ---------------------------------------------------------------------------

describe("listClientMatchSignals", () => {
  const client = (over: Row): Row => ({
    id: "cl_a",
    name: "Acme",
    status: "active",
    website: "https://acme.com/",
    websites: ["https://acme.com/"],
    contact_emails: ["jane@acme.com"],
    priority: "high",
    notes: "never read",
    ...over
  });

  it("reads the match columns of every client, paged by id, and normalizes the arrays", async () => {
    useDb({
      clients: [
        client({ id: "cl_b", status: null, websites: null, contact_emails: null, priority: null, website: null }),
        client({}),
        client({ id: "cl_c", status: "paused", contact_emails: ["x@c.com", 7] })
      ]
    });
    const out = await listClientMatchSignals(principal);
    expect(out).toEqual([
      { id: "cl_a", name: "Acme", status: "active", website: "https://acme.com/", websites: ["https://acme.com/"], contactEmails: ["jane@acme.com"], priority: "high" },
      { id: "cl_b", name: "Acme", status: null, website: null, websites: [], contactEmails: [], priority: null },
      { id: "cl_c", name: "Acme", status: "paused", website: "https://acme.com/", websites: ["https://acme.com/"], contactEmails: ["x@c.com"], priority: "high" }
    ]);
    expect(db.queries[0]).toMatchObject({ table: "clients", columns: "id,name,status,website,websites,contact_emails,priority", orders: [{ column: "id", ascending: true }], range: [0, 999] });
  });

  it("throws instead of reading as no clients", async () => {
    useDb({ clients: [client({})] }, () => "permission denied");
    await expect(listClientMatchSignals(principal)).rejects.toThrow(DdReadError);
  });

  it("pages past 1000 clients", async () => {
    useDb({ clients: Array.from({ length: 1_001 }, (_, i) => client({ id: `cl_${String(i).padStart(5, "0")}` })) });
    expect(await listClientMatchSignals(principal)).toHaveLength(1_001);
    expect(db.queries.map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999]
    ]);
  });
});

describe("listSatisfactionSignals", () => {
  const score = (over: Row): Row => ({
    message_id: "m1",
    client_id: "cl_a",
    thread_id: "th_1",
    account_id: "acct-x",
    direction: "inbound",
    from_address: "Jane Doe <jane@acme.com>",
    subject: "SECRET SUBJECT",
    delivered_at: "2026-11-03T10:00:00+00:00",
    satisfaction_score: 40,
    reason: "SECRET REASON",
    scored_at: "2026-11-03T11:00:00+00:00",
    scored_by: "claude-haiku-4-5",
    ...over
  });
  const SINCE = "2026-10-28T13:00:00.000Z";
  const screen = { rules: [] as RestrictedSenderRule[], tombstonedThreadIds: [] as string[] };

  it("returns numbers only: client, score, delivered and scored times", async () => {
    useDb({ email_satisfaction_scores: [score({})] });
    const out = await listSatisfactionSignals(principal, SINCE, screen);
    expect(out).toEqual([{ clientId: "cl_a", score: 40, deliveredAt: "2026-11-03T10:00:00+00:00", scoredAt: "2026-11-03T11:00:00+00:00" }]);
    expect(JSON.stringify(out)).not.toMatch(/SECRET|jane|th_1/);
  });

  it("never selects the subject or the reason, and filters inbound, since, and real scores", async () => {
    useDb({ email_satisfaction_scores: [score({})] });
    await listSatisfactionSignals(principal, SINCE, screen);
    const q = db.queries[0];
    expect(q.columns.split(",")).toEqual(["client_id", "satisfaction_score", "delivered_at", "scored_at", "from_address", "thread_id"]);
    expect(q.columns).not.toMatch(/subject|reason/);
    expect(q.filters).toEqual(
      expect.arrayContaining([
        { kind: "eq", column: "direction", value: "inbound" },
        { kind: "gte", column: "delivered_at", value: SINCE },
        expect.objectContaining({ kind: "or", raw: 'reason.is.null,reason.neq."(model returned no score)"' })
      ])
    );
    expect(q.orders).toEqual([
      { column: "message_id", ascending: true },
      { column: "client_id", ascending: true }
    ]);
  });

  it("keeps the rows the filters let through", async () => {
    useDb({
      email_satisfaction_scores: [
        score({ message_id: "keep-null-reason", reason: null }),
        score({ message_id: "keep-reason" }),
        score({ message_id: "drop-unparsed", reason: "(model returned no score)", satisfaction_score: 75 }),
        score({ message_id: "drop-outbound", direction: "outbound" }),
        score({ message_id: "drop-old", delivered_at: "2026-10-01T00:00:00+00:00" }),
        score({ message_id: "drop-undelivered", delivered_at: null })
      ]
    });
    const out = await listSatisfactionSignals(principal, SINCE, screen);
    expect(out).toHaveLength(2);
  });

  it("drops rows whose sender matches a rule (exact, domain, subdomain) or can't be screened", async () => {
    useDb({
      email_satisfaction_scores: [
        score({ message_id: "a", from_address: "payroll@deel.com" }),
        score({ message_id: "b", from_address: "Ops <ops@mail.deel.com>" }),
        score({ message_id: "c", from_address: "rm@gmail.com" }),
        score({ message_id: "d", from_address: "someone@notdeel.com" }),
        score({ message_id: "e", from_address: null }),
        score({ message_id: "f", from_address: "no address here" }),
        score({ message_id: "g", from_address: "x@deel.com.evil.io" })
      ]
    });
    const out = await listSatisfactionSignals(principal, SINCE, {
      rules: [rule("r1", "deel.com", "domain"), rule("r2", "rm@gmail.com", "exact")],
      tombstonedThreadIds: []
    });
    // d (lookalike domain) and g (deel.com as a prefix) stay; the rest go.
    expect(out).toHaveLength(2);
  });

  it("drops rows of his tombstoned threads", async () => {
    useDb({
      email_satisfaction_scores: [score({ message_id: "a", thread_id: "th_dead" }), score({ message_id: "b", thread_id: "th_live" })]
    });
    const out = await listSatisfactionSignals(principal, SINCE, { rules: [], tombstonedThreadIds: new Set(["th_dead"]) });
    expect(out).toHaveLength(1);
  });

  it("skips malformed rows rather than guessing", async () => {
    useDb({
      email_satisfaction_scores: [
        score({ message_id: "a", client_id: null }),
        score({ message_id: "b", satisfaction_score: "not a number" }),
        score({ message_id: "c", scored_at: "never" }),
        score({ message_id: "d", satisfaction_score: "62" })
      ]
    });
    expect(await listSatisfactionSignals(principal, SINCE, screen)).toEqual([expect.objectContaining({ score: 62 })]);
  });

  it("throws on a failed read, and on a missing rule list", async () => {
    useDb({ email_satisfaction_scores: [score({})] }, () => "statement timeout");
    await expect(listSatisfactionSignals(principal, SINCE, screen)).rejects.toThrow(DdReadError);
    await expect(listSatisfactionSignals(principal, SINCE, { rules: undefined as unknown as RestrictedSenderRule[], tombstonedThreadIds: [] })).rejects.toThrow(
      TypeError
    );
    await expect(listSatisfactionSignals(principal, "yesterday", screen)).rejects.toThrow(TypeError);
  });
});

describe("latestScoredInboundByClient", () => {
  const row = (over: Row): Row => ({
    message_id: "m",
    client_id: "cl_a",
    direction: "inbound",
    reason: null,
    scored_at: "2026-11-03T11:00:00+00:00",
    ...over
  });

  it("is the newest usable inbound scored_at per client, within the lookback", async () => {
    useDb({
      email_satisfaction_scores: [
        row({ message_id: "1", scored_at: "2026-11-01T00:00:00+00:00" }),
        row({ message_id: "2", scored_at: "2026-11-03T00:00:00+00:00" }),
        row({ message_id: "3", client_id: "cl_b", scored_at: "2026-10-20T00:00:00+00:00" }),
        row({ message_id: "4", client_id: "cl_c", direction: "outbound", scored_at: "2026-11-04T00:00:00+00:00" }),
        row({ message_id: "5", client_id: "cl_d", reason: "(model returned no score)", scored_at: "2026-11-04T00:00:00+00:00" }),
        row({ message_id: "6", client_id: "cl_e", scored_at: "2026-09-01T00:00:00+00:00" })
      ]
    });
    const out = await latestScoredInboundByClient(principal, { now: NOW });
    expect(Object.fromEntries(out)).toEqual({ cl_a: "2026-11-03T00:00:00+00:00", cl_b: "2026-10-20T00:00:00+00:00" });
    expect(db.queries[0].columns).toBe("client_id,scored_at");
    expect(db.queries[0].filters).toContainEqual({ kind: "gte", column: "scored_at", value: "2026-10-05T13:00:00.000Z" });
  });

  it("refuses a bad lookback, and throws on a failed read", async () => {
    await expect(latestScoredInboundByClient(principal, { now: NOW, lookbackDays: 0 })).rejects.toThrow(TypeError);
    useDb({}, () => "boom");
    await expect(latestScoredInboundByClient(principal, { now: NOW })).rejects.toThrow(DdReadError);
  });
});

describe("listTasksForThread", () => {
  const TH = "4f1c2d3e-aaaa-bbbb-cccc-000000000001";
  const task = (over: Row): Row => ({
    id: "t1",
    title: "Reply to Acme",
    status: "pending",
    priority: "medium",
    tags: [],
    department_id: null,
    assignee_id: "u_sam",
    creator_id: "u_bot",
    project_id: null,
    stage_id: null,
    client_name: "Acme",
    due_date: null,
    created_at: "2026-11-01T00:00:00+00:00",
    completed_at: null,
    last_activity_at: "2026-11-01T00:00:00+00:00",
    archived_at: null,
    archived_by: null,
    is_draft: false,
    deleted_at: null,
    estimated_hours: 1,
    missive_thread_url: null,
    description: "never read",
    ...over
  });

  it("finds tasks by the exact ?thread=<id> suffix and through the intake log, newest first", async () => {
    useDb({
      tasks: [
        task({ id: "t1", missive_thread_url: `https://mail.example.com/?thread=${TH}`, created_at: "2026-11-01T00:00:00+00:00" }),
        task({ id: "t2", missive_thread_url: `https://old.example.com/?thread=${TH}`, created_at: "2026-11-03T00:00:00+00:00", is_draft: true }),
        task({ id: "t3", missive_thread_url: `https://mail.example.com/?thread=${TH}0` }),
        task({ id: "t4", missive_thread_url: `https://mail.example.com/?thread=${TH}&x=1` }),
        task({ id: "t5", missive_thread_url: `https://mail.example.com/?thread=${TH}`, deleted_at: "2026-11-02T00:00:00+00:00" }),
        task({ id: "t6", created_at: "2026-11-02T00:00:00+00:00" })
      ],
      email_intake_log: [
        { thread_id: TH, account_id: "acct-1", task_id: "t6", routed_via: "ai-fallback" },
        { thread_id: "other", account_id: "acct-1", task_id: "t3", routed_via: "ai-fallback" }
      ]
    });
    const out = await listTasksForThread(principal, TH);
    expect(out.map((t) => [t.id, t.isDraft])).toEqual([
      ["t2", true],
      ["t6", false],
      ["t1", false]
    ]);
    expect(Object.keys(out[0])).not.toContain("missiveThreadUrl");
    const like = db.queries[0].filters.find((f) => f.kind === "like");
    expect(like).toEqual({ kind: "like", column: "missive_thread_url", pattern: `%?thread=${TH}` });
  });

  it("escapes LIKE's wildcards and still checks the exact suffix", async () => {
    const id = "a_b%c";
    const encoded = encodeURIComponent(id); // a_b%25c
    useDb({
      tasks: [
        task({ id: "exact", missive_thread_url: `https://m.example.com/?thread=${encoded}` }),
        task({ id: "wildcard", missive_thread_url: "https://m.example.com/?thread=aXb%25c" })
      ],
      email_intake_log: []
    });
    const out = await listTasksForThread(principal, id);
    expect(out.map((t) => t.id)).toEqual(["exact"]);
    expect(db.queries[0].filters.find((f) => f.kind === "like")).toEqual({
      kind: "like",
      column: "missive_thread_url",
      pattern: "%?thread=a\\_b\\%25c"
    });
  });

  it("re-checks the suffix when PostgREST's * alias widens the match", async () => {
    useDb({
      tasks: [task({ id: "star", missive_thread_url: "https://m.example.com/?thread=a*b" }), task({ id: "other", missive_thread_url: "https://m.example.com/?thread=aZZb" })],
      email_intake_log: []
    });
    expect((await listTasksForThread(principal, "a*b")).map((t) => t.id)).toEqual(["star"]);
  });

  it("refuses a malformed thread id and throws on a failed read", async () => {
    await expect(listTasksForThread(principal, "")).rejects.toThrow(TypeError);
    await expect(listTasksForThread(principal, "a\nb")).rejects.toThrow(TypeError);
    useDb({ tasks: [], email_intake_log: [] }, (q) => (q.table === "email_intake_log" ? "boom" : null));
    await expect(listTasksForThread(principal, "t")).rejects.toThrow(DdReadError);
  });
});

describe("listClientMeetings", () => {
  it("returns id, title and when, newest first, capped", async () => {
    useDb({
      client_meetings: [
        { id: "mt1", client_id: "cl_a", title: "Kickoff", meeting_date: "2026-10-01T15:00:00+00:00", transcript: "never read" },
        { id: "mt2", client_id: "cl_a", title: "QBR", meeting_date: "2026-11-01T15:00:00+00:00", transcript: "never read" },
        { id: "mt3", client_id: "cl_b", title: "Other", meeting_date: "2026-11-02T15:00:00+00:00", transcript: "never read" },
        { id: "mt4", client_id: "cl_a", title: "Sync", meeting_date: "2026-10-15T15:00:00+00:00", transcript: "never read" }
      ]
    });
    expect(await listClientMeetings(principal, "cl_a", 2)).toEqual([
      { id: "mt2", title: "QBR", meetingAt: "2026-11-01T15:00:00+00:00" },
      { id: "mt4", title: "Sync", meetingAt: "2026-10-15T15:00:00+00:00" }
    ]);
    expect(db.queries[0]).toMatchObject({ columns: "id,title,meeting_date", limit: 2 });
  });

  it("refuses bad arguments and throws on a failed read", async () => {
    await expect(listClientMeetings(principal, "", 5)).rejects.toThrow(TypeError);
    await expect(listClientMeetings(principal, "cl_a", 0)).rejects.toThrow(TypeError);
    await expect(listClientMeetings(principal, "cl_a", 51)).rejects.toThrow(TypeError);
    useDb({}, () => "boom");
    await expect(listClientMeetings(principal, "cl_a", 5)).rejects.toThrow(DdReadError);
  });

  it("passes the signal through", async () => {
    useDb({ client_meetings: [] });
    const signal = new AbortController().signal;
    await listClientMeetings(principal, "cl_a", 5, { signal });
    expect(db.queries[0].signal).toBe(signal);
  });
});
