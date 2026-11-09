import "server-only";

import { logAccess } from "@/lib/exec/access";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import { getBriefHomeLine } from "@/lib/exec/brief-view";
import type { AttentionFeedItem, ScreenedAttentionPage } from "@/lib/exec/attention-types";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { DDTEXT_AI_KINDS } from "@/lib/exec/ddtext-types";
import { getEmailTab, type EmailTabView } from "@/lib/exec/email-view";
import { appOrigin, isAllowedLinkUrl } from "@/lib/exec/refs";
import { loadSettings } from "@/lib/exec/principal";
import { dmSetHome, errLabel, ownSignal } from "@/lib/exec/slack-dm";
import { openInstallationById, recordSlackError } from "@/lib/exec/slack-install";
import { SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { SlackHomePayload } from "@/lib/exec/slack-types";
import { renderNeutralHome, renderOwnerHome, type OwnerHomeBrief, type OwnerHomeInput } from "@/lib/exec/slack-ui";
import { NonRetryableError, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-home (P6 contract §3.11.4, K13, C28-C30, C40; Area D): App Home
// on app_home_opened. Interactive lane, 30 s, two attempts (RPC 1 enqueues it,
// one per installation, user and minute). Ownership is recomputed here from
// the installation (the RPC's choice isn't trusted): Mitchell gets his
// screened summary, anyone else the neutral view and nothing else (C30).
// Attention is read only through P5a's screened accessor (S3, never
// listAttention). Every Home link is absolute: appOrigin() + a DD path (C28).

export type SlackHomeResult = { skipped: string } | { view: "neutral" } | { view: "owner"; items: number };

const KIND = SLACK_JOB_KINDS.home;
const ATTENTION_PATH = "/executive/attention";

export function parseHomePayload(raw: unknown): SlackHomePayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.slack_user_id !== "string" || !SLACK_RE.user.test(p.slack_user_id)) return null;
  return { installation_id: p.installation_id, slack_user_id: p.slack_user_id };
}

/** C28: the item's first DD ref with an allow-listed DD URL, else the attention page; always absolute on appOrigin(). */
export function homeItemHref(item: Pick<AttentionFeedItem, "refs">): string {
  const origin = appOrigin();
  for (const ref of Array.isArray(item?.refs) ? item.refs : []) {
    if (ref?.system !== "dd" || typeof ref.url !== "string") continue;
    if (isAllowedLinkUrl(ref.url) && ref.url.startsWith(`${origin}/`)) return ref.url;
  }
  return `${origin}${ATTENTION_PATH}`;
}

/** One section read, bounded by its own timer (setTimeout, so it is fakeable), its failure or timeout as `null`. */
type Bounded<T> = { ok: true; value: T } | { ok: false };

async function bounded<T>(label: string, run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<Bounded<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("The Home section took too long", "TimeoutError"));
      resolve({ ok: false });
    }, ms);
  });
  const read = run(controller.signal).then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => {
      console.warn(`[exec-slack] home ${label} unavailable (${errLabel(err)})`);
      return { ok: false as const };
    }
  );
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function attentionSection(r: Bounded<ScreenedAttentionPage>): OwnerHomeInput["attention"] {
  if (!r.ok) return { ok: false };
  const page = r.value;
  const items = (Array.isArray(page.items) ? page.items : []).slice(0, SLACK_LIMITS.homeItems).map((item) => ({
    band: item.priority?.band ?? "normal",
    title: typeof item.title === "string" ? item.title : "",
    href: homeItemHref(item),
    // DD text read by a model (blocker / waiting / decision) carries the web's AI-assessed label (P5a plan §2 rule 6).
    aiAssessed: (DDTEXT_AI_KINDS as readonly string[]).includes(item.kind)
  }));
  return { ok: true, items, hiddenEmail: Number.isFinite(page.hiddenEmail) ? page.hiddenEmail : 0, emailScreen: page.emailScreen };
}

