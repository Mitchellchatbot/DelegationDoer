import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/exec/drafts/frame-guard", () => ({ useIsTopWindow: vi.fn(() => true) }));

import { DraftCard } from "@/components/exec/chat/DraftCard";
import { ProposalCard, proposalAfter, proposalStatusText } from "@/components/exec/chat/ProposalCard";
import { useIsTopWindow } from "@/components/exec/drafts/frame-guard";
import {
  CONFIRM_BUTTON,
  DISMISS_BUTTON,
  DRAFT_EXISTING,
  DRAFT_STARTED,
  FRAMED_TEXT,
  OPEN_DRAFT_LINK,
  OPEN_TASK_LINK,
  PRIVATE_REF_KIND_LABELS,
  PROPOSAL_CHANGED,
  PROPOSAL_CONFIRMED,
  PROPOSAL_CONFIRMING,
  PROPOSAL_DISMISSED,
  PROPOSAL_ERROR,
  PROPOSAL_EXPIRED,
  PROPOSAL_PRIVACY_NOTICE,
  PROPOSAL_REMOVED,
  PROPOSAL_UNASSIGNED,
  draftPrivateRefsText
} from "@/lib/exec/chat/copy";
import type { ProposalView } from "@/lib/exec/chat/view-types";
import { draftPageHref } from "@/lib/exec/drafts-links";
import { DRAFT_ID, draftCard, HOSTILE_ANSWER, hrefsOf, NOW_ISO, proposal, textOf, TZ } from "../__tests__/chat-ui-fixtures";

// P5b contract §5 tests 94 and 95 (Area E; §3.19.5, C23, C24, C42, C43,
// b-security-4): the proposal card in every state, showing the full title and
// description as plain text with every detail, the privacy notice, the frame
// guard; and the draft card's link and copy. The Confirm request and its
// 200 / 409 changed / 410 answers are in chat-transport.test.ts; proposalAfter
// below is how the card takes them.

const card = (p: ProposalView, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ProposalCard, { proposal: p, nowIso: NOW_ISO, tz: TZ, isTop: true, ...extra }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*data-proposal-action="([a-z]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  vi.mocked(useIsTopWindow).mockReturnValue(true);
});

describe("ProposalCard (test 94)", () => {
  it("pending: the full title and description as plain text, every detail, Expires, Confirm and Dismiss", () => {
    const html = card(proposal());
    const text = textOf(html);
    expect(text).toContain("Call Acme about the renewal");
    expect(text).toContain("Ask whether they want the annual plan.\nConfirm the start date.");
    expect(text).toContain("AssigneeDana Lee");
    expect(text).toContain("DepartmentAccounts");
    expect(text).toContain("ClientAcme");
    expect(text).toContain("PriorityHigh");
    expect(text).toContain("DueNov 12");
    expect(text).toContain("Expires in 7 d");
    expect(buttons(html)).toEqual(["confirm", "dismiss"]);
    expect(text).toContain(CONFIRM_BUTTON);
    expect(text).toContain(DISMISS_BUTTON);
    expect(text).not.toContain(PROPOSAL_PRIVACY_NOTICE);
    // The description scrolls; it is never clipped.
    expect(html).toMatch(/data-proposal-description="true"[^>]*class="[^"]*max-h-64 overflow-y-auto/);
  });

  it("unassigned, no department, client or due: 'Unassigned' and dashes", () => {
    const text = textOf(card(proposal({ assigneeName: null, departmentName: null, clientName: null, dueOn: null })));
    expect(text).toContain(`Assignee${PROPOSAL_UNASSIGNED}`);
    expect(text).toContain("Department—");
    expect(text).toContain("Client—");
    expect(text).toContain("Due—");
  });

  it("the hostile payload in a full title and a 4,000-character description renders as literal text: no markdown, no <img>, no href", () => {
    const description = (HOSTILE_ANSWER + "\n").repeat(40).slice(0, 4000);
    expect(description).toHaveLength(4000);
    const title = "![x](https://evil.example/p.png) [click](https://evil.example) <img src=x onerror=alert(1)>";
    const html = card(proposal({ title, description, privacyNotice: true }));
    expect(html).not.toMatch(/<img\b/i);
    expect(hrefsOf(html)).toEqual([]);
    expect(html).not.toMatch(/<script\b/i);
    // No inline handler on any element (the payload's text is escaped, so "<" never starts one).
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    const text = textOf(html);
    expect(text).toContain(title);
    expect(text).toContain("![x](https://evil.example/p.png)");
    expect(text).toContain(description);
    expect(text).toContain(PROPOSAL_PRIVACY_NOTICE);
  });

  it("the privacy notice shows only when privacyNotice", () => {
    expect(textOf(card(proposal({ privacyNotice: true })))).toContain(PROPOSAL_PRIVACY_NOTICE);
    expect(textOf(card(proposal({ privacyNotice: false })))).not.toContain(PROPOSAL_PRIVACY_NOTICE);
  });

  it("every other state: its line and no buttons", () => {
    const cases: [Partial<ProposalView>, string][] = [
      [{ status: "confirming" }, PROPOSAL_CONFIRMING],
      [{ status: "confirmed", taskHref: "/tasks/t_9" }, PROPOSAL_CONFIRMED],
      [{ status: "dismissed" }, PROPOSAL_DISMISSED],
      [{ status: "expired" }, PROPOSAL_EXPIRED],
      [{ status: "withdrawn" }, PROPOSAL_REMOVED]
    ];
    for (const [over, line] of cases) {
      const html = card(proposal(over));
      expect(textOf(html), over.status).toContain(line);
      expect(buttons(html), over.status).toEqual([]);
      expect(proposalStatusText(proposal(over))).toBe(line);
    }
    const confirmed = card(proposal({ status: "confirmed", taskHref: "/tasks/t_9" }));
    expect(textOf(confirmed)).toContain(OPEN_TASK_LINK);
    expect(hrefsOf(confirmed)).toEqual(["/tasks/t_9"]);
    // A task link that isn't a DD path is never drawn.
    expect(hrefsOf(card(proposal({ status: "confirmed", taskHref: "https://evil.example/t" })))).toEqual([]);
  });

  it("a redacted card shows Removed and nothing of its content, in any status", () => {
    for (const status of ["pending", "confirmed", "dismissed"] as const) {
      const html = card(proposal({ status, redacted: true, title: "[Removed]", description: "", taskHref: status === "confirmed" ? "/tasks/t_9" : null }));
      const text = textOf(html);
      expect(text, status).toContain(PROPOSAL_REMOVED);
      expect(text, status).not.toContain("[Removed]");
      expect(text, status).not.toContain("Assignee");
      expect(buttons(html), status).toEqual([]);
      // ui-9: a confirmed task outlives the redaction (C20 keeps the status and the task id): it still says so and links.
      expect(hrefsOf(html), status).toEqual(status === "confirmed" ? ["/tasks/t_9"] : []);
      if (status === "confirmed") expect(text).toContain(PROPOSAL_CONFIRMED);
      else expect(text, status).not.toContain(PROPOSAL_CONFIRMED);
    }
  });

  it("frame guard false: no buttons, the framed copy (from the prop or the hook)", () => {
    const framed = card(proposal(), { isTop: false });
    expect(buttons(framed)).toEqual([]);
    expect(textOf(framed)).toContain(FRAMED_TEXT);
    vi.mocked(useIsTopWindow).mockReturnValue(false);
    const viaHook = renderToStaticMarkup(createElement(ProposalCard, { proposal: proposal(), nowIso: NOW_ISO, tz: TZ }));
    expect(buttons(viaHook)).toEqual([]);
    expect(textOf(viaHook)).toContain(FRAMED_TEXT);
  });

  it("after Confirm: 200 takes the confirmed view; 409 changed re-renders the returned proposal and says so; an error keeps the card with the error line", () => {
    const before = proposal();
    expect(proposalAfter({ kind: "updated", proposal: proposal({ status: "confirmed", taskHref: "/tasks/t_9" }) }, before)).toEqual({
      proposal: proposal({ status: "confirmed", taskHref: "/tasks/t_9" }),
      note: null
    });
    const changed = proposal({ title: "Call Acme about the renewal (edited)", contentHash: "e".repeat(64) });
    const after = proposalAfter({ kind: "changed", proposal: changed }, before);
    expect(after).toEqual({ proposal: changed, note: "changed" });
    const html = card(after.proposal, { initialNote: after.note });
    expect(textOf(html)).toContain(PROPOSAL_CHANGED);
    expect(textOf(html)).toContain("(edited)");
    expect(buttons(html)).toEqual(["confirm", "dismiss"]);
    // 410 is "expired" (transport maps it); the card then shows the expired line.
    expect(textOf(card(proposalAfter({ kind: "updated", proposal: proposal({ status: "expired" }) }, before).proposal))).toContain(PROPOSAL_EXPIRED);
    const failed = proposalAfter({ kind: "failed" }, before);
    expect(failed).toEqual({ proposal: before, note: "error" });
    expect(textOf(card(failed.proposal, { initialNote: failed.note }))).toContain(PROPOSAL_ERROR);
  });
});

