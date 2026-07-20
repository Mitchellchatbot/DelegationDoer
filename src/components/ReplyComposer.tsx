"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Reply, Send, Loader2, X, CalendarClock, Sparkles, Check, Maximize2, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MediaPicker } from "@/components/MediaPicker";
import { RecipientAutocomplete } from "@/components/RecipientAutocomplete";
import type { ClientSuggestion } from "@/components/RecipientAutocomplete";
import { useInboxFocus } from "@/components/InboxFocusProvider";
import { useRecipientSuggestions } from "@/lib/use-recipient-suggestions";
import { fetchDeferredBody } from "@/lib/message-body-cache";
import type { TaskMedia } from "@/lib/types";
import type { MissiveMessage } from "@/lib/missive-client";
import { rawEmail, shortName } from "@/lib/email-format";

// Inline reply panel that sits at the bottom of a thread detail. Folded
// into a "Reply" pill by default; expands into a Gmail-style composer
// on click. Submitting hits /api/inboxes/threads/[threadId]/reply and
// refreshes the thread so the new message appears in the list.

function escapeHtml(s: string): string {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Plain textarea text → minimal HTML for the body (the user types plain text;
// the quote we append is HTML, so the whole body becomes HTML on send).
function plainTextToHtml(t: string): string {
  return escapeHtml(t || "").replace(/\n/g, "<br/>");
}

// Browser-only HTML → text, for the plain-text MIME alternative. Called from
// send() (a click handler), never during SSR/render.
function htmlToText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.innerText;
}

// Gmail-style attribution date, e.g. "Fri, Jun 12, 2026 at 3:10 AM".
function formatQuoteDate(d: Date): string {
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

// Build a Gmail-standard quoted block for the message being replied to. Matches
// missiveclone's composer markup byte-for-byte (outer div.gmail_quote,
// div.gmail_attr attribution, blockquote.gmail_quote with Gmail's inline style)
// so replies sent from either app render — and collapse — identically.
function buildReplyQuoteHtml(m: MissiveMessage): string {
  if (!m) return "";
  const when = m.sent_at ? formatQuoteDate(new Date(m.sent_at)) : "";
  const who = escapeHtml(m.from_addr || "");
  const inner = m.body_html || escapeHtml(m.body_text || "").replace(/\n/g, "<br/>");
  return `<br/><br/><div class="gmail_quote">` +
    `<div dir="ltr" class="gmail_attr">On ${escapeHtml(when)} ${who} wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${inner}</blockquote>` +
    `</div>`;
}

// Wrap the quote in a minimal sandboxed document for the composer preview, so
// the quoted email's own CSS can't leak into the composer layout.
function buildQuoteDoc(quoteHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    body{margin:0;padding:8px 10px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:13px;line-height:1.5;color:#475467}
    img{max-width:100% !important;height:auto !important} a{color:#2f6feb}
    blockquote{border-left:1px solid #ccc;margin:0 0 0 .8ex;padding-left:1ex}
  </style></head><body>${quoteHtml || ""}</body></html>`;
}

// A "To" token only counts as a real recipient once it's a COMPLETE address:
// a non-empty local part, an "@", and a dotted domain. Mid-typing fragments
// like "charles.s" (no "@") are incomplete, so the recipient guardrail ignores
// them instead of flagging them as strangers.
function isCompleteEmail(addr: string): boolean {
  const at = addr.indexOf("@");
  if (at <= 0) return false;
  const domain = addr.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

// Our own side of a conversation — connected inboxes plus our domains. The
// in-thread mismatch guardrail uses this to decide who counts as an "external"
// party, so a colleague's inbox in the thread never looks like a misfire.
const OWN_DOMAINS = ["scaledai.org", "scaledai.com"];

export function ReplyComposer({
  threadId, accountId, defaultTo, defaultSubject, replyAllTo, replyAllCc,
  replyTarget, onClearReplyTarget, quoteSource, accounts, threadAddresses, threadParticipants
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
  // A specific message in the chain the user clicked "Reply" on. When set we
  // open the composer, pre-fill To/subject from it, and thread the reply under
  // it (via its RFC message_id). null = default composer (threads to latest).
  replyTarget?: MissiveMessage | null;
  // Clears the pinned target back to the default (reply-to-latest).
  onClearReplyTarget?: () => void;
  // The message to quote (the pinned target, or the latest message for a
  // thread-level reply). Drives the collapsed "•••" quote below the textarea.
  quoteSource?: MissiveMessage | null;
  // Connected accounts (access-scoped) the user may send FROM. Powers the
  // "From" selector; defaults to the thread's inbox (`accountId`).
  accounts?: { id: string; email: string; display_name: string | null }[];
  // Every email address that appears anywhere in this thread (lower-cased,
  // display-names stripped). Powers the pre-send guardrail that warns when a
  // reply's "To" contains someone who isn't part of the conversation. When
  // absent/empty the guardrail stays silent (fails open).
  threadAddresses?: string[];
  // This thread's own participants (name + email) as pick-able typeahead
  // suggestions, so the user can address a reply to someone already in the
  // conversation instead of hand-typing. Merged ahead of the global roster.
  threadParticipants?: ClientSuggestion[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Focus Mode — collapses the inbox rail + thread list so the composer gets
  // the whole content area (see InboxFocusProvider). Only meaningful while the
  // composer is expanded; every path that leaves the composer clears it below.
  const { focusMode, setFocusMode } = useInboxFocus();
  // To/Cc typeahead roster (saved clients + team inboxes), shared verbatim with
  // the main Compose window. Loaded once the composer is expanded.
  const recipientSuggestions = useRecipientSuggestions(open);

  // Never leave the rail/list collapsed once this composer is gone (thread
  // switch remounts it — ThreadConversation is keyed by threadId).
  useEffect(() => () => setFocusMode(false), [setFocusMode]);
  // Collapsing the composer back to the pill also exits focus mode.
  useEffect(() => { if (!open) setFocusMode(false); }, [open, setFocusMode]);
  // "reply" = sender only (default). "replyAll" loads replyAllTo/replyAllCc.
  const [mode, setMode] = useState<"reply" | "replyAll">("reply");
  const [to, setTo] = useState(defaultTo ?? "");
  const [cc, setCc] = useState("");
  // Which connected account the reply is sent FROM. Defaults to the thread's
  // inbox; the component remounts per-thread (key={threadId}) so this resets on
  // thread switch. The options are the user's access-scoped accounts.
  const fromOptions = accounts ?? [];
  const [fromAccountId, setFromAccountId] = useState(accountId);
  const [subject, setSubject] = useState(prefixRe(defaultSubject ?? ""));
  const [bodyText, setBodyText] = useState("");
  // Whether the Cc row is shown. Auto-revealed in reply-all mode or when
  // Cc has content; otherwise the user opens it via the "Add Cc" button.
  const [ccOpen, setCcOpen] = useState(false);

  // Whether reply-all has anyone beyond the default recipient. When the
  // thread has no extra To/Cc, hide the toggle entirely.
  const hasReplyAll = Boolean((replyAllTo ?? "").trim() || (replyAllCc ?? "").trim());

  // Recipient guardrail. `knownAddrs` = every address already in this thread;
  // any "To" entry outside it is a "stranger" (not part of the conversation) —
  // the signal that catches the Chris Barnes → Charles Smellie class of misfire
  // (a reply to one person addressed to someone from a different thread). We
  // fail OPEN when the thread has no known addresses, so a data gap never blocks
  // sending. `confirmedStrangerSigRef` records the exact stranger set the user
  // OK'd via "Send anyway", so an acknowledged send isn't re-challenged.
  const confirmedStrangerSigRef = useRef<string>("");
  const knownAddrs = new Set((threadAddresses ?? []).map((a) => a.toLowerCase()));
  const strangerRecipients: string[] = [];
  if (knownAddrs.size > 0) {
    const seen = new Set<string>();
    for (const part of to.split(/[,\n]/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const email = rawEmail(trimmed).toLowerCase();
      // Only flag COMPLETE addresses — a half-typed fragment like "charles.s"
      // (rawEmail returns it unchanged, no "@") is not a stranger, just unfinished.
      if (!email || !isCompleteEmail(email) || knownAddrs.has(email) || seen.has(email)) continue;
      seen.add(email);
      strangerRecipients.push(rawEmail(trimmed));
    }
  }
  const strangerSig = strangerRecipients.map((a) => a.toLowerCase()).sort().join(",");

  // Typeahead roster: this thread's own participants first (so the user can pick
  // "Charles Smellie <…>" / "Chris Hintz <…>" instead of hand-typing), then the
  // global saved-clients + team roster.
  const suggestions = useMemo(
    () => [...(threadParticipants ?? []), ...recipientSuggestions],
    [threadParticipants, recipientSuggestions]
  );

  // email(lower) -> display name, from this thread's participants. Used to label
  // the "Sending to" preview so a bare address in the To line is recognisable.
  const nameByEmail = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of threadParticipants ?? []) {
      const e = (s.contactEmails[0] ?? "").toLowerCase();
      if (e) map.set(e, s.name);
    }
    return map;
  }, [threadParticipants]);

  // Resolved recipients for the "Sending to" line — every COMPLETE address in
  // the To field, labelled with its thread name when we know it. Incomplete
  // mid-typing tokens are skipped so the line stays quiet while typing.
  const toPreview = useMemo(() => {
    const seen = new Set<string>();
    const out: { email: string; label: string }[] = [];
    for (const part of to.split(/[,\n]/)) {
      const t = part.trim();
      if (!t) continue;
      const email = rawEmail(t);
      const key = email.toLowerCase();
      if (!isCompleteEmail(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ email, label: nameByEmail.get(key) ?? shortName(t) });
    }
    return out;
  }, [to, nameByEmail]);

  // In-thread mismatch guardrail: in a thread with >=2 EXTERNAL parties, warn
  // when you've clicked Reply on one specific message but the person that
  // message is with isn't in the To line — the "replied to Charles's message,
  // addressed to Chris" trap the stranger check can't catch (both are in-thread).
  const confirmedMismatchSigRef = useRef<string>("");
  const mismatch = useMemo(() => {
    if (!replyTarget) return null;
    const ownAddrs = new Set(
      (accounts ?? []).map((a) => rawEmail(a.email).toLowerCase()).filter(Boolean)
    );
    const isOwn = (e: string) => ownAddrs.has(e) || OWN_DOMAINS.some((d) => e.endsWith("@" + d));
    const externals = new Set(
      (threadAddresses ?? []).filter((a) => isCompleteEmail(a) && !isOwn(a))
    );
    if (externals.size < 2) return null;
    const targetRaw =
      replyTarget.direction === "outbound"
        ? (replyTarget.to_addrs[0] ?? "")
        : replyTarget.from_addr;
    const email = rawEmail(targetRaw).toLowerCase();
    if (!isCompleteEmail(email) || isOwn(email)) return null;
    const toSet = new Set<string>();
    for (const part of to.split(/[,\n]/)) {
      const e = rawEmail(part.trim()).toLowerCase();
      if (isCompleteEmail(e)) toSet.add(e);
    }
    if (toSet.has(email)) return null;
    return { name: shortName(targetRaw), email: rawEmail(targetRaw) };
  }, [replyTarget, threadAddresses, accounts, to]);
  const mismatchSig = mismatch ? mismatch.email.toLowerCase() : "";

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

  // RFC Message-ID of the message we're replying to, when the user pinned a
  // specific one via its per-message Reply button. null = thread under the
  // latest message (server default). Sent as `inReplyTo` on both send paths.
  const [inReplyTo, setInReplyTo] = useState<string | null>(null);
  // The quoted-original block (Gmail-standard HTML), shown below the textarea
  // behind a collapsed "•••" toggle and appended to the body on send. Kept out
  // of `bodyText` so drafts/AI-compose stay clean.
  const [quoteHtml, setQuoteHtml] = useState("");
  const [quoteOpen, setQuoteOpen] = useState(false);
  // Outer wrapper — scrolled into view when a target is picked from a message
  // higher up the thread.
  const containerRef = useRef<HTMLDivElement>(null);

  // Draft autosave. We persist the in-progress reply to inbox_drafts
  // (debounced) so it survives navigation/reload, and re-hydrate it on
  // mount. `loaded` gates autosave until the initial fetch settles;
  // `skipSaveRef` swallows the one effect run caused by hydration so we
  // don't immediately re-save unchanged content.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [loaded, setLoaded] = useState(false);
  const skipSaveRef = useRef(false);

  // Load an existing draft for this thread (once).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/inboxes/drafts/thread/${encodeURIComponent(threadId)}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!cancelled && data.draft) {
          const d = data.draft;
          if (Array.isArray(d.to) && d.to.length > 0) setTo(d.to.join(", "));
          if (Array.isArray(d.cc) && d.cc.length > 0) { setCc(d.cc.join(", ")); setCcOpen(true); }
          if (typeof d.subject === "string" && d.subject) setSubject(d.subject);
          if (typeof d.bodyText === "string") setBodyText(d.bodyText);
          if (Array.isArray(d.attachments)) setAttachments(d.attachments);
          // Restore the saved "From" account, but only if it's still one the
          // user can send from (else keep the thread's inbox default).
          if (typeof d.accountId === "string" && (accounts ?? []).some((a) => a.id === d.accountId)) {
            setFromAccountId(d.accountId);
          }
          setSaveState("saved");
          setOpen(true);
        }
      } catch {
        /* no draft / network blip — start fresh */
      } finally {
        if (!cancelled) { skipSaveRef.current = true; setLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const saveDraft = useCallback(async () => {
    const toList = to.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const ccList = cc.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    setSaveState("saving");
    try {
      const res = await fetch("/api/inboxes/drafts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId, accountId: fromAccountId, to: toList, cc: ccList,
          subject: subject.trim() || undefined, bodyText, attachmentUrls: attachments
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setSaveState("idle"); return; }
      setSaveState(data.deleted ? "idle" : "saved");
    } catch {
      setSaveState("idle");
    }
  }, [threadId, fromAccountId, to, cc, subject, bodyText, attachments]);

  // Debounced autosave. Skips until the initial load settles and swallows
  // the hydration-triggered run.
  useEffect(() => {
    if (!loaded) return;
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    const t = setTimeout(() => { void saveDraft(); }, 700);
    return () => clearTimeout(t);
  }, [loaded, saveDraft]);

  // When the user clicks "Reply" on a specific message, open the composer and
  // pre-fill the addressing fields from THAT message — without touching the
  // body they may already have typed. Keyed on the target's id so it only fires
  // when a *different* message is picked, not on every render.
  useEffect(() => {
    if (!replyTarget) return;
    setOpen(true);
    // Outbound = a message we sent; replying should go back to its original
    // recipients, not to ourselves.
    const nextTo =
      replyTarget.direction === "outbound"
        ? replyTarget.to_addrs.join(", ") || defaultTo || ""
        : rawEmail(replyTarget.from_addr);
    setTo(nextTo);
    setSubject(prefixRe(replyTarget.subject || defaultSubject || ""));
    setMode("reply");
    setCc("");
    setCcOpen(false);
    // Pin threading to this message. null when it has no RFC Message-ID yet —
    // the server then falls back to the thread's latest message.
    setInReplyTo(replyTarget.message_id ?? null);
    // The picked message may be far above the composer — bring it into view.
    requestAnimationFrame(() => {
      containerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTarget?.id]);

  // Derive the quoted-original block (pinned target, or latest for a thread-level
  // reply) and collapse it by default. Never touches bodyText — switching targets
  // just swaps the quote. When the target's body was deferred (an older message,
  // withheld on thread open), fetch it first so the quote isn't empty — a cache
  // hit if the user already expanded it. The default target (latest message)
  // ships its body inline, so this stays synchronous in the common case.
  useEffect(() => {
    setQuoteOpen(false);
    if (!quoteSource) {
      setQuoteHtml("");
      return;
    }
    if (!quoteSource.body_deferred || quoteSource.body_html || quoteSource.body_text) {
      setQuoteHtml(buildReplyQuoteHtml(quoteSource));
      return;
    }
    let cancelled = false;
    setQuoteHtml("");
    fetchDeferredBody(quoteSource.id, accountId, threadId)
      .then((body) => {
        if (cancelled) return;
        setQuoteHtml(
          buildReplyQuoteHtml({
            ...quoteSource,
            body_html: body.body_html,
            body_text: body.body_text
          })
        );
      })
      .catch(() => {
        // Best-effort: on failure send with no quoted history rather than block.
        if (!cancelled) setQuoteHtml("");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteSource?.id, accountId, threadId]);

  // Reset the pinned target + addressing fields back to the thread defaults.
  const clearTarget = useCallback(() => {
    setInReplyTo(null);
    setTo(defaultTo ?? "");
    setSubject(prefixRe(defaultSubject ?? ""));
    setMode("reply");
    setCc("");
    setCcOpen(false);
    onClearReplyTarget?.();
  }, [defaultTo, defaultSubject, onClearReplyTarget]);

  // Discard the persisted draft (best-effort) on top of clearing local state.
  const discardDraft = useCallback(() => {
    skipSaveRef.current = true;
    setSaveState("idle");
    void fetch(`/api/inboxes/drafts/thread/${encodeURIComponent(threadId)}`, { method: "DELETE" }).catch(() => {});
  }, [threadId]);

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
    // Guardrail: block a reply addressed to someone who isn't part of this
    // thread until the user explicitly confirms via "Send anyway". Prevents the
    // Chris Barnes → Charles Smellie class of misfire. `strangerRecipients` is
    // only non-empty when we have known thread addresses, so this fails open.
    if (strangerRecipients.length > 0 && confirmedStrangerSigRef.current !== strangerSig) {
      toast.error(
        strangerRecipients.length === 1
          ? `${strangerRecipients[0]} isn't part of this thread — use “Send anyway” to confirm`
          : `${strangerRecipients.length} recipients aren't part of this thread — use “Send anyway” to confirm`
      );
      return;
    }
    // Guardrail: you're replying to a specific message but the person it's with
    // isn't in the To line (a wrong-but-in-thread recipient). Block until "Send
    // anyway" confirms the exact address, so an ack'd send isn't re-challenged.
    if (mismatch && confirmedMismatchSigRef.current !== mismatchSig) {
      toast.error(`You're replying to ${mismatch.name}'s message, but ${mismatch.email} isn't in the To line — use “Send anyway” to confirm`);
      return;
    }
    setBusy(true);
    try {
      // Append the quoted original below the user's text so the reply carries
      // its context — the same wire shape missiveclone sends (body_html =
      // userHtml + gmail_quote, body_text derived from the combined HTML).
      const fullHtml = plainTextToHtml(bodyText) + (quoteHtml || "");
      const sendText = htmlToText(fullHtml);
      const url = scheduling
        ? `/api/inboxes/threads/${encodeURIComponent(threadId)}/reply/schedule`
        : `/api/inboxes/threads/${encodeURIComponent(threadId)}/reply`;
      const body = scheduling
        ? { accountId: fromAccountId, to: toList, cc: ccList, subject: subject.trim() || undefined, bodyText: sendText, bodyHtml: fullHtml, scheduledForISO, inReplyTo: inReplyTo ?? undefined }
        : { accountId: fromAccountId, to: toList, cc: ccList, subject: subject.trim() || undefined, bodyText: sendText, bodyHtml: fullHtml, attachmentUrls: attachments, inReplyTo: inReplyTo ?? undefined };
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
      // The send routes already delete the draft server-side; swallow the
      // autosave that clearing these fields would otherwise trigger.
      skipSaveRef.current = true;
      setSaveState("idle");
      setBodyText("");
      setAttachments([]);
      setScheduleOpen(false);
      setScheduleAt("");
      setMode("reply");
      setCc("");
      setCcOpen(false);
      setInReplyTo(null);
      setQuoteOpen(false);
      setFromAccountId(accountId);
      onClearReplyTarget?.();
      setOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
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
              style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
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
                {replyTarget && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium normal-case px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20 max-w-full">
                    <span className="truncate min-w-0">
                      Replying to{" "}
                      {(() => {
                        const raw = replyTarget.direction === "outbound"
                          ? replyTarget.to_addrs[0]
                          : replyTarget.from_addr;
                        if (!raw) return "recipients";
                        const name = shortName(raw);
                        const email = rawEmail(raw);
                        return name && name.toLowerCase() !== email.toLowerCase()
                          ? `${name} <${email}>`
                          : email;
                      })()}
                    </span>
                    <button
                      type="button"
                      onClick={clearTarget}
                      aria-label="Reply to latest instead"
                      title="Reply to latest instead"
                      className="shrink-0 hover:text-accent/60 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                )}
                {saveState !== "idle" && (
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-ink/45 font-semibold">
                    {saveState === "saving"
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>
                      : <><Check className="w-3 h-3 text-emerald-500" /> Saved</>}
                  </span>
                )}
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
                  onClick={() => setFocusMode(!focusMode)}
                  aria-label={focusMode ? "Collapse focus mode" : "Expand to focus mode"}
                  title={focusMode ? "Back to the inbox layout" : "Expand — more room to write, hides the inbox list"}
                  /* Focus Mode widens the composer by collapsing tree+list —
                     redundant on mobile where it's already one-pane-at-a-time. */
                  className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold text-sky-700 bg-white border border-sky-200/70 hover:bg-sky-100 transition-colors shrink-0"
                >
                  {focusMode
                    ? <><Minimize2 className="w-3 h-3" /> Collapse</>
                    : <><Maximize2 className="w-3 h-3" /> Expand</>}
                </button>
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
              {/* From — which connected inbox sends the reply. Dropdown when the
                  user can send from more than one account; a static label otherwise. */}
              {fromOptions.length > 1 ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                    From
                  </span>
                  <select
                    value={fromAccountId}
                    onChange={(e) => setFromAccountId(e.target.value)}
                    className="flex-1 bg-transparent text-sm outline-none cursor-pointer"
                  >
                    {fromOptions.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.display_name ? `${a.display_name} <${a.email}>` : a.email}
                      </option>
                    ))}
                  </select>
                </div>
              ) : fromOptions.length === 1 ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60">
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                    From
                  </span>
                  <span className="flex-1 text-sm text-ink/70 truncate">
                    {fromOptions[0].display_name ? `${fromOptions[0].display_name} <${fromOptions[0].email}>` : fromOptions[0].email}
                  </span>
                </div>
              ) : null}

              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                  To
                </span>
                <RecipientAutocomplete
                  value={to}
                  onChange={setTo}
                  clients={suggestions}
                  autoFocus
                  placeholder="recipient@example.com"
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

              {/* Resolved recipients — spells out exactly who each address is,
                  so a wrong-but-in-thread recipient (e.g. Chris when you meant
                  Charles) is obvious before send. Quiet while mid-typing. */}
              {toPreview.length > 0 && (
                <div className="px-3 -mt-1 text-[11px] text-ink/55 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="uppercase tracking-wide font-semibold text-ink/40 shrink-0">Sending to</span>
                  {toPreview.map((r) => (
                    <span key={r.email} className="text-ink/70 break-all">
                      {r.label !== r.email ? `${r.label} <${r.email}>` : r.email}
                    </span>
                  ))}
                </div>
              )}

              {(ccOpen || cc.trim()) && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200/70 bg-white/60 focus-within:ring-2 focus-within:ring-accent/30 focus-within:border-accent/40 transition-all">
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-ink/45 w-14 shrink-0">
                    Cc
                  </span>
                  <RecipientAutocomplete
                    value={cc}
                    onChange={setCc}
                    clients={suggestions}
                    placeholder="cc@example.com, …"
                  />
                </div>
              )}

              {/* Mis-recipient guardrail — surfaces the moment a "To" entry isn't
                  part of this thread, with an explicit "Send anyway" to override. */}
              {strangerRecipients.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 rounded-xl border border-amber-300/80 bg-amber-50 text-amber-900">
                  <span className="inline-flex items-start gap-1.5 text-[12.5px] leading-snug">
                    <span aria-hidden className="mt-px">⚠️</span>
                    <span>
                      <strong className="break-all">{strangerRecipients.join(", ")}</strong>{" "}
                      {strangerRecipients.length === 1 ? "isn't" : "aren't"} part of this
                      conversation — double-check the recipient before sending.
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => { confirmedStrangerSigRef.current = strangerSig; void send(); }}
                    disabled={busy}
                    className="ml-auto shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60 transition-colors"
                  >
                    Send anyway
                  </button>
                </div>
              )}

              {/* In-thread mismatch guardrail — you're replying to a specific
                  message but the person it's with isn't in the To line. Blocks
                  send until "Send anyway" (only fires for explicit per-message
                  replies in threads with >=2 external parties). */}
              {mismatch && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 rounded-xl border border-amber-300/80 bg-amber-50 text-amber-900">
                  <span className="inline-flex items-start gap-1.5 text-[12.5px] leading-snug">
                    <span aria-hidden className="mt-px">⚠️</span>
                    <span>
                      You&rsquo;re replying to <strong>{mismatch.name}</strong>&rsquo;s message, but{" "}
                      <strong className="break-all">{mismatch.email}</strong> isn&rsquo;t in the To line.
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => { confirmedMismatchSigRef.current = mismatchSig; void send(); }}
                    disabled={busy}
                    className="ml-auto shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60 transition-colors"
                  >
                    Send anyway
                  </button>
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
                className={cn(
                  "w-full text-sm bg-white/60 border border-slate-200/70 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/40 resize-none transition-all",
                  focusMode && "min-h-[45vh]"
                )}
              />

              {/* Quoted original — collapsed behind a "•••" toggle like Gmail's
                  compose, so the textarea above stays clean. The quote is
                  appended to the body on send; here it's a read-only, sandboxed
                  preview (no scripts, isolated CSS). */}
              {quoteHtml && (
                <div>
                  <button
                    type="button"
                    onClick={() => setQuoteOpen((o) => !o)}
                    title={quoteOpen ? "Hide quoted text" : "Show quoted text"}
                    aria-expanded={quoteOpen}
                    className="inline-flex items-center px-2.5 py-0.5 rounded-full text-sm leading-none tracking-widest text-ink/50 bg-slate-100 border border-slate-200/70 hover:text-ink/80 transition-colors"
                  >
                    •••
                  </button>
                  {quoteOpen && (
                    <iframe
                      title="Quoted message"
                      sandbox="allow-popups allow-popups-to-escape-sandbox"
                      srcDoc={buildQuoteDoc(quoteHtml)}
                      className="w-full h-48 mt-2 rounded-xl border border-slate-200/70 bg-white block"
                    />
                  )}
                </div>
              )}

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
                  onClick={() => { discardDraft(); setOpen(false); setBodyText(""); setAttachments([]); setScheduleOpen(false); setScheduleAt(""); setMode("reply"); setCc(""); setCcOpen(false); setInReplyTo(null); setQuoteOpen(false); onClearReplyTarget?.(); }}
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
                  style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
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
