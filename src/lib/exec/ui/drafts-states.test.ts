import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));

import { actionsFor, DraftActions, sendHintText, showsCheckedBox } from "@/components/exec/drafts/DraftActions";
import { sendProbeAnswer } from "@/components/exec/drafts/panel-logic";
import { DraftBodyPreview, previewParagraphs } from "@/components/exec/drafts/DraftBodyPreview";
import { DraftStatusBanner } from "@/components/exec/drafts/DraftStatusBanner";
import { NewDraft } from "@/components/exec/drafts/DraftPanel";
import { bodyModeFor } from "@/components/exec/drafts/body-mode";
import { COPY, GENERATION_FAILED_SENTENCE, reasonWords } from "@/components/exec/drafts/copy";
import { openInOutlookFlow, openNow } from "@/components/exec/drafts/open-in-outlook";
import { pollErrorCopy, pollIntervalFor } from "@/components/exec/drafts/poll";
import type { DraftView, GenerationError, SendUnavailable } from "@/lib/exec/drafts-types";
import { formatInZone } from "@/lib/exec/format";
import { actionsIn, caps, draftView, NOW_ISO, restrictedView, textOf, TZ, WEB_LINK } from "../__tests__/drafts-ui-fixtures";

// UI01, UI02, UI11 and the bodyModeFor / polling half of UI13 (P4 contract
// §5.11): every DraftPanel state of §3.13.4 as the banner and the buttons
// render it on the server, the frame guard, and Open in Outlook as a button.

const banner = (view: DraftView, pollFailures = 0) =>
  textOf(renderToStaticMarkup(createElement(DraftStatusBanner, { view, tz: TZ, nowIso: NOW_ISO, pollFailures })));
const buttons = (view: DraftView, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(DraftActions, { view, isTop: true, busy: null, sendReady: null, onAction: () => {}, ...extra }));

const LINKED = { linked: true, webLink: WEB_LINK };
/** ui-8: the server says the unknown row is 30 min or more past its send. */
const PAST = { pastHorizon: true };
const at = (iso: string | null) => formatInZone(iso, TZ, "datetime", NOW_ISO);

interface Row {
  name: string;
  view: DraftView;
  headline: string;
  actions: string[];
  extra?: Record<string, unknown>;
  /** Other text the row must show. */
  shows?: string[];
}

