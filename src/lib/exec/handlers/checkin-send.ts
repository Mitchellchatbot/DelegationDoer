import "server-only";

import { createHash } from "node:crypto";

import { auditFinish, auditStart } from "@/lib/exec/audit";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { checkinsMessageParts } from "@/lib/exec/brief-deliver";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import type { CheckinMessageView } from "@/lib/exec/brief-slack-ui";
import { checkinStep, getBriefById, getCheckin } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import type { BriefRow, CheckinActionPayload, CheckinRow, CheckinStatus, OwnerTokenVerdict, TokenHealthState } from "@/lib/exec/brief-types";
import { postCheckinAsOwner, verifyOwnerUserToken } from "@/lib/exec/checkin-post";
import { parseCheckinValue, SecretUnavailableError, verifyCheckinMac } from "@/lib/exec/crypto";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { dmUpdate, errLabel } from "@/lib/exec/slack-dm";
import { openInstallationById } from "@/lib/exec/slack-install";
import { SLACK_RE, type OpenInstallation } from "@/lib/exec/slack-types";
import { listUsers } from "@/lib/exec/sources/dd";
import { failedOnPost, lookupUserByEmail, SlackApiError } from "@/lib/exec/sources/slack";
import { putSyncState } from "@/lib/exec/sync-state";
import { AuditUnavailableError, NonRetryableError, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.checkin-send (P8 contract §3.13.7, M6, C6, C7, C50; intel-17; Area D): one Send click, enqueued by P8's RPC 2 v2
// (key checkin-send:<trigger_id>: one job per click). Verifies the MAC recomputed from the STORED row, the recipient, his
// DD token (auth.test binding), audits first, CASes proposed → sending, posts once as Mitchell through checkin-post.ts
// (B-P8-2), never re-posts. Interactive lane, maxAttempts 1, 30 s. Codes only in its result and its logs.
//
// Shared with exec.checkin-rewrite (steps 1-3 and 5-8): checkActionPayload, loadClick, gateClick, renderer.

export const CHECKIN_SEND_JOB_KIND = BRIEF_JOB_KINDS.checkinSend;

const CHECKIN_ID = /^ebc_[0-9a-f]{32}$/;
const CODE = /^[a-z0-9_]{1,60}$/;
/** Slack codes after which the post may have landed (AM-P8-14); anything else Slack answered proves nothing was posted. */
const AMBIGUOUS_CODES: ReadonlySet<string> = new Set([
  "timeout", "network", "bad_response", "internal_error", "fatal_error", "service_unavailable", "request_timeout"
]);
const HTTP_5XX = /^http_5[0-9][0-9]$/;

export type CheckinResult = { skipped: string } | { status: CheckinStatus; reason: string | null };

/** Step 1's shape check (references only, §0.3 rule 5); null when malformed. */
export function checkActionPayload(raw: unknown): CheckinActionPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.checkin_id !== "string" || !CHECKIN_ID.test(p.checkin_id)) return null;
  if (typeof p.rev !== "number" || !Number.isSafeInteger(p.rev) || p.rev < 0 || p.rev > 9999) return null;
  if (typeof p.value !== "string" || p.value.length > 200) return null;
  if (typeof p.channel_id !== "string" || !SLACK_RE.dm.test(p.channel_id)) return null;
  if (typeof p.message_ts !== "string" || !SLACK_RE.ts.test(p.message_ts)) return null;
  return { installation_id: p.installation_id, checkin_id: p.checkin_id, rev: p.rev, value: p.value, channel_id: p.channel_id, message_ts: p.message_ts };
}

export interface Click {
  payload: CheckinActionPayload; mac: string; inst: OpenInstallation; row: CheckinRow; brief: BriefRow & { checkinsTs: string };
  render: (paused?: CheckinMessageView["paused"], override?: { id: string; status: CheckinStatus }) => Promise<void>;
}

