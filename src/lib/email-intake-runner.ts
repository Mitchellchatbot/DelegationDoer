// Email-intake orchestration: single-thread processing + inbox poll loop.
// Used by:
//   - /api/cron/email-intake (scheduled poll)
//   - email-intake-bootstrap (real-time events + in-process cron on Railway)
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listAccounts, listThreads, getThread } from "@/lib/missive-client";
import { runEmailIntake } from "@/lib/email-intake";
import { looksAutomated } from "@/lib/email-intake-filters";
import { getRestrictedSenderRules, messagesMatch } from "@/lib/restricted-senders";
import {
  extractEmail,
  missiveThreadUrl,
  threadBodyFromMessages
} from "@/lib/email-intake-utils";

export const DEFAULT_THREADS_PER_RUN = 25;

export interface ThreadIntakeOutcome {
  threadId: string;
  accountId: string;
  result: "ok" | "skipped" | "error" | "disabled";
  routedVia?: string;
  taskId?: string;
  error?: string;
}

export interface PollEmailIntakeOptions {
  threadsPerRun?: number;
  silent?: boolean;
}

export interface PollEmailIntakeResult {
  ok: true;
  accounts: number;
  inspected: number;
  processed: number;
  skipped: number;
  errors: number;
  outcomes: ThreadIntakeOutcome[];
}

async function isAutoIntakeEnabled(accountId: string): Promise<boolean> {
  const { data } = await getSupabaseAdmin()
    .from("missive_account_settings")
    .select("auto_intake_enabled")
    .eq("account_id", accountId)
    .maybeSingle();
  return data?.auto_intake_enabled === true;
}

async function touchAccountPollWatermark(accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const now = new Date().toISOString();
  await getSupabaseAdmin()
    .from("missive_account_settings")
    .update({ last_polled_at: now, updated_at: now })
    .in("account_id", accountIds);
}

