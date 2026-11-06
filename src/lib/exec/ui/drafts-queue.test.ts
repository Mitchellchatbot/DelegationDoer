import { describe, expect, it } from "vitest";

import { attachmentHintFor, ATTACHMENT_HINTS } from "@/components/email-editor/types";
import type { DraftUiAction } from "@/components/exec/drafts/actions";
import { busyFor, NEEDS_CHECKED_OUTLOOK } from "@/components/exec/drafts/actions";
import { acceptsTyping, seedsEditorFrom } from "@/components/exec/drafts/body-mode";
import { createDraftMutationQueue } from "@/components/exec/drafts/mutation-queue";
import {
  createOutcome,
  createRequest,
  editRequest,
  EMPTY_BODY_DOC,
  mergeEdits,
  outcomeOf,
  outlookOpenedRequest,
  requestFor,
  sendRequest,
  type ActionContext
} from "@/components/exec/drafts/panel-logic";
import { DOC, draftView, HASH, OTHER_HASH, readBack, reviewResult } from "../__tests__/drafts-ui-fixtures";

// UI13's queue half (C74), the panel's request/answer mapping (R2-R12), and
// PX15 (Y12, C44): the editor's attachment hints.

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (h: unknown) => {
      pending.delete(h as number);
    },
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    count: () => pending.size
  };
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("UI13: one queue for autosave and actions (C74)", () => {
  it("an edit followed at once by Save runs exactly one PATCH, then the save with the version the PATCH returned", async () => {
    const log: string[] = [];
    const timers = manualTimers();
    const q = createDraftMutationQueue({
      version: () => 3,
      patch: async (body, version) => {
        log.push(`patch:${JSON.stringify(body)}:v${version}`);
        return { ok: true, version: 4 };
      },
      act: async (action, version) => {
        log.push(`act:${action}:v${version}`);
        return { ok: true, status: 200 };
      },
      get: async () => {
        log.push("get");
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    q.edit({ n: 1 });
    q.edit({ n: 2 });
    expect(q.pending()).toBe(true);
    expect(await q.run("save")).toBe("done");
    expect(log).toEqual(['patch:{"n":2}:v3', "act:save:v4"]);
    // The debounce that was cancelled never sends a second PATCH.
    timers.fireAll();
    await Promise.resolve();
    expect(log.filter((l) => l.startsWith("patch")).length).toBe(1);
  });

  it("the autosave PATCH goes out after the quiet period, only while edits are pending", async () => {
    const log: string[] = [];
    const timers = manualTimers();
    const q = createDraftMutationQueue({
      version: () => 7,
      patch: async (body, version) => (log.push(`patch:${version}`), { ok: true, version: version + 1 }),
      act: async () => ({ ok: true, status: 200 }),
      get: async () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    expect(timers.count()).toBe(0);
    q.edit({ a: 1 });
    expect(timers.count()).toBe(1);
    timers.fireAll();
    await q.flush();
    expect(log).toEqual(["patch:7"]);
    expect(q.version()).toBe(8);
    expect(q.pending()).toBe(false);
  });

  it("two quick actions run in order, never at the same time", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const gates = [deferred<void>(), deferred<void>()];
    let i = 0;
    const q = createDraftMutationQueue({
      patch: async () => ({ ok: true, version: 1 }),
      act: async (action) => {
        const gate = gates[i++];
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        order.push(`start:${action}`);
        await gate.promise;
        order.push(`end:${action}`);
        running -= 1;
        return { ok: true, status: 200 };
      },
      get: async () => {}
    });
    const a = q.run("save");
    const b = q.run("discard");
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start:save"]);
    gates[0].resolve();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    gates[1].resolve();
    await b;
    expect(order).toEqual(["start:save", "end:save", "start:discard", "end:discard"]);
    expect(maxRunning).toBe(1);
  });

  it("a 409 on the PATCH re-reads the draft, reports 'conflict' and does not run the action", async () => {
    const log: string[] = [];
    const conflicts: boolean[] = [];
    const q = createDraftMutationQueue({
      patch: async () => ({ ok: false, status: 409 }),
      act: async (action) => (log.push(`act:${action}`), { ok: true, status: 200 }),
      get: async () => {
        log.push("get");
      },
      onConflict: (pending) => conflicts.push(pending)
    });
    q.edit({ x: 1 });
    expect(await q.run("save")).toBe("conflict");
    expect(log).toEqual(["get"]);
    expect(conflicts).toEqual([true]);
  });

  it("a 409 version_conflict on the action itself re-reads and reports 'conflict' (the action isn't retried)", async () => {
    let acts = 0;
    let gets = 0;
    const q = createDraftMutationQueue({
      patch: async () => ({ ok: true, version: 1 }),
      act: async () => ((acts += 1), { ok: false, status: 409 }),
      get: async () => {
        gets += 1;
      }
    });
    expect(await q.run("review")).toBe("conflict");
    expect([acts, gets]).toEqual([1, 1]);
  });

  it("another failure is 'failed' and keeps a pending edit for the next quiet period", async () => {
    const timers = manualTimers();
    const bodies: unknown[] = [];
    const q = createDraftMutationQueue({
      patch: async (body) => (bodies.push(body), bodies.length === 1 ? { ok: false, status: 503 } : { ok: true, version: 2 }),
      act: async () => ({ ok: false, status: 503 }),
      get: async () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    expect(await q.run("save")).toBe("failed");
    q.edit({ typed: true });
    // The quiet period's PATCH fails (503): the edit stays pending...
    timers.fireAll();
    // ...and the next flush sends the same body again.
    await q.flush();
    expect(bodies).toEqual([{ typed: true }, { typed: true }]);
    expect(q.pending()).toBe(false);
  });

  it("an edit typed while an action runs is PATCHed after it, and stays unsent (never overwritten) until then (ui-1)", async () => {
    const log: string[] = [];
    const timers = manualTimers();
    const gate = deferred<void>();
    let v = 3;
    const q = createDraftMutationQueue({
      version: () => v,
      patch: async (body, version) => (log.push(`patch:${JSON.stringify(body)}:v${version}`), { ok: true, version: version + 1 }),
      act: async (action) => {
        log.push(`start:${action}`);
        await gate.promise;
        log.push(`end:${action}`);
        v = 3; // the saved row keeps its version
        return { ok: true, status: 200 };
      },
      get: async () => {},
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    });
    const save = q.run("save");
    await new Promise((r) => setTimeout(r, 0));
    q.edit({ typed: "during the save" });
    timers.fireAll(); // the quiet period ends while the save is still running
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(["start:save"]);
    expect(q.unsent()).toBe(true);
    // The save answers: the panel applies its view, and seedsEditorFrom refuses to re-seed over the unsent text.
    expect(seedsEditorFrom({ from: "server", mode: "editor", unsentEdit: q.unsent() })).toBe(false);
    gate.resolve();
    await save;
    await q.flush();
    expect(log).toEqual(["start:save", "end:save", 'patch:{"typed":"during the save"}:v3']);
    expect(q.unsent()).toBe(false);
    expect(seedsEditorFrom({ from: "server", mode: "editor", unsentEdit: q.unsent() })).toBe(true);
    expect(seedsEditorFrom({ from: "edit", mode: "editor", unsentEdit: false })).toBe(false);
    expect(seedsEditorFrom({ from: "server", mode: "preview", unsentEdit: false })).toBe(false);
  });

  it("the editor's changes reach the queue while an action runs (ui-1): typing is accepted on any editable row", () => {
    for (const busy of [null, "saving", "reviewing", "generating"]) expect(acceptsTyping({ isTop: true, mode: "editor", canEdit: true, busy }), String(busy)).toBe(true);
    expect(acceptsTyping({ isTop: false, mode: "editor", canEdit: true, busy: null })).toBe(false);
    expect(acceptsTyping({ isTop: true, mode: "preview", canEdit: true, busy: null })).toBe(false);
    expect(acceptsTyping({ isTop: true, mode: "editor", canEdit: false, busy: null })).toBe(false);
  });

  it("perform runs after the flush with the new version; observe raises the known version", async () => {
    const q = createDraftMutationQueue({
      version: () => 1,
      patch: async () => ({ ok: true, version: 5 }),
      act: async () => ({ ok: true, status: 200 }),
      get: async () => {}
    });
    q.edit({ b: 1 });
    expect(await q.perform(async (v) => `sent with v${v}`)).toBe("sent with v5");
    q.observe(9);
    expect(q.version()).toBe(9);
  });
});

describe("the panel's requests (R2-R12): JSON only, never HTML, never a hash it computed", () => {
  const view = draftView({ id: "ed_" + "f".repeat(32), version: 4 });
  const ctx: ActionContext = { view, version: 5, instruction: "Be brief", shownReadBack: null };
  const shown: ActionContext = { ...ctx, shownReadBack: readBack({ contentHash: OTHER_HASH }) };

  it("maps each action to its route, method and body", () => {
    const id = encodeURIComponent(view.id);
    const cases: [DraftUiAction, ActionContext, unknown][] = [
      ["regenerate", ctx, { method: "POST", path: `/api/exec/drafts/${id}/regenerate`, body: { version: 5, instruction: "Be brief" } }],
      ["write_myself", ctx, { method: "PATCH", path: `/api/exec/drafts/${id}`, body: { version: 5, bodyDoc: EMPTY_BODY_DOC } }],
      ["save", ctx, { method: "POST", path: `/api/exec/drafts/${id}/save`, body: { version: 5 } }],
      ["replace_with_dd", shown, { method: "POST", path: `/api/exec/drafts/${id}/save`, body: { version: 5, seenContentHash: OTHER_HASH } }],
      ["review", ctx, { method: "POST", path: `/api/exec/drafts/${id}/review`, body: { version: 5 } }],
      ["discard", ctx, { method: "DELETE", path: `/api/exec/drafts/${id}`, body: { version: 5 } }],
      ["delete_anyway", shown, { method: "DELETE", path: `/api/exec/drafts/${id}`, body: { version: 5, seenContentHash: OTHER_HASH } }],
      ["delete_restricted", ctx, { method: "DELETE", path: `/api/exec/drafts/${id}`, body: { version: 5, confirmRestrictedDelete: true } }],
      ["check_again", ctx, { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "check" } }],
      ["show_outlook_version", ctx, { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "check" } }],
      ["stop", ctx, { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "stop_generation" } }],
      ["resolve:mark_sent", ctx, { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "mark_sent", checkedOutlook: true } }],
      ["resolve:copy_to_new_draft", ctx, { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "copy_to_new_draft", checkedOutlook: true } }],
      ["resolve:not_sent_new_draft", ctx, { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "not_sent_new_draft", checkedOutlook: true } }],
      [
        "resolve:not_sent_new_draft",
        shown,
        { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "not_sent_new_draft", checkedOutlook: true, seenContentHash: OTHER_HASH } }
      ],
      ["resolve:keep_outlook_version", shown, { method: "POST", path: `/api/exec/drafts/${id}/resolve`, body: { action: "keep_outlook_version", seenContentHash: OTHER_HASH } }]
    ];
    for (const [action, c, expected] of cases) expect(requestFor(action, c), action).toEqual(expected);
  });

  it("the hash-carrying actions refuse to send without a shown read-back; Open in Outlook has its own request", () => {
    for (const a of ["replace_with_dd", "delete_anyway", "resolve:keep_outlook_version"] as const) expect(requestFor(a, ctx)).toBeNull();
    expect(requestFor("open_in_outlook", ctx)).toBeNull();
    expect(outlookOpenedRequest("ed_1")).toEqual({ method: "POST", path: "/api/exec/drafts/ed_1/outlook-opened", body: {} });
  });

  it("an autosave PATCH carries the editor's JSON and the fields its kind allows", () => {
    expect(editRequest(view, 5, { bodyDoc: DOC, subject: "x", to: [{ address: "a@b.co", name: null }], replyAll: true })).toEqual({
      method: "PATCH",
      path: `/api/exec/drafts/${encodeURIComponent(view.id)}`,
      body: { version: 5, bodyDoc: DOC, replyAll: true }
    });
    const n = draftView({ kind: "new" });
    expect(editRequest(n, 2, { subject: "Hello", to: [{ address: "a@b.co", name: "A" }], cc: [] }).body).toEqual({
      version: 2,
      subject: "Hello",
      to: [{ address: "a@b.co", name: "A" }],
      cc: []
    });
    expect(JSON.stringify(editRequest(view, 5, { bodyDoc: DOC }))).not.toMatch(/bodyHtml|<p>/);
    expect(mergeEdits({ bodyDoc: DOC }, { subject: "s" })).toEqual({ bodyDoc: DOC, subject: "s" });
  });

  it("the create (R2): reply and new shapes; hold re-posts with checkedOutlook", () => {
    expect(createRequest({ kind: "reply", threadId: "t1", replyAll: false, checkedOutlook: false }, true, "  Confirm ")).toEqual({
      method: "POST",
      path: "/api/exec/drafts",
      body: { kind: "reply", threadId: "t1", generate: true, replyAll: false, instruction: "Confirm" }
    });
    expect(createRequest({ kind: "reply", threadId: "t1", replyAll: true, checkedOutlook: true }, false, "").body).toEqual({
      kind: "reply",
      threadId: "t1",
      generate: false,
      replyAll: true,
      checkedOutlook: true
    });
    expect(createRequest({ kind: "new", accountId: "acc_1", to: [{ address: "a@b.co", name: null }], cc: [], bcc: [], subject: " Hi " }, true, "Say hi").body).toEqual({
      kind: "new",
      generate: true,
      to: [{ address: "a@b.co" }],
      subject: "Hi",
      accountId: "acc_1",
      instruction: "Say hi"
    });
    expect(createOutcome(201, { id: "ed_1", status: "generating" })).toEqual({ kind: "created", href: "/executive/email/drafts/ed_1" });
    expect(createOutcome(200, { id: "ed_2", status: "draft", existing: true })).toEqual({ kind: "created", href: "/executive/email/drafts/ed_2" });
    expect(createOutcome(409, { error: "hold" })).toEqual({ kind: "hold" });
    expect(createOutcome(409, { error: "sent_copy_found" })).toEqual({ kind: "sent_copy_found" });
    expect(createOutcome(422, { error: "instruction_required" })).toEqual({ kind: "error", lines: ["Tell the assistant what to write."] });
  });

  it("the send (R10) is the review hash and his ticks, nothing else", () => {
    expect(sendRequest("ed_1", reviewResult(), ["newer_inbound", "newer_inbound"])).toEqual({
      method: "POST",
      path: "/api/exec/drafts/ed_1/send",
      body: { reviewHash: HASH, acks: ["newer_inbound"] }
    });
    expect(sendRequest("ed_1", reviewResult({ reviewHash: null }), [])).toBeNull();
  });

  it("answers: a view, a read-back, a review, a successor, or the code's sentence", () => {
    const v = draftView({ status: "saved" });
    expect(outcomeOf("save", 200, { status: "saved", code: null, view: v }).view).toEqual(v);
    const changed = outcomeOf("save", 200, { status: "draft", code: "outlook_changed", readBack: readBack(), view: v });
    expect(changed.readBack?.contentHash).toBe(HASH);
    expect(changed.lines).toEqual(["This draft was changed in Outlook after you saved it."]);
    const unknown = outcomeOf("save", 202, { status: "saving", code: "outcome_unknown" });
    expect(unknown.refetch).toBe(true);
    expect(unknown.lines).toEqual([]);
    const throttled = outcomeOf("save", 200, { status: "draft", code: "throttled", retryAfterSec: 9, view: v });
    expect(throttled.lines).toEqual(["Outlook is busy. Try again in 9 s."]);
    expect(outcomeOf("review", 200, reviewResult()).review?.reviewHash).toBe(HASH);
    expect(outcomeOf("review", 200, reviewResult({ status: "gone" })).review).toBeNull();
    const successor = outcomeOf("resolve:not_sent_new_draft", 200, { status: "discarded", newDraftId: "ed_9", code: null, view: v });
    expect(successor.navigate).toBe("/executive/email/drafts/ed_9");
    const hold = outcomeOf("resolve:mark_sent", 409, { error: "hold" });
    expect(hold.ok).toBe(false);
    expect(hold.refetch).toBe(true);
    const sent409 = outcomeOf("resolve:not_sent_new_draft", 409, { error: "state_conflict", status: "unknown", readBack: readBack() });
    expect(sent409.readBack).not.toBeNull();
    expect(outcomeOf("send", 202, { status: "sent_pending", code: "accepted" }).lines).toEqual([]);
    expect(outcomeOf("send", 200, { status: "saved", code: "changed" }).lines).toEqual(["The draft changed in Outlook after your review. Review it again."]);
    expect(outcomeOf("send", 409, { error: "acks_missing", blockers: ["newer_inbound"] }).lines).toEqual(["Tick every warning before sending."]);
  });

  it("busy states and the checkbox-gated actions", () => {
    expect(busyFor("save")).toBe("saving");
    expect(busyFor("check_again")).toBe("checking");
    expect(busyFor("resolve:mark_sent")).toBe("resolving");
    expect([...NEEDS_CHECKED_OUTLOOK].sort()).toEqual(["resolve:copy_to_new_draft", "resolve:mark_sent", "resolve:not_sent_new_draft"]);
  });
});

