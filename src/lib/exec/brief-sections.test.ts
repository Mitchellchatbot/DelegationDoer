import { describe, expect, it } from "vitest";

import fixture from "@/lib/exec/__tests__/fixtures/brief-gather.json";
import { BRIEF_TEXT_SENTINELS, assertNoBriefText } from "@/lib/exec/__tests__/brief-assert";
import { parseEmailFingerprint } from "@/lib/exec/attention";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { BAND_RANK } from "@/lib/exec/brief-novelty";
import {
  CATEGORY_SECTION,
  KIND_SECTION,
  assembleSections,
  bandRank,
  compareInputItems,
  composeDeterministic,
  contentRefs,
  deterministicTop3,
  gatherItems,
  inputItemFromAttention,
  sectionOf,
  slackKeysOf,
  threadIdsOf,
  type AssembleInput,
  type EmailFpParser
} from "@/lib/exec/brief-sections";
import { BRIEF_LIMITS, BRIEF_SECTION_KEYS } from "@/lib/exec/brief-types";
import type { BriefGather, BriefInputItem, BriefSectionKey, NoveltyVerdict } from "@/lib/exec/brief-types";
import type { ExecOverview } from "@/lib/exec/overview";

// P8 contract §5.5 (GA01-GA05, GA11, GA13-GA15; Area C): the pure assembly of the brief's sections over the shared gather
// fixture (fixtures/brief-gather.json, an AssembleInput as JSON), and the deterministic content. The gather's reads (GA06-GA10,
// GA12, GA16, GA07/GA07b) are in brief-gather.test.ts.

const parseFp: EmailFpParser = (fp) => {
  const p = parseEmailFingerprint(fp);
  return p !== null && typeof p.threadId === "string" ? { threadId: p.threadId } : null;
};

type FixtureInput = Omit<AssembleInput, "now" | "parseEmailFingerprint"> & { now: string };
function input(over: Partial<AssembleInput> = {}): AssembleInput {
  const raw = structuredClone(fixture.input) as unknown as FixtureInput;
  return { ...raw, now: new Date(raw.now), parseEmailFingerprint: parseFp, ...over } as AssembleInput;
}
const feed = (): AttentionFeedItem[] => (structuredClone(fixture.input.attention.items) as unknown as AttentionFeedItem[]);
const overview = (): ExecOverview => structuredClone(fixture.input.overview) as unknown as ExecOverview;
const sectionOfGather = (g: BriefGather, key: BriefSectionKey) => g.sections.find((s) => s.key === key)!;
const fps = (g: BriefGather, key: BriefSectionKey) => sectionOfGather(g, key).items.map((i) => i.fingerprint);

function item(fp: string, over: Partial<AttentionFeedItem> = {}): AttentionFeedItem {
  const base = feed()[0];
  return { ...base, id: `eai_${fp.length.toString(16).padStart(32, "0")}`, fingerprint: fp, ...over } as AttentionFeedItem;
}

