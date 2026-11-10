import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttentionFeed } from "@/components/exec/AttentionFeed";
import { AttentionRow } from "@/components/exec/AttentionRow";
import { COPY } from "@/components/exec/drafts/copy";
import { DraftsBucket, orderDraftItems } from "@/components/exec/drafts/DraftsBucket";
import { DraftStatusBanner } from "@/components/exec/drafts/DraftStatusBanner";
import { draftFocusTarget } from "@/components/exec/drafts/panel-logic";
import { AssessButton } from "@/components/exec/email/AssessButton";
import { EmailRowItem } from "@/components/exec/email/EmailRowItem";
import { EmailTabView, execDraftCountLabel } from "@/components/exec/email/EmailTabView";
import { draftChecksOverdue, DraftsRows, SystemSection } from "@/components/exec/overview/SystemSection";
import type { AttentionItem } from "@/lib/exec/attention-types";
import { draftPageHref, draftReplyHrefFor } from "@/lib/exec/drafts-links";
import type { EmailRowView, EmailTabView as EmailTabData } from "@/lib/exec/email-view";
import type { OverviewDraftsSystem, OverviewSystem } from "@/lib/exec/overview";
import { draftView, listItem, NOW_ISO, textOf, TZ, WEB_LINK } from "../__tests__/drafts-ui-fixtures";

// UI05, UI06, UI07, UI09, UI10 and the island list of components/exec/drafts
// (P4 contract §5.11, §3.13.5, Y7-Y9, X7; bindings AM2).

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));

const bucket = (props: Partial<Parameters<typeof DraftsBucket>[0]> = {}) =>
  renderToStaticMarkup(createElement(DraftsBucket, { state: "ok", items: [], tz: TZ, nowIso: NOW_ISO, newEmailHref: "/executive/email/drafts/new", draftsOn: true, ...props }));

describe("UI05: the Drafts bucket", () => {
  const items = [
    listItem({ id: "ed_a", label: "Plain draft", attention: null }),
    listItem({ id: "ed_b", label: "Changed one", status: "saved", attention: "outlook_changed" }),
    listItem({ id: "ed_c", label: "Unknown one", status: "unknown", attention: "unknown" }),
    listItem({ id: "ed_d", label: "Sent yesterday", status: "sent", sentAt: "2026-11-05T15:00:00.000Z" }),
    listItem({ id: "ed_e", label: "SECRET SUBJECT", toSummary: "secret@client.com", restricted: true, status: "saved", attention: "restricted" }),
    listItem({ id: "ed_f", label: "Failed one", status: "generation_failed", attention: "generation_failed" })
  ];

  it("attention rows first in C46's order, the rest as given", () => {
    expect(orderDraftItems(items).map((i) => i.id)).toEqual(["ed_c", "ed_b", "ed_f", "ed_e", "ed_a", "ed_d"]);
    const html = bucket({ items });
    expect([...html.matchAll(/data-draft-row="([^"]+)"/g)].map((m) => m[1])).toEqual(["ed_c", "ed_b", "ed_f", "ed_e", "ed_a", "ed_d"]);
  });

  it("status chips, attention reasons, the recipients summary and links to the draft pages", () => {
    const text = textOf(bucket({ items }));
    for (const s of ["Outcome unknown", "Changed in Outlook", "Drafting failed", "In DD", "Sent", "To jane@acme.com", "4 drafts need you"]) expect(text).toContain(s);
    const html = bucket({ items });
    expect(html).toContain(`href="${draftPageHref("ed_a")}"`);
  });

  it("a restricted row shows only that it exists: no subject, no recipients", () => {
    const html = bucket({ items });
    expect(html).toContain('data-restricted="true"');
    expect(textOf(html)).toContain("Draft for a restricted thread");
    expect(html).not.toContain("SECRET SUBJECT");
    expect(html).not.toContain("secret@client.com");
  });

  it("the empty state, and 'New email' only while drafts are on", () => {
    expect(textOf(bucket())).toContain("No drafts. Use Draft reply on an email to start one.");
    expect(textOf(bucket())).toContain("New email");
    expect(bucket()).toContain('href="/executive/email/drafts/new"');
    expect(textOf(bucket({ draftsOn: false }))).not.toContain("New email");
  });

  it("the unavailable, off and not-installed states each say so, and list nothing", () => {
    expect(textOf(bucket({ state: "unavailable", items }))).toContain("Drafts couldn't load. Reload to try again.");
    expect(textOf(bucket({ state: "off", items }))).toContain("Assistant drafts are off.");
    expect(textOf(bucket({ state: "not_installed", items }))).toContain("Assistant drafts aren't set up yet.");
    for (const state of ["unavailable", "off", "not_installed"] as const) {
      const html = bucket({ state, items });
      expect(html).not.toContain("data-draft-row");
      expect(textOf(html)).not.toContain("New email");
    }
  });
});

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "ea_1",
  principalId: "ep_owner",
  fingerprint: "email:thread:t_thread1:m_anchor",
  source: "email",
  kind: "email_reply",
  category: "my_action",
  title: "Jane is waiting on a reply",
  whatHappened: "She asked about Thursday.",
  whyItMatters: "A client is waiting.",
  recommendedNext: null,
  facts: [],
  refs: [],
  priority: { score: 60, band: "high", reasons: [] },
  stateHash: "abcd1234abcd1234",
  occurredAt: "2026-11-06T14:00:00.000Z",
  status: "open",
  snoozeUntil: null,
  firstSeenAt: "2026-11-06T14:00:00.000Z",
  lastSeenAt: "2026-11-06T14:00:00.000Z",
  resolvedAt: null,
  resolution: null,
  updatedAt: "2026-11-06T14:00:00.000Z",
  ...over
}) as AttentionItem;

