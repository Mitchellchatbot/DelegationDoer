import type { ReactNode } from "react";
import { CircleCheck, MessagesSquare, TriangleAlert } from "lucide-react";
import { MISSING, formatInZone } from "@/lib/exec/format";
import { SLACK_COPY } from "@/lib/exec/slack-copy";
import type { SlackPickerTags } from "@/lib/exec/slack-page";
import { SLACK_RE, type SlackConnectResult, type SlackSettingsView } from "@/lib/exec/slack-types";
import { cn } from "@/lib/utils";
import { SectionCard } from "../SectionCard";
import { SlackConnectControls } from "./SlackConnectControls";
import { SlackReadingSection } from "./SlackReadingSection";

// The Settings page's Slack section (P6 contract §3.13, K15, C45, C48; Area
// E). Server and presentational: everything comes from the SlackSettingsView
// the page read (slack-settings.ts) and the ?slack= / ?who= the OAuth routes
// redirected with, validated here again. Every string is SLACK_COPY's; values
// are ids, scopes, times and codes, which React escapes like any text.
//
//   heading "Slack"; the result banner (connectResult[code], {who} only when
//   it is a Slack user id; only when it agrees with the state shown, see
//   slackResultBannerShown); then by state:
//     read failed     settingsReadFailed, nothing to click
//     !schema         settingsNotInstalled
//     !configured     settingsNotConfigured
//     not_connected   settingsIntro, Connect
//     connected/error the installation's rows (+ settingsError for error),
//                     Reconnect (in place, C48) and Disconnect
//     revoked         settingsRevoked (date, reason), Connect
//   Off the canonical host every Connect / Reconnect link becomes
//   settingsWrongHost (SlackConnectControls, C45).
//   P7a (contract §3.16): while connected (or error), the reading half
//   (SlackReadingSection, from view.reading) below the installation's rows and
//   their controls; nothing when the view carries none.
//
// Pure: no server-only import, so the page, tests and the static screenshot
// harness render it the same way.

type CopyResult = keyof typeof SLACK_COPY.connectResult;
// Compile-time: the copy has exactly one message per SlackConnectResult (both directions).
const COPY_MATCHES_RESULTS: [CopyResult] extends [SlackConnectResult] ? ([SlackConnectResult] extends [CopyResult] ? true : false) : false = true;
void COPY_MATCHES_RESULTS;

/** Every ?slack= code the Settings page shows a message for, in the copy's order. */
export const SLACK_CONNECT_RESULTS: readonly SlackConnectResult[] = Object.freeze(Object.keys(SLACK_COPY.connectResult) as SlackConnectResult[]);

const firstParam = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** ?slack=: a known SlackConnectResult (an own key of the copy, exact), else null (ignored). Takes Next's string | string[]. */
export function parseSlackResult(v: unknown): SlackConnectResult | null {
  const s = firstParam(v);
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(SLACK_COPY.connectResult, s) ? (s as SlackConnectResult) : null;
}

/** ?who=: a Slack user id (SLACK_RE.user), else null. Nothing else is ever shown from the query. */
export function parseSlackWho(v: unknown): string | null {
  const s = firstParam(v);
  return typeof s === "string" && SLACK_RE.user.test(s) ? s : null;
}

const fill = (template: string, key: string, value: string) => template.split(`{${key}}`).join(value);

/** P7a fixer ui-10: the reading states whose data a Disconnect also deletes (the confirm says so). */
const READING_LIVE: ReadonlySet<string> = new Set(["discovering", "paused", "on", "error"]);

/** The banner's words: connectResult[code], with {who} filled by a valid Slack user id (else "—"). */
export function slackResultText(result: SlackConnectResult, who: string | null | undefined): string {
  return fill(SLACK_COPY.connectResult[result], "who", parseSlackWho(who) ?? MISSING);
}

