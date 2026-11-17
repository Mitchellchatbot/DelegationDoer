import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import leadPages from "@/lib/exec/__tests__/fixtures/p10/lead-history-pages.json";
import { P10_PHI_SENTINELS } from "@/lib/exec/__tests__/p10-assert";
import { slackPageView } from "@/lib/exec/__tests__/p7b-ui-fixtures";
import { LeadCountsCard } from "@/components/exec/slack/LeadCountsCard";
import { SlackPageView } from "@/components/exec/slack/SlackPageView";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { LeadCountsView, LeadsViewState, LeadTriple } from "@/lib/exec/slack-p10-types";
import type { Section } from "@/lib/exec/view-types";

// P10 §5.13 RU13 and §5.4 LP06 (contract §3.9.2, C62, Appendix C; Area B): the Slack tab's lead counts card, a server component
// rendered from its view only. Invented names only.

const C = SLACK_P10_COPY.leads;
const NOW = "2026-11-10T15:00:00.000Z";
const TZ = "America/New_York";
const t = (vob: number, nonvob = 0, calendly = 0): LeadTriple => ({ vob, nonvob, calendly });
const ok = (over: Partial<LeadCountsView> = {}): LeadCountsView => ({
  state: "ok", asOf: "2026-11-10T14:30:00.000Z", tz: TZ,
  totals: { today: t(3, 1, 1), yesterday: t(4, 2, 2), last7: t(8, 3, 3), kinds: ["vob", "nonvob", "calendly", "zap_errors"] },
  clients: [
    { label: "Zenith House", clientId: "cl_zenith", today: t(2, 1, 1), yesterday: t(3, 2, 2), last7: t(6, 3, 3), kinds: ["vob", "nonvob", "calendly", "zap_errors"],
      zapToday: 1, zapYesterday: 2, incomplete: false },
    { label: "Acme Recovery", clientId: "cl_acme", today: t(1), yesterday: t(1), last7: t(2), kinds: ["vob"], zapToday: 0, zapYesterday: 0, incomplete: false }
  ],
  unlinked: { today: t(0), yesterday: t(2), last7: t(2) },
  coverage: { channels: 8, linked: 5, unlinked: 1, ambiguous: 1, otherKind: 1, withError: 0, neverCounted: 0, oldestCountedAt: "2026-11-10T14:00:00.000Z",
    skippedToday: 2, listedNotMember: 2, lastRunAt: "2026-11-10T14:30:00.000Z", lastError: null },
  fix: {
    unlinked: [{ href: "https://slack.com/app_redirect?channel=G0LEADUNL1&team=T0ZENITH", kind: "vob" }],
    ambiguous: [{ href: "https://slack.com/app_redirect?channel=C0AMB1&team=T0ZENITH", kind: "nonvob" }],
    notMember: [{ client: "Acme Recovery", names: ["#acme-recovery-calendly"] }, { client: "Zenith House", names: ["#zenith-house-fb-leads"] }],
    more: 0
  },
  ...over
});
const card = (section: Section<LeadCountsView>) => renderToStaticMarkup(createElement(LeadCountsCard, { section, tz: TZ, now: NOW }));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("RU13 the table", () => {
  it("countsOnly; a caption and th scopes; the All clients row first; each cell a leadCountsLine over the client's kinds", () => {
    const h = card({ ok: true, data: ok() });
    expect(h).toContain('id="leads"');
    expect(text(h)).toContain(C.countsOnly);
    expect(h).toContain(`<caption class="sr-only">${C.tableCaption}</caption>`);
    expect(h.split('scope="col"').length - 1).toBe(4);
    expect(h.split('scope="row"').length - 1).toBe(4);
    const rows = [...h.matchAll(/data-lead-row="([a-z]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["all", "client", "client", "unlinked"]);
    expect(text(h)).toContain("All clients");
    expect(text(h)).toContain("2 VOBs · 1 non-VOB · 1 Calendly post");
    expect(text(h)).toContain("6 VOBs · 3 non-VOBs · 3 Calendly posts");
    // Acme counts only VOBs: never a "0 non-VOBs" for a kind it has no channel for.
    const acme = h.slice(h.indexOf("Acme Recovery"), h.indexOf('data-lead-row="unlinked"'));
    expect(text(acme)).not.toContain("non-VOB");
    expect(text(h)).toContain(C.unlinked);
  });
  it("the Zapier chip by day (product-19); As of; the 390 px stack (block below sm, the column names per cell)", () => {
    const h = card({ ok: true, data: ok() });
    expect(h).toContain('data-lead-zap="today"');
    expect(text(h)).toContain("1 Zapier error today");
    expect(text(h)).toContain("2 Zapier errors yesterday");
    expect(text(h)).toMatch(/As of /);
    expect(h).toMatch(/<tr data-lead-row="all" class="block [^"]*sm:table-row/);
    expect(h).toContain('<span class="font-medium text-slate-500 sm:hidden">Today: </span>');
  });
  it("Appendix C: the Calendly note under the table whenever a row shows the Calendly kind; absent without", () => {
    expect(text(card({ ok: true, data: ok() }))).toContain(C.calendlyNote);
    const noCal = ok({
      totals: { today: t(1), yesterday: t(1), last7: t(2), kinds: ["vob"] },
      clients: [{ label: "Acme Recovery", clientId: "cl_acme", today: t(1), yesterday: t(1), last7: t(2), kinds: ["vob"], zapToday: 0, zapYesterday: 0, incomplete: false }],
      unlinked: null
    });
    expect(text(card({ ok: true, data: noCal }))).not.toContain(C.calendlyNote);
  });
});

describe("RU13 coverage and the fix lists (product-10, Appendix C)", () => {
  it("each coverage line only when > 0; Open in Slack links under unlinked and ambiguous; the not-member lines after them, plain", () => {
    const h = card({ ok: true, data: ok() });
    const tx = text(h);
    // P10 fixer ui-10: the singular for a count of 1 (the *One copy), the plural otherwise.
    expect(tx).toContain("1 lead channel isn't on any client's FB onboarding Notifications card. Add it there to see it by client.");
    expect(tx).toContain("1 lead channel matches more than one client's card. Fix the cards to see it by client.");
    expect(tx).toContain("2 listed lead channels aren't counted because you're not a member.");
    expect(tx).toContain("1 listed channel isn't a lead channel by name and isn't counted.");
    expect(tx).toContain("2 posts today came from people, not from Zapier, and weren't counted.");
    expect(tx).not.toMatch(/\b1 (lead channels|listed channels|posts)\b/);
    const plural = text(card({ ok: true, data: ok({ coverage: { ...ok().coverage!, unlinked: 3, ambiguous: 2, otherKind: 4, skippedToday: 1, listedNotMember: 1 } }) }));
    expect(plural).toContain("3 lead channels aren't on any client's FB onboarding Notifications card.");
    expect(plural).toContain("2 lead channels match more than one client's card.");
    expect(plural).toContain("4 listed channels aren't lead channels by name and aren't counted.");
    expect(plural).toContain("1 post today came from a person, not from Zapier, and wasn't counted.");
    expect(plural).toContain("1 listed lead channel isn't counted because you're not a member.");
    expect(h.split("data-lead-fix-link").length - 1).toBe(2);
    expect(h).toContain('href="https://slack.com/app_redirect?channel=G0LEADUNL1&amp;team=T0ZENITH"');
    expect(tx).toContain(C.fixUnlinked);
    expect(tx).toContain(C.fixAmbiguous);
    expect(tx).toContain("Not counted for Acme Recovery (you're not a member): #acme-recovery-calendly");
    expect(tx).toContain("Not counted for Zenith House (you're not a member): #zenith-house-fb-leads");
    const notCounted = h.slice(h.indexOf("data-lead-not-counted"));
    expect(h.indexOf("data-lead-not-counted")).toBeGreaterThan(h.lastIndexOf("data-lead-fix-link"));
    expect(notCounted.slice(0, notCounted.indexOf("</ul>"))).not.toMatch(/amber|rose|<a /);
    expect(tx).not.toMatch(/ask to be added|join|mute/i);
    const none = card({ ok: true, data: ok({ coverage: { ...ok().coverage!, unlinked: 0, ambiguous: 0, otherKind: 0, skippedToday: 0, listedNotMember: 0 },
      fix: { unlinked: [], ambiguous: [], notMember: [], more: 0 } }) });
    expect(none).not.toContain("data-lead-coverage");
    const more = card({ ok: true, data: ok({ fix: { ...ok().fix!, more: 7 } }) });
    expect(text(more)).toContain("+7 more");
  });
  it("an incomplete client adds the incomplete line", () => {
    const v = ok();
    v.clients[1] = { ...v.clients[1], incomplete: true };
    expect(text(card({ ok: true, data: v }))).toContain(C.incomplete);
  });
  it("P10 fixer correctness-3: the view's own incomplete flag (an unlinked channel, a client with no row yet) adds the line too", () => {
    expect(text(card({ ok: true, data: ok() }))).not.toContain(C.incomplete);
    expect(text(card({ ok: true, data: ok({ incomplete: true }) }))).toContain(C.incomplete);
  });
  it("P10 fixer ui-8: the column headers are AA on the white card (text-muted, slate-500 4.76:1), never slate-400 (2.56:1)", () => {
    const h = card({ ok: true, data: ok() });
    const heads = [...h.matchAll(/<th scope="col" class="([^"]*)"/g)].map((m) => m[1]);
    expect(heads).toHaveLength(4);
    for (const cls of heads) {
      expect(cls).toContain("text-muted");
      expect(cls).not.toContain("text-slate-400");
    }
  });
});

describe("RU13 every other state shows its sentence; no_channels keeps the not-member lines", () => {
  const states: Exclude<LeadsViewState, "ok">[] = ["off", "not_installed", "reading_off", "first_run", "no_channels", "unavailable"];
  for (const state of states) {
    it(state, () => {
      const h = card({ ok: true, data: { ...ok(), state, totals: null, clients: [], unlinked: null, fix: state === "no_channels" ? ok().fix : null,
        coverage: state === "no_channels" ? { ...ok().coverage!, channels: 0 } : null } });
      expect(h).toContain(`data-lead-state="${state}"`);
      expect(text(h)).toContain(C.states[state]);
      expect(h).not.toContain("data-lead-table");
      if (state === "no_channels") {
        expect(text(h)).toContain("Not counted for Acme Recovery (you're not a member): #acme-recovery-calendly");
        expect(text(h)).toContain("2 listed lead channels aren't counted because you're not a member.");
      }
    });
  }
  it("a failed section → Couldn't load lead counts.", () => {
    expect(text(card({ ok: false, error: "unavailable" }))).toContain(C.states.unavailable);
  });
});

describe("RU13 placement: full width right after the counts strip, before the catch-up list", () => {
  it("in SlackPageView", () => {
    const h = renderToStaticMarkup(createElement(SlackPageView, { view: slackPageView({ leads: { ok: true, data: ok() } }) }));
    const counts = h.indexOf("data-slack-counts");
    const leads = h.indexOf('id="leads"');
    const catchUp = h.indexOf("data-catchup");
    expect(counts).toBeGreaterThan(0);
    expect(leads).toBeGreaterThan(counts);
    expect(leads).toBeLessThan(catchUp);
  });
});

describe("LP06 the card holds no lead post content and a lead channel id only in an Open in Slack href", () => {
  it("no sentinel, no Slack channel name, ids only inside app_redirect hrefs", () => {
    const h = card({ ok: true, data: ok() });
    for (const s of P10_PHI_SENTINELS) expect(h.toLowerCase()).not.toContain(s.toLowerCase());
    expect(h).not.toContain("sentinel-patient-name");
    const ids = leadPages.markers.map((m) => m.channelId).concat(["C0AMB1"]);
    const outsideHrefs = h.replace(/href="https:\/\/slack\.com\/app_redirect\?channel=[CG][A-Z0-9]+&amp;team=T[A-Z0-9]+"/g, "");
    for (const id of ids) expect(outsideHrefs, id).not.toContain(id);
    // The not-member names are the FB cards' typed names (DD data), never a Slack name of an unlisted channel.
    for (const ch of leadPages.channels.filter((c) => c.expect.link === "none")) expect(h).not.toContain(ch.slackName);
  });
});