describe("UI06: Draft reply on Needs Attention rows", () => {
  it("draftReplyHrefFor: only an email item with an email:thread: fingerprint", () => {
    expect(draftReplyHrefFor(item())).toBe("/executive/email/drafts/new?threadId=t_thread1");
    expect(draftReplyHrefFor(item({ source: "dd" }))).toBeNull();
    expect(draftReplyHrefFor(item({ fingerprint: "email:commitment:c1" }))).toBeNull();
    expect(draftReplyHrefFor(item({ fingerprint: "email:thread:" }))).toBeNull();
    expect(draftReplyHrefFor(item({ fingerprint: "email:thread:bad id/../x:m1" }))).toBeNull();
  });

  it("AttentionRow shows the link only when given one", () => {
    expect(textOf(renderToStaticMarkup(createElement(AttentionRow, { item: item(), now: NOW_ISO, tz: TZ })))).not.toContain("Draft reply");
    const html = renderToStaticMarkup(createElement(AttentionRow, { item: item(), now: NOW_ISO, tz: TZ, draftReplyHref: "/executive/email/drafts/new?threadId=t_thread1" }));
    expect(textOf(html)).toContain("Draft reply");
    expect(html).toContain('href="/executive/email/drafts/new?threadId=t_thread1"');
  });

  it("AttentionFeed passes it for email items while drafts are on, never for DD items, never while off", () => {
    const items = [item(), item({ id: "ea_2", source: "dd", fingerprint: "dd:task:t1" })];
    const on = renderToStaticMarkup(createElement(AttentionFeed, { items, now: NOW_ISO, tz: TZ, checkedAt: NOW_ISO, draftsEnabled: true }));
    expect((on.match(/data-draft-reply/g) ?? []).length).toBe(1);
    const off = renderToStaticMarkup(createElement(AttentionFeed, { items, now: NOW_ISO, tz: TZ, checkedAt: NOW_ISO }));
    expect(off).not.toContain("data-draft-reply");
  });
});

