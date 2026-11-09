import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  listClientMatchSignals: vi.fn(),
  listTasksByIds: vi.fn(),
  listEodSlackAnchors: vi.fn()
}));
vi.mock("@/lib/exec/sources/mail", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/mail")>()), listInternalAddresses: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { createFakeSlackIntelDb } from "@/lib/exec/__tests__/fake-slack-intel-db";
import { INTEL_SENTINELS, assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { PRINCIPAL } from "@/lib/exec/__tests__/slack-read-jobs";
import { buildSlackCorrelator, effectiveLink, loadSlackCorrelator, type SlackCorrelatorInput } from "@/lib/exec/correlate-slack";
import { listPublicSlackFactsForClient } from "@/lib/exec/slack-intel-store";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { slackPrivacyOf, slackUsePolicy, type ChannelRow, type SlackMessageLink } from "@/lib/exec/slack-intel-types";
import { DdReadError, listClientMatchSignals, listEodSlackAnchors, listTasksByIds } from "@/lib/exec/sources/dd";
import type { DdClientMatchSignals, DdEodSlackAnchor, DdTask } from "@/lib/exec/sources/dd-types";
import { listInternalAddresses } from "@/lib/exec/sources/mail";

// P7b Area B: the correlator (contract §3.4, N18, C2–C5; §5.3 CO01–CO08, CO11, CO12 and the loader half of CO09). The
// channel rule over P7a's ChannelRow fixtures (channels.json), the message link's four arms and their precedence, the
// read-time inheritance, and the loader's fail-closed reads (the four DD / mail reads mocked at their module boundary).

const NOW = new Date("2026-11-08T15:00:00.000Z");
const CHANNELS = (JSON.parse(readFileSync(new URL("./__tests__/fixtures/slack-intel/channels.json", import.meta.url), "utf8")) as
  { rows: Record<string, ChannelRow> }).rows;
const ch = (name: keyof typeof CHANNELS & string, over: Partial<ChannelRow> = {}): ChannelRow => ({ ...CHANNELS[name], ...over });

function client(id: string, name: string, over: Partial<DdClientMatchSignals> = {}): DdClientMatchSignals {
  return { id, name, status: "active", website: null, websites: [], contactEmails: [], priority: null, ...over };
}
function task(id: string, over: Partial<DdTask> = {}): DdTask {
  return {
    id, title: INTEL_SENTINELS.taskTitle, status: "pending", priority: "medium", tags: [], departmentId: null, assigneeId: null, creatorId: "u_1",
    projectId: null, stageId: null, clientName: null, dueDate: null, createdAt: "2026-11-01T00:00:00.000Z", completedAt: null,
    lastActivityAt: "2026-11-01T00:00:00.000Z", archivedAt: null, archivedBy: null, isDraft: false, deletedAt: null, estimatedHours: 1, ...over
  } as DdTask;
}

const CLIENTS: DdClientMatchSignals[] = [
  client("cl_acme", "Acme Dental", { website: "https://www.acmedental.com/about", websites: ["acme-dental.co"] }),
  client("cl_beta", "Beta Labs", { websites: ["beta.io"] }),
  client("cl_gamma", "Gamma Group", { status: "inactive", website: "gamma.com" }),
  client("cl_abc", "Abc", { website: "abc-site.com" }),
  client("cl_twin1", "Twin Co"),
  client("cl_twin2", "Twin Co"),
  client("cl_null", "Null Status", { status: null }),
  // A client claiming our own domain, and one claiming an internal (connected-mailbox) domain: neither names a message.
  client("cl_ours", "Ours", { website: "https://scaledai.org" }),
  client("cl_inside", "Inside", { websites: ["agency-mail.com"] })
];
const TASKS = new Map<string, DdTask>([
  ["tk_acme", task("tk_acme", { clientName: "Acme Dental", projectId: "pr_seo" })],
  ["tk_acme2", task("tk_acme2", { clientName: " Acme Dental ", projectId: "pr_web" })],
  ["tk_near", task("tk_near", { clientName: "Acme Dental Inc" })],
  ["tk_case", task("tk_case", { clientName: "acme dental" })],
  ["tk_beta", task("tk_beta", { clientName: "Beta Labs", projectId: "pr_beta" })],
  ["tk_twin", task("tk_twin", { clientName: "Twin Co" })],
  ["tk_gamma", task("tk_gamma", { clientName: "Gamma Group" })],
  ["tk_none", task("tk_none", { clientName: null, projectId: "pr_none" })],
  ["tk_deleted", task("tk_deleted", { clientName: "Beta Labs", projectId: "pr_gone", deletedAt: "2026-11-02T00:00:00.000Z" })]
]);
const ANCHORS = new Map<string, { clientId: string | null; clientName: string }>([
  ["C0SCALEDTEAM:1794063600.000400", { clientId: "cl_acme", clientName: "Acme Dental" }],
  ["C0SCALEDTEAM:1794063700.000100", { clientId: null, clientName: "Beta Labs" }],
  ["C0SCALEDTEAM:1794063800.000100", { clientId: null, clientName: "Twin Co" }],
  ["C0SCALEDTEAM:1794063900.000100", { clientId: "cl_gamma", clientName: "Beta Labs" }],
  ["C0SCALEDTEAM:1794064000.000100", { clientId: "cl_unknown", clientName: "Acme Dental" }]
]);

const input = (over: Partial<SlackCorrelatorInput> = {}): SlackCorrelatorInput =>
  ({ clients: CLIENTS, internalDomains: ["agency-mail.com"], tasksById: TASKS, anchors: ANCHORS, now: NOW, ...over });
const correlator = buildSlackCorrelator(input());
const msg = (over: Partial<{ channelId: string; ts: string; isDdPost: boolean; ddPaths: string[]; summaries: string[] }> = {}) =>
  ({ channelId: "C0ACMESEO", ts: "1794060000.000100", isDdPost: false, ddPaths: [] as string[], summaries: [] as string[], ...over });
const verdictOf = (l: SlackMessageLink) => [l.clientId, l.clientName, l.clientMatchVia, l.matchConfidence, l.clientCandidates];
const NONE = [null, null, null, null, 0];

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  out = captureConsole();
});
afterEach(() => {
  // The correlator logs nothing at all (§0.3 rule 4).
  expect(out.calls()).toEqual([]);
  assertNoSlackLeak({ console: out });
});

