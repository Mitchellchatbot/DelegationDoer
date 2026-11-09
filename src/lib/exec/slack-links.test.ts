import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFakeSlack } from "@/lib/exec/__tests__/fake-slack-api";
import { assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { DD_PATH_RE, extractDdPaths, sweepVerdict } from "@/lib/exec/slack-ingest";
import { hostsInText, parseDdPaths, type ParsedDdLinks } from "@/lib/exec/slack-links";
import { readHistory, type SlackReadMessage } from "@/lib/exec/sources/slack";

// P7b Area B: DD-path parsing and the domain signal (contract §3.3, §5.2 LK01–LK07). Extraction itself is P7a's
// extractDdPaths (tested in P7a's suite, coherence-4); these tests pin the parser and the hand-off: P7a's own output for the
// frozen DD-post fixtures parses to exactly the fixture's ids (LK06), and P7a's DD_PATH_RE and this parser accept the same
// paths (LK07).

const EMPTY: ParsedDdLinks = { taskIds: [], clientIds: [], projectIds: [], emailThreadIds: [] };

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
});
afterEach(() => {
  // A pure module: nothing logged at all.
  expect(out.calls()).toEqual([]);
  assertNoSlackLeak({ console: out });
});

/** A seeded generator (mulberry32): the property tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("LK01 parseDdPaths groups the DD paths by section", () => {
  it("tasks, clients and projects go to their lists, in order; unknown sections and malformed paths are ignored", () => {
    expect(parseDdPaths(["/tasks/tk_1", "/clients/cl_acme", "/projects/pr-7", "/tasks/TK-2"])).toEqual({
      taskIds: ["tk_1", "TK-2"], clientIds: ["cl_acme"], projectIds: ["pr-7"], emailThreadIds: []
    });
    for (const bad of [
      "/users/u_1", "/tasks", "/tasks/", "/tasks/tk_1/", "/tasks/tk 1", "/tasks/tk.1", "/tasks/tk_1/comments", "/Tasks/tk_1", "tasks/tk_1",
      "//tasks/tk_1", "/tasks/tk_1?x=1", "/tasks/tk_1#c", `/tasks/${"a".repeat(101)}`, "https://operations.scaledai.org/tasks/tk_1",
      "/clients/cl%20x", "/projects/", "/inboxes/a1", "/inboxes/a1?view=all", "/inboxes/?thread=th_1", "/inboxes/a1?thread=", "/inboxes/a 1?thread=t",
      "", " /tasks/tk_1"
    ]) {
      expect(parseDdPaths([bad]), bad).toEqual(EMPTY);
    }
    expect(parseDdPaths([`/tasks/${"a".repeat(100)}`]).taskIds).toEqual(["a".repeat(100)]);
  });

  it("non-string entries and a non-array never throw", () => {
    expect(parseDdPaths([null, 7, {}, ["/tasks/x"], "/tasks/tk_1"] as unknown as string[])).toEqual({ ...EMPTY, taskIds: ["tk_1"] });
    expect(parseDdPaths(null as unknown as string[])).toEqual(EMPTY);
    expect(parseDdPaths("/tasks/tk_1" as unknown as string[])).toEqual(EMPTY);
  });
});

describe("LK02 inbox paths give the thread id", () => {
  it("/inboxes/a1?thread=th_9&acct=a1 → th_9; other query keys ignored, wherever the thread key sits", () => {
    expect(parseDdPaths(["/inboxes/a1?thread=th_9&acct=a1"])).toEqual({ ...EMPTY, emailThreadIds: ["th_9"] });
    expect(parseDdPaths(["/inboxes/acct_1?view=all&thread=th:42.x-1"]).emailThreadIds).toEqual(["th:42.x-1"]);
    expect(parseDdPaths(["/inboxes/acct_1?view=all&thread=th_1&page=2"]).emailThreadIds).toEqual(["th_1"]);
    // A key that only ends in "thread", an empty thread, then the real one.
    expect(parseDdPaths(["/inboxes/a1?xthread=nope&thread=&thread=th_3"]).emailThreadIds).toEqual(["th_3"]);
    // The first well-formed thread key wins.
    expect(parseDdPaths(["/inboxes/a1?thread=th_a&thread=th_b"]).emailThreadIds).toEqual(["th_a"]);
    // An inbox path names no task, client or project.
    expect(parseDdPaths(["/inboxes/cl_acme?thread=th_1"])).toEqual({ ...EMPTY, emailThreadIds: ["th_1"] });
  });

  it("a thread value outside the pattern, or a fragment, is ignored", () => {
    for (const bad of ["/inboxes/a1?thread=th%201", "/inboxes/a1?thread=th 1", "/inboxes/a1?thread=th_1#x", "/inboxes/a1?thread=th_1=2",
      `/inboxes/a1?thread=${"t".repeat(201)}`, "/inboxes/a1?thread=th/1"]) {
      expect(parseDdPaths([bad]), bad).toEqual(EMPTY);
    }
    expect(parseDdPaths([`/inboxes/a1?thread=${"t".repeat(200)}`]).emailThreadIds).toEqual(["t".repeat(200)]);
  });
});

describe("LK03 dedupe and caps", () => {
  it("each id once, in first-seen order; ≤ 20 tasks, clients and projects; ≤ 5 thread ids", () => {
    const paths = [
      ...Array.from({ length: 30 }, (_, i) => `/tasks/tk_${i % 25}`),
      ...Array.from({ length: 25 }, (_, i) => `/clients/cl_${i}`),
      ...Array.from({ length: 25 }, (_, i) => `/projects/pr_${i}`),
      ...Array.from({ length: 9 }, (_, i) => `/inboxes/a1?thread=th_${i % 7}`),
      "/tasks/tk_0", "/inboxes/a1?thread=th_0"
    ];
    const p = parseDdPaths(paths);
    expect(p.taskIds).toEqual(Array.from({ length: 20 }, (_, i) => `tk_${i}`));
    expect(p.clientIds).toEqual(Array.from({ length: 20 }, (_, i) => `cl_${i}`));
    expect(p.projectIds).toEqual(Array.from({ length: 20 }, (_, i) => `pr_${i}`));
    expect(p.emailThreadIds).toEqual(["th_0", "th_1", "th_2", "th_3", "th_4"]);
    expect(parseDdPaths(["/tasks/a", "/tasks/a", "/clients/a", "/projects/a"])).toEqual({ taskIds: ["a"], clientIds: ["a"], projectIds: ["a"], emailThreadIds: [] });
  });
});

describe("LK04 hostsInText", () => {
  it("lowercases, strips www., ignores emails, trims punctuation and Slack markup, keeps first-seen order once", () => {
    expect(hostsInText("Launch on WWW.Acme-Dental.com today; see acme-dental.com/pricing and https://www.beta.io/x?y=1.")).toEqual(["acme-dental.com", "beta.io"]);
    expect(hostsInText("Mail jane@acme.com or Jane.Doe+x@sub.acme.com, not a host")).toEqual([]);
    expect(hostsInText("(gamma.co.uk), \"delta.org\" [epsilon.net] _zeta.app_ *eta.dev* `theta.ai` acme.com: done. omega.com!")).toEqual([
      "gamma.co.uk", "delta.org", "epsilon.net", "zeta.app", "eta.dev", "theta.ai", "acme.com", "omega.com"
    ]);
    expect(hostsInText("<https://acme.com|acme.com> <mailto:bob@beta.io|bob@beta.io> <http://shop.gamma.io:8080/a>")).toEqual(["acme.com", "shop.gamma.io"]);
    // A subdomain is its own host (the domain signal matches exact sites); www. alone is a host only with a domain after it.
    expect(hostsInText("blog.acme.com www.com")).toEqual(["blog.acme.com", "www.com"]);
  });

  it("numbers, versions, abbreviations and glued tokens are not hosts", () => {
    expect(hostsInText("v1.2.3 is 3.14 better, e.g. i.e. etc. Q3 x.y z.1 acme.c a..com -acme.com acme.com-x foo.acme.com.")).toEqual(["foo.acme.com"]);
    expect(hostsInText("")).toEqual([]);
    expect(hostsInText(null as unknown as string)).toEqual([]);
    expect(hostsInText(42 as unknown as string)).toEqual([]);
  });

  it("is bounded: ≤ 50 hosts, and a long text is cut before it is scanned", () => {
    const many = Array.from({ length: 80 }, (_, i) => `site${i}.com`).join(" ");
    expect(hostsInText(many)).toHaveLength(50);
    expect(hostsInText(`${"x ".repeat(15_000)}late.com`)).toEqual([]);
  });
});

describe("LK05 neither function throws on 10 000 random strings", () => {
  it("a seeded generator over path, host and markup pieces", () => {
    const next = rng(0x7b5eed);
    const pieces = ["/", "tasks", "clients", "projects", "inboxes", "?", "&", "thread=", "=", "#", " ", ".", "-", "_", ":", "@", "%2F", "www.",
      "https://", "operations.scaledai.org", "<", ">", "|", "\n", "\t", "a", "Z", "9", "é", "com", "..", "--", String.fromCodePoint(0x1f600),
      // U+202E (right-to-left override) and U+200B (zero-width space), built from code points.
      String.fromCodePoint(0x202e), String.fromCodePoint(0x200b), "x".repeat(70)];
    for (let i = 0; i < 10_000; i++) {
      const n = Math.floor(next() * 40);
      let s = "";
      for (let j = 0; j < n; j++) s += pieces[Math.floor(next() * pieces.length)];
      const parsed = parseDdPaths([s, s.slice(1)]);
      for (const list of [parsed.taskIds, parsed.clientIds, parsed.projectIds, parsed.emailThreadIds]) expect(Array.isArray(list)).toBe(true);
      const hosts = hostsInText(s);
      for (const h of hosts) expect(h).toMatch(/^[a-z0-9.-]+$/);
    }
  });
});

describe("LK06 the hand-off: P7a's extractDdPaths output for the DD-post fixtures parses to exactly the fixture's ids", () => {
  type Anchor = { name: string; channelId: string; raw: Record<string, unknown>; ddPaths: string[]; expect: ParsedDdLinks };
  const fixture = JSON.parse(readFileSync(new URL("./__tests__/fixtures/slack-intel/anchors.json", import.meta.url), "utf8")) as
    { anchors: Anchor[]; ddBot: { userId: string; appId: string } };
  const TARGET = Object.freeze({ userToken: "xoxp-lk06-not-a-token", teamId: "T0SCALED", userId: "U0MITCH" });

  /** The fixtures' raw posts as P7a's reading client parses them (fake-slack-api answers conversations.history). */
  async function parsed(): Promise<SlackReadMessage[]> {
    const slack = installFakeSlack({ "conversations.history": () => ({ ok: true, messages: fixture.anchors.map((a) => a.raw), has_more: false }) });
    try {
      return (await readHistory(TARGET, { channel: "C0ACMESEO", limit: 200 })).messages;
    } finally {
      slack.restore();
    }
  }

  it("P7a stores exactly the fixture's dd_paths (sweepVerdict's anchor branch), and parseDdPaths gives exactly its ids", async () => {
    const messages = await parsed();
    expect(messages).toHaveLength(fixture.anchors.length);
    const ctx = { conv: "channel" as const, hisId: "U0MITCH", teamId: "T0SCALED", ddBot: fixture.ddBot, isHub: false, muted: false, muteSource: null,
      extConversation: false, optedOut: new Set<string>(), hePostedInThread: () => false };
    fixture.anchors.forEach((a, i) => {
      const verdict = sweepVerdict(messages[i], ctx);
      expect(verdict, a.name).toEqual({ role: "anchor", ddPaths: a.ddPaths });
      expect(parseDdPaths((verdict as { ddPaths: string[] }).ddPaths), a.name).toEqual(a.expect);
    });
  });

  it("P7a's extractDdPaths on a post's text alone parses the same way (the text's link tokens)", () => {
    for (const a of fixture.anchors) {
      const fromText = extractDdPaths({ text: typeof a.raw.text === "string" ? a.raw.text : "", urls: [] });
      for (const p of fromText) expect(a.ddPaths, a.name).toContain(p);
      const ids = parseDdPaths(fromText);
      for (const id of ids.taskIds) expect(a.expect.taskIds).toContain(id);
      for (const id of ids.clientIds) expect(a.expect.clientIds).toContain(id);
      for (const id of ids.projectIds) expect(a.expect.projectIds).toContain(id);
    }
    // Every case of the fixture is covered: tasks, a client, a project, an inbox thread and a post with none.
    const all = fixture.anchors.map((a) => a.expect);
    expect(all.some((e) => e.taskIds.length > 0) && all.some((e) => e.clientIds.length > 0) && all.some((e) => e.projectIds.length > 0)
      && all.some((e) => e.emailThreadIds.length > 0) && all.some((e) => JSON.stringify(e) === JSON.stringify(EMPTY))).toBe(true);
  });
});

