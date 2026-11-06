import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmSendContent, sendButtonLabel } from "@/components/exec/drafts/ConfirmSendContent";
import { BLOCKER_COPY, COPY } from "@/components/exec/drafts/copy";
import { READ_BACK_FRAME_SANDBOX, ReadBackFrame } from "@/components/exec/drafts/ReadBackFrame";
import type { ReviewBlocker, ReviewResult } from "@/lib/exec/drafts-types";
import { REVIEW_BLOCKERS } from "@/lib/exec/drafts-types";
import { READ_BACK_CSP, READ_BACK_CSP_META, readBackSrcdoc } from "@/lib/exec/drafts-view";
import { formatInZone } from "@/lib/exec/format";
import { HIDDEN_INSTRUCTION, HOSTILE_READBACK_HTML, REMOTE, SAME_ORIGIN, SCRIPT_SENTINEL } from "../__tests__/drafts-hostile-readback";
import { NOW_ISO, readBack, recipient, reviewResult, textOf, TZ } from "../__tests__/drafts-ui-fixtures";

// UI03, UI04 and UI14 (P4 contract §5.11, L10, C64, C75): the confirm
// dialog's content shows exactly the read-back, never DD's own HTML; the
// read-back document is P4's CSP first and inert; the frame is sandbox="".

const render = (review: ReviewResult, extra: Partial<Parameters<typeof ConfirmSendContent>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ConfirmSendContent, {
      review,
      acks: [],
      onToggleAck: () => {},
      isTop: true,
      busy: false,
      nowIso: NOW_ISO,
      tz: TZ,
      onCancel: () => {},
      onSend: () => {},
      ...extra
    })
  );

const sendButton = (html: string) => /<button[^>]*data-confirm="send"[^>]*>([^<]*)<\/button>/.exec(html);