const ROWS: Row[] = [
  {
    name: "generating (a first generation): Drafting… with the seconds, and Stop (C71)",
    view: draftView({ status: "generating", bodyText: null, bodyDoc: null, capabilities: { resolve: ["stop_generation"] } }),
    headline: "Drafting… (30s)",
    actions: ["stop"]
  },
  {
    name: "draft, no link",
    view: draftView({ capabilities: { canEdit: true, canRegenerate: true, canSave: true, canDiscard: true } }),
    headline: "In DD only. Not in Outlook yet.",
    actions: ["regenerate", "save", "discard"],
    shows: ["Note from the assistant", "Check the date.", "Regenerate", "Save to Outlook", "Discard"]
  },
  {
    name: "draft, stale link",
    view: draftView({
      staleLink: true,
      savedVersion: 2,
      outlook: LINKED,
      capabilities: { canEdit: true, canRegenerate: true, canSave: true, canDiscard: true, canOpenInOutlook: true, resolve: ["check"] }
    }),
    headline: "Edited here since you saved. Your Outlook draft is the older version: save again to replace it.",
    actions: ["save", "regenerate", "check_again", "discard"],
    shows: ["Save again", "Check again"]
  },
  {
    name: "draft, linked, changed in Outlook (outlook_changed): Show the Outlook version first",
    view: draftView({
      outlook: LINKED,
      savedVersion: 2,
      lastError: { code: "outlook_changed", at: NOW_ISO },
      capabilities: { canEdit: true, canSave: true, canDiscard: true, resolve: ["check", "keep_outlook_version"] }
    }),
    headline: "This draft was changed in Outlook after you saved it.",
    actions: ["show_outlook_version"],
    shows: ["Show the Outlook version"]
  },
  {
    name: "draft, changed in Outlook, once the Outlook version is shown: the three follow-ups",
    view: draftView({
      outlook: { ...LINKED, changedSinceSaved: true },
      savedVersion: 2,
      capabilities: { canEdit: true, canSave: true, canDiscard: true, resolve: ["check", "keep_outlook_version"] }
    }),
    extra: { outlookVersionShown: true },
    headline: "This draft was changed in Outlook after you saved it.",
    actions: ["show_outlook_version", "replace_with_dd", "resolve:keep_outlook_version", "delete_anyway"],
    shows: ["Replace it with this version", "Keep the Outlook version", "Delete anyway"]
  },
  {
    name: "saving",
    view: draftView({ status: "saving" }),
    headline: "Saving to your Outlook Drafts… (30s)",
    actions: []
  },
  {
    name: "saving after T25 (outcome_unknown)",
    view: draftView({ status: "saving", lastError: { code: "outcome_unknown", at: NOW_ISO } }),
    headline: "We couldn't confirm the save. Checking…",
    actions: []
  },
  {
    name: "saved: Review & send, Open in Outlook (with the L13 warning), Check again, Regenerate, Discard",
    view: draftView({
      status: "saved",
      savedVersion: 3,
      outlook: LINKED,
      capabilities: { canEdit: true, canReview: true, canRegenerate: true, canDiscard: true, canOpenInOutlook: true, resolve: ["check"] }
    }),
    headline: "Saved in your Outlook Drafts. People with access to your mailbox can see it.",
    actions: ["review", "open_in_outlook", "check_again", "regenerate", "discard"],
    shows: ["Your stored signature was added", COPY.outlookEditWarning, "Review & send", "Open in Outlook"]
  },
  {
    name: "saved with sending unavailable: no Review & send, the hint instead",
    view: draftView({
      status: "saved",
      savedVersion: 3,
      outlook: { ...LINKED, signatureSkipped: true },
      capabilities: { canEdit: true, canRegenerate: true, canDiscard: true, canOpenInOutlook: true, resolve: ["check"], sendUnavailable: "send_off" }
    }),
    headline: "Saved in your Outlook Drafts. People with access to your mailbox can see it.",
    actions: ["open_in_outlook", "check_again", "regenerate", "discard"],
    shows: ["Your signature wasn't added", "Sending from here isn't switched on yet. Open it in Outlook to send."]
  },
  {
    name: "saved, changed in Outlook since the save",
    view: draftView({
      status: "saved",
      savedVersion: 3,
      outlook: { ...LINKED, changedSinceSaved: true },
      capabilities: { canEdit: true, canReview: true, canRegenerate: true, canDiscard: true, canSave: false, canOpenInOutlook: true, resolve: ["check", "keep_outlook_version"] }
    }),
    headline: "Changed in Outlook since you saved. Saving or discarding here will show you that version first.",
    actions: ["review", "open_in_outlook", "check_again", "regenerate", "discard", "show_outlook_version"]
  },
  {
    name: "saved, he kept the Outlook version",
    view: draftView({ status: "saved", savedVersion: 3, outlook: { ...LINKED, edited: true }, capabilities: { canDiscard: true } }),
    headline: "You kept the Outlook version. Editing here would replace it.",
    actions: ["discard"]
  },
  { name: "sending", view: draftView({ status: "sending", outlook: LINKED }), headline: "Sending…", actions: [] },
  {
    name: "sent_pending: Open sent copy (a button) and Check again",
    view: draftView({ status: "sent_pending", outlook: LINKED, capabilities: { resolve: ["check"] } }),
    headline: "Sent. Confirming it reached your Sent Items…",
    actions: ["open_in_outlook", "check_again"],
    shows: ["Open sent copy"]
  },
  {
    name: "sent, with the mismatch and unverified notes",
    view: draftView({ status: "sent", outlook: LINKED, sent: { at: "2026-11-06T14:40:00.000Z", mismatch: true, unverified: true } }),
    headline: `Sent ${at("2026-11-06T14:40:00.000Z")} to jane@acme.com.`,
    actions: ["open_in_outlook"],
    shows: ["Sent; the Sent copy didn't match exactly, ops notified.", "Sent; not verified against your Sent Items.", "View the thread", "Open sent copy"]
  },
  {
    name: "sent_external",
    view: draftView({ status: "sent_external", outlook: LINKED }),
    headline: "This draft, or an earlier version of it, was sent from Outlook.",
    actions: [],
    shows: ["View the thread"]
  },
  {
    name: "unknown, less than 30 min after the send",
    view: draftView({ status: "unknown", outlook: LINKED, capabilities: { canOpenInOutlook: true, resolve: ["check"] } }),
    headline: "We can't confirm it went out yet. Don't send it again: check your Sent Items.",
    actions: ["check_again", "open_in_outlook"]
  },
  {
    name: "unknown, 30 min or more after the send (flag or not): the owner resolution behind the checkbox",
    view: draftView({ status: "unknown", outlook: LINKED, cloneFlags: ["send_status_unknown"], sent: PAST, capabilities: { resolve: ["check", "mark_sent", "not_sent_new_draft"] } }),
    headline: "Outcome unknown. Check Sent Items in Outlook.",
    actions: ["check_again", "resolve:mark_sent", "resolve:not_sent_new_draft"],
    shows: [COPY.checkedOutlook, "It was sent", "It wasn't sent: make a new draft"]
  },
  {
    name: "unknown past the horizon, no flag mirrored (C68): the same resolution",
    view: draftView({ status: "unknown", outlook: LINKED, sent: PAST, capabilities: { resolve: ["check", "mark_sent", "not_sent_new_draft"] } }),
    headline: "Outcome unknown. Check Sent Items in Outlook.",
    actions: ["check_again", "resolve:mark_sent", "resolve:not_sent_new_draft"]
  },
  {
    name: "unknown, a failed 'It wasn't sent' answered 409 changed: Delete it anyway and make a new draft",
    view: draftView({ status: "unknown", outlook: LINKED, sent: PAST, capabilities: { resolve: ["check", "mark_sent", "not_sent_new_draft"] } }),
    extra: { outlookVersionShown: true },
    headline: "Outcome unknown. Check Sent Items in Outlook.",
    actions: ["check_again", "resolve:mark_sent", "resolve:not_sent_new_draft"],
    shows: ["Delete it anyway and make a new draft"]
  },
  {
    name: "gone + unconfirmed: the checkbox is always there (buildability-3)",
    view: draftView({
      status: "gone",
      outlook: LINKED,
      gone: { at: "2026-11-06T14:58:00.000Z", unconfirmed: true, holdUntil: "2026-11-06T15:14:00.000Z" },
      capabilities: { resolve: ["check", "copy_to_new_draft", "mark_sent"] }
    }),
    headline: `This draft is no longer in your Outlook Drafts. Checking whether it was sent… (until ${formatInZone("2026-11-06T15:14:00.000Z", TZ, "time", NOW_ISO)})`,
    actions: ["check_again", "resolve:copy_to_new_draft", "resolve:mark_sent"],
    shows: [COPY.checkedOutlook, "Make a new draft from this text", "It was sent"]
  },
  {
    name: "gone (confirmed): the checkbox stays",
    view: draftView({ status: "gone", outlook: LINKED, gone: { at: "2026-11-06T14:00:00.000Z", unconfirmed: false }, capabilities: { resolve: ["copy_to_new_draft", "mark_sent"] } }),
    headline: "Deleted in Outlook.",
    actions: ["resolve:copy_to_new_draft", "resolve:mark_sent"],
    shows: [COPY.checkedOutlook]
  },
  {
    name: "gone, outlook_reappeared: no actions",
    view: draftView({ status: "gone", outlook: LINKED, lastError: { code: "outlook_reappeared", at: NOW_ISO } }),
    headline: "An older Outlook draft for this thread is back in your Drafts. Delete it in Outlook.",
    actions: []
  },
  { name: "discarding", view: draftView({ status: "discarding", outlook: LINKED }), headline: "Removing from Outlook…", actions: [] },
  {
    name: "discarded (idle): Draft again on the thread",
    view: draftView({ status: "discarded", lastError: { code: "expired_idle", at: NOW_ISO } }),
    headline: "Discarded.",
    actions: [],
    shows: ["Closed after 30 days without changes.", "Draft again"]
  },
  {
    name: "restricted, saved: Delete (with its confirm line)",
    view: restrictedView({ status: "saved", outlook: LINKED, capabilities: { canDeleteRestricted: true } }),
    headline: "Draft for a restricted thread: content removed. Delete it in Outlook.",
    actions: ["delete_restricted"]
  },
  {
    name: "restricted, linked draft: Delete",
    view: restrictedView({ status: "draft", outlook: LINKED, capabilities: { canDeleteRestricted: true } }),
    headline: "Draft for a restricted thread: content removed. Delete it in Outlook.",
    actions: ["delete_restricted"]
  },
  {
    name: "restricted, unknown: Check again, It was sent, It wasn't sent: delete it from Outlook",
    view: restrictedView({ status: "unknown", outlook: LINKED, sent: PAST, capabilities: { resolve: ["check", "mark_sent", "not_sent_new_draft"] } }),
    headline: "Draft for a restricted thread: content removed. We can't confirm whether it was sent. Check Sent Items in Outlook.",
    actions: ["check_again", "resolve:mark_sent", "resolve:not_sent_new_draft"],
    shows: ["It wasn't sent: delete it from Outlook", COPY.checkedOutlook]
  },
  ...(["sending", "sent_pending", "discarding"] as const).map(
    (status): Row => ({
      name: `restricted, ${status}`,
      view: restrictedView({ status, outlook: LINKED }),
      headline: "Draft for a restricted thread: content removed. Its last action is still being confirmed.",
      actions: []
    })
  ),
  ...(["sent", "sent_external"] as const).map(
    (status): Row => ({
      name: `restricted, ${status}`,
      view: restrictedView({ status, outlook: LINKED, sent: { at: "2026-11-06T14:40:00.000Z" } }),
      headline: `Draft for a restricted thread: content removed. It was sent ${at("2026-11-06T14:40:00.000Z")}.`,
      actions: []
    })
  ),
  {
    name: "restricted, gone",
    view: restrictedView({ status: "gone", outlook: LINKED }),
    headline: "Draft for a restricted thread: content removed. It's no longer in your Outlook Drafts.",
    actions: []
  },
  {
    name: "restricted, not linked",
    view: restrictedView({ status: "draft" }),
    headline: "This draft was for a restricted thread; its content was removed.",
    actions: []
  },
  {
    name: "restricted, discarded with an Outlook copy that may remain",
    view: restrictedView({ status: "discarded", lastError: { code: "outlook_unknown_restricted", at: NOW_ISO } }),
    headline: "This draft was for a restricted thread; its content was removed.",
    actions: [],
    shows: ["An Outlook copy may remain: check your Outlook Drafts."]
  },
  {
    name: "drafts unavailable: the reason in words and Discard (DD-only) only",
    view: draftView({ capabilities: { canDiscard: true, draftsUnavailable: "token_expired" } }),
    headline: "In DD only. Not in Outlook yet.",
    actions: ["discard"],
    shows: ["Drafts are unavailable: the drafting key has expired."]
  }
];