describe("DraftCard (test 95)", () => {
  it("href is draftPageHref(id), never the payload's href; 'Draft started' and Open draft", () => {
    const html = renderToStaticMarkup(createElement(DraftCard, { card: draftCard({ href: "https://evil.example/d" }) }));
    expect(hrefsOf(html)).toEqual([draftPageHref(DRAFT_ID)]);
    expect(draftPageHref(DRAFT_ID)).toBe(`/executive/email/drafts/${DRAFT_ID}`);
    expect(textOf(html)).toContain(DRAFT_STARTED);
    expect(textOf(html)).toContain(OPEN_DRAFT_LINK);
    expect(html).not.toContain("data-draft-private-refs");
  });

  it("the existing-draft copy", () => {
    const text = textOf(renderToStaticMarkup(createElement(DraftCard, { card: draftCard({ existing: true }) })));
    expect(text).toContain(DRAFT_EXISTING);
    expect(text).not.toContain(DRAFT_STARTED);
  });

  it("ui-2: an existing draft never shows the private-refs line (no second confirmation was set for it)", () => {
    const html = renderToStaticMarkup(createElement(DraftCard, { card: draftCard({ existing: true, privateRefKinds: ["other_threads"] }) }));
    expect(html).not.toContain("data-draft-private-refs");
    expect(textOf(html)).toContain(DRAFT_EXISTING);
  });

  it("the DRAFT_PRIVATE_REFS line names each kind", () => {
    const kinds = ["other_threads", "dd_text", "other_clients"] as const;
    const html = renderToStaticMarkup(createElement(DraftCard, { card: draftCard({ privateRefKinds: [...kinds] }) }));
    const text = textOf(html);
    expect(text).toContain(draftPrivateRefsText([...kinds]));
    for (const k of kinds) expect(text).toContain(PRIVATE_REF_KIND_LABELS[k]);
    expect(text).toContain("Started in a conversation that also read other email threads, team notes or comments and other clients' records.");
    expect(textOf(renderToStaticMarkup(createElement(DraftCard, { card: draftCard({ privateRefKinds: ["dd_text"] }) })))).toContain(
      "Started in a conversation that also read team notes or comments. You'll be asked to confirm before saving or sending."
    );
  });
});
