import { ServerCog } from "lucide-react";
import { formatCount, formatInZone } from "@/lib/exec/format";
import type { MailSummary } from "@/lib/exec/email-view";
import type { JobKindHealth, OverviewDraftsSystem, OverviewSection, OverviewSystem, OverviewTokenVerdict } from "@/lib/exec/overview";
import type { SlackReadingSummary, SlackSystemSummary } from "@/lib/exec/slack-types";
import { reasonWords, sendTokenReasonWords, voiceErrorWords } from "../drafts/copy";
import { cn } from "@/lib/utils";
import { SectionCard } from "../SectionCard";
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

const JOB_LABELS: Readonly<Record<string, string>> = {
  "exec.dd-attention": "Needs Attention refresh",
  "exec.purge": "Retention cleanup",
  "exec.email-triage": "Email assessment",
  "exec.email-reconcile": "Mail sync check",
  "exec.email-attention": "Email Needs Attention refresh",
  "exec.draft-generate": "Drafting",
  "exec.draft-reconcile": "Draft checks",
  "exec.voice-refresh": "Voice profile"
};

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

function KindRow({ job, lookbackHours, now }: { job: JobKindHealth; lookbackHours: number; now: string }) {
  // A kind with no label (a later phase's) shows its id, which is what the logs use.
  const label = JOB_LABELS[job.kind] ?? job.kind;
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
  tz = "America/New_York"
}: {
  system: OverviewSection<OverviewSystem>;
  now: string;
  /** Mail sync health while email is on; null otherwise. */
  mail?: OverviewSection<MailSummary> | null;
  /** His zone, for the drafts rows' dates (P4). */
  tz?: string;
}) {
  if (!system.ok) return <SectionCard title="System" icon={ServerCog} error />;
  const { kinds, successLookbackHours, dead24h, queued, due, oldestDueAt } = system.data;
  return (
    <SectionCard title="System" icon={ServerCog} basis="record" subtitle="The assistant's background jobs" padded={false}>
      <ul className="divide-y divide-slate-100">
        {kinds.map((job) => (
          <KindRow key={job.kind} job={job} lookbackHours={successLookbackHours} now={now} />
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
    </SectionCard>
  );
}
