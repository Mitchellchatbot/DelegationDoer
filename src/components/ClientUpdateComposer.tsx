"use client";

import { useEffect, useState } from "react";
import { Sparkles, Loader2, ArrowRight, Send, RefreshCw, Calendar, CheckSquare, MessageSquare, Clock, X, Wand2, Paintbrush, Eraser, AlignLeft, List, Code, Eye, Mail, Zap, Check } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getDepartmentMeta } from "@/lib/departments";
import { useCurrentUser } from "@/lib/user-context";
import { renderBlueEmail, type BrandedEmailContent } from "@/lib/email-template";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// Client Update composer, rendered as a per-client section on /clients/[id].
// The window is fixed by `presetDays` (set upstream by the tab that opened
// it; defaults to 7). The operator picks which completed / in-progress
// tasks to include (checkboxes in the preview), hits Generate -> the AI
// drafts ONE client-facing email PER DEPARTMENT from the selected tasks,
// the operator reviews/edits each, then Submit routes every draft to the
// existing approval queue (kind='client_update') tagged with its
// department so it lands with that department's head.
//
// Twin of ContentPlanComposer — same generate -> preview -> submit-for-approval
// flow and the same submit target (POST /api/email-drafts). The client is
// always locked (this only ever renders on a client page).

interface LockedClient {
  id: string;
  name: string;
  contactEmails: string[];
}

const DEFAULT_DAYS = 7;

// A connected sending mailbox (from GET /api/inboxes).
interface MailAccount {
  id: string;
  email: string;
  display_name?: string | null;
}

// AI editor action presets surfaced as a toolbar above each draft body.
type StyleMode = "rephrase" | "structured" | "casual" | "glanceable" | "fancy" | "plain" | "custom";

// One per-department draft the operator is reviewing before submit.
// Each is acted on independently (its own From mailbox, recipients, and
// submit/send action) and surfaced behind a top selector so the operator
// works one at a time.
interface DeptDraft {
  departmentId: string | null;
  departmentName: string;
  accountId: string; // the "From" mailbox for THIS draft (missiveclone account id)
  to: string;
  cc: string;
  bcc: string;
  showCcBcc: boolean;
  subject: string;
  body: string; // plain-text body — the editable source of truth for content
  bodyHtml: string | null; // brand-styled HTML when "fancy"; null = plain
  htmlContent: BrandedEmailContent | null; // structured content behind bodyHtml (for instant re-render)
  signoffName: string; // the name currently stamped in the sign-off (tracks the From mailbox)
  htmlTab: "preview" | "html"; // which view the styled draft shows
  styling: boolean; // an AI editor action is in flight for this draft
  acting: boolean; // a submit/send action is in flight for this draft
  status: "editing" | "submitted" | "sent"; // lifecycle for this single draft
  taskIds: string[];
}

