import type { ReactNode } from "react";
import { History, Mic, SlidersHorizontal, ThumbsUp, Wallet, Waypoints } from "lucide-react";
import type { VoiceProfileRow } from "@/lib/exec/drafts-store";
import { MISSING, formatCount, formatInZone, pluralize } from "@/lib/exec/format";
import type { SlackConnectResult } from "@/lib/exec/slack-types";
import { voiceCanBuild } from "@/lib/exec/ui/settings-api";
import type { SettingsView } from "@/lib/exec/view-types";
import { BasisLabel } from "../BasisLabel";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { SectionCard } from "../SectionCard";
import { SettingsForm } from "./SettingsForm";
import { SlackSection } from "./SlackSection";
import { VoiceResetButton } from "./VoiceResetButton";

// /executive/settings (P5a contract §3.13.2, A6, C14, C20): the switches he
// can change (SettingsForm, frame-guarded), today's AI spend, the settings
// the team sets by hand (read-only here), the learned writing style with its
// reset, feedback totals and recent access, and (P6, contract §3.13) the Slack
// app's own section: Connect, Reconnect, Disconnect. Rendered from a SettingsView only:
// each section fails soft on its own, and no value is shown as a zero when it
// couldn't be read.

export const SETTINGS_PAGE_COPY = {
  ipNote: "The IP is the first X-Forwarded-For entry and can be spoofed.",
  noFeedback: "No feedback yet.",
  feedbackNotInstalled: "Not available yet: the team needs to apply the database update.",
  voiceNotInstalled: "Not available yet: the team needs to apply the database update.",
  voiceNone: "No profile yet. It builds once a week from your sent email.",
  teamSet: "Set by the team. Shown here for reference.",
  // No assistant brief (P8) exists in this build and nothing reads its columns,
  // so its stored values are never shown (review ui-3). The Slack app (P6) has
  // its own section (SlackSection); the old Slack check-in columns stay unshown.
  briefNotSetUp: "Not set up yet"
} as const;

const usd = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : MISSING);
const onOff = (on: boolean) => (on ? "On" : "Off");

const FEATURE_LABEL: Readonly<Record<string, string>> = {
  triage: "Email triage",
  draft: "Drafts",
  voice: "Writing style",
  brief: "Brief",
  digest: "Digest",
  chat: "Chat",
  ddtext: "DD text triage",
  spike: "Tests"
};

// The Needs Attention kinds as he reads them (priority.ts keeps its own copy
// private). A kind this build doesn't know is shown with spaces for underscores.
const KIND_LABEL: Readonly<Record<string, string>> = {
  open_incident: "Open incident",
  unanswered_mention: "Unanswered mention",
  overdue_tasks: "Overdue tasks",
  site_alert: "Site alert",
  recurring_issue: "Recurring issue",
  pending_approval: "Pending approval",
  stalled_tasks: "Stalled tasks",
  waiting_on_client: "Waiting on client",
  missed_deadlines: "Missed deadlines",
  client_escalation: "Client escalation",
  decision_ask: "Decision asked of you",
  client_health_drop: "Client health drop",
  important_email: "Important email",
  overdue_commitment: "Overdue commitment",
  client_satisfaction_drop: "Client satisfaction drop",
  ddtext_blocker: "Possible blocker in DD text",
  ddtext_waiting: "Possible wait in DD text",
  ddtext_decision: "Possible decision in DD text",
  ddtext_mention: "Mention of you in a comment"
};

export function feedbackKindLabel(kind: string): string {
  const known = KIND_LABEL[kind];
  if (known) return known;
  const plain = kind.replace(/_/g, " ").trim();
  return plain.length > 0 ? `${plain[0].toUpperCase()}${plain.slice(1)}` : kind;
}

const REASON_LABEL: Readonly<Record<string, string>> = {
  useful: "Useful",
  not_relevant: "Not relevant",
  wrong_priority: "Wrong priority",
  already_handled: "Already handled",
  duplicate: "Duplicate",
  wrong_facts: "Facts are wrong",
  other: "Other"
};

const VOICE_LABELS: Readonly<Record<string, string>> = {
  ready: "Ready",
  insufficient: "Not enough sent email yet",
  failed: "Last build failed",
  very_casual: "Very casual",
  casual: "Casual",
  neutral: "Neutral",
  formal: "Formal",
  one_liner: "One-liners",
  short: "Short",
  medium: "Medium",
  long: "Long",
  none: "None",
  hi_first_name: "Hi <first name>",
  hey_first_name: "Hey <first name>",
  hello_first_name: "Hello <first name>",
  first_name_only: "First name only",
  dear_name: "Dear <name>",
  mixed: "Mixed",
  single_block: "One block",
  short_paragraphs: "Short paragraphs",
  many_short_lines: "Many short lines",
  never: "Never",
  sometimes: "Sometimes",
  often: "Often",
  rarely: "Rarely"
};