// Process one inbound thread through the auto-intake pipeline.
export async function processThreadForAutoIntake(input: {
  accountId: string;
  threadId: string;
  source?: "cron" | "event";
  silent?: boolean;
}): Promise<ThreadIntakeOutcome> {
  const { accountId, threadId, source = "event", silent = false } = input;

  if (!(await isAutoIntakeEnabled(accountId))) {
    return { threadId, accountId, result: "disabled" };
  }

  let detail: Awaited<ReturnType<typeof getThread>>;
  try {
    detail = await getThread(threadId);
  } catch (err) {
    return {
      threadId,
      accountId,
      result: "error",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const subject = detail.thread.subject;
  const inbound = detail.messages.find((m) => m.direction === "inbound");
  const fromEmail = inbound ? extractEmail(inbound.from_addr) : null;

  const auto = looksAutomated(fromEmail, subject);
  if (auto.filtered) {
    const supabase = getSupabaseAdmin();
    await supabase.from("email_intake_log").upsert(
      {
        thread_id: threadId,
        account_id: accountId,
        task_id: null,
        routed_via: "auto-filtered",
        routed_to_user_id: null,
        processed_at: new Date().toISOString()
      },
      { onConflict: "thread_id" }
    );
    return {
      threadId,
      accountId,
      result: "skipped",
      error: `auto-filtered:${auto.reason ?? "unknown"}`
    };
  }

  // Sender-scoped privacy (see src/lib/restricted-senders.ts). Restricted mail
  // must never become a team task, and — because we return BEFORE
  // runEmailIntake — never reaches writeRoutingDecision either, so no
  // classifier summary of it is persisted where leaders can read it.
  //
  // Deliberately redundant with the SENDER_PATTERNS entry in
  // email-intake-filters.ts: that list is hand-edited often, this is the
  // durable rule. If the two ever disagree, this catches it.
  const restricted = messagesMatch(detail.messages, await getRestrictedSenderRules());
  if (restricted) {
    const supabase = getSupabaseAdmin();
    await supabase.from("email_intake_log").upsert(
      {
        thread_id: threadId,
        account_id: accountId,
        task_id: null,
        routed_via: "restricted-sender",
        routed_to_user_id: null,
        processed_at: new Date().toISOString()
      },
      { onConflict: "thread_id" }
    );
    return {
      threadId,
      accountId,
      result: "skipped",
      error: `restricted-sender:${restricted.label}`
    };
  }

  try {
    const outcome = await runEmailIntake({
      accountId,
      threadId,
      threadSubject: subject,
      threadBody: threadBodyFromMessages(detail.messages),
      fromEmail,
      missiveThreadUrl: missiveThreadUrl(threadId),
      source,
      silent
    });

    await touchAccountPollWatermark([accountId]);

    if (outcome.skipped) {
      return { threadId, accountId, result: "skipped", error: outcome.skipped };
    }
    return {
      threadId,
      accountId,
      result: "ok",
      taskId: outcome.taskId,
      routedVia: outcome.routedVia
    };
  } catch (err) {
    return {
      threadId,
      accountId,
      result: "error",
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// Poll open INBOX threads and run auto-intake — same logic the Vercel
// cron used to own. Safe to call from an HTTP handler or node-cron.
export async function pollEmailIntake(
  options: PollEmailIntakeOptions = {}
): Promise<PollEmailIntakeResult> {
  const threadsPerRun = options.threadsPerRun ?? DEFAULT_THREADS_PER_RUN;
  const silent = options.silent ?? false;
  const supabase = getSupabaseAdmin();

  const { data: settings, error: settingsErr } = await supabase
    .from("missive_account_settings")
    .select("account_id, last_polled_at")
    .eq("auto_intake_enabled", true);
  if (settingsErr) throw new Error(settingsErr.message);

  const enabledIds = new Set((settings ?? []).map((s) => s.account_id));
  if (enabledIds.size === 0) {
    return {
      ok: true,
      accounts: 0,
      inspected: 0,
      processed: 0,
      skipped: 0,
      errors: 0,
      outcomes: []
    };
  }

  const accounts = await listAccounts();
  const targetAccounts = accounts.filter((a) => enabledIds.has(a.id));

  let threads = await listThreads({ folder: "INBOX", status: "open", limit: 200 });
  threads.sort((a, b) => (b.last_message_at > a.last_message_at ? 1 : -1));

  const { data: alreadyHandled } = await supabase
    .from("email_intake_log")
    .select("thread_id")
    .in("thread_id", threads.map((t) => t.id));
  const handled = new Set((alreadyHandled ?? []).map((r) => r.thread_id));
  const candidates = threads.filter((t) => !handled.has(t.id));

  const outcomes: ThreadIntakeOutcome[] = [];
  const perAccountCount = new Map<string, number>();

  for (const t of candidates) {
    if (outcomes.length >= threadsPerRun * targetAccounts.length) break;

    let detail: Awaited<ReturnType<typeof getThread>>;
    try {
      detail = await getThread(t.id);
    } catch (err) {
      outcomes.push({
        threadId: t.id,
        accountId: "?",
        result: "error",
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    const inbound = detail.messages.find((m) => m.direction === "inbound");
    const accountId = inbound?.account_id ?? "";
    if (!accountId || !enabledIds.has(accountId)) continue;

    const used = perAccountCount.get(accountId) ?? 0;
    if (used >= threadsPerRun) continue;
    perAccountCount.set(accountId, used + 1);

    const result = await processThreadForAutoIntake({
      accountId,
      threadId: t.id,
      source: "cron",
      silent
    });
    outcomes.push(result);
  }

  await touchAccountPollWatermark(targetAccounts.map((a) => a.id));

  return {
    ok: true,
    accounts: targetAccounts.length,
    inspected: candidates.length,
    processed: outcomes.filter((o) => o.result === "ok").length,
    skipped: outcomes.filter((o) => o.result === "skipped").length,
    errors: outcomes.filter((o) => o.result === "error").length,
    outcomes
  };
}
