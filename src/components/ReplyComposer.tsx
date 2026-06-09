"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Reply, Send, Loader2, X, CalendarClock, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// Inline reply panel that sits at the bottom of a thread detail. Folded
// into a "Reply" pill by default; expands into a Gmail-style composer
// on click. Submitting hits /api/inboxes/threads/[threadId]/reply and
// refreshes the thread so the new message appears in the list.

export function ReplyComposer({
  threadId, accountId, defaultTo, defaultSubject, replyAllTo, replyAllCc
}: {
  threadId: string;
  accountId: string;
  // Best-guess "to" — the last inbound sender. The server fills this
  // in automatically when omitted; we pre-fill the field so the user
  // can adjust it before sending.
  defaultTo: string | null;
  // Original thread subject; we prepend "Re: " if it's not already there.
  defaultSubject: string | null;
  // Reply-all recipient sets, pre-computed server-side (own address
  // already excluded), comma-joined. "Reply All" loads these into the
  // To / Cc fields. Empty string when there's nobody extra to reply to.
  replyAllTo?: string;
  replyAllCc?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // "reply" = sender only (default). "replyAll" loads replyAllTo/replyAllCc.
  const [mode, setMode] = useState<"reply" | "replyAll">("reply");
  const [to, setTo] = useState(defaultTo ?? "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(prefixRe(defaultSubject ?? ""));
  const [bodyText, setBodyText] = useState("");
  // Whether the Cc row is shown. Auto-revealed in reply-all mode or when
  // Cc has content; otherwise the user opens it via the "Add Cc" button.
  const [ccOpen, setCcOpen] = useState(false);

  // Whether reply-all has anyone beyond the default recipient. When the
  // thread has no extra To/Cc, hide the toggle entirely.
  const hasReplyAll = Boolean((replyAllTo ?? "").trim() || (replyAllCc ?? "").trim());

  function switchMode(next: "reply" | "replyAll") {
    setMode(next);
    if (next === "replyAll") {
      setTo((replyAllTo ?? "").trim() || to);
      setCc(replyAllCc ?? "");
      setCcOpen(true);
    } else {
      setTo(defaultTo ?? "");
      setCc("");
      setCcOpen(false);
    }
  }
  // Send-later state. `scheduleAt` is a datetime-local string ("");
  // when non-empty the Send button becomes "Schedule" and the POST
  // goes to the /schedule endpoint instead of /reply.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  // Reusing TaskMedia shape — same wire format as task attachments. The
  // server pulls each URL via /api/upload and forwards as multipart
  // files[] to the missive clone.
  const [attachments, setAttachments] = useState<TaskMedia[]>([]);

  // AI drafting state. `aiOpen` reveals an inline instruction box;
  // `aiBusy` blocks repeat clicks while the model is generating.
  // The model output replaces whatever's already in bodyText — we
  // confirm with the user if they've started typing.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiTone, setAiTone] = useState<"friendly" | "formal" | "concise">("friendly");
  const [aiBusy, setAiBusy] = useState(false);

  async function aiDraft() {
    if (aiBusy) return;
    if (bodyText.trim().length > 0) {
      const ok = window.confirm("Replace what you've already written with the AI draft?");
      if (!ok) return;
    }
    setAiBusy(true);
    try {
      const res = await fetch(
        `/api/inboxes/threads/${encodeURIComponent(threadId)}/ai-draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: aiInstruction.trim() || undefined, tone: aiTone })
        }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error ?? `Draft failed (${res.status})`);
        return;
      }
      setBodyText(data.bodyText ?? "");
      toast.success("Drafted — edit before sending");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setAiBusy(false);
    }
  }

  async function send() {
    const toList = to.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const ccList = cc.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (toList.length === 0) {
      toast.error("Add a recipient");
      return;
    }
    if (!bodyText.trim()) {
      toast.error("Write something before sending");
      return;
    }
    const scheduling = scheduleOpen && scheduleAt.trim().length > 0;
    let scheduledForISO: string | null = null;
    if (scheduling) {
      const at = new Date(scheduleAt);
      if (Number.isNaN(at.getTime())) {
        toast.error("Pick a valid send time");
        return;
      }
      if (at.getTime() <= Date.now()) {
        toast.error("Send time has to be in the future");
        return;
      }
      scheduledForISO = at.toISOString();
    }
    if (scheduling && attachments.length > 0) {
      toast.error("Attachments aren't supported on scheduled sends — remove them or send now.");
      return;
    }
    setBusy(true);
    try {
      const url = scheduling
        ? `/api/inboxes/threads/${encodeURIComponent(threadId)}/reply/schedule`
        : `/api/inboxes/threads/${encodeURIComponent(threadId)}/reply`;
      const body = scheduling
        ? { accountId, to: toList, cc: ccList, subject: subject.trim() || undefined, bodyText, scheduledForISO }
        : { accountId, to: toList, cc: ccList, subject: subject.trim() || undefined, bodyText, attachmentUrls: attachments };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      // Read as text first so HTML error pages (auth redirect, Next 500,
      // Railway 502 during deploy) don't crash JSON.parse — surface them
      // with a meaningful status code instead.
      const raw = await res.text();
      let data: { error?: string; ok?: boolean } = {};
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { /* leave data empty; we'll fall through to the status hint */ }
      if (!res.ok) {
        const hint = res.status === 401
          ? "Session expired — refresh the page"
          : res.status === 502 || res.status === 503
          ? "Missive backend unavailable — redeploy in progress?"
          : raw.startsWith("<")
          ? `Server returned HTML (status ${res.status}) — check the dev server logs`
          : data.error ?? `Send failed (status ${res.status})`;
        toast.error(hint);
        return;
      }
      if (scheduling && scheduledForISO) {
        const when = new Date(scheduledForISO).toLocaleString(undefined, {
          weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
        });
        toast.success(`Scheduled for ${when} ⏳`);
      } else {
        toast.success("Reply sent ✉️");
      }
      setBodyText("");
      setAttachments([]);
      setScheduleOpen(false);
      setScheduleAt("");
      setMode("reply");
      setCc("");
      setCcOpen(false);
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <AnimatePresence mode="wait" initial={false}>
        {!open ? (
          <motion.button
            key="trigger"
            type="button"
            onClick={() => setOpen(true)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
            className="w-full text-left flex items-center gap-2 px-4 py-3 rounded-2xl border border-slate-200/70 bg-white hover:bg-slate-50/70 hover:border-accent/30 transition-all group shadow-soft"
          >
            <div
              className="w-8 h-8 rounded-full grid place-items-center text-white shrink-0 shadow-sm transition-transform group-hover:scale-105"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
            >
              <Reply className="w-4 h-4" />
            </div>
            <span className="text-sm text-ink/65 flex-1 group-hover:text-ink transition-colors">
              Write a reply…
            </span>
            <span className="text-[10px] uppercase tracking-wide text-ink/45 font-semibold">
              Click to compose
            </span>
          </motion.button>
        ) : (
          <motion.div
            key="composer"
            initial={{ opacity: 0, y: 12, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.99 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="rounded-2xl border border-slate-200/70 bg-white shadow-lift overflow-hidden"
          >
            <header className="px-4 py-2.5 flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-blue-50/60 to-indigo-50/40">
              <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                <Reply className="w-3.5 h-3.5 text-accent" /> Reply
              </div>
              <div className="flex items-center gap-2">
                {hasReplyAll && (
                  <div className="inline-flex rounded-full bg-white/70 border border-slate-200/70 p-0.5">
                    {(["reply", "replyAll"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => switchMode(m)}
                        className={cn(
                          "px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors",
                          mode === m ? "bg-accent text-white" : "text-ink/65 hover:text-ink"
                        )}
                      >
                        {m === "reply" ? "Reply" : "Reply All"}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Discard"
                  className="p-1 rounded-lg text-ink/55 hover:text-ink hover:bg-white transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </header>

            <div className="p-3 space-y-2.5">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                  To
                </span>
                <input
                  type="text"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                  placeholder="recipient@example.com"
                  autoFocus
                />
                {!ccOpen && !cc.trim() && (
                  <button
                    type="button"
                    onClick={() => setCcOpen(true)}
                    className="text-[11px] font-semibold text-accent/80 hover:text-accent shrink-0"
                  >
                    Add Cc
                  </button>
                )}
              </div>

              {(ccOpen || cc.trim()) && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                    Cc
                  </span>
                  <input
                    type="text"
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                    placeholder="cc@example.com, …"
                  />
                </div>
              )}

              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                  Subject
                </span>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
                  placeholder="Re: …"
                />
              </div>

              {/* AI compose row — collapsed to a single pill by default.
                  Clicking expands into an instruction box + tone picker,
                  so the user can steer the draft without leaving the
                  composer. Output drops straight into the textarea below. */}
              <div className="rounded-xl border border-violet-200/60 bg-gradient-to-r from-violet-50/60 to-fuchsia-50/30">
                {!aiOpen ? (
                  <button
                    type="button"
                    onClick={() => setAiOpen(true)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[12px] font-medium text-violet-700 hover:text-violet-900 transition-colors"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      Compose with AI
                    </span>
                    <span className="text-[10px] text-violet-600/80">
                      Drafts a reply from the thread context
                    </span>
                  </button>
                ) : (
                  <div className="p-2.5 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-violet-800">
                        <Sparkles className="w-3.5 h-3.5" />
                        Compose with AI
                      </div>
                      <button
                        type="button"
                        onClick={() => setAiOpen(false)}
                        aria-label="Close AI compose"
                        className="p-0.5 rounded text-violet-600/70 hover:text-violet-900"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={aiInstruction}
                      onChange={(e) => setAiInstruction(e.target.value)}
                      placeholder="What should the reply say? (optional — e.g. 'thank them and confirm Friday')"
                      className="w-full text-[12.5px] bg-white border border-violet-200/70 rounded-lg px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-violet-300/60 focus:border-violet-400/60"
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void aiDraft(); } }}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <div className="inline-flex rounded-full bg-white/70 border border-violet-200/70 p-0.5">
                        {(["friendly", "formal", "concise"] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setAiTone(t)}
                            className={cn(
                              "px-2.5 py-0.5 rounded-full text-[11px] font-medium capitalize transition-colors",
                              aiTone === t ? "bg-violet-600 text-white" : "text-violet-700 hover:text-violet-900"
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => void aiDraft()}
                        disabled={aiBusy}
                        className={cn(
                          "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold text-white shadow-sm transition-all",
                          aiBusy ? "opacity-60 cursor-not-allowed" : "hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
                        )}
                        style={{ background: "linear-gradient(135deg, #7c3aed 0%, #c026d3 100%)" }}
                      >
                        {aiBusy
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : <Sparkles className="w-3 h-3" />}
                        {aiBusy ? "Drafting…" : "Generate"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                placeholder="Write your reply…"
                rows={7}
                className="w-full text-sm bg-white/60 border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-none transition-all"
              />

              <MediaPicker
                value={attachments}
                onChange={setAttachments}
                label="Attach files"
                compact
                hint={scheduleOpen ? "Attachments are not supported on scheduled sends." : undefined}
              />
            </div>

            <footer className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-between gap-2 bg-slate-50/60 flex-wrap">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScheduleOpen((v) => !v)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium border transition-colors",
                    scheduleOpen
                      ? "bg-white border-accent/40 text-accent"
                      : "bg-white/60 border-slate-200/70 text-ink/65 hover:text-ink hover:border-accent/40"
                  )}
                  title="Hold this reply until a specific time"
                >
                  <CalendarClock className="w-3.5 h-3.5" />
                  {scheduleOpen ? "Pick a time" : "Send later"}
                </button>
                {scheduleOpen && (
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className="px-2 py-1.5 rounded-lg bg-white border border-slate-200/70 text-[12px] outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
                  />
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setOpen(false); setBodyText(""); setAttachments([]); setScheduleOpen(false); setScheduleAt(""); setMode("reply"); setCc(""); setCcOpen(false); }}
                  className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={send}
                  disabled={busy}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95",
                    busy && "opacity-60 cursor-not-allowed hover:translate-y-0"
                  )}
                  style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
                >
                  {busy
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : scheduleOpen && scheduleAt
                      ? <CalendarClock className="w-3.5 h-3.5" />
                      : <Send className="w-3.5 h-3.5" />}
                  {busy
                    ? scheduleOpen && scheduleAt ? "Scheduling…" : "Sending…"
                    : scheduleOpen && scheduleAt ? "Schedule send" : "Send"}
                </button>
              </div>
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function prefixRe(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  return /^re:\s*/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
