import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { checkDraftRow, createFakeDraftsDb, draftDefaults, purgeExpiredRows, purgeRestrictedRows, type FakeDraftsDb, type Row } from "@/lib/exec/__tests__/fake-drafts-db";
import {
  DRAFT_COLUMNS,
  DraftStoreError,
  casDraft,
  claimDueDraft,
  countDraftsForCard,
  countDraftsForSystem,
  countRecentAudit,
  draftFromDb,
  earliestDueWithin,
  getActiveDraftForThread,
  getDraft,
  getLatestDraftForParent,
  getVoiceProfile,
  hasDueDrafts,
  insertDraft,
  isUniqueViolation,
  listDraftArtifacts,
  listDrafts,
  listDraftsForParent,
  listDueDrafts,
  listSentInternetMessageIds,
  purgeDraftsForThreads,
  purgeExpiredDrafts,
  upsertVoiceProfile,
  type NewDraftRow
} from "@/lib/exec/drafts-store";
import type { ExecDraftRow, ExecDraftStatus } from "@/lib/exec/drafts-types";
import { principalFromRows } from "@/lib/exec/principal";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec_drafts / exec_voice_profile reads and writes (contract §3.7) against
// the fake PostgREST (fake-drafts-db), which mirrors the table's CHECKs, the
// one-active index and both RPCs. The SQL suite (<sp>/p4-sql) runs the RPC
// cases below against the real functions on three engines (SQ19).

const NOW = new Date("2026-11-06T12:00:00.000Z");
const DAY = 86_400_000;
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const HEX = (c: string) => c.repeat(64);
const idOf = (n: number) => `ed_${n.toString(16).padStart(32, "0")}`;

function mint(id = "ep_1"): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();
const OTHER = mint("ep_2");

/** A snake_case exec_drafts row with the defaults, a reply draft in DD only. */
function dbRow(n: number, over: Row = {}): Row {
  return {
    ...draftDefaults(NOW),
    id: idOf(n),
    principal_id: "ep_1",
    account_id: "acc_1",
    kind: "reply",
    status: "draft",
    thread_id: `th_${n}`,
    parent_message_id: `m_${n}`,
    reply_mode: "reply",
    thread_subject: "Renewal",
    to_recipients: [{ address: "a@client.com", name: "Ann" }],
    body_text: "Hi",
    render_nonce: "abcdefabcdefabcdef012345",
    created_at: at(-20 * MIN),
    updated_at: at(-10 * MIN),
    ...over
  };
}
const LINK = { outlook_graph_id: "AAMk=", web_link: "https://outlook.office.com/x", content_hash: HEX("c"), observed_content_hash: HEX("c"), saved_version: 1 };
const SENT = { ...LINK, send_attempt_key: "k:v1:send:n", send_started_at: at(-40 * MIN), confirm_hash: HEX("c"), sent_at: at(-30 * MIN), terminal_at: at(-30 * MIN), expires_at: at(180 * DAY), internet_message_id: "<Sent@X>" };