describe("GA01 the kind → section map (M4, A4, AM-P8-11)", () => {
  it("every fixture attention kind lands in its KIND_SECTION, an unmapped kind by its category, fyi/on_track nowhere", () => {
    const g = assembleSections(input());
    const where = new Map<string, BriefSectionKey>();
    for (const s of g.sections) for (const i of s.items) where.set(i.fingerprint, s.key);
    for (const it of feed()) {
      if (it.fingerprint === "dd:approval:draft_tasks") continue;   // replaced by its itemized approvals line (asserted below)
      if (it.category === "fyi" || it.category === "on_track") {
        expect(where.has(it.fingerprint), it.fingerprint).toBe(false);
        continue;
      }
      const expected = KIND_SECTION[it.kind] ?? CATEGORY_SECTION[it.category];
      expect(where.get(it.fingerprint), it.fingerprint).toBe(expected);
    }
    expect(where.get("dd:new-rule:x1")).toBe("decisions");
    expect(where.get("dd:ddtext:blocker:comment:cm_1")).toBe("blockers");
    expect(where.get("dd:ddtext:waiting:eod_note:n_2")).toBe("blockers");
    expect(where.get("dd:ddtext:decision:eod_note:n_3")).toBe("decisions");
    expect(where.get("dd:ddtext:mention:comment:cm_4")).toBe("decisions");
  });

  it("sectionOf: fyi and on_track never enter, even for a mapped kind; unmapped kinds fall back by category", () => {
    expect(sectionOf({ kind: "important_email", category: "fyi" })).toBeNull();
    expect(sectionOf({ kind: "site_alert", category: "on_track" })).toBeNull();
    expect(sectionOf({ kind: "important_email", category: "my_action" })).toBe("emails");
    expect(sectionOf({ kind: "nope", category: "approval" })).toBe("approvals");
    expect(sectionOf({ kind: "nope", category: "delegated" })).toBe("work");
    expect(sectionOf({ kind: "nope", category: "intervene" })).toBe("blockers");
    expect(sectionOf({ kind: "toString", category: "my_action" })).toBe("decisions");
  });

  it("an itemized approval mechanism replaces the feed's dd:approval:<m> item (its band and score kept, one line not two)", () => {
    const g = assembleSections(input());
    const approvals = sectionOfGather(g, "approvals").items;
    expect(approvals.map((i) => i.fingerprint)).not.toContain("dd:approval:draft_tasks");
    const drafts = approvals.find((i) => i.fingerprint === "brief:approval-items:draft_tasks")!;
    expect(drafts).toMatchObject({ band: "high", score: 55, category: "approval", kind: "pending_approval", title: "Waiting for approval: AI-drafted tasks (5)" });
    expect(drafts.facts).toHaveLength(3);
    expect(drafts.facts[0]).toMatch(/^Draft: Acme ad refresh, waiting since /);
    // A mechanism with restricted items hidden says so (count only); one with nothing waiting adds no line; the failed one keeps none.
    const mail = approvals.find((i) => i.fingerprint === "brief:approval-items:email_drafts")!;
    expect(mail.facts).toContain("1 hidden: restricted sender");
    expect(approvals.map((i) => i.fingerprint)).not.toContain("brief:approval-items:unrouted_mail");
    expect(approvals.map((i) => i.fingerprint)).not.toContain("brief:approval-items:eod_reviews");
    // Check-ins aren't itemized: the feed's own item stays.
    expect(approvals.map((i) => i.fingerprint)).toContain("dd:approval:checkins");
    expect(g.failures).toContain("approvals.eod_reviews");
  });
});

