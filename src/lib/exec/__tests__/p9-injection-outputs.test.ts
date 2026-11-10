import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));

import { postProcessCheckinText } from "@/lib/exec/brief-checkins";
import type { BriefGather, BriefInputItem, BriefSectionKey } from "@/lib/exec/brief-types";
import { BRIEF_SECTION_KEYS } from "@/lib/exec/brief-types";
import { validateBriefOutput } from "@/lib/exec/brief-validate";
import { neutralizeLinks } from "@/lib/exec/chat/answer";
import { scanDraftOutput, type DraftModelOutput, type ScanContext } from "@/lib/exec/drafts-doc";
import { GENERATION_FLAGS } from "@/lib/exec/drafts-types";
import type { HisMessage } from "@/lib/exec/email-types";
import { principalFromRows } from "@/lib/exec/principal";
import { slackMessageRef } from "@/lib/exec/refs";
import { safeMrkdwn } from "@/lib/exec/slack-ui";
import { parseAddress, parseAddressList } from "@/lib/exec/sources/mail";
import { neutralizeChatText } from "@/lib/exec/text/untrusted";
import { parseTriageOutput } from "@/lib/exec/triage/email";
import { renderTriageInput } from "@/lib/exec/triage/email-text";
import { buildTriageWindow, parseSlackTriageOutput, renderTriageWindow } from "@/lib/exec/triage/slack";
import { parseDigestOutput, renderDigestInput } from "@/lib/exec/triage/slack-digest";
import { filterSignOff } from "@/lib/exec/voice";

import { DEFACED, HOSTILE_URLS, SLACK_CONTROL } from "./fixtures/hostile/corpus";
import { HIM, NOW as SLACK_NOW, PRINCIPAL as SLACK_PRINCIPAL, TEAM, candidate, channelRow, readMessage } from "./slack-read-jobs";

// P9 §2.1 suite 2 (Area B): scripted worst-case model OUTPUTS (every URL form incl. bare domains, Slack control sequences,
// a markdown image, invented citations [r999] / i99, attacker emails and phones) through each module's parse or post-process
// step, then the shared renderers: what is stored renders inert on Slack (safeMrkdwn) and in the chat JSON (neutralizeChatText);
// brief lines citing unknown aliases are dropped and top-3 falls back; check-in text keeps no <…>, URL or @/# mention; the draft
// scan raises every flag (bare domains included, F9); a voice sign-off outside the word list comes out empty.