describe("UI03: ConfirmSendContent", () => {
  it("From and Sender by address first, highlighted when they differ; Reply-To with its warning", () => {
    const html = render(
      reviewResult({
        readBack: readBack({
          from: { address: "mitchell@scaledai.org", name: "Mitchell" },
          sender: { address: "assistant@scaledai.org", name: "Assistant" },
          replyTo: [{ address: "replies@acme.com", name: null }]
        })
      })
    );
    const text = textOf(html);
    expect(text).toContain("mitchell@scaledai.org (Mitchell)");
    expect(text).toContain("assistant@scaledai.org (Assistant)");
    expect((html.match(/bg-amber-100/g) ?? []).length).toBe(2);
    expect(text).toContain("Reply-To");
    expect(text).toContain("replies@acme.com");
    expect(text).toContain("Replies go here");
    // Same From and Sender: nothing highlighted.
    const same = render(reviewResult({ readBack: readBack({ sender: { address: "mitchell@scaledai.org", name: null } }) }));
    expect(same).not.toContain("bg-amber-100");
  });

  it("To/Cc/Bcc with badges, the subject, attachments with the inline flag, the signature note", () => {
    const html = render(
      reviewResult({
        readBack: readBack({
          to: [recipient("jane@acme.com", "Jane", ["external", "added_in_outlook"])],
          cc: [recipient("ops@acme.com", null, ["role"])],
          bcc: [recipient("boss@scaledai.org", null, [])],
          subject: "Re: Contract renewal",
          attachments: [
            { name: "renewal.pdf", size: 204_800, isInline: false, contentType: "application/pdf" },
            { name: "logo.png", size: 2_048, isInline: true, contentType: "image/png" }
          ],
          signatureSkipped: true
        })
      })
    );
    const text = textOf(html);
    for (const s of ["jane@acme.com", "External", "Added in Outlook", "ops@acme.com", "Role address", "boss@scaledai.org", "Re: Contract renewal"]) {
      expect(text).toContain(s);
    }
    expect(text).toContain("renewal.pdf");
    expect(text).toContain("200 KB");
    expect(text).toContain("inline image from the quoted email");
    expect(text).toContain(COPY.signatureSkipped);
    expect(textOf(render(reviewResult()))).toContain(COPY.signatureAdded);
  });

  it("every blocker is a required checkbox with its exact copy (facts_outside_client and unexpected_content filled from DD data)", () => {
    const blockers = [...REVIEW_BLOCKERS];
    const html = render(reviewResult({ blockers }), { clientName: "Acme Dental", flags: ["unexpected_url", "unexpected_amount"] });
    const text = textOf(html);
    for (const b of blockers) {
      expect(html).toContain(`data-blocker="${b}"`);
      expect(html).toMatch(new RegExp(`<input type="checkbox" required=""[^>]*data-blocker="${b}"`));
    }
    expect(text).toContain("A reply may already have gone out on this thread: a newer message from you, or an earlier draft for this email. Send anyway");
    expect(text).toContain("I've closed this draft in Outlook and nobody else is editing it");
    expect(text).toContain("This draft uses internal status for Acme Dental, and a recipient isn't at Acme Dental. Send anyway");
    expect(text).toContain("The assistant added a link and an amount of money that weren't in your instruction or the client facts. I've checked them");
    for (const b of blockers) {
      if (b === "facts_outside_client" || b === "unexpected_content") continue;
      expect(text).toContain(BLOCKER_COPY[b]);
    }
  });

  it("Send is disabled until every blocker is ticked, and while busy", () => {
    const blockers: ReviewBlocker[] = ["newer_inbound", "opened_in_outlook"];
    const none = render(reviewResult({ blockers }), { acks: [] });
    expect(none).toMatch(/<button[^>]*data-confirm="send"[^>]*disabled=""/);
    const one = render(reviewResult({ blockers }), { acks: ["newer_inbound"] });
    expect(one).toMatch(/<button[^>]*data-confirm="send"[^>]*disabled=""/);
    const all = render(reviewResult({ blockers }), { acks: ["newer_inbound", "opened_in_outlook"] });
    expect(all).not.toMatch(/<button[^>]*data-confirm="send"[^>]*disabled=""/);
    const busy = render(reviewResult({ blockers }), { acks: ["newer_inbound", "opened_in_outlook"], busy: true });
    expect(busy).toMatch(/<button[^>]*data-confirm="send"[^>]*disabled=""/);
    expect(busy).toMatch(/<button[^>]*data-confirm="cancel"[^>]*disabled=""/);
  });

  it("the countdown, the one-place line, 'Sends immediately', and the review expiry", () => {
    const text = textOf(render(reviewResult()));
    expect(text).toContain(`This review is valid until ${formatInZone("2026-11-06T15:10:00.000Z", TZ, "time", NOW_ISO)}`);
    expect(text).toContain("Send from one place only. If this draft is open in Outlook, close it first.");
    expect(text).toContain("Sends immediately. There's no undo.");
    const expired = render(reviewResult({ reviewExpiresAt: "2026-11-06T14:59:00.000Z" }));
    expect(textOf(expired)).toContain("The review expired after 10 minutes. Review again.");
    expect(expired).toMatch(/<button[^>]*data-confirm="send"[^>]*disabled=""/);
  });

  it("security-6: a display name that looks like an address never labels Send or leads a row", () => {
    const rb = readBack({ to: [recipient("x@evil.example", "accounts@client.com", ["external"])] });
    const html = render(reviewResult({ readBack: rb }));
    const button = sendButton(html);
    expect(button).not.toBeNull();
    expect(button![1]).toContain("x@evil.example");
    expect(button![1]).not.toContain("accounts@client.com");
    expect(sendButtonLabel({ readBack: rb })).toBe("Send to x@evil.example");
    // Every recipient chip leads with the address.
    for (const m of html.matchAll(/data-recipient-primary="true"[^>]*>([^<]*)</g)) expect(m[1]).toMatch(/@/);
    expect(html).toMatch(/data-recipient-primary="true"[^>]*>x@evil\.example</);
    expect(textOf(html)).toContain("x@evil.example(accounts@client.com)");
  });

  it("'Send to <first To> and N more' counts every recipient", () => {
    const rb = readBack({ to: [recipient("a@acme.com"), recipient("b@acme.com")], cc: [recipient("c@acme.com")], bcc: [recipient("d@acme.com")] });
    expect(sendButtonLabel({ readBack: rb })).toBe("Send to a@acme.com and 3 more");
  });

  it("a sentinel in DD's own body never appears: only the read-back is shown", () => {
    const html = render(reviewResult({ readBack: readBack({ srcdoc: "<!DOCTYPE html><html><head></head><body>OUTLOOK</body></html>" }) }));
    expect(html).not.toContain("DD_BODY_HTML_SENTINEL");
    // The frame's srcdoc is set after mount, never as markup.
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("OUTLOOK");
  });

  it("a cut-off read-back says so", () => {
    expect(textOf(render(reviewResult({ readBack: readBack({ truncated: true }) })))).toContain(
      "This preview is cut off: the email is too long to show in full. Check the whole draft in Outlook before sending."
    );
    expect(textOf(render(reviewResult()))).not.toContain("This preview is cut off");
  });

  it("remote images and links: 'N remote images not loaded.' and 'Links in this preview don't open.'", () => {
    const text = textOf(render(reviewResult({ readBack: readBack({ remoteImageCount: 3 }) })));
    expect(text).toContain("3 remote images not loaded.");
    expect(text).toContain("Links in this preview don't open.");
  });

  it("a review with errors has no Send button and lists them; framed (isTop false) neither", () => {
    const html = render(reviewResult({ reviewHash: null, errors: ["placeholders", "restricted_recipient"] }));
    expect(sendButton(html)).toBeNull();
    expect(textOf(html)).toContain("Fill in the [bracketed] placeholders first.");
    expect(textOf(html)).toContain("An address is on the restricted list.");
    expect(sendButton(render(reviewResult(), { isTop: false }))).toBeNull();
  });

  it("each error names its address (ui-4): errorEntries per recipient; From / Sender from the read-back when an answer carries none", () => {
    const rb = readBack({ from: { address: "other@scaledai.org", name: "Other" }, sender: { address: "delegate@scaledai.org", name: null } });
    const withEntries = textOf(render(reviewResult({
      reviewHash: null, readBack: rb, errors: ["restricted_recipient", "from_mismatch", "reply_to_restricted"],
      errorEntries: [
        { code: "restricted_recipient", address: "bad@restricted.example" },
        { code: "restricted_recipient", address: "worse@restricted.example" },
        { code: "from_mismatch", address: "other@scaledai.org" },
        { code: "reply_to_restricted", address: "billing@restricted.example" }
      ]
    })));
    expect(withEntries).toContain("bad@restricted.example is on the restricted list.");
    expect(withEntries).toContain("worse@restricted.example is on the restricted list.");
    expect(withEntries).toContain("The Outlook draft would go out from other@scaledai.org, not your mailbox.");
    expect(withEntries).toContain("The Reply-To address billing@restricted.example is on the restricted list.");
    expect(withEntries).not.toContain("An address");
    // An answer without entries: From and Sender come from the read-back; nothing reads as a broken sentence.
    const bare = textOf(render(reviewResult({ reviewHash: null, readBack: rb, errors: ["from_mismatch", "sender_mismatch", "reply_to_restricted"] })));
    expect(bare).toContain("The Outlook draft would go out from other@scaledai.org, not your mailbox.");
    expect(bare).toContain("The Outlook draft's sender is delegate@scaledai.org, not your mailbox.");
    expect(bare).toContain("A Reply-To address is on the restricted list.");
    expect(bare).not.toContain("from An address");
    expect(bare).not.toContain("is An address");
  });
});

