import { describe, expect, it } from "vitest";

import { SLACK_TEXT_SENTINELS as S, findSlackText } from "@/lib/exec/__tests__/slack-read-assert";
import { NOW, NOW_MS, channelRow, itemRow } from "@/lib/exec/__tests__/slack-read-jobs";
import { buildSlackCandidates } from "@/lib/exec/producers/slack";
import { scorePriority } from "@/lib/exec/priority";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import { msToTs, type ChannelRow, type SlackItemRow } from "@/lib/exec/slack-read-types";

// P7a contract §3.13, §5.14 AT01-AT09, AT12, §5.12 EX03, §5.11 CC06 (Area D): the Slack attention producer (pure).

const A = SLACK_READ_COPY.attention;
const DAY = 86_400_000;
const tsAgo = (days: number) => msToTs(NOW_MS - days * DAY - 60_000);
const channels = (...rows: ChannelRow[]) => new Map(rows.map((r) => [r.channelId, r]));
const GENERAL = channelRow({ channelId: "C0GENERAL", name: "general" });
const IM = channelRow({ channelId: "D0JANE", convType: "im", isPrivate: true, name: null });
const MPIM = channelRow({ channelId: "G0MPIM", convType: "mpim", isPrivate: true, name: null });
const run = (items: SlackItemRow[], chs = channels(GENERAL, IM, MPIM)) => buildSlackCandidates({ items, channels: chs, now: NOW, tz: "America/New_York" });

describe("AT01-AT02: one candidate per message, by precedence; the fingerprint and scope", () => {
  it("decision > request|question|action_item > commitment > unassessed; fyi-only → none", () => {
    const ts = tsAgo(1);
    const base = { channelId: "C0GENERAL", ts };
    expect(run([itemRow({ ...base, kind: "request" }), itemRow({ ...base, kind: "decision" })]).map((c) => c.kind)).toEqual(["slack_decision"]);
    expect(run([itemRow({ ...base, kind: "question" }), itemRow({ ...base, kind: "commitment", dueAt: new Date(NOW_MS - DAY).toISOString(), commitmentDirection: "owed_to_mitchell" })])
      .map((c) => c.kind)).toEqual(["slack_request"]);
    expect(run([itemRow({ ...base, kind: "request", assessed: false, summary: null, excerpt: null }),
      itemRow({ ...base, kind: "commitment", dueAt: new Date(NOW_MS - DAY).toISOString(), commitmentDirection: "owed_to_mitchell" })]).map((c) => c.kind))
      .toEqual(["slack_commitment"]);
    expect(run([itemRow({ ...base, kind: "action_item" })]).map((c) => c.kind)).toEqual(["slack_request"]);
    expect(run([itemRow({ ...base, kind: "fyi" })])).toEqual([]);
    const two = run([itemRow({ ...base, kind: "request" }), itemRow({ channelId: "D0JANE", ts, kind: "request" })]);
    expect(two.map((c) => c.fingerprint).sort()).toEqual([`slack:msg:C0GENERAL:${ts}`, `slack:msg:D0JANE:${ts}`]);
    expect(two.every((c) => c.source === "slack")).toBe(true);
  });

  it("a conversation that is no longer readable (no row, deny, unclassified, hub) produces nothing (N1)", () => {
    const ts = tsAgo(1);
    for (const cls of ["deny", "unclassified", "hub"] as const) {
      expect(run([itemRow({ ts, channelId: "C0X" })], channels(channelRow({ channelId: "C0X", class: cls })))).toEqual([]);
    }
    expect(run([itemRow({ ts, channelId: "C0MISSING" })])).toEqual([]);
  });
});

describe("AT03-AT04: open while unanswered and fresh; commitments by due date", () => {
  it("AT03 answered items produce nothing; a 15-day-old request produces nothing", () => {
    expect(run([itemRow({ ts: tsAgo(1), respondedTs: "1794149999.000100", respondedAt: NOW.toISOString() })])).toEqual([]);
    expect(run([itemRow({ ts: tsAgo(15) })])).toEqual([]);
    expect(run([itemRow({ ts: tsAgo(13) })])).toHaveLength(1);
  });

  it("AT04 before due → none; 3 days overdue → slack_commitment, Overdue 3 day(s); 31 days → none; owed_to_mitchell → delegated", () => {
    const c = (dueDays: number, dir: "mitchell_owes" | "owed_to_mitchell", over: Partial<SlackItemRow> = {}) =>
      itemRow({ ts: tsAgo(5), kind: "commitment", commitmentDirection: dir, dueAt: new Date(NOW_MS - dueDays * DAY).toISOString(), ...over });
    expect(run([c(-1, "mitchell_owes")])).toEqual([]);
    const three = run([c(3, "mitchell_owes")]);
    expect(three.map((x) => [x.kind, x.category])).toEqual([["slack_commitment", "my_action"]]);
    expect(three[0].facts.map((f) => f.text)).toContain("Overdue 3 day(s)");
    expect(run([c(31, "owed_to_mitchell")])).toEqual([]);
    expect(run([c(3, "owed_to_mitchell")]).map((x) => x.category)).toEqual(["delegated"]);
    // His own commitment, answered by his later message: closed. Owed to him: still open until 30 days overdue.
    expect(run([c(3, "mitchell_owes", { respondedTs: "1794149999.000100", respondedAt: NOW.toISOString() })])).toEqual([]);
    expect(run([c(3, "owed_to_mitchell", { respondedTs: "1794149999.000100", respondedAt: NOW.toISOString() })])).toHaveLength(1);
  });
});

