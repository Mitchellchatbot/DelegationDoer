import { ServerCog } from "lucide-react";
import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { formatCount, formatInZone } from "@/lib/exec/format";
import type { MailSummary } from "@/lib/exec/email-view";
import type { OverviewBriefSystem, OverviewDraftsSystem, OverviewSection, OverviewSystem, OverviewTokenVerdict } from "@/lib/exec/overview";
import type { SlackReadingSummary, SlackSystemSummary } from "@/lib/exec/slack-types";
import { reasonWords, sendTokenReasonWords, voiceErrorWords } from "../drafts/copy";
import { cn } from "@/lib/utils";
import { SectionCard } from "../SectionCard";
import { systemJobRows, type SystemJobRow } from "./job-labels";
import { ago } from "./labels";

// The assistant's background work, from exec_jobs: when each kind last
// succeeded, what died, and whether the queue is keeping up. A tracked kind
// with no recent success is shown as such, which is how a stopped scheduler
// becomes visible.

/** The "Draft checks" row turns amber when a check has been due this long without a reconcile success since (Y8). */
export const DRAFT_CHECKS_OVERDUE_MS = 15 * 60_000;

/** Whether the reconcile is behind (Y8): a check due for more than 15 min, and no success since it fell due. */
export function draftChecksOverdue(reconcile: OverviewDraftsSystem["reconcile"], now: Date | string): boolean {
  if (reconcile === null || reconcile.overdueSince === null) return false;
  const due = Date.parse(reconcile.overdueSince);
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (!Number.isFinite(due) || !Number.isFinite(nowMs) || nowMs - due <= DRAFT_CHECKS_OVERDUE_MS) return false;
  const ran = reconcile.lastSucceededAt === null ? null : Date.parse(reconcile.lastSucceededAt);
  return ran === null || !Number.isFinite(ran) || ran <= due;
}

// P9 F26: the job labels live in job-labels.ts (every registered kind; Slack reading jobs grouped; never a raw kind).

const TOKEN_WARN_MS = 30 * 86_400_000;

type Tone = "muted" | "ok" | "amber" | "rose";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  muted: "text-muted",
  ok: "text-slate-700",
  amber: "font-medium text-amber-700",
  rose: "font-medium text-rose-700"
};

