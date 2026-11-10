import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/slack", () => ({ postMessage: vi.fn(async () => ({ ts: "1794150000.000100" })) }));

import { briefContent, checkinId, TZ } from "@/lib/exec/__tests__/brief-d-harness";
import { postProcessCheckinText } from "@/lib/exec/brief-checkins";
import { NO_SCREEN } from "@/lib/exec/brief-screen";
import {
  briefDmToView,
  renderBriefDm,
  renderCheckinPost,
  renderCheckinsMessage,
  renderFallbackMiniBrief,
  type FallbackMiniBrief
} from "@/lib/exec/brief-slack-ui";
import type { BriefContent, CheckinView } from "@/lib/exec/brief-types";
import { __resetOpsAlertsForTests, notifyOps } from "@/lib/exec/ops";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { renderAnswer, renderDraftCard, renderNote, renderOwnerHome, renderProposalCard, type OwnerHomeInput } from "@/lib/exec/slack-ui";
import type { SlackHomeView, SlackMessageParts } from "@/lib/exec/slack-types";
import { postInDm } from "@/lib/exec/sources/slack";
import { postMessage } from "@/lib/slack";

import { done as chatDone, proposal } from "./chat-ui-fixtures";
import { draftView, recipient } from "./drafts-ui-fixtures";
import { installFakeSlack } from "./fake-slack-api";
import { EMAILS, HOSTILE_URLS, SLACK, SLACK_CONTROL, TAG_SMUGGLED, ZWSP } from "./fixtures/hostile/corpus";
import { assertDmBudget } from "./brief-assert";
import { assertSlackParts } from "./slack-assert";

// P9 §2.1 suite 4 (Area B): every Block Kit renderer fed the hostile corpus. P6's shared rules hold (verbatim: true on every
// mrkdwn object, no raw "<" except an allow-listed slackLink, fixed fallback text); no "<!", "<@", "<#" or "<http" survives;
// every URL-like token sits in a code span; postInDm sends unfurl_links, unfurl_media and link_names false; the draft card
// shows each recipient by address and lists Cc (F10); notifyOps posts its title and detail escaped (P9 ops hardening).

const HOSTILE = [
  ...Object.values(HOSTILE_URLS), ...SLACK_CONTROL, "*bold* _it_ `tick", `zero${ZWSP}width ${TAG_SMUGGLED}`, "write to attacker@evil.example"
].join(" ");
const DD = "https://operations.scaledai.org";

/** Every mrkdwn text of a message or Home view (the texts Slack parses; plain_text headers and button labels are literal). */
function textsOf(parts: SlackMessageParts | SlackHomeView): string[] {
  const out: string[] = [];
  for (const b of parts.blocks) {
    if (b.type === "section") out.push(b.text.text);
    else if (b.type === "context") out.push(...b.elements.map((e) => e.text));
  }
  return out;
}

/** Every mrkdwn object of a message or view: each must carry verbatim: true. */
function mrkdwnObjects(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) for (const x of v) mrkdwnObjects(x, out);
  else if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "mrkdwn") out.push(o);
    for (const x of Object.values(o)) mrkdwnObjects(x, out);
  }
  return out;
}

/** The suite-4 rules over one renderer's output, on top of P6's shared checks (P8's brief messages carry their own fixed
 *  fallback text, so they go through brief-assert's assertDmBudget, which is P6's rules plus the block budget). */
function expectInert(label: string, parts: SlackMessageParts | SlackHomeView, opts: { brief?: boolean } = {}): void {
  if (opts.brief) assertDmBudget(parts as SlackMessageParts, 50, { anyText: true });
  else assertSlackParts(parts);
  for (const o of mrkdwnObjects(parts)) expect(o.verbatim, `${label}: a mrkdwn object without verbatim: true`).toBe(true);
  for (const text of textsOf(parts)) {
    // An allow-listed link is the only "<…>" Slack may parse.
    const links = [...text.matchAll(/<(https:\/\/[^|>\s]+)\|[^>]*>/g)];
    for (const m of links) expect(isAllowedLinkUrl(m[1].replace(/&amp;/g, "&")), `${label}: a link to ${m[1]}`).toBe(true);
    const rest = text.replace(/<https:\/\/[^|>\s]+\|[^>]*>/g, " ");
    for (const control of ["<!", "<@", "<#", "<http"]) expect(rest.includes(control), `${label}: ${control} survived`).toBe(false);
    const outside = rest.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, " ");
    expect(outside, `${label}: a URL-like token outside a code span`).not.toMatch(/https?:\/\/|\bwww\.|(?<![\w@.-])(?:[a-z0-9-]+\.)+(?:example|ly|com|org)\b(?!\.)/i);
    expect(text.includes(ZWSP), `${label}: a zero-width character survived`).toBe(false);
  }
}