describe("GA02 aliases and caps", () => {
  it("aliases are i1..iN across the gather in (band rank desc, score desc, fingerprint asc) order", () => {
    const g = assembleSections(input());
    const all = gatherItems(g);
    const byAlias = [...all].sort((a, b) => Number(a.alias.slice(1)) - Number(b.alias.slice(1)));
    expect(byAlias.map((i) => i.alias)).toEqual(byAlias.map((_, n) => `i${n + 1}`));
    for (let n = 1; n < byAlias.length; n++) expect(compareInputItems(byAlias[n - 1], byAlias[n])).toBeLessThan(0);
    // The order is BAND_RANK's (brief-novelty.ts): critical before high before normal; bandRank agrees with it.
    for (const b of ["normal", "high", "critical"] as const) expect(bandRank(b)).toBe(BAND_RANK[b]);
    for (let n = 1; n < byAlias.length; n++) expect(BAND_RANK[byAlias[n - 1].band]).toBeGreaterThanOrEqual(BAND_RANK[byAlias[n].band]);
    expect(byAlias[0].fingerprint).toBe("dd:incident:task:t_incident7");   // critical, 91
    expect(byAlias[1].fingerprint).toBe("email:thread:th_escal2:msg_e2"); // critical, 88
    // Within a section the items keep that order too.
    for (const s of g.sections) for (let n = 1; n < s.items.length; n++) expect(compareInputItems(s.items[n - 1], s.items[n])).toBeLessThan(0);
  });

  it("caps: 12 per section and 80 in all, the lowest dropped first and counted in the section's more", () => {
    const many: AttentionFeedItem[] = [];
    for (let n = 0; n < 15; n++) many.push(item(`dd:overdue:assignee:u_${String(n).padStart(2, "0")}`, { kind: "overdue_tasks", category: "intervene",
      priority: { score: 100 - n, band: "normal", reasons: [] } }));
    const g = assembleSections(input({ attention: { items: many, hiddenEmail: 0 } }));
    const work = sectionOfGather(g, "work");
    expect(work.items.filter((i) => i.kind === "overdue_tasks")).toHaveLength(BRIEF_LIMITS.modelItemsPerSection - work.items.filter((i) => i.kind !== "overdue_tasks").length);
    expect(work.items).toHaveLength(BRIEF_LIMITS.modelItemsPerSection);
    expect(work.stats.more).toBeGreaterThanOrEqual(3);
    expect(work.items.map((i) => i.fingerprint)).not.toContain("dd:overdue:assignee:u_14");

    const kinds = ["overdue_tasks", "open_incident", "decision_ask", "pending_approval", "client_escalation", "important_email", "slack_request",
      "overdue_commitment"];   // eight kinds in eight sections: 96 items, no section over 12
    const lots: AttentionFeedItem[] = [];
    kinds.forEach((kind, k) => {
      for (let n = 0; n < 12; n++) {
        const source = kind.startsWith("slack") ? "slack" : ["client_escalation", "important_email", "overdue_commitment", "decision_ask"].includes(kind) ? "email" : "dd";
        lots.push(item(`dd:x:${k}:${n}`, { kind, source, category: kind === "pending_approval" ? "approval" : "intervene", priority: { score: k * 12 + n, band: "normal", reasons: [] } }));
      }
    });
    const big = assembleSections(input({ attention: { items: lots, hiddenEmail: 0 }, overview: null, completed: null, approvals: {},
      slack: { state: "ok", digests: [], catchUp: null } }));
    const total = gatherItems(big);
    expect(total).toHaveLength(BRIEF_LIMITS.modelItemsMax);
    expect(total.map((i) => i.alias)).toContain("i80");
    const dropped = big.sections.reduce((n, s) => n + (s.stats.more ?? 0), 0);
    expect(dropped).toBe(lots.length - BRIEF_LIMITS.modelItemsMax);
    // The lowest scores went: every kept score is above every dropped one.
    const keptScores = total.map((i) => i.score);
    expect(Math.min(...keptScores)).toBe(lots.length - BRIEF_LIMITS.modelItemsMax);
  });
});