/** One drafts line: what it is, then its state as words. */
function DraftsLine({ label, value, tone = "ok", name }: { label: string; value: string; tone?: Tone; name: string }) {
  return (
    <li data-drafts-row={name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-[12px]">
      <span className="font-medium text-ink">{label}</span>
      <span className={cn("min-w-0 break-words text-right", TONE_CLASS[tone])}>{value}</span>
    </li>
  );
}

/** "ok, expires 12 Dec 2026" / "<reason in words>" / "not checked yet" / "couldn't load"; amber within 30 days of expiry. */
export function tokenLine(
  verdict: OverviewTokenVerdict | null,
  words: (reason: string | null) => string,
  now: string,
  tz: string
): { value: string; tone: Tone } {
  if (verdict === null) return { value: "couldn't load", tone: "amber" };
  if (verdict.reason === "not_checked") return { value: "not checked yet", tone: "muted" };
  const expires = verdict.expiresAt ? formatInZone(verdict.expiresAt, tz, "date", now) : null;
  const left = verdict.expiresAt ? Date.parse(verdict.expiresAt) - Date.parse(now) : null;
  if (!verdict.ok) return { value: words(verdict.reason), tone: "rose" };
  const soon = left !== null && Number.isFinite(left) && left <= TOKEN_WARN_MS;
  return { value: expires ? `ok, expires ${expires}` : "ok", tone: soon ? "amber" : "ok" };
}

export function DraftsRows({ drafts, now, tz }: { drafts: OverviewDraftsSystem | null; now: string; tz: string }) {
  if (drafts === null) {
    return <p className="border-t border-slate-100 px-4 py-2.5 text-[11.5px] font-medium text-amber-700">Couldn&apos;t load the assistant drafts status.</p>;
  }
  const ea = tokenLine(drafts.eaToken, (r) => reasonWords(r), now, tz);
  const send = tokenLine(drafts.sendToken, (r) => sendTokenReasonWords(r), now, tz);
  // ui-7: the Clone row comes from the same clone-ea/ea-token read as the Draft token row; when that read failed
  // (eaToken null) it says so too, and "not checked yet" is kept for a state nothing has written.
  const cl2 =
    drafts.eaToken === null
      ? { value: "couldn't load", tone: "amber" as Tone }
      : drafts.cl2.ready === null
      ? { value: "not checked yet", tone: "muted" as Tone }
      : { value: `${drafts.cl2.ready ? "CL2 ready" : "CL2 not ready"}, send ${drafts.cl2.send ?? "unknown"}`, tone: (drafts.cl2.ready ? "ok" : "rose") as Tone };
  const c = drafts.counts;
  const attention =
    c === null
      ? { value: "couldn't load", tone: "amber" as Tone }
      : {
          value: `${formatCount(c.unknown)} unknown, ${formatCount(c.sentMismatch7d)} mismatched, ${formatCount(c.goneUnconfirmed)} checking, ${formatCount(c.generationFailed24h)} failed`,
          tone: (c.unknown + c.sentMismatch7d > 0 ? "rose" : c.goneUnconfirmed + c.generationFailed24h > 0 ? "amber" : "ok") as Tone
        };
  const overdue = draftChecksOverdue(drafts.reconcile, now);
  const checks =
    drafts.reconcile === null
      ? { value: "couldn't load", tone: "amber" as Tone }
      : {
          value: [
            drafts.reconcile.lastSucceededAt ? `last run ${ago(drafts.reconcile.lastSucceededAt, now)}` : `no run in the last 48 h`,
            overdue && drafts.reconcile.overdueSince ? `a check has been due since ${ago(drafts.reconcile.overdueSince, now)}` : null
          ]
            .filter(Boolean)
            .join(" · "),
          tone: (overdue ? "amber" : "muted") as Tone
        };
  const v = drafts.voice;
  const voice =
    v === null
      ? { value: "couldn't load", tone: "amber" as Tone }
      : v.status === null
        ? { value: drafts.voiceEnabled ? "not built yet" : "off", tone: "muted" as Tone }
        : {
            value: [
              v.status === "ready"
                ? `ready${v.builtAt ? ` ${formatInZone(v.builtAt, tz, "date", now)}` : ""}`
                : v.status === "insufficient"
                  ? "not enough samples"
                  : `failed (${voiceErrorWords(v.lastAttemptError)})`,
              v.lastAttemptAt ? `last tried ${formatInZone(v.lastAttemptAt, tz, "date", now)}` : null
            ]
              .filter(Boolean)
              .join(", "),
            tone: (v.status === "failed" ? "amber" : "ok") as Tone
          };
  return (
    <ul data-drafts-system className="divide-y divide-slate-100 border-t border-slate-100">
      <DraftsLine name="drafts" label="Assistant drafts" value={drafts.draftsEnabled ? "on" : "off"} tone={drafts.draftsEnabled ? "ok" : "muted"} />
      <DraftsLine name="sending" label="Sending" value={drafts.sendEnabled ? "on" : "off"} tone={drafts.sendEnabled ? "ok" : "muted"} />
      <DraftsLine name="draft-token" label="Draft token" value={ea.value} tone={ea.tone} />
      <DraftsLine name="send-token" label="Send token" value={send.value} tone={send.tone} />
      <DraftsLine name="clone" label="Clone" value={cl2.value} tone={cl2.tone} />
      <DraftsLine name="attention" label="Drafts needing attention" value={attention.value} tone={attention.tone} />
      <DraftsLine name="checks" label="Draft checks" value={checks.value} tone={checks.tone} />
      <DraftsLine name="voice" label="Voice profile" value={voice.value} tone={voice.tone} />
    </ul>
  );
}

/**
 * P6 (contract §3.15.3): the Slack row's words. connected → "Connected · last message <relative time | none yet>";
 * error → "Needs attention: Slack rejected a request (<code>)"; revoked → "Disconnected <date>"; not_connected →
 * "Not connected"; null (the read failed) → "couldn't load", like the drafts rows.
 */
export function slackSystemLine(slack: SlackSystemSummary | null, now: string, tz: string): { value: string; tone: Tone } {
  if (slack === null) return { value: "couldn't load", tone: "amber" };
  switch (slack.state) {
    case "connected":
      return { value: `Connected · last message ${slack.lastDmAt ? ago(slack.lastDmAt, now) : "none yet"}`, tone: "ok" };
    case "error":
      return { value: `Needs attention: Slack rejected a request (${slack.lastErrorCode ?? "unknown"})`, tone: "rose" };
    case "revoked":
      return { value: `Disconnected ${formatInZone(slack.revokedAt, tz, "date", now)}`, tone: "muted" };
    default:
      return { value: "Not connected", tone: "muted" };
  }
}

/** P6: the System card's one Slack row; nothing at all before the P6 schema exists (undefined). */
export function SlackRow({ slack, now, tz }: { slack: SlackSystemSummary | null | undefined; now: string; tz: string }) {
  if (slack === undefined) return null;
  const line = slackSystemLine(slack, now, tz);
  return (
    <>
      <ul data-slack-system className="border-t border-slate-100">
        <li data-slack-row={slack === null ? "unavailable" : slack.state} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-[12px]">
          <span className="font-medium text-ink">Slack</span>
          <span className={cn("min-w-0 break-words text-right", TONE_CLASS[line.tone])}>{line.value}</span>
        </li>
      </ul>
      <SlackReadingRow reading={slack?.reading ?? null} now={now} tz={tz} />
    </>
  );
}

/** C48: the suffix every reading state gets while reading events fall back to P6's handler. */
export const READING_V2_MISSING_TEXT = "Needs attention: reading events are falling back to the old handler (apply or reload the P7a database update)";
const READING_RATE_LIMITED_TEXT = "Slack is rate-limiting us";

/**
 * P7a (contract §3.20.4, M12, C48): the "Slack reading" row's words. on → "On · last check <relative> · <n> waiting";
 * paused → "Set up, turned off"; discovering → "Sorting conversations"; error → "Needs attention: Slack rejected the
 * reading permission (<code>)"; revoked → "Stopped <date>" (in his zone; "Stopped" without a date); a blocked method adds
 * " · Slack is rate-limiting us"; v2Missing adds the fallback warning in every state, alone when the state has no
 * words of its own; not_consented / bot_not_connected / not_installed / null → no row (null).
 */
export function slackReadingLine(reading: SlackReadingSummary | null | undefined, now: string, tz?: string): { value: string; tone: Tone } | null {
  if (reading === null || reading === undefined) return null;
  let base: string | null = null;
  let tone: Tone = "muted";
  switch (reading.state) {
    case "on":
      base = `On · last check ${reading.lastSweepAt ? ago(reading.lastSweepAt, now) : "not yet"} · ${formatCount(reading.pendingTriage)} waiting`;
      tone = "ok";
      break;
    case "paused":
      base = "Set up, turned off";
      break;
    case "discovering":
      base = "Sorting conversations";
      break;
    case "error":
      base = `Needs attention: Slack rejected the reading permission (${reading.userErrorCode ?? "unknown"})`;
      tone = "rose";
      break;
    case "revoked":
      // §3.20.4: "Stopped {date}" in his zone; the date is left out when the summary or the zone doesn't carry one.
      base = typeof reading.revokedAt === "string" && typeof tz === "string" ? `Stopped ${formatInZone(reading.revokedAt, tz, "date", now)}` : "Stopped";
      break;
    default:
      base = null;
  }
  const parts: string[] = [];
  if (base !== null) {
    parts.push(base);
    if (reading.blockedMethods > 0) {
      parts.push(READING_RATE_LIMITED_TEXT);
      if (tone !== "rose") tone = "amber";
    }
  }
  if (reading.v2Missing === true) {
    parts.push(READING_V2_MISSING_TEXT);
    tone = "rose";
  }
  return parts.length === 0 ? null : { value: parts.join(" · "), tone };
}

/** P7a: the System card's "Slack reading" row; nothing when the summary has no reading half to show. */
export function SlackReadingRow({ reading, now, tz }: { reading: SlackReadingSummary | null | undefined; now: string; tz?: string }) {
  const line = slackReadingLine(reading, now, tz);
  if (line === null || reading === null || reading === undefined) return null;
  return (
    <ul data-slack-reading-system className="border-t border-slate-100">
      <li data-slack-reading-row={reading.state} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-[12px]">
        <span className="font-medium text-ink">Slack reading</span>
        <span className={cn("min-w-0 break-words text-right", TONE_CLASS[line.tone])}>{line.value}</span>
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// P8 (contract §3.17.6, M12, C19, C40): the morning brief, the check-in token and the AI rows
// ---------------------------------------------------------------------------

const BRIEF_NONE_TEXT = "Not built yet today";
/** P9 F31: the same day once it is more than 45 minutes past the brief time (the header pill reads "late"). */
export const BRIEF_NONE_LATE_TEXT = "Not built yet today · late";
const CHECKIN_ORDER: readonly (keyof OverviewBriefSystem["checkins"])[] = ["proposed", "sending", "sent", "unknown", "failed", "expired"];
const PAGE_ONLY_KEYS: ReadonlySet<string> = new Set(Object.keys(BRIEF_COPY.pageOnlyReason));
const usd2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");

/** "<owner> · <status line> · <channel> · <mode>" (M12), its tone, and a second line: the DD brief's day and the check-ins.
 *  P9 F31: `late` (the pill's "late") turns a not-built day's row amber and says so. */
export function briefSystemLines(b: OverviewBriefSystem, now: string, tz: string, late = false): { value: string; tone: Tone; detail: string | null } {
  const sys = BRIEF_COPY.system;
  const parts: string[] = [sys.owner[b.owner] ?? sys.owner.unknown];
  const lateNone = late && b.status === "none";
  if (b.status === "none") parts.push(lateNone ? BRIEF_NONE_LATE_TEXT : BRIEF_NONE_TEXT);
  else {
    let line: string =
      b.status === "delivered" ? fillBrief(BRIEF_COPY.status.delivered, { time: formatInZone(b.deliveredAt, tz, "time", now) }) : BRIEF_COPY.status[b.status];
    if (b.status === "page_only" && b.statusReason !== null && PAGE_ONLY_KEYS.has(b.statusReason)) {
      const reason: string = BRIEF_COPY.pageOnlyReason[b.statusReason as keyof typeof BRIEF_COPY.pageOnlyReason];
      // after_cutoff names a time this row doesn't carry; the Brief tab's status line has it.
      if (!reason.includes("{")) line = `${line} ${reason}`;
    }
    if (b.fallbackSentAt !== null) line = `${line} ${fillBrief(BRIEF_COPY.status.fallback, { time: formatInZone(b.fallbackSentAt, tz, "time", now) })}`;
    parts.push(line);
  }
  parts.push(sys.channel[b.channel] ?? sys.channel.unknown);
  if (b.mode === "ai") parts.push(BRIEF_COPY.modeAi);
  else if (b.mode === "deterministic") {
    const key = b.modeReason !== null && b.modeReason in BRIEF_COPY.modeReason ? b.modeReason : "model_error";
    parts.push(fillBrief(BRIEF_COPY.modeDeterministic, { reason: BRIEF_COPY.modeReason[key] }));
  }
  if (b.fallbackErrorCode !== null) parts.push(`backup failed (${b.fallbackErrorCode})`);
  const detail: string[] = [];
  if (b.legacyDeliveredToday !== null) detail.push(fillBrief(sys.legacyToday, { state: b.legacyDeliveredToday ? sys.legacySent : sys.legacyNotSent }));
  const counts = CHECKIN_ORDER.filter((k) => (b.checkins?.[k] ?? 0) > 0).map((k) => `${formatCount(b.checkins[k])} ${k}`);
  if (counts.length > 0) detail.push(`Check-ins: ${counts.join(", ")}`);
  const tone: Tone =
    b.status === "failed" || b.fallbackErrorCode !== null
      ? "rose"
      : b.status === "delivery_unknown" || b.owner === "unknown" || b.fallbackSentAt !== null || lateNone
        ? "amber"
        : "ok";
  return { value: parts.join(" · "), tone, detail: detail.length > 0 ? detail.join(" · ") : null };
}

/** The check-in token row (C19): BRIEF_COPY.system.tokenState in words. The stored verdict carries no error code, so the
 *  " ({code})" part is left out rather than shown unfilled. */
export function userTokenLine(t: NonNullable<OverviewSystem["userToken"]>, now: string, tz: string): { value: string; tone: Tone } {
  const words: string = BRIEF_COPY.system.tokenState[t.state] ?? BRIEF_COPY.system.tokenState.unchecked;
  const value = fillBrief(words.replace(" ({code})", ""), { time: formatInZone(t.checkedAt, tz, "datetime", now) });
  const tone: Tone =
    t.state === "ok" ? "ok" : t.state === "mismatch" || t.state === "revoked" ? "rose" : t.state === "missing" || t.state === "error" ? "amber" : "muted";
  return { value, tone };
}

/** The two AI lines (C40): spend against the cap (amber from 80 %, rose at the cap) with the per-feature split as its
 *  title, and the refusals of the last 24 hours (amber when any). */
export function aiLines(ai: NonNullable<OverviewSystem["ai"]>): { spend: { value: string; tone: Tone; title: string }; refusals: { value: string; tone: Tone } } {
  const sys = BRIEF_COPY.system;
  const ratio = ai.capUsd > 0 ? ai.spentTodayUsd / ai.capUsd : ai.spentTodayUsd > 0 ? 1 : 0;
  const title = Object.entries(ai.byFeature)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([feature, usd]) => `${feature} $${usd2(usd)}`)
    .join(", ");
  return {
    spend: { value: fillBrief(sys.spend, { spent: usd2(ai.spentTodayUsd), cap: usd2(ai.capUsd) }), tone: ratio >= 1 ? "rose" : ratio >= 0.8 ? "amber" : "ok", title },
    refusals: { value: fillBrief(sys.refusals, { n: formatCount(ai.refusals24h) }), tone: ai.refusals24h > 0 ? "amber" : "ok" }
  };
}

const UNAVAILABLE_LINE: { value: string; tone: Tone } = { value: "couldn't load", tone: "amber" };

/**
 * P9 F13: the stored Slack tokens' key ids against this server's keys (overview.ts compares kids, never decrypts):
 * "Slack tokens on the previous key: N", amber while N > 0 (the re-seal hasn't run yet, so EXEC_TOKEN_KEY_PREVIOUS must
 * stay), rose when any is on a key this server doesn't hold (it can't be opened until Reconnect). null = the read failed.
 */
export function tokenKeysLine(k: NonNullable<OverviewSystem["tokenKeys"]> | null): { value: string; tone: Tone } {
  if (k === null) return { value: "Slack token keys: couldn't load", tone: "amber" };
  const parts = [`Slack tokens on the previous key: ${formatCount(k.previousKey)}`];
  if (k.unknownKey > 0) parts.push(`on a key this server doesn't have: ${formatCount(k.unknownKey)}`);
  return { value: parts.join(" · "), tone: k.unknownKey > 0 ? "rose" : k.previousKey > 0 ? "amber" : "ok" };
}

/** P9 F13: the token-key row; nothing without a Slack installation (tokenKeys absent). */
export function TokenKeysRow({ tokenKeys }: { tokenKeys: OverviewSystem["tokenKeys"] }) {
  if (tokenKeys === undefined) return null;
  const line = tokenKeysLine(tokenKeys);
  return (
    <ul data-token-keys-system className="border-t border-slate-100">
      <li data-token-keys-row={tokenKeys === null ? "unavailable" : line.tone} className={cn("px-4 py-2 text-[12px]", TONE_CLASS[line.tone])}>
        {line.value}
      </li>
    </ul>
  );
}

/** P8: the brief, token and AI rows; nothing at all for a part the overview didn't read (undefined). P9 F31: briefLate. */
export function BriefSystemRows({ system, now, tz, briefLate = false }: { system: OverviewSystem; now: string; tz: string; briefLate?: boolean }) {
  const { brief, userToken, ai } = system;
  if (brief === undefined && userToken === undefined && ai === undefined) return null;
  const b = brief === undefined ? undefined : brief === null ? { ...UNAVAILABLE_LINE, detail: null } : briefSystemLines(brief, now, tz, briefLate);
  const t = userToken === undefined ? undefined : userToken === null ? UNAVAILABLE_LINE : userTokenLine(userToken, now, tz);
  const a = ai === undefined ? undefined : ai === null ? null : aiLines(ai);
  return (
    <ul data-brief-system className="divide-y divide-slate-100 border-t border-slate-100">
      {b !== undefined && (
        <li data-brief-system-row="brief" className="space-y-0.5 px-4 py-2 text-[12px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="font-medium text-ink">{BRIEF_COPY.system.brief}</span>
            <span className={cn("min-w-0 break-words text-right", TONE_CLASS[b.tone])}>{b.value}</span>
          </div>
          {b.detail !== null && <p className="text-right text-[11.5px] text-muted">{b.detail}</p>}
        </li>
      )}
      {t !== undefined && (
        <li data-brief-system-row="token" className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2 text-[12px]">
          <span className="font-medium text-ink">{BRIEF_COPY.system.token}</span>
          <span className={cn("min-w-0 break-words text-right", TONE_CLASS[t.tone])}>{t.value}</span>
        </li>
      )}
      {a === null && (
        <li data-brief-system-row="ai" className="px-4 py-2 text-[12px] font-medium text-amber-700">
          Couldn&apos;t load today&apos;s AI spend.
        </li>
      )}
      {a !== null && a !== undefined && (
        <>
          <li data-brief-system-row="spend" title={a.spend.title} className={cn("px-4 py-2 text-[12px]", TONE_CLASS[a.spend.tone])}>
            {a.spend.value}
          </li>
          <li data-brief-system-row="refusals" className={cn("px-4 py-2 text-[12px]", TONE_CLASS[a.refusals.tone])}>
            {a.refusals.value}
          </li>
        </>
      )}
    </ul>
  );
}

/** The mail sync line (P3, when email is on): what reconcile and the live socket last reported. */
function MailLine({ mail, now }: { mail: OverviewSection<MailSummary>; now: string }) {
  if (!mail.ok) {
    return <p className="border-t border-slate-100 px-4 py-2.5 text-[11.5px] font-medium text-amber-700">Couldn&apos;t load the mail sync status.</p>;
  }
  const m = mail.data;
  let text: string;
  let alarm = false;
  if (m.checkedAt === null) text = "Mail: not synced yet";
  else if (m.problems > 0) {
    text = `Mail: ${m.problems === 1 ? "a mailbox connection needs" : `${formatCount(m.problems)} mailbox connections need`} attention`;
    alarm = true;
  } else if (m.failingSince !== null) {
    text = `Mail: sync failing since ${ago(m.failingSince, now)}`;
    alarm = true;
  } else text = m.lastSyncedAt ? `Mail: synced ${ago(m.lastSyncedAt, now)}` : "Mail: the mail service hasn't synced yet";
  const live =
    m.socket === null ? "live updates not reported" : m.socket.stale ? "live updates not reporting" : m.socket.connected ? "live updates connected" : "live updates disconnected";
  return (
    <p className={cn("border-t border-slate-100 px-4 py-2.5 text-[11.5px]", alarm ? "font-medium text-rose-700" : "text-muted")}>{`${text} · ${live}`}</p>
  );
}

function KindRow({ job, lookbackHours, now }: { job: SystemJobRow; lookbackHours: number; now: string }) {
  // P9 F26: the row's words come from job-labels.ts; a kind without a label reads "Other background jobs", never its id.
  const label = job.label;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="break-words text-[13px] font-medium text-ink">{label}</div>
        <div className="text-[11.5px]">
          {job.lastSuccessAt ? (
            <span className="text-muted">
              Last success <time dateTime={job.lastSuccessAt}>{ago(job.lastSuccessAt, now)}</time>
            </span>
          ) : (
            <span className="font-medium text-amber-700">{`No success in the last ${lookbackHours} h`}</span>
          )}
        </div>
      </div>
      {job.dead24h > 0 && (
        <span className="badge shrink-0 border-rose-200 bg-rose-50 text-rose-700" title="Ran out of retries in the last 24 hours">
          {`${formatCount(job.dead24h)} failed`}
        </span>
      )}
    </li>
  );
}

function Figure({ label, value, title, alarm = false }: { label: string; value: string; title?: string; alarm?: boolean }) {
  return (
    <div title={title} className="min-w-0">
      <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[15px] font-semibold tabular-nums", alarm ? "text-rose-700" : "text-ink")}>{value}</dd>
    </div>
  );
}

export function SystemSection({
  system,
  now,
  mail = null,
  tz = "America/New_York",
  briefLate = false
}: {
  system: OverviewSection<OverviewSystem>;
  now: string;
  /** Mail sync health while email is on; null otherwise. */
  mail?: OverviewSection<MailSummary> | null;
  /** His zone, for the drafts rows' dates (P4). */
  tz?: string;
  /** P9 F31: the header pill reads "late" (today's brief more than 45 minutes past its time, not started). */
  briefLate?: boolean;
}) {
  if (!system.ok) return <SectionCard title="System" icon={ServerCog} error />;
  const { kinds, successLookbackHours, dead24h, queued, due, oldestDueAt } = system.data;
  return (
    <SectionCard title="System" icon={ServerCog} basis="record" subtitle="The assistant's background jobs" padded={false}>
      <ul className="divide-y divide-slate-100">
        {systemJobRows(kinds).map((job) => (
          <KindRow key={job.key} job={job} lookbackHours={successLookbackHours} now={now} />
        ))}
      </ul>
      <dl className="grid grid-cols-3 gap-2 border-t border-slate-100 px-4 py-3">
        <Figure
          label="Queued"
          value={queued > due ? `${formatCount(queued)} (${formatCount(due)} due)` : formatCount(queued)}
          title="Jobs waiting to run; the ones not yet due wait for a retry or a later slot"
        />
        <Figure label="Oldest due" value={oldestDueAt ? ago(oldestDueAt, now) : "None"} title="How long the longest-waiting due job has waited" />
        <Figure label="Failed, 24 h" value={formatCount(dead24h)} title="Jobs that ran out of retries in the last 24 hours" alarm={dead24h > 0} />
      </dl>
      {mail !== null && <MailLine mail={mail} now={now} />}
      {system.data.drafts !== undefined && <DraftsRows drafts={system.data.drafts} now={now} tz={tz} />}
      <SlackRow slack={system.data.slack} now={now} tz={tz} />
      <TokenKeysRow tokenKeys={system.data.tokenKeys} />
      <BriefSystemRows system={system.data} now={now} tz={tz} briefLate={briefLate} />
    </SectionCard>
  );
}