describe("CO01 the channel-name rule (C3)", () => {
  const rule = (name: string | null, c = correlator) => c.channelRule(ch("publicWatched", { name }));
  it("an exact name, a slug- prefix and a -slug- token run name the client; it is low by the store's generated columns, never tagged here", () => {
    expect(rule("acme-dental")).toEqual({ clientId: "cl_acme", clientName: "Acme Dental", candidates: 1 });
    expect(rule("acme-dental-seo")).toEqual({ clientId: "cl_acme", clientName: "Acme Dental", candidates: 1 });
    expect(rule("team-acme-dental-ops")).toEqual({ clientId: "cl_acme", clientName: "Acme Dental", candidates: 1 });
    expect(rule("ops-acme-dental")).toEqual({ clientId: "cl_acme", clientName: "Acme Dental", candidates: 1 });
    // The fixture's own channel (name "acme-dental-seo").
    expect(correlator.channelRule(CHANNELS.publicWatched)).toEqual({ clientId: "cl_acme", clientName: "Acme Dental", candidates: 1 });
  });

  it("near misses don't: glued letters, another separator, a partial token", () => {
    for (const name of ["acmedental", "xacme-dental", "acme-dentalx", "acme_dental", "acme-dent", "dental-acme"]) expect(rule(name), name).toEqual({ clientId: null, clientName: null, candidates: 0 });
  });

  it("a slug under 4 characters is ignored; an inactive client never matches; status null counts as active", () => {
    expect(rule("abc-launch")).toEqual({ clientId: null, clientName: null, candidates: 0 });
    expect(rule("abc")).toEqual({ clientId: null, clientName: null, candidates: 0 });
    expect(rule("gamma-group-ops")).toEqual({ clientId: null, clientName: null, candidates: 0 });
    expect(rule("null-status")).toEqual({ clientId: "cl_null", clientName: "Null Status", candidates: 1 });
  });

  it("two clients → candidates 2 and no client; two clients of one name are two candidates", () => {
    expect(rule("acme-dental-beta-labs")).toEqual({ clientId: null, clientName: null, candidates: 2 });
    expect(rule("twin-co")).toEqual({ clientId: null, clientName: null, candidates: 2 });
  });

  it("the stored name is DD's (clipped to the column's 200 characters); a client without a name is never one", () => {
    const long = `Longname ${"x".repeat(250)}`;
    const c = buildSlackCorrelator(input({ clients: [client("cl_long", long), client("cl_blank", "   ")] }));
    expect(c.activeClients).toBe(1);
    expect(c.channelRule(ch("publicWatched", { name: `longname-${"x".repeat(250)}` }))).toEqual({ clientId: "cl_long", clientName: long.slice(0, 200), candidates: 1 });
    expect(correlator.activeClients).toBe(8);
  });
});