describe("§2.1 suite 4: slack-ui renderers", () => {
  it("an answer echoing the corpus, with hostile source labels and urls", () => {
    const parts = renderAnswer(chatDone({
      messageId: `ecm_${"e".repeat(32)}`, answer: `${HOSTILE}\n\n${EMAILS.E6.bodyText}\n\n${SLACK.S3.text}`, recommendations: HOSTILE,
      sources: [
        { n: 1, ref: "r1", source: { system: "dd", id: "t_1", url: `${DD}/tasks/t_1`, label: "<!channel> task", class: "internal" } },
        { n: 2, ref: "r2", source: { system: "outlook", id: "x", url: HOSTILE_URLS.https, label: HOSTILE_URLS.bitly, class: "private" } },
        { n: 3, ref: "r3", source: { system: "slack", id: "C0:1", url: HOSTILE_URLS.slackArchiveFrag, label: "#general", class: "public" } }
      ]
    }), { feedback: null });
    expectInert("answer", parts);
  });

  it("the draft card: hostile body, note, subject and display names; each recipient by address first, Cc listed (F10)", () => {
    const parts = renderDraftCard(draftView({
      bodyText: `${HOSTILE}\n${EMAILS.E3.bodyText}`, noteForMitchell: HOSTILE, subject: `Re: ${SLACK_CONTROL.join(" ")}`,
      to: [recipient(EMAILS.E4.from.email, EMAILS.E4.from.name ?? "")], cc: [recipient("boss@evil.example", "<!here> Boss")],
      capabilities: { canSave: true, canRegenerate: true }
    }), { draftId: draftView().id });
    expectInert("draft card", parts);
    const header = parts.blocks.flatMap((b) => (b.type === "context" ? b.elements.map((e) => e.text) : []))[0];
    expect(header.startsWith("To: `x@evil.example` (`accounts@acmedental.com`)")).toBe(true);
    expect(header).toContain("Cc: `boss@evil.example` (&lt;!here&gt; Boss)");
  });

  it("the proposal card (E7's task injection as its title and description), notes and the owner's App Home", () => {
    expectInert("proposal", renderProposalCard(proposal({ title: EMAILS.E7.bodyText, description: HOSTILE, assigneeName: "<@U0JANE>", clientName: HOSTILE_URLS.bare }),
      { proposalId: proposal().id }));
    expectInert("note", renderNote("failed"));
    const home: OwnerHomeInput = {
      attention: { ok: true, hiddenEmail: 1, emailScreen: "ok", items: [
        { band: "critical", title: SLACK.S1.text, href: `${DD}/tasks/t_1` },
        { band: "high", title: HOSTILE, href: HOSTILE_URLS.https },
        { band: "normal", title: EMAILS.E6.bodyText, href: HOSTILE_URLS.ddDoubleSlash }
      ] },
      email: { state: "on", counts: { reply: 1, urgent: 0, important: 0, waiting: 0 }, restricted: 2 },
      updatedAt: "2026-11-07T15:04:00.000Z", timezone: "America/New_York"
    };
    expectInert("home", renderOwnerHome(home));
  });
});

