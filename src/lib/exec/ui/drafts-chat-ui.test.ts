import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));

import { ConfirmSendContent } from "@/components/exec/drafts/ConfirmSendContent";
import { actionsFor, DraftActions, SAVE_ACTIONS, showsPrivateRefsBox } from "@/components/exec/drafts/DraftActions";
import { InstructionBox } from "@/components/exec/drafts/DraftPanel";
import { DraftStatusBanner } from "@/components/exec/drafts/DraftStatusBanner";
import { lastErrorNotice } from "@/components/exec/drafts/banner";
import { BLOCKER_COPY, CLONE_CODES, codeSentence, COPY, ROUTE_CODE_SENTENCE } from "@/components/exec/drafts/copy";
import { errorLines, requestFor, type ActionContext } from "@/components/exec/drafts/panel-logic";
import { RegenerateBody, SaveBody } from "@/lib/exec/drafts";
import type { DraftView, ReviewResult } from "@/lib/exec/drafts-types";
import { actionsIn, draftView, HASH, NOW_ISO, readBack, restrictedView, reviewResult, textOf, TZ, WEB_LINK } from "../__tests__/drafts-ui-fixtures";

// P5b Area F (contract §3.23 F5, F10): TF5, the private-refs notice and its required box gating Save (posting
// confirmPrivate), the "Written by the assistant in Chat" label, the private_refs confirm-dialog checkbox and the
// frame guard; TF10, the restricted view after RPC 5's purge (chat_source_restricted). Server-rendered, as P4's
// UI tests are.

const NOTICE = "Started in a chat that also read other email, team notes or other clients' records. Check the draft doesn't share any of it.";
const BLOCKER = "This draft was started in a chat that also read other email, team notes or other clients' records. I've checked it shares nothing it shouldn't";
const F10 = "Content removed: the chat that started this draft used mail from a sender that is now restricted.";

const buttons = (view: DraftView, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(DraftActions, { view, isTop: true, busy: null, sendReady: null, onAction: () => {}, ...extra }));
const disabled = (html: string, action: string) => new RegExp(`<button[^>]*data-action="${action.replace(/[:]/g, "\\:")}"[^>]*disabled=""`).test(html);
const privateDraft = (over: Parameters<typeof draftView>[0] = {}) =>
  draftView({ usesPrivateRefs: true, instructionBy: "assistant", capabilities: { canEdit: true, canRegenerate: true, canSave: true, canDiscard: true }, ...over });