describe("CO02 which conversations get a channel verdict", () => {
  it("hub, deny, unclassified, 1:1 DM, unwatched and left → null (no verdict at all)", () => {
    for (const name of ["hubOutbound", "hubClientEmail", "denyLead", "ddBotDm", "selfDm", "unclassified", "im", "publicUnwatched", "leftPrivate"] as const) {
      expect(correlator.channelRule(CHANNELS[name]), name).toBeNull();
    }
    // A watched channel he has left, an unknown watch state or conversation type, fail closed.
    expect(correlator.channelRule(ch("publicWatched", { leftAt: "2026-11-07T00:00:00.000Z" }))).toBeNull();
    expect(correlator.channelRule(ch("publicWatched", { watchState: "paused" as ChannelRow["watchState"] }))).toBeNull();
    expect(correlator.channelRule(ch("publicWatched", { convType: "weird" as ChannelRow["convType"] }))).toBeNull();
    expect(correlator.channelRule(null as unknown as ChannelRow)).toBeNull();
  });

  it("a muted standard channel, a finance channel (muted or watched), Slack Connect, ext_ever, archived and a group DM still get one", () => {
    for (const name of ["publicMuted", "publicSlackMuted", "financeMuted", "financeWatched", "externalShared", "externalFinanceName", "extEverUnshared",
      "archived", "privateWatched", "mpim"] as const) {
      expect(correlator.channelRule(CHANNELS[name]), name).not.toBeNull();
    }
    // A group DM has no name: an empty verdict.
    expect(correlator.channelRule(CHANNELS.mpim)).toEqual({ clientId: null, clientName: null, candidates: 0 });
  });
});

describe("CO03 the anchor arm (dd_post, C4)", () => {
  const at = (ts: string, over = {}) => correlator.messageLink(msg({ channelId: "C0SCALEDTEAM", ts, isDdPost: true, ...over }));
  it("an anchor row's active client → dd_post / high", () => {
    expect(verdictOf(at("1794063600.000400"))).toEqual(["cl_acme", "Acme Dental", "dd_post", "high", 1]);
  });
  it("no client id: the one active client its name names exactly → high; a name two clients share → none", () => {
    expect(verdictOf(at("1794063700.000100"))).toEqual(["cl_beta", "Beta Labs", "dd_post", "high", 1]);
    expect(verdictOf(at("1794063800.000100"))).toEqual(NONE);
  });
  it("an inactive or unknown client id gives nothing (its name is not a fallback)", () => {
    expect(verdictOf(at("1794063900.000100"))).toEqual(NONE);
    expect(verdictOf(at("1794064000.000100"))).toEqual(NONE);
  });
  it("only that exact (channel, ts): the same ts elsewhere is no anchor", () => {
    expect(verdictOf(at("1794063600.000400", { channelId: "C0ACMESEO" }))).toEqual(NONE);
  });
});