describe("§2.1 suite 4: the brief DM, check-in cards and the DD-bot mini-brief (brief-slack-ui)", () => {
  it("brief lines carrying the corpus render inert; a line's link only when its url is allow-listed", () => {
    const c = briefContent() as BriefContent;
    const sections = c.sections.map((s, i) => (i === 0 ? {
      ...s, items: [
        { ...(s.items[0] ?? {}), id: "b1", text: HOSTILE, kind: "fact", basis: "ai", band: "high", aliases: [], fps: [], threadIds: [], slackKeys: [], slackChannels: [],
          refs: [{ system: "dd", id: "t_1", url: HOSTILE_URLS.https, label: "<!here>", class: "internal" }, { system: "dd", id: "t_2", url: `${DD}/tasks/t_2`, label: "ok", class: "internal" }] }
      ]
    } : s));
    const parts = renderBriefDm(briefDmToView({ ...c, headline: SLACK.S1.text, sections } as BriefContent, { tz: TZ, briefHref: `${DD}/executive/brief`, screen: NO_SCREEN }));
    expectInert("brief dm", parts, { brief: true });
  });

  it("the check-ins message and a posted check-in (model text) render inert", () => {
    const rows: CheckinView[] = [{ id: checkinId(1), firstName: "<@U0ANN> Ann", text: HOSTILE, status: "proposed", statusReason: null, sentAt: null, value: `c1.${checkinId(1)}.1.${"a".repeat(32)}` }];
    expectInert("checkins", renderCheckinsMessage({ rows, paused: null, tz: TZ }), { brief: true });
    // A posted check-in is his own message: its text is the stored note, which postProcessCheckinText already cleaned.
    expectInert("checkin post", renderCheckinPost(postProcessCheckinText(`Hi Ann, ${HOSTILE}`) ?? ""), { brief: true });
  });

  it("the DD-bot mini-brief: hostile task titles and a non-DD href", () => {
    const mini: FallbackMiniBrief = {
      prettyDate: "Monday, Nov 9", bands: { critical: 1, high: 1, normal: 1 },
      ddTitles: [{ title: HOSTILE, href: `${DD}/tasks/1` }, { title: SLACK.S6.text, href: HOSTILE_URLS.https }],
      email: 1, slack: 1, approvals: 1, restrictedEmail: 1, execHref: `${DD}/executive`
    };
    expectInert("mini-brief", renderFallbackMiniBrief(mini), { brief: true });
  });
});

describe("§2.1 suite 4: postInDm and the ops channel", () => {
  let slack: ReturnType<typeof installFakeSlack> | null = null;
  afterEach(() => {
    slack?.restore();
    slack = null;
    vi.unstubAllEnvs();
    __resetOpsAlertsForTests();
  });

  it("postInDm sends unfurl_links, unfurl_media and link_names false (and only to the DM)", async () => {
    slack = installFakeSlack({ "chat.postMessage": () => ({ ok: true, ts: "1794150000.000200", channel: "D0MITCH" }) });
    const parts = renderAnswer(chatDone({ messageId: `ecm_${"e".repeat(32)}`, answer: HOSTILE }), { feedback: null });
    await postInDm({ token: "xoxb-test-only", dmChannelId: "D0MITCH" } as never, { channel: "D0MITCH", ...parts });
    expect(slack.calls).toHaveLength(1);
    const body = slack.calls[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ channel: "D0MITCH", unfurl_links: false, unfurl_media: false, link_names: false });
    await expect(postInDm({ token: "xoxb-test-only", dmChannelId: "D0MITCH" } as never, { channel: "C0GENERAL", ...parts })).rejects.toThrow();
    expect(slack.calls).toHaveLength(1);
  });

  beforeEach(() => {
    vi.mocked(postMessage).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("notifyOps escapes its title and detail: an error string with <!channel> or <https://x|y> reaches the ops channel inert", async () => {
    vi.stubEnv("EXEC_OPS_SLACK_CHANNEL", "C0OPS");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-only");
    const posted = await notifyOps({ key: "p9-ops-escape", title: "job dead <!channel> & more", detail: "error: <https://evil.example|click> <@U0JANE> <#C0GEN|general>" });
    expect(posted).toBe(true);
    const text = vi.mocked(postMessage).mock.calls[0][1];
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&lt;https://evil.example|click&gt;");
    expect(text).toContain("&amp; more");
  });

  it("notifyOps never ends its text inside an entity when it clips", async () => {
    vi.stubEnv("EXEC_OPS_SLACK_CHANNEL", "C0OPS");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test-only");
    for (let pad = 0; pad < 6; pad += 1) {
      __resetOpsAlertsForTests();
      vi.mocked(postMessage).mockClear();
      await notifyOps({ key: `p9-ops-clip-${pad}`, title: `${"x".repeat(2_880 + pad)}<<<<<<<<<<` });
      const text = vi.mocked(postMessage).mock.calls[0][1];
      expect(text.length).toBeLessThanOrEqual(2_900);
      expect(text).not.toMatch(/&(?:a|am|amp|l|lt|g|gt)?…$/);
      expect(text).not.toMatch(/[<>]/);
    }
  });
});