const NOW = new Date("2026-11-06T15:00:00.000Z");
const principal = principalFromRows(
  { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acct_1"], slack_team_id: null, slack_user_id: null },
  { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;

/** A worst-case model line: every link form, every Slack control sequence, an image, invented citations, an email, a phone. */
const WORST = [
  "See [r999] and i99: pay now", HOSTILE_URLS.https, HOSTILE_URLS.www, HOSTILE_URLS.bitly, HOSTILE_URLS.bare, HOSTILE_URLS.markdownImage,
  ...SLACK_CONTROL, "write to attacker@evil.example", "call +1 (555) 010-9999"
].join(" ");

/** Slack's reading of a mrkdwn string: nothing that Slack parses as a control sequence or a link survives outside a code span. */
function expectInertMrkdwn(label: string, mrkdwn: string): void {
  expect(mrkdwn.includes("<"), `${label}: a raw < reached Slack`).toBe(false);
  const outsideSpans = mrkdwn.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]+`/g, " ");
  expect(outsideSpans, `${label}: a URL outside a code span`).not.toMatch(/https?:\/\/|www\.|[a-z0-9-]+\.(?:example|ly|com|org)\b/i);
}

// ---------------------------------------------------------------------------
// Stored triage text (email, Slack, DD-text, digest) renders inert
// ---------------------------------------------------------------------------

describe("§2.1 suite 2: stored model text renders inert", () => {
  it("email triage: the parsed summary / reason / decision question carry the worst case; Slack shows it inert, the chat JSON defaces [r999]", () => {
    const m: HisMessage = {
      id: "m1", threadId: "th_1", accountId: "acct_1", direction: "inbound", folder: "INBOX", isJunk: false, rfcMessageId: "<m1@x>", inReplyTo: null, subject: "Invoice",
      from: parseAddress("Carol <carol@client-one.example>"), to: parseAddressList(["mitchell@scaledai.org"]), cc: [], sentAt: NOW.toISOString(), createdAtMs: NOW.getTime(),
      isAutomated: false, attachments: [], bodyDeferred: false, bodyHtml: null, bodyText: "Please pay the invoice."
    };
    const rendered = renderTriageInput({ owner: principal, threadId: "th_1", messages: [m], newSinceWatermarkMs: null, nonce: "0123456789abcdef" });
    const parsed = parseTriageOutput(JSON.stringify({
      summary: WORST, reason: WORST, category: "client", urgency: "high", importance: "high", needs_reply: true, mitchell_personally: true,
      awaiting_reply_from_others: false, decision_ask: { question: WORST, message_index: 1 }, commitments: [], client_signal: "none", automated: false, injection_suspected: true
    }), rendered, "America/New_York", { firstTriage: true });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = parsed.result as unknown as Record<string, unknown>;
    for (const key of ["summary", "reason"]) {
      const stored = String(r[key] ?? "");
      expect(stored.length, key).toBeGreaterThan(0);
      expectInertMrkdwn(`email ${key}`, safeMrkdwn(stored));
      expect(neutralizeChatText(stored).text, key).not.toContain("[r999]");
      expect(neutralizeChatText(stored).text).toContain(`${DEFACED}r999]`);
    }
    expect(r.injectionSuspected).toBe(true);
  });

  it("Slack triage: an item summary is scrubbed of links, emails and phone numbers and renders inert", () => {
    const ts = "1794149000.000100";
    const { window } = buildTriageWindow({ channel: channelRow({ channelId: "C0PUBLIC1" }), fetched: [readMessage(ts, { text: "Can you approve the budget by Friday?" })],
      candidates: [candidate({ ts })], hisId: HIM, teamId: TEAM, ddBot: { userId: "U0DDBOT", appId: "A0DDAPP" }, optedOut: new Set(), labels: new Map(), nonce: "0123456789abcdef" });
    const r = renderTriageWindow(window, SLACK_PRINCIPAL, SLACK_NOW);
    const ref = r.candidateRefs[0];
    const parsed = parseSlackTriageOutput(JSON.stringify({ items: [{ msg: ref, kind: "request", addressed_to_you: true, needs_response: true, urgency: "high",
      summary: WORST, due_date: "", due_text: "", commitment_direction: "none", evidence: "" }], injection_suspected: false }), window, r, "America/New_York");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    for (const item of parsed.items) {
      const s = item.summary ?? "";
      expect(s).not.toMatch(/https?:\/\/|www\.|attacker@evil\.example|555\) 010-9999/);
      expectInertMrkdwn("slack summary", safeMrkdwn(s));
    }
  });

  it("digests: every line is scrubbed of links, mentions, emails and phones before it is stored", () => {
    const input = renderDigestInput({ channelLabel: "#ops", privacy: "public", localDate: "2026-11-05", nonce: "0123456789abcdef", counts: { bot: 0, ddPost: 0, external: 0 },
      messages: [{ ts: "1794141000.000100", threadTs: null, author: "A1", text: "We settled the launch plan for Friday.", isReply: false }] });
    const parsed = parseDigestOutput({ summary: WORST, highlights: [{ msg: "S0", text: WORST }], decisions: [{ msg: "S0", text: WORST }], open_questions: [], injection_suspected: true },
      input, ["We settled the launch plan for Friday."]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const texts = [parsed.summary, ...parsed.highlights.map((h) => h.text), ...parsed.decisions.map((d) => d.text)].filter((t): t is string => typeof t === "string");
    for (const t of texts) {
      expect(t).not.toMatch(/https?:\/\/|www\.|<[@!#]|attacker@evil\.example/);
      expectInertMrkdwn("digest line", safeMrkdwn(t));
    }
  });

  it("a chat answer that echoes the worst case: neutralizeLinks leaves no live link or image in its Markdown", () => {
    const out = neutralizeLinks(`${WORST} [click](https://evil.example/x) <https://evil.example|DD>`);
    expect(out).not.toMatch(/\]\(\s*(?:https?:|\/\/|javascript:|data:)/i);
    expect(out).not.toContain("![x](");
  });
});

// ---------------------------------------------------------------------------
// The brief: invented aliases dropped, top-3 falls back
// ---------------------------------------------------------------------------