describe("UI01: DraftStatusBanner + DraftActions for every §3.13.4 row", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const b = banner(row.view);
      expect(b).toContain(row.headline);
      const html = buttons(row.view, row.extra);
      expect(actionsIn(html)).toEqual(row.actions);
      const all = b + textOf(html);
      for (const s of row.shows ?? []) expect(all).toContain(s);
    });
  }

  for (const code of ["declined", "truncated", "invalid_output", "budget", "input_too_large", "thread_unavailable", "model_error", "timeout", "stale", "stopped"] as GenerationError[]) {
    it(`generation_failed (${code}): its sentence, then Try again, Write it myself, Discard`, () => {
      const view = draftView({ status: "generation_failed", generationError: code, bodyText: null, capabilities: { canEdit: true, canRegenerate: true, canDiscard: true } });
      expect(banner(view)).toContain(GENERATION_FAILED_SENTENCE[code]);
      expect(actionsIn(buttons(view))).toEqual(["regenerate", "write_myself", "discard"]);
      expect(textOf(buttons(view))).toContain("Try again");
    });
  }

  it("the exact generation_failed sentences", () => {
    expect(GENERATION_FAILED_SENTENCE).toMatchObject({
      declined: "The assistant won't draft this one. Write it yourself.",
      truncated: "The draft came back cut off. Try again.",
      invalid_output: "The draft didn't come back in a usable form. Try again.",
      budget: "Today's AI spend cap is reached.",
      input_too_large: "This thread is too long to draft from.",
      thread_unavailable: "The email isn't available to draft from.",
      model_error: "Couldn't reach the model. Try again.",
      timeout: "Drafting took too long. Try again.",
      stale: "Drafting took too long. Try again.",
      stopped: "You stopped drafting."
    });
  });

  it("a regenerate that is drafting keeps the previous text in the preview", () => {
    const view = draftView({ status: "generating", capabilities: { resolve: ["stop_generation"] } });
    expect(bodyModeFor(view)).toBe("preview");
  });

  it("the facts banner, the output-flags banner and the UTC note on a draft (C65, L19)", () => {
    const view = draftView({ factsStatus: "recipients_outside_client", generationFlags: ["unexpected_url", "teammate_name"], mailTimezone: { zone: "Europe/London", mapped: false } });
    const b = banner(view);
    expect(b).toContain("No client status used: a recipient isn't at the client.");
    expect(b).toContain("Check before sending: the assistant added a link and a teammate's name that weren't in your instruction or the client facts.");
    expect(b).toContain("Quoted times will be in UTC");
    expect(banner(draftView({ factsStatus: "medium_confidence" }))).toContain("No client status used: the client match isn't certain.");
    expect(banner(draftView({ factsStatus: "unavailable" }))).toContain("No client status used: client status couldn't be read.");
    expect(banner(draftView({ factsStatus: "used" }))).not.toContain("No client status used");
  });

  it("the injection banner shows when P3 flagged the thread, and never on a restricted row", () => {
    expect(banner(draftView({ injectionSuspected: true }))).toContain(COPY.injectionWarning);
    expect(banner(restrictedView({ injectionSuspected: true }))).not.toContain(COPY.injectionWarning);
  });

  it("a lastError the row doesn't name shows its sentence above the banner", () => {
    const b = banner(draftView({ lastError: { code: "parent_missing", at: NOW_ISO } }));
    expect(b).toContain("The email you're replying to isn't in Outlook any more. DD won't start a new thread.");
    expect(banner(draftView({ lastError: { code: "generation_budget", at: NOW_ISO } }))).toContain(
      "Regenerating failed: Today's AI spend cap is reached. Your previous text is unchanged."
    );
    expect(banner(draftView({ lastError: { code: "generation_stopped", at: NOW_ISO } }))).toContain("You stopped drafting. Your previous text is unchanged.");
  });

  it("the poll-error banner (C42): 'Retrying…' after 1 failure, 'Reload the page' after 3", () => {
    const v = draftView({ status: "saving" });
    expect(banner(v, 0)).not.toContain("Couldn't refresh");
    expect(banner(v, 1)).toContain("Couldn't refresh. Retrying…");
    expect(banner(v, 2)).toContain("Couldn't refresh. Retrying…");
    expect(banner(v, 3)).toContain("Couldn't refresh this draft. Reload the page.");
    expect(pollErrorCopy(0)).toBeNull();
    expect(pollErrorCopy(1)).toBe("Couldn't refresh. Retrying…");
    expect(pollErrorCopy(3)).toBe("Couldn't refresh this draft. Reload the page.");
  });

  it("a checkbox-gated action is disabled until the box is ticked", () => {
    const view = draftView({ status: "unknown", outlook: LINKED, sent: PAST, capabilities: { resolve: ["check", "mark_sent", "not_sent_new_draft"] } });
    const off = buttons(view);
    expect(off).toMatch(/<button[^>]*data-action="resolve:mark_sent"[^>]*disabled=""/);
    expect(off).not.toMatch(/<button[^>]*data-action="check_again"[^>]*disabled=""/);
    const on = buttons(view, { checkedOutlook: true });
    expect(on).not.toMatch(/<button[^>]*data-action="resolve:mark_sent"[^>]*disabled=""/);
    expect(showsCheckedBox(view, actionsFor(view))).toBe(true);
  });

  it("busy disables every button and labels the running one", () => {
    const view = draftView({ capabilities: { canRegenerate: true, canSave: true, canDiscard: true } });
    const html = buttons(view, { busy: "saving" });
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
    expect(textOf(html)).toContain("Saving…");
  });

  // P9 F24 (flip): the probe's "no" names its reason; "isn't switched on yet" is for send_off only.
  it("the live send probe saying no hides Review & send and shows the hint with the probe's reason", () => {
    const view = draftView({ status: "saved", savedVersion: 3, outlook: LINKED, capabilities: { canReview: true, canOpenInOutlook: true } });
    expect(actionsIn(buttons(view, { sendReady: false }))).toEqual(["open_in_outlook"]);
    expect(textOf(buttons(view, { sendReady: false }))).toContain("Sending is unavailable: the reason isn't known. Open it in Outlook to send.");
    expect(textOf(buttons(view, { sendReady: false }))).not.toContain("switched on yet");
    expect(textOf(buttons(view, { sendReady: false, sendReason: "send_token" }))).toContain("Sending is unavailable: the sending key is missing or wrong. Open it in Outlook to send.");
    expect(textOf(buttons(view, { sendReady: false, sendReason: "send_off" }))).toContain("Sending from here isn't switched on yet.");
    expect(actionsIn(buttons(view, { sendReady: true }))).toEqual(["review", "open_in_outlook"]);
  });

  it("P9 F24: one render per SendUnavailable value; 'switched on yet' only for send_off, the reason's words otherwise", () => {
    const reasons: SendUnavailable[] = ["send_off", "clone_send_off", "send_token", "clone_unreachable", "token_missing", "wrong_accounts", "cl2_not_ready"];
    for (const reason of reasons) {
      const view = draftView({ status: "saved", savedVersion: 3, outlook: LINKED, capabilities: { canOpenInOutlook: true, sendUnavailable: reason } });
      const text = textOf(buttons(view, { sendReady: null }));
      if (reason === "send_off") expect(text, reason).toContain("Sending from here isn't switched on yet. Open it in Outlook to send.");
      else {
        expect(text, reason).not.toContain("switched on yet");
        expect(text, reason).toContain(`Sending is unavailable: ${reasonWords(reason)}. Open it in Outlook to send.`);
      }
      // Visible text, not only a title.
      expect(buttons(view, { sendReady: null })).not.toMatch(/<p[^>]*title="Sending is unavailable/);
    }
    expect(sendHintText("send_off")).toBe(COPY.sendOffHint);
  });

  it("P9 F24: sendProbeAnswer keeps the probe's reason when it says no (the panel used to drop it)", () => {
    expect(sendProbeAnswer(200, { sendReady: false, reason: "send_token", draftsReady: true })).toEqual({ sendReady: false, reason: "send_token" });
    expect(sendProbeAnswer(200, { sendReady: true, reason: null })).toEqual({ sendReady: true, reason: null });
    expect(sendProbeAnswer(503, { sendReady: false, reason: "send_token" })).toEqual({ sendReady: null, reason: null });
    expect(sendProbeAnswer(200, { sendReady: false, reason: "<b>x</b>" })).toEqual({ sendReady: false, reason: null });
    expect(sendProbeAnswer(200, null)).toEqual({ sendReady: null, reason: null });
  });

  it("a blocked popup offers 'Open it now' (C69)", () => {
    const view = draftView({ status: "saved", savedVersion: 3, outlook: LINKED, capabilities: { canOpenInOutlook: true } });
    const html = buttons(view, { openBlocked: true });
    expect(html).toContain('data-action="open_now"');
    expect(textOf(html)).toContain("Open it now");
  });

  it("no button anywhere comes from anything but the capabilities: an empty set renders none", () => {
    for (const status of ["draft", "saved", "unknown", "gone", "generation_failed", "generating", "sent_pending"] as const) {
      expect(actionsIn(buttons(draftView({ status, outlook: LINKED, capabilities: caps() })))).toEqual(status === "sent_pending" ? ["open_in_outlook"] : []);
    }
  });
});

