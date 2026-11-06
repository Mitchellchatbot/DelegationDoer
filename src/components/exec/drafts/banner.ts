import type { DraftView } from "@/lib/exec/drafts-types";
import { formatInZone } from "@/lib/exec/format";
import { codeSentence, COPY, DRAFTS_UNAVAILABLE_SENTENCE, factsBanner, flagsBanner, GENERATION_FAILED_SENTENCE, THROTTLED_SHORTLY_SENTENCE } from "./copy";

// The status banner's words for every DraftPanel state (P4 contract §3.13.4),
// as pure data the component renders: one headline, its tone, and the extra
// lines the row names. Times are formatted in his zone from the page's
// nowIso; nothing here comes from the mail service or a mail header
// (recipients are addresses, C75).

export type BannerTone = "info" | "progress" | "ok" | "warn" | "danger" | "muted";

export interface BannerCopy {
  headline: string;
  tone: BannerTone;
  /** Lines under the headline (signature note, sent-copy notes, hold-until, ...). */
  notes: string[];
}

const elapsedSeconds = (sinceIso: string, nowIso: string): number => {
  const since = Date.parse(sinceIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(since) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - since) / 1000));
};

const addressList = (view: DraftView): string => {
  const addresses = [...view.to, ...view.cc, ...view.bcc].map((r) => r.address).filter((a) => a.length > 0);
  return addresses.length === 0 ? "no recipients" : addresses.join(", ");
};

/**
 * The `unknown` row's owner resolution opens 30 min after send_started_at (C68). The server says when
 * (DraftView.sent.pastHorizon, ui-8): the capabilities are emptied whenever drafts are unavailable, so they
 * can't tell an early unknown from one hours old.
 */
export function unknownPastHorizon(view: DraftView): boolean {
  return view.sent.pastHorizon === true;
}

/** A linked `draft` whose Outlook copy changed after the save (buildability-1). */
export function changedInOutlook(view: DraftView): boolean {
  return view.outlook.linked && (view.lastError?.code === "outlook_changed" || view.outlook.changedSinceSaved);
}

function restrictedBanner(view: DraftView, nowIso: string, tz: string): BannerCopy {
  const linked = view.outlook.linked;
  switch (view.status) {
    case "saved":
    case "draft":
      if (linked) return { headline: "Draft for a restricted thread: content removed. Delete it in Outlook.", tone: "warn", notes: [] };
      break;
    case "unknown":
      return {
        headline: "Draft for a restricted thread: content removed. We can't confirm whether it was sent. Check Sent Items in Outlook.",
        tone: "danger",
        notes: []
      };
    case "sending":
    case "sent_pending":
    case "discarding":
      return { headline: "Draft for a restricted thread: content removed. Its last action is still being confirmed.", tone: "progress", notes: [] };
    case "sent":
    case "sent_external": {
      const when = formatInZone(view.sent.at, tz, "datetime", nowIso);
      return { headline: `Draft for a restricted thread: content removed. It was sent ${when}.`, tone: "muted", notes: [] };
    }
    case "gone":
      return { headline: "Draft for a restricted thread: content removed. It's no longer in your Outlook Drafts.", tone: "muted", notes: [] };
    default:
      break;
  }
  const notes = view.lastError?.code === "outlook_unknown_restricted" ? ["An Outlook copy may remain: check your Outlook Drafts."] : [];
  return { headline: "This draft was for a restricted thread; its content was removed.", tone: "muted", notes };
}