// Day boundaries for a fixed N-day window, as ISO strings. `from` is the
// start of the day N days ago in UTC; `to` is "now" so today's completed
// work is included. UTC-aligned to match the /approvals recommendations
// endpoint (which uses the same UTC-midnight floor) so the per-row count
// there matches what the composer pulls in for the preview + draft.
function windowFor(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  from.setUTCHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

// The brand shown in a styled email's header band + footer. This is the
// SENDER (our agency mailbox), never the client. Prefer the mailbox's
// display name; fall back to its domain label, then a neutral default.
function senderBrandFor(acc?: MailAccount): string {
  if (!acc) return "Scaled";
  if (acc.display_name && acc.display_name.trim()) return acc.display_name.trim();
  const domain = acc.email?.split("@")[1]?.split(".")[0];
  if (domain) return domain.charAt(0).toUpperCase() + domain.slice(1);
  return acc.email || "Scaled";
}

// The name used in the email sign-off ("Best, <name>"). Tracks the
// selected From mailbox: its display name, else its email local part
// title-cased (chris.smith@… -> "Chris Smith").
function signoffNameFor(acc?: MailAccount): string {
  if (!acc) return "";
  if (acc.display_name && acc.display_name.trim()) return acc.display_name.trim();
  const local = acc.email?.split("@")[0];
  if (local) {
    return local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
  }
  return "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Swap the trailing sign-off name in a plain-text body (the body ends
// with "Best,\n<name>"). Only touches a trailing occurrence so a name
// that also appears mid-body is left alone. No-op if the old name isn't
// at the end (e.g. the operator hand-edited the sign-off).
function swapSignoff(body: string, prev: string, next: string): string {
  if (!prev || prev === next) return body;
  const re = new RegExp(escapeRegExp(prev) + "\\s*$");
  return re.test(body) ? body.replace(re, next) : body;
}

export function ClientUpdateComposer({
  lockedClient,
  presetDays,
  onSubmitted
}: {
  lockedClient: LockedClient;
  presetDays?: number;
  // Called after a successful submit-for-approval. Used by the
  // /approvals overlay modal to close itself + refresh the
  // recommendations list. On the client detail page this stays
  // undefined and the composer just resets to "compose" as before.
  onSubmitted?: () => void;
}) {
  // Window is fixed for the lifetime of this composer instance —
  // picked upstream (the /approvals tab the user is on; falls back
  // to DEFAULT_DAYS when rendered standalone on the client page).
  // The user already chose the window before opening this; we don't
  // re-ask here.
  const days = presetDays && presetDays > 0 ? presetDays : DEFAULT_DAYS;

  const me = useCurrentUser();
  // Heuristic gate for the "Send now" (bypass-approval) button. The
  // approve route is the real authority and enforces per-department
  // rules; this just hides the button from people who definitely can't
  // self-send (regular members / the client's plain point-person).
  const canSendDirect = me.role === "leader" || !!me.isAdmin || me.role === "department_head";

  const [generating, setGenerating] = useState(false);
  // Tasks the operator has checked in the preview. Only these feed the
  // draft(s). Defaults to "all" each time the preview (re)loads.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Per-department drafts the AI returned, edited in place before submit.
  const [drafts, setDrafts] = useState<DeptDraft[]>([]);
  // Which draft's editor is currently shown (the top selector tab).
  const [activeIdx, setActiveIdx] = useState(0);
  const [scheduledFor, setScheduledFor] = useState(""); // blank = send on approval
  const [attachments, setAttachments] = useState<TaskMedia[]>([]);
  const [step, setStep] = useState<"compose" | "preview">("compose");

  // Connected sending mailboxes for the per-draft "From" picker. Loaded
  // once. When none are connected the picker shows a connect hint and the
  // send path falls back to the author's mailbox (resolved server-side).
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/inboxes", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setAccounts(Array.isArray(j?.inboxes) ? j.inboxes : []);
      })
      .catch(() => { /* picker just shows the connect hint */ });
    return () => { cancelled = true; };
  }, []);

  // Point a draft at a From mailbox, re-deriving everything that tracks
  // the sender: the sign-off name (in both the plain body and, if the
  // draft is a styled email, the HTML), and the brand in the styled
  // header/footer. The styled HTML is re-rendered from its stored
  // structured content — but only when it hasn't been hand-edited
  // (current HTML still matches a fresh render), so manual HTML tweaks
  // are never clobbered.
  function applyAccountToDraft(d: DeptDraft, accId: string): DeptDraft {
    const acc = accounts.find((a) => a.id === accId);
    const newName = signoffNameFor(acc) || me.name;
    const newBrand = senderBrandFor(acc);
    const body = swapSignoff(d.body, d.signoffName, newName);
    let bodyHtml = d.bodyHtml;
    let htmlContent = d.htmlContent;
    if (d.htmlContent && d.bodyHtml && d.bodyHtml === renderBlueEmail(d.htmlContent)) {
      htmlContent = { ...d.htmlContent, brandName: newBrand, signoff: `Best,\n${newName}` };
      bodyHtml = renderBlueEmail(htmlContent);
    }
    return { ...d, accountId: accId, signoffName: newName, body, bodyHtml, htmlContent };
  }

  function changeAccount(idx: number, accId: string) {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? applyAccountToDraft(d, accId) : d)));
  }

  // Backfill the From mailbox on any draft that doesn't have one yet,
  // once the connected accounts load (drafts can be generated before the
  // /api/inboxes round-trip finishes).
  useEffect(() => {
    if (accounts.length === 0) return;
    setDrafts((prev) =>
      prev.some((d) => !d.accountId)
        ? prev.map((d) => (d.accountId ? d : applyAccountToDraft(d, accounts[0].id)))
        : prev
    );
    // applyAccountToDraft is a stable transform over the same closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  function toggleTask(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generate() {
    if (selectedIds.size === 0) {
      return toast.error("Select at least one task to include");
    }
    const window = windowFor(days);
    setGenerating(true);
    try {
      const res = await fetch("/api/client-update/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: lockedClient.id,
          clientName: lockedClient.name,
          from: window.from,
          to: window.to,
          taskIds: [...selectedIds]
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      // Graceful empty state — nothing completed among the selection.
      // Stay on the compose step and nudge instead of a hollow email.
      if (data.empty) {
        toast.message(data.message ?? "No completed work in this selection.");
        return;
      }
      const incoming = Array.isArray(data.drafts) ? data.drafts : [];
      if (incoming.length === 0) {
        toast.message("Nothing to draft from this selection.");
        return;
      }
      setDrafts(incoming.map((d: {
        departmentId: string | null; departmentName: string;
        subject?: string; body?: string; suggestedTo?: string[]; taskIds?: string[];
      }) => {
        // The draft route signs the body with the caller's name; point it
        // at the default From mailbox so the sign-off matches the sender
        // from the start.
        const base: DeptDraft = {
          departmentId: d.departmentId ?? null,
          departmentName: d.departmentName ?? "General",
          accountId: "",
          to: (d.suggestedTo ?? lockedClient.contactEmails ?? []).join(", "),
          cc: "",
          bcc: "",
          showCcBcc: false,
          subject: d.subject ?? "",
          body: d.body ?? "",
          bodyHtml: null,
          htmlContent: null,
          signoffName: me.name,
          htmlTab: "preview",
          styling: false,
          acting: false,
          status: "editing",
          taskIds: Array.isArray(d.taskIds) ? d.taskIds : []
        };
        return accounts[0]?.id ? applyAccountToDraft(base, accounts[0].id) : base;
      }));
      setActiveIdx(0);
      setStep("preview");
    } catch (err) {
      toast.error(`Couldn't draft: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      setGenerating(false);
    }
  }

  function patchDraft(idx: number, patch: Partial<DeptDraft>) {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function removeDraft(idx: number) {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
    // Keep the active tab in range after a drop.
    setActiveIdx((cur) => Math.max(0, cur > idx ? cur - 1 : cur >= drafts.length - 1 ? drafts.length - 2 : cur));
  }

  // AI editor action on a single draft body. Sends the current plain-text
  // body to /api/client-update/style and applies the rewrite (and, for
  // "fancy"/styled drafts, the brand-blue HTML) back in place.
  async function applyStyle(idx: number, mode: StyleMode, instruction?: string) {
    const d = drafts[idx];
    if (!d || d.styling) return;
    if (mode === "plain" && !d.bodyHtml) return; // nothing to strip
    // Brand + sign-off both follow the selected From mailbox — the email
    // is sent FROM our mailbox TO the client.
    const acc = accounts.find((a) => a.id === d.accountId);
    const senderName = signoffNameFor(acc) || me.name;
    patchDraft(idx, { styling: true });
    try {
      const res = await fetch("/api/client-update/style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          instruction: instruction ?? "",
          bodyText: d.body,
          hasHtml: !!d.bodyHtml,
          clientName: lockedClient.name,
          senderBrand: senderBrandFor(acc),
          senderName,
          subject: d.subject
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      patchDraft(idx, {
        body: typeof data.bodyText === "string" && data.bodyText ? data.bodyText : d.body,
        bodyHtml: typeof data.bodyHtml === "string" ? data.bodyHtml : null,
        htmlContent: (data.htmlContent && typeof data.htmlContent === "object") ? data.htmlContent as BrandedEmailContent : null,
        signoffName: senderName,
        htmlTab: "preview"
      });
    } catch (err) {
      toast.error(`AI edit failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      patchDraft(idx, { styling: false });
    }
  }

  function resetComposer() {
    setStep("compose");
    setDrafts([]);
    setAttachments([]);
    setScheduledFor("");
  }

  // Split a comma/semicolon/space-separated address field into a clean array.
  function parseEmails(s: string): string[] {
    return s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  }

  // Validate one draft + build its POST payload. Returns null (after
  // toasting) if anything is missing so the caller can bail.
  function buildPayloadFor(d: DeptDraft): Record<string, unknown> | null {
    if (!d.subject.trim() || !d.body.trim()) {
      toast.error(`${d.departmentName}: subject and body are required`);
      return null;
    }
    const toArr = parseEmails(d.to);
    if (toArr.length === 0) {
      toast.error(`${d.departmentName}: add at least one recipient email`);
      return null;
    }
    return {
      clientId: lockedClient.id,
      clientName: lockedClient.name,
      accountId: d.accountId || undefined,
      to: toArr,
      cc: parseEmails(d.cc),
      bcc: parseEmails(d.bcc),
      subject: d.subject.trim(),
      bodyText: d.body.trim(),
      bodyHtml: d.bodyHtml || undefined,
      kind: "client_update",
      departmentId: d.departmentId,
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      mediaUrls: attachments,
      taskIds: d.taskIds
    };
  }

  // After a draft resolves (submitted/sent), either finish the whole
  // batch (when none are left to act on) or hop to the next editable
  // draft. `list` is the post-update draft array.
  function finishOrAdvance(list: DeptDraft[]) {
    const remaining = list.findIndex((d) => d.status === "editing");
    if (remaining === -1) {
      // Everything is resolved — reset, then notify (the modal closes on
      // this; resetting first avoids a setState on an unmounting tree).
      resetComposer();
      onSubmitted?.();
    } else {
      setActiveIdx(remaining);
    }
  }

  // Submit a single draft to the approval queue.
  async function submitOne(idx: number) {
    const d = drafts[idx];
    if (!d || d.acting || d.status !== "editing") return;
    const payload = buildPayloadFor(d);
    if (!payload) return;
    patchDraft(idx, { acting: true });
    try {
      const res = await fetch("/api/email-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      const delivered = (data.slackDeliveries ?? []).filter((s: { delivered: boolean }) => s.delivered).length;
      toast.success(
        delivered > 0
          ? `${d.departmentName} submitted — ${delivered} approver ping${delivered === 1 ? "" : "s"}`
          : `${d.departmentName} submitted for approval`
      );
      const resolved = drafts.map((x, i) => (i === idx ? { ...x, status: "submitted" as const, acting: false } : x));
      setDrafts(resolved);
      finishOrAdvance(resolved);
    } catch (err) {
      toast.error(`${d.departmentName}: ${err instanceof Error ? err.message : "failed"}`);
      patchDraft(idx, { acting: false });
    }
  }

  // Send-now: create the draft, then immediately approve it (which fires
  // the outbound send) — bypassing the approval queue. The approve route
  // enforces permissions, so a non-approver gets a clear error rather than
  // a silent send. Honors the "Send on" schedule: a future date just
  // approves + queues for the scheduled-emails cron.
  async function sendOne(idx: number) {
    const d = drafts[idx];
    if (!d || d.acting || d.status !== "editing") return;
    const payload = buildPayloadFor(d);
    if (!payload) return;
    const scheduled = !!scheduledFor;
    patchDraft(idx, { acting: true });
    try {
      const createRes = await fetch("/api/email-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const created = await createRes.json();
      if (!createRes.ok) throw new Error(created?.error ?? `create failed (${createRes.status})`);

      const apprRes = await fetch(`/api/email-drafts/${created.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: d.accountId || undefined })
      });
      const appr = await apprRes.json();
      if (!apprRes.ok) throw new Error(appr?.error ?? `send failed (${apprRes.status})`);
      const wasQueued = appr.status === "approved" && scheduled;
      toast.success(wasQueued ? `${d.departmentName} queued for the scheduled send` : `${d.departmentName} sent directly`);
      const resolved = drafts.map((x, i) =>
        i === idx ? { ...x, status: (wasQueued ? "submitted" : "sent") as DeptDraft["status"], acting: false } : x
      );
      setDrafts(resolved);
      finishOrAdvance(resolved);
    } catch (err) {
      toast.error(`${d.departmentName}: ${err instanceof Error ? err.message : "failed"}`);
      patchDraft(idx, { acting: false });
    }
  }

  // The draft whose editor is currently shown, plus a few footer flags.
  const activeDraft = drafts[activeIdx];
  const anyActing = drafts.some((d) => d.acting);

  return (
    <section className="rounded-2xl border border-sky-200/60 bg-gradient-to-br from-sky-50/50 to-white shadow-soft overflow-hidden">
      <header className="px-5 py-3 border-b border-sky-200/40 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-sky-500 text-white grid place-items-center shadow-sm">
          <Send className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">Client update composer</div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            Pick the work to include; the AI drafts one update per department for {lockedClient.name} and routes each to its head.
          </div>
        </div>
      </header>

      {step === "compose" ? (
        <div className="p-4 space-y-3">
          <ComposerPreview
            clientName={lockedClient.name}
            days={days}
            selected={selectedIds}
            onToggle={toggleTask}
            onLoadedIds={(ids) => setSelectedIds(new Set(ids))}
          />

          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-ink/55">
              {selectedIds.size} task{selectedIds.size === 1 ? "" : "s"} selected
            </div>
            <button
              type="button"
              onClick={generate}
              disabled={generating || selectedIds.size === 0}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                (generating || selectedIds.size === 0) && "opacity-50 cursor-not-allowed hover:translate-y-0"
              )}
              style={{ background: "linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)" }}
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {generating ? "Drafting…" : "Generate draft"}
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-sky-700/85 bg-sky-50 border border-sky-200/60 rounded-lg px-2.5 py-1.5">
            <Sparkles className="w-3 h-3" />
            {drafts.length === 1
              ? "AI drafted — edit anything before submitting, or send it directly."
              : `AI drafted ${drafts.length} updates, one per department — handle each on its own tab below.`}
          </div>

          {/* Per-department selector — work one draft at a time so you can
              send one and submit another independently. */}
          {drafts.length > 1 && (
            <div className="flex items-center justify-center">
              <div className="inline-flex items-center gap-1 p-1 rounded-full bg-slate-100/80 border border-slate-200/70">
                {drafts.map((d, i) => {
                  const active = i === activeIdx;
                  return (
                    <button
                      key={`tab-${d.departmentId ?? "general"}-${i}`}
                      type="button"
                      onClick={() => setActiveIdx(i)}
                      className={cn(
                        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-semibold transition-colors",
                        active ? "bg-white text-ink shadow-sm" : "text-ink/55 hover:text-ink"
                      )}
                    >
                      {d.departmentName}
                      {d.status === "sent" && <Check className="w-3 h-3 text-emerald-600" />}
                      {d.status === "submitted" && <Clock className="w-3 h-3 text-sky-600" />}
                      {d.acting && <Loader2 className="w-3 h-3 animate-spin text-sky-600" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {drafts.map((d, idx) => {
            if (idx !== activeIdx) return null; // only the selected draft is shown
            const meta = getDepartmentMeta(d.departmentId ?? undefined);
            const resolved = d.status !== "editing";
            return (
              <div key={`${d.departmentId ?? "general"}-${idx}`} className="rounded-xl border border-slate-200/70 bg-white p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn(
                      "inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-semibold",
                      meta.chip
                    )}>
                      {d.departmentName}
                    </span>
                    <span className="text-[10px] text-ink/50">
                      {d.taskIds.length > 0
                        ? `${d.taskIds.length} task${d.taskIds.length === 1 ? "" : "s"} · routes to ${d.departmentName} head`
                        : `Progress update · routes to ${d.departmentName} head`}
                    </span>
                  </div>
                  {drafts.length > 1 && !resolved && (
                    <button
                      type="button"
                      onClick={() => removeDraft(idx)}
                      className="text-ink/35 hover:text-rose-600 transition-colors p-1"
                      title="Drop this department's draft"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {resolved && (
                  <div className={cn(
                    "flex items-center gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border",
                    d.status === "sent"
                      ? "text-emerald-700 bg-emerald-50 border-emerald-200/60"
                      : "text-sky-700 bg-sky-50 border-sky-200/60"
                  )}>
                    {d.status === "sent" ? <Check className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                    {d.status === "sent" ? "Sent directly to the client." : "Submitted for approval."}
                  </div>
                )}

                <Field label="From">
                  <Mail className="w-3 h-3 text-ink/45" />
                  {accounts.length > 0 ? (
                    <select
                      value={d.accountId}
                      onChange={(e) => changeAccount(idx, e.target.value)}
                      disabled={resolved}
                      className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 cursor-pointer disabled:cursor-default disabled:text-ink/55"
                    >
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.display_name ? `${a.display_name} · ${a.email}` : a.email}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="flex-1 text-[12px] text-ink/45">
                      Sends from your connected mailbox. <a href="/inboxes" className="text-sky-700 font-medium hover:underline">Connect one</a> to choose.
                    </span>
                  )}
                </Field>

                <Field label="To">
                  <input
                    type="text"
                    value={d.to}
                    onChange={(e) => patchDraft(idx, { to: e.target.value })}
                    placeholder="recipient@client.com, second@client.com"
                    className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35"
                  />
                  {!d.showCcBcc && (
                    <button
                      type="button"
                      onClick={() => patchDraft(idx, { showCcBcc: true })}
                      className="text-[10px] font-semibold text-sky-700/80 hover:text-sky-700 shrink-0"
                    >
                      Cc/Bcc
                    </button>
                  )}
                </Field>
                {d.showCcBcc && (
                  <>
                    <Field label="Cc">
                      <input
                        type="text"
                        value={d.cc}
                        onChange={(e) => patchDraft(idx, { cc: e.target.value })}
                        placeholder="cc@client.com"
                        className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35"
                      />
                    </Field>
                    <Field label="Bcc">
                      <input
                        type="text"
                        value={d.bcc}
                        onChange={(e) => patchDraft(idx, { bcc: e.target.value })}
                        placeholder="bcc@internal.com"
                        className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 placeholder:text-ink/35"
                      />
                    </Field>
                  </>
                )}
                <Field label="Subject">
                  <input
                    type="text"
                    value={d.subject}
                    onChange={(e) => patchDraft(idx, { subject: e.target.value })}
                    className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0 font-medium"
                  />
                </Field>

                {/* AI editor toolbar — rewrites this draft's body in place. */}
                <div className="rounded-xl border border-sky-200/60 bg-sky-50/40 p-2 space-y-2">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wide font-semibold text-sky-700/80 inline-flex items-center gap-1 mr-0.5">
                      <Wand2 className="w-3 h-3" /> AI editor
                    </span>
                    <StyleBtn icon={RefreshCw} disabled={d.styling} onClick={() => applyStyle(idx, "rephrase")}>Rephrase</StyleBtn>
                    <StyleBtn icon={List} disabled={d.styling} onClick={() => applyStyle(idx, "structured")}>Structured</StyleBtn>
                    <StyleBtn icon={MessageSquare} disabled={d.styling} onClick={() => applyStyle(idx, "casual")}>Casual</StyleBtn>
                    <StyleBtn icon={AlignLeft} disabled={d.styling} onClick={() => applyStyle(idx, "glanceable")}>Glanceable</StyleBtn>
                    <StyleBtn icon={Paintbrush} disabled={d.styling} primary onClick={() => applyStyle(idx, "fancy")}>
                      {d.bodyHtml ? "Restyle" : "Make fancy"}
                    </StyleBtn>
                    {d.bodyHtml && (
                      <StyleBtn icon={Eraser} disabled={d.styling} onClick={() => applyStyle(idx, "plain")}>Remove formatting</StyleBtn>
                    )}
                    {d.styling && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-600 ml-0.5" />}
                  </div>
                  <CustomInstruction disabled={d.styling} onApply={(text) => applyStyle(idx, "custom", text)} />
                </div>

                {/* Body editor: plain textarea, or a styled-HTML preview/source
                    pair once the draft is "fancy". */}
                {d.bodyHtml ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1">
                      <TabBtn active={d.htmlTab === "preview"} icon={Eye} onClick={() => patchDraft(idx, { htmlTab: "preview" })}>Preview</TabBtn>
                      <TabBtn active={d.htmlTab === "html"} icon={Code} onClick={() => patchDraft(idx, { htmlTab: "html" })}>HTML</TabBtn>
                      <span className="ml-auto text-[10px] text-sky-700/70 inline-flex items-center gap-1">
                        <Mail className="w-3 h-3" /> Sends as a styled email
                      </span>
                    </div>
                    {d.htmlTab === "preview" ? (
                      <iframe
                        title={`${d.departmentName} preview`}
                        srcDoc={d.bodyHtml}
                        sandbox=""
                        className="w-full h-[420px] rounded-xl border border-slate-200/70 bg-white"
                      />
                    ) : (
                      <textarea
                        value={d.bodyHtml}
                        onChange={(e) => patchDraft(idx, { bodyHtml: e.target.value })}
                        rows={16}
                        spellCheck={false}
                        className="w-full text-[11px] font-mono bg-white border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-200/40 focus:border-sky-400/50 resize-y leading-relaxed"
                      />
                    )}
                    <div className="text-[10px] text-ink/45">
                      Edit the wording with the AI buttons or the HTML tab. Use Remove formatting to go back to plain text.
                    </div>
                  </div>
                ) : (
                  <textarea
                    value={d.body}
                    onChange={(e) => patchDraft(idx, { body: e.target.value })}
                    rows={14}
                    className="w-full text-[13px] bg-white border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-200/40 focus:border-sky-400/50 resize-y leading-relaxed"
                  />
                )}
              </div>
            );
          })}

          {/* Shared send date + attachments apply to every draft in the batch. */}
          <Field label="Send on">
            <Calendar className="w-3 h-3 text-ink/45" />
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="flex-1 text-[13px] bg-transparent border-none outline-none focus:ring-0"
            />
            <span className="text-[10px] text-ink/45 shrink-0">
              {scheduledFor ? "queued until this date" : "sends immediately on approval"}
            </span>
          </Field>

          <div>
            <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 mb-1.5">
              Attachments
            </div>
            <MediaPicker
              value={attachments}
              onChange={setAttachments}
              label="Attach files"
              compact
              hint={scheduledFor ? "Attachments are dropped on scheduled sends — clear the send date to keep them." : undefined}
            />
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setStep("compose")}
              disabled={anyActing}
              className="inline-flex items-center gap-1.5 text-[12px] text-ink/65 hover:text-ink px-2 py-1 disabled:opacity-50"
            >
              ← Back to selection
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={generate}
                disabled={generating || anyActing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-sky-700 bg-white border border-sky-200/70 hover:bg-sky-50 transition-colors disabled:opacity-50"
              >
                {generating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Re-draft
              </button>
              {activeDraft && activeDraft.status === "editing" && (
                <>
                  {canSendDirect && (
                    <button
                      type="button"
                      onClick={() => sendOne(activeIdx)}
                      disabled={activeDraft.acting}
                      title="Send this update directly, skipping the approval queue"
                      className={cn(
                        "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold text-sky-700 bg-white border border-sky-300 hover:bg-sky-50 transition-all active:scale-95",
                        activeDraft.acting && "opacity-60 cursor-not-allowed"
                      )}
                    >
                      {activeDraft.acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                      {scheduledFor ? "Schedule send" : "Send now"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => submitOne(activeIdx)}
                    disabled={activeDraft.acting}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 active:scale-95",
                      activeDraft.acting && "opacity-60 cursor-not-allowed hover:translate-y-0"
                    )}
                    style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
                  >
                    {activeDraft.acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    {drafts.length === 1 ? "Submit for approval" : `Submit ${activeDraft.departmentName}`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white">
      <span className="text-[10px] uppercase tracking-wide font-semibold text-ink/55 w-16 shrink-0">{label}</span>
      {children}
    </div>
  );
}

// A single AI-editor preset button in the toolbar.
function StyleBtn({
  icon: Icon, children, onClick, disabled, primary
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        primary
          ? "bg-sky-600 text-white border-sky-600 hover:bg-sky-700"
          : "bg-white text-sky-700 border-sky-200/80 hover:bg-sky-50"
      )}
    >
      <Icon className="w-3 h-3" />
      {children}
    </button>
  );
}

// Preview / HTML-source toggle for a styled draft.
function TabBtn({
  active, icon: Icon, children, onClick
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors",
        active ? "bg-sky-100 text-sky-700" : "text-ink/55 hover:text-ink hover:bg-slate-50"
      )}
    >
      <Icon className="w-3 h-3" />
      {children}
    </button>
  );
}

// Free-text "ask AI to edit" box. Holds its own input state so typing
// doesn't re-render the whole draft list; submits on Enter or the button.
function CustomInstruction({
  onApply, disabled
}: {
  onApply: (text: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  function apply() {
    const t = text.trim();
    if (!t || disabled) return;
    onApply(t);
    setText("");
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }}
        placeholder="Ask AI to edit… (e.g. shorten, add a warm intro, emphasize the launch)"
        disabled={disabled}
        className="flex-1 text-[12px] bg-white border border-sky-200/70 rounded-full px-3 py-1.5 outline-none focus:ring-2 focus:ring-sky-200/40 placeholder:text-ink/35 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={apply}
        disabled={disabled || !text.trim()}
        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold text-white bg-sky-600 hover:bg-sky-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
      >
        <Wand2 className="w-3 h-3" /> Apply
      </button>
    </div>
  );
}

interface PreviewTask {
  id: string;
  title: string;
  completedAt: string | null;
  assigneeName: string | null;
  tags: string[];
  departmentId: string | null;
  departmentName: string | null;
}

interface PreviewInProgress {
  id: string;
  title: string;
  status: string;
  assigneeName: string | null;
  tags: string[];
  lastActivityAt: string | null;
  departmentId: string | null;
  departmentName: string | null;
}

interface PreviewData {
  tasks: PreviewTask[];
  tasksInProgress: PreviewInProgress[];
  eodNotes: Array<{
    authorName: string;
    noteDate: string;
    workedOn: string | null;
    accomplished: string | null;
  }>;
}

// Live preview of what the AI will summarize: completed tasks in the
// window, work still in progress, + EOD notes from teammates who closed
// those tasks. Each task carries a checkbox so the operator controls
// exactly which work feeds the draft(s); a department chip shows which
// per-department draft (and which head) the task will route to. EOD
// notes stay visible as read-only context. Refetches whenever the
// window (days) changes; on (re)load every task starts selected.
function ComposerPreview({
  clientName, days, selected, onToggle, onLoadedIds
}: {
  clientName: string;
  days: number;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onLoadedIds: (ids: string[]) => void;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Resolve the (from, to) ISO pair the same way the real Generate
    // path does, so the preview matches exactly what will feed the AI.
    const window = windowFor(days);
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({
      clientName,
      from: window.from,
      to: window.to
    });
    fetch(`/api/client-update/preview?${qs}`, { cache: "no-store" })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return;
        if (!ok) {
          setError(j?.error ?? "preview failed");
          setData(null);
        } else {
          const tasks: PreviewTask[] = j.tasks ?? [];
          const tasksInProgress: PreviewInProgress[] = j.tasksInProgress ?? [];
          setData({ tasks, tasksInProgress, eodNotes: j.eodNotes ?? [] });
          // Default every task selected on load.
          onLoadedIds([...tasks.map((t) => t.id), ...tasksInProgress.map((t) => t.id)]);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "preview failed");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Re-run only when the window (days) or client changes. onLoadedIds is
    // a stable setter-wrapper from the parent and intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientName, days]);

  return (
    <div className="rounded-xl border border-slate-200/70 bg-white p-3 space-y-3">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-ink/55">
        Pick what the AI will summarize
      </div>
      {loading ? (
        <div className="text-[11px] text-ink/55 inline-flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading context…
        </div>
      ) : error ? (
        <div className="text-[11px] text-rose-700">{error}</div>
      ) : !data || (data.tasks.length === 0 && data.tasksInProgress.length === 0 && data.eodNotes.length === 0) ? (
        <div className="text-[11px] text-ink/55 italic">
          Nothing completed, in progress, or noted by contributors in this window. Widen the range or pick a different period.
        </div>
      ) : (
        <div className="space-y-3">
          {data.tasks.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5 inline-flex items-center gap-1">
                <CheckSquare className="w-3 h-3" />
                Completed tasks · {data.tasks.length}
              </div>
              <ul className="space-y-1">
                {data.tasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    checked={selected.has(t.id)}
                    onToggle={onToggle}
                    departmentName={t.departmentName}
                    departmentId={t.departmentId}
                    metaLine={
                      <>
                        {t.assigneeName && <span>{t.assigneeName}</span>}
                        {t.completedAt && (
                          <>
                            {t.assigneeName && <span>·</span>}
                            <span className="tabular-nums">{t.completedAt.slice(0, 10)}</span>
                          </>
                        )}
                      </>
                    }
                    tags={t.tags}
                  />
                ))}
              </ul>
            </div>
          )}
          {data.tasksInProgress.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5 inline-flex items-center gap-1">
                <Clock className="w-3 h-3" />
                In progress · {data.tasksInProgress.length}
              </div>
              <ul className="space-y-1">
                {data.tasksInProgress.map((t) => (
                  <TaskRow
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    checked={selected.has(t.id)}
                    onToggle={onToggle}
                    departmentName={t.departmentName}
                    departmentId={t.departmentId}
                    metaLine={
                      <>
                        {t.status && (
                          <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px]">
                            {t.status.replace(/_/g, " ")}
                          </span>
                        )}
                        {t.assigneeName && <span>{t.assigneeName}</span>}
                        {t.lastActivityAt && (
                          <>
                            {t.assigneeName && <span>·</span>}
                            <span className="tabular-nums">{t.lastActivityAt.slice(0, 10)}</span>
                          </>
                        )}
                      </>
                    }
                    tags={t.tags}
                  />
                ))}
              </ul>
            </div>
          )}
          {data.eodNotes.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold mb-1.5 inline-flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                EOD notes from contributors · {data.eodNotes.length}
              </div>
              <ul className="space-y-2">
                {data.eodNotes.slice(0, 5).map((n, idx) => (
                  <li key={`${n.authorName}-${n.noteDate}-${idx}`} className="text-[11.5px] text-ink/75 leading-relaxed">
                    <div className="text-[10px] text-ink/55 font-semibold mb-0.5">
                      {n.authorName} · <span className="tabular-nums">{n.noteDate}</span>
                    </div>
                    {n.workedOn && (
                      <div><span className="text-ink/55">Worked on: </span>{n.workedOn}</div>
                    )}
                    {n.accomplished && (
                      <div><span className="text-ink/55">Accomplished: </span>{n.accomplished}</div>
                    )}
                  </li>
                ))}
                <li className="text-[10px] text-ink/45 italic">
                  EOD notes from contributors on the selected tasks are folded into the draft as context (author names withheld; only client-relevant content is used).
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A single selectable task row in the preview. Checkbox + title + a meta
// line (assignee/date/status) + a department chip showing where it routes.
function TaskRow({
  id, title, checked, onToggle, metaLine, tags, departmentName, departmentId
}: {
  id: string;
  title: string;
  checked: boolean;
  onToggle: (id: string) => void;
  metaLine: React.ReactNode;
  tags: string[];
  departmentName: string | null;
  departmentId: string | null;
}) {
  const meta = getDepartmentMeta(departmentId ?? undefined);
  return (
    <li>
      <label className="flex items-start gap-2 cursor-pointer rounded-lg px-1 py-0.5 hover:bg-slate-50">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(id)}
          className="mt-0.5 w-3.5 h-3.5 rounded border-slate-300 text-sky-600 focus:ring-sky-400/40 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="font-medium text-[12px] text-ink/80 truncate">{title}</span>
            <span className={cn(
              "inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-full border font-medium shrink-0",
              meta.chip
            )}>
              {departmentName ?? "General"}
            </span>
          </span>
          <span className="text-[10px] text-ink/50 flex items-center gap-1.5 flex-wrap">
            {metaLine}
            {tags.slice(0, 3).map((tag) => (
              <span key={tag} className="px-1.5 py-0.5 rounded-full bg-slate-100 text-ink/65 text-[9px]">{tag}</span>
            ))}
          </span>
        </span>
      </label>
    </li>
  );
}
