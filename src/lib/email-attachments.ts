// What one outbound email may carry. Shared by the composers that collect
// attachments and by the send path that forwards them, so the hint on the
// picker, the toast at Send and the error a non-UI caller gets all name the
// same number.
//
// The value mirrors the missive clone's own cap (backend/src/util/upload.js,
// MAX_ATTACHMENTS). The clone is what actually refuses an over-limit send, and
// it refuses during multipart parsing — before any of its route code runs — so
// all it can say afterwards is that a form field was unexpected. That is the
// 413 "Unexpected upload field." senders were getting. Duplicating the number
// here lets DD say no while the sender can still do something about it.
//
// Keep this <= the clone's cap. Lower is merely conservative; higher means DD
// waves through sends the clone will bounce, which is the precise failure this
// constant exists to prevent — so if the cap ever moves, DEPLOY THE CLONE FIRST.
//
// What bounds the number is not memory: the clone already admits 150 MB per
// file with no aggregate cap, so bytes are governed elsewhere (or not at all —
// see the note on /api/clients/bulk-email). It is time. The clone attaches to
// Graph strictly serially, one HTTP round trip per file, under DD's 60 s route
// ceiling (`maxDuration` on the send routes).
export const MAX_ATTACHMENTS_PER_EMAIL = 25;

// One phrasing wherever we have to say no, so the pick-time toast, the
// pre-send guard and the API error don't each invent their own wording.
export function tooManyAttachmentsMessage(count: number): string {
  const over = count - MAX_ATTACHMENTS_PER_EMAIL;
  return `${count} attachments — ${MAX_ATTACHMENTS_PER_EMAIL} is the most one email can carry. `
    + `Remove ${over} ${over === 1 ? "file" : "files"} and send ${over === 1 ? "it" : "them"} in a second email.`;
}
