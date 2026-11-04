import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { AssessButton, assessMessage, assessPath, errorCode } from "@/components/exec/email/AssessButton";
import { BucketTabs } from "@/components/exec/email/BucketTabs";
import { CommitmentList } from "@/components/exec/email/CommitmentList";
import { EmailRowItem } from "@/components/exec/email/EmailRowItem";
import { EMAIL_FRAME_SANDBOX, EmailFrame, hardenFrameLinks } from "@/components/exec/email/EmailFrame";
import { EmailTabView } from "@/components/exec/email/EmailTabView";
import { EmailThreadView } from "@/components/exec/email/EmailThreadView";
import { OverviewEmailSection } from "@/components/exec/email/OverviewEmailSection";
import type { AttentionItem } from "@/lib/exec/attention-types";
import type { EmailBucket } from "@/lib/exec/email-types";
import type {
  CommitmentView,
  EmailBucketsView,
  EmailFreshness,
  EmailRowView,
  EmailTabView as TabData,
  EmailThreadView as ThreadData,
  MessageView
} from "@/lib/exec/email-view";

// Static markup of the email surfaces (contract §3.14, §5 F): every value
// carries its basis, each state has its own words, failed reads never show
// as zeros, text never renders as HTML, the frame is sandboxed with no
// srcdoc in the server's HTML, and the DD-inbox link appears only where it
// can apply.

const NOW = "2026-11-04T15:00:00.000Z";
const TZ = "America/New_York";
const NNBSP = String.fromCharCode(0x202f);
const SCRIPT = "<script>alert(1)</script>";
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).split(NNBSP).join(" ");
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

function row(over: Partial<EmailRowView> = {}): EmailRowView {
  return {
    threadId: "t1",
    href: "/executive/email/t1",
    subject: "Q4 budget",
    counterpartName: "Jane Doe",
    counterpartEmail: "jane@acme.com",
    messageCount: 3,
    lastActivityAt: hoursAgo(3),
    lastInboundAt: hoursAgo(3),
    lastOutboundAt: hoursAgo(30),
    state: "triaged",
    answered: "awaiting_reply",
    summary: "Jane asks you to approve the Q4 budget.",
    reason: "A client waits on you.",
    category: "client",
    urgency: "high",
    importance: "high",
    needsReply: true,
    decisionQuestion: "Approve the Q4 budget?",
    clientSignal: "complaint",
    injectionSuspected: false,
    client: { id: "c1", name: "Acme", via: "exact", confidence: "high" },
    flagged: true,
    partialThread: false,
    filterReason: null,
    triageError: null,
    lastAttemptError: null,
    assessable: false,
    ...over
  };
}

const commitmentView = (over: Partial<CommitmentView> = {}): CommitmentView => ({
  id: "ec_1",
  threadId: "t1",
  threadHref: "/executive/email/t1",
  threadSubject: "Q4 budget",
  direction: "mitchell_owes",
  text: "Send the signed budget",
  counterparty: "Jane",
  dueAt: hoursAgo(-48),
  dueText: "Friday",
  status: "open",
  followedUpAt: null,
  overdue: false,
  messageSentAt: hoursAgo(3),
  evidence: null,
  ...over
});

const FRESH: EmailFreshness = {
  accounts: {
    ok: true,
    data: {
      checkedAt: hoursAgo(0.05),
      mailboxes: [{ accountId: "acc_his", address: "mitchell@scaledai.org", lastSyncedAt: hoursAgo(0.1), failingSince: null, failingError: null, problem: null }]
    }
  },
  socket: { ok: true, data: { connected: true, observedAt: hoursAgo(0.01), lastEventAt: null, stale: false } },
  sync: { ok: true, data: { signals: "available", catchingUp: false, catchingUpUntil: null } },
  satisfaction: { ok: true, data: { fresh: 2, active: 5, freshDays: 3 } }
};

function buckets(lists: Partial<Record<EmailBucket, EmailRowView[]>>): EmailBucketsView {
  const full: Record<EmailBucket, EmailRowView[]> = { reply: [], urgent: [], important: [], waiting: [], filtered: [], ...lists };
  return {
    counts: Object.fromEntries(Object.entries(full).map(([k, v]) => [k, v.length])) as Record<EmailBucket, number>,
    lists: full,
    limit: 100
  };
}

