import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appOrigin,
  clipExcerpt,
  ddClientRef,
  ddProjectRef,
  ddTaskRef,
  isAllowedLinkUrl,
  outlookMessageRef,
  slackMessageRef
} from "@/lib/exec/refs";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("appOrigin", () => {
  it("defaults to the canonical DD host", () => {
    expect(appOrigin()).toBe("https://operations.scaledai.org");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "   ");
    expect(appOrigin()).toBe("https://operations.scaledai.org");
  });

  it("uses NEXT_PUBLIC_APP_URL without trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.example.com/");
    expect(appOrigin()).toBe("https://staging.example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " https://staging.example.com/// ");
    expect(appOrigin()).toBe("https://staging.example.com");
  });
});

describe("isAllowedLinkUrl", () => {
  it.each([
    "https://operations.scaledai.org/tasks/t_1",
    "https://operations.scaledai.org/executive?tab=team#top",
    "https://delegationdoer-production.up.railway.app/clients/c_1",
    "https://outlook.office.com/mail/inbox/id/AAMk%3D",
    "https://outlook.office.com/mail/0/id/AAMk",
    "https://outlook.office365.com/owa/?ItemID=AAMkAD%2BZ&exvsurl=1&viewmodel=ReadMessageItem",
    "https://outlook.office365.com/owa/?itemid=AAMkAG&exvsurl=1&path=/calendar/item",
    "https://outlook.live.com/owa/?ItemID=AQMk&exvsurl=1&viewmodel=ReadMessageItem&ispopout=0",
    "https://outlook.live.com/mail/0/",
    "https://slack.com/app_redirect?channel=C1",
    "https://slack.com/app_redirect?team=T1&channel=C1",
    "https://scaledai.slack.com/archives/C123/p1700000000000100",
    "https://scaledai.slack.com/archives/C123/p1700000000000200?thread_ts=1700000000.000100&cid=C123",
    "https://scaledai.slack.com/files/U1/F1/report.pdf",
    "https://app.slack.com/client/T1/C1",
    "https://files.slack.com/files-pri/T1-F1/x.pdf",
    "https://xn--80ak6aa92e.slack.com/archives/C1",
    "HTTPS://SCALEDAI.SLACK.COM/archives/C1",
    "https://slack.com:443/archives/C1"
  ])("allows %s", (url) => {
    expect(isAllowedLinkUrl(url)).toBe(true);
  });

  // One click on any of these would act for the reader: OAuth consent for an
  // attacker's app, a Web API call carrying its own token and text, a compose
  // window addressed to an attacker.
  it.each([
    "https://slack.com/oauth/v2/authorize?client_id=111.222&user_scope=channels:history,im:history,search:read&redirect_uri=https://attacker.example/cb",
    "https://scaledai.slack.com/oauth?client_id=111.222&scope=admin",
    "https://slack.com/openid/connect/authorize?client_id=1&scope=openid&redirect_uri=https://attacker.example/cb",
    "https://slack.com/api/chat.postMessage?token=xoxp-ATTACKER&channel=C0EVIL&text=Q3%20payroll%20numbers",
    "https://scaledai.slack.com/archives/../api/chat.postMessage?token=xoxp-ATTACKER",
    "https://slack.com/apps/A0EVIL",
    "https://slack.com/app_redirect?app=A0EVIL",
    "https://slack.com/app_redirect?channel=C1&app=A0EVIL",
    "https://slack.com/checkcookie?redir=https://evil.io",
    "https://hooks.slack.com/services/T0/B0/XXXX",
    "https://scaledai.slack.com/",
    "https://scaledai.slack.com/archives/C1#x",
    "https://scaledai.slack.com/archives/C1/p1700000000000100?redir=https://evil.io",
    "https://app.slack.com/client/T1/C1?redir=https://evil.io",
    "https://files.slack.com/files-pri/T1-F1/x.pdf?redirect=https://evil.io",
    "https://outlook.office.com/mail/deeplink/compose?to=attacker@example.com&body=private%20summary",
    "https://outlook.office.com/mail/deeplink/compose",
    "https://outlook.office.com/mail/0/deeplink/compose",
    "https://outlook.office.com/mail/deeplink/id/AAMk",
    "https://outlook.office.com/mail/options/mail/forwarding",
    "https://outlook.office.com/mail/inbox/id/AAMk?to=attacker@example.com",
    "https://outlook.office.com/mail/inbox?to=attacker@example.com",
    "https://outlook.office.com/owa/?path=/mail/action/compose&to=attacker@example.com&body=x",
    "https://outlook.office365.com/owa/?ItemID=AAMk&path=/mail/action/compose",
    "https://outlook.office365.com/owa/?ItemID=AAMk&to=attacker@example.com",
    "https://outlook.office365.com/owa/?ItemID=AAMk&viewmodel=ComposeMessageItem",
    "https://outlook.office.com/owa/#path=/mail/action/compose&to=attacker@example.com",
    "https://outlook.office365.com/owa/?ItemID=AAMk&exvsurl=1#path=/mail/action/compose",
    "https://outlook.office.com/calendar/0/deeplink/compose?subject=x&body=y",
    "https://outlook.office365.com/owa/redir.aspx?URL=https://evil.io",
    "https://outlook.office365.com/owa/",
    "https://outlook.office365.com/owa/?ItemID=&exvsurl=1"
  ])("rejects an action link on an allowed host: %s", (url) => {
    expect(isAllowedLinkUrl(url)).toBe(false);
  });

  it("keeps a forged link out of refs too", () => {
    const compose = "https://outlook.office.com/mail/deeplink/compose?to=attacker@example.com&body=x";
    expect(outlookMessageRef({ id: "m", webLink: compose, subject: "s" }).url).toBeNull();
    const api = "https://slack.com/api/chat.postMessage?token=xoxp-ATTACKER&channel=C0EVIL&text=x";
    expect(slackMessageRef({ channelId: "C1", ts: "1.2", permalink: api, label: "x", isPrivate: false }).url).toBeNull();
  });

  it("allows the configured app origin's host", () => {
    expect(isAllowedLinkUrl("https://staging.example.com/tasks/1")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.example.com");
    expect(isAllowedLinkUrl("https://staging.example.com/tasks/1")).toBe(true);
  });

  it("adds no host for a malformed NEXT_PUBLIC_APP_URL, and the fixed hosts still work", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "::not-a-url");
    expect(isAllowedLinkUrl("https://evil.io/")).toBe(false);
    expect(isAllowedLinkUrl("https://operations.scaledai.org/tasks/1")).toBe(true);
    expect(isAllowedLinkUrl("https://scaledai.slack.com/archives/C1")).toBe(true);
  });

  it.each([
    "https://slack.com.evil.io/archives/C1",
    "https://evilslack.com/",
    "https://sslack.com/",
    "https://slack.co/",
    "https://slack.com./",
    "https://scaledai.slack.com./archives/C1",
    "https://.slack.com/",
    "https://xn--slck-zua.com/",
    "https://slаck.com/",
    "https://operations.scaledai.org.evil.io/tasks/1",
    "https://evil.io/operations.scaledai.org",
    "https://evil.io/?u=https://slack.com",
    "https://evil.io#@slack.com",
    "https://outlook.office.com.evil.io/",
    "https://mail.outlook.office.com/",
    "https://scaledai.org/",
    "https://up.railway.app/"
  ])("rejects the lookalike %s", (url) => {
    expect(isAllowedLinkUrl(url)).toBe(false);
  });

  it.each([
    "http://operations.scaledai.org/tasks/1",
    "http://slack.com/",
    "javascript:alert(document.cookie)",
    "JavaScript://slack.com/%0aalert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://slack.com/",
    "file:///etc/passwd",
    "wss://scaledai.slack.com/",
    "//slack.com/archives/C1",
    "/tasks/t_1",
    "slack.com"
  ])("rejects the non-https link %s", (url) => {
    expect(isAllowedLinkUrl(url)).toBe(false);
  });

  it.each(["https://slack.com:8443/", "https://operations.scaledai.org:80/", "https://outlook.office.com:444/"])(
    "rejects a non-default port: %s",
    (url) => {
      expect(isAllowedLinkUrl(url)).toBe(false);
    }
  );

  it.each([
    "https://user@slack.com/",
    "https://user:pass@scaledai.slack.com/",
    "https://slack.com@evil.io/",
    "https://:pw@operations.scaledai.org/"
  ])("rejects userinfo: %s", (url) => {
    expect(isAllowedLinkUrl(url)).toBe(false);
  });

  it.each([
    " https://slack.com/",
    "https://slack.com/ ",
    "https://slack.com/\n",
    "https://sla\tck.com/",
    "https://slack.com/a b",
    "https:\\\\slack.com\\x",
    "https://slack.com\\@evil.io/",
    "https://slack.com/\u0000"
  ])("rejects whitespace, controls and backslashes: %j", (url) => {
    expect(isAllowedLinkUrl(url)).toBe(false);
  });

  it("rejects empty, oversized and non-string input", () => {
    expect(isAllowedLinkUrl("")).toBe(false);
    expect(isAllowedLinkUrl(`https://slack.com/${"a".repeat(4_100)}`)).toBe(false);
    expect(isAllowedLinkUrl(null as unknown as string)).toBe(false);
    expect(isAllowedLinkUrl(42 as unknown as string)).toBe(false);
    expect(isAllowedLinkUrl("https://")).toBe(false);
  });
});

