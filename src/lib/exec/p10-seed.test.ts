import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SLACK_P10_COPY, SLACK_P10_OPS, fillP10 } from "@/lib/exec/slack-p10-copy";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";

// P10 §5.12 (ST07, ST08; contract §3.2, C57, Appendix C; Area B): the P10 copy is the contract's text, exactly, and fits its
// slots; P7a's SLACK_READ_COPY changes exactly three strings. Pure.

/** sha256 of JSON.stringify(SLACK_P10_COPY): the stage-0 seed, byte-equal to §3.2.1 (v1.2, Appendix C's copy), plus the P10
 *  fixer's additions (the contract's appendix "P10 fixer amendments" F.2: security-2's readAllConfirmUnknown, ui-9's settings
 *  and replies words, ui-10's *One singulars). Was dc2aefea3876cc3a07e7fffaf864619d3f9f4da61f1e1c53878646ed373d7ad3. */
const SLACK_P10_COPY_SHA256 = "67ae22f330d1ccefeee4d3e776fc0e7e83f2fe95f2421be5210f339775f2511d";
/** P7a's pin before P10 (p7a-seed.test.ts at e457799) and after (C57). */
const SLACK_READ_COPY_BASE_SHA256 = "5d10fd2652ced1049d13832ff3f07318be6b10ca08a2829cc4db331c1fcd1dbd";
const SLACK_READ_COPY_P10_SHA256 = "0a12c25f3ba5d8c30dfdb837d2370f0896049ae843aac57a106ddd97625193c4";
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function frozenDeep(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  return Object.isFrozen(v) && Object.values(v).every(frozenDeep);
}
/** Every string in a value, with its path. */
function strings(v: unknown, path = "$", out: { path: string; s: string }[] = []): { path: string; s: string }[] {
  if (typeof v === "string") out.push({ path, s: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out);
  return out;
}

describe("ST07 SLACK_P10_COPY", () => {
  it("is §3.2.1's text exactly (sha256 pin over its JSON), frozen at every level", () => {
    expect(sha(SLACK_P10_COPY)).toBe(SLACK_P10_COPY_SHA256);
    expect(frozenDeep(SLACK_P10_COPY)).toBe(true);
    expect(Object.keys(SLACK_P10_COPY)).toEqual(["settings", "leads", "replies", "system"]);
    expect(SLACK_P10_OPS.leadRunFailing.key("ep_1")).toBe("slack-lead-run-failing:ep_1");
    expect(SLACK_P10_OPS.tokenMismatch.key("ep_1")).toBe("slack-reply-token-mismatch:ep_1");
  });

  it("Appendix C: no leads string asks him to join or mute, or to be added; Calendly posts for good, with the reminders note", () => {
    for (const { path, s } of strings(SLACK_P10_COPY.leads)) {
      expect(s.toLowerCase(), path).not.toContain("ask to be added");
      expect(s.toLowerCase(), path).not.toContain("join");
      expect(s.toLowerCase(), path).not.toContain("mute");
    }
    expect(SLACK_P10_COPY.leads.kinds.calendly).toBe("Calendly posts");
    expect(SLACK_P10_COPY.leads.kindOne.calendly).toBe("Calendly post");
    expect(SLACK_P10_COPY.leads.calendlyNote).toBe("Calendly posts include reminders, not only bookings.");
    for (const s of [...Object.values(SLACK_P10_COPY.leads.kinds), ...Object.values(SLACK_P10_COPY.leads.kindOne)]) expect(s).not.toMatch(/calls? booked/i);
    expect(SLACK_P10_COPY.leads.listedNotMember).toBe("{n} listed lead channels aren't counted because you're not a member.");
    expect(SLACK_P10_COPY.leads.fixNotMember).toBe("Not counted for {client} (you're not a member): {names}");
    expect(SLACK_P10_COPY.leads.states.no_channels).toBe("You're not a member of any client lead channels, so there's nothing to count.");
    expect(SLACK_P10_COPY.settings.leadsConfirmBody).toContain("Calendly (bookings and reminders together)");
    expect(SLACK_P10_COPY.leads.chatNote).toContain("Calendly posts include reminders");
  });

  it("v1.1 exact-text checks: read-all's confirm, lead counts' confirm, and never a lead channel's name", () => {
    const body = SLACK_P10_COPY.settings.readAllConfirmBody;
    expect(body).toContain("Channels you muted in Slack become ordinary watched channels: their items can show in your Slack DM, App Home, the brief and email drafts.");
    for (const w of ["finance", "payroll", "HR", "legal", "billing", "accounting", "tax", "contracts", "compliance"]) expect(body, w).toContain(w);
    expect(SLACK_P10_COPY.settings.leadsConfirmBody).toContain("every lead channel you're a member of");
    expect(SLACK_P10_COPY.settings.leadsConfirmBody).toContain("named like one");
    for (const { path, s } of strings(SLACK_P10_COPY.leads)) expect(s, path).not.toMatch(/channel name|\{channel\}|\{name\}/i);
    expect(SLACK_P10_COPY.settings.readAllLabel).toBe("Also read finance, HR and legal channels and channels I muted in Slack");
    expect(SLACK_P10_COPY.settings.readAllConfirmMuteFirst).toBe("Mute any channel that carries patient or lead data first.");
  });

  it("every fill fits: the DM confirm ≤ 300 with an 80-character place and the thread; the brief and leads templates fill completely", () => {
    const R = SLACK_P10_COPY.replies;
    const place = fillP10(R.place.private, { channel: "z".repeat(80 - "# (private)".length) });
    expect(place.length).toBe(80);
    const confirm = fillP10(R.cardConfirmText, { place, thread: R.thread });
    expect(confirm.length).toBeLessThanOrEqual(300);
    expect(confirm).not.toMatch(/\{[a-z]+\}/i);
    const B = SLACK_P10_COPY.leads.brief;
    expect(fillP10(B.total, { counts: "10 VOBs · 8 non-VOBs · 3 Calendly posts" })).toBe("All clients: 10 VOBs · 8 non-VOBs · 3 Calendly posts");
    expect(fillP10(B.line, { client: "Zenith House", counts: "10 VOBs" })).toBe("Zenith House: 10 VOBs");
    expect(fillP10(B.notReady, { n: 2 })).toBe("Lead counts for yesterday aren't ready yet (2 channels not counted).");
    expect(fillP10(B.zap, { list: "Zenith House 2, Acme Recovery 1" })).toBe("Zapier errors: Zenith House 2, Acme Recovery 1");
    expect(fillP10(SLACK_P10_COPY.leads.chatBasis, { tz: "America/New_York", time: "3:05 PM" })).toBe("Whole local days in America/New_York; today so far as of 3:05 PM.");
    expect(fillP10(SLACK_P10_COPY.system.leadsLine, { time: "3:05 PM", channels: 6, unlinked: 1, notMember: 2 }))
      .toBe("Last run 3:05 PM: 6 channels, 1 not linked, 2 listed but not a member");
    expect(fillP10(SLACK_P10_COPY.settings.leadsConfirmBody, { days: 90 })).toContain("for 90 days");
    expect(fillP10(SLACK_P10_COPY.settings.readAllConfirmOpens, { n: 3 })).toBe("It will start reading these 3 channels:");
    for (const { path, s } of strings(SLACK_P10_COPY)) expect(s.length, path).toBeLessThanOrEqual(1200);
  });

  it("P10 fixer ui-10: every count template has a singular that reads for 1 and takes no {n}; ui-9 / security-2: the new words", () => {
    const C = SLACK_P10_COPY;
    const pairs: [string, string, string][] = [
      ["leads.unlinkedHelp", C.leads.unlinkedHelp, C.leads.unlinkedHelpOne], ["leads.ambiguousHelp", C.leads.ambiguousHelp, C.leads.ambiguousHelpOne],
      ["leads.listedNotMember", C.leads.listedNotMember, C.leads.listedNotMemberOne], ["leads.otherKind", C.leads.otherKind, C.leads.otherKindOne],
      ["leads.nonAppPosts", C.leads.nonAppPosts, C.leads.nonAppPostsOne], ["leads.brief.notReady", C.leads.brief.notReady, C.leads.brief.notReadyOne],
      ["settings.readAllConfirmOpens", C.settings.readAllConfirmOpens, C.settings.readAllConfirmOpensOne],
      ["settings.readAllStatus", C.settings.readAllStatus, C.settings.readAllStatusOne],
      ["system.leadsLine", C.system.leadsLine, C.system.leadsLineOne], ["system.repliesLine", C.system.repliesLine, C.system.repliesLineOne]
    ];
    for (const [path, many, one] of pairs) {
      expect(one, path).not.toMatch(/\{n\}|\{finance\}|\{channels\}|\{open\}/);
      expect(one, path).not.toMatch(/\b1 (channels|posts|drafts|lead channels|listed channels)\b/);
      expect(many, path).toMatch(/\{(n|finance|channels|open)\}/);
    }
    expect(C.leads.brief.notReadyOne).toBe("Lead counts for yesterday aren't ready yet (1 channel not counted).");
    expect(C.settings.readAllConfirmOpensOne).toBe("It will start reading this channel:");
    expect(fillP10(C.system.leadsLineOne, { time: "3:05 PM", unlinked: 0, notMember: 0 })).toBe("Last run 3:05 PM: 1 channel, 0 not linked, 0 listed but not a member");
    expect(fillP10(C.system.repliesLineOne, { sent: 0, unknown: 0, token: "Yours" })).toBe("1 draft open, 0 sent today, 0 unconfirmed · Slack connection: Yours");
    expect(C.settings.readAllConfirmUnknown).toBe("DD couldn't list the channels this would open. Reload the page and try again.");
    expect([C.settings.saving, C.settings.turnOn, C.settings.cancel, C.settings.on, C.settings.off]).toEqual(["Saving…", "Turn on", "Cancel", "On", "Off"]);
    expect([C.replies.reviewChecking, C.replies.callFailed, C.replies.openReplyPage, C.replies.pageOff, C.replies.notAllowed, C.replies.createCap, C.replies.placeholdersUnnamed])
      .toEqual(["Checking the conversation…", "Couldn't reach DD. Try again.", "Open the reply page", "Slack reply drafts are off. Turn them on in Settings.",
        "This message can't get a reply draft.", "Too many reply drafts were started just now. Try again in a few minutes.", "Fill in the blanks before sending."]);
  });
});

describe("ST08 SLACK_READ_COPY: exactly three strings change (C57)", () => {
  it("readingWhat[3], financeConfirmBody and checklist[4] are the new text; every other key byte-identical to the base", () => {
    expect(SLACK_READ_COPY.readingWhat[3]).toBe("Never read: lead channels listed on a client's FB onboarding card or named like one (with lead counts on, DD only counts their new posts), your DMs with bots (including DD's bot), notes to yourself, or DD's own announcement channels.");
    expect(SLACK_READ_COPY.financeConfirmBody).toBe("Items from this channel are shown only in DD, never in Slack or in email drafts. A reply drafted here uses only this channel and is shown only in DD. Until you watch it, nothing in it is read, not even messages to you.");
    expect(SLACK_READ_COPY.checklist[4]).toBe("The team ran the pre-enable live checks, including a test lead channel whose messages stay unread (only counted, when lead counts are on).");
    expect(sha(SLACK_READ_COPY)).toBe(SLACK_READ_COPY_P10_SHA256);
    // Put the three base strings back: the rest hashes to the base pin, so nothing else moved.
    const base = JSON.parse(JSON.stringify(SLACK_READ_COPY)) as { readingWhat: string[]; checklist: string[]; financeConfirmBody: string } & Record<string, unknown>;
    base.readingWhat[3] = "Never: lead and patient-intake channels, your DMs with bots (including DD's bot), notes to yourself, or DD's own announcement channels.";
    base.financeConfirmBody = "Items from this channel are shown only in DD, never in Slack or in drafts. Until you watch it, nothing in it is read, not even messages to you.";
    base.checklist[4] = "The team ran the pre-enable live checks, including a test lead channel that stays unread.";
    expect(sha(base)).toBe(SLACK_READ_COPY_BASE_SHA256);
    expect(SLACK_READ_COPY.readingWhat[3]).not.toContain("patient-intake");
  });
});
