import { describe, expect, it } from "vitest";

import { MAX_NEW_REFS_PER_TURN, RefRegistry, targetFromSourceRef, targetKey, threadOfTarget } from "@/lib/exec/agent/refs";
import type { RefEntry } from "@/lib/exec/agent/types";
import { ddClientRef, ddPageRef, ddProjectRef, ddTaskRef, execEmailRef, execEmailThreadRef, slackMessageRef } from "@/lib/exec/refs";

// P5b contract §3.5 and tests 9-10: the ref registry.

const page = (path: string) => ddPageRef(path, path);

describe("RefRegistry (test 9)", () => {
  it("same target → same ref; numbering continues from refSeq; excerpt stripped", () => {
    const reg = new RefRegistry({ refSeq: 7, prior: [], contexts: [] });
    const a = reg.issue({ type: "task", id: "t_1" }, { ...ddTaskRef({ id: "t_1", title: "One" }), excerpt: "SECRET QUOTE" });
    expect(a).toBe("r8");
    expect(reg.issue({ type: "task", id: "t_1" }, ddTaskRef({ id: "t_1" }))).toBe("r8");
    expect(reg.issue({ type: "task", id: "t_2" }, ddTaskRef({ id: "t_2" }))).toBe("r9");
    expect(reg.issuedThisTurn().map((e) => e.ref)).toEqual(["r8", "r9"]);
    expect(reg.issuedThisTurn()[0].source).not.toHaveProperty("excerpt");
    expect(reg.refSeq).toBe(9);
  });

  it("a new ref is not citable until markDelivered sees it; refs not issued this turn are ignored", () => {
    const reg = new RefRegistry({ refSeq: 0, prior: [], contexts: [] });
    const r = reg.issue({ type: "client", id: "c_1" }, ddClientRef({ id: "c_1" })) as string;
    expect(reg.isCitable(r)).toBe(false);
    expect(reg.citable(r)).toBeNull();
    reg.markDelivered(["r99", r]);
    expect(reg.isCitable(r)).toBe(true);
    expect(reg.isCitable("r99")).toBe(false);
    expect(reg.citable(r)?.target).toEqual({ type: "client", id: "c_1" });
    expect(reg.deliveredThisTurn().map((e) => e.ref)).toEqual([r]);
  });

  it("prior cited refs and context refs are reused and citable from the start", () => {
    const prior: RefEntry = { ref: "r3", target: { type: "project", id: "p_1" }, source: ddProjectRef({ id: "p_1" }) };
    const context: RefEntry = { ref: "r5", target: { type: "email_thread", id: "th_1" }, source: execEmailThreadRef("th_1") };
    const reg = new RefRegistry({ refSeq: 5, prior: [prior], contexts: [context] });
    expect(reg.isCitable("r3")).toBe(true);
    expect(reg.isCitable("r5")).toBe(true);
    expect(reg.issue({ type: "project", id: "p_1" }, ddProjectRef({ id: "p_1" }))).toBe("r3");
    expect(reg.issue({ type: "email_thread", id: "th_1" }, execEmailThreadRef("th_1"))).toBe("r5");
    expect(reg.issuedThisTurn()).toEqual([]);
    expect(reg.issue({ type: "task", id: "t_9" }, ddTaskRef({ id: "t_9" }))).toBe("r6");
  });

  it("past 400 new refs → null; refSeq counts undelivered refs too", () => {
    const reg = new RefRegistry({ refSeq: 10, prior: [], contexts: [] });
    for (let i = 0; i < MAX_NEW_REFS_PER_TURN; i += 1) expect(reg.issue({ type: "task", id: `t_${i}` }, ddTaskRef({ id: `t_${i}` }))).not.toBeNull();
    expect(reg.issue({ type: "task", id: "t_over" }, ddTaskRef({ id: "t_over" }))).toBeNull();
    expect(reg.refSeq).toBe(410);
    reg.markDelivered(["r11"]);
    expect(reg.deliveredThisTurn()).toHaveLength(1);
    expect(reg.refSeq).toBe(410);
  });
});

describe("targets (test 10)", () => {
  it("targetFromSourceRef for every builder", () => {
    expect(targetFromSourceRef(ddTaskRef({ id: "t_1", title: "One" }))).toEqual({ type: "task", id: "t_1" });
    expect(targetFromSourceRef(ddClientRef({ id: "c 1" }))).toEqual({ type: "client", id: "c 1" });
    expect(targetFromSourceRef(ddProjectRef({ id: "p_1" }))).toEqual({ type: "project", id: "p_1" });
    expect(targetFromSourceRef(ddPageRef("/team/u%201", "Ann"))).toEqual({ type: "person", id: "u 1" });
    expect(targetFromSourceRef(page("/eod/history"))).toEqual({ type: "page", path: "/eod/history" });
    expect(targetFromSourceRef(page("/tasks/board?status=pending_approval&groupBy=status"))).toEqual({ type: "page", path: "/tasks/board?status=pending_approval&groupBy=status" });
    expect(targetFromSourceRef(page("/executive/email/drafts/ed_1"))).toEqual({ type: "page", path: "/executive/email/drafts/ed_1" });
    expect(targetFromSourceRef(execEmailRef({ threadId: "th_1" }))).toEqual({ type: "email_thread", id: "th_1" });
    expect(targetFromSourceRef(execEmailThreadRef("th/2"))).toEqual({ type: "email_thread", id: "th/2" });
    const slack = slackMessageRef({ channelId: "C1", ts: "1.2", isPrivate: true });
    expect(targetFromSourceRef(slack).type).toBe("page");
  });

  it("threadOfTarget and targetKey", () => {
    expect(threadOfTarget({ type: "email_thread", id: "th_1" })).toBe("th_1");
    expect(threadOfTarget({ type: "attention", id: "ea_1", threadId: "th_2" })).toBe("th_2");
    expect(threadOfTarget({ type: "attention", id: "ea_1", threadId: null })).toBeNull();
    expect(threadOfTarget({ type: "commitment", id: "cm_1", threadId: "th_3" })).toBe("th_3");
    expect(threadOfTarget({ type: "task", id: "t_1" })).toBeNull();
    expect(targetKey({ type: "eod_note", userId: "u_1", date: "2026-11-04" })).toBe("eod_note:u_1:2026-11-04");
    expect(targetKey({ type: "approval", mechanism: "fb_proofs", id: null })).toBe("approval:fb_proofs:");
    expect(targetKey({ type: "email_thread", id: "th_1" })).toBe("email_thread:th_1");
    expect(targetKey({ type: "sod_note", userId: "u_1", date: "2026-11-04" })).not.toBe(targetKey({ type: "eod_note", userId: "u_1", date: "2026-11-04" }));
  });
});