describe("CO04 /clients/<id> paths (dd_link)", () => {
  const link = (paths: string[]) => verdictOf(correlator.messageLink(msg({ ddPaths: paths })));
  it("one active client → dd_link / high; two → none from this arm; an inactive id doesn't count", () => {
    expect(link(["/clients/cl_acme"])).toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
    expect(link(["/clients/cl_acme", "/clients/cl_beta"])).toEqual(NONE);
    expect(link(["/clients/cl_gamma"])).toEqual(NONE);
    expect(link(["/clients/cl_unknown"])).toEqual(NONE);
    expect(link(["/clients/cl_gamma", "/clients/cl_beta"])).toEqual(["cl_beta", "Beta Labs", "dd_link", "high", 1]);
    expect(link(["/clients/cl_acme", "/clients/cl_acme"])).toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
  });
});

describe("CO05 the linked tasks' client (dd_link)", () => {
  const link = (paths: string[]) => verdictOf(correlator.messageLink(msg({ ddPaths: paths })));
  it("a task whose client_name exactly (trimmed, case-sensitive) names one active client → high", () => {
    expect(link(["/tasks/tk_acme"])).toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
    expect(link(["/tasks/tk_acme2"])).toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
    expect(link(["/tasks/tk_acme", "/tasks/tk_acme2", "/tasks/tk_none"])).toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
  });
  it("a near-miss name, another case, an inactive client, a shared name or no name → none", () => {
    for (const id of ["tk_near", "tk_case", "tk_gamma", "tk_twin", "tk_none"]) expect(link([`/tasks/${id}`]), id).toEqual(NONE);
  });
  it("tasks naming two clients → none; a deleted task or a missing one names nothing", () => {
    expect(link(["/tasks/tk_acme", "/tasks/tk_beta"])).toEqual(NONE);
    expect(link(["/tasks/tk_deleted"])).toEqual(NONE);
    expect(link(["/tasks/tk_missing"])).toEqual(NONE);
  });
});

describe("CO06 the domain arm (summaries only)", () => {
  const link = (summaries: string[]) => verdictOf(correlator.messageLink(msg({ summaries })));
  it("one client's website → domain / medium; www., scheme and path don't matter", () => {
    expect(link(["Rankings moved for acmedental.com this week"])).toEqual(["cl_acme", "Acme Dental", "domain", "medium", 1]);
    expect(link(["See https://www.acme-dental.co/pricing"])).toEqual(["cl_acme", "Acme Dental", "domain", "medium", 1]);
    expect(link(["acmedental.com", "acme-dental.co again"])).toEqual(["cl_acme", "Acme Dental", "domain", "medium", 1]);
  });
  it("two clients' sites → domain / low with the candidates and no client", () => {
    expect(link(["acmedental.com vs beta.io"])).toEqual([null, null, "domain", "low", 2]);
    expect(link(["acmedental.com", "beta.io"])).toEqual([null, null, "domain", "low", 2]);
  });
  it("an internal domain and scaledai.org never name a client, whoever claims them; emails and inactive clients' sites don't either", () => {
    expect(link(["Mail from agency-mail.com and scaledai.org"])).toEqual(NONE);
    expect(link(["ops@acmedental.com wrote"])).toEqual(NONE);
    expect(link(["gamma.com launch"])).toEqual(NONE);
    expect(link(["blog.acmedental.com"])).toEqual(NONE);
    // A site of ours alongside a client's: only the client's counts.
    expect(link(["scaledai.org for acmedental.com"])).toEqual(["cl_acme", "Acme Dental", "domain", "medium", 1]);
  });
});