describe("TF5 the private-refs notice and its box gate Save", () => {
  it("a usesPrivateRefs draft shows the notice and a required \"I've checked it\" box above Save; Save is disabled until it is ticked", () => {
    const view = privateDraft();
    const off = buttons(view);
    const text = textOf(off);
    expect(COPY.privateRefsNotice).toBe(NOTICE);
    expect(COPY.privateRefsCheck).toBe("I've checked it");
    expect(text).toContain(NOTICE);
    expect(text).toContain("I've checked it");
    expect(off).toMatch(/<input type="checkbox" required=""[^>]*data-private-refs-check="true"/);
    expect(off.indexOf("data-private-refs")).toBeLessThan(off.indexOf('data-action="save"'));
    expect(disabled(off, "save")).toBe(true);
    // Only the saves are gated: regenerate and discard stay usable.
    expect(disabled(off, "regenerate")).toBe(false);
    expect(disabled(off, "discard")).toBe(false);
    const on = buttons(view, { privateRefsChecked: true });
    expect(disabled(on, "save")).toBe(false);
    expect(on).toMatch(/<input type="checkbox" required="" data-private-refs-check="true"[^>]*checked=""/);
    expect(off).not.toMatch(/data-private-refs-check="true"[^>]*checked=""/);
  });

  it("a stale link's \"Save again\" and the changed-in-Outlook \"Replace it with this version\" are gated the same way", () => {
    const stale = privateDraft({ staleLink: true, savedVersion: 2, outlook: { linked: true, webLink: WEB_LINK }, capabilities: { canSave: true, canRegenerate: true, resolve: ["check"] } });
    expect(disabled(buttons(stale), "save")).toBe(true);
    const changed = privateDraft({ outlook: { linked: true, webLink: WEB_LINK, changedSinceSaved: true }, savedVersion: 2, capabilities: { canSave: true, canDiscard: true, resolve: ["check", "keep_outlook_version"] } });
    const html = buttons(changed, { outlookVersionShown: true });
    expect(disabled(html, "replace_with_dd")).toBe(true);
    expect(disabled(buttons(changed, { outlookVersionShown: true, privateRefsChecked: true }), "replace_with_dd")).toBe(false);
    expect([...SAVE_ACTIONS].sort()).toEqual(["replace_with_dd", "save"]);
  });

  it("a web draft, a restricted row, or a row with no save offered shows no notice and gates nothing", () => {
    const web = draftView({ capabilities: { canSave: true, canRegenerate: true } });
    expect(textOf(buttons(web))).not.toContain(NOTICE);
    expect(disabled(buttons(web), "save")).toBe(false);
    const restricted = restrictedView({ usesPrivateRefs: true, status: "saved", outlook: { linked: true, webLink: WEB_LINK }, capabilities: { canDeleteRestricted: true } });
    expect(textOf(buttons(restricted))).not.toContain(NOTICE);
    expect(actionsIn(buttons(restricted))).toEqual(["delete_restricted"]);
    const saved = privateDraft({ status: "saved", savedVersion: 3, outlook: { linked: true, webLink: WEB_LINK }, capabilities: { canReview: true, canOpenInOutlook: true } });
    expect(showsPrivateRefsBox(saved, actionsFor(saved))).toBe(false);
    expect(textOf(buttons(saved))).not.toContain(NOTICE);
  });

  it("framed (isTop false): no buttons, no notice, no box", () => {
    expect(buttons(privateDraft(), { isTop: false })).toBe("");
    expect(buttons(privateDraft(), { isTop: false, privateRefsChecked: true })).toBe("");
  });

  it("a ticked box makes Save post confirmPrivate: true (and the body still parses); unticked sends none", () => {
    const view = privateDraft({ version: 4 });
    const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ view, version: 4, instruction: null, shownReadBack: readBack({ contentHash: HASH }), ...over });
    expect(requestFor("save", ctx({ confirmPrivate: true }))?.body).toEqual({ version: 4, confirmPrivate: true });
    expect(requestFor("replace_with_dd", ctx({ confirmPrivate: true }))?.body).toEqual({ version: 4, seenContentHash: HASH, confirmPrivate: true });
    expect(requestFor("save", ctx())?.body).toEqual({ version: 4 });
    expect(requestFor("save", ctx({ confirmPrivate: false }))?.body).toEqual({ version: 4 });
    // Nothing else carries it.
    expect(requestFor("review", ctx({ confirmPrivate: true }))?.body).toEqual({ version: 4 });
    expect(requestFor("discard", ctx({ confirmPrivate: true }))?.body).toEqual({ version: 4 });
    for (const body of [requestFor("save", ctx({ confirmPrivate: true }))?.body, requestFor("replace_with_dd", ctx({ confirmPrivate: true }))?.body]) {
      expect(SaveBody.safeParse(body).success).toBe(true);
    }
    // The server's refusal when the box wasn't sent has its own sentence.
    expect(errorLines(409, { error: "private_refs_unconfirmed" })).toEqual([ROUTE_CODE_SENTENCE.private_refs_unconfirmed]);
    expect(ROUTE_CODE_SENTENCE.private_refs_unconfirmed).toContain("I've checked it");
  });

  it("the instruction box says \"Written by the assistant in Chat\" for the assistant's unchanged instruction", () => {
    const html = (writtenByAssistant: boolean) =>
      renderToStaticMarkup(createElement(InstructionBox, { value: "Tell her Thursday works.", onChange: () => {}, disabled: false, writtenByAssistant }));
    expect(COPY.instructionByAssistant).toBe("Written by the assistant in Chat");
    expect(textOf(html(true))).toContain("Written by the assistant in Chat");
    expect(html(true)).toContain('data-instruction-by="assistant"');
    expect(textOf(html(false))).not.toContain("Written by the assistant in Chat");
    expect(textOf(html(false))).toContain(COPY.instructionLabel);
  });

  it("a regenerate keeps the assistant's unchanged instruction (no instruction sent), and sends his edit as his own", () => {
    const view = privateDraft({ version: 2, instruction: "Assistant words." });
    const ctx = (over: Partial<ActionContext>): ActionContext => ({ view, version: 2, instruction: "Assistant words.", shownReadBack: null, ...over });
    const kept = requestFor("regenerate", ctx({ keepInstruction: true }));
    expect(kept?.body).toEqual({ version: 2 });
    expect(RegenerateBody.safeParse(kept?.body).success).toBe(true);
    expect(requestFor("regenerate", ctx({ instruction: "My words." }))?.body).toEqual({ version: 2, instruction: "My words." });
    expect(requestFor("regenerate", ctx({ instruction: null }))?.body).toEqual({ version: 2, instruction: null });
  });

  it("the confirm dialog's private_refs blocker is a required checkbox with its copy; Send waits for it, and is absent in a frame", () => {
    const render = (review: ReviewResult, extra: Record<string, unknown> = {}) =>
      renderToStaticMarkup(createElement(ConfirmSendContent, {
        review, acks: [], onToggleAck: () => {}, isTop: true, busy: false, nowIso: NOW_ISO, tz: TZ, onCancel: () => {}, onSend: () => {}, ...extra
      }));
    expect(BLOCKER_COPY.private_refs).toBe(BLOCKER);
    const review = reviewResult({ blockers: ["private_refs"] });
    const html = render(review);
    expect(textOf(html)).toContain(BLOCKER);
    expect(html).toMatch(/<input type="checkbox" required=""[^>]*data-blocker="private_refs"/);
    expect(html).toMatch(/<button[^>]*data-confirm="send"[^>]*disabled=""/);
    expect(render(review, { acks: ["private_refs"] })).not.toMatch(/<button[^>]*data-confirm="send"[^>]*disabled=""/);
    expect(render(review, { isTop: false })).not.toContain('data-confirm="send"');
  });
});