describe("AT05-AT06: titles and finance", () => {
  it("AT05 titles per conversation and kind, with the author's label and #name", () => {
    const ts = tsAgo(1);
    const [dm] = run([itemRow({ channelId: "D0JANE", ts, authorLabel: "Jane Doe" })]);
    expect(dm.title).toBe("Slack DM from Jane Doe");
    const [group] = run([itemRow({ channelId: "G0MPIM", ts, authorLabel: "Jane Doe" })]);
    expect(group.title).toBe("Jane Doe in a Slack group DM");
    const [mention] = run([itemRow({ channelId: "C0GENERAL", ts, authorLabel: "Jane Doe" })]);
    expect(mention.title).toBe("Jane Doe mentioned you in #general");
    const [thread] = run([itemRow({ channelId: "C0GENERAL", ts, threadTs: "1794100000.000100", authorLabel: "Jane Doe" })]);
    expect(thread.title).toBe("Jane Doe replied in your thread in #general");
    const [decision] = run([itemRow({ channelId: "C0GENERAL", ts, kind: "decision", authorLabel: "Jane Doe" })]);
    expect(decision.title).toBe("Jane Doe asked you to decide (#general)");
    expect(decision.category).toBe("approval");
    expect(decision.recommendedNext).toBe(A.decideInSlack);
    const [ext] = run([itemRow({ channelId: "C0GENERAL", ts, authorExternal: true, authorLabel: "Jane Doe" })]);
    expect(ext.title).toBe("External member mentioned you in #general");
    const due = new Date(NOW_MS - 2 * DAY).toISOString();
    expect(run([itemRow({ channelId: "D0JANE", ts, kind: "commitment", commitmentDirection: "mitchell_owes", dueAt: due, authorLabel: "Jane Doe" })])[0].title)
      .toBe("You said you'd follow up with Jane Doe (a direct message)");
    expect(run([itemRow({ channelId: "D0JANE", ts, kind: "commitment", commitmentDirection: "owed_to_mitchell", dueAt: due, authorLabel: "Jane Doe" })])[0].title)
      .toBe("Jane Doe owes you a follow-up (a direct message)");
  });

  it("CC06 unassessed items: slack_unassessed, the not-assessed suffix and copy, no AI fact", () => {
    const [u] = run([itemRow({ channelId: "D0JANE", ts: tsAgo(1), assessed: false, summary: null, excerpt: null, authorLabel: "Jane Doe" })]);
    expect(u.kind).toBe("slack_unassessed");
    expect(u.title).toBe(`Slack DM from Jane Doe${A.suffixNotAssessed}`);
    expect(u.whatHappened).toBe(A.notAssessed);
    expect(u.facts.some((f) => f.basis === "ai")).toBe(false);
  });

  it("AT06 a finance item (class finance, or a Slack Connect finance name): neutral title, financeWhat, no AI fact, ref class finance", () => {
    const ts = tsAgo(1);
    for (const ch of [channelRow({ channelId: "C0FIN", class: "finance", name: "finance" }),
      channelRow({ channelId: "C0FIN", class: "external", financeName: true, isExtShared: true, extEver: true, name: "partner-billing" })]) {
      const [c] = run([itemRow({ channelId: "C0FIN", ts, sourceClass: ch.class === "finance" ? "finance" : "private" })], channels(ch));
      expect(c.title).toBe(A.titleFinance);
      expect(c.whatHappened).toBe(A.financeWhat);
      expect(c.facts.some((f) => f.basis === "ai")).toBe(false);
      expect(c.refs.map((r) => r.class)).toEqual(["finance"]);
    }
  });
});

