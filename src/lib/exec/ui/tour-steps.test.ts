import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// If a tour hook ever ran during a static render, this would say so instead of silently passing.
vi.mock("next/navigation", () => {
  const ran = (name: string) => () => {
    throw new Error(`${name} ran during a static render`);
  };
  return { useRouter: ran("useRouter"), usePathname: ran("usePathname"), useSearchParams: ran("useSearchParams") };
});

import { EXEC_TABS, SETTINGS_HREF } from "@/components/exec/ExecTabs";
import { ExecTour, TourReplayButton } from "@/components/exec/tour/ExecTour";
import { TOUR_CHAT_PATH, TOUR_DONE_KEY, TOUR_HOME, TOUR_STEPS, tourHref } from "@/components/exec/tour/steps";
import { ASK_PREFILL_MAX, askPrefillFrom, chatAskHref } from "@/lib/exec/chat/ask-prefill";

// The guided tour's steps against the app they describe (modelled on Scaled Sync's tests/tourSteps.test.ts). A tour is
// the kind of feature whose breakage is invisible in review: the anchors live in files nobody touches while editing the
// tour, and a step whose anchor is gone doesn't fail, it just isn't there. So each step is followed to its route's page
// and through the components that page imports, and its anchor has to be rendered there.

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const EXEC_APP = path.join(SRC, "app", "(main)", "executive");
const EXEC_KIT = path.join(SRC, "components", "exec");
const TOUR_DIR = path.join(EXEC_KIT, "tour");
const read = (abs: string) => readFileSync(abs, "utf8");
const nameOf = (target: string) => target.replace(/^\[data-tour="|"\]$/g, "");

/** The data-tour values a source file renders: the attribute itself, or SectionCard's dataTour prop. */
function anchorsIn(source: string): string[] {
  return [...source.matchAll(/(?:data-tour|dataTour)=(?:"([\w-]+)"|\{"([\w-]+)"\})/g)].map((m) => m[1] ?? m[2]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

/** A route's page file: "/executive/email" -> src/app/(main)/executive/email/page.tsx. */
function pageFile(route: string): string {
  const rest = route.replace(/^\/executive\/?/, "");
  return path.join(EXEC_APP, ...rest.split("/").filter(Boolean), "page.tsx");
}

/** Resolve an import specifier to a file under src, or null (a package, or a file outside src). */
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The page and every component file it reaches through imports (src/components and src/app only: the anchors' home). */
function renderClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g)) {
      if (/^import\s+type\b/.test(m[0])) continue;
      const target = resolveImport(file, m[1]);
      if (target && (target.startsWith(path.join(SRC, "components")) || target.startsWith(path.join(SRC, "app")))) queue.push(target);
    }
  }
  return seen;
}