describe("TF10 the restricted view after the chat-draft purge", () => {
  it("chat_source_restricted shows F10's line above P4's restricted copy; the linked row's Delete stays", () => {
    expect(CLONE_CODES).toContain("chat_source_restricted");
    expect(codeSentence("chat_source_restricted")).toBe(F10);
    const discarded = restrictedView({ status: "discarded", lastError: { code: "chat_source_restricted", at: NOW_ISO } });
    expect(lastErrorNotice(discarded)).toBe(F10);
    const text = textOf(renderToStaticMarkup(createElement(DraftStatusBanner, { view: discarded, tz: TZ, nowIso: NOW_ISO })));
    expect(text).toContain(F10);
    expect(text).toContain("This draft was for a restricted thread; its content was removed.");
    expect(text.indexOf(F10)).toBeLessThan(text.indexOf("This draft was for a restricted thread"));

    const linked = restrictedView({ status: "saved", lastError: { code: "chat_source_restricted", at: NOW_ISO }, outlook: { linked: true, webLink: null }, capabilities: { canDeleteRestricted: true } });
    const banner = textOf(renderToStaticMarkup(createElement(DraftStatusBanner, { view: linked, tz: TZ, nowIso: NOW_ISO })));
    expect(banner.indexOf(F10)).toBeGreaterThanOrEqual(0);
    expect(banner.indexOf(F10)).toBeLessThan(banner.indexOf("Draft for a restricted thread: content removed. Delete it in Outlook."));
    expect(actionsIn(buttons(linked))).toEqual(["delete_restricted"]);
  });

  it("a restricted row without that code shows P4's copy alone", () => {
    const plain = restrictedView({ status: "discarded" });
    const text = textOf(renderToStaticMarkup(createElement(DraftStatusBanner, { view: plain, tz: TZ, nowIso: NOW_ISO })));
    expect(text).not.toContain(F10);
    expect(text).toContain("This draft was for a restricted thread; its content was removed.");
  });
});
