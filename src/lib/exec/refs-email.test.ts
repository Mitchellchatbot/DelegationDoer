import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execEmailRef, execEmailThreadRef, isAllowedLinkUrl, isDdHost } from "@/lib/exec/refs";

// P3's additions to refs.ts: isDdHost (the email frame's image allow-list
// keeps nothing pointing at DD) and the two email refs, which are always
// "private" (contract §3.13: no email ref is public).

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("isDdHost", () => {
  it.each([
    "operations.scaledai.org",
    "delegationdoer-production.up.railway.app",
    "OPERATIONS.ScaledAI.org",
    "operations.scaledai.org.",
    "operations.scaledai.org..",
    "  operations.scaledai.org  "
  ])("%j is a DD host", (host) => {
    expect(isDdHost(host)).toBe(true);
  });

  it("includes the configured app origin's host, however it is spelled", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.example.com/");
    expect(isDdHost("staging.example.com")).toBe(true);
    expect(isDdHost("Staging.Example.com.")).toBe(true);
    expect(isDdHost("example.com")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://Staging.Example.com./");
    expect(isDdHost("staging.example.com")).toBe(true);
  });

  it.each([
    "images.example.com",
    "scaledai.org",
    "evil-operations.scaledai.org",
    "operations.scaledai.org.evil.io",
    "up.railway.app",
    "outlook.office.com"
  ])("%j is not a DD host", (host) => {
    expect(isDdHost(host)).toBe(false);
  });

  // Anything that isn't a plain host name can only remove an image, never keep one.
  it.each(["", "   ", "operations.scaledai.org:443", "user@images.example.com", "a/b", "[::1]", "a b"])(
    "treats the malformed %j as DD (fail closed)",
    (host) => {
      expect(isDdHost(host)).toBe(true);
    }
  );

  it("treats a non-string as DD", () => {
    expect(isDdHost(undefined as unknown as string)).toBe(true);
    expect(isDdHost(42 as unknown as string)).toBe(true);
  });
});

describe("execEmailRef", () => {
  const LINK = "https://outlook.office365.com/owa/?ItemID=AAMkAD%2BZ&exvsurl=1&viewmodel=ReadMessageItem";

  it("is private, keyed by the thread, with the allowlisted Outlook link", () => {
    const ref = execEmailRef({ threadId: "th-1", webLink: LINK, label: "Q3 renewal" });
    expect(ref).toEqual({ system: "outlook", id: "th-1", url: new URL(LINK).href, label: "Q3 renewal", class: "private" });
    expect(isAllowedLinkUrl(ref.url as string)).toBe(true);
  });

  it.each([
    "https://evil.example.com/owa/?ItemID=1",
    "https://outlook.office.com/mail/deeplink/compose?to=x@y.z",
    "http://outlook.office.com/mail/0/",
    "javascript:alert(1)",
    "",
    null,
    undefined
  ])("drops the link %j (not an Outlook item view)", (webLink) => {
    const ref = execEmailRef({ threadId: "th-1", webLink, label: "Subject" });
    expect(ref.url).toBeNull();
    expect(ref.class).toBe("private");
  });

  it("labels a thread with no subject, and clips a long one", () => {
    expect(execEmailRef({ threadId: "th-1" }).label).toBe("Email");
    expect(execEmailRef({ threadId: "th-1", label: "   " }).label).toBe("Email");
    expect(execEmailRef({ threadId: "th-1", label: "x".repeat(500) }).label).toHaveLength(200);
  });
});

describe("execEmailThreadRef", () => {
  it("links the assistant's own thread page, private", () => {
    expect(execEmailThreadRef("4f1c2d3e-aaaa-bbbb-cccc-1234567890ab", "Q3 renewal")).toEqual({
      system: "dd",
      id: "/executive/email/4f1c2d3e-aaaa-bbbb-cccc-1234567890ab",
      url: "https://operations.scaledai.org/executive/email/4f1c2d3e-aaaa-bbbb-cccc-1234567890ab",
      label: "Q3 renewal",
      class: "private"
    });
  });

  it("encodes the thread id, so it can't leave the email section", () => {
    const ref = execEmailThreadRef("../../api/x?y#z", "s");
    expect(ref.url).toBe("https://operations.scaledai.org/executive/email/..%2F..%2Fapi%2Fx%3Fy%23z");
    expect(new URL(ref.url as string).pathname.startsWith("/executive/email/")).toBe(true);
  });

  it("follows the configured app origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.example.com");
    expect(execEmailThreadRef("t1", null).url).toBe("https://staging.example.com/executive/email/t1");
  });

  it("gets no link for an empty thread id, and a fallback label", () => {
    const ref = execEmailThreadRef("", null);
    expect(ref.url).toBeNull();
    expect(ref.label).toBe("Email thread");
    expect(ref.class).toBe("private");
  });

  it("never builds a public ref", () => {
    for (const ref of [execEmailThreadRef("t1", "a"), execEmailRef({ threadId: "t1", webLink: "https://outlook.office.com/mail/0/" })]) {
      expect(ref.class).not.toBe("public");
    }
  });
});
