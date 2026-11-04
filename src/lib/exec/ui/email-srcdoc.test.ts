import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowedLinkUrl,
  allowedRemoteImageUrl,
  buildEmailSrcdoc,
  emailFrameCsp,
  filterCss,
  MAX_EMAIL_HTML_CHARS,
  sanitizeEmailHtml,
  type SanitizeContext
} from "@/lib/exec/email-srcdoc";

// The email frame's document builder (contract L15, §3.14, §5 F srcdoc,
// v3.1 A7 image allow-list, round-4 coherence-22). Every vector named there
// is here: CSP first, the img-src toggle, the inert renames, on* stripping,
// the cid placeholder, and every way an image URL can reach DD (img
// src/srcset, <image>, background=, poster, style url(), <style> url(),
// image-set(), input[type=image], SVG image/feImage/use, picture > source).

const off = (): SanitizeContext => ({ showRemote: false, remote: 0, inline: 0 });
const on = (): SanitizeContext => ({ showRemote: true, remote: 0, inline: 0 });
const OFF = (html: string) => sanitizeEmailHtml(html, off());
const ON = (html: string) => sanitizeEmailHtml(html, on());

const EXTERNAL = "https://cdn.example.com/pic.png";

beforeEach(() => {
  // A configured app origin on its own host: its images are DD's too.
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dd.example.org");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The output audit: the output must be canonical (every "<" opens a tag this
// code wrote, attribute values quoted and escaped), and no tag may fetch,
// run or submit anything the rules don't allow.
// ---------------------------------------------------------------------------

const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "meta",
  "link",
  "base",
  "portal",
  "fencedframe",
  "title",
  "noembed",
  "noframes",
  "source",
  "track",
  "use",
  "feimage",
  "animate",
  "set",
  "image",
  "xmp",
  "plaintext",
  "body",
  "html",
  "head"
]);
const FETCH_ATTRS = new Set(["background", "poster", "lowsrc", "dynsrc", "data", "xlink:href", "ping", "formaction", "action", "srcdoc", "referrerpolicy"]);

function auditOutput(out: string, showRemote: boolean): string[] {
  const problems: string[] = [];
  let i = 0;
  while (i < out.length) {
    const lt = out.indexOf("<", i);
    if (lt === -1) break;
    const rest = out.slice(lt);
    const end = /^<\/([a-z][a-z0-9-]*)>/.exec(rest);
    if (end) {
      if (FORBIDDEN_TAGS.has(end[1])) problems.push(`end tag ${end[1]}`);
      i = lt + end[0].length;
      continue;
    }
    const start = /^<([a-z][a-z0-9-]*)((?:\s[a-z_:][a-z0-9_:.-]*="[^"<>]*")*)>/.exec(rest);
    if (!start) {
      problems.push(`non-canonical "<" at ${lt}: ${JSON.stringify(rest.slice(0, 40))}`);
      i = lt + 1;
      continue;
    }
    const name = start[1];
    if (FORBIDDEN_TAGS.has(name)) problems.push(`tag ${name}`);
    const attrs = [...start[2].matchAll(/\s([a-z_:][a-z0-9_:.-]*)="([^"]*)"/g)].map((m) => ({
      name: m[1],
      value: m[2].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    }));
    if (name.startsWith("dd-blocked-") && attrs.length > 0) problems.push(`attributes on ${name}`);
    for (const a of attrs) {
      if (a.name.startsWith("on")) problems.push(`${name}[${a.name}]`);
      if (FETCH_ATTRS.has(a.name)) problems.push(`${name}[${a.name}]`);
      if (a.name === "src") {
        if (name !== "img") problems.push(`src on ${name}`);
        else if (!/^data:image\//i.test(a.value) && !(showRemote && allowedRemoteImageUrl(a.value) === a.value)) problems.push(`img src ${a.value}`);
      }
      if (a.name === "srcset") {
        if (name !== "img" || !showRemote) problems.push(`srcset on ${name}`);
        for (const c of a.value.split(", ")) if (allowedRemoteImageUrl(c.split(" ")[0]) === null) problems.push(`srcset ${c}`);
      }
      if (a.name === "href") {
        if (name !== "a" && name !== "area") problems.push(`href on ${name}`);
        else if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(a.value)) problems.push(`href ${a.value}`);
      }
      if (a.name === "style" && filterCss(a.value, showRemote ? on() : off()) !== a.value) problems.push(`style not stable: ${a.value}`);
    }
    i = lt + start[0].length;
    if (name === "style") {
      const close = out.indexOf("</style>", i);
      const css = out.slice(i, close === -1 ? out.length : close);
      if (/[<&]/.test(css)) problems.push(`raw < or & in <style>`);
      if (filterCss(css, showRemote ? on() : off()) !== css) problems.push(`<style> not stable`);
      i = close === -1 ? out.length : close;
    }
  }
  return problems;
}

