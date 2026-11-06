import { Paperclip, TriangleAlert } from "lucide-react";
import type { DraftAddress, GenerationFlag, ReviewBlocker, ReviewResult } from "@/lib/exec/drafts-types";
import { formatInZone } from "@/lib/exec/format";
import { cn } from "@/lib/utils";
import { blockerCopy, codeSentence, COPY, GENERIC_FAILURE_SENTENCE, isRecipientError, recipientEntry } from "./copy";
import { ReadBackFrame } from "./ReadBackFrame";
import { RecipientChip } from "./RecipientChips";

// The confirm dialog's body (P4 contract §3.13.3/§3.13.4, L10, C64, C75):
// exactly what the mail service read back from the Outlook draft, so what he
// confirms is what goes out. From and Sender (address first, highlighted when
// they differ), Reply-To with its warning, To/Cc/Bcc with badges, the
// subject, the body in P4's own sandboxed frame (remote images never load;
// links don't open), attachments, the signature note, every blocker as a
// required checkbox, the one-place line, the review countdown, and a Send
// button that names the first To ADDRESS (never a display name).
//
// When the preview couldn't be built safely (readBack null, C64) or the
// review found errors, there is no Send button. Props only, server-
// renderable; the frame's srcdoc is set after mount by ReadBackFrame.

export function sendButtonLabel(review: Pick<ReviewResult, "readBack">): string {
  const rb = review.readBack;
  const all = rb === null ? [] : [...rb.to, ...rb.cc, ...rb.bcc];
  const first = all[0]?.address ?? "no one";
  const more = all.length - 1;
  return more > 0 ? `Send to ${first} and ${more} more` : `Send to ${first}`;
}

