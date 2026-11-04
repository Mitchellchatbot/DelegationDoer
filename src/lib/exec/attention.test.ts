import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { createFakeAttentionDb, type FakeAttentionDb, type FakeCall, type Row } from "@/lib/exec/__tests__/fake-attention-db";
import {
  ATTENTION_LIMITS,
  lastAttentionRefresh,
  listAttention,
  normalizeCandidate,
  reconcile,
  syncAttention,
  type AttentionPlan
} from "@/lib/exec/attention";
import type { AttentionCandidate, AttentionItem, AttentionStatus, PriorityBand } from "@/lib/exec/attention-types";
import { principalFromRows } from "@/lib/exec/principal";
import { ddClientRef, ddTaskRef } from "@/lib/exec/refs";
import { NonRetryableError, type ExecPrincipal, type SourceRef } from "@/lib/exec/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mint(id: string, userId: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: userId, enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: userId, email: `${userId}@scaledai.org`, name: userId, work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const principal = mint("ep_1", "u_mitchell");

const NOW = new Date("2026-11-04T13:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const LATER = new Date("2026-11-04T13:10:00.000Z");
const EARLIER = "2026-11-04T12:50:00.000Z";
const FIRST_SEEN = "2026-10-30T09:00:00.000Z";
const TOMORROW = "2026-11-05T13:00:00.000Z";
const YESTERDAY = "2026-11-03T13:00:00.000Z";

const KINDS = ["overdue_tasks", "stalled_tasks", "pending_approval"] as const;
const SCOPE = { source: "dd", kinds: KINDS } as const;

const taskRef = (id = "t_1", title = "Fix the homepage form"): SourceRef => ddTaskRef({ id, title });

function candidate(over: Partial<AttentionCandidate> = {}): AttentionCandidate {
  return {
    fingerprint: "dd:overdue:assignee:u_sam",
    source: "dd",
    kind: "overdue_tasks",
    category: "delegated",
    title: "Sam has 3 overdue tasks",
    whatHappened: "3 open tasks are past their due date. The oldest is 12 days late.",
    whyItMatters: "Client work is slipping past the dates it was promised for.",
    recommendedNext: "Ask Sam for new dates, or decide whether to reassign.",
    facts: [
      { text: "Oldest due 23 Oct", basis: "record", refs: [taskRef()] },
      { text: "12 days overdue", basis: "derived", refs: [] }
    ],
    refs: [taskRef(), ddClientRef({ id: "c_1", name: "Acme Dental" })],
    priority: { score: 55, band: "high", reasons: ["Overdue tasks (base 25)", "Overdue 12 days (+24)", "3 items (+6)"] },
    stateHash: "a1b2c3d4e5f60718",
    occurredAt: "2026-10-23T00:00:00.000Z",
    ...over
  };
}

let seq = 0;
const nextId = () => `ea_${String(++seq).padStart(32, "0")}`;

/** A stored item as reconcile receives it. Row fields default from the status. */
function item(status: AttentionStatus, over: Partial<AttentionItem> = {}): AttentionItem {
  const { id, principalId, snoozeUntil, firstSeenAt, lastSeenAt, resolvedAt, resolution, updatedAt, ...content } = over;
  return {
    ...normalizeCandidate(candidate(content)),
    id: id ?? nextId(),
    principalId: principalId ?? "ep_1",
    status,
    snoozeUntil: snoozeUntil !== undefined ? snoozeUntil : status === "snoozed" ? TOMORROW : null,
    firstSeenAt: firstSeenAt ?? FIRST_SEEN,
    lastSeenAt: lastSeenAt ?? EARLIER,
    resolvedAt: resolvedAt !== undefined ? resolvedAt : status === "resolved" ? YESTERDAY : null,
    resolution: resolution !== undefined ? resolution : status === "resolved" ? "auto" : null,
    updatedAt: updatedAt ?? EARLIER
  };
}

/** The content columns a write sets for a candidate. */
function content(c: AttentionCandidate): Record<string, unknown> {
  const n = normalizeCandidate(c);
  return {
    kind: n.kind,
    category: n.category,
    priority_score: n.priority.score,
    priority_band: n.priority.band,
    priority_reasons: n.priority.reasons,
    title: n.title,
    what_happened: n.whatHappened,
    why_it_matters: n.whyItMatters,
    recommended_next: n.recommendedNext,
    facts: n.facts,
    refs: n.refs,
    state_hash: n.stateHash,
    occurred_at: n.occurredAt
  };
}

/** A stored row (snake_case) for the fake table. */
function rowOf(c: AttentionCandidate, over: Row = {}): Row {
  return {
    principal_id: "ep_1",
    fingerprint: c.fingerprint,
    source: c.source,
    ...content(c),
    first_seen_at: FIRST_SEEN,
    last_seen_at: EARLIER,
    created_at: FIRST_SEEN,
    updated_at: EARLIER,
    ...over
  };
}

const REOPEN = { status: "open", snooze_until: null, resolution: null, resolved_at: null };

function outcome(plan: AttentionPlan, row: AttentionItem): string {
  if (plan.resolves.includes(row.id)) return "resolved";
  const u = plan.updates.find((x) => x.id === row.id);
  return u ? u.change : "untouched";
}

// Characters a hostile or buggy producer might send, built from their code points.
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e); // right-to-left override

const pgTime = (iso: string) => iso.replace(".000Z", "Z").replace("Z", "+00:00");

let db: FakeAttentionDb;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
  db = createFakeAttentionDb({ now: () => NOW_ISO });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const selects = () => db.calls.filter((c) => c.op === "select");
const writes = () => db.calls.filter((c) => c.op !== "select");
const filterValue = (call: FakeCall, kind: string, col: string) => call.filters.find((f) => f[0] === kind && f[1] === col)?.[2];

// ---------------------------------------------------------------------------
// normalizeCandidate
// ---------------------------------------------------------------------------