describe("CO07 precedence: dd_post > dd_link > domain", () => {
  it("an anchor beats a client path, a task and a site", () => {
    const l = correlator.messageLink(msg({ channelId: "C0SCALEDTEAM", ts: "1794063600.000400", isDdPost: true,
      ddPaths: ["/clients/cl_beta", "/tasks/tk_beta"], summaries: ["beta.io"] }));
    expect(verdictOf(l)).toEqual(["cl_acme", "Acme Dental", "dd_post", "high", 1]);
    // Its tasks and projects are kept whatever the verdict.
    expect([l.taskIds, l.projectIds]).toEqual([["tk_beta"], ["pr_beta"]]);
  });
  it("a client path beats a task of another client and a site; a task beats a site", () => {
    expect(verdictOf(correlator.messageLink(msg({ ddPaths: ["/clients/cl_beta", "/tasks/tk_acme"], summaries: ["acmedental.com"] }))))
      .toEqual(["cl_beta", "Beta Labs", "dd_link", "high", 1]);
    expect(verdictOf(correlator.messageLink(msg({ ddPaths: ["/tasks/tk_acme"], summaries: ["beta.io"] }))))
      .toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
    // Two client paths fall through to the tasks, then to the sites.
    expect(verdictOf(correlator.messageLink(msg({ ddPaths: ["/clients/cl_acme", "/clients/cl_beta", "/tasks/tk_beta"] }))))
      .toEqual(["cl_beta", "Beta Labs", "dd_link", "high", 1]);
    expect(verdictOf(correlator.messageLink(msg({ ddPaths: ["/tasks/tk_near"], summaries: ["beta.io"] }))))
      .toEqual(["cl_beta", "Beta Labs", "domain", "medium", 1]);
  });
  it("a DD post and an item are linked alike: the flag decides nothing by itself", () => {
    for (const isDdPost of [true, false]) {
      expect(verdictOf(correlator.messageLink(msg({ isDdPost, ddPaths: ["/clients/cl_acme"] })))).toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
    }
  });
});

describe("CO08 tasks, projects and threads", () => {
  it("taskIds = the paths' tasks that exist (not deleted); projectIds = path projects ∪ the tasks' projects; thread ids from inbox paths", () => {
    const l = correlator.messageLink(msg({ ddPaths: ["/tasks/tk_missing", "/tasks/tk_acme", "/tasks/tk_deleted", "/tasks/tk_none", "/projects/pr_x",
      "/projects/pr_seo", "/inboxes/acct_1?thread=th_42&view=all"] }));
    expect(l.taskIds).toEqual(["tk_acme", "tk_none"]);
    expect(l.projectIds).toEqual(["pr_x", "pr_seo", "pr_none"]);
    expect(l.emailThreadIds).toEqual(["th_42"]);
    expect([l.channelId, l.ts, l.checkedAt]).toEqual(["C0ACMESEO", "1794060000.000100", NOW.toISOString()]);
  });

  it("≤ 20 projects, path projects first", () => {
    const tasks = new Map(Array.from({ length: 15 }, (_, i) => [`tk_${i}`, task(`tk_${i}`, { projectId: `pr_task_${i}` })] as const));
    const c = buildSlackCorrelator(input({ tasksById: tasks }));
    const l = c.messageLink(msg({ ddPaths: [...Array.from({ length: 10 }, (_, i) => `/projects/pr_path_${i}`), ...Array.from({ length: 15 }, (_, i) => `/tasks/tk_${i}`)] }));
    expect(l.taskIds).toHaveLength(15);
    expect(l.projectIds).toHaveLength(20);
    expect(l.projectIds.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `pr_path_${i}`));
  });

  it("every link has the identical key set (P3 §0), matched or not; a malformed message yields an empty link, never a throw", () => {
    const keys = ["channelId", "ts", "clientId", "clientName", "clientMatchVia", "matchConfidence", "clientCandidates", "taskIds", "projectIds",
      "emailThreadIds", "checkedAt"].sort();
    for (const m of [msg(), msg({ ddPaths: ["/tasks/tk_acme"] }), msg({ summaries: ["beta.io"] }), msg({ channelId: "C0SCALEDTEAM", ts: "1794063600.000400" })]) {
      expect(Object.keys(correlator.messageLink(m)).sort()).toEqual(keys);
    }
    const bad = correlator.messageLink({ channelId: "C0X", ts: "1.1", isDdPost: false, ddPaths: null, summaries: null } as unknown as Parameters<typeof correlator.messageLink>[0]);
    expect(verdictOf(bad)).toEqual(NONE);
    expect([bad.taskIds, bad.projectIds, bad.emailThreadIds]).toEqual([[], [], []]);
    // Without `now`, checkedAt is the time messageLink ran.
    const live = buildSlackCorrelator(input({ now: undefined })).messageLink(msg());
    expect(Math.abs(Date.parse(live.checkedAt) - Date.now())).toBeLessThan(60_000);
  });
});