describe("UI04: the hostile read-back is inert (C64)", () => {
  const built = readBackSrcdoc(HOSTILE_READBACK_HTML);
  const doc = built.srcdoc;
  const lower = doc.toLowerCase();

  it("the first element inside <head> is P4's CSP meta, exactly READ_BACK_CSP; P3's own CSP meta follows", () => {
    expect(doc.startsWith(`<!DOCTYPE html><html><head>${READ_BACK_CSP_META}`)).toBe(true);
    const metas = [...doc.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)].map((m) => m[1].replace(/&#39;|&#x27;/g, "'"));
    expect(metas.length).toBe(2);
    expect(metas[0]).toBe(READ_BACK_CSP);
    expect(metas[1]).toContain("default-src 'none'");
    expect(READ_BACK_CSP).toBe(
      "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    );
  });

  it("no live script, iframe, meta refresh, link, base, form, object, video or audio survives", () => {
    for (const tag of ["script", "iframe", "link", "form", "object", "embed", "video", "audio", "source", "track", "frame", "input"]) {
      expect(lower, tag).not.toMatch(new RegExp(`<${tag}[\\s>/]`));
    }
    // The only <base> is P3's own target="_blank" (no href); the email's was blocked.
    expect([...lower.matchAll(/<base[^>]*>/g)].map((m) => m[0])).toEqual(['<base target="_blank">']);
    // The only metas are P3's and P4's own: the email's refresh is gone.
    expect(lower).not.toContain("http-equiv=\"refresh\"");
    expect(lower).not.toContain(SCRIPT_SENTINEL.toLowerCase());
  });

  it("on* handlers and javascript: links are stripped; a cid: image is a placeholder", () => {
    expect(lower).not.toMatch(/\son[a-z]+\s*=/);
    expect(lower).not.toContain("javascript:");
    expect(doc).toContain("[Inline image: inline logo]");
    expect(lower).not.toContain("cid:");
  });

  it("remoteImageCount equals the fixture's remote images (four <img> sources and three CSS urls; DD-host and relative ones are dropped outright)", () => {
    expect(built.remoteImageCount).toBe(7);
    expect(built.truncated).toBe(false);
  });

  it("the stronger assertion (images-off document): no https: or same-origin URL in any src, srcset, background, poster, data, ping or url(", () => {
    expect(doc).not.toMatch(/\s(?:src|srcset|background|poster|data|ping|xlink:href)\s*=\s*["']?\s*(?:https?:|\/\/|\/)/i);
    expect(doc).not.toMatch(/url\(\s*["']?\s*(?:https?:|\/\/|\/)/i);
    expect(doc).not.toMatch(/@import/i);
    // SVG <image>, <use> and <feImage> can't fetch either.
    expect(lower).not.toMatch(/<(?:image|use|feimage)[\s>]/);
    // Links may remain as text targets, but nothing else names the hosts.
    const withoutAnchors = doc.replace(/<a [^>]*>/g, "");
    expect(withoutAnchors).not.toContain(REMOTE);
    expect(withoutAnchors).not.toContain(SAME_ORIGIN);
  });

  it("every URL left in the document is inert under READ_BACK_CSP: only data: images and fonts, inline styles", () => {
    for (const m of doc.matchAll(/url\(([^)]*)\)/g)) expect(m[1].trim().replace(/^["']/, "")).toMatch(/^data:/);
    for (const m of doc.matchAll(/\ssrc="([^"]*)"/g)) expect(m[1]).toMatch(/^data:/);
    expect(READ_BACK_CSP).toMatch(/img-src data:;/);
    expect(READ_BACK_CSP).toMatch(/media-src 'none'/);
    expect(READ_BACK_CSP).toMatch(/connect-src 'none'/);
    expect(READ_BACK_CSP).toMatch(/frame-src 'none'/);
    expect(READ_BACK_CSP).toMatch(/object-src 'none'/);
  });

  it("the hidden instruction stays text inside the frame document, never in the page", () => {
    expect(doc).toContain(HIDDEN_INSTRUCTION);
    const html = render(reviewResult({ readBack: readBack({ srcdoc: doc, remoteImageCount: built.remoteImageCount }) }));
    expect(html).not.toContain(HIDDEN_INSTRUCTION);
    expect(textOf(html)).toContain("7 remote images not loaded.");
  });
});

describe("UI14: ReadBackFrame and the refused preview", () => {
  it("the iframe's sandbox is exactly empty, referrerPolicy is no-referrer, the box has a fixed height", () => {
    const html = renderToStaticMarkup(createElement(ReadBackFrame, { srcdoc: "<p>x</p>", title: "Preview" }));
    expect(READ_BACK_FRAME_SANDBOX).toBe("");
    expect(html).toMatch(/<iframe[^>]*sandbox=""/);
    expect(html).not.toMatch(/allow-same-origin|allow-popups|allow-scripts/);
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("h-[min(60vh,560px)]");
    expect(html).not.toContain("srcdoc");
  });

  it("the island's code has no autosize path and never sets srcdoc as markup", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../components/exec/drafts/ReadBackFrame.tsx", import.meta.url)), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/ResizeObserver|scrollHeight|contentDocument|contentWindow/);
    expect(code).not.toMatch(/srcDoc=/);
    expect(code).not.toContain("allow-");
    expect(code).toContain('sandbox={READ_BACK_FRAME_SANDBOX}');
  });

  it("a dialog whose readBackSrcdoc threw (readBack null) shows the 'couldn't be built safely' line and no Send button", () => {
    // As the server answers it (drafts.ts pushes preview_unavailable): the code itself never shows (ui-3).
    const html = render(reviewResult({ readBack: null, reviewHash: null, errors: ["preview_unavailable"] }));
    expect(textOf(html)).toContain("The preview couldn't be built safely. Open the draft in Outlook to check it.");
    expect(textOf(html)).not.toContain("preview_unavailable");
    expect(textOf(html)).not.toContain("This can't be sent yet");
    // An unknown code is the generic sentence, never the raw code.
    const unknown = textOf(render(reviewResult({ reviewHash: null, errors: ["some_new_code"] })));
    expect(unknown).not.toContain("some_new_code");
    expect(unknown).toContain("Something went wrong. Reload the page and try again.");
    expect(sendButton(html)).toBeNull();
    expect(html).not.toContain("<iframe");
    // Even with a review hash, no read-back means no Send.
    expect(sendButton(render(reviewResult({ readBack: null })))).toBeNull();
  });
});
