import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listAccounts, listThreads, getThread } from "@/lib/missive-client";
import { runEmailIntake } from "@/lib/email-intake";
import { looksAutomated } from "@/lib/email-intake-filters";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Per-run cap so a misconfigured inbox can't pin the cron at the timeout
// limit. We just process the freshest DEFAULT_THREADS_PER_RUN threads per
// account — anything older eventually gets picked up by manual run-once.
// Override per-call with `?limit=N` when draining a backlog.
const DEFAULT_THREADS_PER_RUN = 25;

// GET /api/cron/email-intake — Vercel cron handler.
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>` (also
// supports our existing `?secret=` query-string convention so the route
// is debuggable from a browser).
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const querySecret = url.searchParams.get("secret");
    const ok =
      auth === `Bearer ${secret}` ||
      querySecret === secret;
    if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Backlog-drain knobs:
  //   ?silent=true   — suppress Slack DMs + auto-reply drafts. Tasks
  //                    still land in routing-review.
  //   ?limit=N       — per-account thread cap for this run. Defaults to
  //                    25 (the cron value); useful for catching up
  //                    after a scheduler outage without flooding.
  const silent = url.searchParams.get("silent") === "true";
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const threadsPerRun = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, DEFAULT_THREADS_PER_RUN * 4)
    : DEFAULT_THREADS_PER_RUN;

  const supabase = getSupabaseAdmin();

  // 1) Which accounts are opted into auto-intake?
  const { data: settings, error: settingsErr } = await supabase
    .from("missive_account_settings")
    .select("account_id, last_polled_at")
    .eq("auto_intake_enabled", true);
  if (settingsErr) {
    return NextResponse.json({ error: settingsErr.message }, { status: 500 });
  }
  const enabledIds = new Set((settings ?? []).map((s) => s.account_id));
  if (enabledIds.size === 0) {
    return NextResponse.json({ ok: true, processed: 0, accounts: 0 });
  }

  // 2) Resolve account metadata (display name, etc.) — also confirms the
  //    enabled IDs still correspond to live accounts.
  let accounts: Awaited<ReturnType<typeof listAccounts>> = [];
  try {
    accounts = await listAccounts();
  } catch (err) {
    return NextResponse.json(
      { error: `missive listAccounts failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
  const targetAccounts = accounts.filter((a) => enabledIds.has(a.id));

  // 3) Pull recent inbound threads. The clone's API doesn't filter by
  //    account, so we pull the workspace's open INBOX threads once and
  //    fan-out — getThread tells us which account each thread sits on.
  let threads: Awaited<ReturnType<typeof listThreads>> = [];
  try {
    threads = await listThreads({ folder: "INBOX", status: "open", limit: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: `missive listThreads failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  // Most-recent first so the per-account slice is the freshest mail.
  threads.sort((a, b) => (b.last_message_at > a.last_message_at ? 1 : -1));

  // 4) Skip already-handled threads up front (one query, not N).
  const { data: alreadyHandled } = await supabase
    .from("email_intake_log")
    .select("thread_id")
    .in("thread_id", threads.map((t) => t.id));
  const handled = new Set((alreadyHandled ?? []).map((r) => r.thread_id));
  const candidates = threads.filter((t) => !handled.has(t.id));

  // 5) Walk threads. For each, look up which account it belongs to (via
  //    the message account_id), then dispatch to the shared pipeline.
  const outcomes: Array<{
    threadId: string; accountId: string; result: "ok" | "skipped" | "error";
    routedVia?: string; taskId?: string; error?: string;
  }> = [];
  const perAccountCount = new Map<string, number>();

  for (const t of candidates) {
    if (outcomes.length >= threadsPerRun * targetAccounts.length) break;
    let detail: Awaited<ReturnType<typeof getThread>>;
    try {
      detail = await getThread(t.id);
    } catch (err) {
      outcomes.push({
        threadId: t.id, accountId: "?", result: "error",
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    // Inbound message tells us which account this thread is in.
    const inbound = detail.messages.find((m) => m.direction === "inbound");
    const accountId = inbound?.account_id ?? "";
    if (!accountId || !enabledIds.has(accountId)) continue;

    const used = perAccountCount.get(accountId) ?? 0;
    if (used >= threadsPerRun) continue;
    perAccountCount.set(accountId, used + 1);

    const fromEmail = inbound ? extractEmail(inbound.from_addr) : null;

    // Pre-classifier filter: skip obviously-automated threads (verification
    // codes, security alert digests, bounce notifications, etc.) before
    // they cost a Claude call + clutter the routing-review queue. Write a
    // dedupe row so the cron stops re-evaluating these on every pass.
    const auto = looksAutomated(fromEmail, t.subject);
    if (auto.filtered) {
      await supabase.from("email_intake_log").upsert(
        {
          thread_id: t.id,
          account_id: accountId,
          task_id: null,
          routed_via: "auto-filtered",
          routed_to_user_id: null,
          processed_at: new Date().toISOString()
        },
        { onConflict: "thread_id" }
      );
      outcomes.push({
        threadId: t.id, accountId, result: "skipped",
        error: `auto-filtered:${auto.reason ?? "unknown"}`
      });
      continue;
    }

    const bodyText = detail.messages
      .map((m) => `--- ${m.from_addr} @ ${m.sent_at} ---\n${m.body_text ?? stripHtml(m.body_html ?? "")}`)
      .join("\n\n");

    const missiveAppUrl = (process.env.MISSIVE_API_URL ?? "").replace(/\/$/, "");
    const missiveThreadUrl = missiveAppUrl
      ? `${missiveAppUrl}/?thread=${encodeURIComponent(t.id)}`
      : null;

    try {
      const outcome = await runEmailIntake({
        accountId,
        threadId: t.id,
        threadSubject: t.subject,
        threadBody: bodyText,
        fromEmail,
        missiveThreadUrl,
        source: "cron",
        silent
      });
      if (outcome.skipped) {
        outcomes.push({
          threadId: t.id, accountId, result: "skipped",
          error: outcome.skipped
        });
      } else {
        outcomes.push({
          threadId: t.id, accountId, result: "ok",
          taskId: outcome.taskId, routedVia: outcome.routedVia
        });
      }
    } catch (err) {
      outcomes.push({
        threadId: t.id, accountId, result: "error",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // 6) Bump per-account watermark so the dashboard shows the cron is alive.
  const now = new Date().toISOString();
  if (targetAccounts.length > 0) {
    await supabase
      .from("missive_account_settings")
      .update({ last_polled_at: now, updated_at: now })
      .in("account_id", targetAccounts.map((a) => a.id));
  }

  return NextResponse.json({
    ok: true,
    accounts: targetAccounts.length,
    inspected: candidates.length,
    processed: outcomes.filter((o) => o.result === "ok").length,
    skipped: outcomes.filter((o) => o.result === "skipped").length,
    errors: outcomes.filter((o) => o.result === "error").length,
    outcomes
  });
}

function extractEmail(addr: string): string | null {
  const m = addr.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase();
  if (addr.includes("@")) return addr.trim().toLowerCase();
  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