describe("GA03 thread ids and Slack keys", () => {
  it("threadIdsOf: the fingerprint, an outlook ref and a /executive/email/<t> DD ref → [t]", () => {
    expect(threadIdsOf("email:thread:th_1:msg_a", [], parseFp)).toEqual(["th_1"]);
    expect(threadIdsOf("dd:x", [{ system: "outlook", id: "th_1", url: null, label: "x", class: "private" }], parseFp)).toEqual(["th_1"]);
    expect(threadIdsOf("dd:x", [{ system: "dd", id: "/executive/email/th_1", url: null, label: "x", class: "private" }], parseFp)).toEqual(["th_1"]);
    expect(threadIdsOf("email:thread:th_1:msg_a", [
      { system: "outlook", id: "th_1", url: null, label: "x", class: "private" },
      { system: "dd", id: "/executive/email/th%2F2", url: null, label: "x", class: "private" },
      { system: "dd", id: "/tasks/t_1", url: null, label: "x", class: "internal" }
    ], parseFp)).toEqual(["th_1", "th/2"]);
    expect(threadIdsOf("email:commitment:th_9:cm_1", [], parseFp)).toEqual(["th_9"]);
    expect(threadIdsOf("email:satisfaction:cl_1", [], parseFp)).toEqual([]);
  });

  it("slackKeysOf: slack:msg:C1:1.2 → m:C1:1.2; a digest ref C1:d:<date> → d:C1:<date>; channel C1", () => {
    expect(slackKeysOf("slack:msg:C1:1.2", [])).toEqual({ keys: ["m:C1:1.2"], channels: ["C1"] });
    expect(slackKeysOf("slack:digest:C1:2026-11-05", [{ system: "slack", id: "C1:d:2026-11-05", url: null, label: "x", class: "public" }]))
      .toEqual({ keys: ["d:C1:2026-11-05"], channels: ["C1"] });
    expect(slackKeysOf("dd:x", [{ system: "slack", id: "C2:1794149000.000200", url: null, label: "x", class: "public" }]))
      .toEqual({ keys: ["m:C2:1794149000.000200"], channels: ["C2"] });
    expect(slackKeysOf("dd:x", [{ system: "dd", id: "C2:1.2", url: null, label: "x", class: "internal" }])).toEqual({ keys: [], channels: [] });
  });

  it("an input item carries no excerpt and only allow-listed links (N7)", () => {
    const sales = feed().find((i) => i.fingerprint === "slack:msg:C0SALES01:1794148000.000100")!;
    const one = inputItemFromAttention(sales, "slack", parseFp);
    expect(JSON.stringify(one)).not.toContain(BRIEF_TEXT_SENTINELS.excerpt);
    expect(one.refs[0]).toEqual({ system: "slack", id: "C0SALES01:1794148000.000100", url: null, label: "#sales", class: "private" });
    expect(one).toMatchObject({ slackKeys: ["m:C0SALES01:1794148000.000100"], slackChannels: ["C0SALES01"], untrusted: true, basis: "ai" });
    const evil = inputItemFromAttention(item("dd:y", { refs: [{ system: "dd", id: "/x", url: "https://evil.example/x", label: "x", class: "internal" }] }), "work", parseFp);
    expect(evil.refs[0].url).toBeNull();
    expect(evil.untrusted).toBe(false);
  });
});