/** Steps 1-3: the payload, the value (it must name this check-in and rev), the installation and its DM, the row, the message. */
export async function loadClick(principal: ExecPrincipal, raw: unknown, now: Date, signal: AbortSignal): Promise<Click | { skipped: string }> {
  const payload = checkActionPayload(raw);
  if (payload === null) throw new NonRetryableError("bad_payload");
  const parsed = parseCheckinValue(payload.value);
  if (parsed === null || parsed.checkinId !== payload.checkin_id || parsed.rev !== payload.rev) return { skipped: "bad_value" };
  let inst: OpenInstallation | null;
  try {
    inst = await openInstallationById(principal, payload.installation_id, { signal });
  } catch (err) {
    if (err instanceof SecretUnavailableError) return { skipped: "token_unavailable" };
    throw err;
  }
  if (inst === null || payload.channel_id !== inst.row.dmChannelId) return { skipped: "installation" };
  const row = await getCheckin(principal, payload.checkin_id, { signal });
  if (row === null) return { skipped: "not_found" };
  const brief = await getBriefById(principal, row.briefId, { signal });
  if (brief === null || brief.checkinsTs === null || payload.message_ts !== brief.checkinsTs) return { skipped: "other_message" };
  const open = inst;
  const checkinsTs = brief.checkinsTs;
  /** Re-render the check-ins message (best-effort, its own signal): every early exit shows the row's real state. */
  const render = async (paused: CheckinMessageView["paused"] = null, override?: { id: string; status: CheckinStatus }): Promise<void> => {
    try {
      const parts = await checkinsMessageParts(principal, brief.id, { tz: brief.tz, now, paused, override });
      if (parts !== null) await dmUpdate(open, checkinsTs, parts, { signal: AbortSignal.timeout(BRIEF_LIMITS.slackCallMs) });
    } catch (err) {
      console.warn(`[exec-brief] check-ins message not re-rendered (brief ${brief.id}): ${errLabel(err)}`);
    }
  };
  return { payload, mac: parsed.mac, inst, row, brief: { ...brief, checkinsTs }, render };
}

/** Steps 5-8 (shared with the rewrite): proposed, this rev, the MAC from the stored row, unexpired, check-ins on and owned.
 *  null = go on; otherwise the result (the message was re-rendered). */
export async function gateClick(principal: ExecPrincipal, click: Click, now: Date, signal: AbortSignal): Promise<CheckinResult | null> {
  const { row, payload } = click;
  // 5.
  if (row.status !== "proposed") {
    await click.render();
    return { status: row.status, reason: "not_proposed" };
  }
  if (row.rev !== payload.rev) {
    await click.render();
    return { status: row.status, reason: "stale" };
  }
  // 6. The MAC is recomputed from the stored row, never from the button (C6).
  let macOk: boolean;
  try {
    macOk = verifyCheckinMac({ checkinId: row.id, rev: row.rev, recipientUserId: row.recipientUserId, recipientSlackId: row.recipientSlackId, text: row.text }, click.mac);
  } catch (err) {
    if (!(err instanceof SecretUnavailableError)) throw err;
    await click.render("busy");
    return { status: row.status, reason: "key_unavailable" };
  }
  if (!macOk) {
    console.warn(`[exec-brief] checkin ${row.id} mac_mismatch`);
    await click.render();
    return { status: row.status, reason: "mac_mismatch" };
  }
  // 7.
  if (now.getTime() >= Date.parse(row.expiresAt)) {
    const moved = await checkinStep(principal, row.id, { from: ["proposed"], rev: row.rev, to: "expired", reason: "expired" });
    await click.render();
    return { status: moved ? "expired" : row.status, reason: "expired" };
  }
  // 8.
  const settings = await loadSettings(principal.id);
  if (!settings.checkinsEnabled) {
    await click.render("disabled");
    return { status: row.status, reason: "disabled" };
  }
  const own = await loadBriefOwnership(principal, settings, row.localDate, now, { signal });
  if (own.verdict.owner !== "exec") {
    await click.render("notOwned");
    return { status: row.status, reason: "not_owned" };
  }
  return null;
}