const sizeLabel = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function Address({ a, highlight = false }: { a: DraftAddress | null; highlight?: boolean }) {
  if (a === null) return <span className="text-muted">—</span>;
  return (
    <span className={cn("break-all", highlight && "rounded bg-amber-100 px-1 text-amber-900")}>
      <span className="font-medium">{a.address}</span>
      {a.name && <span className="text-muted">{` (${a.name})`}</span>}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[12.5px]">
      <span className="w-14 shrink-0 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function ConfirmSendContent({
  review,
  acks,
  onToggleAck,
  isTop,
  busy,
  nowIso,
  tz,
  onCancel,
  onSend,
  clientName = null,
  flags = []
}: {
  review: ReviewResult;
  acks: ReviewBlocker[];
  onToggleAck: (b: ReviewBlocker) => void;
  isTop: boolean;
  busy: boolean;
  nowIso: string;
  tz: string;
  onCancel: () => void;
  onSend: () => void;
  /** The facts client's name and the output flags, for the blockers' <client> / <kinds> (DD data). */
  clientName?: string | null;
  flags?: readonly GenerationFlag[];
}) {
  const rb = review.readBack;
  const fromDiffers = rb !== null && rb.from !== null && rb.sender !== null && rb.from.address !== rb.sender.address;
  const errors = review.errors;
  const canSend = isTop && rb !== null && review.reviewHash !== null && errors.length === 0;
  const errorItems = reviewErrorLines(review, clientName);
  const allAcked = review.blockers.every((b) => acks.includes(b));
  const validUntil = formatInZone(review.reviewExpiresAt, tz, "time", nowIso);
  const expiresMs = review.reviewExpiresAt === null ? null : Date.parse(review.reviewExpiresAt);
  const expired = expiresMs !== null && Number.isFinite(expiresMs) && Date.parse(nowIso) >= expiresMs;

  return (
    <div data-confirm-send className="space-y-4">
      {rb === null ? (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[12.5px] text-rose-900">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{COPY.previewRefused}</span>
        </p>
      ) : (
        <>
          <div className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
            <Row label="From">
              <Address a={rb.from} highlight={fromDiffers} />
            </Row>
            {(rb.sender !== null || fromDiffers) && (
              <Row label="Sender">
                <Address a={rb.sender} highlight={fromDiffers} />
              </Row>
            )}
            {rb.replyTo.length > 0 && (
              <Row label="Reply-To">
                {rb.replyTo.map((a) => (
                  <Address key={a.address} a={a} />
                ))}
                <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-800">Replies go here</span>
              </Row>
            )}
            <Row label="To">
              {rb.to.length === 0 && <span className="text-muted">No one</span>}
              {rb.to.map((r) => (
                <RecipientChip key={r.address} recipient={r} />
              ))}
            </Row>
            {rb.cc.length > 0 && (
              <Row label="Cc">
                {rb.cc.map((r) => (
                  <RecipientChip key={r.address} recipient={r} />
                ))}
              </Row>
            )}
            {rb.bcc.length > 0 && (
              <Row label="Bcc">
                {rb.bcc.map((r) => (
                  <RecipientChip key={r.address} recipient={r} />
                ))}
              </Row>
            )}
            <Row label="Subject">
              <span className="break-words font-medium text-ink">{rb.subject === "" ? "(no subject)" : rb.subject}</span>
            </Row>
          </div>

          <div className="space-y-1.5">
            <ReadBackFrame srcdoc={rb.srcdoc} title="The draft as Outlook holds it" />
            <p className="text-[11.5px] text-muted">
              {rb.remoteImageCount > 0 ? `${rb.remoteImageCount} remote ${rb.remoteImageCount === 1 ? "image" : "images"} not loaded. ` : ""}
              {COPY.linksDontOpen}
            </p>
            {rb.truncated && (
              <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{COPY.previewCut}</span>
              </p>
            )}
          </div>

          {rb.attachments.length > 0 && (
            <ul className="space-y-1 text-[12.5px] text-slate-700">
              {rb.attachments.map((a, i) => (
                <li key={`${a.name}-${i}`} className="flex flex-wrap items-center gap-1.5">
                  <Paperclip className="h-3.5 w-3.5 text-muted" aria-hidden />
                  <span className="break-all font-medium">{a.name}</span>
                  <span className="text-muted">{sizeLabel(a.size)}</span>
                  {a.isInline && <span className="text-muted">inline image from the quoted email</span>}
                </li>
              ))}
            </ul>
          )}

          <p className="text-[12px] text-slate-600">{rb.signatureSkipped ? COPY.signatureSkipped : COPY.signatureAdded}</p>
        </>
      )}

      {errorItems.length > 0 && (
        <div role="alert" className="space-y-1 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[12.5px] text-rose-900">
          <p className="font-semibold">This can't be sent yet:</p>
          <ul className="list-disc pl-5">
            {errorItems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {review.warnings.length > 0 && (
        <ul className="space-y-0.5 text-[12px] text-amber-900">
          {review.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>{warningLine(w)}</li>
          ))}
        </ul>
      )}

      {review.blockers.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">Before sending</p>
          {review.blockers.map((b) => (
            <label key={b} className="flex items-start gap-2 text-[12.5px] text-slate-800">
              <input
                type="checkbox"
                required
                checked={acks.includes(b)}
                onChange={() => onToggleAck(b)}
                disabled={busy}
                data-blocker={b}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>{blockerCopy(b, { clientName, flags })}</span>
            </label>
          ))}
        </div>
      )}

      <p className="text-[12.5px] font-medium text-slate-700">{COPY.openInOutlookWarning}</p>
      {review.reviewExpiresAt !== null && !expired && <p className="text-[12px] text-muted">{`This review is valid until ${validUntil}`}</p>}
      {expired && (
        <p role="alert" className="text-[12.5px] font-medium text-rose-700">
          {codeSentence("review_expired")}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
        <button
          type="button"
          data-confirm="cancel"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50"
        >
          Cancel
        </button>
        {canSend && (
          <span className="inline-flex flex-col items-end gap-0.5">
            <button
              type="button"
              data-confirm="send"
              onClick={onSend}
              disabled={busy || !allAcked || expired}
              className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Sending…" : sendButtonLabel(review)}
            </button>
            <span className="text-[11px] text-muted">{COPY.sendsImmediately}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The review's errors as words (ui-3, ui-4): a recipient code gets one entry
 * per address it names (the answer's errorEntries; for From / Sender, the
 * read-back's own address when an older answer carries none), placeholders
 * and the subject their route sentence. preview_unavailable is left out (the
 * "preview couldn't be built" alert says it), and a code this build doesn't
 * know is the generic sentence, never the raw code.
 */
export function reviewErrorLines(review: Pick<ReviewResult, "errors" | "errorEntries" | "readBack">, clientName: string | null): string[] {
  const out: string[] = [];
  const rb = review.readBack;
  const entries = review.errorEntries ?? [];
  for (const code of new Set(review.errors)) {
    if (code === "preview_unavailable") continue;
    if (code === "placeholders" || code === "subject_required") {
      out.push(codeSentence(code) ?? GENERIC_FAILURE_SENTENCE);
      continue;
    }
    if (!isRecipientError(code)) {
      out.push(GENERIC_FAILURE_SENTENCE);
      continue;
    }
    let addresses = entries.filter((e) => e.code === code).map((e) => e.address);
    if (addresses.length === 0 && code === "from_mismatch") addresses = [rb?.from?.address ?? null];
    if (addresses.length === 0 && code === "sender_mismatch") addresses = [rb?.sender?.address ?? null];
    if (addresses.length === 0) addresses = [null];
    for (const a of addresses) out.push(recipientEntry(code, a, clientName));
  }
  return [...new Set(out)];
}

function warningLine(w: ReviewResult["warnings"][number]): string {
  switch (w.code) {
    case "external_domain":
      return `${w.value ?? "A recipient"} is outside the company.`;
    case "role_address":
      return `${w.value ?? "A recipient"} looks like a shared or role mailbox.`;
    case "reply_to_present":
      return "Replies will go to the Reply-To address, not to this thread.";
    default:
      return String(w.code);
  }
}