describe("GA04 synthetic items", () => {
  it("the progress line names only the tiles that loaded", () => {
    const g = assembleSections(input());
    const progress = sectionOfGather(g, "progress").items[0];
    expect(progress.fingerprint).toBe("brief:progress:2026-11-06");
    expect(progress.title).toBe("4 tasks completed so far today and 7 created. 3 EODs submitted, 12.5 hours logged.");
    expect(progress.title).not.toContain("people active");
    const ov = overview();
    const tiles = (ov.sections.tiles as unknown as { ok: true; data: Record<string, unknown> }).data;
    tiles.createdToday = { ok: false, error: "unavailable" };
    tiles.activePeople = { ok: true, data: { count: 1, basis: "record" } };
    const g2 = assembleSections(input({ overview: ov }));
    expect(sectionOfGather(g2, "progress").items[0].title).toBe("4 tasks completed so far today. 1 person active, 3 EODs submitted, 12.5 hours logged.");
    expect(sectionOfGather(g2, "progress").items[0].stateHash).not.toBe(progress.stateHash);
  });

  it("completed yesterday: the count, and at most 5 titles (with their client) in ≤ 3 facts", () => {
    const g = assembleSections(input());
    const done = sectionOfGather(g, "work").items.find((i) => i.fingerprint === "brief:completed:2026-11-06")!;
    expect(done.title).toBe("6 tasks completed yesterday");
    expect(done.facts.length).toBeLessThanOrEqual(3);
    const titles = done.facts.flatMap((f) => f.split("; "));
    expect(titles.length).toBeLessThanOrEqual(5);
    expect(titles).toHaveLength(5);
    const names = (fixture.input.completed as { title: string; clientName: string | null }[]).map((t) => (t.clientName ? `${t.title} (${t.clientName})` : t.title));
    for (const t of titles) expect(names).toContain(t);
    expect(done.refs.length).toBeLessThanOrEqual(5);
    expect(done.refs.every((r) => r.system === "dd")).toBe(true);
    expect(sectionOfGather(g, "work").stats.completedYesterday).toBe(6);
  });

  it("deadlines not covered by a feed item, projects not on track, digests and email commitments", () => {
    const g = assembleSections(input());
    const work = fps(g, "work");
    expect(work).toContain("brief:deadline:t_dl1");
    expect(work).toContain("brief:deadline:t_dl2");
    expect(work).not.toContain("brief:deadline:t_incident7");   // the incident item cites the task
    const delayed = sectionOfGather(g, "delayed").items;
    expect(delayed.map((i) => i.fingerprint).sort()).toEqual(["brief:project:proj_delta", "brief:project:proj_eps"]);
    expect(delayed.find((i) => i.fingerprint === "brief:project:proj_delta")).toMatchObject({ band: "high", title: "Delta rebrand: 40% of open tasks overdue" });
    const slack = sectionOfGather(g, "slack").items;
    const digest = slack.find((i) => i.fingerprint === "slack:digest:C0OPS0001:2026-11-05")!;
    expect(digest).toMatchObject({ untrusted: true, basis: "ai", slackKeys: ["d:C0OPS0001:2026-11-05"], slackChannels: ["C0OPS0001"] });
    expect(digest.title.length).toBeLessThanOrEqual(200);
    expect(digest.facts).toEqual(["Decision: Launch moves to Monday", "Open question: Who tells Acme?"]);
  });

  it("a commitment already in the feed isn't duplicated; the direction stays in the text (AM-P8-28)", () => {
    const g = assembleSections(input());
    const commitments = sectionOfGather(g, "commitments").items;
    expect(commitments.filter((i) => i.fingerprint === "email:commitment:th_com4:cm_9")).toHaveLength(1);
    expect(commitments.find((i) => i.fingerprint === "email:commitment:th_com4:cm_9")!.kind).toBe("overdue_commitment");   // the feed's
    const owed = commitments.find((i) => i.fingerprint === "email:commitment:th_com5:cm_10")!;
    expect(owed).toMatchObject({ title: "Initech owes you: Initech will send the signed SOW", category: "delegated", threadIds: ["th_com5"], untrusted: true });
    // Without the feed item, his own email promise reads as his.
    const noFeed = assembleSections(input({ attention: { items: feed().filter((i) => !i.fingerprint.startsWith("email:commitment:")), hiddenEmail: 0 } }));
    const mine = sectionOfGather(noFeed, "commitments").items.find((i) => i.fingerprint === "email:commitment:th_com4:cm_9")!;
    expect(mine).toMatchObject({ title: "You promised Umbrella: Send Umbrella the audit", category: "my_action", band: "high" });
    // Slack commitments in the feed are commitments others owe him (P7a stores no other kind): nothing claims his own.
    for (const s of g.sections) for (const i of s.items) expect(i.title).not.toMatch(/you promised .*\(#/i);
    expect(sectionOfGather(g, "slack").stats.commitments).toBe(1);
  });
});

describe("GA05 section states", () => {
  const ovWithEmail = (email: unknown) => {
    const ov = overview();
    (ov.sections as unknown as Record<string, unknown>).email = email;
    return ov;
  };

  it("email off: emails not_connected + email_off with no item, ok + email_off with a DD item", () => {
    const off = ovWithEmail({ ok: true, data: { state: "off" } });
    const g = assembleSections(input({ overview: off, attention: { items: feed().filter((i) => i.source !== "email"), hiddenEmail: 0 } }));
    expect(sectionOfGather(g, "emails")).toMatchObject({ state: "not_connected", stateNote: "email_off", items: [] });
    expect(sectionOfGather(g, "client_requests")).toMatchObject({ state: "not_connected", stateNote: "email_off" });
    // decisions has DD and Slack items: ok, and the email state is noted.
    expect(sectionOfGather(g, "decisions")).toMatchObject({ state: "ok", stateNote: "email_off" });
    const withDd = assembleSections(input({ overview: off,
      attention: { items: [item("dd:odd:1", { kind: "important_email", category: "my_action", source: "dd" })], hiddenEmail: 0 } }));
    expect(sectionOfGather(withDd, "emails")).toMatchObject({ state: "ok", stateNote: "email_off" });
    expect(sectionOfGather(withDd, "emails").items).toHaveLength(1);
    const noPin = assembleSections(input({ overview: ovWithEmail({ ok: true, data: { state: "no_pin" } }), attention: { items: [], hiddenEmail: 0 } }));
    expect(sectionOfGather(noPin, "emails")).toMatchObject({ state: "not_connected", stateNote: "email_no_pin" });
    const failed = assembleSections(input({ overview: ovWithEmail({ ok: false, error: "unavailable" }), attention: { items: [], hiddenEmail: 0 } }));
    expect(sectionOfGather(failed, "emails")).toMatchObject({ state: "unavailable", stateNote: "email_unavailable" });
    const unscreenable = assembleSections(input({ attention: { items: [], hiddenEmail: 4, emailScreen: "unavailable" } }));
    expect(sectionOfGather(unscreenable, "emails")).toMatchObject({ state: "unavailable", stateNote: "email_unavailable" });
  });

  it("Slack: reading_off → off, not_connected → not_connected, an unavailable read → unavailable, ok → ok", () => {
    const at = (state: AssembleInput["slack"]["state"], digests: AssembleInput["slack"]["digests"] = []) =>
      sectionOfGather(assembleSections(input({ slack: { state, digests, catchUp: null }, attention: { items: [], hiddenEmail: 0 } })), "slack");
    expect(at("reading_off")).toMatchObject({ state: "off", stateNote: "slack_reading_off" });
    expect(at("not_connected")).toMatchObject({ state: "not_connected", stateNote: "slack_not_connected" });
    expect(at("not_installed")).toMatchObject({ state: "not_connected", stateNote: "slack_not_installed" });
    expect(at("discovering")).toMatchObject({ state: "not_connected", stateNote: "slack_discovering" });
    expect(at("reading_revoked")).toMatchObject({ state: "off", stateNote: "slack_reading_revoked" });
    expect(at("unavailable", null)).toMatchObject({ state: "unavailable", stateNote: "slack_unavailable" });
    expect(at("ok", null)).toMatchObject({ state: "unavailable", stateNote: "slack_unavailable" });   // the digests read failed
    expect(at("ok")).toMatchObject({ state: "ok", stateNote: null, items: [] });                      // live, nothing: "Nothing new."
  });

  it("a failed DD read → unavailable, never 'nothing'; ddtext off is noted on blockers; a live empty section is ok", () => {
    const g = assembleSections(input({ attention: null, overview: null, completed: null }));
    for (const key of ["emails", "client_requests", "blockers", "decisions", "commitments", "work", "progress", "delayed"] as const) {
      expect(sectionOfGather(g, key), key).toMatchObject({ state: "unavailable", items: [] });
    }
    // Approvals still has its itemized lists: shown, with the feed's failure noted.
    expect(sectionOfGather(g, "approvals")).toMatchObject({ state: "ok", stateNote: "unavailable" });
    expect(sectionOfGather(g, "slack")).toMatchObject({ state: "ok", stateNote: "slack_unavailable" });   // digests still came
    expect(g.failures).toEqual(expect.arrayContaining(["attention", "overview", "completed"]));
    const off = assembleSections(input({ ddtextOn: false }));
    expect(sectionOfGather(off, "blockers")).toMatchObject({ state: "ok", stateNote: "ddtext_off" });
    const quiet = assembleSections(input({ attention: { items: [], hiddenEmail: 0 }, ddtextOn: true }));
    expect(sectionOfGather(quiet, "blockers")).toMatchObject({ state: "ok", stateNote: null, items: [] });
    expect(g.sections.map((s) => s.key)).toEqual([...BRIEF_SECTION_KEYS]);
  });
});

describe("GA11 restricted email (C26)", () => {
  it("= the Overview's restricted count + the feed's hiddenEmail; either unreadable → null", () => {
    expect(assembleSections(input()).restrictedEmail).toBe(3);
    const ov = overview();
    (ov.sections.email as { ok: true; data: { restricted: unknown } }).data.restricted = { ok: false, error: "unavailable" };
    expect(assembleSections(input({ overview: ov })).restrictedEmail).toBeNull();
    expect(assembleSections(input({ attention: null })).restrictedEmail).toBeNull();
    expect(assembleSections(input({ overview: null })).restrictedEmail).toBeNull();
  });

  it("GA11 (fixer ui-1) an email screen that couldn't run: its withheld items aren't counted as restricted (only the Overview's count)", () => {
    const base = input();
    const att = base.attention as NonNullable<AssembleInput["attention"]>;
    const withHidden = assembleSections(input({ attention: { ...att, hiddenEmail: 5, emailScreen: "ok" } })).restrictedEmail;
    const unscreened = assembleSections(input({ attention: { ...att, hiddenEmail: 5, emailScreen: "unavailable" } })).restrictedEmail;
    expect(typeof withHidden === "number" && typeof unscreened === "number" && withHidden - unscreened).toBe(5);
  });

  it("slackUnanswered = Slack requests + decisions from the surface-'slack' feed (AM-P8-12); unknown without the feed or Slack", () => {
    const g = assembleSections(input());
    expect(g.slackUnanswered).toBe(2);
    expect(sectionOfGather(g, "slack").stats).toEqual({ requests: 1, decisions: 1, commitments: 1, notAssessed: 1 });
    expect(assembleSections(input({ attention: null })).slackUnanswered).toBeNull();
    expect(assembleSections(input({ slack: { state: "reading_off", digests: [], catchUp: null } })).slackUnanswered).toBeNull();
    expect(assembleSections(input({ attention: { items: feed(), hiddenEmail: 1, slackScreen: "unavailable" } })).slackUnanswered).toBeNull();
  });
});

const verdictsAll = (g: BriefGather, v: NoveltyVerdict = "new") => new Map(gatherItems(g).map((i) => [i.fingerprint, v] as const));

describe("GA13 deterministicTop3 (M4)", () => {
  it("only my_action / approval / intervene, by score, distinct fingerprints, ≤ 3; fewer eligible → fewer", () => {
    const g = assembleSections(input());
    const top = deterministicTop3(gatherItems(g), verdictsAll(g));
    expect(top.map((i) => i.fingerprint)).toEqual(["dd:incident:task:t_incident7", "email:thread:th_escal2:msg_e2", "dd:site:acme.example"]);
    const mk = (fp: string, category: BriefInputItem["category"], score: number) => ({ ...gatherItems(g)[0], fingerprint: fp, alias: fp, category, score });
    const few = [mk("a", "delegated", 99), mk("b", "fyi", 98), mk("c", "approval", 10), mk("c", "approval", 10), mk("d", "my_action", 10)];
    expect(deterministicTop3(few, new Map()).map((i) => i.fingerprint)).toEqual(["c", "d"]);
    expect(deterministicTop3([], new Map())).toEqual([]);
  });
});

describe("GA14 composeDeterministic", () => {
  it("lines = titles with their basis; pending lines; unchanged counts; mode deterministic with the reason (BC18: ≤ 280, kind fact)", () => {
    const g = assembleSections(input());
    const verdicts = verdictsAll(g);
    verdicts.set("dd:approval:checkins", "pending");
    verdicts.set("dd:stalled:assignee:u_bob", "unchanged");
    const long = gatherItems(g).find((i) => i.fingerprint === "dd:site:acme.example")!;
    long.title = "x".repeat(400);
    const c = composeDeterministic(g, verdicts, { rev: 2, builtAt: "2026-11-06T13:05:00.000Z", trigger: "schedule", reason: "timeout" });
    expect(c).toMatchObject({ v: 1, mode: "deterministic", modeReason: "timeout", headline: null, rev: 2, trigger: "schedule", top3Fallback: false });
    expect(c.sections.map((s) => s.key)).toEqual([...BRIEF_SECTION_KEYS]);
    const approvals = c.sections.find((s) => s.key === "approvals")!;
    expect(approvals.pending.map((p) => p.fp)).toEqual(["dd:approval:checkins"]);
    expect(approvals.items.map((i) => i.fps[0])).not.toContain("dd:approval:checkins");
    expect(c.sections.find((s) => s.key === "work")!.unchanged).toBe(1);
    const incident = c.sections.find((s) => s.key === "blockers")!.items.find((i) => i.fps[0] === "dd:incident:task:t_incident7")!;
    expect(incident).toMatchObject({ text: "Incident: checkout form down for Acme", kind: "fact", basis: "record", band: "critical" });
    const ddtext = c.sections.find((s) => s.key === "blockers")!.items.find((i) => i.fps[0] === "dd:ddtext:blocker:comment:cm_1")!;
    expect(ddtext.basis).toBe("ai");
    for (const s of c.sections) for (const i of s.items) {
      expect(i.text.length).toBeLessThanOrEqual(BRIEF_LIMITS.itemTextChars);
      expect(["fact", "recommendation"]).toContain(i.kind);
    }
    expect(c.sections.flatMap((s) => s.items).find((i) => i.fps[0] === "dd:site:acme.example")!.text).toHaveLength(BRIEF_LIMITS.itemTextChars);
    expect(c.top3.map((t) => t.fp)).toEqual(["dd:incident:task:t_incident7", "email:thread:th_escal2:msg_e2", "dd:site:acme.example"]);
    expect(c.top3[0].itemId).toBe(incident.id);
    expect(c.counts).toMatchObject({ pending: 1, unchanged: 1, restrictedEmail: 3, slackUnanswered: 2 });
    expect(Object.keys(c.novelty)).toHaveLength(gatherItems(g).length);
    expect(c.failures).toEqual(g.failures);
    const ids = c.sections.flatMap((s) => s.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("at most 8 lines per section; the rest counted in more", () => {
    const many: AttentionFeedItem[] = [];
    for (let n = 0; n < 11; n++) many.push(item(`dd:incident:task:t_${n}`, { kind: "open_incident", category: "intervene", priority: { score: 50 + n, band: "high", reasons: [] } }));
    const g = assembleSections(input({ attention: { items: many, hiddenEmail: 0 } }));
    const c = composeDeterministic(g, verdictsAll(g), { rev: 1, builtAt: "2026-11-06T13:05:00.000Z", trigger: "schedule", reason: "budget" });
    const blockers = c.sections.find((s) => s.key === "blockers")!;
    expect(blockers.items).toHaveLength(BRIEF_LIMITS.itemsPerSectionStored);
    expect(blockers.more).toBe(3);
  });
});

describe("GA15 contentRefs", () => {
  it("unions items, pending lines and top 3 (sorted, distinct)", () => {
    const g = assembleSections(input());
    const verdicts = verdictsAll(g);
    verdicts.set("email:thread:th_dec3:msg_d3", "pending");
    const c = composeDeterministic(g, verdicts, { rev: 1, builtAt: "2026-11-06T13:05:00.000Z", trigger: "schedule", reason: "refused" });
    // Only the top 3 cites th_x (an entry with no line of its own).
    c.top3.push({ itemId: null, alias: "i99", fp: "fp:x", title: "t", next: null, refs: [], threadIds: ["th_x"], slackKeys: ["m:C9:1.1"], slackChannels: ["C9"] });
    const r = contentRefs(c);
    expect(r.threadIds).toEqual(expect.arrayContaining(["th_dec3", "th_escal2", "th_imp1", "th_x"]));
    expect(r.slackKeys).toEqual(expect.arrayContaining(["d:C0OPS0001:2026-11-05", "m:C0SALES01:1794148000.000100", "m:C9:1.1"]));
    expect(r.slackChannels).toEqual(expect.arrayContaining(["C0OPS0001", "C0SALES01", "C9"]));
    expect([...r.threadIds].sort()).toEqual(r.threadIds);
    expect(new Set(r.slackKeys).size).toBe(r.slackKeys.length);
    expect(contentRefs({ ...c, sections: [], top3: [] })).toEqual({ threadIds: [], slackKeys: [], slackChannels: [] });
  });

  it("no gather output carries a sentinel the fixture planted outside its text fields (excerpt, tokens)", () => {
    const g = assembleSections(input());
    assertNoBriefText(g, { allow: ["emailSubject", "digestSummary"] });
  });
});