describe("CO11 effectiveLink: read-time inheritance (dd_thread)", () => {
  const base = correlator.messageLink(msg());
  const own = { ...base, ts: "1794060100.000200", taskIds: ["tk_acme"] };
  const root = { ...base, clientId: "cl_beta", clientName: "Beta Labs", clientMatchVia: "dd_link" as const, matchConfidence: "high" as const, clientCandidates: 1 };
  it("own wins when it has any client, task or project", () => {
    expect(effectiveLink(own, root)).toEqual({ ...own, inherited: false });
    expect(effectiveLink({ ...base, projectIds: ["pr_1"] }, root)).toEqual({ ...base, projectIds: ["pr_1"], inherited: false });
    expect(effectiveLink({ ...base, clientId: "cl_acme", clientName: "Acme Dental", clientMatchVia: "domain", matchConfidence: "medium", clientCandidates: 1 }, null))
      .toMatchObject({ clientId: "cl_acme", inherited: false });
  });
  it("else the root's, via kept, inherited: true (an empty own, a domain-low verdict with no client, thread ids only, or none)", () => {
    for (const o of [base, null, { ...base, clientMatchVia: "domain" as const, matchConfidence: "low" as const, clientCandidates: 2 }, { ...base, emailThreadIds: ["th_1"] }]) {
      expect(effectiveLink(o, root)).toEqual({ ...root, inherited: true });
    }
  });
  it("neither has content → null", () => {
    expect(effectiveLink(null, null)).toBeNull();
    expect(effectiveLink(base, base)).toBeNull();
    expect(effectiveLink(null, { ...base, emailThreadIds: ["th_1"] })).toBeNull();
  });
});