describe("guided tour steps", () => {
  it("is one short pass: 8 to 12 steps", () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(8);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(12);
  });

  it("targets only [data-tour] attributes, never a class", () => {
    for (const s of TOUR_STEPS) expect(s.target, s.title).toMatch(/^\[data-tour="[\w-]+"\]$/);
  });

  it("every step's route is a real exec page: a tab or Settings, with a page.tsx", () => {
    const routes = new Set([...EXEC_TABS.map((t) => t.href), SETTINGS_HREF]);
    for (const s of TOUR_STEPS) {
      expect(routes.has(s.path), `${s.title}: ${s.path} is not an exec tab`).toBe(true);
      expect(existsSync(pageFile(s.path)), `${s.title}: no page for ${s.path}`).toBe(true);
    }
  });

  it("every step's anchor is rendered by its route's page or a component that page imports", () => {
    const missing: string[] = [];
    for (const s of TOUR_STEPS) {
      const closure = renderClosure(pageFile(s.path));
      const rendered = [...closure].some((file) => anchorsIn(read(file)).includes(nameOf(s.target)));
      if (!rendered) missing.push(`${nameOf(s.target)} (step "${s.title}", ${s.path})`);
    }
    expect(missing, "these anchors aren't rendered on their step's page: the step would be skipped every time").toEqual([]);
  });

  it("every step's page renders the header, which is where the tour itself is mounted", () => {
    const header = path.join(EXEC_KIT, "ExecHeader.tsx");
    for (const route of new Set(TOUR_STEPS.map((s) => s.path))) {
      expect(renderClosure(pageFile(route)).has(header), `${route} doesn't render ExecHeader`).toBe(true);
    }
  });

  it("no exec anchor is left without a step (write the step or remove the attribute)", () => {
    const files = [...walk(EXEC_KIT), ...walk(EXEC_APP)].filter((f) => !f.startsWith(TOUR_DIR));
    const rendered = new Set(files.flatMap((f) => anchorsIn(read(f))));
    const targeted = new Set(TOUR_STEPS.map((s) => nameOf(s.target)));
    expect([...rendered].filter((a) => !targeted.has(a))).toEqual([]);
    // And every target is unique: two steps on one anchor would show the same thing twice.
    expect(targeted.size).toBe(TOUR_STEPS.length);
  });

  it("goes through the pages in tab order, Settings last, and never doubles back", () => {
    const order = [...EXEC_TABS.map((t) => t.href), SETTINGS_HREF];
    const positions = TOUR_STEPS.map((s) => order.indexOf(s.path));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].path).toBe(SETTINGS_HREF);
  });

  it("starts on the Overview, the one page it starts itself on", () => {
    expect(TOUR_HOME).toBe("/executive");
    expect(TOUR_STEPS[0].path).toBe(TOUR_HOME);
    expect(tourHref(TOUR_HOME, 0)).toBe("/executive?tour=1&step=0");
  });

  it("covers what it was asked to: header, brief, tiles, the feed, Email, Slack, Team, Projects, Chat, Settings and Slack connect", () => {
    expect(TOUR_STEPS.map((s) => nameOf(s.target))).toEqual([
      "exec-header",
      "exec-brief",
      "exec-stats",
      "exec-attention",
      "exec-email",
      "exec-slack",
      "exec-team",
      "exec-projects",
      "exec-chat",
      "exec-settings",
      "exec-brief-settings",
      "exec-slack-settings"
    ]);
  });

  it("marks optional exactly the steps whose anchor needs a feature switched on", () => {
    // Email (on, with a mailbox pinned), the Slack catch-up (intel "ok"), the chat (installed and on), the Morning brief
    // card (its migration applied). Every other anchor renders in every state of its page, failed reads included.
    expect(TOUR_STEPS.filter((s) => s.optional).map((s) => nameOf(s.target))).toEqual(["exec-email", "exec-slack", "exec-chat", "exec-brief-settings"]);
  });

  it("every step has a title, a short body and an ask", () => {
    for (const s of TOUR_STEPS) {
      expect(s.title.trim().length, s.path).toBeGreaterThan(0);
      expect(s.title.length, s.title).toBeLessThanOrEqual(32);
      expect(s.body.trim().length, s.title).toBeGreaterThan(0);
      expect(s.ask.trim().length, s.title).toBeGreaterThan(0);
      // One or two short sentences: anything longer belongs in the ask, where it can get a follow-up.
      expect(s.body.length, `${s.title}: ${s.body.length} chars`).toBeLessThanOrEqual(200);
      const sentences = s.body.split(/[.!?]+(?:\s|$)/).filter((p) => p.trim().length > 0);
      expect(sentences.length, `${s.title}: ${sentences.length} sentences`).toBeLessThanOrEqual(2);
    }
  });

  it("never claims anything is sent or done on its own, and says sending is confirmed where it comes up", () => {
    for (const s of TOUR_STEPS) {
      expect(s.body, s.title).not.toMatch(/automatic|auto-?send|on its own|sends? (?:it |them )?for you|we(?:'ll| will) send/i);
    }
    const body = (name: string) => TOUR_STEPS.find((s) => nameOf(s.target) === name)!.body;
    expect(body("exec-email")).toMatch(/Save to Outlook/);
    expect(body("exec-email")).toMatch(/sending is a separate step you confirm/);
    expect(body("exec-chat")).toMatch(/only when you press Confirm/);
  });

  it("every ask survives the composer prefill unchanged and fits its cap", () => {
    for (const s of TOUR_STEPS) {
      expect(s.ask.length, s.title).toBeLessThanOrEqual(ASK_PREFILL_MAX);
      expect(askPrefillFrom(s.ask), s.title).toBe(s.ask);
      const href = chatAskHref(TOUR_CHAT_PATH, s.ask);
      expect(href.startsWith("/executive/chat?ask=")).toBe(true);
      expect(new URLSearchParams(href.slice(href.indexOf("?"))).get("ask")).toBe(s.ask);
    }
  });
});

