import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { neutralizeLinks } from "@/lib/exec/chat/answer";
import { scanDraftOutput, type ScanContext } from "@/lib/exec/drafts-doc";
import { allowedLinkUrl, allowedRemoteImageUrl } from "@/lib/exec/email-srcdoc";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { safeLink } from "@/lib/exec/safe-markdown";
import { defangUrls, slackLink } from "@/lib/exec/slack-ui";

import { HOSTILE_URLS } from "./fixtures/hostile/corpus";

// P9 §2.1 suite 6 (Area B): one URL matrix through every link gate, with the expected answer per gate:
//   allowed  isAllowedLinkUrl (refs.ts): DD, Outlook web items and Slack messages only, https, no userinfo, default port
//   web      safeLink (SafeMarkdown's href): a DD path, or an allowed absolute URL; else plain text
//   slack    slackLink: <url|label> only for an allowed https URL
//   defang   defangUrls: a URL-like token inside a code span (true), or left as text that isn't a URL (false)
//   chat     neutralizeLinks: "[x](url)" loses its link syntax; an absolute URL ends in a code span
//   scan     scanDraftOutput: unexpected_url when a draft carries it (F9 adds the bare forms)
//   anchor   the email frame's anchor rule (allowedLinkUrl): any http(s), mailto: or tel:
//   image    the email frame's remote image rule (allowedRemoteImageUrl): absolute https off DD's site, loaded only on request

const BS = String.fromCharCode(92);
const DD = "https://operations.scaledai.org";

interface Row { url: string; allowed: boolean; web: string | null; slack: boolean; defang: boolean; scan: boolean; anchor: boolean; image: boolean }

const MATRIX: readonly Row[] = [
  { url: `${DD}/tasks/t_1`, allowed: true, web: "/tasks/t_1", slack: true, defang: true, scan: false, anchor: true, image: false },
  { url: "https://scaledai.org/report", allowed: false, web: null, slack: false, defang: true, scan: false, anchor: true, image: false },
  { url: "https://outlook.office.com/mail/inbox/id/AAMkAGI2", allowed: true, web: "https://outlook.office.com/mail/inbox/id/AAMkAGI2", slack: true, defang: true, scan: true, anchor: true, image: true },
  { url: "https://scaledai.slack.com/archives/C0ACMESEO/p1762693200000100", allowed: true, web: "https://scaledai.slack.com/archives/C0ACMESEO/p1762693200000100", slack: true, defang: true, scan: true, anchor: true, image: true },
  { url: HOSTILE_URLS.https, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: true, image: true },
  { url: HOSTILE_URLS.www, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: false, image: false },
  { url: HOSTILE_URLS.bitly, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: false, image: false },
  { url: HOSTILE_URLS.bare, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: false, image: false },
  { url: HOSTILE_URLS.protocolRelative, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: false, image: false },
  { url: `/${BS}evil.example/d`, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: false, image: false },
  // "document.cookie" reads as a bare domain to F9's rule: flagged (the safe direction).
  { url: HOSTILE_URLS.javascript, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: false, image: false },
  { url: HOSTILE_URLS.data, allowed: false, web: null, slack: false, defang: true, scan: false, anchor: false, image: false },
  { url: HOSTILE_URLS.outlookCompose, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: true, image: true },
  { url: HOSTILE_URLS.slackOauth, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: true, image: true },
  { url: HOSTILE_URLS.slackAppRedirect, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: true, image: true },
  { url: HOSTILE_URLS.slackArchiveFrag, allowed: false, web: null, slack: false, defang: true, scan: true, anchor: true, image: true },
  // DD's host with a path that collapses to "//…": allowed (it stays on DD's host), kept absolute by safeLink.
  { url: HOSTILE_URLS.ddDoubleSlash, allowed: true, web: HOSTILE_URLS.ddDoubleSlash, slack: true, defang: true, scan: false, anchor: true, image: false },
  { url: "http://operations.scaledai.org/x", allowed: false, web: null, slack: false, defang: true, scan: false, anchor: true, image: false },
  { url: "https://user:pass@operations.scaledai.org/x", allowed: false, web: null, slack: false, defang: true, scan: true, anchor: false, image: false },
  { url: "https://operations.scaledai.org:8443/x", allowed: false, web: null, slack: false, defang: true, scan: false, anchor: true, image: false },
  { url: "https://operations.scaledai.org.evil.example/x", allowed: false, web: null, slack: false, defang: true, scan: true, anchor: true, image: true },
  { url: "mailto:x@evil.example", allowed: false, web: null, slack: false, defang: true, scan: false, anchor: true, image: false },
  { url: "/tasks/t_9", allowed: false, web: "/tasks/t_9", slack: false, defang: false, scan: false, anchor: false, image: false }
];

const scanCtx: ScanContext = {
  instruction: null, factLines: [], ownDomains: new Set(["scaledai.org"]), internalDomains: new Set(["scaledai.org"]), recipients: new Set(["ann@client.com"]),
  clientNames: null, userNames: null
};

describe("§2.1 suite 6: one URL matrix through every link gate", () => {
  it.each(MATRIX.map((r) => [r.url, r] as const))("%s", (_u, r) => {
    expect(isAllowedLinkUrl(r.url), "isAllowedLinkUrl").toBe(r.allowed);
    expect(safeLink(r.url)?.href ?? null, "safeLink").toBe(r.web);
    const link = slackLink(r.url, "label");
    expect(link !== null, "slackLink").toBe(r.slack);
    if (link !== null) expect(link.startsWith("<https://")).toBe(true);
    const defanged = defangUrls(`see ${r.url} now`);
    expect(/`[^`]+`/.test(defanged), "defangUrls puts it in a code span").toBe(r.defang);
    const chat = neutralizeLinks(`[x](${r.url}) and ${r.url}`);
    expect(chat, "neutralizeLinks leaves no link syntax").not.toContain("](");
    if (/^https?:\/\//.test(r.url)) expect(chat, "an absolute URL ends in a code span").toMatch(/`https?:\/\/[^`]+`/);
    const flags = scanDraftOutput({ paragraphs: [`see ${r.url} now`], signOff: "Thanks,", noteForMitchell: "", placeholders: [], subject: null }, scanCtx);
    expect(flags.includes("unexpected_url"), "scanDraftOutput").toBe(r.scan);
    expect(allowedLinkUrl(r.url) !== null, "email anchor").toBe(r.anchor);
    expect(allowedRemoteImageUrl(r.url) !== null, "email image").toBe(r.image);
    // An allowed link is never a javascript:, data: or protocol-relative one, on any gate.
    for (const href of [safeLink(r.url)?.href, allowedLinkUrl(r.url), allowedRemoteImageUrl(r.url)]) {
      if (typeof href === "string") expect(href).not.toMatch(/^(?:javascript|data):|^\/\//i);
    }
  });

  it("every gate refuses javascript: and data: whatever their case or spacing", () => {
    for (const raw of ["JavaScript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "DATA:text/html,x", "data:image/svg+xml,<svg/onload=alert(1)>"]) {
      expect(isAllowedLinkUrl(raw), raw).toBe(false);
      expect(safeLink(raw), raw).toBeNull();
      expect(slackLink(raw, "x"), raw).toBeNull();
      expect(allowedLinkUrl(raw), raw).toBeNull();
      expect(allowedRemoteImageUrl(raw), raw).toBeNull();
    }
  });
});
