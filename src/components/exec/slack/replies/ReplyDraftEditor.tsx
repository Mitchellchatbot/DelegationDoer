"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../../drafts/frame-guard";
import { ReplyCopyButton } from "./ReplyCopyButton";
import { ReplySendDialog } from "./ReplySendDialog";
import {
  editorControls,
  editorFailureBanner,
  REPLY_UI_COPY,
  replyPollIntervalFor,
  replyStatusBanner,
  textToCopy,
  type ReplyBanner,
  type ReplyPageDraft
} from "./reply-logic";

// The reply editor (P10 contract §3.5.13, C34, C37, C51; v1.1 product-3, -15, -20, security-7; Area D). A client island:
//   * the textarea (labelled textLabel), Save → PATCH (the server stores sanitizeChars(NFC(text)) and recomputes the
//     placeholders), Copy (the stored text, or the textarea's while it differs), Rewrite with an optional instruction (asks
//     rewriteEditedConfirm first when he edited the text), Discard (asks first), Send as you… → ReplySendDialog;
//   * while the textarea differs from the stored text, Send and Rewrite wait for Save (saveFirst): the server binds a send to
//     the STORED text, so the dialog would otherwise show the pre-edit text;
//   * polls GET every 2 s while generating / sending, for at most 3 minutes;
//   * one role="status" line for drafting, rewriting, sending and sent, role="alert" for back to draft, unknown and refusals;
//   * the unknown banner: while DD is still checking Slack, its time and no buttons; after the third check, It posted / It
//     didn't post; after "It didn't post", Start a new draft with this text (a new row, built in SQL from this one);
//   * no actions in a framed page (the frame guard), only the framed line.
// Every string is React text; the draft text is never written into an attribute.
// P10 fixer ui-6: closing the send dialog gives focus back to Send (or, once the draft left `draft`, to the live regions);
// the inline Discard / Rewrite confirm takes focus on its question when it opens and gives it back to its button on Cancel.
// P10 fixer ui-7: each action's refusal in its own words (editorFailureBanner): never the send line "Not sent: …".

const COPY = SLACK_P10_COPY.replies;
const TONE: Readonly<Record<ReplyBanner["tone"], string>> = {
  progress: "border-indigo-200 bg-indigo-50 text-indigo-900",
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  muted: "border-slate-200 bg-white text-slate-700"
};
const BUTTON = "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-slate-50 disabled:opacity-60 sm:min-h-0";
const PRIMARY = "inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 sm:min-h-0";

type Confirming = "rewrite" | "discard" | null;