/** The headline and notes for a DraftView (§3.13.4, one row per state). */
export function statusBanner(view: DraftView, nowIso: string, tz: string): BannerCopy {
  if (view.restricted) return restrictedBanner(view, nowIso, tz);
  switch (view.status) {
    case "generating":
      return { headline: `Drafting… (${elapsedSeconds(view.updatedAt, nowIso)}s)`, tone: "progress", notes: [] };
    case "generation_failed": {
      const code = view.generationError ?? "model_error";
      return { headline: GENERATION_FAILED_SENTENCE[code] ?? GENERATION_FAILED_SENTENCE.model_error, tone: "danger", notes: [] };
    }
    case "draft":
      if (changedInOutlook(view)) return { headline: "This draft was changed in Outlook after you saved it.", tone: "warn", notes: [] };
      if (view.staleLink) {
        return { headline: "Edited here since you saved. Your Outlook draft is the older version: save again to replace it.", tone: "warn", notes: [] };
      }
      return { headline: "In DD only. Not in Outlook yet.", tone: "info", notes: [] };
    case "saving":
      if (view.lastError?.code === "outcome_unknown") return { headline: "We couldn't confirm the save. Checking…", tone: "progress", notes: [] };
      return { headline: `Saving to your Outlook Drafts… (${elapsedSeconds(view.updatedAt, nowIso)}s)`, tone: "progress", notes: [] };
    case "saved": {
      const notes = [view.outlook.signatureSkipped ? COPY.signatureSkipped : COPY.signatureAdded];
      if (view.outlook.changedSinceSaved) {
        return { headline: "Changed in Outlook since you saved. Saving or discarding here will show you that version first.", tone: "warn", notes };
      }
      if (view.outlook.edited) return { headline: "You kept the Outlook version. Editing here would replace it.", tone: "info", notes };
      return { headline: "Saved in your Outlook Drafts. People with access to your mailbox can see it.", tone: "ok", notes };
    }
    case "sending":
      return { headline: "Sending…", tone: "progress", notes: [] };
    case "sent_pending":
      return { headline: "Sent. Confirming it reached your Sent Items…", tone: "progress", notes: [] };
    case "sent": {
      const when = formatInZone(view.sent.at, tz, "datetime", nowIso);
      const notes: string[] = [];
      if (view.sent.mismatch) notes.push("Sent; the Sent copy didn't match exactly, ops notified.");
      if (view.sent.unverified) notes.push("Sent; not verified against your Sent Items.");
      return { headline: `Sent ${when} to ${addressList(view)}.`, tone: "ok", notes };
    }
    case "sent_external":
      return { headline: "This draft, or an earlier version of it, was sent from Outlook.", tone: "ok", notes: [] };
    case "unknown":
      if (unknownPastHorizon(view)) return { headline: "Outcome unknown. Check Sent Items in Outlook.", tone: "danger", notes: [] };
      return { headline: "We can't confirm it went out yet. Don't send it again: check your Sent Items.", tone: "danger", notes: [] };
    case "gone":
      if (view.lastError?.code === "outlook_reappeared") {
        return { headline: "An older Outlook draft for this thread is back in your Drafts. Delete it in Outlook.", tone: "warn", notes: [] };
      }
      if (view.gone.unconfirmed) {
        const until = formatInZone(view.gone.holdUntil, tz, "time", nowIso);
        return { headline: `This draft is no longer in your Outlook Drafts. Checking whether it was sent… (until ${until})`, tone: "warn", notes: [] };
      }
      return { headline: "Deleted in Outlook.", tone: "muted", notes: [] };
    case "discarding":
      return { headline: "Removing from Outlook…", tone: "progress", notes: [] };
    case "discarded":
      return { headline: "Discarded.", tone: "muted", notes: view.lastError?.code === "expired_idle" ? ["Closed after 30 days without changes."] : [] };
    default:
      return { headline: "This draft is in a state this page doesn't know. Reload the page.", tone: "warn", notes: [] };
  }
}

/** The last-error codes whose sentence the banner row itself already states. */
const NAMED_IN_BANNER: ReadonlySet<string> = new Set(["outlook_changed", "outcome_unknown", "outlook_reappeared", "expired_idle", "outlook_unknown_restricted"]);

/** The sentence shown above the banner for a lastError the row doesn't name (§3.13.4), or null. */
export function lastErrorNotice(view: DraftView): string | null {
  const code = view.lastError?.code;
  if (!code || NAMED_IN_BANNER.has(code)) return null;
  if (code === "outlook_changed" || (view.status === "generating" && code.startsWith("generation_"))) return null;
  // ui-5: a stored `throttled` has no wait the row knows; a number here would go stale on every later load.
  if (code === "throttled") return THROTTLED_SHORTLY_SENTENCE;
  // ui-6: a stored bad_request is always the clone's (DD's own refusal is a 400, never written to the row).
  return codeSentence(code, { fromClone: true });
}

/**
 * ui-2: whether the "drafts unavailable" notice offers "Check again": only for
 * a readiness reason the clone or the token can recover from on its own (not
 * the switch, not a mailbox the team must reconnect).
 */
export function canRecheckReadiness(view: DraftView): boolean {
  const reason = view.capabilities.draftsUnavailable;
  return reason !== null && reason !== "drafts_off" && reason !== "mailbox_problem";
}

/** "Drafts are unavailable: <reason>." when the clone path isn't proven for this row (§3.13.4 "drafts unavailable"), else null. */
export function unavailableNotice(view: DraftView): string | null {
  const reason = view.capabilities.draftsUnavailable;
  return reason === null ? null : DRAFTS_UNAVAILABLE_SENTENCE(reason);
}

/** The lines under a `draft` / `saved` banner: facts, output flags, the UTC note (§3.13.4). */
export function draftAdvisories(view: DraftView, clientName: string | null = null): string[] {
  if (view.restricted) return [];
  const out: string[] = [];
  if (view.status === "draft" || view.status === "saved" || view.status === "generating") {
    const facts = factsBanner(view.factsStatus, clientName);
    if (facts) out.push(facts);
    const flags = flagsBanner(view.generationFlags);
    if (flags) out.push(flags);
  }
  if ((view.status === "draft" || view.status === "saved") && !view.mailTimezone.mapped) out.push(COPY.utcTimes);
  return out;
}