/** M6 step 9: the recipient is still that DD user, with that Slack account, active, internal and on the installation's team. */
async function recipientStillValid(principal: ExecPrincipal, click: Click, signal: AbortSignal): Promise<"ok" | "changed" | "unknown"> {
  const { row, inst } = click;
  try {
    const user = (await listUsers(principal, { signal })).find((u) => u.id === row.recipientUserId);
    const email = typeof user?.email === "string" ? user.email.trim() : "";
    if (!user || email.length === 0) return "changed";
    const found = await lookupUserByEmail(inst.target.token, email, { signal: AbortSignal.timeout(BRIEF_LIMITS.slackCallMs) });
    const ok = found !== null && found.id === row.recipientSlackId && !found.deleted && !found.isBot && found.isRestricted !== true &&
      found.isUltraRestricted !== true && found.teamId === inst.row.teamId;
    return ok ? "ok" : "changed";
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn(`[exec-brief] checkin ${row.id} recipient check failed: ${errLabel(err)}`);
    return "unknown";
  }
}

const tokenReason = (v: OwnerTokenVerdict): string => (v.state === "missing" ? "token_missing" : `token_${v.state}`);
const pausedFor = (v: OwnerTokenVerdict): CheckinMessageView["paused"] =>
  v.state === "mismatch" ? "token" : v.state === "missing" ? "missing" : null;

/** What a failed post proves: nothing posted (a clear Slack answer, or a failure before the post call) or maybe posted. */
function postFailure(err: unknown): { kind: "clear" | "ambiguous"; code: string } {
  if (err instanceof SlackApiError) {
    const code = CODE.test(err.code) ? err.code : "slack_error";
    if (!failedOnPost(err)) return { kind: "clear", code };
    return AMBIGUOUS_CODES.has(err.code) || HTTP_5XX.test(err.code) ? { kind: "ambiguous", code } : { kind: "clear", code };
  }
  if (err instanceof Error && err.name === "SlackChannelRefusedError") return { kind: "clear", code: "channel_refused" };
  return { kind: "ambiguous", code: err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "unknown" };
}