describe("UI01: the rows before a draft exists (NewDraft)", () => {
  const seed = {
    kind: "reply" as const,
    threadId: "t_thread1",
    threadSubject: "Contract renewal",
    parentFrom: { address: "x@evil.example", name: "accounts@client.com" },
    to: [{ address: "x@evil.example", name: "accounts@client.com" }],
    cc: [],
    candidates: { from: { address: "x@evil.example", name: "accounts@client.com" }, to: [{ address: "ops@acme.com", name: null }], cc: [] },
    mode: "reply" as const,
    injectionSuspected: true
  };
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(NewDraft, { seed: null, hold: null, suggestions: [], isTop: true, ...props } as Parameters<typeof NewDraft>[0]));

  it("new reply: 'Draft a reply to <address> (<name>).', the recipients by address, the injection banner, Draft with AI · Write it myself", () => {
    const html = render({ seed });
    const text = textOf(html);
    expect(text).toContain("Draft a reply to x@evil.example (accounts@client.com).");
    expect(text).toContain(COPY.injectionWarning);
    expect(actionsIn(html)).toEqual(["generate", "write_myself"]);
    expect(html).toMatch(/data-recipient-primary="true"[^>]*>x@evil\.example</);
  });

  it("new reply, the create answered 409 hold: the checkbox gates both buttons (C63)", () => {
    const html = render({ hold: { threadId: "t_thread1" } });
    const text = textOf(html);
    expect(text).toContain("An earlier draft for this email may already have been sent. Check your Sent Items in Outlook first.");
    expect(text).toContain(COPY.checkedOutlook);
    expect(html).toMatch(/data-action="generate"[^>]*disabled=""/);
    expect(html).toMatch(/data-action="write_myself"[^>]*disabled=""/);
  });

  it("new email: its own intro, the recipient boxes and a subject", () => {
    const html = render({ seed: { kind: "new", accountId: "acc_1" } });
    const text = textOf(html);
    expect(text).toContain("New email from your mailbox. Recipients: your team, client contacts, and people you've emailed.");
    expect(text).toContain("Subject");
    expect(actionsIn(html)).toEqual(["generate", "write_myself"]);
  });

  it("framed (isTop false): no buttons", () => {
    expect(actionsIn(render({ seed, isTop: false }))).toEqual([]);
  });
});