describe("UI07: the kit stays server-side, no raw HTML, and the drafts islands are exactly these", () => {
  const KIT = path.join(SRC, "components", "exec");

  it("no dangerouslySetInnerHTML anywhere under components/exec or the draft pages", () => {
    const pages = filesUnder(path.join(SRC, "app", "(main)", "executive", "email", "drafts"));
    const offenders = [...filesUnder(KIT), ...pages].filter((f) => readFileSync(f, "utf8").includes("dangerouslySetInnerHTML"));
    expect(offenders).toEqual([]);
  });

  it("AttentionRow and AttentionFeed are still server components", () => {
    for (const f of ["AttentionRow.tsx", "AttentionFeed.tsx"]) expect(readFileSync(path.join(KIT, f), "utf8")).not.toMatch(/^\s*["']use client["']/);
  });

  it("components/exec/drafts: the client islands are exactly the container, the dialog, the frame and the frame guard (AM2)", () => {
    const islands = filesUnder(path.join(KIT, "drafts"))
      .filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")))
      .map((f) => path.basename(f))
      .sort();
    expect(islands).toEqual(["ConfirmSendDialog.tsx", "DraftPanel.tsx", "ReadBackFrame.tsx", "frame-guard.ts"]);
  });

  it("the draft pages are server components that call the page gate first", () => {
    for (const rel of ["[id]/page.tsx", "new/page.tsx"]) {
      const src = readFileSync(path.join(SRC, "app", "(main)", "executive", "email", "drafts", rel), "utf8");
      expect(src, rel).not.toMatch(/^\s*["']use client["']/);
      expect(src, rel).toContain('export const dynamic = "force-dynamic"');
      expect(src, rel).not.toMatch(/export (const|async function) metadata|generateMetadata/);
      const body = src.slice(src.indexOf("export default async function"));
      const firstAwait = body.indexOf("await ");
      expect(body.slice(firstAwait, firstAwait + 40), rel).toContain("await requireExecPrincipalForPage(");
    }
  });

  it("no drafts file renders an Outlook webLink into an href", () => {
    for (const f of filesUnder(path.join(KIT, "drafts"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/href=\{[^}]*webLink/);
    }
  });

  it("the client files of components/exec/drafts import nothing server-only", () => {
    // P7b (§3.17.2 E5): DraftPanel's client-update line takes its copy from slack-intel-copy.ts, which B-P7b-8 keeps pure.
    const SERVER_ONLY = /from "@\/lib\/exec\/(?!drafts-types|drafts-links|refs|format|safe-markdown|slack-intel-copy")[^"]*"|from "@\/lib\/supabase|from "server-only"/;
    for (const f of filesUnder(path.join(KIT, "drafts"))) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n").filter((l) => /^import /.test(l) && !/^import type /.test(l))) {
        expect(line, path.basename(f)).not.toMatch(SERVER_ONLY);
      }
    }
  });
});

const drafts = (over: Partial<OverviewDraftsSystem> = {}): OverviewDraftsSystem => ({
  installed: true,
  draftsEnabled: true,
  sendEnabled: false,
  voiceEnabled: true,
  eaToken: { ok: true, reason: null, checkedAt: "2026-11-06T14:55:00.000Z", expiresAt: "2027-03-01T00:00:00.000Z" },
  sendToken: { ok: false, reason: "token_missing", checkedAt: "2026-11-06T14:55:00.000Z", expiresAt: null },
  cl2: { ready: true, send: "off" },
  counts: { active: 5, unknown: 1, sentMismatch7d: 0, goneUnconfirmed: 2, generationFailed24h: 1, restrictedLinked: 0, oldestDueAt: null },
  reconcile: { lastSucceededAt: null, overdueSince: null },
  voice: { status: "ready", builtAt: "2026-11-01T04:00:00.000Z", lastAttemptAt: "2026-11-01T04:00:00.000Z", lastAttemptError: null },
  ...over
});
const rows = (d: OverviewDraftsSystem | null) => renderToStaticMarkup(createElement(DraftsRows, { drafts: d, now: NOW_ISO, tz: TZ }));
const row = (html: string, name: string) => new RegExp(`<li[^>]*data-drafts-row="${name}"[^]*?</li>`).exec(html)?.[0] ?? "";

describe("UI09 / PX12: the System card's drafts rows", () => {
  it("renders each verdict and count", () => {
    const html = rows(drafts());
    const text = textOf(html);
    expect(textOf(row(html, "drafts"))).toBe("Assistant draftson");
    expect(textOf(row(html, "sending"))).toBe("Sendingoff");
    expect(textOf(row(html, "draft-token"))).toMatch(/^Draft tokenok, expires /);
    expect(textOf(row(html, "send-token"))).toBe("Send tokenthe sending key isn't set");
    expect(textOf(row(html, "clone"))).toBe("CloneCL2 ready, send off");
    expect(textOf(row(html, "attention"))).toBe("Drafts needing attention1 unknown, 0 mismatched, 2 checking, 1 failed");
    expect(textOf(row(html, "checks"))).toBe("Draft checksno run in the last 48 h");
    expect(text).toContain("Voice profileready");
  });

  it("a token expiring within 30 days is amber", () => {
    const soon = rows(drafts({ eaToken: { ok: true, reason: null, checkedAt: NOW_ISO, expiresAt: "2026-11-20T00:00:00.000Z" } }));
    expect(row(soon, "draft-token")).toContain("text-amber-700");
    expect(row(rows(drafts()), "draft-token")).not.toContain("text-amber-700");
    expect(textOf(row(rows(drafts({ eaToken: { ok: false, reason: "wrong_accounts", checkedAt: NOW_ISO, expiresAt: null } })), "draft-token"))).toContain(
      "the drafting key is for a different mailbox"
    );
    expect(textOf(row(rows(drafts({ eaToken: { ok: false, reason: "not_checked", checkedAt: null, expiresAt: null } })), "draft-token"))).toContain("not checked yet");
  });

  it("each field fails soft on its own: couldn't load, never a zero", () => {
    const html = rows(drafts({ eaToken: null, counts: null, reconcile: null, voice: null }));
    expect(textOf(row(html, "draft-token"))).toContain("couldn't load");
    expect(textOf(row(html, "attention"))).toContain("couldn't load");
    expect(textOf(row(html, "checks"))).toContain("couldn't load");
    expect(textOf(row(html, "voice"))).toContain("couldn't load");
    expect(textOf(row(html, "send-token"))).toContain("the sending key isn't set");
    expect(textOf(rows(null))).toContain("Couldn't load the assistant drafts status.");
  });

  it("no reconcile run for 48 h because nothing was due: no amber; overdueSince > 15 min with no run since: amber", () => {
    expect(row(rows(drafts({ reconcile: { lastSucceededAt: null, overdueSince: null } })), "checks")).not.toContain("text-amber-700");
    const due = (since: string, ran: string | null) => drafts({ reconcile: { lastSucceededAt: ran, overdueSince: since } });
    expect(row(rows(due("2026-11-06T14:50:00.000Z", null)), "checks")).not.toContain("text-amber-700");
    const late = rows(due("2026-11-06T14:40:00.000Z", null));
    expect(row(late, "checks")).toContain("text-amber-700");
    expect(textOf(row(late, "checks"))).toContain("a check has been due since 20 min ago");
    expect(row(rows(due("2026-11-06T14:40:00.000Z", "2026-11-06T14:45:00.000Z")), "checks")).not.toContain("text-amber-700");
    expect(draftChecksOverdue({ lastSucceededAt: "2026-11-06T14:30:00.000Z", overdueSince: "2026-11-06T14:40:00.000Z" }, NOW_ISO)).toBe(true);
    expect(draftChecksOverdue(null, NOW_ISO)).toBe(false);
  });

  it("the voice row: ready <date>, not enough samples, failed (<last_attempt_error in words>), last tried <date>", () => {
    expect(textOf(row(rows(drafts({ voice: { status: "insufficient", builtAt: null, lastAttemptAt: "2026-11-01T04:00:00.000Z", lastAttemptError: null } })), "voice"))).toMatch(
      /not enough samples, last tried /
    );
    const failed = textOf(row(rows(drafts({ voice: { status: "failed", builtAt: null, lastAttemptAt: "2026-11-01T04:00:00.000Z", lastAttemptError: "read_failed" } })), "voice"));
    expect(failed).toMatch(/failed \(your sent mail couldn't be read\), last tried /);
    expect(textOf(row(rows(drafts({ voice: { status: null, builtAt: null, lastAttemptAt: null, lastAttemptError: null } })), "voice"))).toContain("not built yet");
  });

  it("SystemSection shows the drafts rows only when the overview has them", () => {
    const base: OverviewSystem = { kinds: [], successLookbackHours: 48, dead24h: 0, queued: 0, due: 0, oldestDueAt: null };
    const without = renderToStaticMarkup(createElement(SystemSection, { system: { ok: true, data: base }, now: NOW_ISO }));
    expect(without).not.toContain("data-drafts-system");
    const withRows = renderToStaticMarkup(createElement(SystemSection, { system: { ok: true, data: { ...base, drafts: drafts() } }, now: NOW_ISO, tz: TZ }));
    expect(withRows).toContain("data-drafts-system");
  });
});

function onTab(over: Partial<Extract<EmailTabData, { state: "on" }>> = {}): EmailTabData {
  const empty = { reply: [], urgent: [], important: [], waiting: [], filtered: [] };
  return {
    state: "on",
    generatedAt: NOW_ISO,
    timezone: TZ,
    freshness: {
      accounts: { ok: true, data: { checkedAt: NOW_ISO, mailboxes: [{ accountId: "acc_his", address: "mitchell@scaledai.org", lastSyncedAt: NOW_ISO, failingSince: null, failingError: null, problem: null }] } },
      socket: { ok: true, data: { connected: true, observedAt: NOW_ISO, lastEventAt: null, stale: false } },
      sync: { ok: true, data: { signals: "available", catchingUp: false, catchingUpUntil: null } },
      satisfaction: { ok: true, data: { fresh: 2, active: 5, freshDays: 3 } }
    },
    buckets: { ok: true, data: { counts: { reply: 0, urgent: 0, important: 0, waiting: 0, filtered: 0 }, lists: empty, limit: 100 } },
    restricted: { ok: true, data: 0 },
    drafts: { ok: true, data: { draftsPending: 4, scheduledReplies: 1, execDraftsActive: 3, execDraftsAttention: 1 } },
    commitments: { ok: true, data: { items: [], total: 0, overdue: 0, limit: 20 } },
    draftsBucket: { state: "ok", items: [], draftsOn: true },
    ...over
  } as unknown as EmailTabData;
}

describe("UI10: the Email page's drafts card and the Drafts view", () => {
  const tab = (view: EmailTabData, bucketName?: string) => renderToStaticMarkup(createElement(EmailTabView, { view, bucket: bucketName }));

  it("labels the assistant's drafts and the legacy counts separately", () => {
    const text = textOf(tab(onTab()));
    expect(text).toContain("Assistant drafts3 (1 need attention)");
    expect(text).toContain("Awaiting approval4");
    expect(text).toContain("Scheduled to send1");
  });

  it("a failed exec count reads 'couldn't load', the legacy counts still show", () => {
    const text = textOf(tab(onTab({ drafts: { ok: true, data: { draftsPending: 4, scheduledReplies: 1, execDraftsActive: null, execDraftsAttention: null } } })));
    expect(text).toContain("Assistant draftscouldn't load");
    expect(text).toContain("Awaiting approval4");
    expect(execDraftCountLabel(2, 0)).toBe("2");
    expect(execDraftCountLabel(2, null)).toBe("2 (attention couldn't load)");
  });

  it("before the drafts schema exists the card is P3's (no assistant line), and there's no Drafts view link", () => {
    const html = tab(onTab({ draftsBucket: undefined }));
    expect(textOf(html)).not.toContain("Assistant drafts");
    expect(html).not.toContain("bucket=drafts");
  });

  it("?bucket=drafts renders the Drafts view in place of the email buckets", () => {
    const html = tab(onTab({ draftsBucket: { state: "ok", items: [listItem({ id: "ed_z", label: "Shown in the view" })], draftsOn: true } }), "drafts");
    expect(html).toContain('data-drafts-bucket="ok"');
    expect(textOf(html)).toContain("Shown in the view");
    expect(html).not.toContain("bucket-tab-reply");
    expect(textOf(tab(onTab({ draftsBucket: undefined }), "drafts"))).toContain("Assistant drafts aren't set up yet.");
  });
});

describe("X7: the list row's chip", () => {
  const rowView = (over: Partial<EmailRowView> = {}): EmailRowView => ({
    threadId: "t1",
    href: "/executive/email/t1",
    subject: "Contract renewal",
    counterpartName: "Jane",
    counterpartEmail: "jane@acme.com",
    messageCount: 2,
    lastActivityAt: NOW_ISO,
    lastInboundAt: NOW_ISO,
    lastOutboundAt: null,
    state: "triaged",
    answered: "awaiting_reply",
    summary: null,
    reason: null,
    category: null,
    urgency: null,
    importance: null,
    needsReply: true,
    decisionQuestion: null,
    clientSignal: null,
    injectionSuspected: false,
    client: null,
    flagged: false,
    partialThread: false,
    filterReason: null,
    triageError: null,
    lastAttemptError: null,
    assessable: false,
    ...over
  });
  const render = (row: EmailRowView) => renderToStaticMarkup(createElement(EmailRowItem, { row, tz: TZ, now: NOW_ISO }));

  it("Draft ready / Drafting… / Check Sent Items, linking to the draft; none otherwise", () => {
    const ready = render(rowView({ execDraft: { id: "ed_1", status: "saved" } }));
    expect(textOf(ready)).toContain("Draft ready");
    expect(ready).toContain(`href="${draftPageHref("ed_1")}"`);
    expect(textOf(render(rowView({ execDraft: { id: "ed_1", status: "generating" } })))).toContain("Drafting…");
    expect(textOf(render(rowView({ execDraft: { id: "ed_1", status: "unknown" } })))).toContain("Check Sent Items");
    expect(render(rowView({ execDraft: { id: "ed_1", status: "sending" } }))).not.toContain("data-draft-chip");
    expect(render(rowView())).not.toContain("data-draft-chip");
  });

  it("the reply_sent_pending overlay reads 'Reply sent, syncing'", () => {
    expect(textOf(render(rowView({ answered: "reply_sent_pending" })))).toContain("Reply sent, syncing");
    expect(COPY.restrictedRow).toBe("Draft for a restricted thread");
  });
});

// P9 F27: after Save, Send or Discard the draft's new state is announced by a region that was already there, and focus
// lands on it (never <body>) when the pressed button is gone or the send dialog closed.
describe("P9 F27: draft actions announce their outcome and keep focus", () => {
  const banner = (view: ReturnType<typeof draftView>) => renderToStaticMarkup(createElement(DraftStatusBanner, { view, tz: TZ, nowIso: NOW_ISO }));
  const headline = (markup: string) => /<p tabindex="-1" role="status" aria-live="polite" data-banner-headline="true" class="[^"]*">([^<]*)<\/p>/.exec(markup)?.[1] ?? null;
  const LINKED = { linked: true, webLink: WEB_LINK };

  it("the headline is one persistent status region, focusable by script, in every state; its text follows the state", () => {
    const draft = headline(banner(draftView({ status: "draft" })));
    const saved = headline(banner(draftView({ status: "saved", savedVersion: 3, outlook: LINKED })));
    const sending = headline(banner(draftView({ status: "sending", savedVersion: 3, outlook: LINKED })));
    const discarded = headline(banner(draftView({ status: "discarded" })));
    for (const h of [draft, saved, sending, discarded]) expect(h).not.toBeNull();
    expect(new Set([draft, saved, sending, discarded]).size).toBe(4);
    expect(saved).toBe("Saved in your Outlook Drafts. People with access to your mailbox can see it.");
  });

  it("draftFocusTarget: the send dialog closing, or an action ending with focus lost, puts focus on the headline", () => {
    const idle = { busy: false, sending: false };
    expect(draftFocusTarget({ busy: false, sending: true }, idle, false)).toBe("headline");
    expect(draftFocusTarget({ busy: true, sending: false }, idle, true)).toBe("headline");
    expect(draftFocusTarget({ busy: true, sending: false }, idle, false)).toBeNull();
    expect(draftFocusTarget(idle, { busy: true, sending: false }, true)).toBeNull();
    expect(draftFocusTarget(idle, idle, true)).toBeNull();
  });

  it("DraftPanel wires it: the banner gets the headline ref, and the effect focuses it from draftFocusTarget", () => {
    const src = readFileSync(path.join(SRC, "components", "exec", "drafts", "DraftPanel.tsx"), "utf8");
    expect(src).toMatch(/headlineRef=\{headlineRef\}/);
    expect(src).toMatch(/draftFocusTarget\(prev, next, lost\) === "headline"\) headlineRef\.current\?\.focus\(\)/);
    expect(src).toMatch(/\}, \[busy, sending\]\);/);
  });

  it("AssessButton's status region is mounted (empty) before any click", () => {
    const idle = renderToStaticMarkup(createElement(AssessButton, { threadId: "t_1" }));
    expect(idle).toMatch(/<span role="status" aria-live="polite" data-assess-status="true" class="sr-only"><\/span>/);
  });
});
