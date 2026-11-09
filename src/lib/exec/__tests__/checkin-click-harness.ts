import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";

import { BOT_TOKEN, BRIEF_ID, briefRowSeed, checkinSeed, ctxFor, DM, MITCH_SLACK, openInstallation, ownership, PRINCIPAL, settings, TEAM, USER_TOKEN } from "./brief-d-harness";
import { createFakeBriefDb, type FakeBriefDb } from "./fake-brief-db";
import { fakeSlackWorkspace, installFakeSlack, type FakeSlackWorkspace } from "./fake-slack-api";
import type { Row } from "./fake-slack-db";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { checkinButtonValue } from "@/lib/exec/crypto";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { openInstallationById, recordSlackError, enqueueRevokeCheck, clearSlackError } from "@/lib/exec/slack-install";
import { listDepartments, listUsers } from "@/lib/exec/sources/dd";
import { putSyncState } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 Area D test support for the check-in click handlers (exec.checkin-send / exec.checkin-rewrite): a delivered brief with a
// check-ins message in his assistant DM, its check-in rows, his users row (with his DD Slack token), the stateful fake Slack
// (the exec bot, his user token, the recipients), and the button value each click carries (computed from the STORED row, C6).
// The test files vi.mock these modules: supabase-admin, ops, audit, principal (loadSettings), brief-ownership-load,
// slack-install (openInstallationById + P6's health writers), sources/dd (listUsers, listDepartments), sync-state (putSyncState).

export const CHECKINS_TS = "1794000002.000100";

export interface ClickWorld { db: FakeBriefDb; ws: FakeSlackWorkspace; slack: ReturnType<typeof installFakeSlack>; auditIds: number }

export function setupClickWorld(checkins: Row[] = [checkinSeed(1), checkinSeed(2)], briefOver: Row = {}): ClickWorld {
  vi.stubEnv("EXEC_TOKEN_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://operations.scaledai.org");
  const db = createFakeBriefDb({
    tables: {
      exec_briefs: [briefRowSeed("delivered", { checkins_ts: CHECKINS_TS, ...briefOver })],
      exec_brief_checkins: checkins,
      users: [{ id: PRINCIPAL.userId, email: PRINCIPAL.email, name: "Mitchell Owner", slack_user_token: USER_TOKEN }]
    }
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  const ws = fakeSlackWorkspace({
    tokens: { [BOT_TOKEN]: { userId: "U0BOT", teamId: TEAM, botId: "B0BOT" }, [USER_TOKEN]: { userId: MITCH_SLACK, teamId: TEAM } },
    users: Object.fromEntries([1, 2, 3].map((n) => [`p${n}@scaledai.org`, { id: `U0P${n}` }]))
  });
  ws.messages.push({ channel: DM, ts: CHECKINS_TS, token: BOT_TOKEN, text: "x", blocks: [], metadata: null, deleted: false, updates: 0 });
  const slack = installFakeSlack(ws.handlers);
  const world: ClickWorld = { db, ws, slack, auditIds: 0 };
  for (const m of [notifyOps, auditStart, auditFinish, auditEvent, loadSettings, loadBriefOwnership, openInstallationById, recordSlackError, enqueueRevokeCheck,
    clearSlackError, listUsers, listDepartments, putSyncState]) vi.mocked(m as (...a: unknown[]) => unknown).mockReset();
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(auditStart).mockImplementation(async () => ++world.auditIds);
  vi.mocked(auditFinish).mockResolvedValue(undefined);
  vi.mocked(auditEvent).mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(loadBriefOwnership).mockResolvedValue(ownership());
  vi.mocked(openInstallationById).mockResolvedValue(openInstallation());
  vi.mocked(recordSlackError).mockResolvedValue(undefined);
  vi.mocked(enqueueRevokeCheck).mockResolvedValue(undefined);
  vi.mocked(clearSlackError).mockResolvedValue(undefined);
  vi.mocked(listUsers).mockResolvedValue([1, 2, 3].map((n) => ({ id: `u_${n}`, name: `Person${n} Last`, email: `p${n}@scaledai.org`, role: "worker" as const,
    isAdmin: false, workTimezone: null, managerUserId: null, departmentIds: ["d_ops"] })));
  vi.mocked(listDepartments).mockResolvedValue([{ id: "d_ops", name: "Operations", headUserId: null }]);
  vi.mocked(putSyncState).mockResolvedValue(undefined);
  return world;
}

/** The button value as rendered from the stored row now (C6). */
export function valueOf(db: FakeBriefDb, id: string): string {
  const r = db.tables.exec_brief_checkins.find((x) => x.id === id) as Row;
  return checkinButtonValue({ checkinId: String(r.id), rev: Number(r.rev), recipientUserId: String(r.recipient_user_id),
    recipientSlackId: String(r.recipient_slack_id), text: String(r.text) });
}

export function clickPayload(id: string, value: string, over: Row = {}): Row {
  const rev = Number(value.split(".")[2]);
  return { installation_id: openInstallation().row.id, checkin_id: id, rev, value, channel_id: DM, message_ts: CHECKINS_TS, ...over };
}

export const clickCtx = (kind: string, payload: Row) => ctxFor(kind, payload);
export const checkinRow = (db: FakeBriefDb, id: string): Row => db.tables.exec_brief_checkins.find((x) => x.id === id) as Row;
export const theBrief = (db: FakeBriefDb): Row => db.tables.exec_briefs.find((x) => x.id === BRIEF_ID) as Row;
/** Posts made as Mitchell (his user token). */
export const postsAsHim = (ws: FakeSlackWorkspace) => ws.messages.filter((m) => m.token === USER_TOKEN);
/** The check-ins message as it stands in his assistant DM. */
export const checkinsMessage = (ws: FakeSlackWorkspace) => ws.messages.find((m) => m.channel === DM && m.ts === CHECKINS_TS);
export const messageText = (ws: FakeSlackWorkspace): string => JSON.stringify(checkinsMessage(ws)?.blocks ?? []);
export const sendButtons = (ws: FakeSlackWorkspace): string[] =>
  ((checkinsMessage(ws)?.blocks ?? []) as { type: string; elements?: { action_id: string; value: string }[] }[])
    .filter((b) => b.type === "actions").flatMap((b) => (b.elements ?? []).filter((e) => e.action_id === "ea_ci_send").map((e) => e.value));