describe("DD refs", () => {
  it("builds task, client and project refs on the real detail routes", () => {
    expect(ddTaskRef({ id: "t_1", title: "  Fix the\nhomepage  " })).toEqual({
      system: "dd",
      id: "t_1",
      url: "https://operations.scaledai.org/tasks/t_1",
      label: "Fix the homepage",
      class: "internal"
    });
    expect(ddClientRef({ id: "c_1", name: "Acme" })).toEqual({
      system: "dd",
      id: "c_1",
      url: "https://operations.scaledai.org/clients/c_1",
      label: "Acme",
      class: "internal"
    });
    expect(ddProjectRef({ id: "p_1", name: "Relaunch" })).toEqual({
      system: "dd",
      id: "p_1",
      url: "https://operations.scaledai.org/projects/p_1",
      label: "Relaunch",
      class: "internal"
    });
  });

  it("encodes ids so they can't change the path", () => {
    expect(ddTaskRef({ id: "a/../b?c#d", title: "x" }).url).toBe("https://operations.scaledai.org/tasks/a%2F..%2Fb%3Fc%23d");
  });

  it("follows NEXT_PUBLIC_APP_URL, and drops the link when that origin isn't allowed", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.example.com/");
    expect(ddClientRef({ id: "c_1", name: "Acme" }).url).toBe("https://staging.example.com/clients/c_1");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    expect(ddTaskRef({ id: "t_1", title: "x" }).url).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not a url");
    expect(ddProjectRef({ id: "p_1", name: "x" }).url).toBeNull();
  });

  it("falls back to a label from the id, and has no link without an id", () => {
    expect(ddTaskRef({ id: "t_9", title: "   " }).label).toBe("Task t_9");
    expect(ddClientRef({ id: "c_9", name: null }).label).toBe("Client c_9");
    expect(ddProjectRef({ id: "p_9" }).label).toBe("Project p_9");
    expect(ddTaskRef({ id: "", title: "x" }).url).toBeNull();
  });

  it("caps labels at 200 characters", () => {
    const label = ddTaskRef({ id: "t_1", title: "w ".repeat(300) }).label;
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("outlookMessageRef", () => {
  const webLink = "https://outlook.office365.com/owa/?ItemID=AAMkAD%2BZ&exvsurl=1&viewmodel=ReadMessageItem";

  it("links to Outlook on the web and is public by default", () => {
    expect(outlookMessageRef({ id: "AAMk1", webLink, subject: "Re: proposal" })).toEqual({
      system: "outlook",
      id: "AAMk1",
      url: webLink,
      label: "Re: proposal",
      class: "public"
    });
  });

  it("is restricted when the sender is restricted", () => {
    expect(outlookMessageRef({ id: "AAMk1", webLink, subject: "Invoice", restricted: true }).class).toBe("restricted");
    expect(outlookMessageRef({ id: "AAMk1", webLink, subject: "Invoice", restricted: false }).class).toBe("public");
  });

  it("drops a webLink that isn't on an allowed host", () => {
    expect(outlookMessageRef({ id: "m", webLink: "https://outlook.office365.com.evil.io/owa", subject: "s" }).url).toBeNull();
    expect(outlookMessageRef({ id: "m", webLink: "javascript:alert(1)", subject: "s" }).url).toBeNull();
    expect(outlookMessageRef({ id: "m", webLink: null, subject: "s" }).url).toBeNull();
    expect(outlookMessageRef({ id: "m", subject: "s" }).url).toBeNull();
  });

  it("labels a message without a subject", () => {
    expect(outlookMessageRef({ id: "m", webLink, subject: "" }).label).toBe("(no subject)");
    expect(outlookMessageRef({ id: "m", webLink, subject: null }).label).toBe("(no subject)");
  });

  it("returns the canonical form of the link", () => {
    expect(outlookMessageRef({ id: "m", webLink: "https://OUTLOOK.office.com/mail", subject: "s" }).url).toBe(
      "https://outlook.office.com/mail"
    );
  });
});

describe("slackMessageRef", () => {
  const permalink = "https://scaledai.slack.com/archives/C123/p1700000000000100";

  it("ids by channel and ts, and classes by privacy", () => {
    expect(slackMessageRef({ channelId: "C123", ts: "1700000000.000100", permalink, label: "#ops", isPrivate: false })).toEqual({
      system: "slack",
      id: "C123:1700000000.000100",
      url: permalink,
      label: "#ops",
      class: "public"
    });
    expect(slackMessageRef({ channelId: "D1", ts: "1.2", permalink, label: "DM", isPrivate: true }).class).toBe("private");
  });

  it("fails closed to private when the privacy flag is missing", () => {
    const ref = slackMessageRef({ channelId: "G1", ts: "1.2", permalink, label: "x" } as unknown as Parameters<
      typeof slackMessageRef
    >[0]);
    expect(ref.class).toBe("private");
  });

  it("drops a permalink off Slack and labels an unlabeled message", () => {
    const ref = slackMessageRef({ channelId: "C1", ts: "1.2", permalink: "https://evilslack.com/x", label: "", isPrivate: false });
    expect(ref.url).toBeNull();
    expect(ref.label).toBe("Slack message");
    expect(slackMessageRef({ channelId: "C1", ts: "1.2", permalink: null, label: null, isPrivate: false }).url).toBeNull();
  });
});

describe("clipExcerpt", () => {
  it("collapses whitespace and trims", () => {
    expect(clipExcerpt("  hello \n\n\t world  ")).toBe("hello world");
  });

  it("keeps the result within max, ellipsis included", () => {
    const long = "word ".repeat(200);
    const out = clipExcerpt(long);
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith("…")).toBe(true);
    expect(clipExcerpt(long, 20).length).toBeLessThanOrEqual(20);
    expect(clipExcerpt("hello world foo", 7)).toBe("hello…");
    expect(clipExcerpt("exactly ten", 11)).toBe("exactly ten");
  });

  it("never splits a surrogate pair", () => {
    for (let max = 1; max <= 12; max++) {
      const out = clipExcerpt("😀".repeat(50), max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(LONE_SURROGATE.test(out)).toBe(false);
    }
  });

  it("drops control and bidi-override characters and repairs lone surrogates", () => {
    expect(clipExcerpt("a\u0000b")).toBe("ab");
    expect(clipExcerpt("a \u0001 b")).toBe("a b");
    expect(clipExcerpt("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(clipExcerpt("x\u2066y\u2069z")).toBe("xyz");
    expect(clipExcerpt("bad\uD800half")).toBe("bad�half");
  });

  it("handles degenerate limits and input", () => {
    expect(clipExcerpt("abc", 0)).toBe("");
    expect(clipExcerpt("abc", -5)).toBe("");
    expect(clipExcerpt("abc", Number.NaN)).toBe("");
    expect(clipExcerpt("abcdef", 1)).toBe("…");
    expect(clipExcerpt("abcdef", 3.9)).toBe("ab…");
    expect(clipExcerpt(null as unknown as string)).toBe("");
    expect(clipExcerpt("")).toBe("");
  });
});