let db: FakeDraftsDb;
function useDb(cfg: Parameters<typeof createFakeDraftsDb>[0] = {}) {
  db = createFakeDraftsDb({ now: () => NOW, ...cfg });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const rows = () => db.tables.exec_drafts ?? [];

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function newRow(over: Partial<NewDraftRow> = {}): NewDraftRow {
  const base = draftFromDb(dbRow(1));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = base;
  void _id;
  void _c;
  void _u;
  return { ...rest, ...over };
}

describe("row mapping", () => {
  it("DRAFT_COLUMNS covers every field; draftFromDb maps a full row and refuses a malformed one", () => {
    const row = draftFromDb(dbRow(1, { ...LINK, status: "saved" }));
    expect(row).toMatchObject({ id: idOf(1), principalId: "ep_1", status: "saved", outlookGraphId: "AAMk=", savedVersion: 1, toRecipients: [{ address: "a@client.com", name: "Ann" }] });
    expect(Object.keys(row).sort()).toEqual(Object.keys(DRAFT_COLUMNS).sort());
    expect(() => draftFromDb(dbRow(1, { status: "weird" }))).toThrow(/column status is malformed/);
    expect(() => draftFromDb(dbRow(1, { version: "1" }))).toThrow(/column version is malformed/);
    expect(() => draftFromDb(dbRow(1, { to_recipients: [{ name: "x" }] }))).toThrow(/column to_recipients is malformed/);
    expect(() => draftFromDb(dbRow(1, { clone_flags: ["nope"] }))).toThrow(/column clone_flags is malformed/);
    expect(() => draftFromDb(dbRow(1, { created_at: "yesterday" }))).toThrow(/column created_at is malformed/);
    expect(() => draftFromDb(null)).toThrow(/not an object/);
    // A recipient without a name reads as null.
    expect(draftFromDb(dbRow(1, { to_recipients: [{ address: "a@b.c" }] })).toRecipients).toEqual([{ address: "a@b.c", name: null }]);
  });
});

describe("insertDraft", () => {
  it("sends every NewDraftRow column (one key set), returns the stored row, and answers the existing active draft on 23505", async () => {
    useDb();
    const out = await insertDraft(P, newRow());
    expect(out.inserted).toBe(true);
    if (!out.inserted) return;
    expect(out.row.id).toMatch(/^ed_[0-9a-f]{32}$/);
    expect(out.row.status).toBe("draft");
    const payload = db.requests[0].payload as Row;
    const expectedKeys = Object.values(DRAFT_COLUMNS).filter((c) => !["id", "created_at", "updated_at"].includes(c)).sort();
    expect(Object.keys(payload).sort()).toEqual(expectedKeys);
    const again = await insertDraft(P, newRow());
    expect(again).toEqual({ inserted: false, existingId: out.row.id });
    // A terminal row on the thread doesn't block; another principal's does not either.
    rows()[0].status = "discarded";
    rows()[0].terminal_at = at(0);
    rows()[0].expires_at = at(DAY);
    expect((await insertDraft(P, newRow())).inserted).toBe(true);
    expect((await insertDraft(OTHER, newRow({ principalId: "ep_2" }))).inserted).toBe(true);
  });
  it("refuses a row for another principal, throws on any other error, and a CHECK refusal is fatal", async () => {
    useDb();
    await expect(insertDraft(P, newRow({ principalId: "ep_2" }))).rejects.toThrow(NonRetryableError);
    await expect(insertDraft(P, newRow({ renderNonce: "bad-nonce" }))).rejects.toMatchObject({ code: "23514", errorClass: "fatal" });
    useDb({ fail: () => ({ message: "statement timeout", code: "57014" }) });
    await expect(insertDraft(P, newRow())).rejects.toMatchObject({ errorClass: "retryable" });
    useDb({ missing: ["exec_drafts"] });
    await expect(insertDraft(P, newRow())).rejects.toBeInstanceOf(DraftStoreError);
  });
});

describe("getDraft / getActiveDraftForThread", () => {
  it("reads by (id, principal); not installed -> null; a foreign row -> null", async () => {
    useDb({ tables: { exec_drafts: [dbRow(1), dbRow(2, { principal_id: "ep_2" })] } });
    expect((await getDraft(P, idOf(1)))?.threadId).toBe("th_1");
    expect(await getDraft(P, idOf(2))).toBeNull();
    expect(await getDraft(P, idOf(3))).toBeNull();
    await expect(getDraft(P, "nope")).rejects.toThrow(NonRetryableError);
    useDb({ missing: ["exec_drafts"] });
    expect(await getDraft(P, idOf(1))).toBeNull();
    useDb({ fail: () => ({ message: "down" }) });
    await expect(getDraft(P, idOf(1))).rejects.toThrow(/read failed: down/);
  });
  it("the active draft: non-terminal or gone while unconfirmed; a confirmed gone or a discarded row doesn't count", async () => {
    useDb({
      tables: {
        exec_drafts: [
          dbRow(1, { status: "discarded", terminal_at: at(-DAY), expires_at: at(DAY) }),
          dbRow(2, { thread_id: "th_1", ...LINK, status: "gone", gone_at: at(-MIN), gone_unconfirmed: false, terminal_at: at(-MIN), expires_at: at(DAY) }),
          dbRow(3, { thread_id: "th_2", ...LINK, status: "gone", gone_at: at(-MIN), gone_unconfirmed: true, terminal_at: at(-MIN), expires_at: at(DAY) })
        ]
      }
    });
    expect(await getActiveDraftForThread(P, "th_1")).toBeNull();
    expect((await getActiveDraftForThread(P, "th_2"))?.id).toBe(idOf(3));
    rows().push(dbRow(4, { thread_id: "th_1", status: "saving", save_attempt_key: "k", save_version: 1, save_started_at: at(0) }));
    expect((await getActiveDraftForThread(P, "th_1"))?.id).toBe(idOf(4));
  });
});

describe("casDraft", () => {
  it("matches exactly one row on (id, principal, status, version) and the attempt keys; a stale version or status is false; adds updated_at", async () => {
    useDb({ tables: { exec_drafts: [dbRow(1, { version: 3 })] } });
    expect(await casDraft(P, idOf(1), { status: "draft", version: 3 }, { status: "saving", save_attempt_key: "k:v3:save:n", save_version: 3, save_started_at: at(0) })).toBe(true);
    expect(rows()[0]).toMatchObject({ status: "saving", save_attempt_key: "k:v3:save:n" });
    expect(typeof rows()[0].updated_at).toBe("string");
    expect(await casDraft(P, idOf(1), { status: "draft", version: 3 }, { status: "generating" })).toBe(false);
    expect(await casDraft(P, idOf(1), { status: "saving", version: 2 }, { status: "draft" })).toBe(false);
    expect(await casDraft(P, idOf(1), { status: "saving", saveAttemptKey: "other" }, { status: "draft" })).toBe(false);
    expect(await casDraft(P, idOf(1), { status: ["saving", "draft"], saveAttemptKey: "k:v3:save:n" }, { status: "draft" })).toBe(true);
    expect(await casDraft(OTHER, idOf(1), { status: "draft", version: 3 }, { status: "generating" })).toBe(false);
    const q = db.requests.at(-1);
    expect(q?.kind).toBe("update");
    expect(q?.columns).toBe("id");
  });
  it("throws on a database error, keeps the 23505 code for the gone -> saved race, and refuses id / principal writes", async () => {
    useDb({ tables: { exec_drafts: [dbRow(1, { thread_id: "th_1" }), dbRow(2, { thread_id: "th_1", ...LINK, status: "gone", gone_at: at(-MIN), gone_unconfirmed: false, terminal_at: at(-MIN), expires_at: at(DAY) })] } });
    const err = await casDraft(P, idOf(2), { status: "gone", version: 1 }, { status: "saved", terminal_at: null, expires_at: null, gone_at: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftStoreError);
    expect(isUniqueViolation(err)).toBe(true);
    expect(rows()[1].status).toBe("gone");
    await expect(casDraft(P, idOf(1), { status: "draft" }, { id: "x" })).rejects.toThrow(NonRetryableError);
    useDb({ fail: () => ({ message: "down" }) });
    await expect(casDraft(P, idOf(1), { status: "draft" }, { status: "generating" })).rejects.toThrow(/update failed: down/);
  });
});

describe("listDrafts", () => {
  const fixture = () => [
    dbRow(1, { status: "draft", updated_at: at(-5 * MIN) }),
    dbRow(2, { status: "unknown", ...LINK, send_attempt_key: "k", send_started_at: at(-40 * MIN), confirm_hash: HEX("c"), updated_at: at(-50 * MIN) }),
    dbRow(3, { status: "generation_failed", generation_error: "declined", updated_at: at(-2 * MIN) }),
    dbRow(4, { status: "sent", ...SENT, updated_at: at(-30 * MIN) }),
    dbRow(5, { status: "sent", ...SENT, sent_mismatch: true, terminal_at: at(-8 * DAY), expires_at: at(100 * DAY), updated_at: at(-8 * DAY) }),
    dbRow(6, { status: "gone", ...LINK, gone_at: at(-MIN), gone_unconfirmed: true, terminal_at: at(-MIN), expires_at: at(DAY), updated_at: at(-MIN) }),
    dbRow(7, { status: "gone", ...LINK, gone_at: at(-MIN), gone_unconfirmed: false, terminal_at: at(-MIN), expires_at: at(DAY), updated_at: at(-MIN) }),
    dbRow(8, { status: "draft", principal_id: "ep_2", updated_at: at(0) }),
    dbRow(9, { status: "sent_external", ...SENT, send_attempt_key: null, send_started_at: null, confirm_hash: null, updated_at: at(-3 * DAY), terminal_at: at(-3 * DAY) })
  ];
  it("active: the unique predicate's rows, attention first in C46's order, then updated_at desc; no cursor", async () => {
    useDb({ tables: { exec_drafts: fixture() } });
    const { rows: list, nextCursor } = await listDrafts(P, { view: "active" }, NOW);
    expect(list.map((r) => r.id)).toEqual([idOf(2), idOf(6), idOf(3), idOf(1)]);
    expect(nextCursor).toBeNull();
  });
  it("recent: sent and sent_external that ended within 7 days, newest first", async () => {
    useDb({ tables: { exec_drafts: fixture() } });
    const { rows: list } = await listDrafts(P, { view: "recent" }, NOW);
    expect(list.map((r) => r.id)).toEqual([idOf(4), idOf(9)]);
  });
  it("all: cursor-paged by updated_at desc, id desc, 50 at most; a malformed cursor is refused", async () => {
    const many = Array.from({ length: 7 }, (_, i) => dbRow(10 + i, { updated_at: at(-(i % 3) * MIN) }));
    useDb({ tables: { exec_drafts: many } });
    const page1 = await listDrafts(P, { view: "all", limit: 3 }, NOW);
    expect(page1.rows).toHaveLength(3);
    expect(page1.nextCursor).toMatch(/^2026-.*~ed_/);
    const page2 = await listDrafts(P, { view: "all", limit: 3, cursor: page1.nextCursor }, NOW);
    const page3 = await listDrafts(P, { view: "all", limit: 3, cursor: page2.nextCursor }, NOW);
    const seen = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(7);
    expect(page3.nextCursor).toBeNull();
    const ordered = [...page1.rows, ...page2.rows, ...page3.rows];
    for (let i = 1; i < ordered.length; i += 1) {
      const a = ordered[i - 1];
      const b = ordered[i];
      expect(a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id), `${a.id} before ${b.id}`).toBe(true);
    }
    expect((await listDrafts(P, { view: "all", limit: 500 }, NOW)).rows).toHaveLength(7);
    await expect(listDrafts(P, { view: "all", cursor: "garbage" }, NOW)).rejects.toThrow(NonRetryableError);
    useDb({ missing: ["exec_drafts"] });
    expect(await listDrafts(P, { view: "active" }, NOW)).toEqual({ rows: [], nextCursor: null });
  });
});

describe("the sweep's reads", () => {
  it("listDueDrafts: next_check_at <= now, oldest first, limited; claimDueDraft moves it once (the race loses)", async () => {
    useDb({
      tables: {
        exec_drafts: [
          dbRow(1, { status: "sent_pending", ...LINK, send_attempt_key: "k", send_started_at: at(-10 * MIN), confirm_hash: HEX("c"), send_accepted_at: at(-9 * MIN), next_check_at: at(-MIN) }),
          dbRow(2, { status: "saving", save_attempt_key: "k", save_version: 1, save_started_at: at(-10 * MIN), next_check_at: at(-3 * MIN) }),
          dbRow(3, { status: "saved", ...LINK, next_check_at: at(5 * MIN) }),
          dbRow(4, { status: "draft", next_check_at: null })
        ]
      }
    });
    const due = await listDueDrafts(P, NOW, 20);
    expect(due.map((r) => r.id)).toEqual([idOf(2), idOf(1)]);
    expect((await listDueDrafts(P, NOW, 1)).map((r) => r.id)).toEqual([idOf(2)]);
    expect(await hasDueDrafts(P, NOW)).toBe(true);
    expect(await earliestDueWithin(P, NOW, 5 * MIN)).toBe(at(-3 * MIN));
    expect(await earliestDueWithin(P, new Date(NOW.getTime() + 20 * MIN), 0)).toBe(at(-3 * MIN));
    expect(await claimDueDraft(P, idOf(2), at(-3 * MIN), at(7 * MIN))).toBe(true);
    expect(rows()[1].next_check_at).toBe(at(7 * MIN));
    expect(await claimDueDraft(P, idOf(2), at(-3 * MIN), at(7 * MIN))).toBe(false);
    expect(await claimDueDraft(OTHER, idOf(1), at(-MIN), at(7 * MIN))).toBe(false);
    await expect(claimDueDraft(P, idOf(1), "soon", at(7 * MIN))).rejects.toThrow(NonRetryableError);
    const claim = db.requests.find((r) => r.kind === "update");
    expect(claim?.columns).toBe("id");
    expect(claim?.payload).toEqual({ next_check_at: at(7 * MIN) });
  });
  it("two runs claiming the same row with the same seen value: exactly one wins (beforeExecute races)", async () => {
    useDb({ tables: { exec_drafts: [dbRow(1, { status: "saved", ...LINK, next_check_at: at(-MIN) })] } });
    let raced = false;
    db = createFakeDraftsDb({
      now: () => NOW,
      tables: { exec_drafts: [dbRow(1, { status: "saved", ...LINK, next_check_at: at(-MIN) })] },
      before: (r, d) => {
        if (r.kind === "update" && !raced) {
          raced = true;
          d.tables.exec_drafts[0].next_check_at = at(7 * MIN);
        }
      }
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    expect(await claimDueDraft(P, idOf(1), at(-MIN), at(8 * MIN))).toBe(false);
    expect(rows()[0].next_check_at).toBe(at(7 * MIN));
  });
  it("not installed: no due rows, none to claim, nothing earliest", async () => {
    useDb({ missing: ["exec_drafts"] });
    expect(await listDueDrafts(P, NOW, 20)).toEqual([]);
    expect(await hasDueDrafts(P, NOW)).toBe(false);
    expect(await earliestDueWithin(P, NOW, MIN)).toBeNull();
  });
});

describe("the parent look-ups (C63, C48)", () => {
  it("getLatestDraftForParent: the newest discarded or confirmed-gone draft on the parent; active rows and unconfirmed gone rows are not candidates", async () => {
    useDb({
      tables: {
        exec_drafts: [
          dbRow(1, { thread_id: "th_1", parent_message_id: "m_1", status: "discarded", terminal_at: at(-DAY), expires_at: at(DAY), created_at: at(-3 * DAY) }),
          dbRow(2, { thread_id: "th_1", parent_message_id: "m_1", status: "gone", ...LINK, gone_at: at(-DAY), gone_unconfirmed: false, terminal_at: at(-DAY), expires_at: at(DAY), created_at: at(-2 * DAY) }),
          dbRow(3, { thread_id: "th_1", parent_message_id: "m_1", status: "gone", ...LINK, gone_at: at(-MIN), gone_unconfirmed: true, terminal_at: at(-MIN), expires_at: at(DAY), created_at: at(-DAY) }),
          dbRow(4, { thread_id: "th_1", parent_message_id: "m_2", status: "discarded", terminal_at: at(-DAY), expires_at: at(DAY), created_at: at(0) }),
          dbRow(5, { thread_id: "th_1", parent_message_id: "m_1", status: "sent", ...SENT, created_at: at(0) })
        ]
      }
    });
    expect((await getLatestDraftForParent(P, "th_1", "m_1"))?.id).toBe(idOf(2));
    expect(await getLatestDraftForParent(P, "th_9", "m_1")).toBeNull();
    expect((await listDraftsForParent(P, "th_1", "m_1", idOf(3))).map((d) => [d.id, d.status])).toEqual([[idOf(1), "discarded"], [idOf(2), "gone"], [idOf(5), "sent"]]);
    useDb({ missing: ["exec_drafts"] });
    expect(await getLatestDraftForParent(P, "th_1", "m_1")).toBeNull();
    expect(await listDraftsForParent(P, "th_1", "m_1", idOf(3))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The purges (the SQL suite runs the same fixtures against the real RPCs: SQ19)
// ---------------------------------------------------------------------------

/** SQ10's fixture: one row per status on the restricted thread, plus a sibling thread and another principal. */
export function restrictedPurgeFixture(): Row[] {
  const on = (n: number, over: Row) => dbRow(n, { thread_id: "th_r", parent_message_id: "m_r", instruction: "x", body_html: "<p>x</p>", thread_addresses: ["a@client.com"], ...over });
  return [
    on(1, { status: "generating" }),
    on(2, { status: "generation_failed", generation_error: "declined" }),
    on(3, { status: "draft" }),
    on(4, { status: "generating", ...LINK, prior_status: "saved" }),
    on(5, { status: "saved", ...LINK, review_hash: HEX("c"), review_at: at(-MIN), review_blockers: ["opened_in_outlook"] }),
    on(6, { status: "sending", ...LINK, send_attempt_key: "k", send_started_at: at(-MIN), confirm_hash: HEX("c") }),
    on(7, { status: "unknown", ...LINK, send_attempt_key: "k", send_started_at: at(-MIN), confirm_hash: HEX("c") }),
    on(8, { status: "discarding", ...LINK, prior_status: "saved", discard_attempt_key: "k", discard_started_at: at(-MIN) }),
    on(9, { status: "saving", ...LINK, save_attempt_key: "k", save_version: 1, save_started_at: at(-MIN) }),
    dbRow(10, { thread_id: "th_other", status: "draft", instruction: "keep" }),
    dbRow(11, { thread_id: "th_r", status: "draft", principal_id: "ep_2", instruction: "keep" })
  ];
}

describe("purgeDraftsForThreads (SQ10's cases, on the fake's RPC mirror)", () => {
  it("DD-only rows close as discarded; a linked generating row returns to its prior; linked rows keep their status; a discarding row keeps its prior; content gone, version + 1; others untouched; a second call is 0", async () => {
    useDb({ tables: { exec_drafts: restrictedPurgeFixture(), exec_settings: [{ principal_id: "ep_1", retention_days_email: 60 }] } });
    expect(await purgeDraftsForThreads(P, ["th_r", "th_none"])).toBe(9);
    const byId = Object.fromEntries(rows().map((r) => [r.id, r]));
    expect([1, 2, 3].map((n) => byId[idOf(n)].status)).toEqual(["discarded", "discarded", "discarded"]);
    expect(byId[idOf(1)]).toMatchObject({ terminal_at: NOW.toISOString(), expires_at: at(60 * DAY), next_check_at: null });
    expect(byId[idOf(4)].status).toBe("saved");
    expect([5, 6, 7, 9].map((n) => byId[idOf(n)].status)).toEqual(["saved", "sending", "unknown", "saving"]);
    expect(byId[idOf(8)]).toMatchObject({ status: "discarding", prior_status: "saved" });
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const r = byId[idOf(n)];
      expect(r, `row ${n}`).toMatchObject({ restricted_purged: true, version: 2, instruction: null, body_html: null, thread_addresses: [], to_recipients: [], review_hash: null, review_at: null, review_blockers: [], content_purged_at: NOW.toISOString() });
      expect(checkDraftRow(r), `row ${n} CHECKs`).toEqual([]);
    }
    expect(byId[idOf(10)]).toMatchObject({ instruction: "keep", version: 1, restricted_purged: false });
    expect(byId[idOf(11)]).toMatchObject({ instruction: "keep", version: 1, restricted_purged: false });
    expect(await purgeDraftsForThreads(P, ["th_r"])).toBe(0);
    expect(await purgeDraftsForThreads(P, [])).toBe(0);
  });
  it("the RPC missing -> null; any other error throws (retryable); malformed ids are refused before any call", async () => {
    useDb({ missing: ["exec_drafts_purge_restricted"] });
    expect(await purgeDraftsForThreads(P, ["th_r"])).toBeNull();
    useDb({ fail: (r) => (r.kind === "rpc" ? { message: "lock timeout", code: "55P03" } : null) });
    await expect(purgeDraftsForThreads(P, ["th_r"])).rejects.toMatchObject({ errorClass: "retryable" });
    await expect(purgeDraftsForThreads(P, ["bad id!"])).rejects.toThrow(NonRetryableError);
    expect(db.requests).toHaveLength(1);
  });
});

/** SQ11's fixture around p_now = NOW: each step at its boundary (29 vs 31 days). */
export function expiredPurgeFixture(): Row[] {
  const terminal = (n: number, over: Row) => dbRow(n, { status: "discarded", instruction: "old", ...over });
  const purged = { instruction: null, thread_subject: null, to_recipients: [], body_text: null, thread_addresses: [] };
  return [
    terminal(1, { terminal_at: at(-31 * DAY), expires_at: at(100 * DAY) }),
    terminal(2, { terminal_at: at(-29 * DAY), expires_at: at(100 * DAY) }),
    terminal(3, { terminal_at: at(-200 * DAY), expires_at: at(-DAY), content_purged_at: at(-170 * DAY), ...purged }),
    terminal(4, { terminal_at: at(-200 * DAY), expires_at: at(DAY), content_purged_at: at(-170 * DAY), ...purged }),
    dbRow(5, { status: "draft", updated_at: at(-31 * DAY) }),
    dbRow(6, { status: "generation_failed", generation_error: "declined", updated_at: at(-31 * DAY) }),
    dbRow(7, { status: "draft", updated_at: at(-29 * DAY) }),
    dbRow(8, { status: "saved", ...LINK, updated_at: at(-31 * DAY), next_check_at: null }),
    dbRow(9, { status: "draft", ...LINK, saved_version: 1, version: 2, updated_at: at(-31 * DAY), next_check_at: null }),
    dbRow(10, { status: "unknown", ...LINK, send_attempt_key: "k", send_started_at: at(-32 * DAY), confirm_hash: HEX("c"), updated_at: at(-31 * DAY), next_check_at: null }),
    // Row 11's content was purged a month ago (step 1 bumps updated_at, so a freshly purged gone row can't be idle in the same pass).
    dbRow(11, { status: "gone", ...LINK, gone_at: at(-62 * DAY), gone_unconfirmed: true, terminal_at: at(-62 * DAY), expires_at: at(100 * DAY), updated_at: at(-31 * DAY), next_check_at: null,
      content_purged_at: at(-31 * DAY), thread_subject: null, to_recipients: [], body_text: null, thread_addresses: [] }),
    dbRow(12, { status: "gone", ...LINK, gone_at: at(-31 * DAY), gone_unconfirmed: false, terminal_at: at(-31 * DAY), expires_at: at(100 * DAY), updated_at: at(-31 * DAY), next_check_at: null }),
    dbRow(13, { status: "saved", ...LINK, updated_at: at(-31 * DAY), next_check_at: at(5 * MIN) }),
    dbRow(14, { status: "saved", ...LINK, updated_at: at(-29 * DAY), next_check_at: null }),
    dbRow(15, { status: "unknown", ...LINK, send_attempt_key: "k", send_started_at: at(-2 * DAY), confirm_hash: HEX("c"), expires_at: null, terminal_at: null, updated_at: at(-DAY), next_check_at: null })
  ];
}

describe("purgeExpiredDrafts (SQ11's cases, on the fake's RPC mirror)", () => {
  it("content at 30 days, rows at expiry (never a non-terminal one), idle DD-only rows closed, idle linked rows scheduled; the counts", async () => {
    useDb({ tables: { exec_drafts: expiredPurgeFixture(), exec_settings: [{ principal_id: "ep_1", retention_days_email: 60 }] } });
    const counts = await purgeExpiredDrafts(NOW);
    // Content: rows 1 and 12 ended more than 30 days ago (a gone row is terminal); row 2 at 29 days keeps its text; row 11 was purged earlier.
    expect(counts).toEqual({ contentPurged: 2, deleted: 1, closedIdle: 2, checksScheduled: 4 });
    const byId = Object.fromEntries(rows().map((r) => [r.id, r]));
    expect(byId[idOf(1)]).toMatchObject({ instruction: null, content_purged_at: NOW.toISOString() });
    expect(byId[idOf(12)]).toMatchObject({ body_text: null, content_purged_at: NOW.toISOString(), status: "gone" });
    expect(byId[idOf(11)]).toMatchObject({ content_purged_at: at(-31 * DAY), status: "gone" });
    expect(byId[idOf(2)]).toMatchObject({ instruction: "old", content_purged_at: null });
    expect(byId[idOf(3)]).toBeUndefined();
    expect(byId[idOf(4)]).toBeDefined();
    expect(byId[idOf(5)]).toMatchObject({ status: "discarded", last_error_code: "expired_idle", terminal_at: NOW.toISOString(), expires_at: at(60 * DAY), version: 2 });
    expect(byId[idOf(6)]).toMatchObject({ status: "discarded", last_error_code: "expired_idle" });
    expect(byId[idOf(7)]).toMatchObject({ status: "draft" });
    for (const n of [8, 9, 10, 11]) expect(byId[idOf(n)].next_check_at, `row ${n}`).toBe(NOW.toISOString());
    expect(byId[idOf(12)].next_check_at).toBeNull();
    expect(byId[idOf(13)].next_check_at).toBe(at(5 * MIN));
    expect(byId[idOf(14)].next_check_at).toBeNull();
    expect(byId[idOf(15)]).toMatchObject({ status: "unknown", next_check_at: null });
    // Row 1 (content purged) also counts toward step 1 only once: a second run finds nothing more.
    expect(await purgeExpiredDrafts(NOW)).toEqual({ contentPurged: 0, deleted: 0, closedIdle: 0, checksScheduled: 0 });
    for (const r of rows()) expect(checkDraftRow(r), String(r.id)).toEqual([]);
    const calls = db.requests.filter((r) => r.kind === "rpc");
    expect(calls[0].payload).toEqual({ p_now: NOW.toISOString(), p_limit: 1000 });
  });
  it("loops while a step returns a full batch (at most 10 rounds), sums the counts; not installed -> zeros; an error fails the step", async () => {
    let calls = 0;
    useDb({
      tables: { exec_drafts: [] },
      before: (r) => {
        if (r.kind === "rpc") calls += 1;
      }
    });
    // Replace the RPC answer through `fail`-free means: the fake's mirror answers from the table, so seed 1 001 expired rows.
    const many = Array.from({ length: 1001 }, (_, i) => dbRow(100 + i, { status: "discarded", instruction: "x", terminal_at: at(-31 * DAY), expires_at: at(100 * DAY) }));
    db.tables.exec_drafts = many;
    const counts = await purgeExpiredDrafts(NOW);
    expect(counts.contentPurged).toBe(1001);
    expect(calls).toBe(2);
    useDb({ missing: ["exec_drafts_purge_expired"] });
    expect(await purgeExpiredDrafts(NOW)).toEqual({ contentPurged: 0, deleted: 0, closedIdle: 0, checksScheduled: 0 });
    useDb({ fail: () => ({ message: "lock timeout" }) });
    await expect(purgeExpiredDrafts(NOW)).rejects.toThrow(/exec_drafts_purge_expired failed: lock timeout/);
  });
  it("the mirrors are plain functions over the fake's rows (SQ19 parity hooks)", () => {
    const tables = { exec_drafts: restrictedPurgeFixture() };
    expect(purgeRestrictedRows(tables, { p_principal: "ep_1", p_thread_ids: ["th_r"] }, NOW)).toBe(9);
    expect(purgeRestrictedRows(tables, { p_principal: "ep_1", p_thread_ids: [] }, NOW)).toBe(0);
    expect(() => purgeRestrictedRows(tables, { p_principal: null, p_thread_ids: ["th_r"] }, NOW)).toThrow(/p_principal is required/);
    const t2 = { exec_drafts: expiredPurgeFixture() };
    expect(purgeExpiredRows(t2, { p_now: NOW.toISOString(), p_limit: 1000 })).toEqual({ contentPurged: 2, deleted: 1, closedIdle: 2, checksScheduled: 4 });
    expect(() => purgeExpiredRows(t2, { p_now: null, p_limit: 1000 })).toThrow(/p_now is required/);
  });
});

// ---------------------------------------------------------------------------
// Artifacts and counts
// ---------------------------------------------------------------------------

describe("listDraftArtifacts (X2, C73)", () => {
  it("per thread: the active draft and the parents of drafts sent from DD in the last 7 days; selects only the seven columns; skips malformed rows and logs the count", async () => {
    useDb({
      tables: {
        exec_drafts: [
          dbRow(1, { thread_id: "th_1", status: "saved", ...LINK }),
          dbRow(2, { thread_id: "th_1", parent_message_id: "m_old", status: "sent", ...SENT }),
          dbRow(3, { thread_id: "th_2", parent_message_id: "m_x", status: "sent", ...SENT, sent_at: at(-8 * DAY), send_started_at: at(-8 * DAY), updated_at: at(-8 * DAY) }),
          dbRow(4, { thread_id: "th_3", parent_message_id: "m_y", status: "sent_external", ...SENT, send_attempt_key: null, send_started_at: null, confirm_hash: null, sent_at: null, updated_at: at(-DAY) }),
          dbRow(5, { thread_id: "th_4", status: "gone", ...LINK, gone_at: at(-MIN), gone_unconfirmed: true, terminal_at: at(-MIN), expires_at: at(DAY) }),
          dbRow(6, { thread_id: "th_5", status: "wrong" }),
          dbRow(7, { thread_id: "th_6", status: "sending", ...LINK, send_attempt_key: "k", send_started_at: at(-MIN), confirm_hash: HEX("c") }),
          dbRow(8, { thread_id: "th_1", status: "generating", principal_id: "ep_2" })
        ]
      }
    });
    const map = await listDraftArtifacts(P, ["th_1", "th_2", "th_3", "th_4", "th_5", "th_6", "th_none"], NOW);
    expect(map.get("th_1")).toEqual({ execDraft: { id: idOf(1), status: "saved" }, execSentParents: ["m_old"] });
    expect(map.get("th_2")).toEqual({ execDraft: null, execSentParents: [] });
    expect(map.get("th_3")).toEqual({ execDraft: null, execSentParents: ["m_y"] });
    expect(map.get("th_4")).toEqual({ execDraft: null, execSentParents: [] });
    expect(map.has("th_5")).toBe(false);
    expect(map.get("th_6")).toEqual({ execDraft: { id: idOf(7), status: "sending" }, execSentParents: ["m_7"] });
    expect(map.has("th_none")).toBe(false);
    expect(db.requests[0].columns).toBe("id,status,thread_id,parent_message_id,send_started_at,sent_at,updated_at");
    expect(console.warn).toHaveBeenCalledWith("[exec-drafts] artifacts: skipped 1 malformed rows for ep_1");
    const all = await listDraftArtifacts(P, "all", NOW);
    expect([...all.keys()].sort()).toEqual(["th_1", "th_2", "th_3", "th_4", "th_6"]);
  });
  it("not installed -> an empty map; another error throws (the caller fails open)", async () => {
    useDb({ missing: ["exec_drafts"] });
    expect((await listDraftArtifacts(P, ["th_1"], NOW)).size).toBe(0);
    useDb({ fail: () => ({ message: "down", code: "57014" }) });
    await expect(listDraftArtifacts(P, ["th_1"], NOW)).rejects.toThrow(/artifacts read failed: down/);
  });
});

describe("the card and System counts", () => {
  const fixture = () => [
    dbRow(1, { status: "draft" }),
    dbRow(2, { status: "unknown", ...LINK, send_attempt_key: "k", send_started_at: at(-40 * MIN), confirm_hash: HEX("c"), next_check_at: at(-2 * MIN) }),
    dbRow(3, { status: "generation_failed", generation_error: "declined", updated_at: at(-2 * DAY) }),
    dbRow(4, { status: "generation_failed", generation_error: "declined", updated_at: at(-MIN) }),
    dbRow(5, { status: "sent", ...SENT, sent_mismatch: true }),
    dbRow(6, { status: "sent", ...SENT, sent_mismatch: true, terminal_at: at(-8 * DAY), expires_at: at(100 * DAY) }),
    dbRow(7, { status: "gone", ...LINK, gone_at: at(-MIN), gone_unconfirmed: true, terminal_at: at(-MIN), expires_at: at(DAY), next_check_at: at(-MIN) }),
    dbRow(8, { status: "saved", ...LINK, restricted_purged: true, content_purged_at: at(-MIN), to_recipients: [], thread_subject: null, body_text: null, next_check_at: at(5 * MIN) }),
    dbRow(9, { status: "saved", ...LINK, observed_content_hash: HEX("e") }),
    dbRow(10, { status: "draft", principal_id: "ep_2" })
  ];
  it("countDraftsForCard: active rows and the attention rows of the bucket", async () => {
    useDb({ tables: { exec_drafts: fixture() } });
    // Attention: unknown (2), two failed generations (3, 4), the mismatch within 7 days (5), gone unconfirmed (7), restricted linked (8), changed in Outlook (9).
    expect(await countDraftsForCard(P)).toEqual({ active: 7, attention: 7 });
    useDb({ missing: ["exec_drafts"] });
    expect(await countDraftsForCard(P)).toBeNull();
  });
  it("countDraftsForSystem: every counter and the oldest due check", async () => {
    useDb({ tables: { exec_drafts: fixture() } });
    expect(await countDraftsForSystem(P, NOW)).toEqual({ active: 7, unknown: 1, sentMismatch7d: 1, goneUnconfirmed: 1, generationFailed24h: 1, restrictedLinked: 1, oldestDueAt: at(-2 * MIN) });
    useDb({ missing: ["exec_drafts"] });
    expect(await countDraftsForSystem(P, NOW)).toBeNull();
  });
});

describe("listSentInternetMessageIds / countRecentAudit", () => {
  it("sent ids, lowercased and bracket-less, from the window; the audit count's query shape", async () => {
    useDb({
      tables: {
        exec_drafts: [
          dbRow(1, { status: "sent", ...SENT, internet_message_id: "<ABC@x.com>" }),
          dbRow(2, { status: "sent_external", ...SENT, send_attempt_key: null, send_started_at: null, confirm_hash: null, internet_message_id: "def@x.com" }),
          dbRow(3, { status: "sent", ...SENT, internet_message_id: null }),
          dbRow(4, { status: "saved", ...LINK, internet_message_id: "<saved@x.com>" }),
          dbRow(5, { status: "sent", ...SENT, internet_message_id: "<old@x.com>", updated_at: at(-100 * DAY) })
        ],
        exec_audit_log: [
          { id: 1, principal_id: "ep_1", action: "draft.send", created_at: at(-MIN) },
          { id: 2, principal_id: "ep_1", action: "draft.send", created_at: at(-20 * MIN) },
          { id: 3, principal_id: "ep_1", action: "draft.save", created_at: at(-MIN) },
          { id: 4, principal_id: "ep_2", action: "draft.send", created_at: at(-MIN) }
        ]
      }
    });
    expect([...(await listSentInternetMessageIds(P, at(-90 * DAY)))].sort()).toEqual(["abc@x.com", "def@x.com"]);
    expect(await countRecentAudit(P, "draft.send", at(-10 * MIN))).toBe(1);
    const q = db.requests.at(-1);
    expect(q).toMatchObject({ target: "exec_audit_log", columns: "id", count: "exact", head: true });
    await expect(countRecentAudit(P, "", at(-MIN))).rejects.toThrow(NonRetryableError);
    useDb({ fail: () => ({ message: "down" }) });
    await expect(countRecentAudit(P, "draft.send", at(-MIN))).rejects.toThrow(/exec_audit_log count failed: down/);
  });
});

describe("exec_voice_profile", () => {
  const profile = {
    status: "ready" as const, formality: "casual" as const, typicalLength: "short" as const, greeting: "hi_first_name" as const, paragraphing: "short_paragraphs" as const,
    bullets: "sometimes" as const, emoji: "never" as const, signOff: "Thanks", sampleCount: 20, samplesHash: HEX("a"), windowDays: 90, model: "claude-haiku-5-5",
    promptVersion: "voice-v1", builtAt: at(-DAY), lastAttemptAt: at(-DAY), lastAttemptError: null
  };
  it("upsert then get round-trips; a second upsert replaces; not installed -> null; a malformed row throws", async () => {
    useDb({ tables: { exec_voice_profile: [] } });
    await upsertVoiceProfile(P, profile);
    const got = await getVoiceProfile(P);
    expect(got).toMatchObject({ principalId: "ep_1", ...profile });
    expect(typeof got?.updatedAt).toBe("string");
    await upsertVoiceProfile(P, { ...profile, status: "insufficient", sampleCount: 3, formality: null, typicalLength: null, greeting: null, paragraphing: null, bullets: null, emoji: null, signOff: null, samplesHash: null, lastAttemptError: "read_failed" });
    expect(db.tables.exec_voice_profile).toHaveLength(1);
    expect(await getVoiceProfile(P)).toMatchObject({ status: "insufficient", sampleCount: 3, lastAttemptError: "read_failed" });
    expect(await getVoiceProfile(OTHER)).toBeNull();
    db.tables.exec_voice_profile[0].bullets = "always";
    await expect(getVoiceProfile(P)).rejects.toThrow(/column bullets is malformed/);
    useDb({ missing: ["exec_voice_profile"] });
    expect(await getVoiceProfile(P)).toBeNull();
    await expect(upsertVoiceProfile(P, profile)).rejects.toBeInstanceOf(DraftStoreError);
  });
});

// A compile-time check that NewDraftRow is the row minus the database-set columns.
const _shape: NewDraftRow = {} as Omit<ExecDraftRow, "id" | "createdAt" | "updatedAt">;
void _shape;
const _status: ExecDraftStatus = "draft";
void _status;