function emailSection(r: Bounded<EmailTabView>): OwnerHomeInput["email"] {
  if (!r.ok) return { state: "on", counts: null, restricted: null };
  const tab = r.value;
  if (tab.state !== "on") return { state: tab.state };
  const counts = tab.buckets.ok
    ? { reply: tab.buckets.data.counts.reply, urgent: tab.buckets.data.counts.urgent, important: tab.buckets.data.counts.important, waiting: tab.buckets.data.counts.waiting }
    : null;
  return { state: "on", counts, restricted: tab.restricted.ok ? tab.restricted.data : null };
}

/** getEmailTab takes no signal (its own 15 s timeout): raced against the 8 s timer; the losing read finishes on its own. */
function emailRead(principal: ExecPrincipal, now: Date): (signal: AbortSignal) => Promise<EmailTabView> {
  return () => {
    const read = getEmailTab(principal, now);
    // A read that loses the race and then fails must not surface as an unhandled rejection.
    read.catch(() => undefined);
    return read;
  };
}

/** P8: getBriefHomeLine takes no signal; raced against the 8 s timer like the email read (a late failure is swallowed). */
function briefRead(principal: ExecPrincipal, now: Date): (signal: AbortSignal) => Promise<OwnerHomeBrief> {
  return () => {
    const read = loadSettings(principal.id).then((settings) => getBriefHomeLine(principal, settings, now));
    read.catch(() => undefined);
    return read;
  };
}

async function runHome(ctx: JobContext): Promise<SlackHomeResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const p = parseHomePayload(ctx.job.payload);
  if (!p) return { skipped: "bad_payload" };
  // 1.
  let inst;
  try {
    inst = await openInstallationById(principal, p.installation_id);
  } catch (err) {
    if (err instanceof SecretUnavailableError) {
      await recordSlackError(p.installation_id, "token_unavailable");
      throw new NonRetryableError("slack token unavailable", "auth");
    }
    throw err;
  }
  if (!inst) return { skipped: "installation" };
  // 2. Recomputed from the installation (HM05).
  const owner = p.slack_user_id === inst.row.userId;
  // 3. C30: anyone else sees the neutral view, nothing more.
  if (!owner) {
    await dmSetHome(inst, p.slack_user_id, renderNeutralHome(), { signal: ownSignal() });
    return { view: "neutral" };
  }
  // 4. C40: one access-log row per owner render.
  await logAccess({
    principalId: principal.id,
    authUserId: null,
    sessionId: null,
    ip: null,
    userAgent: null,
    route: "slack:app_home_opened",
    surface: "slack",
    slackUserId: inst.row.userId,
    slackEventId: null
  });
  const now = new Date();
  const [attention, email, brief] = await Promise.all([
    // P7a (§3.14, §3.20.3): App Home is a Slack surface, so finance items stay off it.
    bounded("attention", (signal) => listScreenedAttention(principal, { status: "default", limit: SLACK_LIMITS.homeItems }, { now, signal, surface: "slack" }), SLACK_LIMITS.homeSectionTimeoutMs),
    bounded("email", emailRead(principal, now), SLACK_LIMITS.homeSectionTimeoutMs),
    // P8 (§3.21.3, K13): the brief's line inside the same 8 s section budget; a failure renders P6's neutral line (null).
    bounded("brief", briefRead(principal, now), SLACK_LIMITS.homeSectionTimeoutMs)
  ]);
  const input: OwnerHomeInput = {
    attention: attentionSection(attention),
    email: emailSection(email),
    updatedAt: now.toISOString(),
    timezone: principal.timezone,
    brief: brief.ok ? brief.value : null
  };
  // 5.
  await dmSetHome(inst, inst.row.userId, renderOwnerHome(input), { signal: ownSignal() });
  return { view: "owner", items: input.attention.ok ? input.attention.items.length : 0 };
}

export const SLACK_HOME_TIMEOUT_MS = SLACK_LIMITS.homeTimeoutMs;

export const slackHomeJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: SLACK_HOME_TIMEOUT_MS,
  run: (ctx: JobContext) => runHome(ctx)
};