describe("normalizeCandidate", () => {
  it("passes a clean candidate through unchanged, as a new object", () => {
    const c = candidate();
    const before = structuredClone(c);
    const n = normalizeCandidate(c);
    expect(n).toEqual(c);
    expect(n).not.toBe(c);
    expect(c).toEqual(before);
  });

  it("is idempotent", () => {
    const messy = candidate({
      title: `  Sam\nhas\t3   overdue tasks ${"x".repeat(400)}`,
      whatHappened: "a".repeat(900),
      priority: { score: 61.6, band: "high", reasons: ["  base ", "", "x".repeat(300)] },
      occurredAt: "2026-10-23"
    });
    const once = normalizeCandidate(messy);
    expect(normalizeCandidate(once)).toEqual(once);
  });

  it("clips text to ATTENTION_LIMITS as one line, without control or bidi characters", () => {
    const n = normalizeCandidate(
      candidate({
        title: "x".repeat(250),
        whatHappened: `line one\nline${NUL} two${RLO} ${"w".repeat(700)}`,
        whyItMatters: "y".repeat(601),
        recommendedNext: "z".repeat(1000),
        facts: [{ text: "f".repeat(301), basis: "record", refs: [] }]
      })
    );
    expect(n.title).toHaveLength(ATTENTION_LIMITS.title);
    expect(n.title.endsWith("…")).toBe(true);
    expect(n.whatHappened.startsWith("line one line two ")).toBe(true);
    expect(n.whatHappened).toHaveLength(ATTENTION_LIMITS.text);
    expect(n.whyItMatters).toHaveLength(ATTENTION_LIMITS.text);
    expect(n.recommendedNext).toHaveLength(ATTENTION_LIMITS.text);
    expect(n.facts[0].text).toHaveLength(ATTENTION_LIMITS.factText);
    expect(ATTENTION_LIMITS).toEqual({ title: 200, text: 600, facts: 12, factText: 300, refs: 20 });
  });

  it("caps facts at 12 (empty ones dropped first), refs at 20, and each fact's refs at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => taskRef(`t_${i}`));
    const facts = [
      { text: "   ", basis: "record" as const, refs: [] },
      ...Array.from({ length: 15 }, (_, i) => ({ text: `fact ${i}`, basis: "derived" as const, refs: many }))
    ];
    const n = normalizeCandidate(candidate({ facts, refs: many }));
    expect(n.facts.map((f) => f.text)).toEqual(Array.from({ length: 12 }, (_, i) => `fact ${i}`));
    expect(n.refs).toHaveLength(ATTENTION_LIMITS.refs);
    expect(n.facts.every((f) => f.refs.length === ATTENTION_LIMITS.refs)).toBe(true);
  });

  it("keeps only allowlisted links: anything else loses its url but keeps its label", () => {
    const ref = (url: string | null): SourceRef => ({ system: "web", id: "x1", url, label: "A page", class: "public" });
    const urls = [
      "https://evil.example/steal",
      "javascript:alert(1)",
      "http://operations.scaledai.org/tasks/t_1",
      "https://slack.com/oauth/v2/authorize?client_id=1",
      "https://outlook.office.com/mail/deeplink/compose?body=x",
      null
    ];
    const n = normalizeCandidate(candidate({ refs: urls.map(ref), facts: [{ text: "f", basis: "record", refs: urls.map(ref) }] }));
    expect(n.refs.map((r) => r.url)).toEqual(urls.map(() => null));
    expect(n.facts[0].refs.map((r) => r.url)).toEqual(urls.map(() => null));
    expect(n.refs[0].label).toBe("A page");

    const allowed = [
      "https://operations.scaledai.org/tasks/t_1",
      "https://scaledai.slack.com/archives/C123/p1700000000000100",
      "https://outlook.office.com/mail/inbox/id/AAMkAD"
    ];
    expect(normalizeCandidate(candidate({ refs: allowed.map(ref) })).refs.map((r) => r.url)).toEqual(allowed);
  });

  it("cleans each ref: label falls back to the id, excerpt clipped to 280 or dropped, unknown keys dropped", () => {
    const refs = [
      { system: "dd", id: "t_9", url: null, label: "  ", class: "internal", extra: "nope" },
      { system: "slack", id: "C1:1700000000.000100", url: null, label: "Thread", class: "private", excerpt: "e".repeat(400) },
      { system: "dd", id: "t_10", url: null, label: "No excerpt", class: "internal", excerpt: " \n " }
    ] as unknown as SourceRef[];
    const [a, b, c] = normalizeCandidate(candidate({ refs })).refs;
    expect(a).toEqual({ system: "dd", id: "t_9", url: null, label: "t_9", class: "internal" });
    expect(b.excerpt).toHaveLength(280);
    expect(c).toEqual({ system: "dd", id: "t_10", url: null, label: "No excerpt", class: "internal" });
  });

  it("clamps the score to an integer in 0..100 and cleans the reasons", () => {
    const at = (score: number) => normalizeCandidate(candidate({ priority: { score, band: "normal", reasons: [] } })).priority.score;
    expect([at(-5), at(140), at(61.6), at(61.4)]).toEqual([0, 100, 62, 61]);
    const reasons = normalizeCandidate(
      candidate({ priority: { score: 50, band: "high", reasons: ["", " Overdue tasks (base 25) ", ...Array.from({ length: 20 }, (_, i) => `r${i}`)] } })
    ).priority.reasons;
    expect(reasons[0]).toBe("Overdue tasks (base 25)");
    expect(reasons).toHaveLength(12);
  });

  it("writes occurredAt as an ISO instant, or null when it isn't a date", () => {
    const at = (occurredAt: string | null) => normalizeCandidate(candidate({ occurredAt })).occurredAt;
    expect(at("2026-10-23")).toBe("2026-10-23T00:00:00.000Z");
    expect(at("2026-10-23T05:00:00+05:00")).toBe("2026-10-23T00:00:00.000Z");
    expect(at("not a date")).toBeNull();
    expect(at(null)).toBeNull();
  });

  it("turns an empty suggestion into null", () => {
    expect(normalizeCandidate(candidate({ recommendedNext: " \n " })).recommendedNext).toBeNull();
    expect(normalizeCandidate(candidate({ recommendedNext: null })).recommendedNext).toBeNull();
    expect(normalizeCandidate(candidate({ recommendedNext: undefined as unknown as null })).recommendedNext).toBeNull();
  });

  const refusals: [string, Partial<AttentionCandidate> | ((c: AttentionCandidate) => unknown)][] = [
    ["an unknown source", { source: "teams" as never, fingerprint: "teams:x" }],
    ["an unknown category", { category: "urgent" as never }],
    ["an unknown band", { priority: { score: 50, band: "low" as PriorityBand, reasons: [] } }],
    ["an unknown fact basis", { facts: [{ text: "x", basis: "guess" as never, refs: [] }] }],
    ["an unknown ref system", { refs: [{ ...taskRef(), system: "jira" as never }] }],
    ["an unknown ref class", { refs: [{ ...taskRef(), class: "secret" as never }] }],
    ["an empty title", { title: " \n\t " }],
    ["a title that isn't a string", { title: 42 as never }],
    ["an empty fingerprint", { fingerprint: "" }],
    ["a fingerprint with a space", { fingerprint: "dd:overdue:assignee:u sam" }],
    ["a fingerprint with a comma", { fingerprint: "dd:a,b" }],
    ["a fingerprint with a quote", { fingerprint: 'dd:a"b' }],
    ["a fingerprint with parentheses", { fingerprint: "dd:a(b)" }],
    ["a fingerprint with a control character", { fingerprint: `dd:a${BEL}b` }],
    ["a fingerprint over 300 characters", { fingerprint: `dd:${"x".repeat(298)}` }],
    ["a fingerprint of another source", { fingerprint: "email:thread:1" }],
    ["a fingerprint without the source prefix", { fingerprint: "overdue:u_sam" }],
    ["a fingerprint that is only the prefix", { fingerprint: "dd:" }],
    ["a kind that isn't snake_case", { kind: "OverdueTasks" }],
    ["an empty kind", { kind: "" }],
    ["an empty stateHash", { stateHash: "" }],
    ["a stateHash with a newline", { stateHash: "ab\ncd" }],
    ["a stateHash over 128 characters", { stateHash: "h".repeat(129) }],
    ["facts that aren't an array", { facts: "none" as never }],
    ["refs that aren't an array", { refs: null as never }],
    ["a fact that isn't an object", { facts: ["x" as never] }],
    ["a ref with an empty id", { refs: [{ ...taskRef(), id: "" }] }],
    ["a ref id over 512 characters", { refs: [{ ...taskRef(), id: "i".repeat(513) }] }],
    ["a non-finite score", { priority: { score: Number.NaN, band: "high", reasons: [] } }],
    ["reasons that aren't an array", { priority: { score: 1, band: "high", reasons: "x" as never } }],
    ["a candidate that isn't an object", () => null]
  ];
  it.each(refusals)("refuses %s (NonRetryableError: the same bug would fail every retry)", (_name, over) => {
    const c = typeof over === "function" ? over(candidate()) : candidate(over);
    expect(() => normalizeCandidate(c as AttentionCandidate)).toThrow(NonRetryableError);
  });
});