describe("UI02: the frame guard", () => {
  it("DraftActions renders nothing when isTop is false, in every row", () => {
    for (const row of ROWS) {
      const html = renderToStaticMarkup(createElement(DraftActions, { view: row.view, isTop: false, busy: null, sendReady: true, onAction: () => {}, ...row.extra }));
      expect(html, row.name).toBe("");
    }
  });
});

describe("UI11: Open in Outlook is a button, never an href holding the webLink (C69)", () => {
  it("no rendered state puts the Outlook webLink in an href", () => {
    const views: DraftView[] = [
      ...ROWS.map((r) => r.view),
      draftView({ status: "saved", outlook: LINKED, capabilities: { canOpenInOutlook: true, canReview: true } }),
      draftView({ status: "sent", outlook: LINKED })
    ];
    for (const view of views) {
      const html = buttons(view, { openBlocked: true }) + renderToStaticMarkup(createElement(DraftStatusBanner, { view, tz: TZ, nowIso: NOW_ISO }));
      expect(html).not.toContain(`href="${WEB_LINK}`);
      expect(html).not.toContain("outlook.office.com");
      for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1].startsWith("/executive/")).toBe(true);
    }
  });

  it("Open in Outlook renders only when the link passes the allowlist", () => {
    const view = draftView({ status: "saved", outlook: { linked: true, webLink: "https://evil.example/owa" }, capabilities: { canOpenInOutlook: true } });
    expect(actionsIn(buttons(view))).toEqual([]);
  });

  it("the flow: about:blank before the POST, opener nulled, then location.replace(webLink)", async () => {
    const calls: string[] = [];
    const win = {
      opener: {} as unknown,
      location: { replace: (u: string) => calls.push(`replace:${u}`) },
      close: () => calls.push("close")
    };
    const out = await openInOutlookFlow({
      open: (url, target) => {
        calls.push(`open:${url}:${target}`);
        return win;
      },
      post: async () => {
        calls.push(`post:opener=${win.opener === null ? "null" : "set"}`);
        return true;
      },
      webLink: WEB_LINK
    });
    expect(out).toBe("opened");
    expect(calls).toEqual(["open:about:blank:_blank", "post:opener=null", `replace:${WEB_LINK}`]);
  });

  it("a failed POST closes the window and returns 'failed'; nothing navigates", async () => {
    const calls: string[] = [];
    const out = await openInOutlookFlow({
      open: () => ({ opener: {}, location: { replace: (u: string) => calls.push(`replace:${u}`) }, close: () => calls.push("close") }),
      post: async () => false,
      webLink: WEB_LINK
    });
    expect(out).toBe("failed");
    expect(calls).toEqual(["close"]);
    const thrown = await openInOutlookFlow({
      open: () => ({ opener: {}, location: { replace: () => calls.push("replace") }, close: () => calls.push("close2") }),
      post: async () => {
        throw new Error("network");
      },
      webLink: WEB_LINK
    });
    expect(thrown).toBe("failed");
    expect(calls).not.toContain("replace");
  });

  it("a null popup still POSTs and returns 'blocked'; 'Open it now' opens with noopener,noreferrer", async () => {
    let posted = 0;
    const out = await openInOutlookFlow({ open: () => null, post: async () => ((posted += 1), true), webLink: WEB_LINK });
    expect(out).toBe("blocked");
    expect(posted).toBe(1);
    const opened: unknown[][] = [];
    openNow((...args) => opened.push(args), WEB_LINK);
    expect(opened).toEqual([[WEB_LINK, "_blank", "noopener,noreferrer"]]);
  });

  it("an unknown row hours past its send keeps the late wording while drafts are unavailable (ui-8)", () => {
    const late = draftView({ status: "unknown", outlook: LINKED, sent: PAST, capabilities: { canEdit: false, resolve: [], draftsUnavailable: "clone_unreachable" } });
    expect(banner(late)).toContain("Outcome unknown. Check Sent Items in Outlook.");
    expect(banner(late)).not.toContain("We can't confirm it went out yet");
    const early = draftView({ status: "unknown", outlook: LINKED, capabilities: { resolve: ["check", "mark_sent"] } });
    expect(banner(early)).toContain("We can't confirm it went out yet");
  });

  it("'drafts unavailable' offers Check again for a readiness reason only (ui-2)", () => {
    const html = (draftsUnavailable: DraftView["capabilities"]["draftsUnavailable"], onRecheck?: () => void) =>
      renderToStaticMarkup(createElement(DraftStatusBanner, { view: draftView({ capabilities: { canEdit: false, draftsUnavailable } }), tz: TZ, nowIso: NOW_ISO, onRecheck }));
    for (const reason of ["cl2_not_ready", "clone_unreachable", "token_expired"] as const) {
      expect(html(reason, () => {}), reason).toContain('data-action="recheck_readiness"');
      expect(html(reason, () => {})).toContain("Check again");
    }
    expect(html("drafts_off", () => {})).not.toContain("recheck_readiness");
    expect(html("mailbox_problem", () => {})).not.toContain("recheck_readiness");
    expect(html("cl2_not_ready")).not.toContain("recheck_readiness");
    expect(html(null, () => {})).not.toContain("recheck_readiness");
  });

  it("a null popup whose stamp failed is 'failed', never 'blocked': no 'Open it now' without a recorded stamp (security-3)", async () => {
    for (const post of [async () => false, async () => Promise.reject(new Error("409"))]) {
      let posted = 0;
      const out = await openInOutlookFlow({ open: () => null, post: () => ((posted += 1), post()), webLink: WEB_LINK });
      expect(out).toBe("failed");
      expect(posted).toBe(1);
    }
  });
});