async function call(url: string, method: "POST" | "PATCH" | "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

export function ReplyDraftEditor({
  initial,
  tz,
  nowIso,
  source
}: {
  initial: ReplyPageDraft;
  tz: string;
  nowIso: string;
  /** The draft's message (for "Start a new draft with this text"); null when it can't be offered. */
  source: { channelId: string; ts: string } | null;
}) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const [draft, setDraft] = useState<ReplyPageDraft>(initial);
  const [text, setText] = useState<string>(initial.text ?? "");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [message, setMessage] = useState<ReplyBanner | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const stateStart = useRef<{ status: string; at: number }>({ status: initial.status, at: Date.now() });
  const lastStored = useRef<string | null>(initial.text);
  // ui-6: the dialog's opener and fallback, the inline confirm's question and the two buttons that open it.
  const sendRef = useRef<HTMLButtonElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLSpanElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const rewriteRef = useRef<HTMLButtonElement>(null);
  const confirmWas = useRef<Confirming>(null);
  useEffect(() => {
    const was = confirmWas.current;
    confirmWas.current = confirming;
    if (confirming !== null && was === null) confirmRef.current?.focus();
  }, [confirming]);
  const cancelConfirm = () => {
    const opener = confirming === "rewrite" ? rewriteRef.current : discardRef.current;
    setConfirming(null);
    opener?.focus();
  };

  const base = `/api/exec/slack/replies/${encodeURIComponent(draft.id)}`;
  const dirty = draft.text !== null && text !== draft.text;
  const controls = editorControls(draft, dirty, busy);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await call(base, "GET");
      const next = r.status === 200 && r.body.state === "ok" && r.body.draft ? (r.body.draft as ReplyPageDraft) : null;
      if (next === null) return;
      setDraft(next);
      // His unsaved edits stay; otherwise the textarea follows the stored text.
      setText((cur) => (cur === (lastStored.current ?? "") ? next.text ?? "" : cur));
      lastStored.current = next.text;
    } catch {
      // The next poll (or his next action) tries again.
    }
  }, [base]);

  // §3.5.13: poll every 2 s while generating / sending, ≤ 3 minutes in that state.
  useEffect(() => {
    if (stateStart.current.status !== draft.status) stateStart.current = { status: draft.status, at: Date.now() };
    const wait = replyPollIntervalFor(draft.status, Date.now() - stateStart.current.at);
    if (wait === null) return;
    const t = setTimeout(() => void refresh(), wait);
    return () => clearTimeout(t);
  }, [draft, refresh]);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch {
      setMessage({ role: "alert", tone: "danger", text: REPLY_UI_COPY.failed });
    } finally {
      setBusy(false);
    }
  };

  const failed = (action: Parameters<typeof editorFailureBanner>[0], r: { status: number; body: Record<string, unknown> }) =>
    setMessage(editorFailureBanner(action, r.status, r.body, tz, new Date().toISOString(), draft.readingOff));

  const save = () => act(async () => {
    const r = await call(base, "PATCH", { version: draft.version, text });
    if (r.status === 200) await refresh();
    else failed("save", r);
  });

  const rewrite = () => act(async () => {
    setConfirming(null);
    const r = await call(`${base}/regenerate`, "POST", { version: draft.version, instruction });
    if (r.status === 202) {
      setInstruction("");
      await refresh();
    } else failed("rewrite", r);
  });

  const discard = () => act(async () => {
    setConfirming(null);
    const r = await call(`${base}/discard`, "POST", { version: draft.version });
    if (r.status === 200) await refresh();
    else failed("discard", r);
  });

  const resolve = (action: "posted" | "not_posted") => act(async () => {
    const r = await call(`${base}/resolve`, "POST", { action });
    if (r.status === 200) await refresh();
    else failed("resolve", r);
  });

  const startFromText = () => act(async () => {
    if (source === null) return;
    const r = await call("/api/exec/slack/replies", "POST", { channelId: source.channelId, ts: source.ts, itemId: "", instruction: "", fromDraftId: draft.id });
    if ((r.status === 201 || r.status === 200) && typeof r.body.href === "string") router.push(r.body.href);
    else {
      failed("new_from_text", r);
      if (r.status === 409 && r.body.error === "already_posted") await refresh();
    }
  });

  const banner = replyStatusBanner(draft, tz, nowIso);
  const alertBanner: ReplyBanner | null = message ?? (banner !== null && banner.role === "alert" ? banner : null);
  const showsText = draft.text !== null && (draft.status === "draft" || draft.status === "generating" || draft.status === "sending" || draft.status === "unknown" || draft.status === "sent");
  const notPosted = draft.status === "failed" && draft.ownerResolution === "not_posted";

  return (
    <div data-reply-editor={draft.status} className="space-y-3">
      {/* One status region, one alert region (v1.1 product-20); each stays mounted so a change is announced. ui-6: their
          wrapper takes focus when the send dialog closes after the draft left `draft` (its Send button is gone). */}
      <div ref={liveRef} tabIndex={-1} data-reply-live className="space-y-3 outline-none">
        <p role="status" aria-live="polite" data-reply-status className={cn("rounded-xl border px-3.5 py-2 text-[12.5px]", banner !== null && banner.role === "status" ? TONE[banner.tone] : "sr-only")}>
          {draft.status === "generating" || draft.status === "sending" ? <Loader2 className="mr-1.5 inline h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> : null}
          {banner !== null && banner.role === "status" ? banner.text : ""}
        </p>
        <p role="alert" data-reply-alert className={cn("rounded-xl border px-3.5 py-2 text-[12.5px]", alertBanner !== null ? TONE[alertBanner.tone] : "sr-only")}>
          {alertBanner !== null ? alertBanner.text : ""}
        </p>
      </div>
      {draft.status === "sent" && draft.postedPermalink !== null && (
        <a href={draft.postedPermalink} target="_blank" rel="noopener noreferrer" data-reply-sent-link className="inline-flex text-[12.5px] font-semibold text-indigo-700 hover:text-indigo-900">
          {COPY.sentLink}
        </a>
      )}
      {draft.note !== null && draft.note.trim() !== "" && showsText && (
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{COPY.note}</div>
          <p data-reply-note className="mt-1 whitespace-pre-wrap break-words text-[12.5px] text-slate-700">{draft.note}</p>
        </div>
      )}
      {showsText && (
        <div className="space-y-1.5">
          <label htmlFor={`reply-text-${draft.id}`} className="text-[12px] font-semibold text-slate-700">
            {COPY.textLabel}
          </label>
          <textarea
            id={`reply-text-${draft.id}`}
            data-reply-text
            value={text}
            readOnly={!draft.canEdit || !isTop}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
            className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 read-only:bg-slate-50"
          />
          {draft.placeholders.length > 0 && (
            <p data-reply-placeholders className="text-[12px] text-rose-800">{fillP10(COPY.placeholders, { list: draft.placeholders.join(", ") })}</p>
          )}
        </div>
      )}
      {!isTop ? (
        <p data-reply-framed className="text-[12px] text-slate-600">{COPY.framed}</p>
      ) : (
        <div className="space-y-2.5">
          {controls.saveFirst && <p data-reply-save-first className="text-[12px] font-medium text-amber-800">{COPY.saveFirst}</p>}
          {draft.status === "draft" && draft.sendOff && <p data-reply-send-off className="text-[12px] text-slate-600">{COPY.sendOff}</p>}
          {draft.status === "draft" && !draft.sendOff && draft.readingOff && <p data-reply-reading-off className="text-[12px] text-slate-600">{COPY.readingOff}</p>}
          {(draft.status === "draft" || draft.status === "generation_failed") && (
            <div className="flex flex-wrap items-center gap-2">
              {draft.status === "draft" && (
                <button type="button" data-reply-action="save" disabled={!controls.canSave} onClick={() => void save()} className={BUTTON}>
                  {COPY.save}
                </button>
              )}
              {draft.status === "draft" && <ReplyCopyButton text={textToCopy(draft.text, text)} />}
              <button
                ref={discardRef}
                type="button"
                data-reply-action="discard"
                disabled={!controls.canDiscard}
                onClick={() => setConfirming("discard")}
                className={BUTTON}
              >
                {COPY.discard}
              </button>
              {draft.status === "draft" && (
                <button
                  ref={sendRef}
                  type="button"
                  data-reply-action="send"
                  disabled={!controls.canSend}
                  onClick={() => setSendOpen(true)}
                  className={PRIMARY}
                >
                  {COPY.send}
                </button>
              )}
            </div>
          )}
          {(draft.status === "draft" || draft.status === "generation_failed") && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 basis-60 space-y-1">
                <span className="text-[12px] font-semibold text-slate-700">{REPLY_UI_COPY.rewriteInstructionLabel}</span>
                <input
                  type="text"
                  data-reply-instruction
                  value={instruction}
                  maxLength={2000}
                  onChange={(e) => setInstruction(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                />
              </label>
              <button
                ref={rewriteRef}
                type="button"
                data-reply-action="rewrite"
                disabled={!controls.canRewrite}
                onClick={() => (draft.edited ? setConfirming("rewrite") : void rewrite())}
                className={BUTTON}
              >
                {instruction.trim() !== "" ? COPY.rewriteWith : COPY.rewrite}
              </button>
            </div>
          )}
          {confirming !== null && (
            <div
              role="group"
              aria-labelledby={`reply-confirm-${draft.id}`}
              data-reply-confirm={confirming}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                cancelConfirm();
              }}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12.5px] text-amber-900"
            >
              <span ref={confirmRef} id={`reply-confirm-${draft.id}`} tabIndex={-1} data-reply-confirm-question className="outline-none">
                {confirming === "rewrite" ? COPY.rewriteEditedConfirm : `${COPY.cardDiscardConfirmTitle} ${COPY.cardDiscardConfirmText}`}
              </span>
              <button type="button" data-reply-confirm-yes onClick={() => void (confirming === "rewrite" ? rewrite() : discard())} className={BUTTON}>
                {confirming === "rewrite" ? COPY.cardRewriteConfirmYes : COPY.cardDiscardConfirmYes}
              </button>
              <button type="button" data-reply-confirm-no onClick={cancelConfirm} className={BUTTON}>
                {COPY.cancel}
              </button>
            </div>
          )}
          {draft.status === "unknown" && draft.canResolve && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" data-reply-action="posted" disabled={busy} onClick={() => void resolve("posted")} className={BUTTON}>
                {COPY.resolvePosted}
              </button>
              <button type="button" data-reply-action="not_posted" disabled={busy} onClick={() => void resolve("not_posted")} className={BUTTON}>
                {COPY.resolveNotPosted}
              </button>
            </div>
          )}
          {notPosted && source !== null && (
            <button type="button" data-reply-action="new_from_text" disabled={busy} onClick={() => void startFromText()} className={BUTTON}>
              {COPY.newFromText}
            </button>
          )}
        </div>
      )}
      {draft.status === "draft" && draft.text !== null && (
        <ReplySendDialog
          open={sendOpen}
          draftId={draft.id}
          version={draft.version}
          text={draft.text}
          place={draft.place}
          inThread={draft.inThread}
          placeholders={draft.placeholders}
          tz={tz}
          onClose={() => setSendOpen(false)}
          onAnswer={() => void refresh()}
          returnFocusRef={sendRef}
          fallbackFocusRef={liveRef}
        />
      )}
    </div>
  );
}