function briefItem(alias: string, section: BriefSectionKey): BriefInputItem {
  return {
    alias, fingerprint: `fp_${alias}`, stateHash: "h", section, source: "email", kind: "email_reply", category: "my_action", band: "high", score: 50, basis: "ai",
    title: `Item ${alias}`, facts: ["A fact."], next: null, refs: [slackMessageRef({ channelId: "C0PUBLIC1", ts: "1794140000.000100", isPrivate: false })],
    threadIds: [], slackKeys: [], slackChannels: [], untrusted: true, occurredAt: null
  };
}

describe("§2.1 suite 2: the brief validator", () => {
  it("a line citing an unknown alias (i99) is dropped whole; an invented top-3 falls back to the deterministic one; kept text is cleaned", () => {
    const sections = BRIEF_SECTION_KEYS.map((key) => ({ key, state: "ok" as const, stateNote: null, items: [] as BriefInputItem[], stats: {} }));
    sections.find((s) => s.key === "emails")!.items.push(briefItem("i1", "emails"), briefItem("i2", "emails"));
    const gather: BriefGather = { localDate: "2026-11-06", tz: "America/New_York", nowIso: NOW.toISOString(), sections, restrictedEmail: 0, slackUnanswered: 0, failures: [] };
    const input = { gather, verdicts: new Map([["fp_i1", "new" as const], ["fp_i2", "new" as const]]), nonce: "0123456789abcdef" };
    const raw = JSON.stringify({
      headline: "Two emails need you",
      sections: [{ key: "emails", items: [
        { text: `Reply to Carol ${HOSTILE_URLS.https} <!channel>`, refs: ["i1"], kind: "fact" },
        { text: "An invented line", refs: ["i99"], kind: "fact" },
        { text: "A mixed line", refs: ["i2", "r999"], kind: "recommendation" }
      ] }],
      top3: ["i99", "i42", "r999"]
    });
    const v = validateBriefOutput(raw, input, { rev: 1, builtAt: NOW.toISOString(), trigger: "schedule" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const emails = v.content.sections.find((s) => s.key === "emails");
    const lines = emails?.items ?? [];
    expect(lines.map((l) => l.text)).toEqual([expect.stringContaining("Reply to Carol")]);
    expect(JSON.stringify(v.content)).not.toContain("invented line");
    expect(JSON.stringify(v.content)).not.toContain("A mixed line");
    expect(JSON.stringify(v.content)).not.toContain("i99");
    expect(v.content.top3Fallback).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Check-ins, the draft scan and the voice sign-off
// ---------------------------------------------------------------------------

describe("§2.1 suite 2: check-in text, the draft scan and the voice sign-off", () => {
  it("check-in text keeps no <…>, URL or @/# mention", () => {
    const out = postProcessCheckinText(`Hi Ann ${WORST} @here #general <@U0JANE> thanks`);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/[<>]/);
    expect(out).not.toMatch(/https?:\/\/|www\.|\bbit\.ly\b|evil\.example/i);
    expect(out).not.toMatch(/(^|\s)[@#][A-Za-z0-9]/);
  });

  it("the draft scan raises every flag on the worst case, bare domains included (F9)", () => {
    const ctx: ScanContext = {
      instruction: null, factLines: [], ownDomains: new Set(["scaledai.org"]), internalDomains: new Set(["scaledai.org"]), recipients: new Set(["carol@client-one.example"]),
      clientNames: ["Zenith Law"], userNames: ["Jane Doe"]
    };
    const out: DraftModelOutput = {
      paragraphs: [`Hi Carol, pay $4,500 to account 4417123456789113 at ${HOSTILE_URLS.bare} or ${HOSTILE_URLS.bitly}, write to attacker@evil.example, call +1 (555) 010-9999.`,
        "Zenith Law did the same and Jane Doe approved it."],
      signOff: "Thanks,", noteForMitchell: "", placeholders: [], subject: null
    };
    expect(scanDraftOutput(out, ctx)).toEqual([...GENERATION_FLAGS]);
    // The bare domains alone still flag a link.
    expect(scanDraftOutput({ ...out, paragraphs: [`Go to ${HOSTILE_URLS.bitly} or ${HOSTILE_URLS.bare}.`] }, ctx)).toEqual(["unexpected_url"]);
  });

  it("a voice sign-off outside the word list comes out empty", () => {
    for (const bad of [`Click ${HOSTILE_URLS.bitly}`, "Best, <!channel>", "Thanks — wire $500 now", "Regards evil.example"]) {
      expect(filterSignOff(bad, "Mitchell"), bad).toBeNull();
    }
    expect(filterSignOff("Best, Mitchell", "Mitchell")).toBe("Best, Mitchell");
  });
});