function onView(over: Partial<Extract<TabData, { state: "on" }>> = {}): TabData {
  return {
    state: "on",
    generatedAt: NOW,
    timezone: TZ,
    freshness: FRESH,
    buckets: {
      ok: true,
      data: buckets({
        reply: [row()],
        urgent: [row()],
        filtered: [row({ threadId: "t_f", href: "/executive/email/t_f", state: "filtered", filterReason: "automated_hint", summary: null, assessable: true })]
      })
    },
    restricted: { ok: true, data: 2 },
    drafts: { ok: true, data: { draftsPending: 4, scheduledReplies: 1 } },
    commitments: { ok: true, data: { items: [commitmentView({ id: "ec_2", overdue: true, dueAt: hoursAgo(20) }), commitmentView()], total: 2, overdue: 1, limit: 20 } },
    ...over
  };
}

const FAILED = { ok: false, error: "unavailable" } as const;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The Email tab
// ---------------------------------------------------------------------------

describe("EmailTabView: whole-page states", () => {
  it("says email is off, with the Email tab current and nothing else", () => {
    const out = html(createElement(EmailTabView, { view: { state: "off", generatedAt: NOW, timezone: TZ } }));
    const text = textOf(out);
    expect(text).toContain("Email intelligence is off — the team turns it on");
    expect(out).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/executive\/email"|<a[^>]*href="\/executive\/email"[^>]*aria-current="page"/);
    expect(text).not.toContain("Needs your reply");
    expect(text).not.toContain("Mail status");
  });

  it("says no mailbox is pinned", () => {
    const text = textOf(html(createElement(EmailTabView, { view: { state: "no_pin", generatedAt: NOW, timezone: TZ } })));
    expect(text).toContain("No mailbox is pinned yet");
    expect(text).not.toContain("Needs your reply");
  });
});

