"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { ReplyBlocker } from "@/lib/exec/slack-p10-types";
import { useIsTopWindow } from "../../drafts/frame-guard";
import { ReplySendContent, type ReplySendPhase } from "./ReplySendContent";
import {
  closeFocusTarget, isBlocker, parseSendAnswer, REPLY_UI_COPY, refusalText, sendAnswerBanner, sha256HexOf, type FocusTarget, type ReplyBanner, type SendAnswer
} from "./reply-logic";

// The send dialog (P10 contract §3.5.13, C34, C59; v1.1 product-6, -20; Area D). A Radix dialog portaled into <body> (the
// app's <main> is a z-10 stacking context). On open it calls the review route and shows a loading line until it answers;
// then the exact stored text, read-only, the destination, one checkbox per blocker the review named (every one before the
// first Send), and Send. Send hashes the very text it shows (sha256 of its NFC form, crypto.subtle) and posts { version,
// textSha256, acks }: the server posts the STORED text only when that hash matches. A needs_ack answer re-renders with the
// new checkboxes and "Something changed since you opened this". Focus moves to the title on open and back to the Send
// button that opened it on close. Nothing here renders HTML from content.
//
// P10 fixer ui-2: the review runs when the dialog OPENS (its deps are [open, draftId]; the version it reviews is read from a
// ref). A send answer bumps the draft's version (back_to_draft: version + 1) and the page re-reads it while the dialog is
// still open; that must not re-run the review, which would wipe the answer's banner and offer Send again with every box
// unticked. A retry is a fresh open, so a fresh review on the new version.
// P10 fixer ui-6: the dialog is opened by a plain button, not a Dialog.Trigger, so Radix has no trigger to give focus back
// to; onCloseAutoFocus does it (the opener while it is still in the page, else the page's status region).

const COPY = SLACK_P10_COPY.replies;

export function ReplySendDialog({
  open,
  draftId,
  version,
  text,
  place,
  inThread,
  placeholders,
  tz,
  onClose,
  onAnswer,
  returnFocusRef,
  fallbackFocusRef
}: {
  open: boolean;
  draftId: string;
  version: number;
  /** The stored text the page read (the review and the send bind to it). */
  text: string;
  place: string;
  inThread: boolean;
  placeholders: readonly string[];
  tz: string;
  onClose: () => void;
  /** Every send answer, so the page re-reads the draft. */
  onAnswer: (a: SendAnswer) => void;
  /** ui-6: the button that opened the dialog (focus goes back to it on close while it is still in the page). */
  returnFocusRef?: RefObject<FocusTarget | null>;
  /** ui-6: where focus goes when the opener is gone (the draft left `draft`): the page's status region (tabIndex -1). */
  fallbackFocusRef?: RefObject<FocusTarget | null>;
}) {
  const isTop = useIsTopWindow();
  const [phase, setPhase] = useState<ReplySendPhase>("loading");
  const [blockers, setBlockers] = useState<ReplyBlocker[]>([]);
  const [changed, setChanged] = useState<ReplyBlocker[]>([]);
  const [acks, setAcks] = useState<ReplyBlocker[]>([]);
  const [banner, setBanner] = useState<ReplyBanner | null>(null);
  const [where, setWhere] = useState<{ place: string; inThread: boolean }>({ place, inThread });
  const titleRef = useRef<HTMLHeadingElement>(null);
  // ui-2: the version the next open reviews (kept current on every render; a change while open never re-runs the review).
  const versionRef = useRef(version);
  versionRef.current = version;

  // C59: the review on every open (a new open is a new confirmation: nothing stays ticked).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPhase("loading");
    setBlockers([]);
    setChanged([]);
    setAcks([]);
    setBanner(null);
    void (async () => {
      try {
        const res = await fetch(`/api/exec/slack/replies/${encodeURIComponent(draftId)}/review`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: versionRef.current })
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (res.status === 200 && Array.isArray(body.blockers)) {
          setBlockers(body.blockers.filter((b): b is ReplyBlocker => typeof b === "string" && isBlocker(b)));
          if (typeof body.place === "string") setWhere({ place: body.place, inThread: body.inThread === true });
          setPhase("ready");
        } else {
          setBanner({ role: "alert", tone: "danger", text: refusalText(typeof body.reason === "string" ? body.reason : res.status === 404 ? "not_found" : "other") });
          setPhase("error");
        }
      } catch {
        if (!live) return;
        setBanner({ role: "alert", tone: "danger", text: REPLY_UI_COPY.failed });
        setPhase("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [open, draftId]);

  const toggle = (b: ReplyBlocker) => setAcks((cur) => (cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]));

  const send = async () => {
    if (phase !== "ready") return;
    setPhase("sending");
    setBanner(null);
    let answer: SendAnswer;
    try {
      const textSha256 = await sha256HexOf(text);
      const res = await fetch(`/api/exec/slack/replies/${encodeURIComponent(draftId)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version, textSha256, acks })
      });
      answer = parseSendAnswer(res.status, await res.json().catch(() => ({})));
    } catch {
      answer = { kind: "error" };
    }
    const nowIso = new Date().toISOString();
    if (answer.kind === "needs_ack") {
      // v1.1 product-6: only what appeared after the review is new; every box he ticked stays ticked.
      const fresh = answer.blockers.filter((b) => !blockers.includes(b));
      setBlockers((cur) => [...cur, ...fresh]);
      setChanged(fresh.length > 0 ? fresh : answer.blockers);
      setBanner(null);
      setPhase("ready");
    } else {
      setBanner(answer.kind === "error" ? { role: "alert", tone: "danger", text: REPLY_UI_COPY.failed } : sendAnswerBanner(answer, tz, nowIso));
      setPhase(answer.kind === "error" ? "ready" : "done");
    }
    onAnswer(answer);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && phase !== "sending") onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            titleRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // ui-6: Radix would focus its (absent) trigger, so focus fell to <body>.
            e.preventDefault();
            closeFocusTarget(returnFocusRef?.current ?? null, fallbackFocusRef?.current ?? null)?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (phase === "sending") e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (phase === "sending") e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (phase === "sending") e.preventDefault();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(640px,92vw)] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_24px_72px_-24px_rgba(15,23,42,0.45)] outline-none"
        >
          <Dialog.Title ref={titleRef} tabIndex={-1} className="text-[15px] font-bold text-ink outline-none">
            {COPY.sendTitle}
          </Dialog.Title>
          <Dialog.Description className="sr-only">{COPY.sendAcksTitle}</Dialog.Description>
          <div className="mt-3">
            <ReplySendContent
              text={text}
              place={where.place}
              inThread={where.inThread}
              phase={phase}
              blockers={blockers}
              changed={changed}
              acks={acks}
              placeholders={placeholders}
              banner={banner}
              isTop={isTop}
              onToggleAck={toggle}
              onSend={() => void send()}
              onCancel={() => {
                if (phase !== "sending") onClose();
              }}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