async function runSend(ctx: JobContext): Promise<CheckinResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const signal = ctx.signal;
  const now = new Date();
  // 1.-3.
  const loaded = await loadClick(principal, ctx.job.payload, now, signal);
  if ("skipped" in loaded) return loaded;
  const click = loaded;
  const { row, inst } = click;
  // 4. intel-17: jobs are one per click, so a sending row can be another click's send in flight. Never re-posted either way.
  if (row.status === "sending") {
    const sendingMs = row.sendingAt !== null ? Date.parse(row.sendingAt) : NaN;
    if (!Number.isFinite(sendingMs) || sendingMs < now.getTime() - BRIEF_LIMITS.checkinSendingStaleMs) {
      const moved = await checkinStep(principal, row.id, { from: ["sending"], rev: row.rev, to: "unknown", reason: "found_sending" });
      await click.render();
      return { status: moved ? "unknown" : row.status, reason: "found_sending" };
    }
    await click.render();
    return { status: "sending", reason: "in_flight" };
  }
  // 5.-8.
  const gated = await gateClick(principal, click, now, signal);
  if (gated !== null) return gated;
  // 9.
  const recipient = await recipientStillValid(principal, click, signal);
  if (recipient === "unknown") {
    await click.render("busy");
    return { status: row.status, reason: "recipient_unchecked" };
  }
  if (recipient === "changed") {
    const moved = await checkinStep(principal, row.id, { from: ["proposed"], rev: row.rev, to: "failed", reason: "recipient_changed" });
    await click.render();
    return { status: moved ? "failed" : row.status, reason: "recipient_changed" };
  }
  // 10. auth.test binding of his DD token (M6, C19).
  const verdict = await verifyOwnerUserToken(principal, inst.row, now, { signal });
  if (verdict.state !== "ok") {
    const reason = tokenReason(verdict);
    const moved = await checkinStep(principal, row.id, { from: ["proposed"], rev: row.rev, to: "failed", reason });
    if (verdict.state === "mismatch") {
      await notifyOps({ key: BRIEF_OPS.tokenMismatch.key(principal.id), title: BRIEF_OPS.tokenMismatch.title, detail: `checkin ${row.id}: ${reason}` });
    }
    await click.render(pausedFor(verdict));
    return { status: moved ? "failed" : row.status, reason };
  }
  // 11. Audit first, fail closed: no audit row, nothing sent (and the row stays proposed: a later click can send it).
  let auditId: number;
  try {
    auditId = await auditStart(principal, {
      actor: "slack",
      action: "brief.checkin.send",
      target: `exec_brief_checkins:${row.id}`,
      input: {
        checkinId: row.id, rev: row.rev, recipientUserId: row.recipientUserId, recipientSlackId: row.recipientSlackId,
        textSha256: createHash("sha256").update(row.text, "utf8").digest("hex").slice(0, 16)
      }
    });
  } catch (err) {
    if (!(err instanceof AuditUnavailableError)) throw err;
    await click.render("busy");
    return { status: row.status, reason: "audit_unavailable" };
  }
  // 12. The plain-row CAS: one post per row and rev, ever.
  const claimed = await checkinStep(principal, row.id, { from: ["proposed"], rev: row.rev, to: "sending", sendingAt: now.toISOString(), auditId });
  if (!claimed) {
    await auditFinish(auditId, { ok: false, error: "lost_race" });
    await click.render();
    return { status: row.status, reason: "lost_race" };
  }
  // 13.
  await click.render(null, { id: row.id, status: "sending" });
  // 14. Never retried.
  let status: CheckinStatus;
  let reason: string | null;
  try {
    const r = await postCheckinAsOwner(principal, inst.row, row.recipientSlackId, row.text, { signal: AbortSignal.timeout(BRIEF_LIMITS.checkinPostMs) });
    if ("refused" in r) {
      reason = tokenReason(r.refused);
      status = (await checkinStep(principal, row.id, { from: ["sending"], rev: row.rev, to: "failed", reason })) ? "failed" : "sending";
      await auditFinish(auditId, { ok: false, error: reason });
      if (r.refused.state === "mismatch") {
        await notifyOps({ key: BRIEF_OPS.tokenMismatch.key(principal.id), title: BRIEF_OPS.tokenMismatch.title, detail: `checkin ${row.id}: ${reason}` });
      }
      await click.render(pausedFor(r.refused));
      return { status, reason };
    }
    const sentAt = new Date().toISOString();
    const moved = await checkinStep(principal, row.id, { from: ["sending"], rev: row.rev, to: "sent", sentAt, channel: r.channel, ts: r.ts });
    status = moved ? "sent" : "sending";
    reason = moved ? null : "not_recorded";
    await auditFinish(auditId, { ok: true, result: { ts: r.ts } });
    try {
      const health: TokenHealthState = { state: "ok", checkedAt: sentAt };
      await putSyncState(principal, "brief", "token-health", health);
    } catch (err) {
      console.warn(`[exec-brief] token health not stored (principal ${principal.id}): ${errLabel(err)}`);
    }
  } catch (err) {
    const f = postFailure(err);
    if (f.kind === "clear") {
      reason = f.code;
      status = (await checkinStep(principal, row.id, { from: ["sending"], rev: row.rev, to: "failed", reason })) ? "failed" : "sending";
      await auditFinish(auditId, { ok: false, error: f.code });
    } else {
      reason = f.code;
      status = (await checkinStep(principal, row.id, { from: ["sending"], rev: row.rev, to: "unknown", reason })) ? "unknown" : "sending";
      await auditFinish(auditId, { ok: false, error: "unknown" });
    }
  }
  // 15.
  await click.render();
  return { status, reason };
}

export const checkinSendJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: CHECKIN_SEND_JOB_KIND,
  lane: "interactive",
  timeoutMs: BRIEF_LIMITS.checkinSendTimeoutMs,
  run: (ctx) => runSend(ctx)
});