/** settingsRevoked with the date in his zone and the reason's label. */
export function slackRevokedText(view: Pick<SlackSettingsView, "revokedAt" | "revokeReason">, tz: string, now: string): string {
  const reason = view.revokeReason !== null && Object.prototype.hasOwnProperty.call(SLACK_COPY.revokeReasons, view.revokeReason) ? SLACK_COPY.revokeReasons[view.revokeReason] : MISSING;
  return fill(fill(SLACK_COPY.settingsRevoked, "date", formatInZone(view.revokedAt, tz, "date", now)), "reason", reason);
}

/** The state the section shows, a failed read first, then schema and configuration (data-slack-state). */
export function slackSectionState(view: SlackSettingsView): "read_failed" | "not_installed" | "not_configured" | SlackSettingsView["state"] {
  if (view.readFailed === true) return "read_failed";
  if (!view.schema) return "not_installed";
  if (!view.configured) return "not_configured";
  return view.state;
}

/**
 * Whether the ?slack= banner shows over this state. The query outlives what it reported (a refresh after Disconnect,
 * back/forward), so the banner must agree with what the section shows now:
 *   - "connected" only while the section shows a connection (connected or error);
 *   - never over a failed read (the section can't say what is true);
 *   - not when it would repeat the body: not_installed / not_configured over the same state, and wrong_host off the
 *     canonical host (settingsWrongHost already stands in for the link there);
 *   - P7a (fixer ui-4), by the reading half's state: "read_connected" only while it is still true and still asks him to
 *     act (discovering or paused: "turn reading on below"), and the read failure codes only while reading isn't set up
 *     (not discovering, paused or on). Without a reading state (no reading view) the read codes keep the P6 rule.
 */
export function slackResultBannerShown(result: SlackConnectResult, state: ReturnType<typeof slackSectionState>, onCanonicalHost: boolean,
  readingState?: NonNullable<SlackSettingsView["reading"]>["state"] | null): boolean {
  if (state === "read_failed") return false;
  if (result === "connected") return state === "connected" || state === "error";
  if (result === "read_connected") return readingState === undefined || readingState === null || readingState === "discovering" || readingState === "paused";
  if (READ_FAILURE_RESULTS.has(result) && (readingState === "discovering" || readingState === "paused" || readingState === "on")) return false;
  if (result === "not_installed" && state === "not_installed") return false;
  if (result === "not_configured" && state === "not_configured") return false;
  if (result === "wrong_host" && !onCanonicalHost) return false;
  return true;
}

function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 text-[12.5px]">
      <dt className="text-slate-600">{label}</dt>
      <dd className={cn("min-w-0 text-right font-medium text-ink", mono ? "break-all font-mono text-[11.5px]" : "break-words")}>{children}</dd>
    </div>
  );
}

/** The read consent's failure codes (P7a §3.17): stale once reading is set up. */
const READ_FAILURE_RESULTS: ReadonlySet<SlackConnectResult> = new Set<SlackConnectResult>(["read_not_connected", "missing_user_scopes", "extra_user_scopes", "read_taken"]);

/** The success codes (P7a fixer ui-4: read_connected is a success, not a warning). */
export const slackResultIsOk = (result: SlackConnectResult): boolean => result === "connected" || result === "read_connected";

function ResultBanner({ result, who }: { result: SlackConnectResult; who: string | null | undefined }) {
  const ok = slackResultIsOk(result);
  const Icon = ok ? CircleCheck : TriangleAlert;
  return (
    <div
      role="status"
      data-slack-result={result}
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[12.5px]",
        ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"
      )}
    >
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", ok ? "text-emerald-600" : "text-amber-600")} aria-hidden />
      <span className="min-w-0 break-words">{slackResultText(result, who)}</span>
    </div>
  );
}

const Note = ({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "body" }) => (
  <p className={cn("text-[12.5px] leading-relaxed", tone === "muted" ? "text-muted" : "text-slate-700")}>{children}</p>
);