const audited = (html: string) => {
  const a = OFF(html);
  const b = ON(html);
  expect(auditOutput(a, false)).toEqual([]);
  expect(auditOutput(b, true)).toEqual([]);
  return { off: a, on: b };
};

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe("buildEmailSrcdoc: the document", () => {
  it("puts the CSP first in <head>, before anything that could load", () => {
    const { srcdoc } = buildEmailSrcdoc("<p>Hello</p>", { showRemoteImages: false });
    expect(srcdoc.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    const head = srcdoc.slice(0, srcdoc.indexOf("</head>"));
    expect(head.indexOf("Content-Security-Policy")).toBeLessThan(head.indexOf("<style>"));
    expect(head.indexOf("Content-Security-Policy")).toBeLessThan(head.indexOf("<base"));
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
    expect(head).toContain('<base target="_blank">');
    expect(head).not.toMatch(/<base[^>]*href/);
    expect(srcdoc).toContain("<body><p>Hello</p></body></html>");
  });

  it("allows images from data: only by default, and https: only on the kept images' own hosts when he asks", () => {
    const offCsp = emailFrameCsp([]);
    const onCsp = emailFrameCsp(["img.example.net", "cdn.example.com", "cdn.example.com", "cdn.example.com:8443"]);
    for (const csp of [offCsp, onCsp]) {
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain("style-src 'unsafe-inline'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
    }
    expect(offCsp).toContain("img-src data:;");
    expect(offCsp).not.toContain("https:");
    expect(onCsp).toContain("img-src data: https://cdn.example.com https://cdn.example.com:8443 https://img.example.net;");
    // Nothing that could end a source list or a directive is ever written into it.
    expect(emailFrameCsp(["a;script-src *", "b c", "[::1]", "x,y", "ok.example"])).toContain("img-src data: https://ok.example;");

    expect(buildEmailSrcdoc("x", { showRemoteImages: false }).srcdoc).toContain("img-src data:;");
    expect(buildEmailSrcdoc("x", { showRemoteImages: true }).srcdoc).toContain("img-src data:;");
    const html = `<img src="${EXTERNAL}"><img srcset="https://img.example.net/2.png 2x"><p style="background:url(https://bg.example.org/b.png)">p</p><img src="https://operations.scaledai.org/x">`;
    expect(buildEmailSrcdoc(html, { showRemoteImages: false }).srcdoc).toContain("img-src data:;");
    expect(buildEmailSrcdoc(html, { showRemoteImages: true }).srcdoc).toContain(
      "img-src data: https://bg.example.org https://cdn.example.com https://img.example.net;"
    );
  });

  it("names no host whose reference was dropped, so a redirect off the kept hosts is refused", () => {
    // image-set with one disallowed URL goes whole: neither of its hosts is listed.
    const doc = buildEmailSrcdoc(
      `<style>.a{background:image-set("https://ok.example.com/a.png" 1x, "/api/exec/x" 2x)}</style><img src="https://img.example.net/1.png">`,
      { showRemoteImages: true }
    ).srcdoc;
    expect(doc).toContain("img-src data: https://img.example.net;");
    expect(doc).not.toContain("ok.example.com/a.png");
    expect(doc).not.toContain("https://ok.example.com;");
  });

  it("counts the remote images the toggle would load, and none once they are shown", () => {
    const html = `<img src="${EXTERNAL}"><img src="https://img.example.net/a.gif"><div style="background:url(https://img.example.net/bg.png)">x</div><img src="/api/exec/x">`;
    expect(buildEmailSrcdoc(html, { showRemoteImages: false }).remoteImages).toBe(3);
    expect(buildEmailSrcdoc(html, { showRemoteImages: true }).remoteImages).toBe(0);
  });

  it("cuts a body past the ceiling and says so", () => {
    const big = `<p>${"a".repeat(MAX_EMAIL_HTML_CHARS + 10)}</p>`;
    const doc = buildEmailSrcdoc(big, { showRemoteImages: false });
    expect(doc.truncated).toBe(true);
    expect(buildEmailSrcdoc("<p>small</p>", { showRemoteImages: false }).truncated).toBe(false);
  });

  it("treats a non-string body as empty", () => {
    expect(buildEmailSrcdoc(undefined as unknown as string, { showRemoteImages: false }).srcdoc).toContain("<body></body>");
  });
});

// ---------------------------------------------------------------------------
// Neutralization
// ---------------------------------------------------------------------------

describe("sanitizeEmailHtml: elements that load, navigate or run", () => {
  it("renames meta (refresh), link, base, iframe, frame(set), object, embed, applet and form to inert elements with no attributes", () => {
    const { off: out } = audited(
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">' +
        '<link rel="stylesheet" href="https://evil.example/x.css">' +
        '<base href="https://evil.example/">' +
        '<iframe src="https://evil.example/frame">fallback text</iframe>' +
        '<frameset><frame src="https://evil.example/f"></frameset>' +
        '<object data="https://evil.example/o.swf">obj</object>' +
        '<embed src="https://evil.example/e.swf">' +
        '<applet code="x" archive="https://evil.example/a.jar"></applet>' +
        '<form action="https://evil.example/post" method="post"><input name="q"><button formaction="https://evil.example/b">Go</button></form>' +
        '<portal src="https://evil.example/p"></portal>'
    );
    for (const name of ["meta", "link", "base", "iframe", "frameset", "frame", "object", "embed", "applet", "form", "portal"]) {
      expect(out).toContain(`<dd-blocked-${name}>`);
    }
    expect(out).not.toMatch(/http-equiv|refresh|stylesheet|evil\.example/);
    expect(out).toContain("fallback text");
    // Form controls go too (they could never submit); their text stays.
    expect(out).toContain("<dd-blocked-form>Go</dd-blocked-form>");
    expect(out).not.toMatch(/<input|<button/);
  });

  it("drops script, title, noembed and noframes with everything inside them", () => {
    const { off: out } = audited(
      "<script>alert(1)</script><SCRIPT type=module>import x</SCRIPT ><title>Secret title</title><noembed><img src=x onerror=a()></noembed><noframes>nf</noframes><p>kept</p>"
    );
    expect(out).toBe("<p>kept</p>");
  });

  it("drops a raw-text element without an end tag to the end, as the browser would", () => {
    expect(OFF("<p>a</p><script>never closed <p>b</p>")).toBe("<p>a</p>");
  });

  it("strips every on* attribute, whatever its spelling or spacing", () => {
    const { off: out } = audited(
      '<p onclick="x()" ONMOUSEOVER=y() OnLoad = \'z\'>t</p><img src=x onerror=alert(1)><svg onload="a()"></svg><a href="https://good.example/"onfocus="b()">l</a><body onload="c()">'
    );
    expect(out).not.toMatch(/\son[a-z]*=/i);
    expect(out).toContain('<a href="https://good.example/" target="_blank" rel="noopener noreferrer">l</a>');
  });

  it("keeps real links only, each opening a new tab with no opener or referrer", () => {
    const { off: out } = audited(
      [
        '<a href="javascript:alert(1)">js</a>',
        '<a href="JaVaScRiPt:alert(1)">js2</a>',
        '<a href="java&#x09;script:alert(1)">js3</a>',
        '<a href="&#106;avascript:alert(1)">js4</a>',
        '<a href=" javascript:alert(1)">js5</a>',
        '<a href="data:text/html,<script>alert(1)</script>">data</a>',
        '<a href="vbscript:x">vb</a>',
        '<a href="/settings">relative</a>',
        '<a href="//evil.example/x">protocol-relative</a>',
        '<a href="https:evil.example">relative to the page</a>',
        '<a href="https://good.example/a?b=1&amp;c=2" target="_self" rel="opener" ping="https://evil.example/ping" referrerpolicy="unsafe-url">good</a>',
        '<a href="mailto:jane@acme.com">mail</a>',
        '<a href="tel:+15550100">call</a>',
        '<area href="https://good.example/map">'
      ].join("")
    );
    expect(out).not.toMatch(/javascript|vbscript|data:text|\/settings|evil\.example/i);
    expect(out).toContain('<a href="https://good.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">good</a>');
    expect(out).toContain('<a href="mailto:jane@acme.com" target="_blank" rel="noopener noreferrer">mail</a>');
    expect(out).toContain('<a href="tel:+15550100" target="_blank" rel="noopener noreferrer">call</a>');
    expect(out).toContain('<area href="https://good.example/map" target="_blank" rel="noopener noreferrer">');
    expect(out).toContain("<a>js</a>");
  });

  it("removes href from everything but links, and SVG animation that could rewrite one", () => {
    const { off: out } = audited(
      '<math href="javascript:alert(1)"><mi>x</mi></math><svg><a xlink:href="javascript:alert(1)"><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(2)"/><text>t</text></a></svg>'
    );
    expect(out).not.toMatch(/javascript|animate|<set/i);
    expect(out).toContain("<math><mi>x</mi></math>");
  });

  it("drops behaviour switches: autofocus, popovers, declarative shadow roots", () => {
    const { off: out } = audited('<input autofocus><div popover id="p">x</div><template shadowrootmode="open"><p>s</p></template>');
    expect(out).toBe('<div id="p">x</div><template><p>s</p></template>');
  });

  it("turns his email's <body> into a block, keeping a plain background colour", () => {
    expect(OFF('<html><head><style>p{color:red}</style></head><body bgcolor="#f4f4f4" style="margin:0" background="https://evil.example/bg.png"><p>x</p></body></html>')).toBe(
      '<style>p{color:red}</style><div style="background-color:#f4f4f4;margin:0" class="dd-email-body"><p>x</p></div>'
    );
    expect(OFF('<body bgcolor="url(https://evil.example)">y</body>')).toBe('<div class="dd-email-body">y</div>');
  });
});

describe("sanitizeEmailHtml: inline (cid:) images", () => {
  it("replaces them with a text placeholder, alt text included and escaped", () => {
    const ctx = off();
    const out = sanitizeEmailHtml('<img src="cid:logo@01" alt="Acme <logo>"><img src="CID:sig"><img src=" cid:x">', ctx);
    expect(out).toBe(
      '<span class="dd-inline-image">[Inline image: Acme &lt;logo&gt;]</span><span class="dd-inline-image">[Inline image]</span><span class="dd-inline-image">[Inline image]</span>'
    );
    expect(ctx.inline).toBe(3);
    expect(ctx.remote).toBe(0);
    expect(buildEmailSrcdoc('<img src="cid:a">', { showRemoteImages: true }).inlineImages).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The image allow-list
// ---------------------------------------------------------------------------

describe("the image allow-list (A7, coherence-22)", () => {
  it("allows only absolute https: URLs off DD's site", () => {
    expect(allowedRemoteImageUrl(EXTERNAL)).toBe(EXTERNAL);
    expect(allowedRemoteImageUrl("HTTPS://CDN.Example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(allowedRemoteImageUrl("  https://cdn.example.com/a b.png\n")).toBe("https://cdn.example.com/a%20b.png");
    expect(allowedRemoteImageUrl("https:\\\\cdn.example.com\\x.png")).toBe("https://cdn.example.com/x.png");
    const refused = [
      "http://cdn.example.com/a.png",
      "//cdn.example.com/a.png",
      "/api/exec/email/threads/t1/assess",
      "api/x",
      "?q=1",
      "#frag",
      "https:cdn.example.com/a.png",
      "https:/cdn.example.com/a.png",
      "https://operations.scaledai.org/api/exec/x",
      "https://OPERATIONS.SCALEDAI.ORG./x",
      "https://delegationdoer-production.up.railway.app/x",
      "https://dd.example.org/x",
      "https://scaledai.org/logo.png",
      "https://crm.scaledai.org/api/delete?id=1",
      "https://user:pw@cdn.example.com/a.png",
      "https://[::1]/x",
      "data:image/png;base64,AAAA",
      "cid:x",
      "javascript:alert(1)",
      ""
    ];
    for (const url of refused) expect(allowedRemoteImageUrl(url), url).toBeNull();
  });

  it("allows links over http(s), mailto and tel, never relative or script", () => {
    expect(allowedLinkUrl("https://good.example/x")).toBe("https://good.example/x");
    expect(allowedLinkUrl("http://good.example")).toBe("http://good.example/");
    expect(allowedLinkUrl("https://operations.scaledai.org/tasks/1")).toBe("https://operations.scaledai.org/tasks/1");
    for (const url of ["/tasks/1", "//evil.example", "https:evil.example", "javascript:alert(1)", "java\nscript:x", "data:text/html,x", "ftp://x"]) {
      expect(allowedLinkUrl(url), url).toBeNull();
    }
  });

  it("img src/srcset: nothing remote by default; allowed URLs only, canonical, when shown", () => {
    const html =
      `<img src="${EXTERNAL}" alt="a" width="10">` +
      '<img src="https://operations.scaledai.org/api/exec/x">' +
      '<img src="/api/exec/email/x">' +
      '<img src="//evil.example/p.gif">' +
      '<img src="https:evil.example/rel.png">' +
      '<img src="&#x68;ttps://cdn.example.com/enc.png">' +
      '<img src="https://operations&period;scaledai&period;org/x">' +
      '<img srcset="https://cdn.example.com/1x.png 1x, /api/x 2x, https://operations.scaledai.org/3.png 3x, https://cdn.example.com/w.png 640w">' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' +
      '<IMAGE SRC="https://cdn.example.com/legacy.png">';
    const ctx = off();
    const offOut = sanitizeEmailHtml(html, ctx);
    expect(auditOutput(offOut, false)).toEqual([]);
    expect(offOut).not.toMatch(/cdn\.example|scaledai|evil|\/api\//);
    expect(offOut).toContain('<img alt="a" width="10">');
    expect(offOut).toContain('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">');
    // EXTERNAL, enc.png, the srcset (two allowed candidates) and <image>: four images withheld.
    expect(ctx.remote).toBe(4);

    const onOut = ON(html);
    expect(auditOutput(onOut, true)).toEqual([]);
    expect(onOut).toContain(`<img alt="a" width="10" src="${EXTERNAL}">`);
    expect(onOut).toContain('<img src="https://cdn.example.com/enc.png">');
    expect(onOut).toContain('<img srcset="https://cdn.example.com/1x.png 1x, https://cdn.example.com/w.png 640w">');
    expect(onOut).toContain('<img src="https://cdn.example.com/legacy.png">');
    expect(onOut).not.toMatch(/scaledai|evil|\/api\//);
  });

  it("removes background=, poster, lowsrc and dynsrc always, shown or not", () => {
    const html =
      `<table background="${EXTERNAL}"><tr><td background="https://operations.scaledai.org/x">c</td></tr></table>` +
      `<video poster="${EXTERNAL}" src="${EXTERNAL}"></video><img lowsrc="${EXTERNAL}" dynsrc="${EXTERNAL}">`;
    const { off: o, on: n } = audited(html);
    for (const out of [o, n]) expect(out).not.toMatch(/background=|poster=|lowsrc|dynsrc|cdn\.example|scaledai|<video|<audio/);
  });

  it("drops video and audio players, keeping their fallback text", () => {
    expect(OFF(`<video controls src="${EXTERNAL}"><source src="${EXTERNAL}">Your client can't play this.</video><audio src="x">No audio.</audio>`)).toBe(
      "Your client can't play this.No audio."
    );
  });

  it("removes input[type=image], SVG image/feImage/use and picture > source", () => {
    const html =
      `<input type="image" src="${EXTERNAL}"><input TYPE=" Image " src="https://operations.scaledai.org/x">` +
      '<svg><image href="https://operations.scaledai.org/s.png"/><use href="https://evil.example/u.svg#a"/>' +
      '<filter><feImage href="https://operations.scaledai.org/f.png"/></filter></svg>' +
      `<picture><source srcset="https://operations.scaledai.org/p.png"><source srcset="${EXTERNAL}"><img src="${EXTERNAL}"></picture>`;
    const { off: o, on: n } = audited(html);
    for (const out of [o, n]) {
      expect(out).not.toMatch(/<input|<use|feimage|<source|scaledai|evil/i);
    }
    expect(n).toContain(`<picture><img src="${EXTERNAL}"></picture>`);
    // SVG <image> is the HTML parser's <img>: kept as one, with no SVG href.
    expect(o).toContain("<svg><img>");
  });

  it("filters url() in style attributes, both ways", () => {
    const html =
      `<div style="background:url(${EXTERNAL}) no-repeat;color:red">a</div>` +
      '<div style="background-image:url(\'https://operations.scaledai.org/x.png\')">b</div>' +
      '<div style="background:url(/api/exec/x)">c</div>' +
      '<div style="background:url(data:image/png;base64,AA==)">d</div>' +
      '<div style="list-style-image:URL(https://operations.scaledai.org/l.png);cursor:url(https://cdn.example.com/c.cur),auto">e</div>';
    const { off: o, on: n } = audited(html);
    expect(o).toContain('<div style="background:none no-repeat;color:red">a</div>');
    expect(n).toContain(`<div style="background:url(${EXTERNAL}) no-repeat;color:red">a</div>`);
    for (const out of [o, n]) {
      expect(out).toContain('<div style="background-image:none">b</div>');
      expect(out).toContain('<div style="background:none">c</div>');
      expect(out).toContain('<div style="background:url(data:image/png;base64,AA==)">d</div>');
      expect(out).not.toContain("scaledai");
    }
    expect(n).toContain("cursor:url(https://cdn.example.com/c.cur),auto");
  });

  it("filters SVG presentation attributes that take a url()", () => {
    const { on: n } = audited('<svg><rect fill="url(https://operations.scaledai.org/p.svg#g)" filter="url(/api/f.svg#x)" stroke="red"/></svg>');
    expect(n).toContain('<rect fill="none" filter="none" stroke="red">');
  });

  it("filters <style>: url(), image-set(), @import and escapes", () => {
    const css = [
      "@import url(https://evil.example/a.css);",
      '@import "https://evil.example/b.css" screen;',
      "@IMPORT url(x.css);",
      "@\\69mport url(y.css);",
      `.a{background:url("${EXTERNAL}")}`,
      ".b{background:url(https://operations.scaledai.org/b.png)}",
      ".c{background:u\\72l(https://operations.scaledai.org/c.png)}",
      ".d{background:\\75\\72\\6c (https://operations.scaledai.org/d.png)}",
      '.e{background:image-set("https://operations.scaledai.org/e.png" 1x)}',
      `.f{background:-webkit-image-set(url(${EXTERNAL}) 1x)}`,
      ".g{background:image-set(var(--x) 1x)}",
      ".h{background:attr(data-src type(<url>))}",
      ".i{--x:url(https://operations.scaledai.org/i.png)}",
      `.j{background:url('${EXTERNAL}')}`,
      '@font-face{font-family:x;src:url(https://evil.example/f.woff2) format("woff2"),local("Arial")}',
      ".k{background:url(https://evil.example/k b.png)}"
    ].join("\n");
    const { off: o, on: n } = audited(`<style>${css}</style><p>x</p>`);
    expect(n).not.toMatch(/scaledai|@import|import url|mport/i);
    expect(n).toContain(`.a{background:url("${EXTERNAL}")}`);
    expect(n).toContain(`.f{background:-webkit-image-set(url(${EXTERNAL}) 1x)}`);
    expect(n).toContain(`.j{background:url('${EXTERNAL}')}`);
    expect(n).toContain(".g{background:none}");
    expect(n).toContain(".h{background:none}");
    expect(n).toContain(".i{--x:none}");
    // An external font is "absolute https off DD", so the allow-list keeps it
    // once images are shown; the CSP's font-src data: still never loads it.
    expect(n).toContain('src:url(https://evil.example/f.woff2) format("woff2"),local("Arial")');
    expect(o).toContain('src:none format("woff2"),local("Arial")');
    expect(n).toContain(".k{background:none}");
    expect(o).not.toMatch(/cdn\.example|evil|scaledai/);
  });

  it("never lets a style element's text close it or open a tag, in HTML or in SVG", () => {
    const { off: out } = audited('<style>p{color:red}</style ><svg><style>a{} <img src=x onerror=alert(1)> &amp; b{}</style></svg><p>after</p>');
    expect(out).toContain("<style>p{color:red}</style>");
    expect(out).toContain("<style>a{} \\3C img src=x onerror=alert(1)> \\26 amp; b{}</style>");
    expect(out).toContain("<p>after</p>");
  });
});

// ---------------------------------------------------------------------------
// Tokenizer edge cases: the output is what was checked
// ---------------------------------------------------------------------------

describe("sanitizeEmailHtml: parser differentials", () => {
  it("ends comments where the browser does, and drops them", () => {
    expect(OFF("<!--><img src=x onerror=alert(1)>-->t")).toBe("<img>--&gt;t".replace("&gt;", ">"));
    expect(OFF("<!---><img src=x onerror=alert(1)>")).toBe("<img>");
    expect(OFF("<!-- a --!><b>x</b>")).toBe("<b>x</b>");
    expect(OFF("<!-- never closed <img src=x onerror=a()>")).toBe("");
    expect(OFF("<!DOCTYPE html><![CDATA[x>y<img src=x onerror=a()>]]><?php x ?>z")).toBe("y<img>]]>z");
  });

  it("re-encodes attribute values so a quote can't open a new attribute", () => {
    const { off: out } = audited(`<p title='a"onmouseover="alert(1)' class=x\`y>t</p><p title="&lt;/p&gt;&lt;img src=x onerror=a()&gt;">u</p>`);
    expect(out).toBe('<p title="a&quot;onmouseover=&quot;alert(1)" class="x`y">t</p><p title="&lt;/p&gt;&lt;img src=x onerror=a()&gt;">u</p>');
  });

  it("keeps the first of repeated attributes, as the browser does", () => {
    expect(ON(`<a href="https://good.example/" href="javascript:alert(1)">x</a>`)).toBe(
      '<a href="https://good.example/" target="_blank" rel="noopener noreferrer">x</a>'
    );
    expect(ON(`<img src="${EXTERNAL}" src="https://operations.scaledai.org/x">`)).toBe(`<img src="${EXTERNAL}">`);
    expect(ON(`<img src="https://operations.scaledai.org/x" src="${EXTERNAL}">`)).toBe("<img>");
  });

  it("drops a tag cut off by the end of the input, and everything after an unclosed quote", () => {
    expect(OFF('<p>hi</p><img src="https://evil.example/a.png')).toBe("<p>hi</p>");
    expect(OFF("<p>hi<img src=x")).toBe("<p>hi");
    expect(OFF("<p title='open>still in the value</p>")).toBe("");
  });

  it("escapes a stray < in text and keeps entities as written", () => {
    expect(OFF("a < b &amp; c &lt;script&gt; </ x> <3 </>")).toBe("a &lt; b &amp; c &lt;script&gt;  &lt;3 ");
    expect(OFF("x</")).toBe("x&lt;/");
  });

  it("handles mixed-case and odd tag names", () => {
    expect(OFF('<ScRiPt>a()</sCrIpT><DIV CLASS="Big">x</DIV><a<b>y</a<b><x-y>z</x-y>')).toBe('<div class="Big">x</div>y<x-y>z</x-y>');
  });

  it("keeps foreign content and noscript as markup, sanitized like the rest", () => {
    const { off: out } = audited(
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math><noscript><p title="</noscript><img src=x onerror=alert(1)>">n</p></noscript><xmp><img src=x onerror=alert(1)></xmp>'
    );
    expect(out).not.toMatch(/<img[^>]*onerror/);
    expect(out).toContain("<dd-blocked-xmp><img></dd-blocked-xmp>");
  });

  it("drops NUL characters", () => {
    expect(OFF("<p>a\u0000b</p><scr\u0000ipt>x</script>")).toContain("<p>a");
    expect(buildEmailSrcdoc("<p>a\u0000b</p>", { showRemoteImages: false }).srcdoc).toContain("<p>ab</p>");
  });
});

describe("filterCss", () => {
  it("escapes < and & so the CSS reads the same as raw text and as markup text", () => {
    expect(filterCss("a<b{x:1} & c")).toBe("a\\3C b{x:1} \\26  c");
    expect(filterCss('p{content:"<b>&"}')).toBe('p{content:"\\3C b>\\26 "}');
  });

  it("replaces CDO/CDC with empty comments", () => {
    expect(filterCss("<!-- p{color:red} -->")).toBe("/**/ p{color:red} /**/");
  });

  it("doesn't take a comment between letters for url(", () => {
    expect(filterCss("a{b:u/**/rl(https://operations.scaledai.org/x)}")).toBe("a{b:u/**/rl(https://operations.scaledai.org/x)}");
  });

  it("doesn't take a dimension or a hash for url(", () => {
    expect(filterCss("a{b:5url(x) #url(y)}")).toBe("a{b:5url(x) #url(y)}");
  });

  it("counts withheld remote images", () => {
    const ctx = off();
    filterCss(`a{background:url(${EXTERNAL})} b{background:image-set("${EXTERNAL}" 1x, "https://img.example.net/2.png" 2x)} c{background:url(/rel)}`, ctx);
    expect(ctx.remote).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Bounded work and a seeded fuzz
// ---------------------------------------------------------------------------

describe("bounded work on hostile input", () => {
  const cases: [string, string][] = [
    ["an unclosed comment", `<!--${"-".repeat(300_000)}`],
    ["many comments", "<!-- a -->".repeat(60_000)],
    ["many short scripts", "<script>x</script>".repeat(40_000)],
    ["many unclosed styles", "<style>".repeat(40_000)],
    ["a long run of spaces in a URL", `<img src="${" ".repeat(400_000)}x">`],
    ["many attributes", `<p ${"a=1 ".repeat(150_000)}>`],
    ["many character references", `<p title="${"&#x41;&colon;&zz".repeat(60_000)}">`],
    ["a long CSS escape run", `<p style="${"\\75 ".repeat(150_000)}rl(x)">`],
    ["deep CSS nesting", `<style>a{b:image-set(${"(".repeat(100_000)}</style>`],
    ["a long srcset", `<img srcset="${"https://cdn.example.com/a.png 1x, ".repeat(30_000)}">`]
  ];
  for (const [what, html] of cases) {
    it(`finishes quickly: ${what}`, () => {
      const t0 = Date.now();
      buildEmailSrcdoc(html, { showRemoteImages: true });
      buildEmailSrcdoc(html, { showRemoteImages: false });
      expect(Date.now() - t0).toBeLessThan(5_000);
    });
  }
});

describe("seeded fuzz: every output is canonical and passes the audit", () => {
  const PIECES = [
    "<", ">", "/", "!", "-", "--", "=", '"', "'", " ", "\n", "&", "#", ";", "`",
    "img", "image", "src", "srcset", "href", "a", "on", "error", "load", "style", "svg", "math", "script", "iframe",
    "meta", "base", "link", "form", "style", "template", "noscript", "xmp", "textarea", "title", "source", "picture",
    "url(", ")", "image-set(", "\\75 rl(", "@import ", "background", "poster", "javascript:", "data:image/png,", "cid:x",
    "https://operations.scaledai.org/x", "https://cdn.example.com/y.png", "//evil.example/z", "/api/exec/q", "https:evil.example",
    "&#x3c;", "&lt;", "&colon;", "&sol;", "<!--", "-->", "<![CDATA[", "]]>", "</", "x", "p", "div", "b"
  ];
  // mulberry32: a small deterministic PRNG, so a failure reproduces.
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it("2,000 random documents", () => {
    const next = rng(0x5eed);
    for (let n = 0; n < 2_000; n += 1) {
      let html = "";
      const len = 5 + Math.floor(next() * 60);
      for (let k = 0; k < len; k += 1) html += PIECES[Math.floor(next() * PIECES.length)];
      const a = OFF(html);
      const b = ON(html);
      const problems = [...auditOutput(a, false), ...auditOutput(b, true)];
      if (problems.length > 0) throw new Error(`input ${JSON.stringify(html)} → ${problems.join("; ")}`);
    }
  });
});