describe("AT07-AT09: priority, refs, stateHash", () => {
  it("AT07 bases 45/40/30/40, age points, the AI urgency reason, bands at 50/75", () => {
    const ts = tsAgo(3);
    const due = new Date(NOW_MS - 4 * DAY).toISOString();
    const by = (items: SlackItemRow[]) => run(items)[0].priority;
    const decision = by([itemRow({ ts, kind: "decision", urgency: "high" })]);
    expect(decision).toEqual(scorePriority({ kind: "slack_decision", ageDays: 3, urgency: "high", aboutPrincipal: true }));
    expect(decision.reasons[0]).toBe("Decision asked of you in Slack (base 45)");
    expect(decision.reasons).toContain("High urgency (AI-assessed) (+12)");
    expect(decision.reasons).toContain("Decision waiting 3 days (+6)");
    expect(decision).toMatchObject({ score: 73, band: "high" });
    const request = by([itemRow({ ts, urgency: "critical" })]);
    expect(request).toMatchObject({ score: 81, band: "critical" });
    expect(request.reasons).toContain("Unanswered for 3 days (+6)");
    expect(by([itemRow({ ts, kind: "commitment", commitmentDirection: "owed_to_mitchell", dueAt: due })]).reasons)
      .toEqual(["Slack commitment (base 30)", "Involves you (+10)", "Follow-up overdue 4 days (+8)"]);
    const unassessed = by([itemRow({ ts, assessed: false, urgency: "critical", summary: null, excerpt: null })]);
    expect(unassessed.reasons).toEqual(["Slack message (not assessed) (base 40)", "Involves you (+10)", "Unanswered for 3 days (+6)"]);
    expect(unassessed.band).toBe("high");
  });

  it("AT08 refs: one slackMessageRef with the permalink when stored, isPrivate from sourceClass, never an excerpt", () => {
    const ts = tsAgo(1);
    const link = "https://scaledai.slack.com/archives/C0GENERAL/p1794150001000101";
    const [pub] = run([itemRow({ ts, permalink: link, sourceClass: "public" })]);
    expect(pub.refs).toEqual([{ system: "slack", id: `C0GENERAL:${ts}`, url: link, label: "#general", class: "public" }]);
    const [priv] = run([itemRow({ channelId: "D0JANE", ts, sourceClass: "private" })]);
    expect(priv.refs).toEqual([{ system: "slack", id: `D0JANE:${ts}`, url: null, label: "a direct message", class: "private" }]);
    expect(pub.refs[0]).not.toHaveProperty("excerpt");
  });

  it("AT09 stateHash changes on urgency, acknowledgement and assessment, not on a re-run", () => {
    const ts = tsAgo(1);
    const h = (over: Partial<SlackItemRow>) => run([itemRow({ id: "esl_1", ts, ...over })])[0].stateHash;
    expect(h({})).toBe(h({}));
    expect(h({ urgency: "high" })).not.toBe(h({}));
    expect(h({ acknowledgedAt: NOW.toISOString() })).not.toBe(h({}));
    expect(h({ assessed: false, summary: null, excerpt: null })).not.toBe(h({}));
  });

  it("C40: his reaction adds a record fact; the sent fact is a record with the ref; the age is derived", () => {
    const [c] = run([itemRow({ channelId: "D0JANE", ts: tsAgo(2), acknowledgedAt: NOW.toISOString() })]);
    expect(c.facts.map((f) => [f.basis, f.text.startsWith("Sent ") ? "Sent" : f.text])).toEqual([
      ["record", "Sent"], ["derived", "Unanswered for 2 day(s)"], ["ai", S.summary], ["record", A.factReacted]
    ]);
    expect(c.facts[0].text).toContain("in a direct message");
    expect(c.occurredAt).toBe(new Date(Number(tsAgo(2).split(".")[0]) * 1000).toISOString());
  });
});

describe("EX03 / AT12: no excerpt anywhere; only slack:msg: fingerprints", () => {
  it("EX03 an item whose excerpt is the sentinel: no title, fact, ref or recommendation carries it", () => {
    const ts = tsAgo(1);
    const out = run([itemRow({ ts, excerpt: S.excerpt, dueText: S.dueText }), itemRow({ channelId: "D0JANE", ts, kind: "decision", excerpt: S.excerpt })]);
    expect(out).toHaveLength(2);
    expect(findSlackText(out, { allow: ["summary", "authorName", "channelName"] })).toEqual([]);
    for (const c of out) for (const r of c.refs) expect(r.excerpt).toBeUndefined();
  });

  it("AT12 every fingerprint is slack:msg:<channel>:<ts> (P7b's slack:digest:… kinds are never produced here)", () => {
    const out = run([itemRow({ ts: tsAgo(1) }), itemRow({ channelId: "D0JANE", ts: tsAgo(2), kind: "decision" })]);
    for (const c of out) expect(c.fingerprint).toMatch(/^slack:msg:[CGD][A-Z0-9]+:[0-9]+\.[0-9]+$/);
  });
});
