import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { INTEL_SENTINELS as S, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { PRINCIPAL } from "@/lib/exec/__tests__/slack-read-jobs";
import { DdReadError, listEodSlackAnchors } from "@/lib/exec/sources/dd";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Area B: listEodSlackAnchors (contract §3.13 B block, C4, B-P7b-5): the Scaled Team posts' anchors from
// eod_client_updates and eod_client_checkins. Exactly six columns (never message or subject), posts with a Slack ts sent in
// the window, paged by (sent_at, id), and a failure that names the table and the database's code only.

type Answer = { data: unknown; error: { code?: string; message: string } | null };
interface Recorded { table: string; steps: [string, unknown[]][] }
let calls: Recorded[];
let answers: Record<string, Answer[]>;

function builder(rec: Recorded): unknown {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "gte", "order", "range", "abortSignal", "is", "in", "limit"]) {
    b[m] = (...args: unknown[]) => {
      rec.steps.push([m, args]);
      return b;
    };
  }
  b.then = (resolve: (v: Answer) => unknown, reject: (e: unknown) => unknown) => {
    const queue = answers[rec.table] ?? [];
    const next = queue.length > 1 ? (queue.shift() as Answer) : (queue[0] ?? { data: [], error: null });
    return Promise.resolve(next).then(resolve, reject);
  };
  return b;
}

function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, client_id: "cl_acme", client_name: "Acme Dental", slack_channel: "C0SCALEDTEAM", slack_ts: "1794063600.000400", sent_at: "2026-11-07T15:00:00.000Z", ...over };
}

let out: ReturnType<typeof captureConsole>;
afterEach(() => {
  // The read logs nothing; what it returns is ids, a client name and times only (§0.3 rule 4).
  expect(out.calls()).toEqual([]);
  assertNoSlackLeak({ console: out });
});

beforeEach(() => {
  out = captureConsole();
  calls = [];
  answers = {};
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from: (table: string) => {
      const rec: Recorded = { table, steps: [] };
      calls.push(rec);
      return builder(rec);
    }
  } as unknown as SupabaseClient);
});

describe("listEodSlackAnchors", () => {
  it("reads updates then check-ins: the six columns, a Slack ts and channel, sent since the window, ordered by (sent_at, id), with the signal", async () => {
    answers = {
      eod_client_updates: [{ data: [row("cu_1", { slack_ts: "1794063700.000100", client_id: null, client_name: "Beta Labs" })], error: null }],
      eod_client_checkins: [{ data: [row("cc_1")], error: null }]
    };
    const ac = new AbortController();
    const got = await listEodSlackAnchors(PRINCIPAL, "2026-10-09T15:00:00Z", { signal: ac.signal });
    expect(got).toEqual([
      { source: "update", id: "cu_1", clientId: null, clientName: "Beta Labs", slackChannel: "C0SCALEDTEAM", slackTs: "1794063700.000100", sentAt: "2026-11-07T15:00:00.000Z" },
      { source: "checkin", id: "cc_1", clientId: "cl_acme", clientName: "Acme Dental", slackChannel: "C0SCALEDTEAM", slackTs: "1794063600.000400", sentAt: "2026-11-07T15:00:00.000Z" }
    ]);
    expect(calls.map((c) => c.table)).toEqual(["eod_client_updates", "eod_client_checkins"]);
    for (const c of calls) {
      expect(c.steps).toEqual([
        ["select", ["id,client_id,client_name,slack_channel,slack_ts,sent_at", undefined]],
        ["not", ["slack_ts", "is", null]],
        ["not", ["slack_channel", "is", null]],
        ["gte", ["sent_at", "2026-10-09T15:00:00.000Z"]],
        ["order", ["sent_at", { ascending: true }]],
        ["order", ["id", { ascending: true }]],
        ["range", [0, 999]],
        ["abortSignal", [ac.signal]]
      ]);
    }
  });

  it("never selects message or subject (the column list is pinned; B-P7b-5)", async () => {
    await listEodSlackAnchors(PRINCIPAL, "2026-10-09T15:00:00.000Z");
    const cols = calls.map((c) => String(c.steps[0][1][0]).split(","));
    for (const list of cols) {
      expect(list).toEqual(["id", "client_id", "client_name", "slack_channel", "slack_ts", "sent_at"]);
      expect(list.some((c) => /message|subject|user_id|note/.test(c))).toBe(false);
    }
  });

  it("pages in 1 000s until a short page", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => row(`cu_${String(i).padStart(4, "0")}`));
    answers = { eod_client_updates: [{ data: full, error: null }, { data: [row("cu_last")], error: null }] };
    const got = await listEodSlackAnchors(PRINCIPAL, "2026-10-09T15:00:00.000Z");
    expect(got).toHaveLength(1001);
    expect(calls.filter((c) => c.table === "eod_client_updates").map((c) => c.steps.find((s) => s[0] === "range")?.[1])).toEqual([[0, 999], [1000, 1999]]);
  });

  it("leaves out a row without a usable id, channel id, ts or sent time; trims the channel and ts; an empty client id is none", async () => {
    answers = {
      eod_client_updates: [{
        data: [
          row("cu_ok", { slack_channel: " C0SCALEDTEAM ", slack_ts: " 1794063600.000400 ", client_id: "" }),
          row("", {}), row("cu_badchan", { slack_channel: "#scaled-team" }), row("cu_badts", { slack_ts: "p1794063600000400" }),
          row("cu_nots", { slack_ts: null }), row("cu_noname", { client_name: null }), row("cu_nosent", { sent_at: "yesterday" }), null, "x"
        ],
        error: null
      }]
    };
    const got = await listEodSlackAnchors(PRINCIPAL, "2026-10-09T15:00:00.000Z");
    expect(got).toEqual([{ source: "update", id: "cu_ok", clientId: null, clientName: "Acme Dental", slackChannel: "C0SCALEDTEAM", slackTs: "1794063600.000400",
      sentAt: "2026-11-07T15:00:00.000Z" }]);
  });

  it("a failed read throws DdReadError naming the table and the code, never the database's message", async () => {
    answers = { eod_client_checkins: [{ data: null, error: { code: "42P01", message: `relation does not exist near ${S.eodWork} ${S.clientName}` } }] };
    const err = await listEodSlackAnchors(PRINCIPAL, "2026-10-09T15:00:00.000Z").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DdReadError);
    expect((err as DdReadError).table).toBe("eod_client_checkins");
    expect((err as Error).message).toBe("DD read failed (eod_client_checkins): 42P01");
    assertNoSlackLeak({ errors: [err] });
    answers = { eod_client_updates: [{ data: null, error: null }] };
    await expect(listEodSlackAnchors(PRINCIPAL, "2026-10-09T15:00:00.000Z")).rejects.toThrow("DD read failed (eod_client_updates): the response carried no rows");
    answers = { eod_client_updates: [{ data: null, error: { message: "boom" } }] };
    await expect(listEodSlackAnchors(PRINCIPAL, "2026-10-09T15:00:00.000Z")).rejects.toThrow("DD read failed (eod_client_updates): error");
  });

  it("a malformed window or a missing principal throws before any read", async () => {
    await expect(listEodSlackAnchors(PRINCIPAL, "not a date")).rejects.toBeInstanceOf(TypeError);
    await expect(listEodSlackAnchors(null as unknown as typeof PRINCIPAL, "2026-10-09T15:00:00.000Z")).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });
});