export function SlackSection({
  view,
  result = null,
  who = null,
  onCanonicalHost = true,
  tz,
  now,
  confirmOpen = false,
  readingInitial = {},
  tags = null
}: {
  view: SlackSettingsView;
  /** The validated ?slack= code (parseSlackResult); null or unknown shows no banner. */
  result?: SlackConnectResult | null;
  /** The validated ?who= Slack user id, shown only in the wrong_user message. */
  who?: string | null;
  /** C45: the page was requested on the canonical host (isCanonicalRequestHost). */
  onCanonicalHost?: boolean;
  /** His zone and the page's one "now", for the dates. */
  tz: string;
  now: string;
  /** Static renders only (tests, screenshots): the Disconnect confirm open. */
  confirmOpen?: boolean;
  /** P7a, static renders only: a reading confirm open ("enable" / "stop"), its checkbox ticked, the finance confirm for a channel. */
  readingInitial?: { dialog?: "enable" | "stop" | null; checked?: boolean; financeConfirm?: string | null };
  /** P7b (§3.12.4, AM-P7b-6): the picker's client and project tags, passed to the reading half; null shows none. */
  tags?: SlackPickerTags | null;
}) {
  const state = slackSectionState(view);
  const banner =
    result !== null && parseSlackResult(result) !== null && slackResultBannerShown(result, state, onCanonicalHost, view.reading?.state ?? null)
      ? <ResultBanner result={result} who={who} />
      : null;

  let body: ReactNode;
  if (state === "read_failed") body = <Note tone="body">{SLACK_COPY.settingsReadFailed}</Note>;
  else if (state === "not_installed") body = <Note>{SLACK_COPY.settingsNotInstalled}</Note>;
  else if (state === "not_configured") body = <Note>{SLACK_COPY.settingsNotConfigured}</Note>;
  else if (state === "not_connected") {
    body = (
      <div className="space-y-3">
        <Note tone="body">{SLACK_COPY.settingsIntro}</Note>
        <SlackConnectControls mode="connect" onCanonicalHost={onCanonicalHost} />
      </div>
    );
  } else if (state === "revoked") {
    body = (
      <div className="space-y-3">
        <Note tone="body">{slackRevokedText(view, tz, now)}</Note>
        <SlackConnectControls mode="connect" onCanonicalHost={onCanonicalHost} />
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <dl data-slack-installation className="divide-y divide-slate-100">
          <Fact label="Workspace" mono>
            {view.teamId ?? MISSING}
          </Fact>
          <Fact label="DM channel" mono>
            {view.dmChannelId ?? MISSING}
          </Fact>
          <Fact label="Your Slack id" mono>
            {view.userId ?? MISSING}
          </Fact>
          <Fact label="Connected">{formatInZone(view.installedAt, tz, "datetime", now)}</Fact>
          <Fact label="Permissions">{view.scopes.length > 0 ? view.scopes.join(", ") : MISSING}</Fact>
          <Fact label="Last message handled">{view.lastDmAt ? formatInZone(view.lastDmAt, tz, "datetime", now) : "None yet"}</Fact>
        </dl>
        {state === "error" && (
          <div data-slack-error className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-900">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
            <span className="min-w-0 break-words">{fill(SLACK_COPY.settingsError, "code", view.lastErrorCode ?? MISSING)}</span>
          </div>
        )}
        <SlackConnectControls
          mode="manage"
          installationId={view.installationId}
          onCanonicalHost={onCanonicalHost}
          initialConfirm={confirmOpen}
          readingLive={view.reading !== undefined && READING_LIVE.has(view.reading.state)}
        />
        {view.reading !== undefined && (
          <SlackReadingSection
            view={view.reading}
            tz={tz}
            now={now}
            onCanonicalHost={onCanonicalHost}
            initialDialog={readingInitial.dialog ?? null}
            initialChecked={readingInitial.checked === true}
            initialFinanceConfirm={readingInitial.financeConfirm ?? null}
            tags={tags}
          />
        )}
      </div>
    );
  }

  return (
    <SectionCard title="Slack" icon={MessagesSquare} basis={state === "connected" || state === "error" || state === "revoked" ? "record" : undefined}>
      <div data-slack-section data-slack-state={state} className="space-y-3">
        {banner}
        {body}
      </div>
    </SectionCard>
  );
}
