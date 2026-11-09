import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The /executive segment files that render before any page gate runs, and
// the source rules for the exec kit.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import ChatLoading from "@/app/(main)/executive/chat/loading";
import EmailLoading from "@/app/(main)/executive/email/loading";
import SegmentError from "@/app/(main)/executive/error";
import OwnerSegmentLayout, * as layoutModule from "@/app/(main)/executive/layout";
import Loading from "@/app/(main)/executive/loading";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const SEGMENT = path.join(SRC, "app", "(main)", "executive");
const source = (file: string) => readFileSync(path.join(SEGMENT, file), "utf8");
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, "");

// A teammate who opens /executive sees these before the page's gate answers
// with a 404, so none of them may name the feature: not in what they render,
// and not in their source (comments and imports included), which is what
// gets shipped.
const FEATURE_WORDS = /exec|executive|assistant/i;

beforeEach(() => {
  refresh.mockReset();
});

describe("segment files that render before the gate", () => {
  for (const file of ["layout.tsx", "loading.tsx", "error.tsx", "email/loading.tsx", "chat/loading.tsx"]) {
    it(`${file} never names the feature in its source`, () => {
      expect(source(file)).not.toMatch(FEATURE_WORDS);
    });
  }

  it("layout is force-dynamic and a plain wrapper: no data, no awaits", () => {
    expect(layoutModule.dynamic).toBe("force-dynamic");
    const src = source("layout.tsx");
    expect(src).not.toMatch(/\bawait\b|\basync\b/);
    expect(src).not.toMatch(/from "@\/lib\//);
    const out = renderToStaticMarkup(createElement(OwnerSegmentLayout, null, createElement("p", null, "PAGE")));
    expect(out).toMatch(/^<div[^>]*><p>PAGE<\/p><\/div>$/);
    expect(out).not.toMatch(FEATURE_WORDS);
  });

  it("loading is shapes only: no text at all", () => {
    const out = renderToStaticMarkup(createElement(Loading));
    expect(textOf(out).trim()).toBe("");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("dd-skeleton");
    expect(out).not.toMatch(FEATURE_WORDS);
  });

  it("the email list's loading is shapes only too (P3)", () => {
    const out = renderToStaticMarkup(createElement(EmailLoading));
    expect(textOf(out).trim()).toBe("");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("dd-skeleton");
    expect(out).not.toMatch(FEATURE_WORDS);
    // It is only the shapes: no data, no awaits, no imports from the app.
    const src = source("email/loading.tsx");
    expect(src).not.toMatch(/\bawait\b|\basync\b|^import /m);
  });

  it("the chat page's loading is shapes only too (P5b test 99)", () => {
    const out = renderToStaticMarkup(createElement(ChatLoading));
    expect(textOf(out).trim()).toBe("");
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("dd-skeleton");
    expect(out).not.toMatch(FEATURE_WORDS);
    const src = source("chat/loading.tsx");
    expect(src).not.toMatch(/\bawait\b|\basync\b|^import /m);
  });

  it("error is a client component with generic copy that never shows error.message", () => {
    expect(source("error.tsx").trimStart().startsWith('"use client";')).toBe(true);
    const error = Object.assign(new Error("exec: temporarily unavailable (secret detail)"), { digest: "1234567890" });
    const out = renderToStaticMarkup(createElement(SegmentError, { error, reset: () => {} }));
    const text = textOf(out);
    expect(text).toContain("This page couldn");
    expect(text).toContain("Try again");
    expect(text).toContain("Reference 1234567890");
    expect(text).not.toContain("secret detail");
    expect(out).not.toMatch(FEATURE_WORDS);
    expect(out).toContain('role="alert"');
  });

  it("error leaves out the reference line when there's no digest", () => {
    const out = renderToStaticMarkup(createElement(SegmentError, { error: new Error("x"), reset: () => {} }));
    expect(textOf(out)).not.toContain("Reference");
  });

  it("Try again re-renders the segment on the server (refresh) and resets the boundary", () => {
    const reset = vi.fn();
    // Called as a function: useRouter is mocked, so no React render is needed
    // to reach the button's handler.
    const tree = SegmentError({ error: new Error("x"), reset }) as ReactElement<{ children?: ReactNode }>;
    const button = findButton(tree);
    expect(button).toBeDefined();
    button!.props.onClick();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

type ButtonElement = ReactElement<{ onClick: () => void; children?: ReactNode }>;

function findButton(node: ReactNode): ButtonElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === "button") return node as ButtonElement;
  return findButton((node.props as { children?: ReactNode }).children);
}

describe("exec kit source rules", () => {
  const KIT = path.join(SRC, "components", "exec");

  function filesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []
    );
  }

  it("never renders text as HTML (no dangerouslySetInnerHTML anywhere under components/exec)", () => {
    const offenders = filesUnder(KIT).filter((file) => readFileSync(file, "utf8").includes("dangerouslySetInnerHTML"));
    expect(offenders).toEqual([]);
  });

  it("keeps the P2b kit as server components", () => {
    const kit = [
      "AttentionFeed.tsx",
      "AttentionRow.tsx",
      "BasisLabel.tsx",
      "CategoryBadge.tsx",
      "EmptyState.tsx",
      "ExecHeader.tsx",
      "ExecTabs.tsx",
      "FactList.tsx",
      "PriorityBandBadge.tsx",
      "SafeMarkdown.tsx",
      "SectionCard.tsx",
      "SourceLinks.tsx",
      "Sparkline.tsx",
      "StatTile.tsx"
    ];
    for (const file of kit) {
      const src = readFileSync(path.join(KIT, file), "utf8");
      expect(src, file).not.toMatch(/^\s*["']use client["']/);
    }
  });

  it("keeps the email surfaces on the server except their three islands (P3)", () => {
    const islands = filesUnder(path.join(KIT, "email"))
      .filter((file) => /^\s*["']use client["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.basename(file))
      .sort();
    expect(islands).toEqual(["AssessButton.tsx", "BucketTabs.tsx", "EmailFrame.tsx"]);
  });

  it("never sets srcdoc from markup or adds allow-scripts to the email frame (P3)", () => {
    const frame = readFileSync(path.join(KIT, "email", "EmailFrame.tsx"), "utf8");
    // The code, without its line comments (which explain why allow-scripts is never there).
    const code = frame
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/srcDoc=/);
    expect(code).not.toContain("allow-scripts");
    expect(frame).toContain('EMAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox allow-same-origin"');
  });
});