describe("LK07 P7a's DD_PATH_RE and parseDdPaths accept the same paths", () => {
  const ID = "ABCXYZabcxyz0189_-";
  const THREAD = `${ID}.:`;
  const QUERY = `${THREAD}=/?%+ZQ`;
  function draw(next: () => number, chars: string, min: number, max: number): string {
    const n = min + Math.floor(next() * (max - min + 1));
    let s = "";
    for (let i = 0; i < n; i++) s += chars[Math.floor(next() * chars.length)];
    return s;
  }
  /** Valid-looking paths, near misses and junk in roughly equal parts. */
  function generated(): string[] {
    const next = rng(0xdd9a7);
    const outList: string[] = [];
    const mutate = (s: string): string => {
      const at = Math.floor(next() * (s.length + 1));
      const junk = [" ", "#", "/", "&", "?", "=", "thread=", "%", "!", "é", ""][Math.floor(next() * 11)];
      return next() < 0.5 ? s.slice(0, at) + junk + s.slice(at) : s.slice(0, at) + s.slice(at + 1);
    };
    for (let i = 0; i < 4_000; i++) {
      const section = ["tasks", "clients", "projects", "inboxes", "users", "Tasks"][Math.floor(next() * 6)];
      let p: string;
      if (section === "inboxes") {
        const before = next() < 0.5 ? "" : `${draw(next, QUERY, 0, 30)}&`;
        const after = next() < 0.5 ? "" : `&${draw(next, QUERY, 0, 30)}`;
        p = `/inboxes/${draw(next, ID, 1, 110)}?${before}thread=${draw(next, THREAD, 0, 205)}${after}`;
      } else {
        p = `/${section}/${draw(next, ID, 0, 105)}`;
      }
      outList.push(p);
      if (next() < 0.5) outList.push(mutate(p));
    }
    return outList;
  }

  it("every accepted path gives at least one id, and every path that gives an id is accepted", () => {
    const paths = generated();
    let accepted = 0;
    for (const p of paths) {
      const ids = parseDdPaths([p]);
      const total = ids.taskIds.length + ids.clientIds.length + ids.projectIds.length + ids.emailThreadIds.length;
      if (DD_PATH_RE.test(p)) {
        accepted += 1;
        expect(total, p).toBeGreaterThanOrEqual(1);
      } else {
        expect(total, p).toBe(0);
      }
    }
    // The set exercises both sides.
    expect(accepted).toBeGreaterThan(500);
    expect(paths.length - accepted).toBeGreaterThan(500);
  });
});
