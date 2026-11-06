"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, ShieldAlert, TriangleAlert } from "lucide-react";
import { EmailEditor, EmailFormatButtons, useEmailBody, useFormattingBar } from "@/components/email-editor";
import type { EmailDocNode } from "@/lib/email-doc";
import type {
  DraftAddress,
  DraftView,
  NewDraftSeed,
  ReadBackView,
  RecipientSuggestion,
  RecipientView,
  ReviewBlocker,
  ReviewResult
} from "@/lib/exec/drafts-types";
import { DRAFT_LIMITS } from "@/lib/exec/drafts-types";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { cn } from "@/lib/utils";
import { busyFor, type DraftBusy, type DraftUiAction } from "./actions";
import { canRecheckReadiness } from "./banner";
import { acceptsTyping, bodyModeFor, seedsEditorFrom } from "./body-mode";
import { ConfirmSendDialog } from "./ConfirmSendDialog";
import { codeSentence, COPY, draftReplyBanner } from "./copy";
import { DraftActions } from "./DraftActions";
import { DraftBodyPreview } from "./DraftBodyPreview";
import { DraftStatusBanner } from "./DraftStatusBanner";
import { useIsTopWindow } from "./frame-guard";
import { createDraftMutationQueue, type DraftMutationQueue } from "./mutation-queue";
import { openInOutlookFlow, openNow } from "./open-in-outlook";
import {
  createOutcome,
  createRequest,
  editRequest,
  mergeEdits,
  outcomeOf,
  outlookOpenedRequest,
  requestFor,
  sendProbeRequest,
  sendRequest,
  viewRequest,
  type DraftEdit,
  type PanelOutcome,
  type PanelRequest
} from "./panel-logic";
import { pollIntervalFor, stateEnteredAtMs } from "./poll";
import { ReadBackFrame } from "./ReadBackFrame";
import { RecipientChips, replyAllCc, type RecipientChange } from "./RecipientChips";

// The draft page's container (P4 contract §3.13.3/§3.13.4, L6, L13, L16,
// C42, C69, C74). It owns every request the page makes, the polling, the
// autosave, the frame guard and the confirm dialog; the presentational parts
// render what it hands them.
//
//   - One queue for every write (C74): an action first flushes the pending
//     autosave and uses the version that PATCH returned; a 409 re-reads the
//     draft and re-applies the server's view to the panel and the editor.
//   - Buttons come only from the server's capabilities, and only in a
//     top-level window (useIsTopWindow, L16). Framed, the draft is read-only.
//   - The editor is mounted only in the editable states; every other state
//     shows the static preview (bodyModeFor). The browser sends TipTap JSON,
//     never HTML (L7).
//   - "Open in Outlook" is a button: about:blank first (inside the click),
//     opener cut, the stamp posted, then the link (C69). No href on this page
//     holds the Outlook webLink.
//   - Polling (C42) runs only while something is in flight, pauses while the
//     tab is hidden, keeps the last view when a poll fails and says so.
//
// Nothing here logs: the draft is his mail.

type NewDraftProp = NewDraftSeed | { kind: "new"; accountId: string | null };

interface Answer {
  status: number;
  json: unknown;
}

async function call(req: PanelRequest): Promise<Answer> {
  const init: RequestInit = { method: req.method, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } };
  if (req.body !== undefined) {
    init.body = JSON.stringify(req.body);
    init.headers = { accept: "application/json", "content-type": "application/json" };
  }
  const res = await fetch(req.path, init);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const asRecipientViews = (list: readonly DraftAddress[]): RecipientView[] => list.map((a) => ({ address: a.address, name: a.name, badges: [] }));