describe("UI13: body modes and polling", () => {
  const editable = { canEdit: true };
  it("bodyModeFor: the editor only in the editable states, the preview in every read-only one", () => {
    expect(bodyModeFor(draftView({ capabilities: editable }))).toBe("editor");
    expect(bodyModeFor(draftView({ status: "saved", capabilities: editable }))).toBe("editor");
    // drafts unavailable: the same row, read-only
    expect(bodyModeFor(draftView({ capabilities: { canEdit: false, draftsUnavailable: "clone_unreachable" } }))).toBe("preview");
    for (const status of ["saving", "sending", "sent_pending", "sent", "sent_external", "unknown", "gone", "discarding"] as const) {
      expect(bodyModeFor(draftView({ status, capabilities: editable })), status).toBe("preview");
    }
    for (const status of ["generation_failed", "discarded"] as const) expect(bodyModeFor(draftView({ status }))).toBe("hidden");
    expect(bodyModeFor(draftView({ status: "generating", bodyText: null }))).toBe("hidden");
    expect(bodyModeFor(restrictedView({ status: "saved", capabilities: editable }))).toBe("hidden");
    expect(bodyModeFor(null)).toBe("hidden");
  });

  it("DraftBodyPreview renders the text as React text, split on blank lines", () => {
    expect(previewParagraphs("One\n\nTwo\r\n\r\nThree")).toEqual(["One", "Two", "Three"]);
    const html = renderToStaticMarkup(createElement(DraftBodyPreview, { text: "<b>not markup</b>\n\nSecond" }));
    expect(html).toContain("&lt;b&gt;not markup&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(textOf(renderToStaticMarkup(createElement(DraftBodyPreview, { text: null })))).toContain("No text yet.");
  });

  it("C42's schedule: generating 2 s for 3 min then 10 s; in flight 3 s; after a send 5 s for 2 min then 30 s; nothing otherwise", () => {
    expect(pollIntervalFor(draftView({ status: "generating" }), 10_000)).toBe(2_000);
    expect(pollIntervalFor(draftView({ status: "generating" }), 181_000)).toBe(10_000);
    for (const status of ["saving", "sending", "discarding"] as const) expect(pollIntervalFor(draftView({ status }), 0)).toBe(3_000);
    for (const status of ["sent_pending", "unknown"] as const) {
      expect(pollIntervalFor(draftView({ status }), 60_000)).toBe(5_000);
      expect(pollIntervalFor(draftView({ status }), 121_000)).toBe(30_000);
    }
    expect(pollIntervalFor(draftView({ status: "gone", gone: { unconfirmed: true } }), 0)).toBe(5_000);
    expect(pollIntervalFor(draftView({ status: "gone" }), 0)).toBeNull();
    for (const status of ["draft", "saved", "sent", "discarded", "generation_failed"] as const) expect(pollIntervalFor(draftView({ status }), 0)).toBeNull();
    // A failed poll backs off to 30 s.
    expect(pollIntervalFor(draftView({ status: "generating" }), 0, 1)).toBe(30_000);
  });
});
