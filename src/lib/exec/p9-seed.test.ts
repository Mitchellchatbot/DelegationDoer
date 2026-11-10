import { afterEach, describe, expect, it, vi } from "vitest";

// P9 stage -1 seeds (lead; P9 contract section 0.2 step 3; p9-bindings.md AM-P9-3 to AM-P9-7): pins what the seeds
// added, so an area can't drift from them without the lead. Seeds S1-S4 are the contract's; S5 (BUILT_IN_JOB_KINDS) is
// the lead's, for Area A's System card label map (F26) and Area D's runbook test. Nothing here reads a database, a
// session or the network.
vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => {
    throw new Error("p9-seed.test.ts reads no database");
  }
}));
vi.mock("@/lib/supabase-server", () => ({
  getSupabaseServer: () => {
    throw new Error("p9-seed.test.ts reads no session");
  }
}));

import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";
import { NO_SCREEN, type BriefScreen, type BriefWithheldReason } from "@/lib/exec/brief-screen";
import { briefDmToView } from "@/lib/exec/brief-slack-ui";
import { briefContentView } from "@/lib/exec/brief-view";
import { __resetJobsForTests, getJobHandler } from "@/lib/exec/jobs";
import type { OverviewSystem } from "@/lib/exec/overview";
import { BUILT_IN_JOB_KINDS, __resetExecRuntimeForTests, ensureExecRuntime } from "@/lib/exec/runtime";
import { __resetSchedulerForTests } from "@/lib/exec/scheduler";
import type { JobHandler } from "@/lib/exec/types";
import { content, TZ } from "@/lib/exec/__tests__/brief-ui-fixtures";

const HREF = "https://operations.scaledai.org/executive/brief";
const screen = (over: Partial<BriefScreen> = {}): BriefScreen => ({ ...NO_SCREEN, ...over });
const NONE_LATE =
  "Today's brief was due at {time} and hasn't started. The System card on the Overview shows whether the assistant's jobs are running.";

describe("P9 seed S1: brief-copy.ts", () => {
  it("adds removedUnavailable, pillState.late, noneLate and regenerateGaveUp exactly; noneLate fills {time}", () => {
    expect(BRIEF_COPY.removedUnavailable).toBe("[Removed: no longer available]");
    expect(BRIEF_COPY.pillState.late).toBe("late");
    expect(BRIEF_COPY.noneLate).toBe(NONE_LATE);
    expect(BRIEF_COPY.regenerateGaveUp).toBe("Still building. Reload in a few minutes to see it.");
    expect(fillBrief(BRIEF_COPY.noneLate, { time: "8:00 AM" })).toBe(NONE_LATE.replace("{time}", "8:00 AM"));
    expect(Object.isFrozen(BRIEF_COPY.pillState)).toBe(true);
  });
});

describe("P9 seed S2: BriefWithheldReason \"unavailable\"", () => {
  it("page and card: the line reads removedUnavailable with no refs, and the top-3 entry citing it is withheld alike", () => {
    const reason: BriefWithheldReason = "unavailable";
    const v = briefContentView(content(), screen({ items: new Map([["b1", reason]]), hideHeadline: true }));
    const line = v.sections.find((s) => s.key === "emails")?.lines.find((l) => l.id === "b1");
    expect(line).toMatchObject({ text: BRIEF_COPY.removedUnavailable, withheld: "unavailable", refs: [] });
    expect(v.top3[0]).toEqual({ title: BRIEF_COPY.removedUnavailable, next: null, href: null, withheld: true });
    expect(v.headline).toBeNull();
  });

  it("page and card: \"restricted\" and \"slack\" keep their own copy", () => {
    const items = new Map<string, BriefWithheldReason>([["b1", "restricted"], ["b2", "slack"]]);
    const v = briefContentView(content(), screen({ items, hideHeadline: true }));
    expect(v.sections.find((s) => s.key === "emails")?.lines[0]).toMatchObject({ text: BRIEF_COPY.removedRestricted, withheld: "restricted" });
    expect(v.sections.find((s) => s.key === "slack")?.lines[0]).toMatchObject({ text: BRIEF_COPY.removedSlack, withheld: "slack" });
  });

  it("DM: the line reads removedUnavailable with no link, and the top-3 entry citing it is left out", () => {
    const items = new Map<string, BriefWithheldReason>([["b1", "unavailable"]]);
    const v = briefDmToView(content(), { tz: TZ, briefHref: HREF, screen: screen({ items, hideHeadline: true }) });
    expect(v.sections.find((s) => s.key === "emails")?.lines).toEqual([{ text: BRIEF_COPY.removedUnavailable, kind: "fact", href: null }]);
    expect(v.top3.map((t) => t.title)).not.toContain("Answer Acme");
    expect(v.headline).toBeNull();
  });
});

describe("P9 seeds S3 and S4: additive optional fields", () => {
  it("OverviewSystem.tokenKeys (absent, null or the two counts) and JobHandler.claimable", () => {
    const keys: OverviewSystem["tokenKeys"][] = [undefined, null, { previousKey: 2, unknownKey: 0 }];
    expect(keys).toHaveLength(3);
    const plain: JobHandler = { kind: "exec.p9-seed", lane: "bulk", timeoutMs: 1_000, run: async () => null };
    const gated: JobHandler = { ...plain, claimable: () => false };
    expect(plain.claimable).toBeUndefined();
    expect(gated.claimable?.()).toBe(false);
  });
});

describe("P9 seed S5: runtime.ts BUILT_IN_JOB_KINDS", () => {
  afterEach(() => {
    __resetExecRuntimeForTests();
    __resetJobsForTests();
    __resetSchedulerForTests();
  });

  it("is frozen and unique, every entry an exec kind, and every entry is a kind ensureExecRuntime registers", () => {
    expect(Object.isFrozen(BUILT_IN_JOB_KINDS)).toBe(true);
    expect(BUILT_IN_JOB_KINDS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(BUILT_IN_JOB_KINDS).size).toBe(BUILT_IN_JOB_KINDS.length);
    for (const kind of BUILT_IN_JOB_KINDS) expect(kind).toMatch(/^exec\.[a-z][a-z-]*$/);
    expect(BUILT_IN_JOB_KINDS).toEqual(expect.arrayContaining([
      "exec.purge", "exec.ddtext-triage", "exec.draft-generate", "exec.draft-reconcile", "exec.slack-dm-purge", "exec.slack-intel-sweep",
      "exec.brief", "exec.access-alert"
    ]));
    ensureExecRuntime();
    for (const kind of BUILT_IN_JOB_KINDS) expect(getJobHandler(kind)?.kind, kind).toBe(kind);
  });
});
