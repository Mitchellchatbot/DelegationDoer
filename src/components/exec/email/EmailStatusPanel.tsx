import { CircleAlert, CircleCheck, Clock3, Gauge, Radio, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { EmailFreshness, MailboxStatus, SatisfactionFreshness } from "@/lib/exec/email-view";
import { cn } from "@/lib/utils";
import { BasisLabel } from "../BasisLabel";
import { Ago, When } from "./parts";

// How current the Email tab is: when his mailbox last synced (or that it is
// failing), whether new mail arrives live, whether Outlook's own signals
// (flags, archived mail) are available, whether the assistant is still
// catching up, and for how many active clients the satisfaction scores are
// fresh enough to raise an item (L13). All of it is the system's own record of
// its runs. A part that couldn't be read says so; it never reads as "fine".

const PROBLEM_LABEL: Readonly<Record<string, string>> = {
  not_found: "the mail service no longer has this mailbox",
  email_mismatch: "the mailbox now belongs to a different address",
  not_microsoft: "the mailbox isn't the Outlook connection it was pinned as"
};

type Tone = "ok" | "warn" | "bad" | "muted";

const TONE: Readonly<Record<Tone, string>> = {
  ok: "text-emerald-700",
  warn: "text-amber-800",
  bad: "text-rose-700",
  muted: "text-slate-600"
};

function Line({ icon: Icon, tone, children }: { icon: typeof CircleCheck; tone: Tone; children: ReactNode }) {
  return (
    <li className={cn("flex min-w-0 items-start gap-2 text-[12.5px]", TONE[tone])}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

function MailboxLine({ m, now, tz, many }: { m: MailboxStatus; now: string; tz: string; many: boolean }) {
  const which = many && m.address ? `${m.address}: ` : "";
  if (m.problem !== null) {
    return (
      <Line icon={CircleAlert} tone="bad">
        {`${which}Mailbox connection needs attention: ${PROBLEM_LABEL[m.problem] ?? m.problem}. The team re-pins it; until then nothing new is read from it.`}
      </Line>
    );
  }
  if (m.failingSince !== null) {
    return (
      <Line icon={CircleAlert} tone="bad">
        {which}Sync failing since <When iso={m.failingSince} now={now} tz={tz} />
        {m.failingError ? <span className="text-slate-600">{` (${m.failingError})`}</span> : null}
      </Line>
    );
  }
  if (m.lastSyncedAt === null) {
    return (
      <Line icon={Clock3} tone="warn">
        {`${which}The mail service hasn't synced this mailbox yet.`}
      </Line>
    );
  }
  return (
    <Line icon={CircleCheck} tone="ok">
      {which}Synced <Ago iso={m.lastSyncedAt} now={now} tz={tz} />
    </Line>
  );
}

/** L13: "fresh for N of M active clients". None fresh is a warning: no satisfaction item can be raised. */
function SatisfactionLine({ s }: { s: SatisfactionFreshness }) {
  if (s.active === 0) {
    return (
      <Line icon={Gauge} tone="muted">
        No active clients, so there are no satisfaction scores to track.
      </Line>
    );
  }
  return (
    <Line icon={Gauge} tone={s.fresh === 0 ? "warn" : "muted"}>
      {`Satisfaction scores fresh for ${s.fresh} of ${s.active} active clients`}
      <span className="text-slate-600">{` (scored in the last ${s.freshDays} days; only those clients can raise a satisfaction item)`}</span>
    </Line>
  );
}

export function EmailStatusPanel({ freshness, now, tz }: { freshness: EmailFreshness; now: string; tz: string }) {
  const { accounts, socket, sync, satisfaction } = freshness;
  return (
    <section aria-label="Mail status" className="rounded-2xl border border-slate-200/70 bg-white px-4 py-3 shadow-soft">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Mail status</h2>
        <BasisLabel basis="record" />
      </div>
      <ul className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">
        {!accounts.ok ? (
          <Line icon={CircleAlert} tone="warn">
            Couldn&apos;t load the mailbox status.
          </Line>
        ) : accounts.data.checkedAt === null ? (
          <Line icon={Clock3} tone="warn">
            Not synced yet. The first sync runs within about 5 minutes of email being turned on.
          </Line>
        ) : (
          accounts.data.mailboxes.map((m) => <MailboxLine key={m.accountId} m={m} now={now} tz={tz} many={accounts.data.mailboxes.length > 1} />)
        )}

        {!socket.ok ? (
          <Line icon={CircleAlert} tone="warn">
            Couldn&apos;t load the live-update status.
          </Line>
        ) : socket.data === null ? (
          <Line icon={Radio} tone="muted">
            Live updates haven&apos;t reported yet. New mail still arrives within about 5 minutes.
          </Line>
        ) : socket.data.stale ? (
          <Line icon={Radio} tone="warn">
            Live updates haven&apos;t reported since <Ago iso={socket.data.observedAt} now={now} tz={tz} />. New mail still arrives within about 5
            minutes.
          </Line>
        ) : socket.data.connected ? (
          <Line icon={Radio} tone="ok">
            Live updates connected
          </Line>
        ) : (
          <Line icon={Radio} tone="warn">
            Live updates disconnected. New mail arrives within about 5 minutes instead.
          </Line>
        )}

        {!sync.ok ? (
          <Line icon={CircleAlert} tone="warn">
            Couldn&apos;t load the sync progress.
          </Line>
        ) : (
          <>
            {sync.data.signals === "unavailable" && (
              <Line icon={CircleAlert} tone="muted">
                Outlook signals aren&apos;t available yet: flags and archived mail don&apos;t show here, so archived mail can still look unanswered.
              </Line>
            )}
            {sync.data.catchingUp && (
              <Line icon={RefreshCw} tone="warn">
                Catching up on recent mail
                {sync.data.catchingUpUntil ? (
                  <>
                    {" "}
                    (queued work runs until <When iso={sync.data.catchingUpUntil} now={now} tz={tz} mode="time" />)
                  </>
                ) : null}
                . Some threads may not be assessed yet.
              </Line>
            )}
          </>
        )}

        {!satisfaction.ok ? (
          <Line icon={CircleAlert} tone="warn">
            Couldn&apos;t load how fresh the client satisfaction scores are.
          </Line>
        ) : (
          <SatisfactionLine s={satisfaction.data} />
        )}
      </ul>
    </section>
  );
}