const voiceWord = (v: string | null) => (v === null ? MISSING : (VOICE_LABELS[v] ?? v));

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 text-[12.5px]">
      <dt className="text-slate-600">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-ink">{children}</dd>
    </div>
  );
}

function Spend({ view }: { view: SettingsView }) {
  const s = view.spend;
  if (!s.ok) return <SectionCard title="Today's AI spend" icon={Wallet} error />;
  const { totalUsd, capUsd, byFeature } = s.data;
  return (
    <SectionCard title="Today's AI spend" icon={Wallet} basis="record" subtitle="Since midnight in your time zone">
      <p className="text-[13px] text-slate-700">
        <span className="text-[20px] font-bold tabular-nums text-ink">{usd(totalUsd)}</span>
        {` of ${usd(capUsd)} today`}
      </p>
      {byFeature.length > 0 ? (
        <dl className="mt-2 divide-y divide-slate-100">
          {byFeature.map((f) => (
            <Row key={f.feature} label={FEATURE_LABEL[f.feature] ?? f.feature}>
              {usd(f.usd)}
            </Row>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-[12px] text-muted">No AI work yet today.</p>
      )}
    </SectionCard>
  );
}

function ReadOnly({ view }: { view: SettingsView }) {
  const s = view.settings;
  const mailbox = view.pinnedMailbox;
  return (
    <SectionCard title="Email, drafts and brief" icon={Waypoints} subtitle={SETTINGS_PAGE_COPY.teamSet}>
      <dl className="divide-y divide-slate-100">
        <Row label="Email intelligence">{s.emailSchemaReady ? onOff(s.emailEnabled) : "Not set up yet"}</Row>
        <Row label="Pinned mailbox">
          {!mailbox.ok ? (
            <span title="Couldn't load">{MISSING}</span>
          ) : mailbox.data.emails.length > 0 ? (
            mailbox.data.emails.join(", ")
          ) : mailbox.data.accountIds.length > 0 ? (
            pluralize(mailbox.data.accountIds.length, "mailbox", "mailboxes")
          ) : (
            "None pinned"
          )}
        </Row>
        <Row label="Assistant drafts">{s.draftsSchemaReady ? onOff(s.draftsEnabled) : "Not set up yet"}</Row>
        <Row label="Send from DD">{s.draftsSchemaReady ? onOff(s.sendEnabled) : "Not set up yet"}</Row>
        <Row label="Morning brief">{SETTINGS_PAGE_COPY.briefNotSetUp}</Row>
      </dl>
    </SectionCard>
  );
}

function VoiceCard({ view }: { view: SettingsView }) {
  const v = view.voice;
  if (!v.ok) return <SectionCard title="Writing style" icon={Mic} error />;
  const { installed, profile } = v.data;
  const tz = view.timezone;
  const now = view.generatedAt;
  const p: VoiceProfileRow | null = profile;
  return (
    <SectionCard title="Writing style" icon={Mic} basis="ai" subtitle="Learned weekly from your sent email; drafts use it">
      {!installed ? (
        <p className="text-[12.5px] text-muted">{SETTINGS_PAGE_COPY.voiceNotInstalled}</p>
      ) : (
        <div className="space-y-3">
          {p === null ? (
            <p className="text-[12.5px] text-muted">{SETTINGS_PAGE_COPY.voiceNone}</p>
          ) : (
            <dl className="divide-y divide-slate-100">
              <Row label="Status">{voiceWord(p.status)}</Row>
              <Row label="Formality">{voiceWord(p.formality)}</Row>
              <Row label="Typical length">{voiceWord(p.typicalLength)}</Row>
              <Row label="Greeting">{voiceWord(p.greeting)}</Row>
              <Row label="Paragraphs">{voiceWord(p.paragraphing)}</Row>
              <Row label="Bullets">{voiceWord(p.bullets)}</Row>
              <Row label="Emoji">{voiceWord(p.emoji)}</Row>
              <Row label="Sign-off">{p.signOff ?? MISSING}</Row>
              <Row label="Built">{`${formatInZone(p.builtAt, tz, "datetime", now)} from ${pluralize(p.sampleCount, "email")}`}</Row>
            </dl>
          )}
          <VoiceResetButton installed={installed} hasProfile={p !== null} rebuilds={view.settings.voiceEnabled && voiceCanBuild(view)} />
        </div>
      )}
    </SectionCard>
  );
}

function Feedback({ view }: { view: SettingsView }) {
  const f = view.feedback;
  if (!f.ok) return <SectionCard title="Feedback on Needs Attention" icon={ThumbsUp} error />;
  if (f.data === null) {
    return (
      <SectionCard title="Feedback on Needs Attention" icon={ThumbsUp}>
        <p className="text-[12.5px] text-muted">{SETTINGS_PAGE_COPY.feedbackNotInstalled}</p>
      </SectionCard>
    );
  }
  const t = f.data;
  const none = t.up === 0 && t.down === 0;
  return (
    <SectionCard
      title="Feedback on Needs Attention"
      icon={ThumbsUp}
      basis="record"
      subtitle={`Since ${formatInZone(t.sinceIso, view.timezone, "date", view.generatedAt)}`}
      empty={none ? SETTINGS_PAGE_COPY.noFeedback : undefined}
    >
      <p className="text-[13px] text-slate-700">{`${pluralize(t.up, "useful vote")} · ${pluralize(t.down, "not useful vote")}`}</p>
      {t.byKind.length > 0 && (
        <dl className="mt-2 divide-y divide-slate-100">
          {t.byKind.map((k) => (
            <Row key={k.kind} label={feedbackKindLabel(k.kind)}>{`${formatCount(k.up)} up · ${formatCount(k.down)} down`}</Row>
          ))}
        </dl>
      )}
      {t.byReason.length > 0 && (
        <p className="mt-2 text-[12px] text-muted">
          {t.byReason.map((r) => `${REASON_LABEL[r.reason] ?? r.reason}: ${formatCount(r.count)}`).join(" · ")}
        </p>
      )}
    </SectionCard>
  );
}

function RecentAccess({ view }: { view: SettingsView }) {
  const r = view.recentAccess;
  const tz = view.timezone;
  const now = view.generatedAt;
  if (!r.ok) return <SectionCard title="Recent access" icon={History} error />;
  return (
    <SectionCard title="Recent access" icon={History} basis="record" subtitle={SETTINGS_PAGE_COPY.ipNote} empty={r.data.length === 0 ? "No access recorded yet." : undefined} padded={false}>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[12px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] uppercase tracking-wide text-slate-600">
              <th scope="col" className="px-3 py-2 font-semibold">When</th>
              <th scope="col" className="px-3 py-2 font-semibold">Route</th>
              <th scope="col" className="px-3 py-2 font-semibold">Surface</th>
              <th scope="col" className="px-3 py-2 font-semibold">IP (as reported)</th>
              <th scope="col" className="px-3 py-2 font-semibold">Device</th>
              <th scope="col" className="px-3 py-2 font-semibold">Session</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {r.data.map((a, i) => (
              <tr key={`${a.at}:${i}`} className="align-top">
                <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-700">{formatInZone(a.at, tz, "datetime", now)}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700">{a.route}</td>
                <td className="px-3 py-1.5 text-slate-700">{a.surface}</td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700">{a.ip ?? MISSING}</td>
                <td className="max-w-[16rem] px-3 py-1.5 text-slate-600">
                  <span className="line-clamp-2 break-words">{a.device ?? MISSING}</span>
                </td>
                <td className="px-3 py-1.5 font-mono text-[11px] text-slate-600">{a.sessionTag ?? MISSING}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

export function SettingsPageView({
  view,
  slackResult = null,
  who = null,
  onCanonicalHost = true
}: {
  view: SettingsView;
  /** P6 (C24): the validated ?slack= result code the OAuth routes redirected with (SlackSection's parseSlackResult). */
  slackResult?: SlackConnectResult | null;
  /** P6 (C25): the validated ?who= Slack user id, shown only with wrong_user. */
  who?: string | null;
  /** P6 (C45): this request's host is the canonical one (isCanonicalRequestHost); false replaces Connect / Reconnect. */
  onCanonicalHost?: boolean;
}) {
  const now = view.generatedAt;
  const tz = view.timezone;
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="settings" tabs={EXEC_TABS} />} />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <SectionCard
            title="Assistant settings"
            icon={SlidersHorizontal}
            subtitle={
              <span className="inline-flex flex-wrap items-center gap-1.5">
                Saved values, read from the settings record <BasisLabel basis="record" />
              </span>
            }
            padded={false}
          >
            <div className="px-4 pb-1">
              <SettingsForm view={view} />
            </div>
          </SectionCard>
          <RecentAccess view={view} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Spend view={view} />
          <VoiceCard view={view} />
          <ReadOnly view={view} />
          <SlackSection view={view.slack} result={slackResult} who={who} onCanonicalHost={onCanonicalHost} tz={tz} now={now} />
          <Feedback view={view} />
        </div>
      </div>
    </div>
  );
}