describe("PX15: attachmentHintFor (Y12, C44)", () => {
  it("default: a file with nowhere to go gets 'Use Attach files…'; one the composer takes gets none; dropped pasted images get their note", () => {
    expect(attachmentHintFor({}, { kind: "files" })).toBe(ATTACHMENT_HINTS.useAttachFiles);
    expect(attachmentHintFor({ onAttachFiles: () => {} }, { kind: "files" })).toBeNull();
    expect(attachmentHintFor({}, { kind: "pasted_images", count: 2 })).toBe(ATTACHMENT_HINTS.pastedImagesDropped);
    expect(attachmentHintFor({}, { kind: "pasted_images", count: 0 })).toBeNull();
    expect(ATTACHMENT_HINTS.useAttachFiles).toBe("Use Attach files to add attachments.");
    expect(ATTACHMENT_HINTS.pastedImagesDropped).toMatch(/^Images in pasted content aren't included . attach them as files instead\.$/);
  });

  it("hideAttachmentHint suppresses both toasts", () => {
    expect(attachmentHintFor({ hideAttachmentHint: true }, { kind: "files" })).toBeNull();
    expect(attachmentHintFor({ hideAttachmentHint: true }, { kind: "pasted_images", count: 3 })).toBeNull();
    expect(attachmentHintFor({ hideAttachmentHint: false }, { kind: "files" })).toBe(ATTACHMENT_HINTS.useAttachFiles);
  });
});
