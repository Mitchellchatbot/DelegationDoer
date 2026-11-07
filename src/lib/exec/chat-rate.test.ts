import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { createChatFakeDb, type ChatFakeDb, type Row } from "@/lib/exec/__tests__/fake-chat-store-db";
import { RATE_BUCKETS, rateLimit } from "@/lib/exec/http";
import { principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// T74: P5b's two rate buckets in P5a's registry (contract §3.0.1, S2; bindings
// AM2). "chat" counts his questions (exec_messages user rows, any surface) by
// created_at; "proposal" counts his decided proposals (confirms and
// dismisses) by decided_at. Both fail closed through rateLimit.

const NOW = new Date("2026-11-07T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const WINDOW_MS = 600_000;
const SINCE = ago(600);

function mint(id: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: `${id}@scaledai.org`, name: id, work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint("ep_1");

const message = (n: number, over: Row): Row => ({ id: `ecm_${n}`, principal_id: "ep_1", role: "user", surface: "web", created_at: ago(n), ...over });
const proposal = (n: number, over: Row): Row => ({ id: `etp_${n}`, principal_id: "ep_1", status: "dismissed", decided_at: ago(n), ...over });

let db: ChatFakeDb;
function useDb(tables: Record<string, Row[]>): ChatFakeDb {
  db = createChatFakeDb({ tables });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("RATE_BUCKETS.chat (T74)", () => {
  const rows = [
    message(30, {}),
    message(60, { surface: "slack" }),
    message(90, {}),
    message(45, { role: "assistant" }),
    message(15, { role: "assistant" }),
    message(700, {}),
    message(20, { principal_id: "ep_2" })
  ];

  it("counts his question rows in the window only: not answers, not older rows, not another principal's", async () => {
    useDb({ exec_messages: rows });
    const nth = (n: number) => RATE_BUCKETS.chat.nthNewestAt(P, SINCE, n);
    expect(await nth(1)).toBe(ago(30));
    expect(await nth(2)).toBe(ago(60));
    expect(await nth(3)).toBe(ago(90));
    expect(await nth(4)).toBeNull();
  });

  it("reads exec_messages.created_at with the rate index's predicate, newest first, the n-th row only, with the signal", async () => {
    useDb({ exec_messages: rows });
    const signal = new AbortController().signal;
    await RATE_BUCKETS.chat.nthNewestAt(P, SINCE, 3, signal);
    const [q] = db.requests;
    expect([q.kind, q.target, q.columns]).toEqual(["select", "exec_messages", "created_at"]);
    expect(q.filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["eq", "role", "user"],
      ["gte", "created_at", SINCE],
      ["not_is_null", "created_at", null]
    ]);
    expect(q.orders).toEqual([{ column: "created_at", ascending: false }]);
    expect(q.range).toEqual([2, 2]);
    expect(q.signal).toBe(signal);
  });

  it("through rateLimit: under the limit ok; at it 429 with Retry-After from the oldest counted row; a missing table 503", async () => {
    useDb({ exec_messages: rows });
    expect(await rateLimit(P, "chat", 4, WINDOW_MS, { now: NOW })).toEqual({ ok: true });
    const limited = await rateLimit(P, "chat", 3, WINDOW_MS, { now: NOW });
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.response.status).toBe(429);
    expect(await limited.response.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 510 });
    expect(limited.response.headers.get("retry-after")).toBe("510");
    useDb({});
    const down = await rateLimit(P, "chat", 30, WINDOW_MS, { now: NOW });
    expect(down.ok).toBe(false);
    if (down.ok) return;
    expect(down.response.status).toBe(503);
    expect(await down.response.json()).toEqual({ error: "unavailable" });
    await expect(RATE_BUCKETS.chat.nthNewestAt(P, SINCE, 1)).rejects.toThrow("exec_messages rate count failed");
  });

  it("refuses a bad n or since before reading", async () => {
    useDb({ exec_messages: rows });
    await expect(RATE_BUCKETS.chat.nthNewestAt(P, SINCE, 0)).rejects.toThrow(TypeError);
    await expect(RATE_BUCKETS.chat.nthNewestAt(P, "recently", 1)).rejects.toThrow(TypeError);
    expect(db.requests).toEqual([]);
  });
});

describe("RATE_BUCKETS.proposal (T74)", () => {
  const rows = [
    proposal(10, { status: "confirmed" }),
    proposal(40, {}),
    proposal(0, { status: "pending", decided_at: null }),
    proposal(1, { status: "confirming", decided_at: null }),
    proposal(800, {}),
    proposal(5, { principal_id: "ep_2" })
  ];

  it("counts his decided proposals (confirms and dismisses) by decided_at in the window; undecided ones never count", async () => {
    useDb({ exec_task_proposals: rows });
    const nth = (n: number) => RATE_BUCKETS.proposal.nthNewestAt(P, SINCE, n);
    expect(await nth(1)).toBe(ago(10));
    expect(await nth(2)).toBe(ago(40));
    expect(await nth(3)).toBeNull();
    const [q] = db.requests;
    expect([q.target, q.columns]).toEqual(["exec_task_proposals", "decided_at"]);
    expect(q.filters).toEqual([
      ["eq", "principal_id", "ep_1"],
      ["gte", "decided_at", SINCE],
      ["not_is_null", "decided_at", null]
    ]);
    expect(q.orders).toEqual([{ column: "decided_at", ascending: false }]);
  });

  it("through rateLimit: 429 at the limit, 503 without the table", async () => {
    useDb({ exec_task_proposals: rows });
    const r = await rateLimit(P, "proposal", 2, WINDOW_MS, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(429);
    useDb({});
    const down = await rateLimit(P, "proposal", 2, WINDOW_MS, { now: NOW });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.response.status).toBe(503);
  });
});
