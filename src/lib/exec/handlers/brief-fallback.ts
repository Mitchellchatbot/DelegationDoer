import "server-only";

import { listScreenedAttention } from "@/lib/exec/attention-read";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { resolveStaleRows } from "@/lib/exec/brief-deliver";
import { briefExpiries, mayDmAt } from "@/lib/exec/brief-ownership";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { briefPrettyDate, renderFallbackMiniBrief, type FallbackMiniBrief } from "@/lib/exec/brief-slack-ui";
import { briefSchemaReady, claimFallback, deliveryStep, getBriefById, recordFallbackResult } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS, briefDeliverKey } from "@/lib/exec/brief-types";
import type { BriefFallbackPayload, BriefStateNote, BriefStatus } from "@/lib/exec/brief-types";
import { postDdBotDm } from "@/lib/exec/dd-bot";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { appOrigin, isAllowedLinkUrl } from "@/lib/exec/refs";
import { getLatestInstallation } from "@/lib/exec/slack-install";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";
import { getPendingApprovals } from "@/lib/exec/sources/dd";
import { pinnedAccounts } from "@/lib/exec/sources/mail";
import { SlackApiError } from "@/lib/exec/sources/slack";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.brief-fallback (P8 contract §3.13.3, M7, C3, C32-C34, C49; intel-10, intel-11, intel-18; Area D): the watchdog. When
// the brief hasn't landed 45 minutes after its time (and only while mayDmAt holds), the DD bot DMs a deterministic
// mini-brief (counts, the top 5 DD-sourced titles, email and Slack as counts only; no model call) through dd-bot.ts
// postDdBotDm (B-P8-3: imported only here). Interactive lane, maxAttempts 1, 60 s; enqueued as the scheduler companion of
// exec.brief (key exec.brief-fallback:<p>:<localDate>). Never posts while the brief is delivered, delivering or
// delivery_unknown (C32), never after the catch-up cutoff or the end of the brief's local date (intel-10), and never twice
// (RPC 4's CAS). Results and logs carry ids and codes only.

export const BRIEF_FALLBACK_JOB_KIND = BRIEF_JOB_KINDS.fallback;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[a-z0-9_]{1,60}$/;
const DAY_MS = 86_400_000;
const DD_TITLES = 5;

type FallbackResult =
  | { skipped: string }
  | { outcome: "posted" | "failed"; briefId: string; status: BriefStatus | null; code: string | null; movedToPageOnly: boolean };

function parsePayload(raw: unknown): BriefFallbackPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.local_date !== "string" || !LOCAL_DATE.test(p.local_date)) return null;
  if (typeof p.scheduled_at !== "string" || !Number.isFinite(Date.parse(p.scheduled_at))) return null;
  return { local_date: p.local_date, scheduled_at: p.scheduled_at };
}

