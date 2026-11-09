import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/producers/dd", async () => (await import("./__tests__/ddtext-mocks")).producersDd);
vi.mock("@/lib/exec/analysis/tasks", async () => (await import("./__tests__/ddtext-mocks")).analysisTasks);

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  ddtextLastRunAt,
  deleteAllDdtextData,
  deleteDdtextItems,
  deleteDdtextItemsForTasks,
  getDdtextCursor,
  listDdtextItemsByKeys,
  listDeferredDdtextItems,
  listLiveDdtextSignals,
  parseDdtextCursor,
  purgeExpiredDdtext,
  purgeOrphanDdtextAttention,
  saveDdtextCursor,
  writeDdtextItem,
  type DdtextItemWrite
} from "@/lib/exec/ddtext-store";
import { ddtextFingerprint } from "@/lib/exec/producers/ddtext";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { createFakeDdtextDb, type FakeDdtextDb, type Row } from "./__tests__/fake-ddtext-db";
import { createFakePostgrest, type FakePostgrest } from "./__tests__/fake-postgrest";

// P5a contract §3.12.4, tests 59b (the orphan purge), 61 (writes and deletes)
// and 62's ddtextLastRunAt, over the fake DD + ddtext + attention database.

const NOW = new Date("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const HASH = "a".repeat(64);

const mk = (id: string, userId: string) =>
  ({ id, userId, email: `${id}@x.test`, name: "Mitchell", timezone: "America/New_York", mailAccountIds: [], slackTeamId: null, slackUserId: null }) as unknown as ExecPrincipal;
const p1 = mk("ep_1", "u_mitchell");
const p2 = mk("ep_2", "u_other");

let db: FakeDdtextDb;
let state: FakePostgrest;

function wire(): void {
  const client = db.client as { from(t: string): unknown; rpc(n: string, a: unknown): unknown };
  const stateClient = state.client as { from(t: string): unknown };
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from: (t: string) => (t === "exec_sync_state" ? stateClient.from(t) : client.from(t)),
    rpc: (n: string, a: unknown) => client.rpc(n, a)
  } as unknown as SupabaseClient);
}