function useTickingNow(initialIso: string, ticking: boolean): string {
  const [now, setNow] = useState(initialIso);
  useEffect(() => {
    // The server's clock first (no hydration mismatch), the browser's after mount.
    setNow(new Date().toISOString());
    if (!ticking) return;
    const t = setInterval(() => setNow(new Date().toISOString()), 1_000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

function Lines({ lines, tone = "warn" }: { lines: string[]; tone?: "warn" | "danger" }) {
  if (lines.length === 0) return null;
  return (
    <div
      role="alert"
      className={cn(
        "space-y-0.5 rounded-xl border px-3.5 py-2 text-[12.5px]",
        tone === "danger" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-amber-200 bg-amber-50 text-amber-900"
      )}
    >
      {lines.map((line, i) => (
        <p key={`${i}-${line}`} className={cn(i === 0 && "flex items-start gap-2")}>
          {i === 0 && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span>{line}</span>
        </p>
      ))}
    </div>
  );
}

function InstructionBox({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{COPY.instructionLabel}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.currentTarget.value.slice(0, DRAFT_LIMITS.instructionChars))}
        disabled={disabled}
        rows={3}
        maxLength={DRAFT_LIMITS.instructionChars}
        placeholder={COPY.instructionPlaceholder}
        className="min-h-[76px] w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-indigo-400 disabled:opacity-60"
      />
    </label>
  );
}

const BUTTON_PRIMARY =
  "rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON_SECONDARY =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------------------
// Before the draft exists (/executive/email/drafts/new)
// ---------------------------------------------------------------------------

/** Exported for the render tests: DraftPanel picks it when there is no draft row yet. */
export function NewDraft({
  seed,
  hold: startOnHold,
  suggestions,
  isTop
}: {
  seed: NewDraftProp | null;
  hold: { threadId: string } | null;
  suggestions: RecipientSuggestion[];
  isTop: boolean;
}) {
  const router = useRouter();
  const reply = seed !== null && seed.kind === "reply" ? seed : null;
  const threadId = reply?.threadId ?? startOnHold?.threadId ?? null;
  const [mode, setMode] = useState<"ready" | "hold" | "sent_copy_found">(startOnHold ? "hold" : "ready");
  const [checked, setChecked] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [replyAll, setReplyAll] = useState(reply?.mode === "reply_all");
  const [to, setTo] = useState<DraftAddress[]>([]);
  const [cc, setCc] = useState<DraftAddress[]>([]);
  const [bcc, setBcc] = useState<DraftAddress[]>([]);
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  const replyTo = reply ? reply.to : [];
  const replyCc = reply ? (replyAll ? (reply.cc.length > 0 ? reply.cc : replyAllCc(reply.candidates, reply.to)) : []) : [];

  const create = async (generate: boolean) => {
    if (busy) return;
    if (generate && instruction.trim() === "") {
      setLines([codeSentence("instruction_required") ?? ""]);
      return;
    }
    if (seed?.kind === "new" && to.length === 0) {
      setLines([COPY.newEmailNoRecipients]);
      return;
    }
    const createSeed =
      threadId !== null
        ? ({ kind: "reply", threadId, replyAll, checkedOutlook: mode === "hold" && checked } as const)
        : ({ kind: "new", accountId: seed?.kind === "new" ? seed.accountId : null, to, cc, bcc, subject } as const);
    setBusy(true);
    setLines([]);
    try {
      const a = await call(createRequest(createSeed, generate, instruction));
      const out = createOutcome(a.status, a.json);
      if (out.kind === "created") {
        router.replace(out.href);
        return;
      }
      if (out.kind === "hold") {
        setMode("hold");
        setChecked(false);
      } else if (out.kind === "sent_copy_found") {
        setMode("sent_copy_found");
      } else {
        setLines(out.lines);
      }
      setBusy(false);
    } catch {
      setLines([codeSentence("unavailable") ?? ""]);
      setBusy(false);
    }
  };

  if (mode === "sent_copy_found") {
    return (
      <div data-new-draft="sent_copy_found" className="space-y-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13.5px] font-semibold text-emerald-900">{COPY.newSentCopyFound}</div>
        {threadId !== null && (
          <Link href={`/executive/email/${encodeURIComponent(threadId)}`} prefetch={false} className={BUTTON_SECONDARY}>
            {COPY.viewThread}
          </Link>
        )}
      </div>
    );
  }

  const gated = mode === "hold" && !checked;
  const headline = mode === "hold" ? COPY.newHold : reply ? draftReplyBanner(reply.parentFrom) : seed?.kind === "new" ? COPY.newEmailIntro : COPY.newHold;
  return (
    <div data-new-draft={mode === "hold" ? "hold" : reply ? "reply" : "new"} className="space-y-3">
      <div className={cn("rounded-xl border px-4 py-3", mode === "hold" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-800")}>
        <p className="text-[13.5px] font-semibold leading-snug">{headline}</p>
        {reply?.threadSubject && <p className="mt-1 break-words text-[12px] text-slate-600">{`Re: ${reply.threadSubject}`}</p>}
      </div>
      {reply?.injectionSuspected && (
        <p className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-[12.5px] text-rose-800">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{COPY.injectionWarning}</span>
        </p>
      )}
      {reply && (
        <RecipientChips
          kind="reply"
          to={asRecipientViews(replyTo)}
          cc={asRecipientViews(replyCc)}
          bcc={[]}
          candidates={reply.candidates}
          suggestions={[]}
          editable={isTop && !busy}
          replyAll={replyAll}
          onChange={(next: RecipientChange) => setReplyAll(next.replyAll ?? next.cc.length > 0)}
        />
      )}
      {seed?.kind === "new" && (
        <>
          <RecipientChips
            kind="new"
            to={asRecipientViews(to)}
            cc={asRecipientViews(cc)}
            bcc={asRecipientViews(bcc)}
            candidates={null}
            suggestions={suggestions}
            editable={isTop && !busy}
            onChange={(next) => {
              setTo(next.to);
              setCc(next.cc);
              setBcc(next.bcc);
            }}
          />
          <label className="block space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{COPY.subjectLabel}</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.currentTarget.value.slice(0, DRAFT_LIMITS.subjectChars))}
              disabled={busy || !isTop}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-ink outline-none focus:border-indigo-400"
            />
          </label>
        </>
      )}
      <InstructionBox value={instruction} onChange={setInstruction} disabled={busy || !isTop} />
      <Lines lines={lines} />
      {isTop && (
        <div className="space-y-2">
          {mode === "hold" && (
            <label className="flex items-start gap-2 text-[12.5px] text-slate-700">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.currentTarget.checked)} disabled={busy} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
              <span>{COPY.checkedOutlook}</span>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-action="generate" disabled={busy || gated} onClick={() => void create(true)} className={BUTTON_PRIMARY}>
              {busy ? "Working…" : "Draft with AI"}
            </button>
            <button type="button" data-action="write_myself" disabled={busy || gated} onClick={() => void create(false)} className={BUTTON_SECONDARY}>
              Write it myself
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// An existing draft
// ---------------------------------------------------------------------------

function ExistingDraft({
  initial,
  suggestions,
  tz,
  nowIso,
  isTop,
  clientName
}: {
  initial: DraftView;
  suggestions: RecipientSuggestion[];
  tz: string;
  nowIso: string;
  isTop: boolean;
  clientName: string | null;
}) {
  const router = useRouter();
  const [view, setView] = useState<DraftView>(initial);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [busy, setBusy] = useState<DraftBusy | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [pollFailures, setPollFailures] = useState(0);
  const [checkedOutlook, setCheckedOutlook] = useState(false);
  const [shownReadBack, setShownReadBack] = useState<ReadBackView | null>(null);
  const shownRef = useRef<ReadBackView | null>(null);
  shownRef.current = shownReadBack;
  const [instruction, setInstruction] = useState(initial.instruction ?? "");
  const instructionRef = useRef(instruction);
  instructionRef.current = instruction;
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [sending, setSending] = useState(false);
  const [sendReady, setSendReady] = useState<boolean | null>(null);
  const [openBlocked, setOpenBlocked] = useState(false);
  const [subject, setSubject] = useState(initial.subject ?? "");
  const body = useEmailBody();
  const [toolbarOpen, toggleToolbar] = useFormattingBar();
  const pendingEdit = useRef<DraftEdit | undefined>(undefined);
  const lastOutcome = useRef<PanelOutcome | null>(null);
  const visible = useTabVisible();
  const inFlight = view.status === "generating" || view.status === "saving" || view.status === "sending" || view.status === "discarding";
  const now = useTickingNow(nowIso, inFlight || review !== null);
  const mode = bodyModeFor(view);

  // The editor's content follows the server only when the change came from
  // somewhere else (a finished regenerate, a conflict re-read, a kept Outlook
  // version), never from his own autosave answer: that would move his cursor.
  const lastBodyKey = useRef<string | null>(null);
  // useEmailBody's seed and reset are stable callbacks (the object around them isn't).
  const { seed: seedBody, reset: resetBody } = body;
  const seedEditor = useCallback(
    (v: DraftView, undoable: boolean) => {
      const key = JSON.stringify(v.bodyDoc ?? null);
      if (key === lastBodyKey.current) return;
      lastBodyKey.current = key;
      if (v.bodyDoc) seedBody({ kind: "doc", doc: v.bodyDoc }, { undoable });
      else if (v.bodyText) seedBody({ kind: "text", text: v.bodyText }, { undoable });
      else resetBody();
    },
    [seedBody, resetBody]
  );
  useEffect(() => {
    if (lastBodyKey.current === null) seedEditor(initial, false);
    // Once, for the page's first view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queueRef = useRef<DraftMutationQueue | null>(null);

  const applyView = useCallback(
    (v: DraftView, from: "edit" | "server") => {
      const prev = viewRef.current;
      viewRef.current = v;
      setView(v);
      queueRef.current?.observe(v.version);
      if (from === "server") {
        if (seedsEditorFrom({ from, mode: bodyModeFor(v), unsentEdit: queueRef.current?.unsent() ?? false })) seedEditor(v, prev.status === "generating");
        setSubject(v.subject ?? "");
        if (prev.status !== v.status) setInstruction(v.instruction ?? "");
      }
      if (prev.status !== v.status) {
        setCheckedOutlook(false);
        setOpenBlocked(false);
      }
    },
    [seedEditor]
  );

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const a = await call(viewRequest(viewRef.current.id));
      if (a.status === 200) {
        const out = outcomeOf("edit", a.status, a.json);
        if (out.view) {
          applyView(out.view, "server");
          return true;
        }
      }
      if (a.status === 404) setLines([codeSentence("not_found") ?? ""]);
      return false;
    } catch {
      return false;
    }
  }, [applyView]);

  if (queueRef.current === null) {
    queueRef.current = createDraftMutationQueue({
      version: () => viewRef.current.version,
      patch: async (edit, version) => {
        if (pendingEdit.current === edit) pendingEdit.current = undefined;
        try {
          const a = await call(editRequest(viewRef.current, version, edit as DraftEdit));
          const out = outcomeOf("edit", a.status, a.json);
          if (out.ok && out.view) {
            applyView(out.view, "edit");
            return { ok: true, version: out.view.version };
          }
          if (a.status !== 409) setLines(out.lines);
          return { ok: false, status: a.status };
        } catch {
          return { ok: false, status: 0 };
        }
      },
      act: async (action, version) => {
        const req = requestFor(action, { view: viewRef.current, version, instruction: instructionRef.current.trim() || null, shownReadBack: shownRef.current });
        if (req === null) {
          lastOutcome.current = null;
          return { ok: false, status: 0 };
        }
        try {
          const a = await call(req);
          const out = outcomeOf(action, a.status, a.json);
          lastOutcome.current = out;
          return { ok: out.ok, status: a.status };
        } catch {
          lastOutcome.current = { ok: false, status: 0, view: null, refetch: true, lines: [codeSentence("unavailable") ?? ""], readBack: null, review: null, navigate: null, code: null };
          return { ok: false, status: 0 };
        }
      },
      get: async () => {
        pendingEdit.current = undefined;
        await refresh();
      },
      onConflict: (pending) => {
        if (pending) setLines([codeSentence("version_conflict") ?? ""]);
      }
    });
  }
  const queue = queueRef.current;

  const edit = (change: DraftEdit) => {
    pendingEdit.current = mergeEdits(pendingEdit.current, change);
    queue.edit(pendingEdit.current);
  };

  // --- polling (C42) ------------------------------------------------------------
  useEffect(() => {
    if (!visible) return;
    const interval = pollIntervalFor(view, Date.now() - stateEnteredAtMs(view), pollFailures);
    if (interval === null) return;
    const t = setTimeout(async () => {
      if (queue.pending()) return;
      const ok = await refresh();
      setPollFailures((n) => (ok ? 0 : n + 1));
    }, interval);
    return () => clearTimeout(t);
  }, [view, pollFailures, visible, refresh, queue]);

  // --- the live send probe (R9; display only) ------------------------------------
  const probeKey = view.status === "saved" && view.capabilities.canReview && view.capabilities.sendUnavailable === null ? `${view.id}:${view.version}` : null;
  useEffect(() => {
    if (probeKey === null || !isTop) return;
    let live = true;
    call(sendProbeRequest(viewRef.current.id))
      .then((a) => {
        const o = typeof a.json === "object" && a.json !== null ? (a.json as Record<string, unknown>) : {};
        if (live) setSendReady(a.status === 200 && typeof o.sendReady === "boolean" ? o.sendReady : null);
      })
      .catch(() => {
        if (live) setSendReady(null);
      });
    return () => {
      live = false;
    };
  }, [probeKey, isTop]);

  // --- "drafts unavailable": re-prove readiness (ui-2) ----------------------------
  // The view is DB-only (C19), so a stored failure would stay until another route re-checked it. The R9 probe
  // proves it again (at most one /api/auth/me check a minute); when the drafts are ready the view is re-read.
  const [rechecking, setRechecking] = useState(false);
  const recheckReadiness = useCallback(async () => {
    setRechecking(true);
    try {
      const a = await call(sendProbeRequest(viewRef.current.id));
      const o = typeof a.json === "object" && a.json !== null ? (a.json as Record<string, unknown>) : {};
      if (a.status === 200 && o.draftsReady === true) await refresh();
    } catch {
      // Still unavailable: the notice stays.
    } finally {
      setRechecking(false);
    }
  }, [refresh]);
  const recheckKey = isTop && canRecheckReadiness(view) ? `${view.id}:${view.capabilities.draftsUnavailable}` : null;
  useEffect(() => {
    if (recheckKey !== null) void recheckReadiness();
  }, [recheckKey, recheckReadiness]);

  // --- actions -----------------------------------------------------------------
  const runAction = async (action: DraftUiAction) => {
    if (busy !== null) return;
    if (action === "open_in_outlook") return openInOutlook();
    setBusy(busyFor(action));
    setLines([]);
    if (action !== "show_outlook_version" && action !== "replace_with_dd" && action !== "delete_anyway" && action !== "resolve:keep_outlook_version" && action !== "resolve:not_sent_new_draft") {
      setShownReadBack(null);
    }
    try {
      const result = await queue.run(action);
      const out = lastOutcome.current;
      lastOutcome.current = null;
      if (out !== null) {
        if (out.view) applyView(out.view, "server");
        if (!(result === "conflict" && out.code === "version_conflict")) setLines(out.lines);
        if (out.readBack) setShownReadBack(out.readBack);
        else if (action === "replace_with_dd" || action === "delete_anyway" || action === "resolve:keep_outlook_version") setShownReadBack(null);
        if (out.review) setReview(out.review);
        if (out.navigate) {
          router.push(out.navigate);
          return;
        }
        if (out.refetch && result !== "conflict") await refresh();
      } else if (result === "failed") {
        setLines([codeSentence("unavailable") ?? ""]);
      }
    } finally {
      setBusy(null);
    }
  };

  const openInOutlook = async () => {
    const v = viewRef.current;
    const link = v.outlook.webLink;
    if (link === null || !isAllowedLinkUrl(link)) return;
    if (v.status === "sent" || v.status === "sent_pending") {
      // "Open sent copy": already sent, nothing to stamp.
      openNow((url, target, features) => window.open(url, target, features), link);
      return;
    }
    setLines([]);
    setOpenBlocked(false);
    const outcome = await openInOutlookFlow({
      open: (url, target, features) => window.open(url, target, features),
      webLink: link,
      post: async () => {
        const stamped = await queue.perform(async () => {
          const a = await call(outlookOpenedRequest(v.id));
          const out = outcomeOf("outlook_opened", a.status, a.json);
          if (out.view) applyView(out.view, "server");
          return out.ok;
        });
        return stamped === true;
      }
    });
    if (outcome === "blocked") setOpenBlocked(true);
    if (outcome === "failed") setLines([COPY.openFailed]);
  };

  const send = async (acks: ReviewBlocker[]) => {
    const r = review;
    if (r === null || sending) return;
    const req = sendRequest(viewRef.current.id, r, acks);
    if (req === null) return;
    setSending(true);
    try {
      const out = await queue.perform(async () => {
        const a = await call(req);
        return outcomeOf("send", a.status, a.json);
      });
      setReview(null);
      if (out !== null) setLines(out.lines);
      await refresh();
    } catch {
      setReview(null);
      setLines([codeSentence("transport") ?? ""]);
      await refresh();
    } finally {
      setSending(false);
    }
  };

  // --- render ------------------------------------------------------------------
  const editable = isTop && mode === "editor" && view.capabilities.canEdit && busy === null;
  // The editor takes typing even while an action runs (it can't be locked): the queue sends it after the action (ui-1).
  const typing = acceptsTyping({ isTop, mode, canEdit: view.capabilities.canEdit, busy });
  const showInstruction = isTop && !view.restricted && (view.status === "draft" || view.status === "saved" || view.status === "generation_failed") && view.capabilities.canRegenerate;
  const recipientsShown = !view.restricted && view.status !== "discarded";

  return (
    <div data-draft-panel={view.status} className="space-y-4">
      <Lines lines={lines} />
      <DraftStatusBanner
        view={view}
        tz={tz}
        nowIso={now}
        pollFailures={pollFailures}
        clientName={clientName ?? view.clientName ?? null}
        onRecheck={isTop ? () => void recheckReadiness() : undefined}
        rechecking={rechecking}
      />

      {recipientsShown && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <RecipientChips
            kind={view.kind}
            to={view.to}
            cc={view.cc}
            bcc={view.bcc}
            candidates={view.replyCandidates}
            suggestions={suggestions}
            editable={editable}
            replyAll={view.replyMode === "reply_all"}
            onChange={(next) =>
              view.kind === "new" ? edit({ to: next.to, cc: next.cc, bcc: next.bcc }) : edit({ replyAll: next.replyAll ?? next.cc.length > 0 })
            }
          />
          {view.kind === "new" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="w-8 shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Subj</span>
              {editable ? (
                <input
                  value={subject}
                  aria-label={COPY.subjectLabel}
                  onChange={(e) => {
                    const next = e.currentTarget.value.slice(0, DRAFT_LIMITS.subjectChars);
                    setSubject(next);
                    edit({ subject: next.trim() === "" ? null : next });
                  }}
                  className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-[13px] outline-none focus:border-indigo-400"
                />
              ) : (
                <span className="min-w-0 break-words font-medium text-ink">{view.subject ?? "(no subject)"}</span>
              )}
            </div>
          )}
          {view.kind === "reply" && view.threadSubject && <p className="mt-2 break-words text-[12px] text-slate-600">{`Re: ${view.threadSubject}`}</p>}
        </div>
      )}

      {mode === "editor" && (
        <div className="space-y-1.5">
          <EmailEditor
            {...body.editorProps}
            onChange={(b) => {
              body.editorProps.onChange(b);
              const doc = (b.doc as EmailDocNode | null) ?? null;
              // A seed from the server (a finished regenerate) reports itself as a change: nothing to save then.
              if (JSON.stringify(doc) === lastBodyKey.current) return;
              lastBodyKey.current = null;
              if (typing) edit({ bodyDoc: doc });
            }}
            toolbarOpen={toolbarOpen}
            placeholder="Write the reply here."
            ariaLabel="Draft text"
            hideAttachmentHint
            contentClassName="min-h-[200px] max-h-[55vh]"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1 text-[11.5px] text-muted">
              <Paperclip className="h-3 w-3" aria-hidden />
              {COPY.noAttachments}
            </p>
            <span className="inline-flex items-center gap-1">
              <EmailFormatButtons toolbarOpen={toolbarOpen} onToggleToolbar={toggleToolbar} onInsertLink={() => body.apiRef.current?.openLinkDialog()} disabled={!editable} />
            </span>
          </div>
        </div>
      )}
      {mode === "preview" && <DraftBodyPreview text={view.bodyText} />}

      {shownReadBack !== null && !view.restricted && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{COPY.outlookVersionTitle}</p>
          <ReadBackFrame srcdoc={shownReadBack.srcdoc} title={COPY.outlookVersionTitle} />
          <p className="text-[11.5px] text-muted">{COPY.linksDontOpen}</p>
        </div>
      )}

      {showInstruction && <InstructionBox value={instruction} onChange={setInstruction} disabled={busy !== null} />}

      <DraftActions
        view={view}
        isTop={isTop}
        busy={busy}
        sendReady={sendReady}
        onAction={(a) => void runAction(a)}
        checkedOutlook={checkedOutlook}
        onCheckedOutlook={setCheckedOutlook}
        outlookVersionShown={shownReadBack !== null}
        openBlocked={openBlocked}
        onOpenNow={() => {
          const link = viewRef.current.outlook.webLink;
          if (link !== null && isAllowedLinkUrl(link)) openNow((url, target, features) => window.open(url, target, features), link);
          setOpenBlocked(false);
        }}
      />

      {review !== null && (
        <ConfirmSendDialog
          open={review !== null}
          review={review}
          busy={sending}
          tz={tz}
          nowIso={now}
          clientName={clientName ?? review.clientName ?? view.clientName ?? null}
          flags={view.generationFlags}
          onCancel={() => setReview(null)}
          onSend={(acks) => void send(acks)}
        />
      )}
    </div>
  );
}

export function DraftPanel({
  initial,
  newDraft,
  suggestions = [],
  tz,
  nowIso,
  hold = null,
  clientName = null
}: {
  initial: DraftView | null;
  newDraft?: NewDraftSeed | { kind: "new"; accountId: string | null };
  suggestions?: RecipientSuggestion[];
  tz: string;
  nowIso: string;
  /** Additive: the new-draft page found an earlier draft that may have been sent (C63): start on the "I checked" step. */
  hold?: { threadId: string } | null;
  /** Additive: the facts client's name for the "<client>" copy (DD data). */
  clientName?: string | null;
}) {
  const isTop = useIsTopWindow();
  const seed = useMemo(() => newDraft ?? null, [newDraft]);
  if (initial !== null) {
    return <ExistingDraft initial={initial} suggestions={suggestions} tz={tz} nowIso={nowIso} isTop={isTop} clientName={clientName} />;
  }
  return <NewDraft seed={seed} hold={hold} suggestions={suggestions} isTop={isTop} />;
}