describe("EmailTabView: on", () => {
  const out = html(createElement(EmailTabView, { view: onView() }));
  const text = textOf(out);

  it("shows every bucket with its count, the first panel open and the rest hidden", () => {
    expect(out).toContain('role="tablist"');
    for (const label of ["Needs reply1", "Urgent1", "Important0", "Waiting0", "Not assessed1"]) expect(text).toContain(label);
    // Each panel opens with the bucket's full name.
    for (const name of ["Needs your reply.", "Urgent.", "Important.", "Waiting on others.", "Filtered / not assessed."]) expect(text).toContain(name);
    expect(out).toMatch(/id="bucket-panel-reply"[^>]*>/);
    expect(out).not.toMatch(/id="bucket-panel-reply"[^>]*hidden/);
    expect(out).toMatch(/hidden=""[^>]*id="bucket-panel-urgent"|id="bucket-panel-urgent"[^>]*hidden=""/);
  });

  it("states each bucket's rule with its basis, and its own empty copy", () => {
    expect(text).toContain("The assistant read it as needing your reply, and none has gone out. Last 30 days.");
    expect(text).toContain("Read as high importance, or flagged in Outlook. Last 7 days.");
    expect(text).toContain("Nothing marked important in the last 7 days.");
    expect(text).toContain("No one owes you a reply.");
  });

  it("labels the basis of every value on a row", () => {
    const one = html(createElement(EmailTabView, { view: onView({ buckets: { ok: true, data: buckets({ reply: [row()] }) } }) }));
    const panel = one.slice(one.indexOf('id="bucket-panel-reply"'), one.indexOf('id="bucket-panel-urgent"'));
    expect(panel).toContain(">Record<");
    expect(panel).toContain(">Derived<");
    expect(panel).toContain(">AI-assessed<");
    const t = textOf(panel);
    for (const s of ["Jane Doe &lt;jane@acme.com&gt;", "3 messages", "Flagged in Outlook", "Awaiting your reply", "Client: Acme", "Client", "High urgency", "High importance", "Complaint", "Needs a reply", "Jane asks you to approve the Q4 budget.", "Decision asked: Approve the Q4 budget?", "3 h ago"]) {
      expect(t, s).toContain(s);
    }
    expect(hrefs(panel)).toContain("/executive/email/t1");
  });

  it("offers Assess on filtered rows only, with the reason they weren't assessed", () => {
    const panel = out.slice(out.indexOf('id="bucket-panel-filtered"'));
    expect(textOf(panel)).toContain("Set aside: looks automated");
    expect(textOf(panel)).toContain("Assess");
    const reply = out.slice(out.indexOf('id="bucket-panel-reply"'), out.indexOf('id="bucket-panel-urgent"'));
    expect(textOf(reply)).not.toContain("Assess");
  });

  it("shows the side cards: commitments overdue first, drafts, the restricted count", () => {
    expect(text).toContain("2 open");
    expect(text.indexOf("Was due")).toBeLessThan(text.indexOf("Due Nov 6"));
    expect(text).toContain("Overdue");
    expect(text).toContain("Awaiting approval4");
    expect(text).toContain("Scheduled to send1");
    expect(text).toContain("2 threads hidden by the restricted-sender rules.");
  });

  it("shows the mail status", () => {
    expect(text).toContain("Synced 6 min ago");
    expect(text).toContain("Live updates connected");
    expect(text).not.toContain("Catching up");
  });

  it("shows a failed card as couldn't load, never as zero", () => {
    const failed = textOf(
      html(createElement(EmailTabView, { view: onView({ buckets: FAILED, restricted: FAILED, drafts: FAILED, commitments: FAILED }) }))
    );
    expect(failed).toContain("Couldn't load your email right now.");
    expect(failed.match(/Couldn't load this section right now/g)).toHaveLength(3);
    expect(failed).not.toContain("hidden by the restricted-sender rules");
    expect(failed).not.toContain("Awaiting approval");
  });

  it("escapes every stored string", () => {
    const evil = html(
      createElement(EmailTabView, {
        view: onView({ buckets: { ok: true, data: buckets({ reply: [row({ subject: SCRIPT, summary: SCRIPT, counterpartName: SCRIPT, decisionQuestion: SCRIPT })] }) } })
      })
    );
    expect(evil).not.toContain(SCRIPT);
    expect(evil).toContain(ESCAPED);
  });

  it("starts on the bucket the URL names, and on the first for an unknown one", () => {
    const urgent = html(createElement(EmailTabView, { view: onView(), bucket: "urgent" }));
    expect(urgent).not.toMatch(/id="bucket-panel-urgent"[^>]*hidden/);
    expect(urgent).toMatch(/hidden=""[^>]*id="bucket-panel-reply"|id="bucket-panel-reply"[^>]*hidden=""/);
    const bogus = html(createElement(EmailTabView, { view: onView(), bucket: "nope" }));
    expect(bogus).not.toMatch(/id="bucket-panel-reply"[^>]*hidden/);
  });
});

describe("EmailStatusPanel states", () => {
  const status = (freshness: EmailFreshness) => textOf(html(createElement(EmailTabView, { view: onView({ freshness }) })));

  it("not synced yet, live updates not reported", () => {
    const text = status({
      accounts: { ok: true, data: { checkedAt: null, mailboxes: [] } },
      socket: { ok: true, data: null },
      sync: FRESH.sync,
      satisfaction: FRESH.satisfaction
    });
    expect(text).toContain("Not synced yet.");
    expect(text).toContain("Live updates haven't reported yet.");
  });

  it("says for how many active clients the satisfaction scores are fresh (L13)", () => {
    expect(status(FRESH)).toContain(
      "Satisfaction scores fresh for 2 of 5 active clients (scored in the last 3 days; only those clients can raise a satisfaction item)"
    );
    expect(status({ ...FRESH, satisfaction: { ok: true, data: { fresh: 0, active: 4, freshDays: 3 } } })).toContain(
      "Satisfaction scores fresh for 0 of 4 active clients"
    );
    expect(status({ ...FRESH, satisfaction: { ok: true, data: { fresh: 0, active: 0, freshDays: 3 } } })).toContain(
      "No active clients, so there are no satisfaction scores to track."
    );
  });

  it("problem accounts and failing syncs", () => {
    const text = status({
      ...FRESH,
      accounts: {
        ok: true,
        data: {
          checkedAt: hoursAgo(0.1),
          mailboxes: [
            { accountId: "a", address: "mitchell@scaledai.org", lastSyncedAt: hoursAgo(5), failingSince: hoursAgo(2), failingError: "AADSTS70000: invalid_grant", problem: null },
            { accountId: "b", address: "m2@scaledai.org", lastSyncedAt: null, failingSince: null, failingError: null, problem: "email_mismatch" }
          ]
        }
      }
    });
    expect(text).toContain("mitchell@scaledai.org: Sync failing since Nov 4, 8:00 AM EST (AADSTS70000: invalid_grant)");
    expect(text).toContain("m2@scaledai.org: Mailbox connection needs attention: the mailbox now belongs to a different address.");
  });

  it("disconnected or stale live updates, no Outlook signals, catching up", () => {
    const text = status({
      ...FRESH,
      socket: { ok: true, data: { connected: false, observedAt: hoursAgo(0.01), lastEventAt: null, stale: false } },
      sync: { ok: true, data: { signals: "unavailable", catchingUp: true, catchingUpUntil: hoursAgo(-0.25) } }
    });
    expect(text).toContain("Live updates disconnected.");
    expect(text).toContain("Outlook signals aren't available yet");
    expect(text).toContain("Catching up on recent mail (queued work runs until 10:15 AM EST). Some threads may not be assessed yet.");
    expect(status({ ...FRESH, socket: { ok: true, data: { connected: true, observedAt: hoursAgo(2), lastEventAt: null, stale: true } } })).toContain(
      "Live updates haven't reported since 2 h ago."
    );
  });

  it("a part that couldn't be read says so", () => {
    const text = status({ accounts: FAILED, socket: FAILED, sync: FAILED, satisfaction: FAILED });
    expect(text).toContain("Couldn't load the mailbox status.");
    expect(text).toContain("Couldn't load the live-update status.");
    expect(text).toContain("Couldn't load the sync progress.");
    expect(text).toContain("Couldn't load how fresh the client satisfaction scores are.");
    expect(text).not.toContain("Synced");
    expect(text).not.toContain("Satisfaction scores fresh");
  });
});

// ---------------------------------------------------------------------------
// The thread page
// ---------------------------------------------------------------------------

function message(id: string, over: Partial<MessageView> = {}): MessageView {
  return {
    id,
    direction: "inbound",
    isJunk: false,
    isAutomated: false,
    from: { name: "Jane Doe", email: "jane@acme.com" },
    to: [{ name: "Mitchell", email: "mitchell@scaledai.org" }],
    cc: [],
    subject: "Q4 budget",
    sentAt: hoursAgo(3),
    attachments: [],
    body: { kind: "html", srcdoc: "<!DOCTYPE html><html><head></head><body>SRCDOC_BODY</body></html>", imagesSrcdoc: "<!DOCTYPE html>IMAGES", remoteImages: 2, inlineImages: 0, truncated: false },
    ...over
  };
}

function attention(id: string): AttentionItem {
  return {
    id,
    principalId: "ep_owner",
    fingerprint: "email:thread:t1:m3",
    source: "email",
    kind: "decision_ask",
    category: "approval",
    title: "Jane asks you to decide on the Q4 budget",
    whatHappened: "",
    whyItMatters: "",
    recommendedNext: null,
    facts: [],
    refs: [],
    priority: { score: 50, band: "high", reasons: [] },
    stateHash: "0123456789abcdef",
    occurredAt: hoursAgo(3),
    status: "open",
    snoozeUntil: null,
    firstSeenAt: hoursAgo(3),
    lastSeenAt: hoursAgo(1),
    resolvedAt: null,
    resolution: null,
    updatedAt: hoursAgo(1)
  };
}

function threadView(over: Partial<ThreadData> = {}): ThreadData {
  return {
    generatedAt: NOW,
    timezone: TZ,
    threadId: "t1",
    mode: "live",
    thread: { ...row(), answeredAt: null, triagedAt: hoursAgo(2) },
    answeredUnchecked: false,
    messages: [
      message("m3", { attachments: [{ filename: "budget.xlsx", contentType: "application/vnd.ms-excel", size: 24_576, inline: false }] }),
      message("m2", { direction: "outbound", from: { name: "Mitchell", email: "mitchell@scaledai.org" }, body: { kind: "text", text: `Plain ${SCRIPT}`, truncated: false } }),
      message("m1", { body: { kind: "not_loaded" } })
    ],
    bodiesFailed: false,
    partialThread: false,
    outlookUrl: "https://outlook.office.com/owa/?ItemID=AAMk&exvsurl=1&viewmodel=ReadMessageItem",
    ddInboxUrl: "https://operations.scaledai.org/inboxes/acc_his?thread=t1&acct=acc_his",
    commitments: { ok: true, data: [commitmentView({ evidence: "I'll send the signed budget by Friday" })] },
    tasks: { ok: true, data: [{ id: "task1", title: "Review budget", status: "in_progress", priority: "high", dueDate: null, isDraft: false, href: "/tasks/task1" }] },
    client: { ok: true, data: { id: "c1", name: "Acme Dental", via: "exact", confidence: "high", candidates: 1, health: "shaky", healthOverridden: false, meetings: [{ id: "mt1", title: "QBR", meetingAt: hoursAgo(120) }] } },
    attention: { ok: true, data: [attention("ea_1")] },
    ...over
  };
}

describe("EmailThreadView", () => {
  const out = html(createElement(EmailThreadView, { view: threadView() }));
  const text = textOf(out);

  it("renders the given messages only, newest first, each with its basis", () => {
    expect(text.indexOf("budget.xlsx")).toBeLessThan(text.indexOf("Plain"));
    expect(text).toContain("Messages (3)");
    expect(out.match(/>Record</g)?.length).toBeGreaterThanOrEqual(4);
    expect(text).toContain("budget.xlsx · 24 KB");
    expect(text).toContain("The text of this message isn't loaded here. Open it in Outlook to read it.");
    expect(out).toContain(`Plain ${ESCAPED}`);
    expect(out).not.toContain(SCRIPT);
  });

  it("puts HTML bodies in the sandboxed frame, with no srcdoc in the server's HTML", () => {
    expect(out).toContain(`sandbox="${EMAIL_FRAME_SANDBOX}"`);
    expect(EMAIL_FRAME_SANDBOX).toBe("allow-popups allow-popups-to-escape-sandbox allow-same-origin");
    expect(out).not.toContain("allow-scripts");
    expect(out).not.toMatch(/srcdoc=/i);
    expect(out).not.toContain("SRCDOC_BODY");
    expect(text).toContain("Show images (2)");
    expect(text).toContain("Loading them tells the sender you opened this and shows them your IP address.");
  });

  it("links to Outlook in a new tab and to the DD inbox with its catch", () => {
    expect(out).toContain('href="https://outlook.office.com/owa/?ItemID=AAMk&amp;exvsurl=1&amp;viewmodel=ReadMessageItem" target="_blank" rel="noopener noreferrer"');
    expect(hrefs(out)).toContain("/inboxes/acc_his?thread=t1&amp;acct=acc_his");
    expect(text).toContain("Open in DD inboxneeds DD inbox access");
  });

  it("shows no DD-inbox link when it can't apply, and no Outlook link without a CL1 link", () => {
    const bare = html(createElement(EmailThreadView, { view: threadView({ ddInboxUrl: null, outlookUrl: null }) }));
    expect(textOf(bare)).not.toContain("Open in DD inbox");
    expect(textOf(bare)).not.toContain("needs DD inbox access");
    expect(textOf(bare)).not.toContain("Open in Outlook");
    const offsite = html(createElement(EmailThreadView, { view: threadView({ outlookUrl: "https://evil.example/owa/?ItemID=x" }) }));
    expect(offsite).not.toContain("evil.example");
  });

  it("labels the assessment AI-assessed and the status derived", () => {
    expect(text).toContain("AssessmentAI-assessed");
    expect(text).toContain("Decision asked: Approve the Q4 budget?");
    expect(text).toContain("StatusDerived");
    expect(text).toContain("ReplyAwaiting your reply");
    expect(text).toContain("Acmecontact email, high confidence");
  });

  it("shows the side sections: commitments with evidence, attention, tasks, client", () => {
    expect(text).toContain("“I'll send the signed budget by Friday”");
    expect(text).toContain("Jane asks you to decide on the Q4 budget");
    expect(text).toContain("Review budget");
    expect(text).toContain("Health in DDShaky");
    expect(text).toContain("QBR");
    expect(hrefs(out)).toContain("/clients/c1");
  });

  it("offers Assess only on a thread that wasn't assessed", () => {
    expect(text).not.toContain("Assess ");
    const filtered = textOf(
      html(createElement(EmailThreadView, { view: threadView({ thread: { ...row({ state: "deferred_budget", assessable: true, summary: null }), answeredAt: null, triagedAt: null } }) }))
    );
    expect(filtered).toContain("Deferred: today's AI budget was used up");
    expect(filtered).toContain("Assess");
  });

  it("says when it shows stored sections only, and why", () => {
    const down = textOf(html(createElement(EmailThreadView, { view: threadView({ mode: "clone_unavailable", messages: null }) })));
    expect(down).toContain("Couldn't reach the mail service just now, so the messages aren't shown.");
    expect(down).not.toContain("Messages (");
    expect(down).toContain("Jane asks you to approve the Q4 budget.");
    const problem = textOf(html(createElement(EmailThreadView, { view: threadView({ mode: "account_problem", messages: null, ddInboxUrl: null }) })));
    expect(problem).toContain("Mailbox connection needs attention");
  });

  it("notes partial threads, failed bodies, an unchecked overlay and suspected injection", () => {
    const t = textOf(
      html(
        createElement(EmailThreadView, {
          view: threadView({ partialThread: true, bodiesFailed: true, answeredUnchecked: true, thread: { ...row({ injectionSuspected: true }), answeredAt: null, triagedAt: null } })
        })
      )
    );
    expect(t).toContain("Part of this conversation isn't in your synced folders");
    expect(t).toContain("Some message text couldn't be loaded in time.");
    expect(t).toContain("Outlook and DD drafts couldn't be checked");
    expect(t).toContain("instructions aimed at the assistant");
  });

  it("fails each side section on its own", () => {
    const t = textOf(html(createElement(EmailThreadView, { view: threadView({ commitments: FAILED, tasks: FAILED, client: FAILED, attention: FAILED }) })));
    expect(t.match(/Couldn't load this section right now/g)).toHaveLength(4);
    expect(t).toContain("Messages (3)");
  });
});

// ---------------------------------------------------------------------------
// Islands
// ---------------------------------------------------------------------------

describe("EmailFrame", () => {
  it("renders no toggle without remote images or a second document", () => {
    expect(textOf(html(createElement(EmailFrame, { srcdoc: "x", imagesSrcdoc: null, remoteImages: 3, title: "t" })))).not.toContain("Show images");
    expect(textOf(html(createElement(EmailFrame, { srcdoc: "x", imagesSrcdoc: "y", remoteImages: 0, title: "t" })))).not.toContain("Show images");
  });

  it("names the frame and keeps the referrer off", () => {
    const out = html(createElement(EmailFrame, { srcdoc: "x", imagesSrcdoc: null, remoteImages: 0, title: "Message from Jane" }));
    expect(out).toContain('title="Message from Jane"');
    expect(out).toContain('referrerPolicy="no-referrer"'.toLowerCase().replace("referrerpolicy", "referrerPolicy"));
  });

  it("forces every link in the frame to a new tab with no opener or referrer", () => {
    const set: Record<string, string>[] = [];
    const fakeLink = () => {
      const attrs: Record<string, string> = { rel: "opener", target: "_top" };
      set.push(attrs);
      return { setAttribute: (k: string, v: string) => (attrs[k] = v) };
    };
    const links = [fakeLink(), fakeLink()];
    const doc = { querySelectorAll: (sel: string) => (sel === "a, area" ? links : []) } as unknown as Document;
    expect(hardenFrameLinks(doc)).toBe(2);
    expect(set).toEqual([
      { rel: "noopener noreferrer", target: "_blank" },
      { rel: "noopener noreferrer", target: "_blank" }
    ]);
  });
});

describe("AssessButton", () => {
  it("renders a button and posts to the thread's route", () => {
    expect(textOf(html(createElement(AssessButton, { threadId: "t/1" })))).toBe("Assess");
    expect(assessPath("t/1")).toBe("/api/exec/email/threads/t%2F1/assess");
  });

  it("says what each answer means", () => {
    expect(assessMessage(202)).toContain("Queued");
    expect(assessMessage(409)).toContain("can't be assessed now");
    expect(assessMessage(429)).toContain("Too many");
    expect(assessMessage(404)).toContain("isn't available");
    expect(assessMessage(503)).toContain("Couldn't queue");
    expect(assessMessage(0)).toContain("Couldn't queue");
  });

  it("says why a thread on a mailbox that needs attention can't be assessed, from the route's code (ui-2)", async () => {
    expect(assessMessage(409, "account_unusable")).toBe("Its mailbox connection needs attention, so it can't be assessed until the team fixes it.");
    expect(assessMessage(409, "not_assessable")).toContain("it was assessed already");
    expect(await errorCode({ json: async () => ({ error: "account_unusable" }) })).toBe("account_unusable");
    expect(await errorCode({ json: async () => ({ queued: true }) })).toBeNull();
    expect(
      await errorCode({
        json: async () => {
          throw new SyntaxError("not json");
        }
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Review round 5: honest empties, earlier assessments, answered words, due dates
// ---------------------------------------------------------------------------

describe("empty buckets before his mail is read (ui-5)", () => {
  const emptyView = (freshness: EmailFreshness) =>
    onView({ freshness, buckets: { ok: true, data: buckets({}) }, commitments: { ok: true, data: { items: [], total: 0, overdue: 0, limit: 20 } } });
  const render = (freshness: EmailFreshness) => textOf(html(createElement(EmailTabView, { view: emptyView(freshness) })));

  it("not synced yet, or catching up: an empty bucket says the assistant hasn't finished, never a confident empty", () => {
    const notSynced: EmailFreshness = { ...FRESH, accounts: { ok: true, data: { checkedAt: null, mailboxes: [] } } };
    const catchingUp: EmailFreshness = { ...FRESH, sync: { ok: true, data: { signals: "available", catchingUp: true, catchingUpUntil: null } } };
    for (const f of [notSynced, catchingUp]) {
      const t = render(f);
      expect(t).toContain("Nothing here yet — the assistant hasn't finished reading your mail.");
      for (const confident of ["Nothing is waiting on your reply.", "Nothing urgent is waiting on you.", "No one owes you a reply.", "No open commitments."]) {
        expect(t).not.toContain(confident);
      }
    }
    // Before the first sync the tabs show no count at all; while catching up they count what is there.
    expect(render(notSynced)).toContain("Needs reply—");
    expect(render(notSynced)).not.toContain("Needs reply0");
    expect(render(catchingUp)).toContain("Needs reply0");
  });

  it("the mail status unreadable: the empty list may be incomplete, and says so", () => {
    const t = render({ ...FRESH, sync: { ok: false, error: "unavailable" } });
    expect(t).toContain("Nothing here, but the mail status couldn't be checked, so this may be incomplete.");
    expect(t).not.toContain("Nothing is waiting on your reply.");
  });

  it("synced and caught up: each bucket's own empty copy", () => {
    const t = render(FRESH);
    expect(t).toContain("Nothing is waiting on your reply.");
    expect(t).toContain("No open commitments.");
    expect(t).not.toContain("hasn't finished reading");
  });
});

describe("rows whose newest mail wasn't assessed (ui-6)", () => {
  const deferred = row({ state: "deferred_budget", lastAttemptError: "budget", assessable: true, needsReply: true, urgency: "high", importance: "normal", clientSignal: "none", decisionQuestion: null });

  it("a deferred row in Needs your reply shows the assessment that put it there, labeled as earlier", () => {
    const out = html(createElement(EmailTabView, { view: onView({ buckets: { ok: true, data: buckets({ reply: [deferred], urgent: [deferred] }) } }) }));
    const panel = textOf(out.slice(out.indexOf('id="bucket-panel-reply"'), out.indexOf('id="bucket-panel-urgent"')));
    expect(panel).toContain("Earlier assessment (before the newest message)");
    for (const s of ["High urgency", "Needs a reply", "Jane asks you to approve the Q4 budget.", "Deferred: today's AI budget was used up", "Assess"]) expect(panel, s).toContain(s);
  });

  it("an assessed row carries no such label, and a never-assessed one has no AI line at all", () => {
    expect(textOf(html(createElement(EmailRowItem, { row: row(), tz: TZ, now: NOW })))).not.toContain("Earlier assessment");
    const bare = html(
      createElement(EmailRowItem, {
        row: row({ state: "filtered", filterReason: "automated_hint", assessable: true, summary: null, category: null, urgency: null, importance: null, needsReply: null, clientSignal: null, decisionQuestion: null }),
        tz: TZ,
        now: NOW
      })
    );
    expect(textOf(bare)).not.toContain("Earlier assessment");
    expect(bare).not.toContain(">AI-assessed<");
  });

  it("the thread page shows the earlier assessment under the reason it wasn't assessed", () => {
    const t = textOf(html(createElement(EmailThreadView, { view: threadView({ thread: { ...deferred, answeredAt: null, triagedAt: null } }) })));
    expect(t).toContain("Deferred: today's AI budget was used up");
    expect(t).toContain("Earlier assessment (before the newest message)");
    expect(t).toContain("Jane asks you to approve the Q4 budget.");
    expect(t).toContain("Needs your replyYes");
  });
});

describe("the answered words (ui-7)", () => {
  const chipText = (r: EmailRowView) => textOf(html(createElement(EmailRowItem, { row: r, tz: TZ, now: NOW })));
  const neverAssessed = { summary: null, category: null, urgency: null, importance: null, needsReply: null, clientSignal: null, decisionQuestion: null } as const;

  it("'Awaiting your reply' only where the assistant read a reply as needed", () => {
    expect(chipText(row())).toContain("Awaiting your reply");
    expect(chipText(row({ state: "triage_failed", triageError: "truncated", assessable: true, ...neverAssessed }))).toContain("No reply yet");
    expect(chipText(row({ answered: "answered" }))).toContain("You replied");
  });

  it("no answered chip on an unanswered thread set aside as automated, or read as needing no reply", () => {
    const filtered = chipText(row({ state: "filtered", filterReason: "automated_hint", assessable: true, ...neverAssessed }));
    expect(filtered).toContain("Set aside: looks automated");
    expect(filtered).not.toMatch(/Awaiting your reply|No reply yet/);
    expect(chipText(row({ needsReply: false }))).not.toMatch(/Awaiting your reply|No reply yet/);
  });

  it("the thread page's Reply fact never claims he owes a reply the assistant didn't read as needed", () => {
    const filtered = textOf(
      html(createElement(EmailThreadView, { view: threadView({ thread: { ...row({ state: "filtered", filterReason: "automated_hint", assessable: true, ...neverAssessed }), answeredAt: null, triagedAt: null } }) }))
    );
    expect(filtered).toContain("ReplyNo reply yet");
    expect(filtered).not.toContain("Awaiting your reply");
  });
});

describe("commitment due lines (ui-8)", () => {
  const line = (over: Partial<CommitmentView>) => textOf(html(createElement(CommitmentList, { items: [commitmentView(over)], tz: TZ, now: NOW })));

  it("show the date and what the email said, never a clock time nobody stated", () => {
    // Stored as 17:00 his time by convention; the email said 10am.
    const t = line({ dueAt: "2026-11-06T22:00:00.000Z", dueText: "by 10am Friday" });
    expect(t).toContain('Due Nov 6 (the email said "by 10am Friday")');
    expect(t).not.toMatch(/\d{1,2}:\d{2}/);
    expect(t).not.toMatch(/\b(AM|PM|EST|EDT)\b/);
  });

  it("an overdue one, one with no words for it, and one with words only", () => {
    expect(line({ dueAt: "2026-11-02T22:00:00.000Z", dueText: "Monday", overdue: true })).toContain('Was due Nov 2 (the email said "Monday")');
    expect(line({ dueAt: "2026-11-06T22:00:00.000Z", dueText: null })).toContain("Due Nov 6");
    expect(line({ dueAt: "2026-11-06T22:00:00.000Z", dueText: null })).not.toContain("the email said");
    expect(line({ dueAt: null, dueText: "next week" })).toContain("Due: next week");
  });
});

describe("BucketTabs", () => {
  it("is a tablist with one selected tab and its panel shown", () => {
    const out = html(
      createElement(BucketTabs, {
        tabs: [
          { key: "a", label: "A", count: 1 },
          { key: "b", label: "B", count: null }
        ],
        panels: { a: createElement("p", null, "PA"), b: createElement("p", null, "PB") },
        initial: "b"
      })
    );
    expect(out).toContain('role="tablist"');
    expect(out).toMatch(/aria-selected="true"[^>]*id="bucket-tab-b"|id="bucket-tab-b"[^>]*aria-selected="true"/);
    expect(textOf(out)).toContain("B—");
    expect(out).toMatch(/hidden=""[^>]*id="bucket-panel-a"|id="bucket-panel-a"[^>]*hidden=""/);
  });

  it("wraps its tabs instead of scrolling them, so the selected one is always in view on a phone (ui-9)", () => {
    const out = html(createElement(BucketTabs, { tabs: [{ key: "a", label: "A", count: 1 }], panels: { a: "PA" }, initial: "a" }));
    const strip = /<div[^>]*role="tablist"[^>]*>/.exec(out)?.[0] ?? "";
    const classes = (/class="([^"]*)"/.exec(strip)?.[1] ?? "").split(/\s+/);
    expect(classes).toContain("flex-wrap");
    expect(classes).not.toContain("overflow-x-auto");
  });
});

// ---------------------------------------------------------------------------
// The Overview card
// ---------------------------------------------------------------------------

describe("OverviewEmailSection", () => {
  const render = (email: Parameters<typeof OverviewEmailSection>[0]["email"]) => textOf(html(createElement(OverviewEmailSection, { email, tz: TZ, now: NOW })));

  it("off, no pin and a failed read each say so", () => {
    expect(render({ ok: true, data: { state: "off" } })).toContain("Email intelligence is off — the team turns it on.");
    expect(render({ ok: true, data: { state: "no_pin" } })).toContain("No mailbox is pinned yet.");
    expect(render(FAILED)).toContain("Couldn't load this section right now");
  });

  it("shows the counts, the hidden count and the commitments due this week", () => {
    const text = render({
      ok: true,
      data: {
        state: "on",
        counts: { ok: true, data: { reply: 3, urgent: 1, important: 2, waiting: 4, filtered: 5, decisionAsks: 1 } },
        restricted: { ok: true, data: 2 },
        commitments: { ok: true, data: { items: [commitmentView()], total: 1, days: 7, limit: 6 } },
        mail: { ok: true, data: { checkedAt: NOW, lastSyncedAt: NOW, failingSince: null, problems: 0, socket: null } }
      }
    });
    for (const s of ["Needs reply3", "Urgent1", "Important2", "Waiting on others4", "Not assessed5", "2 threads hidden", "Commitments due within 7 days", "Send the signed budget"]) {
      expect(text, s).toContain(s);
    }
  });

  it("before the first sync: says so instead of showing zero counts or an empty week (ui-5)", () => {
    const text = render({
      ok: true,
      data: {
        state: "on",
        counts: { ok: true, data: { reply: 0, urgent: 0, important: 0, waiting: 0, filtered: 0, decisionAsks: 0 } },
        restricted: { ok: true, data: 0 },
        commitments: { ok: true, data: { items: [], total: 0, days: 7, limit: 6 } },
        mail: { ok: true, data: { checkedAt: null, lastSyncedAt: null, failingSince: null, problems: 0, socket: null } }
      }
    });
    expect(text).toContain("Not synced yet.");
    expect(text).not.toMatch(/Needs reply\d/);
    expect(text).not.toContain("Nothing due this week.");
    expect(text).toContain("None found yet: your mail hasn't been read.");
  });

  it("shows unavailable parts as couldn't load, never zero", () => {
    const text = render({
      ok: true,
      data: { state: "on", counts: FAILED, restricted: FAILED, commitments: FAILED, mail: FAILED }
    });
    expect(text).toContain("Couldn't load your email counts.");
    expect(text).toContain("Couldn't check how many threads are hidden.");
    expect(text).toContain("Couldn't load your commitments.");
    expect(text).not.toMatch(/Needs reply\d/);
  });
});
