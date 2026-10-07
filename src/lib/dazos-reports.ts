import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getThread, fetchAttachment, listThreads, type MissiveMessage } from "@/lib/missive-client";

// Dazos daily VOB reports → the AWFMP dashboard.
//
// Dazos emails two CSVs a day. The moment one lands (missive-webhook), the
// attachment is streamed out of the mail clone and POSTed to the dashboard's
// ingest endpoint; /api/cron/dazos-reports sweeps for anything the webhook
// missed or that failed with a retryable error.
//
// Only these two reports are forwarded — subject must mention META VOB AND
// name a campaign. Any other Dazos mail is ignored.
//
// The endpoint upserts on the CSV's own row keys, so re-posting the same
// report is harmless. That is why retrying is safe and why the log below is
// for visibility rather than correctness.

export const DAZOS_SENDER = "noreply@dazos.com";

const DEFAULT_INGEST_URL =
  "https://awfmp-dashboard-production.up.railway.app/api/ingest/dazos-vobs?client=quest-2-recovery";

export type Campaign = "q2r" | "qbh";

// Subject gate. Both halves must match: the report family, and a campaign.
// "VOBS" and "VOB'S" both contain "META VOB", which is why the test is that
// loose — the apostrophe varies between the two mails.
export function campaignFor(subject: string): Campaign | null {
  const s = (subject ?? "").toUpperCase();
  if (!s.includes("META VOB")) return null;
  if (s.includes("Q2R")) return "q2r";
  if (s.includes("QBH")) return "qbh";
  return null;
}

const isCsv = (a: { filename: string; content_type: string }) =>
  /\.csv$/i.test(a.filename ?? "") || /csv/i.test(a.content_type ?? "");

const isDazos = (m: MissiveMessage) =>
  m.direction === "inbound" && (m.from_addr ?? "").toLowerCase().includes(DAZOS_SENDER);

// 400 / 401 / 404 are our mistakes (wrong campaign, bad secret, unknown
// client), per the endpoint's contract — retrying just repeats them, so they
// are parked as `rejected` for a human. 5xx and network errors are `failed`
// and the sweep picks them up.
const isPermanent = (status: number) => status === 400 || status === 401 || status === 404;

interface PushRow {
  attachmentId: string;
  messageId: string;
  threadId: string | null;
  subject: string;
  campaign: Campaign;
  filename: string;
  sizeBytes: number;
}

// POST one attachment. Returns true when the endpoint took it.
async function push(row: PushRow): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const secret = process.env.DASHBOARD_INGEST_SECRET ?? "";
  const url = process.env.DAZOS_INGEST_URL || DEFAULT_INGEST_URL;
  const now = new Date().toISOString();

  // Claim the row first, so the attachment is never silently lost if the push
  // throws: a crash leaves it `pending`/`failed` for the sweep to find.
  await supabase.from("dazos_report_pushes").upsert({
    attachment_id: row.attachmentId,
    message_id: row.messageId,
    thread_id: row.threadId,
    subject: row.subject,
    campaign: row.campaign,
    filename: row.filename,
    size_bytes: row.sizeBytes,
    status: "pending",
    updated_at: now
  }, { onConflict: "attachment_id", ignoreDuplicates: true });

  const fail = async (patch: Record<string, unknown>) => {
    await supabase.rpc("dazos_push_attempt", { p_attachment_id: row.attachmentId });
    await supabase.from("dazos_report_pushes")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("attachment_id", row.attachmentId);
    return false;
  };

  if (!secret) {
    return fail({ status: "rejected", error: "DASHBOARD_INGEST_SECRET is not set" });
  }

  try {
    const file = await fetchAttachment(row.attachmentId);
    if (!file.ok) {
      return fail({ status: "failed", error: `couldn't read the attachment (${file.status})` });
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) {
      return fail({ status: "failed", error: "the attachment was empty" });
    }

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "text/csv" }), row.filename || `${row.campaign}.csv`);
    form.append("report", row.subject);

    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
      cache: "no-store"
    });
    const body = (await res.text().catch(() => "")).slice(0, 2000);

    if (res.ok) {
      await supabase.from("dazos_report_pushes").update({
        status: "pushed",
        http_status: res.status,
        response: body,
        error: null,
        attempts: 1,
        pushed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        size_bytes: bytes.byteLength
      }).eq("attachment_id", row.attachmentId);
      return true;
    }
    return fail({
      status: isPermanent(res.status) ? "rejected" : "failed",
      http_status: res.status,
      response: body,
      error: `endpoint returned ${res.status}`
    });
  } catch (err) {
    return fail({ status: "failed", error: err instanceof Error ? err.message : String(err) });
  }
}

// Every CSV on a Dazos report message that hasn't been pushed yet.
async function pendingFrom(messages: MissiveMessage[], threadId: string | null): Promise<PushRow[]> {
  const rows: PushRow[] = [];
  for (const m of messages) {
    if (!isDazos(m)) continue;
    const campaign = campaignFor(m.subject ?? "");
    if (!campaign) continue;
    for (const a of m.attachments ?? []) {
      if (!isCsv(a)) continue;
      rows.push({
        attachmentId: a.id,
        messageId: m.id,
        threadId,
        subject: m.subject ?? "",
        campaign,
        filename: a.filename,
        sizeBytes: a.size_bytes ?? 0
      });
    }
  }
  if (rows.length === 0) return [];

  // Skip anything already delivered or parked. `failed` rows fall through on
  // purpose — that is the retry.
  const { data: seen } = await getSupabaseAdmin()
    .from("dazos_report_pushes")
    .select("attachment_id, status")
    .in("attachment_id", rows.map((r) => r.attachmentId));
  const done = new Set((seen ?? [])
    .filter((s) => s.status === "pushed" || s.status === "rejected")
    .map((s) => s.attachment_id as string));
  return rows.filter((r) => !done.has(r.attachmentId));
}

export interface PushResult { pushed: number; failed: number; skipped: number }

// Called from the missive webhook for every inbound message. Cheap and silent
// for the ~all of mail that isn't a Dazos report.
export async function handleDazosMessage(threadId: string, messageId: string): Promise<PushResult> {
  const empty = { pushed: 0, failed: 0, skipped: 0 };
  try {
    const detail = await getThread(threadId);
    const message = detail.messages.find((m) => m.id === messageId);
    if (!message || !isDazos(message) || !campaignFor(message.subject ?? "")) return empty;

    const rows = await pendingFrom([message], threadId);
    if (rows.length === 0) return { ...empty, skipped: 1 };
    let pushed = 0, failed = 0;
    for (const r of rows) (await push(r)) ? pushed++ : failed++;
    return { pushed, failed, skipped: 0 };
  } catch {
    // Never let this break mail ingestion — the sweep is the backstop.
    return empty;
  }
}

// Safety net: re-scan recent mail for reports the webhook never saw, and retry
// anything that failed with a retryable error.
export async function sweepDazosReports(limit = 40): Promise<PushResult> {
  const result: PushResult = { pushed: 0, failed: 0, skipped: 0 };
  const threads = await listThreads({ folder: "INBOX", limit });
  for (const t of threads) {
    // Cheap filter before paying for the thread fetch.
    if (!campaignFor(t.subject ?? "")) continue;
    const detail = await getThread(t.id);
    const rows = await pendingFrom(detail.messages, t.id);
    for (const r of rows) (await push(r)) ? result.pushed++ : result.failed++;
  }
  return result;
}