/** An error as a stored code (fallback_error_code's shape): NonRetryableError's code message, Slack's code, else its class. */
function errorCodeOf(err: unknown): string {
  if (err instanceof NonRetryableError && CODE.test(err.message)) return err.message;
  if (err instanceof SlackApiError && CODE.test(err.code)) return err.code;
  if (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return "error";
}

/** The first DD ref with an allow-listed URL, or null. */
function ddHref(refs: readonly { system: string; url: string | null }[] | undefined): string | null {
  for (const r of Array.isArray(refs) ? refs : []) {
    if (r?.system === "dd" && typeof r.url === "string" && isAllowedLinkUrl(r.url)) return r.url;
  }
  return null;
}

/** P8 fixer ui-1: P7b's Slack state as the mini-brief's state line (null: Slack is read, so a count is honest). */
const SLACK_STATE_NOTE: Readonly<Record<Exclude<SlackIntelState, "ok">, BriefStateNote>> = Object.freeze({
  not_installed: "slack_not_installed", not_connected: "slack_not_connected", reading_revoked: "slack_reading_revoked",
  reading_off: "slack_reading_off", discovering: "slack_discovering"
});

/** P3's email gate (email-view.ts loadEmailGate), from the settings already read: off / no mailbox → its state line, else null. */
function emailStateNote(principal: ExecPrincipal, settings: ExecSettings): BriefStateNote | null {
  if (settings.emailSchemaReady !== true || settings.emailEnabled !== true) return "email_off";
  return pinnedAccounts(principal).length === 0 ? "email_no_pin" : null;
}

/** §3.16 layout 4 inputs: deterministic reads only (no model call). Each failed read → its line says fallbackUnavailable. Email and
 *  Slack are counts only; the titles are DD-sourced items' (M7). Slack items come from the "slack" surface (no finance, N1).
 *  P8 fixer ui-1 (M4: never "nothing"): email or Slack off / not set up → the full brief's state line instead of "0 items"; a
 *  screen that couldn't run → "Couldn't load this." (and no restricted-sender count, since those emails weren't screened). */
async function buildFallbackMiniBrief(principal: ExecPrincipal, settings: ExecSettings, localDate: string, now: Date, signal: AbortSignal):
  Promise<FallbackMiniBrief> {
  const mini: FallbackMiniBrief = {
    prettyDate: briefPrettyDate(localDate), bands: null, ddTitles: [], email: null, slack: null, approvals: null, restrictedEmail: null,
    execHref: `${appOrigin()}/executive`, emailNote: emailStateNote(principal, settings), slackNote: null
  };
  const [attention, approvals, slackState] = await Promise.allSettled([
    listScreenedAttention(principal, { status: "default", limit: BRIEF_LIMITS.attentionPageSize }, { now, signal, surface: "slack" }),
    getPendingApprovals(principal, now, { signal }),
    slackIntelState(principal, settings, { signal })
  ]);
  const slackIntel: SlackIntelState | null = slackState.status === "fulfilled" ? slackState.value : null;
  if (slackIntel !== null && slackIntel !== "ok") mini.slackNote = SLACK_STATE_NOTE[slackIntel] ?? "slack_unavailable";
  if (attention.status === "fulfilled") {
    const items = Array.isArray(attention.value.items) ? attention.value.items : [];
    const bands = { critical: 0, high: 0, normal: 0 };
    for (const item of items) {
      const band = item.priority?.band;
      if (band === "critical" || band === "high" || band === "normal") bands[band] += 1;
    }
    mini.bands = bands;
    mini.ddTitles = items.filter((i) => i.source === "dd").slice(0, DD_TITLES).map((i) => ({ title: i.title, href: ddHref(i.refs) }));
    const emailOk = attention.value.emailScreen !== "unavailable";
    mini.email = emailOk ? items.filter((i) => i.source === "email").length : null;
    mini.slack = slackIntel === "ok" && attention.value.slackScreen !== "unavailable" ? items.filter((i) => i.source === "slack").length : null;
    mini.restrictedEmail = emailOk && Number.isFinite(attention.value.hiddenEmail) ? attention.value.hiddenEmail : null;
  } else {
    if (signal.aborted) throw signal.reason;
    console.warn(`[exec-brief] fallback attention read failed (principal ${principal.id}): ${errorCodeOf(attention.reason)}`);
  }
  if (approvals.status === "fulfilled") {
    mini.approvals = approvals.value.reduce((n, b) => n + (Number.isFinite(b.count) && b.count > 0 ? b.count : 0), 0);
  } else {
    if (signal.aborted) throw signal.reason;
    console.warn(`[exec-brief] fallback approvals read failed (principal ${principal.id}): ${errorCodeOf(approvals.reason)}`);
  }
  return mini;
}

async function enqueueLate(principal: ExecPrincipal, briefId: string, localDate: string): Promise<void> {
  try {
    const row = await getBriefById(principal, briefId);
    if (row === null) return;
    await enqueueJob({
      kind: BRIEF_JOB_KINDS.deliver,
      lane: "interactive",
      principalId: principal.id,
      payload: { brief_id: row.id, local_date: localDate, rev: row.rev, mode: "late" },
      dedupeKey: briefDeliverKey(principal.id, localDate, row.rev, "late"),
      maxAttempts: 1
    });
  } catch (err) {
    console.warn(`[exec-brief] late note not enqueued (brief ${briefId}): ${errorCodeOf(err)}`);
  }
}

async function runFallback(ctx: JobContext): Promise<FallbackResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  // 1.
  const payload = parsePayload(ctx.job.payload);
  if (payload === null) throw new NonRetryableError("bad_payload");
  const signal = ctx.signal;
  if (!(await briefSchemaReady({ signal }))) return { skipped: "not_installed" };
  const now = new Date();
  const localDate = payload.local_date;
  const tz = principal.briefTimezone;
  const scheduledAt = new Date(payload.scheduled_at);
  // 2.
  const settings = await loadSettings(principal.id);
  const own = await loadBriefOwnership(principal, settings, localDate, now, { signal });
  if (own.verdict.owner !== "exec") return { skipped: own.verdict.reason };
  // 2b. intel-10: never after the catch-up cutoff or the end of the local date. The build raises "late"; only a day with no row
  // at all (the build never ran) is the watchdog's to report.
  if (!mayDmAt(now, localDate, scheduledAt, tz)) {
    if (own.brief === null) {
      await notifyOps({ key: BRIEF_OPS.late.key(principal.id), title: BRIEF_OPS.late.title, detail: `principal ${principal.id}, ${localDate}: no build` });
    }
    return { skipped: "after_cutoff" };
  }
  // 3. Never a post here.
  await resolveStaleRows(principal, now, signal);
  // 4. RPC 4: inserts the day's placeholder when there is no row, then stamps fallback_sent_at by CAS (C32, C36).
  const claim = await claimFallback(principal, { localDate, tz, scheduledAt, ...briefExpiries(localDate, tz) });
  if (claim.outcome === "not_installed") return { skipped: "not_installed" };
  if (claim.outcome !== "claimed") return { skipped: claim.outcome };
  // 5.-7.
  const mini = await buildFallbackMiniBrief(principal, settings, localDate, now, signal);
  let slackUserId: string | null = null;
  try {
    slackUserId = (await getLatestInstallation(principal, { signal }))?.userId ?? null;
  } catch (err) {
    if (signal.aborted) throw err;
    slackUserId = null;
  }
  let outcome: "posted" | "failed";
  let code: string | null = null;
  try {
    const posted = await postDdBotDm(principal, { slackUserId, parts: renderFallbackMiniBrief(mini) }, { signal: AbortSignal.timeout(BRIEF_LIMITS.slackCallMs * 2) });
    // C49 (intel-18): deleted by the system purge at retention_days_chat (the setting now), never after the row's own expiry.
    const expiresAt = briefExpiries(localDate, tz).expiresAt.getTime();
    const deleteAfter = new Date(Math.min(Date.now() + settings.retentionDaysChat * DAY_MS, expiresAt));
    if (!(await recordFallbackResult(claim.id, { channel: posted.channel, ts: posted.ts, deleteAfter }))) {
      console.warn(`[exec-brief] fallback ts not recorded (brief ${claim.id})`);
    }
    await notifyOps({ key: BRIEF_OPS.fallback.key(principal.id), title: BRIEF_OPS.fallback.title, detail: `brief ${claim.id}, ${localDate}: ${claim.status ?? "none"}` });
    outcome = "posted";
  } catch (err) {
    code = errorCodeOf(err);
    try {
      await recordFallbackResult(claim.id, { errorCode: code });
    } catch (storeErr) {
      console.warn(`[exec-brief] fallback error not recorded (brief ${claim.id}): ${errorCodeOf(storeErr)}`);
    }
    await notifyOps({ key: BRIEF_OPS.fallbackFailed.key(principal.id), title: BRIEF_OPS.fallbackFailed.title, detail: `brief ${claim.id}, ${localDate}: ${code}` });
    outcome = "failed";
  }
  // 8. C34, C48 (intel-11): a row that was built at the claim can never be DMed in full now; it moves to page_only and gets the
  // late note, whether or not the mini-brief went out.
  let movedToPageOnly = false;
  if (claim.status === "built") {
    movedToPageOnly = await deliveryStep(claim.id, { from: ["built"], to: "page_only", countPost: false, reason: "after_fallback" });
    if (movedToPageOnly) await enqueueLate(principal, claim.id, localDate);
  }
  return { outcome, briefId: claim.id, status: claim.status, code, movedToPageOnly };
}

export const briefFallbackJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: BRIEF_FALLBACK_JOB_KIND,
  lane: "interactive",
  timeoutMs: BRIEF_LIMITS.fallbackTimeoutMs,
  run: (ctx) => runFallback(ctx)
});