describe("CO12 a finance-named Slack Connect channel", () => {
  it("gets at most the name rule (low, by the store's generated columns); the correlator has no other channel verdict", () => {
    const c = buildSlackCorrelator(input({ clients: [client("cl_acmeb", "Acme")] }));
    expect(c.channelRule(CHANNELS.externalFinanceName)).toEqual({ clientId: "cl_acmeb", clientName: "Acme", candidates: 1 });
  });
  it("is never public or draftable: the policy every public-fact read uses denies it (finance first, then Slack Connect)", () => {
    const row = CHANNELS.externalFinanceName;
    expect(slackPrivacyOf(row)).toBe("finance");
    expect(slackUsePolicy("ok", row, "draft")).toEqual({ allowed: false, reason: "muted" });
    expect(slackUsePolicy("ok", { ...row, watchState: "watched", muteSource: null }, "draft")).toEqual({ allowed: false, reason: "finance" });
    expect(slackPrivacyOf({ ...row, financeName: false })).toBe("external");
  });
  it("its items never reach listPublicSlackFactsForClient, even linked high and marked public (the fake twin of SQ20)", async () => {
    const at = "2026-11-08T14:00:00.000Z";
    const chan = (channel_id: string, over: Record<string, unknown>) => ({ principal_id: "ep_1", installation_id: CHANNELS.publicWatched.installationId, channel_id,
      conv_type: "channel", is_private: false, class: "standard", finance_name: false, watch_state: "watched", mute_source: null, name: "x", is_member: true,
      is_ext_shared: false, ext_ever: false, is_archived: false, left_at: null, last_activity_ts: "1794140000.000100", ...over });
    const tag = (channel_id: string) => ({ principal_id: "ep_1", channel_id, tag_client_id: "cl_acme", tag_client_name: "Acme Dental", tag_project_ids: [], tagged_at: at,
      rule_client_id: null, rule_client_name: null, rule_candidates: 0, rule_computed_at: null, created_at: at, updated_at: at });
    const message = (channel_id: string, ts: string) => ({ principal_id: "ep_1", channel_id, ts, thread_ts: null, role: "item", is_dd_post: false, author_user_id: "U0JANE",
      author_external: false, dd_paths: [], created_at: at });
    const item = (channel_id: string, ts: string, id: string) => ({ id, principal_id: "ep_1", channel_id, ts, thread_ts: null, kind: "decision", author_user_id: "U0JANE",
      author_external: false, assessed: true, needs_response: false, bypass_mute: false, summary: `${INTEL_SENTINELS.summary} ${id}`, excerpt: null,
      source_class: "public", permalink: null, responded_at: null, created_at: at, expires_at: "2027-02-01T00:00:00.000Z" });
    const link = (channel_id: string, ts: string) => ({ principal_id: "ep_1", channel_id, ts, client_id: "cl_acme", client_name: "Acme Dental", client_match_via: "dd_link",
      match_confidence: "high", client_candidates: 1, task_ids: [], project_ids: [], email_thread_ids: [], checked_at: at });
    const db = createFakeSlackIntelDb({
      now: () => NOW,
      tables: {
        // The finance-named Slack Connect channel, watched here so that only its class, share and finance name can keep it out.
        exec_slack_channels: [chan("C0EXTBOOKS", { class: "external", finance_name: true, is_ext_shared: true, ext_ever: true, name: "acme-bookkeeping" }), chan("C0ACMESEO", {})],
        exec_slack_channel_links: [tag("C0EXTBOOKS"), tag("C0ACMESEO")],
        exec_slack_messages: [message("C0EXTBOOKS", "1794140000.000100"), message("C0ACMESEO", "1794140000.000200")],
        exec_slack_items: [item("C0EXTBOOKS", "1794140000.000100", "esl_books"), item("C0ACMESEO", "1794140000.000200", "esl_seo")],
        exec_slack_message_links: [link("C0EXTBOOKS", "1794140000.000100"), link("C0ACMESEO", "1794140000.000200")]
      }
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    const facts = await listPublicSlackFactsForClient(PRINCIPAL, "cl_acme", { sinceIso: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(), limit: 8 });
    expect(facts.map((f) => [f.src, f.id, f.channelId])).toEqual([["item", "esl_seo", "C0ACMESEO"]]);
  });

  it("channelSlug is P7a's (slack-classes.ts), not DD's fb-onboarding module", () => {
    const src = readFileSync(new URL("./correlate-slack.ts", import.meta.url), "utf8");
    expect(src).toContain('import { channelSlug } from "@/lib/exec/slack-classes";');
    expect(src).not.toMatch(/fb-onboarding/);
  });
});

describe("CO09 loadSlackCorrelator reads every source and throws on any failure", () => {
  const ANCHOR_ROWS: DdEodSlackAnchor[] = [
    { source: "checkin", id: "cc_1", clientId: "cl_acme", clientName: "Acme Dental", slackChannel: "C0SCALEDTEAM", slackTs: "1794063600.000400", sentAt: "2026-11-07T15:00:00.000Z" },
    { source: "update", id: "cu_1", clientId: null, clientName: "Beta Labs", slackChannel: "C0SCALEDTEAM", slackTs: "1794063700.000100", sentAt: "2026-11-07T16:00:00.000Z" },
    // Two posts at one key that disagree: no client.
    { source: "update", id: "cu_2", clientId: "cl_acme", clientName: "Acme Dental", slackChannel: "C0SCALEDTEAM", slackTs: "1794063800.000100", sentAt: "2026-11-07T16:00:00.000Z" },
    { source: "checkin", id: "cc_2", clientId: "cl_beta", clientName: "Beta Labs", slackChannel: "C0SCALEDTEAM", slackTs: "1794063800.000100", sentAt: "2026-11-07T16:00:00.000Z" }
  ];
  beforeEach(() => {
    vi.mocked(listClientMatchSignals).mockReset().mockResolvedValue(CLIENTS);
    vi.mocked(listInternalAddresses).mockReset().mockResolvedValue({ addresses: ["mitchell@agency-mail.com"], domains: ["agency-mail.com", "scaledai.org"] });
    vi.mocked(listTasksByIds).mockReset().mockResolvedValue([...TASKS.values()]);
    vi.mocked(listEodSlackAnchors).mockReset().mockResolvedValue(ANCHOR_ROWS);
  });

  it("passes the signal, the deduped task ids and the anchor window to the four reads, and builds from them", async () => {
    const ac = new AbortController();
    const c = await loadSlackCorrelator(PRINCIPAL, { taskIds: ["tk_acme", "tk_acme", "", "tk_beta"], anchorsSince: "2026-10-09T15:00:00.000Z" }, { signal: ac.signal });
    expect(listClientMatchSignals).toHaveBeenCalledWith(PRINCIPAL, { signal: ac.signal });
    expect(listInternalAddresses).toHaveBeenCalledWith(PRINCIPAL, { signal: ac.signal });
    expect(listTasksByIds).toHaveBeenCalledWith(PRINCIPAL, ["tk_acme", "tk_beta"], { signal: ac.signal });
    expect(listEodSlackAnchors).toHaveBeenCalledWith(PRINCIPAL, "2026-10-09T15:00:00.000Z", { signal: ac.signal });
    expect(c.activeClients).toBe(8);
    const at = (ts: string) => verdictOf(c.messageLink(msg({ channelId: "C0SCALEDTEAM", ts })));
    expect(at("1794063600.000400")).toEqual(["cl_acme", "Acme Dental", "dd_post", "high", 1]);
    expect(at("1794063700.000100")).toEqual(["cl_beta", "Beta Labs", "dd_post", "high", 1]);
    expect(at("1794063800.000100")).toEqual(NONE);
    expect(verdictOf(c.messageLink(msg({ ddPaths: ["/tasks/tk_acme"] })))).toEqual(["cl_acme", "Acme Dental", "dd_link", "high", 1]);
    expect(verdictOf(c.messageLink(msg({ summaries: ["agency-mail.com"] })))).toEqual(NONE);
  });

  it.each([
    ["listClientMatchSignals", () => vi.mocked(listClientMatchSignals).mockRejectedValue(new DdReadError("clients", "53300"))],
    ["listInternalAddresses", () => vi.mocked(listInternalAddresses).mockRejectedValue(new Error("clone unavailable"))],
    ["listTasksByIds", () => vi.mocked(listTasksByIds).mockRejectedValue(new DdReadError("tasks", "57014"))],
    ["listEodSlackAnchors", () => vi.mocked(listEodSlackAnchors).mockRejectedValue(new DdReadError("eod_client_updates", "42P01"))]
  ])("%s failing → loadSlackCorrelator throws (never a correlator over nothing)", async (_name, fail) => {
    fail();
    await expect(loadSlackCorrelator(PRINCIPAL, { taskIds: ["tk_acme"], anchorsSince: "2026-10-09T15:00:00.000Z" }, { signal: new AbortController().signal }))
      .rejects.toBeInstanceOf(Error);
  });
});