describe("where the tour is mounted, and what the server sees", () => {
  it("ExecHeader mounts it, nothing else does, and the segment layout never mentions it", () => {
    const header = read(path.join(EXEC_KIT, "ExecHeader.tsx"));
    expect(header).toContain('import { ExecTour } from "./tour/ExecTour";');
    expect(header.match(/<ExecTour\b/g)).toHaveLength(1);
    const mounts = walk(SRC).filter((f) => /<ExecTour\b/.test(read(f)));
    expect(mounts.map((f) => path.relative(SRC, f).split(path.sep).join("/"))).toEqual(["components/exec/ExecHeader.tsx"]);
    expect(read(path.join(EXEC_APP, "layout.tsx"))).not.toMatch(/tour/i);
  });

  it("renders nothing on the server or in a static render: no control in the HTML, no router hook run", () => {
    expect(renderToStaticMarkup(createElement(ExecTour))).toBe("");
    expect(renderToStaticMarkup(createElement(TourReplayButton))).toBe("");
  });

  it("portals a labelled modal dialog to <body>, above the top bar, with motion that honours reduced motion", () => {
    const src = read(path.join(TOUR_DIR, "ExecTour.tsx"));
    expect(src).toMatch(/createPortal\(/);
    expect(src).toMatch(/document\.body\s*\)/);
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toMatch(/aria-label=\{`Guided tour, step/);
    expect(src).toContain("z-[1000]");
    expect(src).toContain("motion-reduce:transition-none");
    expect(src).toMatch(/behavior: reducedMotion\(\) \? "auto" : "smooth"/);
    // Esc, Left and Right.
    for (const key of ['"Escape"', '"ArrowRight"', '"ArrowLeft"']) expect(src).toContain(key);
  });

  it("keeps state in the URL and rewrites it with a null state (Next syncs its router only then)", () => {
    const src = read(path.join(TOUR_DIR, "ExecTour.tsx"));
    expect(src).toContain('params?.get("tour") === "1"');
    expect(src).toContain('params?.get("step")');
    expect(src).not.toMatch(/(?:replace|push)State\(\s*window\.history\.state/);
    expect(src).toMatch(/window\.history\.replaceState\(null, "", href\)/);
  });

  it("remembers per browser, inside try/catch, and every exit path goes through close(), which records it", () => {
    const src = read(path.join(TOUR_DIR, "ExecTour.tsx"));
    expect(TOUR_DONE_KEY).toMatch(/^dd\./);
    expect(src).toMatch(/try \{\s*return window\.localStorage\.getItem\(TOUR_DONE_KEY\) !== null;\s*\} catch \{\s*return true;/);
    expect(src).toMatch(/try \{\s*window\.localStorage\.setItem\(TOUR_DONE_KEY,/);
    expect(src.match(/localStorage\./g)).toHaveLength(2);
    // close() records it before anything else.
    expect(src).toMatch(/const close = useCallback\(\s*\(ask\?: string\) => \{\s*markSeen\(\);/);
    // Esc, Skip, Finish (button and Right on the last step), Ask, and falling past the last step.
    expect(src).toMatch(/e\.key === "Escape"\) \{\s*e\.preventDefault\(\);\s*close\(\);/);
    expect(src).toMatch(/data-tour-skip onClick=\{\(\) => close\(\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => \(last \? close\(\) : goto\(index \+ 1\)\)\}/);
    expect(src).toMatch(/if \(last\) close\(\);\s*else goto\(index \+ 1\);/);
    expect(src).toMatch(/onClick=\{\(\) => close\(step\.ask\)\}/);
    expect(src).toMatch(/else if \(index < steps\.length - 1\) goto\(index \+ 1\);\s*else close\(\);/);
    // Starting itself happens only on the Overview, and records it at once.
    expect(src).toMatch(/if \(sessionLatch \|\| pathname !== home \|\| steps\.length === 0\) return;/);
  });

  it("hands Ask to the chat page as ?ask=, and nothing in the tour sends anything", () => {
    const src = read(path.join(TOUR_DIR, "ExecTour.tsx"));
    expect(src).toMatch(/router\.push\(chatAskHref\(chatPath, ask\)\)/);
    expect(src).not.toMatch(/\bfetch\(|postChatTurn|\/api\/exec/);
  });
});