beforeEach(() => {
  db = createFakeDdtextDb();
  state = createFakePostgrest({ tables: { exec_sync_state: [] } });
  for (const u of ["u_ann", "u_bob", "u_mitchell"]) db.userIds.add(u);
  for (const t of ["t_1", "t_2"]) db.taskIds.add(t);
  wire();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function activity(id: string, taskId = "t_1", userId = "u_ann", createdAt = ago(1)): Row {
  const row = { id, task_id: taskId, user_id: userId, action: "comment", detail: "x", created_at: createdAt, mentioned_user_ids: [] };
  db.activity.push(row);
  return row;
}

function commentWrite(id: string, over: Partial<DdtextItemWrite> = {}): DdtextItemWrite {
  return {
    sourceType: "comment",
    sourceId: id,
    activityLogId: id,
    eodNoteId: null,
    sodNoteId: null,
    taskId: "t_1",
    authorUserId: "u_ann",
    sourceCreatedAt: ago(1),
    noteDate: null,
    outcome: "signals",
    failure: null,
    contentHash: HASH,
    model: "claude-haiku-5-5",
    triageVersion: "ddtext-v1",
    expiresAt: new Date(NOW.getTime() + 89 * DAY).toISOString(),
    ...over
  };
}

const blocker = { kind: "blocker" as const, summary: "Hosting access is missing.", confidence: "high" as const };
const mention = { kind: "mention" as const, summary: null, confidence: "deterministic" as const };

function attentionRow(principalId: string, fingerprint: string, over: Row = {}): Row {
  const status = (over.status as string | undefined) ?? "open";
  return db.attention.seed({
    principal_id: principalId,
    fingerprint,
    source: "dd",
    kind: "ddtext_blocker",
    category: "intervene",
    priority_score: 60,
    priority_band: "high",
    priority_reasons: ["Blocker in DD text (AI-assessed) (base 60)"],
    title: "Possible blocker",
    what_happened: "An AI reading found a possible blocker.",
    why_it_matters: "It matters.",
    facts: [{ text: "Hosting access is missing.", basis: "ai", refs: [] }],
    state_hash: "0123456789abcdef0123456789abcdef",
    status,
    resolution: status === "resolved" ? "owner" : null,
    resolved_at: status === "resolved" ? ago(1) : null,
    occurred_at: ago(1),
    ...over
  });
}

describe("writeDdtextItem (test 61)", () => {
  it("calls the RPC with exactly the migration's item keys and maps written / source_gone", async () => {
    activity("a_1");
    expect(await writeDdtextItem(p1, commentWrite("a_1"), [blocker, mention])).toBe("written");
    const call = db.callsTo("exec_ddtext_replace_item", "rpc")[0];
    expect(Object.keys(call.args ?? {}).sort()).toEqual(["p_item", "p_principal", "p_signals"]);
    expect(Object.keys(call.args?.p_item as Row).sort()).toEqual(
      [
        "activity_log_id",
        "author_user_id",
        "content_hash",
        "eod_note_id",
        "expires_at",
        "failure",
        "model",
        "note_date",
        "outcome",
        "source_created_at",
        "source_id",
        "source_type",
        "sod_note_id",
        "task_id",
        "triage_version"
      ].sort()
    );
    expect(call.args?.p_signals).toEqual([
      { kind: "blocker", summary: "Hosting access is missing.", confidence: "high" },
      { kind: "mention", summary: null, confidence: "deterministic" }
    ]);
    expect(db.items).toHaveLength(1);
    expect(db.signals.map((s) => s.kind).sort()).toEqual(["blocker", "mention"]);
    // A re-triage replaces the signals.
    expect(await writeDdtextItem(p1, commentWrite("a_1", { outcome: "none" }), [])).toBe("written");
    expect(db.signals).toEqual([]);
    // The DD row is gone: nothing written.
    expect(await writeDdtextItem(p1, commentWrite("a_gone"), [blocker])).toBe("source_gone");
    expect(db.items).toHaveLength(1);
  });

  it("a CHECK violation is NonRetryableError; anything else is a plain, retryable Error", async () => {
    activity("a_1");
    await expect(writeDdtextItem(p1, commentWrite("a_1", { taskId: null }), [])).rejects.toBeInstanceOf(NonRetryableError);
    db.fail = () => ({ message: "upstream connect error" });
    const err = await writeDdtextItem(p1, commentWrite("a_1"), []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });

  it("refuses malformed input before the database", async () => {
    await expect(writeDdtextItem(p1, commentWrite("a_1", { contentHash: "nothex" }), [])).rejects.toBeInstanceOf(NonRetryableError);
    await expect(writeDdtextItem(p1, commentWrite("a_1"), [{ kind: "blocker", summary: "x".repeat(201), confidence: "high" }])).rejects.toBeInstanceOf(NonRetryableError);
    await expect(writeDdtextItem(p1, commentWrite("a_1"), [{ kind: "mention", summary: "text", confidence: "deterministic" }])).rejects.toBeInstanceOf(NonRetryableError);
    await expect(writeDdtextItem(p1, commentWrite("a_1"), [blocker, blocker])).rejects.toBeInstanceOf(NonRetryableError);
    expect(db.callsTo("exec_ddtext_replace_item")).toEqual([]);
  });
});

describe("reads", () => {
  it("listDdtextItemsByKeys, listDeferredDdtextItems and listLiveDdtextSignals are scoped to the principal", async () => {
    activity("a_1");
    activity("a_2", "t_2");
    activity("a_3");
    await writeDdtextItem(p1, commentWrite("a_1"), [blocker]);
    await writeDdtextItem(p1, commentWrite("a_2", { taskId: "t_2", outcome: "deferred", model: null, sourceCreatedAt: ago(2) }), []);
    await writeDdtextItem(p2, commentWrite("a_3", { outcome: "deferred", model: null }), []);
    const keys = await listDdtextItemsByKeys(p1, [
      { sourceType: "comment", sourceId: "a_1" },
      { sourceType: "comment", sourceId: "a_2" },
      { sourceType: "comment", sourceId: "a_3" }
    ]);
    expect([...keys]).toEqual([
      ["comment:a_1", { contentHash: HASH, outcome: "signals" }],
      ["comment:a_2", { contentHash: HASH, outcome: "deferred" }]
    ]);
    expect((await listDeferredDdtextItems(p1, ago(14), 10)).map((r) => r.sourceId)).toEqual(["a_2"]);
    expect(await listDeferredDdtextItems(p1, ago(14), 0)).toEqual([]);
    const sig = await listLiveDdtextSignals(p1, { sinceIso: ago(14) });
    expect(sig).toEqual([
      expect.objectContaining({ sourceType: "comment", sourceId: "a_1", kind: "blocker", summary: "Hosting access is missing.", confidence: "high", taskId: "t_1", authorUserId: "u_ann" })
    ]);
    expect(await listLiveDdtextSignals(p1, { sinceIso: ago(14), taskIds: ["t_2"] })).toEqual([]);
    expect(await listLiveDdtextSignals(p1, { sinceIso: ago(14), kinds: [] })).toEqual([]);
  });

  it("reads fail closed on a database error, and read as nothing stored when the migration isn't applied", async () => {
    db.fail = (c) => (c.table === "exec_ddtext_signals" ? { message: "timeout" } : null);
    await expect(listLiveDdtextSignals(p1, { sinceIso: ago(14) })).rejects.toThrow("timeout");
    db.fail = () => null;
    db.installed = false;
    expect(await listLiveDdtextSignals(p1, { sinceIso: ago(14) })).toEqual([]);
    expect(await listDdtextItemsByKeys(p1, [{ sourceType: "comment", sourceId: "x" }])).toEqual(new Map());
    expect(await purgeExpiredDdtext(NOW)).toBe(0);
  });
});

describe("deletes (test 61)", () => {
  it("deleteDdtextItems, deleteDdtextItemsForTasks and deleteAllDdtextData touch only the principal's rows and count them", async () => {
    for (const id of ["a_1", "a_2", "a_3", "a_4"]) activity(id, id === "a_2" ? "t_2" : "t_1");
    await writeDdtextItem(p1, commentWrite("a_1"), [blocker]);
    await writeDdtextItem(p1, commentWrite("a_2", { taskId: "t_2" }), [blocker]);
    await writeDdtextItem(p1, commentWrite("a_3"), [blocker]);
    await writeDdtextItem(p2, commentWrite("a_4"), [blocker]);
    attentionRow("ep_1", ddtextFingerprint("blocker", "comment", "a_1"), { status: "resolved" });
    attentionRow("ep_1", "dd:overdue:assignee:u_ann", { kind: "overdue_tasks", category: "delegated" });
    attentionRow("ep_2", ddtextFingerprint("blocker", "comment", "a_4"));

    expect(await deleteDdtextItems(p1, [{ sourceType: "comment", sourceId: "a_1" }, { sourceType: "comment", sourceId: "a_4" }])).toBe(1);
    expect(await deleteDdtextItemsForTasks(p1, ["t_2"])).toBe(1);
    expect(db.items.map((i) => `${i.principal_id}:${i.source_id}`).sort()).toEqual(["ep_1:a_3", "ep_2:a_4"]);
    expect(db.signals.map((s) => `${s.principal_id}:${s.source_id}`).sort()).toEqual(["ep_1:a_3", "ep_2:a_4"]);

    expect(await deleteAllDdtextData(p1)).toEqual({ items: 1, attentionRows: 1 });
    expect(db.items.map((i) => i.principal_id)).toEqual(["ep_2"]);
    expect(db.attention.rows.map((r) => `${r.principal_id}:${r.kind}`).sort()).toEqual(["ep_1:overdue_tasks", "ep_2:ddtext_blocker"]);
  });
});

describe("purgeOrphanDdtextAttention (test 59b, a-correct-1)", () => {
  async function storedBlocker(principal: ExecPrincipal, id: string, userId = "u_ann", days = 1): Promise<string> {
    activity(id, "t_1", userId, ago(days));
    await writeDdtextItem(principal, commentWrite(id, { authorUserId: userId, sourceCreatedAt: ago(days) }), [blocker]);
    return ddtextFingerprint("blocker", "comment", id);
  }

  it("a deleted DD source (cascade) takes the attention row with it, whatever its status", async () => {
    const fp = await storedBlocker(p1, "a_1");
    attentionRow("ep_1", fp, { status: "open" });
    const fpSeen = await storedBlocker(p1, "a_2");
    attentionRow("ep_1", fpSeen, { status: "seen" });
    const fpDismissed = await storedBlocker(p1, "a_3");
    attentionRow("ep_1", fpDismissed, { status: "dismissed" });
    const fpResolved = await storedBlocker(p1, "a_4");
    attentionRow("ep_1", fpResolved, { status: "resolved" });
    // Nothing to purge while every row is backed.
    expect(await purgeOrphanDdtextAttention(NOW, { principal: p1 })).toBe(0);
    for (const id of ["a_1", "a_2", "a_3", "a_4"]) db.deleteActivity(id);
    expect(db.signals).toEqual([]);
    expect(await purgeOrphanDdtextAttention(NOW, { principal: p1 })).toBe(4);
    expect(db.attention.rows).toEqual([]);
  });

  it("off-boarding the author (user delete cascade) does the same", async () => {
    db.userIds.add("u_leaver");
    attentionRow("ep_1", await storedBlocker(p1, "a_9", "u_leaver"));
    db.deleteUser("u_leaver");
    expect(await purgeOrphanDdtextAttention(NOW, { principal: p1 })).toBe(1);
    expect(db.attention.rows).toEqual([]);
  });

  it("deletes an unparseable fingerprint and a row past 14 days even when backed; keeps a backed recent row and other kinds", async () => {
    const recent = await storedBlocker(p1, "a_1");
    attentionRow("ep_1", recent);
    const old = await storedBlocker(p1, "a_2", "u_ann", 15);
    attentionRow("ep_1", old, { status: "resolved", occurred_at: ago(15) });
    attentionRow("ep_1", "dd:ddtext:blocker:garbage");
    attentionRow("ep_1", "dd:overdue:assignee:u_ann", { kind: "overdue_tasks", category: "delegated", occurred_at: ago(40) });
    expect(await purgeOrphanDdtextAttention(NOW, { principal: p1 })).toBe(2);
    expect(db.attention.rows.map((r) => r.fingerprint).sort()).toEqual([recent, "dd:overdue:assignee:u_ann"].sort());
  });

  it("uses the backing signals it is handed, and covers every principal when none is named", async () => {
    const fp1 = await storedBlocker(p1, "a_1");
    attentionRow("ep_1", fp1);
    const fp2 = await storedBlocker(p2, "a_2");
    attentionRow("ep_2", fp2);
    attentionRow("ep_2", ddtextFingerprint("waiting", "comment", "a_2"), { kind: "ddtext_waiting" });
    // Handed an empty backing list, the run's principal loses its row without a signal read.
    const reads = db.callsTo("exec_ddtext_signals").length;
    expect(await purgeOrphanDdtextAttention(NOW, { principal: p1, backing: [] })).toBe(1);
    expect(db.callsTo("exec_ddtext_signals").length).toBe(reads);
    // The purge job: every principal, each against its own stored signals.
    expect(await purgeOrphanDdtextAttention(NOW)).toBe(1);
    expect(db.attention.rows.map((r) => r.fingerprint)).toEqual([fp2]);
  });

  it("missing tables purge nothing", async () => {
    attentionRow("ep_1", ddtextFingerprint("blocker", "comment", "a_1"));
    db.installed = false;
    expect(await purgeOrphanDdtextAttention(NOW, { principal: p1 })).toBe(0);
    expect(db.attention.rows).toHaveLength(1);
  });

  it("retention 7: after the expiry purge and the orphan purge, no summary and no ai fact older than 7 days remains (M30)", async () => {
    const keep = 7;
    const write = async (id: string, days: number) => {
      activity(id, "t_1", "u_ann", ago(days));
      await writeDdtextItem(p1, commentWrite(id, { sourceCreatedAt: ago(days), expiresAt: new Date(NOW.getTime() - days * DAY + keep * DAY).toISOString() }), [blocker]);
      attentionRow("ep_1", ddtextFingerprint("blocker", "comment", id), { occurred_at: ago(days), status: days > 5 ? "resolved" : "open" });
    };
    await write("old", 8);
    await write("new", 3);
    expect(await purgeExpiredDdtext(NOW)).toBe(1);
    expect(await purgeOrphanDdtextAttention(NOW)).toBe(1);
    const cutoff = NOW.getTime() - keep * DAY;
    expect(db.signals.every((s) => Date.parse(s.source_created_at as string) >= cutoff)).toBe(true);
    const aiFacts = db.attention.rows.filter((r) => (r.facts as { basis: string }[]).some((f) => f.basis === "ai"));
    expect(aiFacts.every((r) => Date.parse(r.occurred_at as string) >= cutoff)).toBe(true);
    expect(aiFacts.map((r) => r.fingerprint)).toEqual([ddtextFingerprint("blocker", "comment", "new")]);
  });
});

describe("the cursor (test 62: ddtextLastRunAt)", () => {
  const cursor = (startedAt: string) => ({ comments: { at: "2026-11-20T11:00:00.123456+00:00", id: "a_9" }, eod: { at: null }, sod: { at: ago(1) }, startedAt });

  it("returns the saved cursor's startedAt, also when a later run moved no position", async () => {
    expect(await ddtextLastRunAt(p1)).toBeNull();
    expect(await saveDdtextCursor(p1, null, cursor("2026-11-20T11:50:00.000Z"))).toBe(true);
    expect(await ddtextLastRunAt(p1)).toBe("2026-11-20T11:50:00.000Z");
    const read = await getDdtextCursor(p1);
    expect(read?.value.comments).toEqual({ at: "2026-11-20T11:00:00.123456+00:00", id: "a_9" });
    // Same positions, a new run start.
    expect(await saveDdtextCursor(p1, read?.rev ?? null, cursor("2026-11-20T12:00:00.000Z"))).toBe(true);
    expect(await ddtextLastRunAt(p1)).toBe("2026-11-20T12:00:00.000Z");
    // A stale rev loses the CAS.
    expect(await saveDdtextCursor(p1, read?.rev ?? null, cursor("2026-11-20T12:10:00.000Z"))).toBe(false);
    expect(state.tables.exec_sync_state.map((r) => [r.source, r.key])).toEqual([["ddtext", "cursor"]]);
  });

  it("parseDdtextCursor: the stored shape round-trips; anything malformed is null", () => {
    expect(parseDdtextCursor({ rev: 3, ...cursor("2026-11-20T12:00:00.000Z") })).toEqual(cursor("2026-11-20T12:00:00.000Z"));
    expect(parseDdtextCursor({ ...cursor("2026-11-20T12:00:00.000Z"), comments: { at: null, id: null } })).toMatchObject({ comments: { at: null, id: null } });
    for (const bad of [null, 5, {}, { ...cursor("x") }, { ...cursor("2026-11-20T12:00:00.000Z"), comments: { at: "yesterday", id: null } }, { ...cursor("2026-11-20T12:00:00.000Z"), comments: { at: null, id: "a b" } }, { ...cursor("2026-11-20T12:00:00.000Z"), eod: null }]) {
      expect(parseDdtextCursor(bad)).toBeNull();
    }
  });
});