// ---------------------------------------------------------------------------
// reconcile: every transition of the contract's table
// ---------------------------------------------------------------------------

describe("reconcile", () => {
  type Variant = "same" | "content" | "state" | "escalated" | "lowered" | "absent";
  const variants: Record<Exclude<Variant, "absent">, Partial<AttentionCandidate>> = {
    same: {},
    content: { title: "Sam has 3 overdue tasks (one due today)" },
    state: { stateHash: "ffffffffffffffff", whatHappened: "4 open tasks are past their due date." },
    escalated: { priority: { score: 80, band: "critical", reasons: ["Overdue tasks (base 25)", "Overdue 30 days (+30)"] } },
    lowered: { priority: { score: 30, band: "normal", reasons: ["Overdue tasks (base 25)", "Overdue 2 days (+4)"] } }
  };
  type Transition = [string, () => AttentionItem, Record<Variant, string>];
  const transitions: Transition[] = [
    ["open", () => item("open"), { same: "unchanged", content: "updated", state: "updated", escalated: "updated", lowered: "updated", absent: "resolved" }],
    ["seen", () => item("seen"), { same: "unchanged", content: "updated", state: "reopened", escalated: "updated", lowered: "updated", absent: "resolved" }],
    [
      "snoozed until tomorrow",
      () => item("snoozed"),
      // lowered: a put-away row keeps its higher band, and nothing else differs.
      { same: "unchanged", content: "updated", state: "updated", escalated: "reopened", lowered: "unchanged", absent: "resolved" }
    ],
    [
      "snoozed until exactly now",
      () => item("snoozed", { snoozeUntil: NOW_ISO }),
      { same: "reopened", content: "reopened", state: "reopened", escalated: "reopened", lowered: "reopened", absent: "resolved" }
    ],
    [
      "snoozed until yesterday",
      () => item("snoozed", { snoozeUntil: YESTERDAY }),
      { same: "reopened", content: "reopened", state: "reopened", escalated: "reopened", lowered: "reopened", absent: "resolved" }
    ],
    [
      "dismissed",
      () => item("dismissed"),
      { same: "unchanged", content: "updated", state: "updated", escalated: "reopened", lowered: "unchanged", absent: "resolved" }
    ],
    [
      "resolved (auto)",
      () => item("resolved"),
      { same: "reopened", content: "reopened", state: "reopened", escalated: "reopened", lowered: "reopened", absent: "untouched" }
    ],
    [
      "resolved (owner)",
      () => item("resolved", { resolution: "owner" }),
      { same: "unchanged", content: "updated", state: "reopened", escalated: "updated", lowered: "updated", absent: "untouched" }
    ]
  ];

  for (const [name, make, expected] of transitions) {
    for (const variant of Object.keys(expected) as Variant[]) {
      it(`${name} + ${variant === "absent" ? "candidate absent" : `candidate present (${variant})`} -> ${expected[variant]}`, () => {
        const row = make();
        const c = variant === "absent" ? null : candidate(variants[variant]);
        const plan = reconcile([row], c ? [c] : [], SCOPE, NOW);
        expect(outcome(plan, row)).toBe(expected[variant]);
        const update = plan.updates.find((u) => u.id === row.id);
        switch (expected[variant]) {
          case "unchanged":
            expect(update?.patch).toEqual({ last_seen_at: NOW_ISO });
            expect(plan.unchanged).toBe(1);
            break;
          case "updated":
            // Content and priority refreshed, the status left alone.
            expect(update?.patch).toEqual({ ...content(c as AttentionCandidate), last_seen_at: NOW_ISO, updated_at: NOW_ISO });
            expect(plan.unchanged).toBe(0);
            break;
          case "reopened":
            // Back to open; snooze and resolution cleared; first_seen_at kept (never in a patch).
            expect(update?.patch).toEqual({ ...content(c as AttentionCandidate), ...REOPEN, last_seen_at: NOW_ISO, updated_at: NOW_ISO });
            break;
          case "resolved":
            expect(plan.updates).toEqual([]);
            break;
          case "untouched":
            expect(plan.updates).toEqual([]);
            expect(plan.resolves).toEqual([]);
            break;
        }
        expect(plan.inserts).toEqual([]);
      });
    }
  }

  it("no row + candidate present -> insert as open (the normalized candidate)", () => {
    const c = candidate({ title: "  Sam has 3 overdue tasks  " });
    const plan = reconcile([], [c], SCOPE, NOW);
    expect(plan).toEqual({ inserts: [normalizeCandidate(c)], updates: [], resolves: [], unchanged: 0 });
  });

  it.each<[PriorityBand, PriorityBand, string]>([
    ["normal", "high", "reopened"],
    ["normal", "critical", "reopened"],
    ["high", "critical", "reopened"],
    ["normal", "normal", "updated"],
    ["high", "high", "updated"],
    // A lower band isn't written: the stored one stays, and nothing else changed.
    ["critical", "high", "unchanged"],
    ["high", "normal", "unchanged"]
  ])("dismissed: band %s -> %s is %s (only an escalation reopens)", (from, to, expected) => {
    const row = item("dismissed", { priority: { score: 40, band: from, reasons: ["a"] } });
    const plan = reconcile([row], [candidate({ priority: { score: 41, band: to, reasons: ["a"] } })], SCOPE, NOW);
    expect(outcome(plan, row)).toBe(expected);
  });

  it.each<[string, () => AttentionItem]>([
    ["dismissed", () => item("dismissed")],
    ["snoozed", () => item("snoozed")]
  ])("%s: a lower band is held while the rest of the content updates", (_name, make) => {
    const row = make();
    const c = candidate({ title: "Sam has 2 overdue tasks", priority: { score: 30, band: "normal", reasons: ["Overdue tasks (base 25)"] } });
    const plan = reconcile([row], [c], SCOPE, NOW);
    expect(plan.updates).toEqual([
      {
        id: row.id,
        patch: {
          ...content(c),
          // The priority he put it away at (here, high), not the candidate's normal.
          priority_score: row.priority.score,
          priority_band: row.priority.band,
          priority_reasons: row.priority.reasons,
          last_seen_at: NOW_ISO,
          updated_at: NOW_ISO
        },
        change: "updated"
      }
    ]);
  });

  it("a snoozed row whose snooze ran out reopens with the candidate's own, lower priority", () => {
    const row = item("snoozed", { snoozeUntil: YESTERDAY });
    const c = candidate(variants.lowered);
    const plan = reconcile([row], [c], SCOPE, NOW);
    expect(plan.updates[0]).toMatchObject({ change: "reopened", patch: { priority_band: "normal", priority_score: 30, status: "open" } });
  });

  it("compares stored rows the way they come back: jsonb key order and +00:00 timestamps don't count as a change", () => {
    const c = candidate();
    const stored = item("seen");
    const reordered: AttentionItem = {
      ...stored,
      occurredAt: pgTime(stored.occurredAt as string),
      facts: stored.facts.map((f) => ({ refs: f.refs.map((r) => ({ id: r.id, url: r.url, class: r.class, label: r.label, system: r.system })), text: f.text, basis: f.basis })),
      refs: stored.refs.map((r) => ({ id: r.id, url: r.url, class: r.class, label: r.label, system: r.system }))
    };
    const plan = reconcile([reordered], [c], SCOPE, NOW);
    expect(plan.updates).toEqual([{ id: stored.id, patch: { last_seen_at: NOW_ISO }, change: "unchanged" }]);
  });

  it("never touches rows outside the scope: another source, or a kind not listed", () => {
    const email = item("open", { source: "email", fingerprint: "email:thread:1", kind: "important_email" });
    const incident = item("open", { fingerprint: "dd:incident:task:t_7", kind: "open_incident" });
    const mine = item("open");
    const plan = reconcile([email, incident, mine], [], SCOPE, NOW);
    expect(plan).toEqual({ inserts: [], updates: [], resolves: [mine.id], unchanged: 0 });
  });

  it("refuses a candidate whose fingerprint belongs to a row outside the scope", () => {
    const incident = item("open", { kind: "open_incident" });
    expect(() => reconcile([incident], [candidate()], SCOPE, NOW)).toThrow(/already belongs to dd\/open_incident, outside this sync's scope/);
  });

  it("plans a whole batch: inserts, updates, resolves and the unchanged count", () => {
    const a = item("open", { fingerprint: "dd:overdue:assignee:u_a" });
    const b = item("seen", { fingerprint: "dd:overdue:assignee:u_b" });
    const gone = item("dismissed", { fingerprint: "dd:overdue:assignee:u_gone" });
    const plan = reconcile(
      [a, b, gone],
      [
        candidate({ fingerprint: "dd:overdue:assignee:u_a" }),
        candidate({ fingerprint: "dd:overdue:assignee:u_b", stateHash: "0000000000000002" }),
        candidate({ fingerprint: "dd:overdue:assignee:u_new" })
      ],
      SCOPE,
      NOW
    );
    expect(plan.inserts.map((c) => c.fingerprint)).toEqual(["dd:overdue:assignee:u_new"]);
    expect(plan.updates.map((u) => [u.id, u.change])).toEqual([
      [a.id, "unchanged"],
      [b.id, "reopened"]
    ]);
    expect(plan.resolves).toEqual([gone.id]);
    expect(plan.unchanged).toBe(1);
  });

  it.each<[string, () => unknown]>([
    ["a candidate of another source", () => reconcile([], [candidate({ source: "email", fingerprint: "email:t:1" })], SCOPE, NOW)],
    ["a kind the scope doesn't list", () => reconcile([], [candidate({ kind: "open_incident" })], SCOPE, NOW)],
    ["duplicate fingerprints", () => reconcile([], [candidate(), candidate({ title: "again" })], SCOPE, NOW)],
    ["a scope with no kinds", () => reconcile([], [], { source: "dd", kinds: [] }, NOW)],
    ["a scope with an unknown source", () => reconcile([], [], { source: "teams" as never, kinds: ["overdue_tasks"] }, NOW)],
    ["an invalid now", () => reconcile([], [], SCOPE, new Date("nope"))]
  ])("refuses %s", (_name, run) => {
    expect(run).toThrow(NonRetryableError);
  });
});

// ---------------------------------------------------------------------------
// syncAttention against the in-memory table
// ---------------------------------------------------------------------------

describe("syncAttention", () => {
  const stalled = (over: Partial<AttentionCandidate> = {}) =>
    candidate({
      fingerprint: "dd:stalled:assignee:u_ali",
      kind: "stalled_tasks",
      title: "Ali has 2 stalled tasks",
      stateHash: "5151515151515151",
      ...over
    });
  const approval = (over: Partial<AttentionCandidate> = {}) =>
    candidate({
      fingerprint: "dd:approval:draft_tasks",
      kind: "pending_approval",
      category: "approval",
      title: "4 draft tasks wait for approval",
      stateHash: "abababababababab",
      ...over
    });

  it("inserts a first batch as open, stamped with the sync's time", async () => {
    const result = await syncAttention(principal, SCOPE, [candidate(), stalled()], NOW);
    expect(result).toEqual({ inserted: 2, updated: 0, reopened: 0, resolved: 0, unchanged: 0 });
    const [upsert] = writes();
    expect(upsert).toMatchObject({ op: "upsert", columns: "id", options: { onConflict: "principal_id,fingerprint", ignoreDuplicates: true } });
    expect(upsert.rows?.[0]).toEqual({
      principal_id: "ep_1",
      fingerprint: "dd:overdue:assignee:u_sam",
      source: "dd",
      ...content(candidate()),
      status: "open",
      first_seen_at: NOW_ISO,
      last_seen_at: NOW_ISO,
      updated_at: NOW_ISO
    });
    expect(db.read().map((r) => [r.fingerprint, r.status, r.first_seen_at])).toEqual([
      ["dd:overdue:assignee:u_sam", "open", pgTime(NOW_ISO)],
      ["dd:stalled:assignee:u_ali", "open", pgTime(NOW_ISO)]
    ]);
    expect(console.log).toHaveBeenCalledWith(
      "[exec-attention] synced dd for ep_1: inserted=2 updated=0 reopened=0 resolved=0 unchanged=0"
    );
  });

  it("a second sync of the same situations changes nothing but last_seen_at (across the jsonb round trip)", async () => {
    await syncAttention(principal, SCOPE, [candidate(), stalled()], NOW);
    const before = db.read();
    db.calls.length = 0;
    const result = await syncAttention(principal, SCOPE, [candidate(), stalled()], LATER);
    expect(result).toEqual({ inserted: 0, updated: 0, reopened: 0, resolved: 0, unchanged: 2 });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ op: "update", patch: { last_seen_at: LATER.toISOString() } });
    expect(filterValue(writes()[0], "in", "id")).toEqual(before.map((r) => r.id));
    const after = db.read();
    expect(after.map((r) => r.last_seen_at)).toEqual([pgTime(LATER.toISOString()), pgTime(LATER.toISOString())]);
    expect(after.map(({ last_seen_at: _l, ...rest }) => rest)).toEqual(before.map(({ last_seen_at: _l, ...rest }) => rest));
  });

  it("applies a mixed batch and leaves other scopes, other principals and owner resolutions alone", async () => {
    const a = db.seed(rowOf(candidate()));
    const b = db.seed(rowOf(stalled(), { status: "seen" }));
    const c = db.seed(rowOf(approval(), { status: "resolved", resolution: "auto", resolved_at: YESTERDAY }));
    const snoozed = db.seed(
      rowOf(candidate({ fingerprint: "dd:overdue:assignee:u_kim" }), { status: "snoozed", snooze_until: TOMORROW })
    );
    const dismissed = db.seed(rowOf(candidate({ fingerprint: "dd:overdue:assignee:u_lee" }), { status: "dismissed" }));
    const owner = db.seed(
      rowOf(candidate({ fingerprint: "dd:overdue:assignee:u_old" }), { status: "resolved", resolution: "owner", resolved_at: YESTERDAY })
    );
    const email = db.seed(rowOf(candidate({ source: "email", fingerprint: "email:thread:1", kind: "important_email" })));
    const incident = db.seed(rowOf(candidate({ fingerprint: "dd:incident:task:t_7", kind: "open_incident" })));
    const theirs = db.seed(rowOf(candidate(), { principal_id: "ep_2" }));
    const untouched = [owner, email, incident, theirs].map((r) => structuredClone(r));

    const result = await syncAttention(
      principal,
      SCOPE,
      [
        candidate({ title: "Sam has 3 overdue tasks (one due today)" }),
        stalled({ stateHash: "5252525252525252" }),
        approval(),
        candidate({ fingerprint: "dd:overdue:assignee:u_new", title: "New has 1 overdue task" })
      ],
      NOW
    );
    expect(result).toEqual({ inserted: 1, updated: 1, reopened: 2, resolved: 2, unchanged: 0 });

    const byId = new Map(db.read().map((r) => [r.id, r]));
    expect(byId.get(a.id as string)).toMatchObject({ status: "open", title: "Sam has 3 overdue tasks (one due today)", updated_at: pgTime(NOW_ISO) });
    expect(byId.get(b.id as string)).toMatchObject({ status: "open", state_hash: "5252525252525252" });
    expect(byId.get(c.id as string)).toMatchObject({ status: "open", resolution: null, resolved_at: null, first_seen_at: pgTime(FIRST_SEEN) });
    expect(byId.get(snoozed.id as string)).toMatchObject({ status: "resolved", resolution: "auto", resolved_at: pgTime(NOW_ISO), snooze_until: null });
    expect(byId.get(dismissed.id as string)).toMatchObject({ status: "resolved", resolution: "auto", resolved_at: pgTime(NOW_ISO) });
    for (const r of untouched) expect(byId.get(r.id as string)).toEqual(r);
    expect(db.read().filter((r) => r.fingerprint === "dd:overdue:assignee:u_new")).toMatchObject([{ status: "open", principal_id: "ep_1" }]);
  });

  it("reads the live rows of the scope by id pages, then looks up only the candidates that aren't live", async () => {
    db.seed(rowOf(candidate()));
    db.seed(rowOf(approval(), { status: "resolved", resolution: "auto", resolved_at: YESTERDAY }));
    await syncAttention(principal, SCOPE, [candidate(), approval(), stalled()], NOW);
    const [live, lookup, ...rest] = selects();
    expect(rest).toEqual([]);
    expect(live.filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["eq", "source", "dd"],
      ["in", "kind", [...KINDS]],
      ["neq", "status", "resolved"]
    ]);
    expect(live.orders).toEqual([["id", true]]);
    expect(live.range).toEqual([0, 999]);
    // Its own columns only; never more than the item needs.
    expect(live.columns?.split(",")).toEqual([
      "id",
      "principal_id",
      "fingerprint",
      "source",
      "kind",
      "category",
      "priority_score",
      "priority_band",
      "priority_reasons",
      "title",
      "what_happened",
      "why_it_matters",
      "recommended_next",
      "facts",
      "refs",
      "state_hash",
      "occurred_at",
      "status",
      "snooze_until",
      "resolution",
      "first_seen_at",
      "last_seen_at",
      "resolved_at",
      "updated_at"
    ]);
    expect(lookup.filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["in", "fingerprint", ["dd:approval:draft_tasks", "dd:stalled:assignee:u_ali"]]
    ]);
  });

  it("pages past 1000 live rows, and resolves them in chunks that keep the id list short", async () => {
    for (let i = 0; i < 1001; i++) db.seed(rowOf(candidate({ fingerprint: `dd:overdue:assignee:u_${i}` })));
    const result = await syncAttention(principal, SCOPE, [], NOW);
    expect(result.resolved).toBe(1001);
    expect(selects().map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999]
    ]);
    const resolves = writes();
    expect(resolves.every((c) => c.op === "update" && c.patch?.status === "resolved")).toBe(true);
    const lists = resolves.map((c) => filterValue(c, "in", "id") as string[]);
    expect(lists.flat()).toHaveLength(1001);
    for (const list of lists) {
      expect(list.length).toBeLessThanOrEqual(200);
      expect(list.reduce((n, id) => n + encodeURIComponent(id).length + 3, 0)).toBeLessThanOrEqual(6_000);
    }
    expect(db.read().every((r) => r.status === "resolved")).toBe(true);
  });

  it("inserts in chunks of 200, and looks fingerprints up in URL-sized chunks", async () => {
    const many = Array.from({ length: 450 }, (_, i) => candidate({ fingerprint: `dd:overdue:assignee:u_${i}` }));
    const result = await syncAttention(principal, SCOPE, many, NOW);
    expect(result.inserted).toBe(450);
    expect(writes().map((c) => c.rows?.length)).toEqual([200, 200, 50]);
    const lookups = selects().slice(1).map((c) => filterValue(c, "in", "fingerprint") as string[]);
    expect(lookups.flat()).toEqual(many.map((c) => c.fingerprint));
    for (const list of lookups) {
      expect(list.length).toBeLessThanOrEqual(200);
      expect(list.reduce((n, fp) => n + encodeURIComponent(fp).length + 3, 0)).toBeLessThanOrEqual(6_000);
    }
  });

  it("writes each changed row on its own, guarded by the status and version it was read with, ten at a time", async () => {
    const fps = Array.from({ length: 25 }, (_, i) => `dd:overdue:assignee:u_${i}`);
    for (const fp of fps) db.seed(rowOf(candidate({ fingerprint: fp }), { status: "seen" }));
    const result = await syncAttention(principal, SCOPE, fps.map((fp) => candidate({ fingerprint: fp, title: "changed" })), NOW);
    expect(result).toEqual({ inserted: 0, updated: 25, reopened: 0, resolved: 0, unchanged: 0 });
    const updates = writes();
    expect(updates).toHaveLength(25);
    for (const u of updates) {
      expect(u.filters).toEqual([
        ["eq", "principal_id", "ep_1"],
        ["eq", "id", expect.any(String)],
        ["eq", "status", "seen"],
        // Exactly as it was read back (PostgREST's "+00:00" form).
        ["eq", "updated_at", pgTime(EARLIER)],
        ["lte", "updated_at", NOW_ISO],
        ["lte", "last_seen_at", NOW_ISO]
      ]);
      expect(u.options).toEqual({ count: "exact" });
    }

    // Abort on the 3rd write: the other 7 of its window were already sent, nothing after.
    db.calls.length = 0;
    const controller = new AbortController();
    let n = 0;
    db.before = (call) => {
      if (call.op === "update" && ++n === 3) controller.abort(new Error("lease lost"));
    };
    await expect(
      syncAttention(principal, SCOPE, fps.map((fp) => candidate({ fingerprint: fp, title: "changed again" })), NOW, { signal: controller.signal })
    ).rejects.toThrow("lease lost");
    expect(writes()).toHaveLength(10);
  });

  it("skips an update when he changed the row since the read: his dismissal wins", async () => {
    const row = db.seed(rowOf(candidate(), { status: "seen" }));
    db.before = (call) => {
      if (call.op === "update") db.rows[0] = { ...db.rows[0], status: "dismissed" };
    };
    const result = await syncAttention(principal, SCOPE, [candidate({ stateHash: "0000000000000009" })], NOW);
    expect(result).toEqual({ inserted: 0, updated: 0, reopened: 0, resolved: 0, unchanged: 0 });
    expect(db.read()[0]).toMatchObject({ id: row.id, status: "dismissed", state_hash: "a1b2c3d4e5f60718" });
    expect(console.warn).toHaveBeenCalledWith("[exec-attention] 1 write(s) skipped for ep_1: rows changed during the sync");
  });

  it.each<[string, Row]>([
    ["dismissed", { status: "dismissed" }],
    ["snoozed", { status: "snoozed", snooze_until: TOMORROW }]
  ])("%s at high: a dip to normal and a climb back to high leave it put away; only critical reopens it", async (_name, putAway) => {
    // Put away while the item scored high (the fixture's 55).
    const row = db.seed(rowOf(candidate(), putAway));
    const stored = () => {
      const [r] = db.read();
      return [r.status, r.priority_band, r.priority_score];
    };
    const sync = (priority: AttentionCandidate["priority"], at: Date) => syncAttention(principal, SCOPE, [candidate({ priority })], at);

    // He closed the high-priority task: the next refresh scores it normal. It stays put away, at high.
    await sync({ score: 40, band: "normal", reasons: ["Overdue tasks (base 25)", "Overdue 6 days (+12)", "3 items (+6)"] }, NOW);
    expect(stored()).toEqual([putAway.status, "high", 55]);

    // A new high-priority task goes overdue: high again, which is no higher than where he left it.
    const back = await sync({ score: 57, band: "high", reasons: ["Overdue tasks (base 25)", "Overdue 7 days (+14)", "High priority (+12)"] }, LATER);
    expect(back).toMatchObject({ reopened: 0, updated: 1 });
    expect(stored()).toEqual([putAway.status, "high", 57]);

    // Critical is above it: that reopens, and clears any snooze.
    const up = await sync({ score: 80, band: "critical", reasons: ["Overdue tasks (base 25)", "Critical (+25)"] }, new Date(LATER.getTime() + 60_000));
    expect(up.reopened).toBe(1);
    expect(db.read()[0]).toMatchObject({ id: row.id, status: "open", priority_band: "critical", snooze_until: null });
  });

  // Two refreshes for one principal can run at once (a retry outlasts its
  // 10-minute bucket). Each write is fenced on last_seen_at: a row a later
  // sync has already stamped is never written by an earlier one.
  describe("an earlier sync that finishes after a later one", () => {
    const laterSyncStamped = () => {
      db.before = (call) => {
        if (call.op === "update") db.rows[0] = { ...db.rows[0], last_seen_at: pgTime(LATER.toISOString()) };
      };
    };

    it("doesn't write its older content over the row", async () => {
      db.seed(rowOf(candidate()));
      laterSyncStamped();
      const result = await syncAttention(principal, SCOPE, [candidate({ title: "Sam has 2 overdue tasks", stateHash: "0000000000000002" })], NOW);
      expect(result).toEqual({ inserted: 0, updated: 0, reopened: 0, resolved: 0, unchanged: 0 });
      expect(db.read()[0]).toMatchObject({ title: "Sam has 3 overdue tasks", last_seen_at: pgTime(LATER.toISOString()) });
      expect(console.warn).toHaveBeenCalledWith("[exec-attention] 1 write(s) skipped for ep_1: rows changed during the sync");
    });

    it("doesn't resolve an item the later sync still sees", async () => {
      db.seed(rowOf(candidate()));
      laterSyncStamped();
      const result = await syncAttention(principal, SCOPE, [], NOW);
      expect(result.resolved).toBe(0);
      expect(db.read()[0]).toMatchObject({ status: "open", resolution: null, resolved_at: null });
    });

    it("doesn't reopen an item the later sync resolved, though it read the row after that", async () => {
      // A resolve doesn't stamp last_seen_at (the situation wasn't seen), so
      // the later sync's mark here is the resolution's own time.
      db.seed(rowOf(candidate(), { status: "resolved", resolution: "auto", resolved_at: pgTime(LATER.toISOString()), updated_at: pgTime(LATER.toISOString()) }));
      const result = await syncAttention(principal, SCOPE, [candidate()], NOW);
      expect(result.reopened).toBe(0);
      expect(db.read()[0]).toMatchObject({ status: "resolved", resolution: "auto" });
    });

    it("never moves last_seen_at back", async () => {
      db.seed(rowOf(candidate()));
      laterSyncStamped();
      const result = await syncAttention(principal, SCOPE, [candidate()], NOW);
      expect(result.unchanged).toBe(0);
      expect(db.read()[0].last_seen_at).toBe(pgTime(LATER.toISOString()));
    });

    it("sends the fence with every write", async () => {
      db.seed(rowOf(candidate()));
      db.seed(rowOf(stalled()));
      db.seed(rowOf(approval()));
      await syncAttention(principal, SCOPE, [candidate({ title: "changed" }), stalled()], NOW);
      const fenced = writes().filter((c) => c.op === "update");
      expect(fenced.map((c) => (c.patch?.status === "resolved" ? "resolve" : c.patch?.title !== undefined ? "content" : "bump"))).toEqual([
        "content",
        "bump",
        "resolve"
      ]);
      for (const c of fenced) expect(filterValue(c, "lte", "last_seen_at")).toBe(NOW_ISO);
    });
  });

  // P5's actions can change a row without changing its status (a new snooze
  // on one that ran out). Each content write is also a compare-and-set on the
  // updated_at it read, so whatever he did since the read wins.
  it("skips a reopen when he snoozed the item again since the read, though its status didn't change", async () => {
    db.seed(rowOf(candidate(), { status: "snoozed", snooze_until: EARLIER }));
    db.before = (call) => {
      // An owner action stamped by now() in SQL: microseconds.
      if (call.op === "update") db.rows[0] = { ...db.rows[0], snooze_until: pgTime(TOMORROW), updated_at: "2026-11-04T12:59:30.123456+00:00" };
    };
    const result = await syncAttention(principal, SCOPE, [candidate()], NOW);
    expect(result.reopened).toBe(0);
    expect(db.read()[0]).toMatchObject({ status: "snoozed", snooze_until: pgTime(TOMORROW) });
  });

  it("matches the updated_at it read to the microsecond, so a row an owner action stamped still refreshes", async () => {
    const row = db.seed(rowOf(candidate(), { status: "seen", updated_at: "2026-11-04T12:55:00.123456+00:00" }));
    const result = await syncAttention(principal, SCOPE, [candidate({ stateHash: "0000000000000003" })], NOW);
    expect(result.reopened).toBe(1);
    const [update] = writes();
    expect(filterValue(update, "eq", "updated_at")).toBe("2026-11-04T12:55:00.123456+00:00");
    expect(db.read()[0]).toMatchObject({ id: row.id, status: "open", state_hash: "0000000000000003", updated_at: pgTime(NOW_ISO) });
  });

  it("skips an insert whose fingerprint appeared since the read (an overlapping sync)", async () => {
    db.before = (call) => {
      if (call.op === "upsert") db.seed(rowOf(candidate(), { title: "from the other sync" }));
    };
    const result = await syncAttention(principal, SCOPE, [candidate()], NOW);
    expect(result.inserted).toBe(0);
    expect(db.read()).toMatchObject([{ title: "from the other sync" }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("1 write(s) skipped"));
  });

  it("never overrides a resolution he made since the read", async () => {
    db.seed(rowOf(candidate()));
    db.before = (call) => {
      if (call.op === "update") db.rows[0] = { ...db.rows[0], status: "resolved", resolution: "owner", resolved_at: pgTime(EARLIER) };
    };
    const result = await syncAttention(principal, SCOPE, [], NOW);
    expect(result.resolved).toBe(0);
    expect(db.read()[0]).toMatchObject({ status: "resolved", resolution: "owner", resolved_at: pgTime(EARLIER) });
  });

  it("with no candidates, resolves every live item of the scope (and clears a snooze) but nothing else", async () => {
    for (const [i, status] of (["open", "seen", "dismissed"] as const).entries()) {
      db.seed(rowOf(candidate({ fingerprint: `dd:overdue:assignee:u_${i}` }), { status }));
    }
    db.seed(rowOf(candidate({ fingerprint: "dd:overdue:assignee:u_z" }), { status: "snoozed", snooze_until: TOMORROW }));
    db.seed(rowOf(candidate({ fingerprint: "dd:overdue:assignee:u_r" }), { status: "resolved", resolution: "owner", resolved_at: YESTERDAY }));
    db.seed(rowOf(candidate({ fingerprint: "dd:incident:task:t_1", kind: "open_incident" })));
    const result = await syncAttention(principal, SCOPE, [], NOW);
    expect(result).toEqual({ inserted: 0, updated: 0, reopened: 0, resolved: 4, unchanged: 0 });
    expect(db.read().map((r) => [r.fingerprint, r.status, r.resolution, r.snooze_until])).toEqual([
      ["dd:overdue:assignee:u_0", "resolved", "auto", null],
      ["dd:overdue:assignee:u_1", "resolved", "auto", null],
      ["dd:overdue:assignee:u_2", "resolved", "auto", null],
      ["dd:overdue:assignee:u_z", "resolved", "auto", null],
      ["dd:overdue:assignee:u_r", "resolved", "owner", null],
      ["dd:incident:task:t_1", "open", null, null]
    ]);
  });

  it("refuses a fingerprint that belongs to a row outside the scope, and writes nothing", async () => {
    db.seed(rowOf(candidate(), { kind: "open_incident" }));
    await expect(syncAttention(principal, SCOPE, [candidate()], NOW)).rejects.toThrow(NonRetryableError);
    expect(writes()).toEqual([]);
  });

  it.each<[string, Parameters<typeof syncAttention>[1], AttentionCandidate[], Date?]>([
    ["a candidate of another source", SCOPE, [candidate({ source: "email", fingerprint: "email:thread:1" })]],
    ["a kind outside the scope", SCOPE, [candidate({ kind: "open_incident" })]],
    ["duplicate fingerprints", SCOPE, [candidate(), stalled({ fingerprint: "dd:overdue:assignee:u_sam" })]],
    ["a fingerprint without its source prefix", SCOPE, [candidate({ fingerprint: "overdue:assignee:u_sam" })]],
    ["a fingerprint of another source", SCOPE, [candidate({ fingerprint: "slack:C1:1" })]],
    ["an invalid candidate", SCOPE, [candidate({ category: "urgent" as never })]],
    ["a scope with no kinds", { source: "dd", kinds: [] }, []],
    ["an invalid now", SCOPE, [], new Date("nope")]
  ])("refuses %s before reading or writing anything", async (_name, scope, candidates, now) => {
    db.seed(rowOf(candidate()));
    await expect(syncAttention(principal, scope, candidates, now ?? NOW)).rejects.toThrow(NonRetryableError);
    expect(db.calls).toEqual([]);
  });

  it.each<[string, (call: FakeCall) => boolean, string]>([
    ["the live read", (c) => c.op === "select" && c.range !== null, "exec_attention_items read failed: boom"],
    ["the fingerprint lookup", (c) => c.op === "select" && c.range === null, "exec_attention_items read failed: boom"],
    ["an insert", (c) => c.op === "upsert", "exec_attention_items insert failed: boom"],
    ["a content update", (c) => c.op === "update" && c.patch?.title !== undefined, "exec_attention_items update failed: boom"],
    ["the last-seen bump", (c) => c.op === "update" && Object.keys(c.patch ?? {}).join() === "last_seen_at", "exec_attention_items update failed: boom"],
    ["a resolve", (c) => c.op === "update" && c.patch?.status === "resolved", "exec_attention_items resolve failed: boom"]
  ])("fails closed when %s fails, and stops there", async (_name, which, message) => {
    db.seed(rowOf(candidate()));
    db.seed(rowOf(stalled()));
    db.seed(rowOf(approval({ fingerprint: "dd:approval:fb_proofs" })));
    db.fail = (call) => (which(call) ? { message: "boom" } : null);
    await expect(
      syncAttention(
        principal,
        SCOPE,
        [candidate({ title: "changed" }), stalled(), candidate({ fingerprint: "dd:overdue:assignee:u_new" })],
        NOW
      )
    ).rejects.toThrow(message);
    const failedAt = db.calls.findIndex(which);
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(db.calls).toHaveLength(failedAt + 1);
  });

  it("passes its signal to every request, and an aborted one stops it before the first", async () => {
    db.seed(rowOf(candidate()));
    db.seed(rowOf(stalled({ fingerprint: "dd:stalled:assignee:u_gone" })));
    const signal = new AbortController().signal;
    await syncAttention(principal, SCOPE, [candidate({ title: "changed" }), stalled(), approval()], NOW, { signal });
    expect(db.calls.length).toBeGreaterThanOrEqual(5);
    expect(db.calls.every((c) => c.signal === signal)).toBe(true);

    db.calls.length = 0;
    const aborted = new AbortController();
    aborted.abort(new Error("timed out"));
    await expect(syncAttention(principal, SCOPE, [candidate()], NOW, { signal: aborted.signal })).rejects.toThrow("timed out");
    expect(db.calls).toEqual([]);
  });

  it("throws the signal's reason when a request is aborted in flight", async () => {
    db.seed(rowOf(candidate()));
    const controller = new AbortController();
    db.before = () => controller.abort(new Error("lease lost"));
    db.fail = (call) => (call.signal?.aborted ? { message: "AbortError: This operation was aborted" } : null);
    await expect(syncAttention(principal, SCOPE, [candidate()], NOW, { signal: controller.signal })).rejects.toThrow("lease lost");
  });

  it("fails the read on a stored row the checks refuse (fail closed, nothing written)", async () => {
    db.seed(rowOf(candidate()));
    db.rows[0] = { ...db.rows[0], category: "urgent" };
    await expect(syncAttention(principal, SCOPE, [candidate()], NOW)).rejects.toThrow(
      /exec_attention_items read failed: row ea_0+1: exec attention: unknown dd:overdue:assignee:u_sam: category "urgent"/
    );
    expect(writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listAttention
// ---------------------------------------------------------------------------

describe("listAttention", () => {
  const seed = (fp: string, over: Row) => db.seed(rowOf(candidate({ fingerprint: `dd:overdue:assignee:${fp}` }), over));

  function seedFeed() {
    return {
      o1: seed("o1", { priority_score: 80, priority_band: "critical" }),
      z1: seed("z1", { priority_score: 70, priority_band: "high", status: "snoozed", snooze_until: "2026-11-04T12:59:00.000Z" }),
      o2: seed("o2", { priority_score: 55, last_seen_at: "2026-11-04T12:55:00.000Z" }),
      s1: seed("s1", { priority_score: 55, status: "seen" }),
      z2: seed("z2", { priority_score: 55, status: "snoozed", snooze_until: NOW_ISO }),
      z3: seed("z3", { priority_score: 90, priority_band: "critical", status: "snoozed", snooze_until: TOMORROW }),
      d1: seed("d1", { priority_score: 95, priority_band: "critical", status: "dismissed" }),
      r1: seed("r1", { priority_score: 99, priority_band: "critical", status: "resolved", resolution: "auto", resolved_at: YESTERDAY }),
      x1: seed("x1", { principal_id: "ep_2", priority_score: 100, priority_band: "critical" })
    };
  }
  const fps = (items: AttentionItem[]) => items.map((i) => i.fingerprint.replace("dd:overdue:assignee:", ""));

  it("by default: open, seen, and snoozed past their time (as open), highest priority first, then most recently seen", async () => {
    seedFeed();
    const items = await listAttention(principal, { now: NOW });
    expect(fps(items)).toEqual(["o1", "z1", "o2", "s1", "z2"]);
    expect(items.map((i) => i.status)).toEqual(["open", "open", "open", "seen", "open"]);
    expect(items.map((i) => i.snoozeUntil)).toEqual([null, null, null, null, null]);
    const [call] = db.calls;
    expect(call.filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["or", `status.in.(open,seen),and(status.eq.snoozed,snooze_until.lte.${NOW_ISO})`]
    ]);
    expect(call.orders).toEqual([
      ["priority_score", false],
      ["last_seen_at", false],
      ["id", true]
    ]);
    expect(call.limit).toBe(50);
  });

  it.each<[AttentionStatus[], string, string[], AttentionStatus[]]>([
    [["snoozed"], `and(status.eq.snoozed,snooze_until.gt.${NOW_ISO})`, ["z3"], ["snoozed"]],
    [["open", "snoozed"], "status.in.(open,snoozed)", ["z3", "o1", "z1", "o2", "z2"], ["snoozed", "open", "open", "open", "open"]],
    [["dismissed", "resolved"], "status.in.(dismissed,resolved)", ["r1", "d1"], ["resolved", "dismissed"]],
    [["seen", "open"], `status.in.(open,seen),and(status.eq.snoozed,snooze_until.lte.${NOW_ISO})`, ["o1", "z1", "o2", "s1", "z2"], ["open", "open", "open", "seen", "open"]],
    [["seen"], "status.in.(seen)", ["s1"], ["seen"]]
  ])("statuses %j", async (statuses, filter, expected, shownStatuses) => {
    seedFeed();
    const items = await listAttention(principal, { statuses, now: NOW });
    expect(db.calls[0].filters[1]).toEqual(["or", filter]);
    expect(fps(items)).toEqual(expected);
    expect(items.map((i) => i.status)).toEqual(shownStatuses);
  });

  it.each<[number | undefined, number]>([
    [undefined, 50],
    [20, 20],
    [500, 200],
    [0, 1],
    [-3, 1],
    [7.9, 7],
    [Number.NaN, 50]
  ])("limit %j -> %i", async (limit, expected) => {
    await listAttention(principal, { limit, now: NOW });
    expect(db.calls[0].limit).toBe(expected);
  });

  it("applies the limit to the top of the order", async () => {
    seedFeed();
    expect(fps(await listAttention(principal, { limit: 2, now: NOW }))).toEqual(["o1", "z1"]);
  });

  it("maps rows to items: camelCase, ISO timestamps, links re-checked", async () => {
    const row = seed("m1", {
      refs: [{ system: "web", id: "w1", url: "https://evil.example/x", label: "Planted", class: "public" }]
    });
    const [it] = await listAttention(principal, { now: NOW });
    expect(it).toEqual({
      ...normalizeCandidate(candidate({ fingerprint: "dd:overdue:assignee:m1" })),
      refs: [{ system: "web", id: "w1", url: null, label: "Planted", class: "public" }],
      id: row.id,
      principalId: "ep_1",
      status: "open",
      snoozeUntil: null,
      firstSeenAt: FIRST_SEEN,
      lastSeenAt: EARLIER,
      resolvedAt: null,
      resolution: null,
      updatedAt: EARLIER
    });
  });

  it("throws on a read error instead of returning an empty feed", async () => {
    seedFeed();
    db.fail = () => ({ message: "connection reset" });
    await expect(listAttention(principal, { now: NOW })).rejects.toThrow("exec_attention_items read failed: connection reset");
  });

  it("throws on a stored row the checks refuse, instead of showing the rest", async () => {
    seedFeed();
    db.rows[0] = { ...db.rows[0], priority_band: "urgent" };
    await expect(listAttention(principal, { now: NOW })).rejects.toThrow(/read failed: row ea_0+1: .*priority band "urgent"/);
  });

  it.each<[string, Parameters<typeof listAttention>[1]]>([
    ["an empty status list", { statuses: [] }],
    ["an unknown status", { statuses: ["archived" as AttentionStatus] }],
    ["an invalid now", { now: new Date("nope") }]
  ])("refuses %s without querying", async (_name, opts) => {
    await expect(listAttention(principal, opts)).rejects.toThrow(NonRetryableError);
    expect(db.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lastAttentionRefresh
// ---------------------------------------------------------------------------

describe("lastAttentionRefresh", () => {
  it("is the latest last_seen_at of that source for this principal, whatever the status", async () => {
    const seed = (fp: string, over: Row) => db.seed(rowOf(candidate({ fingerprint: fp }), over));
    seed("dd:overdue:assignee:a", { last_seen_at: "2026-11-04T12:00:00.000Z" });
    seed("dd:overdue:assignee:b", { last_seen_at: "2026-11-04T12:55:00.000Z", status: "resolved", resolution: "auto", resolved_at: NOW_ISO });
    seed("dd:overdue:assignee:c", { last_seen_at: "2026-11-04T12:30:00.000Z", status: "seen" });
    db.seed(rowOf(candidate({ source: "email", fingerprint: "email:t:1", kind: "important_email" }), { last_seen_at: "2026-11-04T12:59:00.000Z" }));
    seed("dd:overdue:assignee:d", { principal_id: "ep_2", last_seen_at: "2026-11-04T12:58:00.000Z" });

    await expect(lastAttentionRefresh(principal, "dd")).resolves.toBe("2026-11-04T12:55:00.000Z");
    expect(db.calls[0]).toMatchObject({
      columns: "last_seen_at",
      filters: [
        ["eq", "principal_id", "ep_1"],
        ["eq", "source", "dd"]
      ],
      orders: [["last_seen_at", false]],
      limit: 1
    });
  });

  it("is null when the source has no items", async () => {
    await expect(lastAttentionRefresh(principal, "slack")).resolves.toBeNull();
  });

  it("throws on a read error", async () => {
    db.fail = () => ({ message: "timeout" });
    await expect(lastAttentionRefresh(principal, "dd")).rejects.toThrow("exec_attention_items read failed: timeout");
  });

  it("refuses an unknown source without querying", async () => {
    await expect(lastAttentionRefresh(principal, "teams" as never)).rejects.toThrow(NonRetryableError);
    expect(db.calls).toEqual([]);
  });
});
